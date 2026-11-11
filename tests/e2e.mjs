/**
 * e2e.mjs — 用无头 Chrome + CDP 跑真实浏览器交互测试
 *
 * 不使用任何第三方依赖：Chrome 自带 headless 模式，Node 22 自带 WebSocket。
 *
 * 运行：
 *   node tests/e2e.mjs scan        // 只读扫描
 *   node tests/e2e.mjs select      // 扫描 + 自动选择 + 清空
 *   node tests/e2e.mjs unfollow    // 扫描 + 选 5 个 + 执行
 *   node tests/e2e.mjs stop        // 扫描 + 选多个 + 执行中停止
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SHOT_DIR = path.join(__dirname, "screenshots");
const PORT = Number(process.env.XFM_CDP_PORT || 9223);
const TEST_PORT = Number(process.env.XFM_TEST_PORT || 38080);
const APP_URL = process.env.XFM_TEST_URL || `http://localhost:${TEST_PORT}/alice/following`;
const CHROME = process.env.CHROME_PATH || [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe')
].find(candidate => fs.existsSync(candidate));
if (!CHROME) throw new Error('未找到 Chrome/Edge，请通过 CHROME_PATH 指定浏览器路径');

const scenario = String(process.argv[2] || "scan").toLowerCase();

fs.mkdirSync(SHOT_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* CDP 客户端                                                          */
/* ------------------------------------------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`页面执行出错: ${detail}\n表达式: ${expression.slice(0, 200)}`);
    }
    return result.result.value;
  }

  async shot(name, clip) {
    // 截图前隐藏测试控制台，避免遮挡产品界面
    await this.evaluate(`(() => { const h = document.getElementById('harness'); if (h) h.style.display = 'none'; })()`);
    // 不开 captureBeyondViewport：全页截图会把 sticky 面板画到文档流位置而不是吸顶状态；
    // 内容高于视口的场景（popup）先用 Emulation.setDeviceMetricsOverride 拉高视口再截
    const params = { format: "png" };
    if (clip) params.clip = clip;
    const { data } = await this.send("Page.captureScreenshot", params);
    const file = path.join(SHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    await this.evaluate(`(() => { const h = document.getElementById('harness'); if (h) h.style.display = ''; })()`);
    console.log(`  截图: ${path.relative(ROOT, file)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(220);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
}

/* ------------------------------------------------------------------ */
/* 启动与连接                                                          */
/* ------------------------------------------------------------------ */

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xfm-e2e-"));
  const proc = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1000,520",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    "about:blank"
  ], { stdio: "ignore" });

  const deadline = Date.now() + 20000;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch (err) { /* 还没起来 */ }
    await sleep(300);
  }
  if (!version) {
    proc.kill();
    throw new Error("无头 Chrome 启动失败");
  }
  return { proc, profile };
}

async function connectNewTab() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: "PUT" });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return { cdp, ws, targetId: target.id };
}

/* ------------------------------------------------------------------ */
/* 页面辅助                                                            */
/* ------------------------------------------------------------------ */

const PANEL = 'document.querySelector(\'[data-xfm-panel-host="1"]\')';
const SR = `${PANEL}.shadowRoot`;

async function panelReady(cdp) {
  return cdp.evaluate(`!!${PANEL}`);
}

async function stat(cdp, role) {
  return cdp.evaluate(`(${SR}.querySelector('[data-role="${role}"]')||{}).textContent || ""`);
}

async function phaseText(cdp) {
  return stat(cdp, "phase");
}

async function statusText(cdp) {
  return stat(cdp, "status");
}

async function clickAction(cdp, act) {
  await cdp.evaluate(`(${SR}.querySelector('[data-act="${act}"]')||{click(){}}).click()`);
}

async function clickShadow(cdp, selector) {
  await cdp.evaluate(`(${SR}.querySelector('${selector}')||{click(){}}).click()`);
}

/* ------------------------------------------------------------------ */
/* 场景                                                                */
/* ------------------------------------------------------------------ */

async function runScan(cdp) {
  console.log("\n[1] 只读扫描");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  const initial = (await phaseText(cdp)).trim();
  console.log(`  初始状态: ${initial}`);
  if (!initial.includes("未扫描")) throw new Error("初始状态应为「未扫描」");

  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描中"), 5000, "进入扫描中");
  console.log(`  扫描中状态: ${(await phaseText(cdp)).trim()}`);

  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 60000, "扫描完成");

  const total = await stat(cdp, "total");
  const oneWay = await stat(cdp, "oneway");
  const unknown = await stat(cdp, "unknown");
  const status = await statusText(cdp);
  console.log(`  扫描结果: 已扫描 ${total}，未回关 ${oneWay}，未知 ${unknown}`);
  console.log(`  状态文本: ${status}`);

  if (total !== "20") throw new Error(`应扫描到 20 个账号，实际 ${total}`);
  if (unknown !== "1") throw new Error(`应有 1 个未知（结构异常行），实际 ${unknown}`);

  const disabledBoxes = await cdp.evaluate(`document.querySelectorAll('[data-xfm-select][data-disabled="1"]').length`);
  const expectedDisabled = Number(total) - Number(oneWay);
  console.log(`  禁用的复选框（已回关 + 未知）: ${disabledBoxes}，期望 ${expectedDisabled}`);
  if (disabledBoxes !== expectedDisabled) {
    throw new Error(`应有 ${expectedDisabled} 个禁用复选框，实际 ${disabledBoxes}`);
  }

  const layout = await cdp.evaluate(`(() => {
    const host = document.querySelector('[data-xfm-panel-host="1"]');
    const sr = host.shadowRoot;
    const r = (el) => el ? { x: Math.round(el.getBoundingClientRect().x), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
    const wrap = sr.querySelector('.wrap');
    return {
      host: r(host), wrap: r(wrap), top: r(sr.querySelector('.row.top')),
      seg: r(sr.querySelector('.seg')), qty: r(sr.querySelector('.field')),
      msg: r(sr.querySelector('.msg.info')),
      overflowX: wrap.scrollWidth > wrap.clientWidth + 1,
      wrapScrollW: wrap.scrollWidth, wrapClientW: wrap.clientWidth
    };
  })()`);
  console.log("  布局: " + JSON.stringify(layout));
  if (layout.overflowX) throw new Error("面板横向溢出，控件不可完整查看");

  const activeFilter = await cdp.evaluate(`(${SR}.querySelector('[data-filter].on')||{}).getAttribute ? (${SR}.querySelector('[data-filter].on')).getAttribute('data-filter') : ""`);
  const rosterBtn = await cdp.evaluate(`(() => { const b = ${SR}.querySelector('[data-role="rosterBtn"]'); return b ? { text: b.textContent, disabled: b.disabled } : null; })()`);
  console.log(`  扫描后筛选: ${activeFilter}；名单按钮: ${JSON.stringify(rosterBtn)}`);
  // v1.6.2：扫描结束后恢复用户原本的筛选偏好（切换瞬间由 preserveScroll 抵消高度变化），
  // 测试台默认筛选是 one-way，因此这里应回到 one-way 而不是留在「全部」
  if (activeFilter !== "one-way") throw new Error("扫描后应恢复用户的筛选偏好（默认 one-way）");
  if (!rosterBtn || rosterBtn.disabled || rosterBtn.text !== "名单") throw new Error("扫描后应出现可用的「名单」按钮");

  const yBefore = await cdp.evaluate(`Math.round(window.scrollY)`);
  await sleep(2500);
  const yAfter = await cdp.evaluate(`Math.round(window.scrollY)`);
  console.log(`  结束后 2.5 秒滚动位置: ${yBefore} → ${yAfter}`);
  if (Math.abs(yAfter - yBefore) > 6) throw new Error("扫描结束后页面仍在自动滚动");

  // 完成后未完成进度必须不存在（在途的节流保存也不得把它写回来；墓碑不算复活）
  const staleProgress = await cdp.evaluate(`(() => {
    const all = JSON.parse(localStorage.getItem("xfm-store") || "{}");
    return Object.keys(all)
      .filter((k) => k.indexOf("xfm.scan.progress.v1") === 0)
      .filter((k) => Array.isArray(all[k].rows) && all[k].rows.length > 0);
  })()`);
  console.log(`  完成后含行数的进度键: ${JSON.stringify(staleProgress)}`);
  if (staleProgress.length !== 0) throw new Error("扫描完成后未完成进度应被清除（含在途保存不得复活）");

  await cdp.shot("01-scan-complete");
  return { total: Number(total), oneWay: Number(oneWay), unknown: Number(unknown) };
}

async function runScheduledSimulation(cdp, mode) {
  console.log(`\n[scheduled] ${mode}`);
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  if (mode === "notifyfail") {
    // 通知通道强制失败：记录仍必须保存，任务结果不得被通知失败覆盖
    await cdp.evaluate(`window.__xfmNotifyFail = true`);
  }
  if (mode === "followback") {
    await cdp.evaluate(`window.__xfmExternalWrite('xfm.settings.v1', { batchLimit: 50, quantity: 50, strictMode: true, excluded: ['user1'] })`);
    await sleep(500);
  }
  const count = mode === "unknown" ? 15 : 3;
  await cdp.evaluate(`window.__xfmDeliverScheduled({type:'XFM_SCHEDULED_RUN',taskKey:'${mode === "followback" ? "followback" : "cleanup"}',taskType:'${mode === "followback" ? "followback" : "cleanup"}',account:'alice',count:${count},order:'asc',due:Date.now(),runId:'simulated-run',manual:true})`);
  await waitFor(async () => cdp.evaluate(`window.__xfmScheduled.records.length > 0`), 120000, "定时任务结果记录");
  const result = await cdp.evaluate(`({ record: window.__xfmScheduled.records[0], events: window.__xfmScheduled.events, notifications: window.__xfmScheduled.notifications })`);
  const begun = result.events.filter(e => e.type === 'XFM_SCHED_ACTION_BEGIN').map(e => e.handle);
  console.log('  结果:', JSON.stringify({status: result.record.status, success: result.record.success, unknown: result.record.unknown, begun}));
  if (mode === 'unknown') {
    if (result.record.unknown !== 1 || !result.record.pause || !begun.includes('stuck_user') || begun.includes('limit_user')) throw new Error('未知结果必须立即停止并暂停，不能继续下一个账号');
  } else {
    if (result.record.success !== 3 || begun.length !== 3) throw new Error('定时人数必须严格按配置执行');
    if (mode === 'followback' && !begun.includes('user1')) throw new Error('回关不应受清理排除名单影响');
    if (mode === 'cleanup' && begun.join(',') !== 'user1,user2,user4') throw new Error('从列表开头选择或执行顺序不正确');
  }
  if (mode === 'notifyfail') {
    if (result.record.status !== 'success' || result.record.success !== 3) throw new Error('通知失败不得影响任务记录');
    if (result.notifications.length !== 0) throw new Error('通知替身应保持失败状态');
  } else if (!result.notifications.length) {
    throw new Error('完成后应发送通知');
  }
}

async function runSelect(cdp) {
  console.log("\n[2] 自动选择 / 清空 / 手动勾选");
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "3"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);

  await clickAction(cdp, "auto");
  await sleep(400);
  let selected = await stat(cdp, "selected");
  console.log(`  自动选择 3 个 → 已选 ${selected}`);
  if (selected !== "3") throw new Error(`应选中 3 个，实际 ${selected}`);

  const checked = await cdp.evaluate(`document.querySelectorAll('[data-xfm-select][data-checked="1"]').length`);
  console.log(`  页面复选框勾选数: ${checked}`);
  if (checked !== 3) throw new Error("复选框未与选择状态同步");

  await cdp.shot("02-auto-select");

  // 清空入口移到了名单窗口底部
  await clickAction(cdp, "roster");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "名单窗口");
  await cdp.evaluate(`${SR}.querySelector('[data-ract="clear"]').click()`);
  await sleep(250);
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(300);
  selected = await stat(cdp, "selected");
  console.log(`  名单内清空后 → 已选 ${selected}`);
  if (selected !== "0") throw new Error("清空后应为 0");

  // 手动勾选第一个复选框
  await cdp.evaluate(`document.querySelector('[data-xfm-select]').click()`);
  await sleep(250);
  selected = await stat(cdp, "selected");
  console.log(`  手动勾选 → 已选 ${selected}`);
  if (selected !== "1") throw new Error("手动勾选应生效");

  // 再点一次取消
  await cdp.evaluate(`document.querySelector('[data-xfm-select]').click()`);
  await sleep(250);
  selected = await stat(cdp, "selected");
  if (selected !== "0") throw new Error("再次点击应取消勾选");
  console.log("  手动取消勾选正常");
}

async function runUnfollow(cdp) {
  console.log("\n[3] 批量取消关注（5 个正常账号）");
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "5"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(400);

  const selected = await stat(cdp, "selected");
  console.log(`  已选 ${selected} 个，准备执行`);
  if (selected !== "5") throw new Error(`应选中 5 个，实际 ${selected}`);

  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay')`), 5000, "确认弹窗");

  const meta = await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.overlay .facts .fact')).map(d=>d.textContent.trim())`);
  console.log(`  确认弹窗信息: ${meta.join(" | ")}`);
  await cdp.shot("03-confirm-dialog");

  const okDisabled = await cdp.evaluate(`(${SR}.querySelector('.overlay [data-dlg="ok"]')).disabled`);
  if (okDisabled !== true) throw new Error("未勾选确认时，执行按钮应禁用");

  await clickShadow(cdp, '.overlay [data-role="ack"]');
  await sleep(150);
  const okEnabled = await cdp.evaluate(`!(${SR}.querySelector('.overlay [data-dlg="ok"]')).disabled`);
  if (!okEnabled) throw new Error("勾选确认后，执行按钮应启用");

  await clickShadow(cdp, '.overlay [data-dlg="ok"]');
  console.log("  已确认，开始执行…");

  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay .sum')`), 60000, "结果弹窗");
  const sums = await cdp.evaluate(
    `Array.from(${SR}.querySelectorAll('.overlay .sum div')).map(d=>d.textContent.trim())`
  );
  console.log(`  执行结果: ${sums.join(" | ")}`);
  const detail = await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.overlay .list .item')).map((e)=>e.textContent.trim())`);
  console.log(`  明细: ${detail.join(" / ")}`);
  const dlgInfo = await cdp.evaluate(`(() => {
    const sr = document.querySelector('[data-xfm-panel-host="1"]').shadowRoot;
    const ov = sr.querySelector('.overlay');
    const dlg = ov.querySelector('.dlg');
    const head = dlg.querySelector('.dhead');
    const host = document.querySelector('[data-xfm-panel-host="1"]');
    const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    return {
      viewport: [window.innerWidth, window.innerHeight],
      host: r(host), hostZ: getComputedStyle(host).zIndex,
      overlay: r(ov), overlayPos: getComputedStyle(ov).position,
      dlg: r(dlg), dlgScrollTop: dlg.scrollTop, dlgScrollH: dlg.scrollHeight, dlgClientH: dlg.clientHeight,
      dhead: r(head),
      tabsZ: (() => { const t = document.querySelector('[role="tablist"]'); let n = t, z = []; for (let i = 0; i < 5 && n; i++) { const cs = getComputedStyle(n); if (cs.position !== 'static') z.push(cs.position + ':' + cs.zIndex); n = n.parentElement; } return z; })()
    };
  })()`);
  console.log("  弹窗: " + JSON.stringify(dlgInfo));

  await cdp.shot("04-result");

  const success = Number(sums[0].replace(/[^\d]/g, ""));
  if (success !== 5) throw new Error(`应成功 5 个，实际 ${success}`);

  const remaining = await cdp.evaluate(`document.querySelectorAll('[data-testid="UserCell"]').length`);
  console.log(`  执行后页面剩余用户行: ${remaining}`);
}

async function runStop(cdp) {
  console.log("\n[4] 执行中停止");
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "50"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(400);

  const selected = await stat(cdp, "selected");
  console.log(`  已选 ${selected} 个`);

  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay')`), 5000, "确认弹窗");
  await clickShadow(cdp, '.overlay [data-role="ack"]');
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');

  await sleep(2500);
  await clickAction(cdp, "stop");
  console.log("  已点击停止");
  await sleep(1200);
  const status = await statusText(cdp);
  console.log(`  停止后状态: ${status}`);
  await cdp.shot("05-stopped");

  // 等待当前操作结束并弹出结果
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay .sum')`), 60000, "结果弹窗");
  const sums = await cdp.evaluate(
    `Array.from(${SR}.querySelectorAll('.overlay .sum div')).map(d=>d.textContent.trim())`
  );
  console.log(`  停止后结果: ${sums.join(" | ")}`);
  await cdp.shot("06-stop-result");
}

async function runLimit(cdp) {
  console.log("\n[5] 单批上限：设置上限 3，选中 5 个");
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "5"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(400);

  const selected = await stat(cdp, "selected");
  console.log(`  已选 ${selected} 个（本批上限 3）`);
  if (selected !== "5") throw new Error(`应选中 5 个，实际 ${selected}`);

  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay')`), 5000, "确认弹窗");

  const meta = await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.overlay .facts .fact')).map(d=>d.textContent.trim())`);
  console.log(`  确认弹窗: ${meta.join(" | ")}`);
  const text = meta.join(" ");
  if (!text.includes("本批3")) throw new Error("超出上限时应只执行 3 个");
  if (!text.includes("超出上限未处理2")) throw new Error("剩余 2 个应标为未处理");
  await cdp.shot("07-limit-dialog");

  const followingBefore = await cdp.evaluate(`document.querySelectorAll('[data-testid$="-unfollow"]').length`);
  await cdp.evaluate(`window.__xfmExternalSettingsWrite({ ...window.__xfmStoredSettings(), batchLimit: 2 })`);
  await clickShadow(cdp, '.overlay [data-role="ack"]');
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');
  await waitFor(() => cdp.evaluate(`${SR}.querySelector('.toast')?.textContent.includes("单批上限已降低")`), 6000, "确认后检查当前上限");
  const followingAfter = await cdp.evaluate(`document.querySelectorAll('[data-testid$="-unfollow"]').length`);
  if (followingAfter !== followingBefore) throw new Error("降低上限后，已有确认框不能继续执行");
  await cdp.evaluate(`window.__xfmExternalSettingsWrite({ ...window.__xfmStoredSettings(), batchLimit: 3 })`);
  await waitFor(() => cdp.evaluate(`!window.__xfmStoredValue("xfm.run.lock.v1")`), 6000, "取消旧批次后释放执行锁");

  await clickAction(cdp, "unfollow");
  await waitFor(() => cdp.evaluate(`!!${SR}.querySelector('.overlay [data-role="ack"]')`), 6000, "按当前上限重新确认");
  await clickShadow(cdp, '.overlay [data-role="ack"]');
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay .sum')`), 60000, "结果弹窗");

  const sums = await cdp.evaluate(
    `Array.from(${SR}.querySelectorAll('.overlay .sum div')).map(d=>d.textContent.trim())`
  );
  console.log(`  执行结果: ${sums.join(" | ")}`);
  const success = Number(sums[0].replace(/[^\d]/g, ""));
  const pending = Number(sums[4].replace(/[^\d]/g, ""));
  if (success !== 3) throw new Error(`应只成功 3 个，实际 ${success}`);
  if (pending !== 2) throw new Error(`应有 2 个未处理，实际 ${pending}`);
  await cdp.shot("08-limit-result");
}

async function runAnomaly(cdp) {
  console.log("\n[6] 异常账号：无响应 + 触发限制");
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "50"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(500);

  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay')`), 5000, "确认弹窗");
  await clickShadow(cdp, '.overlay [data-role="ack"]');
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');
  console.log("  已确认，等待异常分支…");

  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay .sum')`), 120000, "结果弹窗");
  const sums = await cdp.evaluate(
    `Array.from(${SR}.querySelectorAll('.overlay .sum div')).map(d=>d.textContent.trim())`
  );
  const detail = await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.overlay .list div')).map(d=>d.textContent.trim()).slice(0,20)`);
  console.log(`  结果: ${sums.join(" | ")}`);
  console.log(`  明细: ${detail.join(" / ")}`);

  const text = detail.join(" ");
  if (!/未观察到可确认的成功状态/.test(text)) throw new Error("应记录「结果未知」的账号");
  if (!/限制|错误|出错|重试/.test(text)) throw new Error("应记录限制类失败");
  await cdp.shot("09-anomaly-result");
}

