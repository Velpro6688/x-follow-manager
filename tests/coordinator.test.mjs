import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function createCoordinator(initial = {}, shared = false, options = {}) {
  const storage = shared ? initial : structuredClone(initial);
  const listeners = [];
  const stats = { setCalls: 0, lastHandled: 0, listenerCalls: 0 };
  const context = vm.createContext({
    console, Date, Set, Promise,
    chrome: {
      runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } },
      storage: { local: {
        async get(key) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (key == null) return structuredClone(storage);
          return { [key]: structuredClone(storage[key]) };
        },
        async set(value) { await new Promise((resolve) => setTimeout(resolve, 1)); stats.setCalls += 1; Object.assign(storage, structuredClone(value)); },
        async remove(key) { delete storage[key]; }
      } }
    }
  });
  context.importScripts = () => vm.runInContext(fs.readFileSync("x-follow-manager/content/core.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("x-follow-manager/background.js", "utf8"), context);
  // 缺陷形态专用：把第一个监听再注册一次，验证测试替身能发现“同一消息被处理两遍”。
  // 正常加载不应走这条分支。
  if (options.duplicateFirstListener && listeners[0]) listeners.push(listeners[0]);

  // Chrome 语义：消息会依次交给每个监听，只有 return true 的监听持有 respond；
  // 多个监听可以同时 return true，首个 sendResponse 生效，后续响应被忽略。
  // 因此这里必须把所有监听都调用完，不能遇到第一个 true 就提前退出。
  function send(msg) {
    return new Promise((resolve) => {
      let responded = false;
      const respond = (value) => { if (!responded) { responded = true; resolve(value); } };
      let handled = 0;
      for (const fn of listeners) {
        stats.listenerCalls += 1;
        const holds = fn(msg, {}, respond);
        if (holds === true) handled += 1;
      }
      stats.lastHandled = handled;
      // 没有监听接手才立即返回空；有监听 return true 时必须等它的异步 respond。
      if (!responded && handled === 0) resolve({});
    });
  }
  return { storage, stats, send };
}

test("同时保存排除名单时两个新增都保留", async () => {
  const c = createCoordinator({ "xfm.settings.v1": { excluded: [] } });
  const results = await Promise.all(["alice", "bob"].map((name) => c.send({
    type: "XFM_COORD_SETTINGS", patch: {}, excluded: { base: [], ours: [name] }
  })));
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual([...c.storage["xfm.settings.v1"].excluded].sort(), ["alice", "bob"]);
});

test("同时申请执行锁时只能一个成功，其他任务不能释放它", async () => {
  const c = createCoordinator();
  const results = await Promise.all(["a", "b"].map((runId) => c.send({ type: "XFM_COORD_ACQUIRE", runId, path: "/alice/following" })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  const winner = results[0].ok ? "a" : "b";
  const loser = winner === "a" ? "b" : "a";
  assert.equal((await c.send({ type: "XFM_COORD_RELEASE", runId: loser })).ok, false);
  assert.equal(c.storage["xfm.run.lock.v1"].runId, winner);
  assert.equal((await c.send({ type: "XFM_COORD_RELEASE", runId: winner })).ok, true);
});

test("同一共享存储中的并发扫描合并，清除后旧代次不能复活", async () => {
  const c = createCoordinator();
  const key = "xfm.scan.progress.v1:alice|alice|following";
  const other = "xfm.scan.progress.v1:alice|alice|followers";
  const begin = (k) => c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key: k });
  const [a, b, o] = await Promise.all([begin(key), begin(key), begin(other)]);
  assert.equal(a.generation, 0);
  assert.equal(b.generation, 0);
  const save = (k, generation, h) => c.send({ type: "XFM_COORD_PROGRESS_SAVE", key: k, id: k, generation, rows: [{ h }] });
  await Promise.all([save(key, a.generation, "a"), save(key, b.generation, "b"), save(other, o.generation, "c")]);
  assert.deepEqual(Array.from(c.storage[key].rows, (row) => row.h).sort(), ["a", "b"]);
  await c.send({ type: "XFM_COORD_PROGRESS_CLEAR", key, id: key });
  assert.equal((await save(key, b.generation, "stale")).skipped, true);
  assert.equal(c.storage[key].rows, undefined);
  assert.equal(c.storage[other].rows[0].h, "c");
  const next = await begin(key);
  assert.equal(next.generation, 1);
  await save(key, next.generation, "new");
  assert.equal((await save(key, a.generation, "stale")).skipped, true);
  assert.equal((await c.send({ type: "XFM_COORD_PROGRESS_CLEAR", key, generation: a.generation })).skipped, true);
  assert.deepEqual(Array.from(c.storage[key].rows, (row) => row.h), ["new"]);
  const restarted = createCoordinator(c.storage, true);
  assert.equal((await restarted.send({ type: "XFM_COORD_PROGRESS_BEGIN", key })).generation, 1);
  assert.equal((await restarted.send({ type: "XFM_COORD_PROGRESS_SAVE", key, generation: 0, rows: [{ h: "stale" }] })).skipped, true);
});

test("BEGIN 清理超过一周的过期进度（写回升代墓碑），且不解除旧任务写入阻断", async () => {
  const c = createCoordinator();
  const key = "xfm.scan.progress.v1:alice|alice|cleanup";
  const oldKey = "xfm.scan.progress.v1:bob|bob|cleanup";
  const now = Date.now();
  c.storage[key] = { id: key, rows: [{ h: "fresh" }], generation: 3, updatedAt: now };
  c.storage[oldKey] = { id: oldKey, rows: [{ h: "stale" }], generation: 1, updatedAt: now - 8 * 24 * 60 * 60 * 1000 };
  const begun = await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key });
  assert.equal(begun.generation, 3);
  // 过期条目写回升代墓碑（1→2），行数据清除
  assert.equal(c.storage[oldKey].generation, 2, "过期条目应升代为墓碑");
  assert.equal(c.storage[oldKey].rows, undefined, "过期行数据应被清除");
  assert.equal(c.storage[key].rows[0].h, "fresh", "新鲜条目不得被清理");
  // 旧任务携带旧代次（1）的保存仍被跳过（墓碑已升到 2）
  assert.equal((await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key: oldKey, generation: 1, rows: [{ h: "stale2" }] })).skipped, true);
  // 新 BEGIN 拿到升代后的 2，可正常写回
  const next = await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key: oldKey });
  assert.equal(next.generation, 2);
  assert.equal((await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key: oldKey, generation: 2, rows: [{ h: "n1" }] })).skipped, undefined);
  assert.equal(c.storage[oldKey].rows[0].h, "n1");
});

