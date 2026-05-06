/**
 * WF-Swap 登录协助模块
 *
 * 统一处理 "任意凭据 → 完整 AccountInfo 字段填充" 的流程, 供导入时立即验证使用
 *
 * 支持 3 种输入凭据:
 *   - password       普通邮箱密码 (自动判 Devin auth1 / Firebase)
 *   - refreshToken   Firebase refresh token (旧版)
 *   - auth1Token     Devin auth1 token (新版)
 *
 * 登录成功后会调 runAuthChain, 填充:
 *   - apiKey / apiServerUrl / displayName     (切号 + 刷额度凭据)
 *   - devinAuth1Token / devinAccountId / devinPrimaryOrgId / devinSessionToken (Devin 体系)
 *   - idToken / refreshToken / tokenExpiresAt (Firebase 体系)
 *
 * 开发者: Ti
 */

import { AccountInfo } from './types';
import { log } from './logger';
import { queryConnections, passwordLogin as devinPasswordLogin } from './devinAuth';
import { signInWithPassword, refreshIdToken } from './firebaseAuth';
import { registerUser } from './windsurfApi';
import { runAuthChain } from './postAuthChain';

const TAG = 'LoginHelper';

/** 登录凭据类型 */
export type CredentialKind = 'password' | 'refresh_token' | 'auth1_token';

/** 登录输入 (至少提供其中一种凭据) */
export interface LoginCredentials {
  email: string;
  password?: string;
  refreshToken?: string;   /* Firebase refresh token */
  auth1Token?: string;     /* Devin auth1 token */
}

/**
 * 登录并拉取完整账号信息
 *
 * 执行路径 (按优先级):
 *   A. 有 auth1Token  → runAuthChain → apiKey + orgId 等
 *   B. 有 refreshToken → refreshIdToken → registerUser → apiKey
 *   C. 有 password:
 *      → queryConnections 判策略
 *      → 'auth1' 走 Devin passwordLogin + runAuthChain (主路 PostAuth, fallback 桥接)
 *      → 其他走 Firebase signInWithPassword + registerUser
 * @param creds - 登录凭据
 * @returns 可直接 Object.assign 到 AccountInfo 的字段快照
 * @throws Error - 登录失败时抛出友好错误信息
 */
export async function loginAndFetchInfo(creds: LoginCredentials): Promise<Partial<AccountInfo>> {
  const { email } = creds;
  if (!email) { throw new Error('缺少邮箱'); }
  log('info', TAG, `准备登录: ${email}`);

  /* === 路径 B: Firebase refresh token === */
  if (creds.refreshToken && !creds.auth1Token) {
    log('info', TAG, '路径 B: Firebase refresh_token → apiKey');
    const refreshResp = await refreshIdToken(creds.refreshToken);
    const reg = await registerUser(refreshResp.id_token);
    return {
      refreshToken: refreshResp.refresh_token,
      idToken: refreshResp.id_token,
      tokenExpiresAt: Date.now() + parseInt(refreshResp.expires_in) * 1000,
      apiKey: reg.api_key,
      apiServerUrl: reg.api_server_url,
      displayName: reg.name
    };
  }

  /* 收集 auth1Token, 后面统一跑 runAuthChain */
  let auth1Token: string | undefined;

  /* === 路径 A: 直接提供 auth1 token === */
  if (creds.auth1Token) {
    log('info', TAG, '路径 A: 直接使用 auth1 token → runAuthChain');
    auth1Token = creds.auth1Token;
  }
  /* === 路径 C: 密码登录 === */
  else if (creds.password) {
    log('info', TAG, '路径 C: 密码 → queryConnections 判策略');
    const conn = await queryConnections(email);
    const method = conn.auth_method?.method;
    const hasPwd = conn.auth_method?.has_password;

    if (method === 'auth1' && hasPwd) {
      /* Devin 新体系 */
      log('info', TAG, '策略: Devin auth1 + 密码登录');
      const loginResp = await devinPasswordLogin(email, creds.password);
      auth1Token = loginResp.token;
    } else if (method === 'password' || (method === 'email' && hasPwd) || hasPwd) {
      /* Firebase 旧体系 */
      log('info', TAG, '策略: Firebase 密码登录');
      const authResp = await signInWithPassword(email, creds.password);
      const reg = await registerUser(authResp.idToken);
      return {
        password: creds.password,
        idToken: authResp.idToken,
        refreshToken: authResp.refreshToken,
        tokenExpiresAt: Date.now() + parseInt(authResp.expiresIn) * 1000,
        apiKey: reg.api_key,
        apiServerUrl: reg.api_server_url,
        displayName: reg.name
      };
    } else {
      throw new Error(`该账号登录方式=${method || '未知'}, 不支持密码登录 (可能启用 SSO/OTP)`);
    }
  }
  else {
    throw new Error('缺少登录凭据 (password / refreshToken / auth1Token)');
  }

  /* 到这里说明走 Devin 路径, 必有 auth1Token */
  if (!auth1Token) { throw new Error('未获取 auth1 token'); }

  /* AuthChain (1.5.7): 主试 PostAuth 单步 → 失败 fallback Devin-first 桥接路 */
  const chain = await runAuthChain(auth1Token);
  const result: Partial<AccountInfo> = {
    apiKey: chain.apiKey,
    apiServerUrl: chain.apiServerUrl,
    displayName: chain.name,
    devinAuth1Token: chain.auth1Token,
    devinAccountId: chain.accountId,
    devinPrimaryOrgId: chain.primaryOrgId,
    devinSessionToken: chain.sessionToken
  };
  /* 若密码登录路径, 把密码也记下来便于以后 refresh */
  if (creds.password) { result.password = creds.password; }
  return result;
}

