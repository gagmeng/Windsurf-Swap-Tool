/**
 * Windsurf API 直连模块
 * 所有请求直接发送到 Windsurf 官方服务器，不经过任何第三方
 * 开发者: Ti
 */

import axios from 'axios';
import { WindsurfRegisterResponse, WindsurfPlanStatus } from './types';
import type { AccountInfo } from './types';
import { log } from './logger';
import { getAxiosProxyConfig, getCfProxyBaseUrl } from './proxyAgent';
import { encodeStringField, parseProto, ProtoNode } from './windsurfProto';

const TAG = 'WindsurfApi';

/** Windsurf 后端地址 */
const WINDSURF_BACKEND = 'https://web-backend.windsurf.com';
const CODEIUM_SERVER = 'https://server.codeium.com';
const REGISTER_URL = 'https://register.windsurf.com';

type PlanStatusAuthContext = Pick<AccountInfo, 'devinSessionToken' | 'devinAccountId' | 'devinAuth1Token' | 'devinPrimaryOrgId'>;

function buildPlanStatusHeaders(apiKey: string, account?: PlanStatusAuthContext): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/proto',
    'Accept': 'application/proto',
    'User-Agent': 'Windsurf/1.4.2',
    'Origin': 'https://windsurf.com',
    'Referer': 'https://windsurf.com/'
  };

  const isDevinSession = apiKey.startsWith('devin-session-token$')
    || account?.devinSessionToken === apiKey
    || !!account?.devinAuth1Token;

  if (isDevinSession) {
    headers['Accept'] = '*/*';
    headers['connect-protocol-version'] = '1';
    headers['x-auth-token'] = apiKey;
    headers['x-devin-session-token'] = apiKey;
    if (account?.devinAccountId) {
      headers['x-devin-account-id'] = account.devinAccountId;
    }
    if (account?.devinAuth1Token) {
      headers['x-devin-auth1-token'] = account.devinAuth1Token;
    }
    if (account?.devinPrimaryOrgId) {
      headers['x-devin-primary-org-id'] = account.devinPrimaryOrgId;
    }
  }

  return headers;
}

/**
 * 使用 Firebase ID Token 注册/获取 Windsurf API Key
 * 优先走 CF Worker 代理，失败回退直连
 * @param idToken - Firebase ID Token
 * @returns 注册响应 (包含 api_key)
 */
export async function registerUser(idToken: string): Promise<WindsurfRegisterResponse> {
  log('info', TAG, '正在注册 Windsurf 用户...');

  const reqBody = { firebase_id_token: idToken };
  const reqHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'windsurf'
  };

  /* 尝试 1: CF Worker 代理中转 */
  const cfBase = getCfProxyBaseUrl();
  if (cfBase) {
    try {
      const resp = await axios.post<WindsurfRegisterResponse>(
        `${cfBase}/proxy/windsurf/register`,
        reqBody,
        { timeout: 15000, headers: reqHeaders }
      );
      log('info', TAG, `注册成功 (CF代理)，获取 apiKey: ${resp.data.api_key?.substring(0, 8)}...`);
      return resp.data;
    } catch (cfErr: any) {
      const cfMsg = cfErr.response?.data?.message || cfErr.message;
      log('warn', TAG, `CF代理注册失败: ${cfMsg}，尝试直连...`);
    }
  }

  /* 尝试 2: 直连 */
  try {
    const proxyConfig = await getAxiosProxyConfig();
    const resp = await axios.post<WindsurfRegisterResponse>(
      `${REGISTER_URL}/exa.seat_management_pb.SeatManagementService/RegisterUser`,
      reqBody,
      { timeout: 15000, headers: reqHeaders, ...proxyConfig }
    );

    log('info', TAG, `注册成功，获取 apiKey: ${resp.data.api_key?.substring(0, 8)}...`);
    return resp.data;
  } catch (err: any) {
    const errMsg = err.response?.data?.message || err.message;
    log('error', TAG, `注册失败: ${errMsg}`);
    throw new Error(`Windsurf 注册失败: ${errMsg}`);
  }
}

