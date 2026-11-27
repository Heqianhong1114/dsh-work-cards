// 合成会话日志：把若干 JSON 事件按帧写入 session.v4.jsonl.zstd。
// 每个帧都是独立的 zstd 压缩块，解码后以 \n 结尾（与 DSH 真实日志一致）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export function frame(lines) {
  return zlib.zstdCompressSync(Buffer.from(lines.join("\n") + "\n", "utf8"));
}

export function evt(type, data, extra = {}) {
  return { type, time: Date.now(), data, ...extra };
}

export function makeEvents(count, sessionId, opts = {}) {
  const events = [
    { type: "session/meta", id: sessionId, time: Date.now() - 60000, delegationDepth: opts.depth || 0 },
    evt("session/title", { title: opts.title || "合成会话 " + sessionId.slice(-4) }),
    evt("turn/start", { turn: 1 }),
  ];
  for (let i = 0; i < count; i++) {
    events.push(evt("tool/call", { tool: "read", args: JSON.stringify({ file_path: `C:\\tmp\\f${i}.txt` }) }));
    events.push(evt("tool/result", { callId: "c" + i, ok: true }));
  }
  if (opts.end !== false) events.push(evt("turn/end", { turn: 1, reason: { kind: opts.endKind || "completed" } }));
  return events;
}

export function writeSession(root, ws, id, events, { frames = 1, mtime } = {}) {
  const dir = path.join(root, ws, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.v4.jsonl.zstd");
  const per = Math.max(1, Math.ceil(events.length / frames));
  const chunks = [];
  for (let i = 0; i < events.length; i += per) {
    chunks.push(frame(events.slice(i, i + per).map((e) => JSON.stringify(e))));
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

export function appendFrames(file, events, { truncateLastByte = false } = {}) {
  const buf = frame(events.map((e) => JSON.stringify(e)));
  if (truncateLastByte) {
    fs.appendFileSync(file, buf.subarray(0, Math.max(1, Math.floor(buf.length / 2))));
    return buf;
  }
  fs.appendFileSync(file, buf);
  return buf;
}

export function tempHome(prefix = "dsh-wc-test-") {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", prefix));
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  return root;
}
