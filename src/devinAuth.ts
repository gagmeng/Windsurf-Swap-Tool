/**
 * Devin Auth (Windsurf 新认证体系) 模块
 *
 * 包含两组 endpoint, 按用途区分:
 *   - https://windsurf.com/_devin-auth/*      老路 (PostAuth 链路用)
 *   - https://app.devin.ai/api/auth/*         新路 (激进主路 Devin OAuth code flow 用)
 *
 * 参考: Windsurf认证接口文档.md 第二节
 * 开发者: Ti
 */

import axios from 'axios';
import { log } from './logger';
import { getAxiosProxyConfig } from './proxyAgent';

const TAG = 'DevinAuth';

/** 老路 host: Windsurf 收编子站 (PostAuth 链路 / OTP / queryConnections 用) */
const DEVIN_HOST = 'https://windsurf.com';

/** 新路 host: Devin 真主域 (激进主路桥接接口用) */
const DEVIN_APP_HOST = 'https://app.devin.ai';

/** 浏览器级 UA (文档建议) */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 通用请求 headers */
const COMMON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': BROWSER_UA,
  'Origin': DEVIN_HOST,
  'Referer': DEVIN_HOST + '/'
};

/** 登录方式查询响应 */
export interface DevinConnectionsResponse {
  connections: Array<{ id: string | null; type: string; enabled: boolean; client_id: string | null }>;
  auth_method: {
    method: 'password' | 'email' | 'sso' | 'auth1';
    has_password: boolean;
    sso_connections: string[] | null;
  };
}

/** 密码登录响应 */
export interface DevinPasswordLoginResponse {
  token: string;       // auth1_xxx
  user_id: string;     // uid_xxx
}

/** OTP 发送响应 */
export interface DevinOtpStartResponse {
  ok: boolean;
  email_verification_token: string;   // evt_xxx
}

/** OTP 完成响应 */
export interface DevinOtpCompleteResponse {
  token: string;       // auth1_xxx
  user_id: string;     // uid_xxx
}

/**
 * 友好化 Devin Auth 错误信息
 */
function friendlyError(detail: string): string {
  if (!detail) { return '未知错误'; }
  if (detail.includes('invalid_credentials')) { return '邮箱或密码错误'; }
  if (detail.includes('account_not_found')) { return '该邮箱未注册'; }
  if (detail.includes('rate_limited')) { return '请求过于频繁，请稍后重试'; }
  if (detail.includes('invalid_code')) { return '验证码错误或已过期'; }
  if (detail.includes('token_expired')) { return '验证码会话已失效，请重新获取'; }
  if (detail.includes('user_already_exists')) { return '该邮箱已注册，请改用登录模式'; }
  return detail;
}

/**
 * 查询邮箱登录方式
 * 用于判断账号走哪种认证路径（password / email OTP / SSO / auth1）
 * @param email - 邮箱
 * @returns 登录方式信息
 */
export async function queryConnections(email: string): Promise<DevinConnectionsResponse> {
  log('info', TAG, `查询登录方式: ${email}`);
  const proxyConfig = await getAxiosProxyConfig();

  try {
    const resp = await axios.post<DevinConnectionsResponse>(
      `${DEVIN_HOST}/_devin-auth/connections`,
      { product: 'devin', email },
      { headers: COMMON_HEADERS, timeout: 15000, ...proxyConfig }
    );
    log('info', TAG, `登录方式: ${resp.data.auth_method?.method}, 有密码: ${resp.data.auth_method?.has_password}`);
    return resp.data;
  } catch (err: any) {
    const detail = err.response?.data?.detail || err.message;
    throw new Error(`查询登录方式失败: ${friendlyError(detail)}`);
  }
}

/**
 * 邮箱+密码登录 (Devin Auth)
 * @param email - 邮箱
 * @param password - 密码
 * @returns { token: 'auth1_xxx', user_id: 'uid_xxx' }
 */
export async function passwordLogin(email: string, password: string): Promise<DevinPasswordLoginResponse> {
  log('info', TAG, `Devin 密码登录: ${email}`);
  const proxyConfig = await getAxiosProxyConfig();

  try {
    const resp = await axios.post<DevinPasswordLoginResponse>(
      `${DEVIN_HOST}/_devin-auth/password/login`,
      { email, password },
      { headers: COMMON_HEADERS, timeout: 15000, ...proxyConfig }
    );

    if (!resp.data.token || !resp.data.token.startsWith('auth1_')) {
      throw new Error('返回的 token 格式不正确');
    }

    log('info', TAG, `Devin 登录成功, user_id: ${resp.data.user_id}`);
    return resp.data;
  } catch (err: any) {
    const detail = err.response?.data?.detail || err.message;
    log('error', TAG, `Devin 登录失败 (${email}): ${detail}`);
    throw new Error(friendlyError(detail));
  }
}

/**
 * 请求邮箱 OTP 验证码
 * @param email - 邮箱
 * @param mode - login (已注册) 或 signup (新注册)
 * @returns { email_verification_token: 'evt_xxx' }
 */
export async function sendOtpCode(
  email: string,
  mode: 'login' | 'signup' = 'login'
): Promise<DevinOtpStartResponse> {
  log('info', TAG, `请求 OTP: ${email}, mode=${mode}`);
  const proxyConfig = await getAxiosProxyConfig();

  try {
    const resp = await axios.post<DevinOtpStartResponse>(
      `${DEVIN_HOST}/_devin-auth/email/start`,
      { email, mode },
      { headers: COMMON_HEADERS, timeout: 15000, ...proxyConfig }
    );
    return resp.data;
  } catch (err: any) {
    const detail = err.response?.data?.detail || err.message;
    throw new Error(`发送验证码失败: ${friendlyError(detail)}`);
  }
}

