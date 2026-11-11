/**
 * server.mjs — 本地测试服务器
 *
 * 用途：把 tests/fixtures/harness.html 暴露在 /<user>/following 路径下，
 *       让 content.js 的路由判断与真实 X 页面保持一致。
 *
 * 运行：node tests/server.mjs [端口]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.resolve(__dirname, "fixtures");
const PORT = Number(process.argv[2] || 38080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
  } catch {
    return send(res, 400, "Bad request");
  }

  // 模拟 X 的关注列表路由
  if (/^\/[A-Za-z0-9_]{1,15}\/(?:following|followers)\/?$/.test(pathname)) {
    let html = fs.readFileSync(path.join(FIXTURES, "harness.html"), "utf8");
    // Integration tests load the real extension instead of page-injected copies.
    if (process.env.XFM_EXTENSION_TEST === "1") html = html.replace(/<script src="\.\.\/x-follow-manager\/[^"]+"><\/script>/g, "");
    return send(res, 200, html, MIME[".html"]);
  }

  // 工具栏弹窗预览：注入 chrome API stub 后再加载 popup.js
  if (pathname === "/popup-preview") {
    const stub = `
<script>
window.chrome = {
  storage: { local: {
    get: function (k, cb) { var d = {}; d["xfm.settings.v1"] = { batchLimit: 50, quantity: 50, strictMode: true, filter: "one-way", excluded: ["a", "b"] }; if (cb) { cb(d); return; } return Promise.resolve(d); },
    set: function (o, cb) { if (cb) cb(); return Promise.resolve(); }
  } },
  tabs: {
    query: function () { return Promise.resolve([{ id: 1, url: "https://x.com/alice/following" }]); },
    sendMessage: function (id, msg, cb) {
      var payload = { isFollowing: true, mode: "cleanup", phase: "scanned", total: 20, oneWay: 13, mutual: 6, unknown: 1, selected: 5, excluded: 2, candidateLabel: "未回关", actionLabel: "取关", runDone: 0, runTotal: 0, notice: "" };
      // 递增计数桩：验证弹窗在扫描中会持续拉取最新数字
      if (msg && msg.type === "XFM_GET_STATUS" && location.search.indexOf("tick=1") !== -1) {
        window.__xfmTick = (window.__xfmTick || 20) + 100;
        payload.total = window.__xfmTick;
        payload.phase = "scanning";
        payload.scanning = true;
        payload.notice = "已扫描 " + payload.total + " 个账号，正在加载…";
      }
      if (typeof cb === "function") { cb(payload); return; }
      return Promise.resolve(payload);
    },
    reload: function () {}
  },
  runtime: { lastError: null }
};
<\/script>`;
    let html = fs.readFileSync(path.join(ROOT, "x-follow-manager/popup.html"), "utf8");
    html = html
      .replace('href="popup.css"', 'href="/x-follow-manager/popup.css"')
      .replace(/src="(popup\.js|shared\/[\w-]+\.js)"/g, 'src="/x-follow-manager/$1"')
      .replace("</head>", stub + "\n</head>");
    return send(res, 200, html, MIME[".html"]);
  }

  if (pathname === "/") pathname = "/tests/fixtures/harness.html";

  // 只提供模拟页面和扩展资源，避免把发布仓库当作静态文件目录。
  const isExtensionAsset = /^\/x-follow-manager\/(?:[\w-]+\/)*[\w-]+\.(?:html|js|css|png|json|svg)$/i.test(pathname);
  if (!isExtensionAsset && pathname !== "/tests/fixtures/harness.html") return send(res, 404, "Not found");
  const target = path.join(ROOT, pathname.slice(1));

  fs.readFile(target, (err, data) => {
    if (err) return send(res, 404, "Not found: " + pathname);
    send(res, 200, data, MIME[path.extname(target)] || "application/octet-stream");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`测试台已启动：http://localhost:${server.address().port}/alice/following`);
});
