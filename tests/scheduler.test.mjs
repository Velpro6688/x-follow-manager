import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness(initial = {}, options = {}) {
  const local = structuredClone(initial), session = structuredClone(options.session || {}), alarms = new Map(), messages = [], listeners = [];
  let alarmListener, removedListener, updatedListener;
  let now = Date.UTC(2026, 0, 1, 0, 0);
  class Clock extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const area = (data) => ({
    async get(key) { if (key == null) return structuredClone(data); return { [key]: structuredClone(data[key]) }; },
    async set(value) { Object.assign(data, structuredClone(value)); },
    async remove(key) { delete data[key]; }
  });
  const ctx = vm.createContext({ console, Date: Clock, Set, Map, Promise, Intl, URL,
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } },
      storage: { local: area(local), session: area(session) },
      alarms: { clear: async name => alarms.delete(name), create: async (name, spec) => alarms.set(name, spec), get: async name => alarms.get(name), onAlarm: { addListener(fn) { alarmListener = fn; } } },
      tabs: { get: async id => ({ id, url: 'https://x.com/alice/following' }), query: async () => [{ id: 7 }], sendMessage: async (id, msg) => { messages.push({ id, msg }); return { ok: true }; }, onRemoved: { addListener(fn) { removedListener = fn; } }, onUpdated: { addListener(fn) { updatedListener = fn; } } },
      notifications: { create: async () => 'notification' }
    } });
  ctx.importScripts = () => vm.runInContext(fs.readFileSync('x-follow-manager/content/core.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('x-follow-manager/background.js', 'utf8'), ctx);
  vm.runInContext('scheduledExecutionReady = ' + (options.ready === false ? 'false' : 'true'), ctx);
  async function send(msg, sender = { tab: { id: 7 } }) {
    return new Promise(resolve => {
      for (const listener of listeners) if (listener(msg, sender, resolve) === true) return;
      resolve(undefined);
    });
  }
  async function fire(name) { alarmListener({ name }); await new Promise(resolve => setTimeout(resolve, 30)); }
  return { local, session, alarms, messages, send, fire, async removeTab(id) { removedListener(id); await new Promise(resolve => setTimeout(resolve, 30)); }, async updateTab(id, change, url) { updatedListener(id, change, { id, url }); await new Promise(resolve => setTimeout(resolve, 30)); }, advance(ms) { now += ms; }, now: () => now };
}

test('计划时间保存并只向绑定的页面发送一次', async () => {
  const h = harness();
  const task = { enabled: true, type: 'once', datetime: h.now() + 60000, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  assert.equal((await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task })).ok, true);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.nextRun, task.datetime);
  h.advance(60000);
  await h.fire('xfm-sched-cleanup');
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].id, 7);
  assert.equal(h.messages[0].msg.account, 'alice');
});

test('浏览器会话丢失绑定时不向其他标签页执行', async () => {
  const h = harness();
  const task = { enabled: true, type: 'once', datetime: h.now() + 60000, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  delete h.session['xfm.schedule.bindings'];
  h.advance(60000);
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.messages.length, 0);
  assert.match(h.local['xfm.scheduled.v1'].cleanup.records[0].reason, /重新绑定/);
});

test('后台重建时恢复已保存闹钟，重启后仍要求重新绑定页面', async () => {
  const due = Date.UTC(2026, 0, 1, 0, 1);
  const h = harness({ 'xfm.scheduled.v1': { cleanup: { enabled: true, type: 'once', datetime: due, nextRun: due, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true }, followback: null } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.alarms.get('xfm-sched-cleanup').when, due);
  h.advance(60000);
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.messages.length, 0);
  assert.match(h.local['xfm.scheduled.v1'].cleanup.records[0].reason, /重新绑定/);
});

test('扩展会话丢失时恢复中断记录，在途操作标记未知并暂停', async () => {
  const task = { enabled: true, type: 'weekly', account: 'alice', records: [] };
  const active = { taskKey: 'cleanup', tabId: 7, startedAt: 1, due: 1, current: 'bob', detail: [] };
  const h = harness({ 'xfm.scheduled.v1': { cleanup: task, followback: null }, 'xfm.scheduled.active.v1': active });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.local['xfm.scheduled.active.v1'], undefined);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.enabled, false);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.records[0].unknown, 1);
});

test('计划时间之前误触发闹钟不运行也不记录错过', async () => {
  const h = harness();
  const task = { enabled: true, type: 'once', datetime: h.now() + 60000, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.messages.length, 0);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.records?.length || 0, 0);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.nextRun, task.datetime);
});

test('超过五分钟窗口的单次任务记录错过且不补跑', async () => {
  const h = harness();
  const task = { enabled: true, type: 'once', datetime: h.now() + 60000, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  h.advance(60000 + 300001);
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.messages.length, 0);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.enabled, false);
  assert.match(h.local['xfm.scheduled.v1'].cleanup.records[0].reason, /错过/);
});

