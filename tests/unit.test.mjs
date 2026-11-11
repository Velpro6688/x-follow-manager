/**
 * unit.test.mjs — core.js 单元测试（Node + jsdom）
 *
 * 覆盖：账号解析、三种关注关系、语言变体、DOM 复用、去重、
 *       完整性自检、自动选择、批次上限、异常页面检测。
 *
 * 运行：node --test tests/unit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_SRC = fs.readFileSync(path.resolve(__dirname, "../x-follow-manager/content/core.js"), "utf8");

/** 建立隔离的 DOM 环境，并把 core.js 注入进去 */
function createEnv(bodyHtml = "") {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`, {
    url: "https://x.com/alice/following",
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  dom.window.eval(CORE_SRC);
  return { dom, window: dom.window, C: dom.window.XFMCore };
}

/**
 * 构造一个 X 用户行。
 * @param {{handle:string, name?:string, followsYou?:boolean|string, button?:'unfollow'|'follow'|'none', lang?:'zh'|'en'|'zh-tw'}} opts
 */
function userCell(opts) {
  const handle = opts.handle;
  const name = opts.name || handle.toUpperCase();
  const button = opts.button === undefined ? "unfollow" : opts.button;

  let indicator = "";
  if (opts.followsYou) {
    const text = typeof opts.followsYou === "string"
      ? opts.followsYou
      : (opts.lang === "en" ? "Follows you" : opts.lang === "zh-tw" ? "追蹤你" : "关注了你");
    indicator = `<div data-testid="userFollowIndicator"><span>${text}</span></div>`;
  }

  let action = "";
  if (button === "unfollow") {
    action = `<div role="button" data-testid="999-unfollow" aria-label="Following @${handle}"><span>${opts.lang === "en" ? "Following" : "正在关注"}</span></div>`;
  } else if (button === "follow") {
    action = `<div role="button" data-testid="999-follow" aria-label="Follow @${handle}"><span>${opts.lang === "en" ? "Follow" : "关注"}</span></div>`;
  }

  return `
  <div data-testid="cellInnerDiv">
    <div class="css-inner">
      <div data-testid="UserCell">
        <a href="/${handle}"><img alt=""></a>
        <div data-testid="User-Name">
          <a href="/${handle}"><span>${name}</span></a>
          <a href="/${handle}"><span>@${handle}</span></a>
          ${indicator}
        </div>
        ${action}
      </div>
    </div>
  </div>`;
}

function wrapList(cells) {
  return `<div data-testid="primaryColumn">
    <div role="tablist"><a role="tab" href="/alice/following" aria-selected="true">正在关注</a></div>
    <section role="region">${cells.join("")}</section>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* 路径与账号解析                                                      */
/* ------------------------------------------------------------------ */

test("handleFromHref 只接受单段个人主页路径", () => {
  const { C } = createEnv();
  assert.equal(C.handleFromHref("/bob"), "bob");
  assert.equal(C.handleFromHref("/Bob"), "bob");
  assert.equal(C.handleFromHref("/@bob"), "bob");
  assert.equal(C.handleFromHref("/bob/status/123"), null);
  assert.equal(C.handleFromHref("/home"), null);
  assert.equal(C.handleFromHref("/i/flow/login"), null);
  assert.equal(C.handleFromHref(""), null);
  assert.equal(C.handleFromHref("/abcdefghijklmnopq"), null, "超过 15 字符不是合法 handle");
});

test("parseFollowingPath 支持标准与 /i/user 形式", () => {
  const { C } = createEnv();
  assert.deepEqual(C.parseFollowingPath("/alice/following").handle, "alice");
  assert.deepEqual(C.parseFollowingPath("/alice/following/").handle, "alice");
  assert.equal(C.parseFollowingPath("/alice"), null);
  assert.equal(C.parseFollowingPath("/alice/followers"), null);
  const internal = C.parseFollowingPath("/i/user/12345/following");
  assert.ok(internal);
  assert.equal(internal.handle, null);
  assert.equal(internal.userId, "12345");
});

/* ------------------------------------------------------------------ */
/* 关注关系判定                                                        */
/* ------------------------------------------------------------------ */

test("有「关注了你」标记 → 已回关", () => {
  const { C, window } = createEnv(wrapList([userCell({ handle: "bob", followsYou: true })]));
  const cell = window.document.querySelector('[data-testid="UserCell"]');
  const rec = C.readUserCell(cell);
  assert.equal(rec.handle, "bob");
  assert.equal(rec.relation, C.REL.MUTUAL);
  assert.equal(rec.indicator, true);
  assert.equal(rec.actionKind, "unfollow");
});

test("无标记且存在取关按钮 → 未回关", () => {
  const { C, window } = createEnv(wrapList([userCell({ handle: "carol" })]));
  const rec = C.readUserCell(window.document.querySelector('[data-testid="UserCell"]'));
  assert.equal(rec.relation, C.REL.ONE_WAY);
  assert.equal(rec.reason, "ok");
});

test("中文 / 繁中 / 英文标记均能识别", () => {
  const variants = [
    userCell({ handle: "a1", followsYou: true }),
    userCell({ handle: "a2", followsYou: "Follows you" }),
    userCell({ handle: "a3", followsYou: "追蹤你" })
  ];
  const { C, window } = createEnv(wrapList(variants));
  const cells = window.document.querySelectorAll('[data-testid="UserCell"]');
  for (const cell of cells) {
    assert.equal(C.readUserCell(cell).relation, C.REL.MUTUAL);
  }
});

test("没有操作按钮 → 未知，不能当成未回关", () => {
  const { C, window } = createEnv(wrapList([userCell({ handle: "dave", button: "none" })]));
  const rec = C.readUserCell(window.document.querySelector('[data-testid="UserCell"]'));
  assert.equal(rec.relation, C.REL.UNKNOWN);
  assert.equal(rec.reason, "missing-action-button");
});

test("按钮显示为「关注」→ 未知（列表数据已变化）", () => {
  const { C, window } = createEnv(wrapList([userCell({ handle: "erin", button: "follow" })]));
  const rec = C.readUserCell(window.document.querySelector('[data-testid="UserCell"]'));
  assert.equal(rec.relation, C.REL.UNKNOWN);
  assert.equal(rec.reason, "not-following-now");
});

test("缺少 handle → 未知", () => {
  const html = `<div data-testid="UserCell">
      <div data-testid="User-Name"><span>Ghost</span></div>
      <div role="button" data-testid="1-unfollow"><span>正在关注</span></div>
    </div>`;
  const { C, window } = createEnv(html);
  const rec = C.readUserCell(window.document.querySelector('[data-testid="UserCell"]'));
  assert.equal(rec.relation, C.REL.UNKNOWN);
  assert.equal(rec.reason, "missing-handle");
});

test("DOM 节点被复用给另一个账号时，读取结果跟随当前内容", () => {
  const { C, window } = createEnv(wrapList([userCell({ handle: "first" })]));
  const cell = window.document.querySelector('[data-testid="UserCell"]');
  assert.equal(C.readUserCell(cell).handle, "first");

  // 模拟虚拟列表复用：同一节点换成另一个账号
  cell.querySelector('a[href="/first"]').setAttribute("href", "/second");
  const inner = cell.querySelector('[data-testid="User-Name"] a[href="/first"]');
  inner.setAttribute("href", "/second");
  cell.querySelector('[data-testid="User-Name"] a span').textContent = "Second";

  assert.equal(C.readUserCell(cell).handle, "second");
});

/* ------------------------------------------------------------------ */
/* 收集与合并                                                          */
/* ------------------------------------------------------------------ */

test("collectRows 按 handle 去重并统计跳过行", () => {
  const cells = [userCell({ handle: "u1" }), userCell({ handle: "u1" }), userCell({ handle: "u2" })];
  const broken = '<div data-testid="UserCell"><span>坏行</span></div>';
  const { C, window } = createEnv(wrapList([...cells, broken]));
  const result = C.collectRows(window.document);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].handle, "u1");
  assert.equal(result.rows[1].handle, "u2");
  assert.equal(result.skipped, 1);
});

