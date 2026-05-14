/**
 * 代理工具模块
 * 支持 Cloudflare Workers 代理中转 + 本地代理 (SOCKS5/HTTP)
 * 优先级: CF Worker 中转 > 本地代理 > 直连
 * 开发者: Ti
 */

import * as vscode from 'vscode';
import { Agent } from 'http';
import { execSync } from 'child_process';
import { log } from './logger';

const TAG = 'ProxyAgent';

/** 缓存的代理 agent */
let cachedAgent: Agent | null = null;
let cachedProxyUrl: string | null = null;

/**
 * 获取代理 Agent (用于 axios 的 httpAgent/httpsAgent)
 * 优先级: VS Code 设置 > 环境变量 > 自动探测本地端口
 * @returns Agent 或 undefined (无代理时直连)
 */
export async function getProxyAgent(): Promise<Agent | undefined> {
  const proxyUrl = await detectProxyUrl();
  if (!proxyUrl) {
    return undefined;
  }

  /* 缓存命中 */
  if (cachedAgent && cachedProxyUrl === proxyUrl) {
    return cachedAgent;
  }

  try {
    let agent: Agent;

    if (proxyUrl.startsWith('socks')) {
      /* SOCKS5 代理 (v2ray/xray 常用) */
      const { SocksProxyAgent } = require('socks-proxy-agent');
      agent = new SocksProxyAgent(proxyUrl);
      log('info', TAG, `使用 SOCKS5 代理: ${proxyUrl}`);
    } else {
      /* HTTP/HTTPS 代理 (Clash 常用) */
      const { HttpsProxyAgent } = require('https-proxy-agent');
      agent = new HttpsProxyAgent(proxyUrl);
      log('info', TAG, `使用 HTTP 代理: ${proxyUrl}`);
    }

    cachedAgent = agent;
    cachedProxyUrl = proxyUrl;
    return agent;
  } catch (err: any) {
    log('error', TAG, `创建代理 Agent 失败: ${err.message}`);
    return undefined;
  }
}

/**
 * 获取 axios 请求的代理配置
 * @returns axios 配置对象 (httpAgent, httpsAgent, proxy)
 */
export async function getAxiosProxyConfig(): Promise<Record<string, any>> {
  const agent = await getProxyAgent();
  if (!agent) {
    return {};
  }
  /* 用自定义 agent 时必须禁用 axios 内置 proxy */
  return {
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false
  };
}

/**
 * 探测代理 URL
 * 优先级:
 *   1. VS Code 设置 (wfSwitcher.proxyUrl)
 *   2. 环境变量 (https_proxy / http_proxy / ALL_PROXY)
 *   3. Windows 系统代理 (注册表 Internet Settings)
 *   4. 自动探测常见本地代理端口
 */
async function detectProxyUrl(): Promise<string | null> {
  /* 1. VS Code 设置 */
  const config = vscode.workspace.getConfiguration('wfSwitcher');
  const manualUrl = config.get<string>('proxyUrl', '').trim();
  if (manualUrl) {
    log('info', TAG, `使用手动配置代理: ${manualUrl}`);
    return manualUrl;
  }

  /* 2. 环境变量 */
  const envProxy = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) {
    log('info', TAG, `使用环境变量代理: ${envProxy}`);
    return envProxy;
  }

  /* 3. Windows 系统代理 (HKCU\...\Internet Settings) */
  if (process.platform === 'win32') {
    const regProxy = readWindowsSystemProxy();
    if (regProxy) {
      log('info', TAG, `使用 Windows 系统代理 (注册表): ${regProxy}`);
      return regProxy;
    }
  }

  /* 4. 自动探测常见本地代理端口
   * 排序原则: 越具体越靠前 (SOCKS5 特征端口 > HTTP 通用端口) */
  const probeList: Array<{ port: number; protocol: string }> = [
    /* SOCKS5 (v2ray/xray/v2rayN) */
    { port: 10808, protocol: 'socks5' },
    { port: 20170, protocol: 'socks5' },
    { port: 20171, protocol: 'socks5' },  /* v2rayN 高版本默认 */
    { port: 20172, protocol: 'socks5' },
    { port: 1080, protocol: 'socks5' },
    /* HTTP (Clash/Clash Verge/Surge) */
    { port: 7890, protocol: 'http' },
    { port: 7891, protocol: 'http' },
    { port: 7897, protocol: 'http' },     /* Clash Verge 默认 */
    { port: 8080, protocol: 'http' },
    { port: 8118, protocol: 'http' },     /* Privoxy 默认 */
    { port: 1081, protocol: 'http' },
    /* SOCKS5 (其他) */
    { port: 10801, protocol: 'socks5' },
    { port: 2080, protocol: 'socks5' },
  ];

  for (const { port, protocol } of probeList) {
    if (await isPortOpen(port)) {
      const url = `${protocol}://127.0.0.1:${port}`;
      log('info', TAG, `自动探测到本地代理: ${url}`);
      return url;
    }
  }

  log('info', TAG, '未检测到代理，使用直连');
  return null;
}