test('两个到期任务不能并发，结果未知会暂停重复任务', async () => {
  const h = harness();
  const base = { enabled: true, type: 'once', datetime: h.now() + 60000, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task: { ...base } });
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'followback', task: { ...base } });
  h.advance(60000);
  await h.fire('xfm-sched-cleanup');
  await h.fire('xfm-sched-followback');
  assert.equal(h.messages.length, 1);
  assert.equal(h.local['xfm.scheduled.v1'].followback.records[0].status, 'skipped');
  const runId = h.messages[0].msg.runId;
  assert.ok(runId);
  assert.equal((await h.send({ type: 'XFM_SCHED_RECORD_RUN', taskKey: 'cleanup', runId, status: 'partial', unknown: 1, pause: true })).ok, true);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.enabled, false);
  assert.equal(h.local['xfm.scheduled.active.v1'], undefined);
});

test('页面关闭时在途账号标记未知，任务暂停且不重试', async () => {
  const h = harness();
  const task = { enabled: true, type: 'weekly', time: '00:01', dayOfWeek: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  h.advance(60000);
  await h.fire('xfm-sched-cleanup');
  const runId = h.messages[0].msg.runId;
  assert.equal((await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId })).ok, true);
  assert.equal((await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 })).ok, true);
  assert.equal((await h.send({ type: 'XFM_SCHED_ACTION_BEGIN', runId, handle: 'bob' })).ok, true);
  await h.removeTab(7);
  assert.equal(h.local['xfm.scheduled.active.v1'], undefined);
  const saved = h.local['xfm.scheduled.v1'].cleanup;
  assert.equal(saved.enabled, false);
  assert.equal(saved.records[0].status, 'interrupted');
  assert.equal(saved.records[0].scanned, 20);
  assert.equal(saved.records[0].candidates, 10);
  assert.equal(saved.records[0].detail[0].status, 'unknown');
  assert.equal(saved.records[0].detail[0].handle, 'bob');
});

test('在途操作长期无响应时标记未知，旧任务不能继续', async () => {
  const h = harness();
  const task = { enabled: true, type: 'once', datetime: h.now() + 60000, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  h.advance(60000);
  await h.fire('xfm-sched-cleanup');
  const runId = h.messages[0].msg.runId;
  assert.equal((await h.send({ type: 'XFM_SCHED_ACTION_BEGIN', runId, handle: 'bob' })).ok, false);
  await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
  await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 });
  await h.send({ type: 'XFM_SCHED_ACTION_BEGIN', runId, handle: 'bob' });
  h.advance(300000);
  await h.fire('xfm-action-watch');
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.records[0].unknown, 1);
  assert.equal((await h.send({ type: 'XFM_SCHED_ACTION_END', runId, handle: 'bob', status: 'success' })).ok, false);
});

test('协调器独立限制操作次数，未知结果后禁止后续操作', async () => {
  const h = harness();
  const task = { enabled: true, type: 'once', datetime: h.now() + 60000, count: 1, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  h.advance(60000); await h.fire('xfm-sched-cleanup');
  const runId = h.messages[0].msg.runId;
  await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
  await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 });
  assert.equal((await h.send({ type: 'XFM_SCHED_ACTION_BEGIN', runId, handle: 'bob' })).ok, true);
  assert.equal((await h.send({ type: 'XFM_SCHED_ACTION_END', runId, handle: 'bob', status: 'unknown' })).ok, true);
  assert.equal((await h.send({ type: 'XFM_SCHED_ACTION_BEGIN', runId, handle: 'carol' })).ok, false);
});

test('数量未耗尽时遇到未知结果仍禁止继续', async () => {
  const h = harness();
  const task = { enabled: true, type: 'once', datetime: h.now() + 60000, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  h.advance(60000); await h.fire('xfm-sched-cleanup');
  const runId = h.messages[0].msg.runId;
  await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
  await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 });
  await h.send({ type: 'XFM_SCHED_ACTION_BEGIN', runId, handle: 'bob' });
  await h.send({ type: 'XFM_SCHED_ACTION_END', runId, handle: 'bob', status: 'unknown' });
  assert.equal((await h.send({ type: 'XFM_SCHED_ACTION_BEGIN', runId, handle: 'carol' })).ok, false);
});

test('另一个标签页正在扫描时定时任务跳过，运行期间不能开始手动扫描', async () => {
  const h = harness();
  const task = { enabled: true, type: 'once', datetime: h.now() + 60000, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  assert.equal((await h.send({ type: 'XFM_COORD_SCAN_START', scanId: 'manual' }, { tab: { id: 8 } })).ok, true);
  h.advance(60000);
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.messages.length, 0);
  assert.match(h.local['xfm.scheduled.v1'].cleanup.records[0].reason, /扫描/);
  await h.send({ type: 'XFM_COORD_SCAN_END', scanId: 'manual' }, { tab: { id: 8 } });
  const next = { ...task, enabled: true, datetime: h.now() + 60000 };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task: next });
  h.advance(60000);
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.messages.length, 1);
  assert.equal((await h.send({ type: 'XFM_COORD_SCAN_START', scanId: 'other' }, { tab: { id: 8 } })).ok, false);
  assert.equal((await h.send({ type: 'XFM_COORD_ACQUIRE', runId: 'manual-action' }, { tab: { id: 8 } })).ok, false);
  assert.equal((await h.send({ type: 'XFM_COORD_SCAN_START', scanId: 'scheduled', runId: h.messages[0].msg.runId })).ok, true);
});

