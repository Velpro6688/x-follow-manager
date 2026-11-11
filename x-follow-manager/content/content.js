/**
 * content.js — 编排层
 *
 * 负责：路由识别、面板挂载、扫描调度、选中状态、批量取关状态机、消息响应。
 * 所有判断依赖 core.js；所有渲染依赖 ui.js。
 *
 * 关键安全约束：
 *  - 不猜测关注关系，判不出来就是 unknown，且不进队列；
 *  - 执行前逐条复核页面 / 账号 / 关系 / 按钮；
 *  - 只以页面可观察状态确认成功，绝不以固定延时当作成功；
 *  - 扫描阶段强制显示全部行，避免筛选影响虚拟列表滚动加载。
 */
(function initXfmContent(global) {
  "use strict";

  if (global.__XFM_BOOTSTRAPPED__) return;
  global.__XFM_BOOTSTRAPPED__ = true;

  var C = global.XFMCore;
  var U = global.XFMUI;
  var T = function (key, vars) { return global.XFMI18N ? global.XFMI18N.t(key, vars) : key; };
  if (global.XFMI18N) global.XFMI18N.setLanguage("auto");
  var D = global.XFMDebug;
  if (!C || !U) return;

  function debugLog(tag, data) {
    if (D && typeof D.log === "function") D.log(tag, data);
  }

  /* ------------------------------------------------------------------ */
  /* 常量与状态                                                          */
  /* ------------------------------------------------------------------ */

  var VERSION = "1.0.0";
  var STORAGE_KEY = "xfm.settings.v1";
  var PROGRESS_KEY = "xfm.scan.progress.v1";
  var PROGRESS_SAVE_INTERVAL_MS = 5000; // 进度保存节流：后台/前台都不每扫一人写一次
  var PROGRESS_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 超过一周的未完成进度不再提示恢复
  var ROUTE_POLL_MS = 400;
  var WATCHDOG_MS = 2000;
  var SCAN_IDLE_ROUNDS = 4;        // 连续多少轮「无新增 + 到底 + 无加载」判定为到底（仅前台）
  var SCAN_STEP_RATIO = 1.0;       // 1 屏：兼顾速度与完整，再大会在弱网下漏行
  var SCAN_SETTLE_FAST_MS = 620;   // 普通轮次最多等多久（有新增就提前继续）
  var SCAN_SETTLE_BOTTOM_MS = 1200; // 到底时留给网络加载的时间
  var SCAN_POLL_STEP_MS = 50;      // 等待期间的检测间隔
  var SCAN_BG_RETRY_MS = 8000;     // 后台加载受限时的低频重试间隔
  var SCAN_BG_RENDER_MS = 5000;    // 后台渲染节流：提示变化至少隔这么久才写一次 DOM
  var SCAN_MAX_ROUNDS = 900;
  var UNFOLLOW_CONFIRM_WAIT_MS = 2200;
  var UNFOLLOW_RESULT_WAIT_MS = 8000;
  var UNFOLLOW_CONFIRM_TEXT = /^(Unfollow|取消关注|取消關注|取消跟隨|取消追蹤|取消追踪|停止跟隨)$/i;
  var SEEK_GRACE_MS = 800;         // 用户滚动后多久内不发起程序化定位滚动
  var SEEK_STEP_RATIO = 0.8;       // 渐进搜索每步滚动 = 0.8 视口
  var SEEK_SETTLE_MS = 420;        // 渐进滚动后等待渲染
  var SEEK_JUMP_SETTLE_MS = 520;   // 估算跳转后等待渲染
  var SEEK_STALL_ROUNDS = 5;       // 连续多少轮滚不动就放弃当前目标
  var SEEK_TIME_BUDGET_MS = 40000;  // 单个目标的定位时间上限（45 秒内必然给结论）
  var ANCHOR_TTL_MS = 1200;        // 锚点补偿的有效期
  var ROW_HEIGHT_MAX_SAMPLES = 40;

  var state = {
    phase: "idle",
    mode: "cleanup",     // cleanup=关注页清理单向关注；reply=粉丝页回关
    owner: null,
    selfHandle: null,
    rows: new Map(),
    order: [],
    selected: new Set(),
    excluded: new Set(),
    filter: "one-way",
    quantity: 50,
    batchLimit: 50,
    strictMode: true,
    collapsed: false,
    excludeMode: false,
    debug: false,
    notice: "",
    hint: "",
    warning: "",
    scan: {
      active: false,
      abort: false,
      complete: false,
      userPaused: false,   // 用户手动暂停：切窗口/回前台都不会改变它
      hidden: false,       // 页面当前不可见（后台继续扫描，速度可能降低）
      bgLimited: false,    // 后台加载受限：连续无新增时不再滚动，等回前台复核
      pendingRecheck: false, // 回到前台 / 继续扫描时要求重新评估空闲与加载状态
      stopReason: "",
      error: "",
      skippedRows: 0,
      rounds: 0,
      startedAt: 0,
      integrity: null
    },
    run: {
      active: false,
      abort: false,
      total: 0,
      done: 0,
      groups: null,
      current: "",
      seeking: false,      // true = 正在定位目标（尚未点击任何按钮）
      seekAttempt: 0,      // 当前目标的第几次定位动作
      waiting: false       // true = 单账号处理超过 3s 仍无进展
    },
    mountedPath: "",
    uiMounted: false,
    savedProgress: null,
    scheduledRun: null   // 命中当前页面的未完成扫描进度（刷新后提示恢复用）
  };

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // 用户手动滚动的时间戳：扫描时一旦发现用户在滚，就先让出控制权，避免和用户抢滚动条
  var lastUserScrollAt = 0;
  var userScrollVersion = 0;
  function markUserScroll() { lastUserScrollAt = Date.now(); userScrollVersion += 1; }
  /** 用户是否在最近 ms 毫秒内滚动过（宽限期内禁止程序化定位滚动） */
  function recentUserScroll(ms) { return Date.now() - lastUserScrollAt < ms; }
  // 键盘滚动（空格/方向键等）不产生 wheel/touchmove，也要计入，否则会被 preserveScroll 拉回去
  var SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"];
  function markUserScrollKey(event) {
    if (SCROLL_KEYS.indexOf(event.key) !== -1) markUserScroll();
  }

  function nowLabel() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
  }

  /* ------------------------------------------------------------------ */
  /* 设置持久化（仅设置，不含任何账号数据）                                */
  /* ------------------------------------------------------------------ */

  function hasChromeStorage() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  function applyDebugSetting() {
    if (D && typeof D.setSettingsEnabled === "function") D.setSettingsEnabled(state.debug);
  }

  async function loadSettings() {
    applyDebugSetting();
    if (!hasChromeStorage()) return;
    try {
      var data = await chrome.storage.local.get(STORAGE_KEY);
      var saved = data && data[STORAGE_KEY];
      if (!saved) return;
      if (Number.isFinite(saved.batchLimit)) state.batchLimit = C.sanitizeBatchLimit(saved.batchLimit);
      if (Number.isFinite(saved.quantity)) state.quantity = C.sanitizeCount(saved.quantity, 50);
      if (typeof saved.strictMode === "boolean") state.strictMode = saved.strictMode;
      if (saved.filter === "all" || saved.filter === "one-way") state.filter = saved.filter;
      if (typeof saved.collapsed === "boolean") state.collapsed = saved.collapsed;
      if (typeof saved.language === "string" && global.XFMI18N) global.XFMI18N.setLanguage(saved.language);
      if (typeof saved.debug === "boolean") state.debug = saved.debug;
      if (Array.isArray(saved.excluded)) {
        state.excluded = new Set(saved.excluded.filter(function (h) { return typeof h === "string" && h; }));
      }
      lastSyncedExcluded = Array.from(state.excluded);
    } catch (err) { /* 读取失败沿用默认值 */ }
    applyDebugSetting();
  }

  // 本页上次与磁盘同步的排除名单快照：保存时用它做三方合并，
  // 避免多标签页场景下用过期副本整份覆盖、丢掉别的标签页刚加的保护项
  var lastSyncedExcluded = [];

  function excludedKey(arr) {
    return arr.slice().sort().join("\n");
  }

  var saveTimer = 0;
  function saveSettings() {
    if (!hasChromeStorage()) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      (async function () {
        try {
          if (chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
            var base = lastSyncedExcluded.slice();
            var ours = Array.from(state.excluded);
            var result = await chrome.runtime.sendMessage({
              type: "XFM_COORD_SETTINGS",
              patch: { batchLimit: state.batchLimit, quantity: state.quantity, strictMode: state.strictMode,
                filter: state.filter, collapsed: state.collapsed, debug: state.debug },
              excluded: { base: base, ours: ours }
            });
            if (!result || !result.ok) throw new Error("设置保存失败");
            state.excluded = new Set(C.mergeExcluded(ours, Array.from(state.excluded), result.settings.excluded));
            lastSyncedExcluded = result.settings.excluded.slice();
            return;
          }
          // 先读磁盘最新名单，再以快照为基准做三方合并；直接整份覆盖会
          // 把其他标签页在「本页上次读取之后」新增的排除项抹掉
          var disk = await chrome.storage.local.get(STORAGE_KEY);
          var saved = disk && disk[STORAGE_KEY];
          var theirs = saved && Array.isArray(saved.excluded) ? saved.excluded : [];
          var merged = C.mergeExcluded(lastSyncedExcluded, Array.from(state.excluded), theirs);
          state.excluded = new Set(merged);
          lastSyncedExcluded = merged;
          var payload = {};
          payload[STORAGE_KEY] = {
            batchLimit: state.batchLimit,
            quantity: state.quantity,
            strictMode: state.strictMode,
            filter: state.filter,
            collapsed: state.collapsed,
            debug: state.debug,
            excluded: merged.slice(0, 5000)
          };
          await chrome.storage.local.set(payload);
        } catch (err) { U.toast("设置保存失败，请重试"); }
      })();
    }, 200);
  }

  /**
   * 监听其他标签页 / 弹窗对设置的修改，保持本页内存副本最新。
   * 排除名单用三方合并（本页可能有未落盘的新增/恢复），其余键直接采用最新值。
   */
  function registerStorageSync() {
    if (!hasChromeStorage() || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      var next = changes[STORAGE_KEY].newValue;
      if (!next) return;

      var externalExcluded = Array.isArray(next.excluded) ? next.excluded : [];
      var isExternal = excludedKey(externalExcluded) !== excludedKey(lastSyncedExcluded);
      var excludedChanged = false;
      if (isExternal) {
        var merged = C.mergeExcluded(lastSyncedExcluded, Array.from(state.excluded), externalExcluded);
        excludedChanged = excludedKey(Array.from(state.excluded)) !== excludedKey(merged);
        state.excluded = new Set(merged);
        lastSyncedExcluded = externalExcluded.slice();
      }

      if (Number.isFinite(next.batchLimit)) state.batchLimit = C.sanitizeBatchLimit(next.batchLimit);
      if (Number.isFinite(next.quantity)) state.quantity = C.sanitizeCount(next.quantity, 50);
      if (typeof next.strictMode === "boolean") state.strictMode = next.strictMode;
      if (next.filter === "all" || next.filter === "one-way") state.filter = next.filter;
      if (typeof next.collapsed === "boolean") state.collapsed = next.collapsed;
      if (typeof next.language === "string" && global.XFMI18N) { global.XFMI18N.setLanguage(next.language); if (U.applyLanguage) U.applyLanguage(); }
      if (typeof next.debug === "boolean") state.debug = next.debug;
      applyDebugSetting();

      if (excludedChanged) {
        syncCheckboxes();
      }
      render();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 页面探测                                                            */
  /* ------------------------------------------------------------------ */

  /** 当前模式的候选关系：清理=单向关注，回关=待回关 */
  function candidateRel() {
    return state.mode === C.MODE.REPLY ? C.REL.PENDING : C.REL.ONE_WAY;
  }

  /** 按当前模式读取一行 */
  function readCell(cell) {
    return state.mode === C.MODE.REPLY ? C.readFollowerCell(cell) : C.readUserCell(cell);
  }

  /**
   * 定时周期内实际生效的排除集合：快照 ∪ 实时值。
   * 只允许“更严格”：运行中新增的排除立即生效，运行中取消排除不影响本周期。
   */
  function scheduledExcludedUnion() {
    var sr = state.scheduledRun;
    if (!sr || !sr.active) return new Set(state.excluded);
    return new Set(C.mergeRunExcluded(
      Array.from(sr.excludedSnapshot || []),
      Array.from(state.excluded),
      state.mode === C.MODE.REPLY
    ));
  }

  function runExcludedSet(ignoreExcluded) {
    if (ignoreExcluded) return null;
    if (state.scheduledRun && state.scheduledRun.active) return scheduledExcludedUnion();
    return state.excluded;
  }

  function isRunExcluded(handle) {
    if (state.run && state.run.ignoreExcluded) return false;
    var set = (state.scheduledRun && state.scheduledRun.active) ? scheduledExcludedUnion() : state.excluded;
    return set.has(handle);
  }

  /** 严格模式同样只允许收紧：快照开启或运行中开启都生效 */
  function effectiveRunStrict() {
    if (state.scheduledRun && state.scheduledRun.active) {
      return C.strictModeForRun(state.scheduledRun.strictModeSnapshot, state.strictMode);
    }
    return state.strictMode;
  }

  /** 当前页面属于哪种模式；不是列表页返回 null */
  function detectPage() {
    var following = C.parseFollowingPath(location.pathname);
    if (following) return { mode: C.MODE.CLEANUP, handle: following.handle };
    var followers = C.parseFollowersPath(location.pathname);
    if (followers) return { mode: C.MODE.REPLY, handle: followers.handle };
    return null;
  }

  function readSelfHandle() {
    var selectors = [
      'a[data-testid="AppTabBar_Profile_Link"]',
      'a[data-testid="SideNav_AccountSwitcher_Button"]',
      '[data-testid="SideNav_AccountSwitcher_Button"] a[href^="/"]'
    ];
    for (var i = 0; i < selectors.length; i += 1) {
      var el = document.querySelector(selectors[i]);
      if (!el) continue;
      var handle = C.handleFromHref(el.getAttribute("href"));
      if (handle) return handle;
    }
    return null;
  }

  /**
   * 校验当前页面是否还是任务启动时的那一个。
   * @param {{path:string, mode:string, owner:string|null}} [expected]
   *   任务开始时固化的身份快照。路由切换会先更新 state.mode/state.owner，
   *   所以运行中的校验必须与快照比较，而不是与可变的全局状态比较，
   *   否则旧队列会在新列表上通过校验、继续执行。
   */
  function verifyPage(expected) {
    var page = detectPage();
    if (!page) return { ok: false, reason: "当前页面不是关注或粉丝列表" };
    if (expected && location.pathname !== expected.path) {
      return { ok: false, reason: "页面已切换，任务中止" };
    }
    if (page.mode !== state.mode) return { ok: false, reason: "页面模式已变化" };
    if (page.handle && state.owner && page.handle !== state.owner) {
      return { ok: false, reason: "列表已切换到其他账号" };
    }
    var self = readSelfHandle();
    if (self && page.handle && self !== page.handle) {
      return { ok: false, reason: "当前登录账号是 @" + self + "，与列表主人 @" + page.handle + " 不一致" };
    }
    return { ok: true };
  }

  /**
   * 批量执行用的严格校验：在 readSelfHandle 失败或列表地址只有数字 ID
   * （/i/user/<id>/following）时，无法证明列表属于当前登录账号，
   * 必须阻止批量操作，宁可不执行也不能在别人的列表上动手。
   */
  function verifyExecutionAllowed(expected) {
    var base = verifyPage(expected);
    if (!base.ok) return base;
    var page = detectPage();
    var self = readSelfHandle();
    if (!page || !page.handle || !self) {
      return { ok: false, reason: "无法核实列表主人与登录账号一致，批量操作已锁定" };
    }
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* 执行互斥锁：同一时刻只允许一个标签页执行批量操作                       */
  /* ------------------------------------------------------------------ */

  var RUN_LOCK_KEY = "xfm.run.lock.v1";
  var RUN_LOCK_STALE_MS = 6000;
  var runLock = null;   // { runId, timer }

  /** 抢占执行锁。锁被其他存活标签页持有时返回 busy；存储异常时放行（不阻塞主功能）。 */
  function acquireRunLock() {
    if (!hasChromeStorage()) return Promise.resolve({ ok: true });
    var runId = "run-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);
    return (async function () {
      try {
        if (chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
          var acquired = await chrome.runtime.sendMessage({ type: "XFM_COORD_ACQUIRE", runId: runId, path: location.pathname,
            scheduleRunId: state.scheduledRun && state.scheduledRun.active ? state.scheduledRun.runId : null });
          if (!acquired || !acquired.ok) return acquired || { ok: false, reason: "无法确认执行锁" };
          runLock = { runId: runId, timer: window.setInterval(function () {
            chrome.runtime.sendMessage({ type: "XFM_COORD_BEAT", runId: runId }).then(function (result) {
              if (!result || !result.ok) state.run.abort = true;
            }).catch(function () { state.run.abort = true; });
          }, 2000) };
          return { ok: true };
        }
        var data = await chrome.storage.local.get(RUN_LOCK_KEY);
        var existing = data && data[RUN_LOCK_KEY];
        if (existing && existing.runId && Date.now() - (existing.heartbeat || 0) < RUN_LOCK_STALE_MS) {
          return { ok: false, reason: "另一个标签页正在执行（" + (existing.path || "其他列表") + "），请先等它结束" };
        }
        var lock = { runId: runId, path: location.pathname, owner: state.owner || "", at: Date.now(), heartbeat: Date.now() };
        var payload = {};
        payload[RUN_LOCK_KEY] = lock;
        await chrome.storage.local.set(payload);
        // storage 没有原子 CAS：写完复读确认没有被并发抢占
        var check = await chrome.storage.local.get(RUN_LOCK_KEY);
        if (check && check[RUN_LOCK_KEY] && check[RUN_LOCK_KEY].runId !== runId) {
          return { ok: false, reason: "另一个标签页正在执行，请先等它结束" };
        }
        runLock = {
          runId: runId,
          timer: window.setInterval(function () {
            if (!runLock) return;
            lock.heartbeat = Date.now();
            try {
              var beat = {};
              beat[RUN_LOCK_KEY] = lock;
              chrome.storage.local.set(beat);
            } catch (err) { /* 心跳失败不影响执行 */ }
          }, 2000)
        };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: "无法确认执行锁，请刷新后重试" };
      }
    })();
  }

  /** 释放执行锁（只清自己持有的；崩溃标签页的锁靠心跳过期被接管）。 */
  function releaseRunLock() {
    if (!runLock) return;
    window.clearInterval(runLock.timer);
    var runId = runLock.runId;
    runLock = null;
    if (!hasChromeStorage()) return;
    if (chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      void chrome.runtime.sendMessage({ type: "XFM_COORD_RELEASE", runId: runId }).catch(function () {});
      return;
    }
    (async function () {
      try {
        var data = await chrome.storage.local.get(RUN_LOCK_KEY);
        var existing = data && data[RUN_LOCK_KEY];
        if (existing && existing.runId === runId) {
          await chrome.storage.local.remove(RUN_LOCK_KEY);
        }
      } catch (err) { /* 忽略 */ }
    })();
  }

  async function checkRunLock() {
    if (!runLock) return !hasChromeStorage();
    if (!chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return true;
    try {
      var result = await chrome.runtime.sendMessage({ type: "XFM_COORD_BEAT", runId: runLock.runId });
      return !!(result && result.ok);
    } catch (err) { return false; }
  }

  /* ------------------------------------------------------------------ */
  /* 定位：从结果窗口跳到列表里的某一行                                    */
  /* ------------------------------------------------------------------ */

  var locateFlashTimer = 0;

  function ensureLocateStyle() {
    var styleId = "xfm-locate-style";
    if (document.getElementById(styleId)) return;
    var style = document.createElement("style");
    style.id = styleId;
    style.textContent = '[data-xfm-locate="1"]{outline:2px solid #1d9bf0 !important;outline-offset:-2px !important;}';
    (document.head || document.documentElement).appendChild(style);
  }

  function flashLocate(cell) {
    ensureLocateStyle();
    var rowEl = cell.closest ? (cell.closest('[data-testid="cellInnerDiv"]') || cell) : cell;
    if (!rowEl) return;
    window.clearTimeout(locateFlashTimer);
    rowEl.setAttribute("data-xfm-locate", "1");
    locateFlashTimer = window.setTimeout(function () {
      try { rowEl.removeAttribute("data-xfm-locate"); } catch (err) { /* 行可能已被移除 */ }
    }, 2600);
  }

  /** 当前视口最上方可见行的「快照序号 + 文档坐标」，作为定位跳跃的基准 */
  function visibleIndexReference() {
    var cells = document.querySelectorAll(C.SELECTORS.userCell);
    var scrollerTop = getScrollTop();
    var originTop = getViewportOriginTop();
    var best = null;
    for (var i = 0; i < cells.length; i += 1) {
      var handle = C.extractHandle(cells[i]);
      if (!handle) continue;
      var idx = state.order.indexOf(handle);
      if (idx === -1) continue;
      var rect = cells[i].getBoundingClientRect();
      if (rect.bottom < originTop + 10) continue;
      var y = Math.round(rect.top + scrollerTop - originTop);
      if (!best || idx < best.idx) best = { idx: idx, y: y };
    }
    return best;
  }

  /**
   * 在页面里找到某个账号并高亮。行在 DOM 里直接滚过去；
   * 被虚拟列表卸载时按「快照序号差 × 局部行高」估算位置反复跳，最多 12 次。
   */
  async function locateHandle(handle) {
    if (!handle || !state.rows.has(handle)) {
      U.toast("该账号已不在本页候选名单里");
      return false;
    }
    if (state.scan.active || state.run.active) {
      U.toast("扫描或执行中无法定位");
      return false;
    }
    for (var attempt = 0; attempt < 12; attempt += 1) {
      var cell = findCellByHandle(handle);
      if (cell) {
        cell.scrollIntoView({ block: "center" });
        flashLocate(cell);
        return true;
      }
      var idx = state.order.indexOf(handle);
      if (idx === -1) break;
      var density = C.pickRowHeight(rowHeightSamples, 84);
      var ref = visibleIndexReference();
      if (ref) {
        scrollToY(Math.max(0, ref.y + (idx - ref.idx) * density - getViewportHeight() / 2));
      } else {
        scrollToY(Math.max(0, idx * density - getViewportHeight() / 2));
      }
      await sleep(320);
    }
    U.toast("没有在页面里找到这一行，可能已被 X 移出渲染区，请手动滚动查找");
    return false;
  }

  function getScroller() {
    var column = document.querySelector(C.SELECTORS.primaryColumn);
    var node = column;
    while (node && node !== document.body) {
      var cs = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 20) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function getScrollTop() {
    var sc = getScroller();
    return sc === document.scrollingElement ? (window.scrollY || sc.scrollTop || 0) : sc.scrollTop;
  }

  function getScrollHeight() {
    var sc = getScroller();
    return sc.scrollHeight;
  }

  function getViewportHeight() {
    var sc = getScroller();
    return sc === document.scrollingElement ? window.innerHeight : sc.clientHeight;
  }

  /** 滚动容器可视区顶部在视口中的 y 坐标（window 滚动时为 0） */
  function getViewportOriginTop() {
    var sc = getScroller();
    if (sc === document.scrollingElement) return 0;
    return sc.getBoundingClientRect().top;
  }


  /** 按 handle 在整列里重查目标行（虚拟列表复用节点后，原引用不可靠） */
  function findCellByHandle(handle) {
    if (!handle) return null;
    var column = document.querySelector(C.SELECTORS.primaryColumn) || document;
    var cells = column.querySelectorAll(C.SELECTORS.userCell);
    for (var i = 0; i < cells.length; i += 1) {
      if (C.extractHandle(cells[i]) === handle) return cells[i];
    }
    return null;
  }

  /**
   * 当前视口里第一个可见的用户行，用作滚动锚点。
   * 只存节点引用在虚拟列表下必然失效，因此同时记下 handle 与时间戳。
   */
  function visibleAnchor() {
    var cells = document.querySelectorAll(C.SELECTORS.userCell);
    var originTop = getViewportOriginTop();
    for (var i = 0; i < cells.length; i += 1) {
      var r = cells[i].getBoundingClientRect();
      if (r.bottom > originTop + 40) {
        return {
          handle: C.extractHandle(cells[i]),
          el: cells[i],
          top: r.top,
          at: Date.now()
        };
      }
    }
    return null;
  }

  /**
   * 行被移除后列表变矮，用锚点把视口补回来，避免页面跳动。
   * 三重约束：只在 1200ms 内有效、用户正在滚时不补、位移过大不补。
   */
  function restoreAnchor(anchor) {
    if (!anchor || !anchor.at) return;
    if (Date.now() - anchor.at > ANCHOR_TTL_MS) return;
    if (recentUserScroll(SEEK_GRACE_MS)) return;

    // 优先按 handle 重查：节点复用/卸载后 el 已经指向别的账号
    var cell = anchor.handle ? findCellByHandle(anchor.handle) : null;
    if (!cell && anchor.el && anchor.el.isConnected) cell = anchor.el;
    // 行确实已消失：浏览器可能已原生补偿，此时再补反而会跳
    if (!cell) return;

    var delta = cell.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 2 && Math.abs(delta) < 240) {
      debugLog("scroll.anchor", { handle: anchor.handle, delta: Math.round(delta) });
      scrollByY(delta);
    }
  }

  /** 正在处理的行加高亮，让用户在页面上能一眼看到 */
  function markBusy(cell) {
    var row = cell && cell.closest ? cell.closest('[data-testid="cellInnerDiv"]') : null;
    if (!row && cell) row = cell.parentElement;
    if (row) row.setAttribute("data-xfm-busy", "1");
  }

  function clearBusy() {
    var marked = document.querySelectorAll("[data-xfm-busy='1']");
    for (var i = 0; i < marked.length; i += 1) marked[i].removeAttribute("data-xfm-busy");
  }

  function atBottom() {
    var sc = getScroller();
    if (sc === document.scrollingElement) {
      var y = window.scrollY || sc.scrollTop || 0;
      return y + window.innerHeight >= sc.scrollHeight - 12;
    }
    return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 12;
  }

  function atTop() {
    return getScrollTop() <= 2;
  }

  var programmaticScrollAt = 0;

  function scrollToY(y) {
    var sc = getScroller();
    var target = Math.max(0, Math.round(y));
    programmaticScrollAt = Date.now();
    if (sc === document.scrollingElement) window.scrollTo(0, target);
    else sc.scrollTop = target;
    debugLog("scroll.to", { y: target, got: Math.round(getScrollTop()) });
  }

  function scrollByY(delta) {
    scrollToY(getScrollTop() + delta);
  }

  /**
   * 执行一次会改动列表布局的操作，并保持用户的滚动位置不动。
   * 面板提示增减、X 虚拟列表对 DOM 变化的重排都可能让页面跳回顶部；
   * 在改动前后各校正一次，用户一旦开始手动滚动就立刻放手。
   */
  var scrollPreserveId = 0;
  function preserveScroll(apply) {
    var id = ++scrollPreserveId;
    var path = location.pathname;
    var before = getScrollTop();
    var beforeUserScroll = userScrollVersion;
    apply();
    var restore = function () {
      if (id !== scrollPreserveId || path !== location.pathname || state.scan.active || state.run.active) return;
      if (userScrollVersion !== beforeUserScroll) return;
      if (Math.abs(getScrollTop() - before) > 1) scrollToY(before);
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(function () { restore(); requestAnimationFrame(restore); });
    }
    window.setTimeout(restore, 150);
    window.setTimeout(restore, 600);
  }

  /* ------------------------------------------------------------------ */
  /* 面板挂载                                                            */
  /* ------------------------------------------------------------------ */

  function findPanelAnchor() {
    var column = document.querySelector(C.SELECTORS.primaryColumn);
    if (!column) return null;

    var tablist = column.querySelector('[role="tablist"]');
    if (tablist) {
      // 找到包含 "正在关注" 的 tablist，避免挂到错误的位置
      var anchors = tablist.querySelectorAll("a[role='tab'], a[href]");
      var hit = false;
      for (var i = 0; i < anchors.length; i += 1) {
        var href = anchors[i].getAttribute("href") || "";
        var text = (anchors[i].textContent || "").trim();
        if (/\/following\/?$/.test(href) || /^(正在关注|Following|正在跟隨)$/.test(text)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        // 向上找 sticky 容器，把面板放在它后面
        var sticky = tablist;
        var node = tablist;
        for (var d = 0; d < 10 && node && node !== column; d += 1) {
          var pos = window.getComputedStyle(node).position;
          if (pos === "sticky" || pos === "-webkit-sticky") sticky = node;
          node = node.parentElement;
        }
        return sticky;
      }
    }

    var section = column.querySelector("section");
    if (section && section.previousElementSibling) return section.previousElementSibling;
    return null;
  }

  function resolveStickyTop() {
    var tablist = document.querySelector('[role="tablist"]');
    if (!tablist) return 0;
    var node = tablist;
    var column = document.querySelector(C.SELECTORS.primaryColumn);
    var stickyEl = null;
    for (var d = 0; d < 10 && node && node !== column; d += 1) {
      var pos = window.getComputedStyle(node).position;
      if (pos === "sticky" || pos === "-webkit-sticky") { stickyEl = node; break; }
      node = node.parentElement;
    }
    if (!stickyEl) return 0;
    var top = parseFloat(window.getComputedStyle(stickyEl).top) || 0;
    return top + stickyEl.offsetHeight;
  }

  function mountUi() {
    if (U.isMounted()) {
      state.uiMounted = true;
      return true;
    }
    var anchor = findPanelAnchor();
    if (!anchor || !anchor.parentElement) return false;

    U.mountPanel(anchor, {
      onAction: handleAction,
      onFilter: function (mode) { setFilter(mode); },
      onQuantityChange: function (value) {
        state.quantity = C.sanitizeCount(value, 50);
        saveSettings();
        render();
      }
    });

    var host = U.getHost();
    if (host) {
      host.style.position = "sticky";
      host.style.top = resolveStickyTop() + "px";
      host.style.zIndex = "5";
      host.style.background = "var(--xfm-bg, #fff)";
    }
    state.uiMounted = true;
    if (host) host.setAttribute("data-xfm-version", VERSION);
    render();
    // 只在每次页面加载后提示一次，便于确认扩展是否已更新
    if (!state.bootNoticeShown) {
      state.bootNoticeShown = true;
      U.toast("关注管理台 v" + VERSION + " 已加载");
    }
    return true;
  }

  function unmountUi() {
    U.removeCheckboxes(document);
    U.unmountPanel();
    state.uiMounted = false;
    state.mountedPath = "";
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function currentRows() {
    return C.rowsInOrder(state.rows, state.order);
  }

  function computeRenderState() {
    var rows = currentRows();
    var stats = C.countStats(rows, state.selected, candidateRel());
    var integrity = C.evaluateIntegrity(rows, { strict: state.strictMode, candidateRel: candidateRel() });
    var busy = state.scan.active || state.run.active;

    // 身份无法核实（列表地址只有数字 ID、读不到登录用户名等）时锁定批量执行；
    // 扫描是只读的，不受影响。锁定原因直接展示，避免用户以为按钮坏了。
    var identityCheck = verifyExecutionAllowed();
    var identityLocked = !busy && !identityCheck.ok && identityCheck.reason !== "当前页面不是关注或粉丝列表";

    var phaseLabel = T("state.idle");
    var phaseTone = "";
    if (state.phase === "scanning") {
      phaseLabel = state.scan.userPaused ? T("state.pausedN", { n: stats.total }) : T("state.scanningN", { n: stats.total });
      phaseTone = "run";
    }
    else if (state.phase === "scanned") { phaseLabel = T("state.scanned"); phaseTone = "ok"; }
    else if (state.phase === "partial") { phaseLabel = "结果不完整"; phaseTone = "bad"; }
    else if (state.phase === "failed") { phaseLabel = "扫描失败"; phaseTone = "bad"; }
    else if (state.phase === "running") { phaseLabel = "执行中"; phaseTone = "run"; }
    else if (state.phase === "done") { phaseLabel = "本批已结束"; phaseTone = "ok"; }

    var warning = state.warning;
    if (!warning && (state.phase === "failed" || state.phase === "partial")) {
      warning = state.notice || "";
    }
    if (!warning && integrity.warnings.length > 0) {
      warning = integrity.warnings[0].message;
    }
    if (!warning && identityLocked) {
      warning = identityCheck.reason;
    }

    var canSelect = !busy && stats.oneWay > 0;
    // 扫描失败说明页面可能已异常，禁止执行；用户主动停止（partial）仍允许按已确认候选执行
    var canUnfollow = !busy && stats.selected > 0 && !integrity.blocked && state.phase !== "failed" && !identityLocked;

    var excludedCount = 0;
    for (var ei = 0; ei < rows.length; ei += 1) {
      if (state.excluded.has(rows[ei].handle)) excludedCount += 1;
    }

    var scanLabel = T("panel.scan");
    var scanAccent = true;
    if (state.phase === "scanned") { scanLabel = T("panel.rescan"); scanAccent = false; }
    else if (state.phase === "partial" && state.rows.size > 0) scanLabel = T("panel.resume");

    // 视图状态：扫描 / 执行 时收起工具栏，换成一条进度行，避免两套按钮抢注意力
    var view = "idle";
    if (state.scan.active) view = "scan";
    else if (state.run.active) view = "run";
    else if (state.phase === "scanned") view = "done";
    else if (state.phase === "failed" || state.phase === "partial") view = "error";

    var runbar = null;
    var hideTools = false;
    if (state.scan.active) {
      hideTools = true;
      var elapsed = state.scan.startedAt ? Math.max(0, Math.round((Date.now() - state.scan.startedAt) / 1000)) : 0;
      var runText;
      if (state.scan.userPaused) {
        runText = "已暂停 · 已扫描 " + stats.total + " 人";
      } else if (state.scan.bgLimited) {
        runText = "后台加载受限，切回 X 可继续 · 已保存 " + stats.total + " 人";
      } else if (document.hidden) {
        runText = "后台扫描中，速度可能降低 · 已扫描 " + stats.total + " 人";
      } else {
        runText = "已扫描 " + stats.total + (elapsed >= 2 ? " · " + elapsed + "s" : "");
      }
      runbar = {
        text: runText,
        mode: "indeterminate",
        percent: 0,
        canPause: true   // 扫描中显示「暂停/继续」按钮
      };
    } else if (state.run.active) {
      hideTools = true;
      var total = Math.max(1, state.run.total || 0);
      var curTag = state.run.current ? " @" + state.run.current : "";
      var runText;
      if (state.run.seeking) {
        runText = "定位中" + curTag + "（第 " + Math.max(1, state.run.seekAttempt || 1) + " 次）";
      } else if (state.run.waiting) {
        runText = "等待页面响应…" + curTag;
      } else {
        runText = "处理中" + curTag + "（" + state.run.done + " / " + total + "）";
      }
      runbar = {
        text: runText,
        mode: "run",
        percent: Math.round((state.run.done / total) * 100)
      };
    }

    var hideScan = state.scan.active || state.run.active;
    var hideUnfollow = state.scan.active || state.run.active;

    var progress = null;
    // 扫描时 X 不提供总数，不伪造百分比进度；用「已扫描 N」+ 脉动状态点表达进行中
    if (state.run.active) {
      progress = { done: state.run.done, total: state.run.total };
    }

    var overLimit = null;
    if (stats.selected > state.batchLimit) {
      overLimit = {
        selected: stats.selected,
        limit: state.batchLimit,
        deferred: stats.selected - state.batchLimit
      };
    }

    return {
      total: stats.total,
      oneWay: stats.oneWay,
      mutual: stats.mutual,
      unknown: stats.unknown,
      selected: stats.selected,
      excluded: excludedCount,
      batchLimit: state.batchLimit,
      quantity: state.quantity,
      filter: state.filter,
      busy: busy,
      phaseLabel: phaseLabel,
      phaseTone: phaseTone,
      status: state.notice || defaultStatus(),
      notice: state.hint || "",
      warning: warning,
      canSelect: canSelect,
      canUnfollow: canUnfollow,
      identityLockReason: identityLocked ? identityCheck.reason : "",
      scanLabel: scanLabel,
      scanAccent: scanAccent,
      scanActive: !!state.scan.active,
      scanUserPaused: !!state.scan.userPaused,
      savedCount: state.savedProgress && Array.isArray(state.savedProgress.rows)
        ? state.savedProgress.rows.length : 0,
      mode: state.mode,
      collapsed: state.collapsed,
      excludeMode: state.excludeMode,
      overLimit: overLimit,
      view: view,
      hideTools: hideTools,
      hideScan: hideScan,
      hideUnfollow: hideUnfollow,
      runbar: runbar,
      scanDone: state.phase === "scanned" || state.phase === "partial",
      progress: progress
    };
  }

  function defaultStatus() {
    if (state.phase === "idle") return "扫描只读，不会修改任何账号";
    if (state.phase === "scanning") return "正在滚动加载，请勿切换页面";
    if (state.phase === "scanned") return "已到达列表末尾，共 " + state.rows.size + " 个账号";
    if (state.phase === "partial") return state.scan.stopReason || "扫描未完成，结果不完整";
    if (state.phase === "failed") return state.scan.error || "扫描失败";
    if (state.phase === "running") return state.mode === C.MODE.REPLY ? "正在逐条回关，可随时停止" : "正在逐条取消关注，可随时停止";
    if (state.phase === "done") return "本批已结束，详见结果窗口";
    return "";
  }

  function render() {
    if (!U.isMounted()) return;
    var rs = computeRenderState();
    U.updatePanel(rs);

    var host = U.getHost();
    if (host) {
      var theme = U.detectTheme();
      host.setAttribute("data-xfm-theme", theme);
      host.style.background = theme === "dark" ? "#16181c" : "#ffffff";
    }
  }

  /**
   * 临时提示：统一入口，避免多处 setTimeout 互相覆盖导致提示闪一下就消失。
   */
  var tempNoticeTimer = 0;
  function setTempNotice(text, ms) {
    state.hint = text || "";
    render();
    window.clearTimeout(tempNoticeTimer);
    if (!text) return;
    tempNoticeTimer = window.setTimeout(function () {
      state.hint = "";
      render();
    }, ms || 2600);
  }

  /* ------------------------------------------------------------------ */
  /* 复选框同步                                                          */
  /* ------------------------------------------------------------------ */

  /*
   * 扫描快照自动对账。
   * 快照是上次扫描时的关系判定，页面现实会变：用户在 X 上手动取关/回关、
   * 在另一个标签页执行、或上一批执行成功。syncCheckboxes 本来就会读每一行
   * 的实时状态，顺带把「明确可读且与快照不一致」的行修正回来，
   * 统计和复选框不用等重新扫描。
   * 为避开 hydration / 重渲染的瞬时态，同一行需要连续两轮观察到不一致才改。
   */
  var reconcileSeen = new Map();
  function clearReconcileState() {
    reconcileSeen.clear();
  }

  function syncCheckboxes(onlyHandle) {
    if (!U.isMounted()) return;
    // 扫描期间每轮都全量遍历 DOM 会拖慢滚动加载，且此时不允许勾选，直接跳过
    if (state.scan.active) return;

    var column = document.querySelector(C.SELECTORS.primaryColumn) || document;
    var cells = column.querySelectorAll(C.SELECTORS.userCell);
    var reconciled = false;
    var demotedCount = 0;

    for (var i = 0; i < cells.length; i += 1) {
      var cell = cells[i];
      if (onlyHandle && C.extractHandle(cell) !== onlyHandle) continue;
      var rec = readCell(cell);
      if (!rec.handle) {
        U.removeCheckbox(cell);
        continue;
      }
      // 只给「已扫描到」的账号挂复选框；未扫描的行走原生样式
      var stored = state.rows.get(rec.handle);
      if (!stored) {
        U.removeCheckbox(cell);
        continue;
      }

      // ---- 快照对账：实时读数与快照不一致，两轮确认后修正 ----
      if (rec.relation !== C.REL.UNKNOWN && rec.relation !== stored.relation) {
        if (reconcileSeen.get(rec.handle)) {
          reconcileSeen.delete(rec.handle);
          stored.relation = rec.relation;
          stored.reason = "reconciled";
          reconciled = true;
        } else {
          reconcileSeen.set(rec.handle, true);
        }
      } else if (
        state.mode !== C.MODE.REPLY &&
        rec.actionKind === "follow" &&
        stored.relation === C.REL.ONE_WAY
      ) {
        // 关注列表里出现「关注」按钮：该账号已不是「正在关注」
        // （用户手动取关，或上一批已处理过）。清理候选资格随之消失。
        if (reconcileSeen.get(rec.handle)) {
          reconcileSeen.delete(rec.handle);
          state.rows.delete(rec.handle);
          var staleIdx = state.order.indexOf(rec.handle);
          if (staleIdx !== -1) state.order.splice(staleIdx, 1);
          state.selected.delete(rec.handle);
          U.removeCheckbox(cell);
          demotedCount += 1;
          reconciled = true;
          continue;
        }
        reconcileSeen.set(rec.handle, true);
      } else if (reconcileSeen.get(rec.handle)) {
        // 读数回到一致（瞬时态已过去），撤销观察
        reconcileSeen.delete(rec.handle);
      }

      var relation = stored.relation;

      // 扫描中只显示状态，不允许勾选（避免与滚动加载互相干扰）
      var rel = candidateRel();
      var selectable = relation === rel && !state.scan.active && !state.run.active;
      var checked = state.selected.has(rec.handle) && relation === rel;
      var isExcluded = state.excluded.has(rec.handle);
      var canExclude = relation === rel && !state.scan.active && !state.run.active;

      U.ensureCheckbox(cell, {
        handle: rec.handle,
        checked: checked,
        excluded: isExcluded,
        disabled: !selectable,
        armed: state.excludeMode && relation === rel,
        mode: relation === C.REL.MUTUAL ? "mutual" : "candidate",
        title: isExcluded
          ? "已排除，右键或 Alt+点击可恢复"
          : (relation === C.REL.MUTUAL
            ? (state.mode === C.MODE.REPLY ? "你已回关，无需操作" : "对方已关注你，不在清理范围")
            : (relation === rel
              ? "左键选中；右键或 Alt+点击 = 排除（保留这个账号）"
              : "关注关系无法确认，已禁用")),
        onToggle: (function (handle) {
          return function (next) { toggleSelect(handle, next); };
        })(rec.handle),
        onExclude: canExclude ? (function (handle) {
          return function () { toggleExclude(handle); };
        })(rec.handle) : null
      });

      // 筛选标记挂在整行容器上，避免只隐藏内层节点导致虚拟列表高度计算错乱
      var rowEl = cell.closest ? cell.closest('[data-testid="cellInnerDiv"]') : null;
      if (rowEl) {
        rowEl.setAttribute("data-xfm-rel", relation);
        if (isExcluded) rowEl.setAttribute("data-xfm-excluded", "1");
        else rowEl.removeAttribute("data-xfm-excluded");
      }
    }

    // 对账改动了快照 → 统计立即反映，不等下一次 render
    if (reconciled) {
      if (demotedCount > 0 && !state.run.active) {
        setTempNotice("已把 " + demotedCount + " 个不再是「正在关注」的账号移出候选", 3000);
      }
      render();
    }
  }

  function applyFilterToCss() {
    var styleId = "xfm-filter-style";
    var style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      (document.head || document.documentElement).appendChild(style);
    }
    var active = state.filter === "one-way" && !state.scan.active && !state.run.active;
    style.textContent = active
      ? [
        '[data-xfm-rel="mutual"]{opacity:.4;}',
        '[data-xfm-rel="unknown"]{opacity:.65;}'
      ].join("\n")
      : "";
  }

  function setFilter(mode) {
    if (mode !== "one-way" && mode !== "all") return;
    if (state.scan.active || state.run.active) {
      U.toast("执行或扫描期间不能切换筛选");
      render();
      return;
    }
    state.filter = mode;
    saveSettings();
    applyFilterToCss();
    syncCheckboxes();
    render();
  }

  /* ------------------------------------------------------------------ */
  /* 选择                                                                */
  /* ------------------------------------------------------------------ */

  function toggleSelect(handle, next) {
    var row = state.rows.get(handle);
    if (!row || row.relation !== candidateRel()) {
      U.toast("该账号不是可清理的未回关账号");
      syncCheckboxes();
      return;
    }
    if (next) state.selected.add(handle);
    else state.selected.delete(handle);
    preserveScroll(function () { render(); });
  }

  function autoSelect() {
    var rows = currentRows();
    var plan = C.planAutoSelect(rows, state.quantity, state.excluded, candidateRel(), true);
    if (plan.poolSize === 0) {
      U.toast(state.excluded.size > 0 ? "候选都被排除了，先右键取消排除" : "没有可选的未回关账号");
      return;
    }
    state.selected = new Set(plan.picked.map(function (r) { return r.handle; }));
    var skipNote = state.excluded.size > 0 ? "，已跳过 " + state.excluded.size + " 个排除项" : "";
    var orderNote = plan.oldestFirst ? "最早关注的 " : "";
    var whereNote = plan.oldestFirst && plan.shortfall <= 0 ? "；执行时会自动定位到列表后段" : "";
    syncCheckboxes();
    setTempNotice(plan.shortfall > 0
      ? "候选只有 " + plan.poolSize + " 个，已全选" + skipNote
      : "已优先选择" + orderNote + plan.picked.length + " 个" + skipNote + whereNote + "，可继续手动调整", 3600);
  }

  function toggleExclude(handle) {
    var row = state.rows.get(handle);
    if (!row || row.relation !== candidateRel()) return;
    if (state.excluded.has(handle)) {
      state.excluded.delete(handle);
      // 恢复不会自动找回之前的勾选：排除时已顺手取消，这里把预期说清楚
      state.hint = "已恢复 @" + handle + "（如需执行，请重新勾选）";
    } else {
      state.excluded.add(handle);
      // 排除即意味着不清理，顺手取消勾选，避免歧义
      state.selected.delete(handle);
      state.hint = "已排除 @" + handle + "，自动选择和执行都会跳过";
    }
    saveSettings();
    // 右键排除时用户正看着这一行，布局变化不允许把页面拉走
    preserveScroll(function () {
      syncCheckboxes(handle);
      setTempNotice(state.hint, 2800);
    });
  }

  function clearExcluded() {
    var count = state.excluded.size;
    if (count === 0) {
      U.toast("排除名单为空");
      return;
    }
    state.excluded.clear();
    saveSettings();
    syncCheckboxes();
    render();
    U.toast("已清空 " + count + " 个排除项");
  }

  /**
   * 打开名单窗口：搜索、勾选、排除都在这里完成。
   * 页面上的复选框只是快捷入口，名单窗口才是完整视图。
   */
  function openRoster() {
    var rows = currentRows().map(function (row) {
      return {
        handle: row.handle,
        name: row.name || "",
        avatar: row.avatar || "",
        relation: row.relation
      };
    });
    if (rows.length === 0) {
      U.toast("还没有扫描到账号，先扫描一次");
      return;
    }
    U.showRoster({
      mode: state.mode,
      rows: rows,
      selected: Array.from(state.selected),
      excluded: Array.from(state.excluded),
      limit: state.batchLimit,
      onApply: function (next) {
        state.selected = new Set(next.selected);
        state.excluded = new Set(next.excluded);
        saveSettings();
        syncCheckboxes();
        render();
      },
      onClose: function () {
        syncCheckboxes();
        render();
      }
    });
  }

  function clearSelection() {
    state.selected.clear();
    syncCheckboxes();
    setTempNotice("已清空选择", 2000);
  }

  /* ------------------------------------------------------------------ */
  /* 扫描                                                                */
  /* ------------------------------------------------------------------ */

  var rowHeightSamples = [];
  var scannedPositions = new Map();
  var lastRowSampleAt = 0;
  // 恢复扫描时的基线：已保存的账号在「继续往下找新的」时不计为增长，
  // 否则重扫已知区域会被误判为「到底」
  var scanBaseline = new Set();
  var scanFresh = new Set();       // 基线之外新增的账号（增长判定用）
  var lastBgRenderAt = 0;
  var lastProgressSaveAt = 0;
  var progressSaveFailed = false;
  function releaseScanActivity(scanId) {
    if (!scanId || !hasChromeStorage() || !chrome.runtime || !chrome.runtime.sendMessage) return Promise.resolve();
    return chrome.runtime.sendMessage({ type: "XFM_COORD_SCAN_END", scanId: scanId }).catch(function () {});
  }
  var progressStaleWarned = false;   // 「进度已失效」提示每次扫描会话只发一次
  /**
   * 进度操作统一走后台协调服务（background.js 串行队列）：
   * 跨标签页的读-合并-写与清除在同一个协调点按到达顺序处理，
   * 页面内的 Promise 队列无法协调不同标签页（实测会互相覆盖）。
   * 协调服务不可用时提示失败，避免直接写入破坏跨标签页一致性。
   */
  function coordProgress(msg) {
    if (hasChromeStorage() && chrome.runtime && chrome.runtime.sendMessage) {
      return chrome.runtime.sendMessage(msg).then(function (r) {
        if (!r || r.ok !== true) throw new Error((r && r.reason) || "协调服务拒绝");
        return r;
      });
    }
    return Promise.reject(new Error("协调服务不可用"));
  }

  /**
   * 进度隔离键：登录账号 + 名单所属账号 + 列表类型。
   * 名单所属账号拿不到 handle 时（/i/user/<id> 地址）退回用路径区分，
   * 保证不同账号/列表之间不串号。
   */
  function progressId() {
    var page = detectPage();
    if (!page) return null;
    var self = readSelfHandle() || state.selfHandle || "?";
    var ownerPart = page.handle || location.pathname;
    return self + "|" + ownerPart + "|" + page.mode;
  }

  /**
   * 每个身份一个独立存储键：先后扫描不同列表时，
   * 各自的未完成进度互不覆盖（单键会被后扫的列表抹掉前一个）。
   */
  function progressKey() {
    var id = progressId();
    return id ? PROGRESS_KEY + ":" + id : null;
  }

  /**
   * 保存扫描进度（节流：默认 5 秒一次；暂停/停止/收尾时 force 补存）。
   * 只存已扫账号（handle/昵称/头像地址/关系判定）与辅助滚动位置，
   * 不存 Cookie、令牌、页面 HTML 或调试日志。
   */
  async function saveScanProgress(force) {
    if (!hasChromeStorage()) return;
    var scanning = state.scan.active;
    if (!scanning && state.phase !== "partial" && state.phase !== "failed") return;
    if (state.rows.size === 0 && !scanning) return;
    var now = Date.now();
    if (!force && now - lastProgressSaveAt < PROGRESS_SAVE_INTERVAL_MS) return;
    lastProgressSaveAt = now;
    var id = progressId();
    if (!id) return;
    var rows = [];
    for (var i = 0; i < state.order.length; i += 1) {
      var h = state.order[i];
      var rec = state.rows.get(h);
      if (!rec) continue;
      rows.push({ h: h, r: rec.relation || "", n: rec.name || "", a: rec.avatar || "" });
    }
    if (rows.length === 0) return;
    var key = (state.scan && state.scan.progressKey) || progressKey();
    if (!key) return;
    if (key !== progressKey()) {
      // 列表身份已变化：旧任务的进度不得写入新列表
      debugLog("progress.save.skipIdentity", { pinned: key, now: progressKey() });
      return;
    }
    try {
      if (state.scan.progressGeneration == null) throw new Error("协调服务不可用");
      var saveResult = await coordProgress({
        type: "XFM_COORD_PROGRESS_SAVE",
        key: key,
        id: id,
        path: location.pathname,
        mode: state.mode,
        rows: rows,
        scrollTop: Math.round(getScrollTop()),
        rounds: (state.scan && state.scan.rounds) || 0,
        partial: state.phase === "partial",
        startedAt: (state.scan && state.scan.startedAt) || 0,
        generation: state.scan.progressGeneration
      });
      progressSaveFailed = false;
      if (saveResult && saveResult.skipped && !progressStaleWarned) {
        // 本页任务已被其他窗口的新扫描取代：如实提示，不静默假装已保存
        progressStaleWarned = true;
        U.toast("扫描进度已失效：此列表已在其他窗口重新扫描");
      }
    } catch (err) {
      // 存储失败必须给反馈，不能让用户以为已保存
      if (!progressSaveFailed) {
        progressSaveFailed = true;
        U.toast("扫描进度保存失败，进度可能无法恢复");
      }
    }
  }

  // 调试/测试入口：强制补存一次当前进度（仅作用于本页已扫快照）
  if (D && typeof D === "object") {
    D.forceProgressSave = function () { return saveScanProgress(true); };
  }

  function clearSavedProgress(generation, keyOverride) {
    state.savedProgress = null;
    if (!hasChromeStorage()) return Promise.resolve();
    // 丢弃横幅看到的进度可能属于某个代次：携带它所见代次清除，
    // 若其他窗口已开始新一轮扫描（代次递增），协调服务会跳过本次清除
    var key = keyOverride || progressKey();
    if (!key) return Promise.resolve();
    // 清除写成墓碑（经协调服务串行）：晚到的在途保存经规则判断后不得复活
    return coordProgress({
      type: "XFM_COORD_PROGRESS_CLEAR",
      key: key,
      id: progressId() || "",
      generation: generation
    }).catch(function () { U.toast("清除扫描进度失败，请重试"); return { ok: false }; });
  }

  /** 刷新/回到本列表后检查有没有命中当前页面的未完成扫描进度 */
  async function checkSavedProgress() {
    if (!hasChromeStorage()) return;
    if (state.scan.active || state.run.active) return;
    if (state.rows.size > 0 || state.phase !== "idle") return;
    var id = progressId();
    if (!id) return;
    try {
      var key = progressKey();
      var data = await chrome.storage.local.get(key);
      if (id !== progressId() || state.scan.active || state.run.active || state.phase !== "idle") return;
      var saved = data && data[key];
      if (saved && saved.id === id && Array.isArray(saved.rows) && saved.rows.length > 0) {
        if (Date.now() - (saved.updatedAt || 0) > PROGRESS_STALE_MS) {
          return;
        }
        saved.progressKey = key;
        state.savedProgress = saved;
        render();
      } else if (state.savedProgress) {
        state.savedProgress = null;
        render();
      }
    } catch (err) { /* 读取失败：当作没有保存进度 */ }
  }

  /**
   * 恢复定位：无限列表必须先加载中间内容才能撑开滚动范围，
   * 一次 scrollTo 会被浏览器钳到当前高度；这里分段推进，直到接近目标或页面不再增长。
   */
  async function seekToSavedY(targetY, stillRestoring) {
    if (!targetY || targetY <= 0) return;
    var far = Math.abs(targetY - getScrollTop()) > getViewportHeight() * 1.5;
    var overlay = null, textEl = null, skip = false;
    if (far) {
      try {
        overlay = document.createElement("div");
        overlay.setAttribute("data-xfm-seek", "1");
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.55);color:#fff;font:13px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;backdrop-filter:blur(2px);";
        textEl = document.createElement("div");
        textEl.textContent = "正在回到上次停下的位置…";
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "跳过定位，直接继续";
        btn.style.cssText = "border:1px solid rgba(255,255,255,.6);border-radius:8px;background:transparent;color:#fff;font:inherit;padding:5px 12px;cursor:pointer;";
        btn.addEventListener("click", function () { skip = true; });
        overlay.appendChild(textEl);
        overlay.appendChild(btn);
        document.documentElement.appendChild(overlay);
      } catch (err) { overlay = null; textEl = null; }
    }
    function finish() { if (overlay && overlay.parentNode) overlay.remove(); }
    scrollToY(targetY);
    await sleep(320);
    var deadline = Date.now() + 15000;
    var lastHeight = getScrollHeight();
    var stalls = 0;
    while (!skip && stillRestoring() && Date.now() < deadline) {
      if (Math.abs(getScrollTop() - targetY) <= getViewportHeight() * 0.5) break;
      var max = Math.max(0, getScrollHeight() - getViewportHeight());
      if (max <= getScrollTop() + 8) {
        await sleep(220);
        var grown = getScrollHeight();
        if (grown <= lastHeight + 4) {
          stalls += 1;
          if (stalls >= 6) break;
        } else {
          stalls = 0;
          lastHeight = grown;
        }
        continue;
      }
      scrollToY(Math.min(targetY, max));
      if (textEl) textEl.textContent = "正在回到上次停下的位置… " + Math.min(99, Math.round(getScrollTop() / Math.max(1, targetY) * 100)) + "%";
      await sleep(180);
    }
    finish();
  }

  /**
   * 恢复扫描：合并去重已保存名单 → 标注「结果不完整」→ 以恢复点为基线继续扫描。
   * 滚动坐标只作辅助（刷新后 X 会重置列表），找不到原位置就明说，不承诺瞬间续扫。
   */
  async function restoreScan() {
    var saved = state.savedProgress;
    if (!saved) return;
    var page = detectPage();
    var self = readSelfHandle();
    if (!page || !self || saved.id !== progressId()) {
      U.toast("页面身份已变化，无法恢复上次进度");
      state.savedProgress = null;
      render();
      return;
    }
    var baseline = new Set();
    var incoming = [];
    var validRels = { mutual: 1, "one-way": 1, pending: 1, unknown: 1 };
    (saved.rows || []).forEach(function (r) {
      if (!r || typeof r.h !== "string" || !r.h || baseline.has(r.h)) return;
      baseline.add(r.h);
      incoming.push({
        handle: r.h,
        name: typeof r.n === "string" ? r.n : "",
        avatar: typeof r.a === "string" ? r.a : "",
        relation: validRels[r.r] ? r.r : C.REL.UNKNOWN,
        reason: "restored"
      });
    });
    if (incoming.length === 0) {
      U.toast("保存的进度为空，已丢弃");
      await clearSavedProgress(saved.generation, saved.progressKey);
      render();
      return;
    }
    C.mergeRows(state.rows, state.order, incoming);   // 去重合并进当前快照
    scanBaseline = baseline;
    scanFresh = new Set();
    state.savedProgress = null;
    // 部分结果不得冒充完整：恢复即标注「结果不完整」，继续扫描补齐
    state.phase = "partial";
    state.scan.stopReason = "已恢复上次进度（" + baseline.size + " 人），结果不完整";
    state.notice = "正在重新定位，已保存名单会保留";
    var restoringPath = location.pathname;
    var previousScan = state.scan;
    function stillRestoring() {
      return location.pathname === restoringPath && saved.id === progressId() &&
        state.scan === previousScan && state.phase === "partial" && !state.run.active;
    }
    render();
    if (saved.scrollTop && saved.scrollTop > 0) {
      await seekToSavedY(saved.scrollTop, stillRestoring);
    }
    await sleep(500);
    if (!stillRestoring()) return;
    // 提示要驻留一会儿：startScan 的轮次提示会在 1 秒内覆盖 state.notice
    setTempNotice("正在重新定位，已保存名单会保留（已恢复 " + baseline.size + " 人）", 4000);
    void startScan(true);
  }

  /**
   * 记录当前可见行的实际高度。
   * X 的行高并不均匀（简介一行/两行、徽章、头像差异），用均值估算会越走越偏；
   * 攒一批真实样本取中位数，比 scrollHeight / 总行数稳得多。
   * offsetHeight 会触发同步布局，因此限制采样频率。
   */
  function recordRowHeights() {
    var now = Date.now();
    if (now - lastRowSampleAt < 400) return;
    lastRowSampleAt = now;
    var cells = document.querySelectorAll(C.SELECTORS.userCell);
    var heights = [];
    for (var i = 0; i < cells.length && i < 20; i += 1) {
      heights.push(cells[i].offsetHeight || 0);
    }
    rowHeightSamples = C.mergeRowHeights(rowHeightSamples, heights, ROW_HEIGHT_MAX_SAMPLES);
  }

  function harvest() {
    var column = document.querySelector(C.SELECTORS.primaryColumn) || document;
    var result = C.collectRows(column, state.mode);
    if (state.mode !== C.MODE.REPLY) {
      /*
       * 清理模式：关注列表里按钮已是「关注」的行 = 已不是正在关注
       * （上一批刚取关、或用户在 X 上手动取关）。不入快照，否则执行后的
       * 刷新会把刚取关的账号当成「未知」收回来，名单越扫越脏，
       * 也违背「成功后从候选移除」的语义。
       */
      result.rows = result.rows.filter(function (r) { return r.actionKind !== "follow"; });
    }
    var merged = C.mergeRows(state.rows, state.order, result.rows);
    // 增长判定：只统计基线之外的新账号。恢复扫描时基线=已保存名单，
    // 重扫已知区域不算增长，否则会被误判为「到底」
    for (var fi = 0; fi < result.rows.length; fi += 1) {
      if (!scanBaseline.has(result.rows[fi].handle)) scanFresh.add(result.rows[fi].handle);
    }
    var scrollTop = getScrollTop();
    var origin = getViewportOriginTop();
    var viewportHeight = getViewportHeight();
    result.rows.forEach(function (row) {
      if (!row.element || !row.element.isConnected) return;
      var rect = row.element.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > origin && rect.top < origin + viewportHeight) {
        scannedPositions.set(row.handle, scrollTop + rect.top - origin);
      }
    });
    state.scan.skippedRows = result.skipped;
    recordRowHeights();
    return merged;
  }

  /**
   * 等待本屏出现新账号；一旦有新内容立刻返回，不必死等到上限。
   * 这是提速的关键：X 大部分轮次只是渲染已加载的行，200ms 内就绪。
   * 先用便宜的探针（行数 + 页高）判断有没有变化，都没变就跳过全量采集
   * ——全量 harvest 要逐行建记录，是扫描中最重的 DOM 操作。
   */
  async function waitForGrowth(maxMs) {
    var before = scanFresh.size;
    var probe = probeSignature();
    var waited = 0;
    while (waited < maxMs && state.scan.active && !state.scan.abort) {
      await sleep(SCAN_POLL_STEP_MS);
      if (!state.scan.active || state.scan.abort) return;
      waited += SCAN_POLL_STEP_MS;
      var sig = probeSignature();
      /*
       * 便宜探针：行数、页高、首行身份都没变才跳过全量采集。
       * 虚拟列表节点复用时行数与页高都可以不变而内容已换（首行换成另一个账号），
       * 只比行数+页高会漏掉这种变化，让采集延迟一轮。
       */
      if (sig.cells === probe.cells && sig.height === probe.height && sig.first === probe.first) continue;
      probe = sig;
      harvest();
      if (scanFresh.size > before) return;
      if (!atBottom() && !C.detectPageIssues(document).loading) return;
    }
  }

  /** 便宜探针签名：一次 querySelectorAll + 一次页高 + 首行一次 handle 查询 */
  function probeSignature() {
    var cells = document.querySelectorAll(C.SELECTORS.userCell);
    return {
      cells: cells.length,
      height: getScrollHeight(),
      first: cells.length ? (C.extractHandle(cells[0]) || "") : ""
    };
  }

  /**
   * 可中断睡眠：等待期间随时响应停止 / 手动暂停 / 回前台复核，
   * 后台受限的 8 秒试探间隔不再是「点了暂停要等 8 秒才生效」。
   */
  async function sleepInterruptible(ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) {
      if (state.scan.abort || state.scan.userPaused || state.scan.pendingRecheck) return;
      var step = Math.min(400, end - Date.now());
      if (step <= 0) return;
      await sleep(step);
    }
  }

  /** 后台渲染节流：提示变化至少隔 SCAN_BG_RENDER_MS 才写一次 DOM */
  function renderThrottled() {
    if (!document.hidden) {
      render();
      return;
    }
    var now = Date.now();
    if (now - lastBgRenderAt < SCAN_BG_RENDER_MS) return;
    lastBgRenderAt = now;
    render();
  }

  async function startScan(resume) {
    if (state.scan.active || state.run.active) return;

    var page = detectPage();
    if (!page) {
      U.toast("请打开你自己账号的「正在关注」或「关注者」列表");
      return;
    }
    state.mode = page.mode;
    state.owner = page.handle || null;
    state.selfHandle = readSelfHandle();
    if (state.selfHandle && state.owner && state.selfHandle !== state.owner) {
      state.phase = "failed";
      state.scan.error = "这是 @" + state.owner + " 的关注列表，但你当前登录的是 @" + state.selfHandle + "，已拒绝扫描。";
      render();
      return;
    }

    // 「继续扫描」：保留已扫描结果，从当前位置往下走，不再回到顶部重来
    var isResume = resume === true && state.rows.size > 0 && state.phase === "partial";
    var hadRows = state.rows.size > 0;

    if (!isResume) {
      state.rows.clear();
      state.order = [];
      state.selected.clear();
      state.excludeMode = false;
      rowHeightSamples = [];
      scannedPositions.clear();
      clearReconcileState();
      U.removeCheckboxes(document);
    }
    state.warning = "";
    state.notice = (isResume ? "从中断处继续扫描…" : "正在加载列表…") + "（保持此标签页可见，窗口被完全遮挡会暂停）";
    state.phase = "scanning";
    state.scan = {
      active: true, abort: false, complete: false,
      userPaused: false, hidden: document.hidden,
      bgLimited: false, pendingRecheck: false,
      stopReason: "",
      error: "", skippedRows: 0, rounds: 0, startedAt: Date.now(), integrity: null,
      previousFilter: state.filter,
      // 固定任务身份：扫描只在启动时的这个列表上进行，路由一变立即中止
      page: { path: location.pathname, mode: state.mode, owner: state.owner }
    };
    // 固定进度身份：BEGIN 是异步的，等待期间可能路由切换或重新开始扫描——
    // 返回的代次只允许用于启动时的这个键，旧任务的回调不得污染新一轮扫描
    var pinnedProgressKey = progressKey();
    var pinnedPagePath = location.pathname;
    var scanObj = state.scan;
    scanObj.activityId = "scan-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    if (hasChromeStorage() && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      try {
        var activity = await chrome.runtime.sendMessage({ type: "XFM_COORD_SCAN_START", scanId: scanObj.activityId,
          runId: state.scheduledRun && state.scheduledRun.active ? state.scheduledRun.runId : null });
        if (!activity || !activity.ok) throw new Error((activity && activity.reason) || "无法协调扫描状态");
        if (state.scan !== scanObj || !scanObj.active || location.pathname !== pinnedPagePath) {
          void releaseScanActivity(scanObj.activityId);
          return;
        }
      } catch (err) {
        if (state.scan === scanObj) {
          scanObj.active = false;
          state.phase = "failed";
          state.notice = err.message || "无法协调扫描状态";
          render();
          if (state.scheduledRun && state.scheduledRun.active) void finishScheduledRun("failed", state.notice);
        }
        return;
      }
    }
    try {
      var progressStart = await coordProgress({ type: "XFM_COORD_PROGRESS_BEGIN", key: pinnedProgressKey });
      // 协调器顺带清理了过期进度键： BEGIN 返回的代次基于清理后的存储，直接可用
      if (state.scan !== scanObj || !state.scan.active || progressKey() !== pinnedProgressKey || location.pathname !== pinnedPagePath) {
        debugLog("progress.begin.discard", { pinned: pinnedProgressKey, now: progressKey() });
        return; // 身份已变：本次扫描作废，旧代次不得写入新列表
      }
      state.scan.progressGeneration = progressStart.generation;
      state.scan.progressKey = pinnedProgressKey;
    } catch (err) {
      if (state.scan === scanObj) state.scan.progressGeneration = null;
      U.toast("扫描进度保存不可用，刷新后可能无法恢复");
    }
    if (!state.scan.active) return;
    lastBgRenderAt = 0;
    lastProgressSaveAt = 0;
    progressSaveFailed = false;

    // 先渲染一次，让界面立刻反映「扫描中」，再开始滚动加载
    render();
    debugLog("scan.start", { mode: state.mode, resume: isResume, owner: state.owner });

    // 扫描必须看全部行，否则 display:none 会干扰虚拟列表的高度计算
    if (state.filter !== "all") {
      state.filter = "all";
      applyFilterToCss();
    }

    if (!isResume) {
      // 重新扫描必须先回到顶部；提前说清楚，避免用户以为页面被抢走
      if (hadRows) {
        state.notice = "即将回到顶部重新扫描…";
        render();
        await sleep(260);
      }
      scrollToY(0);
      await sleep(600);
      render();
      scanBaseline = new Set();
      scanFresh = new Set();
    }

    var lastFresh = -1;
    var scheduledLastGrowth = Date.now();
    var scheduledLastProgressReport = 0;
    var lastHeight = -1;
    var lastSavedFresh = 0;
    var idleRounds = 0;

    while (!state.scan.abort && state.scan.rounds < SCAN_MAX_ROUNDS) {
      if (state.scheduledRun && state.scheduledRun.active && Date.now() - scheduledLastGrowth >= 5 * 60 * 1000) {
        finishScan("partial", "扫描 5 分钟没有进展");
        break;
      }
      // 用户手动暂停：不滚动、不计空闲；切窗口/回前台都不会改变这个状态
      if (state.scan.userPaused) {
        state.notice = "已暂停（已保存 " + state.rows.size + " 人）";
        renderThrottled();
        await sleep(400);
        continue;
      }

      // 回到前台 / 点「继续」：重新检查页面、加载状态并采集，空闲判定从头再来
      if (state.scan.pendingRecheck) {
        state.scan.pendingRecheck = false;
        state.scan.bgLimited = false;
        lastFresh = -1;
        lastHeight = -1;
        idleRounds = 0;
        harvest();
      }

      // 用户正在手动滚动 → 暂停自动滚动，别把页面抢回来
      if (Date.now() - lastUserScrollAt < 1200) {
        // 已到底、只是在做收尾确认时，用户一接管就直接结束，避免继续拉扯
        if (idleRounds >= 1 && !document.hidden && !(state.scheduledRun && state.scheduledRun.active)) {
          finishScan("scanned", "");
          break;
        }
        state.notice = "检测到你在手动滚动，已暂停自动滚动；停手后自动继续";
        renderThrottled();
        await sleep(400);
        continue;
      }

      state.scan.rounds += 1;

      if (!verifyPage(state.scan.page).ok) {
        finishScan("partial", "页面已切换，扫描中止");
        break;
      }

      var issues = C.detectPageIssues(document);
      if (issues.blocked) {
        if (state.scheduledRun && state.scheduledRun.active) state.scheduledRun.pauseRequired = true;
        finishScan("failed", issues.blockedReason || "页面出现限制或验证");
        break;
      }

      harvest();
      var fresh = scanFresh.size;
      if (fresh > lastFresh) {
        scheduledLastGrowth = Date.now();
        if (fresh > 0 && state.scheduledRun && state.scheduledRun.active && Date.now() - scheduledLastProgressReport >= 60000) {
          scheduledLastProgressReport = Date.now();
          void chrome.runtime.sendMessage({ type: "XFM_SCHED_SCAN_PROGRESS", runId: state.scheduledRun.runId, scanned: fresh }).catch(function () {});
        }
      }
      var count = state.rows.size;
      var height = getScrollHeight();
      var loading = issues.loading;

      if (document.hidden) {
        state.notice = "后台扫描中，速度可能降低（已扫描 " + count + " 人）";
      } else {
        state.notice = "已扫描 " + count + " 个账号" + (loading ? "，正在加载…" : "") + "（保持可见，完全遮挡会暂停）";
      }
      renderThrottled();
      debugLog("scan.round", {
        round: state.scan.rounds,
        count: count,
        height: Math.round(height),
        top: Math.round(getScrollTop()),
        bottom: atBottom(),
        loading: loading,
        idle: idleRounds
      });

      // 有新账号就补存进度（内部按 5s 节流，不会每扫一人写一次）
      if (fresh !== lastSavedFresh) {
        lastSavedFresh = fresh;
        saveScanProgress(false);
      }

      if (fresh === lastFresh && height === lastHeight && atBottom() && !loading) {
        idleRounds += 1;
      } else {
        idleRounds = 0;
      }
      lastFresh = fresh;
      lastHeight = height;

      if (idleRounds >= SCAN_IDLE_ROUNDS) {
        if (document.hidden) {
          /*
           * 后台连续无新增 ≠ 到底：X 在后台会暂停懒加载，此时判「扫描完成」
           * 是误报。进入「后台加载受限」：停止滚动、低频试探、已有结果保留，
           * 回到前台后复核（pendingRecheck 会重置空闲计数）。
           */
          state.scan.bgLimited = true;
          state.notice = "后台加载受限，切回 X 可继续（已保存 " + count + " 人）";
          renderThrottled();
          // 等待加载不应耗尽扫描轮次；切回前台后下一轮重新复核。
          state.scan.rounds -= 1;
          await sleep(SCAN_BG_RETRY_MS);
          continue;
        }
        finishScan("scanned", "");
        break;
      }

      if (count === 0 && state.scan.rounds > 25) {
        finishScan("failed", "页面上没有找到任何用户行，可能列表未加载或页面结构不兼容。");
        break;
      }

      // 后台加载受限：低频试探（X 可能自行恢复加载）；回前台由 pendingRecheck 复核
      if (state.scan.bgLimited) {
        await sleepInterruptible(SCAN_BG_RETRY_MS);
        harvest();
        if (scanFresh.size > fresh) state.scan.bgLimited = false; // 后台也恢复了加载
        continue;
      }

      if (atBottom() && !loading) {
        // 到底后只在前两轮做一次轻微回弹，后续静默等待，避免用户看到「一直往下拉」。
        // 回弹前后都检查用户是否接管：窗口内用户一滚就放弃，绝不再把页面抢回底部。
        if (idleRounds < 1 && !recentUserScroll(1200)) {
          scrollByY(-160);
          await sleep(120);
          if (recentUserScroll(1200)) {
            debugLog("scan.rebound.skip", { reason: "user-scroll" });
          } else {
            // 相对归位：不再 scrollToY(scrollHeight)，避免把用户甩到底部
            scrollByY(160);
          }
        }
        await waitForGrowth(SCAN_SETTLE_BOTTOM_MS);
      } else {
        scrollByY(Math.max(400, Math.floor(getViewportHeight() * SCAN_STEP_RATIO)));
        await waitForGrowth(SCAN_SETTLE_FAST_MS);
      }
    }

    if (state.scan.rounds >= SCAN_MAX_ROUNDS && state.phase === "scanning") {
      finishScan("partial", "达到最大滚动轮次，仍未确认列表末尾，结果可能不完整。");
    }
  }

  function finishScan(phase, reason) {
    void releaseScanActivity(state.scan.activityId);
    state.scan.active = false;
    state.scan.abort = true;   // 必须为 true：循环条件靠它退出，设 false 会让自动滚动继续跑

    // 收尾再收一次：真实 X 会在停到底部时又补几行，最后一次 harvest 能把它们捞进来
    if (phase !== "failed") {
      try { harvest(); } catch (err) { /* 收尾失败不影响主流程 */ }
    }

    var rows = currentRows();
    var integrity = C.evaluateIntegrity(rows, { strict: state.strictMode, candidateRel: candidateRel() });
    state.scan.integrity = integrity;
    debugLog("scan.finish", {
      phase: phase,
      reason: reason,
      rows: rows.length,
      rounds: state.scan.rounds,
      elapsed: state.scan.startedAt ? Date.now() - state.scan.startedAt : 0
    });

    if (phase === "failed") {
      state.phase = "failed";
      state.scan.error = reason || "扫描失败";
      state.notice = state.scan.error;
    } else if (phase === "partial") {
      state.phase = "partial";
      state.scan.stopReason = reason || "扫描未完成";
      state.notice = state.scan.stopReason + "（已保留已扫描结果）";
    } else {
      state.phase = "scanned";
      state.notice = "已到达列表末尾，共 " + rows.length + " 个账号";
      // 名单窗口是最直观的挑选入口，扫描完成后主动提示一次
      setTempNotice("点「名单」可搜索、勾选、排除想保留的人；点「" +
        (state.mode === C.MODE.REPLY ? "待回关" : "未回关") + "」数字也能打开", 7000);
    }

    state.warning = integrity.warnings.length > 0 ? integrity.warnings[0].message : "";

    if (phase === "scanned") {
      // 正常完成：未完成进度不再需要，清掉避免下次回来误提示恢复
      if (state.scan.progressGeneration != null) {
        void clearSavedProgress(state.scan.progressGeneration, state.scan.progressKey);
      }
    } else {
      // 停止/受限/失败：补存，刷新后还能恢复
      void saveScanProgress(true);
    }

    restoreFilterAfterScan();
    syncCheckboxes();
    render();
    saveSettings();

    // 定时任务自动链式：扫描完成 → 自动选择 → 自动执行
    if (phase === "scanned" && state.scheduledRun && state.scheduledRun.active) {
      setTimeout(function () { runScheduledChain(); }, 500);
    } else if (phase !== "scanned" && state.scheduledRun && state.scheduledRun.active) {
      void finishScheduledRun("failed", reason || "扫描未完成");
    }
  }

  /** 定时任务的自动选择 + 执行（跳过确认弹窗，保留安全校验） */
  async function runScheduledChain() {
    if (!state.scheduledRun || !state.scheduledRun.active) return;
    var sr = state.scheduledRun;
    if (state.phase !== "scanned" || readSelfHandle() !== sr.account || sr.count > (sr.batchLimit || state.batchLimit) || !verifyExecutionAllowed(state.scan.page).ok) {
      void finishScheduledRun("failed", "扫描或账号校验未通过");
      return;
    }
    var selection = C.planAutoSelect(currentRows(), sr.count, runExcludedSet(state.mode === C.MODE.REPLY), candidateRel(), sr.order !== "asc");
    state.selected = new Set(selection.picked.map(function (row) { return row.handle; }));
    sr.scanned = state.rows.size;
    sr.candidates = selection.poolSize;
    if (!selection.picked.length) { void finishScheduledRun("success", "扫描完成，无需处理"); return; }
    try {
      var savedScan = await chrome.runtime.sendMessage({ type: "XFM_SCHED_SCAN_DONE", runId: sr.runId, scanned: sr.scanned, candidates: sr.candidates });
      if (!savedScan || !savedScan.ok || state.scheduledRun !== sr || !sr.active || state.phase !== "scanned" || !verifyExecutionAllowed(state.scan.page).ok) throw new Error("任务状态已变化");
    } catch (err) { void finishScheduledRun("failed", "无法保存扫描结果或页面已变化"); return; }
    syncCheckboxes();
    void runUnfollow({ skipConfirm: true, scheduled: true, oldestFirst: sr.order !== "asc" }).then(function () {
      // 运行结束：上报记录到后台存储
      var g = state.run && state.run.groups ? state.run.groups : {};
      var status = state.phase !== "done" ? "failed" : ((g.unknown || []).length || (g.failed || []).length || (g.pending || []).length ? "partial" : "success");
      void finishScheduledRun(status, state.notice || "", g);
    }).catch(function () {
      void finishScheduledRun("failed", "执行过程中发生错误");
    });
  }

  /** 退出定时运行模式 */
  function endScheduledRun() {
    if (state.scheduledRun) state.scheduledRun.active = false;
  }

  async function finishScheduledRun(status, reason, groups) {
    var sr = state.scheduledRun;
    if (!sr || !sr.active) return;
    sr.active = false;
    groups = groups || {};
    var detail = [];
    ["success", "failed", "skipped", "unknown"].forEach(function (type) {
      (groups[type] || []).forEach(function (item) { detail.push({ handle: item.handle, status: type, reason: item.reason || "" }); });
    });
    try {
      var result = await chrome.runtime.sendMessage({ type: "XFM_SCHED_RECORD_RUN", taskKey: sr.taskKey, runId: sr.runId, due: sr.due, startedAt: sr.startedAt,
        status: status, reason: reason, scanned: sr.scanned || state.rows.size, candidates: sr.candidates || 0,
        success: (groups.success || []).length, skipped: (groups.skipped || []).length,
        unknown: (groups.unknown || []).length, failed: (groups.failed || []).length, detail: detail,
        pause: !!sr.pauseRequired || (groups.unknown || []).length > 0,
        failureCycle: sr.stopReason === "consecutive-failures" });
      if (!result || !result.ok) throw new Error("定时记录保存失败");
    } catch (err) {
      U.toast("定时任务结果保存失败，请查看当前页面");
      return;   // 记录都没保存成功时，不再继续发通知，避免误导
    }
    // 通知与记录解耦：通知失败只写调试日志，不得提示“保存失败”或影响任务结果
    try {
      var notifyResult = await chrome.runtime.sendMessage({ type: "XFM_COORD_NOTIFY", title: sr.taskType === "followback" ? "定时回关" : "定时清理", message: status === "success" ? "本次任务已完成" : "本次任务已停止，请查看记录" });
      if (!notifyResult || !notifyResult.ok) debugLog("sched.notifyFailed", { taskKey: sr.taskKey, status: status });
    } catch (err) {
      debugLog("sched.notifyException", { taskKey: sr.taskKey, message: String(err && err.message || err) });
    }
  }

  function stopScan() {
    if (!state.scan.active) return;
    void releaseScanActivity(state.scan.activityId);
    state.scan.abort = true;
    state.scan.active = false;
    state.scan.userPaused = false;
    state.scan.bgLimited = false;
    state.phase = "partial";
    state.scan.stopReason = "已手动停止，结果不完整";
    state.notice = state.scan.stopReason;
    var rows = currentRows();
    var integrity = C.evaluateIntegrity(rows, { strict: state.strictMode, candidateRel: candidateRel() });
    state.scan.integrity = integrity;
    state.warning = integrity.warnings.length > 0 ? integrity.warnings[0].message : "";
    void saveScanProgress(true);
    if (state.scheduledRun && state.scheduledRun.active) void finishScheduledRun("skipped", "用户停止扫描");
    restoreFilterAfterScan();
    syncCheckboxes();
    render();
  }

  /**
   * 扫描结束（完成或手动停止）后恢复用户原本的筛选偏好。
   * 扫描期间强制「全部」（display:none 会干扰虚拟列表高度计算），
   * 之前是静默留在「全部」——用户选过的「仅看未回关」被悄悄重置，属于同类
   * 「动作后状态不告知」的问题。现在恢复突出显示偏好，不隐藏原生行，避免
   * 切换瞬间列表高度骤变带来的滚动钳制。
   */
  function restoreFilterAfterScan() {
    var want = state.scan.previousFilter === "one-way" || state.scan.previousFilter === "all"
      ? state.scan.previousFilter
      : "all";
    if (state.filter === want) return;
    preserveScroll(function () {
      state.filter = want;
      applyFilterToCss();
    });
    setTempNotice(want === "one-way" ? "已突出显示候选；精确筛选请打开「名单」" : "已恢复你的筛选：全部", 3200);
  }

  /* ------------------------------------------------------------------ */
  /* 批量取消关注                                                        */
  /* ------------------------------------------------------------------ */

  function visibleNativeConfirmation() {
    var buttons = document.querySelectorAll('[data-testid="confirmationSheetConfirm"]');
    return Array.from(buttons).find(C.isVisible) || null;
  }

  /**
   * 观察单次操作的结果。
   *
   * 判定规则：
   *  1. 按钮翻转 → 成功（取关→关注 / 回关→正在关注）。这是唯一可信的成功证据；
   *  2. 行从 DOM 消失 → 结果未知：虚拟列表滚动时会卸载屏幕外的行，
   *     用户滚动或页面重渲染也会让行离开 DOM，不能当作操作生效；
   *  3. 行还在、按钮没变 → 结果未知。
   *
   */
  function watchUnfollowResult(cell, handle, startScrollTop, anchor, actionKind, clickActivityAt) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + (state.run.abort ? 2500 : UNFOLLOW_RESULT_WAIT_MS);
      var confirmClicked = false;
      var missingSince = 0;
      var startedAt = Date.now();
      var wantDone = state.mode === C.MODE.REPLY ? "unfollow" : "follow";

      function finish(status, reason) {
        debugLog("verdict", {
          handle: handle,
          status: status,
          reason: reason,
          elapsed: Date.now() - startedAt,
          scrollDelta: Math.round(getScrollTop() - startScrollTop)
        });
        resolve({ status: status, reason: reason });
      }

      (function tick() {
        // 等待期间持续补偿视口，页面不会因为列表重排而跳动
        if (anchor) restoreAnchor(anchor);

        // 路由已经离开关注列表 → 立即收敛，不再对当前页面做任何操作
        if (!verifyExecutionAllowed(state.run.page).ok) {
          finish("unknown", "操作后页面已切换，需人工确认结果");
          return;
        }

        // 页面级限制 / 验证优先于确认按钮。
        var issues = C.detectPageIssues(document);
        if (issues.blocked) {
          finish("blocked", issues.blockedReason || "页面出现限制或验证");
          return;
        }

        var confirm = visibleNativeConfirmation();
        if (confirm && !confirmClicked) {
          if (actionKind !== "unfollow" || state.run.abort || lastUserClickAt !== clickActivityAt ||
            !UNFOLLOW_CONFIRM_TEXT.test(confirm.textContent.trim())) {
            state.run.abort = true;
            finish("unknown", "无法核实 X 的确认窗口，已停止，请人工复查");
            return;
          }
          confirmClicked = true;
          confirm.click();
        }

        // X 可能重渲染或复用原来的节点。重新定位到同一账号后检查按钮状态。
        if (!cell || !cell.isConnected || C.extractHandle(cell) !== handle) cell = findCellByHandle(handle);
        var liveAction = cell && C.findActionButton(cell);
        if (liveAction && liveAction.kind === wantDone) {
          finish("success", state.mode === C.MODE.REPLY ? "按钮已变为「正在关注」" : "按钮已变为「关注」");
          return;
        }

        // 4) 按 handle 全列重查：查不到不算成功。
        //    虚拟列表滚动时会卸载屏幕外的行，用户滚动或页面重渲染也会让行离开
        //    DOM——「行消失」不是操作生效的证据。没有按钮状态变化就归为「结果未知」，
        //    让用户在结果窗口里人工复查，绝不静默计成已取关。
        if (!cell) {
          if (!missingSince) missingSince = Date.now();
          var waitingForConfirm = actionKind === "unfollow" && !confirmClicked && Date.now() - startedAt < UNFOLLOW_CONFIRM_WAIT_MS;
          if (!waitingForConfirm && Date.now() - missingSince >= 160) {
            finish("unknown", "行已从列表移除，但未观察到按钮状态变化，需人工确认");
            return;
          }
        } else {
          missingSince = 0;
        }

        if (Date.now() > deadline) {
          if (confirm) {
            finish("blocked", "确认弹窗未能关闭，已停止");
          } else {
            finish("unknown", "未观察到可确认的成功状态");
          }
          return;
        }
        setTimeout(tick, 80);
      })();
    });
  }

  async function unfollowOne(cell, target) {
    if (!await checkRunLock()) return { status: "aborted", reason: "执行锁已失效" };
    var pageCheck = verifyExecutionAllowed(state.run && state.run.page);
    if (!pageCheck.ok) {
      return { status: "aborted", reason: pageCheck.reason };
    }
    if (!cell || !cell.isConnected) {
      return { status: "skipped", reason: "行已不在页面" };
    }

    var wantRel = candidateRel();
    var wantKind = state.mode === C.MODE.REPLY ? "follow" : "unfollow";

    /*
     * 执行前逐条复核。X 的按钮是异步 hydration 出来的：刚滚到的行可能短暂
     * 没有按钮，直接判「未找到按钮」会把可执行账号白白跳过，因此给 450ms 短轮询。
     */
    var live = readCell(cell);
    var action = null;
    var actionDeadline = Date.now() + 450;
    for (;;) {
      if (isRunExcluded(target.handle)) return { status: "skipped", reason: "账号已加入排除名单" };
      if (state.run.abort || !verifyExecutionAllowed(state.run.page).ok) {
        return { status: "aborted", reason: "页面已切换或任务已停止" };
      }
      if (!cell.isConnected) return { status: "skipped", reason: "行已不在页面" };
      live = readCell(cell);
      if (!live.handle) return { status: "skipped", reason: "无法识别账号" };
      if (live.handle !== target.handle) {
        return { status: "skipped", reason: "账号身份不匹配（DOM 已复用）" };
      }
      if (live.relation === C.REL.MUTUAL) {
        return { status: "skipped", reason: state.mode === C.MODE.REPLY ? "已回关，跳过" : "已回关，按规则跳过" };
      }
      action = C.findActionButton(cell);
      if (live.relation === wantRel && action && action.kind === wantKind) break;
      if (Date.now() > actionDeadline) {
        if (live.relation !== wantRel) {
          return { status: "skipped", reason: "关注关系无法确认" };
        }
        debugLog("button.missing", { handle: target.handle, waited: 450 });
        return { status: "skipped", reason: state.mode === C.MODE.REPLY ? "未找到回关按钮" : "未找到取关按钮" };
      }
      await sleep(90);
    }

    var startScrollTop = getScrollTop();
    var anchor = visibleAnchor();
    debugLog("unfollow.start", { handle: target.handle, top: Math.round(startScrollTop) });
    var sr = state.scheduledRun && state.scheduledRun.active ? state.scheduledRun : null;
    if (sr) {
      try {
        var marked = await chrome.runtime.sendMessage({ type: "XFM_SCHED_ACTION_BEGIN", runId: sr.runId, handle: target.handle });
        if (!marked || !marked.ok) return { status: "aborted", reason: "无法保存操作状态" };
      } catch (err) { return { status: "aborted", reason: "无法保存操作状态" }; }
      if (state.run.abort || !verifyExecutionAllowed(state.run.page).ok) {
        return await finishScheduledAction(sr, target.handle, { status: "aborted", reason: "操作前任务已停止" });
      }
      var current = cell.isConnected && readCell(cell);
      var currentAction = cell.isConnected && C.findActionButton(cell);
      if (!current || current.handle !== target.handle || current.relation !== wantRel || !currentAction || currentAction.kind !== wantKind || isRunExcluded(target.handle)) {
        return await finishScheduledAction(sr, target.handle, { status: "skipped", reason: "操作前账号或关系已变化" });
      }
      action = currentAction;
    }
    if (visibleNativeConfirmation()) {
      return await finishScheduledAction(sr, target.handle, { status: "blocked", reason: "X 页面已有待确认操作，请先处理该窗口" });
    }
    var issues = C.detectPageIssues(document);
    if (issues.blocked) {
      return await finishScheduledAction(sr, target.handle, { status: "blocked", reason: issues.blockedReason });
    }
    var clickActivityAt = lastUserClickAt;
    action.el.click();
    var outcome = await watchUnfollowResult(cell, target.handle, startScrollTop, anchor, wantKind, clickActivityAt);
    return await finishScheduledAction(sr, target.handle, outcome);
  }

  async function finishScheduledAction(sr, handle, outcome) {
    if (!sr) return outcome;
    try {
      var saved = await chrome.runtime.sendMessage({ type: "XFM_SCHED_ACTION_END", runId: sr.runId, handle: handle, status: outcome.status, reason: outcome.reason });
      if (!saved || !saved.ok) throw new Error("保存失败");
      return outcome;
    } catch (err) { return { status: "unknown", reason: "无法保存操作结果，请人工复查" }; }
  }

  async function runUnfollow(opts) {
    var skipConfirm = opts && opts.skipConfirm;
    var ignoreExcluded = !!(opts && opts.scheduled && state.mode === C.MODE.REPLY);
    if (state.run.active || state.scan.active) return;
    if (state.phase === "failed") {
      U.toast("扫描失败，请重新扫描后再执行");
      return;
    }

    var rows = currentRows();
    // 定时运行使用周期开始时的批次上限快照；手动执行沿用当前设置
    var effectiveBatchLimit = state.scheduledRun && state.scheduledRun.active && Number.isInteger(state.scheduledRun.batchLimit)
      ? state.scheduledRun.batchLimit
      : state.batchLimit;
    var plan = C.planBatch(rows, state.selected, effectiveBatchLimit, runExcludedSet(ignoreExcluded), candidateRel());
    if (plan.batch.length === 0) {
      U.toast(plan.blocked.length > 0 ? "选中的账号都在排除名单里" : "没有可执行的账号");
      return;
    }

    var integrity = C.evaluateIntegrity(rows, { strict: effectiveRunStrict(), candidateRel: candidateRel() });
    if (integrity.blocked) {
      U.toast("完整性校验未通过，已阻止批量操作");
      render();
      return;
    }

    var taskPage = { path: location.pathname, mode: state.mode, owner: state.owner };
    var pageCheck = verifyExecutionAllowed(taskPage);
    if (!pageCheck.ok) {
      U.toast(pageCheck.reason);
      return;
    }

    // 执行互斥：同一时刻只允许一个标签页执行，避免重复操作与双倍风控压力
    var lock = await acquireRunLock();
    if (!lock.ok) {
      U.toast(lock.reason);
      render();
      return;
    }
    if (!verifyExecutionAllowed(taskPage).ok) {
      releaseRunLock();
      return;
    }

    var scanLabel = state.phase === "scanned" ? "已到达列表末尾"
      : (state.phase === "partial" ? "未完成（结果不完整）"
        : (state.phase === "failed" ? "扫描失败（结果不可靠）" : "未扫描"));

    var confirmResult;
    if (skipConfirm) {
      // 定时任务：跳过确认弹窗，但保留排除名单过滤与全部安全校验
      confirmResult = {
        confirmed: true,
        batch: plan.batch
      };
    } else {
      confirmResult = await U.confirmUnfollow({
        batch: plan.batch,
        deferred: plan.deferred,
        limit: plan.limit,
        scanLabel: scanLabel,
        mode: state.mode,
        // 在确认弹窗里排除的账号，立即写回持久名单并取消勾选
        onExclude: function (handle, excluded) {
          if (excluded) {
            state.excluded.add(handle);
            state.selected.delete(handle);
          } else {
            state.excluded.delete(handle);
          }
          saveSettings();
          syncCheckboxes();
          render();
          U.toast((excluded ? "已排除 @" : "已恢复 @") + handle);
        }
      });
    }
    if (!confirmResult || !confirmResult.confirmed) {
      releaseRunLock();
      return;
    }
    if (!await checkRunLock() || !verifyExecutionAllowed(taskPage).ok) {
      releaseRunLock();
      U.toast("页面已切换，本批未执行");
      return;
    }

    // 以弹窗里最终保留的名单为准；用户可能取消了部分勾选
    var excludedForBatch = runExcludedSet(ignoreExcluded);
    var batch = (confirmResult.batch || []).filter(function (row) {
      return !excludedForBatch || !excludedForBatch.has(row.handle);
    });
    if (batch.length === 0) {
      U.toast("本批已清空，未执行");
      releaseRunLock();
      render();
      return;
    }
    if (C.evaluateIntegrity(currentRows(), { strict: effectiveRunStrict(), candidateRel: candidateRel() }).blocked) {
      releaseRunLock();
      U.toast("完整性校验未通过，已阻止批量操作");
      render();
      return;
    }
    if (!skipConfirm && batch.length > state.batchLimit) {
      releaseRunLock();
      U.toast("单批上限已降低，请重新核对名单");
      render();
      return;
    }

    state.run = {
      active: true,
      abort: false,
      total: batch.length,
      done: 0,
      current: "",
      seeking: false,
      seekAttempt: 0,
      waiting: false,
      ignoreExcluded: ignoreExcluded,
      // 固定任务身份：执行只在确认时的这个列表上进行
      page: taskPage,
      groups: { success: [], failed: [], skipped: [], unknown: [], pending: [] }
    };
    plan.deferred.forEach(function (row) {
      state.run.groups.pending.push({ handle: row.handle, reason: "超出单批上限，未处理" });
    });
    plan.excluded.forEach(function (row) {
      state.run.groups.skipped.push({ handle: row.handle, reason: "不是未回关账号" });
    });
    (plan.blocked || []).forEach(function (row) {
      state.run.groups.skipped.push({ handle: row.handle, reason: "在排除名单中，已跳过" });
    });

    state.phase = "running";
    state.notice = state.mode === C.MODE.REPLY ? "正在逐条回关…" : "正在逐条取消关注…";
    state.warning = "";
    state.selected.clear();
    applyFilterToCss();
    syncCheckboxes();
    render();

    // 目标从列表尾部向前排列，先处理本批最靠后的账号
    var orderIndex = new Map();
    state.order.forEach(function (h, i) { orderIndex.set(h, i); });
    var targets = batch.slice().sort(function (a, b) {
      var ia = orderIndex.has(a.handle) ? orderIndex.get(a.handle) : 0;
      var ib = orderIndex.has(b.handle) ? orderIndex.get(b.handle) : 0;
      return opts && opts.oldestFirst === false ? ia - ib : ib - ia;
    });

    var queue = new Map();
    targets.forEach(function (row) { queue.set(row.handle, row); });

    /**
     * 均值行高兜底：没有样本时用「列表总高 / 账号数」。
     * 只在拿不到局部行高时使用（真实列表里这个值可能偏差 20% 以上）。
     */
    function fallbackRowHeight() {
      var cells = document.querySelectorAll(C.SELECTORS.userCell);
      var first = cells[0];
      if (!first) return 84;
      var listTop = first.getBoundingClientRect().top + getScrollTop() - getViewportOriginTop();
      var total = Math.max(1, state.rows.size);
      return Math.max(40, Math.min(300, (getScrollHeight() - listTop) / total));
    }

    /** 队列中位置最靠后的目标 */
    function nextTarget() {
      var best = null;
      var ascending = opts && opts.oldestFirst === false;
      var bestIdx = ascending ? Infinity : -Infinity;
      queue.forEach(function (row) {
        var i = orderIndex.has(row.handle) ? orderIndex.get(row.handle) : -1;
        if (ascending ? i < bestIdx : i > bestIdx) { bestIdx = i; best = row; }
      });
      return best;
    }

    /* 按目标序号与局部行高估算位置，跳转后重新校正；到达边界仍未找到则跳过。 */
    var seekState = null;

    function resetSeek(handle) {
      seekState = {
        handle: handle,
        down: 0,
        up: 0,
        stall: 0,
        attempt: 0,
        dir: "",          // 本目标锁定的方向，不再来回摇摆
        lastJump: 0,      // 上一次的跳跃幅度，用于没有渲染行时原样再跳
        startedAt: Date.now()
      };
      state.run.seekAttempt = 0;
    }

    /**
     * 视口内的「序号窗口」：可见行的序号范围、对应的文档坐标、局部行高。
     * 局部行高来自当前真实渲染出来的行，比全局平均准得多。
     */
    function visibleIndexWindow() {
      var cells = document.querySelectorAll(C.SELECTORS.userCell);
      var minIdx = Infinity;
      var maxIdx = -Infinity;
      var minY = 0;
      var maxY = 0;
      var heights = [];
      for (var i = 0; i < cells.length; i += 1) {
        var handle = C.extractHandle(cells[i]);
        if (!handle) continue;
        if (!orderIndex.has(handle)) continue;
        var idx = orderIndex.get(handle);
        var rect = cells[i].getBoundingClientRect();
        var y = Math.round(rect.top + getScrollTop());
        if (rect.height > 20) heights.push(Math.round(rect.height));
        if (idx < minIdx) { minIdx = idx; minY = y; }
        if (idx > maxIdx) { maxIdx = idx; maxY = y; }
      }
      if (minIdx === Infinity) return null;
      /*
       * 局部行高用「像素跨度 ÷ 序号跨度」算，而不是量某个元素的高度：
       * 量元素会量到内容块而不是整行（真实页面里同行内容高度和行高并不相等），
       * 用跨度算出来的才是这一段真实的行密度。
       */
      var spanRows = maxIdx - minIdx;
      var density = spanRows > 0
        ? Math.max(40, Math.min(600, (maxY - minY) / spanRows))
        : C.pickRowHeight(heights.length ? heights : rowHeightSamples, fallbackRowHeight());
      return {
        minIdx: minIdx,
        maxIdx: maxIdx,
        minY: minY,
        maxY: maxY,
        rowHeight: Math.round(density)
      };
    }

    /**
     * 朝目标推进一步。
     * @returns {Promise<{found:boolean, gaveUp:boolean}>}
     */
    async function seekStep(handle) {
      if (!seekState || seekState.handle !== handle) resetSeek(handle);
      var st = seekState;
      var vh = getViewportHeight();
      var step = Math.max(320, Math.floor(vh * SEEK_STEP_RATIO));

      // 用户刚滚过：宽限期内不抢滚动条，但任务不暂停，等宽限期过去再继续
      if (recentUserScroll(SEEK_GRACE_MS)) {
        debugLog("seek.grace", { handle: handle });
        await sleep(160);
        return { found: false, gaveUp: false };
      }

      st.attempt += 1;
      state.run.seeking = true;
      state.run.seekAttempt = st.attempt;
      render();

      // 目标行可能已经渲染在页面里（虚拟列表会预渲染），先直接找一遍
      if (findCellByHandle(handle)) return { found: true, gaveUp: false };

      var idx = orderIndex.has(handle) ? orderIndex.get(handle) : null;
      var win = visibleIndexWindow();
      var plan = null;

      if (idx !== null && idx !== undefined && win) {
        plan = C.planSeekTarget({
          targetIdx: idx,
          minIdx: win.minIdx,
          maxIdx: win.maxIdx,
          minY: win.minY,
          maxY: win.maxY,
          rowHeight: win.rowHeight
        });
        if (plan.direction !== "unknown") st.dir = plan.direction;
      }
      // 方向一旦定下就锁定：不再因为推不出方向而掉头，避免「找一会又回到底部」
      if (!st.dir) st.dir = "down";

      /*
       * 位移方向必须与判断出的方向严格一致：
       * 之前用「估算 y − 当前 y」当位移，估算锚点一旦落在当前视口另一侧，
       * 就会出现「判断向上、实际向下」的来回弹跳（实测目标在顶部时必踩）。
       * 正确做法是只信方向，距离用「行数差 × 局部行高」算。
       */
      var delta;
      var maxJump = vh * 20;   // 单次最多跳 20 屏：真实列表 27 万像素，要能一次跨过一大段
      if (plan && plan.direction === "up") {
        var jumpUp = Math.round((plan.rowsAway + 0.5) * win.rowHeight);
        if (jumpUp < Math.max(160, Math.floor(vh * 0.3))) jumpUp = Math.max(160, Math.floor(vh * 0.3));
        if (jumpUp > maxJump) jumpUp = maxJump;
        delta = -jumpUp;
      } else if (plan && plan.direction === "down") {
        var jumpDown = Math.round((plan.rowsAway + 0.5) * win.rowHeight);
        if (jumpDown < Math.max(160, Math.floor(vh * 0.3))) jumpDown = Math.max(160, Math.floor(vh * 0.3));
        if (jumpDown > maxJump) jumpDown = maxJump;
        delta = jumpDown;
      } else if (plan && plan.direction === "inside") {
        // 序号在渲染窗口内但行不在：虚拟列表跳段了，朝缺口方向小步挪
        var mid = (win.minIdx + win.maxIdx) / 2;
        delta = (idx >= mid ? 1 : -1) * Math.max(120, Math.floor(vh * 0.3));
      } else if (!win) {
        // 当前没有渲染行（可能跳进了尚未加载的区域）：保持方向，按上次幅度再跳一次
        var repeat = st.lastJump || Math.floor(vh * 8);
        delta = (st.dir === "up" ? -1 : 1) * repeat;
      } else {
        // 拿不到序号：只能按方向一屏一屏挪
        delta = (st.dir === "up" ? -1 : 1) * step;
      }
      st.lastJump = Math.abs(delta);

      var before = Math.round(getScrollTop());
      if (delta >= 0) scrollByY(delta);
      else scrollToY(before + delta);
      if (st.dir === "up") st.up += 1; else st.down += 1;

      await sleep(SEEK_SETTLE_MS);

      // 等目标行渲染出来：先短等；序号已经落进渲染窗口说明快到了，再多等一会儿
      var waited = 0;
      while (waited < 300 && !findCellByHandle(handle)) { await sleep(100); waited += 100; }
      var win2 = visibleIndexWindow();
      if (win2 && idx !== null && idx !== undefined && idx >= win2.minIdx && idx <= win2.maxIdx) {
        waited = 0;
        while (waited < 1600 && !findCellByHandle(handle)) { await sleep(100); waited += 100; }
      }
      if (findCellByHandle(handle)) {
        debugLog("seek.hit", { handle: handle, dir: st.dir, from: before, to: Math.round(getScrollTop()), attempt: st.attempt });
        return { found: true, gaveUp: false };
      }

      var after = Math.round(getScrollTop());
      if (Math.abs(after - before) < 4) {
        st.stall += 1;
        debugLog("seek.stall", { handle: handle, dir: st.dir, stall: st.stall, top: after });
        if (st.stall >= SEEK_STALL_ROUNDS) {
          st.giveUpReason = "页面滚动不动，未能定位到该行";
          debugLog("seek.giveup", { handle: handle, why: "stalled", down: st.down, up: st.up });
          return { found: false, gaveUp: true };
        }
      } else {
        st.stall = 0;
      }
      debugLog("seek.step", {
        handle: handle, dir: st.dir, from: before, to: after,
        down: st.down, up: st.up, idx: idx, rowsAway: plan ? plan.rowsAway : null
      });

      // 到达物理边界仍没找到 → 就地判「未找到」，绝不掉头往回爬整页
      if (st.dir === "up" && atTop()) {
        st.giveUpReason = "已到列表顶部仍未找到该行";
        debugLog("seek.giveup", { handle: handle, why: "reached-top", down: st.down, up: st.up });
        return { found: false, gaveUp: true };
      }
      if (st.dir === "down" && atBottom()) {
        st.giveUpReason = "已到列表底部仍未找到该行";
        debugLog("seek.giveup", { handle: handle, why: "reached-bottom", down: st.down, up: st.up });
        return { found: false, gaveUp: true };
      }

      // 兜底刹车：单方向步数用完，或单目标耗时超预算
      var bound = C.planSeekBounds(st.dir, st.dir === "up" ? st.up : st.down);
      if (bound.exhausted) {
        st.giveUpReason = "定位步数用尽，仍未找到该行";
        debugLog("seek.giveup", { handle: handle, why: "steps-exhausted", down: st.down, up: st.up });
        return { found: false, gaveUp: true };
      }
      if (Date.now() - st.startedAt > SEEK_TIME_BUDGET_MS) {
        st.giveUpReason = "定位超时，仍未找到该行";
        debugLog("seek.giveup", { handle: handle, why: "time-budget", down: st.down, up: st.up });
        return { found: false, gaveUp: true };
      }

      return { found: false, gaveUp: false };
    }

    // 直接定位到第一个目标：名单通常在列表后段，从顶部重爬既慢又晃眼
    var firstTarget = nextTarget();
    if (firstTarget) {
      state.run.current = firstTarget.handle;
      if (!recentUserScroll(SEEK_GRACE_MS)) {
        var firstCell = findCellByHandle(firstTarget.handle);
        var firstY = firstCell
          ? getScrollTop() + firstCell.getBoundingClientRect().top - getViewportOriginTop()
          : scannedPositions.get(firstTarget.handle);
        if (Number.isFinite(firstY)) {
          scrollToY(Math.max(0, firstY - getViewportHeight() / 2));
          debugLog("seek.direct", { handle: firstTarget.handle, y: firstY });
          await sleep(SEEK_SETTLE_MS);
        }
      }
      await seekStep(firstTarget.handle);
    }

    var consecutiveFailures = 0;
    var guard = 0;

    while (queue.size > 0 && !state.run.abort && guard < 1200) {
      guard += 1;

      // 每轮开始前重新确认页面身份：与任务启动时的快照比较，
      // 而不是与可能已被路由更新过的 state.mode/state.owner 比较
      if (!verifyPage(state.run.page).ok) {
        state.run.abort = true;
        state.notice = "页面已切换，任务中止";
        break;
      }

      var actedThisPass = false;
      var cells = Array.from(document.querySelectorAll(C.SELECTORS.userCell));
      if (!opts || opts.oldestFirst !== false) cells.reverse();

      for (var i = 0; i < cells.length; i += 1) {
        if (state.run.abort) break;
        var cell = cells[i];
        if (!cell.isConnected) continue;

        var rec = readCell(cell);
        if (!rec.handle || !queue.has(rec.handle)) continue;

        var target = queue.get(rec.handle);
        queue.delete(rec.handle);
        actedThisPass = true;

        state.run.current = target.handle;
        state.run.seeking = false;
        state.run.waiting = false;
        state.notice = "正在处理 @" + target.handle + "（" + (state.run.done + 1) + "/" + state.run.total + "）";
        render();

        // 单账号超过 3s 没有任何进展 → 状态栏说明「等待页面响应」，不假装还在正常跑
        var slowTimer = window.setTimeout(function () {
          if (state.run.active && state.run.current === target.handle) {
            state.run.waiting = true;
            render();
          }
        }, 3000);

        markBusy(cell);
        var outcome = await unfollowOne(cell, target);
        window.clearTimeout(slowTimer);
        state.run.waiting = false;
        clearBusy();
        state.run.done += 1;

        if (outcome.status === "success") {
          state.run.groups.success.push({ handle: target.handle, reason: outcome.reason });
          consecutiveFailures = 0;
          /*
           * 成功后立即更新本页内存状态，统计和复选框不用等重新扫描：
           *  - 清理模式：该账号已被取关，不再是「未回关」候选，从本页名单移除
           *    （真实 X 的关注列表随后也不会再展示它）；
           *  - 回关模式：按钮已翻成「正在关注」，转为「已回关」，行保留且复选框禁用。
           * 结果未知 / 失败 / 跳过的账号保持原状，下次扫描再核实。
           */
          var doneRow = state.rows.get(target.handle);
          if (doneRow) {
            if (state.mode === C.MODE.REPLY) {
              doneRow.relation = C.REL.MUTUAL;
              doneRow.reason = "已回关";
            } else {
              state.rows.delete(target.handle);
              var doneIdx = state.order.indexOf(target.handle);
              if (doneIdx !== -1) state.order.splice(doneIdx, 1);
            }
          }
          syncCheckboxes();
        } else if (outcome.status === "blocked") {
          state.run.groups.failed.push({ handle: target.handle, reason: outcome.reason });
          state.run.abort = true;
          state.notice = "已停止：" + outcome.reason;
          if (state.scheduledRun && state.scheduledRun.active) state.scheduledRun.pauseRequired = true;
        } else if (outcome.status === "aborted") {
          queue.set(target.handle, target);
          state.run.done -= 1;
          state.run.abort = true;
          state.notice = "已停止：" + outcome.reason;
        } else if (outcome.status === "skipped") {
          state.run.groups.skipped.push({ handle: target.handle, reason: outcome.reason });
          consecutiveFailures += 1;
          setTempNotice("跳过 @" + target.handle + "：" + outcome.reason, 2800);
        } else {
          state.run.groups.unknown.push({ handle: target.handle, reason: outcome.reason });
          consecutiveFailures += 1;
          if (state.scheduledRun && state.scheduledRun.active) {
            state.run.abort = true;
            state.scheduledRun.pauseRequired = true;
            state.notice = "结果未知，已停止；请先人工复查";
          }
        }

        if (consecutiveFailures >= 3) {
          state.run.abort = true;
          state.notice = "连续 3 个账号未成功，已自动停止";
          // 定时任务：普通连续失败也要按“失败周期”上报，后台累计到阈值后暂停任务
          if (state.scheduledRun && state.scheduledRun.active) {
            state.scheduledRun.stopReason = "consecutive-failures";
            state.scheduledRun.pauseRequired = false;   // 不是限流/未知，不要求本周期立即暂停
          }
        }

        render();

        if (!state.run.abort) {
          var gap = state.mode === C.MODE.REPLY
            ? 800 + Math.floor(Math.random() * 500)
            : 120 + Math.floor(Math.random() * 140);
          await sleep(gap);
        }
      }

      if (state.run.abort) break;

      if (!actedThisPass) {
        var pending = nextTarget();
        if (!pending) break;
        state.run.current = pending.handle;
        state.run.seeking = true;
        render();

        var seeked = await seekStep(pending.handle);
        state.run.seeking = false;

        if (seeked.gaveUp) {
          // 双向都找不到：明确归类为「跳过」并写清原因，绝不静默吞掉
          queue.delete(pending.handle);
          state.run.done += 1;
          state.run.groups.skipped.push({
            handle: pending.handle,
            reason: (seekState && seekState.giveUpReason) ? seekState.giveUpReason : "未在页面中找到该行"
          });
          setTempNotice("跳过 @" + pending.handle + "：页面中找不到该行", 2800);
          debugLog("target.skipped", { handle: pending.handle, down: seekState.down, up: seekState.up });
          render();
        }
      }
    }

    // 队列剩余：因中止而未处理的记为「未处理」，正常跑完仍找不到的记为「跳过」
    var aborted = state.run.abort;
    queue.forEach(function (row) {
      if (aborted) {
        state.run.groups.pending.push({ handle: row.handle, reason: "任务中止，未处理" });
      } else {
        state.run.groups.skipped.push({ handle: row.handle, reason: "未在页面中找到该行（可能已不在列表）" });
      }
    });

    state.run.active = false;
    state.run.abort = false;
    state.run.seeking = false;
    state.run.waiting = false;
    state.phase = "done";
    syncCheckboxes();

    var g = state.run.groups;
    var isReply = state.mode === C.MODE.REPLY;
    var summary;
    if (g.failed.length === 0 && g.unknown.length === 0 && g.skipped.length === 0 &&
        g.pending.length === 0 && g.success.length > 0) {
      summary = isReply
        ? "已回关 " + g.success.length + " 个账号。"
        : "已取消关注 " + g.success.length + " 个账号。";
    } else if (g.success.length === 0) {
      summary = isReply ? "本批没有账号被确认回关。请检查失败原因。" : "本批没有账号被确认取关。请检查失败原因后再决定是否继续。";
    } else {
      summary = "成功 " + g.success.length + "，失败 " + g.failed.length +
        "，跳过 " + g.skipped.length + "，结果未知 " + g.unknown.length +
        "，未处理 " + g.pending.length;
    }
    if (aborted) summary += "（任务被中止）";

    state.notice = summary;
    state.warning = "";
    applyFilterToCss();
    syncCheckboxes();
    render();

    U.showResult({
      groups: g,
      summary: summary,
      // 结果窗口里的「定位」按钮：跳到该账号所在行并高亮，方便人工复查
      onLocate: function (handle) { void locateHandle(handle); }
    });
    releaseRunLock();

    // 重新扫描以刷新关系状态（只更新内存，不自动滚动）。
    // 中止（路由切换/限流/未知结果）不刷新：onRouteChange 等已清空面板，
    // 这里再 harvest 会把旧行合并回来（routeswitch 断言的面板残留根因）。
    if (g.success.length > 0 && !aborted) {
      setTimeout(function () {
        if (state.phase !== "done" || state.run.active) return;
        harvest();
        render();
      }, 800);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 动作分发                                                            */
  /* ------------------------------------------------------------------ */

  /** 扩展被重新加载/更新后，旧页面里的 chrome.runtime 会失效；这里给出可操作的提示 */
  function extensionAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (err) { return false; }
  }
  var EXTENSION_GONE = "扩展已更新或重新加载，请刷新 X 页面后重试";

  /** 打开定时任务管理对话框 */
  async function openScheduledDialog() {
    if (!extensionAlive()) { U.toast(EXTENSION_GONE); return; }
    var tasks = { cleanup: null, followback: null };
    try {
      if (chrome.runtime && chrome.runtime.sendMessage) {
        tasks = await chrome.runtime.sendMessage({ type: "XFM_SCHED_GET_TASKS" });
      }
    } catch (err) { /* 使用默认值 */ }
    U.showScheduledDialog({
      tasks: tasks,
      account: readSelfHandle(),
      batchLimit: state.batchLimit,
      onSave: function (taskKey, task) {
        if (!extensionAlive()) return Promise.resolve({ ok: false, reason: EXTENSION_GONE });
        task.taskKey = taskKey;
        var expectedMode = taskKey === "followback" ? C.MODE.REPLY : C.MODE.CLEANUP;
        // 启用（含重新启用已有授权任务）一律要求当前对应列表已完成扫描：
        // 授权绑定的是“扫描时的账号+名单状态”，隔次启用不能沿用旧授权跳过校验
        if (task.enabled && (state.phase !== "scanned" || state.mode !== expectedMode || !verifyExecutionAllowed(state.scan.page).ok)) {
          U.toast("请先完成对应列表的扫描");
          return Promise.resolve({ ok: false, reason: "请先完成对应列表的扫描并确认账号" });
        }
        if (task.enabled) task.authorized = true;
        return chrome.runtime.sendMessage({ type: "XFM_SCHED_SAVE_TASK", taskKey: taskKey, task: task });
      },
      onExecute: function (taskKey, task) {
        if (!extensionAlive()) { U.toast(EXTENSION_GONE); return; }
        chrome.runtime.sendMessage({ type: "XFM_SCHED_CLAIM_NOW", taskKey: taskKey, account: task.account, options: { count: task.count, order: task.order } }).then(function (claim) {
          if (!claim || !claim.ok) { U.toast((claim && claim.reason) || "任务无法启动"); return; }
          void handleScheduledRun({ taskKey: taskKey, taskType: taskKey, count: task.count, order: task.order, account: task.account, batchLimit: claim.batchLimit, strictMode: claim.strictMode, excluded: claim.excluded, due: Date.now(), runId: claim.runId, manual: true });
        }).catch(function () { U.toast(EXTENSION_GONE); });
      },
      onStop: function (taskKey) {
        if (state.scan.active) { stopScan(); return true; }
        if (state.run.active) {
          state.run.abort = true;
          state.notice = "已请求停止：当前账号处理完后不再继续";
          render();
          return true;
        }
        return false;
      },
      onClearRecords: function (taskKey) {
        if (!extensionAlive()) return Promise.resolve({ ok: false, reason: EXTENSION_GONE });
        return chrome.runtime.sendMessage({ type: "XFM_SCHED_CLEAR_RECORDS", taskKey: taskKey });
      }
    });
  }

  function handleAction(act) {
    if (act === "sched") { void openScheduledDialog(); return; }
    if (act === "scan") {
      if (state.phase === "scanning") return;
      var canResume = state.phase === "partial" && state.rows.size > 0;
      // 重新扫描会回到顶部并清空勾选；不是大损失但要提前说一声
      if (!canResume && state.selected.size > 0) {
        U.toast("重新扫描：将回到顶部，当前勾选会被清空");
      }
      void startScan(canResume);
    } else if (act === "stop") {
      if (state.scan.active) stopScan();
      else if (state.run.active) {
        state.run.abort = true;
        state.notice = "已请求停止：当前账号处理完后不再继续";
        render();
      }
    } else if (act === "pauseScan") {
      // 扫描中手动暂停/继续；页面隐藏不会碰这个状态
      if (!state.scan.active) return;
      state.scan.userPaused = !state.scan.userPaused;
      if (state.scan.userPaused) {
        state.notice = "已暂停";
        void saveScanProgress(true);   // 暂停时补存
      } else {
        state.scan.pendingRecheck = true; // 继续时重新评估加载与空闲
        state.notice = "继续扫描…";
      }
      render();
    } else if (act === "recover-yes") {
      void restoreScan();
    } else if (act === "recover-no") {
      // 丢弃的是横幅展示的那份进度：携带它所见代次，
      // 若其他窗口已开始新一轮扫描（代次递增），协调服务会跳过本次清除
      var discardedGeneration = state.savedProgress ? state.savedProgress.generation : null;
      void clearSavedProgress(discardedGeneration).then(function (result) {
        if (!result || result.ok !== false) U.toast("已丢弃保存的扫描进度");
        render();
      });
    } else if (act === "auto") {
      autoSelect();
    } else if (act === "clear") {
      clearSelection();
    } else if (act === "exclude-mode") {
      state.excludeMode = !state.excludeMode;
      state.hint = state.excludeMode
        ? "排除模式下，点击复选框会把账号加入排除名单"
        : "";
      syncCheckboxes();
      render();
    } else if (act === "collapse") {
      state.collapsed = !state.collapsed;
      saveSettings();
      render();
    } else if (act === "roster") {
      openRoster();
    } else if (act === "unfollow") {
      void runUnfollow();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期与路由                                                      */
  /* ------------------------------------------------------------------ */

  var lastPathname = "";
  var watchdogTimer = 0;
  var routeTimer = 0;

  function activate() {
    var page = detectPage();
    if (!page) {
      if (state.uiMounted) unmountUi();
      return;
    }
    state.mode = page.mode;
    if (state.mountedPath !== location.pathname) {
      state.owner = page.handle || null;
      state.selfHandle = readSelfHandle();
      state.mountedPath = location.pathname;
    }
    if (!mountUi()) return;
    applyFilterToCss();
    syncCheckboxes();
    render();
    // 回到本列表（含刷新后）检查有没有命中当前页面的未完成扫描进度
    void checkSavedProgress();
  }

  function onRouteChange() {
    var page = detectPage();
    if (!page) {
      if (state.scan.active) stopScan();
      if (state.run.active) {
        state.run.abort = true;
        state.phase = "done";
      }
      unmountUi();
      return;
    }
    // 切换账号或切换模式（关注↔粉丝）→ 立即终止旧任务再清数据。
    // 必须在更新 state.mode/state.owner 之前做：运行中的循环靠这两个字段
    // 做身份校验，先更新它们会让旧队列通过校验、继续在新列表上执行。
    var listChanged = state.owner !== page.handle || page.mode !== state.mode ||
      (!page.handle && state.mountedPath.replace(/\/$/, "") !== location.pathname.replace(/\/$/, ""));
    if (listChanged) {
      U.cancelDialog();
      if (state.scan.active) stopScan();
      if (state.run.active) {
        state.run.abort = true;
        state.notice = "列表已切换，任务中止";
        debugLog("run.abortRoute", { from: state.owner, to: page.handle, mode: page.mode });
      }
      state.excludeMode = false;
      state.rows.clear();
      state.order = [];
      state.selected.clear();
      state.savedProgress = null;
      clearReconcileState();
      state.phase = state.run.active ? state.phase : "idle";
      state.notice = state.run.active ? state.notice : "";
      state.warning = "";
    }
    state.mode = page.mode;
    state.owner = page.handle || null;
    state.selfHandle = readSelfHandle();
    activate();
  }

  function startRouteWatch() {
    lastPathname = location.pathname;
    routeTimer = window.setInterval(function () {
      if (location.pathname !== lastPathname) {
        lastPathname = location.pathname;
        onRouteChange();
      }
    }, ROUTE_POLL_MS);
    window.addEventListener("popstate", function () {
      if (location.pathname !== lastPathname) {
        lastPathname = location.pathname;
        onRouteChange();
      }
    });
  }

  function startWatchdog() {
    watchdogTimer = window.setInterval(function () {
      var page = detectPage();
      if (!page) return;
      if (!U.isMounted()) {
        state.uiMounted = false;
        activate();
        return;
      }
      // 面板被 X 的渲染移除后重挂
      var host = U.getHost();
      if (host && !host.isConnected) {
        state.uiMounted = false;
        activate();
        return;
      }
      syncCheckboxes();
      var hostEl = U.getHost();
      if (hostEl) hostEl.style.top = resolveStickyTop() + "px";
    }, WATCHDOG_MS);
  }

  // 虚拟列表滚动后会复用行节点，需要把复选框与筛选标记重新贴到新行上
  var scrollSyncTimer = 0;
  function scheduleScrollSync() {
    if (state.scan.active || state.run.active) return;
    window.clearTimeout(scrollSyncTimer);
    scrollSyncTimer = window.setTimeout(function () {
      syncCheckboxes();
      render();
    }, 180);
  }

  /* ------------------------------------------------------------------ */
  /* 与 popup 通信                                                       */
  /* ------------------------------------------------------------------ */

  function buildPopupStatus() {
    var stats = C.countStats(currentRows(), state.selected, candidateRel());
    return {
      url: location.href,
      isFollowing: detectPage() !== null,
      mode: state.mode,
      owner: state.owner,
      phase: state.phase,
      scanning: state.scan.active,
      running: state.run.active,
      total: stats.total,
      oneWay: stats.oneWay,
      mutual: stats.mutual,
      unknown: stats.unknown,
      selected: stats.selected,
      runDone: state.run.done || 0,
      runTotal: state.run.total || 0,
      excluded: state.excluded.size,
      candidateLabel: state.mode === C.MODE.REPLY ? "待回关" : "未回关",
      actionLabel: state.mode === C.MODE.REPLY ? "回关" : "取关",
      notice: state.notice || defaultStatus()
    };
  }

  function registerMessaging() {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) return;
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || typeof msg.type !== "string") return undefined;
      if (msg.type === "XFM_GET_STATUS") {
        sendResponse(buildPopupStatus());
        return true;
      }
      if (msg.type === "XFM_STOP") {
        if (state.scan.active) stopScan();
        if (state.run.active) {
          state.run.abort = true;
          state.notice = "已请求停止";
          render();
        }
        sendResponse({ ok: true, status: buildPopupStatus() });
        return true;
      }
      if (msg.type === "XFM_OPEN_ROSTER") {
        openRoster();
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === "XFM_FOCUS_PANEL") {
        var host = U.getHost();
        if (host) host.scrollIntoView({ block: "center", behavior: "smooth" });
        sendResponse({ ok: !!host });
        return true;
      }
      if (msg.type === "XFM_SETTINGS_CHANGED") {
        // 弹窗里清空排除名单等操作也要立刻刷新页面行的排除标记
        void loadSettings().then(function () { syncCheckboxes(); render(); });
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === "XFM_SCHEDULED_RUN") {
        void handleScheduledRun(msg).catch(function () { void recordScheduledSkip(msg.taskKey, "定时任务启动失败", msg.runId); });
        sendResponse({ ok: true });
        return true;
      }
      return undefined;
    });
  }

  /* ------------------------------------------------------------------ */
  /* 定时任务运行模式                                                     */
  /* ------------------------------------------------------------------ */

  var lastUserClickAt = 0;
  (function trackClicks() {
    function userInput(event) { if (event.isTrusted) lastUserClickAt = Date.now(); }
    document.addEventListener("pointerdown", userInput, { capture: true, passive: true });
    document.addEventListener("keydown", userInput, { capture: true, passive: true });
  })();

  /** 用户最近 2 分钟内有真实操作（点击/输入/手动滚动） */
  function userActiveRecently() {
    return !document.hidden && (Date.now() - lastUserClickAt < 2 * 60 * 1000 ||
           Date.now() - lastUserScrollAt < 2 * 60 * 1000 && lastUserScrollAt > programmaticScrollAt);
  }

  async function handleScheduledRun(msg) {
    if (state.scheduledRun && state.scheduledRun.active && state.scheduledRun.runId === msg.runId) return;
    if (state.scan.active || state.run.active || (state.scheduledRun && state.scheduledRun.active)) {
      U.toast("已有任务运行，定时任务跳过");
      void recordScheduledSkip(msg.taskKey, "已有任务运行", msg.runId);
      return;
    }
    // 身份校验：当前页面的登录账号与任务绑定账号一致
    var page = detectPage();
    var self = readSelfHandle();
    if (msg.resume) {
      for (var ready = 0; !self && ready < 20; ready++) { await sleep(250); self = readSelfHandle(); }
    }
    if (!self || !msg.account || self.toLowerCase() !== String(msg.account).toLowerCase() || (page && page.handle && page.handle.toLowerCase() !== self.toLowerCase())) {
      U.toast("定时任务跳过：无法确认登录账号");
      void recordScheduledSkip(msg.taskKey, "身份不可确认", msg.runId);
      return;
    }
    // 确定目标路径；批次上限用“周期开始时的快照”，运行中修改设置不影响本周期
    var runBatchLimit = Number.isInteger(msg.batchLimit) ? C.sanitizeBatchLimit(msg.batchLimit) : state.batchLimit;
    if (!Number.isInteger(msg.count) || msg.count < 1 || msg.count > runBatchLimit) {
      U.toast("定时任务人数超过当前单批上限");
      void recordScheduledSkip(msg.taskKey, "人数超过当前单批上限", msg.runId);
      return;
    }
    var targetPath = "/" + self + (msg.taskType === "followback" ? "/followers" : "/following");
    // 前台近 2 分钟有用户操作 → 询问
    if (!msg.manual && !msg.resume && userActiveRecently()) {
      var temporaryPanel = !U.isMounted();
      if (temporaryPanel) U.mountPanel(null, {});
      U.toast("定时任务准备开始，现在执行吗？请在 " + (5 * 60 / 60 | 0) + " 分钟内确认");
      var confirmed = await U.confirmScheduled((msg.due || Date.now()) + 5 * 60 * 1000);
      if (temporaryPanel && !detectPage()) U.unmountPanel();
      if (!confirmed) {
        U.toast("定时任务已跳过本次");
        void recordScheduledSkip(msg.taskKey, "用户未确认", msg.runId);
        return;
      }
    }
    // 路由到正确列表
    if (readSelfHandle() !== self || state.scan.active || state.run.active || (!msg.manual && !msg.resume && Date.now() > msg.due + 5 * 60 * 1000)) {
      void recordScheduledSkip(msg.taskKey, "页面状态已变化或超过启动窗口", msg.runId);
      return;
    }
    var expectedPath = targetPath;
    if (location.pathname !== expectedPath) {
      // 需要导航到对应列表
      U.toast("正在切换到" + (msg.taskType === "followback" ? "粉丝" : "关注") + "列表…");
      var navigation = await chrome.runtime.sendMessage({ type: "XFM_SCHED_PREPARE_NAVIGATION", runId: msg.runId, targetPath: expectedPath });
      if (!navigation || !navigation.ok) { void recordScheduledSkip(msg.taskKey, "无法安全切换列表", msg.runId); return; }
      window.location.assign(expectedPath);
      return;
    }
    // 先建立本地运行上下文，再让后台进入 scanning；
    // 这样后台若先因阶段超时中断，页面不会继续扫描并反复保存失败。
    state.scheduledRun = {
      active: true,
      taskKey: msg.taskKey,
      taskType: msg.taskType,
      count: msg.count || 20,
      order: msg.order || "desc",
      account: self,
      batchLimit: runBatchLimit,
      strictModeSnapshot: msg.strictMode !== false,
      excludedSnapshot: new Set((Array.isArray(msg.excluded) ? msg.excluded : []).filter(function (h) { return typeof h === "string" && h; })),
      due: msg.due,
      runId: msg.runId,
      startedAt: Date.now()
    };
    var scanMark = await chrome.runtime.sendMessage({ type: "XFM_SCHED_MARK_SCANNING", runId: msg.runId });
    if (!scanMark || !scanMark.ok) {
      state.scheduledRun.active = false;
      void recordScheduledSkip(msg.taskKey, "任务状态已变化", msg.runId);
      return;
    }
    // 开始扫描（复用现有逻辑，含安全校验）
    await startScan(false);
    if (state.scheduledRun && state.scheduledRun.active && !state.scan.active && state.phase !== "scanned") {
      await finishScheduledRun("failed", state.notice || "扫描未完成");
    }
  }

  function recordScheduledSkip(taskKey, reason, runId) {
    if (!hasChromeStorage()) return;
    chrome.runtime.sendMessage({
      type: "XFM_SCHED_RECORD_SKIP",
      taskKey: taskKey,
      runId: runId,
      reason: reason,
      at: Date.now()
    }).then(function (result) { if (!result || !result.ok) U.toast("未能保存定时任务记录"); }).catch(function () { U.toast("未能保存定时任务记录"); });
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    await loadSettings();
    registerStorageSync();
    registerMessaging();
    startRouteWatch();
    startWatchdog();
    debugLog("boot", { version: VERSION, path: location.pathname, debug: state.debug, mode: state.mode });
    window.addEventListener("scroll", scheduleScrollSync, { passive: true, capture: true });
    window.addEventListener("wheel", markUserScroll, { passive: true, capture: true });
    window.addEventListener("touchmove", markUserScroll, { passive: true, capture: true });
    // 拖动滚动条、按 PageUp/Down 也要算用户接管；程序化滚动后 150ms 内的 scroll 事件忽略
    window.addEventListener("scroll", function () {
      if (Date.now() - programmaticScrollAt > 150) markUserScroll();
    }, { passive: true, capture: true });
    window.addEventListener("keydown", markUserScrollKey, { capture: true });
    // 页面可见性：不再暂停扫描，只更新状态与复核标记。
    // 手动暂停（state.scan.userPaused）与页面隐藏是两回事，互不影响。
    document.addEventListener("visibilitychange", function () {
      if (!state.scan.active) return;
      if (document.hidden) {
        state.scan.hidden = true;
        if (!state.scan.userPaused) {
          state.notice = "后台扫描中，速度可能降低（已扫描 " + state.rows.size + " 人）";
        }
      } else {
        state.scan.hidden = false;
        // 前台复核：重新检查页面、加载状态并采集；手动暂停的任务保持暂停
        state.scan.pendingRecheck = true;
        if (!state.scan.userPaused) state.notice = "已回到前台，继续扫描";
      }
      render();
    });
    // 刷新/关闭前的兜底补存（尽力而为，不保证成功；丢失范围取决于最后一次成功保存的时间）
    window.addEventListener("pagehide", function () {
      if (state.scan.active || state.phase === "partial") saveScanProgress(true);
    });
    activate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { void boot(); }, { once: true });
  } else {
    void boot();
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