/**
 * 提交 OTP 验证码完成登录
 * @param emailVerificationToken - evt_xxx (来自 sendOtpCode)
 * @param code - 6位验证码
 * @param mode - login 或 signup
 * @returns { token: 'auth1_xxx', user_id: 'uid_xxx' }
 */
export async function completeOtpLogin(
  emailVerificationToken: string,
  code: string,
  mode: 'login' | 'signup' = 'login'
): Promise<DevinOtpCompleteResponse> {
  log('info', TAG, `提交 OTP 验证码 mode=${mode}`);
  const proxyConfig = await getAxiosProxyConfig();

  try {
    const resp = await axios.post<DevinOtpCompleteResponse>(
      `${DEVIN_HOST}/_devin-auth/email/complete`,
      { email_verification_token: emailVerificationToken, code, mode },
      { headers: COMMON_HEADERS, timeout: 15000, ...proxyConfig }
    );

    if (!resp.data.token || !resp.data.token.startsWith('auth1_')) {
      throw new Error('返回的 token 格式不正确');
    }

    log('info', TAG, `OTP 登录成功, user_id: ${resp.data.user_id}`);
    return resp.data;
  } catch (err: any) {
    const detail = err.response?.data?.detail || err.message;
    log('error', TAG, `OTP 登录失败: ${detail}`);
    throw new Error(friendlyError(detail));
  }
}

/* ============================================================================
 * 激进主路 (Devin-first) 桥接接口
 * 走 https://app.devin.ai/api/auth/windsurf/* 这一组
 * 替代老的 PostAuth + PKCE 链, 跨域容灾
 * ============================================================================ */

/** eligible-organizations 响应中的单个 org 条目 */
export interface EligibleOrganization {
  org_id: string;
  display_name: string | null;
  name: string;
  is_primary_org: boolean;
  account_id: string;
  is_admin: boolean;
  can_use_cli: boolean;
  can_use_cascade: boolean;
  plan_slug: string;
  subscription_status: string | null;
  onboarding_status: string;
  enterprise_id: string | null;
  max_acu_limit: number | null;
  webapp_host: string | null;
  picture: string | null;
  external_org_id: string | null;
  created_at: string;
}

/**
 * 列举可用于桥接 Windsurf 的组织
 *
 * 关键: 不需要 x-cog-org-id, 仅 Bearer auth1 即可调通
 * 这是激进主路解"首次登录无 orgId 死锁"的核心
 *
 * @param auth1Token - Devin auth1 token (auth1_xxx)
 * @returns 可用的 org 列表 (至少 1 个)
 */
export async function listEligibleOrganizations(auth1Token: string): Promise<EligibleOrganization[]> {
  log('info', TAG, '查询 eligible-organizations (激进主路 step 2/4)');
  const proxyConfig = await getAxiosProxyConfig();

  try {
    const resp = await axios.get<EligibleOrganization[]>(
      `${DEVIN_APP_HOST}/api/auth/windsurf/eligible-organizations`,
      {
        headers: {
          'Authorization': `Bearer ${auth1Token}`,
          'Accept': 'application/json',
          'User-Agent': BROWSER_UA,
          'Origin': DEVIN_APP_HOST
        },
        timeout: 15000,
        ...proxyConfig
      }
    );

    if (!Array.isArray(resp.data) || resp.data.length === 0) {
      throw new Error('返回 0 个 organization');
    }

    log('info', TAG, `eligible-organizations 返回 ${resp.data.length} 个 org, primary plan=${resp.data[0].plan_slug}`);
    return resp.data;
  } catch (err: any) {
    const detail = err.response?.data?.detail || err.message;
    log('error', TAG, `查询 eligible-organizations 失败: ${detail}`);
    throw new Error(`查询组织列表失败: ${friendlyError(detail)}`);
  }
}

/**
 * 请求 Windsurf 桥接 code (Devin OAuth code flow)
 *
 * 关键: 必需 x-cog-org-id (auth1 不带 org 上下文)
 * 不带 orgId 会返回 401 "No organizations found for auth1 user"
 *
 * @param auth1Token - Devin auth1 token
 * @param orgId      - 组织 ID (来自 listEligibleOrganizations)
 * @returns code (22 字符短串, 一次性使用, TTL 估计 1-2 分钟)
 */
export async function requestWindsurfContinueCode(auth1Token: string, orgId: string): Promise<string> {
  log('info', TAG, `请求 windsurf/continue (激进主路 step 3/4), orgId=${orgId}`);
  const proxyConfig = await getAxiosProxyConfig();

  try {
    const resp = await axios.post<{ code: string }>(
      `${DEVIN_APP_HOST}/api/auth/windsurf/continue`,
      undefined,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${auth1Token}`,
          'x-cog-org-id': orgId,
          'Accept': 'application/json',
          'User-Agent': BROWSER_UA,
          'Origin': DEVIN_APP_HOST
        },
        timeout: 15000,
        ...proxyConfig
      }
    );

    if (!resp.data.code || typeof resp.data.code !== 'string') {
      throw new Error('返回的 code 格式不正确');
    }

    log('info', TAG, `windsurf/continue 拿到 code (${resp.data.code.length} chars)`);
    return resp.data.code;
  } catch (err: any) {
    const detail = err.response?.data?.detail || err.message;
    log('error', TAG, `请求 windsurf/continue 失败: ${detail}`);
    throw new Error(`请求桥接 code 失败: ${friendlyError(detail)}`);
  }
}