test('跨列表导航仅恢复相同标签和账号，加载其他页面则中断', async () => {
  const h = harness();
  const task = { enabled: true, type: 'once', datetime: h.now() + 60000, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'followback', task });
  h.advance(60000);
  await h.fire('xfm-sched-followback');
  const runId = h.messages[0].msg.runId;
  assert.equal((await h.send({ type: 'XFM_SCHED_PREPARE_NAVIGATION', runId, targetPath: '/alice/followers' })).ok, true);
  await h.updateTab(7, { status: 'loading' }, 'https://x.com/alice/followers');
  await h.updateTab(7, { status: 'complete' }, 'https://x.com/alice/followers');
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[1].msg.runId, runId);
  assert.equal(h.messages[1].msg.resume, true);
  assert.equal(h.messages[1].msg.batchLimit, h.messages[0].msg.batchLimit);
  assert.equal(h.messages[1].msg.strictMode, h.messages[0].msg.strictMode);
  assert.deepEqual(Array.from(h.messages[1].msg.excluded), Array.from(h.messages[0].msg.excluded));
  await h.updateTab(7, { status: 'loading' }, 'https://x.com/other/following');
  assert.equal(h.local['xfm.scheduled.active.v1'], undefined);
  assert.equal(h.local['xfm.scheduled.v1'].followback.records[0].status, 'interrupted');
});

test('每月按指定时区和月末计算，夏令时缺失时间跳过当次', () => {
  const h = harness();
  // 独立加载核心模块，以固定 UTC 时间检查不同时区。
  const c = vm.createContext({ Date, Intl, Set, Map });
  vm.runInContext(fs.readFileSync('x-follow-manager/content/core.js', 'utf8'), c);
  const monthly = { type: 'monthly', time: '10:00', dayOfMonth: 31, timezone: 'Asia/Shanghai' };
  assert.equal(c.XFMCore.computeNextRun(monthly, Date.parse('2026-02-01T00:00:00Z')), Date.parse('2026-02-28T02:00:00Z'));
  const weekly = { type: 'weekly', time: '02:30', dayOfWeek: 0, timezone: 'America/New_York' };
  assert.equal(c.XFMCore.computeNextRun(weekly, Date.parse('2026-03-07T00:00:00Z')), Date.parse('2026-03-15T06:30:00Z'));
});

test('夏令时回拨后同一周的重复时间不会再次安排', () => {
  const c = vm.createContext({ Date, Intl, Set, Map });
  vm.runInContext(fs.readFileSync('x-follow-manager/content/core.js', 'utf8'), c);
  const task = { type: 'weekly', time: '01:30', dayOfWeek: 0, timezone: 'America/New_York' };
  const first = c.XFMCore.computeNextRun(task, Date.parse('2026-10-31T00:00:00Z'));
  assert.equal(first, Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(c.XFMCore.computeNextRun(task, first), Date.parse('2026-11-08T06:30:00Z'));
});

test('每天/每周：夏令时缺失时刻的下一次执行不携带归一化漂移', () => {
  // 本地回退路径（任务无 timezone 时）按宿主时区计算。宿主为 Asia/Shanghai：
  // 中国 1986-05-04 起实行夏令时（02:00→03:00），该日 02:30 本地不存在，
  // 可确定性触发归一化分支。前提不成立的环境直接跳过断言。
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Asia/Shanghai') return;
  if (new Date(1986, 4, 4, 2, 30).getHours() !== 3) return; // 空洞未复现则不依赖该前提
  const c = vm.createContext({ Date, Intl, Set, Map });
  vm.runInContext(fs.readFileSync('x-follow-manager/content/core.js', 'utf8'), c);
  const from = new Date(1986, 4, 4, 0, 30).getTime(); // 空洞日（周日）02:30 之前
  const daily = new Date(c.XFMCore.computeNextRun({ type: 'daily', time: '02:30' }, from));
  assert.equal(daily.getHours(), 2);
  assert.equal(daily.getDate(), 5);   // 次日同一墙钟时刻，而非被归一化的 03:30
  const weekly = new Date(c.XFMCore.computeNextRun({ type: 'weekly', time: '02:30', dayOfWeek: 0 }, from));
  assert.equal(weekly.getHours(), 2);
  assert.equal(weekly.getDate(), 11); // 下一个周日
});

test('普通连续失败按周期累计，三个失败周期后暂停并清除闹钟', async () => {
  const h = harness();
  const task = { enabled: true, type: 'weekly', time: '00:01', dayOfWeek: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  for (let cycle = 0; cycle < 3; cycle++) {
    const stored = h.local['xfm.scheduled.v1'].cleanup;
    h.advance(stored.nextRun - h.now());
    await h.fire('xfm-sched-cleanup');
    const runId = h.messages[h.messages.length - 1].msg.runId;
    await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
    await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 });
    const result = await h.send({ type: 'XFM_SCHED_RECORD_RUN', taskKey: 'cleanup', runId, status: 'partial', failureCycle: true, success: 1, failed: 2 });
    assert.equal(result.ok, true);
  }
  const saved = h.local['xfm.scheduled.v1'].cleanup;
  assert.equal(saved.enabled, false);
  assert.equal(saved.failureCount, 3);
  assert.equal(h.alarms.has('xfm-sched-cleanup'), false);
  assert.equal(saved.records.length, 3);
});

