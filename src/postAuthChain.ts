/**
 * Windsurf Auth Chain (1.5.7 简化版)
 *
 * 1.5.7 关键变更: 合并实测 + 同行实现 (windsurf-account-manager-simple) 后,
 * 验证 PostAuth 一步就能拿到所有需要的字段 (sessionToken=apiKey, name, orgs, accountId,
 * primaryOrgId), PKCE 链是冗余的 (PostAuth.session_token === ExchangePKCE.field1).
 *
 * 提供两条 auth1_token → apiKey 的链路 (主路从 PKCE 老路 → PostAuth 单步):
 *
 *   - 主路 PostAuth (1 步, 默认): runPostAuthChain
 *     1. WindsurfPostAuth(auth1) → session_token + orgs[] + accountId + primaryOrgId
 *     ★ session_token 直接当 apiKey, 从 orgs[primary].name 拿 name, apiServerUrl 用默认值
 *     ★ 借鉴 simple-main: 新建账号 org 同步竞态 (404 + no_eligible_organizations) 退避重试
 *
 *   - Fallback 桥接路 (Devin-first, 3 步): runDevinBridgeChain
 *     1. listEligibleOrganizations (Devin 域)
 *     2. requestWindsurfContinueCode (Devin 域)
 *     3. exchangeDevinCode (Windsurf BFF host)
 *     ★ 仅在 PostAuth 风控/web-backend 整域死时启用
 *     ★ 要求账号已激活 (eligible-organizations 401 = 未激活, 此时 fallback 也救不回来)
 *
 * 总入口 runAuthChain: 主试 PostAuth, 失败 fallback 桥接
 *
 * 开发者: Ti
 */

import axios from 'axios';
import { log } from './logger';
import { getAxiosProxyConfig } from './proxyAgent';
import { encodeStringField, decodeVarint, decodeProtoFields } from './windsurfProto';
import { listEligibleOrganizations, requestWindsurfContinueCode, EligibleOrganization } from './devinAuth';

const TAG = 'AuthChain';

/** Web Backend 主机 (老路 PostAuth + PKCE 用) */
const WEB_BACKEND = 'https://web-backend.windsurf.com';

/** Windsurf BFF (激进主路 ExchangeDevinCode 用, 跟 web-backend 是不同 host) */
const WINDSURF_BFF = 'https://windsurf.com/_backend';

/** 默认 API server URL (apiServerUrl 缺省值) */
const DEFAULT_API_SERVER = 'https://server.codeium.com';

/** Proto 请求通用 headers */
const PROTO_HEADERS: Record<string, string> = {
  'Content-Type': 'application/proto',
  'Accept': 'application/proto',
  'User-Agent': 'Windsurf/1.4.2',
  'Origin': 'https://windsurf.com',
  'Referer': 'https://windsurf.com/'
};

/** WindsurfPostAuth 解析的 organization 项 */
export interface PostAuthOrg {
  /** org_id (field 1, e.g. "team-xxxxx") */
  id: string;
  /** 显示名 (field 2, 一般是邮箱前缀或团队名) */
  name: string;
}

/** WindsurfPostAuth 响应完整结构 */
export interface WindsurfPostAuthResult {
  /** 会话 token (field 1) - 跟 ExchangePKCE.field1 是同一个 JWT, 直接当 apiKey */
  sessionToken: string;
  /** 新的 auth1_token (field 3) - 服务端可能轮换 */
  auth1Token: string;
  /** 账号 ID (field 4) */
  accountId: string;
  /** 主组织 ID (field 5) */
  primaryOrgId: string;
  /** 组织列表 (field 2, repeated message) - 用于取 name */
  orgs: PostAuthOrg[];
}

/** Auth Chain 最终结果 (上层无差异消费) */
export interface AuthChainResult {
  /** Windsurf 最终 apiKey (= sessionToken, IDE 切号写到 secrets 的字段) */
  apiKey: string;
  /** 账号显示名 (从 orgs[primary].name 取) */
  name: string;
  /** API Server URL (1.5.7 起统一用默认值, IDE 自己会重写) */
  apiServerUrl: string;
  /** Devin 扩展字段, 用于后续切号/查额度等需要 5 个 header 的接口 */
  sessionToken: string;
  auth1Token: string;
  accountId: string;
  primaryOrgId: string;
}