/**
 * 从 GetPlanStatus 的嵌套 protobuf 响应中提取配额数据
 *
 * 响应结构 (通过实测 dump 确认):
 *   subMsg_1 (PlanStatus):
 *     subMsg_1 (PlanInfo):
 *       string_2: plan_name (如 "Trial" / "Pro" / "Free")
 *       int_1:    teams_tier 枚举
 *     subMsg_2 (PlanPeriod):
 *       int_1:    plan_start_at_unix  ← 套餐开始时间
 *     subMsg_3 (PlanPeriod):
 *       int_1:    plan_end_at_unix    ← 套餐到期时间 ★
 *     int_14: daily_quota_remaining_percent  (默认 0 时不序列化)
 *     int_15: weekly_quota_remaining_percent
 *     int_17: daily_quota_reset_at_unix
 *     int_18: weekly_quota_reset_at_unix
 *
 * @param root - parseProto 解析的响应根节点
 */
function extractPlanStatus(root: ProtoNode): WindsurfPlanStatus {
  const planStatus = (root.subMsg_1 as ProtoNode | undefined) || {};
  const planInfo = (planStatus.subMsg_1 as ProtoNode | undefined) || {};
  const planStartMsg = (planStatus.subMsg_2 as ProtoNode | undefined) || {};
  const planEndMsg = (planStatus.subMsg_3 as ProtoNode | undefined) || {};

  const toNum = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : undefined;

  const dailyRemain = toNum(planStatus.int_14) ?? 0;
  const weeklyRemain = toNum(planStatus.int_15) ?? 0;

  return {
    dailyRemainingPercent: dailyRemain,
    weeklyRemainingPercent: weeklyRemain,
    planName: typeof planInfo.string_2 === 'string' ? planInfo.string_2 : 'Free',
    teamsTier: toNum(planInfo.int_1),
    dailyResetAtUnix: toNum(planStatus.int_17),
    weeklyResetAtUnix: toNum(planStatus.int_18),
    planStartAtUnix: toNum(planStartMsg.int_1),
    planEndAtUnix: toNum(planEndMsg.int_1)
  };
}

/**
 * 查询配额/套餐状态 (Windsurf 新体系)
 * Endpoint: web-backend.windsurf.com/.../GetPlanStatus (protobuf)
 * 请求 body: field 1 = api_key
 * 对 Devin 新 api_key 和 Firebase 旧 api_key 都有效
 *
 * @param apiKey - Windsurf API Key
 * @returns 配额状态信息
 */
export async function getPlanStatus(apiKey: string, account?: PlanStatusAuthContext): Promise<WindsurfPlanStatus> {
  log('debug', TAG, '正在查询配额状态 (protobuf)...');
  const proxyConfig = await getAxiosProxyConfig();

  try {
    const resp = await axios.post(
      `${WINDSURF_BACKEND}/exa.seat_management_pb.SeatManagementService/GetPlanStatus`,
      encodeStringField(1, apiKey),
      {
        headers: buildPlanStatusHeaders(apiKey, account),
        responseType: 'arraybuffer',
        timeout: 15000,
        ...proxyConfig
      }
    );

    const root = parseProto(Buffer.from(resp.data));
    const status = extractPlanStatus(root);
    log('debug', TAG, `配额: 日剩余 ${status.dailyRemainingPercent}%, 周剩余 ${status.weeklyRemainingPercent}%, plan=${status.planName}`);
    return status;
  } catch (err: any) {
    const errMsg = err.response?.status
      ? `HTTP ${err.response.status}`
      : err.message;
    log('error', TAG, `查询配额失败: ${errMsg}`);
    throw new Error(`查询配额失败: ${errMsg}`);
  }
}

/**
 * 获取一次性认证令牌 (用于 windsurf:// 协议回调切号)
 * 参考: windsurf-account-manager-simple 的 get_auth_token
 * @param accessToken - Firebase access_token (即 id_token)
 * @returns 一次性 auth_token
 */
