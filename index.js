import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
let collectFn = null;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 每 intervalMs 读一次会话日志，把状态写进 state.json，并看护一个 PowerShell 卡片管理器。
 * 管理器退出后下一拍自动重启；插件卸载时一起收掉。
 */
export function apply(ctx, config) {
  if (process.platform !== "win32") {
    // 卡片窗口依赖 Windows PowerShell + WPF；其它平台安静退出
    return;
  }
  const intervalMs = Math.max(200, Number(config?.intervalMs ?? 1000));
  const maxCards = Math.max(1, Number(config?.maxCards ?? 6));
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const dir = path.join(home, "work-cards");
  fs.mkdirSync(dir, { recursive: true });

  const statePath = path.join(dir, "state.json");
  const runnerPath = path.join(dir, "runner.ps1");

  const writeRunner = () => {
    let source = fs.readFileSync(path.join(here, "window.ps1"), "utf8");
    source = source.replace(/^\uFEFF/, "");
    fs.writeFileSync(runnerPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, "utf8")]));

  };
  writeRunner();

  let child = null;
  let stopped = false;
  let spawnFails = 0;
  let nextSpawnAt = 0;

  const noteError = (e) => {
    try {
      const p = path.join(dir, "plugin.err");
      try {
        if (fs.statSync(p).size > 256 * 1024) fs.writeFileSync(p, "");
      } catch { }
      fs.appendFileSync(p, new Date().toISOString() + " " + (e && e.stack || e) + "\n");
    } catch { }
  };

  const killStaleManager = () => {
    try {
      const hbPath = path.join(dir, "manager.hb");
      if (!fs.existsSync(hbPath)) return;
      const hb = JSON.parse(fs.readFileSync(hbPath, "utf8"));
      const pid = Number(hb && hb.pid);
      if (!pid || pid === process.pid) return;
      if (child && child.pid === pid) return;
      process.kill(pid, "SIGTERM");
    } catch { }
  };

  const killRecordedManager = () => {
    try {
      const hbPath = path.join(dir, "manager.hb");
      if (!fs.existsSync(hbPath)) return;
      const hb = JSON.parse(fs.readFileSync(hbPath, "utf8"));
      const pid = Number(hb && hb.pid);
      if (!pid || pid === process.pid) return;
      if (child && child.pid === pid) return;
      process.kill(pid, "SIGTERM");
    } catch { }
  };

  const managerAlive = () => {
    try {
      const hbPath = path.join(dir, "manager.hb");
      if (!fs.existsSync(hbPath)) return false;
      const hb = JSON.parse(fs.readFileSync(hbPath, "utf8"));
      if (!hb || !hb.ts || Date.now() - Number(hb.ts) > 4000) return false;
      process.kill(Number(hb.pid), 0);
      return true;
    } catch { return false; }
  };

  const startWindow = () => {
    if (stopped || child) return;
    if (Date.now() < nextSpawnAt) return;
    killRecordedManager();
    try {
      writeRunner();
      child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", runnerPath], {
        env: { ...process.env, DSH_WORK_CARDS_DIR: dir },
        windowsHide: true,
        stdio: "ignore",
        detached: false,
      });
      const startedAt = Date.now();
      child.on("exit", () => {
        child = null;
        if (!stopped && Date.now() - startedAt < 5000) {
          spawnFails++;
          nextSpawnAt = Date.now() + Math.min(30000, 1000 * Math.pow(2, spawnFails));
        } else {
          spawnFails = 0;
        }
      });
      child.on("error", (e) => { child = null; noteError(e); });
    } catch { child = null; }
  };

  const version = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
  let loadedVersion = null;
  let logCacheHint = false;
  let lastStateJson = "";

  // state.json 的写入：读方（PowerShell）可能正好在读取，rename 偶尔 EPERM；
  // 这里重试几次，内容没变则直接跳过写盘。
  const writeStateFile = (json) => {
    if (json === lastStateJson) return;
    const tmp = statePath + ".tmp";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(tmp, json, "utf8");
        fs.renameSync(tmp, statePath);
        lastStateJson = json;
        return;
      } catch (e) {
        if (attempt === 2) { noteError(e); return; }
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); } catch { }
      }
    }
  };

  const writeState = () => {
    try {
      if (loadedVersion !== version) {
        import(new URL(`./lib/collect.mjs?v=${version}`, import.meta.url).href)
          .then((m) => { collectFn = m.collect; loadedVersion = version; })
          .catch((e) => { noteError(e); });
        if (loadedVersion !== version) return;
      }
      const reqPath = path.join(dir, "refresh.req");
      if (fs.existsSync(reqPath)) {
        try { fs.unlinkSync(reqPath); } catch { }
        logCacheHint = true;
      }
      const state = collectFn(maxCards, { refresh: logCacheHint });
      logCacheHint = false;
      writeStateFile(JSON.stringify(state));
    } catch (e) { noteError(e); }
  };

  ctx.effect(() => {
    if (config?.todoReminder === false) return () => { };
    try {
      if (ctx.systemPrompt?.section) {
        return ctx.systemPrompt.section({
          name: "work-cards/todo-discipline",
          order: 9500,
          text: "Before starting any multi-step task, call todo_write once with the full plan, and keep it updated while you work: one item per concrete step, exactly one in_progress at a time, and mark an item completed as soon as it is done. The desktop work-card reads this list to show progress.",
        });
      }
    } catch { }
    return () => { };
  });

  ctx.effect(() => {
    startWindow();
    // 首拍延后：冷启动要解压解析历史日志，别和 host 自己的启动抢主线程
    const firstTick = setTimeout(writeState, 1500);
    const timer = setInterval(() => {
      if (!child) startWindow();
      writeState();
    }, intervalMs);
    return () => {
      stopped = true;
      clearTimeout(firstTick);
      clearInterval(timer);
      try { child?.kill(); } catch { }
      child = null;
      };
  });
}