/** 默认 apiServerUrl - IDE 内部会自己 register / 重写 */
const FALLBACK_API_SERVER = 'https://server.self-serve.windsurf.com';

/** 退避重试间隔 (毫秒): 借鉴 simple-main 的 1.5/3/5 秒退避 */
const POST_AUTH_RETRY_DELAYS_MS: number[] = [1500, 3000, 5000];

/** sleep 工具 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 判断 PostAuth 错误是否为 "Devin 新账号 org 同步未就绪" 的瞬时错误
 *
 * 借鉴 simple-main 的 `is_post_auth_org_sync_pending`:
 * Devin 服务端在 /email/complete 返回 auth1_token 后, 需要异步把新账号同步到
 * Windsurf 后端的 org 关联表; 紧接着 (秒级) 调 PostAuth 会得到:
 *   HTTP 404 + body 含 "no_eligible_organizations" / "not_found"
 *
 * 仅对这些瞬时错误重试; 验证码错 / 参数错 / 真实账号不存在 等错误保持 fail-fast.
 */
function isPostAuthOrgSyncPending(err: any): boolean {
  const status = err?.response?.status;
  if (status !== 404) { return false; }
  /* response.data 可能是 ArrayBuffer (因为 responseType=arraybuffer) */
  let bodyText = '';
  try {
    const data = err?.response?.data;
    if (data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      bodyText = buf.toString('utf8').toLowerCase();
    }
  } catch { /* 忽略, bodyText 保持 '' */ }
  return bodyText.includes('no_eligible_org')
    || bodyText.includes('no eligible organizations')
    || bodyText.includes('not_found')
    || bodyText.includes('not found');
}

/**
 * 解析 WindsurfPostAuth response (proto 二进制)
 *
 * Schema (来自 simple-main 实测 + 我们之前实测验证):
 *   - field 1: session_token (string)
 *   - field 2: orgs (repeated message)  ★ 注意 repeated, 普通 decodeProtoFields 会被覆盖
 *       - field 1: id (string)
 *       - field 2: name (string)
 *   - field 3: auth1_token (optional string)
 *   - field 4: account_id (optional string)
 *   - field 5: primary_org_id (optional string)
 *
 * 自定义 parser 是因为通用 `decodeProtoFields` 用 Map.set 会让 repeated 字段被覆盖.
 */
function parsePostAuthResponse(buf: Buffer, fallbackAuth1: string): WindsurfPostAuthResult {
  const result: WindsurfPostAuthResult = {
    sessionToken: '',
    auth1Token: fallbackAuth1,
    accountId: '',
    primaryOrgId: '',
    orgs: []
  };

  let pos = 0;
  while (pos < buf.length) {
    const tagRes = decodeVarint(buf, pos);
    pos = tagRes.pos;
    const fieldNum = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x07;

    if (wireType === 2) {
      const lenRes = decodeVarint(buf, pos);
      pos = lenRes.pos;
      const len = lenRes.value;
      const payload = buf.subarray(pos, pos + len);
      pos += len;

      switch (fieldNum) {
        case 1:
          result.sessionToken = payload.toString('utf8');
          break;
        case 2: {
          /* repeated WindsurfOrg, 内部 field 1=id, field 2=name */
          const org: PostAuthOrg = { id: '', name: '' };
          let p = 0;
          while (p < payload.length) {
            const t = decodeVarint(payload, p);
            p = t.pos;
            const fNum = t.value >>> 3;
            const wType = t.value & 0x07;
            if (wType === 2) {
              const l = decodeVarint(payload, p);
              p = l.pos;
              const v = payload.subarray(p, p + l.value).toString('utf8');
              p += l.value;
              if (fNum === 1) { org.id = v; }
              else if (fNum === 2) { org.name = v; }
            } else if (wType === 0) {
              const skip = decodeVarint(payload, p);
              p = skip.pos;
            } else {
              break;
            }
          }
          if (org.id) { result.orgs.push(org); }
          break;
        }
        case 3:
          result.auth1Token = payload.toString('utf8');
          break;
        case 4:
          result.accountId = payload.toString('utf8');
          break;
        case 5:
          result.primaryOrgId = payload.toString('utf8');
          break;
        /* 其他字段忽略 */
      }
    } else if (wireType === 0) {
      /* varint, 跳过 */
      const skip = decodeVarint(buf, pos);
      pos = skip.pos;
    } else {
      /* 不支持的 wire type, 中止解析 */
      break;
    }
  }

  return result;
}

