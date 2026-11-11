/**
 * tokens.js — 设计令牌的唯一来源
 *
 * 页面内面板（Shadow DOM）与工具栏弹窗共用同一套变量，避免两处颜色、
 * 圆角、控件高度各自漂移。新增颜色请只改这里。
 */
(function initXfmTokens(global) {
  "use strict";

  if (global.XFMTokens) return;

  var light = {
    bg: "#ffffff",
    bg2: "#f7f9f9",
    bg3: "#eff3f4",
    bd: "rgba(0,0,0,.10)",
    bd2: "rgba(0,0,0,.06)",
    tx: "#0f1419",
    tx2: "#536471",
    tx3: "#8b98a5",
    accent: "#1d9bf0",
    accentHover: "#1a8cd8",
    accentBg: "rgba(29,155,240,.10)",
    danger: "#f4212e",
    dangerHover: "#d81c28",
    dangerBg: "rgba(244,33,46,.08)",
    ok: "#00ba7c",
    okBg: "rgba(0,186,124,.10)",
    warn: "#b8860b",
    warnBg: "rgba(255,212,0,.14)",
    shadow: "0 12px 32px rgba(0,0,0,.18)",
    overlay: "rgba(0,0,0,.6)",
    art: "#9aa7b2"
  };

  var dark = {
    bg: "#16181c",
    bg2: "#1c1f23",
    bg3: "#24282e",
    bd: "rgba(255,255,255,.13)",
    bd2: "rgba(255,255,255,.07)",
    tx: "#e7e9ea",
    tx2: "#8b98a5",
    tx3: "#6b7682",
    accent: "#1d9bf0",
    accentHover: "#1a8cd8",
    accentBg: "rgba(29,155,240,.14)",
    danger: "#f4212e",
    dangerHover: "#d81c28",
    dangerBg: "rgba(244,33,46,.14)",
    ok: "#00ba7c",
    okBg: "rgba(0,186,124,.14)",
    warn: "#ffd400",
    warnBg: "rgba(255,212,0,.12)",
    shadow: "0 12px 32px rgba(0,0,0,.5)",
    overlay: "rgba(0,0,0,.62)",
    art: "#6b7682"
  };

  /** 与主题无关的尺寸令牌 */
  var metrics = {
    "font-family": "-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif",
    "r-sm": "6px",
    "r-md": "8px",
    "r-lg": "10px",
    "r-xl": "16px",
    "h-ctl": "28px",
    "h-ctl-lg": "32px"
  };

  function declarations(map) {
    var out = [];
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      out.push("--" + key + ":" + map[key]);
    }
    for (var mk in metrics) {
      if (!Object.prototype.hasOwnProperty.call(metrics, mk)) continue;
      out.push("--" + mk + ":" + metrics[mk]);
    }
    return out.join(";");
  }

  /**
   * 生成一段变量声明。
   * @param {"light"|"dark"} theme
   * @param {string} [selector] 默认 `:root`；面板传 `:host([data-xfm-theme='light'])`
   */
  function toCss(theme, selector) {
    var map = theme === "dark" ? dark : light;
    return (selector || ":root") + "{" + declarations(map) + ";}";
  }

  /** 把变量写到指定根节点（用于普通页面，例如 popup） */
  function apply(root, theme) {
    var map = theme === "dark" ? dark : light;
    var style = root.style;
    for (var key in map) {
      if (Object.prototype.hasOwnProperty.call(map, key)) style.setProperty("--" + key, map[key]);
    }
    for (var mk in metrics) {
      if (Object.prototype.hasOwnProperty.call(metrics, mk)) style.setProperty("--" + mk, metrics[mk]);
    }
    root.setAttribute("data-xfm-theme", theme === "dark" ? "dark" : "light");
  }

  global.XFMTokens = {
    light: light,
    dark: dark,
    metrics: metrics,
    toCss: toCss,
    apply: apply
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