test('用户手动停止不计失败周期，成功周期清零计数', async () => {
  const h = harness();
  const task = { enabled: true, type: 'weekly', time: '00:01', dayOfWeek: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  // 先制造 2 个失败周期
  for (let cycle = 0; cycle < 2; cycle++) {
    const stored = h.local['xfm.scheduled.v1'].cleanup;
    h.advance(stored.nextRun - h.now());
    await h.fire('xfm-sched-cleanup');
    const runId = h.messages[h.messages.length - 1].msg.runId;
    await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
    await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 });
    await h.send({ type: 'XFM_SCHED_RECORD_RUN', taskKey: 'cleanup', runId, status: 'partial', failureCycle: true, failed: 3 });
  }
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.failureCount, 2);
  // 手动停止（skipped，不带 failureCycle）不累计
  let stored = h.local['xfm.scheduled.v1'].cleanup;
  h.advance(stored.nextRun - h.now());
  await h.fire('xfm-sched-cleanup');
  let runId = h.messages[h.messages.length - 1].msg.runId;
  await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
  await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 });
  await h.send({ type: 'XFM_SCHED_RECORD_RUN', taskKey: 'cleanup', runId, status: 'skipped', reason: '用户停止扫描' });
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.failureCount, 2);
  // 成功周期清零
  stored = h.local['xfm.scheduled.v1'].cleanup;
  h.advance(stored.nextRun - h.now());
  await h.fire('xfm-sched-cleanup');
  runId = h.messages[h.messages.length - 1].msg.runId;
  await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
  await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 });
  await h.send({ type: 'XFM_SCHED_RECORD_RUN', taskKey: 'cleanup', runId, status: 'success', success: 3 });
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.failureCount, 0);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.enabled, true);
});

test('周期使用启动时的设置快照，运行中修改设置只影响后续周期', async () => {
  const h = harness({ 'xfm.settings.v1': { batchLimit: 5, strictMode: true, excluded: ['keep1', 'keep1', 'keep2'] } });
  const task = { enabled: true, type: 'weekly', time: '00:01', dayOfWeek: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  const stored = h.local['xfm.scheduled.v1'].cleanup;
  h.advance(stored.nextRun - h.now());
  await h.fire('xfm-sched-cleanup');
  const first = h.messages[h.messages.length - 1].msg;
  assert.equal(first.batchLimit, 5);
  assert.equal(first.strictMode, true);
  assert.deepEqual(Array.from(first.excluded).sort(), ['keep1', 'keep2']);
  assert.equal(h.local['xfm.scheduled.active.v1'].snapshot.batchLimit, 5);
  assert.deepEqual(Array.from(h.local['xfm.scheduled.active.v1'].snapshot.excluded).sort(), ['keep1', 'keep2']);
  // 运行中修改设置：当前 active 快照不变
  h.local['xfm.settings.v1'].batchLimit = 2;
  h.local['xfm.settings.v1'].strictMode = false;
  h.local['xfm.settings.v1'].excluded = ['another'];
  assert.equal(h.local['xfm.scheduled.active.v1'].snapshot.batchLimit, 5);
  assert.equal(h.local['xfm.scheduled.active.v1'].snapshot.strictMode, true);
  assert.deepEqual(Array.from(h.local['xfm.scheduled.active.v1'].snapshot.excluded).sort(), ['keep1', 'keep2']);
  const runId = first.runId;
  await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
  await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 });
  await h.send({ type: 'XFM_SCHED_RECORD_RUN', taskKey: 'cleanup', runId, status: 'success', success: 3 });
  // 下一周期才使用新设置
  const next = h.local['xfm.scheduled.v1'].cleanup;
  h.advance(next.nextRun - h.now());
  await h.fire('xfm-sched-cleanup');
  const second = h.messages[h.messages.length - 1].msg;
  assert.equal(second.batchLimit, 2);
  assert.equal(second.strictMode, false);
  assert.deepEqual(Array.from(second.excluded), ['another']);
});