test("mergeRows 保持首次出现顺序，并更新关系变化", () => {
  const { C } = createEnv();
  const store = new Map();
  let order = [];

  C.mergeRows(store, order, [
    { handle: "u1", name: "One", relation: C.REL.ONE_WAY, reason: "ok" },
    { handle: "u2", name: "Two", relation: C.REL.ONE_WAY, reason: "ok" }
  ]);
  assert.deepEqual(order, ["u1", "u2"]);

  // u2 被判定为已回关（页面状态变化）
  C.mergeRows(store, order, [
    { handle: "u2", name: "Two", relation: C.REL.MUTUAL, reason: "ok" },
    { handle: "u3", name: "Three", relation: C.REL.ONE_WAY, reason: "ok" }
  ]);
  assert.deepEqual(order, ["u1", "u2", "u3"], "重复行不得改变顺序");
  assert.equal(store.get("u2").relation, C.REL.MUTUAL);
  assert.equal(store.size, 3);
});

/* ------------------------------------------------------------------ */
/* 完整性自检                                                          */
/* ------------------------------------------------------------------ */

test("样本足够大但零回关标记 → 阻断", () => {
  const { C } = createEnv();
  const rows = Array.from({ length: 20 }, (_, i) => ({ handle: "u" + i, relation: C.REL.ONE_WAY }));
  const result = C.evaluateIntegrity(rows, { strict: true });
  assert.equal(result.blocked, true);
  assert.equal(result.warnings[0].code, "no-mutual-marker");
  assert.equal(result.warnings[0].severity, "block");
});

