/** macOS 风格 CSS - 从 webviewContent.ts 提取 */

export function getStyles(): string {
  return `
    :root {
      --bg-primary: var(--vscode-editor-background);
      --bg-secondary: var(--vscode-sideBar-background);
      --bg-card: var(--vscode-editorWidget-background, #1e1e1e);
      --bg-hover: var(--vscode-list-hoverBackground);
      --bg-active: var(--vscode-list-activeSelectionBackground);
      --text-primary: var(--vscode-foreground);
      --text-secondary: var(--vscode-descriptionForeground);
      --text-muted: var(--vscode-disabledForeground);
      --border: var(--vscode-widget-border, rgba(255,255,255,0.06));
      --accent: var(--vscode-focusBorder, #007AFF);
      --danger: #FF3B30;
      --success: #34C759;
      --warning: #FF9500;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      color: var(--text-primary);
      background: var(--bg-primary);
      line-height: 1.5;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }

    #app { padding: 0 0 20px 0; }

    /* 顶栏 */
    .toolbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; position: sticky; top: 0; z-index: 10;
      background: var(--bg-primary);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    .toolbar-title {
      font-size: 13px; font-weight: 600;
      letter-spacing: -0.01em;
    }
    .toolbar-actions { display: flex; gap: 4px; }

    /* 按钮 */
    .btn-icon {
      width: 28px; height: 28px; border: none; border-radius: var(--radius-sm);
      background: transparent; color: var(--text-secondary);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: all 0.15s ease;
    }
    .btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
    .btn-icon:active { transform: scale(0.92); }
    .btn-icon.spinning svg { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .btn {
      padding: 6px 14px; border: none; border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn:active { transform: scale(0.96); }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { filter: brightness(1.1); }
    .btn-secondary { background: var(--bg-hover); color: var(--text-primary); }
    .btn-secondary:hover { filter: brightness(1.1); }
    .btn-sm { padding: 4px 10px; font-size: 11px; }
    .btn-danger { background: var(--danger); color: #fff; }

    /* 卡片 */
    .card {
      margin: 10px 12px; padding: 14px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
    }
    .card-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 8px;
    }
    .card-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    .badge {
      font-size: 10px; padding: 2px 8px; border-radius: 10px;
      background: rgba(0,122,255,0.15); color: var(--accent);
      font-weight: 600;
    }
    /* 套餐 badge 颜色按等级区分 */
    .badge.plan-trial { background: rgba(255,149,0,0.18); color: #FF9500; }
    .badge.plan-pro { background: rgba(52,199,89,0.18); color: #34C759; }
    .badge.plan-free { background: rgba(142,142,147,0.18); color: #8E8E93; }
    .badge.plan-enterprise { background: rgba(175,82,222,0.18); color: #AF52DE; }
    .active-name { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
    .active-name:empty { display: none; }
    .active-email { font-size: 12px; color: var(--text-secondary); font-weight: 400; margin-bottom: 12px; }
    .active-name:not(:empty) + .active-email { margin-top: 0; }

    /* 配额进度条 */
    .quota-bars { display: flex; flex-direction: column; gap: 8px; }
    .quota-row { display: flex; align-items: center; gap: 8px; }
    .quota-label { font-size: 11px; color: var(--text-secondary); width: 16px; flex-shrink: 0; }
    .quota-value { font-size: 11px; font-weight: 600; min-width: 36px; text-align: right; color: var(--text-primary); }
    .quota-reset { font-size: 10px; color: var(--text-muted); min-width: 68px; text-align: right; }
    .quota-reset:empty { display: none; }
    .progress-track {
      flex: 1; height: 6px; border-radius: 3px;
      background: rgba(255,255,255,0.06); overflow: hidden;
    }
    .progress-fill {
      height: 100%; border-radius: 3px;
      background: var(--success);
      transition: width 0.5s ease, background 0.3s ease;
    }
    .progress-fill.warning { background: var(--warning); }
    .progress-fill.danger { background: var(--danger); }
    .progress-fill.critical { background: #8B0000; }
    .quota-value { font-size: 11px; color: var(--text-secondary); width: 32px; text-align: right; font-variant-numeric: tabular-nums; }

    /* 标签页 */
    .tab-bar {
      display: flex; padding: 0 12px; gap: 2px;
      border-bottom: 1px solid var(--border);
    }
    .tab {
      padding: 8px 14px; font-size: 12px; font-weight: 500;
      border: none; background: transparent; color: var(--text-secondary);
      cursor: pointer; border-bottom: 2px solid transparent;
      transition: all 0.15s ease;
    }
    .tab:hover { color: var(--text-primary); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    .tab-content { display: none; padding: 10px 12px; }
    .tab-content.active { display: block; }

    /* 搜索框 */
    .search-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 10px; margin-bottom: 8px;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-md);
    }
    .search-bar svg { color: var(--text-muted); flex-shrink: 0; }
    .search-bar input {
      flex: 1; border: none; background: transparent; outline: none;
      color: var(--text-primary); font-size: 12px;
      font-family: inherit;
    }
    .search-bar input::placeholder { color: var(--text-muted); }

    /* 筛选按钮 */
    .filter-toggle-btn {
      display: flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; border: none; border-radius: var(--radius-sm);
      background: transparent; color: var(--text-muted); cursor: pointer;
      flex-shrink: 0; transition: color 0.15s, background 0.15s;
    }
    .filter-toggle-btn:hover { color: var(--accent); background: rgba(0,122,255,0.08); }
    .filter-toggle-btn.active { color: var(--accent); }

    /* 筛选面板 */
    .filter-panel {
      margin-bottom: 8px; padding: 10px 12px;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-md);
      animation: filterSlide 0.15s ease;
    }
    @keyframes filterSlide { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    .filter-panel-row {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 8px;
    }
    .filter-panel-row:last-child { margin-bottom: 0; }
    .filter-label {
      font-size: 11px; color: var(--text-secondary);
      min-width: 52px; flex-shrink: 0;
    }
    .filter-select {
      flex: 1; padding: 4px 22px 4px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--bg-card); color: var(--text-primary);
      font-size: 11px; cursor: pointer; outline: none;
      appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><polyline points='1,1 5,5 9,1' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
      background-repeat: no-repeat; background-position: right 6px center;
    }
    .filter-select:hover, .filter-select:focus { border-color: var(--accent); }
    .filter-input {
      flex: 1; padding: 4px 8px;
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--bg-card); color: var(--text-primary);
      font-size: 11px; outline: none; font-family: inherit;
    }
    .filter-input::placeholder { color: var(--text-muted); }
    .filter-input:focus { border-color: var(--accent); }
    .filter-panel-actions {
      display: flex; justify-content: flex-end; margin-top: 8px; padding-top: 6px;
      border-top: 1px solid var(--border);
    }
    .filter-reset-btn {
      padding: 3px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: transparent; color: var(--text-secondary);
      font-size: 11px; cursor: pointer; transition: all 0.15s;
    }
    .filter-reset-btn:hover { border-color: var(--accent); color: var(--accent); }
    .setting-select {
      padding: 4px 26px 4px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--bg-card); color: var(--text-primary);
      font-size: 12px; cursor: pointer; outline: none;
      appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><polyline points='1,1 5,5 9,1' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
      background-repeat: no-repeat; background-position: right 6px center;
    }
    .setting-select:hover, .setting-select:focus { border-color: var(--accent); }

    /* 账号列表 */
    .account-list { display: flex; flex-direction: column; gap: 2px; }

    /* 分页条 */
    .pagination-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px 12px;
      flex-wrap: wrap;
      font-size: 11px;
      color: var(--text-muted);
    }
    .pagi-info {
      flex: 1 1 auto;
      white-space: nowrap;
      opacity: 0.85;
    }
    .pagi-controls {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .page-btn {
      min-width: 22px;
      height: 22px;
      padding: 0 5px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .page-btn:hover:not(:disabled) {
      background: var(--bg-hover);
      color: var(--text-primary);
      border-color: var(--accent);
    }
    .page-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
    .page-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
      font-weight: 600;
    }
    .page-ellipsis {
      padding: 0 3px;
      color: var(--text-muted);
      user-select: none;
    }
    .page-size-select {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 2px 4px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      outline: none;
    }
    .page-size-select:hover { border-color: var(--accent); }
    .page-size-select:focus { border-color: var(--accent); }
    /* 账号卡片（卡片化布局） */
    .account-item {
      display: block;
      padding: 10px 12px; margin: 0 12px 8px;
      border-radius: var(--radius-md);
      background: var(--bg-card);
      cursor: default; transition: all 0.15s ease;
      border: 1px solid var(--border);
    }
    .account-item:hover { border-color: rgba(0,122,255,0.35); }
    .account-item.active { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(0,122,255,0.2); }

    /* 第一行：头像 + 邮箱 + badge + 到期 + 操作图标 */
    .account-row-head {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 6px;
    }
    .account-avatar {
      width: 28px; height: 28px; border-radius: 50%;
      background: linear-gradient(135deg, var(--accent), #5856D6);
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 600; color: #fff; flex-shrink: 0;
    }
    .account-email {
      font-size: 13px; font-weight: 500; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: flex; align-items: center; gap: 6px; flex: 1;
    }
    .account-email .email-text {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      min-width: 0;
    }
    .account-email .badge { font-size: 9px; padding: 1px 6px; flex-shrink: 0; }
    .account-expire {
      font-size: 11px; color: var(--text-muted); flex-shrink: 0;
      white-space: nowrap;
    }
    .account-actions {
      display: flex; gap: 2px; flex-shrink: 0;
    }
    .account-actions .btn-icon { width: 24px; height: 24px; }
    .account-actions .btn-icon svg { width: 12px; height: 12px; }
    .account-actions .btn-icon.danger:hover { color: var(--danger); }

    /* 第二部分：配额条 */
    .account-quotas { display: flex; flex-direction: column; gap: 4px; padding-left: 36px; }
    .account-quota-row { display: flex; align-items: center; gap: 8px; }
    .account-quota-row .quota-label { width: 14px; font-size: 10px; }
    .account-quota-row .progress-track { height: 5px; }
    .account-quota-row .quota-value { font-size: 11px; font-weight: 600; min-width: 32px; text-align: right; }
    .account-quota-row .quota-reset { font-size: 10px; color: var(--text-muted); min-width: 68px; text-align: right; }
    .account-quotas-empty { padding-left: 36px; font-size: 11px; color: var(--text-muted); }

    /* 第三部分：到期行 (在配额条下方) */
    .account-expire-line {
      display: flex; align-items: center; gap: 8px;
      padding-left: 36px; margin-top: 6px;
      font-size: 11px; color: var(--text-muted);
    }
    .account-expire-line .expire-label { color: var(--text-muted); }
    .account-expire-line .expire-remain {
      margin-left: auto;
      padding: 1px 8px; border-radius: 10px;
      font-weight: 600;
    }
    .account-expire-line .expire-remain.ok { background: rgba(52,199,89,0.15); color: #34C759; }
    .account-expire-line .expire-remain.warn { background: rgba(255,149,0,0.18); color: #FF9500; }
    .account-expire-line .expire-remain.danger { background: rgba(255,59,48,0.18); color: #FF3B30; }

    .empty-state {
      padding: 40px 20px; text-align: center;
      color: var(--text-muted); font-size: 12px;
    }
    /* 分组内空态: 提示新建的空分组, 尺寸比全局 empty-state 小一圈 */
    .group-empty {
      padding: 14px 12px; text-align: center;
      color: var(--text-muted); font-size: 11px;
      background: var(--bg-card); border: 1px dashed var(--border);
      border-radius: var(--radius-sm);
      margin: 6px 4px 4px;
    }

    /* 工具箱 */
    .tool-group { margin-bottom: 16px; }
    .tool-group-title {
      font-size: 11px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.05em;
      padding: 4px 4px 6px; margin-bottom: 2px;
    }
    .tool-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border-radius: var(--radius-md);
      cursor: pointer; transition: background 0.15s ease;
    }
    .tool-item:hover { background: var(--bg-hover); }
    .tool-item:active { transform: scale(0.99); }
    .tool-item.danger .tool-name { color: var(--danger); }
    .tool-item.danger .tool-icon { color: var(--danger); }
    .tool-icon { color: var(--text-secondary); flex-shrink: 0; }
    .tool-info { flex: 1; }
    .tool-name { font-size: 13px; font-weight: 500; }
    .tool-desc { font-size: 11px; color: var(--text-secondary); }
    .tool-arrow { color: var(--text-muted); }

    .patch-status {
      padding: 8px 12px; font-size: 11px; color: var(--text-secondary);
      line-height: 1.6;
    }

    /* 切号模式 segmented control (紧凑, 风格对齐 .tool-item) */
    .mode-toggle {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; margin-top: 2px;
      background: var(--bg-card); border-radius: 6px;
    }
    .mode-toggle-label {
      font-size: 12px; color: var(--text-secondary); font-weight: 500;
    }
    .mode-toggle-seg {
      display: inline-flex; background: var(--bg-hover, rgba(127,127,127,0.12));
      border-radius: 6px; padding: 2px; gap: 2px;
    }
    .mode-btn {
      min-width: 52px; padding: 3px 10px;
      border: 0; background: transparent; cursor: pointer;
      font-size: 11px; font-weight: 500; color: var(--text-secondary);
      border-radius: 4px; transition: background 0.15s, color 0.15s;
    }
    .mode-btn:hover { color: var(--text-primary); }
    .mode-btn.active {
      background: var(--accent, #0e639c); color: #fff;
    }

    /* 分身管理 */
    .instance-list {
      padding: 4px 8px;
    }
    .instance-card {
      padding: 8px 10px; margin-bottom: 6px;
      border-radius: var(--radius-md);
      background: var(--bg-card); border: 1px solid var(--border);
      font-size: 12px;
    }
    .instance-card.is-me {
      border-color: var(--accent);
    }
    .instance-card .inst-label {
      font-weight: 600; font-size: 13px; margin-bottom: 2px;
    }
    .instance-card .inst-lock {
      color: var(--text-secondary); font-size: 11px;
    }
    .instance-card .inst-lock .locked {
      color: var(--warning, #e8a838);
    }
    .instance-card .inst-time {
      color: var(--text-muted); font-size: 10px; margin-top: 2px;
    }
    .inst-status-dot {
      display: inline-block; width: 6px; height: 6px; border-radius: 50%;
      margin-right: 4px; vertical-align: middle;
    }
    .inst-status-dot.running { background: #4caf50; box-shadow: 0 0 4px #4caf50; }
    .inst-status-dot.stopped { background: #888; }
    .instance-card .inst-header {
      display: flex; align-items: center; justify-content: space-between;
    }
    .instance-card .inst-actions {
      display: flex; gap: 4px; flex-shrink: 0;
    }
    .btn-inst {
      padding: 2px 8px; font-size: 11px; border-radius: 4px;
      border: 1px solid var(--border); background: var(--bg-card);
      color: var(--text-secondary); cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-inst:hover { background: var(--bg-hover); }
    .btn-inst-delete { color: var(--danger); border-color: var(--danger); }
    .btn-inst-delete:hover { background: var(--danger); color: #fff; }

    /* 设置 */
    .setting-group { margin-bottom: 20px; }
    .setting-group-title {
      font-size: 11px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.05em;
      padding: 4px 0 8px;
    }
    .setting-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 0; border-bottom: 1px solid var(--border);
    }
    .setting-row:last-child { border-bottom: none; }
    .setting-info { flex: 1; }
    .setting-name { font-size: 13px; font-weight: 500; }
    .setting-desc { font-size: 11px; color: var(--text-secondary); }
    .setting-control { display: flex; align-items: center; gap: 6px; }

    /* macOS 风格 Toggle */
    .toggle {
      position: relative; display: inline-block;
      width: 38px; height: 22px; flex-shrink: 0;
    }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; cursor: pointer; inset: 0;
      background: rgba(255,255,255,0.12); border-radius: 11px;
      transition: 0.25s ease;
    }
    .slider::before {
      content: ''; position: absolute;
      height: 18px; width: 18px; left: 2px; bottom: 2px;
      background: #fff; border-radius: 50%;
      transition: 0.25s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    }
    .toggle input:checked + .slider { background: var(--accent); }
    .toggle input:checked + .slider::before { transform: translateX(16px); }

    /* 输入框 */
    .input-field {
      flex: 1; padding: 6px 10px;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); color: var(--text-primary);
      font-size: 12px; outline: none; font-family: inherit;
    }
    .input-field:focus { border-color: var(--accent); }
    .input-number {
      width: 64px; padding: 4px 8px;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); color: var(--text-primary);
      font-size: 12px; text-align: center; outline: none;
    }
    .input-number:focus { border-color: var(--accent); }

    input[type="range"] {
      -webkit-appearance: none; width: 100px; height: 4px;
      background: rgba(255,255,255,0.12); border-radius: 2px; outline: none;
    }
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none; width: 16px; height: 16px;
      background: var(--accent); border-radius: 50%; cursor: pointer;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }

    /* 弹窗 */
    .modal-overlay {
      position: fixed; inset: 0; z-index: 100;
      background: rgba(0,0,0,0.4);
      display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px);
    }
    /* 确认弹窗永远在最上层, 避免同时打开两个 modal 时被后声明的盖住 */
    .modal-overlay#confirmModal {
      z-index: 150;
    }
    .modal {
      width: 90%; max-width: 380px;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      overflow: hidden;
    }
    .modal-sm { max-width: 320px; }

    /* 确认弹窗 */
    .confirm-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
    .confirm-msg { font-size: 13px; color: var(--text-secondary); line-height: 1.6; word-break: break-all; }
    .confirm-msg strong { color: var(--text-primary); font-weight: 600; }
    .btn-danger-solid { background: var(--danger); color: #fff; }
    .btn-danger-solid:hover { filter: brightness(1.1); }

    /* 编辑弹窗表单 */
    .form-row {
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 12px;
    }
    .form-row:last-child { margin-bottom: 0; }
    .form-label {
      font-size: 12px; color: var(--text-secondary);
      width: 44px; flex-shrink: 0;
    }
    .edit-email { color: var(--accent); font-weight: 500; }
    /* 下拉框样式 */
    select.input-field {
      cursor: pointer;
      appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><polyline points='1,1 5,5 9,1' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
      background-repeat: no-repeat;
      background-position: right 10px center;
      padding-right: 26px;
    }

    /* 单卡片刷新中 - 图标旋转 */
    @keyframes wf-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .btn-acc-refresh.is-refreshing {
      pointer-events: none;
      color: var(--accent);
    }
    .btn-acc-refresh.is-refreshing svg {
      animation: wf-spin 0.9s linear infinite;
    }

    /* 导入弹窗 Tab */
    .import-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .import-tab {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
    }
    .import-tab:hover { color: var(--text-primary); }
    .import-tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
      font-weight: 600;
    }
    .import-tab-content textarea {
      width: 100%;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: 12px;
      resize: vertical;
      outline: none;
    }
    .import-tab-content textarea:focus { border-color: var(--accent); }

    /* 分组区节标题 (账号列表按分组分节, 不再有顶部 chip) */
    .group-section-header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px 4px;
      font-size: 11px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
      cursor: pointer;
      user-select: none;
    }
    .group-section-header:hover { color: var(--text-primary); }
    .group-section-header .chev {
      transition: transform 0.15s ease;
      display: inline-flex;
    }
    .group-section-header.collapsed .chev { transform: rotate(-90deg); }
    /* 右侧尾部: count + 操作按钮; 始终靠右 */
    .group-section-header .section-tail {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .group-section-header .count {
      color: var(--text-muted);
      font-weight: 500;
    }
    /* 分组操作按钮: 默认隐藏, hover 整个 header 时显示 */
    .group-section-actions {
      display: none;
      align-items: center;
      gap: 2px;
    }
    .group-section-header:hover .group-section-actions { display: inline-flex; }
    .group-section-actions .btn-icon {
      width: 18px; height: 18px; padding: 2px;
      background: transparent; border: none;
      color: var(--text-secondary); cursor: pointer;
      border-radius: 4px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .group-section-actions .btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
    .group-section-actions .btn-icon.danger:hover { color: var(--danger); }
    .group-section.collapsed .account-item,
    .group-section.collapsed .pagination-bar { display: none; }

    /* 批量操作工具栏 */
    .bulk-bar {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 12px 8px;
      flex-wrap: wrap;
    }
    .bulk-count {
      font-size: 12px; color: var(--accent); font-weight: 600;
      margin-right: 4px;
    }
    .bulk-btn {
      padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--bg-card); color: var(--text-primary);
      font-size: 11px; cursor: pointer;
      transition: all 0.15s ease;
    }
    .bulk-btn:hover { border-color: rgba(0,122,255,0.4); }
    .bulk-btn:active { transform: scale(0.97); }
    .bulk-danger {
      background: rgba(255,59,48,0.12); border-color: rgba(255,59,48,0.35); color: #FF3B30;
    }
    .bulk-danger:hover { background: rgba(255,59,48,0.22); }
    /* 批量刷新按钮: 主题蓝系, 与单卡片刷新图标呼应 */
    .bulk-refresh {
      background: rgba(0,122,255,0.12); border-color: rgba(0,122,255,0.4); color: var(--accent);
      font-weight: 600;
    }
    .bulk-refresh:hover:not(:disabled) { background: rgba(0,122,255,0.22); }
    .bulk-select {
      padding: 4px 22px 4px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--bg-card); color: var(--text-primary);
      font-size: 11px; cursor: pointer; outline: none;
      appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><polyline points='1,1 5,5 9,1' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
      background-repeat: no-repeat;
      background-position: right 6px center;
    }

    /* 账号卡片左上选择框 */
    .account-checkbox {
      width: 16px; height: 16px; flex-shrink: 0;
      appearance: none; -webkit-appearance: none;
      border: 1.5px solid var(--border); border-radius: 4px;
      background: transparent; cursor: pointer;
      position: relative; transition: all 0.15s ease;
    }
    .account-checkbox:hover { border-color: var(--accent); }
    .account-checkbox:checked {
      background: var(--accent); border-color: var(--accent);
    }
    .account-checkbox:checked::after {
      content: '';
      position: absolute;
      left: 3px; top: 0;
      width: 5px; height: 9px;
      border: solid #fff; border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    .account-item.selected { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(0,122,255,0.2); }

    /* 分组 header 上的"全选本组" checkbox (复用 account-checkbox 样式基础) */
    .group-checkbox {
      width: 14px; height: 14px; flex-shrink: 0;
      appearance: none; -webkit-appearance: none;
      border: 1.5px solid var(--border); border-radius: 3px;
      background: transparent; cursor: pointer;
      position: relative; transition: all 0.15s ease;
      margin-right: 2px;
    }
    .group-checkbox:hover { border-color: var(--accent); }
    /* 全选态: 实心填充 + 白色对勾 */
    .group-checkbox:checked {
      background: var(--accent); border-color: var(--accent);
    }
    .group-checkbox:checked::after {
      content: '';
      position: absolute;
      left: 2.5px; top: -1px;
      width: 4px; height: 8px;
      border: solid #fff; border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    /* 半选态 (indeterminate): 中间一个横条, 表示本组部分被选 */
    .group-checkbox:indeterminate {
      background: var(--accent); border-color: var(--accent);
    }
    .group-checkbox:indeterminate::after {
      content: '';
      position: absolute;
      left: 2px; top: 5px;
      width: 7px; height: 2px;
      background: #fff; border-radius: 1px;
    }
    .modal-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px; border-bottom: 1px solid var(--border);
      font-weight: 600; font-size: 14px;
    }
    .modal-body { padding: 16px; }
    .modal-body textarea {
      width: 100%; padding: 10px;
      background: var(--bg-primary); border: 1px solid var(--border);
      border-radius: var(--radius-sm); color: var(--text-primary);
      font-family: "SF Mono", Menlo, monospace; font-size: 12px;
      outline: none; resize: vertical;
    }
    .modal-body textarea:focus { border-color: var(--accent); }
    .modal-footer {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 16px; border-top: 1px solid var(--border);
    }

    /* About */
    .about { padding: 20px 0; text-align: center; }
    .about-text { font-size: 11px; color: var(--text-muted); line-height: 1.8; }

    /* 加载遮罩 */
    .loading-overlay {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,0.5);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px;
      backdrop-filter: blur(4px);
    }
    .spinner {
      width: 24px; height: 24px;
      border: 2.5px solid rgba(255,255,255,0.15);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    .loading-text { font-size: 12px; color: var(--text-secondary); }

    /* 滚动条: 默认完全隐形 (透明), 鼠标悬停到面板时才淡出显现, 离开后隐去 */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: transparent; border-radius: 3px;
      transition: background 0.25s ease;
    }
    body:hover ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
    ::-webkit-scrollbar-corner { background: transparent; }
    /* Firefox: thin + 透明 thumb, hover body 时才变灰 */
    html { scrollbar-width: thin; scrollbar-color: transparent transparent; }
    html:hover { scrollbar-color: rgba(255,255,255,0.12) transparent; }

  `;
}