async function runJump(cdp) {
  console.log("\n[7] 执行中切换页面（SPA 路由）");
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "50"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(400);
  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay')`), 5000, "确认弹窗");
  await clickShadow(cdp, '.overlay [data-role="ack"]');
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');
  console.log("  执行中，2 秒后切换路由…");

  await sleep(2000);
  await cdp.evaluate(`history.pushState({}, "", "/alice/profile")`);

  const gone = await waitFor(
    async () => cdp.evaluate(`!document.querySelector('[data-xfm-panel-host="1"]')`),
    8000,
    "离开关注页后面板卸载"
  ).then(() => true).catch(() => false);

  console.log(`  面板已卸载: ${gone}`);
  if (!gone) throw new Error("切换路由后应卸载面板并中止任务");

  const leftover = await cdp.evaluate(`document.querySelectorAll('[data-xfm-select]').length`);
  console.log(`  页面残留复选框: ${leftover}`);
  if (leftover !== 0) throw new Error("切换路由后不应残留复选框");
}

async function runFail(cdp) {
  console.log("\n[8] 扫描中页面报错");
  await clickAction(cdp, "scan");
  await sleep(1400);
  await cdp.evaluate(`window.__mockFail()`);
  await waitFor(async () => (await phaseText(cdp)).includes("扫描失败"), 10000, "扫描失败状态");
  const status = await statusText(cdp);
  console.log(`  状态: ${status}`);
  if (!/出错|错误|重试|Something|went wrong/i.test(status)) {
    throw new Error("失败原因应可读，而不是静默显示 0 个");
  }

  // 失败前已扫描到的账号仍可勾选，但不允许执行
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "2"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(400);

  const selected = await stat(cdp, "selected");
  const canUnfollow = await cdp.evaluate(`!(${SR}.querySelector('[data-act="unfollow"]')).disabled`);
  console.log(`  已选 ${selected} 个，取消关注按钮可用: ${canUnfollow}`);
  if (canUnfollow) throw new Error("扫描失败后即使选中账号也不应允许执行");
  await cdp.shot("10-scan-failed");
}

async function runStrict(cdp) {
  console.log("\n[9] 严格校验：整页没有「关注了你」标记");
  const warn = await cdp.evaluate(
    `(() => { const w = ${SR}.querySelector('[data-role="warn"]'); return w && !w.hidden ? w.textContent : ''; })()`
  );
  console.log(`  警告文案: ${warn.slice(0, 80)}…`);
  if (!warn.includes("没有检测到任何")) throw new Error("应显示零回关标记的阻断警告");

  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "5"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(400);

  const disabled = await cdp.evaluate(`(${SR}.querySelector('[data-act="unfollow"]')).disabled`);
  console.log(`  取消关注按钮 disabled = ${disabled}`);
  if (!disabled) throw new Error("完整性校验未通过时，执行按钮应禁用");

  await clickAction(cdp, "unfollow");
  await sleep(1000);
  const hasDialog = await cdp.evaluate(`!!${SR}.querySelector('.overlay')`);
  if (hasDialog) throw new Error("被阻断时不应弹出确认框");
  await cdp.shot("11-strict-blocked");

  await cdp.evaluate(`window.__xfmExternalSettingsWrite({ ...window.__xfmStoredSettings(), strictMode: false })`);
  await clickAction(cdp, "unfollow");
  await waitFor(() => cdp.evaluate(`!!${SR}.querySelector('.overlay [data-role="ack"]')`), 6000, "严格校验关闭时可打开确认框");
  const followingBefore = await cdp.evaluate(`document.querySelectorAll('[data-testid$="-unfollow"]').length`);
  await cdp.evaluate(`window.__xfmExternalSettingsWrite({ ...window.__xfmStoredSettings(), strictMode: true })`);
  await clickShadow(cdp, '.overlay [data-role="ack"]');
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');
  await waitFor(() => cdp.evaluate(`${SR}.querySelector('.toast')?.textContent.includes("完整性校验未通过")`), 6000, "确认后重新执行严格校验");
  const followingAfter = await cdp.evaluate(`document.querySelectorAll('[data-testid$="-unfollow"]').length`);
  if (followingAfter !== followingBefore) throw new Error("重新开启严格校验后，已有确认框不能继续执行");
}

async function runDup(cdp) {
  console.log("\n[10] 扩展重复注入");
  const before = await cdp.evaluate(`document.querySelectorAll('[data-xfm-panel-host]').length`);
  await cdp.evaluate(
    `new Promise((resolve) => { const s = document.createElement('script'); s.src = '/x-follow-manager/content/content.js'; s.onload = () => resolve(true); s.onerror = () => resolve(false); document.body.appendChild(s); })`
  );
  await sleep(900);
  const after = await cdp.evaluate(`document.querySelectorAll('[data-xfm-panel-host]').length`);
  const checks = await cdp.evaluate(`document.querySelectorAll('[data-xfm-select]').length`);
  console.log(`  面板数量 ${before} → ${after}；复选框 ${checks}`);
  if (before !== 1 || after !== 1) throw new Error("重复注入不应产生第二个面板");
  if (checks > 20) throw new Error("复选框数量异常，疑似重复注入");
}

async function runEnglish(cdp) {
  console.log("\n[11] 英文界面标记");
  await cdp.evaluate(`document.getElementById('btnLang').click()`);
  await sleep(600);
  const langText = await cdp.evaluate(`document.getElementById('langLabel').textContent`);
  console.log(`  ${langText}`);

  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 60000, "英文界面扫描完成");
  const total = await stat(cdp, "total");
  const oneWay = await stat(cdp, "oneway");
  const unknown = await stat(cdp, "unknown");
  console.log(`  结果: 已扫描 ${total}，未回关 ${oneWay}，未知 ${unknown}`);
  if (total !== "20" || oneWay !== "13" || unknown !== "1") {
    throw new Error("英文标记下结果应与中文一致");
  }
  await cdp.shot("12-english-ui");
}

async function runScanStop(cdp) {
  console.log("\n[12] 扫描中途停止");
  await clickAction(cdp, "scan");
  await sleep(1600);
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 6000, "标记为不完整");
  const status = await statusText(cdp);
  const total = await stat(cdp, "total");
  console.log(`  状态: ${status}`);
  console.log(`  已保留已扫描账号: ${total}`);
  if (!/不完整|停止/.test(status)) throw new Error("停止后应明确标注结果不完整");
  if (Number(total) === 0) throw new Error("停止后应保留已扫描结果");
  await cdp.shot("13-scan-stopped");
}

async function runDark(cdp) {
  console.log("\n[13] 深色模式");
  const theme = await cdp.evaluate(`document.querySelector('[data-xfm-panel-host="1"]').getAttribute('data-xfm-theme')`);
  console.log(`  面板主题: ${theme}`);
  if (theme !== "dark") throw new Error("深色页面下应自动切换为 dark 主题");
  await cdp.shot("14-dark-theme");
}


async function runExclude(cdp) {
  console.log("\n[14] 排除名单（保护真实关注的人）");

  // 右键第一个未回关行 -> 排除
  const firstHandle = await cdp.evaluate(`(() => {
    const box = document.querySelector('[data-xfm-select][data-disabled="0"]');
    if (!box) return null;
    const h = box.getAttribute("data-handle");
    box.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    return h;
  })()`);
  if (!firstHandle) throw new Error("没有可排除的候选行");
  await sleep(500);

  const excludedCount = await stat(cdp, "excluded");
  const flag = await cdp.evaluate(`document.querySelector('[data-xfm-select][data-handle="${firstHandle}"]').getAttribute("data-excluded")`);
  console.log(`  右键排除 @${firstHandle} -> 已排除 ${excludedCount}，标记 ${flag}`);
  if (excludedCount !== "1" || flag !== "1") throw new Error("排除未生效");

  // 自动选择 3 个，必须跳过被排除的
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "3"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(600);

  const checkedHandles = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-xfm-select][data-checked="1"]')).map(el => el.getAttribute("data-handle"))`);
  console.log(`  自动选择 3 个: ${checkedHandles.join(", ")}`);
  if (checkedHandles.includes(firstHandle)) throw new Error("自动选择没有跳过排除项");
  if (checkedHandles.length !== 3) throw new Error(`应选中 3 个，实际 ${checkedHandles.length}`);

  await cdp.shot("16-exclude");

  // 右键恢复
  await cdp.evaluate(`document.querySelector('[data-xfm-select][data-handle="${firstHandle}"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await sleep(400);
  const restored = await stat(cdp, "excluded");
  console.log(`  再次右键恢复 -> 已排除 ${restored}`);
  if (restored !== "0") throw new Error("恢复排除失败");
}


async function runResume(cdp) {
  console.log("\n[15] 停止后继续扫描");
  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描中"), 5000, "进入扫描中");
  await sleep(1200);
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 6000, "标记不完整");

  const before = Number(await stat(cdp, "total"));
  const label = await cdp.evaluate(`(${SR}.querySelector('[data-act="scan"]')).textContent`);
  console.log(`  停止时已扫描 ${before} 个，按钮文案「${label}」`);
  if (label !== "继续扫描") throw new Error("停止后按钮应变为「继续扫描」");
  if (before === 0) throw new Error("停止前应已扫描到部分账号");

  await clickAction(cdp, "scan");
  await sleep(600);
  const phaseAfter = await phaseText(cdp);
  if (!phaseAfter.includes("扫描中")) throw new Error("点击继续后应回到扫描中");
  console.log(`  继续后状态: ${phaseAfter}`);

  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 30000, "继续直到完成");
  const after = Number(await stat(cdp, "total"));
  console.log(`  继续后共扫描 ${after} 个（继续前 ${before} 个）`);
  if (after <= before) throw new Error("继续扫描没有带来新增");
  if (after !== 20) throw new Error(`应补齐到 20 个，实际 ${after}`);
  await cdp.shot("17-resume");
}


async function runReply(cdp) {
  console.log("\n[16] 粉丝页回关模式");
  const brand = await cdp.evaluate(`(${SR}.querySelector('[data-role="brand"]')).textContent`);
  const label = await cdp.evaluate(`(${SR}.querySelector('[data-role="label-candidate"]')).textContent`);
  console.log(`  面板标题「${brand}」，候选标签「${label}」`);
  if (brand !== "粉丝回关" || label !== "待回关") throw new Error("粉丝页应切换到回关模式");

  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 60000, "回关扫描完成");
  const total = await stat(cdp, "total");
  const pending = await stat(cdp, "oneway");
  const unknown = await stat(cdp, "unknown");
  console.log(`  扫描: 共 ${total}，待回关 ${pending}，未知 ${unknown}`);
  if (pending !== "13") throw new Error(`应有 13 个待回关，实际 ${pending}`);
  if (unknown !== "1") throw new Error(`应有 1 个未知，实际 ${unknown}`);

  // 名单窗口在回关模式下应显示「待回关」语义
  await clickAction(cdp, "roster");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "回关名单打开");
  const rTitle = await cdp.evaluate(`(${SR}.querySelector('.dlg.wide h3')).textContent`);
  const rTab = await cdp.evaluate(`(${SR}.querySelector('[data-rtab="candidate"]')).textContent`);
  console.log(`  回关名单: 标题「${rTitle}」，页签「${rTab}」`);
  if (rTitle !== "粉丝回关名单" || !rTab.includes("待回关")) throw new Error("回关名单文案不正确");
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(300);



  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "3"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(400);
  const selected = await stat(cdp, "selected");
  const btnText = await cdp.evaluate(`(${SR}.querySelector('[data-act="unfollow"]')).textContent`);
  console.log(`  已选 ${selected} 个，按钮「${btnText}」`);
  if (selected !== "3") throw new Error(`应选中 3 个，实际 ${selected}`);
  if (!btnText.includes("回关")) throw new Error("按钮文案应为回关");

  await clickAction(cdp, "unfollow");
  await sleep(150);
  const early = await cdp.evaluate(`(() => {
    const sr = ${SR};
    const ov = sr.querySelector('.overlay');
    return { overlay: !!ov, okDisabled: ov ? ov.querySelector('[data-dlg="ok"]').disabled : null, ack: ov ? ov.querySelector('[data-role="ack"]').checked : null };
  })()`);
  console.log("  点击后 150ms: " + JSON.stringify(early));
  await sleep(1200);
  const diag = await cdp.evaluate(`(() => {
    const sr = ${SR};
    const toast = sr.querySelector('.toast');
    return {
      overlay: !!sr.querySelector('.overlay'),
      toast: toast ? toast.textContent : null,
      brand: sr.querySelector('[data-role="brand"]').textContent,
      status: sr.querySelector('[data-role="status"]').textContent,
      btn: sr.querySelector('[data-act="unfollow"]').textContent,
      disabled: sr.querySelector('[data-act="unfollow"]').disabled,
      toolsHidden: sr.querySelector('[data-role="tools"]').hidden,
      scanHidden: sr.querySelector('[data-act="scan"]').hidden,
      runbarHidden: sr.querySelector('[data-role="runbar"]').hidden,
      phase: sr.querySelector('[data-role="phase"]').textContent
    };
  })()`);
  console.log("  点击后诊断: " + JSON.stringify(diag));
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay')`), 5000, "确认弹窗");
  const title = await cdp.evaluate(`(${SR}.querySelector('.overlay h3')).textContent`);
  const okText = await cdp.evaluate(`(${SR}.querySelector('.overlay [data-dlg="ok"]')).textContent`);
  console.log(`  确认弹窗「${title}」，按钮「${okText}」`);
  if (title !== "确认回关") throw new Error("确认弹窗标题应为确认回关");
  if (!okText.includes("回关 3")) throw new Error("确认按钮应显示回关数量");
  await cdp.shot("18-reply-confirm");

  await clickShadow(cdp, '.overlay [data-role="ack"]');
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay .sum')`), 60000, "结果弹窗");
  const sums = await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.overlay .sum div')).map(d=>d.textContent.trim())`);
  console.log(`  执行结果: ${sums.join(" | ")}`);
  const ok = Number(sums[0].replace(/[^\d]/g, ""));
  if (ok !== 3) throw new Error(`应成功回关 3 个，实际 ${ok}`);

  const nowFollowing = await cdp.evaluate(`document.querySelectorAll('[data-testid$="-unfollow"]').length`);
  console.log(`  页面「正在关注」按钮数量: ${nowFollowing}`);
  await cdp.shot("19-reply-result");
}


async function pressEscape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}

