"use strict";

importScripts("content/core.js");

var settingsKey = "xfm.settings.v1";
var lockKey = "xfm.run.lock.v1";
var tasksKey = "xfm.scheduled.v1";
var queue = Promise.resolve();

async function handleMessage(msg, sender) {
  if (msg.type === "XFM_COORD_SCAN_START" || msg.type === "XFM_COORD_SCAN_END") {
    if (!sender.tab || !sender.tab.id || !chrome.storage.session || !msg.scanId) return { ok: false, reason: "无法协调扫描状态" };
    var sessionData = await chrome.storage.session.get("xfm.scan.activity.v1");
    var scans = sessionData["xfm.scan.activity.v1"] || {};
    var tabKey = String(sender.tab.id);
    if (msg.type === "XFM_COORD_SCAN_START") {
      var running = (await chrome.storage.local.get("xfm.scheduled.active.v1"))["xfm.scheduled.active.v1"];
      if (running && (running.runId !== msg.runId || running.tabId !== sender.tab.id)) return { ok: false, reason: "定时任务正在运行" };
      if (scans[tabKey] && scans[tabKey] !== msg.scanId) return { ok: false, reason: "当前标签页正在扫描" };
      scans[tabKey] = msg.scanId;
    } else if (scans[tabKey] === msg.scanId) delete scans[tabKey];
    await chrome.storage.session.set({ "xfm.scan.activity.v1": scans });
    return { ok: true };
  }
  if (msg.type === "XFM_COORD_PROGRESS_BEGIN") {
    /*
     * 扫描开始：顺带安全清理超过一周的进度条目（任意列表）。
     * 清理 = 写回升代墓碑（代次 +1），而非删除——删除会把代次重置为 0，
     * 让持有旧代次 0 的迟到保存重新通过检查、复活已清除进度（审核确认的漏洞）。
     * 墓碑保留递增后的代次：旧任务的保存/清除仍被跳过；新扫描拿到新代次正常写回。
     * 存储增长限制：每个不再使用的「登录账号+列表」身份留一个 ~100 字节墓碑。
     */
    var allEntries = await chrome.storage.local.get(null);
    var staleUpdate = {};
    Object.keys(allEntries || {}).forEach(function (k) {
      if (k.indexOf("xfm.scan.progress.v1") !== 0) return;
      var entry = allEntries[k];
      var at = (entry && (entry.updatedAt || entry.clearedAt)) || 0;
      if (Date.now() - at > 7 * 24 * 60 * 60 * 1000) {
        staleUpdate[k] = {
          id: k.slice("xfm.scan.progress.v1:".length),
          clearedAt: Date.now(),
          generation: ((entry && entry.generation) || 0) + 1
        };
      }
    });
    if (Object.keys(staleUpdate).length > 0) await chrome.storage.local.set(staleUpdate);
    var beginData = await chrome.storage.local.get(msg.key);
    return { ok: true, generation: (beginData[msg.key] && beginData[msg.key].generation) || 0 };
  }
  if (msg.type === "XFM_COORD_PROGRESS_SAVE") {
    /*
     * 扫描进度保存：串行队列内读-合并-写。
     * 同一账号同一列表可能被多个标签页同时扫描，各自的已扫子集不同——
     * 直接整份覆盖会抹掉另一标签页的成果；墓碑（丢弃/完成清除）优先级
     * 高于本页扫描开始之前的写回。
     */
    var pdata = await chrome.storage.local.get(msg.key);
    var existing = pdata[msg.key] || null;
    var generation = (existing && existing.generation) || 0;
    if (msg.generation !== generation) return { ok: true, skipped: true, reason: "generation" };
    var resolved = { rows: XFMCore.mergeProgressRows(existing && existing.rows, msg.rows || []), updatedAt: Date.now() };
    var pupdate = {};
    pupdate[msg.key] = Object.assign({
      id: msg.id || "",
      path: msg.path || "",
      mode: msg.mode || "",
      scrollTop: msg.scrollTop || 0,
      rounds: msg.rounds || 0,
      partial: !!msg.partial,
      generation: generation
    }, resolved);
    await chrome.storage.local.set(pupdate);
    return { ok: true };
  }
  if (msg.type === "XFM_COORD_PROGRESS_CLEAR") {
    // 清除写成墓碑（不是 remove）：晚到的在途保存经规则判断后不得复活
    var beforeClear = await chrome.storage.local.get(msg.key);
    var currentGeneration = (beforeClear[msg.key] && beforeClear[msg.key].generation) || 0;
    if (msg.generation != null && msg.generation !== currentGeneration) return { ok: true, skipped: true };
    var ptomb = {};
    ptomb[msg.key] = { id: msg.id || "", clearedAt: Date.now(), generation: currentGeneration + 1 };
    await chrome.storage.local.set(ptomb);
    return { ok: true };
  }
  if (msg.type === "XFM_COORD_SETTINGS") {
    var data = await chrome.storage.local.get(settingsKey);
    var saved = data[settingsKey] || {};
    var next = Object.assign({}, saved, msg.patch || {});
    if (msg.excluded) {
      next.excluded = XFMCore.mergeExcluded(msg.excluded.base, msg.excluded.ours, saved.excluded || []).slice(0, 5000);
    }
    var update = {};
    update[settingsKey] = next;
    await chrome.storage.local.set(update);
    return { ok: true, settings: next };
  }
  var data = await chrome.storage.local.get(lockKey);
  var current = data[lockKey];
  if (msg.type === "XFM_COORD_ACQUIRE") {
    var scheduled = (await chrome.storage.local.get("xfm.scheduled.active.v1"))["xfm.scheduled.active.v1"];
    if (scheduled && (!sender.tab || sender.tab.id !== scheduled.tabId || msg.scheduleRunId !== scheduled.runId)) return { ok: false, reason: "定时任务正在运行" };
    if (current && current.runId && Date.now() - (current.heartbeat || 0) < 6000) {
      return { ok: false, reason: "另一个标签页正在执行，请先等它结束" };
    }
    var entry = {};
    entry[lockKey] = { runId: msg.runId, path: msg.path, heartbeat: Date.now() };
    await chrome.storage.local.set(entry);
    return { ok: true };
  }
  if (!current || current.runId !== msg.runId) return { ok: false };
  if (msg.type === "XFM_COORD_BEAT") {
    current.heartbeat = Date.now();
    var beat = {};
    beat[lockKey] = current;
    await chrome.storage.local.set(beat);
  } else if (msg.type === "XFM_COORD_RELEASE") {
    await chrome.storage.local.remove(lockKey);
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (!msg || !/^XFM_COORD_(SETTINGS|ACQUIRE|BEAT|RELEASE|SCAN_START|SCAN_END|PROGRESS_BEGIN|PROGRESS_SAVE|PROGRESS_CLEAR)$/.test(msg.type || "")) return;
  var task = queue.then(function () { return handleMessage(msg, sender); });
  queue = task.catch(function () {});
  task.then(respond, function () { respond({ ok: false, reason: "本地协调服务不可用" }); });
  return true;
});

