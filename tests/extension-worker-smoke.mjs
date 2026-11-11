// Loads an isolated test copy in Chrome or Edge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const edge = process.env.XFM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xfm-worker-smoke-'));
const ext = path.join(temp, 'extension');
// Node 的 fs.cpSync(recursive) 在本机目录复制时静默崩溃（exit 127），
// 这里改为手写递归复制，行为等价且可控。
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}
copyDirSync('x-follow-manager', ext);
const bg = path.join(ext, 'background.js');
fs.writeFileSync(bg, fs.readFileSync(bg, 'utf8').replace('var scheduledExecutionReady = false;', 'var scheduledExecutionReady = true;').replace('!/^https:\\/\\/(x\\.com|twitter\\.com)\\//i.test(tab.url || "")', '!/^http:\\/\\/localhost:38083\\//i.test(tab.url || "")'));
const manifestPath = path.join(ext, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
// The temporary test copy cannot access X or a real account.
manifest.host_permissions = ['http://localhost/*'];
manifest.content_scripts[0].matches = ['http://localhost/*'];
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
const mode = process.env.XFM_SMOKE_MODE === 'followback' ? 'followback' : 'cleanup';
const profile = path.join(temp, 'profile');
const server = spawn(process.execPath, ['tests/server.mjs', '38083'], { env: { ...process.env, XFM_EXTENSION_TEST: '1' }, stdio: 'ignore' });
const proc = spawn(edge, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-background-networking', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
let ws;
let browser;
try {
  let port;
  for (let i = 0; i < 60 && !port; i++) {
    try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!port) throw new Error('浏览器调试接口不可用');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browser = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { browser.addEventListener('open', resolve, { once: true }); browser.addEventListener('error', reject, { once: true }); });
  const loaded = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 10000);
    browser.addEventListener('message', e => { const msg = JSON.parse(e.data); if (msg.id === 99) { clearTimeout(timer); resolve(msg); } });
    browser.send(JSON.stringify({ id: 99, method: 'Extensions.loadUnpacked', params: { path: ext } }));
  });
  if (!loaded?.result?.id) throw new Error('无法装载隔离测试扩展: ' + JSON.stringify(loaded?.error));
  const extensionOrigin = 'chrome-extension://' + loaded.result.id;
  const auditUrl = extensionOrigin + '/popup.html';
  const auditPage = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(auditUrl)}`, { method: 'PUT' })).json();
  const isTestWorker = (target) => target.type === 'service_worker' && target.url === extensionOrigin + '/background.js';
  let targets = [];
  let auditReady = false;
  for (let i = 0; i < 40 && (!targets.length || !auditReady); i++) {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    targets = tabs.filter(isTestWorker);
    auditReady = tabs.some(tab => tab.id === auditPage.id && tab.url === auditUrl);
    if (!targets.length || !auditReady) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!auditReady) throw new Error('测试扩展页面未加载');
  if (!targets.length) throw new Error('扩展后台未启动');
  let value;
  for (const target of targets) {
    ws = new WebSocket(auditPage.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      ready = await new Promise(resolve => {
        const id = 100 + i;
        const timer = setTimeout(() => { ws.removeEventListener('message', receive); resolve(false); }, 1000);
        function receive(e) {
          const msg = JSON.parse(e.data);
          if (msg.id !== id) return;
          clearTimeout(timer);
          ws.removeEventListener('message', receive);
          resolve(msg.result?.result?.value === true);
        }
        ws.addEventListener('message', receive);
        const expression = `location.href === ${JSON.stringify(auditUrl)} && typeof chrome.storage?.session?.get === 'function'`;
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
      if (!ready) await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!ready) throw new Error('测试扩展弹窗的 API 未就绪');
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 10000);
      ws.addEventListener('message', e => { const msg = JSON.parse(e.data); if (msg.id === 2) { clearTimeout(timer); resolve(msg); } });
      ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '(async()=>{await chrome.storage.session.set({xfmSmoke:1}); const d=await chrome.storage.session.get("xfmSmoke"); const key="xfm.scan.progress.v1:synthetic"; const begin=await chrome.runtime.sendMessage({type:"XFM_COORD_PROGRESS_BEGIN",key}); await Promise.all(["alice","bob"].map(h=>chrome.runtime.sendMessage({type:"XFM_COORD_PROGRESS_SAVE",key,generation:begin.generation,rows:[{h}]}))); const rows=(await chrome.storage.local.get(key))[key].rows.map(r=>r.h).sort(); await chrome.runtime.sendMessage({type:"XFM_COORD_PROGRESS_CLEAR",key,generation:begin.generation}); const stale=await chrome.runtime.sendMessage({type:"XFM_COORD_PROGRESS_SAVE",key,generation:begin.generation,rows:[{h:"stale"}]}); const when=Date.now()+120000; const saved=await chrome.runtime.sendMessage({type:"XFM_SCHED_SAVE_TASK",taskKey:"cleanup",task:{enabled:true,authorized:true,type:"once",datetime:when,count:3,order:"desc",account:"alice",timezone:"UTC"}}); const tasks=await chrome.storage.local.get("xfm.scheduled.v1"); const bindings=await chrome.storage.session.get("xfm.schedule.bindings"); const alarm=await chrome.alarms.get("xfm-sched-cleanup"); return {session:d.xfmSmoke, alarms:typeof chrome.alarms.create, version:chrome.runtime.getManifest().version,rows,stale:stale.skipped,saved:saved.ok,next:tasks["xfm.scheduled.v1"]?.cleanup?.nextRun===when,bound:!!bindings["xfm.schedule.bindings"]?.cleanup?.tabId,alarm:!!alarm};})()', awaitPromise: true, returnByValue: true } }));
    });
    if (!result || result.error) throw new Error('无法读取测试扩展页面: ' + (result?.error?.message || '超时'));
    if (result?.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.text);
    value = result?.result?.result?.value;
    if (value) {
      const mock = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://localhost:38083/alice/${mode === 'followback' ? 'followers' : 'following'}?synthetic=20`)}`, { method: 'PUT' })).json();
      ws.close(); ws = new WebSocket(mock.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
      let seq = 10;
      async function evaluate(expression) {
        const current = ++seq;
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('页面检查超时')), 10000);
          function receive(e) { const msg = JSON.parse(e.data); if (msg.id !== current) return; ws.removeEventListener('message', receive); clearTimeout(timer); if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text)); else resolve(msg.result?.result?.value); }
          ws.addEventListener('message', receive);
          ws.send(JSON.stringify({ id: current, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        });
      }
      let panelReady = false;
      for (let i = 0; i < 80 && !panelReady; i++) { panelReady = await evaluate('!!document.querySelector("[data-xfm-panel-host]")'); if (!panelReady) await new Promise(r => setTimeout(r, 250)); }
      if (!panelReady) throw new Error('模拟页面未加载真实扩展面板');
      await evaluate('document.querySelector("[data-xfm-panel-host]").shadowRoot.querySelector("[data-act=scan]").click()');
      let completed = false;
      for (let i = 0; i < 200 && !completed; i++) { completed = await evaluate('document.querySelector("[data-xfm-panel-host]").shadowRoot.querySelector("[data-role=phase]").textContent.includes("扫描完成")'); if (!completed) await new Promise(r => setTimeout(r, 250)); }
      if (!completed) throw new Error('模拟页面真实扩展扫描未完成');
      await evaluate('document.querySelector("[data-xfm-panel-host]").shadowRoot.querySelector("[data-act=sched]").click()');
      let hasSave = false;
      for (let i = 0; i < 40 && !hasSave; i++) { hasSave = await evaluate(`!!document.querySelector("[data-xfm-panel-host]").shadowRoot.querySelector("[data-sched-save=${mode}]")`); if (!hasSave) await new Promise(r => setTimeout(r, 250)); }
      if (!hasSave) throw new Error('真实扩展定时设置缺少保存按钮');
      if (mode === 'followback') await evaluate('document.querySelector("[data-xfm-panel-host]").shadowRoot.querySelector("[data-stab=followback]").click()');
      await evaluate(`(()=>{const r=document.querySelector('[data-xfm-panel-host]').shadowRoot;const b=r.querySelector('[data-sbody=${mode}]');b.querySelector('[data-sched=type]').value='daily';b.querySelector('[data-sched=enabled]').checked=true;b.querySelector('[data-sched=ack]').checked=true;b.querySelector('[data-sched=count]').value='3';b.querySelector('[data-sched-save=${mode}]').click()})()`);
      const worker2 = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { worker2.addEventListener('open', resolve, { once: true }); worker2.addEventListener('error', reject, { once: true }); });
      async function workerEval(expression) {
        const current = ++seq;
        return await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('后台检查超时')), 10000); function receive(e) { const m=JSON.parse(e.data); if(m.id!==current)return;worker2.removeEventListener('message',receive);clearTimeout(timer);if(m.result?.exceptionDetails)reject(new Error(m.result.exceptionDetails.text));else resolve(m.result?.result?.value); } worker2.addEventListener('message',receive);worker2.send(JSON.stringify({id:current,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}})); });
      }
      let saved = false;
      for(let i=0;i<40&&!saved;i++){ saved=await workerEval(`(async()=>{const t=(await chrome.storage.local.get("xfm.scheduled.v1"))["xfm.scheduled.v1"]?.${mode};return !!(t?.enabled&&t?.count===3&&t?.type==='daily')})()`);if(!saved)await new Promise(r=>setTimeout(r,250)); }
      if(!saved) {
        const message = await evaluate('document.querySelector("[data-xfm-panel-host]")?.shadowRoot.querySelector(".toast")?.textContent');
        throw new Error('真实扩展页面未保存定时设置: ' + (message || '没有提示'));
      }
      await evaluate('document.querySelector("[data-xfm-panel-host]").shadowRoot.querySelector(".overlay [data-dlg=close]")?.click()');
      await workerEval(`(async()=>{const d=await chrome.storage.local.get("xfm.scheduled.v1");const due=Date.now()+1000;d["xfm.scheduled.v1"].${mode}.records=[];d["xfm.scheduled.v1"].${mode}.nextRun=due;await chrome.storage.local.set(d);await chrome.alarms.create("xfm-sched-${mode}",{when:due});return true})()`);
      for(let i=0;i<20;i++){ const asked=await evaluate('(()=>{const s=document.querySelector("[data-xfm-panel-host]")?.shadowRoot;const title=s?.querySelector("#xfm-sched-confirm");if(!title)return false;s.querySelector("[data-dlg=now]").click();return true})()'); if(asked)break; await new Promise(r=>setTimeout(r,250)); }
      let record;
      for(let i=0;i<360&&!record;i++){record=await workerEval(`(async()=>{const t=(await chrome.storage.local.get("xfm.scheduled.v1"))["xfm.scheduled.v1"]?.${mode};return t?.records?.[0]||null})()`);if(!record)await new Promise(r=>setTimeout(r,250));}
      if(!record||record.status!=='success'||record.success!==3) {
        const diag = await workerEval(`(async()=>({active:(await chrome.storage.local.get("xfm.scheduled.active.v1"))["xfm.scheduled.active.v1"], task:(await chrome.storage.local.get("xfm.scheduled.v1"))["xfm.scheduled.v1"]?.${mode}}))()`);
        const pageState = await evaluate('(()=>{const s=document.querySelector("[data-xfm-panel-host]")?.shadowRoot;return {phase:s?.querySelector("[data-role=phase]")?.textContent,status:s?.querySelector("[data-role=status]")?.textContent,dialog:!!s?.querySelector(".overlay")}})()');
        throw new Error('定时执行链未通过: '+JSON.stringify({record,diag,pageState}));
      }
      worker2.close();
      break;
    }

    ws.close(); ws = null;
  }
  if (!value || value.session !== 1 || value.alarms !== 'function' || value.version !== manifest.version || value.rows.join(',') !== 'alice,bob' || !value.stale || !value.saved || !value.next || !value.bound || !value.alarm) throw new Error('后台 API 检查失败: ' + JSON.stringify(value));
  console.log(`PASS: isolated ${/chrome\.exe$/i.test(edge) ? 'Chrome' : 'Edge'} extension messaging, progress coordination and simulated scheduled ${mode} execution`);
} finally {
  if (ws) ws.close();
  if (browser) browser.close();
  proc.kill();
  server.kill();
  await new Promise(resolve => setTimeout(resolve, 1000));
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
}