async function runRoster(cdp) {
  console.log("\n[17] 名单窗口：搜索 / 勾选 / 排除");
  await clickAction(cdp, "roster");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "名单窗口打开");

  const title = await cdp.evaluate(`(${SR}.querySelector('.dlg.wide h3')).textContent`);
  const summary = await cdp.evaluate(`(${SR}.querySelector('.rsummary')).textContent`);
  const rows = await cdp.evaluate(`${SR}.querySelectorAll('.rrow').length`);
  console.log(`  标题「${title}」，摘要「${summary}」，候选行 ${rows}`);
  if (title !== "未回关名单") throw new Error("名单标题应为未回关名单");
  if (rows !== 13) throw new Error(`候选应有 13 行，实际 ${rows}`);

  const withAvatar = await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.rrow')).filter((r) => !!r.querySelector('.ravatar img')).length`);
  console.log(`  带头像的行: ${withAvatar}`);
  if (withAvatar < 3) throw new Error(`头像未被保留，实际只有 ${withAvatar} 行`);

  // 搜索
  await cdp.evaluate(`(() => { const i = ${SR}.querySelector('.rsearch'); i.value = 'alpha'; i.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  const filtered = await cdp.evaluate(`${SR}.querySelectorAll('.rrow').length`);
  const firstHandle = await cdp.evaluate(`${SR}.querySelector('.rrow') ? ${SR}.querySelector('.rrow').getAttribute('data-handle') : ''`);
  console.log(`  搜索 alpha → ${filtered} 行（${firstHandle}）`);
  if (filtered !== 1 || firstHandle !== "alpha_dev") throw new Error("搜索未正确过滤");

  await cdp.evaluate(`(() => { const i = ${SR}.querySelector('.rsearch'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  await cdp.shot("20-roster");

  // 勾选第一行
  const pickHandle = await cdp.evaluate(`(() => { const b = ${SR}.querySelector('.rrow[data-kind="candidate"] .rcheck'); const h = b.closest('.rrow').getAttribute('data-handle'); b.click(); return h; })()`);
  await sleep(300);
  const selAfter = await stat(cdp, "selected");
  console.log(`  勾选 @${pickHandle} → 面板已选 ${selAfter}`);
  if (selAfter !== "1") throw new Error(`勾选后应为 1，实际 ${selAfter}`);

  // 排除另一行
  const exHandle = await cdp.evaluate(`(() => {
    const rows = Array.from(${SR}.querySelectorAll('.rrow[data-kind="candidate"]'));
    const target = rows.find((r) => r.getAttribute('data-handle') !== '${pickHandle}');
    if (!target) return '';
    const h = target.getAttribute('data-handle');
    target.querySelector('.rex').click();
    return h;
  })()`);
  await sleep(300);
  const exAfter = await stat(cdp, "excluded");
  const rowExcluded = await cdp.evaluate(`(() => { const r = ${SR}.querySelector('.rrow[data-handle="${exHandle}"]'); return r ? r.getAttribute('data-excluded') : null; })()`);
  console.log(`  排除 @${exHandle} → 面板已排除 ${exAfter}，行标记 ${rowExcluded}`);
  if (exAfter !== "1" || rowExcluded !== "1") throw new Error("排除未生效");

  // 已排除页签
  await cdp.evaluate(`${SR}.querySelector('[data-rtab="excluded"]').click()`);
  await sleep(250);
  const exRows = await cdp.evaluate(`${SR}.querySelectorAll('.rrow').length`);
  console.log(`  已排除页签 → ${exRows} 行`);
  if (exRows !== 1) throw new Error("已排除页签数量不对");

  await cdp.shot("20b-roster-excluded");

  // 关闭后状态保留
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await waitFor(async () => cdp.evaluate(`!${SR}.querySelector('.overlay')`), 4000, "名单窗口关闭");
  const panelSel = await stat(cdp, "selected");
  const panelEx = await stat(cdp, "excluded");
  console.log(`  关闭后：面板已选 ${panelSel}，已排除 ${panelEx}`);
  if (panelSel !== "1" || panelEx !== "1") throw new Error("关闭后状态丢失");

  // 重开验证持久
  await clickAction(cdp, "roster");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "名单窗口重开");
  await cdp.evaluate(`${SR}.querySelector('[data-rtab="selected"]').click()`);
  await sleep(250);
  const selRows = await cdp.evaluate(`${SR}.querySelectorAll('.rrow').length`);
  console.log(`  重开后已选页签 → ${selRows} 行`);
  if (selRows !== 1) throw new Error("重开后选择状态丢失");
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(300);
}

async function runExcludeMode(cdp) {
  console.log("\n[18] 排除模式：左键即排除");
  await clickAction(cdp, "exclude-mode");
  await sleep(300);
  const armed = await cdp.evaluate(`(${SR}.querySelector('[data-role="excludeBtn"]')).classList.contains('on')`);
  const hintVisible = await cdp.evaluate(`(() => { const h = ${SR}.querySelector('[data-role="armHint"]'); return h && !h.hidden; })()`);
  const boxArmed = await cdp.evaluate(`(document.querySelector('[data-xfm-select][data-disabled="0"]')).getAttribute('data-armed')`);
  console.log(`  排除模式开启: ${armed}，提示条 ${hintVisible}，复选框标记 ${boxArmed}`);
  if (!armed || !hintVisible || boxArmed !== "1") throw new Error("排除模式未生效");

  await cdp.evaluate(`(() => { const b = document.querySelector('[data-xfm-select][data-disabled="0"]'); b.click(); })()`);
  await sleep(300);
  const ex = await stat(cdp, "excluded");
  const sel = await stat(cdp, "selected");
  console.log(`  左键点击后：已排除 ${ex}，已选 ${sel}`);
  if (ex !== "1" || sel !== "0") throw new Error("排除模式点击应排除而不是勾选");

  await clickAction(cdp, "exclude-mode");
  await sleep(200);
  const armedOff = await cdp.evaluate(`(${SR}.querySelector('[data-role="excludeBtn"]')).classList.contains('on')`);
  console.log(`  关闭排除模式: on=${armedOff}`);
  if (armedOff) throw new Error("排除模式未关闭");
  await cdp.shot("21-exclude-mode");
}

async function runDialogKeys(cdp) {
  console.log("\n[19] 弹窗键盘与遮罩关闭");
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "2"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(400);

  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay')`), 5000, "确认弹窗出现");
  await cdp.evaluate(`${SR}.querySelector('[data-dlg="cancel"]').focus()`);
  await cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  const trapped=await cdp.evaluate(`${SR}.querySelector('.dlg').contains(${SR}.activeElement)`);
  if(!trapped) throw Error('Tab 焦点逃出确认弹窗');
  await pressEscape(cdp);
  await sleep(300);
  const afterEsc = await cdp.evaluate(`!!${SR}.querySelector('.overlay')`);
  const running = (await phaseText(cdp)).includes("执行中");
  console.log(`  ESC 后弹窗存在: ${afterEsc}，任务执行中: ${running}`);
  if (afterEsc) throw new Error("ESC 未关闭确认弹窗");
  if (running) throw new Error("ESC 后不应开始执行");

  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay')`), 5000, "确认弹窗再次出现");
  await cdp.evaluate(`(() => {
    const ov = ${SR}.querySelector('.overlay');
    ov.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  })()`);
  await sleep(300);
  const afterBackdrop = await cdp.evaluate(`!!${SR}.querySelector('.overlay')`);
  const running2 = (await phaseText(cdp)).includes("执行中");
  console.log(`  点遮罩后弹窗存在: ${afterBackdrop}，任务执行中: ${running2}`);
  if (afterBackdrop) throw new Error("点遮罩未关闭确认弹窗");
  if (running2) throw new Error("点遮罩后不应开始执行");
}


async function runNarrow(cdp) {
  console.log("\n[20] 窄屏布局（520px）");
  const info = await cdp.evaluate(`(() => {
    const sr = document.querySelector('[data-xfm-panel-host="1"]').shadowRoot;
    const wrap = sr.querySelector('.wrap');
    const seen = (sel) => {
      const el = sr.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const extra = sr.querySelector('.metric.extra');
    return {
      viewport: [window.innerWidth, window.innerHeight],
      wrap: [wrap.clientWidth, wrap.scrollWidth],
      overflowX: wrap.scrollWidth > wrap.clientWidth + 1,
      scan: seen('[data-act="scan"]'),
      unfollow: seen('[data-act="unfollow"]'),
      auto: seen('[data-act="auto"]'),
      exclude: seen('[data-act="exclude-mode"]'),
      clear: seen('[data-act="clear"]'),
      extraHidden: extra ? getComputedStyle(extra).display === 'none' : null,
      height: Math.round(wrap.getBoundingClientRect().height)
    };
  })()`);
  console.log("  " + JSON.stringify(info));
  if (info.overflowX) throw new Error("窄屏出现横向溢出");
  if (!info.scan || !info.unfollow) throw new Error("窄屏下主操作按钮不可见");
  if (!info.extraHidden) throw new Error("窄屏下应隐藏次要指标");
  if (info.height > 200) throw new Error(`窄屏面板过高：${info.height}px`);
  await cdp.shot("22-narrow");
}


async function runCollapse(cdp) {
  console.log("\n[21] 折叠状态与设置记忆");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  const before = await cdp.evaluate(`(() => {
    const sr = document.querySelector('[data-xfm-panel-host="1"]').shadowRoot;
    return { collapsed: sr.querySelector('[data-role="wrap"]').getAttribute('data-collapsed'), icon: sr.querySelector('[data-act="collapse"]').textContent };
  })()`);
  console.log(`  初始: ${JSON.stringify(before)}`);

  await clickAction(cdp, "collapse");
  await sleep(250);
  const folded = await cdp.evaluate(`(() => {
    const sr = document.querySelector('[data-xfm-panel-host="1"]').shadowRoot;
    const tools = sr.querySelector('[data-role="tools"]');
    return {
      collapsed: sr.querySelector('[data-role="wrap"]').getAttribute('data-collapsed'),
      toolsHidden: getComputedStyle(tools).display === 'none',
      icon: sr.querySelector('[data-act="collapse"]').textContent
    };
  })()`);
  console.log(`  收起后: ${JSON.stringify(folded)}`);
  if (folded.collapsed !== "1" || !folded.toolsHidden || folded.icon !== "▸") throw new Error("折叠未生效");

  await cdp.send("Page.reload", {});
  await waitFor(() => panelReady(cdp), 8000, "刷新后面板挂载");
  await sleep(500);
  const restored = await cdp.evaluate(`(() => {
    const sr = document.querySelector('[data-xfm-panel-host="1"]').shadowRoot;
    return {
      collapsed: sr.querySelector('[data-role="wrap"]').getAttribute('data-collapsed'),
      toolsHidden: getComputedStyle(sr.querySelector('[data-role="tools"]')).display === 'none'
    };
  })()`);
  console.log(`  刷新后: ${JSON.stringify(restored)}`);
  if (restored.collapsed !== "1" || !restored.toolsHidden) throw new Error("折叠状态未持久化");

  await clickAction(cdp, "collapse");
  await sleep(250);
  const opened = await cdp.evaluate(`document.querySelector('[data-xfm-panel-host="1"]').shadowRoot.querySelector('[data-role="wrap"]').getAttribute('data-collapsed')`);
  console.log(`  再次展开: collapsed=${opened}`);
  if (opened !== "0") throw new Error("无法展开");
  await cdp.shot("23-collapse");
}


async function runScrollLock(cdp) {
  console.log("\n[23] 右键排除/勾选不改变滚动位置");
  const h = await cdp.evaluate(`document.documentElement.scrollHeight`);
  const midY = Math.floor(h / 2);

  const probe = async (label) => {
    await cdp.evaluate(`window.scrollTo({ top: ${midY}, behavior: "instant" })`);
    await sleep(750);
    const before = await cdp.evaluate(`window.scrollY`);
    const handle = await cdp.evaluate(`(() => {
      const boxes = Array.from(document.querySelectorAll('[data-xfm-select][data-disabled="0"][data-excluded="0"]'));
      const visible = boxes.find((b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
      const b = visible || boxes[0];
      if (!b) return null;
      b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      return b.getAttribute("data-handle");
    })()`);
    if (!handle) throw new Error("没有可排除的候选行");
    await sleep(3400); // 覆盖延迟清提示的 render
    const after = await cdp.evaluate(`window.scrollY`);
    const height = await cdp.evaluate(`document.documentElement.scrollHeight`);
    console.log(`  ${label} @${handle}: ${before} → ${after}（位移 ${Math.abs(after - before)}px，页高 ${height}）`);
    if (Math.abs(after - before) > 40) throw new Error(`${label}导致滚动位置跳动 ${after - before}px`);
    if (height !== h) throw new Error(`页面高度发生变化 ${h} → ${height}，提示条仍在文档流内`);
    // 恢复排除状态，避免影响后续用例
    await cdp.evaluate(`document.querySelector('[data-xfm-select][data-handle="${handle}"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await sleep(900);
  };

  await probe("右键排除");
  await probe("再次右键（恢复）");

  // 左键勾选同样不能拉走页面
  await cdp.evaluate(`window.scrollTo({ top: ${midY}, behavior: "instant" })`);
  await sleep(750);
  const beforeSel = await cdp.evaluate(`window.scrollY`);
  await cdp.evaluate(`(() => {
    const boxes = Array.from(document.querySelectorAll('[data-xfm-select][data-disabled="0"][data-checked="0"]'));
    const visible = boxes.find((b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
    (visible || boxes[0]).click();
  })()`);
  await sleep(900);
  const afterSel = await cdp.evaluate(`window.scrollY`);
  console.log(`  左键勾选: ${beforeSel} → ${afterSel}（位移 ${Math.abs(afterSel - beforeSel)}px）`);
  if (Math.abs(afterSel - beforeSel) > 40) throw new Error("左键勾选导致滚动位置跳动");
  await cdp.evaluate(`(() => {
    const boxes = Array.from(document.querySelectorAll('[data-xfm-select][data-checked="1"]'));
    const visible = boxes.find((b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
    (visible || boxes[0]).click();
  })()`);
  await sleep(600);
  await cdp.shot("26-scroll-lock");
}

async function runInteractionAudit(cdp) {
  const started = Date.now();
  await scanToEnd(cdp, 60, 120000);
  console.log(`SCAN_MS=${Date.now() - started}`);
  const hidden = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-xfm-rel]')).filter(e=>getComputedStyle(e).display==='none').length`);
  if (hidden) throw new Error(`原生虚拟列表中有 ${hidden} 行被 display:none 隐藏`);
  await cdp.evaluate(`window.scrollTo(0, document.documentElement.scrollHeight * .55)`);
  await sleep(700);
  const sample = await cdp.evaluate(`(() => {
    const box = Array.from(document.querySelectorAll('[data-xfm-select][data-disabled="0"]')).find(e=>{const r=e.getBoundingClientRect();return r.top>180 && r.bottom<innerHeight});
    if (!box) throw Error('缺少可见候选');
    const y=scrollY, start=performance.now();
    box.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    return {y,ms:performance.now()-start,handle:box.getAttribute('data-handle')};
  })()`);
  await sleep(700);
  const after=await cdp.evaluate(`scrollY`);
  console.log(`EXCLUDE_MS=${sample.ms}; SCROLL=${sample.y}->${after}`);
  if(Math.abs(after-sample.y)>40) throw Error('排除后视口跳动');
  await cdp.evaluate(`document.querySelector('[data-xfm-select][data-handle="${sample.handle}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); window.dispatchEvent(new WheelEvent('wheel',{deltaY:-220})); window.scrollBy(0,-220);`);
  // 虚拟测试台复用节点时浏览器会先做原生锚定，等这一帧稳定后再检查延迟恢复。
  await sleep(80);
  const userY=await cdp.evaluate(`scrollY`);
  await sleep(750);
  const settledY=await cdp.evaluate(`scrollY`);
  console.log(`USER_SCROLL=${userY}->${settledY}`);
  if(Math.abs(settledY-userY)>40) throw Error('延迟回滚抢走了用户滚动');
  await setQty(cdp, 3);
  await clickAction(cdp, 'auto');
  await clickAction(cdp, 'unfollow');
  await waitFor(async()=>cdp.evaluate(`!!${SR}.querySelector('.pick')`),5000,'确认名单');
  const lastHandle=await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.pick')).at(-1).getAttribute('data-handle')`);
  await cdp.evaluate(`window.scrollTo(0,0)`);
  await sleep(1000);
  await clickShadow(cdp, '.overlay [data-role="ack"]');
  const runStarted=Date.now();
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');
  const {sums}=await readResult(cdp,60000);
  expectClean(sums,3);
  const first=await cdp.evaluate(`${SR}.querySelector('.dlg .list .item .h').textContent`);
  if(first.replace('@','')!==lastHandle) throw Error('没有从本批最靠后的目标开始');
  console.log(`FIRST_TARGET=${lastHandle}; RUN_MS=${Date.now()-runStarted}`);
}

async function runConfirmEdit(cdp) {
  console.log("\n[22] 确认弹窗内取消勾选 / 排除");
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "5"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(400);

  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay .pick')`), 5000, "确认弹窗出现");

  const handles = await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.pick')).map((r) => r.getAttribute('data-handle'))`);
  console.log(`  本批账号: ${handles.join(", ")}`);
  if (handles.length !== 5) throw new Error(`应有 5 行，实际 ${handles.length}`);

  const read = async () => cdp.evaluate(`(() => ({
    count: Number(${SR}.querySelector('[data-role="count"]').textContent),
    ok: ${SR}.querySelector('[data-dlg="ok"]').textContent,
    disabled: ${SR}.querySelector('[data-dlg="ok"]').disabled,
    excludedFact: (() => { const f = ${SR}.querySelector('[data-role="excludedFact"]'); return f && !f.hidden ? Number(f.querySelector('b').textContent) : 0; })(),
    includes: Array.from(${SR}.querySelectorAll('.pick')).map((r) => r.getAttribute('data-included'))
  }))()`);

  // 取消第一个的勾选
  await cdp.evaluate(`(() => {
    const row = ${SR}.querySelector('.pick[data-handle="${handles[0]}"]');
    const box = row.querySelector('[data-role="pick"]');
    box.click();
  })()`);
  await sleep(200);
  let st = await read();
  console.log(`  取消勾选 @${handles[0]} → 本批 ${st.count}，按钮「${st.ok}」`);
  if (st.count !== 4 || !st.ok.includes("4")) throw new Error("取消勾选未更新数量");

  // 右键第二个 → 永久排除
  await cdp.evaluate(`(() => {
    const row = ${SR}.querySelector('.pick[data-handle="${handles[1]}"]');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  })()`);
  await sleep(300);
  st = await read();
  const panelEx = await stat(cdp, "excluded");
  console.log(`  右键排除 @${handles[1]} → 本批 ${st.count}，本次排除 ${st.excludedFact}，面板已排除 ${panelEx}`);
  if (st.count !== 3) throw new Error("排除后本批数量不对");
  if (st.excludedFact !== 1 || panelEx !== "1") throw new Error("排除未写回状态");

  // 点 ↺ 恢复
  await cdp.evaluate(`(() => {
    const row = ${SR}.querySelector('.pick[data-handle="${handles[1]}"]');
    row.querySelector('[data-role="ex"]').click();
  })()`);
  await sleep(300);
  st = await read();
  const panelEx2 = await stat(cdp, "excluded");
  console.log(`  恢复 @${handles[1]} → 本次排除 ${st.excludedFact}，面板已排除 ${panelEx2}`);
  if (st.excludedFact !== 0 || panelEx2 !== "0") throw new Error("恢复排除失败");

  // 重新勾选第一个，最终 4 个
  await cdp.evaluate(`(() => {
    const row = ${SR}.querySelector('.pick[data-handle="${handles[0]}"]');
    row.querySelector('[data-role="pick"]').click();
  })()`);
  await sleep(200);
  st = await read();
  console.log(`  重新勾选 @${handles[0]} → 本批 ${st.count}`);
  if (st.count !== 4) throw new Error("重新勾选失败");

  await cdp.shot("25-confirm-edit");

  await clickShadow(cdp, '.overlay [data-role="ack"]');
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay .sum')`), 60000, "结果弹窗");
  const sums = await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.overlay .sum div')).map((d) => d.textContent.trim())`);
  console.log(`  执行结果: ${sums.join(" | ")}`);
  const ok = Number(sums[0].replace(/[^\d]/g, ""));
  if (ok !== 4) throw new Error(`应只执行 4 个，实际 ${ok}`);
  await cdp.evaluate(`${SR}.querySelector('.overlay [data-dlg="close"]').click()`);
  await sleep(300);
}


async function runLongList(cdp) {
  console.log("\n[23] 长列表：直接定位到最早的账号，不从顶部爬");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 120000, "扫描完成");
  const total = await stat(cdp, "total");
  const oneWay = await stat(cdp, "oneway");
  console.log(`  扫描: 共 ${total}，未回关 ${oneWay}`);
  if (Number(total) !== 400) throw new Error(`应扫描到 400 个，实际 ${total}`);

  // 自动选择 = 最早的一批（列表后段）
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "20"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(200);
  await clickAction(cdp, "auto");
  await sleep(400);
  const selected = await stat(cdp, "selected");
  console.log(`  已选 ${selected}（应为最早关注的 20 个）`);
  if (selected !== "20") throw new Error("自动选择数量不对");

  // 记录执行前的滚动位置（此时页面停在列表底部）
  const yBefore = await cdp.evaluate(`Math.round(window.scrollY)`);
  console.log(`  执行前滚动位置: ${yBefore}`);

  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay')`), 5000, "确认弹窗");
  await clickShadow(cdp, '.overlay [data-role="ack"]');

  const t0 = Date.now();
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');

  // 采样：首次成功耗时 + 期间滚动位置最小值
  let firstDoneAt = null;
  let minY = Infinity;
  let maxY = 0;
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    const st = await cdp.evaluate(`(() => {
      const sr = document.querySelector('[data-xfm-panel-host="1"]').shadowRoot;
      const bar = sr.querySelector('[data-role="runtext"]');
      return { y: Math.round(window.scrollY), text: bar ? bar.textContent : '' };
    })()`);
    if (st.y < minY) minY = st.y;
    if (st.y > maxY) maxY = st.y;
    if (firstDoneAt === null && /\/\s*20/.test(st.text)) firstDoneAt = Date.now() - t0;
    const done = await cdp.evaluate(`(() => {
      const sr = document.querySelector('[data-xfm-panel-host="1"]').shadowRoot;
      const bar = sr.querySelector('[data-role="runtext"]');
      return bar ? bar.textContent : '';
    })()`);
    if (/20 \/ 20/.test(done)) break;
  }
  const totalMs = Date.now() - t0;
  console.log(`  首个结果耗时 ${firstDoneAt} ms；全程滚动位置 ${minY} ~ ${maxY}；总耗时 ${totalMs} ms`);

  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay .sum')`), 60000, "结果弹窗");
  const sums = await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.overlay .sum div')).map(d => d.textContent.trim())`);
  console.log(`  执行结果: ${sums.join(" | ")}`);
  const ok = Number(sums[0].replace(/[^\d]/g, ""));
  if (ok !== 20) throw new Error(`应成功 20 个，实际 ${ok}`);
  if (minY < 50) throw new Error(`执行期间被拉回了顶部（最小滚动位置 ${minY}）`);
  if (firstDoneAt === null || firstDoneAt > 8000) throw new Error(`定位首个目标太慢：${firstDoneAt} ms`);
  await cdp.shot("26-longlist");
}

/* ------------------------------------------------------------------ */
/* 通用辅助                                                */
/* ------------------------------------------------------------------ */

async function setQty(cdp, n) {
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).value = "${n}"`);
  await cdp.evaluate(`(${SR}.querySelector('[data-role="qty"]')).dispatchEvent(new Event("change"))`);
  await sleep(180);
}

async function scanToEnd(cdp, expectTotal, timeoutMs) {
  await waitFor(() => panelReady(cdp), 10000, "面板挂载");
  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), timeoutMs || 120000, "扫描完成");
  const total = Number(await stat(cdp, "total"));
  const oneWay = Number(await stat(cdp, "oneway"));
  console.log(`  扫描完成: 共 ${total}，未回关 ${oneWay}`);
  if (expectTotal != null && total !== expectTotal) throw new Error(`应扫描到 ${expectTotal} 个，实际 ${total}`);
  return { total, oneWay };
}

async function openConfirmAndRun(cdp) {
  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay')`), 6000, "确认弹窗");
  await clickShadow(cdp, '.overlay [data-role="ack"]');
  await clickShadow(cdp, '.overlay [data-dlg="ok"]');
}

async function readResult(cdp, timeoutMs) {
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay .sum')`), timeoutMs || 90000, "结果弹窗");
  const sums = await cdp.evaluate(
    `Array.from(${SR}.querySelectorAll('.overlay .sum div')).map(d=>d.textContent.trim())`
  );
  const detail = await cdp.evaluate(
    `Array.from(${SR}.querySelectorAll('.overlay .list div')).map(d=>d.textContent.trim()).slice(0,20)`
  );
  console.log(`  结果: ${sums.join(" | ")}`);
  return { sums, detail };
}

const numOf = (text) => Number(String(text || "0").replace(/[^\d]/g, ""));

/** 断言「成功 N，其余全 0」 */
function expectClean(sums, successCount) {
  const got = sums.map(numOf);
  if (got[0] !== successCount) throw new Error(`应成功 ${successCount} 个，实际 ${sums[0]}`);
  if (got[1] !== 0) throw new Error(`不应有失败：${sums[1]}`);
  if (got[2] !== 0) throw new Error(`不应有跳过：${sums[2]}`);
  if (got[3] !== 0) throw new Error(`不应有未知：${sums[3]}`);
}

/**
 * [V8] 行消失 ≠ 成功：确认后行被移出列表但不翻按钮（旧版本 X 行为），
 * 必须归为「结果未知」等待人工复查，绝不能静默计成已取关。
 */
async function runRemovalUnknown(cdp) {
  console.log("\n[V8] 行消失但按钮未翻转：必须判「结果未知」");
  await scanToEnd(cdp, 20, 120000);
  await setQty(cdp, 3);
  await clickAction(cdp, "auto");
  await waitFor(async () => (await stat(cdp, "selected")) === "3", 5000, "自动勾选 3 个");

  await openConfirmAndRun(cdp);
  const { sums, detail } = await readResult(cdp, 120000);
  const got = sums.map(numOf);
  console.log(`  明细: ${detail.join(" / ").slice(0, 160)}`);
  if (got[0] !== 0) throw new Error(`行消失不应判成功，实际成功 ${got[0]}`);
  if (got[1] !== 0) throw new Error(`不应有失败：${sums[1]}`);
  if (got[3] !== 3) throw new Error(`3 个无法确认的账号应全部归为未知，实际 ${sums[3]}`);
  if (!detail.join("").includes("人工确认")) throw new Error("未知原因应提示人工复查");
  await cdp.shot("33-removal-unknown");
}

/**
 * [B0] 模拟页面隐藏/可见：CDP 无法真实切窗口，
 * 用 defineProperty 覆盖 document.hidden/visibilityState 并派发事件。
 */
async function setHidden(cdp, hidden) {
  await cdp.evaluate(`(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => ${hidden ? "true" : "false"} });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => ${hidden ? '"hidden"' : '"visible"'} });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
}

/**
 * [B1] 后台继续扫描：隐藏不暂停、后台无新增不误判完成、回前台复核后继续到底。
 * 页面用 ?bgstall=1：隐藏期间懒加载暂停（模拟 X 后台不加载新行）。
 */
async function runBgScan(cdp) {
  console.log("\n[B1] 后台继续扫描");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描中"), 5000, "进入扫描中");
  await waitFor(async () => Number(await stat(cdp, "total")) >= 4, 20000, "扫描到前几行");
  await setHidden(cdp, true);
  // 隐藏后继续扫：受限状态出现（bgstall 让懒加载停了），但任务必须还在进行中
  await waitFor(async () => (await cdp.evaluate(`${SR}.querySelector('[data-role="runtext"]').textContent`)).includes("后台加载受限"), 30000, "进入后台受限状态");
  await sleep(1500);
  const st = await cdp.evaluate(`(() => {
    const sr = ${SR};
    return {
      phase: sr.querySelector('[data-role="phase"]').textContent,
      runtext: sr.querySelector('[data-role="runtext"]').textContent,
      status: sr.querySelector('[data-role="status"]').textContent
    };
  })()`);
  console.log(`  隐藏后: 阶段「${st.phase}」进度「${st.runtext}」`);
  if (st.phase.includes("完成") || st.phase.includes("不完整")) {
    throw new Error(`后台无新增被误判为结束：${st.phase}`);
  }
  if (!st.phase.includes("扫描中")) throw new Error(`隐藏后任务应仍在进行，实际「${st.phase}」`);
  if (!st.runtext.includes("后台")) throw new Error("后台应有明确状态（后台扫描中/加载受限）");

  // 回到前台：复核加载状态并采集，继续扫到真正到底
  await setHidden(cdp, false);
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 60000, "回前台后扫描完成");
  const total = Number(await stat(cdp, "total"));
  console.log(`  回前台后完成: 共 ${total} 个`);
  if (total !== 20) throw new Error(`回前台后应补齐到 20 个，实际 ${total}`);
  await cdp.shot("41-bg-scan");
}

/**
 * [B2] 手动暂停/继续：暂停期间不滚动；切窗口不改变暂停状态；继续后扫完。
 */
async function runPause(cdp) {
  console.log("\n[B2] 手动暂停与继续");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描中"), 5000, "进入扫描中");
  await sleep(600);
  await clickAction(cdp, "pauseScan");
  await sleep(300);
  let st = await cdp.evaluate(`(() => {
    const sr = ${SR};
    return {
      runtext: sr.querySelector('[data-role="runtext"]').textContent,
      pause: sr.querySelector('[data-act="pauseScan"]').textContent,
      phase: sr.querySelector('[data-role="phase"]').textContent,
      y: window.scrollY
    };
  })()`);
  console.log(`  暂停后: 「${st.runtext}」按钮「${st.pause}」阶段「${st.phase}」`);
  if (!st.runtext.includes("已暂停")) throw new Error("暂停后应显示已暂停");
  if (st.pause !== "继续") throw new Error("暂停后按钮应变为「继续」");
  if (!st.phase.includes("已暂停")) throw new Error("阶段徽标应显示已暂停");
  const y1 = st.y;
  await sleep(1600);
  const y2 = await cdp.evaluate(`window.scrollY`);
  if (Math.abs(y2 - y1) > 2) throw new Error(`暂停期间不应自动滚动（${y1} → ${y2}）`);

  // 切到后台再回来：手动暂停必须保持
  await setHidden(cdp, true);
  await sleep(400);
  await setHidden(cdp, false);
  await sleep(400);
  const after = await cdp.evaluate(`(() => {
    const sr = ${SR};
    return {
      pause: sr.querySelector('[data-act="pauseScan"]').textContent,
      runtext: sr.querySelector('[data-role="runtext"]').textContent
    };
  })()`);
  console.log(`  切窗口后: 按钮「${after.pause}」「${after.runtext}」`);
  if (after.pause !== "继续" || !after.runtext.includes("已暂停")) {
    throw new Error("切窗口不应取消手动暂停");
  }

  // 继续扫描 → 完成
  await clickAction(cdp, "pauseScan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 60000, "继续后完成");
  const total = Number(await stat(cdp, "total"));
  console.log(`  继续后完成: 共 ${total} 个`);
  if (total !== 20) throw new Error(`继续后应完成 20 个，实际 ${total}`);
  await cdp.shot("42-pause");
}

/**
 * [B3] 进度跨刷新保存/恢复 + 账号与列表隔离 + 合并去重。
 */
async function runProgress(cdp) {
  console.log("\n[B3] 进度保存与恢复");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await clickAction(cdp, "scan");
  await waitFor(async () => Number(await stat(cdp, "total")) >= 8, 30000, "扫描到 8 个以上");
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 5000, "标注不完整");
  const savedCount = Number(await stat(cdp, "total"));
  console.log(`  停止时已保存 ${savedCount} 人`);
  const stored = await cdp.evaluate(`(() => {
    const all = JSON.parse(localStorage.getItem("xfm-store") || "{}");
    const keys = Object.keys(all).filter((k) => k.indexOf("xfm.scan.progress.v1:") === 0);
    const rows = keys.map((k) => (all[k] && Array.isArray(all[k].rows)) ? all[k].rows.length : 0);
    return rows.length ? Math.max.apply(null, rows) : 0;
  })()`);
  if (stored < 8) throw new Error(`停止应补存进度，实际落盘 ${stored} 人`);

  // 刷新 → 恢复横幅
  await cdp.send("Page.reload", {});
  await waitFor(() => panelReady(cdp), 8000, "刷新后面板挂载");
  await sleep(700);
  const banner = await cdp.evaluate(`(() => {
    const sr = ${SR};
    const r = sr.querySelector('[data-role="recover"]');
    return {
      visible: !!(r && !r.hidden),
      text: r && !r.hidden ? sr.querySelector('[data-role="recoverText"]').textContent : ""
    };
  })()`);
  console.log(`  刷新后横幅: ${JSON.stringify(banner)}`);
  if (!banner.visible || !banner.text.includes("已保存")) {
    throw new Error("刷新后应提示发现未完成扫描");
  }

  // 切到粉丝列表：不得命中其它列表的进度（隔离）
  await cdp.evaluate(`history.pushState({}, "", "/alice/followers")`);
  await cdp.evaluate(`window.dispatchEvent(new PopStateEvent("popstate"))`);
  await sleep(900);
  const bannerOther = await cdp.evaluate(`(() => {
    const r = ${SR}.querySelector('[data-role="recover"]');
    return !!(r && !r.hidden);
  })()`);
  console.log(`  粉丝列表页横幅: ${bannerOther}`);
  if (bannerOther) throw new Error("不同列表类型不应命中保存的进度");

  // 在粉丝列表也扫一小段并停止：两个列表各有自己的未完成进度（分键不覆盖）
  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描中"), 5000, "粉丝页进入扫描中");
  await sleep(1500);
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 5000, "粉丝页标注不完整");
  const followersSaved = Number(await stat(cdp, "total"));
  console.log(`  粉丝列表单独保存: ${followersSaved} 人`);
  if (followersSaved < 5) throw new Error("粉丝列表应保存自己的进度");

  // 回到关注列表：横幅必须仍是关注列表自己的 8 人（未被粉丝列表覆盖）
  await cdp.evaluate(`history.pushState({}, "", "/alice/following")`);
  await cdp.evaluate(`window.dispatchEvent(new PopStateEvent("popstate"))`);
  await sleep(900);
  const bannerFollowing = await cdp.evaluate(`(() => {
    const sr = ${SR};
    const r = sr.querySelector('[data-role="recover"]');
    return r && !r.hidden ? sr.querySelector('[data-role="recoverText"]').textContent : "";
  })()`);
  console.log(`  回到关注列表横幅: ${bannerFollowing}`);
  if (!bannerFollowing.includes("8 人")) throw new Error(`关注列表进度被覆盖，横幅: ${bannerFollowing}`);

  // 恢复扫描 → 合并去重 → 完成
  await clickAction(cdp, "recover-yes");
  await cdp.evaluate(`window.dispatchEvent(new PopStateEvent("popstate"))`);
  await sleep(900);
  await clickAction(cdp, "recover-yes");
  await sleep(900);
  const restoreNote = await cdp.evaluate(`(() => {
    const sr = ${SR};
    const n = sr.querySelector('[data-role="notice"]');
    return (n && !n.hidden ? n.textContent : "") || sr.querySelector('[data-role="status"]').textContent;
  })()`);
  console.log(`  恢复提示: ${restoreNote}`);
  if (!restoreNote.includes("重新定位") && !restoreNote.includes("继续")) {
    throw new Error("应提示正在重新定位且名单保留，而不是承诺瞬间续扫");
  }
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 60000, "恢复后扫描完成");
  const total = Number(await stat(cdp, "total"));
  const boxes = await cdp.evaluate(`document.querySelectorAll('[data-xfm-select]').length`);
  console.log(`  恢复后完成: 共 ${total}，复选框 ${boxes}`);
  if (total !== 20) throw new Error(`恢复后应补齐 20（合并去重），实际 ${total}`);
  if (boxes > 20) throw new Error(`去重失败：复选框 ${boxes} > 20`);
  // 粉丝列表的分键进度必须仍在（分键不互相清除）
  await cdp.evaluate(`history.pushState({}, "", "/alice/followers")`);
  await cdp.evaluate(`window.dispatchEvent(new PopStateEvent("popstate"))`);
  await sleep(900);
  const bannerKeep = await cdp.evaluate(`(() => {
    const sr = ${SR};
    const r = sr.querySelector('[data-role="recover"]');
    return r && !r.hidden ? sr.querySelector('[data-role="recoverText"]').textContent : "";
  })()`);
  console.log(`  粉丝列表横幅（应保留）: ${bannerKeep}`);
  if (!bannerKeep.includes("人")) throw new Error("粉丝列表自己的未完成进度不应被关注列表的完成清除");
  // 丢弃 → 横幅消失
  await clickAction(cdp, "recover-no");
  await sleep(500);
  const bannerGone = await cdp.evaluate(`(() => {
    const sr = ${SR};
    const r = sr.querySelector('[data-role="recover"]');
    return !(r && !r.hidden);
  })()`);
  if (!bannerGone) throw new Error("丢弃进度后横幅应消失");
  console.log("  丢弃进度后横幅消失 ✓");
  await cdp.shot("43-progress");
}

/**
 * [B4] 存储失败要有明确反馈，且扫描本身不受影响。
 */
/**
 * [B5] 延迟存储下的异步竞争：扫描完成时的清除必须能压过在途的保存写回。
 * ?storagelag=2500 让最后一次周期保存的 set 迟 2.5 秒才落盘。
 */
async function runProgressRace(cdp) {
  console.log("\n[B5] 延迟存储：完成后进度不得复活");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 60000, "扫描完成");
  await sleep(4000); // 覆盖 2.5s 延迟落盘 + epoch 复核清除
  const anyRows = await cdp.evaluate(`(() => {
    const all = JSON.parse(localStorage.getItem("xfm-store") || "{}");
    return Object.keys(all)
      .filter((k) => k.indexOf("xfm.scan.progress.v1") === 0)
      .filter((k) => Array.isArray(all[k].rows) && all[k].rows.length > 0);
  })()`);
  console.log(`  完成后 7s: 含行数的进度键 [${anyRows.join(", ")}]（墓碑键不算复活）`);
  if (anyRows.length !== 0) throw new Error(`完成后进度复活（在途保存写回）: ${anyRows.join(",")}`);
  console.log("  异步竞争处理正确 ✓");
  await cdp.shot("45-progress-race");
}

/**
 * [B6] 虚拟列表探针盲区：首行、行数、页高全部不变，仅视口中段行被复用为新账号。
 * 便宜探针（行数+页高+首行身份）对此不敏感 —— 验证扫描是否漏采。
 * 通过标准：5 个 ghost 账号全部进入扫描快照（名单窗口可见），总数不缺。
 */
async function runRecycleMid(cdp) {
  console.log("[B6] 虚拟列表中段复用不漏采");
  await scanToEnd(cdp, null, 180000); // 总数按构造在 60~65 之间，下方自行断言
  const total = Number(await stat(cdp, "total"));
  console.log(`  扫描完成: 共 ${total} 人（60 原始 + 换入的 ghost，被替换行若未及采集则不计）`);
  if (total < 60 || total > 65) throw new Error(`总数应在 60~65 区间，实际 ${total}`);

  // 名单窗口读取全量快照
  await clickAction(cdp, "roster");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "名单窗口");
  await cdp.evaluate(`${SR}.querySelector('[data-rtab="all"]').click()`);
  await sleep(400);
  const handles = await cdp.evaluate(`Array.from(${SR}.querySelectorAll('.rrow')).map((r) => r.getAttribute('data-handle'))`);
  console.log(`  名单窗口行数: ${handles.length}`);
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(300);

  if (handles.length !== total) throw new Error(`快照行数 ${handles.length} ≠ 面板总数 ${total}`);
  const missing = [];
  for (let i = 0; i < 5; i++) {
    if (handles.indexOf("ghost_" + i) === -1) missing.push("ghost_" + i);
  }
  if (missing.length > 0) throw new Error(`探针盲区漏采: ${missing.join(",")} 未进入扫描快照`);
  console.log("  5 个 ghost 全部被采集，探针盲区无漏采 ✓");
  await cdp.shot("46-recycle-mid");
}

/**
 * [B7] 持续后台受限：不空转、轮次不耗尽、不误报完成；
 * 受限期间暂停/继续即时响应；回前台复核后扫完。
 */
async function runBgPersistent(cdp) {
  console.log("[B7] 持续后台受限");
  const state = () => cdp.evaluate(`(() => {
    const sr = ${SR};
    return {
      phase: sr.querySelector('[data-role="phase"]').textContent,
      runtext: sr.querySelector('[data-role="runtext"]').textContent,
      total: Number(sr.querySelector('[data-role="total"]').textContent)
    };
  })()`);
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描中"), 5000, "进入扫描中");
  await waitFor(async () => Number(await stat(cdp, "total")) >= 4, 20000, "扫到前几行");
  await setHidden(cdp, true);
  await waitFor(async () => {
    const t = (await state(cdp)).runtext || "";
    return t.indexOf("受限") !== -1;
  }, 30000, "进入后台受限");

  const roundsInBg = () => cdp.evaluate(`(window.__xfmLogs || []).filter((e) => e.tag === "scan.round").length`);
  const r1 = await roundsInBg();
  await sleep(40000); // 约 5 个 8s 试探周期
  const st = await state(cdp);
  const r2 = await roundsInBg();
  console.log(`  受限 40s: 阶段「${st.phase}」轮次日志 ${r1} → ${r2}（+${r2 - r1}）`);
  if (!st.phase.includes("扫描中")) throw new Error(`持续受限被误判结束: ${st.phase}`);
  if (r2 - r1 > 12) throw new Error(`后台受限空转：40 秒内轮次日志增加 ${r2 - r1}（应约 5 个试探周期）`);

  // 受限期间暂停 → 即时生效（≤2s）
  await clickAction(cdp, "pauseScan");
  await waitFor(async () => (await state(cdp)).runtext.indexOf("已暂停") !== -1, 2000, "受限中暂停即时生效");
  console.log("  受限中暂停: 即时生效 ✓");
  // 暂停 3s 后继续 → 回到受限等待
  await sleep(3000);
  await clickAction(cdp, "pauseScan");
  await waitFor(async () => (await state(cdp)).runtext.indexOf("受限") !== -1, 3000, "继续后回到受限等待");
  console.log("  继续后回到受限等待 ✓");

  // 回前台 → 复核 → 完成
  await setHidden(cdp, false);
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 90000, "回前台后完成");
  const total = Number(await stat(cdp, "total"));
  console.log(`  回前台后完成: 共 ${total} 人`);
  if (total < 8) throw new Error(`回前台后应补齐，实际 ${total}`);
  await cdp.shot("47-bg-persistent");
}

/**
 * [B8] 同账号同列表多标签页并发扫描：
 * 标签页 A 与 B 各自扫到不同子集后先后保存，读-合并-写必须保住双方成果，
 * 后写的一方不得用较少的快照覆盖较多的一方。不同列表不互相删除（progress 场景已覆盖）。
 */
async function runProgressMulti(cdp) {
  console.log("[B8] 多标签页并发扫描进度");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");

  // 标签页 A：扫到 8 行即停（存下自己的子集）
  await clickAction(cdp, "scan");
  await waitFor(async () => Number(await stat(cdp, "total")) >= 8, 30000, "A 扫到 8 行");
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 5000, "A 标注不完整");
  const aCount = Number(await stat(cdp, "total"));
  const diskAfterA = await progressRowsOnDisk(cdp);
  console.log(`  A 停止: 快照 ${aCount} 人，落盘 ${diskAfterA.length} 人`);

  // 标签页 B：同一列表，独立扫描到 14 行后停止（B 是后写方、子集更大）
  const resB = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: "PUT" });
  const tabB = await resB.json();
  const wsb = new WebSocket(tabB.webSocketDebuggerUrl);
  await new Promise((res, rej) => { wsb.addEventListener("open", res, { once: true }); wsb.addEventListener("error", rej, { once: true }); });
  const cdpB = new Cdp(wsb);
  await cdpB.send("Page.enable");
  await cdpB.send("Page.navigate", { url: APP_URL }); // 同一列表，独立注入与扫描
  await waitFor(() => cdpB.evaluate(`!!${PANEL}`), 10000, "B 面板注入");
  await cdpB.evaluate(`${SR}.querySelector('[data-act="scan"]').click()`);
  await waitFor(async () => Number(await cdpB.evaluate(`${SR}.querySelector('[data-role="total"]').textContent`)) >= 14, 40000, "B 扫到 14 行");
  await cdpB.evaluate(`${SR}.querySelector('[data-act="stop"]').click()`);
  await waitFor(async () => cdpB.evaluate(`${SR}.querySelector('[data-role="phase"]').textContent.includes("结果不完整")`), 5000, "B 标注不完整");
  const bCount = await cdpB.evaluate(`Number(${SR}.querySelector('[data-role="total"]').textContent)`);
  const diskAfterB = await progressRowsOnDisk(cdp);
  console.log(`  B 停止: 快照 ${bCount} 人，落盘 ${diskAfterB.length} 人`);
  await wsb.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${tabB.id}`).catch(() => {});
  await sleep(600);

  // 关键断言：B 的保存不得把 A 先前扫到、而 B 没扫到的账号抹掉
  // （A 与 B 都从顶部扫起，A ⊆ B 属构造前提；这里验证读-合并-写路径真实生效：
  //  A 继续扫描几个新行后保存，合并后的落盘必须 ≥ B 的数量，且 A 的新增也进入落盘）
  await clickAction(cdp, "scan");
  await waitFor(async () => Number(await stat(cdp, "total")) >= aCount + 2, 40000, "A 继续扫描新增");
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 5000, "A 再次标注不完整");
  const aFinal = Number(await stat(cdp, "total"));
  const diskFinal = await progressRowsOnDisk(cdp);
  console.log(`  A 继续后: 快照 ${aFinal} 人，落盘 ${diskFinal.length} 人`);
  if (diskFinal.length < bCount) throw new Error(`并发保存丢数据：落盘 ${diskFinal.length} < B 的 ${bCount}`);
  if (diskFinal.length < aFinal) throw new Error(`并发保存丢数据：落盘 ${diskFinal.length} < A 的 ${aFinal}`);
  await cdp.shot("48-progress-multi");
}

/** 落盘的扫描进度行数（分键：取所有 progress 键中行数最多者） */
async function progressRowsOnDisk(cdp) {
  return cdp.evaluate(`(() => {
    const all = JSON.parse(localStorage.getItem("xfm-store") || "{}");
    const keys = Object.keys(all).filter((k) => k.indexOf("xfm.scan.progress.v1:") === 0);
    let best = [];
    keys.forEach((k) => {
      const rows = all[k] && Array.isArray(all[k].rows) ? all[k].rows : [];
      if (rows.length > best.length) best = rows;
    });
    return best.map((r) => r.h);
  })()`);
}


/**
 * [B9] 同一进度键的跨标签页写竞争（确定性时序）：
 * A 与 B 各自持有不相交的扫描子集（dropFirst(8) 制造），
 * 门控让两个标签页「都读完旧进度之后」才分别写入，B 后写。
 * 正确行为：串行化读-合并-写，A 的 8 行与 B 的 12 行都保留。
 * 缺陷行为：后写者整份覆盖，A 的 8 行丢失。
 */
async function runProgressHold(cdp) {
  console.log("[B9] 进度键跨标签页写竞争（门控时序）");
  const readDiskHandles = () => cdp.evaluate(`(() => {
    const all = JSON.parse(localStorage.getItem("xfm-store") || "{}");
    const keys = Object.keys(all).filter((k) => k.indexOf("xfm.scan.progress.v1:") === 0);
    const hs = [];
    keys.forEach((k) => { (all[k].rows || []).forEach((r) => hs.push(r.h)); });
    return hs;
  })()`);

  await waitFor(() => panelReady(cdp), 8000, "面板挂载");

  // A：扫前 8 行后停止
  await clickAction(cdp, "scan");
  await waitFor(async () => Number(await stat(cdp, "total")) >= 8, 30000, "A 扫到 8 行");
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 5000, "A 标注不完整");
  const aHandles = await cdp.evaluate(`Array.from(new Set(Array.from(document.querySelectorAll('[data-xfm-select]')).map((b) => b.getAttribute("data-handle")))).slice(0, 8)`);
  console.log(`  A 子集: ${aHandles.join(",")}`);

  // 移除列表前 8 个账号 → B 的扫描子集与 A 不相交
  await cdp.evaluate(`window.__xfmDropFirst(8)`);

  // B：新标签页，扫剩余 12 行后停止
  const resB = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: "PUT" });
  const tabB = await resB.json();
  const wsb = new WebSocket(tabB.webSocketDebuggerUrl);
  await new Promise((res, rej) => { wsb.addEventListener("open", res, { once: true }); wsb.addEventListener("error", rej, { once: true }); });
  const cdpB = new Cdp(wsb);
  await cdpB.send("Page.enable");
  await cdpB.send("Page.navigate", { url: APP_URL });
  await waitFor(() => cdpB.evaluate(`!!${PANEL}`), 10000, "B 面板注入");
  // 在 B 的页面里移除前 8 个账号 → B 的扫描子集与 A 不相交
  const dropped = await cdpB.evaluate(`window.__xfmDropFirst(8)`);
  console.log(`  B 侧已移除: ${dropped.join(",")}`);
  await cdpB.evaluate(`${SR}.querySelector('[data-act="scan"]').click()`);
  await waitFor(async () => Number(await cdpB.evaluate(`${SR}.querySelector('[data-role="total"]').textContent`)) >= 12, 30000, "B 扫到 12 行");
  await cdpB.evaluate(`${SR}.querySelector('[data-act="stop"]').click()`);
  await waitFor(async () => cdpB.evaluate(`${SR}.querySelector('[data-role="phase"]').textContent.includes("结果不完整")`), 5000, "B 标注不完整");
  const diskAfterB = await readDiskHandles();
  console.log(`  B 停止后落盘: ${diskAfterB.length} 人`);
  if (diskAfterB.length < 12) throw new Error(`B 停止后落盘应 ≥ 12，实际 ${diskAfterB.length}`);

  // 门控：两个标签页的进度读取都挂起
  await cdp.evaluate(`window.__xfmHoldProgressGets = true`);
  await cdpB.evaluate(`window.__xfmHoldProgressGets = true`);
  // 各自触发强制补存（调试入口）
  await cdp.evaluate(`(() => { XFMDebug.forceProgressSave(); })()`); // 不等待返回：读取已挂起
  await cdpB.evaluate(`(() => { XFMDebug.forceProgressSave(); })()`);
  await waitFor(async () => (await cdp.evaluate(`window.__xfmHeldGetCount`)) >= 1, 8000, "A 读取挂起");
  await waitFor(async () => (await cdpB.evaluate(`window.__xfmHeldGetCount`)) >= 1, 8000, "B 读取挂起");
  console.log("  两页均已读取旧进度并挂起等待写入");

  // 先放 A（先写），再放 B（后写）——确定性顺序
  await cdp.evaluate(`window.__xfmHoldProgressGets = false`);
  await sleep(900);
  await cdpB.evaluate(`window.__xfmHoldProgressGets = false`);
  await sleep(2000);

  const finalHandles = await readDiskHandles();
  const lostA = aHandles.filter((h) => finalHandles.indexOf(h) === -1);
  console.log(`  最终落盘: ${finalHandles.length} 人；A 的 8 行中丢失 ${lostA.length}`);
  if (lostA.length > 0) {
    throw new Error(`并发写竞争丢数据：A 的 ${lostA.length} 行被 B 后写覆盖（${lostA.slice(0, 3).join(",")}…）`);
  }
  console.log("  双方扫描成果都保留 ✓");
  await wsb.close();
  await cdp.shot("49-progress-hold");
}