test("关闭严格校验后仅警告，不阻断", () => {
  const { C } = createEnv();
  const rows = Array.from({ length: 20 }, (_, i) => ({ handle: "u" + i, relation: C.REL.ONE_WAY }));
  const result = C.evaluateIntegrity(rows, { strict: false });
  assert.equal(result.blocked, false);
  assert.equal(result.warnings[0].severity, "warn");
});

test("小样本（<15）不触发零标记阻断", () => {
  const { C } = createEnv();
  const rows = Array.from({ length: 5 }, (_, i) => ({ handle: "u" + i, relation: C.REL.ONE_WAY }));
  const result = C.evaluateIntegrity(rows, { strict: true });
  assert.equal(result.blocked, false);
});

test("未知占比超过一半 → 阻断", () => {
  const { C } = createEnv();
  const rows = [
    { handle: "a", relation: C.REL.ONE_WAY },
    { handle: "b", relation: C.REL.UNKNOWN },
    { handle: "c", relation: C.REL.UNKNOWN },
    { handle: "d", relation: C.REL.UNKNOWN },
    { handle: "e", relation: C.REL.UNKNOWN },
    { handle: "f", relation: C.REL.UNKNOWN },
    { handle: "g", relation: C.REL.UNKNOWN },
    { handle: "h", relation: C.REL.UNKNOWN },
    { handle: "i", relation: C.REL.UNKNOWN },
    { handle: "j", relation: C.REL.UNKNOWN },
    { handle: "k", relation: C.REL.UNKNOWN }
  ];
  const result = C.evaluateIntegrity(rows, { strict: true });
  assert.equal(result.blocked, true);
  assert.ok(result.warnings.some((w) => w.code === "high-unknown-ratio"));
});

test("回关模式：全是待回关、零互关属正常，不触发零标记阻断", () => {
  const { C } = createEnv();
  // 粉丝列表里「你还没回关的人」占多数是正常状态（比如刚注册的账号），
  // 清理模式的零标记规则不能套用到回关模式
  const rows = Array.from({ length: 20 }, (_, i) => ({ handle: "f" + i, relation: C.REL.PENDING }));
  const result = C.evaluateIntegrity(rows, { strict: true, candidateRel: C.REL.PENDING });
  assert.equal(result.blocked, false);
  assert.ok(!result.warnings.some((w) => w.code === "no-mutual-marker"));
});

