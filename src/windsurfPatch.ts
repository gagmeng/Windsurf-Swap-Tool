/**
 * Windsurf 无感换号补丁系统 (v2)
 * 参考 wf-dialog-mcp 的实现，注入自定义命令 windsurf.provideAuthTokenToAuthProviderWithShit
 * 该命令直接操作 context.secrets 和 LanguageServerClient，不走不可靠的 windsurf:// 协议
 * 开发者: Ti
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import * as vscode from 'vscode';
import { PatchStatus, MachineIdResetStep } from './types';
import { log } from './logger';

const TAG = 'WindsurfPatch';

/** 补丁标识：内容中是否包含此字符串即认定补丁已应用 */
const PATCH_MARKER = 'handleAuthTokenWithShit';

/** 自定义命令名 (viewProvider 切号时会 executeCommand 这个命令) */
export const CUSTOM_COMMAND = 'windsurf.provideAuthTokenToAuthProviderWithShit';

/**
 * 补丁代码版本号
 *
 * 用途:
 *   - 嵌入到注入的 handleAuthTokenWithShit 方法体开头作为注释 marker (形如 `/*WF_V1*\/`)
 *   - isPatchApplied: 要求同时存在 PATCH_MARKER + CUSTOM_COMMAND + PATCH_VERSION
 *   - isPatchOutdated: 旧补丁存在但版本号缺失 → 自动升级
 *
 * 改补丁代码时递增此版本号 (WF_V1 → WF_V2 ...), 插件启动时会静默升级老用户
 * 参考 eg.js (windsurf-switcher) 的 PATCH_V6 设计
 */
const PATCH_VERSION = 'WF_V1';

/**
 * 命令注册位置匹配正则 (三种历史版本，按顺序尝试)
 * 在匹配到的位置之前插入 NEW_COMMAND_CODE
 */