test('扫描失败不累计普通失败周期，仅显式 failureCycle 才停用', async () => {
  const h = harness();
  const task = { enabled: true, type: 'weekly', time: '00:01', dayOfWeek: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  const stored = h.local['xfm.scheduled.v1'].cleanup;
  h.advance(stored.nextRun - h.now());
  await h.fire('xfm-sched-cleanup');
  const runId = h.messages[h.messages.length - 1].msg.runId;
  await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
  await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 });
  const result = await h.send({ type: 'XFM_SCHED_RECORD_RUN', taskKey: 'cleanup', runId, status: 'failed', reason: '扫描中止' });
  assert.equal(result.ok, true);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.failureCount || 0, 0);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.enabled, true);
});

test('awaiting 阶段超时会中断并清理活动状态，但不停用任务', async () => {
  const h = harness();
  const task = { enabled: true, type: 'weekly', time: '00:01', dayOfWeek: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  const stored = h.local['xfm.scheduled.v1'].cleanup;
  h.advance(stored.nextRun - h.now());
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.local['xfm.scheduled.active.v1'].phase, 'awaiting');
  assert.ok(h.local['xfm.scheduled.active.v1'].phaseDeadline > h.now());
  h.advance(6 * 60 * 1000 + 1000);
  await h.fire('xfm-phase-watch');
  assert.equal(h.local['xfm.scheduled.active.v1'], undefined);
  const saved = h.local['xfm.scheduled.v1'].cleanup;
  assert.equal(saved.enabled, true);
  assert.equal(saved.records[0].status, 'interrupted');
  assert.match(saved.records[0].reason, /阶段超时/);
  assert.equal(h.alarms.has('xfm-phase-watch'), false);
});

test('开关关闭时恢复入口不重建闹钟，并中断遗留 active', async () => {
  const task = { enabled: true, type: 'weekly', time: '00:01', dayOfWeek: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true, nextRun: Date.UTC(2026, 0, 1, 0, 1) };
  const active = { runId: 'old-run', taskKey: 'cleanup', due: Date.now(), tabId: 7, startedAt: Date.now(), phase: 'awaiting', snapshot: { taskKey: 'cleanup', account: 'alice', count: 3, order: 'desc', batchLimit: 50 } };
  const h = harness({
    'xfm.scheduled.v1': { cleanup: task, followback: null },
    'xfm.scheduled.active.v1': active
  }, {
    ready: false,
    session: { 'xfm.schedule.bindings': { cleanup: { tabId: 7, account: 'alice' } } }
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.local['xfm.scheduled.active.v1'], undefined);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.enabled, true);
  assert.equal(h.alarms.has('xfm-sched-cleanup'), false);
  assert.equal(h.alarms.has('xfm-phase-watch'), false);
  assert.ok(h.local['xfm.scheduled.v1'].cleanup.records.some(r => r.status === 'interrupted'));
});

test('scanning 阶段超过 30 分钟会被后台中断，且后续 SCAN_DONE 被拒绝', async () => {
  const h = harness();
  const task = { enabled: true, type: 'weekly', time: '00:01', dayOfWeek: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  const stored = h.local['xfm.scheduled.v1'].cleanup;
  h.advance(stored.nextRun - h.now());
  await h.fire('xfm-sched-cleanup');
  const runId = h.messages[h.messages.length - 1].msg.runId;
  await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
  assert.equal(h.local['xfm.scheduled.active.v1'].phase, 'scanning');
  h.advance(30 * 60 * 1000 + 1000);
  await h.fire('xfm-phase-watch');
  assert.equal(h.local['xfm.scheduled.active.v1'], undefined);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.records[0].status, 'interrupted');
  const late = await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 20, candidates: 10 });
  assert.equal(late.ok, false);
});

