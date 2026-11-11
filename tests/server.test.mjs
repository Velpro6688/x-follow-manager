import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("本地测试台只提供模拟页面和扩展资源", { timeout: 10000 }, async (t) => {
  const entry = fileURLToPath(new URL("./server.mjs", import.meta.url));
  const server = spawn(process.execPath, [entry, "0"]);
  t.after(() => server.kill());
  const [output] = await once(server.stdout, "data", { signal: AbortSignal.timeout(5000) });
  const port = /localhost:(\d+)\//.exec(String(output))?.[1];
  assert.ok(Number(port) > 0);

  const request = (pathname) => fetch(`http://127.0.0.1:${port}${pathname}`);
  const preview = await request("/popup-preview");
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /src="\/x-follow-manager\/shared\/i18n\.js"/);
  for (const [pathname, status] of [
    ["/README.md", 404],
    ["/%", 400],
    ["/alice/following", 200],
    ["/x-follow-manager/shared/i18n.js", 200]
  ]) {
    const response = await request(pathname);
    assert.equal(response.status, status, pathname);
    await response.body.cancel();
  }
});