const CMD_PATTERNS: RegExp[] = [
  /s\.commands\.registerCommand\(t\.PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER,/,
  /s\.commands\.registerCommand\(t\.LOGIN_WITH_AUTH_TOKEN,/,
  /s\.commands\.registerCommand\(['"]windsurf\.provideAuthTokenToAuthProvider['"]/
];

/** 要注入的命令注册代码 (在原命令注册前插入) */
const NEW_COMMAND_CODE = `s.commands.registerCommand("${CUSTOM_COMMAND}",async A=>{try{return{session:await e.handleAuthTokenWithShit(A),error:void 0}}catch(A){return A instanceof a.WindsurfError?{error:A.errorMetadata}:{error:C.WindsurfExtensionMetadata.getInstance().errorCodes.GENERIC_ERROR}}}),`;

/** 方法注入的静态 fallback 实现 (参数 A, 方法体开头带 PATCH_VERSION marker) */
const NEW_HANDLE_AUTH_TOKEN_WITH_SHIT = `async handleAuthTokenWithShit(A){/*${PATCH_VERSION}*/const{apiKey:t,name:i}=A,g=(0,B.getApiServerUrl)(A.apiServerUrl);if(!t)throw new s.AuthMalformedLanguageServerResponseError("Auth login failure: empty api_key");if(!i)throw new s.AuthMalformedLanguageServerResponseError("Auth login failure: empty name");const I={id:(0,n.v4)(),accessToken:t,account:{label:i,id:i},scopes:[]};return await this.context.secrets.store(u.sessionsSecretKey,JSON.stringify([I])),await this.context.globalState.update("apiServerUrl",g),(0,o.isString)(g)&&!(0,o.isEmpty)(g)&&g!==r.LanguageServerClient.getInstance().apiServerUrl&&await r.LanguageServerClient.getInstance().restart(g),this._sessionChangeEmitter.fire({added:[I],removed:[],changed:[]}),I}`;

/** 180s 超时移除正则 */
const TIMEOUT_PATTERN = /,new Promise\((\w+),(\w+)\)=>setTimeout\(\(\)=>\{(\w+)\(new (\w+)\)\},18e4\)\)/;

/* ========== URI Patch (兜底切号方案) ========== */
/**
 * URI 补丁标记 (写进 handleUri 闭包头部作为注释)
 * 作用:
 *   - 切号核心 patch 被 Windsurf 新版干掉时, URI 模式仍可通过 windsurf:// 协议兜底
 *   - 不依赖 handleAuthTokenWithShit 方法 (自包含 session 注入)
 */
const URI_PATCH_MARKER = '/*WS_URI_PATCH_V1*/';

/**
 * Windsurf 原生 URI handler 匹配正则
 *
 * 已知两种写法:
 *   v1 (老版): this._uriHandler.event(e=>{"/refresh-authentication-session"===e.path&&(0,X.refreshAuthenticationSession)()})
 *   v2 (新版): this._uriHandler.event(A=>{"/refresh-authentication-session"===A.path?(0,m.refreshAuthenticationSession)():this._loginInProgress||this.maybeHandleUriWithToken(A)})
 *
 * 这里用宽松匹配: 抓参数名 + 模块名, 然后 bracket-matching 定位整个 event callback 体
 * 这样不管 Windsurf 怎么改 else 分支, 都能命中
 *
 * 捕获组:
 *   [1] 参数名 (箭头函数参数, 如 e / A)
 *   [2] 模块变量名 (含 refreshAuthenticationSession, 如 X / m)
 */
const URI_HANDLER_REGEX = /this\._uriHandler\.event\((\w+)=>\{"\/refresh-authentication-session"===\1\.path[?&]\(0,(\w+)\.refreshAuthenticationSession\)/;

/**
 * 生成 URI handler 替换代码
 *
 * 支持两种 URL fragment 格式 (按优先级):
 *   1. windsurf://...#api_key=XXX&name=YYY&api_server_url=ZZZ  (wf-switcher 自定义)
 *      → 直接写 secrets.store, 不依赖 handleAuthToken* 任何变体
 *   2. windsurf://...#access_token=XXX                          (Windsurf 原生 / eg.js 兼容)
 *      → 调原生 this.handleAuthToken(accessToken) 走 Firebase 注册流程
 *   3. 不命中以上两种 → fall through 到原始 else 分支 (保留 Windsurf 原生行为)
 *
 * @param paramName - 箭头函数参数名 (要跟原生代码里保持一致)
 * @param moduleName - 包含 refreshAuthenticationSession 的模块变量名
 * @param originalElse - 原始 else 分支代码 (如 `this._loginInProgress||this.maybeHandleUriWithToken(A)`)
 */
function generateUriHandlerReplacement(paramName: string, moduleName: string, originalElse: string): string {
  return [
    `this._uriHandler.event(async ${paramName}=>{`,
    URI_PATCH_MARKER,
    `try{`,
    `if("/refresh-authentication-session"===${paramName}.path){(0,${moduleName}.refreshAuthenticationSession)();return}`,
    `const __f=new URLSearchParams(${paramName}.fragment);`,
    `const __k=__f.get("api_key");`,
    `if(__k){`,
    `const __n=__f.get("name")||__k.substring(0,8);`,
    `const __u=__f.get("api_server_url")||"https://server.codeium.com";`,
    `const __s={id:Math.random().toString(36).slice(2),accessToken:__k,account:{label:__n,id:__n},scopes:[]};`,
    `const __sk=this.constructor&&typeof this.constructor.getSessionsSecretKey==="function"?this.constructor.getSessionsSecretKey():"windsurf_auth.sessionsSecretKey";`,
    `await this.context.secrets.store(__sk,JSON.stringify([__s]));`,
    `await this.context.globalState.update("apiServerUrl",__u);`,
    `this._sessionChangeEmitter.fire({added:[__s],removed:[],changed:[]});`,
    `return;`,
    `}`,
    `const __t=__f.get("access_token");`,
    `if(__t){await this.handleAuthToken(__t);return}`,
    /* 不命中任何自定义 → 交还给原始 else 分支 */
    originalElse,
    `}catch(__e){console.error("[WF-Swap] URI callback error:",__e);}`,
    `})`
  ].join('');
}

/* ========== Fingerprint / InstallationId 补丁标记 ========== */
/** 指纹补丁标记: 存在此标记说明已注入 */
const FP_MARKER = '/*WF_FP*/';
/** 安装 ID 补丁标记 */
const IID_MARKER = '/*WF_IID*/';

/**
 * 指纹函数匹配正则 (按优先级排列, 匹配到第一个即停)
 * 格式 1: e.generateFingerprint=async function(){  (模块导出, Windsurf 实际格式)
 * 格式 2: async generateFingerprint(){              (类方法)
 * 格式 3: generateFingerprint(){                    (同步方法)
 */
const FP_FUNC_PATTERNS: RegExp[] = [
  /(generateFingerprint\s*=\s*async\s+function\s*\([^)]*\)\s*\{)/,
  /(async\s+generateFingerprint\s*\([^)]*\)\s*\{)/,
  /(generateFingerprint\s*\([^)]*\)\s*\{)/,
];

/**
 * 安装 ID 函数匹配正则
 * 目标: getOrGenerateInstallationId() 或类似名字
 */
const IID_FUNC_PATTERNS = [
  /(getOrGenerateInstallationId\s*\([^)]*\)\s*\{)/,
  /(getInstallationId\s*\([^)]*\)\s*\{)/,
];

/**
 * 补丁方案定义 (用于 UI 展示)
 */
const PATCH_SCHEMES: Record<string, { description: string }> = {
  'auth_token_with_shit': { description: '无感换号: 注入自定义认证命令' },
  'seamless_timeout': { description: '无感换号: 移除 180s 超时限制' },
  'uri_handler': { description: '兜底切号: URI 协议回调 (可选)' },
  'fingerprint': { description: '机器码重置: 固定设备指纹' },
  'installation_id': { description: '机器码重置: 固定安装 ID' },
};

export class WindsurfPatch {
  private windsurfPath: string = '';
  /** Windsurf 内置扩展 extension.js 路径 */
  private extensionJsPath: string = '';
  private initialized: boolean = false;

  constructor() {
    this.detectInstallPath();
  }

  /** 懒初始化: 仅在用户主动操作补丁时才定位目标文件 */
  private ensureInitialized(): void {
    if (this.initialized) { return; }
    this.initialized = true;

    if (this.windsurfPath) {
      this.locateExtensionJs();
    }
  }

  /** 检测 Windsurf 安装路径 */
  private detectInstallPath(): void {
    try {
      const appRoot = vscode.env.appRoot;
      if (appRoot) {
        const installRoot = path.resolve(appRoot, '..', '..');
        if (fs.existsSync(path.join(installRoot, 'resources'))) {
          this.windsurfPath = installRoot;
          log('info', TAG, `从 appRoot 检测到路径: ${installRoot}`);
          return;
        }
      }
    } catch (err: any) {
      log('warn', TAG, `appRoot 检测失败: ${err.message}`);
    }

    try {
      const execDir = path.dirname(process.execPath);
      if (fs.existsSync(path.join(execDir, 'resources'))) {
        this.windsurfPath = execDir;
        log('info', TAG, `从 execPath 检测到路径: ${execDir}`);
        return;
      }
    } catch { /* 忽略 */ }

    /* 常规路径兜底 */
    const possiblePaths: string[] = [];
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || '';
      const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
      const userProfile = process.env.USERPROFILE || '';
      possiblePaths.push(
        path.join(localAppData, 'Programs', 'Windsurf'),
        path.join(localAppData, 'Windsurf'),
        path.join(programFiles, 'Windsurf'),
        path.join(userProfile, 'AppData', 'Local', 'Programs', 'Windsurf')
      );
    } else if (process.platform === 'darwin') {
      possiblePaths.push(
        '/Applications/Windsurf.app/Contents',
        path.join(process.env.HOME || '', 'Applications', 'Windsurf.app', 'Contents')
      );
    } else {
      possiblePaths.push(
        '/usr/share/windsurf',
        '/opt/windsurf',
        path.join(process.env.HOME || '', '.local', 'share', 'windsurf')
      );
    }

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        this.windsurfPath = p;
        log('info', TAG, `检测到路径: ${p}`);
        return;
      }
    }
  }

  /**
   * 定位 Windsurf 内置扩展的 extension.js
   * 优先通过 vscode.extensions API (最可靠)，失败回退路径扫描
   */
  private locateExtensionJs(): void {
    /* 方式 1: vscode.extensions API */
    try {
      const ext = vscode.extensions.all.find(e => e.id.startsWith('codeium.windsurf'));
      if (ext) {
        const candidate = path.join(ext.extensionPath, 'dist', 'extension.js');
        if (fs.existsSync(candidate)) {
          this.extensionJsPath = candidate;
          log('info', TAG, `✅ 通过 vscode.extensions 找到: ${candidate}`);
          return;
        }
      }
    } catch (err: any) {
      log('warn', TAG, `vscode.extensions 检测失败: ${err.message}`);
    }

    /* 方式 2: 通过安装路径 + 相对路径查找 */
    const relativePath = process.platform === 'darwin'
      ? path.join('Resources', 'app', 'extensions')
      : path.join('resources', 'app', 'extensions');

    const extensionsDir = path.join(this.windsurfPath, relativePath);
    const found = this.tryFindExtension(extensionsDir);
    if (found) {
      this.extensionJsPath = found;
      log('info', TAG, `✅ 通过路径扫描找到: ${found}`);
    } else {
      log('warn', TAG, `未找到 Windsurf 扩展 extension.js (扫描目录: ${extensionsDir})`);
    }
  }

  /**
   * 在 extensions 目录中查找 Windsurf 扩展
   * @param extensionsDir - VS Code 扩展根目录
   * @returns extension.js 绝对路径，未找到返回 null
   */
  private tryFindExtension(extensionsDir: string): string | null {
    if (!fs.existsSync(extensionsDir)) { return null; }
    try {
      const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        const lower = entry.name.toLowerCase();
        if (lower.startsWith('codeium.windsurf') || lower === 'windsurf') {
          const jsPath = path.join(extensionsDir, entry.name, 'dist', 'extension.js');
          if (fs.existsSync(jsPath)) { return jsPath; }
        }
      }
    } catch { /* 忽略 */ }
    return null;
  }

  /** 获取补丁状态 */
  getPatchStatus(): PatchStatus {
    this.ensureInitialized();
    const schemes: Record<string, boolean> = {};

    for (const id of Object.keys(PATCH_SCHEMES)) {
      schemes[id] = this.isSchemeApplied(id);
    }

    return {
      schemes,
      hasBackup: this.hasBackup(),
      lastApplied: undefined
    };
  }

  getPatchDiagnostics(): {
    windsurfPath: string;
    extensionJsPath: string;
    extensionJsExists: boolean;
    writable: boolean;
    backups: string[];
    schemes: Array<{ id: string; description: string; applied: boolean; canApply: boolean; reason?: string }>;
  } {
    this.ensureInitialized();
    const extensionJsExists = !!this.extensionJsPath && fs.existsSync(this.extensionJsPath);
    let content = '';
    let writable = false;

    if (extensionJsExists) {
      try {
        content = fs.readFileSync(this.extensionJsPath, 'utf-8');
      } catch {
        content = '';
      }

      try {
        fs.accessSync(this.extensionJsPath, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
    }

    const schemes = Object.entries(PATCH_SCHEMES).map(([id, scheme]) => {
      const applied = this.isSchemeApplied(id);
      const readiness = this.getSchemeReadiness(id, content, extensionJsExists, applied);
      return {
        id,
        description: scheme.description,
        applied,
        canApply: readiness.canApply,
        reason: readiness.reason
      };
    });

    return {
      windsurfPath: this.windsurfPath || '',
      extensionJsPath: this.extensionJsPath || '',
      extensionJsExists,
      writable,
      backups: this.listBackupFiles(),
      schemes
    };
  }

  private getSchemeReadiness(
    schemeId: string,
    content: string,
    extensionJsExists: boolean,
    applied: boolean
  ): { canApply: boolean; reason?: string } {
    if (!extensionJsExists) {
      return { canApply: false, reason: '未找到 Windsurf extension.js' };
    }
    if (!content) {
      return { canApply: false, reason: '无法读取 Windsurf extension.js' };
    }
    if (applied) {
      return { canApply: true, reason: '已应用' };
    }

    switch (schemeId) {
      case 'auth_token_with_shit': {
        const hasMethodAnchor = content.includes('async handleAuthToken(');
        const hasCommandAnchor = CMD_PATTERNS.some(pattern => pattern.test(content));
        if (hasMethodAnchor && hasCommandAnchor) {
          return { canApply: true };
        }
        return {
          canApply: false,
          reason: !hasMethodAnchor ? '未找到 handleAuthToken 注入锚点' : '未找到命令注册注入锚点'
        };
      }
      case 'seamless_timeout':
        return TIMEOUT_PATTERN.test(content)
          ? { canApply: true }
          : { canApply: false, reason: '未找到 180s 超时锚点' };
      case 'uri_handler':
        return URI_HANDLER_REGEX.test(content)
          ? { canApply: true }
          : { canApply: false, reason: '未找到 URI handler 注入锚点' };
      case 'fingerprint':
        return FP_FUNC_PATTERNS.some(pattern => pattern.test(content))
          ? { canApply: true }
          : { canApply: false, reason: '未找到 generateFingerprint 注入锚点' };
      case 'installation_id':
        return IID_FUNC_PATTERNS.some(pattern => pattern.test(content))
          ? { canApply: true }
          : { canApply: false, reason: '未找到 installationId 注入锚点' };
      default:
        return { canApply: false, reason: '未知补丁方案' };
    }
  }

  /**
   * 判断当前补丁是否已应用 (且为当前 PATCH_VERSION)
   * 三件套缺一不可: PATCH_MARKER (方法名) + CUSTOM_COMMAND (命令名) + PATCH_VERSION (版本 marker)
   */
  isPatchApplied(): boolean {
    this.ensureInitialized();
    if (!this.extensionJsPath || !fs.existsSync(this.extensionJsPath)) {
      return false;
    }
    try {
      const content = fs.readFileSync(this.extensionJsPath, 'utf-8');
      return content.includes(PATCH_MARKER)
          && content.includes(CUSTOM_COMMAND)
          && content.includes(PATCH_VERSION);
    } catch {
      return false;
    }
  }

  /**
   * 判断补丁是否为旧版本 (方法和命令都在, 但 PATCH_VERSION marker 不在)
   *
   * 场景: 用户升级了插件 (补丁代码改了 WF_V1 → WF_V2), 但核心文件里还是旧版注入
   * 结果: 老用户无感享受不到新补丁逻辑 (除非手动回退再重装)
   *
   * 检测到返回 true 后应自动调用 upgradePatch() 静默升级
   */
  isPatchOutdated(): boolean {
    this.ensureInitialized();
    if (!this.extensionJsPath || !fs.existsSync(this.extensionJsPath)) {
      return false;
    }
    try {
      const content = fs.readFileSync(this.extensionJsPath, 'utf-8');
      /* 旧补丁存在 (方法和命令都已注入) */
      const coreApplied = content.includes(PATCH_MARKER) && content.includes(CUSTOM_COMMAND);
      /* 当前版本号缺失 */
      const versionMatches = content.includes(PATCH_VERSION);
      return coreApplied && !versionMatches;
    } catch {
      return false;
    }
  }

  /**
   * 升级补丁 (旧版 → 当前 PATCH_VERSION)
   *
   * 为什么不能用 restoreAll ?
   *   applyAll 是"先备份再改", 用户装过 N 次老插件后, 每一份 backup 都是"上一次改过的"文件,
   *   最近 backup 本身就含老 handleAuthTokenWithShit, 只是没 WF_V1 marker. restoreAll + applyAll
   *   会走进 "PATCH_MARKER 已在 → 跳过注入" 的分支, 导致 marker 永远写不进去 → 下次启动又 outdated
   *   → 升级死循环.
   *
   * 正确做法 (手术刀法):
   *   1. 读当前 extension.js, 调 removeOldPatchInjection 用 bracket-matching 精确删掉
   *      老 handleAuthTokenWithShit 方法 + 老命令注册 (得到"逻辑上的原始文件")
   *   2. 写回, 再调 applyAll 正常注入新版 (含 PATCH_VERSION marker)
   *
   * 这样不依赖 backup 干不干净, 100% 可靠
   *
   * @returns 是否升级成功 + 需要重启 Windsurf 才能生效
   */
  async upgradePatch(): Promise<{ success: boolean; needsRestart: boolean; error?: string }> {
    log('info', TAG, '检测到旧版补丁, 自动升级...');
    try {
      this.ensureInitialized();
      if (!this.extensionJsPath || !fs.existsSync(this.extensionJsPath)) {
        return { success: false, needsRestart: false, error: '未找到 Windsurf extension.js' };
      }

      /* Step 1: 手术刀法清除老注入 */
      const original = fs.readFileSync(this.extensionJsPath, 'utf-8');
      const cleaned = this.removeOldPatchInjection(original);
      if (cleaned === original) {
        log('warn', TAG, '未找到老补丁注入位置, 尝试直接 applyAll');
      } else {
        this.writeFileWithRetry(this.extensionJsPath, cleaned);
        log('info', TAG, `已清除老补丁注入 (减少 ${original.length - cleaned.length} 字符)`);
      }

      /* Step 2: 重新注入当前版本 */
      const applied = await this.applyAll();
      const ok = applied.includes('auth_token_with_shit');
      if (!ok) {
        return { success: false, needsRestart: false, error: '核心补丁注入失败' };
      }

      /* Step 3: 校验 — 必须写进了 PATCH_VERSION marker, 否则下次又会被判定 outdated */
      const finalContent = fs.readFileSync(this.extensionJsPath, 'utf-8');
      if (!finalContent.includes(PATCH_VERSION)) {
        log('error', TAG, `升级后仍未检测到 ${PATCH_VERSION} marker, 可能是 removeOldPatchInjection 漏删了`);
        return { success: false, needsRestart: false, error: `升级后 ${PATCH_VERSION} marker 写入失败` };
      }

      log('info', TAG, `补丁已升级到 ${PATCH_VERSION}, 已应用: ${applied.join(', ')}`);
      return { success: true, needsRestart: true };
    } catch (err: any) {
      log('error', TAG, `补丁升级失败: ${err.message}`);
      return { success: false, needsRestart: false, error: err.message };
    }
  }

  /**
   * 手术刀法移除老补丁的所有注入代码
   *
   * 识别并删除两处:
   *   1. async handleAuthTokenWithShit(...) { ... }           ← 用 bracket-matching 圈定整个方法
   *   2. s.commands.registerCommand("windsurf.provideAuthTokenToAuthProviderWithShit",...), ← 匹配括号闭合
   *
   * 若未检测到老注入, 原样返回 content (幂等)
   *
   * @param content - 可能含老补丁的 extension.js 内容
   * @returns 移除老注入后的内容
   */
  private removeOldPatchInjection(content: string): string {
    let result = content;

    /* 1) 移除 handleAuthTokenWithShit 方法 (bracket-matching) */
    const methodAnchor = `async ${PATCH_MARKER}(`;
    const methodIdx = result.indexOf(methodAnchor);
    if (methodIdx >= 0) {
      const bodyStart = result.indexOf('{', methodIdx);
      if (bodyStart >= 0) {
        let depth = 0;
        let bodyEnd = -1;
        for (let i = bodyStart; i < result.length; i++) {
          const ch = result[i];
          if (ch === '{') { depth++; }
          else if (ch === '}') {
            depth--;
            if (depth === 0) { bodyEnd = i; break; }
          }
        }
        if (bodyEnd > methodIdx) {
          const removed = bodyEnd - methodIdx + 1;
          result = result.slice(0, methodIdx) + result.slice(bodyEnd + 1);
          log('info', TAG, `[removeOldPatch] 清除老 handleAuthTokenWithShit 方法 (${removed} 字符)`);
        } else {
          log('warn', TAG, '[removeOldPatch] handleAuthTokenWithShit 方法体未闭合, 跳过');
        }
      }
    }

    /* 2) 移除命令注册 s.commands.registerCommand("<CUSTOM_COMMAND>",...),
     * NEW_COMMAND_CODE 末尾有逗号, 要把紧随的 `,` 一起吃掉 */
    const cmdStr = `"${CUSTOM_COMMAND}"`;
    const cmdIdx = result.indexOf(cmdStr);
    if (cmdIdx >= 0) {
      /* 往前找最近的 s.commands.registerCommand( 起点 */
      const regAnchor = 's.commands.registerCommand(';
      const regStart = result.lastIndexOf(regAnchor, cmdIdx);
      /* 要紧邻 (中间不超过 5 字符, 防止误删无关代码) */
      if (regStart >= 0 && (cmdIdx - regStart - regAnchor.length) < 5) {
        /* 从 regStart 开始括号匹配找 `)` 闭合 */
        let depth = 0;
        let end = -1;
        for (let i = regStart + regAnchor.length - 1; i < result.length; i++) {
          const ch = result[i];
          if (ch === '(') { depth++; }
          else if (ch === ')') {
            depth--;
            if (depth === 0) { end = i; break; }
          }
        }
        if (end > regStart) {
          /* 吃掉紧随的逗号 (老 NEW_COMMAND_CODE 末尾是 `),`) */
          if (result[end + 1] === ',') { end++; }
          const removed = end - regStart + 1;
          result = result.slice(0, regStart) + result.slice(end + 1);
          log('info', TAG, `[removeOldPatch] 清除老命令注册 (${removed} 字符)`);
        } else {
          log('warn', TAG, '[removeOldPatch] 命令注册括号未闭合, 跳过');
        }
      }
    }

    return result;
  }

  /** 检查单个方案是否已应用 */
  private isSchemeApplied(schemeId: string): boolean {
    if (!this.extensionJsPath || !fs.existsSync(this.extensionJsPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(this.extensionJsPath, 'utf-8');
      switch (schemeId) {
        case 'auth_token_with_shit':
          return content.includes(PATCH_MARKER)
              && content.includes(CUSTOM_COMMAND)
              && content.includes(PATCH_VERSION);
        case 'seamless_timeout':
          return !TIMEOUT_PATTERN.test(content);
        case 'uri_handler':
          return content.includes(URI_PATCH_MARKER);
        case 'fingerprint':
          return content.includes(FP_MARKER);
        case 'installation_id':
          return content.includes(IID_MARKER);
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  /** 检查是否有备份 */
  private hasBackup(): boolean {
    if (!this.extensionJsPath) { return false; }
    const dir = path.dirname(this.extensionJsPath);
    try {
      const files = fs.readdirSync(dir);
      return files.some(f => f.startsWith('extension.js.backup.'));
    } catch {
      return false;
    }
  }

  private listBackupFiles(): string[] {
    if (!this.extensionJsPath) { return []; }
    const dir = path.dirname(this.extensionJsPath);
    try {
      return fs.readdirSync(dir)
        .filter(f => f.startsWith('extension.js.backup.') || f.startsWith('extension.js.uribackup.'))
        .map(f => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    } catch {
      return [];
    }
  }

  /**
   * 应用所有补丁
   * @returns 应用成功的方案列表
   */
  async applyAll(): Promise<string[]> {
    this.ensureInitialized();
    if (!this.windsurfPath) {
      throw new Error('未检测到 Windsurf 安装路径');
    }
    if (!this.extensionJsPath || !fs.existsSync(this.extensionJsPath)) {
      throw new Error('未找到 Windsurf 内置扩展 extension.js');
    }

    /* 预检: 目标文件可写 (Windsurf 有时会把 extension.js 设成只读, 此处自动解锁) */
    const writableCheck = this.ensureFileWritable(this.extensionJsPath);
    if (!writableCheck.success) {
      throw new Error(writableCheck.error || '目标文件无写入权限');
    }

    /* 管理备份 (最多保留 3 份) */
    this.manageBackups();

    /* 创建新备份 */
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').substring(0, 15);
    const backupPath = this.extensionJsPath + `.backup.${timestamp}`;
    fs.copyFileSync(this.extensionJsPath, backupPath);
    log('info', TAG, `已创建备份: ${backupPath}`);

    let content = fs.readFileSync(this.extensionJsPath, 'utf-8');
    const originalContent = content;
    const applied: string[] = [];

    /* 补丁 1: 注入 handleAuthTokenWithShit 方法 + 注册 CUSTOM_COMMAND */
    if (!content.includes(PATCH_MARKER)) {
      try {
        content = this.injectAuthTokenMethod(content);
        content = this.injectCommandRegistration(content);
        applied.push('auth_token_with_shit');
        log('info', TAG, '✅ auth_token_with_shit 注入成功');
      } catch (err: any) {
        log('error', TAG, `❌ auth_token_with_shit 注入失败: ${err.message}`);
        /* 回滚备份 (用提权链写入, 防止权限丢失导致二次失败) */
        this.writeFileWithRetry(this.extensionJsPath, originalContent);
        throw new Error(`补丁注入失败: ${err.message}`);
      }
    } else {
      log('info', TAG, 'auth_token_with_shit 已应用，跳过');
      applied.push('auth_token_with_shit');
    }

    /* 补丁 2: 移除 180s 超时 */
    const timeoutMatch = content.match(TIMEOUT_PATTERN);
    if (timeoutMatch && timeoutMatch[2] === timeoutMatch[3]) {
      content = content.replace(timeoutMatch[0], '');
      applied.push('seamless_timeout');
      log('info', TAG, '✅ 180s 超时限制已移除');
    }

    /* 写入修改 (带提权链) */
    if (content !== originalContent) {
      this.writeFileWithRetry(this.extensionJsPath, content);
      log('info', TAG, `补丁应用完成，共 ${applied.length} 项修改`);
    }

    return applied;
  }

  /**
   * 注入 handleAuthTokenWithShit 方法
   * 策略: 找到原 `async handleAuthToken(` 方法，克隆其体，改名为 WithShit
   * 失败时使用静态 fallback
   *
   * @param content - extension.js 完整内容
   * @returns 注入后的内容
   */
  private injectAuthTokenMethod(content: string): string {
    const anchor = 'async handleAuthToken(';
    const idx = content.indexOf(anchor);
    if (idx === -1) {
      throw new Error('未找到 async handleAuthToken( 注入锚点');
    }

    /* 提取参数 */
    const argStart = idx + anchor.length;
    const argEnd = content.indexOf(')', argStart);
    const argList = content.slice(argStart, argEnd).trim();

    /* 括号计数找方法体结束 */
    let depth = 0;
    const bodyStart = content.indexOf('{', idx);
    let bodyEnd = bodyStart;
    for (; bodyEnd < content.length; bodyEnd++) {
      const ch = content[bodyEnd];
      if (ch === '{') { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) { break; }
      }
    }
    const insertAt = bodyEnd + 1;

    let newMethod: string;
    try {
      /* 动态克隆: 复制原方法体，去掉 registerUser 调用 */
      const bodyText = content.slice(bodyStart, insertAt);
      let cloned = bodyText;

      /* 去掉内部的 registerUser 调用 (Windsurf 内置的注册逻辑)，直接用传入的 apiKey */
      const registerUserRegex = /await\s*\(0,\s*\w+\.registerUser\)\(\w+\)/;
      if (registerUserRegex.test(cloned)) {
        cloned = cloned.replace(registerUserRegex, argList);
        log('info', TAG, '已跳过内部 registerUser 调用');
      }

      /* 字段名替换: snake_case → camelCase */
      cloned = cloned.replace(/\bapi_key\b/g, 'apiKey');
      cloned = cloned.replace(/\bapi_server_url\b/g, 'apiServerUrl');

      /* 注入 PATCH_VERSION marker 到方法体头部 (紧跟在 { 后面, 用注释包装不影响执行) */
      /* cloned 形如 "{...方法体...}" → 拼接成 "async handleAuthTokenWithShit(A){/*WF_V1*\/...方法体...}" */
      newMethod = `async handleAuthTokenWithShit(${argList}){/*${PATCH_VERSION}*/${cloned.slice(1)}`;
      log('info', TAG, `动态克隆 handleAuthToken 成功 (参数: ${argList}, 体长: ${bodyText.length}, 版本: ${PATCH_VERSION})`);
    } catch (err: any) {
      log('warn', TAG, `动态克隆失败: ${err.message}，使用静态 fallback`);
      newMethod = NEW_HANDLE_AUTH_TOKEN_WITH_SHIT;
    }

    return content.slice(0, insertAt) + newMethod + content.slice(insertAt);
  }

  /**
   * 注入命令注册代码
   * 在原命令 PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER 注册位置之前插入新命令
   *
   * @param content - extension.js 内容
   * @returns 注入后的内容
   */
  private injectCommandRegistration(content: string): string {
    for (const pattern of CMD_PATTERNS) {
      const match = content.match(pattern);
      if (match && match.index !== undefined) {
        const idx = match.index;
        const newContent = content.substring(0, idx) + NEW_COMMAND_CODE + content.substring(idx);
        log('info', TAG, `命令注册注入成功，模式: ${pattern.source}`);
        return newContent;
      }
    }
    throw new Error('无法定位命令注册位置，当前 Windsurf 版本不兼容');
  }

  /** 管理备份文件，最多保留 3 份 */
  private manageBackups(): void {
    if (!this.extensionJsPath) { return; }
    const dir = path.dirname(this.extensionJsPath);

    try {
      let backups = fs.readdirSync(dir)
        .filter(f => f.startsWith('extension.js.backup.'))
        .map(f => path.join(dir, f))
        .sort((a, b) => {
          const statA = fs.statSync(a);
          const statB = fs.statSync(b);
          return statA.mtimeMs - statB.mtimeMs;
        });

      while (backups.length >= 3) {
        const oldest = backups.shift()!;
        fs.unlinkSync(oldest);
        log('info', TAG, `删除旧备份: ${oldest}`);
      }
    } catch (err: any) {
      log('warn', TAG, `管理备份失败: ${err.message}`);
    }
  }

  /**
   * 确保文件可写 (无权限时尝试多级提权)
   *
   * 策略 (由轻到重, 任一步成功即返回):
   *   1. fs.accessSync(W_OK)         直接测可写, 成功就 OK
   *   2. fs.chmodSync(0o644)         解除只读位 (Windows 的 +R 属性也会吃这个)
   *   3. Windows icacls /grant       给当前用户加写权限 (不需要 UAC, 能改大部分文件)
   *   4. PowerShell Start-Process -Verb RunAs icacls  弹 UAC 提权 (Everyone:F)
   *
   * 返回 success=true 表示后续可以直接 writeFileSync
   */
  private ensureFileWritable(filePath: string): { success: boolean; error?: string } {
    /* 1) 直接测 */
    try {
      fs.accessSync(filePath, fs.constants.W_OK);
      return { success: true };
    } catch { /* 继续下一级 */ }

    /* 2) chmod 解除只读 */
    try {
      fs.chmodSync(filePath, 0o644);
      fs.accessSync(filePath, fs.constants.W_OK);
      log('info', TAG, `chmod 解除只读: ${filePath}`);
      return { success: true };
    } catch { /* 继续 */ }

    /* 3)+4) Windows: icacls 加写权限 */
    if (process.platform === 'win32') {
      /* 3) 先试普通 icacls (通常当前用户对自己目录下文件够了) */
      try {
        const me = process.env.USERNAME || process.env.USER || '';
        if (me) {
          execSync(`icacls "${filePath}" /grant "${me}":(M) /Q`, { stdio: 'ignore' });
          fs.accessSync(filePath, fs.constants.W_OK);
          log('info', TAG, `icacls 授权成功 (${me}): ${filePath}`);
          return { success: true };
        }
      } catch { /* 继续提权 */ }

      /* 4) UAC 提权: 弹窗让用户确认 */
      try {
        const escaped = filePath.replace(/"/g, '""');
        const psCmd = `Start-Process -FilePath icacls -ArgumentList '"${escaped}"','/grant','Everyone:(F)','/Q' -Verb RunAs -Wait -WindowStyle Hidden`;
        execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'ignore', timeout: 30000 });
        fs.accessSync(filePath, fs.constants.W_OK);
        log('info', TAG, `UAC 提权成功 (Everyone:F): ${filePath}`);
        return { success: true };
      } catch (err: any) {
        const msg = err.message || String(err);
        log('error', TAG, `UAC 提权失败: ${msg}`);
        return { success: false, error: `文件无写入权限, UAC 提权失败: ${msg}` };
      }
    }

    /* 非 Windows: chmod 都失败则认输, 让用户 sudo */
    return { success: false, error: '文件无写入权限, 请用 sudo 或 chmod 手动授权后重试' };
  }

  /**
   * 带提权链的 writeFileSync
   *
   * 首次直接写, 失败自动走 ensureFileWritable 提权后重试一次
   * 仍失败则抛错 (调用方自己 try/catch)
   */
  private writeFileWithRetry(filePath: string, content: string): void {
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      return;
    } catch (err: any) {
      log('warn', TAG, `直接写入失败, 尝试提权: ${err.message}`);
      const check = this.ensureFileWritable(filePath);
      if (!check.success) {
        throw new Error(check.error || '无写入权限');
      }
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }

  /* ========== URI Patch 方法组 (兜底切号) ========== */

  /**
   * 应用 URI Patch (可选, 独立于核心 patch)
   *
   * 使用场景:
   *   - 核心 patch (handleAuthTokenWithShit) 被 Windsurf 版本升级干掉时, URI 模式兜底
   *   - 用户主动通过 `wfSwitcher.switchMode = "uri"` 配置时
   *
   * 幂等: 已应用则直接返回 success=true
   *
   * @returns success / needsRestart / error
   */
  async applyUriPatch(): Promise<{ success: boolean; needsRestart: boolean; error?: string }> {
    this.ensureInitialized();
    if (!this.extensionJsPath || !fs.existsSync(this.extensionJsPath)) {
      return { success: false, needsRestart: false, error: '未找到 Windsurf extension.js' };
    }

    /* 预检写权限 */
    const writable = this.ensureFileWritable(this.extensionJsPath);
    if (!writable.success) {
      return { success: false, needsRestart: false, error: writable.error || '文件无写权限' };
    }

    try {
      let content = fs.readFileSync(this.extensionJsPath, 'utf-8');

      /* 幂等: 已有 marker 直接跳过 */
      if (content.includes(URI_PATCH_MARKER)) {
        log('info', TAG, 'URI 补丁已应用, 跳过');
        return { success: true, needsRestart: false };
      }

      /* 匹配原生 URI handler (宽松正则, 只抓前半段, 再 bracket-matching 找整个 callback 体) */
      const match = content.match(URI_HANDLER_REGEX);
      if (!match || match.index === undefined) {
        return { success: false, needsRestart: false, error: '未找到 _uriHandler.event 注入点, Windsurf 版本可能不兼容' };
      }

      const [, paramName, moduleName] = match;

      /* bracket-matching: 从 this._uriHandler.event( 开始, 找到匹配的 `)` 闭合
       * 结果就是完整的 `this._uriHandler.event(A=>{...整个callback...})` */
      const eventAnchor = 'this._uriHandler.event(';
      const eventStart = content.lastIndexOf(eventAnchor, match.index);
      if (eventStart < 0) {
        return { success: false, needsRestart: false, error: 'bracket-matching: 找不到 event( 起点' };
      }
      let depth = 0;
      let eventEnd = -1;
      for (let i = eventStart + eventAnchor.length - 1; i < content.length; i++) {
        const ch = content[i];
        if (ch === '(') { depth++; }
        else if (ch === ')') {
          depth--;
          if (depth === 0) { eventEnd = i; break; }
        }
      }
      if (eventEnd < 0) {
        return { success: false, needsRestart: false, error: 'bracket-matching: event callback 括号未闭合' };
      }
      const whole = content.slice(eventStart, eventEnd + 1);
      log('info', TAG, `URI handler 原始代码: ${whole.length} 字符`);

      /* 提取 else 分支:
       * 原代码形如 `...refreshAuthenticationSession()():ELSE_BRANCH})` 或 `...refreshAuthenticationSession()()&&ELSE_BRANCH})`
       * refreshAuthenticationSession() 后面可能是 `()` (调用) 再跟 `:` 或 `&&`
       * 我们找 refreshAuthenticationSession 调用闭合后到 `})` 之间的部分就是 else */
      const refreshIdx = whole.indexOf('refreshAuthenticationSession');
      let elseCode = '';
      if (refreshIdx >= 0) {
        /* 找 refreshAuthenticationSession)() 结束的位置 */
        let callEnd = whole.indexOf('()', refreshIdx + 'refreshAuthenticationSession'.length);
        if (callEnd >= 0) {
          callEnd += 2; /* 跳过 () */
          /* 从 callEnd 开始到 `})` 之间就是 else 逻辑 (含冒号/&&等分隔符) */
          const tail = whole.slice(callEnd);
          /* tail 形如 `:this._loginInProgress||this.maybeHandleUriWithToken(A)})` 或 `})` */
          const closeBrace = tail.lastIndexOf('})');
          if (closeBrace >= 0) {
            let elsePart = tail.slice(0, closeBrace).trim();
            /* 去掉开头的 `:` 或 `&&` 分隔符 */
            if (elsePart.startsWith(':')) { elsePart = elsePart.slice(1); }
            else if (elsePart.startsWith('&&')) { elsePart = elsePart.slice(2); }
            elseCode = elsePart.trim();
          }
        }
      }
      if (elseCode) {
        log('info', TAG, `原始 else 分支: ${elseCode.slice(0, 80)}${elseCode.length > 80 ? '...' : ''}`);
      } else {
        log('info', TAG, '未检测到 else 分支 (老版 Windsurf)');
      }

      /* 备份 (独立于核心 patch 的备份序列, 文件名不同避免冲突) */
      const ts = new Date().toISOString().replace(/[:.]/g, '').substring(0, 15);
      const backupPath = this.extensionJsPath + `.uribackup.${ts}`;
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(this.extensionJsPath, backupPath);
        log('info', TAG, `已创建 URI patch 备份: ${backupPath}`);
      }

      /* 替换 */
      const replacement = generateUriHandlerReplacement(paramName, moduleName, elseCode ? `;${elseCode};` : '');
      content = content.replace(whole, replacement);

      /* 校验: marker 必须真的写进去了 */
      if (!content.includes(URI_PATCH_MARKER)) {
        return { success: false, needsRestart: false, error: 'URI 补丁替换后 marker 缺失, 放弃写入' };
      }

      this.writeFileWithRetry(this.extensionJsPath, content);
      log('info', TAG, `✅ URI 补丁已应用 (param=${paramName}, module=${moduleName})`);
      return { success: true, needsRestart: true };
    } catch (err: any) {
      log('error', TAG, `URI 补丁失败: ${err.message}`);
      return { success: false, needsRestart: false, error: err.message };
    }
  }

  /** URI Patch 是否已应用 */
  isUriPatchApplied(): boolean {
    this.ensureInitialized();
    if (!this.extensionJsPath || !fs.existsSync(this.extensionJsPath)) {
      return false;
    }
    try {
      const content = fs.readFileSync(this.extensionJsPath, 'utf-8');
      return content.includes(URI_PATCH_MARKER);
    } catch {
      return false;
    }
  }

  /**
   * 恢复 URI Patch (使用 .uribackup.* 备份还原)
   * 没有 URI 专属备份时回退用普通 .backup.* (可能也还原了核心 patch)
   */
  async restoreUriPatch(): Promise<boolean> {
    this.ensureInitialized();
    if (!this.extensionJsPath) { return false; }

    const dir = path.dirname(this.extensionJsPath);
    try {
      /* 优先找 URI 专属备份 */
      let backups = fs.readdirSync(dir)
        .filter(f => f.startsWith('extension.js.uribackup.'))
        .map(f => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

      if (backups.length === 0) {
        /* 回退: 用核心 patch 的备份 (会连带还原 handleAuthTokenWithShit, 用户自行决定) */
        log('warn', TAG, '无 URI 专属备份, 回退用核心 patch 备份');
        backups = fs.readdirSync(dir)
          .filter(f => f.startsWith('extension.js.backup.'))
          .map(f => path.join(dir, f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      }

      if (backups.length === 0) {
        log('warn', TAG, '没有找到任何备份文件');
        return false;
      }

      const writable = this.ensureFileWritable(this.extensionJsPath);
      if (!writable.success) {
        log('error', TAG, `URI 补丁恢复失败: ${writable.error}`);
        return false;
      }

      fs.copyFileSync(backups[0], this.extensionJsPath);
      log('info', TAG, `URI 补丁已恢复: ${backups[0]}`);
      return true;
    } catch (err: any) {
      log('error', TAG, `URI 补丁恢复失败: ${err.message}`);
      return false;
    }
  }

  /** 恢复补丁 (使用最新备份) */
  async restoreAll(): Promise<boolean> {
    this.ensureInitialized();
    if (!this.extensionJsPath) { return false; }

    const dir = path.dirname(this.extensionJsPath);
    try {
      const backups = fs.readdirSync(dir)
        .filter(f => f.startsWith('extension.js.backup.'))
        .map(f => path.join(dir, f))
        .sort((a, b) => {
          const statA = fs.statSync(a);
          const statB = fs.statSync(b);
          return statB.mtimeMs - statA.mtimeMs;
        });

      if (backups.length === 0) {
        log('warn', TAG, '没有找到备份文件');
        return false;
      }

      /* 恢复前确保可写 */
      const writable = this.ensureFileWritable(this.extensionJsPath);
      if (!writable.success) {
        log('error', TAG, `恢复失败: ${writable.error}`);
        return false;
      }

      const latestBackup = backups[0];
      fs.copyFileSync(latestBackup, this.extensionJsPath);
      log('info', TAG, `已从备份恢复: ${latestBackup}`);
      return true;
    } catch (err: any) {
      log('error', TAG, `恢复失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 修复旧补丁造成的核心文件损坏
   * 扫描 resources/app/out/ 目录下的 .backup 文件并还原
   */
  async repairCorruption(): Promise<{ repaired: boolean; files: string[] }> {
    if (!this.windsurfPath) {
      return { repaired: false, files: [] };
    }

    const repairedFiles: string[] = [];
    const outDir = path.join(this.windsurfPath, 'resources', 'app', 'out');

    if (!fs.existsSync(outDir)) {
      return { repaired: false, files: [] };
    }

    try {
      const findBackups = (dir: string, depth: number = 4): string[] => {
        const results: string[] = [];
        if (depth <= 0) { return results; }
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              results.push(...findBackups(fullPath, depth - 1));
            } else if (entry.name.endsWith('.backup')) {
              results.push(fullPath);
            }
          }
        } catch { /* 忽略权限错误 */ }
        return results;
      };

      const backups = findBackups(outDir);

      for (const backupPath of backups) {
        const originalPath = backupPath.replace(/\.backup$/, '');
        if (fs.existsSync(originalPath)) {
          fs.copyFileSync(backupPath, originalPath);
          fs.unlinkSync(backupPath);
          repairedFiles.push(path.basename(originalPath));
          log('info', TAG, `已修复: ${originalPath}`);
        }
      }

      if (repairedFiles.length > 0) {
        log('info', TAG, `修复完成，共还原 ${repairedFiles.length} 个核心文件`);
      }
    } catch (err: any) {
      log('warn', TAG, `修复扫描失败: ${err.message}`);
    }

    return { repaired: repairedFiles.length > 0, files: repairedFiles };
  }

  /** 获取 Windsurf 路径 (供 UI 显示) */
  getWindsurfPath(): string {
    return this.windsurfPath || '未检测到';
  }

  /**
   * 检测 Windsurf 是否正在运行
   *
   * 用途:
   *   - CLI / MCP 场景: 打补丁前判断 Windsurf 是否在跑, 在跑就提示"改完要重启"
   *   - UI 场景: 显示"当前 Windsurf 进程数: N", 多开时警告
   *   - 注意: 插件自身跑在 Windsurf 扩展宿主里时, 本函数**必然返回 true** (自己也是 Windsurf 进程)
   *          这个 API 的价值主要体现在"进程数 > 预期值" (多开) 和 CLI 独立调用场景
   *
   * 实现:
   *   - Windows: tasklist /FI "IMAGENAME eq Windsurf.exe"
   *   - macOS / Linux: ps -axo comm= | grep -i windsurf
   *
   * @returns 至少有一个 Windsurf 进程在运行
   */
  isWindsurfRunning(): boolean {
    return this.getWindsurfProcessCount() > 0;
  }

  /**
   * 获取当前 Windsurf 进程数 (用于多开检测)
   *
   * 经验值参考:
   *   - 单个 Windsurf 窗口通常会拉起 5~8 个进程 (主进程 + 渲染进程 + 扩展宿主 + GPU + utility)
   *   - 两个窗口差不多 10~15 个
   *   - 具体数值因版本/项目/扩展数量而异, 不要死板卡阈值
   *
   * @returns 进程数, 检测失败返回 0
   */
  getWindsurfProcessCount(): number {
    try {
      if (process.platform === 'win32') {
        const out = execSync(
          'tasklist /FI "IMAGENAME eq Windsurf.exe" /FO CSV /NH',
          { encoding: 'utf-8', timeout: 3000, windowsHide: true }
        );
        /* 无匹配时 tasklist 会输出 "信息: 没有运行的任务匹配指定标准。" */
        if (/没有运行的任务|No tasks are running/i.test(out)) { return 0; }
        return out.split('\n').filter(l => /Windsurf\.exe/i.test(l)).length;
      }

      /* Unix-like (macOS / Linux) */
      const out = execSync('ps -axo comm=', { encoding: 'utf-8', timeout: 3000 });
      return out.split('\n').filter(l => /windsurf/i.test(l.trim())).length;
    } catch (err: any) {
      log('debug', TAG, `进程检测失败: ${err.message}`);
      return 0;
    }
  }

  /** 获取 extension.js 路径 (供诊断/外部调用) */
  getExtensionJsPath(): string {
    this.ensureInitialized();
    return this.extensionJsPath;
  }

  /**
   * 补丁: 固定 generateFingerprint 返回值
   * 在函数体开头注入 early return, 让函数始终返回一个固定的随机指纹
   * 可重入: 如果已补丁则替换为新随机值
   *
   * @returns MachineIdResetStep 结果
   */
  patchFingerprint(): MachineIdResetStep {
    this.ensureInitialized();
    const stepName = 'Patch: generateFingerprint';

    if (!this.extensionJsPath || !fs.existsSync(this.extensionJsPath)) {
      return { name: stepName, success: false, error: '未找到 Windsurf extension.js' };
    }

    try {
      let content = fs.readFileSync(this.extensionJsPath, 'utf-8');
      const newFp = crypto.randomBytes(32).toString('hex'); // 64 字符 hex
      const injection = `return"${newFp}"${FP_MARKER};`;

      if (content.includes(FP_MARKER)) {
        /* 可重入: 替换旧注入值 */
        const reEntryRegex = /return"[a-f0-9]{64}"\/\*WF_FP\*\/;/;
        if (reEntryRegex.test(content)) {
          content = content.replace(reEntryRegex, injection);
          fs.writeFileSync(this.extensionJsPath, content, 'utf-8');
          log('info', TAG, `✅ fingerprint 补丁已更新 (重入): ${newFp.substring(0, 16)}...`);
          return { name: stepName, success: true, value: newFp.substring(0, 16) + '... (更新)' };
        }
        /* 标记存在但格式不匹配, 视为已补丁 */
        log('info', TAG, 'fingerprint 补丁标记存在但格式异常, 跳过');
        return { name: stepName, success: true, value: '已存在 (跳过)' };
      }

      /* 首次注入: 尝试多种函数签名模式 */
      let matched = false;
      for (const pattern of FP_FUNC_PATTERNS) {
        const match = content.match(pattern);
        if (match && match.index !== undefined) {
          const insertAt = match.index + match[0].length;
          content = content.substring(0, insertAt) + injection + content.substring(insertAt);
          matched = true;
          log('info', TAG, `fingerprint 匹配模式: ${pattern.source}`);
          break;
        }
      }

      if (!matched) {
        log('warn', TAG, '未找到 generateFingerprint 函数, 跳过补丁');
        return { name: stepName, success: false, error: '未找到目标函数 (可能版本不兼容)' };
      }

      fs.writeFileSync(this.extensionJsPath, content, 'utf-8');
      log('info', TAG, `✅ fingerprint 补丁注入成功: ${newFp.substring(0, 16)}...`);
      return { name: stepName, success: true, value: newFp.substring(0, 16) + '...' };
    } catch (err: any) {
      log('error', TAG, `fingerprint 补丁失败: ${err.message}`);
      return { name: stepName, success: false, error: err.message };
    }
  }

  /**
   * 补丁: 固定 getOrGenerateInstallationId 返回值
   * 原理同 patchFingerprint, 注入 early return 返回固定 UUID
   *
   * @returns MachineIdResetStep 结果
   */
  patchInstallationId(): MachineIdResetStep {
    this.ensureInitialized();
    const stepName = 'Patch: installationId';

    if (!this.extensionJsPath || !fs.existsSync(this.extensionJsPath)) {
      return { name: stepName, success: false, error: '未找到 Windsurf extension.js' };
    }

    try {
      let content = fs.readFileSync(this.extensionJsPath, 'utf-8');
      const newId = crypto.randomUUID();
      const injection = `return"${newId}"${IID_MARKER};`;

      if (content.includes(IID_MARKER)) {
        /* 可重入: 替换旧值 */
        const reEntryRegex = /return"[a-f0-9-]{36}"\/\*WF_IID\*\/;/;
        if (reEntryRegex.test(content)) {
          content = content.replace(reEntryRegex, injection);
          fs.writeFileSync(this.extensionJsPath, content, 'utf-8');
          log('info', TAG, `✅ installationId 补丁已更新 (重入): ${newId}`);
          return { name: stepName, success: true, value: newId.substring(0, 8) + '... (更新)' };
        }
        log('info', TAG, 'installationId 补丁标记存在但格式异常, 跳过');
        return { name: stepName, success: true, value: '已存在 (跳过)' };
      }

      /* 首次注入: 尝试多种函数名模式 */
      let matched = false;
      for (const pattern of IID_FUNC_PATTERNS) {
        const match = content.match(pattern);
        if (match && match.index !== undefined) {
          const insertAt = match.index + match[0].length;
          content = content.substring(0, insertAt) + injection + content.substring(insertAt);
          matched = true;
          log('info', TAG, `installationId 匹配模式: ${pattern.source}`);
          break;
        }
      }

      if (!matched) {
        log('warn', TAG, '未找到 installationId 函数, 跳过补丁');
        return { name: stepName, success: false, error: '未找到目标函数 (可能版本不兼容)' };
      }

      fs.writeFileSync(this.extensionJsPath, content, 'utf-8');
      log('info', TAG, `✅ installationId 补丁注入成功: ${newId}`);
      return { name: stepName, success: true, value: newId.substring(0, 8) + '...' };
    } catch (err: any) {
      log('error', TAG, `installationId 补丁失败: ${err.message}`);
      return { name: stepName, success: false, error: err.message };
    }
  }

  /** 获取方案列表 (供 UI 显示) */
  getSchemeList(): Array<{ id: string; description: string; applied: boolean }> {
    this.ensureInitialized();
    return Object.entries(PATCH_SCHEMES).map(([id, scheme]) => ({
      id,
      description: scheme.description,
      applied: this.isSchemeApplied(id)
    }));
  }
}