/**
 * 读取 Windows 系统代理 (注册表 HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings)
 *
 * 系统设置里"使用代理服务器"打开时, ProxyEnable=1 + ProxyServer=host:port
 * 多协议时格式形如 `http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:1080`
 *
 * 优先级: https > http > 通用 (host:port)
 *
 * @returns 可直接用的代理 URL, 未开启或读取失败返回 null
 */
function readWindowsSystemProxy(): string | null {
  try {
    /* Windows reg query 一次只能带 一个 /v, 写两个 /v 会报"无效语法"
     * 所以分两次读 ProxyEnable 和 ProxyServer */
    const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const opts = { encoding: 'utf-8' as const, timeout: 3000, windowsHide: true };

    const enableOut = execSync(`reg query "${regKey}" /v ProxyEnable`, opts);
    const enableMatch = enableOut.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
    if (!enableMatch || parseInt(enableMatch[1], 16) === 0) {
      return null; /* 系统代理未开启 */
    }

    const serverOut = execSync(`reg query "${regKey}" /v ProxyServer`, opts);
    const serverMatch = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (!serverMatch) { return null; }
    const serverRaw = serverMatch[1].trim();
    if (!serverRaw) { return null; }

    /* 多协议格式: "http=H:P;https=H:P;socks=H:P" */
    if (serverRaw.includes('=')) {
      const pairs = serverRaw.split(';').map(s => s.trim()).filter(Boolean);
      const kvMap: Record<string, string> = {};
      for (const pair of pairs) {
        const [k, v] = pair.split('=').map(s => s.trim());
        if (k && v) { kvMap[k.toLowerCase()] = v; }
      }
      /* 优先级: https > http > socks */
      if (kvMap.https) { return `http://${kvMap.https}`; }
      if (kvMap.http) { return `http://${kvMap.http}`; }
      if (kvMap.socks) { return `socks5://${kvMap.socks}`; }
      return null;
    }

    /* 单协议格式: "host:port" → 默认当 http */
    return `http://${serverRaw}`;
  } catch (err: any) {
    log('debug', TAG, `读注册表代理失败: ${err.message || err}`);
    return null;
  }
}

/**
 * 检测本地端口是否开放
 */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const net = require('net');
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 500 });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

/** 清除缓存（代理配置变更后调用） */
export function clearProxyCache(): void {
  cachedAgent = null;
  cachedProxyUrl = null;
  log('info', TAG, '代理缓存已清除');
}

/** 默认 CF Worker 代理地址 (硬编码，用户无需配置) */
const DEFAULT_CF_PROXY = 'https://windsurfapi.karelxiaxia.workers.dev';

/**
 * 获取 Cloudflare Workers 代理基础 URL
 * 启用时优先使用用户自定义配置，否则使用内置默认地址
 * @returns 代理 URL，关闭时返回 null
 */
export function getCfProxyBaseUrl(): string | null {
  const config = vscode.workspace.getConfiguration('wfSwitcher');
  const enabled = config.get<boolean>('cfProxyEnabled', true);
  if (!enabled) {
    return null;
  }
  const cfUrl = config.get<string>('cfProxyUrl', '').trim();
  /* 用户自定义优先，否则用默认 */
  const url = cfUrl || DEFAULT_CF_PROXY;
  const normalized = url.replace(/\/+$/, '');
  return normalized;
}

/**
 * 判断 Cloudflare Workers 代理是否已启用
 * @returns true 表示配置了 CF 代理 URL
 */
export function isCfProxyEnabled(): boolean {
  return getCfProxyBaseUrl() !== null;
}
