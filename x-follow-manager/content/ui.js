/**
 * ui.js — 页面内界面层
 *
 * 全部界面放在 Shadow DOM 中，避免与 X 的样式互相污染。
 * 只负责「渲染 + 事件回调」，不持有业务状态。
 *
 * 视觉令牌来自 shared/tokens.js，与工具栏弹窗共用同一套变量。
 */
(function initXfmUi(global) {
  "use strict";

  if (global.XFMUI) return;

  var HOST_ATTR = "data-xfm-panel-host";
  var ROW_ATTR = "data-xfm-row";
  var CHECK_ATTR = "data-xfm-select";
  var STYLE_ID = "xfm-page-style";
  var Z_INDEX = 2147483000;
  var L = function (key, vars) { return global.XFMI18N ? global.XFMI18N.t(key, vars) : key; };
  var WEEK_LOCALES = { zh: "zh-CN", en: "en-US", ja: "ja-JP", ko: "ko-KR", de: "de-DE", fr: "fr-FR", es: "es-ES", pt: "pt-BR", ru: "ru-RU" };
  function weekdayName(index) {
    try {
      var lang = global.XFMI18N ? global.XFMI18N.lang() : "en";
      return new Intl.DateTimeFormat(WEEK_LOCALES[lang] || "en-US", { weekday: "long" }).format(new Date(2024, 0, 7 + index));
    } catch (err) {
      return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][index];
    }
  }

  var panel = null;       // shadow root
  var hostEl = null;
  var handlers = {};
  var dialogEl = null;
  var lastFocus = null;

  /* ------------------------------------------------------------------ */
  /* 主题                                                                */
  /* ------------------------------------------------------------------ */

  function parseRgb(value) {
    if (!value) return null;
    var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  function detectTheme() {
    try {
      var body = document.body;
      if (body) {
        var raw = window.getComputedStyle(body).backgroundColor || "";
        var bg = parseRgb(raw);
        if (bg) {
          var luma = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255;
          // rgba(0,0,0,0) 会被解析成 0,0,0，需要用 alpha 排除
          if (raw.indexOf("rgba") === -1 || !/,\s*0\s*\)$/.test(raw)) {
            return luma < 0.5 ? "dark" : "light";
          }
        }
      }
      var html = document.documentElement;
      var scheme = (window.getComputedStyle(html).colorScheme || html.style.colorScheme || "").toLowerCase();
      if (scheme.indexOf("dark") !== -1) return "dark";
      if (scheme.indexOf("light") !== -1) return "light";
    } catch (err) { /* 忽略：退化到系统偏好 */ }

    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    } catch (err2) { /* 忽略 */ }
    return "light";
  }

  function applyTheme() {
    if (!hostEl) return;
    var theme = detectTheme();
    hostEl.setAttribute("data-xfm-theme", theme);
    // host 本身在 X 的页面里，需要一层与主题一致的底色，避免圆角处透出页面色
    hostEl.style.background = theme === "dark" ? "#16181c" : "#ffffff";
  }

  var themeObserver = null;

  function startThemeWatch() {
    if (themeObserver) return;
    applyTheme();
    themeObserver = new MutationObserver(function () { applyTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-color-mode"] });
    if (document.body) {
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    }
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
    } catch (err) { /* 旧浏览器忽略 */ }
  }

  /* ------------------------------------------------------------------ */
  /* 页面级样式（复选框占位）                                             */
  /* ------------------------------------------------------------------ */

  function ensurePageStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "[" + ROW_ATTR + '="1"]{position:relative !important;}',
      "[" + CHECK_ATTR + "]{position:absolute;left:4px;top:32px;",
      "width:28px;height:28px;display:flex;align-items:center;justify-content:center;",
      "cursor:pointer;z-index:3;box-sizing:border-box;border-radius:6px;",
      "-webkit-tap-highlight-color:transparent;}",
      "[" + CHECK_ATTR + "]:hover{background:rgba(29,155,240,.12);}",
      "[" + CHECK_ATTR + '][data-disabled="1"]{cursor:not-allowed;opacity:.4;}',
      "[" + CHECK_ATTR + "] input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none;}",
      "[" + CHECK_ATTR + "] .xfm-box{width:18px;height:18px;border-radius:4px;",
      "border:1.5px solid rgba(83,100,113,.75);background:transparent;",
      "display:flex;align-items:center;justify-content:center;box-sizing:border-box;",
      "transition:background .12s ease,border-color .12s ease;}",
      "[" + CHECK_ATTR + '][data-armed="1"] .xfm-box{border-style:dashed;border-color:#f4212e;}',
      "[" + CHECK_ATTR + '][data-checked="1"] .xfm-box{background:#1d9bf0;border-color:#1d9bf0;}',
      "[" + CHECK_ATTR + "] .xfm-box::after{content:'';width:5px;height:9px;",
      "border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg) translate(-1px,-1px);",
      "opacity:0;transition:opacity .1s ease;}",
      "[" + CHECK_ATTR + '][data-checked="1"] .xfm-box::after{opacity:1;}',
      "[" + CHECK_ATTR + '][data-mode="mutual"] .xfm-box{border-style:dashed;border-color:rgba(83,100,113,.45);}',
      "[" + CHECK_ATTR + '][data-excluded="1"] .xfm-box{border-color:#f4212e;background:rgba(244,33,46,.14);}',
      "[" + CHECK_ATTR + '][data-excluded="1"] .xfm-box::after{content:\'\';width:11px;height:2px;background:#f4212e;border:none;transform:rotate(-45deg);opacity:1;border-radius:1px;}',
      '[data-xfm-excluded="1"]{opacity:.55;}',
      "[data-xfm-busy='1']{outline:2px solid #1d9bf0 !important;outline-offset:-3px;border-radius:10px;",
      "background:rgba(29,155,240,.08) !important;}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------------ */
  /* 复选框                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 在用户行左侧注入或同步复选框。
   * @param {Element} cell  [data-testid="UserCell"]
   * @param {{handle:string, checked:boolean, excluded:boolean, disabled:boolean,
   *          mode:string, armed:boolean, title:string, onToggle:Function, onExclude:Function}} opts
   */
  function ensureCheckbox(cell, opts) {
    if (!cell || !opts || !opts.handle) return null;
    var mount = cell.parentElement;
    if (!mount) return null;

    ensurePageStyle();

    var node = mount.querySelector(":scope > [" + CHECK_ATTR + "]");
    // 节点被虚拟列表复用给别的账号：重新绑定，不能沿用旧勾选状态
    if (node && node.getAttribute("data-handle") !== opts.handle) {
      node.setAttribute("data-handle", opts.handle);
      node.setAttribute("data-checked", "0");
      var inner = node.querySelector("input");
      if (inner) inner.checked = false;
    }

    if (!node) {
      node = document.createElement("label");
      node.setAttribute(CHECK_ATTR, "1");
      node.setAttribute("data-handle", opts.handle);
      node.setAttribute("role", "checkbox");
      node.setAttribute("tabindex", "0");
      node.innerHTML = '<input type="checkbox" tabindex="-1"><span class="xfm-box"></span>';
      node.addEventListener("click", onCheckboxClick, true);
      node.addEventListener("keydown", onCheckboxKey, true);
      node.addEventListener("contextmenu", onCheckboxContext, true);
      node.addEventListener("pointerdown", function (e) { e.stopPropagation(); }, true);
      mount.insertBefore(node, cell);
      mount.setAttribute(ROW_ATTR, "1");
    }

    if (!node.parentElement || node.parentElement !== mount) {
      mount.insertBefore(node, cell);
      mount.setAttribute(ROW_ATTR, "1");
    }

    var armed = !!opts.armed;
    node.setAttribute("data-checked", opts.checked ? "1" : "0");
    node.setAttribute("aria-checked", opts.checked ? "true" : "false");
    node.setAttribute("data-disabled", opts.disabled ? "1" : "0");
    node.setAttribute("data-mode", opts.mode || "candidate");
    node.setAttribute("data-excluded", opts.excluded ? "1" : "0");
    node.setAttribute("data-armed", armed ? "1" : "0");
    node.setAttribute("aria-label", armed ? "排除此账号" : "选择此账号");
    node.setAttribute("title", opts.title || "");
    var input = node.querySelector("input");
    if (input) input.checked = !!(opts.checked && !opts.excluded);

    node.__xfmToggle = opts.onToggle || null;
    node.__xfmExclude = opts.onExclude || null;
    node.__xfmArmed = armed;
    return node;
  }

  /** 右键复选框 = 切换「排除」（保留这个真实关注的人） */
  function onCheckboxContext(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    var node = event.currentTarget;
    if (node.getAttribute("data-disabled") === "1") return;
    if (typeof node.__xfmExclude === "function") node.__xfmExclude();
  }

  function onCheckboxClick(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    var node = event.currentTarget;
    if (node.getAttribute("data-disabled") === "1") return;

    // 排除模式：左键即排除；Alt/Option + 左键在任何模式下都排除
    if (node.__xfmArmed || (event && event.altKey)) {
      if (typeof node.__xfmExclude === "function") node.__xfmExclude();
      return;
    }

    var next = node.getAttribute("data-checked") !== "1";
    node.setAttribute("data-checked", next ? "1" : "0");
    node.setAttribute("aria-checked", next ? "true" : "false");
    var input = node.querySelector("input");
    if (input) input.checked = next;
    if (typeof node.__xfmToggle === "function") node.__xfmToggle(next);
  }

  function onCheckboxKey(event) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    onCheckboxClick(event);
  }

  function removeCheckboxes(scope) {
    var root = scope || document;
    var nodes = root.querySelectorAll("[" + CHECK_ATTR + "]");
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var mount = node.parentElement;
      node.remove();
      if (mount) mount.removeAttribute(ROW_ATTR);
    }
    var rows = root.querySelectorAll("[" + ROW_ATTR + "]");
    for (var j = 0; j < rows.length; j += 1) rows[j].removeAttribute(ROW_ATTR);
    var labeled = root.querySelectorAll("[data-xfm-rel]");
    for (var k = 0; k < labeled.length; k += 1) labeled[k].removeAttribute("data-xfm-rel");
    var excl = root.querySelectorAll("[data-xfm-excluded]");
    for (var m = 0; m < excl.length; m += 1) excl[m].removeAttribute("data-xfm-excluded");
  }

  function removeCheckbox(cell) {
    if (!cell || !cell.parentElement) return;
    var mount = cell.parentElement;
    var node = mount.querySelector(":scope > [" + CHECK_ATTR + "]");
    if (node) node.remove();
    mount.removeAttribute(ROW_ATTR);
    // 关系标记挂在更外层的行容器上，必须一并清理，否则筛选会残留
    var rowEl = typeof cell.closest === "function" ? cell.closest('[data-testid="cellInnerDiv"]') : null;
    if (rowEl) {
      rowEl.removeAttribute("data-xfm-rel");
      rowEl.removeAttribute("data-xfm-excluded");
    }
  }

  /* ------------------------------------------------------------------ */
  /* 面板样式                                                            */
  /* ------------------------------------------------------------------ */

  var T = global.XFMTokens || {
    toCss: function () { return ""; }
  };

  var TOKEN_CSS = [
    T.toCss("light", ":host([data-xfm-theme='light'])"),
    T.toCss("dark", ":host([data-xfm-theme='dark'])")
  ].join("\n");

  var PANEL_CSS = [
    ":host{all:initial;display:block;font-family:var(--font-family,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif);}",
    TOKEN_CSS,
    "*{box-sizing:border-box;margin:0;padding:0;}",
    "[hidden]{display:none !important;}",
    "button{font-family:inherit;}",
    ".wrap{background:var(--bg,#fff);border-bottom:1px solid var(--bd);color:var(--tx);font-size:12px;line-height:1.4;position:relative;}",
    ".row{display:flex;align-items:center;gap:8px;padding:8px 12px;}",
    ".row.tools{flex-wrap:wrap;gap:6px;}",
    ".tools-sep{width:1px;height:18px;background:var(--bd);flex:none;margin:0 2px;}",
    ".row.tools .btn{padding:0 8px;}",
    ".row.tools .field span{display:none;}",,
    ".row+.row{border-top:1px solid var(--bd2);}",
    ".dot{width:8px;height:8px;border-radius:50%;background:var(--tx3);flex:none;transition:background .2s,box-shadow .2s;}",
    ".dot[data-tone='run']{background:var(--accent);box-shadow:0 0 0 3px var(--accentBg);}",
    ".dot[data-tone='ok']{background:var(--ok);}",
    ".dot[data-tone='bad']{background:var(--danger);}",
    ".brand{font-weight:700;font-size:12.5px;letter-spacing:.2px;white-space:nowrap;}",
    ".metrics{display:flex;align-items:baseline;gap:14px;margin-left:4px;min-width:0;overflow:hidden;}",
    ".metric{display:inline-flex;align-items:baseline;gap:5px;white-space:nowrap;}",
    ".metric b{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.2px;}",
    ".metric i{font-size:10px;font-style:normal;color:var(--tx2);letter-spacing:.2px;}",
    ".metric.key b{color:var(--accent);}",
    ".metric.dim b{color:var(--tx2);font-weight:600;font-size:13px;}",
    ".metric.dim i{color:var(--tx2);opacity:.85;}",
    ".metric.on b{color:var(--tx);}",
    ".metric.warn b{color:var(--warn);}",
    ".metricbtn{border:1px solid transparent;background:var(--accentBg);padding:2px 7px;margin:-2px 0;",
    "font:inherit;color:inherit;cursor:pointer;border-radius:var(--r-sm);gap:4px;}",
    ".metricbtn::after{content:'›';color:var(--accent);font-size:13px;line-height:1;opacity:.75;}",
    ".metricbtn:hover{border-color:rgba(29,155,240,.35);}",
    ".metricbtn:hover i{color:var(--accent);}",
    ".metricbtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}",
    ".state{margin-left:auto;font-size:10.5px;color:var(--tx2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px;}",
    ".state[data-tone='run']{color:var(--accent);}",
    ".state[data-tone='ok']{color:var(--ok);}",
    ".state[data-tone='bad']{color:var(--danger);}",
    ".icon{width:24px;height:24px;border:0;background:transparent;color:var(--tx2);border-radius:var(--r-sm);",
    "cursor:pointer;font-size:11px;line-height:1;display:grid;place-items:center;flex:none;}",
    ".icon:hover{background:var(--bg3);color:var(--tx);}",
    ".icon:focus-visible,.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}",
    ".seg{display:inline-flex;background:var(--bg2);border:1px solid var(--bd2);border-radius:var(--r-md);padding:2px;flex:none;}",
    ".seg button{border:0;background:transparent;color:var(--tx2);font-size:11.5px;font-weight:600;",
    "padding:4px 8px;border-radius:var(--r-sm);cursor:pointer;transition:background .12s,color .12s;white-space:nowrap;}",
    ".seg button:hover{color:var(--tx);}",
    ".seg button.on{background:var(--bg);color:var(--tx);box-shadow:0 1px 2px rgba(0,0,0,.08);}",
    ".field{display:inline-flex;align-items:center;gap:6px;color:var(--tx2);font-size:11px;flex:none;}",
    ".field span{white-space:nowrap;}",
    ".field input{width:46px;height:var(--h-ctl);border:1px solid var(--bd);border-radius:var(--r-sm);background:var(--bg2);",
    "color:var(--tx);padding:0 7px;font-size:12px;font-family:inherit;font-variant-numeric:tabular-nums;text-align:center;}",
    ".field input:focus{outline:none;border-color:var(--accent);background:var(--bg);box-shadow:0 0 0 2px var(--accentBg);}",
    ".field input::-webkit-outer-spin-button,.field input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}",
    ".btn{height:var(--h-ctl);padding:0 11px;border:1px solid var(--bd);background:var(--bg);color:var(--tx);",
    "border-radius:var(--r-md);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;",
    "display:inline-flex;align-items:center;gap:5px;transition:background .12s,border-color .12s,color .12s,opacity .12s;}",
    ".btn:hover:not(:disabled){background:var(--bg3);}",
    ".btn:active:not(:disabled){transform:translateY(.5px);}",
    ".btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}",
    ".btn:disabled{opacity:.45;cursor:not-allowed;}",
    ".btn.accent{background:var(--accent);border-color:var(--accent);color:#fff;}",
    ".btn.accent:hover:not(:disabled){background:var(--accentHover);border-color:var(--accentHover);}",
    ".btn.danger{background:var(--danger);border-color:var(--danger);color:#fff;}",
    ".btn.danger:hover:not(:disabled){background:var(--dangerHover);border-color:var(--dangerHover);}",
    ".btn.danger:disabled{background:var(--bg2);border-color:var(--bd2);color:var(--tx3);}",
    ".btn.ghost{background:transparent;border-color:transparent;color:var(--tx2);}",
    ".btn.ghost:hover:not(:disabled){background:var(--bg3);color:var(--tx);}",
    ".btn.ghost.on{background:var(--dangerBg);border-color:rgba(244,33,46,.28);color:var(--danger);}",
    ".btn.stop{background:var(--dangerBg);border-color:transparent;color:var(--danger);}",
    ".btn.stop:hover:not(:disabled){background:var(--dangerBg);}",
    ".btn .num{font-variant-numeric:tabular-nums;}",
    ".btn.mini{height:22px;padding:0 9px;font-size:10.5px;border-radius:var(--r-sm);margin-left:6px;}",
    ".sched-section{margin:0 18px 10px;padding:10px 12px;border:1px solid var(--bd2);border-radius:var(--r-lg);background:var(--bg2);}",
    ".sched-section h4{margin:0 0 8px;font-size:13px;}",
    ".sched-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}",
    ".sched-head h4{margin:0;}",
    ".sched-group{border-top:1px solid var(--bd2);padding-top:10px;margin-top:10px;}",
    ".sched-group:first-of-type{border-top:0;padding-top:0;margin-top:0;}",
    ".sched-group-title{font-size:10.5px;font-weight:700;color:var(--tx3);letter-spacing:.4px;margin-bottom:6px;}",
    ".sched-actions-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}",
    ".btn.outline{background:transparent;border-color:var(--accent);color:var(--accent);}",
    ".btn.outline:hover:not(:disabled){background:var(--accentBg);}",
    ".sched-row{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap;}",
    ".sched-row label{font-size:11px;color:var(--tx2);min-width:72px;}",
    ".sched-row select,.sched-row input[type=time],.sched-row input[type=number],.sched-row input[type=date]{height:var(--h-ctl);border:1px solid var(--bd);border-radius:var(--r-sm);background:var(--bg);color:var(--tx);padding:0 6px;font-size:12px;}",
    ".sched-row select{min-width:90px;}",
    ".sched-row input[type=number]{width:60px;}",
    ".sched-row input[type=time]{width:80px;}",
    ".sched-note{font-size:11px;color:var(--tx2);line-height:1.5;}",

    ".sched-toggle{display:flex;align-items:center;gap:6px;cursor:pointer;}",
    ".sched-toggle input{accent-color:var(--accent);}",
    ".sched-next{font-size:11px;color:var(--tx2);margin:6px 0;}",
    ".sched-next b{color:var(--tx);}",
    ".sched-status{font-size:11px;margin:4px 0;}",
    ".sched-status[data-ok]{color:var(--ok);}",
    ".sched-status[data-bad]{color:var(--danger);}",
    ".sched-records{margin:8px 18px;max-height:200px;overflow-y:auto;border:1px solid var(--bd2);border-radius:var(--r-lg);background:var(--bg2);}",
    ".sched-records .rrow{font-size:11px;}",
    ".sched-tabs{display:flex;gap:5px;padding:0 18px 10px;}",
    ".sched-summary{margin:6px 18px;padding:6px 10px;border-radius:var(--r-md);background:var(--accentBg);font-size:11px;color:var(--tx);}",
    ".sched-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:10px 18px 16px;flex-wrap:wrap;row-gap:6px;}",
    // .dlg>* 会固定子项高度；这里显式允许内容区滚动，避免小窗口下底部按钮被裁掉
    ".dlg .sched-body{flex:1 1 auto;min-height:0;overflow-y:auto;}",
    ".btn.mini{height:22px;padding:0 9px;font-size:10.5px;border-radius:var(--r-sm);margin-left:6px;}",
    ".grow{flex:1 1 auto;min-width:4px;}",
    ".row.tools[data-locked='1']{opacity:.5;pointer-events:none;}",
    ".row.run{background:var(--bg2);}",
    ".track{flex:1 1 auto;height:6px;background:var(--bg3);border-radius:999px;overflow:hidden;position:relative;min-width:60px;}",
    ".track i{display:block;height:100%;width:0;background:var(--accent);border-radius:999px;transition:width .25s ease;}",
    ".track[data-mode='run'] i{background:var(--ok);}",
    ".track[data-mode='indeterminate'] i{width:38%;animation:xfmSlide 1.15s ease-in-out infinite;}",
    "@keyframes xfmSlide{0%{transform:translateX(-105%);}100%{transform:translateX(305%);}}",
    ".runtext{font-size:11px;color:var(--tx2);white-space:nowrap;font-variant-numeric:tabular-nums;}",
    ".runtext b{color:var(--tx);}",
    // 提示/警告条浮在面板下方，不占文档流：出现或消失都不会改变页面高度，
    // 避免右键排除等操作触发滚动位置跳动（真实 X 的虚拟列表会被放大成「拉回顶部」）
    ".msgs{position:absolute;left:0;right:0;top:100%;z-index:4;display:flex;flex-direction:column;",
    "gap:6px;padding:8px 12px 2px;pointer-events:none;}",
    ".msgs .msg{margin:0;box-shadow:var(--shadow);pointer-events:auto;}",
    ".msg{margin:0 12px 8px;padding:6px 9px;border-radius:var(--r-md);font-size:11px;line-height:1.5;border:1px solid transparent;}",
    ".sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}",
    ".msg.info{background-color:var(--bg2);background-image:linear-gradient(var(--accentBg),var(--accentBg));",
    "color:var(--accent);border-color:rgba(29,155,240,.22);}",
    ".msg.warn{background-color:var(--bg2);background-image:linear-gradient(var(--warnBg),var(--warnBg));",
    "color:var(--tx);border-color:rgba(255,212,0,.35);}",
    ".msg.warn b{color:var(--danger);}",
    ".msg.over{background-color:var(--bg2);background-image:linear-gradient(var(--warnBg),var(--warnBg));",
    "color:var(--tx);border-color:rgba(255,212,0,.35);}",
    ".msg.over b{color:var(--danger);font-variant-numeric:tabular-nums;}",
    ".msg.arm{background-color:var(--bg2);background-image:linear-gradient(var(--dangerBg),var(--dangerBg));",
    "color:var(--tx);border-color:rgba(244,33,46,.28);}",
    ".msg.arm b{color:var(--danger);}",
    ".overlay{position:fixed;inset:0;background:var(--overlay);display:flex;align-items:center;",
    "justify-content:center;z-index:" + Z_INDEX + ";padding:16px;backdrop-filter:blur(2px);}",
    ".dlg{background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:var(--r-xl);",
    "width:min(540px,100%);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;",
    "box-shadow:var(--shadow);font-size:12px;outline:none;}",
    ".dlg>*{flex:0 0 auto;}",
    ".dlg .dbody{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;}",
    ".dlg .dbody>*{flex:0 0 auto;}",
    ".dlg .dbody.fit{overflow:hidden;}",
    ".dlg .dbody.fit .list{flex:1 1 auto;min-height:96px;overflow:auto;}",
    ".dlg .strip{height:3px;background:var(--danger);border-radius:var(--r-xl) var(--r-xl) 0 0;}",
    ".dlg .strip.ok{background:var(--ok);}",
    ".dlg .strip.info{background:var(--accent);}",
    ".dlg .dhead{padding:16px 18px 10px;}",
    ".dlg .dhead h3{margin:0;font-size:16px;letter-spacing:-.2px;}",
    ".dlg .dhead p{margin:4px 0 0;color:var(--tx2);font-size:11.5px;line-height:1.5;}",
    ".facts{display:flex;flex-wrap:wrap;gap:6px;padding:0 18px 12px;}",
    ".fact{background:var(--bg2);border:1px solid var(--bd2);border-radius:var(--r-md);padding:5px 9px;font-size:11px;color:var(--tx2);}",
    ".fact b{color:var(--tx);font-size:12px;margin-left:4px;font-variant-numeric:tabular-nums;}",
    ".fact.bad b{color:var(--danger);}",
    ".dlg .list{margin:0 18px;border:1px solid var(--bd2);border-radius:var(--r-lg);overflow:hidden;",
    "background:var(--bg2);}",
    ".dlg .list.scrollable{mask-image:linear-gradient(to bottom,#000 calc(100% - 22px),transparent);}",
    ".dlg .list .item{display:flex;gap:8px;align-items:baseline;padding:6px 10px;border-bottom:1px solid var(--bd2);font-size:11.5px;}",
    ".dlg .list .item:last-child{border-bottom:0;}",
    ".dlg .list .idx{color:var(--tx3);font-variant-numeric:tabular-nums;min-width:18px;font-size:10.5px;}",
    ".dlg .list .h{font-weight:700;}",
    ".dlg .list .n{color:var(--tx2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".dlg .list .loc{margin-left:auto;flex:none;border:1px solid var(--bd);background:var(--bg);color:var(--accent);",
    "font-size:10.5px;font-weight:600;border-radius:var(--r-sm);padding:2px 8px;cursor:pointer;white-space:nowrap;}",
    ".dlg .list .loc:hover{background:var(--accentBg);border-color:rgba(29,155,240,.35);}",
    ".dlg .list .item[data-kind='failed'] .h,.dlg .list .item[data-kind='failed'] .n{color:var(--danger);}",
    ".dlg .list .item[data-kind='unknown'] .h{color:var(--warn);}",
    ".dlg .risk{margin:12px 18px 0;padding:8px 10px;border-radius:var(--r-md);background:var(--dangerBg);",
    "color:var(--tx);font-size:11px;line-height:1.55;}",
    ".dlg .risk em{font-style:normal;font-weight:700;color:var(--danger);}",
    ".dlg .ack{display:flex;gap:8px;align-items:flex-start;margin:10px 18px 0;cursor:pointer;font-size:11.5px;line-height:1.5;}",
    ".dlg .ack input{width:15px;height:15px;margin-top:1px;accent-color:var(--accent);flex:none;cursor:pointer;}",
    ".dlg .foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:14px 18px 16px;}",
    ".dlg .foot .grow{flex:1 1 auto;}",
    ".dlg .foot .btn{height:var(--h-ctl-lg);padding:0 16px;font-size:12px;}",
    ".dlg .empty{padding:18px;color:var(--tx2);text-align:center;font-size:11.5px;}",
    ".sum{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;padding:0 18px 14px;}",
    ".sum div{background:var(--bg2);border:1px solid var(--bd2);border-radius:var(--r-lg);padding:8px 10px;}",
    ".sum span{display:block;color:var(--tx2);font-size:10px;margin-bottom:2px;}",
    ".sum b{font-size:18px;font-variant-numeric:tabular-nums;letter-spacing:-.3px;}",
    ".sum div[data-tone='ok'] b{color:var(--ok);}",
    ".sum div[data-tone='bad'] b{color:var(--danger);}",
    ".sec{padding:4px 18px 0;font-size:11px;font-weight:700;color:var(--tx2);}",
    ".dlg.wide{width:min(640px,100%);}",
    ".rhint{margin:4px 0 0;font-size:10.5px;color:var(--tx3);line-height:1.5;}",
    ".pick{display:flex;align-items:center;gap:7px;padding:5px 10px;border-bottom:1px solid var(--bd2);",
    "font-size:11.5px;cursor:pointer;}",
    ".pick:last-child{border-bottom:0;}",
    ".pick:hover{background:var(--bg3);}",
    ".pick input[type='checkbox']{width:14px;height:14px;accent-color:var(--accent);flex:none;cursor:pointer;}",
    ".pick .ravatar{width:22px;height:22px;font-size:10px;}",
    ".pick .rex{width:22px;height:22px;border:1px solid var(--bd2);background:var(--bg);color:var(--tx2);font-size:12px;}",
    ".pick .rex:hover{border-color:rgba(244,33,46,.4);background:var(--dangerBg);color:var(--danger);}",
    ".pick[data-included='0']{opacity:.45;}",
    ".pick[data-excluded='1']{opacity:.4;}",
    ".pick .rtext b{font-size:11.5px;}",
    ".pick .rtext i{font-size:10px;}",
    ".rhint b{color:var(--tx2);font-weight:600;}",
    ".rbar{display:flex;align-items:center;gap:8px;padding:2px 18px 10px;}",
    ".rsearch{flex:1 1 auto;height:30px;border:1px solid var(--bd);border-radius:var(--r-md);background:var(--bg2);",
    "color:var(--tx);padding:0 10px;font-family:inherit;font-size:12px;min-width:0;}",
    ".rsearch:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accentBg);}",
    ".rsort{border:0;background:transparent;color:var(--tx2);font-size:11px;cursor:pointer;white-space:nowrap;padding:4px;}",
    ".rsort:hover{color:var(--accent);}",
    ".rtabs{display:flex;gap:5px;padding:0 18px 10px;flex-wrap:wrap;}",
    ".rtab{border:1px solid var(--bd2);background:var(--bg2);color:var(--tx2);font-size:11px;font-weight:600;",
    "padding:4px 10px;border-radius:var(--r-md);cursor:pointer;}",
    ".rtab:hover{color:var(--tx);}",
    ".rtab.on{background:var(--accentBg);border-color:rgba(29,155,240,.35);color:var(--accent);}",
    ".rlist{margin:0 18px;border:1px solid var(--bd2);border-radius:var(--r-lg);overflow:auto;",
    "flex:1 1 auto;min-height:120px;max-height:min(46vh,430px);background:var(--bg2);}",
    ".rrow{display:flex;align-items:center;gap:9px;padding:7px 10px;border-bottom:1px solid var(--bd2);cursor:pointer;font-size:12px;}",
    ".rrow:last-child{border-bottom:0;}",
    ".rrow:hover{background:var(--bg3);}",
    ".rrow[data-excluded='1']{opacity:.6;}",
    ".rrow[data-kind='mutual'],.rrow[data-kind='unknown']{cursor:default;}",
    ".rcheck{width:16px;height:16px;flex:none;border:1.5px solid var(--tx3);border-radius:4px;background:transparent;",
    "cursor:pointer;padding:0;display:grid;place-items:center;}",
    ".rcheck::after{content:'';width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;",
    "transform:rotate(45deg) translate(-1px,-1px);opacity:0;}",
    ".rrow[data-selected='1'] .rcheck{background:var(--accent);border-color:var(--accent);}",
    ".rrow[data-selected='1'] .rcheck::after{opacity:1;}",
    ".rrow[data-kind='mutual'] .rcheck,.rrow[data-kind='unknown'] .rcheck{opacity:.35;cursor:not-allowed;}",
    ".ravatar{width:30px;height:30px;border-radius:50%;flex:none;background:var(--bg3);overflow:hidden;",
    "display:grid;place-items:center;color:var(--tx2);font-size:12px;font-weight:700;}",
    ".ravatar img{width:100%;height:100%;object-fit:cover;display:block;}",
    ".rtext{display:flex;flex-direction:column;min-width:0;line-height:1.3;}",
    ".rtext b{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".rtext i{font-style:normal;color:var(--tx2);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".rtag{margin-left:auto;font-size:10px;color:var(--tx2);white-space:nowrap;flex:none;}",
    ".rex{width:24px;height:24px;flex:none;border:0;background:transparent;color:var(--tx3);border-radius:var(--r-sm);",
    "cursor:pointer;font-size:13px;line-height:1;display:grid;place-items:center;}",
    ".rex:hover{background:var(--dangerBg);color:var(--danger);}",
    ".rrow[data-excluded='1'] .rex{color:var(--danger);}",
    ".rmore{display:block;width:100%;border:0;background:transparent;color:var(--accent);font-size:11px;padding:9px;cursor:pointer;}",
    ".rfoot{display:flex;align-items:center;gap:8px;padding:10px 18px 16px;font-size:11px;color:var(--tx2);flex-wrap:wrap;}",
    ".rfoot b{color:var(--tx);font-variant-numeric:tabular-nums;}",
    ".rfoot .over{color:var(--danger);}",
    ".toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--tx);",
    "color:var(--bg);padding:8px 14px;border-radius:var(--r-lg);font-size:11.5px;z-index:" + (Z_INDEX + 1) + ";",
    "box-shadow:var(--shadow);max-width:80vw;text-align:center;font-weight:500;pointer-events:none;}",
    ".toast[data-pos='top']{top:24px;bottom:auto;}",
    ".wrap[data-collapsed='1'] .row.tools,.wrap[data-collapsed='1'] .row.run,.wrap[data-collapsed='1'] .msg{display:none;}",
    ".wrap[data-collapsed='1'] .msgs{display:none;}",
    "@supports(corner-shape:squircle){",
    ".dlg{corner-shape:squircle;border-radius:calc(var(--r-xl)*1.5);}",
    ".dlg .list,.rlist,.sum>div,.toast{corner-shape:squircle;border-radius:calc(var(--r-lg)*1.5);}",
    ".msg,.fact,.dlg .risk{corner-shape:squircle;border-radius:calc(var(--r-md)*1.5);}",
    "}",
    "@media (max-width:720px){.metric.extra{display:none;}}",
    "@media (max-width:620px){.state{max-width:90px;}.btn.ghost[data-act='clear']{display:none;}",
    ".row.tools{gap:6px;}}",
    "@media (max-width:520px){.row.tools{flex-wrap:wrap;row-gap:6px;}.btn[data-act='auto'],.btn[data-act='exclude-mode']{padding:0 8px;}}",
    "@media (max-width:480px){.brand{display:none;}}"
  ].join("\n");

  function buildPanelHtml() {
    return [
      "<style>" + PANEL_CSS + "</style>",
      '<div class="wrap" data-role="wrap" data-view="idle">',
      '  <div class="row top">',
      '    <span class="dot" data-role="dot"></span>',
      '    <span class="brand" data-role="brand" data-i18n="panel.brand">' + L("panel.brand") + '</span>',
      '    <div class="metrics">',
      '      <button class="metric key metricbtn" data-act="roster" title="查看名单：搜索、勾选、排除你想保留的人">',
      '        <b data-role="oneway">0</b><i data-role="label-candidate" data-i18n="panel.oneway">' + L("panel.oneway") + '</i>',
      "      </button>",
      '      <span class="metric"><b data-role="selected">0</b><i data-i18n="panel.selected">' + L("panel.selected") + '</i></span>',
      '      <span class="metric dim"><b data-role="unknown">0</b><i data-i18n="panel.unknown">' + L("panel.unknown") + '</i></span>',
      '      <span class="metric dim extra"><b data-role="excluded">0</b><i data-i18n="panel.excluded">' + L("panel.excluded") + '</i></span>',
      '      <span class="metric dim extra"><b data-role="total">0</b><i data-i18n="panel.scanned">' + L("panel.scanned") + '</i></span>',
      "    </div>",
      '    <span class="state" data-role="phase">未扫描</span>',
      '    <button class="icon" data-act="collapse" aria-expanded="true" title="收起 / 展开">▾</button>',
      "  </div>",
      '  <div class="row tools" data-role="tools">',
      '    <div class="seg">',
      '      <button data-filter="one-way" class="on" data-role="filter-candidate" title="突出显示未回关账号，列表仍保留全部行" data-i18n="panel.filter.candidate">' + L("panel.filter.candidate") + '</button>',
      '      <button data-filter="all" data-i18n="panel.filter.all">' + L("panel.filter.all") + '</button>',
      "    </div>",
      '    <label class="field" title="自动选择一次挑多少个（1–5000），只是默认建议值：手动勾选不受它限制；一次最多执行多少个由弹窗里的「单批上限」决定"><span data-i18n="panel.qty">' + L("panel.qty") + '</span><input type="number" min="1" max="5000" step="1" value="50" data-role="qty" aria-label="自动选择数量"></label>',
      '    <button class="btn ghost" data-act="auto" data-i18n="panel.auto">' + L("panel.auto") + '</button>',
      '    <span class="tools-sep" aria-hidden="true"></span>',
      '    <button class="btn ghost" data-act="roster" data-role="rosterBtn" title="打开名单：搜索、勾选、排除" data-i18n="panel.roster">' + L("panel.roster") + '</button>',
      '    <button class="btn ghost" data-act="exclude-mode" data-role="excludeBtn" aria-pressed="false"',
      '      title="开启后，点击复选框即加入排除名单（Alt + 点击随时可用）" data-i18n="panel.exclude">' + L("panel.exclude") + '</button>',
      '    <button class="btn ghost" data-act="sched" data-role="schedBtn" title="定时清理与定时回关" data-i18n="panel.schedule">' + L("panel.schedule") + '</button>',
      '    <button class="btn ghost" data-act="scan" data-i18n="panel.scan">' + L("panel.scan") + '</button>',
      '    <span class="grow"></span>',
      '    <button class="btn danger" data-act="unfollow" disabled data-i18n="panel.unfollowSelected">' + L("panel.unfollowSelected") + '</button>',
      "  </div>",
      '  <div class="row run" data-role="runbar" hidden>',
      '    <span class="runtext" data-role="runtext">0 / 0</span>',
      '    <div class="track" data-role="track" data-mode="indeterminate"><i data-role="bar"></i></div>',
      '    <button class="btn ghost" data-act="pauseScan" hidden>暂停</button>',
      '    <button class="btn stop" data-act="stop">停止</button>',
      "  </div>",
      '  <span class="sr-only" data-role="status" aria-live="polite"></span>',
      '  <div class="msgs" data-role="msgs">',
      '    <div class="msg over" data-role="overlimit" hidden></div>',
      '    <div class="msg info" data-role="recover" hidden>',
      '      <span data-role="recoverText"></span> ',
      '      <button type="button" class="btn mini" data-act="recover-yes">恢复扫描</button> ',
      '      <button type="button" class="btn mini ghost" data-act="recover-no">丢弃进度</button>',
      "    </div>",
      '    <div class="msg arm" data-role="armHint" hidden>',
      "      <b>排除模式</b>：点击复选框会把该账号加入排除名单，不会勾选。再点一次「排除」退出。",
      "    </div>",
      '    <div class="msg warn" data-role="scanVisibleHint" hidden>扫描期间请保持此标签页可见；窗口被完全覆盖时浏览器会暂停页面，扫描会停止。</div>',
      '    <div class="msg info" data-role="notice" hidden></div>',
      '    <div class="msg warn" data-role="warn" hidden></div>',
      "  </div>",
      "</div>"
    ].join("\n");
  }

  function mountPanel(insertAfter, callbacks) {
    handlers = callbacks || {};
    if (hostEl && hostEl.isConnected) return hostEl;

    hostEl = document.createElement("div");
    hostEl.setAttribute(HOST_ATTR, "1");
    hostEl.style.cssText = "display:block;z-index:5;";
    var shadow = hostEl.attachShadow({ mode: "open" });
    shadow.innerHTML = buildPanelHtml();
    panel = shadow;

    // 事件委托
    shadow.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var actBtn = target.closest("[data-act]");
      if (actBtn) {
        if (handlers.onAction) handlers.onAction(actBtn.getAttribute("data-act"));
        return;
      }
      var filterBtn = target.closest("[data-filter]");
      if (filterBtn && handlers.onFilter) {
        handlers.onFilter(filterBtn.getAttribute("data-filter"));
      }
    });

    var qty = shadow.querySelector('[data-role="qty"]');
    qty.addEventListener("change", function () {
      if (handlers.onQuantityChange) handlers.onQuantityChange(qty.value);
    });
    // 回车立即提交，不必先点别处
    qty.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        qty.blur();
      }
    });

    startThemeWatch();

    if (insertAfter && insertAfter.parentElement) {
      insertAfter.parentElement.insertBefore(hostEl, insertAfter.nextSibling);
    } else {
      document.body.appendChild(hostEl);
    }
    return hostEl;
  }

  function updatePanel(state) {
    if (!panel) return;
    var s = state || {};
    var q = function (role) { return panel.querySelector('[data-role="' + role + '"]'); };
    var setText = function (role, value) { var el = q(role); if (el) el.textContent = value; };

    setText("oneway", String(s.oneWay || 0));
    setText("selected", String(s.selected || 0));
    setText("status", s.status || "");
    var isReply = s.mode === "reply";
    var candidateLabel = isReply ? L("panel.replyPending") : L("panel.oneway");
    setText("brand", isReply ? L("panel.brandReply") : L("panel.brand"));
    setText("label-candidate", candidateLabel);
    setText("filter-candidate", isReply ? L("panel.filter.reply") : L("panel.filter.candidate"));
    setText("unknown", String(s.unknown || 0));
    setText("excluded", String(s.excluded || 0));
    setText("total", String(s.total || 0));

    // 主指标：有候选才用强调色；有选中才点亮「已选」
    var oneWayEl = q("oneway");
    if (oneWayEl && oneWayEl.parentElement) {
      oneWayEl.parentElement.className = "metric metricbtn" + ((s.oneWay || 0) > 0 ? " key" : "");
    }
    var selEl = q("selected");
    if (selEl && selEl.parentElement) {
      selEl.parentElement.className = "metric" + ((s.selected || 0) > 0 ? " on" : "");
    }
    var unkEl = q("unknown");
    if (unkEl && unkEl.parentElement) {
      unkEl.parentElement.className = "metric dim" + ((s.unknown || 0) > 0 ? " warn" : "");
    }

    var phaseEl = q("phase");
    if (phaseEl) {
      phaseEl.textContent = s.phaseLabel || "未扫描";
      phaseEl.setAttribute("data-tone", s.phaseTone || "");
      phaseEl.title = s.status || "";
    }
    var dot = q("dot");
    if (dot) dot.setAttribute("data-tone", s.phaseTone || "");

    var wrap = q("wrap");
    if (wrap) {
      wrap.setAttribute("data-view", s.view || "idle");
      wrap.setAttribute("data-collapsed", s.collapsed ? "1" : "0");
    }
    var collapseBtn = panel.querySelector('[data-act="collapse"]');
    if (collapseBtn) {
      collapseBtn.textContent = s.collapsed ? "▸" : "▾";
      collapseBtn.setAttribute("aria-expanded", s.collapsed ? "false" : "true");
    }

    var tools = q("tools");
    if (tools) {
      tools.hidden = !!s.hideTools;
      tools.setAttribute("data-locked", s.busy ? "1" : "0");
    }

    var runbar = q("runbar");
    if (runbar) {
      runbar.hidden = !s.runbar;
      if (s.runbar) {
        setText("runtext", s.runbar.text || "");
        var track = q("track");
        if (track) track.setAttribute("data-mode", s.runbar.mode || "run");
        var bar = q("bar");
        if (bar && s.runbar.mode !== "indeterminate") {
          bar.style.width = Math.max(0, Math.min(100, s.runbar.percent || 0)) + "%";
        }
      }
    }

    // 扫描中的「暂停/继续」：仅扫描时可见，页面隐藏不会替用户点它
    var pauseBtn = panel.querySelector('[data-act="pauseScan"]');
    if (pauseBtn) {
      var canPause = !!(s.runbar && s.runbar.canPause);
      pauseBtn.hidden = !canPause;
      pauseBtn.textContent = s.scanUserPaused ? "继续" : "暂停";
    }

    // 刷新后命中未完成进度的恢复横幅
    var recover = q("recover");
    if (recover) {
      recover.hidden = !s.savedCount;
      if (s.savedCount) {
        var recoverText = q("recoverText");
        if (recoverText) recoverText.textContent = "发现未完成扫描：已保存 " + s.savedCount + " 人";
      }
    }

    var scanBtn = panel.querySelector('[data-act="scan"]');
    if (scanBtn) {
      scanBtn.hidden = !!s.hideScan;
      scanBtn.disabled = !!s.busy;
      scanBtn.textContent = s.scanLabel || L("panel.scan");
      scanBtn.className = "btn " + (s.scanAccent ? "accent" : "ghost");
    }

    var unfollowBtn = panel.querySelector('[data-act="unfollow"]');
    if (unfollowBtn) {
      unfollowBtn.hidden = !!s.hideUnfollow;
      unfollowBtn.disabled = !s.canUnfollow;
      var actName = isReply ? L("panel.reply") : L("panel.unfollow");
      unfollowBtn.textContent = (s.selected || 0) > 0 ? actName + " " + s.selected : (isReply ? L("panel.replySelected") : L("panel.unfollowSelected"));
      unfollowBtn.title = "本批上限 " + (s.batchLimit || 50) + " 个；超出的保留为未处理";
    }

    var excludeBtn = q("excludeBtn");
    if (excludeBtn) {
      excludeBtn.classList.toggle("on", !!s.excludeMode);
      excludeBtn.setAttribute("aria-pressed", s.excludeMode ? "true" : "false");
      excludeBtn.disabled = !!s.busy || (s.oneWay || 0) === 0;
    }

    var rosterBtn = q("rosterBtn");
    if (rosterBtn) rosterBtn.disabled = (s.total || 0) === 0;

    var autoBtn = panel.querySelector('[data-act="auto"]');
    if (autoBtn) autoBtn.disabled = !s.canSelect;
    var clearBtn = panel.querySelector('[data-act="clear"]');
    if (clearBtn) clearBtn.disabled = !s.canSelect;

    panel.querySelectorAll("[data-filter]").forEach(function (btn) {
      btn.classList.toggle("on", btn.getAttribute("data-filter") === (s.filter || "one-way"));
    });

    var qty = q("qty");
    if (qty && panel.activeElement !== qty && s.quantity !== undefined) {
      qty.value = String(s.quantity);
    }

    var over = q("overlimit");
    if (over) {
      if (s.overLimit && s.overLimit.deferred > 0) {
        over.hidden = false;
        over.innerHTML = "";
        over.appendChild(document.createTextNode("已选 "));
        var b1 = document.createElement("b");
        b1.textContent = String(s.overLimit.selected);
        over.appendChild(b1);
        over.appendChild(document.createTextNode(" 个，本批最多 "));
        var b2 = document.createElement("b");
        b2.textContent = String(s.overLimit.limit);
        over.appendChild(b2);
        over.appendChild(document.createTextNode(" 个，其余 "));
        var b3 = document.createElement("b");
        b3.textContent = String(s.overLimit.deferred);
        over.appendChild(b3);
        over.appendChild(document.createTextNode(" 个保留为未处理。"));
      } else {
        over.hidden = true;
      }
    }

    var arm = q("armHint");
    if (arm) arm.hidden = !s.excludeMode;

    var visibleHint = q("scanVisibleHint");
    if (visibleHint) visibleHint.hidden = !s.scanActive;

    var notice = q("notice");
    if (notice) {
      notice.hidden = !s.notice;
      if (s.notice) notice.textContent = s.notice;
    }

    var warn = q("warn");
    if (warn) {
      if (s.warning) {
        warn.hidden = false;
        warn.innerHTML = "";
        var b = document.createElement("b");
        b.textContent = "注意：";
        warn.appendChild(b);
        warn.appendChild(document.createTextNode(s.warning));
      } else {
        warn.hidden = true;
      }
    }

    applyTheme();
  }

  function isMounted() {
    return !!(hostEl && hostEl.isConnected && panel);
  }

  function getHost() {
    return hostEl;
  }

  function unmountPanel() {
    cancelDialog();
    if (hostEl) hostEl.remove();
    hostEl = null;
    panel = null;
  }

  /* ------------------------------------------------------------------ */
  /* 对话框                                                              */
  /* ------------------------------------------------------------------ */

  function focusables(root) {
    var nodes = root.querySelectorAll('button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])');
    return Array.prototype.slice.call(nodes).filter(function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
  }

  function onDialogKey(event) {
    if (!dialogEl) return;
    if (event.key === "Escape") {
      event.preventDefault();
      var cancel = dialogEl.querySelector('[data-dlg="cancel"],[data-dlg="close"]');
      if (cancel) cancel.click();
      else closeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    var list = focusables(dialogEl);
    if (list.length === 0) return;
    var first = list[0];
    var last = list[list.length - 1];
    var active = dialogEl.getRootNode().activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function closeDialog() {
    if (dialogEl) {
      dialogEl.remove();
      dialogEl = null;
    }
    document.removeEventListener("keydown", onDialogKey, true);
    // 恢复面板自身的层叠层级，避免长期压住 X 的原生元素
    if (hostEl) hostEl.style.zIndex = "5";
    if (lastFocus && typeof lastFocus.focus === "function") {
      try { lastFocus.focus({ preventScroll: true }); } catch (err) { /* 元素可能已被移除 */ }
    }
    lastFocus = null;
  }

  function cancelDialog() {
    var cancel = dialogEl && dialogEl.querySelector('[data-dlg="cancel"], [data-dlg="close"]');
    if (cancel) cancel.click();
    else closeDialog();
  }

  function buildDialog(html, opts) {
    // 面板已被卸载（例如路由跳转）时不要继续创建弹窗，否则会抛错
    if (!panel) return null;
    closeDialog();
    // 整个 Shadow 树的层叠受 host 的 z-index 约束；X 的 sticky 标签条是 z-index:10，
    // 不抬高 host 的话，弹窗顶部会被标签条盖住。
    if (hostEl) hostEl.style.zIndex = String(Z_INDEX);
    lastFocus = document.activeElement;

    var overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = html;
    panel.appendChild(overlay);
    dialogEl = overlay;

    document.addEventListener("keydown", onDialogKey, true);

    if (!opts || opts.backdropClose !== false) {
      overlay.addEventListener("mousedown", function (event) {
        if (event.target === overlay) {
          var cancel = overlay.querySelector('[data-dlg="cancel"],[data-dlg="close"]');
          if (cancel) cancel.click();
          else closeDialog();
        }
      });
    }

    var dlg = overlay.querySelector(".dlg");
    if (dlg) {
      dlg.setAttribute("tabindex", "-1");
      var focusTarget = overlay.querySelector('[data-role="ack"]') || dlg;
      try { focusTarget.focus({ preventScroll: true }); } catch (err) { /* 忽略 */ }
    }
    return overlay;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      ta.remove();
      if (ok) resolve(); else reject(new Error("copy failed"));
    });
  }

  /**
   * 执行前确认。
   * @returns {Promise<boolean>}
   */
  function confirmUnfollow(payload) {
    return new Promise(function (resolve) {
      var rows = payload.batch || [];
      var isReply = payload.mode === "reply";
      var actName = isReply ? "回关" : "取关";
      var deferred = payload.deferred || [];

      // 每行的本地状态：是否在本批、是否已排除
      var items = rows.map(function (row) {
        return { row: row, included: true, excluded: false };
      });

      var itemsHtml = items.map(function (it) {
        var row = it.row;
        var avatar = row.avatar
          ? '<img src="' + escapeHtml(row.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
          : escapeHtml(initialOf(row));
        return '<div class="pick" data-handle="' + escapeHtml(row.handle) + '" data-included="1" data-excluded="0">' +
          '<input type="checkbox" data-role="pick" checked aria-label="纳入本批">' +
          '<span class="ravatar">' + avatar + "</span>" +
          '<span class="rtext"><b>' + escapeHtml(row.name || "") + "</b>" +
          "<i>@" + escapeHtml(row.handle) + "</i></span>" +
          '<button type="button" class="rex" data-role="ex" title="排除此账号（以后不再出现）" aria-label="排除 @' + escapeHtml(row.handle) + '（以后不再出现）" aria-pressed="false">⊘</button>' +
          "</div>";
      }).join("");
      if (!itemsHtml) itemsHtml = '<div class="empty">没有可执行的账号</div>';

      var html = [
        '<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="xfm-dlg-title">',
        '  <div class="strip"></div>',
        '  <div class="dhead">',
        '    <h3 id="xfm-dlg-title">' + (isReply ? "确认回关" : "确认取消关注") + "</h3>",
        "    <p>" + (isReply
          ? "可取消勾选或点 ⊘ 排除其中的账号，再执行。回关后如果后悔，需要逐个取消。"
          : "可取消勾选或点 ⊘ 排除其中的账号，再执行。这一步不可撤销。") + "</p>",
        '    <p class="rhint">执行时按<b>列表顺序</b>逐个处理，插件会自动滚动定位目标；你<b>手动滚动不会暂停任务</b>，短暂让出后从新位置继续找。</p>',
        '    <p class="rhint">任务结束停在<b>最后处理的位置</b>，不会带你回顶部；过程中可能出现 X 的确认弹窗，插件会自动确认。</p>',
        "  </div>",
        '  <div class="dbody fit">',
        '  <div class="facts">',
        '    <span class="fact">本批<b data-role="count">' + rows.length + "</b>个</span>",
        '    <span class="fact">单批上限<b>' + payload.limit + "</b>个</span>",
        '    <span class="fact">扫描状态<b>' + escapeHtml(payload.scanLabel) + "</b></span>",
        (deferred.length > 0
          ? '    <span class="fact bad">超出上限未处理<b>' + deferred.length + "</b>"
          : ""),
        '    <span class="fact bad" data-role="excludedFact" hidden>本次排除<b data-role="excludedCount">0</b></span>',
        "  </div>",
        '  <div class="list">' + itemsHtml + "</div>",
        '  <div class="risk">' + (isReply
          ? "X 对关注操作的风控比取关更严：短时间内大量回关容易触发限流、验证甚至账号受限。"
          : "X 对自动化操作有使用规则限制，批量取消关注可能触发限制、验证或账号处置。") +
          "<em>本工具不保证任何速度或数量是安全的。</em>请自行控制频率并承担风险。</div>",
        "  </div>",
        '  <label class="ack"><input type="checkbox" data-role="ack">' +
          "<span>我已核对名单，了解上述风险，并确认执行。</span></label>",
        '  <div class="foot">',
        '    <span class="grow"></span>',
        '    <button class="btn ghost" data-dlg="cancel">取消</button>',
        '    <button class="btn danger" data-dlg="ok" disabled>确认' + actName + " " + rows.length + " 个</button>",
        "  </div>",
        "</div>"
      ].join("\n");

      var overlay = buildDialog(html);
      if (!overlay) { resolve({ confirmed: false, batch: [] }); return; }

      var listEl = overlay.querySelector(".list");
      if (listEl && listEl.scrollHeight > listEl.clientHeight + 1) listEl.classList.add("scrollable");

      var ack = overlay.querySelector('[data-role="ack"]');
      var ok = overlay.querySelector('[data-dlg="ok"]');
      var countEl = overlay.querySelector('[data-role="count"]');
      var exCountEl = overlay.querySelector('[data-role="excludedCount"]');
      var exFact = overlay.querySelector('[data-role="excludedFact"]');

      var liveBatch = function () {
        return items.filter(function (it) { return it.included && !it.excluded; });
      };
      var settle = function () {
        var live = liveBatch();
        var excludedCount = items.filter(function (it) { return it.excluded; }).length;
        if (countEl) countEl.textContent = String(live.length);
        if (exCountEl) exCountEl.textContent = String(excludedCount);
        if (exFact) exFact.hidden = excludedCount === 0;
        ok.textContent = "确认" + actName + " " + live.length + " 个";
        ok.disabled = live.length === 0 || !ack.checked;
      };
      var findItem = function (handle) {
        for (var i = 0; i < items.length; i += 1) {
          if (items[i].row.handle === handle) return items[i];
        }
        return null;
      };
      var paint = function (it) {
        var node = overlay.querySelector('.pick[data-handle="' + it.row.handle + '"]');
        if (!node) return;
        node.setAttribute("data-included", it.included ? "1" : "0");
        node.setAttribute("data-excluded", it.excluded ? "1" : "0");
        var box = node.querySelector('[data-role="pick"]');
        if (box) box.checked = it.included && !it.excluded;
        var ex = node.querySelector('[data-role="ex"]');
        if (ex) {
          ex.textContent = it.excluded ? "↺" : "⊘";
          ex.setAttribute("aria-pressed", it.excluded ? "true" : "false");
          ex.title = it.excluded ? "恢复此账号" : "排除此账号（以后不再出现）";
        }
      };
      var setExcluded = function (it, next) {
        if (!it) return;
        it.excluded = next;
        if (next) it.included = false;
        paint(it);
        settle();
        if (typeof payload.onExclude === "function") payload.onExclude(it.row.handle, next);
      };

      overlay.addEventListener("click", function (event) {
        var t = event.target;
        if (!(t instanceof Element)) return;
        var role = t.getAttribute("data-dlg");
        if (role === "cancel") {
          closeDialog();
          resolve({ confirmed: false, batch: [] });
          return;
        }
        if (role === "ok") {
          if (!ack.checked) return;
          var live = liveBatch();
          if (live.length === 0) return;
          closeDialog();
          resolve({ confirmed: true, batch: live.map(function (it) { return it.row; }) });
          return;
        }
        var exBtn = t.closest('[data-role="ex"]');
        var rowEl = t.closest(".pick");
        if (!rowEl) return;
        var it = findItem(rowEl.getAttribute("data-handle"));
        if (!it) return;
        if (exBtn) {
          event.preventDefault();
          setExcluded(it, !it.excluded);
          return;
        }
        if (t.matches('input[type="checkbox"]')) {
          it.included = t.checked && !it.excluded;
          paint(it);
          settle();
          return;
        }
        // 点整行 = 切换勾选（已排除的行不参与）
        if (it.excluded) return;
        it.included = !it.included;
        paint(it);
        settle();
      });

      // 右键整行 = 永久排除
      overlay.addEventListener("contextmenu", function (event) {
        var rowEl = event.target instanceof Element ? event.target.closest(".pick") : null;
        if (!rowEl) return;
        event.preventDefault();
        var it = findItem(rowEl.getAttribute("data-handle"));
        setExcluded(it, !it.excluded);
      });

      ack.addEventListener("change", settle);
      settle();
    });
  }

  /**
   * 执行结果。
   */
  function showResult(payload) {
    var groups = payload.groups || {};
    var order = ["success", "failed", "skipped", "unknown", "pending"];
    var labels = {
      success: "成功", failed: "失败", skipped: "跳过",
      unknown: "结果未知", pending: "未处理"
    };
    var kinds = {
      success: "success", failed: "failed", skipped: "skipped",
      unknown: "unknown", pending: "pending"
    };

    var canLocate = typeof payload.onLocate === "function";
    var sections = order.map(function (key) {
      var list = groups[key] || [];
      if (list.length === 0) return "";
      var items = list.map(function (row) {
        // 成功的行已不在候选里，定位无意义；其余组提供「定位」跳到那一行人工复查
        var locBtn = canLocate && key !== "success"
          ? '<button type="button" class="loc" data-loc="' + escapeHtml(row.handle) + '"' +
            ' title="跳到该账号所在行并高亮">定位</button>'
          : "";
        return '<div class="item" data-kind="' + kinds[key] + '">' +
          '<span class="h">@' + escapeHtml(row.handle) + "</span>" +
          '<span class="n">' + escapeHtml(row.reason || "") + "</span>" + locBtn + "</div>";
      }).join("");
      return '<div class="sec">' + labels[key] + "（" + list.length + "）</div>" +
        '<div class="list">' + items + "</div>";
    }).join("");

    var okCount = (groups.success || []).length;
    var failedCount = (groups.failed || []).length;
    var attention = failedCount + (groups.unknown || []).length;
    var badHappened = attention > 0;

    var html = [
      '<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="xfm-dlg-title">',
      '  <div class="strip' + (badHappened ? "" : " ok") + '"></div>',
      '  <div class="dhead">',
      '    <h3 id="xfm-dlg-title">执行结果</h3>',
      "    <p>" + escapeHtml(payload.summary || "") + "</p>",
      "  </div>",
      '  <div class="dbody">',
      '  <div class="sum">',
      '    <div data-tone="ok"><span>成功</span><b>' + okCount + "</b></div>",
      '    <div data-tone="' + (failedCount > 0 ? "bad" : "") + '"><span>失败</span><b>' + failedCount + "</b></div>",
      '    <div><span>跳过</span><b>' + (groups.skipped || []).length + "</b></div>",
      '    <div data-tone="' + ((groups.unknown || []).length > 0 ? "bad" : "") + '"><span>未知</span><b>' + (groups.unknown || []).length + "</b></div>",
      '    <div><span>未处理</span><b>' + (groups.pending || []).length + "</b></div>",
      "  </div>",
      sections,
      "  </div>",
      '  <div class="foot">',
      (attention > 0 ? '    <button class="btn ghost" data-dlg="copy">复制需复查名单</button>' : ""),
      '    <span class="grow"></span>',
      '    <button class="btn accent" data-dlg="close">关闭</button>',
      "  </div>",
      "</div>"
    ].join("\n");

    var overlay = buildDialog(html);
    if (!overlay) return;

    overlay.querySelectorAll(".list").forEach(function (list) {
      if (list.scrollHeight > list.clientHeight + 1) list.classList.add("scrollable");
    });

    var copyBtn = overlay.querySelector('[data-dlg="copy"]');
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var lines = [];
        ["failed", "unknown"].forEach(function (key) {
          (groups[key] || []).forEach(function (row) {
            lines.push(labels[key] + "\t@" + row.handle + "\t" + (row.reason || ""));
          });
        });
        copyText(lines.join("\n")).then(function () {
          copyBtn.textContent = "已复制";
          window.setTimeout(function () { copyBtn.textContent = "复制需复查名单"; }, 1600);
        }).catch(function () {
          copyBtn.textContent = "复制失败";
          window.setTimeout(function () { copyBtn.textContent = "复制需复查名单"; }, 1600);
        });
      });
    }

    overlay.addEventListener("click", function (event) {
      var t = event.target;
      if (t instanceof Element && t.getAttribute("data-dlg") === "close") {
        closeDialog();
        return;
      }
      if (t instanceof Element && canLocate) {
        var loc = t.closest("[data-loc]");
        if (loc) {
          var handle = loc.getAttribute("data-loc");
          closeDialog();
          payload.onLocate(handle);
        }
      }
    });
  }


  /* ------------------------------------------------------------------ */
  /* 名单窗口（搜索 / 勾选 / 排除）                                        */
  /* ------------------------------------------------------------------ */

  var rosterCtx = null;
  var ROSTER_PAGE = 120;

  function candidateRelOf(mode) {
    return mode === "reply" ? "pending" : "one-way";
  }

  function relationTag(rel, candRel) {
    if (rel === candRel) return modeTag(candRel);
    if (rel === "mutual") return "已回关";
    return "未知";
  }

  function modeTag(candRel) {
    return candRel === "pending" ? "待回关" : "未回关";
  }

  function initialOf(row) {
    var name = String(row.name || "").replace(/^@/, "").trim();
    return name ? name.charAt(0).toUpperCase() : "?";
  }

  function rosterFiltered() {
    var ctx = rosterCtx;
    if (!ctx) return [];
    var candRel = candidateRelOf(ctx.mode);
    var q = ctx.query.trim().toLowerCase();
    var rows = ctx.rows.filter(function (row) {
      if (ctx.filter === "candidate" && row.relation !== candRel) return false;
      if (ctx.filter === "selected" && !ctx.selected.has(row.handle)) return false;
      if (ctx.filter === "excluded" && !ctx.excluded.has(row.handle)) return false;
      if (q) {
        var hay = (row.handle + " " + (row.name || "")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    if (ctx.sortOldest) rows = rows.slice().reverse();
    return rows;
  }

  function rosterRowHtml(row) {
    var ctx = rosterCtx;
    var candRel = candidateRelOf(ctx.mode);
    var isCandidate = row.relation === candRel;
    var excluded = ctx.excluded.has(row.handle);
    var selected = isCandidate && !excluded && ctx.selected.has(row.handle);
    var kind = isCandidate ? "candidate" : (row.relation === "mutual" ? "mutual" : "unknown");
    var avatar = row.avatar
      ? '<img src="' + escapeHtml(row.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : escapeHtml(initialOf(row));
    var handle = escapeHtml(row.handle);
    var name = escapeHtml(row.name || "");
    var tag = excluded ? "已排除" : relationTag(row.relation, candRel);
    return '<div class="rrow" data-handle="' + handle + '" data-kind="' + kind + '"' +
      ' data-selected="' + (selected ? "1" : "0") + '" data-excluded="' + (excluded ? "1" : "0") + '">' +
      '<button class="rcheck" type="button" role="checkbox" aria-checked="' + (selected ? "true" : "false") + '"' +
      (isCandidate ? "" : " disabled") + ' aria-label="选择 @' + handle + '"></button>' +
      '<span class="ravatar">' + avatar + "</span>" +
      '<span class="rtext"><b>' + name + "</b><i>@" + handle + "</i></span>" +
      '<span class="rtag">' + tag + "</span>" +
      (isCandidate
        ? '<button class="rex" type="button" title="' + (excluded ? "恢复此账号" : "排除此账号（保留）") + '"' +
          ' aria-pressed="' + (excluded ? "true" : "false") + '">' + (excluded ? "↺" : "⊘") + "</button>"
        : '<span class="rex" aria-hidden="true"></span>') +
      "</div>";
  }

  function renderRoster() {
    var ctx = rosterCtx;
    if (!ctx || !dialogEl) return;
    var root = dialogEl;
    var candRel = candidateRelOf(ctx.mode);
    var candidates = ctx.rows.filter(function (r) { return r.relation === candRel; });

    // 页签计数
    var counts = {
      candidate: candidates.length,
      selected: ctx.selected.size,
      excluded: ctx.excluded.size,
      all: ctx.rows.length
    };
    root.querySelectorAll("[data-rtab]").forEach(function (btn) {
      var key = btn.getAttribute("data-rtab");
      btn.classList.toggle("on", key === ctx.filter);
      btn.textContent = ({ candidate: modeTag(candRel), selected: "已选", excluded: "已排除", all: "全部" })[key] +
        " " + (counts[key] || 0);
    });

    var rows = rosterFiltered();
    var shown = rows.slice(0, ctx.shown);
    var list = root.querySelector(".rlist");
    if (list) {
      var scrollTop = list.scrollTop;
      var active = root.getRootNode().activeElement;
      var focusedRow = active && active.closest ? active.closest('.rrow') : null;
      var focusedHandle = focusedRow && focusedRow.getAttribute('data-handle');
      var focusedSelector = active && active.classList.contains('rex') ? '.rex' : '.rcheck';
      list.innerHTML = shown.length === 0
        ? '<div class="empty">' + (ctx.query ? "没有匹配的账号" : "此分类下暂无账号") + "</div>"
        : shown.map(rosterRowHtml).join("") +
          (rows.length > shown.length
            ? '<button class="rmore" type="button" data-rmore="1">显示更多（还有 ' + (rows.length - shown.length) + " 个）</button>"
            : "");

      // 头像加载失败时退回首字母，避免破图
      Array.prototype.forEach.call(list.querySelectorAll(".ravatar img"), function (img) {
        img.addEventListener("error", function () {
          var wrap = img.parentElement;
          var row = wrap && wrap.parentElement;
          var handle = row ? row.getAttribute("data-handle") : "";
          var rec = ctx.rows.find(function (r) { return r.handle === handle; });
          if (wrap) wrap.textContent = rec ? initialOf(rec) : "?";
        }, { once: true });
      });
      list.scrollTop = scrollTop;
      if (focusedHandle) {
        var nextFocus = list.querySelector('[data-handle="' + focusedHandle + '"] ' + focusedSelector);
        if (nextFocus) nextFocus.focus({ preventScroll: true });
      }
    }

    var foot = root.querySelector(".rfoot");
    if (foot) {
      var selected = ctx.selected.size;
      var over = Math.max(0, selected - ctx.limit);
      foot.innerHTML = [
        "<span>已选 <b>" + selected + "</b> 个 · 本批最多 <b>" + ctx.limit + "</b> 个</span>",
        over > 0 ? '<span class="over">超出 ' + over + " 个将保留为未处理</span>" : "",
        '<span class="grow" style="flex:1 1 auto"></span>',
        '<button class="btn ghost" type="button" data-ract="bulk">' +
        (ctx.query.trim() ? "全选匹配（当前筛选）" : "全选候选") + "</button>",
        '<button class="btn ghost" type="button" data-ract="clear"' + (selected === 0 ? " disabled" : "") + ">清空选择</button>",
        '<button class="btn accent" type="button" data-dlg="close">完成</button>'
      ].join("");
    }

    var summary = root.querySelector(".rsummary");
    if (summary) {
      summary.textContent = candidates.length + " 个" + modeTag(candRel) +
        " · 已排除 " + ctx.excluded.size + " 个";
    }
  }

  function applyRoster(patch) {
    var ctx = rosterCtx;
    if (!ctx) return;
    if (patch) {
      if (patch.selected) ctx.selected = patch.selected;
      if (patch.excluded) ctx.excluded = patch.excluded;
    }
    if (typeof ctx.onApply === "function") {
      ctx.onApply({
        selected: Array.from(ctx.selected),
        excluded: Array.from(ctx.excluded)
      });
    }
    renderRoster();
  }

  /**
   * 定时任务对话框：创建 / 查看 / 修改定时清理与定时回关。
   * @param {{tasks:object, onSave:Function, onExecute:Function, onStop:Function, onDiscardRecords:Function}} payload
   */
  function showScheduledDialog(payload) {
    var tasks = payload.tasks || {};
    var taskLabels = { cleanup: L("sched.cleanup"), followback: L("sched.followback") };
    var activeTab = "cleanup";
    var overlay = buildDialog(
      '<div class="dlg wide" role="dialog" aria-modal="true" aria-labelledby="xfm-sched-title">' +
      '<div class="strip info"></div>' +
      '<div class="dhead"><h3 id="xfm-sched-title">' + L("sched.title") + '</h3><p class="rhint">' + L("sched.desc") + '</p></div>' +
      '<div class="sched-tabs">' +
      '<button class="rtab on" data-stab="cleanup">' + L("sched.cleanup") + '</button>' +
      '<button class="rtab" data-stab="followback">' + L("sched.followback") + '</button>' +
      "</div>" +
      '<div class="sched-body" data-sbody="cleanup"></div>' +
      '<div class="sched-body" data-sbody="followback" hidden></div>' +
      '<div class="sched-actions">' +
      '<span class="grow"></span>' +
      '<button class="btn ghost" data-dlg="close">关闭</button>' +
      "</div></div>"
    );
    if (!overlay) return;

    var drafts = { cleanup: null, followback: null };

    function rowVisible(rowType, type) {
      if (rowType === "once") return type === "once";
      if (rowType === "weekly") return type === "weekly";
      if (rowType === "monthly") return type === "monthly";
      if (rowType === "time") return type === "weekly" || type === "monthly" || type === "daily";
      if (rowType === "interval") return type === "interval";
      return true;
    }

    function applyRowVisibility(body, type) {
      if (!body) return;
      body.querySelectorAll("[data-sched-row]").forEach(function (row) {
        row.hidden = !rowVisible(row.getAttribute("data-sched-row"), type);
      });
    }

    function schedSectionHtml(taskKey, task) {
      var t = task || { enabled: false, type: "weekly", dayOfWeek: 1, dayOfMonth: 1, time: "09:00",
        dailyStart: "09:00", dailyEnd: "21:00", intervalHours: 4,
        count: Math.min(20, payload.batchLimit || 20), order: "desc" };
      var typeOpts = "";
      [["once", L("sched.once")], ["daily", L("sched.daily")], ["weekly", L("sched.weekly")], ["monthly", L("sched.monthly")], ["interval", L("sched.interval")]].forEach(function (pair) {
        typeOpts += '<option value="' + pair[0] + '"' + (t.type === pair[0] ? " selected" : "") + ">" + escapeHtml(pair[1]) + "</option>";
      });
      var orderOpts = "";
      [["desc", L("sched.orderDesc")], ["asc", L("sched.orderAsc")]].forEach(function (o) {
        orderOpts += '<option value="' + o[0] + '"' + (t.order === o[0] ? " selected" : "") + ">" + escapeHtml(o[1]) + "</option>";
      });
      var dowSel = "";
      for (var d = 0; d < 7; d += 1) {
        dowSel += '<option value="' + d + '"' + (t.dayOfWeek === d ? " selected" : "") + ">" + escapeHtml(weekdayName(d)) + "</option>";
      }
      var enabled = t.enabled ? " checked" : "";
      var dtValue = t.datetime ? new Date(t.datetime - new Date(t.datetime).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
      var limit = payload.batchLimit || 20;
      var zone = escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone || L("sched.localZone"));
      var nextRun = "";
      if (t.enabled && t.nextRun) {
        try {
          nextRun = "<div class='sched-next'>" + escapeHtml(L("sched.next")) + ": <b>" +
            escapeHtml(new Date(t.nextRun).toLocaleString(undefined, { timeZone: t.timezone })) + "</b> · " +
            escapeHtml(t.timezone || L("sched.localZone")) + "</div>";
        } catch (err) {
          nextRun = "<div class='sched-next'>" + escapeHtml(L("sched.badZone")) + "</div>";
        }
      }
      var status = "";
      if (t.lastRun) {
        var lr = t.lastRun;
        status = "<div class='sched-status'" + (lr.status === "success" ? " data-ok" : lr.status !== "skipped" ? " data-bad" : "") + ">" +
          escapeHtml(L("sched.last")) + ": " + escapeHtml(lr.status || "") + " · " + escapeHtml(L("sched.stat.scanned")) + " " + (lr.scanned || 0) +
          " · " + escapeHtml(L("sched.stat.candidates")) + " " + (lr.candidates || 0) +
          " · " + escapeHtml(L("sched.stat.success")) + " " + (lr.success || 0) + " · " + escapeHtml(L("sched.stat.skipped")) + " " + (lr.skipped || 0) +
          " · " + escapeHtml(L("sched.stat.unknown")) + " " + (lr.unknown || 0) +
          (lr.reason ? " · " + escapeHtml(lr.reason) : "") + "</div>";
      }
      var records = Array.isArray(t.records) ? t.records.slice(0, 10) : [];
      var history = records.length ? '<details><summary>' + escapeHtml(L("sched.records")) + " (" + records.length + ')</summary>' + records.map(function (record) {
        var details = (Array.isArray(record.detail) ? record.detail : []).map(function (item) {
          var handle = String(item.handle || "");
          if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return "";
          return '<li><a href="https://x.com/' + encodeURIComponent(handle) + '" target="_blank" rel="noopener noreferrer">@' + escapeHtml(handle) + '</a> · ' + escapeHtml(item.status || "") + (item.reason ? ' · ' + escapeHtml(item.reason) : '') + '</li>';
        }).join("");
        return '<div class="sched-status">' + escapeHtml(new Date(record.at || 0).toLocaleString()) + ' · ' + escapeHtml(record.status || "") +
          ' · ' + escapeHtml(L("sched.stat.scanned")) + ' ' + (Number(record.scanned) || 0) + ' · ' + escapeHtml(L("sched.stat.candidates")) + ' ' + (Number(record.candidates) || 0) +
          ' · ' + escapeHtml(L("sched.stat.success")) + ' ' + (Number(record.success) || 0) + ' · ' + escapeHtml(L("sched.stat.skipped")) + ' ' + (Number(record.skipped) || 0) +
          ' · ' + escapeHtml(L("sched.stat.failed")) + ' ' + (Number(record.failed) || 0) + ' · ' + escapeHtml(L("sched.stat.unknown")) + ' ' + (Number(record.unknown) || 0) +
          (record.reason ? ' · ' + escapeHtml(record.reason) : '') + (details ? '<ul>' + details + '</ul>' : '') + '</div>';
      }).join("") + '<button class="btn ghost" data-sched-clear="' + taskKey + '">' + escapeHtml(L("sched.clear")) + '</button></details>' : "";
      var timeVisible = t.type === "weekly" || t.type === "monthly" || t.type === "daily";
      return '<div class="sched-section">' +
        '<div class="sched-head"><h4>' + escapeHtml(taskLabels[taskKey]) + '</h4>' +
        '<label class="sched-toggle" title="' + escapeHtml(L("sched.tip.ack")) + '"><input type="checkbox" data-sched="enabled"' + enabled + '> ' + escapeHtml(L("sched.enabled")) + '</label></div>' +
        '<div class="sched-group">' +
          '<div class="sched-group-title">' + escapeHtml(L("sched.group.schedule")) + '</div>' +
          '<div class="sched-row"><label>' + escapeHtml(L("sched.type")) + '</label><select data-sched="type" title="' + escapeHtml(L("sched.tip.type")) + '">' + typeOpts + '</select></div>' +
          '<div class="sched-row" data-sched-row="once"' + (t.type === "once" ? "" : " hidden") + '><label>' + escapeHtml(L("sched.datetime")) + '</label><input type="datetime-local" data-sched="datetime" value="' + dtValue + '"></div>' +
          '<div class="sched-row" data-sched-row="weekly"' + (t.type === "weekly" ? "" : " hidden") + '><label>' + escapeHtml(L("sched.weekday")) + '</label><select data-sched="dayOfWeek">' + dowSel + '</select></div>' +
          '<div class="sched-row" data-sched-row="monthly"' + (t.type === "monthly" ? "" : " hidden") + '><label>' + escapeHtml(L("sched.day")) + '</label><input type="number" min="1" max="31" step="1" data-sched="dayOfMonth" value="' + (t.dayOfMonth || 1) + '"><span class="sched-note">' + escapeHtml(L("sched.dayNote")) + '</span></div>' +
          '<div class="sched-row" data-sched-row="time"' + (timeVisible ? "" : " hidden") + '><label>' + escapeHtml(L("sched.time")) + '</label><input type="time" data-sched="time" value="' + (t.time || "09:00") + '"></div>' +
          '<div class="sched-row" data-sched-row="interval"' + (t.type === "interval" ? "" : " hidden") + '><label>' + escapeHtml(L("sched.start")) + '</label><input type="time" data-sched="dailyStart" value="' + (t.dailyStart || "09:00") + '"></div>' +
          '<div class="sched-row" data-sched-row="interval"' + (t.type === "interval" ? "" : " hidden") + '><label>' + escapeHtml(L("sched.end")) + '</label><input type="time" data-sched="dailyEnd" value="' + (t.dailyEnd || "21:00") + '"></div>' +
          '<div class="sched-row" data-sched-row="interval"' + (t.type === "interval" ? "" : " hidden") + '><label>' + escapeHtml(L("sched.step")) + '</label><input type="number" min="1" max="12" step="1" data-sched="intervalHours" value="' + (Number(t.intervalHours) || 4) + '"><span class="sched-note">' + escapeHtml(L("sched.stepNote")) + '</span></div>' +
          '<div class="sched-row" data-sched-row="interval"' + (t.type === "interval" ? "" : " hidden") + '><span class="sched-note">' + escapeHtml(L("sched.crossNote")) + '</span></div>' +
        '</div>' +
        '<div class="sched-group">' +
          '<div class="sched-group-title">' + escapeHtml(L("sched.group.run")) + '</div>' +
          '<div class="sched-row"><label>' + escapeHtml(L("sched.count")) + '</label><input type="number" min="1" max="' + limit + '" step="1" data-sched="count" title="' + escapeHtml(L("sched.tip.count")) + '" value="' + (t.count || 20) + '"><span class="sched-note">' + escapeHtml(L("sched.countNote", { n: limit })) + '</span></div>' +
          '<div class="sched-row"><label>' + escapeHtml(L("sched.order")) + '</label><select data-sched="order" title="' + escapeHtml(L("sched.tip.order")) + '">' + orderOpts + '</select></div>' +
        '</div>' +
        '<div class="sched-group">' +
          '<div class="sched-group-title">' + escapeHtml(L("sched.group.confirm")) + '</div>' +
          '<div class="sched-row sched-account">' + escapeHtml(L("sched.account", { account: payload.account || L("sched.unknownAccount"), tz: zone, limit: limit })) + '</div>' +
          '<label class="sched-row"><input type="checkbox" data-sched="ack">' + escapeHtml(L("sched.ack")) + '</label>' +
          nextRun + status + history +
          '<div class="sched-actions-row">' +
            '<button class="btn accent" data-sched-save="' + taskKey + '" title="' + escapeHtml(L("sched.tip.save")) + '">' + escapeHtml(L("sched.save")) + '</button>' +
            '<button class="btn outline" data-sched-exec="' + taskKey + '" title="' + escapeHtml(L("sched.tip.runNow")) + '">' + escapeHtml(L("sched.runNow")) + '</button>' +
            '<button class="btn stop" data-sched-stop="' + taskKey + '" title="' + escapeHtml(L("sched.tip.stop")) + '">' + escapeHtml(L("sched.stop")) + '</button>' +
          '</div>' +
        '</div>' +
        '</div>';
    }

    function renderTab(tabKey) {
      var body = overlay.querySelector('[data-sbody="' + tabKey + '"]');
      if (body) body.innerHTML = schedSectionHtml(tabKey, drafts[tabKey] || tasks[tabKey]);
    }

    // 只读 DOM，不做校验：用于切换标签/重建前保留用户已填但未保存的内容。
    function readFormRaw(tabKey) {
      var body = overlay.querySelector('[data-sbody="' + tabKey + '"]');
      if (!body || !body.querySelector('[data-sched="type"]')) return null;
      var task = Object.assign({}, tasks[tabKey] || {});
      task.enabled = body.querySelector('[data-sched="enabled"]').checked;
      task.type = body.querySelector('[data-sched="type"]').value;
      task.count = Number(body.querySelector('[data-sched="count"]').value);
      task.order = body.querySelector('[data-sched="order"]').value;
      var timeEl = body.querySelector('[data-sched="time"]');
      if (timeEl && timeEl.value) task.time = timeEl.value;
      if (task.type === "once") {
        var dt = body.querySelector('[data-sched="datetime"]');
        task.datetime = dt && dt.value ? new Date(dt.value).getTime() : 0;
      } else if (task.type === "weekly") {
        task.dayOfWeek = Number(body.querySelector('[data-sched="dayOfWeek"]').value);
      } else if (task.type === "monthly") {
        task.dayOfMonth = Number(body.querySelector('[data-sched="dayOfMonth"]').value);
      } else if (task.type === "interval") {
        task.dailyStart = body.querySelector('[data-sched="dailyStart"]').value;
        task.dailyEnd = body.querySelector('[data-sched="dailyEnd"]').value;
        task.intervalHours = Number(body.querySelector('[data-sched="intervalHours"]').value);
      }
      return task;
    }

    function captureDrafts() {
      overlay.querySelectorAll("[data-sbody]").forEach(function (body) {
        var key = body.getAttribute("data-sbody");
        var snapshot = readFormRaw(key);
        if (snapshot) drafts[key] = snapshot;
      });
    }

    function readForm(tabKey, opts) {
      var body = overlay.querySelector('[data-sbody="' + tabKey + '"]');
      if (!body) return null;
      var task = readFormRaw(tabKey);
      if (!task) return null;
      var limit = payload.batchLimit || 20;
      if (!Number.isInteger(task.count) || task.count < 1 || task.count > limit) throw new Error("人数需为 1–" + limit + " 的整数");
      if (!payload.account) throw new Error("无法确认当前登录账号");
      if (task.enabled && !body.querySelector('[data-sched="ack"]').checked) throw new Error("请先确认定时任务设置");
      var requireFuture = task.enabled && !(opts && opts.requireFuture === false);
      var core = global.XFMCore;
      var reason = core && typeof core.validateSchedule === "function"
        ? core.validateSchedule(task, Date.now(), { requireFuture: requireFuture })
        : "";
      if (reason) throw new Error(reason);
      task.account = payload.account;
      task.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return task;
    }

    function render(skipCapture) {
      if (!skipCapture) captureDrafts();
      renderTab("cleanup");
      renderTab("followback");
      overlay.querySelectorAll(".sched-body").forEach(function (el) {
        el.hidden = el.getAttribute("data-sbody") !== activeTab;
      });
      overlay.querySelectorAll("[data-stab]").forEach(function (btn) {
        btn.classList.toggle("on", btn.getAttribute("data-stab") === activeTab);
      });
    }

    overlay.addEventListener("click", function (event) {
      var t = event.target instanceof Element ? event.target : null;
      if (!t) return;
      if (t.closest('[data-dlg="close"]')) { closeDialog(); return; }
      var stab = t.closest("[data-stab]");
      if (stab) {
        captureDrafts();
        activeTab = stab.getAttribute("data-stab");
        render(true);
        return;
      }
      var saveBtn = t.closest('[data-sched-save]');
      if (saveBtn) {
        var tk = saveBtn.getAttribute("data-sched-save");
        try {
          var nextTask = readForm(tk);
          Promise.resolve(payload.onSave(tk, nextTask)).then(function (result) {
            if (!result || !result.ok) throw new Error((result && result.reason) || "保存失败，请重试");
            // 后台会回写 nextRun；用它覆盖本地对象，避免界面显示旧的下次执行时间
            tasks[tk] = result.task || nextTask;
            drafts[tk] = null;
            render(true);
            toast("已保存");
          }).catch(function (err) { toast(err.message || "保存失败，请重试"); });
        } catch (err) { toast(err.message); }
        return;
      }
      var execBtn = t.closest('[data-sched-exec]');
      if (execBtn) {
        var ek = execBtn.getAttribute("data-sched-exec");
        try {
          var executeTask = readForm(ek, { requireFuture: false });
          if (!overlay.querySelector('[data-sbody="' + ek + '"] [data-sched="ack"]').checked) throw new Error("请先确认本次任务设置");
          if (typeof payload.onExecute === "function") payload.onExecute(ek, executeTask);
          closeDialog();
        } catch (err) { toast(err.message); }
        return;
      }
      var stopBtn = t.closest('[data-sched-stop]');
      if (stopBtn) {
        var sk = stopBtn.getAttribute("data-sched-stop");
        var stopped = typeof payload.onStop === "function" ? payload.onStop(sk) : false;
        toast(stopped ? "已请求停止，当前账号处理完后不再继续" : "当前没有正在运行的扫描或执行");
        return;
      }
      var clearBtn = t.closest('[data-sched-clear]');
      if (clearBtn && typeof payload.onClearRecords === "function") {
        var ck = clearBtn.getAttribute("data-sched-clear");
        Promise.resolve(payload.onClearRecords(ck)).then(function (result) {
          if (!result || !result.ok) throw new Error("清空失败");
          if (tasks[ck]) { tasks[ck].records = []; tasks[ck].lastRun = null; }
          drafts[ck] = null;
          render(true);
          toast("记录已清空");
        }).catch(function () { toast("清空记录失败，请重试"); });
        return;
      }
    });

    // 周期切换只影响对应行的显示，不重建表单，避免已填内容丢失。
    overlay.addEventListener("change", function (event) {
      var t = event.target instanceof Element ? event.target : null;
      if (t && t.getAttribute("data-sched") === "type") {
        applyRowVisibility(overlay.querySelector('[data-sbody="' + activeTab + '"]'), t.value);
      }
    });

    render();
  }

  function confirmScheduled(deadline) {
    return new Promise(function (resolve) {
      var settled = false, timer;
      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (overlay && overlay.isConnected) closeDialog();
        resolve(value);
      }
      var overlay = buildDialog('<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="xfm-sched-confirm"><div class="strip info"></div><div class="dhead"><h3 id="xfm-sched-confirm">定时任务准备开始</h3><p>需要切换列表并重新扫描。现在执行吗？</p></div><div class="foot"><button class="btn ghost" data-dlg="cancel">跳过本次</button><button class="btn accent" data-dlg="now">立即执行</button></div></div>', { backdropClose: false });
      if (!overlay || deadline <= Date.now()) { finish(false); return; }
      overlay.addEventListener("click", function (event) {
        var target = event.target instanceof Element ? event.target : null;
        if (target && target.closest('[data-dlg="now"]')) finish(Date.now() <= deadline);
        else if (target && target.closest('[data-dlg="cancel"]')) finish(false);
      });
      timer = setTimeout(function () { finish(false); }, Math.max(0, deadline - Date.now()));
    });
  }

  /**
   * 打开名单窗口。
   * @param {{mode:string, rows:Array, selected:Array, excluded:Array, limit:number,
   *          onApply:Function, onClose:Function}} payload
   */
  function showRoster(payload) {
    if (!payload) return;
    rosterCtx = {
      mode: payload.mode === "reply" ? "reply" : "cleanup",
      rows: (payload.rows || []).slice(),
      selected: new Set(payload.selected || []),
      excluded: new Set(payload.excluded || []),
      limit: payload.limit || 50,
      filter: "candidate",
      query: "",
      shown: ROSTER_PAGE,
      sortOldest: true,
      onApply: payload.onApply,
      onClose: payload.onClose
    };

    var candRel = candidateRelOf(rosterCtx.mode);
    var html = [
      '<div class="dlg wide" role="dialog" aria-modal="true" aria-labelledby="xfm-roster-title">',
      '  <div class="strip ok"></div>',
      '  <div class="dhead">',
      '    <h3 id="xfm-roster-title">' + (rosterCtx.mode === "reply" ? "粉丝回关名单" : "未回关名单") + "</h3>",
      '    <p class="rsummary">正在读取…</p>',
      "  </div>",
      '  <div class="rbar">',
      '    <input class="rsearch" type="search" placeholder="搜索昵称或 @用户名" aria-label="搜索账号">',
      '    <button class="rsort" type="button" data-rsort="1">⇅ 最早优先</button>',
      "  </div>",
      '  <div class="rtabs">',
      '    <button class="rtab on" type="button" data-rtab="candidate">' + modeTag(candRel) + "</button>",
      '    <button class="rtab" type="button" data-rtab="selected">已选</button>',
      '    <button class="rtab" type="button" data-rtab="excluded">已排除</button>',
      '    <button class="rtab" type="button" data-rtab="all">全部</button>',
      "  </div>",
      '  <div class="rlist"></div>',
      '  <div class="rfoot"></div>',
      "</div>"
    ].join("\n");

    var overlay = buildDialog(html);
    if (!overlay) return;

    var search = overlay.querySelector(".rsearch");
    search.addEventListener("input", function () {
      rosterCtx.query = search.value;
      rosterCtx.shown = ROSTER_PAGE;
      renderRoster();
    });

    overlay.addEventListener("click", function (event) {
      var t = event.target;
      if (!(t instanceof Element)) return;

      if (t.closest('[data-dlg="close"]')) {
        if (typeof rosterCtx.onClose === "function") rosterCtx.onClose();
        closeDialog();
        return;
      }

      var tab = t.closest("[data-rtab]");
      if (tab) {
        rosterCtx.filter = tab.getAttribute("data-rtab");
        rosterCtx.shown = ROSTER_PAGE;
        renderRoster();
        return;
      }

      if (t.closest("[data-rsort]")) {
        rosterCtx.sortOldest = !rosterCtx.sortOldest;
        t.closest("[data-rsort]").textContent = "⇅ " + (rosterCtx.sortOldest ? "最早优先" : "最新优先");
        renderRoster();
        return;
      }

      if (t.closest("[data-rmore]")) {
        rosterCtx.shown += ROSTER_PAGE;
        renderRoster();
        return;
      }

      var act = t.closest("[data-ract]");
      if (act) {
        var kind = act.getAttribute("data-ract");
        if (kind === "clear") {
          rosterCtx.selected = new Set();
          applyRoster();
        } else if (kind === "bulk") {
          var candRel2 = candidateRelOf(rosterCtx.mode);
          var q = rosterCtx.query.trim().toLowerCase();
          var next = new Set(rosterCtx.selected);
          rosterCtx.rows.forEach(function (row) {
            if (row.relation !== candRel2) return;
            if (rosterCtx.excluded.has(row.handle)) return;
            if (q && (row.handle + " " + (row.name || "")).toLowerCase().indexOf(q) === -1) return;
            next.add(row.handle);
          });
          rosterCtx.selected = next;
          applyRoster();
        }
        return;
      }

      var row = t.closest(".rrow");
      if (row) {
        var handle = row.getAttribute("data-handle");
        if (t.closest(".rex")) {
          toggleRosterExclude(handle);
        } else if (row.getAttribute("data-kind") === "candidate") {
          toggleRosterSelect(handle);
        }
      }
    });

    // 右键整行也能排除，符合页面上的操作习惯
    overlay.addEventListener("contextmenu", function (event) {
      var row = event.target instanceof Element ? event.target.closest(".rrow") : null;
      if (!row || row.getAttribute("data-kind") !== "candidate") return;
      event.preventDefault();
      toggleRosterExclude(row.getAttribute("data-handle"));
    });

    renderRoster();
  }

  function toggleRosterSelect(handle) {
    var ctx = rosterCtx;
    if (!ctx || !handle) return;
    if (ctx.selected.has(handle)) ctx.selected.delete(handle);
    else ctx.selected.add(handle);
    applyRoster();
  }

  function toggleRosterExclude(handle) {
    var ctx = rosterCtx;
    if (!ctx || !handle) return;
    var restoring = ctx.excluded.has(handle);
    if (restoring) {
      ctx.excluded.delete(handle);
    } else {
      ctx.excluded.add(handle);
      ctx.selected.delete(handle);
    }
    applyRoster();
    toast((restoring ? "已恢复 @" : "已排除 @") + handle);
  }

  var toastTimer = 0;
  function toast(text) {
    if (!panel) return;
    var old = panel.querySelector(".toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "toast";
    // 弹窗打开时把提示放到顶部，避免盖住底部按钮
    el.setAttribute("data-pos", dialogEl ? "top" : "bottom");
    el.textContent = text;
    panel.appendChild(el);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { el.remove(); }, 2600);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function applyLanguage() {
    if (panel && global.XFMI18N) global.XFMI18N.apply(panel);
  }

  global.XFMUI = {
    HOST_ATTR: HOST_ATTR,
    applyLanguage: applyLanguage,
    ROW_ATTR: ROW_ATTR,
    CHECK_ATTR: CHECK_ATTR,
    mountPanel: mountPanel,
    updatePanel: updatePanel,
    isMounted: isMounted,
    getHost: getHost,
    unmountPanel: unmountPanel,
    ensureCheckbox: ensureCheckbox,
    removeCheckbox: removeCheckbox,
    removeCheckboxes: removeCheckboxes,
    confirmUnfollow: confirmUnfollow,
    showResult: showResult,
    showRoster: showRoster,
    showScheduledDialog: showScheduledDialog,
    confirmScheduled: confirmScheduled,
    toast: toast,
    closeDialog: closeDialog,
    cancelDialog: cancelDialog,
    detectTheme: detectTheme,
    escapeHtml: escapeHtml
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
