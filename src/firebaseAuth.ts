/**
 * Firebase 认证模块
 * 自动检测本地代理 (SOCKS5/HTTP) 连接 Google API
 * 参考: windsurf-account-manager-simple auth_service.rs
 * 开发者: Ti
 */

import axios from 'axios';
import { FirebaseAuthResponse, FirebaseRefreshResponse } from './types';
import { log } from './logger';
import { getAxiosProxyConfig, getCfProxyBaseUrl } from './proxyAgent';

const TAG = 'FirebaseAuth';

/**
 * 并行竞速: 多个 Promise 任一成功则返回，全部失败时聚合错误
 * 替代 Promise.any (ES2021 才有)
 * @param promises - 竞速的 Promise 数组
 * @returns 第一个成功的结果
 */
async function raceSuccess<T>(promises: Array<Promise<T>>): Promise<T> {
  if (promises.length === 0) {
    throw new Error('raceSuccess: 空数组');
  }
  return new Promise<T>((resolve, reject) => {
    let remaining = promises.length;
    const errors: any[] = new Array(promises.length);
    let settled = false;
    promises.forEach((p, i) => {
      p.then(val => {
        if (settled) { return; }
        settled = true;
        resolve(val);
      }).catch(err => {
        errors[i] = err;
        remaining--;
        if (remaining === 0 && !settled) {
          const agg: any = new Error('所有路径都失败');
          agg.errors = errors;
          reject(agg);
        }
      });
    });
  });
}

/** Firebase API Key (硬编码默认值, 失效时会尝试从 windsurf.com 动态抓新的) */
const DEFAULT_FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';

/**
 * 当前实际使用的 Firebase API Key (运行时可变)
 * 首次加载用硬编码默认值, 若登录返回 INVALID_KEY/API_KEY_INVALID 则动态抓一个新的
 */
let CURRENT_FIREBASE_API_KEY: string = DEFAULT_FIREBASE_API_KEY;

/** 动态抓取到的 key 缓存时长 (毫秒, 24 小时) */
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 上次抓取时间戳, 避免短时间内反复抓 */
let lastKeyFetchAt = 0;

/** Firebase 端点 */
const FIREBASE_AUTH_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';

/**
 * 动态抓取最新的 Firebase API Key
 *
 * 背景: Windsurf 偶尔会轮换 Firebase 项目的 Web API Key (安全策略), 硬编码 key 会一夜失效
 *       此函数从官方登录页 HTML 里正则匹配 AIza 开头的 key, 热更新 CURRENT_FIREBASE_API_KEY
 *
 * 调用时机:
 *   - signInWithPassword 报 INVALID_API_KEY / API_KEY_NOT_VALID 错误时
 *   - 距上次抓取 > 24h 时 (避免滥用导致 IP 被封)
 *
 * @returns 新 key 或 null (失败)
 */
async function fetchLatestFirebaseApiKey(): Promise<string | null> {
  const now = Date.now();
  if (now - lastKeyFetchAt < 5 * 60 * 1000) {
    /* 5 分钟内刚抓过, 别反复打官网 */
    return null;
  }
  lastKeyFetchAt = now;

  const proxyConfig = await getAxiosProxyConfig();
  const urls = [
    'https://windsurf.com/account/login',
    'https://windsurf.com/',
  ];

  for (const url of urls) {
    try {
      const resp = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html'
        },
        ...proxyConfig,
        responseType: 'text',
        validateStatus: () => true
      });

      if (resp.status !== 200 || typeof resp.data !== 'string') { continue; }

      /* 匹配 AIza 开头 35~40 字符 base64 字符集的 key (Google API Key 标准格式) */
      const match = resp.data.match(/AIza[A-Za-z0-9_\-]{35,40}/);
      if (match) {
        const newKey = match[0];
        if (newKey !== CURRENT_FIREBASE_API_KEY) {
          log('info', TAG, `动态抓取到新 Firebase API Key: ${newKey.substring(0, 10)}... (来源: ${url})`);
          CURRENT_FIREBASE_API_KEY = newKey;
          return newKey;
        }
        /* 抓到的跟当前一样, 说明硬编码还没失效, 或对方真的在用这个 */
        return CURRENT_FIREBASE_API_KEY;
      }
    } catch (err: any) {
      log('debug', TAG, `抓取 Firebase Key 失败 (${url}): ${err.message}`);
    }
  }
  return null;
}

