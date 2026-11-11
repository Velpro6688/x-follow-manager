/**
 * popup.js — 工具栏弹窗
 *
 * 职责：显示当前页面状态、提供名单入口 / 停止入口与最小设置。
 * 不读取、不展示任何账号名单（名单只在页面内的窗口里渲染）。
 */
(function () {
  "use strict";

  var STORAGE_KEY = "xfm.settings.v1";
  var DEFAULTS = { batchLimit: 50, quantity: 50, strictMode: true, filter: "one-way", collapsed: false, debug: false, excluded: [], language: "auto" };

  var el = {
    card: document.getElementById("stateCard"),
    dot: document.getElementById("dot"),
    title: document.getElementById("stateTitle"),
    desc: document.getElementById("stateDesc"),
    chip: document.getElementById("modeChip"),
    progress: document.getElementById("progress"),
    progressBar: document.getElementById("progressBar"),
    scanHint: document.getElementById("scanHint"),
    stats: document.getElementById("stats"),
    total: document.getElementById("sTotal"),
    oneWay: document.getElementById("sOneWay"),
    selected: document.getElementById("sSelected"),
    unknown: document.getElementById("sUnknown"),
    excluded: document.getElementById("sExcluded"),
    labOneWay: document.getElementById("labOneWay"),
    focusBtn: document.getElementById("focusBtn"),
    rosterBtn: document.getElementById("rosterBtn"),
    stopBtn: document.getElementById("stopBtn"),
    reloadBtn: document.getElementById("reloadBtn"),
    limit: document.getElementById("limitInput"),
    strict: document.getElementById("strictInput"),
    debug: document.getElementById("debugInput"),
    resetBtn: document.getElementById("resetBtn"),
    settingsError: document.getElementById("settingsError"),
    excludedCount: document.getElementById("excludedCount"),
    clearExcludedBtn: document.getElementById("clearExcludedBtn"),
    lang: document.getElementById("langInput")
  };

  var currentTab = null;
  var savedSettings = DEFAULTS;

  function isXUrl(url) {
    return typeof url === "string" && /^https:\/\/(x|twitter)\.com\//.test(url);
  }

  /** 关注列表与粉丝列表都是受支持的入口（回关模式在粉丝页） */
  function isListUrl(url) {
    return typeof url === "string" &&
      /^https:\/\/(x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}|i\/user\/\d+)\/(?:following|followers)\/?(?:[?#]|$)/.test(url);
  }

  function setState(tone, title, desc) {
    if (el.card) el.card.setAttribute("data-tone", tone || "");
    if (el.dot) el.dot.setAttribute("data-tone", tone || "");
    el.title.textContent = title;
    el.desc.textContent = desc;
  }

  function showProgress(mode, percent) {
    if (!el.progress) return;
    el.progress.hidden = !mode;
    if (!mode) return;
    el.progress.setAttribute("data-mode", mode);
    if (mode === "run") {
      el.progressBar.style.width = Math.max(0, Math.min(100, percent || 0)) + "%";
    } else {
      el.progressBar.style.width = "";
    }
  }

  function sendToTab(message) {
    return new Promise(function (resolve) {
      if (!currentTab || currentTab.id == null) { resolve(null); return; }
      try {
        chrome.tabs.sendMessage(currentTab.id, message, function (response) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response || null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  function loadSettings() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(STORAGE_KEY, function (data) {
        var saved = (data && data[STORAGE_KEY]) || {};
        resolve({
          batchLimit: Number.isFinite(saved.batchLimit) ? saved.batchLimit : DEFAULTS.batchLimit,
          quantity: Number.isFinite(saved.quantity) ? saved.quantity : DEFAULTS.quantity,
          strictMode: typeof saved.strictMode === "boolean" ? saved.strictMode : DEFAULTS.strictMode,
          filter: saved.filter === "all" ? "all" : "one-way",
          collapsed: typeof saved.collapsed === "boolean" ? saved.collapsed : DEFAULTS.collapsed,
          debug: typeof saved.debug === "boolean" ? saved.debug : DEFAULTS.debug,
          excluded: Array.isArray(saved.excluded) ? saved.excluded : [],
          language: typeof saved.language === "string" ? saved.language : DEFAULTS.language
        });
      });
    });
  }

  async function saveSettings(settings) {
    try {
      var result = await chrome.runtime.sendMessage({ type: "XFM_COORD_SETTINGS", patch: settings });
      if (!result || !result.ok) throw new Error("设置保存失败");
      savedSettings = Object.assign({}, savedSettings, settings, result.settings);
    } catch (err) {
      renderSettings(savedSettings);
      el.settingsError.hidden = false;
      return false;
    }
    el.settingsError.hidden = true;
    void sendToTab({ type: "XFM_SETTINGS_CHANGED" });
    return true;
  }

  function htmlLang(code) {
    var map = { zh: "zh-CN", en: "en", ja: "ja", ko: "ko", de: "de", fr: "fr", es: "es", pt: "pt-BR", ru: "ru" };
    return map[code] || "en";
  }

  function applyLanguage(code) {
    if (!window.XFMI18N) return;
    var lang = XFMI18N.setLanguage(code, true);
    XFMI18N.apply(document);
    document.documentElement.lang = htmlLang(lang);
    document.title = XFMI18N.t("popup.title");
    if (lastStatus) renderStatus(lastStatus);
  }

  function renderSettings(settings) {
    applyLanguage(settings.language);
    if (el.lang) el.lang.value = settings.language;
    el.limit.value = String(settings.batchLimit);
    el.strict.checked = settings.strictMode;
    if (el.debug) el.debug.checked = settings.debug;
    renderExcluded(Array.isArray(settings.excluded) ? settings.excluded.length : 0);
  }

  async function initSettings() {
    savedSettings = await loadSettings();
    renderSettings(savedSettings);

    if (el.lang) el.lang.addEventListener("change", async function () {
      var value = el.lang.value;
      if (await saveSettings({ language: value })) applyLanguage(value);
    });

    el.limit.addEventListener("change", async function () {
      var value = parseInt(el.limit.value, 10);
      if (!Number.isFinite(value)) value = DEFAULTS.batchLimit;
      value = Math.min(200, Math.max(1, Math.floor(value)));
      el.limit.value = String(value);
      await saveSettings({ batchLimit: value });
    });

    el.strict.addEventListener("change", async function () {
      await saveSettings({ strictMode: el.strict.checked });
    });

    if (el.debug) {
      el.debug.addEventListener("change", async function () {
        await saveSettings({ debug: el.debug.checked });
      });
    }

    el.clearExcludedBtn.addEventListener("click", async function () {
      if (await saveSettings({ excluded: [] })) renderExcluded(0);
    });

    el.resetBtn.addEventListener("click", async function () {
      // 重置阈值与开关，但保留排除名单，避免误删用户手动保护的账号
      if (!await saveSettings({
        batchLimit: DEFAULTS.batchLimit,
        quantity: DEFAULTS.quantity,
        strictMode: DEFAULTS.strictMode,
        filter: DEFAULTS.filter,
        collapsed: DEFAULTS.collapsed,
        debug: DEFAULTS.debug
      })) return;
      renderSettings(savedSettings);
      // 操作反馈：按钮短暂变为「已恢复」，避免用户不确定是否生效
      var original = el.resetBtn.textContent;
      el.resetBtn.textContent = "已恢复默认 ✓";
      el.resetBtn.disabled = true;
      setTimeout(function () {
        el.resetBtn.textContent = original;
        el.resetBtn.disabled = false;
      }, 1500);
    });
  }

  function renderExcluded(count) {
    if (el.excludedCount) el.excludedCount.textContent = String(count);
    if (el.clearExcludedBtn) el.clearExcludedBtn.hidden = count === 0;
  }

  var lastStatus = null;
  var actionsWired = false;
  var pollTimer = null;

  function wireActions() {
    if (actionsWired) return;
    actionsWired = true;

    el.reloadBtn.addEventListener("click", function () {
      if (currentTab && currentTab.id != null) chrome.tabs.reload(currentTab.id);
      window.close();
    });
    el.rosterBtn.addEventListener("click", function () {
      void sendToTab({ type: "XFM_OPEN_ROSTER" });
      window.close();
    });
    el.focusBtn.addEventListener("click", function () {
      void sendToTab({ type: "XFM_FOCUS_PANEL" });
      window.close();
    });
    el.stopBtn.addEventListener("click", async function () {
      await sendToTab({ type: "XFM_STOP" });
      window.close();
    });
  }

  /** 只更新界面，不重复绑定事件；扫描/执行期间由轮询反复调用 */
  function renderStatus(status) {
    lastStatus = status;
    var isReply = status.mode === "reply";

    if (el.chip) {
      el.chip.hidden = false;
      el.chip.textContent = isReply ? "粉丝回关" : "关注清理";
    }
    if (el.labOneWay) el.labOneWay.textContent = status.candidateLabel || (isReply ? "待回关" : "未回关");

    el.stats.hidden = false;
    el.total.textContent = String(status.total || 0);
    el.oneWay.textContent = String(status.oneWay || 0);
    el.selected.textContent = String(status.selected || 0);
    el.unknown.textContent = String(status.unknown || 0);
    if (el.excluded) el.excluded.textContent = String(status.excluded || 0);

    var hasRows = (status.total || 0) > 0;
    el.rosterBtn.hidden = !hasRows;
    el.rosterBtn.textContent = isReply ? "查看待回关名单" : "查看未回关名单";

    el.focusBtn.hidden = false;
    el.reloadBtn.hidden = true;

    var running = status.scanning || status.running;
    el.stopBtn.hidden = !running;

    var actionName = isReply ? "回关" : "取关";
    if (el.scanHint) el.scanHint.hidden = !status.scanning;
    if (status.scanning) {
      setState("run", "扫描中", status.notice || "正在滚动加载列表，可随时停止");
      showProgress("indeterminate");
    } else if (status.running) {
      setState("run", "正在批量" + actionName, status.notice || "可点击下方按钮停止");
      var total = Math.max(1, status.runTotal || 0);
      showProgress("run", 100 * Math.min(1, (status.runDone || 0) / total));
    } else if (status.phase === "failed") {
      setState("bad", "扫描失败", status.notice || "请刷新页面后重试");
      showProgress("");
    } else if (status.phase === "partial") {
      setState("bad", "结果不完整", status.notice || "已保留已扫描部分，可回到页面继续扫描");
      showProgress("");
    } else if (status.phase === "scanned") {
      setState("ok", "已完成扫描",
        "识别到 " + status.oneWay + " 个" + (status.candidateLabel || "未回关") +
        "，共扫描 " + status.total + " 个。");
      showProgress("");
    } else {
      setState("", "已就绪", "页面顶部的管理面板可开始扫描。扫描为只读，不会修改任何账号。");
      showProgress("");
    }
  }

  async function refreshStatus() {
    var status = await sendToTab({ type: "XFM_GET_STATUS" });
    if (!status) {
      // 页面未接入：只提示一次，不反复覆盖其他状态
      if (!lastStatus) {
        setState("bad", "页面尚未接入", "扩展刚安装或更新后，需要刷新一次 X 页面才能生效。");
        el.reloadBtn.hidden = false;
        wireActions();
      }
      return;
    }
    wireActions();
    renderStatus(status);
  }

  async function initPage() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs && tabs[0] ? tabs[0] : null;
    var url = currentTab ? (currentTab.url || currentTab.pendingUrl || "") : "";

    if (!isXUrl(url)) {
      setState("", "当前不是 X 页面", "打开 x.com 并登录，再进入你自己账号的关注或粉丝列表。");
      return;
    }

    if (!isListUrl(url)) {
      setState("", "不在关注或粉丝列表", "打开你自己主页的「正在关注」或「关注者」，页面顶部会出现管理面板。");
      return;
    }

    await refreshStatus();
    // 扫描/批量执行时数字要跟着页面走；弹窗关闭后定时器自动销毁
    if (!pollTimer) pollTimer = setInterval(refreshStatus, 300);
  }

  void initSettings();
  void initPage();
})();