test("代次前进后的保存被跳过并带原因（同代次并发保存仍合并）", async () => {
  const c = createCoordinator();
  const key = "xfm.scan.progress.v1:alice|alice|cleanup";
  await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key });
  // 同代次的两次并发保存：合法合并，双方成果都保留
  const r1 = await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key, generation: 0, rows: [{ h: "a" }] });
  const r2 = await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key, generation: 0, rows: [{ h: "b" }] });
  assert.equal(r1.skipped, undefined);
  assert.equal(r2.skipped, undefined);
  assert.deepEqual(Array.from(c.storage[key].rows, (row) => row.h).sort(), ["a", "b"]);
  // 清除使代次前进：旧代次的保存被跳过并带原因
  await c.send({ type: "XFM_COORD_PROGRESS_CLEAR", key, generation: 0 });
  const stale = await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key, generation: 0, rows: [{ h: "stale" }] });
  assert.equal(stale.skipped, true);
  assert.equal(stale.reason, "generation");
});

test("清理后旧代次 0 的迟到保存不得复活已清除进度", async () => {
  const c = createCoordinator();
  const key = "xfm.scan.progress.v1:alice|alice|cleanup";
  const WEEK = 8 * 24 * 60 * 60 * 1000;
  // 旧任务 BEGIN：键不存在 → generation 0
  const begun = await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key });
  assert.equal(begun.generation, 0);
  // 旧任务保存了一些行
  await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key, generation: 0, rows: [{ h: "old1" }, { h: "old2" }] });
  // 另一窗口丢弃进度 → 墓碑 generation 1
  await c.send({ type: "XFM_COORD_PROGRESS_CLEAR", key, generation: 0 });
  assert.equal(c.storage[key].generation, 1);
  // 模拟超过清理期限：把墓碑时间改到 8 天前
  c.storage[key].clearedAt = Date.now() - WEEK;
  // 新扫描 BEGIN → 清理触发：当前实现删除条目 → 代次归 0 → 旧任务迟到保存复活
  const begun2 = await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key });
  const lateSave = await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key, generation: 0, rows: [{ h: "resurrected" }] });
  const resurrected = c.storage[key] && Array.isArray(c.storage[key].rows) && c.storage[key].rows.some((r) => r.h === "resurrected");
  assert.equal(resurrected, false, "已清除进度不得被旧代次的迟到保存复活");
});