test('持续增长的扫描可超过 30 分钟，停止增长后仍超时', async () => {
  const h = harness();
  const task = { enabled: true, type: 'weekly', time: '00:01', dayOfWeek: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  h.advance(h.local['xfm.scheduled.v1'].cleanup.nextRun - h.now());
  await h.fire('xfm-sched-cleanup');
  const runId = h.messages.at(-1).msg.runId;
  await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
  for (let count = 1; count <= 4; count++) {
    h.advance(10 * 60 * 1000);
    assert.equal((await h.send({ type: 'XFM_SCHED_SCAN_PROGRESS', runId, scanned: count })).ok, true);
    await h.fire('xfm-phase-watch');
    assert.ok(h.local['xfm.scheduled.active.v1']);
  }
  assert.equal((await h.send({ type: 'XFM_SCHED_SCAN_PROGRESS', runId, scanned: 4 })).ok, false);
  h.advance(30 * 60 * 1000 + 1);
  await h.fire('xfm-phase-watch');
  assert.equal(h.local['xfm.scheduled.active.v1'], undefined);
});

/* ------------------------------------------------------------------ */
/* 每天按间隔                                                          */
/* ------------------------------------------------------------------ */

function coreContext() {
  const c = vm.createContext({ Date, Intl, Set, Map, console });
  vm.runInContext(fs.readFileSync('x-follow-manager/content/core.js', 'utf8'), c);
  return c;
}

test('每天间隔：同一天多个执行点，含结束时间', () => {
  const c = coreContext();
  const task = { type: 'interval', dailyStart: '09:00', dailyEnd: '21:00', intervalHours: 4, timezone: 'UTC' };
  assert.deepEqual(Array.from(c.XFMCore.intervalSlots(task)), [540, 780, 1020, 1260]);
  const cases = [
    ['2026-11-09T00:00:00Z', '2026-11-09T09:00:00Z'],
    ['2026-11-09T08:59:00Z', '2026-11-09T09:00:00Z'],
    ['2026-11-09T09:00:00Z', '2026-11-09T13:00:00Z'],
    ['2026-11-09T13:30:00Z', '2026-11-09T17:00:00Z'],
    ['2026-11-09T20:59:00Z', '2026-11-09T21:00:00Z'],
    ['2026-11-09T21:00:00Z', '2026-11-10T09:00:00Z'],
    ['2026-11-09T23:59:00Z', '2026-11-10T09:00:00Z']
  ];
  for (const [from, expected] of cases) {
    assert.equal(c.XFMCore.computeNextRun(task, Date.parse(from)), Date.parse(expected), from);
  }
});

test('每天间隔：间隔大于窗口只保留开始点，开始等于结束或跨午夜被拒绝', () => {
  const c = coreContext();
  const wide = { type: 'interval', dailyStart: '09:00', dailyEnd: '10:00', intervalHours: 12, timezone: 'UTC' };
  assert.deepEqual(Array.from(c.XFMCore.intervalSlots(wide)), [540]);
  assert.equal(c.XFMCore.computeNextRun(wide, Date.parse('2026-11-09T09:30:00Z')), Date.parse('2026-11-10T09:00:00Z'));
  const same = { type: 'interval', dailyStart: '09:00', dailyEnd: '09:00', intervalHours: 1, count: 3, order: 'desc' };
  assert.equal(c.XFMCore.intervalSlots(same), null);
  assert.match(c.XFMCore.validateSchedule(same, Date.now()), /结束时间需晚于开始时间/);
  const overnight = { type: 'interval', dailyStart: '22:00', dailyEnd: '02:00', intervalHours: 2, count: 3, order: 'desc' };
  assert.equal(c.XFMCore.intervalSlots(overnight), null);
  assert.match(c.XFMCore.validateSchedule(overnight, Date.now()), /跨午夜/);
});

test('每天间隔：0、负数、小数、空值和超范围都不接受', () => {
  const c = coreContext();
  const base = { type: 'interval', dailyStart: '09:00', dailyEnd: '21:00', count: 3, order: 'desc' };
  for (const value of [0, -1, 1.5, '', null, 13, 100]) {
    assert.match(c.XFMCore.validateSchedule({ ...base, intervalHours: value }, Date.now()), /1–12 的整数小时/, String(value));
    assert.equal(c.XFMCore.intervalSlots({ ...base, intervalHours: value }), null, String(value));
  }
  for (const value of [1, 12]) assert.equal(c.XFMCore.validateSchedule({ ...base, intervalHours: value }, Date.now()), '');
});

test('每天间隔：保存时区生效，夏令时缺失时间跳过当次', () => {
  const c = coreContext();
  const spring = { type: 'interval', dailyStart: '01:00', dailyEnd: '04:00', intervalHours: 1, timezone: 'America/New_York' };
  const first = c.XFMCore.computeNextRun(spring, Date.parse('2026-03-08T00:00:00-05:00'));
  assert.equal(first, Date.parse('2026-03-08T06:00:00Z'));
  const second = c.XFMCore.computeNextRun(spring, first);
  assert.equal(second, Date.parse('2026-03-08T07:00:00Z'), '02:00 不存在，应直接到 03:00');
  const third = c.XFMCore.computeNextRun(spring, second);
  assert.equal(third, Date.parse('2026-03-08T08:00:00Z'));
  const nextDay = c.XFMCore.computeNextRun(spring, third);
  assert.equal(nextDay, Date.parse('2026-03-09T05:00:00Z'));
});

test('每天间隔：夏令时回拨的重复时间不会执行两次', () => {
  const c = coreContext();
  const task = { type: 'interval', dailyStart: '01:00', dailyEnd: '01:30', intervalHours: 1, timezone: 'America/New_York' };
  const first = c.XFMCore.computeNextRun(task, Date.parse('2026-11-01T00:00:00-04:00'));
  assert.equal(first, Date.parse('2026-11-01T05:00:00Z'));
  const second = c.XFMCore.computeNextRun(task, first);
  assert.equal(second, Date.parse('2026-11-02T06:00:00Z'), '06:30Z 是同一墙钟时间的第二次出现，不得再排');
});

test('每天间隔：用本地时区也能正确换算（不依赖保存时区）', () => {
  const c = coreContext();
  const task = { type: 'interval', dailyStart: '09:00', dailyEnd: '21:00', intervalHours: 4 };
  const from = new Date(2026, 10, 9, 12).getTime();
  const expected = new Date(2026, 10, 9, 13).getTime();
  assert.equal(c.XFMCore.computeNextRun(task, from), expected);
});

test('每天间隔保存后写入下一个执行点，重复闹钟只发送一次并推进', async () => {
  const h = harness();
  const task = { enabled: true, type: 'interval', dailyStart: '09:00', dailyEnd: '21:00', intervalHours: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  const saved = await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  assert.equal(saved.ok, true);
  assert.ok(saved.task);
  const stored = h.local['xfm.scheduled.v1'].cleanup;
  assert.equal(stored.nextRun, Date.UTC(2026, 0, 1, 9, 0));
  assert.equal(h.alarms.get('xfm-sched-cleanup').when, Date.UTC(2026, 0, 1, 9, 0));

  h.advance(9 * 60 * 60 * 1000);
  await h.fire('xfm-sched-cleanup');
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.messages.length, 1);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.nextRun, Date.UTC(2026, 0, 1, 13, 0));
});