/* ------------------------------------------------------------------ */
/* 定时任务调度（chrome.alarms）                                        */
/* ------------------------------------------------------------------ */

var SCHED_ALARM_PREFIX = "xfm-sched-";
var scheduledActiveKey = "xfm.scheduled.active.v1";
var navigationWatchdogName = "xfm-navigation-watch";
var actionWatchdogName = "xfm-action-watch";
var phaseWatchdogName = "xfm-phase-watch";
// Fail closed until the complete scheduled-action safety and interruption path is verified.
var scheduledExecutionReady = false;

function schedAlarmName(taskKey) { return SCHED_ALARM_PREFIX + taskKey; }

function phaseTimeoutMs(phase) {
  if (phase === "awaiting") return 6 * 60 * 1000;      // 覆盖 5 分钟确认窗口
  if (phase === "resuming") return 2 * 60 * 1000;
  if (phase === "scanning") return 30 * 60 * 1000;     // 内容脚本自身 5 分钟无增长兜底
  if (phase === "executing") return 3 * 60 * 1000;     // 两次动作之间的空窗
  return 5 * 60 * 1000;
}

/** 给当前活动任务设置阶段与后台超时；同名 alarm 会覆盖旧计划 */
async function setActivePhase(active, phase) {
  if (!active) return null;
  active.phase = phase;
  active.phaseStartedAt = Date.now();
  active.phaseDeadline = active.phaseStartedAt + phaseTimeoutMs(phase);
  var upd = {};
  upd[scheduledActiveKey] = active;
  await chrome.storage.local.set(upd);
  await chrome.alarms.create(phaseWatchdogName, { when: active.phaseDeadline });
  return active;
}

async function clearPhaseWatch() {
  await chrome.alarms.clear(phaseWatchdogName);
}

/** 读取定时任务存储 */
async function getTasks() {
  var data = await chrome.storage.local.get(tasksKey);
  return (data && data[tasksKey]) || { cleanup: null, followback: null };
}

/** 写回定时任务存储 */
async function setTasks(tasks) {
  var upd = {};
  upd[tasksKey] = tasks;
  await chrome.storage.local.set(upd);
}

/** 读取定时周期启动时的设置快照（排除名单去重、严格模式、批次上限） */
function scheduledSettingsSnapshot(config) {
  var source = config || {};
  var seen = new Set();
  var excluded = [];
  (Array.isArray(source.excluded) ? source.excluded : []).forEach(function (value) {
    if (excluded.length >= 5000) return;
    var handle = XFMCore.normalizeHandle(value);
    if (!handle || seen.has(handle)) return;
    seen.add(handle);
    excluded.push(handle);
  });
  return {
    excluded: excluded,
    strictMode: source.strictMode !== false,
    batchLimit: XFMCore.sanitizeBatchLimit(source.batchLimit)
  };
}