/**
 * [B10] 陈旧读取 + 后写覆盖：A 挂起读取旧进度（12 人），
 * B 在此期间扫满 20 人并落盘；放行 A → A 用旧基线合并后写回 12 人。
 * 无跨标签页串行化时，B 的 8 个独有账号被覆盖丢失。
 * 通过标准：放行后落盘仍包含 B 的全部 20 人。
 */
async function runProgressStale(cdp) {
  console.log("[B10] 陈旧读取与后写覆盖");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");

  // A：扫 12 行后停止（disk = A 的 12 人）
  await clickAction(cdp, "scan");
  await waitFor(async () => Number(await stat(cdp, "total")) >= 12, 30000, "A 扫到 12 行");
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 5000, "A 标注不完整");
  const aHandles = await progressRowsOnDisk(cdp);
  console.log(`  A 停止: 落盘 ${aHandles.length} 人`);

  // A 挂起读取（旧基线 12 人）
  await cdp.evaluate(`window.__xfmHoldProgressGets = true`);
  await cdp.evaluate(`(() => { XFMDebug.forceProgressSave(); })()`); // 不等待返回：读取已挂起
  await waitFor(async () => (await cdp.evaluate(`window.__xfmHeldGetCount`)) >= 1, 8000, "A 读取挂起");

  // B：另一标签页扫满 20 行后停止（disk = B 的 20 人）
  const resB = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: "PUT" });
  const tabB = await resB.json();
  const wsb = new WebSocket(tabB.webSocketDebuggerUrl);
  await new Promise((res, rej) => { wsb.addEventListener("open", res, { once: true }); wsb.addEventListener("error", rej, { once: true }); });
  const cdpB = new Cdp(wsb);
  await cdpB.send("Page.enable");
  await cdpB.send("Page.navigate", { url: APP_URL });
  await waitFor(() => cdpB.evaluate(`!!${PANEL}`), 10000, "B 面板注入");
  await cdpB.evaluate(`${SR}.querySelector('[data-act="scan"]').click()`);
  await waitFor(async () => Number(await cdpB.evaluate(`${SR}.querySelector('[data-role="total"]').textContent`)) >= 20, 60000, "B 扫满 20 行");
  await cdpB.evaluate(`${SR}.querySelector('[data-act="stop"]').click()`);
  await waitFor(async () => cdpB.evaluate(`${SR}.querySelector('[data-role="phase"]').textContent.includes("结果不完整")`), 5000, "B 标注不完整");
  const diskAfterB = await progressRowsOnDisk(cdp);
  console.log(`  B 停止: 落盘 ${diskAfterB.length} 人`);
  await wsb.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${tabB.id}`).catch(() => {});

  // 放行 A：A 用旧基线（12 人）合并写回
  await cdp.evaluate(`window.__xfmHoldProgressGets = false`);
  await sleep(2500);
  const finalHandles = await progressRowsOnDisk(cdp);
  const lostB = diskAfterB.filter((h) => finalHandles.indexOf(h) === -1);
  console.log(`  A 写回后落盘: ${finalHandles.length} 人；B 的 20 人中丢失 ${lostB.length}`);
  if (lostB.length > 0) {
    throw new Error(`陈旧读取覆盖丢数据：B 的 ${lostB.length} 行被 A 的旧快照覆盖（${lostB.slice(0, 3).join(",")}…）`);
  }
  console.log("  陈旧读取未覆盖 B 的成果 ✓");
  await cdp.shot("50-progress-stale");
}

/**
 * [B11] 清除 vs 在途写入：B 的保存带延迟落盘（在途），
 * A 在此期间「丢弃进度」——写回落地后进度不得复活。
 */
async function runProgressDiscard(cdp) {
  console.log("[B11] 清除与在途写入");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");

  // A：扫 8 行后停止（有恢复横幅，可丢弃）
  await clickAction(cdp, "scan");
  await waitFor(async () => Number(await stat(cdp, "total")) >= 8, 30000, "A 扫到 8 行");
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 5000, "A 标注不完整");

  // B：同一列表扫描 10 行后停止，保存带 2.5s 延迟落盘（在途）
  const resB = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: "PUT" });
  const tabB = await resB.json();
  const wsb = new WebSocket(tabB.webSocketDebuggerUrl);
  await new Promise((res, rej) => { wsb.addEventListener("open", res, { once: true }); wsb.addEventListener("error", rej, { once: true }); });
  const cdpB = new Cdp(wsb);
  await cdpB.send("Page.enable");
  await cdpB.evaluate(`window.__xfmSetLag = 2500`);
  await cdpB.send("Page.navigate", { url: APP_URL });
  await waitFor(() => cdpB.evaluate(`!!${PANEL}`), 10000, "B 面板注入");
  await cdpB.evaluate(`${SR}.querySelector('[data-act="scan"]').click()`);
  await waitFor(async () => Number(await cdpB.evaluate(`${SR}.querySelector('[data-role="total"]').textContent`)) >= 10, 40000, "B 扫到 10 行");
  await cdpB.evaluate(`${SR}.querySelector('[data-act="stop"]').click()`);
  await waitFor(async () => cdpB.evaluate(`${SR}.querySelector('[data-role="phase"]').textContent.includes("结果不完整")`), 5000, "B 标注不完整");
  console.log("  B 停止：保存已发起（延迟 2.5s 落盘）");

  // A 刷新出现恢复横幅 → 立即丢弃进度（B 的写回在途）
  await cdp.send("Page.reload", {});
  await waitFor(() => cdp.evaluate(`!!${PANEL}`), 10000, "A 刷新后面板挂载");
  await waitFor(async () => (await cdp.evaluate(`(() => { const r = ${SR}.querySelector('[data-role="recover"]'); return !!(r && !r.hidden); })()`)), 8000, "A 恢复横幅");
  await clickAction(cdp, "recover-no");
  await sleep(7000); // 覆盖延迟落盘（2.5s）+ 墓碑写回 + 复核

  const anyRows = await cdp.evaluate(`(() => {
    const all = JSON.parse(localStorage.getItem("xfm-store") || "{}");
    const keys = Object.keys(all).filter((k) => k.indexOf("xfm.scan.progress.v1") === 0);
    return keys.filter((k) => Array.isArray(all[k].rows) && all[k].rows.length > 0);
  })()`);
  console.log(`  丢弃+在途写回后: 有行数的进度键 [${anyRows.join(", ")}]`);
  if (anyRows.length > 0) throw new Error(`丢弃后进度复活（在途写回未处理）: ${anyRows.join(",")}`);
  console.log("  丢弃后未复活 ✓");
  await wsb.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${tabB.id}`).catch(() => {});
  await cdp.shot("51-progress-discard");
}