test('每天间隔：错过多个执行点不追补，直接安排下一个未来点', async () => {
  const h = harness();
  const task = { enabled: true, type: 'interval', dailyStart: '09:00', dailyEnd: '21:00', intervalHours: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  h.advance(9 * 60 * 60 * 1000 + 10 * 60 * 1000);
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.messages.length, 0);
  const saved = h.local['xfm.scheduled.v1'].cleanup;
  assert.equal(saved.records[0].status, 'skipped');
  assert.match(saved.records[0].reason, /错过/);
  assert.equal(saved.nextRun, Date.UTC(2026, 0, 1, 13, 0));
  assert.equal(saved.enabled, true);
});

test('每天间隔：跨午夜设置在后台保存时被拒绝，不写坏已有任务', async () => {
  const h = harness();
  const good = { enabled: true, type: 'interval', dailyStart: '09:00', dailyEnd: '21:00', intervalHours: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task: good });
  const before = structuredClone(h.local['xfm.scheduled.v1'].cleanup);
  const bad = { ...good, dailyStart: '22:00', dailyEnd: '02:00' };
  const result = await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task: bad });
  assert.equal(result.ok, false);
  assert.match(result.reason, /跨午夜/);
  assert.deepEqual(h.local['xfm.scheduled.v1'].cleanup, before);
});

test('两个任务的间隔计划互不覆盖，各自保存各自的执行点', async () => {
  const h = harness();
  const cleanup = { enabled: true, type: 'interval', dailyStart: '09:00', dailyEnd: '21:00', intervalHours: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  const followback = { enabled: true, type: 'interval', dailyStart: '10:00', dailyEnd: '12:00', intervalHours: 1, count: 2, order: 'asc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task: cleanup });
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'followback', task: followback });
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.nextRun, Date.UTC(2026, 0, 1, 9, 0));
  assert.equal(h.local['xfm.scheduled.v1'].followback.nextRun, Date.UTC(2026, 0, 1, 10, 0));
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.count, 3);
  assert.equal(h.local['xfm.scheduled.v1'].followback.count, 2);
  assert.equal(h.local['xfm.scheduled.v1'].followback.order, 'asc');
});

test('新鲜执行锁阻止定时任务，过期锁不阻止', async () => {
  const task = { enabled: true, type: 'once', datetime: Date.UTC(2026, 0, 1, 0, 1), count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  const fresh = harness({ 'xfm.run.lock.v1': { runId: 'other', path: '/bob/following', heartbeat: Date.UTC(2026, 0, 1, 0, 0) } });
  await fresh.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task: { ...task } });
  fresh.advance(60000);
  fresh.local['xfm.run.lock.v1'].heartbeat = fresh.now();
  await fresh.fire('xfm-sched-cleanup');
  assert.equal(fresh.messages.length, 0);
  assert.match(fresh.local['xfm.scheduled.v1'].cleanup.records[0].reason, /已有任务运行/);

  const stale = harness({ 'xfm.run.lock.v1': { runId: 'dead', path: '/bob/following', heartbeat: Date.UTC(2026, 0, 1, 0, 0) - 10000 } });
  await stale.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task: { ...task } });
  stale.advance(60000);
  await stale.fire('xfm-sched-cleanup');
  assert.equal(stale.messages.length, 1);
});