function addScheduledRecord(task, record) {
  if (!Array.isArray(task.records)) task.records = [];
  task.records.unshift(record);
  task.records = task.records.slice(0, 10);
  task.lastRun = record;
}

async function notifyScheduled(message) {
  try { await chrome.notifications.create({ type: "basic", iconUrl: "icons/icon-128.png", title: "X 关注管理台", message: message }); }
  catch (err) { /* 通知失败不影响任务 */ }
}

async function interruptScheduled(tabId, reason) {
  var data = await chrome.storage.local.get(scheduledActiveKey);
  var active = data[scheduledActiveKey];
  if (!active || (tabId != null && active.tabId !== tabId)) return;
  var tasks = await getTasks();
  var task = tasks[active.taskKey];
  if (task) {
    var detail = Array.isArray(active.detail) ? active.detail.slice() : [];
    if (active.current) detail.push({ handle: active.current, status: "unknown", reason: "中断时操作结果未确认" });
    var unknown = detail.filter(function (item) { return item.status === "unknown"; }).length;
    addScheduledRecord(task, { at: Date.now(), startedAt: active.startedAt, due: active.due, status: "interrupted", reason: reason,
      scanned: active.scanned || 0, candidates: active.candidates || 0,
      success: detail.filter(function (item) { return item.status === "success"; }).length,
      skipped: detail.filter(function (item) { return item.status === "skipped"; }).length,
      failed: detail.filter(function (item) { return item.status === "failed" || item.status === "blocked"; }).length,
      unknown: unknown, detail: detail });
    if (unknown) { task.enabled = false; await chrome.alarms.clear(schedAlarmName(active.taskKey)); }
    await setTasks(tasks);
  }
  await chrome.storage.local.remove(scheduledActiveKey);
  await chrome.alarms.clear(navigationWatchdogName);
  await chrome.alarms.clear(actionWatchdogName);
  await chrome.alarms.clear(phaseWatchdogName);
  await notifyScheduled("定时任务中断，请查看记录");
}

async function clearScanActivity(tabId) {
  if (!chrome.storage.session) return;
  var data = await chrome.storage.session.get("xfm.scan.activity.v1");
  var scans = data["xfm.scan.activity.v1"] || {};
  delete scans[String(tabId)];
  await chrome.storage.session.set({ "xfm.scan.activity.v1": scans });
}

