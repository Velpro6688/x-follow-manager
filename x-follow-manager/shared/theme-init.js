/**
 * theme-init.js — 在扩展页（工具栏弹窗）里尽早套用设计令牌
 *
 * 内容脚本不加载本文件：X 页面的主题由 ui.js 按页面实际背景判断。
 */
(function initXfmTheme() {
  "use strict";

  var T = window.XFMTokens;
  if (!T) return;

  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function current() {
    return media && media.matches ? "dark" : "light";
  }

  function sync() {
    T.apply(document.documentElement, current());
  }

  sync();
  if (media) {
    try {
      media.addEventListener("change", sync);
    } catch (err) {
      if (typeof media.addListener === "function") media.addListener(sync);
    }
  }
})();