test('中断后旧 runId 的进度与完成消息不能复活任务', async () => {
  const h = harness();
  const task = { enabled: true, type: 'weekly', time: '00:01', dayOfWeek: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  h.advance(h.local['xfm.scheduled.v1'].cleanup.nextRun - h.now());
  await h.fire('xfm-sched-cleanup');
  const runId = h.messages[0].msg.runId;
  await h.send({ type: 'XFM_SCHED_MARK_SCANNING', runId });
  await h.removeTab(7);
  assert.equal(h.local['xfm.scheduled.active.v1'], undefined);
  const before = structuredClone(h.local['xfm.scheduled.v1'].cleanup.records[0]);
  assert.equal((await h.send({ type: 'XFM_SCHED_SCAN_PROGRESS', runId, scanned: 30 })).ok, false);
  assert.equal((await h.send({ type: 'XFM_SCHED_SCAN_DONE', runId, scanned: 40, candidates: 20 })).ok, false);
  assert.equal((await h.send({ type: 'XFM_SCHED_ACTION_BEGIN', runId, handle: 'bob' })).ok, false);
  assert.equal(h.local['xfm.scheduled.active.v1'], undefined);
  assert.deepEqual(h.local['xfm.scheduled.v1'].cleanup.records[0], before);
});

test('定时开关关闭时保存启用、立即执行、闹钟入口都拒绝', async () => {
  const h = harness({}, { ready: false });
  const task = { enabled: true, type: 'interval', dailyStart: '09:00', dailyEnd: '21:00', intervalHours: 4, count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  const save = await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task });
  assert.equal(save.ok, false);
  assert.match(save.reason, /暂不可启用/);
  const claim = await h.send({ type: 'XFM_SCHED_CLAIM_NOW', taskKey: 'cleanup', account: 'alice', options: { count: 3, order: 'desc' } });
  assert.equal(claim.ok, false);
  assert.match(claim.reason, /暂不可执行/);
  assert.equal(h.messages.length, 0);
});

test('单次：过去时间拒绝启用，未启用时允许保留设置', () => {
  const c = coreContext();
  const from = Date.parse('2026-11-09T12:00:00+08:00');
  const past = { type: 'once', datetime: from - 1000, count: 3, order: 'desc' };
  assert.match(c.XFMCore.validateSchedule(past, from), /未来的执行时间/);
  assert.equal(c.XFMCore.validateSchedule(past, from, { requireFuture: false }), '');
  const future = { ...past, datetime: from + 60000 };
  assert.equal(c.XFMCore.validateSchedule(future, from), '');
  assert.equal(c.XFMCore.computeNextRun(past, from), null);
});

test('每天固定时间：按日推进，跨天与整点边界正确', () => {
  const c = coreContext();
  const tz = { type: 'daily', time: '09:30', timezone: 'UTC' };
  assert.equal(c.XFMCore.computeNextRun(tz, Date.parse('2026-11-09T08:00:00Z')), Date.parse('2026-11-09T09:30:00Z'));
  assert.equal(c.XFMCore.computeNextRun(tz, Date.parse('2026-11-09T09:30:00Z')), Date.parse('2026-11-10T09:30:00Z'));
  assert.equal(c.XFMCore.computeNextRun(tz, Date.parse('2026-11-09T23:59:00Z')), Date.parse('2026-11-10T09:30:00Z'));
  const local = { type: 'daily', time: '09:30' };
  const localRun = new Date(2026, 10, 9, 9, 30).getTime();
  const nextLocalRun = new Date(2026, 10, 10, 9, 30).getTime();
  assert.equal(c.XFMCore.computeNextRun(local, localRun), nextLocalRun);
  assert.equal(c.XFMCore.validateSchedule({ type: 'daily', time: '09:30', count: 3, order: 'desc' }, Date.now()), '');
  assert.match(c.XFMCore.validateSchedule({ type: 'daily', time: '25:00', count: 3, order: 'desc' }, Date.now()), /时间/);
});

test('每天固定时间保存后写入下一次，两个任务互不覆盖', async () => {
  const h = harness();
  const daily = { enabled: true, type: 'daily', time: '09:30', count: 3, order: 'desc', account: 'alice', timezone: 'UTC', authorized: true };
  const weekly = { enabled: true, type: 'weekly', time: '10:00', dayOfWeek: 4, count: 2, order: 'asc', account: 'alice', timezone: 'UTC', authorized: true };
  assert.equal((await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'cleanup', task: { ...daily } })).ok, true);
  assert.equal((await h.send({ type: 'XFM_SCHED_SAVE_TASK', taskKey: 'followback', task: { ...weekly } })).ok, true);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.nextRun, Date.UTC(2026, 0, 1, 9, 30));
  assert.equal(h.local['xfm.scheduled.v1'].followback.nextRun, Date.UTC(2026, 0, 1, 10, 0));
  h.advance(9 * 60 * 60 * 1000 + 30 * 60 * 1000);
  await h.fire('xfm-sched-cleanup');
  assert.equal(h.messages.length, 1);
  assert.equal(h.local['xfm.scheduled.v1'].cleanup.nextRun, Date.UTC(2026, 0, 2, 9, 30));
});
