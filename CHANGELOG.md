# Changelog

## 1.0.1 — 2026-11-27

性能修复：DSH 启动变慢、空闲时 host 单核占用高的问题。

### 根因

`collect()` 每 450ms 在 DSH host 的 Node 主线程上同步执行：

- 读取最近 24 个 `session.v4.jsonl.zstd`
- 整文件解压 + 全量 `JSON.parse`
- 之后才用「12 小时没动静」把大部分会话丢掉

实测 24 个文件 / 11.3MB 压缩 / 35.8MB 解压 / 15,979 事件时，单次约 **353ms**，即主线程约 **78%** 被占用；主窗口要等 host `ready` 才能打开。

### 变更

- 采集前先按文件 `mtime` 过滤 12 小时窗口，再读文件（原来是读完解析完才过滤）
- 按 `路径 + size + mtime` 缓存解析结果；文件没变时直接复用
- 增量解析：会话日志是 append-only 的 zstd 帧序列，只解析文件尾部新增的完整帧；尾部半帧留到下一拍
- 事件增量喂入分析状态机，稳定状态下每拍只做 O(卡片数) 的收尾计算，不再遍历事件
- 默认刷新间隔 `intervalMs` 450 → **1000**
- 首次采集延后 1.5s，避免冷解析与 host 启动抢主线程
- `state.json` 写入加重试；内容没变时跳过写盘
- 「更新」按钮触发全量重读（清缓存）
- 运行时日志带上日期

### 基准（本机真实数据）

| 场景 | 1.0.0 | 1.0.1 |
|---|---|---|
| 冷读（首次） | 353ms 每 450ms | 220ms 一次（启动时延后执行） |
| 文件没变 | 353ms | **1.6ms** |
| 追加 1 个帧 | 353ms | **10ms** |
| 手动刷新 | 353ms | 52ms |

合成数据基准（`npm run bench`，26 个会话）：

```
cold            60.3ms
hot(no change)   0.9ms
append 1 frame  10.2ms
refresh         52.5ms
```

### 测试

新增 `test/collect.test.mjs`（10 个用例，覆盖冷读/缓存/追加/半帧/重写/刷新/12h 边界/多工作区/子代理/终止状态）和 `test/bench.mjs`（合成数据基准）、`test/bench-real.mjs`（本机真实会话对照）。

```powershell
npm test      # node --test test/collect.test.mjs
npm run bench # node test/bench.mjs
```
