/**
 * core.js — 纯逻辑层（无 UI、无网络、无存储）
 *
 * 职责：
 *  1. 从 X 页面 DOM 中解析「用户行」，判定关注关系；
 *  2. 提供选择 / 批次规划 / 完整性自检等纯函数；
 *  3. 全部函数接受 root 或路径作为参数，便于在 Node + jsdom 中测试。
 *
 * 设计原则：宁可判为「未知」，也不猜测「未回关」。判定失败必须留下 reason。
 */
(function initXfmCore(global) {
  "use strict";

  if (global.XFMCore) return;

  /* ------------------------------------------------------------------ */
  /* 常量                                                                */
  /* ------------------------------------------------------------------ */

  var REL = {
    MUTUAL: "mutual",   // 双向：关注页里=对方回关了我；粉丝页里=我回关了他
    ONE_WAY: "one-way", // 我关注了对方，对方未回关（清理候选）
    PENDING: "pending", // 对方关注了我，我没回关（回关候选）
    UNKNOWN: "unknown"  // 无法可靠判定
  };

  // 页面模式：关注页=清理单向关注；粉丝页=回关粉丝
  var MODE = { CLEANUP: "cleanup", REPLY: "reply" };

  // X 的保留路径，不能当作账号 handle
  var RESERVED_HANDLES = new Set([
    "home", "explore", "notifications", "messages", "compose", "search",
    "settings", "i", "account", "tos", "privacy", "login", "logout",
    "signup", "following", "followers", "jobs", "premium", "verified",
    "download", "intent", "share", "hashtag", "rules", "about"
  ]);

  var HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

  var SEL = {
    userCell: '[data-testid="UserCell"]',
    userName: '[data-testid="User-Name"]',
    followIndicator: '[data-testid="userFollowIndicator"]',
    unfollowSuffix: '[data-testid$="-unfollow"]',
    followSuffix: '[data-testid$="-follow"]:not([data-testid$="-unfollow"])',
    primaryColumn: '[data-testid="primaryColumn"]',
    progressbar: '[role="progressbar"]',
    alert: '[role="alert"]'
  };

  // 「关注了你」标记文本：简中 / 繁中 / 英文。X 可能因界面语言不同而变化。
  var FOLLOWS_YOU_TEXTS = new Set([
    "Follows you", "关注了你", "追蹤你", "追踪你", "关注你"
  ]);

  // 取关按钮文本（含 hover 态 Unfollow）
  var UNFOLLOW_TEXTS = new Set([
    "Following", "正在关注", "取消关注", "Unfollow", "正在跟隨", "跟隨中", "追蹤中"
  ]);

  // 关注按钮文本
  var FOLLOW_TEXTS = new Set(["Follow", "关注", "跟隨", "追踪"]);

  var LIMITS = {
    minBatch: 1,
    maxBatch: 200,
    defaultBatch: 50,
    maxSelectInput: 5000
  };

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function normalizeHandle(value) {
    if (typeof value !== "string") return null;
    var trimmed = value.trim().replace(/^@/, "").toLowerCase();
    if (!HANDLE_RE.test(trimmed)) return null;
    if (RESERVED_HANDLES.has(trimmed)) return null;
    return trimmed;
  }

  /**
   * 从 href 解析账号 handle。
   * 只接受形如 /handle 或 /@handle 的单段路径，避免把 /handle/status/123 误判。
   */
  function handleFromHref(href, base) {
    if (typeof href !== "string" || href.length === 0) return null;
    var path;
    try {
      path = new URL(href, base || "https://x.com").pathname;
    } catch (err) {
      return null;
    }
    var segments = path.split("/").filter(Boolean);
    if (segments.length !== 1) return null;
    return normalizeHandle(segments[0]);
  }

  /**
   * 解析 /<handle>/following 路径。
   * 同时兼容 /i/user/<id>/following 这种自己账号的另一种形式。
   * @returns {{handle: string|null, raw: string}|null}
   */
  function parseFollowingPath(pathname) {
    if (typeof pathname !== "string") return null;
    var match = /^\/([A-Za-z0-9_]{1,15})\/following\/?$/.exec(pathname);
    if (match) {
      var handle = normalizeHandle(match[1]);
      if (!handle) return null;
      return { handle: handle, raw: pathname };
    }
    var idMatch = /^\/i\/user\/(\d+)\/following\/?$/.exec(pathname);
    if (idMatch) {
      return { handle: null, userId: idMatch[1], raw: pathname };
    }
    return null;
  }

  /**
   * 解析 /<handle>/followers 路径。
   */
  function parseFollowersPath(pathname) {
    if (typeof pathname !== "string") return null;
    var match = /^\/([A-Za-z0-9_]{1,15})\/followers\/?$/.exec(pathname);
    if (match) {
      var handle = normalizeHandle(match[1]);
      if (!handle) return null;
      return { handle: handle, raw: pathname };
    }
    var idMatch = /^\/i\/user\/(\d+)\/followers\/?$/.exec(pathname);
    if (idMatch) return { handle: null, userId: idMatch[1], raw: pathname };
    return null;
  }

  function parseProfileHandle(pathname) {
    if (typeof pathname !== "string") return null;
    var match = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(pathname);
    return match ? normalizeHandle(match[1]) : null;
  }

  function isFollowingPath(pathname) {
    return parseFollowingPath(pathname) !== null;
  }

  function textOf(el) {
    return el && typeof el.textContent === "string" ? el.textContent.trim() : "";
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    // jsdom 没有布局，getClientRects 为空；仅在真实浏览器中做尺寸判断
    if (typeof el.getClientRects === "function") {
      var rects = el.getClientRects();
      if (rects && rects.length === 0 && typeof el.getBoundingClientRect === "function") {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 单行解析                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 提取账号 handle。优先 User-Name 区域，其次全单元格频次。
   */
  function extractHandle(cell) {
    if (!cell) return null;
    var userName = cell.querySelector(SEL.userName);
    if (userName) {
      var links = userName.querySelectorAll('a[href^="/"]');
      for (var i = 0; i < links.length; i += 1) {
        var handle = handleFromHref(links[i].getAttribute("href"));
        if (handle) return handle;
      }
    }
    // 兜底：同一单元格内指向同一 handle 的链接通常出现多次（头像 + 昵称）
    var frequency = new Map();
    var all = cell.querySelectorAll('a[href^="/"]');
    for (var j = 0; j < all.length; j += 1) {
      var h = handleFromHref(all[j].getAttribute("href"));
      if (h) frequency.set(h, (frequency.get(h) || 0) + 1);
    }
    if (frequency.size === 0) return null;
    var sorted = Array.from(frequency.entries()).sort(function (a, b) { return b[1] - a[1]; });
    // 只在前两名频次不同时才采信，避免歧义
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null;
    return sorted[0][0];
  }

  function extractDisplayName(cell, handle) {
    if (!cell) return handle ? "@" + handle : "";
    var scope = cell.querySelector(SEL.userName) || cell;
    var spans = scope.querySelectorAll("span");
    for (var i = 0; i < spans.length; i += 1) {
      var span = spans[i];
      // 只取叶子节点，避免拿到整行拼接文本
      if (span.children && span.children.length > 0) continue;
      var text = textOf(span);
      if (!text) continue;
      if (text.charAt(0) === "@") continue;
      if (FOLLOWS_YOU_TEXTS.has(text)) continue;
      if (text === "·") continue;
      if (/^\d+[smhd]$/.test(text)) continue;
      return text.slice(0, 80);
    }
    return handle ? "@" + handle : "";
  }

  /**
   * 取头像地址。只读页面里已有的图片，不发额外请求。
   * X 的头像在 pbs.twimg.com/profile_images/...，同一条目里可能还有徽章图，
   * 因此优先匹配 profile_images，其次取尺寸最大的 img。
   */
  function extractAvatar(cell) {
    if (!cell || typeof cell.querySelectorAll !== "function") return "";
    var imgs = cell.querySelectorAll("img");
    var fallback = "";
    for (var i = 0; i < imgs.length; i += 1) {
      var src = imgs[i].getAttribute("src") || "";
      if (!src) continue;
      if (src.indexOf("profile_images") !== -1) return src;
      if (!fallback) fallback = src;
    }
    return fallback;
  }

  /**
   * 判断「关注了你」标记。
   * @returns {{value: boolean, source: "testid"|"text"|"none"}}
   */
  function detectFollowsYou(cell) {
    if (!cell) return { value: false, source: "none" };
    if (cell.querySelector(SEL.followIndicator)) {
      return { value: true, source: "testid" };
    }
    var spans = cell.querySelectorAll("span");
    for (var i = 0; i < spans.length; i += 1) {
      var text = textOf(spans[i]);
      if (text && FOLLOWS_YOU_TEXTS.has(text)) {
        return { value: true, source: "text" };
      }
    }
    return { value: false, source: "none" };
  }

  /**
   * 查找该行的关注/取关按钮。
   * @returns {{el: Element, kind: "unfollow"|"follow", source: string}|null}
   */
  function findActionButton(cell) {
    if (!cell) return null;

    var unfollow = cell.querySelector(SEL.unfollowSuffix);
    if (unfollow) return { el: unfollow, kind: "unfollow", source: "testid" };

    var follow = cell.querySelector(SEL.followSuffix);
    if (follow) return { el: follow, kind: "follow", source: "testid" };

    // 文本兜底：X 改版可能调整 data-testid，但按钮文案相对稳定
    var candidates = cell.querySelectorAll('[role="button"], button');
    var i;
    for (i = 0; i < candidates.length; i += 1) {
      var t = textOf(candidates[i]);
      if (t && UNFOLLOW_TEXTS.has(t)) {
        return { el: candidates[i], kind: "unfollow", source: "text" };
      }
    }
    for (i = 0; i < candidates.length; i += 1) {
      var t2 = textOf(candidates[i]);
      if (t2 && FOLLOW_TEXTS.has(t2)) {
        return { el: candidates[i], kind: "follow", source: "text" };
      }
    }

    // aria-label 兜底
    var labeled = cell.querySelectorAll('[aria-label]');
    for (i = 0; i < labeled.length; i += 1) {
      var label = labeled[i].getAttribute("aria-label") || "";
      if (/^(Following|正在关注|取消关注|Unfollow)\b/i.test(label)) {
        return { el: labeled[i], kind: "unfollow", source: "aria" };
      }
    }
    return null;
  }

  /**
   * 读取单个用户行。
   * 判定优先级：结构完整 → 是否关注我 → 未回关。
   * 任一必要条件缺失即判 UNKNOWN，绝不猜测。
   */
  function readUserCell(cell) {
    var handle = extractHandle(cell);
    var indicator = detectFollowsYou(cell);
    var action = findActionButton(cell);
    var record = {
      handle: handle,
      name: extractDisplayName(cell, handle),
      avatar: extractAvatar(cell),
      relation: REL.UNKNOWN,
      reason: "",
      indicator: indicator.value,
      indicatorSource: indicator.source,
      actionKind: action ? action.kind : "none",
      actionSource: action ? action.source : "none",
      element: cell || null
    };

    if (!handle) {
      record.reason = "missing-handle";
      return record;
    }
    if (!action) {
      record.reason = "missing-action-button";
      return record;
    }
    if (action.kind !== "unfollow") {
      // 出现在「正在关注」列表，按钮却是「关注」→ 页面数据已变化，不能据此判定
      record.reason = "not-following-now";
      return record;
    }
    if (indicator.value) {
      record.relation = REL.MUTUAL;
      record.reason = "ok";
      return record;
    }
    record.relation = REL.ONE_WAY;
    record.reason = "ok";
    return record;
  }

  /**
   * 读取粉丝列表中的一行。
   * 粉丝页的关注关系靠按钮判断：按钮为「正在关注」= 我已回关；为「关注」= 我还没回关。
   */
  function readFollowerCell(cell) {
    var handle = extractHandle(cell);
    var action = findActionButton(cell);
    var record = {
      handle: handle,
      name: extractDisplayName(cell, handle),
      avatar: extractAvatar(cell),
      relation: REL.UNKNOWN,
      reason: "",
      indicator: false,
      indicatorSource: "none",
      actionKind: action ? action.kind : "none",
      actionSource: action ? action.source : "none",
      element: cell || null
    };

    if (!handle) { record.reason = "missing-handle"; return record; }
    if (!action) { record.reason = "missing-action-button"; return record; }

    if (action.kind === "unfollow") {
      record.relation = REL.MUTUAL;   // 我已经关注了对方，无需操作
      record.reason = "ok";
    } else {
      record.relation = REL.PENDING;  // 对方关注了我，我没回关
      record.reason = "ok";
    }
    return record;
  }

  /**
   * 收集指定范围内的所有用户行，按首次出现顺序返回，handle 去重。
   * @param {Document|Element} scope
   * @returns {{rows: Array, skipped: number}}
   */
  function collectRows(scope, mode) {
    var rows = [];
    var skipped = 0;
    if (!scope || typeof scope.querySelectorAll !== "function") {
      return { rows: rows, skipped: skipped };
    }
    var reader = mode === MODE.REPLY ? readFollowerCell : readUserCell;
    var seen = new Set();
    var cells = scope.querySelectorAll(SEL.userCell);
    for (var i = 0; i < cells.length; i += 1) {
      var record = reader(cells[i]);
      if (!record.handle) {
        skipped += 1;
        continue;
      }
      if (seen.has(record.handle)) continue;
      seen.add(record.handle);
      rows.push(record);
    }
    return { rows: rows, skipped: skipped };
  }

  /**
   * 合并扫描结果：新行追加，旧行更新关系（DOM 复用 / 状态可能变化）。
   * @param {Map<string, object>} store
   * @param {Array<string>} order
   * @param {Array} incoming
   * @returns {{added: number, updated: number, order: Array<string>}}
   */
  function mergeRows(store, order, incoming) {
    var added = 0;
    var updated = 0;
    for (var i = 0; i < incoming.length; i += 1) {
      var row = incoming[i];
      if (!row || !row.handle) continue;
      var existing = store.get(row.handle);
      if (!existing) {
        store.set(row.handle, {
          handle: row.handle,
          name: row.name,
          avatar: row.avatar || "",
          relation: row.relation,
          reason: row.reason,
          indicatorSource: row.indicatorSource,
          actionKind: row.actionKind,
          order: order.length,
          lastSeenAt: Date.now()
        });
        order.push(row.handle);
        added += 1;
      } else {
        if (existing.relation !== row.relation) updated += 1;
        existing.relation = row.relation;
        existing.reason = row.reason;
        existing.name = row.name || existing.name;
        existing.avatar = row.avatar || existing.avatar || "";
        existing.indicatorSource = row.indicatorSource;
        existing.actionKind = row.actionKind;
        existing.lastSeenAt = Date.now();
      }
    }
    return { added: added, updated: updated, order: order };
  }

  function rowsInOrder(store, order) {
    var out = [];
    for (var i = 0; i < order.length; i += 1) {
      var row = store.get(order[i]);
      if (row) out.push(row);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 统计与规划                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {string} [candidateRel] 候选关系：清理模式为 one-way，回关模式为 pending
   */
  function countStats(rows, selected, candidateRel) {
    var want = candidateRel || REL.ONE_WAY;
    var stats = { total: rows.length, mutual: 0, oneWay: 0, unknown: 0, selected: 0 };
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (row.relation === REL.MUTUAL) stats.mutual += 1;
      else if (row.relation === want) stats.oneWay += 1;
      else stats.unknown += 1;
      if (selected && selected.has(row.handle) && row.relation === want) {
        stats.selected += 1;
      }
    }
    return stats;
  }

  /**
   * 自动选择候选。
   *
   * 默认取「最早的一批」（列表末尾）：X 的关注/粉丝列表都是最新在前，
   * 刚建立关系的人可能还没反应过来回关，先处理老的更稳。
   * 传 preferOldest=false 才会取最新的一批。
   */
  function planAutoSelect(rows, requestedCount, excludedSet, candidateRel, preferOldest) {
    var count = sanitizeCount(requestedCount, LIMITS.defaultBatch);
    var want = candidateRel || REL.ONE_WAY;
    var pool = [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].relation !== want) continue;
      if (excludedSet && excludedSet.has(rows[i].handle)) continue;
      pool.push(rows[i]);
    }
    var oldest = preferOldest !== false;
    var picked = oldest ? pool.slice(Math.max(0, pool.length - count)) : pool.slice(0, count);
    return {
      picked: picked,
      poolSize: pool.length,
      requested: count,
      oldestFirst: oldest,
      shortfall: Math.max(0, count - pool.length)
    };
  }

  /**
   * 批次规划：超上限的部分必须留在「未处理」，不得静默扩大。
   * 被排除的账号即使被选中，也不会进入执行队列。
   */
  function planBatch(rows, selected, limit, excludedSet, candidateRel) {
    var safeLimit = sanitizeBatchLimit(limit);
    var want = candidateRel || REL.ONE_WAY;
    var chosen = [];
    var excluded = [];
    var blocked = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!selected || !selected.has(row.handle)) continue;
      if (excludedSet && excludedSet.has(row.handle)) {
        blocked.push(row);
        continue;
      }
      if (row.relation === want) chosen.push(row);
      else excluded.push(row);
    }
    return {
      batch: chosen.slice(0, safeLimit),
      deferred: chosen.slice(safeLimit),
      excluded: excluded,
      blocked: blocked,
      limit: safeLimit,
      eligible: chosen.length
    };
  }

  function sanitizeCount(value, fallback) {
    var n = typeof value === "number" ? value : parseInt(String(value), 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    if (n > LIMITS.maxSelectInput) return LIMITS.maxSelectInput;
    return Math.floor(n);
  }

  function sanitizeBatchLimit(value) {
    var n = typeof value === "number" ? value : parseInt(String(value), 10);
    if (!Number.isFinite(n)) return LIMITS.defaultBatch;
    if (n < LIMITS.minBatch) return LIMITS.minBatch;
    if (n > LIMITS.maxBatch) return LIMITS.maxBatch;
    return Math.floor(n);
  }

  /* ------------------------------------------------------------------ */
  /* 定位相关的纯函数                                                    */
  /* ------------------------------------------------------------------ */

  // 双向搜索的步数上限：每次跳跃按「距离」折算步数，这里只是兜底刹车，
  // 真实关注列表可达 2500+ 条 / 27 万像素，20 步的旧上限连 7% 都覆盖不到
  var SEEK_LIMITS = { up: 60, down: 60 };

  /**
   * 根据目标序号与当前视口内可见行的序号范围，算出该往哪走、还差多少行。
   * 用「局部行高 × 行数差」估算像素距离，比全局平均行高准得多，
   * 而且每次跳跃后都会用新的视口重新估算，自我修正。
   *
   * @param {{targetIdx:number, minIdx:number, maxIdx:number, minY:number, maxY:number, rowHeight:number}} opts
   * @returns {{direction:"up"|"down"|"inside"|"unknown", rowsAway:number, estY:number|null}}
   */
  function planSeekTarget(opts) {
    var o = opts || {};
    var unknown = { direction: "unknown", rowsAway: 0, estY: null };
    if (!Number.isFinite(o.targetIdx) || !Number.isFinite(o.minIdx) || !Number.isFinite(o.maxIdx)) return unknown;
    var rowH = Number.isFinite(o.rowHeight) && o.rowHeight > 0 ? o.rowHeight : 84;
    if (o.targetIdx > o.maxIdx) {
      var down = o.targetIdx - o.maxIdx;
      return {
        direction: "down",
        rowsAway: down,
        estY: Number.isFinite(o.maxY) ? Math.round(o.maxY + down * rowH) : null
      };
    }
    if (o.targetIdx < o.minIdx) {
      var up = o.minIdx - o.targetIdx;
      return {
        direction: "up",
        rowsAway: up,
        estY: Number.isFinite(o.minY) ? Math.round(o.minY - up * rowH) : null
      };
    }
    // 序号落在渲染窗口内，行却不在：虚拟列表跳过了这一段，需要小步挪动
    return { direction: "inside", rowsAway: 0, estY: null };
  }

  /**
   * 根据当前视口内可见行的 orderIndex，推断目标在视口的上方还是下方。
   * 全部小于目标 → 目标在下方；全部大于目标 → 目标在上方；
   * 目标落在区间内但没被找到（行间隙/虚拟列表未渲染）→ 无法判断。
   * @param {number[]} viewportIdxs 视口内各行的 orderIndex
   * @param {number} targetIdx 目标的 orderIndex
   * @returns {"up"|"down"|"unknown"}
   */
  function inferDirection(viewportIdxs, targetIdx) {
    if (!Number.isFinite(targetIdx)) return "unknown";
    var list = Array.isArray(viewportIdxs) ? viewportIdxs : [];
    var min = Infinity;
    var max = -Infinity;
    for (var i = 0; i < list.length; i += 1) {
      if (!Number.isFinite(list[i])) continue;
      if (list[i] < min) min = list[i];
      if (list[i] > max) max = list[i];
    }
    if (min === Infinity) return "unknown";
    if (targetIdx > max) return "down";
    if (targetIdx < min) return "up";
    return "unknown";
  }

  /**
   * 计算某个方向还剩几步可走，用于步数熔断。
   * @param {"up"|"down"} direction
   * @param {number} steps 已走步数
   */
  function planSeekBounds(direction, steps) {
    var dir = direction === "up" ? "up" : "down";
    var cap = SEEK_LIMITS[dir];
    var used = Number.isFinite(steps) ? Math.max(0, Math.floor(steps)) : 0;
    return {
      direction: dir,
      cap: cap,
      used: used,
      left: Math.max(0, cap - used),
      exhausted: used >= cap
    };
  }

  /**
   * 合并行高样本：只保留合理区间（40~600px）的整数，超出上限时丢最旧的。
   */
  function mergeRowHeights(samples, incoming, max) {
    var out = Array.isArray(samples) ? samples.slice() : [];
    var list = Array.isArray(incoming) ? incoming : [];
    var limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 40;
    for (var i = 0; i < list.length; i += 1) {
      var h = Math.round(Number(list[i]));
      if (!Number.isFinite(h) || h < 40 || h > 600) continue;
      out.push(h);
    }
    if (out.length > limit) out = out.slice(out.length - limit);
    return out;
  }

  /**
   * 从样本里取一个稳健的行高：优先中位数（抗异常行），样本不足 3 个时向回退值收敛。
   */
  function pickRowHeight(samples, fallback) {
    var fb = Number.isFinite(fallback) && fallback > 0 ? fallback : 84;
    var list = [];
    var src = Array.isArray(samples) ? samples : [];
    for (var i = 0; i < src.length; i += 1) {
      if (Number.isFinite(src[i]) && src[i] >= 40 && src[i] <= 600) list.push(src[i]);
    }
    if (list.length === 0) return Math.round(fb);
    list.sort(function (a, b) { return a - b; });
    var mid = Math.floor(list.length / 2);
    var median = list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
    if (list.length < 3) return Math.round((median + fb) / 2);
    return Math.round(median);
  }

  /* ------------------------------------------------------------------ */
  /* 页面级自检                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 扫描完整性自检。
   *
   * 「关注了你」零标记阻断只适用于清理模式（关注列表）：如果 X 改版导致标记
   * 不再渲染，所有行都会被判为未回关，这是批量误取关的前兆。
   * 回关模式（粉丝列表）不能用这条规则：粉丝页上「你还没回关的人」占多数
   * 本身就是正常状态，比如刚开始玩 X、回关数为 0 的账号，会被误伤阻断。
   * 该保护可由用户在设置中显式关闭（关闭后仍显示警告）。
   */
  function evaluateIntegrity(rows, options) {
    var opts = options || {};
    var minSample = typeof opts.minSample === "number" ? opts.minSample : 15;
    var strict = opts.strict !== false;
    var want = opts.candidateRel || REL.ONE_WAY;   // 回关模式下候选是 pending，不能算未知
    var isReply = want === REL.PENDING;

    var total = rows.length;
    var mutual = 0;
    var unknown = 0;
    var oneWay = 0;
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].relation === REL.MUTUAL) mutual += 1;
      else if (rows[i].relation === want) oneWay += 1;
      else unknown += 1;
    }

    var warnings = [];

    if (!isReply && total >= minSample && mutual === 0) {
      warnings.push({
        code: "no-mutual-marker",
        severity: strict ? "block" : "warn",
        message:
          "已扫描 " + total + " 个账号，但没有检测到任何「关注了你」标记。可能是 X 页面结构变化，" +
          "也可能你确实没有回关者。请人工确认页面；确认无误后可在设置中关闭该校验。"
      });
    }

    if (total >= 10 && unknown / total > 0.5) {
      warnings.push({
        code: "high-unknown-ratio",
        severity: "block",
        message:
          "超过一半的账号无法判定关注关系（" + unknown + "/" + total + "）。" +
          "为避免误取关，已禁用批量操作。请刷新页面后重新扫描。"
      });
    }

    if (total > 0 && oneWay + mutual === 0) {
      warnings.push({
        code: "no-classified",
        severity: "block",
        message: "没有任何账号被成功判定关注关系，页面结构可能已变化。"
      });
    }

    return {
      total: total,
      mutual: mutual,
      oneWay: oneWay,
      unknown: unknown,
      warnings: warnings,
      blocked: warnings.some(function (w) { return w.severity === "block"; })
    };
  }

  /**
   * 排除名单三方合并（多标签页并发写保护）。
   *
   * 每个标签页都持有内存副本；保存设置若整份覆盖，就会用过期副本抹掉
   * 其他标签页刚加进来的保护项。以「本页上次同步的快照」为基准做合并：
   *  - 任一侧新增的账号都保留；
   *  - 只有一侧明确删除的账号按删除算（另一侧只是没动它）；
   *  - 两侧都没动的账号保留。
   * @param {string[]} base  上次同步的快照（没有就传空数组）
   * @param {string[]} ours  本页内存中的名单
   * @param {string[]} theirs 磁盘上刚读到的名单
   * @returns {string[]}
   */
  /**
   * 扫描进度行合并（多标签页同账号同列表并发写保护）。
   * 同一存储键被多个标签页写入：直接整份覆盖会用本页快照抹掉
   * 另一标签页扫到的账号。按 handle 并集合并：
   *  - 双方都有的行：以写入方（本页实时读取）为准；
   *  - 只有一方有的行：保留（另一标签页的扫描成果不丢）。
   * @param {Array<{h:string}>} existing 磁盘上已有的行
   * @param {Array<{h:string}>} incoming 本页要写入的行
   * @returns {Array<{h:string}>}
   */
  function mergeProgressRows(existing, incoming) {
    var out = [];
    var seen = {};
    var exMap = {};
    var ex = Array.isArray(existing) ? existing : [];
    var inc = Array.isArray(incoming) ? incoming : [];
    var i;
    for (i = 0; i < ex.length; i += 1) {
      if (ex[i] && typeof ex[i].h === "string" && ex[i].h) exMap[ex[i].h] = ex[i];
    }
    for (i = 0; i < inc.length; i += 1) {
      var row = inc[i];
      if (!row || typeof row.h !== "string" || !row.h || seen[row.h]) continue;
      seen[row.h] = true;
      out.push(row);
    }
    for (i = 0; i < ex.length; i += 1) {
      var e = ex[i];
      if (!e || typeof e.h !== "string" || !e.h || seen[e.h]) continue;
      seen[e.h] = true;
      out.push(e);
    }
    void exMap;
    return out;
  }

  /**
   * 进度写回决策（跨标签页协调服务调用）。
   * @param {object|null} existingEntry 该键当前条目：{rows:[...]} 或清除墓碑 {clearedAt}
   * @param {Array<{h:string}>} incomingRows 本页要写入的已扫行
   * @param {number} startedAt 本页本次扫描会话的开始时间
   * @param {number} now 当前时间
   * @returns {object|null} { rows, updatedAt } 写回条目；null = 跳过本次写回
   *
   * 规则：
   *  - 键上是清除墓碑、且清除发生在本页扫描开始之后 → 尊重丢弃，跳过写回
   *    （防止「丢弃/完成后」被另一标签页的在途写回复活）；
   *  - 否则与已有行按 handle 并集合并（另一标签页的扫描成果不丢）。
   */
  function resolveProgressWrite(existingEntry, incomingRows, startedAt, now) {
    if (existingEntry && existingEntry.clearedAt && !Array.isArray(existingEntry.rows)) {
      if ((existingEntry.clearedAt || 0) >= (startedAt || 0)) return null;
    }
    var existingRows = existingEntry && Array.isArray(existingEntry.rows) ? existingEntry.rows : [];
    var rows = mergeProgressRows(existingRows, incomingRows);
    return { rows: rows, updatedAt: now };
  }

  function mergeExcluded(base, ours, theirs) {
    var b = new Set(Array.isArray(base) ? base : []);
    var o = new Set(Array.isArray(ours) ? ours : []);
    var t = new Set(Array.isArray(theirs) ? theirs : []);
    var out = new Set();
    o.forEach(function (h) { if (typeof h === "string" && h) out.add(h); });
    t.forEach(function (h) { if (typeof h === "string" && h) out.add(h); });
    b.forEach(function (h) {
      var weDeleted = !o.has(h);
      var theyDeleted = !t.has(h);
      if (weDeleted !== theyDeleted) out.delete(h);
    });
    return Array.from(out);
  }

  /**
   * 定时周期实际生效的排除集合：启动快照 ∪ 运行中新增。
   * 只并集、不删减，保证运行中取消排除不会把已跳过的人重新拉回本周期。
   * 回关模式返回空数组（不套用清理排除名单）。
   */
  function mergeRunExcluded(snapshot, live, isReply) {
    if (isReply) return [];
    var out = new Set();
    [snapshot, live].forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (h) {
        if (typeof h === "string" && h) out.add(h);
      });
    });
    return Array.from(out);
  }

  /** 严格模式只允许收紧：快照或运行中任一开启即生效 */
  function strictModeForRun(snapshotStrict, liveStrict) {
    return snapshotStrict === true || liveStrict === true;
  }

  /**
   * 检测页面级异常（限制、验证码、加载失败）。
   */
  function detectPageIssues(root) {
    var doc = root || (typeof document !== "undefined" ? document : null);
    var issues = {
      loading: false,
      blocked: false,
      blockedReason: "",
      empty: false
    };
    if (!doc) return issues;

    var column = doc.querySelector(SEL.primaryColumn) || doc;

    // 加载指示器只认主列内的，避免侧边栏或其它区域的进度条造成误判
    if (column.querySelector(SEL.progressbar)) issues.loading = true;

    // 登录态失效：未登录时 X 会渲染登录入口，此时任何判定都不可信
    if (doc.querySelector('[data-testid="loginButton"], input[autocomplete="username"]')) {
      issues.blocked = true;
      issues.blockedReason = "登录状态可能已失效，请重新登录 X 后再试。";
      return issues;
    }

    // 验证码 / 身份验证
    if (doc.querySelector('iframe[src*="arkose"], iframe[src*="captcha"], #arkose')) {
      issues.blocked = true;
      issues.blockedReason = "页面出现人机验证，已中止操作。";
      return issues;
    }

    // 限流 / 错误提示可能以 toast 形式挂在 body 上，不能只查主列
    var alerts = doc.querySelectorAll(SEL.alert);
    var checked = 0;
    for (var i = 0; i < alerts.length && checked < 30; i += 1) {
      var text = textOf(alerts[i]);
      if (!text) continue;
      checked += 1;
      if (/rate limit|too many requests|temporarily limited|暂时受到限制|操作过于频繁|请求过于频繁/i.test(text)) {
        issues.blocked = true;
        issues.blockedReason = text.slice(0, 120);
        return issues;
      }
      if (/something went wrong|try reloading|出错了|出现问题|请重试/i.test(text)) {
        issues.blocked = true;
        issues.blockedReason = text.slice(0, 120);
        return issues;
      }
    }

    // 空列表提示（仅用于把「0 个结果」与「加载失败」区分开）
    var spans = column.querySelectorAll("span");
    for (var j = 0; j < spans.length && j < 4000; j += 1) {
      var t = textOf(spans[j]);
      if (!t || t.length > 80) continue;
      if (/aren't following anyone|not following anyone|还没有关注任何人|尚未关注任何人/i.test(t)) {
        issues.empty = true;
        break;
      }
    }
    return issues;
  }

  /* ------------------------------------------------------------------ */
  /* 导出                                                                */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* 定时任务调度计算                                                     */
  /* ------------------------------------------------------------------ */

  function parseHM(str) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
    if (!m) return null;
    var h = Number(m[1]), min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { h: h, m: min };
  }

  /* 每天按间隔：间隔单位固定为小时，允许 1–12 的整数。
     结束时间包含在计划内（09:00–21:00 / 4 小时 = 09:00、13:00、17:00、21:00）。
     不支持跨午夜：结束时间必须晚于开始时间，界面与后台都拒绝保存。 */
  var INTERVAL_MIN_HOURS = 1;
  var INTERVAL_MAX_HOURS = 12;

  function parseIntervalHours(value) {
    var n = Number(value);
    if (!Number.isInteger(n) || n < INTERVAL_MIN_HOURS || n > INTERVAL_MAX_HOURS) return null;
    return n;
  }

  /** 返回当天所有执行点的“分钟数”数组（升序，含结束点）；设置无效时返回 null */
  function intervalSlots(task) {
    if (!task) return null;
    var start = parseHM(task.dailyStart), end = parseHM(task.dailyEnd);
    var step = parseIntervalHours(task.intervalHours);
    if (!start || !end || step === null) return null;
    var begin = start.h * 60 + start.m, finish = end.h * 60 + end.m;
    if (finish <= begin) return null;
    var slots = [];
    for (var at = begin; at <= finish && slots.length < 48; at += step * 60) slots.push(at);
    return slots.length ? slots : null;
  }

  function nextIntervalLocal(task, from) {
    var slots = intervalSlots(task);
    if (!slots) return null;
    var now = new Date(from);
    for (var day = 0; day < 3; day += 1) {
      var baseY = now.getFullYear(), baseM = now.getMonth(), baseD = now.getDate() + day;
      for (var i = 0; i < slots.length; i += 1) {
        var h = Math.floor(slots[i] / 60), m = slots[i] % 60;
        var candidate = new Date(baseY, baseM, baseD, h, m, 0, 0);
        // 夏令时跳时：本地构造会归一化到别的时间，这种槽位当天不存在，跳过。
        if (candidate.getHours() !== h || candidate.getMinutes() !== m) continue;
        if (candidate.getTime() > from) return candidate.getTime();
      }
    }
    return null;
  }

  /** 统一的保存前校验；返回空字符串表示合法，否则返回可直接展示的原因 */
  function validateSchedule(task, from, options) {
    if (!task || typeof task !== "object") return "任务设置无效";
    if (["once", "daily", "weekly", "monthly", "interval"].indexOf(task.type) === -1) return "请选择执行周期";
    if (!Number.isInteger(task.count) || task.count < 1) return "每次人数无效";
    if (task.order !== "asc" && task.order !== "desc") return "请选择处理顺序";
    var requireFuture = !options || options.requireFuture !== false;
    if (task.type === "once") {
      if (!isFinite(Number(task.datetime)) || Number(task.datetime) <= 0) return "请选择执行时间";
      if (requireFuture && Number(task.datetime) <= from) return "请选择未来的执行时间";
      return "";
    }
    if (task.type === "daily") {
      return parseHM(task.time) ? "" : "时间格式无效";
    }
    if (task.type === "weekly") {
      if (!Number.isInteger(task.dayOfWeek) || task.dayOfWeek < 0 || task.dayOfWeek > 6) return "请选择星期";
      return parseHM(task.time) ? "" : "时间格式无效";
    }
    if (task.type === "monthly") {
      if (!Number.isInteger(task.dayOfMonth) || task.dayOfMonth < 1 || task.dayOfMonth > 31) return "日期需在 1–31 之间";
      return parseHM(task.time) ? "" : "时间格式无效";
    }
    var start = parseHM(task.dailyStart), end = parseHM(task.dailyEnd);
    if (!start || !end) return "开始或结束时间格式无效";
    if (end.h * 60 + end.m <= start.h * 60 + start.m) return "结束时间需晚于开始时间（暂不支持跨午夜）";
    if (parseIntervalHours(task.intervalHours) === null) return "间隔需为 1–12 的整数小时";
    return intervalSlots(task) ? "" : "时间范围或间隔无效";
  }

  function computeNextRun(task, from) {
    if (!task || !task.type) return null;
    if (task.type === "once") {
      var t = Number(task.datetime);
      return (isFinite(t) && t > from) ? t : null;
    }
    if (task.type === "interval") {
      if (!intervalSlots(task)) return null;
      if (task.timezone) return nextInTimezone(task, null, from);
      return nextIntervalLocal(task, from);
    }
    var hm = parseHM(task.time);
    if (!hm) return null;
    if (task.timezone) return nextInTimezone(task, hm, from);
    if (task.type === "daily") {
      return nextDaily(hm.h, hm.m, from);
    }
    if (task.type === "weekly" && typeof task.dayOfWeek === "number" && task.dayOfWeek >= 0 && task.dayOfWeek <= 6) {
      return nextWeekly(hm.h, hm.m, task.dayOfWeek, from);
    }
    if (task.type === "monthly" && typeof task.dayOfMonth === "number" && task.dayOfMonth >= 1 && task.dayOfMonth <= 31) {
      return nextMonthly(hm.h, hm.m, task.dayOfMonth, from);
    }
    return null;
  }

  // Ambiguous local times use the earlier occurrence; nonexistent DST times skip that cycle.
  function nextInTimezone(task, hm, from) {
    var formatter;
    try {
      formatter = new Intl.DateTimeFormat("en-GB", { timeZone: task.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      formatter.format(new Date(from));
    } catch (err) { return null; }
    function parts(ts) {
      var out = {};
      formatter.formatToParts(new Date(ts)).forEach(function (p) { if (p.type !== "literal") out[p.type] = Number(p.value); });
      return out;
    }
    function epoch(y, m, d, h, min) {
      var wanted = Date.UTC(y, m - 1, d, h, min);
      var offsets = new Set();
      [-172800000, 0, 172800000].forEach(function (delta) {
        var instant = wanted + delta;
        var p = parts(instant);
        offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - instant);
      });
      var choices = [];
      offsets.forEach(function (offset) {
        var value = wanted - offset, p = parts(value);
        if (p.year === y && p.month === m && p.day === d && p.hour === h && p.minute === min) choices.push(value);
      });
      return choices.length ? Math.min.apply(null, choices) : null;
    }
    var local = parts(from);
    var start = Date.UTC(local.year, local.month - 1, local.day);
    if (task.type === "interval") {
      var slots = intervalSlots(task);
      if (!slots) return null;
      for (var intervalDay = 0; intervalDay < 3; intervalDay++) {
        var slotDate = new Date(start + intervalDay * 86400000);
        for (var s = 0; s < slots.length; s++) {
          var slotWhen = epoch(slotDate.getUTCFullYear(), slotDate.getUTCMonth() + 1, slotDate.getUTCDate(), Math.floor(slots[s] / 60), slots[s] % 60);
          if (slotWhen !== null && slotWhen > from) return slotWhen;
        }
      }
      return null;
    }
    if (task.type === "daily") {
      for (var dailyDay = 0; dailyDay < 3; dailyDay++) {
        var dailyDate = new Date(start + dailyDay * 86400000);
        var dailyWhen = epoch(dailyDate.getUTCFullYear(), dailyDate.getUTCMonth() + 1, dailyDate.getUTCDate(), hm.h, hm.m);
        if (dailyWhen !== null && dailyWhen > from) return dailyWhen;
      }
      return null;
    }
    if (task.type === "weekly" && Number.isInteger(task.dayOfWeek) && task.dayOfWeek >= 0 && task.dayOfWeek <= 6) {
      for (var days = 0; days < 21; days++) {
        var date = new Date(start + days * 86400000);
        if (date.getUTCDay() !== task.dayOfWeek) continue;
        var when = epoch(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hm.h, hm.m);
        if (when !== null && when > from) return when;
      }
    }
    if (task.type === "monthly" && Number.isInteger(task.dayOfMonth) && task.dayOfMonth >= 1 && task.dayOfMonth <= 31) {
      for (var month = 0; month < 14; month++) {
        var first = new Date(Date.UTC(local.year, local.month - 1 + month, 1));
        var y = first.getUTCFullYear(), m = first.getUTCMonth() + 1;
        var day = Math.min(task.dayOfMonth, new Date(Date.UTC(y, m, 0)).getUTCDate());
        var result = epoch(y, m, day, hm.h, hm.m);
        if (result !== null && result > from) return result;
      }
    }
    return null;
  }

  function nextDaily(h, m, from) {
    var d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    if (d.getTime() > from && d.getHours() === h && d.getMinutes() === m) return d.getTime();
    // 该墙钟时刻今天不存在（夏令时跳时）：按目标日历日重新构造，
    // 不能沿用被归一化过的时刻——那会把下次执行带出 1 小时漂移。
    d.setDate(d.getDate() + 1);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  }

  function nextWeekly(h, m, dayOfWeek, from) {
    var d = new Date(from);
    d.setHours(h, m, 0, 0);
    var dayDiff = (dayOfWeek - d.getDay() + 7) % 7;
    if (dayDiff === 0 && d.getTime() <= from) dayDiff = 7;
    d.setDate(d.getDate() + dayDiff);
    if (d.getTime() > from && d.getHours() === h && d.getMinutes() === m) return d.getTime();
    // 目标日的该墙钟时刻不存在（夏令时跳时）：退一周并按日历日重新构造墙钟时间。
    d.setDate(d.getDate() + 7);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  }

  function nextMonthly(h, m, dayOfMonth, from) {
    var d = new Date(from);
    d.setHours(h, m, 0, 0);
    for (var attempt = 0; attempt < 13; attempt++) {
      var y = d.getFullYear(), mo = d.getMonth();
      var lastDay = new Date(y, mo + 1, 0).getDate();
      var day = Math.min(dayOfMonth, lastDay);
      var candidate = new Date(y, mo, day, h, m, 0, 0);
      if (candidate.getTime() > from && candidate.getHours() === h && candidate.getMinutes() === m) return candidate.getTime();
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(h, m, 0, 0);
    }
    return null;
  }

  function withinStartWindow(due, ts, windowMs) {
    return ts >= due && ts <= due + (windowMs || 5 * 60 * 1000);
  }

  global.XFMCore = {
    REL: REL,
    MODE: MODE,
    LIMITS: LIMITS,
    SELECTORS: SEL,
    FOLLOWS_YOU_TEXTS: FOLLOWS_YOU_TEXTS,
    UNFOLLOW_TEXTS: UNFOLLOW_TEXTS,
    FOLLOW_TEXTS: FOLLOW_TEXTS,
    normalizeHandle: normalizeHandle,
    handleFromHref: handleFromHref,
    parseFollowingPath: parseFollowingPath,
    parseFollowersPath: parseFollowersPath,
    parseProfileHandle: parseProfileHandle,
    isFollowingPath: isFollowingPath,
    extractHandle: extractHandle,
    extractDisplayName: extractDisplayName,
    extractAvatar: extractAvatar,
    extractAvatar: extractAvatar,
    detectFollowsYou: detectFollowsYou,
    findActionButton: findActionButton,
    readUserCell: readUserCell,
    readFollowerCell: readFollowerCell,
    collectRows: collectRows,
    mergeRows: mergeRows,
    rowsInOrder: rowsInOrder,
    countStats: countStats,
    planAutoSelect: planAutoSelect,
    planBatch: planBatch,
    sanitizeCount: sanitizeCount,
    sanitizeBatchLimit: sanitizeBatchLimit,
    SEEK_LIMITS: SEEK_LIMITS,
    inferDirection: inferDirection,
    planSeekBounds: planSeekBounds,
    planSeekTarget: planSeekTarget,
    mergeRowHeights: mergeRowHeights,
    pickRowHeight: pickRowHeight,
    evaluateIntegrity: evaluateIntegrity,
    mergeExcluded: mergeExcluded,
    mergeRunExcluded: mergeRunExcluded,
    strictModeForRun: strictModeForRun,
    mergeProgressRows: mergeProgressRows,
    resolveProgressWrite: resolveProgressWrite,
    detectPageIssues: detectPageIssues,
    isVisible: isVisible,
    textOf: textOf,
    parseHM: parseHM,
    computeNextRun: computeNextRun,
    intervalSlots: intervalSlots,
    parseIntervalHours: parseIntervalHours,
    validateSchedule: validateSchedule,
    INTERVAL_MIN_HOURS: INTERVAL_MIN_HOURS,
    INTERVAL_MAX_HOURS: INTERVAL_MAX_HOURS,
    withinStartWindow: withinStartWindow
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
