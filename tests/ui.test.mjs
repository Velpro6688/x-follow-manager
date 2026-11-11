import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

test('弹窗自动语言跟随浏览器，保存失败时恢复原来的设置', async (t) => {
  const extension = 'x-follow-manager/';
  const { window: w } = new JSDOM(fs.readFileSync(extension + 'popup.html', 'utf8'), { runScripts: 'outside-only' });
  t.after(() => w.close());
  const settings = { language: 'auto', batchLimit: 50 };
  let rejectSave = false;
  w.chrome = {
    i18n: { getUILanguage: () => 'en-US' },
    storage: { local: { get: (key, callback) => callback({ [key]: settings }) } },
    tabs: { query: async () => [] },
    runtime: { sendMessage: async ({ patch }) => {
      if (rejectSave) return { ok: false };
      Object.assign(settings, patch);
      return { ok: true };
    } }
  };
  w.eval(fs.readFileSync(extension + 'shared/i18n.js', 'utf8'));
  w.eval(fs.readFileSync(extension + 'popup.js', 'utf8'));
  await new Promise(setImmediate);
  const language = w.document.getElementById('langInput');
  const limit = w.document.getElementById('limitInput');
  assert.equal(w.document.documentElement.lang, 'en');
  for (const [value, expected] of [['zh', 'zh-CN'], ['auto', 'en']]) {
    language.value = value;
    language.dispatchEvent(new w.Event('change'));
    await new Promise(setImmediate);
    assert.equal(settings.language, value);
    assert.equal(w.document.documentElement.lang, expected);
  }
  rejectSave = true;
  limit.value = '80';
  limit.dispatchEvent(new w.Event('change'));
  await new Promise(setImmediate);
  assert.equal(limit.value, '50');
  assert.equal(w.document.getElementById('settingsError').hidden, false);
});

