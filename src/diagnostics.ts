import * as vscode from 'vscode';
import { AccountManager } from './accountManager';
import { InstanceManager } from './instanceManager';
import { WindsurfPatch } from './windsurfPatch';

interface DiagnosticReportInput {
  context: vscode.ExtensionContext;
  accountManager: AccountManager;
  instanceManager: InstanceManager;
  windsurfPatch: WindsurfPatch;
}

export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const config = vscode.workspace.getConfiguration('wfSwitcher');
  const accounts = input.accountManager.getAccounts();
  const groups = input.accountManager.getGroups();
  const active = input.accountManager.getActiveAccount();
  const patchDiagnostics = safeCall(() => input.windsurfPatch.getPatchDiagnostics(), null);
  const patchStatus = safeCall(() => input.windsurfPatch.getPatchStatus(), null);
  const processCount = safeCall(() => input.windsurfPatch.getWindsurfProcessCount(), 0);
  const instances = safeCall(() => input.instanceManager.getAllInstances(), []);
  const pkg = input.context.extension?.packageJSON || {};

  const lines: string[] = [];
  lines.push('WF-Swap 诊断报告');
  lines.push(`生成时间: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('[扩展]');
  lines.push(`版本: ${pkg.version || 'unknown'}`);
  lines.push(`扩展路径: ${input.context.extensionPath}`);
  lines.push(`VS Code: ${vscode.version}`);
  lines.push(`App: ${vscode.env.appName}`);
  lines.push(`Node: ${process.versions.node}`);
  lines.push(`Electron: ${process.versions.electron || 'unknown'}`);
  lines.push(`平台: ${process.platform} ${process.arch}`);
  lines.push('');
  lines.push('[账号]');
  lines.push(`账号数: ${accounts.length}`);
  lines.push(`分组数: ${groups.length}`);
  lines.push(`活跃账号: ${active ? maskEmail(active.email) : '无'}`);
  lines.push(`已登录(apiKey存在): ${accounts.filter(a => !!a.apiKey).length}`);
  lines.push(`Devin策略账号: ${accounts.filter(a => a.authStrategy === 'devin_auth').length}`);
  lines.push(`Firebase策略账号: ${accounts.filter(a => a.authStrategy === 'firebase').length}`);
  lines.push('');
  lines.push('[设置]');
  lines.push(`switchMode: ${config.get<string>('switchMode', 'patch')}`);
  lines.push(`autoSwitchEnabled: ${config.get<boolean>('autoSwitchEnabled', false)}`);
  lines.push(`autoSwitchSilent: ${config.get<boolean>('autoSwitchSilent', false)}`);
  lines.push(`autoSwitchThreshold: ${config.get<number>('autoSwitchThreshold', 5)}`);
  lines.push(`autoSwitchPlanType: ${config.get<string>('autoSwitchPlanType', 'All')}`);
  lines.push(`autoResetMachineIdOnAutoSwitch: ${config.get<boolean>('autoResetMachineIdOnAutoSwitch', false)}`);
  lines.push(`balanceAutoRefresh: ${config.get<boolean>('balanceAutoRefresh', true)}`);
  lines.push(`balanceRefreshInterval: ${config.get<number>('balanceRefreshInterval', 30)}`);
  lines.push(`concurrentLimit: ${config.get<number>('concurrentLimit', 5)}`);
  lines.push(`unlimitedConcurrent: ${config.get<boolean>('unlimitedConcurrent', false)}`);
  lines.push(`cfProxyEnabled: ${config.get<boolean>('cfProxyEnabled', true)}`);
  lines.push(`cfProxyUrl: ${redactUrl(config.get<string>('cfProxyUrl', ''))}`);
  lines.push(`proxyUrl: ${redactUrl(config.get<string>('proxyUrl', ''))}`);
  lines.push('');
  lines.push('[补丁]');
  lines.push(`Windsurf路径: ${input.windsurfPatch.getWindsurfPath()}`);
  lines.push(`Windsurf进程数: ${processCount}`);
  if (patchStatus) {
    lines.push(`有备份: ${patchStatus.hasBackup}`);
    for (const [id, applied] of Object.entries(patchStatus.schemes)) {
      lines.push(`方案 ${id}: ${applied ? '已应用' : '未应用'}`);
    }
  } else {
    lines.push('补丁状态: 获取失败');
  }
  if (patchDiagnostics) {
    lines.push(`extension.js: ${patchDiagnostics.extensionJsPath || '未找到'}`);
    lines.push(`extension.js存在: ${patchDiagnostics.extensionJsExists}`);
    lines.push(`extension.js可写: ${patchDiagnostics.writable}`);
    lines.push(`备份数量: ${patchDiagnostics.backups.length}`);
    for (const scheme of patchDiagnostics.schemes) {
      lines.push(`预检 ${scheme.id}: ${scheme.applied ? '已应用' : scheme.canApply ? '可应用' : '不可应用'}${scheme.reason ? ` (${scheme.reason})` : ''}`);
    }
  } else {
    lines.push('补丁诊断: 获取失败');
  }
  lines.push('');
  lines.push('[实例]');
  lines.push(`当前实例: ${input.instanceManager.getMyInstanceId()}`);
  lines.push(`当前数据目录: ${input.instanceManager.getMyDataDir()}`);
  lines.push(`实例数: ${instances.length}`);
  for (const inst of instances) {
    const locked = inst.lockedEmail ? maskEmail(inst.lockedEmail) : '无';
    lines.push(`- ${inst.label}: locked=${locked}, lastSeen=${inst.lastSeen || '无'}`);
  }

  return lines.join('\n');
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) { return email; }
  const maskedName = name.length <= 2 ? name[0] + '*' : name[0] + '*'.repeat(Math.min(name.length - 2, 4)) + name[name.length - 1];
  const parts = domain.split('.');
  const domainName = parts[0] || '';
  const suffix = parts.slice(1).join('.');
  const maskedDomain = domainName.length <= 2 ? domainName[0] + '*' : domainName[0] + '*'.repeat(Math.min(domainName.length - 2, 3)) + domainName[domainName.length - 1];
  return `${maskedName}@${maskedDomain}${suffix ? '.' + suffix : ''}`;
}

function redactUrl(value?: string): string {
  const raw = (value || '').trim();
  if (!raw) { return '未配置'; }
  try {
    const url = new URL(raw);
    url.username = url.username ? '***' : '';
    url.password = url.password ? '***' : '';
    url.search = url.search ? '?***' : '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/:\/\/([^/@]+)@/, '://***@');
  }
}
