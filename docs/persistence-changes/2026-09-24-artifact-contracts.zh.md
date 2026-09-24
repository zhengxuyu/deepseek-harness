---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-artifact-contracts

[English](2026-09-24-artifact-contracts.md) | 中文

## 概述

为 team/task 新增输出契约、记录的产物与边说明。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-artifact-contracts
baseline: false
changes:
  - root: "event:team/task"
    previous: "2026-09-23-member-turn-outcomes"
    after: "2ec38aab48aedd826f356fd89275ed1a525bb9a915c4df0af3e55cef86c87d06"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有的 team/task 记录仍然有效：`outputs`、`artifacts` 与 `edgeInstructions` 都是可选的，所有早期记录都没有它们，版本 2 的声明不变。新记录可以携带声明的输出契约、按 blocker 键控且键指向当前 blocker 的说明，以及只出现在 `completed` 变体上的、完成时记录的产物。早于这些字段的读取方会忽略它们。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team packages/bundle/headless：268 个测试通过，包括 projection 拒绝未完成任务上的产物、拒绝不指向 blocker 的说明，以及契约与产物的版本 3 回放。

<a id="dev-note"></a>
## 开发备注

无。