test('账号复选框支持空格和 Enter，禁用时不修改选择', () => {
  const dom = new JSDOM('<body><div><div id="cell"></div></div></body>', {
    url: 'https://x.com/alice/following', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', event => { errors.push(event.message); event.preventDefault(); });
  w.eval(fs.readFileSync('x-follow-manager/content/ui.js', 'utf8'));
  let changes = 0;
  const options = { handle: 'alice', checked: false, disabled: false, onToggle() { changes++; } };
  const box = w.XFMUI.ensureCheckbox(w.document.getElementById('cell'), options);
  for (const key of [' ', 'Enter']) box.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  assert.equal(changes, 2);
  w.XFMUI.ensureCheckbox(w.document.getElementById('cell'), { ...options, disabled: true });
  box.dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  assert.equal(changes, 2);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('定时设置可切换周期并保存，超过单批上限被拒绝', async () => {
  const dom = new JSDOM('<body></body>', { url: 'https://x.com/alice/following', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.eval(fs.readFileSync('x-follow-manager/content/ui.js', 'utf8'));
  const host = w.XFMUI.mountPanel(null, {});
  let saved;
  w.XFMUI.showScheduledDialog({ tasks: {}, account: 'alice', batchLimit: 10, onSave: async (key, task) => { saved = { key, task }; return { ok: true }; } });
  const root = host.shadowRoot;
  const type = root.querySelector('[data-sbody="cleanup"] [data-sched="type"]');
  type.value = 'monthly';
  type.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(root.querySelector('[data-sbody="cleanup"] [data-sched-row="monthly"]').hidden, false);
  const count = root.querySelector('[data-sbody="cleanup"] [data-sched="count"]');
  assert.equal(count.value, '10');
  count.value = '11';
  root.querySelector('[data-sbody="cleanup"] [data-sched-save]').click();
  assert.equal(saved, undefined);
  count.value = '5';
  root.querySelector('[data-sbody="cleanup"] [data-sched-save]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved.key, 'cleanup');
  assert.equal(saved.task.count, 5);
  assert.equal(saved.task.account, 'alice');
  dom.window.close();
});

function scheduledHarness(tasks = {}) {
  const dom = new JSDOM('<body></body>', { url: 'https://x.com/alice/following', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.eval(fs.readFileSync('x-follow-manager/shared/i18n.js', 'utf8'));
  w.XFMI18N.setLanguage('zh');
  w.eval(fs.readFileSync('x-follow-manager/content/core.js', 'utf8'));
  w.eval(fs.readFileSync('x-follow-manager/content/ui.js', 'utf8'));
  const host = w.XFMUI.mountPanel(null, {});
  const saved = [];
  w.XFMUI.showScheduledDialog({
    tasks,
    account: 'alice',
    batchLimit: 10,
    onSave: async (key, task) => { saved.push({ key, task }); return { ok: true, task: { ...task, nextRun: task.datetime || Date.now() + 3600000 } }; },
    onExecute: () => {},
    onStop: () => false,
    onClearRecords: async () => ({ ok: true })
  });
  return { dom, w, root: host.shadowRoot, saved };
}

test('单次定时只显示一个日期时间输入，时间行真正隐藏', () => {
  const { dom, w, root } = scheduledHarness();
  const body = root.querySelector('[data-sbody="cleanup"]');
  const type = body.querySelector('[data-sched="type"]');
  type.value = 'once';
  type.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(body.querySelector('[data-sched-row="once"]').hidden, false);
  assert.equal(body.querySelector('[data-sched-row="time"]').hidden, true);
  const visibleTimeInputs = Array.from(body.querySelectorAll('input[type="datetime-local"], input[type="time"]'))
    .filter(el => !el.closest('[data-sched-row]').hidden);
  assert.equal(visibleTimeInputs.length, 1);
  dom.window.close();
});

test('每周/每月显示星期或日期加时间，每天间隔显示开始结束与间隔', () => {
  const { dom, w, root } = scheduledHarness();
  const body = root.querySelector('[data-sbody="cleanup"]');
  const type = body.querySelector('[data-sched="type"]');
  function switchTo(value) {
    type.value = value;
    type.dispatchEvent(new w.Event('change', { bubbles: true }));
  }
  switchTo('weekly');
  assert.equal(body.querySelector('[data-sched-row="weekly"]').hidden, false);
  assert.equal(body.querySelector('[data-sched-row="time"]').hidden, false);
  assert.equal(body.querySelector('[data-sched-row="interval"]').hidden, true);
  switchTo('monthly');
  assert.equal(body.querySelector('[data-sched-row="monthly"]').hidden, false);
  assert.equal(body.querySelector('[data-sched-row="time"]').hidden, false);
  switchTo('interval');
  assert.equal(body.querySelector('[data-sched-row="time"]').hidden, true);
  assert.equal(body.querySelectorAll('[data-sched-row="interval"]:not([hidden])').length, 4);
  assert.equal(body.querySelector('[data-sched="intervalHours"]').getAttribute('min'), '1');
  assert.equal(body.querySelector('[data-sched="intervalHours"]').getAttribute('max'), '12');
  dom.window.close();
});

test('切换到回关标签再切回，未保存的填写不会丢失', () => {
  const { dom, w, root } = scheduledHarness();
  const cleanup = root.querySelector('[data-sbody="cleanup"]');
  cleanup.querySelector('[data-sched="count"]').value = '7';
  cleanup.querySelector('[data-sched="type"]').value = 'interval';
  cleanup.querySelector('[data-sched="type"]').dispatchEvent(new w.Event('change', { bubbles: true }));
  cleanup.querySelector('[data-sched="dailyStart"]').value = '08:30';
  cleanup.querySelector('[data-sched="dailyEnd"]').value = '18:30';
  cleanup.querySelector('[data-sched="intervalHours"]').value = '2';

  root.querySelector('[data-stab="followback"]').click();
  root.querySelector('[data-stab="cleanup"]').click();

  const again = root.querySelector('[data-sbody="cleanup"]');
  assert.equal(again.querySelector('[data-sched="type"]').value, 'interval');
  assert.equal(again.querySelector('[data-sched="count"]').value, '7');
  assert.equal(again.querySelector('[data-sched="dailyStart"]').value, '08:30');
  assert.equal(again.querySelector('[data-sched="dailyEnd"]').value, '18:30');
  assert.equal(again.querySelector('[data-sched="intervalHours"]').value, '2');
  assert.equal(again.querySelector('[data-sched-row="interval"]').hidden, false);
  dom.window.close();
});

test('保存每天间隔会提交规范字段，并用后台返回的下次执行时间刷新界面', async () => {
  const { dom, w, root, saved } = scheduledHarness();
  const body = root.querySelector('[data-sbody="cleanup"]');
  body.querySelector('[data-sched="type"]').value = 'interval';
  body.querySelector('[data-sched="type"]').dispatchEvent(new w.Event('change', { bubbles: true }));
  body.querySelector('[data-sched="dailyStart"]').value = '09:00';
  body.querySelector('[data-sched="dailyEnd"]').value = '21:00';
  body.querySelector('[data-sched="intervalHours"]').value = '4';
  body.querySelector('[data-sched="count"]').value = '5';
  body.querySelector('[data-sched="enabled"]').checked = true;
  body.querySelector('[data-sched="ack"]').checked = true;
  body.querySelector('[data-sched-save="cleanup"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].task.type, 'interval');
  assert.equal(saved[0].task.dailyStart, '09:00');
  assert.equal(saved[0].task.dailyEnd, '21:00');
  assert.equal(saved[0].task.intervalHours, 4);
  assert.equal(saved[0].task.count, 5);
  assert.equal(saved[0].task.account, 'alice');
  const next = root.querySelector('[data-sbody="cleanup"] .sched-next');
  assert.ok(next && /下次开始扫描/.test(next.textContent));
  dom.window.close();
});

test('结束时间早于开始时间时拒绝保存并给出明确提示', async () => {
  const { dom, w, root, saved } = scheduledHarness();
  const body = root.querySelector('[data-sbody="cleanup"]');
  body.querySelector('[data-sched="type"]').value = 'interval';
  body.querySelector('[data-sched="type"]').dispatchEvent(new w.Event('change', { bubbles: true }));
  body.querySelector('[data-sched="dailyStart"]').value = '22:00';
  body.querySelector('[data-sched="dailyEnd"]').value = '02:00';
  body.querySelector('[data-sched="intervalHours"]').value = '2';
  body.querySelector('[data-sched="count"]').value = '3';
  body.querySelector('[data-sched="ack"]').checked = true;
  body.querySelector('[data-sched-save="cleanup"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(saved.length, 0);
  const toast = root.querySelector('.toast');
  assert.ok(toast && /跨午夜/.test(toast.textContent));
  dom.window.close();
});

test('间隔为空或非整数时拒绝保存', async () => {
  const { dom, w, root, saved } = scheduledHarness();
  const body = root.querySelector('[data-sbody="cleanup"]');
  body.querySelector('[data-sched="type"]').value = 'interval';
  body.querySelector('[data-sched="type"]').dispatchEvent(new w.Event('change', { bubbles: true }));
  body.querySelector('[data-sched="dailyStart"]').value = '09:00';
  body.querySelector('[data-sched="dailyEnd"]').value = '21:00';
  body.querySelector('[data-sched="count"]').value = '3';
  body.querySelector('[data-sched="ack"]').checked = true;
  for (const value of ['', '0', '-2', '2.5', '13']) {
    body.querySelector('[data-sched="intervalHours"]').value = value;
    body.querySelector('[data-sched-save="cleanup"]').click();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(saved.length, 0);
  const toast = root.querySelector('.toast');
  assert.ok(toast && /1–12/.test(toast.textContent));
  dom.window.close();
});
