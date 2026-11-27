// 基准：用合成数据测冷读 / 命中 / 尾部增量，不依赖个人会话历史。
// 用法：node test/bench.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, stats, resetStats } from "../lib/collect.mjs";
import { makeEvents, writeSession, appendFrames, evt } from "./gen.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wc-bench-"));
process.env.DSH_HOME = home;
const root = path.join(home, "sessions");

// 26 个会话：其中 2 个活跃（最近），24 个较旧但仍在 12h 内
const specs = [];
for (let i = 0; i < 26; i++) {
  const id = `session-${String(i).padStart(4, "0")}`;
  const events = makeEvents(i === 0 ? 4000 : 1200, id, { title: `基准会话 ${i}` });
  const mtime = i < 2 ? new Date() : new Date(Date.now() - (i + 1) * 60 * 1000);
  specs.push({ id, events, mtime });
}
for (const s of specs) writeSession(root, "--bench-ws--", s.id, s.events, { frames: 3, mtime: s.mtime });

const bytes = fs.readdirSync(path.join(root, "--bench-ws--"), { recursive: true })
  .filter((f) => String(f).endsWith(".zstd"))
  .reduce((n, f) => n + fs.statSync(path.join(root, "--bench-ws--", String(f))).size, 0);
console.log(`sessions=26 compressed=${(bytes / 1024 / 1024).toFixed(1)}MB`);

function time(label, fn) {
  const t = performance.now();
  const r = fn();
  console.log(`${label.padEnd(22)} ${(performance.now() - t).toFixed(1)}ms  cards=${r.cards.length}`);
  return r;
}

resetStats();
time("cold", () => collect(6, { refresh: true }));
console.log("  stats", JSON.stringify(stats));

resetStats();
time("hot(no change)", () => collect(6));
console.log("  stats", JSON.stringify(stats));

const activeFile = path.join(root, "--bench-ws--", specs[0].id, "session.v4.jsonl.zstd");
appendFrames(activeFile, [evt("tool/call", { tool: "read", args: JSON.stringify({ file_path: "C:\\a.txt" }) })]);
resetStats();
time("append 1 frame", () => collect(6));
console.log("  stats", JSON.stringify(stats));

const full = fs.readFileSync(activeFile);
fs.appendFileSync(activeFile, full.subarray(full.length - 120, full.length - 60)); // 半个帧
resetStats();
time("half frame", () => collect(6));
console.log("  stats", JSON.stringify(stats));

resetStats();
time("refresh", () => collect(6, { refresh: true }));

try { fs.rmSync(home, { recursive: true, force: true }); } catch { }