test("清理模式：同样数据（20 个未回关、0 互关）仍然阻断", () => {
  const { C } = createEnv();
  const rows = Array.from({ length: 20 }, (_, i) => ({ handle: "u" + i, relation: C.REL.ONE_WAY }));
  const result = C.evaluateIntegrity(rows, { strict: true, candidateRel: C.REL.ONE_WAY });
  assert.equal(result.blocked, true);
  assert.equal(result.warnings[0].code, "no-mutual-marker");
});

/* ------------------------------------------------------------------ */
/* 排除名单三方合并（多标签页并发写保护）                                */
/* ------------------------------------------------------------------ */

test("合并：两侧各自新增的账号都保留", () => {
  const { C } = createEnv();
  const merged = C.mergeExcluded(
    ["a"],
    ["a", "b"],       // 本页新增 b
    ["a", "c"]        // 另一标签页新增 c
  );
  assert.deepEqual(Array.from(merged).sort(), ["a", "b", "c"]);
});

test("合并：只在一侧明确删除的账号按删除算", () => {
  const { C } = createEnv();
  const merged = C.mergeExcluded(
    ["a", "b", "c"],
    ["a", "b"],       // 本页删除了 c（恢复到可清理范围）
    ["a", "b", "c"]   // 另一标签页没动 c
  );
  assert.deepEqual(Array.from(merged).sort(), ["a", "b"]);

  const merged2 = C.mergeExcluded(
    ["a", "b", "c"],
    ["a", "b", "c"],  // 本页没动
    ["a", "b"]        // 另一标签页删除了 c
  );
  assert.deepEqual(Array.from(merged2).sort(), ["a", "b"]);
});

test("合并：两侧都保留 / 都删除的账号不意外增删", () => {
  const { C } = createEnv();
  const merged = C.mergeExcluded(
    ["a", "b", "x"],
    ["a", "b"],       // 本页删 x，另一页也删 x
    ["a", "b"]        // 对方删 x
  );
  assert.deepEqual(Array.from(merged).sort(), ["a", "b"]);

  const merged2 = C.mergeExcluded(["a"], ["a"], ["a"]);
  assert.deepEqual(Array.from(merged2), ["a"]);
});


test("扫描进度合并：双方并集，重复 handle 以写入方为准", () => {
  const { C } = createEnv();
  const merged = C.mergeProgressRows(
    [{ h: "a", r: "one-way", n: "旧昵称" }, { h: "b", r: "one-way" }],
    [{ h: "b", r: "mutual", n: "新昵称" }, { h: "c", r: "pending" }]
  );
  const byH = {};
  merged.forEach((r) => { byH[r.h] = r; });
  assert.equal(merged.length, 3);
  assert.equal(byH.a.r, "one-way");          // 只有一方有的保留
  assert.equal(byH.b.r, "mutual");           // 重复 handle 以写入方为准
  assert.equal(byH.b.n, "新昵称");
  assert.equal(byH.c.r, "pending");
});

test("扫描进度合并：另一标签页的独有扫描成果不丢", () => {
  const { C } = createEnv();
  const merged = C.mergeProgressRows(
    [{ h: "u5" }, { h: "u6" }, { h: "u7" }],   // 磁盘上另一标签页扫到的
    [{ h: "u1" }, { h: "u2" }]                  // 本页快照较少
  );
  const hs = Array.from(merged.map((r) => r.h)).sort();
  assert.deepEqual(hs, ["u1", "u2", "u5", "u6", "u7"]);
});


test("写回决策：扫描开始之后的丢弃墓碑 → 跳过写回", () => {
  const { C } = createEnv();
  const now = 1000000;
  const tomb = { clearedAt: now - 100 };
  const resolved = C.resolveProgressWrite(tomb, [{ h: "a" }], now - 5000, now);
  assert.equal(resolved, null); // 丢弃发生在本次扫描开始之后，不得复活
});

