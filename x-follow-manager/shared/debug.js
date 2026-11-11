/**
 * debug.js — 调试日志底座
 *
 * 设计原则：默认完全静默。关闭时不写控制台、不产生任何可见输出，
 * 只在内存里留一个空缓冲，避免给日常使用增加噪音。
 *
 * 开启方式（任一命中即可）：
 *   1. 弹窗设置里打开「调试日志」（写入 xfm.settings.v1.debug）；
 *   2. 页面 URL 带 ?xfmdebug=1（临时排查，不改设置）；
 *   3. localStorage["xfm.debug"] = "1"（测试台/自动化用）。
 *
 * 日志落在 globalThis.__xfmLogs（环形缓冲，上限 500 条），
 * 排查时在控制台执行 __xfmLogs 即可看到完整时间线。
 */
(function initXfmDebug(global) {
  "use strict";

  if (global.XFMDebug) return;

  var MAX_ENTRIES = 500;
  var buffer = [];
  global.__xfmLogs = buffer;   // 始终存在，关闭时为空数组

  var settingsEnabled = false;

  function paramEnabled() {
    try {
      if (typeof location === "undefined") return false;
      return new URLSearchParams(location.search).get("xfmdebug") === "1";
    } catch (err) { return false; }
  }

  function localEnabled() {
    try {
      return !!global.localStorage && global.localStorage.getItem("xfm.debug") === "1";
    } catch (err) { return false; }
  }

  var api = {
    /** 由 content.js 在读取设置后调用 */
    setSettingsEnabled: function (value) { settingsEnabled = value === true; },
    /** 三处开关任一打开即生效 */
    enabled: function () { return settingsEnabled || paramEnabled() || localEnabled(); },
    /**
     * 写一条日志。data 只用可序列化的普通对象，禁止塞 DOM 节点。
     * 任何异常都在内部吞掉：日志绝不能影响主流程。
     */
    log: function (tag, data) {
      try {
        if (!api.enabled()) return;
        var entry = { at: Date.now(), tag: String(tag || "") };
        if (data !== undefined) entry.data = data;
        buffer.push(entry);
        if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
      } catch (err) { /* 忽略 */ }
    },
    dump: function () { return buffer.slice(); },
    clear: function () { buffer.length = 0; }
  };

  global.XFMDebug = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
