---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-notes-are-edges

[English](2026-09-24-notes-are-edges.md) | 中文

## 概述

为 team/task 增加 notes 与 holds。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-notes-are-edges
baseline: false
changes:
  - root: "event:team/task"
    previous: "2026-09-24-artifact-contracts"
    after: "d326c8ee74f16d57610cb3141f1df26048d42ec8b4be5e8a9ed95cbaf4b090bf"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有的 team/task 记录仍然有效：`notes` 与 `holds` 是可选字段，在所有更早的记录中都不存在，版本 2 的声明未变。新记录可以携带发送到该任务的 note（id、发送成员、文本）以及该任务上尚未确认的 hold（note id、note 所发往的任务、发送者），已完成的任务上绝不会出现 hold。早于这些字段的读取方会忽略它们。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team --coverage：全部测试通过且逐文件覆盖率 100%，包括 projection 的 note id 唯一与已完成任务无 hold 规则，以及 notes 与 holds 的回放。

<a id="dev-note"></a>
## 开发备注

无。