/** 公共 headers (对齐 wf-dialog-mcp, 不带 Origin 避免 Firebase 拒绝) */
const COMMON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Client-Version': 'Chrome/JsCore/11.0.0/FirebaseCore-web',
  'Referer': 'https://windsurf.com/',
  'x-firebase-gmpid': '1:957777847521:web:390f31e87633dc5cc803a0'
};

/**
 * 友好化 Firebase 错误信息
 */
function friendlyError(errMsg: string): string {
  if (errMsg.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) { return '登录尝试次数过多，请15-30分钟后再试'; }
  if (errMsg.includes('INVALID_LOGIN_CREDENTIALS')) { return '邮箱或密码错误'; }
  if (errMsg.includes('EMAIL_NOT_FOUND')) { return '该邮箱未注册'; }
  if (errMsg.includes('USER_DISABLED')) { return '该账号已被禁用'; }
  if (errMsg.includes('INVALID_PASSWORD')) { return '密码错误'; }
  if (errMsg.includes('referer')) { return '请求被拒(缺少 Referer)，请检查代理配置'; }
  return errMsg;
}

/**
 * 使用邮箱密码登录 Firebase
 * 并行竞速: CF 代理 + 直连同时发起，Promise.any 取最先成功的
 * 参考 wf-dialog-mcp 的竞速策略，显著降低国内用户登录耗时
 *
 * @param email - 邮箱
 * @param password - 密码
 * @returns Firebase 认证响应
 */
export async function signInWithPassword(
  email: string,
  password: string
): Promise<FirebaseAuthResponse> {
  log('info', TAG, `正在登录: ${email}`);

  const body = {
    email,
    password,
    returnSecureToken: true,
    clientType: 'CLIENT_TYPE_WEB'
  };

  /* 构造两路请求 */
  const races: Array<Promise<{ source: string; data: FirebaseAuthResponse }>> = [];

  /* 路径 1: CF Worker 代理 */
  const cfBase = getCfProxyBaseUrl();
  if (cfBase) {
    races.push(
      axios.post<FirebaseAuthResponse>(
        `${cfBase}/proxy/firebase/auth`,
        body,
        { timeout: 15000, headers: COMMON_HEADERS }
      ).then(r => ({ source: 'cf-proxy', data: r.data }))
    );
  }

  /* 路径 2: 直连 / 本地代理 (使用当前 API Key) */
  const proxyConfig = await getAxiosProxyConfig();
  races.push(
    axios.post<FirebaseAuthResponse>(
      `${FIREBASE_AUTH_URL}?key=${CURRENT_FIREBASE_API_KEY}`,
      body,
      { timeout: 15000, headers: COMMON_HEADERS, ...proxyConfig }
    ).then(r => ({ source: 'direct', data: r.data }))
  );

  try {
    /* 竞速: 谁先成功用谁 */
    const winner = await raceSuccess(races);
    log('info', TAG, `✅ 登录成功 (${winner.source}): ${email}`);
    return winner.data;
  } catch (aggErr: any) {
    /* 所有路径都失败, 聚合错误信息 */
    const errors: any[] = aggErr.errors || [];

    /* 先检测是否是 API Key 失效 (INVALID_API_KEY / API_KEY_NOT_VALID / API_KEY_SERVICE_BLOCKED)
     * 命中则动态抓一个新 key 并重试一次 */
    const keyInvalid = errors.some(e => {
      const m: string = e?.response?.data?.error?.message || '';
      return /INVALID_API_KEY|API_KEY_NOT_VALID|API_KEY_SERVICE_BLOCKED/i.test(m);
    });
    if (keyInvalid) {
      log('warn', TAG, 'Firebase API Key 失效, 尝试动态抓取新 Key 并重试...');
      const newKey = await fetchLatestFirebaseApiKey();
      if (newKey && newKey !== aggErr.__lastTriedKey) {
        try {
          const retryResp = await axios.post<FirebaseAuthResponse>(
            `${FIREBASE_AUTH_URL}?key=${newKey}`,
            body,
            { timeout: 15000, headers: COMMON_HEADERS, ...proxyConfig }
          );
          log('info', TAG, `✅ 登录成功 (new key retry): ${email}`);
          return retryResp.data;
        } catch (retryErr: any) {
          const bizMsg = retryErr?.response?.data?.error?.message;
          if (bizMsg) { throw new Error(friendlyError(bizMsg)); }
          throw new Error(`登录失败 (new key retry): ${retryErr.message}`);
        }
      }
    }

    /* 优先使用业务错误 (INVALID_LOGIN_CREDENTIALS / EMAIL_NOT_FOUND 等) */
    for (const err of errors) {
      const bizMsg = err?.response?.data?.error?.message;
      if (bizMsg) {
        log('error', TAG, `登录业务错误 (${email}): ${bizMsg}`);
        throw new Error(friendlyError(bizMsg));
      }
    }

    /* 全部网络错误 */
    const netMsgs = errors.map((e: any) => e?.message || String(e)).join(' | ');
    log('error', TAG, `登录失败 (${email}): ${netMsgs}`);
    throw new Error(`登录失败: ${netMsgs || '未知错误'}`);
  }
}