/**
 * [B12] BEGIN 固定键：扫描开始后路由切换到另一列表，
 * 旧任务的强制补存不得写入新列表的进度键。
 */
async function runProgressBegin(cdp) {
  console.log("[B12] BEGIN 固定键：路由切换后旧任务不写入新列表");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await clickAction(cdp, "scan");
  await waitFor(async () => Number(await stat(cdp, "total")) >= 8, 30000, "A 扫到 8 行");
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 5000, "A 标注不完整");

  // 路由切到粉丝列表（另一列表类型 + 同账号）
  await cdp.evaluate(`history.pushState({}, "", "/alice/followers")`);
  await cdp.evaluate(`window.dispatchEvent(new PopStateEvent("popstate"))`);
  await sleep(900);
  await cdp.evaluate(`(() => { XFMDebug.forceProgressSave(); })()`); // 旧任务的强制补存
  await sleep(1000);
  const followerKeys = await cdp.evaluate(`(() => {
    const all = JSON.parse(localStorage.getItem("xfm-store") || "{}");
    return Object.keys(all).filter((k) => k.indexOf("xfm.scan.progress.v1") === 0 && k.indexOf("reply") !== -1);
  })()`);
  console.log(`  粉丝列表进度键: [${followerKeys.join(", ")}]`);
  if (followerKeys.length > 0) throw new Error(`旧任务的进度写入了新列表: ${followerKeys.join(",")}`);
  // 关注列表自己的进度仍在（分键不互删）
  const followingKeys = await cdp.evaluate(`(() => {
    const all = JSON.parse(localStorage.getItem("xfm-store") || "{}");
    return Object.keys(all).filter((k) => k.indexOf("xfm.scan.progress.v1") === 0 && k.indexOf("cleanup") !== -1);
  })()`);
  console.log(`  关注列表进度键: [${followingKeys.join(", ")}]`);
  if (followingKeys.length !== 1) throw new Error("关注列表自己的进度应保留");
  console.log("  固定键生效 ✓");
  await cdp.shot("52-progress-begin");
}

/**
 * [B13] 旧任务失效提示：另一窗口完成扫描（代次前进）后，
 * 本页旧任务继续保存被跳过，并给出「进度已失效」提示（不静默假装已保存）。
 */
async function runProgressStaleToast(cdp) {
  console.log("[B13] 旧任务失效提示（A 慢扫 + B 先完成）");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  // A：小批量慢扫 40 行（batch=3），保证 B 先完成时 A 仍在扫描中
  await clickAction(cdp, "scan");

  // B：同一列表（普通 20 行）直接扫完并正常完成 → 完成清除使代次前进
  const resB = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: "PUT" });
  const tabB = await resB.json();
  const wsb = new WebSocket(tabB.webSocketDebuggerUrl);
  await new Promise((res, rej) => { wsb.addEventListener("open", res, { once: true }); wsb.addEventListener("error", rej, { once: true }); });
  const cdpB = new Cdp(wsb);
  await cdpB.send("Page.enable");
  await cdpB.send("Page.navigate", { url: APP_URL });
  await waitFor(() => cdpB.evaluate(`!!${PANEL}`), 10000, "B 面板注入");
  await cdpB.evaluate(`${SR}.querySelector('[data-act="scan"]').click()`);
  await waitFor(async () => (await cdpB.evaluate(`${SR}.querySelector('[data-role="phase"]').textContent`)).includes("扫描完成"), 90000, "B 完成扫描");
  await wsb.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${tabB.id}`).catch(() => {});
  console.log("  B 已完成扫描（代次前进）");

  // A 的旧会话（未重新 BEGIN）下一次周期保存被跳过 → 失效提示
  await waitFor(async () => {
    const toast = await cdp.evaluate(`(() => { const t = ${SR}.querySelector('.toast'); return t ? t.textContent : ""; })()`);
    return toast.includes("已失效");
  }, 45000, "失效提示出现");
  const toastText = await cdp.evaluate(`(() => { const t = ${SR}.querySelector('.toast'); return t ? t.textContent : ""; })()`);
  console.log(`  失效提示: ${toastText}`);
  if (!toastText.includes("已失效")) throw new Error("应提示进度已失效");
  // 旧会话停止：不复活进度
  await clickAction(cdp, "stop");
  await waitFor(async () => (await phaseText(cdp)).includes("结果不完整"), 5000, "A 标注不完整");
  const rowsLeft = await cdp.evaluate(`(() => {
    const all = JSON.parse(localStorage.getItem("xfm-store") || "{}");
    return Object.keys(all)
      .filter((k) => k.indexOf("xfm.scan.progress.v1") === 0)
      .filter((k) => Array.isArray(all[k].rows) && all[k].rows.length > 0).length;
  })()`);
  if (rowsLeft > 0) throw new Error("失效后停止不应复活进度");
  console.log("  旧任务保存不再静默假装成功，停止后未复活 ✓");
  await cdp.shot("53-progress-stale-toast");
}

async function runStorageFail(cdp) {
  console.log("\n[B4] 存储失败的反馈");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await clickAction(cdp, "scan");
  await sleep(1800);
  const toast = await cdp.evaluate(`(() => {
    const t = ${SR}.querySelector('.toast');
    return t ? t.textContent : "";
  })()`);
  console.log(`  toast: ${toast}`);
  if (!toast.includes("保存失败")) throw new Error("存储失败应给出简短提示");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 60000, "扫描仍应完成");
  console.log("  扫描未受存储失败影响，正常完成");
  await cdp.shot("44-storage-fail");
}

/**
 * [V14] 执行互斥锁：另一个标签页持有锁时拒绝执行；锁过期可接管；跑完释放。
 */
async function runLock(cdp) {
  console.log("\n[V14] 执行互斥锁");
  await scanToEnd(cdp, 20, 120000);
  await setQty(cdp, 3);
  await clickAction(cdp, "auto");
  await waitFor(async () => (await stat(cdp, "selected")) === "3", 5000, "自动勾选 3 个");

  // a) 另一个标签页持有新鲜锁 → 拒绝执行，不出确认弹窗
  await cdp.evaluate(`window.__xfmExternalWrite("xfm.run.lock.v1", {
    runId: "other-tab", path: "/bob/following", heartbeat: Date.now()
  })`);
  await sleep(200);
  await clickAction(cdp, "unfollow");
  await sleep(900);
  const blocked = await cdp.evaluate(`(() => {
    const sr = ${SR};
    const toast = sr.querySelector('.toast');
    return { overlay: !!sr.querySelector('.overlay'), toast: toast ? toast.textContent : "" };
  })()`);
  console.log(`  持锁方存在: 弹窗=${blocked.overlay}，提示「${blocked.toast}」`);
  if (blocked.overlay) throw new Error("另一标签页执行中时不应出现确认弹窗");
  if (!blocked.toast.includes("另一个标签页")) throw new Error("应提示互斥原因");

  // b) 锁已过期（心跳 10 秒前）→ 接管并正常执行
  await cdp.evaluate(`window.__xfmExternalWrite("xfm.run.lock.v1", {
    runId: "dead-tab", path: "/bob/following", heartbeat: Date.now() - 10000
  })`);
  await sleep(200);
  await openConfirmAndRun(cdp);
  const { sums } = await readResult(cdp, 120000);
  expectClean(sums, 3);
  console.log(`  过期锁被接管，正常执行: ${sums.join(" | ")}`);

  // c) 执行结束后锁应释放
  await cdp.evaluate(`${SR}.querySelector('.overlay [data-dlg="close"]').click()`);
  await sleep(700);
  const lockAfter = await cdp.evaluate(`window.__xfmStoredValue("xfm.run.lock.v1")`);
  console.log(`  执行后互斥锁: ${JSON.stringify(lockAfter)}`);
  if (lockAfter) throw new Error("执行结束后应释放互斥锁");
  await cdp.shot("39-run-lock");
}

/**
 * [V15] 结果窗口「定位」：结果未知/失败的账号可一键跳到所在行并高亮。
 */
async function runLocateUnknown(cdp) {
  console.log("\n[V15] 结果窗口定位到未知账号");
  await scanToEnd(cdp, 20, 120000);
  await setQty(cdp, 50);
  await clickAction(cdp, "auto");
  await sleep(400);

  await openConfirmAndRun(cdp);
  const { sums } = await readResult(cdp, 150000);
  const got = sums.map(numOf);
  console.log(`  结果: ${sums.join(" | ")}`);
  if (got[3] < 1) throw new Error("场景需要至少 1 个「结果未知」（stuck_user）");

  // 点击未知明细里的「定位」
  const located = await cdp.evaluate(`(() => {
    const sr = ${SR};
    const item = sr.querySelector('.dlg .list .item[data-kind="unknown"] .loc');
    if (!item) return null;
    const handle = item.getAttribute('data-loc');
    item.click();
    return handle;
  })()`);
  console.log(`  点击「定位」@${located}，弹窗应关闭并跳到该行`);
  if (!located) throw new Error("未知明细里没有「定位」按钮");
  await sleep(1200);

  const st = await cdp.evaluate(`(() => {
    const overlay = document.querySelector('[data-xfm-panel-host="1"]').shadowRoot.querySelector('.overlay');
    const flash = document.querySelector('[data-xfm-locate="1"]');
    const handleLink = flash ? flash.querySelector('[data-testid="User-Name"] a') : null;
    const href = handleLink ? handleLink.getAttribute('href') : "";
    const rect = flash ? flash.getBoundingClientRect() : null;
    return {
      overlayGone: !overlay,
      flashed: !!flash,
      onHandle: href.indexOf('${located}') !== -1,
      inViewport: rect ? rect.top >= 0 && rect.bottom <= window.innerHeight : false
    };
  })()`);
  console.log(`  弹窗关闭=${st.overlayGone}，高亮=${st.flashed}，命中账号=${st.onHandle}，在视口内=${st.inViewport}`);
  if (!st.overlayGone) throw new Error("点击定位后结果窗口应关闭");
  if (!st.flashed) throw new Error("应高亮定位到的行");
  if (!st.onHandle) throw new Error("高亮的不是目标账号");
  if (!st.inViewport) throw new Error("定位后目标行应在视口内");
  await cdp.shot("40-locate-unknown");
}

/**
 * [V11] 切换到另一个列表：旧任务必须立即终止，不能带着旧队列在新列表上继续。
 * 对应审核发现 1：路由切换会更新 state.mode/state.owner，
 * 运行中的校验必须与任务启动时固化的身份快照比较。
 */
async function runRouteSwitch(cdp) {
  console.log("\n[V11] 列表切换：旧任务立即中止");
  await scanToEnd(cdp, 20, 120000);
  await setQty(cdp, 50);
  await clickAction(cdp, "auto");
  await sleep(400);
  const selected = Number(await stat(cdp, "selected"));
  console.log(`  已选 ${selected} 个，观察到第一次取关后切换到 /bob/following`);
  if (selected < 8) throw new Error("候选不足，场景无法覆盖中止");

  const followed = `document.querySelectorAll('[data-testid$="-unfollow"]').length`;
  const before = await cdp.evaluate(followed);
  await openConfirmAndRun(cdp);
  await waitFor(async () => await cdp.evaluate(followed) < before, 10000, "首次取关");
  await cdp.evaluate(`history.pushState({}, "", "/bob/following"); window.dispatchEvent(new PopStateEvent("popstate"));`);

  const { sums } = await readResult(cdp, 30000);
  const got = sums.map(numOf);
  console.log(`  结果: ${sums.join(" | ")}`);
  if (got[4] < 5) throw new Error(`剩余目标应记为未处理，实际未处理 ${got[4]}`);
  if (got[0] + got[3] + got[2] >= selected) throw new Error("不应把所有目标都处理完，场景没有覆盖中止");

  // 关闭结果弹窗：新列表应从零开始，不残留旧数据与复选框
  await cdp.evaluate(`${SR}.querySelector('.overlay [data-dlg="close"]').click()`);
  await sleep(600);
  const st = await cdp.evaluate(`(() => {
    const sr = ${SR};
    return {
      phase: sr.querySelector('[data-role="phase"]').textContent,
      total: sr.querySelector('[data-role="total"]').textContent,
      boxes: document.querySelectorAll('[data-xfm-select]').length
    };
  })()`);
  console.log(`  切换后: 阶段「${st.phase}」，已扫描 ${st.total}，复选框 ${st.boxes}`);
  if (st.total !== "0") throw new Error(`切换列表后旧扫描数据应清空，实际 ${st.total}`);
  if (st.boxes !== 0) throw new Error(`切换列表后不应残留复选框，实际 ${st.boxes}`);
  await cdp.shot("36-route-switch");
}

async function runRouteConfirm(cdp) {
  console.log("\n列表切换：确认弹窗打开期间取消任务");
  await scanToEnd(cdp, 20, 120000);
  await setQty(cdp, 3);
  await clickAction(cdp, "auto");
  const before = await cdp.evaluate(`document.querySelectorAll('[data-testid$="-unfollow"]').length`);
  await clickAction(cdp, "unfollow");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.overlay [data-role="ack"]')`), 6000, "确认弹窗");
  await cdp.evaluate(`history.pushState({}, "", "/alice/followers"); window.dispatchEvent(new PopStateEvent("popstate"));`);
  await sleep(500);
  const st = await cdp.evaluate(`({dialog: !!${SR}.querySelector('.overlay [data-role="ack"]'), lock: window.__xfmStoredValue('xfm.run.lock.v1'), following: document.querySelectorAll('[data-testid$="-unfollow"]').length})`);
  if (st.dialog || st.lock) throw new Error("切换列表后应关闭确认并释放执行锁");
  if (st.following !== before) throw new Error(`切换确认页面期间不应执行操作，之前 ${before}，现在 ${st.following}`);
}

