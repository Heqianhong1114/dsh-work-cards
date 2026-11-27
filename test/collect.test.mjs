import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collect, stats, resetStats } from "../lib/collect.mjs";
import { makeEvents, writeSession, appendFrames, evt, tempHome } from "./gen.mjs";

function withHome(fn) {
  const home = tempHome();
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { return fn(home); } finally {
    process.env.DSH_HOME = prev;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { }
  }
}

const WS = "--C-test-workspace--";
const ID = "session-11111111-2222-3333-4444-555555555555";

test("冷读解析出卡片与标题", () => withHome((home) => {
  collect(6, { refresh: true });
  writeSession(path.join(home, "sessions"), WS, ID, makeEvents(4, ID, { title: "冷读测试" }));
  resetStats();
  const r = collect(6);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].title, "冷读测试");
  assert.equal(stats.coldLoads, 1);
}));

test("文件没变时命中缓存", () => withHome((home) => {
  writeSession(path.join(home, "sessions"), WS, ID, makeEvents(4, ID));
  collect(6, { refresh: true });
  resetStats();
  collect(6);
  collect(6);
  assert.equal(stats.coldLoads, 0);
  assert.equal(stats.tailLoads, 0);
  assert.ok(stats.cacheHits >= 2);
}));

test("追加一个帧只解析尾部，事件不重复", () => withHome((home) => {
  const file = writeSession(path.join(home, "sessions"), WS, ID, makeEvents(3, ID));
  const first = collect(6, { refresh: true });
  const before = first.cards[0].step;
  appendFrames(file, [evt("tool/call", { tool: "grep", args: JSON.stringify({ pattern: "x" }) })]);
  resetStats();
  const second = collect(6);
  assert.equal(stats.tailLoads, 1);
  assert.equal(stats.coldLoads, 0);
  assert.equal(second.cards[0].step, before + 1);
}));

test("半帧不前进，补齐后只多一条", () => withHome((home) => {
  const file = writeSession(path.join(home, "sessions"), WS, ID, makeEvents(2, ID));
  collect(6, { refresh: true });
  const buf = appendFrames(file, [evt("tool/call", { tool: "glob", args: "{}" })], { truncateLastByte: true });
  const mid = collect(6);
  const midStep = mid.cards[0].step;
  fs.appendFileSync(file, buf.subarray(Math.floor(buf.length / 2)));
  const done = collect(6);
  assert.equal(done.cards[0].step, midStep + 1);
}));

test("文件被截断重写时回退全量", () => withHome((home) => {
  const file = writeSession(path.join(home, "sessions"), WS, ID, makeEvents(5, ID));
  collect(6, { refresh: true });
  const fresh = makeEvents(2, ID, { title: "重写后" });
  writeSession(path.join(home, "sessions"), WS, ID, fresh);
  const r = collect(6);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].title, "重写后");
}));

test("refresh 会清空缓存重新全量", () => withHome((home) => {
  writeSession(path.join(home, "sessions"), WS, ID, makeEvents(2, ID));
  collect(6, { refresh: true });
  resetStats();
  collect(6, { refresh: true });
  assert.equal(stats.coldLoads, 1);
}));

test("12 小时没写入的会话被过滤", () => withHome((home) => {
  const old = new Date(Date.now() - 13 * 3600 * 1000);
  writeSession(path.join(home, "sessions"), WS, "session-old-0000", makeEvents(2, "session-old-0000"), { mtime: old });
  const r = collect(6, { refresh: true });
  assert.equal(r.cards.length, 0);
}));

test("多工作区都能出卡片", () => withHome((home) => {
  const root = path.join(home, "sessions");
  writeSession(root, "--ws-a--", "session-a", makeEvents(2, "session-a", { title: "A" }));
  writeSession(root, "--ws-b--", "session-b", makeEvents(2, "session-b", { title: "B" }));
  const r = collect(6, { refresh: true });
  assert.deepEqual(r.cards.map((c) => c.title).sort(), ["A", "B"]);
  assert.equal(new Set(r.cards.map((c) => c.workspace)).size, 2);
}));

test("子代理会话（delegationDepth > 0）被跳过", () => withHome((home) => {
  writeSession(path.join(home, "sessions"), WS, "session-sub", makeEvents(2, "session-sub", { depth: 1 }));
  const r = collect(6, { refresh: true });
  assert.equal(r.cards.length, 0);
}));

test("被用户终止的回合标记为 stopped", () => withHome((home) => {
  writeSession(path.join(home, "sessions"), WS, ID, makeEvents(2, ID, { endKind: "aborted" }));
  const r = collect(6, { refresh: true });
  assert.equal(r.cards[0].status, "stopped");
  assert.equal(r.cards[0].endKind, "aborted");
}));
