---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-23-team-task-lost

[English](2026-09-23-team-task-lost.md) | 中文

## 概述

新增 team/task payload 版本 3，携带仅由 harness 进入的 `lost` 任务状态及其 `lostCause`。

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
    after: "cc80b86c80b0f4a334297abb4b6aa0398ef60abf81d54d3de632b37247458c4f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有的版本 2 team/task 记录仍然有效并按原样投影；版本 2 的声明保持四状态联合。新记录以版本 3 写入，其状态联合新增 `lost`，可选的 `lostCause` 恰在状态为 lost 时存在。只认识版本 2 的读取方遇到版本 3 记录会记录投影失败，而不会误读它。其他 Team event 保持版本 2。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team --coverage --coverage.include='packages/experimental/agent-team/src/**/*.ts'：93 个测试通过，逐文件 100% 覆盖，包括版本 2 拒绝 lost 任务、版本 3 的状态–原因一致性，以及不受支持的版本 3 team/member 记录。

<a id="dev-note"></a>
## 开发备注

无。