test("写回决策：墓碑早于本次扫描开始 → 新扫描正常写回", () => {
  const { C } = createEnv();
  const now = 1000000;
  const tomb = { clearedAt: now - 60000 };
  const resolved = C.resolveProgressWrite(tomb, [{ h: "a" }], now - 10000, now);
  assert.ok(resolved);
  assert.deepEqual(Array.from(resolved.rows.map((r) => r.h)), ["a"]);
});

test("写回决策：与已有行并集合并", () => {
  const { C } = createEnv();
  const now = 1000000;
  const existing = { rows: [{ h: "u5" }, { h: "u6" }] };
  const resolved = C.resolveProgressWrite(existing, [{ h: "u1" }, { h: "u6" }], now - 1000, now);
  const hs = Array.from(resolved.rows.map((r) => r.h)).sort();
  assert.deepEqual(hs, ["u1", "u5", "u6"]);
});

test("写回决策：空键（首次保存）正常写回", () => {
  const { C } = createEnv();
  const resolved = C.resolveProgressWrite(null, [{ h: "a" }], 500, 1000);
  assert.ok(resolved);
  assert.deepEqual(Array.from(resolved.rows.map((r) => r.h)), ["a"]);
});

test("扫描进度合并：非法行与空输入", () => {
  const { C } = createEnv();
  assert.deepEqual(Array.from(C.mergeProgressRows([], [], [])), []);
  const merged = C.mergeProgressRows([{ h: "a" }, { h: "" }, null], [{ h: "a" }, { x: 1 }]);
  assert.deepEqual(Array.from(merged).map((r) => r.h), ["a"]);
});

test("合并：空基准（首次运行）时并集生效", () => {
  const { C } = createEnv();
  const merged = C.mergeExcluded([], ["p"], ["q"]);
  assert.deepEqual(Array.from(merged).sort(), ["p", "q"]);
});

/* ------------------------------------------------------------------ */
/* 选择与批次规划                                                      */
/* ------------------------------------------------------------------ */

test("自动选择：候选不足时全选并报告差额", () => {
  const { C } = createEnv();
  const rows = [
    { handle: "a", relation: C.REL.ONE_WAY },
    { handle: "b", relation: C.REL.MUTUAL },
    { handle: "c", relation: C.REL.ONE_WAY },
    { handle: "d", relation: C.REL.UNKNOWN }
  ];
  const plan = C.planAutoSelect(rows, 50);
  assert.deepEqual(Array.from(plan.picked, (r) => r.handle), ["a", "c"]);
  assert.equal(plan.poolSize, 2);
  assert.equal(plan.shortfall, 48);
});

test("自动选择默认取最早的（列表末尾）", () => {
  const { C } = createEnv();
  // 列表顺序 = 最新在前，末尾是最早关注的
  const rows = [
    { handle: "newest", relation: C.REL.ONE_WAY },
    { handle: "y", relation: C.REL.MUTUAL },
    { handle: "old", relation: C.REL.ONE_WAY },
    { handle: "oldest", relation: C.REL.ONE_WAY }
  ];
  const plan = C.planAutoSelect(rows, 2);
  assert.deepEqual(Array.from(plan.picked, (r) => r.handle), ["old", "oldest"]);
  assert.equal(plan.oldestFirst, true);
});

test("显式要求最新时才取开头", () => {
  const { C } = createEnv();
  const rows = [
    { handle: "newest", relation: C.REL.ONE_WAY },
    { handle: "old", relation: C.REL.ONE_WAY }
  ];
  const plan = C.planAutoSelect(rows, 1, null, null, false);
  assert.deepEqual(Array.from(plan.picked, (r) => r.handle), ["newest"]);
});

test("批次规划：超过单批上限的部分进入未处理", () => {
  const { C } = createEnv();
  const rows = Array.from({ length: 60 }, (_, i) => ({ handle: "u" + i, relation: C.REL.ONE_WAY }));
  const selected = new Set(rows.map((r) => r.handle));
  const plan = C.planBatch(rows, selected, 50);
  assert.equal(plan.batch.length, 50);
  assert.equal(plan.deferred.length, 10);
  assert.equal(plan.limit, 50);
});