/**
 * 使用 Refresh Token 刷新 ID Token
 * 优先走 CF Worker 代理，失败回退直连
 * @param refreshToken - Firebase Refresh Token
 * @returns 刷新响应
 */
export async function refreshIdToken(
  refreshToken: string
): Promise<FirebaseRefreshResponse> {
  log('info', TAG, '正在刷新 Token...');

  const tokenBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const tokenHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Client-Version': 'Chrome/JsCore/11.0.0/FirebaseCore-web',
    'Referer': 'https://windsurf.com/',
    'Origin': 'https://windsurf.com'
  };

  /* 尝试 1: CF Worker 代理中转 */
  const cfBase = getCfProxyBaseUrl();
  if (cfBase) {
    try {
      const resp = await axios.post<FirebaseRefreshResponse>(
        `${cfBase}/proxy/firebase/token`,
        tokenBody,
        { timeout: 15000, headers: tokenHeaders }
      );
      log('info', TAG, 'Token 刷新成功 (CF代理)');
      return resp.data;
    } catch (cfErr: any) {
      const cfMsg = cfErr.response?.data?.error?.message || cfErr.message;
      log('warn', TAG, `CF代理 Token 刷新失败: ${cfMsg}，尝试直连...`);
      if (cfErr.response?.data?.error?.message) {
        throw new Error(`Token 刷新失败: ${friendlyError(cfErr.response.data.error.message)}`);
      }
    }
  }

  /* 尝试 2: 本地代理 / 直连 */
  const proxyConfig = await getAxiosProxyConfig();

  try {
    const resp = await axios.post<FirebaseRefreshResponse>(
      `${FIREBASE_TOKEN_URL}?key=${CURRENT_FIREBASE_API_KEY}`,
      tokenBody,
      { timeout: 15000, headers: tokenHeaders, ...proxyConfig }
    );

    log('info', TAG, 'Token 刷新成功');
    return resp.data;
  } catch (err: any) {
    const errMsg = err.response?.data?.error?.message || err.message;

    /* API Key 失效 → 动态抓新 key 重试一次 */
    if (/INVALID_API_KEY|API_KEY_NOT_VALID/i.test(errMsg)) {
      log('warn', TAG, 'Refresh 用的 API Key 失效, 抓新 key 重试...');
      const newKey = await fetchLatestFirebaseApiKey();
      if (newKey) {
        try {
          const retry = await axios.post<FirebaseRefreshResponse>(
            `${FIREBASE_TOKEN_URL}?key=${newKey}`,
            tokenBody,
            { timeout: 15000, headers: tokenHeaders, ...proxyConfig }
          );
          log('info', TAG, 'Token 刷新成功 (new key retry)');
          return retry.data;
        } catch { /* 继续抛原错误 */ }
      }
    }

    log('error', TAG, `Token 刷新失败: ${errMsg}`);
    throw new Error(`Token 刷新失败: ${friendlyError(errMsg)}`);
  }
}

/** 清除缓存的 API Key (强制下次 signInWithPassword 时重新抓取) */
export function clearApiKeyCache(): void {
  CURRENT_FIREBASE_API_KEY = DEFAULT_FIREBASE_API_KEY;
  lastKeyFetchAt = 0;
  log('info', TAG, 'Firebase API Key 缓存已清除');
}
