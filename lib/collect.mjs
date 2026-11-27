// 读取 DSH 会话日志，算出每个活跃会话的「在干什么 / 粗进度 / 预计剩余」
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const logCache = new Map();

const VERB = {
  pwsh: "运行命令", bash: "运行命令", read: "读文件", write: "写文件", edit: "改文件",
  glob: "找文件", grep: "搜代码", web_search: "联网搜索", web_fetch: "抓网页",
  todo_write: "更新计划", subagent: "派子代理", subagent_fork: "派子代理",
  present: "交付文件", job_output: "看后台任务", job_list: "看后台任务",
  skill: "加载技能", schedule_create: "建定时任务", ask_user_question: "等你确认",
  load_workspace_dependencies: "找运行环境", working_directory: "切目录",
  list_agents: "看子代理", send_message: "发消息", wait_agent: "等子代理",
  job_kill: "停后台任务", update_goal: "更新目标", get_goal: "读目标",
  workflow: "跑工作流", create_goal: "建目标", plugin_manager: "管插件",
  read_image: "看图", office_render: "渲染文档",
};

// 会话日志是「连续的独立 zstd 帧」拼接，每个完整帧解码后都以 \n 结尾。
// 返回 { text, consumed }：consumed 只累计到最后一个完整帧的结尾，
// 尾部半帧（正在写入）留在文件里等下一拍，避免解析到截断的 JSON。
function decodeFrames(buf) {
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  const parts = [];
  let consumed = 0;
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(s, e)).toString("utf8");
    } catch {
      break; // 半帧或损坏帧：停在这里
    }
    if (!text.endsWith("\n")) break; // 行不完整，等下一拍
    parts.push(text);
    consumed = e;
  }
  return { text: parts.join(""), consumed };
}

