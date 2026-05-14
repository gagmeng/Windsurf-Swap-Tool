/** 客户端 JavaScript - 从 webviewContent.ts 提取 */

export function getScript(): string {
  return `
    (function() {
      /* --- 全局错误上报 (捕获同步/异步异常, 辅助排查白屏) --- */
      let __vscodeApi = null;
      try { __vscodeApi = acquireVsCodeApi(); } catch (e) { /* 极罕见: API 获取失败, 下面 try-catch 会处理 */ }
      function __reportError(label, err) {
        try {
          const msg = (err && err.message) ? err.message : String(err);
          const stack = (err && err.stack) ? err.stack : '';
          if (__vscodeApi) {
            __vscodeApi.postMessage({ type: 'webviewError', payload: { error: label + ': ' + msg, stack: stack } });
          }
          /* 页面上显示错误, 避免纯白屏 */
          const overlay = document.getElementById('bootOverlay');
          const errBox = document.getElementById('bootError');
          if (overlay && errBox) {
            overlay.style.display = 'flex';
            errBox.style.display = 'block';
            errBox.textContent = '加载异常 (' + label + '):\\n' + msg + (stack ? '\\n' + stack : '');
          }
        } catch (_) { /* ignore */ }
      }
      window.addEventListener('error', (ev) => __reportError('window.error', ev.error || ev.message));
      window.addEventListener('unhandledrejection', (ev) => __reportError('unhandledrejection', ev.reason));

      try {
      const vscode = __vscodeApi;
      if (!vscode) { throw new Error('acquireVsCodeApi 返回空, webview 环境异常'); }
      let state = {
        accounts: [], groups: [], activeAccountId: null, settings: {}, appVersion: '',
        /* 补丁管理相关运行态 (由 patchStatusUpdate 填充) */
        switchMode: 'patch',    /* 'patch' | 'uri', 后端权威值 */
        processCount: 0,        /* Windsurf 进程数, 0 表示未探测 / 无 */
        uriPatchApplied: false, /* URI 补丁是否已应用 */
        patchDiagnostics: null
      };
      /* 端上视图状态 (不持久化，只在当前会话有效)
       * collapsedGroups: 折叠的分组 map { gid: boolean }
       * selectedIds: 选中的账号 ID map (用于批量操作)
       * pageSize / currentPage: 每个分组独立分页 { gid: number }
       *   gid 为 'none' 代表默认分组, 其他为真实分组 ID
       *   pageSize=0 代表 "全部/不分页" */
      let viewState = {
        collapsedGroups: {},
        selectedIds: {},
        pageSize: {},      /* { gid: pageSize }  未设置则取默认 DEFAULT_PAGE_SIZE */
        currentPage: {}    /* { gid: currentPage } 未设置则默认 1 */
      };

      /** 分页默认每页条数 */
      const DEFAULT_PAGE_SIZE = 10;

      /** 正在刷新中的 accountId 集合 (rerender 后仍要保持转圈状态) */
      const refreshingAccountIds = new Set();

      /**
       * 根据 refreshingAccountIds 集合, 重新给对应卡片的刷新图标加/去 is-refreshing 类
       * 每次渲染账号列表后或收到 singleRefresh* 消息时调用
       */
      function applyRefreshingClass() {
        document.querySelectorAll('.btn-acc-refresh').forEach(el => {
          const id = el.dataset.id;
          if (id && refreshingAccountIds.has(id)) {
            el.classList.add('is-refreshing');
          } else {
            el.classList.remove('is-refreshing');
          }
        });
      }

      /** 读取某分组当前分页设置 */
      function getGroupPaging(gid) {
        return {
          pageSize: viewState.pageSize[gid] != null ? viewState.pageSize[gid] : DEFAULT_PAGE_SIZE,
          currentPage: viewState.currentPage[gid] || 1
        };
      }

      /* ---------- 消息通信 ---------- */
      window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
          case 'stateUpdate': {
            state = msg.payload;
            /* 首次 state 到达, 先隐藏启动占位 (避免 renderAll 异常导致永久白屏) */
            const __bo = document.getElementById('bootOverlay');
            if (__bo) { __bo.style.display = 'none'; }
            try { renderAll(); } catch (e) { console.error('[WF-Swap] renderAll error:', e); }
            break;
          }
          case 'switchStart':
            showLoading('正在切换账号...');
            break;
          case 'switchDone':
          case 'switchError':
            hideLoading();
            break;
          case 'refreshStart':
            showLoading('正在刷新余额...');
            break;
          case 'refreshProgress':
            setLoadingText('刷新中 ' + msg.payload.current + '/' + msg.payload.total + ' ' + msg.payload.email);
            break;
          case 'refreshDone':
            hideLoading();
            break;
          case 'singleRefreshStart': {
            /* 单账号刷新开始: 给该账号的刷新图标加转圈 (fullState 重绘也保持) */
            const id = msg.payload && msg.payload.accountId;
            if (id) {
              refreshingAccountIds.add(id);
              applyRefreshingClass();
            }
            break;
          }
          case 'singleRefreshDone': {
            /* 单账号刷新结束: 移除转圈 */
            const id = msg.payload && msg.payload.accountId;
            if (id) {
              refreshingAccountIds.delete(id);
              applyRefreshingClass();
            }
            break;
          }
          case 'patchStart':
            showLoading('正在应用补丁...');
            break;
          case 'patchDone':
          case 'patchError':
            hideLoading();
            break;
          case 'machineIdStart':
            showLoading('正在重置机器码...');
            break;
          case 'machineIdDone':
          case 'machineIdError':
            hideLoading();
            break;
          case 'importResult':
            /* verifyOnImport=true 时 payload 带 verifyFailures, 登录已经在 importAccounts 里完成 → 直接关 loading
             * verifyOnImport=false 时会紧跟 refreshStart 进入异步刷新 → 切换文案等后续 */
            if (msg.payload && Array.isArray(msg.payload.verifyFailures)) {
              hideLoading();
            } else if (msg.payload && msg.payload.count > 0) {
              setLoadingText('导入完成，正在登录验证 0/' + msg.payload.count);
            } else {
              hideLoading();
            }
            break;
          case 'hideLoading':
            hideLoading();
            break;
          case 'setLoadingText':
            if (msg.payload && msg.payload.text) { setLoadingText(msg.payload.text); }
            break;
          case 'patchStatusUpdate':
            /* 延迟加载的补丁状态更新 (含 switchMode / processCount / uriPatchApplied) */
            if (msg.payload) {
              state.patchStatus = msg.payload.patchStatus;
              state.schemeList = msg.payload.schemeList;
              if (msg.payload.windsurfPath) { state.windsurfPath = msg.payload.windsurfPath; }
              if (msg.payload.switchMode) { state.switchMode = msg.payload.switchMode; }
              if (typeof msg.payload.processCount === 'number') {
                state.processCount = msg.payload.processCount;
              }
              if (typeof msg.payload.uriPatchApplied === 'boolean') {
                state.uriPatchApplied = msg.payload.uriPatchApplied;
              }
              state.patchDiagnostics = msg.payload.patchDiagnostics || null;
              renderPatchStatus();
            }
            break;
          case 'instancesUpdate':
            renderInstances(msg.payload || []);
            break;
        }
      });

      function send(type, payload) {
        vscode.postMessage({ type, payload });
      }

      /* ---------- 渲染 ---------- */
      function renderAll() {
        /* 账号可能被删除 → 同步清理 selectedIds */
        cleanupSelectedIds();
        renderActiveCard();
        renderAccountList();
        renderBulkBar();
        renderPatchStatus();
        renderSettings();
      }

      /** 清除不存在账号的选中项 */
      function cleanupSelectedIds() {
        const validIds = new Set((state.accounts || []).map(a => a.id));
        for (const id of Object.keys(viewState.selectedIds)) {
          if (!validIds.has(id)) { delete viewState.selectedIds[id]; }
        }
      }

      /** 获取当前选中 ID 数组 */
      function getSelectedIds() {
        return Object.keys(viewState.selectedIds).filter(id => viewState.selectedIds[id]);
      }

      /**
       * 渲染批量工具栏 (只在有选中账号时显示)
       */
      function renderBulkBar() {
        const bar = document.getElementById('bulkBar');
        if (!bar) { return; }
        const selected = getSelectedIds();
        if (selected.length === 0) {
          bar.style.display = 'none';
          return;
        }
        bar.style.display = 'flex';
        document.getElementById('bulkCount').textContent = selected.length;

        /* 更新分组下拉选项 */
        const sel = document.getElementById('bulkGroupSelect');
        const currentVal = sel.value;
        const opts = ['<option value="__none__" disabled selected>移入分组...</option>',
          '<option value="">(移出分组)</option>'];
        for (const g of (state.groups || [])) {
          opts.push('<option value="' + g.id + '">' + escapeHtml(g.name) + '</option>');
        }
        sel.innerHTML = opts.join('');
        /* disabled 的 selected 默认重置 */
        if (currentVal && currentVal !== '__none__') { sel.value = currentVal; }
      }

      /**
       * 格式化 unix 时间戳为 "MM/DD HH:mm"
       * @param {number} unixSec - 秒级时间戳
       * @returns {string} 格式化字符串（无效返回空）
       */
      function formatResetTime(unixSec) {
        if (!unixSec || typeof unixSec !== 'number') { return ''; }
        const d = new Date(unixSec * 1000);
        if (isNaN(d.getTime())) { return ''; }
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return mm + '/' + dd + ' ' + hh + ':' + mi;
      }

      /**
       * 根据 plan name 返回 badge CSS 类（色彩区分）
       */
      function getPlanClass(planName) {
        if (!planName) { return ''; }
        const p = String(planName).toLowerCase();
        if (p.includes('trial')) { return 'plan-trial'; }
        if (p.includes('pro')) { return 'plan-pro'; }
        if (p.includes('enterprise') || p.includes('team')) { return 'plan-enterprise'; }
        return 'plan-free';
      }

      function renderActiveCard() {
        const active = state.accounts.find(a => a.id === state.activeAccountId);
        const nameEl = document.getElementById('activeName');
        const emailEl = document.getElementById('activeEmail');
        const dailyBar = document.getElementById('dailyBar');
        const weeklyBar = document.getElementById('weeklyBar');
        const dailyVal = document.getElementById('dailyValue');
        const weeklyVal = document.getElementById('weeklyValue');
        const dailyReset = document.getElementById('dailyReset');
        const weeklyReset = document.getElementById('weeklyReset');
        const badge = document.getElementById('planBadge');

        if (active) {
          /* 有 displayName 显示真名，否则只显示邮箱 */
          nameEl.textContent = active.displayName || '';
          emailEl.textContent = active.email;
          const dq = active.dailyQuota != null ? active.dailyQuota : 0;
          const wq = active.weeklyQuota != null ? active.weeklyQuota : 0;
          dailyBar.style.width = dq + '%';
          weeklyBar.style.width = wq + '%';
          dailyBar.className = 'progress-fill ' + getQuotaClass(dq);
          weeklyBar.className = 'progress-fill ' + getQuotaClass(wq);
          dailyVal.textContent = dq + '%';
          weeklyVal.textContent = wq + '%';
          dailyReset.textContent = formatResetTime(active.dailyResetAt);
          weeklyReset.textContent = formatResetTime(active.weeklyResetAt);
          /* 套餐 badge，有 planName 显示真名，否则 Active */
          const plan = active.planName || 'Active';
          badge.textContent = plan;
          badge.className = 'badge ' + getPlanClass(active.planName);
        } else {
          nameEl.textContent = '';
          emailEl.textContent = '未登录';
          dailyBar.style.width = '0%';
          weeklyBar.style.width = '0%';
          dailyVal.textContent = '--';
          weeklyVal.textContent = '--';
          dailyReset.textContent = '';
          weeklyReset.textContent = '';
          badge.textContent = '--';
          badge.className = 'badge';
        }
      }

      function getQuotaClass(percent) {
        if (percent > 50) return '';
        if (percent > 25) return 'warning';
        if (percent > 5) return 'danger';
        return 'critical';
      }

      /**
       * SVG 图标库（账号卡片操作按钮专用）
       */
      const ICONS = {
        switch: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
        refresh: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
        edit: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
        close: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
      };

      /** 获取当前所有筛选条件过滤后的账号列表 (搜索 + Plan + 到期 + 创建时间 + 邮箱后缀) */
      function getFilteredAccounts() {
        const searchText = (document.getElementById('searchInput')?.value || '').toLowerCase();
        const filterPlan = (document.getElementById('filterPlan')?.value || '');
        const filterExpiry = (document.getElementById('filterExpiry')?.value || '');
        const filterCreated = (document.getElementById('filterCreated')?.value || '');
        const filterSuffix = (document.getElementById('filterSuffix')?.value || '').toLowerCase().trim();
        const nowSec = Math.floor(Date.now() / 1000);

        return (state.accounts || []).filter(a => {
          if (searchText && !a.email.toLowerCase().includes(searchText)) { return false; }
          if (filterPlan) {
            const plan = (a.planName || '').toLowerCase();
            if (plan !== filterPlan.toLowerCase()) { return false; }
          }
          if (filterExpiry) {
            if (filterExpiry === 'expired') {
              if (!a.planEndAt || a.planEndAt >= nowSec) { return false; }
            } else if (filterExpiry === 'noexpiry') {
              if (a.planEndAt) { return false; }
            } else {
              const days = parseInt(filterExpiry);
              if (!a.planEndAt) { return false; }
              const remainDays = (a.planEndAt - nowSec) / 86400;
              if (remainDays < 0 || remainDays > days) { return false; }
            }
          }
          if (filterCreated) {
            const days = parseInt(filterCreated);
            if (!a.createdAt) { return false; }
            const ageDays = (nowSec - a.createdAt) / 86400;
            if (ageDays > days) { return false; }
          }
          if (filterSuffix) {
            const atIdx = a.email.indexOf('@');
            const domain = atIdx >= 0 ? a.email.substring(atIdx + 1).toLowerCase() : '';
            if (!domain.includes(filterSuffix)) { return false; }
          }
          return true;
        });
      }

      /** 检查当前是否有任何筛选条件处于激活状态 */
      function hasActiveFilter() {
        const searchText = (document.getElementById('searchInput')?.value || '');
        const filterPlan = (document.getElementById('filterPlan')?.value || '');
        const filterExpiry = (document.getElementById('filterExpiry')?.value || '');
        const filterCreated = (document.getElementById('filterCreated')?.value || '');
        const filterSuffix = (document.getElementById('filterSuffix')?.value || '').trim();
        return searchText.length > 0 || !!filterPlan || !!filterExpiry || !!filterCreated || !!filterSuffix;
      }

      /**
       * 渲染账号卡片列表
       * 结构: 按分组永久分节; 每个 section 内有自己的分页条
       * 搜索过滤: 跨分组; 过滤为空的分组 section 不显示
       */
      function renderAccountList() {
        const list = document.getElementById('accountList');
        const filtered = getFilteredAccounts();

        if (filtered.length === 0) {
          list.innerHTML = '<div class="empty-state">'
            + (state.accounts.length === 0 ? '暂无账号，点击顶部 + 导入' : '无匹配结果')
            + '</div>';
          return;
        }

        /* 永远按分组分节: 默认分组在最前, 再按 state.groups 顺序
         * 传入 hasFilter 让空分组在筛选时仍被过滤, 非筛选场景下保留展示
         * (这样用户新建的空分组也能在 UI 上看到, 否则会感觉"创建不了") */
        list.innerHTML = renderGroupedSections(filtered, hasActiveFilter());

        /* 绑定所有事件 (折叠 / 分组操作 / 账号操作 / 分页) */
        bindSectionHeaderToggle(list);
        bindSectionActions(list);
        bindGroupSelectAll(list);
        bindAccountCheckboxEvents(list);
        bindAccountActionEvents(list);
        bindPerSectionPagination(list);

        /* 重绘后重新同步"刷新中"状态 (因为 innerHTML 会丢失 class) */
        applyRefreshingClass();
      }

      /**
       * 绑定 section header 点击折叠
       * 点击 actions / 分组 checkbox 不触发折叠
       */
      function bindSectionHeaderToggle(list) {
        list.querySelectorAll('.group-section-header').forEach(el => {
          el.addEventListener('click', (e) => {
            /* 操作按钮 / 分组勾选框不触发折叠 */
            if (e.target.closest('.group-section-actions, .group-checkbox')) { return; }
            const gid = el.dataset.gid;
            /* 默认折叠语义: undefined 视为 true (折叠).
             * 翻转时要显式读当前状态, 避免 undefined 取反变成 true (还是折叠) 的 bug */
            const curCollapsed = viewState.collapsedGroups[gid] !== false;
            viewState.collapsedGroups[gid] = !curCollapsed;
            renderAccountList();
          });
        });
      }

      /**
       * 绑定"全选本组" checkbox
       *
       * 状态机:
       *   none    → 点击 → all    (选中本组所有账号)
       *   partial → 点击 → all    (补齐为全选, 与主流产品一致)
       *   all     → 点击 → none   (取消本组所有选中)
       *
       * 渲染时 HTML 里用 data-state 记录初始态, 此处同步 DOM 的 indeterminate 属性
       * (HTML 标签没法直接写 indeterminate, 必须 JS 设置)
       *
       * 搜索过滤场景: 只针对"当前过滤后能见到"的同组账号操作, 不会动到被过滤掉的
       */
      function bindGroupSelectAll(list) {
        list.querySelectorAll('.group-checkbox').forEach(el => {
          /* 同步 indeterminate 视觉 */
          if (el.dataset.state === 'partial') { el.indeterminate = true; }

          /* 阻止 click 冒泡到 section header (避免折叠) */
          el.addEventListener('click', (e) => { e.stopPropagation(); });

          el.addEventListener('change', (e) => {
            e.stopPropagation();
            const gid = el.dataset.gid;
            /* 取出当前分组 + 当前筛选范围 内的所有账号 */
            const allFiltered = getFilteredAccounts();
            const groupItems = allFiltered.filter(a => {
              const inGroup = gid === 'none' ? !a.groupId : a.groupId === gid;
              return inGroup;
            });
            if (groupItems.length === 0) { return; }

            const allSelected = groupItems.every(a => viewState.selectedIds[a.id]);
            if (allSelected) {
              /* 全 → 取消本组 */
              for (const a of groupItems) { delete viewState.selectedIds[a.id]; }
            } else {
              /* 无 / 半 → 补齐全选 */
              for (const a of groupItems) { viewState.selectedIds[a.id] = true; }
            }
            renderAccountList();
            renderBulkBar();
          });
        });
      }

      /**
       * 绑定分组操作按钮 (重命名 / 删除)
       * 仅自定义分组有这两个按钮 (默认分组/系统分组无)
       */
      function bindSectionActions(list) {
        list.querySelectorAll('.btn-group-rename').forEach(el => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            openRenameGroupModal(el.dataset.gid);
          });
        });
        list.querySelectorAll('.btn-group-delete').forEach(el => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            confirmDeleteGroup(el.dataset.gid);
          });
        });
      }

      /** 选中 checkbox 事件 */
      function bindAccountCheckboxEvents(list) {
        list.querySelectorAll('.account-checkbox').forEach(el => {
          el.addEventListener('click', (e) => {
            /* 阻止冒泡到卡片其他点击区 */
            e.stopPropagation();
          });
          el.addEventListener('change', (e) => {
            const id = el.dataset.id;
            if (el.checked) { viewState.selectedIds[id] = true; }
            else { delete viewState.selectedIds[id]; }
            /* 只更新批量栏 + 卡片选中样式，不全量重渲染 */
            const item = el.closest('.account-item');
            if (item) {
              if (el.checked) { item.classList.add('selected'); }
              else { item.classList.remove('selected'); }
            }
            renderBulkBar();
          });
        });
      }

      /**
       * 账号操作按钮事件 (切号 / 刷新 / 编辑 / 删除)
       * 切号按钮总是弹二次确认（包括当前活跃账号的重新登录）
       */
      function bindAccountActionEvents(list) {
        list.querySelectorAll('.btn-acc-switch').forEach(el => {
          el.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = el.dataset.id;
            const acc = state.accounts.find(a => a.id === id);
            if (!acc) { return; }
            const isActive = id === state.activeAccountId;
            const ok = await confirmDialog({
              title: isActive ? '重新登录当前账号' : '切换账号',
              message: (isActive ? '重新登录 ' : '切换到 ')
                + '<strong>' + escapeHtml(acc.email) + '</strong>？',
              okText: isActive ? '重新登录' : '确定切换'
            });
            if (ok) { send('switchAccount', { accountId: id }); }
          });
        });
        list.querySelectorAll('.account-avatar[data-email], .account-email[data-email]').forEach(el => {
          el.addEventListener('click', async (e) => {
            e.stopPropagation();
            const email = el.dataset.email || '';
            if (!email) { return; }
            send('copyEmail', { email });
            const oldTitle = el.getAttribute('title') || email;
            el.setAttribute('title', '已复制: ' + email);
            setTimeout(() => el.setAttribute('title', oldTitle), 1000);
          });
        });
        list.querySelectorAll('.btn-acc-refresh').forEach(el => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = el.dataset.id;
            /* 立即加 spinning, 视觉反馈; 后端返回 singleRefreshDone 后移除
             * 同时记录到全局 Set, 保证 sendFullState 触发的重绘也能保持转圈 */
            refreshingAccountIds.add(id);
            applyRefreshingClass();
            send('refreshBalance', { accountId: id });
          });
        });
        list.querySelectorAll('.btn-acc-edit').forEach(el => {
          el.addEventListener('click', (e) => { e.stopPropagation(); openEditModal(el.dataset.id); });
        });
        list.querySelectorAll('.btn-acc-delete').forEach(el => {
          el.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = el.dataset.id;
            const acc = state.accounts.find(a => a.id === id);
            if (!acc) { return; }
            const ok = await confirmDialog({
              title: '删除 ' + acc.email + '？',
              message: '该操作不可恢复，确认删除账号？',
              okText: '确定删除',
              dangerous: true
            });
            if (ok) { send('deleteAccount', { accountId: id }); }
          });
        });
      }

      /**
       * 渲染分页条 HTML (归属某个 section, 独立状态)
       * 小于默认页属且不是 "全部" 模式不显示
       *
       * @param {string} gid    - 分组 ID ('none' 代表默认分组)
       * @param {number} total  - 该分组总账号数 (过滤后)
       * @returns {string} HTML (空串 = 不显示分页条)
       */
      function renderPaginationBar(gid, total) {
        const { pageSize, currentPage } = getGroupPaging(gid);
        const effectiveSize = pageSize > 0 ? pageSize : total;
        const totalPages = Math.max(1, Math.ceil(total / effectiveSize));
        /* 账号少且默认页属时不显示 */
        if (totalPages <= 1 && total <= DEFAULT_PAGE_SIZE) { return ''; }
        const from = (currentPage - 1) * effectiveSize + 1;
        const to = Math.min(currentPage * effectiveSize, total);

        /* 每页条数选项 (0 = 全部) */
        const sizeOpts = [10, 20, 50, 100, 0];
        const sizeSelect = '<select class="page-size-select" data-role="page-size" data-gid="' + gid + '">'
          + sizeOpts.map(s => '<option value="' + s + '"' + (s === pageSize ? ' selected' : '') + '>' + (s === 0 ? '全部' : s + '/页') + '</option>').join('')
          + '</select>';

        /* 页码按钮 */
        let pages = '';
        if (totalPages > 1) {
          const btn = (p, label, disabled, active) =>
            '<button class="page-btn' + (active ? ' active' : '') + '" data-page="' + p + '" data-gid="' + gid + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
          pages += btn(currentPage - 1, '‹', currentPage <= 1, false);
          const range = computePageRange(currentPage, totalPages);
          for (const p of range) {
            if (p === '...') { pages += '<span class="page-ellipsis">...</span>'; }
            else { pages += btn(p, String(p), false, p === currentPage); }
          }
          pages += btn(currentPage + 1, '›', currentPage >= totalPages, false);
        }

        return '<div class="pagination-bar" data-gid="' + gid + '">'
          + '<div class="pagi-info">' + from + '-' + to + ' / 共 ' + total + '</div>'
          + '<div class="pagi-controls">' + pages + '</div>'
          + sizeSelect
          + '</div>';
      }

      /**
       * 生成紧凑页码序列 (类似 Baidu 分页)
       * 规则: 首页 + 当前页±1 + 末页; 中间超 1 页用 '...' 省略
       * 示例: current=5, total=10 → [1, '...', 4, 5, 6, '...', 10]
       * @param {number} current
       * @param {number} total
       * @returns {(number|string)[]}
       */
      function computePageRange(current, total) {
        if (total <= 7) {
          const all = [];
          for (let i = 1; i <= total; i++) { all.push(i); }
          return all;
        }
        const pages = [1];
        if (current > 3) { pages.push('...'); }
        const low = Math.max(2, current - 1);
        const high = Math.min(total - 1, current + 1);
        for (let p = low; p <= high; p++) { pages.push(p); }
        if (current < total - 2) { pages.push('...'); }
        pages.push(total);
        return pages;
      }

      /**
       * 绑定每个 section 的分页条事件 (页码按钮 + 每页条数下拉)
       * 事件委托到 list 容器, 按 data-gid 更新对应分组状态
       * @param {HTMLElement} list - 账号列表容器
       */
      function bindPerSectionPagination(list) {
        list.querySelectorAll('.pagination-bar .page-btn').forEach(el => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            const p = parseInt(el.dataset.page);
            const gid = el.dataset.gid;
            if (isNaN(p) || p < 1 || !gid) { return; }
            if (p === (viewState.currentPage[gid] || 1)) { return; }
            viewState.currentPage[gid] = p;
            renderAccountList();
            /* 切页后滚动 section header 到可见区, 避免用户看着一半 */
            const header = list.querySelector('.group-section-header[data-gid="' + gid + '"]');
            if (header) { header.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          });
        });
        list.querySelectorAll('.pagination-bar .page-size-select').forEach(sel => {
          sel.addEventListener('change', (e) => {
            e.stopPropagation();
            const gid = sel.dataset.gid;
            if (!gid) { return; }
            viewState.pageSize[gid] = parseInt(sel.value);
            viewState.currentPage[gid] = 1;
            renderAccountList();
          });
        });
      }

      /**
       * 按分组分节渲染账号列表 (“全部”视图专用)
       * 顺序：默认分组 (如有) → 分组A → 分组B → ...
       * 默认分组优先展示, 与 chip 顺序 "全部 · 默认分组 · 其他分组" 保持一致
       */
      function renderGroupedSections(accounts, hasSearch) {
        const groups = state.groups || [];
        const sections = [];
        /* 总排序: 按套餐到期时间升序 (越早到期越靠前), 这样 filter 出的每个分组也自然有序 */
        const sorted = accounts.slice().sort(sortByExpire);
        /* 默认分组 (无 groupId 的账号) 排最前 */
        const ungrouped = sorted.filter(a => !a.groupId);
        if (ungrouped.length > 0) {
          sections.push(renderSection('none', '默认分组', ungrouped));
        }
        for (const g of groups) {
          const items = sorted.filter(a => a.groupId === g.id);
          /* 搜索场景: 精确过滤, 空分组跳过
           * 非搜索场景: 保留空分组, 让用户看到新建的 / 刚把账号全移走的分组 */
          if (items.length === 0 && hasSearch) { continue; }
          sections.push(renderSection(g.id, g.name, items));
        }
        return sections.join('');
      }

      /**
       * 账号排序规则: 按套餐到期时间升序 (越早到期越靠前)
       * - 有 planEndAt 的账号排前面, 按时间升序
       * - 无 planEndAt 的账号排后面, 按邮箱字典序 fallback
       * @param {object} a
       * @param {object} b
       * @returns {number}
       */
      function sortByExpire(a, b) {
        const aEnd = a.planEndAt || 0;
        const bEnd = b.planEndAt || 0;
        if (aEnd && bEnd) { return aEnd - bEnd; }
        if (aEnd) { return -1; }
        if (bEnd) { return 1; }
        /* 两边都没到期信息: 按邮箱排 (稳定可预测) */
        return (a.email || '').localeCompare(b.email || '');
      }

      /**
       * 系统分组 ID: Lite 版仅保留默认分组 'none' (未分组账号)
       * 该分组不可重命名 / 不可删除
       */
      const SYSTEM_GROUP_IDS = ['none'];

      /**
       * 渲染单个分组 section
       * 内部结构: header (chev + 名称 + count + actions) + 当前页卡片 + 独立分页条
       *
       * @param {string} gid   - 分组 ID ('none' = 默认分组)
       * @param {string} name  - 分组显示名
       * @param {object[]} items - 该分组全量账号 (过滤后)
       */
      function renderSection(gid, name, items) {
        /* 默认折叠: undefined = 用户未手动操作过, 按折叠态渲染
         * 只有显式 false 时 (用户主动展开) 才展开 */
        const collapsed = viewState.collapsedGroups[gid] !== false;
        const chev = '<span class="chev"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>';

        /* 系统分组 (默认分组) 不显示重命名/删除按钮 */
        const isSystem = SYSTEM_GROUP_IDS.indexOf(gid) >= 0;
        const actions = isSystem ? '' :
          '<div class="group-section-actions">'
          + '<button class="btn-icon btn-group-rename" data-gid="' + gid + '" title="重命名分组">' + ICONS.edit + '</button>'
          + '<button class="btn-icon btn-group-delete danger" data-gid="' + gid + '" title="删除分组">' + ICONS.close + '</button>'
          + '</div>';

        /* 当前页切片 (账号可能被删导致页码越界, 自动纠正) */
        const { pageSize, currentPage } = getGroupPaging(gid);
        const effectiveSize = pageSize > 0 ? pageSize : items.length;
        const totalPages = Math.max(1, Math.ceil(items.length / effectiveSize));
        let curPage = currentPage;
        if (curPage > totalPages) { curPage = totalPages; viewState.currentPage[gid] = curPage; }
        if (curPage < 1) { curPage = 1; viewState.currentPage[gid] = 1; }
        const start = (curPage - 1) * effectiveSize;
        const end = Math.min(start + effectiveSize, items.length);
        const pageItems = items.slice(start, end);

        /* 本组勾选框三态:
         * selectedInGroup === 0            → none     (checkbox 空)
         * selectedInGroup === items.length → all      (checkbox 勾)
         * else                              → partial (checkbox 半选) */
        const selectedInGroup = items.reduce(
          (n, a) => n + (viewState.selectedIds[a.id] ? 1 : 0), 0
        );
        const checkState = selectedInGroup === 0 ? 'none'
          : (selectedInGroup === items.length ? 'all' : 'partial');
        /* indeterminate 只能 JS 设置, HTML 先标 data-state, 绑定事件时再同步 */
        const chkHtml = '<input type="checkbox" class="group-checkbox" data-gid="'
          + gid + '" data-state="' + checkState + '"'
          + (checkState === 'all' ? ' checked' : '')
          + ' title="全选本组 / 取消全选" />';

        /* 空分组占位: 提示用户可以从导入 / 编辑账号时把账号归入此组 */
        const bodyHtml = items.length === 0
          ? '<div class="group-empty">暂无账号, 可在导入或编辑账号时选择此分组</div>'
          : pageItems.map(a => renderAccountItem(a)).join('');

        return '<div class="group-section' + (collapsed ? ' collapsed' : '') + '">'
          + '<div class="group-section-header' + (collapsed ? ' collapsed' : '') + '" data-gid="' + gid + '">'
          + chev
          + chkHtml
          + '<span class="group-name">' + escapeHtml(name) + '</span>'
          + '<span class="section-tail">'
          + '<span class="count">' + items.length + '</span>'
          + actions
          + '</span>'
          + '</div>'
          + bodyHtml
          + renderPaginationBar(gid, items.length)
          + '</div>';
      }

      function renderAccountItem(a) {
        const isActive = a.id === state.activeAccountId;
        const isSelected = !!viewState.selectedIds[a.id];
        const initial = a.email.charAt(0).toUpperCase();
        const dq = a.dailyQuota != null ? a.dailyQuota : -1;
        const wq = a.weeklyQuota != null ? a.weeklyQuota : -1;

        /* 套餐 badge */
        const planBadge = a.planName
          ? '<span class="badge ' + getPlanClass(a.planName) + '">' + escapeHtml(a.planName) + '</span>'
          : '';

        /* 到期行：优先 planEndAt（套餐真正到期），否则不显示 */
        const expireInfo = computeExpireInfo(a);

        /* 配额条（没有数据时提示刷新） */
        let quotasHtml;
        if (dq < 0) {
          quotasHtml = '<div class="account-quotas-empty">未刷新配额，点 刷新 图标查询</div>';
        } else {
          quotasHtml = '<div class="account-quotas">'
            + '<div class="account-quota-row">'
            + '<span class="quota-label">日</span>'
            + '<div class="progress-track"><div class="progress-fill ' + getQuotaClass(dq) + '" style="width:' + dq + '%"></div></div>'
            + '<span class="quota-value">' + dq + '%</span>'
            + '<span class="quota-reset">' + formatResetTime(a.dailyResetAt) + '</span>'
            + '</div>'
            + '<div class="account-quota-row">'
            + '<span class="quota-label">周</span>'
            + '<div class="progress-track"><div class="progress-fill ' + getQuotaClass(wq) + '" style="width:' + wq + '%"></div></div>'
            + '<span class="quota-value">' + wq + '%</span>'
            + '<span class="quota-reset">' + formatResetTime(a.weeklyResetAt) + '</span>'
            + '</div>'
            + '</div>';
        }

        const expireHtml = expireInfo
          ? '<div class="account-expire-line">'
            + '<span class="expire-label">到期时间: ' + expireInfo.dateText + '</span>'
            + '<span class="expire-remain ' + expireInfo.level + '">' + expireInfo.remainText + '</span>'
            + '</div>'
          : '';

        return '<div class="account-item' + (isActive ? ' active' : '') + (isSelected ? ' selected' : '') + '" data-id="' + a.id + '">'
          + '<div class="account-row-head">'
          + '<input type="checkbox" class="account-checkbox" data-id="' + a.id + '"' + (isSelected ? ' checked' : '') + ' title="选中" />'
          + '<div class="account-avatar" title="' + escapeAttr(a.email) + '" data-email="' + escapeAttr(a.email) + '">' + initial + '</div>'
          + '<div class="account-email" title="' + escapeAttr(a.email) + '" data-email="' + escapeAttr(a.email) + '"><span class="email-text">' + escapeHtml(a.email) + '</span>' + planBadge + '</div>'
          + '<div class="account-actions">'
          + '<button class="btn-icon btn-acc-switch" data-id="' + a.id + '" title="切换到此账号">' + ICONS.switch + '</button>'
          + '<button class="btn-icon btn-acc-refresh" data-id="' + a.id + '" title="刷新配额">' + ICONS.refresh + '</button>'
          + '<button class="btn-icon btn-acc-edit" data-id="' + a.id + '" title="编辑账号">' + ICONS.edit + '</button>'
          + '<button class="btn-icon btn-acc-delete danger" data-id="' + a.id + '" title="删除账号">' + ICONS.close + '</button>'
          + '</div>'
          + '</div>'
          + quotasHtml
          + expireHtml
          + '</div>';
      }

      /**
       * 计算套餐到期信息 (显示在卡片底部)
       * 只用 planEndAt (真正的套餐结束时间)，周重置时间不算到期
       * @returns {null | {dateText, remainText, level}}
       */
      function computeExpireInfo(a) {
        if (!a.planEndAt || typeof a.planEndAt !== 'number') { return null; }
        const end = a.planEndAt;
        const now = Math.floor(Date.now() / 1000);
        const diffSec = end - now;

        /* 格式化到期日期: YYYY-MM-DD HH:mm (不能用模板串，webview 脚本本身已被外层反引号包裹) */
        const d = new Date(end * 1000);
        const yy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        const dateText = yy + '-' + mm + '-' + dd + ' ' + hh + ':' + mi;

        /* 剩余时间精确显示: "X天Y小时后到期" / "X小时Y分后到期" / "X分钟后到期"
         * 避免单纯 floor/ceil 导致"13.4天"被显示成 13 天 或 14 天（都不够直观） */
        let remainText, level;
        if (diffSec <= 0) {
          remainText = '已到期';
          level = 'danger';
        } else {
          const days = Math.floor(diffSec / 86400);
          const hours = Math.floor((diffSec % 86400) / 3600);
          const minutes = Math.floor((diffSec % 3600) / 60);
          if (days > 0) {
            /* ≥ 1 天: 天 + 小时 (小时为 0 省略) */
            remainText = hours > 0
              ? days + '天' + hours + '小时后到期'
              : days + '天后到期';
          } else if (hours > 0) {
            /* < 1 天但 ≥ 1 小时: 小时 + 分钟 */
            remainText = minutes > 0
              ? hours + '小时' + minutes + '分后到期'
              : hours + '小时后到期';
          } else {
            /* < 1 小时 */
            remainText = minutes > 0
              ? minutes + '分钟后到期'
              : '即将到期';
          }
          /* 颜色分级按完整天数判定 */
          if (days <= 3) { level = 'danger'; }
          else if (days <= 7) { level = 'warn'; }
          else { level = 'ok'; }
        }

        return { dateText, remainText, level };
      }

      /* ---------- 通用确认弹窗 ---------- */
      /**
       * 弹出确认框，返回 Promise<boolean>
       * @param {object} opts - {title, message, okText, cancelText, dangerous}
       * @returns {Promise<boolean>}
       */
      function confirmDialog(opts) {
        return new Promise(resolve => {
          const modal = document.getElementById('confirmModal');
          document.getElementById('confirmTitle').textContent = opts.title || '确认操作';
          document.getElementById('confirmMsg').innerHTML = opts.message || '';
          const okBtn = document.getElementById('confirmOk');
          const cancelBtn = document.getElementById('confirmCancel');
          okBtn.textContent = opts.okText || '确定';
          cancelBtn.textContent = opts.cancelText || '取消';
          /* 危险操作 → 确认按钮改红色 */
          okBtn.className = opts.dangerous ? 'btn btn-danger-solid' : 'btn btn-primary';

          const cleanup = (val) => {
            modal.style.display = 'none';
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            resolve(val);
          };
          okBtn.onclick = () => cleanup(true);
          cancelBtn.onclick = () => cleanup(false);
          modal.style.display = 'flex';
        });
      }

      /* ---------- 编辑账号弹窗 ---------- */
      /**
       * 打开编辑账号弹窗，提交后发送 editAccount 消息到后端
       */
      function openEditModal(accountId) {
        const account = state.accounts.find(a => a.id === accountId);
        if (!account) { return; }
        document.getElementById('editEmail').textContent = account.email;
        document.getElementById('editPassword').value = '';
        document.getElementById('editNote').value = account.note || '';

        /* 填充分组下拉 */
        const sel = document.getElementById('editGroup');
        const optsHtml = ['<option value="">(无分组)</option>']
          .concat((state.groups || []).map(g =>
            '<option value="' + g.id + '"' + (account.groupId === g.id ? ' selected' : '') + '>'
            + escapeHtml(g.name) + '</option>'))
          .concat('<option value="__new__">➕ 新建分组...</option>');
        sel.innerHTML = optsHtml.join('');
        sel.value = account.groupId || '';

        document.getElementById('editModal').dataset.accountId = accountId;
        document.getElementById('editModal').style.display = 'flex';
        setTimeout(() => document.getElementById('editPassword').focus(), 50);
      }

      function closeEditModal() {
        document.getElementById('editModal').style.display = 'none';
      }

      function renderPatchStatus() {
        const el = document.getElementById('patchStatus');
        if (!state.patchStatus || !state.schemeList) {
          el.textContent = '';
          /* 即便没有详细状态, switchMode toggle 也要尽力同步 (默认 patch) */
          applySwitchModeUI(state.switchMode || 'patch');
          return;
        }
        const lines = state.schemeList.map(s =>
          (s.applied ? '[v] ' : '[ ] ') + s.description
        );
        if (state.windsurfPath) {
          lines.unshift('路径: ' + state.windsurfPath);
        }
        const diag = state.patchDiagnostics;
        if (diag) {
          lines.push('extension.js: ' + (diag.extensionJsExists ? (diag.extensionJsPath || '已找到') : '未找到'));
          lines.push('文件可写: ' + (diag.writable ? '是' : '否'));
          if (diag.backups && diag.backups.length) {
            lines.push('备份: ' + diag.backups.length + ' 个');
          }
          const blocked = (diag.schemes || []).filter(s => !s.applied && !s.canApply);
          if (blocked.length) {
            lines.push('不可应用: ' + blocked.map(s => s.id + '(' + (s.reason || '未知原因') + ')').join('; '));
          }
        }
        /* 运行态追加: 当前模式 + Windsurf 进程数 (多开提示) */
        const mode = state.switchMode || 'patch';
        lines.push('模式: ' + (mode === 'uri' ? 'URI (兜底)' : 'Patch (推荐)'));
        el.textContent = lines.join('\\n');
        el.style.whiteSpace = 'pre-wrap';

        /* segmented toggle 同步 + URI 专属按钮显隐 */
        applySwitchModeUI(mode);
      }

      /**
       * 切号模式 UI 同步
       * - segmented control 高亮
       * - uri 模式下显示"应用/恢复 URI 补丁"按钮, patch 模式下隐藏
       */
      function applySwitchModeUI(mode) {
        const patchBtn = document.getElementById('modeBtnPatch');
        const uriBtn = document.getElementById('modeBtnUri');
        if (patchBtn && uriBtn) {
          patchBtn.classList.toggle('active', mode === 'patch');
          uriBtn.classList.toggle('active', mode === 'uri');
        }
        document.querySelectorAll('.uri-tool').forEach(el => {
          el.style.display = (mode === 'uri') ? 'flex' : 'none';
        });
      }

      function renderInstances(instances) {
        const list = document.getElementById('instanceList');
        if (!instances || instances.length === 0) {
          list.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-muted);">暂无分身实例</div>';
          list.style.display = 'block';
          return;
        }
        const now = Date.now();
        const html = instances.map(inst => {
          const isMe = inst.id === (state.myInstanceId || '');
          const isMain = inst.id === '__main__';
          const lockInfo = inst.lockedEmail
            ? '<span class="locked">' + inst.lockedEmail + '</span>'
            : '<span style="opacity:0.5">未占用</span>';
          /* 心跳间隔 60s, 2 分钟内视为运行中 */
          const isRunning = inst.lastSeen && (now - inst.lastSeen) < 120000;
          const lastSeen = inst.lastSeen
            ? (isRunning
                ? '<span class="inst-status-dot running"></span>运行中'
                : '<span class="inst-status-dot stopped"></span>已停止 (' + Math.round((now - inst.lastSeen) / 60000) + ' 分钟前)')
            : '<span class="inst-status-dot stopped"></span><span style="opacity:0.5">未启动</span>';
          /* 从 dataDir 提取分身名 (最后一段路径) */
          const profileName = (inst.dataDir || '').replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop() || '';
          /* 非主实例 + 非当前实例 → 显示启动和删除按钮 */
          const actions = (!isMain && !isMe)
            ? '<div class="inst-actions">'
              + '<button class="btn-inst btn-inst-launch" data-profile="' + profileName + '">启动</button>'
              + '<button class="btn-inst btn-inst-delete" data-profile="' + profileName + '">删除</button>'
              + '</div>'
            : '';
          return '<div class="instance-card' + (isMe ? ' is-me' : '') + '">'
            + '<div class="inst-header">'
            + '<div class="inst-label">' + inst.label + (isMe ? ' (当前)' : '') + '</div>'
            + actions
            + '</div>'
            + '<div class="inst-lock">账号: ' + lockInfo + '</div>'
            + '<div class="inst-time">' + lastSeen + '</div>'
            + '</div>';
        }).join('');
        list.innerHTML = html;
        list.style.display = 'block';

        /* 绑定启动按钮 */
        list.querySelectorAll('.btn-inst-launch').forEach(el => {
          el.addEventListener('click', () => {
            send('createInstance', { name: el.dataset.profile });
          });
        });
        /* 绑定删除按钮 */
        list.querySelectorAll('.btn-inst-delete').forEach(el => {
          el.addEventListener('click', async () => {
            const name = el.dataset.profile;
            const ok = await confirmDialog({
              title: '删除分身',
              message: '将删除分身 <strong>' + name + '</strong> 的所有数据，此操作不可恢复！',
              okText: '确定删除',
              dangerous: true
            });
            if (ok) { send('deleteInstance', { name }); }
          });
        });
      }

      function renderSettings() {
        const s = state.settings || {};
        setChecked('settAutoSwitch', s.autoSwitchEnabled);
        setChecked('settSilent', s.autoSwitchSilent);
        setChecked('settAutoResetMachineId', s.autoResetMachineIdOnAutoSwitch);
        setValue('settAutoSwitchPlanType', s.autoSwitchPlanType || 'All');
        setChecked('settAutoRefresh', s.balanceAutoRefresh);
        setChecked('settStatusBar', s.statusBarEnabled);
        setValue('settThreshold', s.autoSwitchThreshold);
        setValue('settInterval', s.balanceRefreshInterval);
        setValue('settConcurrentLimit', s.concurrentLimit != null ? s.concurrentLimit : 5);
        setChecked('settUnlimitedConcurrent', !!s.unlimitedConcurrent);
        const appVersion = document.getElementById('appVersion');
        if (appVersion) { appVersion.textContent = state.appVersion || '-'; }
        document.getElementById('thresholdValue').textContent = (s.autoSwitchThreshold || 5) + '%';
        /* 无限并发开启时, 并发上限输入框置灰 (仅视觉, 不阻止) */
        const concurrentInput = document.getElementById('settConcurrentLimit');
        if (concurrentInput) {
          concurrentInput.disabled = !!s.unlimitedConcurrent;
          concurrentInput.style.opacity = s.unlimitedConcurrent ? '0.45' : '1';
        }
      }

      function setChecked(id, val) {
        const el = document.getElementById(id);
        if (el) el.checked = !!val;
      }
      function setValue(id, val) {
        const el = document.getElementById(id);
        if (el && val != null) el.value = val;
      }

      /* ---------- 事件绑定 ---------- */

      /* 标签页切换 */
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
          tab.classList.add('active');
          document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
          /* 切到工具箱时请求补丁状态 (延迟加载，避免启动时扫描文件) */
          if (tab.dataset.tab === 'tools') {
            send('getPatchStatus');
          }
        });
      });

      /* 搜索 (每次输入重置所有分组倒第 1 页) */
      document.getElementById('searchInput').addEventListener('input', () => {
        viewState.currentPage = {};
        renderAccountList();
      });

      /* 筛选面板切换按钮 */
      document.getElementById('filterToggleBtn')?.addEventListener('click', () => {
        const panel = document.getElementById('filterPanel');
        const btn = document.getElementById('filterToggleBtn');
        if (!panel || !btn) { return; }
        const visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : 'block';
        btn.classList.toggle('active', !visible);
      });

      /* 筛选控件 (Plan 类型 / 到期时间 / 创建时间 / 邮箱后缀) */
      document.getElementById('filterPlan')?.addEventListener('change', () => {
        viewState.currentPage = {};
        renderAccountList();
        syncFilterBtnState();
      });
      document.getElementById('filterExpiry')?.addEventListener('change', () => {
        viewState.currentPage = {};
        renderAccountList();
        syncFilterBtnState();
      });
      document.getElementById('filterCreated')?.addEventListener('change', () => {
        viewState.currentPage = {};
        renderAccountList();
        syncFilterBtnState();
      });
      document.getElementById('filterSuffix')?.addEventListener('input', () => {
        viewState.currentPage = {};
        renderAccountList();
        syncFilterBtnState();
      });

      /* 重置筛选 */
      document.getElementById('filterResetBtn')?.addEventListener('click', () => {
        const fp = document.getElementById('filterPlan'); if (fp) { fp.value = ''; }
        const fe = document.getElementById('filterExpiry'); if (fe) { fe.value = ''; }
        const fc = document.getElementById('filterCreated'); if (fc) { fc.value = ''; }
        const fs = document.getElementById('filterSuffix'); if (fs) { fs.value = ''; }
        viewState.currentPage = {};
        renderAccountList();
        syncFilterBtnState();
      });

      /** 同步筛选按钮高亮状态 (有任何筛选条件激活时高亮) */
      function syncFilterBtnState() {
        const btn = document.getElementById('filterToggleBtn');
        const filterPlan = (document.getElementById('filterPlan')?.value || '');
        const filterExpiry = (document.getElementById('filterExpiry')?.value || '');
        const filterCreated = (document.getElementById('filterCreated')?.value || '');
        const filterSuffix = (document.getElementById('filterSuffix')?.value || '').trim();
        const hasFilter = !!filterPlan || !!filterExpiry || !!filterCreated || !!filterSuffix;
        if (btn) { btn.classList.toggle('active', hasFilter); }
      }

      /* 顶栏按钮 */
      document.getElementById('btnRefreshAll').addEventListener('click', () => send('refreshAllBalances'));
      document.getElementById('btnImport').addEventListener('click', () => {
        document.getElementById('importModal').style.display = 'flex';
        document.getElementById('importText').value = '';
        document.getElementById('tokenEmail').value = '';
        document.getElementById('tokenValue').value = '';
        /* 默认回到"批量导入"tab */
        switchImportTab('batch');
        /* 填充分组下拉：复用编辑弹窗的选项格式 */
        fillImportGroupSelect();
        document.getElementById('importText').focus();
      });

      /**
       * 填充导入弹窗的分组下拉
       * 默认保留上次选择；没选过则 (无分组)
       */
      function fillImportGroupSelect() {
        const sel = document.getElementById('importGroupSelect');
        const prev = sel.value;
        const opts = ['<option value="">(无分组)</option>']
          .concat((state.groups || []).map(g =>
            '<option value="' + g.id + '">' + escapeHtml(g.name) + '</option>'))
          .concat('<option value="__new__">➕ 新建分组...</option>');
        sel.innerHTML = opts.join('');
        /* 恢复之前的选择；如果选的组被删了则回落到空 */
        if (prev && prev !== '__new__'
            && (prev === '' || (state.groups || []).some(g => g.id === prev))) {
          sel.value = prev;
        } else {
          sel.value = '';
        }
      }
      document.getElementById('btnExport').addEventListener('click', () => {
        const ids = getSelectedIds();
        if (ids.length > 0) {
          send('exportAccounts', { accountIds: ids });
        } else {
          send('exportAccounts');
        }
      });

      /* 导入弹窗 */
      document.getElementById('importClose').addEventListener('click', closeImport);
      document.getElementById('importCancel').addEventListener('click', closeImport);
      /* 分组下拉选"新建分组" → 弹出新建分组框（不关闭导入弹窗） */
      document.getElementById('importGroupSelect').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          e.target.value = ''; /* 复原，等新分组创建后下次渲染自动补全 */
          openAddGroupModal();
        }
      });
      /* Tab 切换 (批量文本 / 单账号 Token) */
      document.querySelectorAll('.import-tab').forEach(el => {
        el.addEventListener('click', () => switchImportTab(el.dataset.mode));
      });

      /**
       * 切换导入 Tab
       * @param {string} mode - 'batch' | 'token' | 'server'
       */
      function switchImportTab(mode) {
        document.querySelectorAll('.import-tab').forEach(el => {
          el.classList.toggle('active', el.dataset.mode === mode);
        });
        document.getElementById('importTab-batch').style.display = mode === 'batch' ? '' : 'none';
        document.getElementById('importTab-token').style.display = mode === 'token' ? '' : 'none';
        document.getElementById('importTab-server').style.display = mode === 'server' ? '' : 'none';
        /* 焦点跳到当前 tab 的首个输入框 */
        if (mode === 'batch') {
          document.getElementById('importText').focus();
        } else if (mode === 'token') {
          document.getElementById('tokenEmail').focus();
        } else if (mode === 'server') {
          document.getElementById('serverBaseUrl').focus();
        }
      }

      document.getElementById('importConfirm').addEventListener('click', () => {
        const groupId = document.getElementById('importGroupSelect').value || '';
        /* 判断当前激活的 tab */
        const activeTab = document.querySelector('.import-tab.active').dataset.mode;

        if (activeTab === 'server') {
          /* 服务端导入: 先从 API 拉取账号再转为批量导入文本 */
          const baseUrl = (document.getElementById('serverBaseUrl').value || '').trim().replace(new RegExp('[/]+$'), '');
          const planType = document.getElementById('serverPlanType').value;
          const credType = document.getElementById('serverCredType').value;
          if (!baseUrl) {
            vscode.postMessage({ type: 'showError', payload: { message: '请填写 API 地址' } });
            return;
          }
          send('serverImport', { baseUrl, planType, credType, groupId });
          showLoading('正在从服务端获取账号...');
          closeImport();
          return;
        }

        let text = '';
        if (activeTab === 'batch') {
          text = document.getElementById('importText').value.trim();
        } else {
          /* Token 模式: 单账号, 拼成一行 "邮箱;auth1:xxx" 或 "邮箱;rt:xxx" */
          const email = document.getElementById('tokenEmail').value.trim();
          const kind = document.getElementById('tokenKind').value;
          const token = document.getElementById('tokenValue').value.trim();
          if (!email || !token) {
            vscode.postMessage({ type: 'showError', payload: { message: '请填写邮箱和 Token' } });
            return;
          }
          const prefix = kind === 'auth1_token' ? 'auth1:' : 'rt:';
          text = email + ';' + prefix + token;
        }

        if (text) {
          send('importAccounts', { text, groupId });
          showLoading('正在导入...');
        }
        closeImport();
      });
      function closeImport() {
        document.getElementById('importModal').style.display = 'none';
      }

      /* 编辑账号弹窗 */
      document.getElementById('editClose').addEventListener('click', closeEditModal);
      document.getElementById('editCancel').addEventListener('click', closeEditModal);
      /* 分组下拉选择 “新建分组” 时，弹新建分组框 */
      document.getElementById('editGroup').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          e.target.value = ''; /* 先复原，等新分组创建后前端下次渲染会自动补全 */
          openAddGroupModal();
        }
      });
      document.getElementById('editConfirm').addEventListener('click', () => {
        const modal = document.getElementById('editModal');
        const accountId = modal.dataset.accountId;
        if (!accountId) { return; }
        const password = document.getElementById('editPassword').value;
        const note = document.getElementById('editNote').value;
        const groupId = document.getElementById('editGroup').value;
        /* 传递到后端；空密码表示不改；groupId 空字符串 = 移出分组 */
        send('editAccount', {
          accountId,
          password: password.length > 0 ? password : undefined,
          note,
          groupId: groupId || null
        });
        closeEditModal();
      });

      /* ---------- 分组管理 ---------- */
      /**
       * 打开新建分组弹窗
       */
      function openAddGroupModal() {
        const modal = document.getElementById('groupModal');
        document.getElementById('groupModalTitle').textContent = '新建分组';
        document.getElementById('groupNameInput').value = '';
        modal.dataset.mode = 'add';
        modal.dataset.groupId = '';
        modal.style.display = 'flex';
        setTimeout(() => document.getElementById('groupNameInput').focus(), 50);
      }
      /**
       * 打开重命名分组弹窗
       */
      function openRenameGroupModal(groupId) {
        const group = (state.groups || []).find(g => g.id === groupId);
        if (!group) { return; }
        const modal = document.getElementById('groupModal');
        document.getElementById('groupModalTitle').textContent = '重命名分组';
        document.getElementById('groupNameInput').value = group.name;
        modal.dataset.mode = 'rename';
        modal.dataset.groupId = groupId;
        modal.style.display = 'flex';
        setTimeout(() => {
          const input = document.getElementById('groupNameInput');
          input.focus();
          input.select();
        }, 50);
      }
      function closeGroupModal() {
        document.getElementById('groupModal').style.display = 'none';
      }
      /**
       * 删除分组 (二次确认)
       */
      async function confirmDeleteGroup(groupId) {
        const group = (state.groups || []).find(g => g.id === groupId);
        if (!group) { return; }
        const ok = await confirmDialog({
          title: '删除分组',
          message: '删除分组 <strong>' + escapeHtml(group.name) + '</strong>？<br><span style="color:var(--text-muted)">组内账号会保留并移到“默认分组”。</span>',
          okText: '确定删除',
          dangerous: true
        });
        if (ok) {
          send('deleteGroup', { groupId });
        }
      }

      document.getElementById('btnAddGroup').addEventListener('click', openAddGroupModal);
      document.getElementById('groupClose').addEventListener('click', closeGroupModal);
      document.getElementById('groupCancel').addEventListener('click', closeGroupModal);
      document.getElementById('groupConfirm').addEventListener('click', () => {
        const modal = document.getElementById('groupModal');
        const mode = modal.dataset.mode;
        const name = document.getElementById('groupNameInput').value.trim();
        if (!name) { return; }
        if (mode === 'rename') {
          send('renameGroup', { groupId: modal.dataset.groupId, name });
        } else {
          send('createGroup', { name });
        }
        closeGroupModal();
      });
      /* 回车快捷提交 */
      document.getElementById('groupNameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { document.getElementById('groupConfirm').click(); }
      });

      /* ---------- 批量操作 ---------- */
      /** 全选当前视图下已渲染的账号 */
      document.getElementById('bulkSelectAll').addEventListener('click', () => {
        /* 全选 = 选中当前筛选后跨分组的所有账号 */
        const filtered = getFilteredAccounts();
        for (const a of filtered) { viewState.selectedIds[a.id] = true; }
        renderAccountList();
        renderBulkBar();
      });

      /** 清除所有选中 */
      document.getElementById('bulkClear').addEventListener('click', () => {
        viewState.selectedIds = {};
        renderAccountList();
        renderBulkBar();
      });

      /** 批量刷新 (选中账号的配额)
       * 仅刷选中, 不弹确认 (刷新是只读操作, 无风险)
       * 每张卡片立即转圈, 后端按顺序完成后解除, 并弹全局进度条 */
      document.getElementById('bulkRefresh').addEventListener('click', () => {
        const ids = getSelectedIds();
        if (ids.length === 0) { return; }
        /* 立即给这些卡片加 spinning, 视觉反馈 */
        for (const id of ids) { refreshingAccountIds.add(id); }
        applyRefreshingClass();
        send('bulkRefresh', { accountIds: ids });
      });

      /** 批量导出选中账号 */
      document.getElementById('bulkExport').addEventListener('click', () => {
        const ids = getSelectedIds();
        if (ids.length === 0) { return; }
        send('exportAccounts', { accountIds: ids });
      });

      /** 批量删除 (二次确认) */
      document.getElementById('bulkDelete').addEventListener('click', async () => {
        const ids = getSelectedIds();
        if (ids.length === 0) { return; }
        const ok = await confirmDialog({
          title: '批量删除账号',
          message: '将删除 <strong>' + ids.length + '</strong> 个账号，此操作不可恢复！',
          okText: '确定删除',
          dangerous: true
        });
        if (ok) {
          send('bulkDelete', { accountIds: ids });
          viewState.selectedIds = {};
        }
      });

      /** 批量移入分组 (下拉触发) */
      document.getElementById('bulkGroupSelect').addEventListener('change', (e) => {
        const ids = getSelectedIds();
        if (ids.length === 0) { e.target.value = '__none__'; return; }
        const val = e.target.value;
        if (val === '__none__') { return; }
        send('bulkAssignGroup', { accountIds: ids, groupId: val || '' });
        e.target.value = '__none__';
        /* 移完后清空选择，避免残留 */
        viewState.selectedIds = {};
      });

      /* 工具箱 */
      document.getElementById('btnApplyPatch').addEventListener('click', () => send('applyPatch'));
      document.getElementById('btnRestorePatch').addEventListener('click', () => send('restorePatch'));

      /* 切号模式 segmented toggle: 点按钮 → 后端更新 config → 回推 patchStatusUpdate 同步 UI */
      ['modeBtnPatch', 'modeBtnUri'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) { return; }
        btn.addEventListener('click', () => {
          const mode = btn.dataset.mode; /* 'patch' | 'uri' */
          if (state.switchMode === mode) { return; } /* 防止重复点 */
          /* 乐观更新: 先同步 UI, 再等后端回推校准 */
          state.switchMode = mode;
          applySwitchModeUI(mode);
          send('setSwitchMode', { mode });
        });
      });

      /* URI 补丁独立管理 (仅 URI 模式下可见) */
      const btnApplyUri = document.getElementById('btnApplyUriPatch');
      if (btnApplyUri) {
        btnApplyUri.addEventListener('click', () => send('applyUriPatch'));
      }
      const btnRestoreUri = document.getElementById('btnRestoreUriPatch');
      if (btnRestoreUri) {
        btnRestoreUri.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: '恢复 URI 补丁',
            message: '将还原 Windsurf 的 URI handler 到原始状态 (使用 .uribackup.* 备份)。重启后生效。',
            okText: '恢复',
            dangerous: true
          });
          if (ok) { send('restoreUriPatch'); }
        });
      }
      document.getElementById('btnResetMachineId').addEventListener('click', () => send('resetMachineId'));
      document.getElementById('btnClearAll').addEventListener('click', async () => {
        const total = (state.accounts || []).length;
        if (total === 0) {
          /* 没账号就不弹，静默返回 */
          return;
        }
        const ok = await confirmDialog({
          title: '清空所有账号',
          message: '即将清空 <strong>' + total + '</strong> 个账号以及活跃状态，<br>此操作<strong>不可恢复</strong>，请再次确认！',
          okText: '确定清空',
          dangerous: true
        });
        if (ok) { send('clearAccounts'); }
      });


      /* 分身管理: 查看/折叠 */
      let instanceListVisible = false;
      document.getElementById('btnRefreshInstances').addEventListener('click', () => {
        const list = document.getElementById('instanceList');
        if (instanceListVisible) {
          list.style.display = 'none';
          instanceListVisible = false;
        } else {
          send('getInstances');
          instanceListVisible = true;
          /* renderInstances 回调会设置 display=block */
        }
      });
      /* 创建分身: webview 内弹窗 */
      document.getElementById('btnCreateInstance').addEventListener('click', () => {
        const modal = document.getElementById('createInstanceModal');
        const input = document.getElementById('instanceNameInput');
        const errEl = document.getElementById('instanceNameError');
        input.value = '';
        errEl.style.display = 'none';
        modal.style.display = 'flex';
        setTimeout(() => input.focus(), 100);
      });
      document.getElementById('createInstanceCancel').addEventListener('click', () => {
        document.getElementById('createInstanceModal').style.display = 'none';
      });
      document.getElementById('createInstanceOk').addEventListener('click', () => {
        const input = document.getElementById('instanceNameInput');
        const errEl = document.getElementById('instanceNameError');
        const val = (input.value || '').trim();
        if (!val) {
          errEl.textContent = '名称不能为空';
          errEl.style.display = 'block';
          return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(val)) {
          errEl.textContent = '只允许英文、数字、下划线、连字符';
          errEl.style.display = 'block';
          return;
        }
        errEl.style.display = 'none';
        document.getElementById('createInstanceModal').style.display = 'none';
        send('createInstance', { name: val });
      });
      /* Enter 快捷键 */
      document.getElementById('instanceNameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { document.getElementById('createInstanceOk').click(); }
      });

      /* 设置变更 */
      const settingMap = {
        'settAutoSwitch': 'autoSwitchEnabled',
        'settSilent': 'autoSwitchSilent',
        'settAutoResetMachineId': 'autoResetMachineIdOnAutoSwitch',
        'settAutoRefresh': 'balanceAutoRefresh',
        'settStatusBar': 'statusBarEnabled',
        'settUnlimitedConcurrent': 'unlimitedConcurrent'
      };
      Object.entries(settingMap).forEach(([elId, key]) => {
        document.getElementById(elId).addEventListener('change', (e) => {
          const obj = {}; obj[key] = e.target.checked;
          send('updateSettings', obj);
        });
      });

      document.getElementById('settThreshold').addEventListener('input', (e) => {
        document.getElementById('thresholdValue').textContent = e.target.value + '%';
      });
      document.getElementById('settThreshold').addEventListener('change', (e) => {
        send('updateSettings', { autoSwitchThreshold: parseInt(e.target.value) });
      });
      document.getElementById('settInterval').addEventListener('change', (e) => {
        send('updateSettings', { balanceRefreshInterval: parseInt(e.target.value) });
      });
      /* 并发上限: 1-20 范围内, clamp 后发给后端 */
      document.getElementById('settConcurrentLimit').addEventListener('change', (e) => {
        let v = parseInt(e.target.value);
        if (isNaN(v) || v < 1) { v = 1; }
        if (v > 20) { v = 20; }
        e.target.value = v;
        send('updateSettings', { concurrentLimit: v });
      });

      /* 自动切换订阅类型下拉 */
      document.getElementById('settAutoSwitchPlanType')?.addEventListener('change', (e) => {
        send('updateSettings', { autoSwitchPlanType: e.target.value });
      });

      /* ---------- 工具函数 ---------- */
      function showLoading(text) {
        document.getElementById('loadingText').textContent = text || '处理中...';
        document.getElementById('loadingOverlay').style.display = 'flex';
      }
      function setLoadingText(text) {
        document.getElementById('loadingText').textContent = text;
      }
      function hideLoading() {
        document.getElementById('loadingOverlay').style.display = 'none';
      }
      function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      }
      function escapeAttr(str) {
        return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      /* 初始化完成, 通知扩展: 现在可以推送首屏 state 了 (握手) */
      send('webviewReady');
      } catch (__bootErr) {
        __reportError('init', __bootErr);
      }
    })();
  `;
}