async function runRouteIdentity(cdp) {
  console.log("\n切换到数字 ID 列表时清空旧账号的扫描与选择");
  async function switchList(path) {
    await cdp.evaluate(`history.pushState({}, "", ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent("popstate"));`);
    if (await stat(cdp, "total") !== "0" || await stat(cdp, "selected") !== "0") {
      throw new Error(`切换到 ${path} 后仍显示上一个列表的扫描或选择`);
    }
  }

  await scanToEnd(cdp, 20, 30000);
  await clickAction(cdp, "auto");
  await switchList("/i/user/101/following");
  await scanToEnd(cdp, 20, 30000);
  await switchList("/i/user/202/following");
}

async function runForeignConfirmation(cdp) {
  console.log("\nX 已有待确认的操作时暂停本批，不点击该确认按钮");
  await scanToEnd(cdp, 20, 30000);
  await setQty(cdp, 1);
  await clickAction(cdp, "auto");
  const before = await cdp.evaluate(`(() => {
    window.foreignConfirmationClicks = 0;
    const button = document.createElement('button');
    button.dataset.testid = 'confirmationSheetConfirm';
    button.textContent = '删除';
    button.addEventListener('click', () => { window.foreignConfirmationClicks++; button.remove(); });
    document.body.append(button);
    return document.querySelectorAll('[data-testid$="-unfollow"]').length;
  })()`);
  await openConfirmAndRun(cdp);
  const { sums } = await readResult(cdp, 12000);
  const after = await cdp.evaluate(`({ clicks: window.foreignConfirmationClicks, following: document.querySelectorAll('[data-testid$="-unfollow"]').length })`);
  if (after.clicks !== 0 || after.following !== before || numOf(sums[0]) !== 0) {
    throw new Error(`不得点击已有确认或执行取关，实际 ${JSON.stringify(after)}`);
  }
}

/**
 * [V12] 排除名单并发写保护。
 * 修复后所有写入方都先读盘合并再写，不会出现「旧副本整份覆盖」；
 * 本场景验证两条真实路径：
 *  a) 另一个标签页并发保存它自己的排除项 → 双方保护项都保留；
 *  b) 弹窗「清空排除」的显式清空 → 正常生效（合并不能把显式删除吞掉）。
 */
async function runExcludeMerge(cdp) {
  console.log("\n[V12] 排除名单跨标签页合并");
  await scanToEnd(cdp, 20, 120000);

  // 本页右键排除 alpha_dev，等防抖落盘
  await cdp.evaluate(`(() => {
    const b = document.querySelector('[data-xfm-select][data-handle="alpha_dev"]');
    b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  })()`);
  await sleep(600);
  let stored = await cdp.evaluate(`(window.__xfmStoredSettings() || {}).excluded || []`);
  console.log(`  本页排除后落盘: ${stored.join(", ")}`);
  if (!stored.includes("alpha_dev")) throw new Error("排除 alpha_dev 未落盘");

  // a) 另一个标签页（同样读-合并-写）保存它自己的排除项 bob_ui，
  //    它读盘时会带上本页刚写的 alpha_dev —— 这正是并发写的真实形态
  await cdp.evaluate(`(() => {
    const s = window.__xfmStoredSettings();
    s.excluded = ["alpha_dev", "bob_ui"];
    window.__xfmExternalSettingsWrite(s);
  })()`);
  await sleep(500);
  const metricAfter = await stat(cdp, "excluded");
  console.log(`  并发写入后本页已排除指标: ${metricAfter}（应为 2）`);
  if (metricAfter !== "2") throw new Error(`收到并发写入后应合并两页名单，实际 ${metricAfter}`);

  // 本页再排除 carol_ml 触发一次真实保存：alpha_dev 与 bob_ui 都不能丢
  await cdp.evaluate(`(() => {
    const b = document.querySelector('[data-xfm-select][data-handle="carol_ml"]');
    b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  })()`);
  await sleep(700);
  stored = await cdp.evaluate(`(window.__xfmStoredSettings() || {}).excluded || []`);
  console.log(`  本页再排除后落盘: ${stored.join(", ")}`);
  for (const h of ["alpha_dev", "bob_ui", "carol_ml"]) {
    if (!stored.includes(h)) throw new Error(`三方合并后落盘名单缺少 ${h}`);
  }

  // b) 弹窗「清空排除」= 显式清空，必须正常生效
  await cdp.evaluate(`(() => {
    const s = window.__xfmStoredSettings();
    s.excluded = [];
    window.__xfmExternalSettingsWrite(s);
  })()`);
  await sleep(500);
  const metricCleared = await stat(cdp, "excluded");
  console.log(`  显式清空后已排除指标: ${metricCleared}`);
  if (metricCleared !== "0") throw new Error("显式清空应立即生效");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-xfm-select][data-handle="alpha_dev"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true}));
    const s=window.__xfmStoredSettings();
    s.excluded=['bob_ui'];
    window.__xfmExternalSettingsWrite(s);
  })()`);
  await sleep(700);
  const pendingMerged=await cdp.evaluate(`window.__xfmStoredSettings().excluded`);
  if(!pendingMerged.includes('alpha_dev') || !pendingMerged.includes('bob_ui')) throw Error('外部同步丢失了尚未落盘的排除项');
  await cdp.shot("37-exclude-merge");
}

/**
 * [V13] 执行后状态即时更新 + 快照对账。
 * a) 取关成功后「未回关」统计立即扣减、对应复选框消失——不用重新扫描；
 * b) 用户在 X 上手动取关（绕过扩展）→ 页面按钮变「关注」→ 对账把该账号
 *    移出候选，统计同步。
 */
async function runPostRunSync(cdp) {
  console.log("\n[V13] 执行后统计即时更新 + 快照对账");
  await scanToEnd(cdp, 20, 120000);
  const oneWayBefore = Number(await stat(cdp, "oneway"));
  await setQty(cdp, 3);
  await clickAction(cdp, "auto");
  await waitFor(async () => (await stat(cdp, "selected")) === "3", 5000, "自动勾选 3 个");

  await openConfirmAndRun(cdp);
  const { sums } = await readResult(cdp, 120000);
  if (sums.map(numOf)[0] !== 3) throw new Error(`应成功 3 个，实际 ${sums[0]}`);

  const after = await cdp.evaluate(`(() => {
    const sr = ${SR};
    return {
      oneWay: Number(sr.querySelector('[data-role="oneway"]').textContent),
      total: Number(sr.querySelector('[data-role="total"]').textContent),
      boxes: document.querySelectorAll('[data-xfm-select][data-checked="1"]').length
    };
  })()`);
  console.log(`  执行后: 未回关 ${after.oneWay}（执行前 ${oneWayBefore}），已扫描 ${after.total}`);
  if (after.oneWay !== oneWayBefore - 3) throw new Error("取关成功后「未回关」统计应立即扣减 3");
  if (after.boxes !== 0) throw new Error("执行后不应残留勾选");

  // 快照对账：模拟用户在 X 上手动取关一个未处理的账号（按钮翻成「关注」）
  const target = await cdp.evaluate(`(() => {
    const b = document.querySelector('[data-xfm-select][data-disabled="0"]');
    if (!b) return null;
    const h = b.getAttribute("data-handle");
    const cell = b.parentElement.querySelector('[data-testid="UserCell"]');
    const btn = cell.querySelector('[data-testid$="-unfollow"]');
    const uid = btn.getAttribute("data-testid").replace(/-unfollow$/, "");
    btn.setAttribute("data-testid", uid + "-follow");
    btn.innerHTML = "<span>关注</span>";
    return h;
  })()`);
  if (!target) throw new Error("没有可操作的候选行");
  console.log(`  手动取关 @${target}，等待两轮对账…`);
  let reconciled = null;
  for (let i = 0; i < 7; i += 1) {
    await sleep(1000);
    reconciled = await cdp.evaluate(`(() => {
      const sr = ${SR};
      const boxes = Array.from(document.querySelectorAll('[data-xfm-select]')).map(b => b.getAttribute('data-handle'));
      return {
        oneWay: Number(sr.querySelector('[data-role="oneway"]').textContent),
        total: Number(sr.querySelector('[data-role="total"]').textContent),
        boxGone: !document.querySelector('[data-xfm-select][data-handle="${target}"]'),
        firstBoxes: boxes.slice(0, 4).join(',')
      };
    })()`);
    console.log(`  t+${i + 1}s:` + JSON.stringify(reconciled));
    if (reconciled.boxGone) break;
  }
  console.log(`  对账后: 未回关 ${reconciled.oneWay}，该行复选框已移除=${reconciled.boxGone}`);
  if (reconciled.oneWay !== after.oneWay - 1) throw new Error("手动取关后「未回关」应对账扣减 1");
  if (!reconciled.boxGone) throw new Error("已取关账号的复选框应被移除");
  await cdp.shot("38-post-run-sync");
}

/**
 * [V9] 身份不一致：侧边栏是另一个账号 → 扫描入口直接拒绝并写明两侧账号。
 * 钉住行为防止回退。
 */
async function runForeignIdentity(cdp) {
  console.log("\n[V9] 身份不一致：拒绝扫描且原因可读");
  await waitFor(() => panelReady(cdp), 10000, "面板挂载");
  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描失败"), 20000, "扫描标记失败");
  const status = await statusText(cdp);
  console.log(`  状态: ${status}`);
  if (!status.includes("@bob") || !status.includes("@alice")) {
    throw new Error("拒绝原因应写明两侧账号，实际: " + status);
  }
  const canUnfollow = await cdp.evaluate(`!(${SR}.querySelector('[data-act="unfollow"]')).disabled`);
  if (canUnfollow) throw new Error("身份不一致时不应允许执行");
  await cdp.shot("34-foreign-identity");
}

/**
 * [V10] 身份无法核实：页面完全暴露不出登录账号 → 扫描可用，批量执行锁定。
 * 对应发现 4 的真正盲区：/i/user/<id>/following 或读不到侧边栏身份的页面。
 */
async function runNoSelfIdentity(cdp) {
  console.log("\n[V10] 身份无法核实：批量执行锁定");
  await scanToEnd(cdp, 20, 120000);
  await setQty(cdp, 2);
  await clickAction(cdp, "auto");
  await sleep(400);
  if ((await stat(cdp, "selected")) !== "2") throw new Error("身份锁定不应影响勾选");

  const st = await cdp.evaluate(`(() => {
    const sr = ${SR};
    const btn = sr.querySelector('[data-act="unfollow"]');
    const warn = sr.querySelector('[data-role="warn"]');
    return {
      disabled: btn.disabled,
      warn: warn && !warn.hidden ? warn.textContent : ""
    };
  })()`);
  console.log(`  执行按钮 disabled=${st.disabled}；警告「${st.warn}」`);
  if (!st.disabled) throw new Error("身份无法核实时应禁用批量执行按钮");
  if (!st.warn.includes("无法核实")) throw new Error("应展示身份锁警告");

  // 禁用按钮的 JS click 也不应触发确认弹窗
  await cdp.evaluate(`(${SR}.querySelector('[data-act="unfollow"]')).click()`);
  await sleep(600);
  const hasDialog = await cdp.evaluate(`!!${SR}.querySelector('.overlay')`);
  if (hasDialog) throw new Error("身份锁定时不应出现确认弹窗");
  await cdp.shot("35-noself-identity");
}

/* ------------------------------------------------------------------ */
/* 交互场景                                                      */
/* ------------------------------------------------------------------ */

async function runVirtual(cdp) {
  console.log("\n[V1] 虚拟列表：只渲染视口附近 + 节点复用");
  await scanToEnd(cdp, 60, 180000);
  const rendered = await cdp.evaluate(`document.querySelectorAll('[data-testid="UserCell"]').length`);
  const topRow = await cdp.evaluate(`!!document.querySelector('#list [data-handle="user0"]')`);
  console.log(`  当前渲染行数: ${rendered}（真实列表 60 行），首行是否还在 DOM: ${topRow}`);
  if (rendered >= 40) throw new Error("虚拟列表渲染了过多行，测试台配置有误");
  if (topRow) throw new Error("滚动到底后列表顶部的行仍留在 DOM，节点没有被回收");

  await setQty(cdp, 5);
  await clickAction(cdp, "auto");
  await sleep(400);
  if ((await stat(cdp, "selected")) !== "5") throw new Error("自动选择数量不对");
  await openConfirmAndRun(cdp);
  const { sums } = await readResult(cdp, 150000);
  expectClean(sums, 5);
  await cdp.shot("27-virtual");
}

async function runTargetAbove(cdp) {
  console.log("\n[V2] 目标在视口上方：从底部执行，必须向上搜索");
  await scanToEnd(cdp, 40, 180000);

  const handles = ["user19", "user20", "user22"];
  for (const h of handles) {
    const ok = await cdp.evaluate(`window.__xfmScrollToHandle("${h}")`);
    if (!ok) throw new Error(`测试台没有找到 ${h}`);
    await sleep(520);
    const clicked = await cdp.evaluate(`(() => {
      const box = document.querySelector('[data-xfm-select][data-handle="${h}"]');
      if (!box) return false;
      box.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`${h} 没有复选框，页面同步失败`);
  }
  const selected = await stat(cdp, "selected");
  console.log(`  已选中 ${selected} 个位于列表上方的账号: ${handles.join(", ")}`);
  if (selected !== "3") throw new Error(`应选中 3 个，实际 ${selected}`);

  // 回到列表底部：此时 3 个目标全在视口上方
  await cdp.evaluate(`window.__xfmScrollToBottom()`);
  await sleep(500);
  const yStart = await cdp.evaluate(`window.scrollY`);
  console.log(`  执行起点（列表底部）: ${yStart}`);

  await openConfirmAndRun(cdp);

  let minY = yStart;
  let logged = 0;
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    const y = await cdp.evaluate(`window.scrollY`);
    if (y < minY) minY = y;
    if (process.env.XFM_DEBUG) {
      const logs = await cdp.evaluate(
        `(window.__xfmLogs || []).filter((e) => e.tag.indexOf('seek') === 0).slice(${logged}).map((e) => e.tag + ' ' + JSON.stringify(e.data))`
      );
      if (logs.length) { console.log("    " + logs.join("\n    ")); logged += logs.length; }
    }
    if (await cdp.evaluate(`!!${SR}.querySelector('.overlay .sum')`)) break;
  }
  const { sums } = await readResult(cdp, 90000);
  console.log(`  执行期间最高点: ${minY}（起点 ${yStart}）`);
  if (process.env.XFM_DEBUG) {
    const logs = await cdp.evaluate(
      `(window.__xfmLogs || []).filter((e) => e.tag.indexOf('seek') === 0 || e.tag === 'verdict').map((e) => e.tag + ' ' + JSON.stringify(e.data))`
    );
    console.log("  定位日志:\n    " + logs.join("\n    "));
  }
  expectClean(sums, 3);
  if (minY > yStart - 800) throw new Error("没有观察到向上搜索，用例没有覆盖目标在上方的场景");
  await cdp.shot("28-target-above");
}

async function runDeleteComp(cdp) {
  console.log("\n[V3] 删除行 + 滚动补偿：视口不能跳");
  await scanToEnd(cdp, 40, 180000);
  await setQty(cdp, 3);
  await clickAction(cdp, "auto");
  await sleep(400);
  if ((await stat(cdp, "selected")) !== "3") throw new Error("自动选择数量不对");

  await openConfirmAndRun(cdp);

  let prev = await cdp.evaluate(`window.scrollY`);
  let maxJump = 0;
  let sawTarget = false; // 首个目标的定位跳跃是设计行为，不计入删除补偿测量
  for (let i = 0; i < 150; i += 1) {
    await sleep(200);
    const st = await cdp.evaluate(`(() => {
      const sr = document.querySelector('[data-xfm-panel-host="1"]').shadowRoot;
      const bar = sr.querySelector('[data-role="runtext"]');
      return { y: window.scrollY, text: bar ? bar.textContent : '' };
    })()`);
    if (st.text.indexOf("@") !== -1) sawTarget = true;
    if (sawTarget && st.text.indexOf("处理中") !== -1) {
      maxJump = Math.max(maxJump, Math.abs(st.y - prev));
    }
    prev = st.y;
    if (await cdp.evaluate(`!!${SR}.querySelector('.overlay .sum')`)) break;
  }
  const { sums } = await readResult(cdp, 90000);
  console.log(`  处理阶段最大单步位移: ${maxJump}px`);
  expectClean(sums, 3);
  if (maxJump > 340) throw new Error(`删除行导致视口跳动 ${maxJump}px（超过一行高度）`);
  await cdp.shot("29-delete-compensate");
}

