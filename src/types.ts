/**
 * WF-Swap 类型定义
 * 开发者: Ti
 */

/** 认证策略 */
export type AuthStrategy = 'devin_auth' | 'firebase';

/** 账号信息 */
export interface AccountInfo {
  /** 唯一标识 */
  id: string;
  /** 邮箱 */
  email: string;
  /** 密码 */
  password: string;
  /** 认证策略（成功登录后记录，下次优先用） */
  authStrategy?: AuthStrategy;
  /** Firebase ID Token (firebase 体系) */
  idToken?: string;
  /** Firebase Refresh Token (firebase 体系) */
  refreshToken?: string;
  /** Token 过期时间戳 (毫秒) */
  tokenExpiresAt?: number;
  /** Windsurf API Key (两种体系最终都是这个) */
  apiKey?: string;
  /** API Server URL (Devin: server.self-serve.windsurf.com, Firebase: server.codeium.com) */
  apiServerUrl?: string;
  /** 账号显示名 */
  displayName?: string;
  /** Devin auth1_token */
  devinAuth1Token?: string;
  /** Devin session_token */
  devinSessionToken?: string;
  /** Devin 账号 ID */
  devinAccountId?: string;
  /** Devin 主组织 ID */
  devinPrimaryOrgId?: string;
  /** 是否为当前活跃账号 */
  isActive?: boolean;
  /** 日配额剩余百分比 */
  dailyQuota?: number;
  /** 周配额剩余百分比 */
  weeklyQuota?: number;
  /** 最后余额刷新时间 */
  lastBalanceCheck?: number;
  /** 套餐名 (Trial / Pro / Free 等) */
  planName?: string;
  /** 日配额下次重置时间 (unix 秒) */
  dailyResetAt?: number;
  /** 周配额下次重置时间 (unix 秒) */
  weeklyResetAt?: number;
  /** 套餐开始时间 (unix 秒) */
  planStartAt?: number;
  /** 套餐到期时间 (unix 秒) */
  planEndAt?: number;
  /** 备注 / 昵称 */
  note?: string;
  /** 所属分组 ID (空/undefined 表示"未分组") */
  groupId?: string;
  /** 账号创建时间 (unix 秒) */
  createdAt?: number;
}

/**
 * 分组信息
 * 用于把账号归类管理，如"工作组"等
 */
export interface GroupInfo {
  /** 唯一 ID */
  id: string;
  /** 分组名称 */
  name: string;
  /** 分组色 (CSS 颜色值，可选；用于 badge 着色) */
  color?: string;
  /** 创建时间戳 (毫秒) */
  createdAt: number;
}

/** Firebase 登录响应 */
export interface FirebaseAuthResponse {
  idToken: string;
  email: string;
  refreshToken: string;
  expiresIn: string;
  localId: string;
  registered: boolean;
}

/** Firebase Token 刷新响应 */
export interface FirebaseRefreshResponse {
  access_token: string;
  expires_in: string;
  token_type: string;
  refresh_token: string;
  id_token: string;
  user_id: string;
  project_id: string;
}

/** Windsurf 用户注册响应 */
export interface WindsurfRegisterResponse {
  api_key: string;
  name?: string;
  api_server_url?: string;
}

/** Windsurf 配额状态 */
export interface WindsurfPlanStatus {
  /** 日配额剩余百分比 (0-100) */
  dailyRemainingPercent: number;
  /** 周配额剩余百分比 (0-100) */
  weeklyRemainingPercent: number;
  /** 套餐名 (如 "Trial" / "Pro" / "Free") */
  planName: string;
  /** TeamsTier 枚举值 */
  teamsTier?: number;
  /** 日配额重置时间 (unix 秒) */
  dailyResetAtUnix?: number;
  /** 周配额重置时间 (unix 秒) */
  weeklyResetAtUnix?: number;
  /** 套餐开始时间 (unix 秒, subMsg_1.subMsg_2.int_1) */
  planStartAtUnix?: number;
  /** 套餐到期时间 (unix 秒, subMsg_1.subMsg_3.int_1) */
  planEndAtUnix?: number;
}

/** 补丁方案 */
export interface PatchScheme {
  /** 方案标识 (A-J) */
  id: string;
  /** 方案描述 */
  description: string;
  /** 是否已应用 */
  applied: boolean;
  /** 搜索模式 */
  searchPattern: RegExp | string;
  /** 替换内容 */
  replacement: string;
  /** 目标文件类型 */
  targetFile: 'main' | 'webview';
}

/** 补丁状态 */
export interface PatchStatus {
  /** 各方案状态 */
  schemes: Record<string, boolean>;
  /** 是否有备份 */
  hasBackup: boolean;
  /** 最后应用时间 */
  lastApplied?: number;
}

export interface PatchSchemeDiagnostic {
  id: string;
  description: string;
  applied: boolean;
  canApply: boolean;
  reason?: string;
}

export interface PatchDiagnostics {
  windsurfPath: string;
  extensionJsPath: string;
  extensionJsExists: boolean;
  writable: boolean;
  backups: string[];
  schemes: PatchSchemeDiagnostic[];
}

/** 机器码信息 */
export interface MachineIdInfo {
  /** 当前机器码 */
  machineId?: string;
  /** telemetry machineId */
  telemetryMachineId?: string;
  /** 设备指纹 */
  fingerprint?: string;
  /** 安装 ID */
  installationId?: string;
}

/** 机器码重置单步结果 */
export interface MachineIdResetStep {
  /** 步骤名 (如 'storage.json (globalStorage)' / 'HKLM\\...\\MachineGuid') */
  name: string;
  /** 是否成功 */
  success: boolean;
  /** 成功时的值 (截断展示) */
  value?: string;
  /** 涉及的文件路径 (如 storage.json 完整路径) */
  path?: string;
  /** 失败时的错误信息 */
  error?: string;
}

/** 机器码重置整体结果 */
export interface MachineIdResetResult {
  /** 是否所有步骤都成功 */
  success: boolean;
  /** 每一步详情 */
  steps: MachineIdResetStep[];
  /** 是否因为权限问题导致失败 (提示管理员运行) */
  requiresAdminHint: boolean;
}

/** Webview 消息类型 */
export interface WebviewMessage {
  type: string;
  payload?: any;
}

/** 日志级别 */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