test("清理后旧代次的清除不得删除清理后新任务的成果", async () => {
  const c = createCoordinator();
  const key = "xfm.scan.progress.v1:bob|bob|cleanup";
  const WEEK = 8 * 24 * 60 * 60 * 1000;
  // 旧任务 BEGIN（gen 0）→ 保存 → 清除（墓碑 gen 1）
  await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key });
  await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key, generation: 0, rows: [{ h: "old" }] });
  await c.send({ type: "XFM_COORD_PROGRESS_CLEAR", key, generation: 0 });
  // 墓碑老化 → 新扫描 BEGIN 触发清理
  c.storage[key].clearedAt = Date.now() - WEEK;
  await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key });
  // 清理后新任务拿到新代次并写入成果
  const next = await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key });
  await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key, generation: next.generation, rows: [{ h: "new1" }, { h: "new2" }] });
  // 旧任务的迟到清除（旧代次 0）不得删除新任务成果
  await c.send({ type: "XFM_COORD_PROGRESS_CLEAR", key, generation: 0 });
  const hs = (c.storage[key].rows || []).map((r) => r.h);
  assert.deepEqual(hs, ["new1", "new2"]);
});

test("不同进度键的清理与写入互不影响（墓碑升代，不删除）", async () => {
  const c = createCoordinator();
  const keyA = "xfm.scan.progress.v1:alice|alice|cleanup";
  const keyB = "xfm.scan.progress.v1:bob|bob|cleanup";
  const WEEK = 8 * 24 * 60 * 60 * 1000;
  await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key: keyA });
  await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key: keyA, generation: 0, rows: [{ h: "a1" }] });
  c.storage[keyB] = { id: keyB, rows: [{ h: "b1" }], generation: 5, updatedAt: Date.now() - WEEK };
  // 清理触发（BEGIN keyA）：keyB 过期条目写回升代墓碑（代次 5→6），keyA 不受影响
  await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key: keyA });
  assert.equal(c.storage[keyB].generation, 6, "keyB 应升代为墓碑（5→6）");
  assert.equal(c.storage[keyB].rows, undefined, "keyB 行数据应被清除");
  assert.equal(c.storage[keyA].rows[0].h, "a1", "keyA 不受清理影响");
  // keyB 旧代次保存被跳过，keyA 正常
  assert.equal((await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key: keyB, generation: 5, rows: [{ h: "stale" }] })).skipped, true);
  assert.equal((await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key: keyA, generation: 0, rows: [{ h: "a2" }] })).skipped, undefined);
});

test("独立读合并写在两次读取后交错写入会丢失数据", async () => {
  const storage = { rows: [] };
  const readA = structuredClone(storage.rows);
  const readB = structuredClone(storage.rows);
  storage.rows = [...readA, { h: "a" }];
  storage.rows = [...readB, { h: "b" }];
  assert.deepEqual(storage.rows.map((row) => row.h), ["b"]);
});

test("同一条协调消息只进入串行队列一次（真实多监听分发下）", async () => {
  const c = createCoordinator({ "xfm.settings.v1": { excluded: [] } });
  const before = c.stats.setCalls;
  const r = await c.send({ type: "XFM_COORD_SETTINGS", patch: {}, excluded: { base: [], ours: ["alice"] } });
  assert.equal(r.ok, true);
  assert.equal(c.stats.lastHandled, 1, "SETTINGS 只应由一个监听接手");
  assert.equal(c.stats.setCalls - before, 1, "SETTINGS 应只写一次存储");

  const key = "xfm.scan.progress.v1:once|once|following";
  await c.send({ type: "XFM_COORD_PROGRESS_BEGIN", key });
  assert.equal(c.stats.lastHandled, 1, "PROGRESS_BEGIN 只应由一个监听接手");
  const saveBase = c.stats.setCalls;
  const save = await c.send({ type: "XFM_COORD_PROGRESS_SAVE", key, generation: 0, rows: [{ h: "a" }] });
  assert.equal(save.skipped, undefined);
  assert.equal(c.stats.lastHandled, 1, "PROGRESS_SAVE 只应由一个监听接手");
  assert.equal(c.stats.setCalls - saveBase, 1, "PROGRESS_SAVE 应只写一次存储");

  const acquireBase = c.stats.setCalls;
  const acquired = await c.send({ type: "XFM_COORD_ACQUIRE", runId: "once-only", path: "/alice/following" });
  assert.equal(acquired.ok, true);
  assert.equal(c.stats.lastHandled, 1, "ACQUIRE 只应由一个监听接手");
  assert.equal(c.stats.setCalls - acquireBase, 1, "ACQUIRE 应只写一次存储");
});

test("缺陷形态：重复注册监听会被测试替身检出（证明单次处理用例有牙齿）", async () => {
  const c = createCoordinator({ "xfm.settings.v1": { excluded: [] } }, false, { duplicateFirstListener: true });
  const before = c.stats.setCalls;
  const r = await c.send({ type: "XFM_COORD_SETTINGS", patch: {}, excluded: { base: [], ours: ["bob"] } });
  assert.equal(r.ok, true);
  assert.equal(c.stats.lastHandled, 2, "重复监听时应有两个监听接手");
  // 第二个监听仍会被串行队列执行；等它完成后再检查存储写入次数
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(c.stats.setCalls - before, 2, "重复监听会写两次存储，测试应能发现");
});