test("批次规划：非未回关账号即便被选中也排除", () => {
  const { C } = createEnv();
  const rows = [
    { handle: "a", relation: C.REL.ONE_WAY },
    { handle: "b", relation: C.REL.MUTUAL },
    { handle: "c", relation: C.REL.UNKNOWN }
  ];
  const plan = C.planBatch(rows, new Set(["a", "b", "c"]), 50);
  assert.deepEqual(Array.from(plan.batch, (r) => r.handle), ["a"]);
  assert.deepEqual(Array.from(plan.excluded, (r) => r.handle), ["b", "c"]);
});

test("数量与上限的清洗", () => {
  const { C } = createEnv();
  assert.equal(C.sanitizeCount("abc", 50), 50);
  assert.equal(C.sanitizeCount("-3", 50), 50);
  assert.equal(C.sanitizeCount("0", 50), 50);
  assert.equal(C.sanitizeCount("7", 50), 7);
  assert.equal(C.sanitizeCount("99999", 50), 5000);
  assert.equal(C.sanitizeBatchLimit(0), 1);
  assert.equal(C.sanitizeBatchLimit(500), 200);
  assert.equal(C.sanitizeBatchLimit("x"), 50);
  assert.equal(C.sanitizeBatchLimit("33"), 33);
});

test("countStats 只统计「未回关且被选中」为已选", () => {
  const { C } = createEnv();
  const rows = [
    { handle: "a", relation: C.REL.ONE_WAY },
    { handle: "b", relation: C.REL.MUTUAL }
  ];
  const stats = C.countStats(rows, new Set(["a", "b"]));
  assert.equal(stats.total, 2);
  assert.equal(stats.oneWay, 1);
  assert.equal(stats.mutual, 1);
  assert.equal(stats.selected, 1, "已回关账号即使被选中也不计入可执行数");
});

/* ------------------------------------------------------------------ */
/* 页面异常检测                                                        */
/* ------------------------------------------------------------------ */

test("检测主列加载指示器", () => {
  const { C, window } = createEnv(`<div data-testid="primaryColumn"><div role="progressbar"></div></div>`);
  assert.equal(C.detectPageIssues(window.document).loading, true);
});

test("检测人机验证", () => {
  const { C, window } = createEnv(`<div data-testid="primaryColumn"></div><iframe src="https://x.com/arkose/frame"></iframe>`);
  const issues = C.detectPageIssues(window.document);
  assert.equal(issues.blocked, true);
  assert.match(issues.blockedReason, /人机验证/);
});

test("检测限流提示", () => {
  const { C, window } = createEnv(
    `<div data-testid="primaryColumn"><div role="alert">You are temporarily limited. Please try again later.</div></div>`
  );
  const issues = C.detectPageIssues(window.document);
  assert.equal(issues.blocked, true);
});

test("空列表提示与普通空页面区分", () => {
  const { C, window } = createEnv(
    `<div data-testid="primaryColumn"><span>You aren't following anyone yet.</span></div>`
  );
  assert.equal(C.detectPageIssues(window.document).empty, true);
  assert.equal(C.detectPageIssues(window.document).blocked, false);
});

/* ------------------------------------------------------------------ */
/* 排除名单（用户手动保护的真实关注对象）                                */
/* ------------------------------------------------------------------ */

test("自动选择跳过排除名单", () => {
  const { C } = createEnv();
  const rows = [
    { handle: "keep1", relation: C.REL.ONE_WAY },
    { handle: "go1", relation: C.REL.ONE_WAY },
    { handle: "keep2", relation: C.REL.ONE_WAY },
    { handle: "go2", relation: C.REL.ONE_WAY }
  ];
  const plan = C.planAutoSelect(rows, 3, new Set(["keep1", "keep2"]));
  assert.deepEqual(Array.from(plan.picked, (r) => r.handle), ["go1", "go2"]);
  assert.equal(plan.poolSize, 2);
  assert.equal(plan.shortfall, 1);
});

