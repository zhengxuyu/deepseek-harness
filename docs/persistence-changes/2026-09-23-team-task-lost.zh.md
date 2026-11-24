---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-23-team-task-lost

[English](2026-09-23-team-task-lost.md) | 中文

## 概述

新增 team/task payload 版本 3，携带仅由 harness 进入的 `lost` 任务状态及其 `lostCause`，并把版本 3 的任务声明为每个状态一个变体。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-team-task-lost
baseline: false
changes:
  - root: "event:team/task"
    previous: "2026-09-11-initial"
    after: "d2a2bb417550d2172dacd56001f089d1416a30120af43723a80d8caf8b43e591"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有的版本 2 team/task 记录仍然有效；版本 2 的声明保持四状态联合及其可选的 owner。版本 2 记录按其状态读成当前的对应变体：pending 记录上的 owner 被丢弃；没有 owner 的 in-progress 或 completed 记录被拒绝，已发布的构建从未写出过这种记录。新记录以版本 3 写入。其状态联合新增 `lost`，每个状态写明它带有的 owner 与 cause 字段：pending 两者都没有，in-progress 与 completed 必须有 owner，lost 必须有 owner 与 `lostCause`，deleted 可以保留 owner。带有其他状态字段的版本 3 记录被拒绝。只认识版本 2 的读取方遇到版本 3 记录会记录投影失败，而不会误读它。其他 Team event 保持版本 2。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team：119 个测试通过，包括版本 2 拒绝 lost 任务、版本 2 记录按状态保留的 owner、版本 3 对每个状态接受与拒绝的字段、被删除的 lost 任务的 tombstone，以及不受支持的版本 3 team/member 记录。

<a id="dev-note"></a>
## 开发备注

无。
