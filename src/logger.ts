/**
 * 日志工具 - 统一输出到 VS Code OutputChannel
 * 开发者: Ti
 */

import * as vscode from 'vscode';
import { LogLevel } from './types';

let outputChannel: vscode.OutputChannel | null = null;

/** 初始化日志通道 */
export function initLogger(channel: vscode.OutputChannel): void {
  outputChannel = channel;
}

/** 获取当前时间字符串 */
function timestamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/** 写日志 */
export function log(level: LogLevel, tag: string, message: string): void {
  const line = `[${timestamp()}] [${level.toUpperCase()}] [${tag}] ${message}`;
  if (outputChannel) {
    outputChannel.appendLine(line);
  }
  if (level === 'error') {
    console.error(line);
  }
}

/** 显示输出面板 */
export function showOutput(): void {
  outputChannel?.show(true);
}