export async function getOneTimeAuthToken(accessToken: string): Promise<string> {
  log('info', TAG, '正在获取一次性 auth_token...');

  try {
    /* Protobuf 编码: field 1, wire type 2 (length-delimited) */
    const valueBytes = Buffer.from(accessToken, 'utf-8');
    const lengthBytes: number[] = [];
    let len = valueBytes.length;
    while (len > 127) {
      lengthBytes.push((len & 0x7F) | 0x80);
      len >>= 7;
    }
    lengthBytes.push(len & 0x7F);

    const requestData = Buffer.concat([
      Buffer.from([0x0A]),
      Buffer.from(lengthBytes),
      valueBytes
    ]);

    const proxyConfig = await getAxiosProxyConfig();
    const resp = await axios.post(
      `${WINDSURF_BACKEND}/exa.seat_management_pb.SeatManagementService/GetOneTimeAuthToken`,
      requestData,
      {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/proto',
          'Accept': 'application/proto',
          'User-Agent': 'Windsurf/1.4.2'
        },
        responseType: 'arraybuffer',
        ...proxyConfig
      }
    );

    /* Protobuf 解码: 提取 field 1 的字符串值 */
    const data = Buffer.from(resp.data);
    let pos = 0;
    while (pos < data.length) {
      const tag = data[pos];
      pos++;
      const wireType = tag & 0x07;
      const fieldNumber = tag >> 3;

      if (wireType === 2) {
        let strLen = 0;
        let shift = 0;
        while (pos < data.length) {
          const byte = data[pos];
          pos++;
          strLen |= (byte & 0x7F) << shift;
          if ((byte & 0x80) === 0) { break; }
          shift += 7;
        }
        if (pos + strLen <= data.length) {
          const value = data.subarray(pos, pos + strLen).toString('utf-8');
          if (fieldNumber === 1 && value.length > 0) {
            log('info', TAG, '获取 auth_token 成功');
            return value;
          }
          pos += strLen;
        }
      } else if (wireType === 0) {
        while (pos < data.length) {
          if ((data[pos] & 0x80) === 0) { pos++; break; }
          pos++;
        }
      } else {
        break;
      }
    }

    throw new Error('无法从响应中解析 auth_token');
  } catch (err: any) {
    const errMsg = err.response?.status ? `HTTP ${err.response.status}` : err.message;
    log('error', TAG, `获取 auth_token 失败: ${errMsg}`);
    throw new Error(`获取 auth_token 失败: ${errMsg}`);
  }
}

/**
 * 获取用户信息
 * 优先走 CF Worker 代理，失败回退直连
 * @param apiKey - Windsurf API Key
 * @returns 用户信息
 */
export async function getUserInfo(apiKey: string): Promise<any> {
  log('debug', TAG, '正在获取用户信息...');

  const reqHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${apiKey}-windsurf`,
    'User-Agent': 'windsurf'
  };

  /* 尝试 1: CF Worker 代理中转 */
  const cfBase = getCfProxyBaseUrl();
  if (cfBase) {
    try {
      const resp = await axios.post(
        `${cfBase}/proxy/windsurf/user`,
        {},
        { timeout: 15000, headers: reqHeaders }
      );
      return resp.data;
    } catch (cfErr: any) {
      log('warn', TAG, `CF代理获取用户信息失败: ${cfErr.message}，尝试直连...`);
    }
  }

  /* 尝试 2: 直连 */
  try {
    const proxyConfig = await getAxiosProxyConfig();
    const resp = await axios.post(
      `${CODEIUM_SERVER}/exa.api_server_pb.ApiServerService/GetUser`,
      {},
      { timeout: 15000, headers: reqHeaders, ...proxyConfig }
    );
    return resp.data;
  } catch (err: any) {
    log('error', TAG, `获取用户信息失败: ${err.message}`);
    throw err;
  }
}