async function runHydrate(cdp) {
  console.log("\n[V4] 按钮延迟渲染（hydration）：不能误判「未找到按钮」");
  await scanToEnd(cdp, 40, 180000);

  // 回到顶部并让所有行重新渲染；执行阶段的行会带着 600ms 的按钮延迟出现
  await cdp.evaluate(`window.scrollTo(0, 0)`);
  await sleep(500);
  await cdp.evaluate(`window.__xfmHydrate = 0.6`);

  await setQty(cdp, 3);
  await clickAction(cdp, "auto");
  await sleep(400);
  if ((await stat(cdp, "selected")) !== "3") throw new Error("自动选择数量不对");

  await openConfirmAndRun(cdp);
  const { sums } = await readResult(cdp, 120000);
  expectClean(sums, 3);
  await cdp.shot("30-hydrate");
}

async function runUserCoexist(cdp) {
  console.log("\n[V5] 执行中用户手动滚动：任务继续，不抢滚动条");
  await scanToEnd(cdp, 20, 120000);
  await setQty(cdp, 5);
  await clickAction(cdp, "auto");
  await sleep(400);
  if ((await stat(cdp, "selected")) !== "5") throw new Error("应选中 5 个");

  await openConfirmAndRun(cdp);
  await sleep(1800);

  const before = await cdp.evaluate(`window.scrollY`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 500, y: 300, deltaX: 0, deltaY: -450 });
  await sleep(200);
  let after = await cdp.evaluate(`window.scrollY`);
  if (Math.abs(after - before) < 60) {
    // 无头环境偶尔不派发滚轮事件：退化为脚本滚动 + wheel，等价触发「用户接管」
    await cdp.evaluate(`window.dispatchEvent(new WheelEvent('wheel', { deltaY: -450 })); window.scrollBy(0, -450);`);
    await sleep(200);
    after = await cdp.evaluate(`window.scrollY`);
  }
  console.log(`  手动滚动: ${before} → ${after}`);

  const samples = [];
  for (let i = 0; i < 7; i += 1) {
    await sleep(100);
    samples.push(await cdp.evaluate(`window.scrollY`));
  }
  console.log(`  宽限期采样: ${samples.join(", ")}`);
  const pulled = samples.filter((y) => Math.abs(y - after) > 80);
  if (pulled.length > 0) throw new Error(`用户滚动后被程序化定位抢回: ${samples.join(", ")}`);

  const { sums } = await readResult(cdp, 120000);
  expectClean(sums, 5);
  await cdp.shot("31-user-coexist");
}

async function runBottomScroll(cdp) {
  console.log("\n[V6] 扫描到底回弹：不能把用户滚动抢回底部");
  await waitFor(() => panelReady(cdp), 10000, "面板挂载");
  await clickAction(cdp, "scan");

  const deadline = Date.now() + 60000;
  let reached = false;
  while (Date.now() < deadline) {
    // 必须「20 行全部渲染 + 已在底部」，否则会误把首屏加载完成当成到达列表末尾
    const st = await cdp.evaluate(`({
      y: window.scrollY,
      h: document.documentElement.scrollHeight,
      vh: window.innerHeight,
      rows: document.querySelectorAll('[data-testid="UserCell"]').length
    })`);
    if (st.rows >= 20 && st.y + st.vh >= st.h - 30) { reached = true; break; }
    await sleep(100);
  }
  if (!reached) throw new Error("扫描没有走到列表底部");

  const yBottom = await cdp.evaluate(`window.scrollY`);
  await cdp.evaluate(`window.dispatchEvent(new WheelEvent('wheel', { deltaY: -250 })); window.scrollBy(0, -250);`);
  const yAfter = await cdp.evaluate(`window.scrollY`);
  await sleep(500);
  const yNow = await cdp.evaluate(`window.scrollY`);
  console.log(`  底部回弹窗口: ${yBottom} → 用户滚到 ${yAfter} → 500ms 后 ${yNow}`);
  if (yNow > yAfter + 80) throw new Error(`扫描回弹把用户滚动抢回了底部（${yAfter} → ${yNow}）`);

  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 90000, "扫描完成");
  const total = await stat(cdp, "total");
  console.log(`  扫描最终完成: ${total} 个`);
  if (Number(total) !== 20) throw new Error(`扫描应完成 20 个，实际 ${total}`);
  await cdp.shot("32-bottom-scroll");
}

async function runDebugLog(cdp) {
  console.log("\n[V7] 调试日志：开启可取证，关闭零输出");
  await waitFor(() => panelReady(cdp), 10000, "面板挂载");
  await sleep(600);

  const bootTags = await cdp.evaluate(`(window.__xfmLogs || []).map((e) => e.tag)`);
  console.log(`  启动日志: ${bootTags.join(", ")}`);
  if (!bootTags.includes("boot")) throw new Error("开启调试后应记录 boot 日志");

  await clickAction(cdp, "scan");
  await sleep(5200);
  const tags = await cdp.evaluate(`(window.__xfmLogs || []).map((e) => e.tag)`);
  const uniq = Array.from(new Set(tags));
  console.log(`  扫描日志标签: ${uniq.join(", ")}`);
  if (!tags.includes("scan.round")) throw new Error("缺少扫描轮次日志");
  if (!tags.includes("scroll.to")) throw new Error("缺少滚动日志");
  await clickAction(cdp, "stop");
  await sleep(400);

  // 不带 ?xfmdebug=1 重新加载：缓冲必须为空
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(1800);
  const offCount = await cdp.evaluate(`(window.__xfmLogs || []).length`);
  console.log(`  关闭调试后的日志条数: ${offCount}`);
  if (offCount !== 0) throw new Error("默认关闭时不应记录任何日志");
}

async function runSchedPrecheck(cdp) {
  console.log("\n[scheduled] 启用前必须完成当前列表扫描");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  const phase = await phaseText(cdp);
  console.log(`  当前状态: ${phase}`);
  if (/扫描中|扫描完成|结果不完整|扫描失败/.test(phase)) throw new Error("该场景必须在未扫描状态下运行");

  await clickAction(cdp, "sched");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "定时设置窗口");
  await cdp.evaluate(`(() => {
    const body = ${SR}.querySelector('[data-sbody="cleanup"]');
    body.querySelector('[data-sched="enabled"]').checked = true;
    body.querySelector('[data-sched="ack"]').checked = true;
    body.querySelector('[data-sched-save="cleanup"]').click();
  })()`);
  await sleep(500);
  const toast = await cdp.evaluate(`(() => { const t = ${SR}.querySelector('.toast'); return t ? t.textContent : ''; })()`);
  console.log(`  提示: ${toast}`);
  if (!toast.includes("请先完成对应列表的扫描")) throw new Error("未扫描状态下启用定时任务应被拒绝");
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(300);
}

async function runSchedRecheck(cdp) {
  console.log("\n[scheduled] 重新启用已有授权任务仍需当前扫描");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");

  async function openSched() {
    await clickAction(cdp, "sched");
    await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "定时设置窗口");
  }
  async function fillAndSave(enable) {
    await cdp.evaluate(`(() => {
      const body = ${SR}.querySelector('[data-sbody="cleanup"]');
      body.querySelector('[data-sched="enabled"]').checked = ${enable ? "true" : "false"};
      body.querySelector('[data-sched="ack"]').checked = ${enable ? "true" : "false"};
      body.querySelector('[data-sched-save="cleanup"]').click();
    })()`);
    await sleep(500);
    return await cdp.evaluate(`(() => { const t = ${SR}.querySelector('.toast'); return t ? t.textContent : ''; })()`);
  }
  async function readTask() {
    return await cdp.evaluate(`(() => {
      const all = JSON.parse(localStorage.getItem('xfm-store') || '{}');
      return all['xfm.scheduled.v1'] ? all['xfm.scheduled.v1'].cleanup : null;
    })()`);
  }

  // 1) 未扫描：启用被拒
  await openSched();
  let toast = await fillAndSave(true);
  console.log(`  未扫描启用: ${toast}`);
  if (!toast.includes("请先完成对应列表的扫描")) throw new Error("未扫描时启用应被拒绝");
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(300);

  // 2) 扫描完成：启用成功
  await clickAction(cdp, "scan");
  await waitFor(async () => (await phaseText(cdp)).includes("扫描完成"), 60000, "扫描完成");
  await openSched();
  toast = await fillAndSave(true);
  console.log(`  扫描后启用: ${toast}`);
  if (!toast.includes("已保存")) throw new Error("扫描完成后应允许启用");
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(300);
  const savedBefore = await readTask();
  if (!savedBefore || savedBefore.enabled !== true || savedBefore.authorized !== true) throw new Error("任务未正确保存");
  console.log(`  已保存任务: ${JSON.stringify({ enabled: savedBefore.enabled, authorized: savedBefore.authorized, count: savedBefore.count })}`);

  // 3) 刷新后未扫描：再次保存已启用任务仍被拒，且存储不变
  await cdp.send("Page.reload", {});
  await waitFor(() => panelReady(cdp), 8000, "刷新后面板挂载");
  const phaseAfterReload = await phaseText(cdp);
  if (!phaseAfterReload.includes("未扫描")) throw new Error(`刷新后应回到未扫描，实际 ${phaseAfterReload}`);
  await openSched();
  toast = await fillAndSave(true);
  console.log(`  刷新后再保存: ${toast}`);
  if (!toast.includes("请先完成对应列表的扫描")) throw new Error("重新启用已授权任务也必须先扫描");
  const savedAfter = await readTask();
  if (JSON.stringify(savedAfter) !== JSON.stringify(savedBefore)) throw new Error("被拒绝的保存不应改写任务");

  // 4) 关闭定时任务不应被扫描前置条件卡住
  toast = await fillAndSave(false);
  console.log(`  关闭任务: ${toast}`);
  if (!toast.includes("已保存")) throw new Error("关闭定时任务应允许保存");
  const closed = await readTask();
  if (!closed || closed.enabled !== false) throw new Error("关闭状态未保存");
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(300);
}

async function runSchedInterval(cdp) {
  console.log("\n[scheduled] 每天按间隔：字段显示、保存与切换保留");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await scanToEnd(cdp, 20, 120000);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  await clickAction(cdp, "sched");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "定时设置窗口");

  const once = await cdp.evaluate(`(() => {
    const body = ${SR}.querySelector('[data-sbody="cleanup"]');
    const type = body.querySelector('[data-sched="type"]');
    type.value = "once";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    const display = sel => getComputedStyle(body.querySelector('[data-sched-row="' + sel + '"]')).display;
    const visibleInputs = Array.from(body.querySelectorAll('input[type="time"], input[type="datetime-local"]'))
      .filter(el => getComputedStyle(el.closest('[data-sched-row]')).display !== "none").length;
    return { timeRow: display("time"), onceRow: display("once"), visibleInputs };
  })()`);
  console.log(`  单次: 日期行=${once.onceRow}，时间行=${once.timeRow}，可见时间输入=${once.visibleInputs}`);
  if (once.timeRow !== "none") throw new Error("单次不应显示第二个时间输入");
  if (once.onceRow === "none") throw new Error("单次应显示日期时间行");
  if (once.visibleInputs !== 1) throw new Error("单次应只有一个可见时间输入");

  const interval = await cdp.evaluate(`(() => {
    const body = ${SR}.querySelector('[data-sbody="cleanup"]');
    const type = body.querySelector('[data-sched="type"]');
    type.value = "interval";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    const display = sel => getComputedStyle(body.querySelector('[data-sched-row="' + sel + '"]')).display;
    return { time: display("time"), once: display("once"), weekly: display("weekly"), monthly: display("monthly"), interval: display("interval") };
  })()`);
  console.log(`  每天按间隔: time=${interval.time} once=${interval.once} weekly=${interval.weekly} monthly=${interval.monthly} interval=${interval.interval}`);
  for (const key of ["time", "once", "weekly", "monthly"]) {
    if (interval[key] !== "none") throw new Error(`每天按间隔时 ${key} 行应隐藏`);
  }
  if (interval.interval === "none") throw new Error("每天按间隔行应显示");

  await cdp.evaluate(`(() => {
    const body = ${SR}.querySelector('[data-sbody="cleanup"]');
    body.querySelector('[data-sched="dailyStart"]').value = "09:00";
    body.querySelector('[data-sched="dailyEnd"]').value = "21:00";
    body.querySelector('[data-sched="intervalHours"]').value = "4";
    body.querySelector('[data-sched="count"]').value = "3";
    body.querySelector('[data-sched="enabled"]').checked = true;
    body.querySelector('[data-sched="ack"]').checked = true;
    body.querySelector('[data-sched-save="cleanup"]').click();
  })()`);
  await waitFor(async () => (await cdp.evaluate(`(() => { const t = ${SR}.querySelector('.toast'); return t ? t.textContent : ''; })()`)).includes("已保存"), 8000, "保存成功提示");

  const saved = await cdp.evaluate(`(() => {
    const all = JSON.parse(localStorage.getItem('xfm-store') || '{}');
    return all['xfm.scheduled.v1'] ? all['xfm.scheduled.v1'].cleanup : null;
  })()`);
  if (!saved) throw new Error("任务未写入存储");
  console.log(`  已保存: type=${saved.type} ${saved.dailyStart}-${saved.dailyEnd}/${saved.intervalHours}h nextRun=${new Date(saved.nextRun).toLocaleString()}`);
  if (saved.type !== "interval" || saved.dailyStart !== "09:00" || saved.dailyEnd !== "21:00" || saved.intervalHours !== 4) throw new Error("间隔字段保存不正确");
  if (!(saved.nextRun > Date.now())) throw new Error("下次执行时间应在未来");
  const at = new Date(saved.nextRun);
  const slot = String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
  if (!["09:00", "13:00", "17:00", "21:00"].includes(slot)) throw new Error(`下次执行时间不在计划槽位：${slot}`);

  const hint = await cdp.evaluate(`(() => {
    const body = ${SR}.querySelector('[data-sbody="cleanup"]');
    return { save: (body.querySelector('[data-sched-save]') || {}).title || "", run: (body.querySelector('[data-sched-exec]') || {}).title || "" };
  })()`);
  if (!hint.save.includes("只保存计划") || !hint.run.includes("不改变")) throw new Error("保存与立即执行的悬停说明缺失");

  // 未保存的修改在切换标签后仍保留
  await cdp.evaluate(`(() => {
    const body = ${SR}.querySelector('[data-sbody="cleanup"]');
    body.querySelector('[data-sched="count"]').value = "7";
    ${SR}.querySelector('[data-stab="followback"]').click();
  })()`);
  await sleep(250);
  await cdp.evaluate(`${SR}.querySelector('[data-stab="cleanup"]').click()`);
  await sleep(250);
  const draft = await cdp.evaluate(`(() => {
    const body = ${SR}.querySelector('[data-sbody="cleanup"]');
    return { type: body.querySelector('[data-sched="type"]').value, count: body.querySelector('[data-sched="count"]').value, start: body.querySelector('[data-sched="dailyStart"]').value };
  })()`);
  console.log(`  切换标签后草稿: ${JSON.stringify(draft)}`);
  if (draft.type !== "interval" || draft.count !== "7" || draft.start !== "09:00") throw new Error("切换标签后未保存的填写丢失");

  // 关闭再打开：显示已保存的设置，不沿用未保存草稿
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(300);
  await clickAction(cdp, "sched");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "重开定时设置窗口");
  const reopened = await cdp.evaluate(`(() => {
    const body = ${SR}.querySelector('[data-sbody="cleanup"]');
    return {
      type: body.querySelector('[data-sched="type"]').value,
      count: body.querySelector('[data-sched="count"]').value,
      start: body.querySelector('[data-sched="dailyStart"]').value,
      end: body.querySelector('[data-sched="dailyEnd"]').value,
      step: body.querySelector('[data-sched="intervalHours"]').value,
      intervalVisible: getComputedStyle(body.querySelector('[data-sched-row="interval"]')).display !== "none",
      next: (body.querySelector('.sched-next') || {}).textContent || ""
    };
  })()`);
  console.log(`  重开: ${JSON.stringify(reopened)}`);
  if (reopened.type !== "interval" || reopened.count !== "3" || reopened.start !== "09:00" || reopened.end !== "21:00" || reopened.step !== "4") throw new Error("重开后设置回显不正确");
  if (!reopened.intervalVisible) throw new Error("重开后间隔字段应可见");
  if (!reopened.next.includes("下次开始扫描")) throw new Error("重开后应显示下次执行时间");
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(300);

  // 小窗口：对话框不横向溢出，底部操作按钮可见，内容区可滚动
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 620, deviceScaleFactor: 1, mobile: false });
  await sleep(350);
  const panelState = await cdp.evaluate(`(() => {
    const host = document.querySelector('[data-xfm-panel-host="1"]');
    const btn = host && host.shadowRoot.querySelector('[data-act="sched"]');
    return { host: !!host, btn: !!btn, display: btn ? getComputedStyle(btn).display : 'none', w: innerWidth, h: innerHeight };
  })()`);
  console.log(`  小窗口面板: ${JSON.stringify(panelState)}`);
  await clickAction(cdp, "sched");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "小窗口定时设置");
  const narrow = await cdp.evaluate(`(() => {
    const dlg = ${SR}.querySelector('.dlg.wide');
    const actions = dlg.querySelector('.sched-actions');
    const body = dlg.querySelector('.sched-body:not([hidden])');
    const rect = actions.getBoundingClientRect();
    return {
      w: innerWidth, h: innerHeight,
      dlgW: dlg.getBoundingClientRect().width,
      actionsBottom: rect.bottom, actionsTop: rect.top,
      bodyOverflowX: body.scrollWidth > body.clientWidth + 1,
      bodyScrollable: getComputedStyle(body).overflowY
    };
  })()`);
  console.log(`  小窗口 ${narrow.w}x${narrow.h}: 弹窗宽=${Math.round(narrow.dlgW)}，按钮 top=${Math.round(narrow.actionsTop)} bottom=${Math.round(narrow.actionsBottom)}，横向溢出=${narrow.bodyOverflowX}，内容区=${narrow.bodyScrollable}`);
  if (narrow.dlgW > narrow.w) throw new Error("小窗口下弹窗横向溢出");
  if (narrow.actionsTop < 0 || narrow.actionsBottom > narrow.h) throw new Error("小窗口下操作按钮不可见");
  if (narrow.bodyOverflowX) throw new Error("小窗口下表单横向溢出");
  if (narrow.bodyScrollable !== "auto") throw new Error("小窗口下内容区应可滚动");
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await cdp.send("Emulation.clearDeviceMetricsOverride", {});
}