/**
 * WindsurfPostAuth 单步调用 (无重试)
 * 用 auth1_token 换 session_token + orgs[] + accountId + primaryOrgId
 *
 * @param auth1Token - Devin 登录返回的 auth1_xxx token
 * @param orgId - 可选, 多 org 账号在二次调用时传入选定 orgId (field 2)
 */
export async function windsurfPostAuth(auth1Token: string, orgId?: string, accountId?: string, sessionToken?: string): Promise<WindsurfPostAuthResult> {
  log('info', TAG, `WindsurfPostAuth (orgId=${orgId || '<none>'})...`);
  const proxyConfig = await getAxiosProxyConfig();

  /* field 2: org_id (可选) */
  const parts: Buffer[] = [];
  if (orgId) { parts.push(encodeStringField(2, orgId)); }
  const body = Buffer.concat(parts);
  const headers: Record<string, string> = {
    ...PROTO_HEADERS,
    'connect-protocol-version': '1',
    'X-Devin-Auth1-Token': auth1Token
  };
  if (accountId) { headers['X-Devin-Account-Id'] = accountId; }
  if (orgId) { headers['X-Devin-Primary-Org-Id'] = orgId; }
  if (sessionToken) { headers['X-Devin-Session-Token'] = sessionToken; }

  const resp = await axios.post(
    `${WEB_BACKEND}/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth`,
    body,
    {
      headers,
      responseType: 'arraybuffer',
      timeout: 20000,
      ...proxyConfig
    }
  );

  const result = parsePostAuthResponse(Buffer.from(resp.data), auth1Token);
  if (!result.sessionToken) {
    throw new Error('WindsurfPostAuth 响应未包含 session_token');
  }

  log('info', TAG, `WindsurfPostAuth 成功, accountId=${result.accountId}, orgs=${result.orgs.length}`);
  return result;
}

/**
 * 主路: PostAuth 单步链 (1.5.7 简化, 替换原 PKCE 3 步链)
 *
 * 步骤:
 *   1. windsurfPostAuth(auth1) → session_token + orgs + 元数据
 *      - 对 "no_eligible_organizations" 类瞬时 404 做 1.5/3/5 秒 3 次退避重试
 *
 * 字段映射:
 *   - apiKey         = sessionToken (实测可直接调 GetPlanStatus)
 *   - name           = orgs[primary].name 或 orgs[0].name (空则给空串, IDE 用 email)
 *   - apiServerUrl   = FALLBACK_API_SERVER (IDE 内部会重写)
 *
 * @param auth1Token - Devin 登录返回的 auth1_xxx token
 */
