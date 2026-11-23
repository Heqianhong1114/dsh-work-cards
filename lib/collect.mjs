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

function decodeFrames(buf) {
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString("utf8")); } catch { }
  }
  return out.join("\n");
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
      try { files.push({ file: f, mtime: fs.statSync(f).mtimeMs, ws: path.basename(ws) }); } catch { }
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

function analyze(events, now) {
  let lastTurnStart = null, lastTodo = null, lastEvtTime = 0, pending = null, lastAssistant = false;
  let turnEndTime = null;
  let endKind = "";
  const results = new Set();
  const recent = [];
  let planRev = "";
  let prevTotal = 0;
  let prevSig = "";
  let planRevTime = 0;
  let callsThisTurn = 0;
  let curTurnKinds = [];
  const kindDurations = {};   // kind -> [ms]
  let lastTurnKind = null;

  for (const e of events) {
    if (!e || !e.type) continue;
    if (e.time) lastEvtTime = e.time;
    if (e.type === "turn/start") {
      lastTurnStart = e.time; lastTodo = null; pending = null; lastAssistant = false;
      turnEndTime = null; callsThisTurn = 0; curTurnKinds = []; planRev = ""; prevTotal = 0; prevSig = ""; planRevTime = 0;
    }
    if (e.type === "turn/end") {
      turnEndTime = e.time; pending = null;
      endKind = (e.data && e.data.reason && e.data.reason.kind) ? e.data.reason.kind : "";
      if (lastTurnStart && curTurnKinds.length) {
        const kind = curTurnKinds.slice().sort((a, b) => curTurnKinds.filter((x) => x === b).length - curTurnKinds.filter((x) => x === a).length)[0];
        const dur = e.time - lastTurnStart;
        if (dur > 500) {
          kindDurations[kind] = kindDurations[kind] || [];
          kindDurations[kind].push(dur);
          lastTurnKind = kind;
        }
      }
    }
    if (e.type === "todo/write") {
      const list = (e.data && e.data.todos) || [];
      lastTodo = { todos: list, time: e.time };
      const sig = list.map((x) => x.content).join("|");
      if (prevTotal > 0 && list.length !== prevTotal) { planRev = prevTotal + "→" + list.length; planRevTime = e.time; }
      else if (prevSig && sig !== prevSig) { planRev = "已更新"; planRevTime = e.time; }
      prevTotal = list.length; prevSig = sig;
    }
    if (e.type === "assistant/message") lastAssistant = true;
    if (e.type === "tool/call") {
      pending = e; lastAssistant = false; callsThisTurn++;
      const nm = (e.data && e.data.name) ? e.data.name : "工具";
      const rawArgs = e.data && e.data.arguments ? String(e.data.arguments) : "";
      const d = pickDetail(nm, e.data && e.data.arguments);
      const kind = classify(nm, rawArgs, d);
      curTurnKinds.push(kind);
      const hh = new Date(e.time);
      const tm = String(hh.getHours()).padStart(2, "0") + ":" + String(hh.getMinutes()).padStart(2, "0");
      recent.push({ t: tm, text: (VERB[nm] || CATEGORY_VERB[kind] || nm) + (d ? " " + d : "") });
      if (recent.length > 6) recent.shift();
    }
    if (e.type === "tool/result") { results.add(e.data.callId); if (pending && e.data.callId === pending.data.callId) pending = null; }
  }
  if (pending && results.has(pending.data.callId)) pending = null;

  const ended = turnEndTime != null && (lastTurnStart == null || turnEndTime >= lastTurnStart);
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
    if (endKind && endKind !== "completed") { status = "stopped"; activity = "已终止"; }
    else { status = "idle"; activity = "干完了"; }
  } else if (lastAssistant) {
    status = "thinking"; activity = "正在琢磨";
  } else if (lastTurnStart && lastEvtTime > lastTurnStart) {
    status = "thinking"; activity = "正在准备";
  }

  let done = 0, total = 0;
  if (lastTodo && lastTodo.todos.length) {
    total = lastTodo.todos.length;
    done = lastTodo.todos.filter((t) => t.status === "completed").length;
  }

  let elapsed = 0;
  if (lastTurnStart) {
    elapsed = ended ? Math.max(0, turnEndTime - lastTurnStart) : Math.max(0, now - lastTurnStart);
  }
  // 计划分支/回退后重新计时：从最近一次计划变更开始算
  let segmentStart = lastTurnStart;
  if (planRevTime && planRevTime > (lastTurnStart || 0)) segmentStart = planRevTime;
  const segmentElapsed = segmentStart ? Math.max(0, (ended ? turnEndTime : now) - segmentStart) : 0;

  // 进度：只在能确知时给
  let pct = null;
  if (total > 0) pct = done / total;
  if (ended) pct = 1;
  if (status === "waiting") pct = 1;

  // 预计用时：按"任务类型"的历史中位数，样本 >=3 才显示
  let eta = null, etaLow = null, etaHigh = null, etaKind = null, etaSamples = 0;
  const kinds = curTurnKinds.length ? curTurnKinds : (lastTurnKind ? [lastTurnKind] : []);
  if (kinds.length) {
    const counts = {};
    for (const k of kinds) counts[k] = (counts[k] || 0) + 1;
    etaKind = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const hist = kindDurations[etaKind] || [];
    etaSamples = hist.length;
    if (hist.length >= 3 && !ended) {
      const med = median(hist);
      const sorted = hist.slice().sort((a, b) => a - b);
      const p25 = sorted[Math.floor(sorted.length * 0.25)];
      const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
      eta = Math.max(0, Math.round(med - segmentElapsed));
      etaLow = Math.max(0, Math.round(p25 - segmentElapsed));
      etaHigh = Math.max(0, Math.round(p75 - segmentElapsed));
    }
  }

  const stuckMs = (status === "running" || status === "thinking") ? Math.max(0, now - lastEvtTime) : 0;
  return {
    status, activity, detail, done, total, eta, etaLow, etaHigh, etaKind, etaSamples,
    elapsed, lastEvtTime, ended, pct, stuckMs, planRev, endKind,
    step: callsThisTurn, turnStart: lastTurnStart, recent,
  };
}
export function collect(cardsMax = 6) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const sessionsRoot = path.join(home, "sessions");
  const now = Date.now();
  const logs = listLogs(sessionsRoot).slice(0, 24);
  const cards = [];
  for (const { file, ws } of logs) {
    let events;
    try { events = decodeFrames(fs.readFileSync(file)).split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { continue; }
    if (!events.length) continue;
    const head = events[0];
    if (head.delegationDepth > 0) continue;
    const info = analyze(events, now);
    if (now - info.lastEvtTime > 12 * 60 * 60 * 1000) continue; // 12 小时没动静才不显示，卡片由用户手动关闭
    cards.push({
      id: head.id,
      workspace: ws,
      title: sessionTitle(events),
      ...info,
    });
  }
  cards.sort((a, b) => b.lastEvtTime - a.lastEvtTime);
  return { ts: now, cards: cards.slice(0, cardsMax) };
}