function parseEvents(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

// events 上限：极长会话（几万条）只保留尾部，避免长期运行内存膨胀
const MAX_EVENTS = 50000;

function trimEvents(events) {
  if (events.length <= MAX_EVENTS) return events;
  return events.slice(events.length - MAX_EVENTS);
}

function short(s, n) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function pickDetail(tool, argsRaw) {
  let a = {};
  try { a = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw || {}; } catch { }
  if (tool === "pwsh" || tool === "bash") return short(a.description || a.command, 30);
  if (a.file_path) return short(path.basename(a.file_path), 24);
  if (a.pattern) return short(a.pattern, 20);
  if (a.query) return short(a.query, 24);
  if (a.queries) return short([].concat(a.queries)[0], 24);
  if (a.url) return short(a.url, 26);
  if (a.name) return short(a.name, 20);
  return "";
}

function listLogs(sessionsRoot) {
  const files = [];
  let dirs = [];
  try { dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return files; }
  for (const d of dirs) {
    const ws = path.join(sessionsRoot, d.name);
    let subs = [];
    try { subs = fs.readdirSync(ws, { withFileTypes: true }).filter((x) => x.isDirectory()); } catch { }
    for (const s of subs) {
      const f = path.join(ws, s.name, "session.v4.jsonl.zstd");
      try {
        const st = fs.statSync(f);
        files.push({ file: f, mtime: st.mtimeMs, size: st.size, ws: path.basename(ws) });
      } catch { }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

function sessionTitle(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "session/title" && e.data && e.data.title) return short(e.data.title, 18);
  }
  for (const e of events) {
    if (e.type === "user/message" && e.data && e.data.message) {
      const c = e.data.message.content;
      if (Array.isArray(c)) {
        const t = c.find((x) => x && x.type === "text");
        if (t && t.text) return short(t.text, 18);
      }
    }
  }
  return "未命名会话";
}

// 把工具调用翻译成"人话分类"
const RESEARCH = new Set(["web_search", "web_fetch"]);
const READING = new Set(["read", "glob", "grep", "read_image", "load_workspace_dependencies"]);
const WRITING = new Set(["write", "edit", "present"]);
const SHELL = new Set(["pwsh", "bash", "shell", "terminal"]);

function classify(name, argsRaw, desc) {
  if (RESEARCH.has(name)) return "research";
  if (READING.has(name)) return "reading";
  if (WRITING.has(name)) return "coding";
  if (name === "todo_write") return "plan";
  if (name === "ask_user_question") return "waiting";
  if (!SHELL.has(name)) return "other";
  const s = ((desc || "") + " " + (argsRaw || "")).toLowerCase();
  if (/pytest|npm (run )?test|vitest|jest|go test|cargo test|ctest|--test|测试|自测/.test(s)) return "testing";
  if (/gcc|clang|g\+\+|make |cmake|dotnet build|npm run build|pnpm build|tsc |vite build|cargo build|编译|构建/.test(s)) return "building";
  if (/pip install|npm i |npm install|pnpm add|yarn add|apt(-get)? install|winget install|choco install|安装|装依赖/.test(s)) return "install";
  if (/curl |wget |git clone|git push|git pull|ssh |scp |联网|搜索|抓取/.test(s)) return "network";
  if (/def |class |function |print\(|console\.log|import |写入|编辑|修改|生成/.test(s)) return "coding";
  if (/读取|查看|检查|分析|阅读|搜索文件/.test(s)) return "reading";
  return "shell";
}

const CATEGORY_VERB = {
  research: "在联网搜索",
  reading: "在翻文件",
  coding: "在写代码",
  testing: "在跑测试",
  building: "在构建",
  install: "在装依赖",
  network: "在联网操作",
  shell: "在运行命令",
  plan: "在列计划",
  waiting: "DSH 在等你",
  other: "在调用工具",
};

function median(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

// 增量分析状态机：事件只喂一次，稳态下每拍只做 finish（O(卡片数)）。
function newFeedState() {
  return {
    lastTurnStart: null, lastTodo: null, lastEvtTime: 0, pending: null, lastAssistant: false,
    turnEndTime: null, endKind: "", results: new Set(), recent: [], planRev: "",
    prevTotal: 0, prevSig: "", planRevTime: 0, callsThisTurn: 0, curTurnKinds: [],
    kindDurations: {}, lastTurnKind: null, seen: 0,
  };
}

function feedEvent(st, e) {
  if (!e || !e.type) return;
  st.seen++;
  if (e.time) st.lastEvtTime = e.time;
  if (e.type === "turn/start") {
    st.lastTurnStart = e.time; st.lastTodo = null; st.pending = null; st.lastAssistant = false;
    st.turnEndTime = null; st.callsThisTurn = 0; st.curTurnKinds = []; st.planRev = ""; st.prevTotal = 0; st.prevSig = ""; st.planRevTime = 0;
  }
  if (e.type === "turn/end") {
    st.turnEndTime = e.time; st.pending = null;
    st.endKind = (e.data && e.data.reason && e.data.reason.kind) ? e.data.reason.kind : "";
    if (st.lastTurnStart && st.curTurnKinds.length) {
      const counts = {};
      let best = "", bestN = -1;
      for (const k of st.curTurnKinds) {
        counts[k] = (counts[k] || 0) + 1;
        if (counts[k] > bestN) { bestN = counts[k]; best = k; }
      }
      const dur = e.time - st.lastTurnStart;
      if (dur > 500) {
        (st.kindDurations[best] || (st.kindDurations[best] = [])).push(dur);
        if (st.kindDurations[best].length > 50) st.kindDurations[best].shift();
        st.lastTurnKind = best;
      }
    }
  }
  if (e.type === "todo/write") {
    const list = (e.data && e.data.todos) || [];
    st.lastTodo = { todos: list, time: e.time };
    const sig = list.map((x) => x.content).join("|");
    if (st.prevTotal > 0 && list.length !== st.prevTotal) { st.planRev = st.prevTotal + "→" + list.length; st.planRevTime = e.time; }
    else if (st.prevSig && sig !== st.prevSig) { st.planRev = "已更新"; st.planRevTime = e.time; }
    st.prevTotal = list.length; st.prevSig = sig;
  }
  if (e.type === "assistant/message") st.lastAssistant = true;
  if (e.type === "tool/call") {
    st.pending = e; st.lastAssistant = false; st.callsThisTurn++;
    const nm = (e.data && e.data.name) ? e.data.name : "工具";
    const rawArgs = e.data && e.data.arguments ? String(e.data.arguments) : "";
    const d = pickDetail(nm, e.data && e.data.arguments);
    const kind = classify(nm, rawArgs, d);
    st.curTurnKinds.push(kind);
    if (st.curTurnKinds.length > 200) st.curTurnKinds.shift();
    const hh = new Date(e.time);
    const tm = String(hh.getHours()).padStart(2, "0") + ":" + String(hh.getMinutes()).padStart(2, "0");
    st.recent.push({ t: tm, text: (VERB[nm] || CATEGORY_VERB[kind] || nm) + (d ? " " + d : "") });
    if (st.recent.length > 6) st.recent.shift();
  }
  if (e.type === "tool/result") {
    st.results.add(e.data.callId);
    if (st.results.size > 4000) st.results.clear();
    if (st.pending && e.data.callId === st.pending.data.callId) st.pending = null;
  }
}

function finishFeed(st, now) {
  const pending = st.pending;
  if (pending && st.results.has(pending.data.callId)) {
    // 结果已到但状态没更新（少见）：清掉
  }
  const ended = st.turnEndTime != null && (st.lastTurnStart == null || st.turnEndTime >= st.lastTurnStart);
  let status = "idle", activity = "空闲", detail = "";
  if (pending && pending.data.name === "ask_user_question") {
    status = "waiting"; activity = "DSH 在等你";
  } else if (pending) {
    status = "running";
    const nm = pending.data.name;
    const rawArgs = pending.data.arguments ? String(pending.data.arguments) : "";
    detail = pickDetail(nm, pending.data.arguments);
    activity = CATEGORY_VERB[classify(nm, rawArgs, detail)] || "在调用工具";
  } else if (ended) {
    if (st.endKind && st.endKind !== "completed") { status = "stopped"; activity = "已终止"; }
    else { status = "idle"; activity = "干完了"; }
  } else if (st.lastAssistant) {
    status = "thinking"; activity = "正在琢磨";
  } else if (st.lastTurnStart && st.lastEvtTime > st.lastTurnStart) {
    status = "thinking"; activity = "正在准备";
  }

  let done = 0, total = 0;
  if (st.lastTodo && st.lastTodo.todos.length) {
    total = st.lastTodo.todos.length;
    for (const t of st.lastTodo.todos) if (t.status === "completed") done++;
  }

  let elapsed = 0;
  if (st.lastTurnStart) {
    elapsed = ended ? Math.max(0, st.turnEndTime - st.lastTurnStart) : Math.max(0, now - st.lastTurnStart);
  }
  // 计划分支/回退后重新计时：从最近一次计划变更开始算
  let segmentStart = st.lastTurnStart;
  if (st.planRevTime && st.planRevTime > (st.lastTurnStart || 0)) segmentStart = st.planRevTime;

  // 进度：只在能确知时给
  let pct = null;
  if (total > 0) pct = done / total;
  if (ended) pct = 1;
  if (status === "waiting") pct = 1;

  // 预计用时：按"任务类型"的历史中位数，样本 >=3 才显示
  let eta = null, etaLow = null, etaHigh = null, etaKind = null, etaSamples = 0;
  let med = null, p25 = null, p75 = null;
  const kinds = st.curTurnKinds.length ? st.curTurnKinds : (st.lastTurnKind ? [st.lastTurnKind] : []);
  if (kinds.length) {
    const counts = {};
    for (const k of kinds) counts[k] = (counts[k] || 0) + 1;
    etaKind = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const hist = st.kindDurations[etaKind] || [];
    etaSamples = hist.length;
    if (hist.length >= 3 && !ended) {
      med = median(hist);
      const sorted = hist.slice().sort((a, b) => a - b);
      p25 = sorted[Math.floor(sorted.length * 0.25)];
      p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
      const segElapsed = segmentStart ? Math.max(0, now - segmentStart) : 0;
      eta = Math.max(0, Math.round(med - segElapsed));
      etaLow = Math.max(0, Math.round(p25 - segElapsed));
      etaHigh = Math.max(0, Math.round(p75 - segElapsed));
    }
  }

  const stuckMs = (status === "running" || status === "thinking") ? Math.max(0, now - st.lastEvtTime) : 0;
  return {
    status, activity, detail, done, total, eta, etaLow, etaHigh, etaKind, etaSamples,
    elapsed, lastEvtTime: st.lastEvtTime, ended, pct, stuckMs, planRev: st.planRev, endKind: st.endKind,
    step: st.callsThisTurn, turnStart: st.lastTurnStart, recent: st.recent.slice(),
  };
}

function analyze(events, now) {
  const st = newFeedState();
  for (const e of events) feedEvent(st, e);
  return finishFeed(st, now);
}

function buildState(events) {
  const st = newFeedState();
  for (const e of events) feedEvent(st, e);
  return st;
}

function loadFull(file, mtime, size) {
  const { text, consumed } = decodeFrames(fs.readFileSync(file));
  const events = trimEvents(parseEvents(text));
  const head = events[0] || {};
  return {
    mtime, size, consumed, events,
    st: buildState(events),
    title: sessionTitle(events),
    sessionId: head.id,
    depth: Number(head.delegationDepth) || 0,
  };
}

// 只读文件尾部新增的字节；起点必须正好是帧头，否则说明文件被重写/压缩，回退全量。
function loadTail(file, entry, mtime, size) {
  const len = size - entry.consumed;
  if (len <= 0) return null;

  const fd = fs.openSync(file, "r");
  let buf;
  try {
    buf = Buffer.allocUnsafe(len);
    const got = fs.readSync(fd, buf, 0, len, entry.consumed);
    buf = buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }

  if (buf.length < 4) return null;
  if (buf[0] !== 0x28 || buf[1] !== 0xb5 || buf[2] !== 0x2f || buf[3] !== 0xfd) return null;

  const { text, consumed } = decodeFrames(buf);
  if (consumed === 0) { // 还没有完整的新帧
    entry.mtime = mtime;
    entry.size = size;
    return entry;
  }
  if (text) {
    const added = parseEvents(text);
    if (added.length) {
      entry.events = trimEvents(entry.events.concat(added));
      if (entry.events.length >= MAX_EVENTS) entry.st = buildState(entry.events);
      else for (const e of added) feedEvent(entry.st, e);
    }
  }
  entry.consumed += consumed;
  entry.mtime = mtime;
  entry.size = size;
  return entry;
}

// 供测试/基准读取的运行时统计
export const stats = { coldLoads: 0, tailLoads: 0, cacheHits: 0, rewrites: 0, skipped: 0 };
export function resetStats() {
  stats.coldLoads = 0; stats.tailLoads = 0; stats.cacheHits = 0; stats.rewrites = 0; stats.skipped = 0;
}

export function collect(cardsMax = 6, options = {}) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const sessionsRoot = path.join(home, "sessions");
  const now = Date.now();
  const cutoff = now - 12 * 60 * 60 * 1000;
  if (options.refresh) logCache.clear();

  // 先按文件 mtime 过滤，再读：12 小时没写过的会话不可能有新活动，
  // 旧实现是读完、解压、全量 parse 之后才过滤，等于每拍把过期大日志重算一遍。
  const logs = listLogs(sessionsRoot).filter((x) => x.mtime >= cutoff).slice(0, 24);
  const cards = [];
  const active = new Set();

  for (const { file, ws, mtime, size } of logs) {
    active.add(file);
    let entry = logCache.get(file);

    try {
      if (!entry || size < entry.size || (size === entry.size && mtime !== entry.mtime)) {
        // 首次 / 被截断 / 原地重写：全量
        if (entry) stats.rewrites++;
        entry = loadFull(file, mtime, size);
        stats.coldLoads++;
        logCache.set(file, entry);
      } else if (size > entry.size) {
        const next = loadTail(file, entry, mtime, size);
        if (next === null) {
          entry = loadFull(file, mtime, size);
          stats.coldLoads++;
        } else {
          entry = next;
          stats.tailLoads++;
        }
        logCache.set(file, entry);
      } else {
        stats.cacheHits++; // size / mtime 都没变，直接复用
      }
    } catch {
      logCache.delete(file); // 被占用或损坏：本拍跳过，下拍重试
      stats.skipped++;
      continue;
    }

    const events = entry.events;
    if (!events.length) continue;
    if (entry.depth > 0) continue;

    // 事件喂进增量状态后，每拍只做一次 finish（O(1)，与事件数无关）
    const info = finishFeed(entry.st, now);
    if (now - info.lastEvtTime > 12 * 60 * 60 * 1000) continue;
    cards.push({
      id: entry.sessionId,
      workspace: ws,
      title: entry.title,
      ...info,
    });
  }

  // 只保留 12h 窗口内的缓存，避免长期运行内存只增不减
  for (const file of logCache.keys()) if (!active.has(file)) logCache.delete(file);

  cards.sort((a, b) => b.lastEvtTime - a.lastEvtTime);
  return { ts: now, cards: cards.slice(0, cardsMax) };
}