export async function runPostAuthChain(auth1Token: string): Promise<AuthChainResult> {
  let orgHint: EligibleOrganization | null = null;
  try {
    const orgs = await listEligibleOrganizations(auth1Token);
    orgHint = selectPrimaryOrg(orgs);
    log('info', TAG, `PostAuth 预取 org: ${orgHint.org_id}, plan=${orgHint.plan_slug}, name=${orgHint.name}`);
  } catch (err: any) {
    log('warn', TAG, `PostAuth 预取 org 失败, 仅使用 auth1 header 尝试: ${err.message}`);
  }

  /* 退避重试: 仅针对 "Devin 新账号 org 同步竞态" 瞬时 404 */
  let postAuth: WindsurfPostAuthResult | null = null;
  let attempt = 0;
  while (true) {
    try {
      postAuth = await windsurfPostAuth(auth1Token, orgHint?.org_id, orgHint?.account_id);
      break;
    } catch (err: any) {
      if (attempt < POST_AUTH_RETRY_DELAYS_MS.length && isPostAuthOrgSyncPending(err)) {
        const delay = POST_AUTH_RETRY_DELAYS_MS[attempt];
        log('warn', TAG, `PostAuth org 同步未就绪, ${delay}ms 后重试 (attempt=${attempt + 1}/${POST_AUTH_RETRY_DELAYS_MS.length})`);
        await sleep(delay);
        attempt++;
        continue;
      }
      throw err;
    }
  }

  /* 取 name: 优先 primaryOrgId 对应的 org, 否则 orgs[0] */
  const primaryOrg = postAuth.orgs.find(o => o.id === postAuth!.primaryOrgId) || postAuth.orgs[0];
  const name = primaryOrg?.name || orgHint?.name || '';

  return {
    apiKey: postAuth.sessionToken,
    name,
    apiServerUrl: FALLBACK_API_SERVER,
    sessionToken: postAuth.sessionToken,
    auth1Token: postAuth.auth1Token,
    accountId: postAuth.accountId || orgHint?.account_id || '',
    primaryOrgId: postAuth.primaryOrgId || orgHint?.org_id || ''
  };
}

/* ============================================================================
 * Fallback 桥接路 (Devin-first, 仅在 PostAuth 风控/web-backend 整域死时启用)
 *
 * 注意: 桥接路要求账号已激活 (eligible-organizations 200), 未激活账号永久 401,
 * 此时也救不回来, 用户必须先用网页/PostAuth 激活账号.
 * ============================================================================ */

/**
 * 用 code 兑换 Windsurf session_token (OAuth ExchangeAuthorizationCode 等价步骤)
 *
 * 走 windsurf.com/_backend/ 这个 BFF host (跟 web-backend.windsurf.com 不同)
 * 实测响应 schema (扁平 string 字段, 没有 repeated):
 *   field 1: session_token  (devin-session-token$JWT, 直接当 apiKey)
 *   field 2: auth1_token    (服务端可能轮换)
 *   field 3: account_id
 *   field 4: primary_org_id
 *
 * @param code - 来自 requestWindsurfContinueCode 的一次性 code
 */
async function exchangeDevinCode(code: string): Promise<{ sessionToken: string; auth1Token: string; accountId: string; primaryOrgId: string; }> {
  log('info', TAG, '桥接路: ExchangeDevinCode...');
  const proxyConfig = await getAxiosProxyConfig();
  const body = encodeStringField(1, code);

  const resp = await axios.post(
    `${WINDSURF_BFF}/exa.seat_management_pb.SeatManagementService/ExchangeDevinCode`,
    body,
    {
      headers: {
        ...PROTO_HEADERS,
        'connect-protocol-version': '1'
      },
      responseType: 'arraybuffer',
      timeout: 20000,
      ...proxyConfig
    }
  );

  const fields = decodeProtoFields(Buffer.from(resp.data));
  const sessionToken = fields.get(1) || '';
  if (!sessionToken) {
    throw new Error('ExchangeDevinCode 未返回 session_token');
  }

  log('info', TAG, `ExchangeDevinCode 成功, account_id=${fields.get(3) || ''}`);
  return {
    sessionToken,
    auth1Token: fields.get(2) || '',
    accountId: fields.get(3) || '',
    primaryOrgId: fields.get(4) || ''
  };
}

/**
 * 选 primary org (优先 is_primary_org=true, 退化为第 1 个)
 * 校验该 org 必须 can_use_cascade=true (否则切号给 IDE 也没用)
 */
function selectPrimaryOrg(orgs: EligibleOrganization[]): EligibleOrganization {
  if (orgs.length === 0) { throw new Error('账号没有可用 organization'); }
  /* 优先 is_primary_org=true; 实测多账号场景下大量为 false, 不能强依赖 */
  const primary = orgs.find(o => o.is_primary_org) || orgs[0];
  if (!primary.can_use_cascade) {
    throw new Error(`组织 ${primary.org_id} 不支持 Cascade (plan=${primary.plan_slug})`);
  }
  return primary;
}