test("批次规划把排除项隔离到 blocked，绝不下发执行", () => {
  const { C } = createEnv();
  const rows = [
    { handle: "keep", relation: C.REL.ONE_WAY },
    { handle: "go", relation: C.REL.ONE_WAY }
  ];
  const plan = C.planBatch(rows, new Set(["keep", "go"]), 50, new Set(["keep"]));
  assert.deepEqual(Array.from(plan.batch, (r) => r.handle), ["go"]);
  assert.deepEqual(Array.from(plan.blocked, (r) => r.handle), ["keep"]);
});

test("未传排除名单时行为与旧版一致", () => {
  const { C } = createEnv();
  const rows = [
    { handle: "a", relation: C.REL.ONE_WAY },
    { handle: "b", relation: C.REL.ONE_WAY }
  ];
  const auto = C.planAutoSelect(rows, 5);
  assert.equal(auto.picked.length, 2);
  const batch = C.planBatch(rows, new Set(["a", "b"]), 50);
  assert.equal(batch.batch.length, 2);
  assert.equal(batch.blocked.length, 0);
});

/* ------------------------------------------------------------------ */
/* 头像提取与合并                                                       */
/* ------------------------------------------------------------------ */

test("从行内取头像时优先 profile_images", () => {
  const { dom, C } = createEnv(`
    <div data-testid="UserCell" id="cell">
      <img src="https://abs.twimg.com/badge.png" alt="">
      <img src="https://pbs.twimg.com/profile_images/123/abc_normal.jpg" alt="">
      <div data-testid="User-Name"><a href="/alice"><span>Alice</span></a></div>
      <div role="button" data-testid="1-unfollow"><span>Following</span></div>
    </div>`);
  const cell = dom.window.document.getElementById("cell");
  assert.match(C.extractAvatar(cell), /profile_images/);
});

test("合并重复行时保留头像，不被空值覆盖", () => {
  const { C } = createEnv();
  const store = new Map();
  const order = [];
  C.mergeRows(store, order, [{
    handle: "alice", name: "Alice", avatar: "https://pbs.twimg.com/profile_images/1/a.jpg",
    relation: C.REL.ONE_WAY, reason: "ok"
  }]);
  C.mergeRows(store, order, [{
    handle: "alice", name: "Alice 2", avatar: "",
    relation: C.REL.ONE_WAY, reason: "ok"
  }]);
  const row = store.get("alice");
  assert.equal(row.name, "Alice 2");
  assert.match(row.avatar, /profile_images/);
  assert.equal(C.rowsInOrder(store, order)[0].avatar, row.avatar);
});

/* ------------------------------------------------------------------ */
/* 定位算法                                                     */
/* ------------------------------------------------------------------ */

test("inferDirection：全部小于目标判向下、全部大于判向上、其它判未知", () => {
  const { C } = createEnv();
  assert.equal(C.inferDirection([3, 4, 5], 12), "down");
  assert.equal(C.inferDirection([12, 13, 14], 5), "up");
  // 目标落在区间内但没找到（虚拟列表间隙）→ 无法判断
  assert.equal(C.inferDirection([3, 9, 15], 8), "unknown");
  // 视口为空或目标索引缺失 → 未知
  assert.equal(C.inferDirection([], 8), "unknown");
  assert.equal(C.inferDirection([1, 2], null), "unknown");
  // 非数字脏数据要忽略掉
  assert.equal(C.inferDirection([undefined, NaN, 4], 9), "down");
});

test("planSeekBounds：单方向 60 步封顶（真实列表可达 2500+ 条 / 27 万像素）", () => {
  const { C } = createEnv();
  const fresh = C.planSeekBounds("up", 0);
  // 跨 realm 的对象原型不同，逐字段断言
  assert.equal(fresh.direction, "up");
  assert.equal(fresh.cap, 60);
  assert.equal(fresh.used, 0);
  assert.equal(fresh.left, 60);
  assert.equal(fresh.exhausted, false);
  assert.equal(C.planSeekBounds("up", 59).exhausted, false);
  assert.equal(C.planSeekBounds("up", 60).exhausted, true);
  assert.equal(C.planSeekBounds("down", 59).left, 1);
  assert.equal(C.planSeekBounds("down", 60).exhausted, true);
  // 脏数据按 0 处理，方向非法时按向下
  assert.equal(C.planSeekBounds("down", -5).used, 0);
  assert.equal(C.planSeekBounds("sideways", 1).direction, "down");
});

