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
    after: "ed7e25aba4a4bbfd27d24e89d80bd1bc0172423427e959d503519ceb84564e6f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有的 team/task 记录仍然有效：`outputs`、`artifacts` 与 `edgeInstructions` 都是可选的，所有早期记录都没有它们，版本 2 的声明不变。新记录可以携带声明的输出契约、完成时记录的产物（只出现在已完成的任务上），以及按 blocker 键控、键指向当前 blocker 的说明。早于这些字段的读取方会忽略它们。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team --coverage：137 个测试通过，逐文件 100% 覆盖，包括 projection 的「产物只在已完成任务上」与「说明只指向 blocker」规则，以及契约与产物的版本 3 回放。

<a id="dev-note"></a>
## 开发备注

无。