async function runToolbar(cdp) {
  console.log("\n[UI] 工具栏单行布局");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await scanToEnd(cdp, 20, 120000);
  const layout = await cdp.evaluate(`(() => {
    const row = ${SR}.querySelector('[data-role="tools"]');
    const btns = Array.from(row.querySelectorAll('.btn'));
    const tops = btns.map(b => Math.round(b.getBoundingClientRect().top));
    const rect = row.getBoundingClientRect();
    const unfollow = row.querySelector('[data-act="unfollow"]').getBoundingClientRect();
    return {
      rowW: Math.round(rect.width), scrollW: row.scrollWidth, rowH: Math.round(rect.height),
      tops, uniqueTops: Array.from(new Set(tops)).length,
      rightGap: Math.round(rect.right - unfollow.right),
      labels: btns.map(b => b.textContent.trim()),
      sep: !!row.querySelector('.tools-sep')
    };
  })()`);
  console.log(`  宽度 ${layout.rowW}，高度 ${layout.rowH}，按钮：${layout.labels.join(" / ")}`);
  if (!layout.sep) throw new Error("缺少分组分隔");
  if (layout.uniqueTops !== 1) throw new Error(`按钮不在同一行：${layout.tops.join(",")}`);
  if (layout.scrollW > layout.rowW + 1) throw new Error(`工具栏横向溢出：${layout.scrollW} > ${layout.rowW}`);
  if (layout.rightGap > 14) throw new Error(`取关按钮未靠右：右侧留白 ${layout.rightGap}px`);

  await cdp.evaluate(`${SR}.querySelector('[data-act="exclude-mode"]').click()`);
  await sleep(300);
  const pressed = await cdp.evaluate(`(() => {
    const btn = ${SR}.querySelector('[data-act="exclude-mode"]');
    const style = getComputedStyle(btn);
    return { pressed: btn.getAttribute('aria-pressed'), on: btn.classList.contains('on'),
      disabled: btn.disabled, bg: style.backgroundColor, color: style.color };
  })()`);
  console.log(`  排除模式: aria-pressed=${pressed.pressed}，on=${pressed.on}，背景=${pressed.bg}，文字=${pressed.color}`);
  if (pressed.pressed !== "true" || !pressed.on) throw new Error("排除模式按钮未进入激活状态");
  if (pressed.bg === "rgba(0, 0, 0, 0)" || pressed.bg === "transparent") throw new Error("排除模式激活时没有可见背景");
  await cdp.evaluate(`${SR}.querySelector('[data-act="exclude-mode"]').click()`);
  await sleep(300);
  const released = await cdp.evaluate(`(() => {
    const btn = ${SR}.querySelector('[data-act="exclude-mode"]');
    return { on: btn.classList.contains('on'), pressed: btn.getAttribute('aria-pressed'),
      bg: getComputedStyle(btn).backgroundColor };
  })()`);
  if (released.on || released.pressed !== "false") throw new Error("再次点击应退出排除模式");
  if (released.bg !== "rgba(0, 0, 0, 0)") throw new Error(`退出排除模式后仍保留背景：${released.bg}`);
  await cdp.shot("60-toolbar");
}

async function runToolbarI18n(cdp) {
  console.log("\n[UI] 多语言工具栏布局");
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await scanToEnd(cdp, 20, 120000);

  async function setLang(code) {
    await cdp.evaluate(`window.__xfmExternalSettingsWrite({ batchLimit: 50, quantity: 50, strictMode: true, filter: "one-way", language: "${code}" })`);
    await sleep(500);
  }
  async function measure(label, expectBrand) {
    const st = await cdp.evaluate(`(() => {
      const row = ${SR}.querySelector('[data-role="tools"]');
      const btns = Array.from(row.querySelectorAll('.btn'));
      const rect = row.getBoundingClientRect();
      const unfollow = row.querySelector('[data-act="unfollow"]').getBoundingClientRect();
      return {
        brand: (${SR}.querySelector('[data-role="brand"]') || {}).textContent || "",
        labels: btns.map(b => b.textContent.trim()),
        lineTops: Array.from(new Set(btns.map(b => Math.round(b.getBoundingClientRect().top)))).length,
        scrollW: row.scrollWidth, rowW: Math.round(rect.width),
        rightGap: Math.round(rect.right - unfollow.right)
      };
    })()`);
    console.log(`  ${label}: ${st.brand} | ${st.labels.join(" / ")} | 行数=${st.lineTops} 宽=${st.rowW}/${st.scrollW}`);
    if (!st.brand.includes(expectBrand)) throw new Error(`${label} 品牌文案未切换：${st.brand}`);
    if (st.lineTops !== 1) throw new Error(`${label} 工具栏换行`);
    if (st.scrollW > st.rowW + 1) throw new Error(`${label} 工具栏横向溢出`);
    if (st.rightGap > 14) throw new Error(`${label} 取关按钮未靠右`);
  }

  await setLang("en");
  await measure("English", "Follow Manager");
  await setLang("de");
  await measure("Deutsch", "Follow-Manager");
  await setLang("ru");
  await measure("Русский", "Менеджер подписок");
  await setLang("fr");
  await measure("Français", "Gestion des abonnements");
  await setLang("es");
  await measure("Español", "Gestor de seguidos");
  await setLang("pt");
  await measure("Português", "Gerenciador de seguidores");
  await setLang("ja");
  await measure("日本語", "フォロー管理");
  await setLang("ko");
  await measure("한국어", "팔로우 관리");

  // 定时对话框也必须是当前语言
  await clickAction(cdp, "sched");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "定时设置窗口");
  const dlg = await cdp.evaluate(`(() => {
    const root = ${SR};
    const title = root.querySelector('#xfm-sched-title');
    const typeSelect = root.querySelector('[data-sbody="cleanup"] [data-sched="type"]');
    return { title: title ? title.textContent : "", types: Array.from(typeSelect.options).map(o => o.text) };
  })()`);
  console.log(`  定时窗口: ${dlg.title} | ${dlg.types.join(" / ")}`);
  if (!dlg.title.includes("예약")) throw new Error("定时窗口未跟随语言");
  if (!dlg.types.some(t => t.includes("매일"))) throw new Error("每天间隔选项未翻译");
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await setLang("zh");
  await sleep(300);
}

async function runSchedLayout(cdp, dark) {
  console.log(`\n[scheduled] 排版与按钮可见性（${dark ? "dark" : "light"}）`);
  await waitFor(() => panelReady(cdp), 8000, "面板挂载");
  await scanToEnd(cdp, 20, 120000);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await clickAction(cdp, "sched");
  await waitFor(async () => cdp.evaluate(`!!${SR}.querySelector('.dlg.wide')`), 5000, "定时设置窗口");
  const state = await cdp.evaluate(`(() => {
    const body = ${SR}.querySelector('[data-sbody="cleanup"]');
    const type = body.querySelector('[data-sched="type"]');
    type.value = "daily";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    const save = body.querySelector('[data-sched-save]');
    const run = body.querySelector('[data-sched-exec]');
    const stop = body.querySelector('[data-sched-stop]');
    const rect = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      types: Array.from(type.options).map(o => o.text),
      groups: Array.from(body.querySelectorAll(".sched-group-title")).map(e => e.textContent.trim()),
      visibleRows: Array.from(body.querySelectorAll("[data-sched-row]:not([hidden])")).map(e => e.getAttribute("data-sched-row")),
      tips: [save.title, run.title, stop.title],
      classes: [save.className, run.className, stop.className],
      visibleButtons: [rect(save), rect(run), rect(stop)],
      leftoverHint: !!body.querySelector(".sched-hint"),
      colors: [save, run, stop].map(el => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, border: cs.borderColor, color: cs.color };
      })
    };
  })()`);
  console.log(`  类型: ${state.types.join(" / ")}`);
  console.log(`  分组: ${state.groups.join(" | ")}`);
  console.log(`  每天可见行: ${state.visibleRows.join(",")}`);
  console.log(`  按钮: ${state.classes.join(" | ")}`);
  if (!state.types.includes("每天") || !state.types.includes("每天按间隔")) throw new Error("类型缺少「每天」或「每天按间隔」");
  if (state.groups.length !== 3) throw new Error("定时表单分组不完整");
  if (!state.visibleRows.includes("time")) throw new Error("每天模式未显示时间行");
  if (state.visibleRows.some(r => r === "weekly" || r === "monthly" || r === "once")) throw new Error("每天模式仍显示其他周期字段");
  if (state.tips.some(t => !t)) throw new Error("按钮缺少悬停提示");
  if (state.visibleButtons.some(v => !v)) throw new Error("操作按钮不可见");
  if (state.leftoverHint) throw new Error("说明文字仍然常显");
  if (state.colors[1].bg === "rgba(0, 0, 0, 0)" && state.colors[1].border === "rgba(0, 0, 0, 0)") throw new Error("立即执行按钮在浅色下无边框无背景");
  await sleep(250);
  const dlgRect = await cdp.evaluate(`(() => { const r = ${SR}.querySelector('.dlg.wide').getBoundingClientRect(); return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height, scale: 1 }; })()`);
  await cdp.shot(dark ? "63-sched-dark" : "62-sched-light", dlgRect);
  await cdp.evaluate(`${SR}.querySelector('.dlg.wide [data-dlg="close"]').click()`);
  await sleep(250);
}

async function main() {
  console.log(`启动无头 Chrome，场景: ${scenario}`);
  // 场景页面依赖本地测试服务器；由 e2e 自行拉起，避免依赖外部常驻进程
  const serverProc = spawn(process.execPath, ["tests/server.mjs", String(TEST_PORT)], { stdio: "ignore" });
  await sleep(500);
  const { proc, profile } = await launchChrome();
  let ws = null;

  try {
    const { cdp, ws: socket } = await connectNewTab();
    ws = socket;

    const navUrl = new URL(APP_URL);
    if (scenario === "anomaly" || scenario === "locateunknown") navUrl.searchParams.set("unknownfirst", "1");
    if (scenario === "scheduledcleanup" || scenario === "scheduledfollowback" || scenario === "schedulednotifyfail" || scenario === "schedrecheck" || scenario === "schedinterval" || scenario === "toolbar" || scenario === "toolbardark" || scenario === "toolbari18n" || scenario === "schedlayout" || scenario === "schedlayoutdark") navUrl.searchParams.set("synthetic", "20");
    if (scenario === "schedlayoutdark") navUrl.searchParams.set("dark", "1");
    if (scenario === "toolbardark") navUrl.searchParams.set("dark", "1");
    if (scenario === "scheduledfollowback") navUrl.pathname = "/alice/followers";
    if (scenario === "limit") navUrl.searchParams.set("limit", "3");
    if (scenario === "strict") navUrl.searchParams.set("nomutual", "1");
    if (scenario === "dark") navUrl.searchParams.set("dark", "1");
    if (scenario === "resume") { navUrl.searchParams.set("batch", "2"); navUrl.searchParams.set("initial", "4"); }
    if (scenario === "reply") navUrl.pathname = "/alice/followers";
    if (scenario === "replacedrow") navUrl.searchParams.set("replaceonunfollow", "1");
    if (scenario === "longlist") navUrl.searchParams.set("synthetic", "400");
    if (scenario === "virtual") { navUrl.searchParams.set("virtual", "1"); navUrl.searchParams.set("synthetic", "60"); }
    if (scenario === "interactionaudit") { navUrl.searchParams.set("virtual", "1"); navUrl.searchParams.set("synthetic", "60"); }
    if (scenario === "targetabove") {
      navUrl.searchParams.set("virtual", "1");
      navUrl.searchParams.set("varheights", "1");
      navUrl.searchParams.set("synthetic", "40");
    }
    if (scenario === "deletecomp") { navUrl.searchParams.set("virtual", "1"); navUrl.searchParams.set("compensate", "1"); navUrl.searchParams.set("removeonunfollow", "1"); navUrl.searchParams.set("synthetic", "40"); }
    if (scenario === "removalunknown") navUrl.searchParams.set("removeonly", "1");
    if (scenario === "foreign") navUrl.searchParams.set("foreign", "1");
    if (scenario === "noself") navUrl.searchParams.set("noself", "1");
    if (scenario === "bgscan") navUrl.searchParams.set("bgstall", "1");
    if (scenario === "storagefail") navUrl.searchParams.set("storagefail", "1");
    if (scenario === "progressdiscard") navUrl.searchParams.set("storagelag", "2500");
    if (scenario === "progressrace") navUrl.searchParams.set("storagelag", "2500");
    if (scenario === "recyclemid") { navUrl.searchParams.set("virtual", "1"); navUrl.searchParams.set("recyclemid", "1"); navUrl.searchParams.set("synthetic", "60"); }
    if (scenario === "bgpersistent") { navUrl.searchParams.set("bgstall", "1"); navUrl.searchParams.set("xfmdebug", "1"); }
    if (scenario === "hydrate") { navUrl.searchParams.set("virtual", "1"); navUrl.searchParams.set("synthetic", "40"); }
    if (scenario === "debuglog") navUrl.searchParams.set("xfmdebug", "1");
    if (process.env.XFM_DEBUG) navUrl.searchParams.set("xfmdebug", "1");
    if (scenario === "narrow") {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 520, height: 800, deviceScaleFactor: 1, mobile: false });
    }

    if (scenario === "popup" || scenario === "popuplight" || scenario === "popuprefresh") {
      const scheme = scenario === "popuplight" ? "light" : "dark";
      // 无头窗口高 520，弹窗内容 471px 的底部会被视口截掉；把视口拉到弹窗上限 600
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 368, height: 600, deviceScaleFactor: 1, mobile: false });
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await cdp.send("Page.navigate", { url: `http://localhost:${TEST_PORT}/popup-preview` + (scenario === "popuprefresh" ? "?tick=1" : "") });
      await sleep(1000);
      if (scenario === "popuprefresh") {
        await waitFor(async () => cdp.evaluate(`!!document.getElementById('sTotal')`), 8000, "弹窗渲染");
        const first = await cdp.evaluate(`document.getElementById('sTotal').textContent`);
        await sleep(2200);
        const later = await cdp.evaluate(`document.getElementById('sTotal').textContent`);
        const title = await cdp.evaluate(`document.getElementById('stateTitle').textContent`);
        console.log(`  轮询刷新: 初始 ${first} → 2.2 秒后 ${later}，状态「${title}」`);
        if (!(Number(later) > Number(first))) throw new Error(`弹窗数字未跟随扫描进度：${first} → ${later}`);
        if (!title.includes("扫描中")) throw new Error("扫描中状态未保持");
        await cdp.shot("61-popup-refresh", { x: 0, y: 0, width: 368, height: 340, scale: 1 });
        console.log("\n场景通过 ✓");
        return;
      }
      const total = await cdp.evaluate(`document.getElementById('sTotal').textContent`);
      const oneWay = await cdp.evaluate(`document.getElementById('sOneWay').textContent`);
      const title = await cdp.evaluate(`document.getElementById('stateTitle').textContent`);
      const excluded = await cdp.evaluate(`document.getElementById('sExcluded').textContent`);
      const size = await cdp.evaluate(`(() => {
        const app = document.querySelector('.app');
        const r = app.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), scrollH: document.documentElement.scrollHeight };
      })()`);
      console.log(`  popup 状态: ${title}；已扫描 ${total}，未回关 ${oneWay}，已排除 ${excluded}；尺寸 ${JSON.stringify(size)}`);
      if (total !== "20" || oneWay !== "13") throw new Error("popup 未正确渲染统计");
      if (excluded !== "2") throw new Error("popup 未渲染已排除数量");
      if (size.scrollH > 600) throw new Error(`popup 高度 ${size.scrollH} 超出 Chrome 弹窗上限 600`);

      const theme = await cdp.evaluate(`(() => ({
        attr: document.documentElement.getAttribute('data-xfm-theme'),
        bg: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color
      }))()`);
      const wantTheme = scenario === "popuplight" ? "light" : "dark";
      console.log(`  主题: ${JSON.stringify(theme)}`);
      if (theme.attr !== wantTheme) throw new Error(`主题应为 ${wantTheme}，实际 ${theme.attr}`);
      if (wantTheme === "light" && theme.bg !== "rgb(255, 255, 255)") throw new Error("浅色背景不正确");
      if (wantTheme === "dark" && theme.bg !== "rgb(22, 24, 28)") throw new Error("深色背景不正确");

      await cdp.shot(scenario === "popuplight" ? "24-popup-light" : "15-popup", { x: 0, y: 0, width: 368, height: Math.min(600, size.scrollH + 8), scale: 1 });
      console.log("\n场景通过 ✓");
      return;
    }

    await cdp.send("Page.navigate", { url: navUrl.toString() });
    await sleep(1200);

    const needsScan = ["scan", "select", "unfollow", "replacedrow", "stop", "limit", "anomaly", "jump", "strict", "dup", "en", "dark", "exclude", "roster", "excludemode", "dialogkeys", "narrow", "collapse", "confirmedit", "scrolllock"];
    if (needsScan.includes(scenario)) {
      await runScan(cdp);
    }
    if (scenario === "select") await runSelect(cdp);
    if (scenario === "unfollow" || scenario === "replacedrow") await runUnfollow(cdp);
    if (scenario === "stop") await runStop(cdp);
    if (scenario === "limit") await runLimit(cdp);
    if (scenario === "anomaly") await runAnomaly(cdp);
    if (scenario === "jump") await runJump(cdp);
    if (scenario === "fail") await runFail(cdp);
    if (scenario === "strict") await runStrict(cdp);
    if (scenario === "dup") await runDup(cdp);
    if (scenario === "en") await runEnglish(cdp);
    if (scenario === "scanstop") await runScanStop(cdp);
    if (scenario === "dark") await runDark(cdp);
    if (scenario === "exclude") await runExclude(cdp);
    if (scenario === "reply") await runReply(cdp);
    if (scenario === "resume") await runResume(cdp);
    if (scenario === "roster") await runRoster(cdp);
    if (scenario === "excludemode") await runExcludeMode(cdp);
    if (scenario === "dialogkeys") await runDialogKeys(cdp);
    if (scenario === "narrow") await runNarrow(cdp);
    if (scenario === "collapse") await runCollapse(cdp);
    if (scenario === "confirmedit") await runConfirmEdit(cdp);
    if (scenario === "longlist") await runLongList(cdp);
    if (scenario === "scrolllock") await runScrollLock(cdp);
    if (scenario === "interactionaudit") await runInteractionAudit(cdp);
    if (scenario === "virtual") await runVirtual(cdp);
    if (scenario === "targetabove") await runTargetAbove(cdp);
    if (scenario === "deletecomp") await runDeleteComp(cdp);
    if (scenario === "hydrate") await runHydrate(cdp);
    if (scenario === "usercoexist") await runUserCoexist(cdp);
    if (scenario === "bottomscroll") await runBottomScroll(cdp);
    if (scenario === "debuglog") await runDebugLog(cdp);
    if (scenario === "removalunknown") await runRemovalUnknown(cdp);
    if (scenario === "foreign") await runForeignIdentity(cdp);
    if (scenario === "noself") await runNoSelfIdentity(cdp);
    if (scenario === "routeswitch") await runRouteSwitch(cdp);
    if (scenario === "routeconfirm") await runRouteConfirm(cdp);
    if (scenario === "routeidentity") await runRouteIdentity(cdp);
    if (scenario === "foreignconfirmation") await runForeignConfirmation(cdp);
    if (scenario === "excludemerge") await runExcludeMerge(cdp);
    if (scenario === "postrunsync") await runPostRunSync(cdp);
    if (scenario === "runlock") await runLock(cdp);
    if (scenario === "locateunknown") await runLocateUnknown(cdp);
    if (scenario === "bgscan") await runBgScan(cdp);
    if (scenario === "pause") await runPause(cdp);
    if (scenario === "progress") await runProgress(cdp);
    if (scenario === "storagefail") await runStorageFail(cdp);
    if (scenario === "progressrace") await runProgressRace(cdp);
    if (scenario === "progressmulti") await runProgressMulti(cdp);
    if (scenario === "recyclemid") await runRecycleMid(cdp);
    if (scenario === "bgpersistent") await runBgPersistent(cdp);
    if (scenario === "progresshold") await runProgressHold(cdp);
    if (scenario === "progressstale") await runProgressStale(cdp);
    if (scenario === "progressdiscard") await runProgressDiscard(cdp);
    if (scenario === "progressbegin") await runProgressBegin(cdp);
    if (scenario === "progressstaletoast") await runProgressStaleToast(cdp);
    if (scenario === "scheduledcleanup") await runScheduledSimulation(cdp, "cleanup");
    if (scenario === "scheduledfollowback") await runScheduledSimulation(cdp, "followback");
    if (scenario === "scheduledunknown") await runScheduledSimulation(cdp, "unknown");
    if (scenario === "schedulednotifyfail") await runScheduledSimulation(cdp, "notifyfail");
    if (scenario === "schedprecheck") await runSchedPrecheck(cdp);
    if (scenario === "schedrecheck") await runSchedRecheck(cdp);
    if (scenario === "schedinterval") await runSchedInterval(cdp);
    if (scenario === "toolbar" || scenario === "toolbardark") await runToolbar(cdp);
    if (scenario === "toolbari18n") await runToolbarI18n(cdp);
    if (scenario === "schedlayout") await runSchedLayout(cdp, false);
    if (scenario === "schedlayoutdark") await runSchedLayout(cdp, true);

    console.log("\n场景通过 ✓");
  } finally {
    try { if (ws) ws.close(); } catch (err) { /* ignore */ }
    proc.kill();
    try { serverProc.kill(); } catch (err) { /* ignore */ }
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  }
}

main().catch((err) => {
  console.error("\n测试失败 ✗");
  console.error(err.message);
  process.exitCode = 1;
});