test("planSeekTarget：按「行数差 × 局部行高」估算目标位置", () => {
  const { C } = createEnv();
  // 目标在下方：行数差 × 行高
  const down = C.planSeekTarget({ targetIdx: 2600, minIdx: 2510, maxIdx: 2530, minY: 250000, maxY: 252000, rowHeight: 100 });
  assert.equal(down.direction, "down");
  assert.equal(down.rowsAway, 2600 - 2530);
  assert.equal(down.estY, 252000 + (2600 - 2530) * 100);
  // 目标在上方
  const up = C.planSeekTarget({ targetIdx: 10, minIdx: 100, maxIdx: 120, minY: 12000, maxY: 13000, rowHeight: 100 });
  assert.equal(up.direction, "up");
  assert.equal(up.rowsAway, 90);
  assert.equal(up.estY, 12000 - 90 * 100);
  // 序号落在渲染窗口内但行不在 → 虚拟列表跳段
  const inside = C.planSeekTarget({ targetIdx: 110, minIdx: 100, maxIdx: 120, minY: 0, maxY: 100, rowHeight: 100 });
  assert.equal(inside.direction, "inside");
  assert.equal(inside.estY, null);
  // 脏数据
  assert.equal(C.planSeekTarget({ targetIdx: null, minIdx: 1, maxIdx: 2 }).direction, "unknown");
  // 行高缺失时按 84 兜底
  const fallback = C.planSeekTarget({ targetIdx: 12, minIdx: 10, maxIdx: 10, minY: 0, maxY: 1000 });
  assert.equal(fallback.estY, 1000 + 2 * 84);
});

test("行高样本：合并去脏数据、超出上限丢最旧、中位数估算", () => {
  const { C } = createEnv();
  const merged = C.mergeRowHeights([], [84, 0, 12, 300, 9999], 40);
  assert.deepEqual(merged, [84, 300]);

  const capped = C.mergeRowHeights([10, 20, 30], [40, 50], 4);
  assert.deepEqual(capped, [20, 30, 40, 50]);

  // 样本充足 → 中位数
  assert.equal(C.pickRowHeight([72, 300, 300, 300, 72], 84), 300);
  // 样本不足 3 个 → 向回退值收敛
  assert.equal(C.pickRowHeight([300], 84), 192);
  // 没有样本 → 直接用回退值
  assert.equal(C.pickRowHeight([], 120), 120);
  assert.equal(C.pickRowHeight(null, null), 84);
});

test("运行期排除集合：快照与实时值并集，取消排除不回退", () => {
  const { C } = createEnv();
  assert.deepEqual(Array.from(C.mergeRunExcluded(["keep1", "keep2"], ["keep2", "new1"], false)).sort(), ["keep1", "keep2", "new1"]);
  // 快照里有、实时已删除 → 仍保留（本周期不放宽）
  assert.deepEqual(Array.from(C.mergeRunExcluded(["keep1"], [], false)), ["keep1"]);
  // 回关模式不套用排除名单
  assert.deepEqual(Array.from(C.mergeRunExcluded(["keep1"], ["new1"], true)), []);
  // 脏数据过滤
  assert.deepEqual(Array.from(C.mergeRunExcluded([null, "", 1], ["ok"], false)), ["ok"]);
});

test("运行期严格模式只允许收紧", () => {
  const { C } = createEnv();
  assert.equal(C.strictModeForRun(true, false), true);
  assert.equal(C.strictModeForRun(false, true), true);
  assert.equal(C.strictModeForRun(false, false), false);
  assert.equal(C.strictModeForRun(undefined, false), false);
});