/**
 * Fallback 桥接链: Devin-first 跨域 (3 步, 仅 web-backend 死/PostAuth 风控时用)
 *
 *   1. listEligibleOrganizations(auth1)  → orgs[]   (app.devin.ai 域)
 *      ★ 未激活账号会 401, 此时桥接路也救不回来
 *   2. requestWindsurfContinueCode       → code     (app.devin.ai 域)
 *   3. exchangeDevinCode(code)           → session_token (windsurf.com/_backend)
 *
 * 字段映射:
 *   - apiKey         = sessionToken
 *   - name           = orgs[primary].name (从 eligible-organizations 取)
 *   - apiServerUrl   = FALLBACK_API_SERVER
 *
 * @param auth1Token - Devin 登录返回的 auth1_xxx token
 */
export async function runDevinBridgeChain(auth1Token: string): Promise<AuthChainResult> {
  /* Step 1: 拿 orgs (含 name + can_use_cascade 校验) */
  const orgs = await listEligibleOrganizations(auth1Token);
  const primary = selectPrimaryOrg(orgs);
  log('info', TAG, `选定 org: ${primary.org_id}, plan=${primary.plan_slug}, name=${primary.name}`);

  /* Step 2: 拿 code */
  const code = await requestWindsurfContinueCode(auth1Token, primary.org_id);

  /* Step 3: 兑换 session_token */
  const exchange = await exchangeDevinCode(code);

  return {
    apiKey: exchange.sessionToken,
    name: primary.name,
    apiServerUrl: FALLBACK_API_SERVER,
    sessionToken: exchange.sessionToken,
    auth1Token: exchange.auth1Token || auth1Token,
    accountId: exchange.accountId || primary.account_id,
    primaryOrgId: exchange.primaryOrgId || primary.org_id
  };
}

/**
 * 总登录入口: 主试 PostAuth 单步, 失败 fallback 桥接路 (1.5.7 简化版)
 *
 * 主路 = PostAuth (1 步, 80% 场景):
 *   - 一次请求拿到所有需要的字段, 顺便激活账号
 *   - 对 "新账号 org 同步竞态 404" 做 1.5/3/5 秒退避重试
 *   - 仅依赖 web-backend.windsurf.com (单点)
 *
 * Fallback 桥接路 (3 步, 仅在 web-backend 整域死/PostAuth 风控时启用):
 *   - 跨 app.devin.ai + windsurf.com/_backend 两个 host
 *   - 要求账号已激活 (未激活账号此 fallback 也救不回来)
 *
 * 故障矩阵:
 *   - WindsurfPostAuth 接口风控/web-backend 整域死 → 主路死, 桥接路活 (前提:已激活)
 *   - app.devin.ai 风控/限流                       → 主路活, 桥接路死
 *   - 账号未激活                                    → 主路活 (顺便激活), 桥接路死
 *
 * @param auth1Token - Devin 登录返回的 auth1_xxx token
 */
export async function runAuthChain(auth1Token: string): Promise<AuthChainResult> {
  /* 主路: PostAuth 单步 (覆盖 99% 场景) */
  try {
    log('info', TAG, '主路: WindsurfPostAuth 单步登录');
    return await runPostAuthChain(auth1Token);
  } catch (mainErr: any) {
    log('warn', TAG, `主路 PostAuth 失败, fallback 桥接路: ${mainErr.message}`);

    /* Fallback 桥接路 */
    try {
      log('info', TAG, 'fallback: Devin-first 桥接路');
      return await runDevinBridgeChain(auth1Token);
    } catch (fallbackErr: any) {
      /* 两路都死, 抛友好的双错误 */
      throw new Error(`登录失败 (双路均失败): 主路=${mainErr.message}; fallback=${fallbackErr.message}`);
    }
  }
}