if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(function (tabId) {
  var t = queue.then(async function () {
    await clearScanActivity(tabId);
    return interruptScheduled(tabId, "标签页已关闭");
  });
  queue = t.catch(function () {});
});
if (chrome.tabs && chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener(function (tabId, change, tab) {
  if (change.status !== "loading" && change.status !== "complete") return;
  var t = queue.then(async function () {
    if (change.status === "loading") await clearScanActivity(tabId);
    var active = (await chrome.storage.local.get(scheduledActiveKey))[scheduledActiveKey];
    if (!active || active.tabId !== tabId) return;
    if (!scheduledExecutionReady) { await interruptScheduled(tabId, "定时功能未启用，运行已取消"); return; }
    var currentTasks = await getTasks();
    var currentTask = currentTasks[active.taskKey];
    if (!currentTask || (!currentTask.enabled && currentTask.type !== "once")) { await interruptScheduled(tabId, "任务已停用"); return; }
    if (chrome.storage.session) {
      var currentBindings = (await chrome.storage.session.get("xfm.schedule.bindings"))["xfm.schedule.bindings"] || {};
      var currentBinding = currentBindings[active.taskKey];
      if (!currentBinding || currentBinding.tabId !== tabId || currentBinding.account !== active.snapshot.account) {
        await interruptScheduled(tabId, "绑定已失效");
        return;
      }
    }
    if (active.phase !== "navigating") {
      if (change.status === "loading") await interruptScheduled(tabId, "页面已重新加载");
      return;
    }
    if (change.status !== "complete") return;
    var url;
    try { url = new URL(tab.url); } catch (err) { await interruptScheduled(tabId, "页面地址无法核实"); return; }
    if (!/^https:$/.test(url.protocol) || !/^(x\.com|twitter\.com)$/i.test(url.hostname) || url.pathname.toLowerCase() !== active.targetPath.toLowerCase()) {
      await interruptScheduled(tabId, "页面已切换"); return;
    }
    await setActivePhase(active, "resuming");
    var message = Object.assign({}, active.snapshot, { type: "XFM_SCHEDULED_RUN", runId: active.runId, due: active.due, resume: true });
    var delivered = false;
    for (var retry = 0; retry < 3 && !delivered; retry++) {
      try { await chrome.tabs.sendMessage(tabId, message); delivered = true; }
      catch (err) { if (retry < 2) await new Promise(function (resolve) { setTimeout(resolve, 500); }); }
    }
    if (!delivered) await interruptScheduled(tabId, "无法连接新的列表页面");
  });
  queue = t.catch(function () {});
});
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(function () {
  var t = queue.then(function () { return interruptScheduled(null, "浏览器已重启"); });
  queue = t.catch(function () {});
});

/** 计算某任务的下一次执行时间并设置 chrome.alarms */
async function scheduleTask(taskKey, task) {
  var alarmName = schedAlarmName(taskKey);
  await chrome.alarms.clear(alarmName);
  if (!task || !task.enabled) return;
  var next = XFMCore.computeNextRun(task, Date.now());
  if (!next) return;
  task.nextRun = next;
  await chrome.alarms.create(alarmName, { when: next });
  var tasks = await getTasks();
  tasks[taskKey] = task;
  await setTasks(tasks);
}

async function restoreScheduledAlarms() {
  if (!chrome.alarms || typeof chrome.alarms.get !== "function") return;
  // A service-worker restart retains session storage; an extension reload does not.
  // Do not leave an interrupted run permanently blocking later tasks.
  var active = (await chrome.storage.local.get(scheduledActiveKey))[scheduledActiveKey];
  if (!scheduledExecutionReady) {
    // 开关关闭时 fail-closed：不重建任何定时闹钟，遗留 active 必须中断
    if (active) await interruptScheduled(null, "定时功能未启用，运行已取消");
    await clearPhaseWatch();
    await chrome.alarms.clear(navigationWatchdogName);
    await chrome.alarms.clear(actionWatchdogName);
    await chrome.alarms.clear(schedAlarmName("cleanup"));
    await chrome.alarms.clear(schedAlarmName("followback"));
    var disabledTasks = await getTasks();
    var recordChanged = false;
    ["cleanup", "followback"].forEach(function (key) {
      var task = disabledTasks[key];
      if (!task || !task.enabled) return;
      var last = task.lastRun;
      if (last && last.status === "skipped" && last.reason === "定时功能暂不可启用，未安排执行") return;
      if (last && last.status === "interrupted" && /定时功能未启用/.test(last.reason || "")) return;
      addScheduledRecord(task, { at: Date.now(), status: "skipped", reason: "定时功能暂不可启用，未安排执行" });
      recordChanged = true;
    });
    if (recordChanged) await setTasks(disabledTasks);
    return;
  }
  if (active && chrome.storage.session) {
    var bindings = (await chrome.storage.session.get("xfm.schedule.bindings"))["xfm.schedule.bindings"] || {};
    var binding = bindings[active.taskKey];
    if (!binding || binding.tabId !== active.tabId) await interruptScheduled(null, "扩展会话已结束，请重新绑定");
  }
  var tasks = await getTasks();
  for (var i = 0; i < 2; i++) {
    var key = i ? "followback" : "cleanup", task = tasks[key];
    if (!task || !task.enabled) continue;
    var alarm = await chrome.alarms.get(schedAlarmName(key));
    if (!alarm && task.nextRun) await chrome.alarms.create(schedAlarmName(key), { when: Math.max(Date.now() + 1, task.nextRun) });
  }
}

if (chrome.alarms && typeof chrome.alarms.get === "function") {
  var restoreTask = queue.then(restoreScheduledAlarms);
  queue = restoreTask.catch(function () {});
}

/** alarm 触发：查找匹配的 X 标签页并通知内容脚本 */
async function onAlarmFire(taskKey) {
  if (!scheduledExecutionReady) {
    await interruptScheduled(null, "定时功能未启用，运行已取消");
    await clearPhaseWatch();
    return;
  }
  var tasks = await getTasks();
  var task = tasks[taskKey];
  if (!task || !task.enabled) return;
  var now = Date.now();
  var next = task.nextRun || 0;
  if (!next || now < next) return;
  if (!XFMCore.withinStartWindow(next, now, 5 * 60 * 1000)) {
    // 已错过窗口：不补跑，直接调度下一次
    addScheduledRecord(task, { at: now, status: "skipped", reason: "已错过计划时间" });
    if (task.type === "once") task.enabled = false;
    await setTasks(tasks);
    await scheduleTask(taskKey, task);
    await notifyScheduled("定时任务已错过，请查看记录");
    return;
  }
  // 持久化已认领周期，重复 alarm 和后台重启不能再次启动同一周期。
  if (task.lastClaimed === next) return;
  task.lastClaimed = next;
  var snapshot = Object.assign({}, task);
  // 周期开始时的设置快照：运行中修改设置只影响后续周期
  var settingsSnapshot = scheduledSettingsSnapshot((await chrome.storage.local.get(settingsKey))[settingsKey]);
  var limitSnapshot = settingsSnapshot.batchLimit;
  if (task.type === "once") { task.enabled = false; task.nextRun = null; }
  else task.nextRun = XFMCore.computeNextRun(task, now);
  await setTasks(tasks);
  if (task.enabled && task.nextRun) await chrome.alarms.create(schedAlarmName(taskKey), { when: task.nextRun });
  var session;
  try { session = chrome.storage.session && await chrome.storage.session.get("xfm.schedule.bindings"); }
  catch (err) { session = null; }
  var binding = session && session["xfm.schedule.bindings"] && session["xfm.schedule.bindings"][taskKey];
  if (!binding || binding.account !== task.account) {
    addScheduledRecord(task, { at: now, status: "skipped", reason: "请重新绑定 X 标签页" });
    await setTasks(tasks);
    await notifyScheduled("定时任务未执行，请重新绑定 X 标签页");
    return;
  }
  var activeData = await chrome.storage.local.get(scheduledActiveKey);
  var lock = (await chrome.storage.local.get(lockKey))[lockKey];
  var scanData = await chrome.storage.session.get("xfm.scan.activity.v1");
  if (activeData[scheduledActiveKey] || (lock && lock.runId && now - (lock.heartbeat || 0) < 6000) || Object.keys(scanData["xfm.scan.activity.v1"] || {}).length) {
    addScheduledRecord(task, { at: now, status: "skipped", reason: activeData[scheduledActiveKey] || (lock && lock.runId && now - (lock.heartbeat || 0) < 6000) ? "已有任务运行" : "已有扫描运行" });
    await setTasks(tasks);
    await notifyScheduled("定时任务未执行：已有任务运行");
    return;
  }
  var runId = taskKey + ":" + next + ":" + Math.random().toString(36).slice(2);
  var activeWrite = {};
  var activeRecord = { runId: runId, taskKey: taskKey, due: next, tabId: binding.tabId, startedAt: now,
    phase: "awaiting", phaseStartedAt: now, phaseDeadline: now + phaseTimeoutMs("awaiting"), snapshot: {
    taskKey: taskKey, taskType: taskKey, count: snapshot.count, order: snapshot.order, account: snapshot.account,
    batchLimit: limitSnapshot, strictMode: settingsSnapshot.strictMode, excluded: settingsSnapshot.excluded
  } };
  activeWrite[scheduledActiveKey] = activeRecord;
  await chrome.storage.local.set(activeWrite);
  await chrome.alarms.create(phaseWatchdogName, { when: activeRecord.phaseDeadline });
  try {
    var tab = await chrome.tabs.get(binding.tabId);
    if (!tab || !/^https:\/\/(x\.com|twitter\.com)\//i.test(tab.url || "")) throw new Error("标签页不可用");
    await chrome.tabs.sendMessage(binding.tabId, {
      type: "XFM_SCHEDULED_RUN",
      taskKey: taskKey,
      taskType: taskKey,
      count: snapshot.count,
      order: snapshot.order,
      account: snapshot.account,
      batchLimit: limitSnapshot,
      strictMode: settingsSnapshot.strictMode,
      excluded: settingsSnapshot.excluded,
      due: next,
      runId: runId
    });
  } catch (err) {
    await chrome.storage.local.remove(scheduledActiveKey);
    await clearPhaseWatch();
    addScheduledRecord(task, { at: now, status: "skipped", reason: "无法连接标签页" });
    await setTasks(tasks);
    await notifyScheduled("定时任务未执行：无法连接标签页");
  }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === phaseWatchdogName) {
      var phaseWatch = queue.then(async function () {
        var active = (await chrome.storage.local.get(scheduledActiveKey))[scheduledActiveKey];
        if (!active) return;
        var now = Date.now();
        if (active.phaseDeadline && now < active.phaseDeadline) {
          // Chrome 提前唤醒：按剩余时间重设，不误杀
          await chrome.alarms.create(phaseWatchdogName, { when: active.phaseDeadline });
          return;
        }
        await interruptScheduled(active.tabId, "阶段超时：" + active.phase);
      });
      queue = phaseWatch.catch(function () {});
      return;
    }
    if (alarm.name === navigationWatchdogName) {
      var watch = queue.then(async function () {
        var active = (await chrome.storage.local.get(scheduledActiveKey))[scheduledActiveKey];
        if (active && (active.phase === "navigating" || active.phase === "resuming")) await interruptScheduled(active.tabId, "切换列表超时");
      });
      queue = watch.catch(function () {});
      return;
    }
    if (alarm.name === actionWatchdogName) {
      var actionWatch = queue.then(async function () {
        var active = (await chrome.storage.local.get(scheduledActiveKey))[scheduledActiveKey];
        if (active && active.current && Date.now() - (active.actionStartedAt || 0) >= 5 * 60 * 1000) await interruptScheduled(active.tabId, "操作长时间未响应");
      });
      queue = actionWatch.catch(function () {});
      return;
    }
    if (alarm.name && alarm.name.indexOf(SCHED_ALARM_PREFIX) === 0) {
      var taskKey = alarm.name.slice(SCHED_ALARM_PREFIX.length);
      var alarmTask = queue.then(function () { return onAlarmFire(taskKey); });
      queue = alarmTask.catch(function () {});
    }
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (!msg) return;
  if (msg.type === "XFM_SCHED_ACTION_BEGIN" || msg.type === "XFM_SCHED_ACTION_END") {
    var action = queue.then(async function () {
      var data = await chrome.storage.local.get(scheduledActiveKey);
      var active = data[scheduledActiveKey];
      if (!active || active.runId !== msg.runId || !sender.tab || sender.tab.id !== active.tabId || !/^[A-Za-z0-9_]{1,15}$/.test(msg.handle || "")) return { ok: false };
      if (msg.type === "XFM_SCHED_ACTION_BEGIN") {
        if (active.phase !== "executing" || active.current || active.halted || !active.snapshot || (active.attempts || 0) >= active.snapshot.count) return { ok: false };
        active.current = msg.handle;
        active.attempts = (active.attempts || 0) + 1;
        active.actionStartedAt = Date.now();
        await chrome.alarms.create(actionWatchdogName, { when: active.actionStartedAt + 5 * 60 * 1000 });
      } else {
        if (active.current !== msg.handle || !/^(success|failed|skipped|unknown|blocked|aborted)$/.test(msg.status || "")) return { ok: false };
        if (!Array.isArray(active.detail)) active.detail = [];
        active.detail.push({ handle: msg.handle, status: msg.status, reason: String(msg.reason || "").slice(0, 300) });
        if (msg.status === "unknown" || msg.status === "blocked" || msg.status === "aborted") active.halted = true;
        active.current = null;
      }
      var update = {}; update[scheduledActiveKey] = active;
      active.phase = "executing";
      active.phaseStartedAt = Date.now();
      active.phaseDeadline = active.phaseStartedAt + phaseTimeoutMs("executing");
      await chrome.storage.local.set(update);
      await chrome.alarms.create(phaseWatchdogName, { when: active.phaseDeadline });
      if (msg.type === "XFM_SCHED_ACTION_END") await chrome.alarms.clear(actionWatchdogName);
      return { ok: true };
    });
    queue = action.catch(function () {});
    action.then(respond, function () { respond({ ok: false }); });
    return true;
  }
  if (msg.type === "XFM_SCHED_PREPARE_NAVIGATION" || msg.type === "XFM_SCHED_MARK_SCANNING" || msg.type === "XFM_SCHED_SCAN_PROGRESS" || msg.type === "XFM_SCHED_SCAN_DONE") {
    var navigation = queue.then(async function () {
      var active = (await chrome.storage.local.get(scheduledActiveKey))[scheduledActiveKey];
      if (!active || active.runId !== msg.runId || !sender.tab || sender.tab.id !== active.tabId) return { ok: false };
      if (msg.type === "XFM_SCHED_PREPARE_NAVIGATION") {
        var expected = "/" + active.snapshot.account + (active.taskKey === "followback" ? "/followers" : "/following");
        if (String(msg.targetPath || "").toLowerCase() !== expected.toLowerCase() || active.phase !== "awaiting") return { ok: false };
        active.phase = "navigating";
        active.phaseStartedAt = Date.now();
        active.phaseDeadline = 0;   // navigating 由 navigation-watch 负责
        active.targetPath = expected;
        await chrome.alarms.create(navigationWatchdogName, { when: Date.now() + 60000 });
      } else if (msg.type === "XFM_SCHED_MARK_SCANNING") {
        if (active.phase !== "awaiting" && active.phase !== "resuming") return { ok: false };
        active.phase = "scanning";
        active.phaseStartedAt = Date.now();
        active.phaseDeadline = active.phaseStartedAt + phaseTimeoutMs("scanning");
      } else if (msg.type === "XFM_SCHED_SCAN_PROGRESS") {
        if (active.phase !== "scanning" || !Number.isInteger(msg.scanned) || msg.scanned <= (active.progressCount || 0)) return { ok: false };
        active.progressCount = msg.scanned;
        active.phaseDeadline = Date.now() + phaseTimeoutMs("scanning");
      } else {
        if (active.phase !== "scanning" || !Number.isInteger(msg.scanned) || !Number.isInteger(msg.candidates) || msg.scanned < 0 || msg.candidates < 0 || msg.candidates > msg.scanned) return { ok: false };
        active.phase = "executing";
        active.phaseStartedAt = Date.now();
        active.phaseDeadline = active.phaseStartedAt + phaseTimeoutMs("executing");
        active.scanned = msg.scanned;
        active.candidates = msg.candidates;
      }
      var update = {}; update[scheduledActiveKey] = active;
      await chrome.storage.local.set(update);
      if (msg.type === "XFM_SCHED_PREPARE_NAVIGATION") await clearPhaseWatch();
      if (msg.type === "XFM_SCHED_MARK_SCANNING") {
        await chrome.alarms.clear(navigationWatchdogName);
        await chrome.alarms.create(phaseWatchdogName, { when: active.phaseDeadline });
      }
      if (msg.type === "XFM_SCHED_SCAN_DONE") await chrome.alarms.create(phaseWatchdogName, { when: active.phaseDeadline });
      if (msg.type === "XFM_SCHED_SCAN_PROGRESS") await chrome.alarms.create(phaseWatchdogName, { when: active.phaseDeadline });
      return { ok: true };
    });
    queue = navigation.catch(function () {});
    navigation.then(respond, function () { respond({ ok: false }); });
    return true;
  }
  if (msg.type === "XFM_COORD_NOTIFY") {
    // 浏览器通知：只显示状态和数量，不显示账号名单
    var nTitle = msg.title || "X 关注管理台";
    var nMsg = msg.message || "";
    Promise.resolve().then(function () { return chrome.notifications.create({
      type: "basic", iconUrl: "icons/icon-128.png", title: nTitle, message: nMsg
    }); }).then(function () { respond({ ok: true }); }, function () { respond({ ok: false }); });
    return true;
  }
  if (msg.type === "XFM_SCHED_RECORD_RUN" || msg.type === "XFM_SCHED_RECORD_SKIP") {
    var rTask = queue.then(async function () {
      var tasks = await getTasks();
      var tk = msg.taskKey;
      if (!tasks[tk]) return { ok: false, reason: "任务不存在" };
      var activeData = await chrome.storage.local.get(scheduledActiveKey);
      var active = activeData[scheduledActiveKey];
      if (!active || !msg.runId || active.runId !== msg.runId || !sender.tab || sender.tab.id !== active.tabId) return { ok: false, reason: "运行身份不匹配" };
      var record = {
        at: msg.at || Date.now(), status: msg.status || "",
        startedAt: msg.startedAt || active.startedAt, due: active.due, endedAt: Date.now(),
        scanned: msg.scanned || 0, candidates: msg.candidates || 0,
        success: msg.success || 0, skipped: msg.skipped || 0,
        unknown: msg.unknown || 0, failed: msg.failed || 0,
        reason: msg.reason || "", detail: Array.isArray(msg.detail) ? msg.detail : [],
        failureCycle: !!msg.failureCycle
      };
      if (active.current) {
        record.detail.push({ handle: active.current, status: "unknown", reason: "操作结果尚未确认" });
        record.unknown += 1;
        record.status = "interrupted";
      }
      if (msg.type === "XFM_SCHED_RECORD_SKIP") record.status = "skipped";
      addScheduledRecord(tasks[tk], record);
      // 只认显式“连续操作失败”信号；扫描中止、身份变化、页面切换、用户停止
      // 一律不计入 failureCount，避免任务被非操作原因停用。
      if (record.failureCycle === true) tasks[tk].failureCount = (tasks[tk].failureCount || 0) + 1;
      else if (record.status === "success") tasks[tk].failureCount = 0;
      if (msg.pause || record.unknown || tasks[tk].failureCount >= 3) {
        tasks[tk].enabled = false;
        await chrome.alarms.clear(schedAlarmName(tk));
      }
      await setTasks(tasks);
      await chrome.storage.local.remove(scheduledActiveKey);
      await clearPhaseWatch();
      if (msg.type === "XFM_SCHED_RECORD_SKIP") await notifyScheduled("定时任务未执行，请查看记录");
      return { ok: true };
    });
    queue = rTask.catch(function () {});
    rTask.then(respond, function () { respond({ ok: false }); });
    return true;
  }
  if (msg.type === "XFM_SCHED_SAVE_TASK") {
    var task = queue.then(async function () {
      if (!scheduledExecutionReady && msg.task && msg.task.enabled) return { ok: false, reason: "定时任务正在完善，暂不可启用" };
      if ((msg.taskKey !== "cleanup" && msg.taskKey !== "followback") || !msg.task || !/^[A-Za-z0-9_]{1,15}$/.test(msg.task.account || "") || !sender.tab || !sender.tab.id || !chrome.storage.session) throw new Error("无法绑定当前账号或标签页");
      var tasks = await getTasks();
      var config = (await chrome.storage.local.get(settingsKey))[settingsKey] || {};
      var limit = XFMCore.sanitizeBatchLimit(config.batchLimit);
      if (!Number.isInteger(msg.task.count) || msg.task.count < 1 || msg.task.count > limit || !/^(asc|desc)$/.test(msg.task.order || "")) throw new Error("人数或处理顺序无效");
      // 周期字段统一由核心校验：跨午夜、间隔范围、日期已过等在这里也会被拒绝。
      var scheduleError = XFMCore.validateSchedule(msg.task, Date.now(), { requireFuture: !!msg.task.enabled });
      if (scheduleError) return { ok: false, reason: scheduleError };
      if (msg.task.enabled && (!msg.task.authorized || !msg.task.timezone || !XFMCore.computeNextRun(msg.task, Date.now()))) throw new Error("计划时间或授权无效");
      var previous = tasks[msg.taskKey];
      if (previous) {
        msg.task.records = previous.records || [];
        msg.task.lastRun = previous.lastRun || null;
        msg.task.failureCount = previous.failureCount || 0;
        msg.task.lastClaimed = previous.lastClaimed;
      }
      if (!msg.task.enabled) msg.task.nextRun = null;
      tasks[msg.taskKey] = msg.task;
      await setTasks(tasks);
      var stored = await chrome.storage.session.get("xfm.schedule.bindings");
      var bindings = stored["xfm.schedule.bindings"] || {};
      bindings[msg.taskKey] = { tabId: sender.tab.id, account: msg.task.account };
      await chrome.storage.session.set({ "xfm.schedule.bindings": bindings });
      await scheduleTask(msg.taskKey, msg.task);
      return { ok: true, task: msg.task };
    });
    queue = task.catch(function () {});
    task.then(respond, function () { respond({ ok: false, reason: "保存失败" }); });
    return true;
  }
  if (msg.type === "XFM_SCHED_GET_TASKS") {
    var t = queue.then(async function () { return await getTasks(); });
    queue = t.catch(function () {});
    t.then(respond, function () { respond({ cleanup: null, followback: null }); });
    return true;
  }
  if (msg.type === "XFM_SCHED_CLEAR_RECORDS") {
    var clear = queue.then(async function () {
      var tasks = await getTasks();
      if (!tasks[msg.taskKey] || !sender.tab) return { ok: false };
      tasks[msg.taskKey].records = [];
      tasks[msg.taskKey].lastRun = null;
      await setTasks(tasks);
      return { ok: true };
    });
    queue = clear.catch(function () {});
    clear.then(respond, function () { respond({ ok: false }); });
    return true;
  }
  if (msg.type === "XFM_SCHED_CLAIM_NOW") {
    var claim = queue.then(async function () {
      if (!scheduledExecutionReady) return { ok: false, reason: "定时任务正在完善，暂不可执行" };
      var tasks = await getTasks();
      var current = tasks[msg.taskKey];
      var active = await chrome.storage.local.get(scheduledActiveKey);
      var session = chrome.storage.session && await chrome.storage.session.get("xfm.schedule.bindings");
      var binding = session && session["xfm.schedule.bindings"] && session["xfm.schedule.bindings"][msg.taskKey];
      if (!current || !current.authorized || !sender.tab || !binding || binding.tabId !== sender.tab.id || binding.account !== msg.account || current.account !== msg.account) return { ok: false, reason: "请先完成扫描并保存任务" };
      if (active[scheduledActiveKey]) return { ok: false, reason: "已有定时任务运行" };
      var scans = (await chrome.storage.session.get("xfm.scan.activity.v1"))["xfm.scan.activity.v1"] || {};
      var existingLock = (await chrome.storage.local.get(lockKey))[lockKey];
      if (Object.keys(scans).length || (existingLock && existingLock.runId && Date.now() - (existingLock.heartbeat || 0) < 6000)) return { ok: false, reason: "已有任务运行" };
      var id = msg.taskKey + ":manual:" + Date.now() + ":" + Math.random().toString(36).slice(2);
      var value = {};
      var options = msg.options || {};
      var settingsSnapshot = scheduledSettingsSnapshot((await chrome.storage.local.get(settingsKey))[settingsKey]);
      var limit = settingsSnapshot.batchLimit;
      if (!Number.isInteger(options.count) || options.count < 1 || options.count > limit || !/^(asc|desc)$/.test(options.order || "")) return { ok: false, reason: "人数或处理顺序无效" };
      var nowClaim = Date.now();
      var activeRecord = { runId: id, taskKey: msg.taskKey, due: nowClaim, tabId: sender.tab.id, startedAt: nowClaim,
        phase: "awaiting", phaseStartedAt: nowClaim, phaseDeadline: nowClaim + phaseTimeoutMs("awaiting"), snapshot: {
        taskKey: msg.taskKey, taskType: msg.taskKey, account: msg.account, count: options.count, order: options.order,
        batchLimit: limit, strictMode: settingsSnapshot.strictMode, excluded: settingsSnapshot.excluded, manual: true
      } };
      value[scheduledActiveKey] = activeRecord;
      await chrome.storage.local.set(value);
      await chrome.alarms.create(phaseWatchdogName, { when: activeRecord.phaseDeadline });
      return { ok: true, runId: id, batchLimit: limit, strictMode: settingsSnapshot.strictMode, excluded: settingsSnapshot.excluded };
    });
    queue = claim.catch(function () {});
    claim.then(respond, function () { respond({ ok: false, reason: "任务无法启动" }); });
    return true;
  }
  // XFM_COORD_*（含 NOTIFY 与 SCAN_START/END）已由上方第一个监听统一处理。
  // 此处若再兜底处理一次，同一条消息会进入串行队列两遍：多数操作恰好幂等，
  // 但执行锁/进度的 respond 会发生竞争，属于真实缺陷。这里必须保持“不处理”。
  return;
});
