/**
 * Webview HTML 模板 - 从 webviewContent.ts 提取
 * macOS 风格界面
 */

import * as vscode from 'vscode';
import { getStyles } from './styles';
import { getScript } from './script';

/**
 * 生成 Webview HTML 内容
 * @param webview - Webview 实例
 * @param extensionUri - 扩展根目录 URI
 * @returns 完整 HTML 字符串
 */
export function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>WF-Swap</title>
  <style>${getStyles()}</style>
</head>
<body>
  <!-- 首屏加载占位 (webview 脚本一收到首次 stateUpdate 就隐藏) -->
  <div id="bootOverlay" style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font-family:var(--vscode-font-family,sans-serif);z-index:9999;gap:8px;">
    <div style="width:24px;height:24px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:bootspin 0.8s linear infinite;opacity:0.7;"></div>
    <div style="font-size:12px;opacity:0.7;">正在加载 WF-Swap...</div>
    <div id="bootError" style="display:none;max-width:320px;padding:8px 12px;margin-top:12px;border:1px solid #c33;background:rgba(204,51,51,0.1);color:#f88;font-size:11px;text-align:left;white-space:pre-wrap;word-break:break-all;border-radius:4px;"></div>
    <style>@keyframes bootspin{to{transform:rotate(360deg);}}</style>
  </div>
  <div id="app">
    <!-- 顶栏 -->
    <header class="toolbar">
      <span class="toolbar-title">WF-Swap</span>
      <div class="toolbar-actions">
        <button class="btn-icon" id="btnRefreshAll" title="刷新所有余额">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
        </button>
        <button class="btn-icon" id="btnImport" title="导入账号">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="btn-icon" id="btnAddGroup" title="新建分组">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
        </button>
        <button class="btn-icon" id="btnExport" title="导出账号">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
      </div>
    </header>

    <!-- 当前账号卡片 -->
    <section class="card active-card" id="activeCard">
      <div class="card-header">
        <span class="card-label">当前账号</span>
        <span class="badge" id="planBadge">--</span>
      </div>
      <div class="active-name" id="activeName"></div>
      <div class="active-email" id="activeEmail">未登录</div>
      <div class="quota-bars">
        <div class="quota-row">
          <span class="quota-label">日</span>
          <div class="progress-track"><div class="progress-fill" id="dailyBar" style="width:0%"></div></div>
          <span class="quota-value" id="dailyValue">--</span>
          <span class="quota-reset" id="dailyReset"></span>
        </div>
        <div class="quota-row">
          <span class="quota-label">周</span>
          <div class="progress-track"><div class="progress-fill" id="weeklyBar" style="width:0%"></div></div>
          <span class="quota-value" id="weeklyValue">--</span>
          <span class="quota-reset" id="weeklyReset"></span>
        </div>
      </div>
    </section>

    <!-- 导入弹窗 -->
    <div class="modal-overlay" id="importModal" style="display:none">
      <div class="modal">
        <div class="modal-header">
          <span>导入账号</span>
          <button class="btn-icon modal-close" id="importClose">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <!-- 导入方式 Tab -->
          <div class="import-tabs">
            <button class="import-tab active" data-mode="batch">批量导入</button>
            <button class="import-tab" data-mode="token">Token 导入</button>
            <button class="import-tab" data-mode="server">服务端导入</button>
          </div>

          <!-- Tab1: 批量导入 (凭据类型自动识别) -->
          <div class="import-tab-content" id="importTab-batch">
            <textarea id="importText" placeholder="每行一个账号, 邮箱和凭据之间加分隔符即可, 凭据类型自动识别:&#10;&#10;  邮箱:密码&#10;  邮箱:auth1_xxxxxxxx&#10;  邮箱:长refresh_token&#10;&#10;分隔符任选一种:  :  ;  ,  空格  tab  ----" rows="8"></textarea>
          </div>

          <!-- Tab2: 单账号 Token 导入 -->
          <div class="import-tab-content" id="importTab-token" style="display:none">
            <div class="form-row">
              <label class="form-label">邮箱</label>
              <input type="email" id="tokenEmail" class="input-field" placeholder="user@example.com" />
            </div>
            <div class="form-row">
              <label class="form-label">凭据类型</label>
              <select id="tokenKind" class="input-field">
                <option value="auth1_token">Devin auth1 (新版)</option>
                <option value="refresh_token">Firebase refresh_token (旧版)</option>
              </select>
            </div>
            <div class="form-row">
              <label class="form-label">Token</label>
              <textarea id="tokenValue" class="input-field" rows="4" placeholder="auth1_xxxxxxxxxxxx... 或 Firebase refresh_token" style="font-family:monospace;font-size:11px"></textarea>
            </div>
          </div>

          <!-- Tab3: 服务端导入 -->
          <div class="import-tab-content" id="importTab-server" style="display:none">
            <div class="form-row">
              <label class="form-label">套餐类型</label>
              <select id="serverPlanType" class="input-field">
                <option value="All">全部</option>
                <option value="Free">免费</option>
                <option value="Trial">试用</option>
                <option value="Pro">专业</option>
                <option value="Team">团队</option>
                <option value="Enterprise">旗舰</option>
              </select>
            </div>
            <div class="form-row">
              <label class="form-label">导入方式</label>
              <select id="serverCredType" class="input-field">
                <option value="auth1">邮箱+Auth1 Token</option>
                <option value="password">邮箱+密码</option>
                <option value="refresh">邮箱+Refresh Token</option>
              </select>
            </div>
            <div class="form-row">
              <label class="form-label">API 地址</label>
              <input type="text" id="serverBaseUrl" class="input-field" value="http://127.0.0.1:46953/api/v1" placeholder="http://127.0.0.1:46953/api/v1" />
            </div>
          </div>

          <div class="form-row" style="margin-top:12px">
            <label class="form-label">分组</label>
            <select id="importGroupSelect" class="input-field"></select>
          </div>

        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="importCancel">取消</button>
          <button class="btn btn-primary" id="importConfirm">导入并验证</button>
        </div>
      </div>
    </div>

    <!-- 通用确认弹窗 -->
    <div class="modal-overlay" id="confirmModal" style="display:none">
      <div class="modal modal-sm">
        <div class="modal-body">
          <div class="confirm-title" id="confirmTitle"></div>
          <div class="confirm-msg" id="confirmMsg"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="confirmCancel">取消</button>
          <button class="btn btn-primary" id="confirmOk">确定</button>
        </div>
      </div>
    </div>

    <!-- 创建分身弹窗 -->
    <div class="modal-overlay" id="createInstanceModal" style="display:none">
      <div class="modal modal-sm">
        <div class="modal-body">
          <div class="confirm-title">创建分身</div>
          <div class="confirm-msg" style="margin-bottom:12px">输入分身名称 (英文/数字/下划线/连字符)</div>
          <input type="text" id="instanceNameInput" class="input" placeholder="例如: profile-2" style="width:100%;padding:8px 10px;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--bg-input,var(--bg-card));color:var(--text-primary);font-size:13px;outline:none;" />
          <div id="instanceNameError" style="color:var(--danger);font-size:11px;margin-top:4px;display:none;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="createInstanceCancel">取消</button>
          <button class="btn btn-primary" id="createInstanceOk">创建并启动</button>
        </div>
      </div>
    </div>

    <!-- 编辑账号弹窗 -->
    <div class="modal-overlay" id="editModal" style="display:none">
      <div class="modal">
        <div class="modal-header">
          <span>编辑 <span id="editEmail" class="edit-email"></span></span>
          <button class="btn-icon modal-close" id="editClose">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label class="form-label">密码</label>
            <input type="password" id="editPassword" class="input-field" placeholder="留空=不修改" />
          </div>
          <div class="form-row">
            <label class="form-label">昵称</label>
            <input type="text" id="editNote" class="input-field" placeholder="留空=清空" />
          </div>
          <div class="form-row">
            <label class="form-label">分组</label>
            <select id="editGroup" class="input-field"></select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="editCancel">取消</button>
          <button class="btn btn-primary" id="editConfirm">保存</button>
        </div>
      </div>
    </div>

    <!-- 新建/重命名分组弹窗 -->
    <div class="modal-overlay" id="groupModal" style="display:none">
      <div class="modal modal-sm">
        <div class="modal-header">
          <span id="groupModalTitle">新建分组</span>
          <button class="btn-icon modal-close" id="groupClose">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label class="form-label">名称</label>
            <input type="text" id="groupNameInput" class="input-field" placeholder="例如: 工作组 / 备用号池" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="groupCancel">取消</button>
          <button class="btn btn-primary" id="groupConfirm">保存</button>
        </div>
      </div>
    </div>

    <!-- 标签页导航 -->
    <nav class="tab-bar">
      <button class="tab active" data-tab="accounts">账号列表</button>
      <button class="tab" data-tab="tools">工具箱</button>
      <button class="tab" data-tab="settings">设置</button>
    </nav>

    <!-- 账号列表 -->
    <section class="tab-content active" id="tab-accounts">
      <div class="search-bar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="searchInput" placeholder="搜索账号..." />
        <button class="filter-toggle-btn" id="filterToggleBtn" title="筛选">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
        </button>
      </div>
      <!-- 筛选面板 (默认隐藏) -->
      <div class="filter-panel" id="filterPanel" style="display:none">
        <div class="filter-panel-row">
          <label class="filter-label">套餐类型</label>
          <select class="filter-select" id="filterPlan">
            <option value="">全部</option>
              <option value="Free">免费</option>
              <option value="Trial">试用</option>
              <option value="Pro">专业</option>
              <option value="Team">团队</option>
              <option value="Enterprise">旗舰</option>
          </select>
        </div>
        <div class="filter-panel-row">
          <label class="filter-label">到期时间</label>
          <select class="filter-select" id="filterExpiry">
            <option value="">全部</option>
            <option value="3">3天内到期</option>
            <option value="7">7天内到期</option>
            <option value="30">30天内到期</option>
            <option value="expired">已过期</option>
            <option value="noexpiry">永不过期/未知</option>
          </select>
        </div>
        <div class="filter-panel-row">
          <label class="filter-label">创建时间</label>
          <select class="filter-select" id="filterCreated">
            <option value="">全部</option>
            <option value="1">最近1天</option>
            <option value="7">最近7天</option>
            <option value="30">最近30天</option>
          </select>
        </div>
        <div class="filter-panel-row">
          <label class="filter-label">邮箱后缀</label>
          <input type="text" class="filter-input" id="filterSuffix" placeholder="如 gmail.com" />
        </div>
        <div class="filter-panel-actions">
          <button class="filter-reset-btn" id="filterResetBtn">重置</button>
        </div>
      </div>
      <!-- 批量操作工具栏（仅在有选中账号时显示） -->
      <div class="bulk-bar" id="bulkBar" style="display:none">
        <span class="bulk-count">已选 <span id="bulkCount">0</span> 项</span>
        <button class="bulk-btn" id="bulkSelectAll" title="全选当前视图">全选</button>
        <button class="bulk-btn" id="bulkClear" title="取消全选 (清除所有选中)">取消全选</button>
        <select class="bulk-select" id="bulkGroupSelect" title="批量移入分组">
          <option value="__none__" disabled selected>移入分组...</option>
        </select>
        <button class="bulk-btn bulk-refresh" id="bulkRefresh" title="刷新选中账号配额">刷新</button>
        <button class="bulk-btn" id="bulkExport" title="导出选中账号到剪贴板">导出</button>
        <button class="bulk-btn bulk-danger" id="bulkDelete" title="批量删除">删除</button>
      </div>
      <div class="account-list" id="accountList">
        <div class="empty-state">暂无账号，点击顶部 + 导入</div>
      </div>
    </section>

    <!-- 工具箱 -->
    <section class="tab-content" id="tab-tools">
      <div class="tool-group">
        <div class="tool-group-title">补丁管理</div>
        <div class="tool-item" id="btnApplyPatch">
          <div class="tool-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></div>
          <div class="tool-info">
            <div class="tool-name">应用补丁</div>
            <div class="tool-desc">解除 Windsurf 使用限制</div>
          </div>
          <div class="tool-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
        </div>
        <div class="tool-item" id="btnRestorePatch">
          <div class="tool-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></div>
          <div class="tool-info">
            <div class="tool-name">恢复补丁</div>
            <div class="tool-desc">还原为原始版本</div>
          </div>
          <div class="tool-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
        </div>

        <!-- 切号模式切换 (Patch 模式 vs URI 兜底模式) -->
        <div class="mode-toggle">
          <div class="mode-toggle-label">切号模式</div>
          <div class="mode-toggle-seg" id="switchModeSeg">
            <button class="mode-btn" data-mode="patch" id="modeBtnPatch">Patch</button>
            <button class="mode-btn" data-mode="uri" id="modeBtnUri">URI</button>
          </div>
        </div>

        <!-- URI 补丁管理 (默认隐藏, 切到 URI 模式后显示) -->
        <div class="tool-item uri-tool" id="btnApplyUriPatch" style="display:none">
          <div class="tool-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>
          <div class="tool-info">
            <div class="tool-name">应用 URI 补丁</div>
            <div class="tool-desc">兜底方案: 通过 windsurf:// 协议回调切号</div>
          </div>
          <div class="tool-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
        </div>
        <div class="tool-item uri-tool" id="btnRestoreUriPatch" style="display:none">
          <div class="tool-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></div>
          <div class="tool-info">
            <div class="tool-name">恢复 URI 补丁</div>
            <div class="tool-desc">还原 URI handler 为原始状态</div>
          </div>
          <div class="tool-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
        </div>

        <div class="patch-status" id="patchStatus"></div>
      </div>

      <div class="tool-group">
        <div class="tool-group-title">设备管理</div>
        <div class="tool-item" id="btnResetMachineId">
          <div class="tool-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>
          <div class="tool-info">
            <div class="tool-name">重置机器码</div>
            <div class="tool-desc">重置设备标识，重启后生效</div>
          </div>
          <div class="tool-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
        </div>
      </div>

      <div class="tool-group">
        <div class="tool-group-title">分身管理</div>
        <div class="tool-item" id="btnRefreshInstances">
          <div class="tool-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
          <div class="tool-info">
            <div class="tool-name">查看分身状态</div>
            <div class="tool-desc">查看所有 Windsurf 实例及账号占用</div>
          </div>
          <div class="tool-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
        </div>
        <div class="instance-list" id="instanceList" style="display:none;"></div>
        <div class="tool-item" id="btnCreateInstance">
          <div class="tool-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
          <div class="tool-info">
            <div class="tool-name">创建分身</div>
            <div class="tool-desc">启动独立数据目录的 Windsurf 新实例</div>
          </div>
          <div class="tool-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
        </div>
      </div>

      <div class="tool-group">
        <div class="tool-group-title">危险操作</div>
        <div class="tool-item danger" id="btnClearAll">
          <div class="tool-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></div>
          <div class="tool-info">
            <div class="tool-name">清空所有账号</div>
            <div class="tool-desc">不可恢复，谨慎操作</div>
          </div>
          <div class="tool-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
        </div>
      </div>
    </section>

    <!-- 设置 -->
    <section class="tab-content" id="tab-settings">
      <div class="setting-group">
        <div class="setting-group-title">自动切换</div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-name">配额耗尽自动切换</div>
            <div class="setting-desc">日配额低于阈值时自动切换到下一个账号</div>
          </div>
          <label class="toggle"><input type="checkbox" id="settAutoSwitch"><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-name">静默切换</div>
            <div class="setting-desc">自动切换时不弹出确认对话框</div>
          </div>
          <label class="toggle"><input type="checkbox" id="settSilent"><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-name">切换阈值</div>
            <div class="setting-desc">日配额低于此百分比时触发切换</div>
          </div>
          <div class="setting-control">
            <input type="range" id="settThreshold" min="0" max="100" value="5" />
            <span id="thresholdValue">5%</span>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-name">切号后重置机器码</div>
            <div class="setting-desc">自动切号成功后静默重置机器码/指纹 (5分钟冷却)</div>
          </div>
          <label class="toggle"><input type="checkbox" id="settAutoResetMachineId"><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-name">切换订阅类型</div>
            <div class="setting-desc">仅在选定订阅类型的账号间自动切换 (全部 = 不限制)</div>
          </div>
          <div class="setting-control">
            <select class="setting-select" id="settAutoSwitchPlanType">
              <option value="All">全部</option>
              <option value="Free">免费</option>
              <option value="Trial">试用</option>
              <option value="Pro">专业</option>
              <option value="Team">团队</option>
              <option value="Enterprise">旗舰</option>
            </select>
          </div>
        </div>
      </div>
      <div class="setting-group">
        <div class="setting-group-title">余额监控</div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-name">自动刷新余额</div>
            <div class="setting-desc">定时查询当前账号的配额剩余</div>
          </div>
          <label class="toggle"><input type="checkbox" id="settAutoRefresh"><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-name">刷新间隔 (秒)</div>
          </div>
          <div class="setting-control">
            <input type="number" id="settInterval" min="10" max="600" value="30" class="input-number" />
          </div>
        </div>
      </div>
      <div class="setting-group">
        <div class="setting-group-title">批量并发</div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-name">并发上限</div>
            <div class="setting-desc">批量刷新/登录时同时进行的任务数 (推荐 5; 过高可能触发 Firebase 限流)</div>
          </div>
          <div class="setting-control">
            <input type="number" id="settConcurrentLimit" min="1" max="20" value="5" class="input-number" />
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-name">无限并发 (激进)</div>
            <div class="setting-desc">忽略并发上限一次性全并发。100+ 账号同时请求有被限流风险</div>
          </div>
          <label class="toggle"><input type="checkbox" id="settUnlimitedConcurrent"><span class="slider"></span></label>
        </div>
      </div>
      <div class="setting-group">
        <div class="setting-group-title">显示</div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-name">底部状态栏</div>
            <div class="setting-desc">在编辑器底部显示当前账号和配额</div>
          </div>
          <label class="toggle"><input type="checkbox" id="settStatusBar" checked><span class="slider"></span></label>
        </div>
      </div>
      <div class="about">
        <div class="about-text">WF-Swap</div>
        <div class="about-text">安全直连版 - 所有请求直连官方服务器</div>
        <div class="about-text">版本: <span id="appVersion">-</span></div>
        <div class="about-text">开发者: Ti</div>
        <div class="about-text">VX: M78ATMSL</div>
      </div>
    </section>

    <!-- 加载遮罩 -->
    <div class="loading-overlay" id="loadingOverlay" style="display:none">
      <div class="spinner"></div>
      <div class="loading-text" id="loadingText">处理中...</div>
    </div>
  </div>

  <script nonce="${nonce}">${getScript()}</script>
</body>
</html>`;
}

/** 生成随机 nonce */
function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}