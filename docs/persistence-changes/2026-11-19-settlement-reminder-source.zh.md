---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-19-settlement-reminder-source

[English](2026-11-19-settlement-reminder-source.md) | 中文

## 概述

新增仅用于归属的消息来源 kind `agent-team-settlement`：当根 Agent 的回合已完成、而运行声明的产出仍未结算时，结算插件发给它的提醒带有该来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-19-settlement-reminder-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-23-member-turn-outcomes"
    after: "f68f6bcd4a80cb8e254770a60adb7b2dd94d2d9884b624d4bc6ff3c73cccb067"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-23-member-turn-outcomes"
    after: "22208a47bf9fb77d6ea7a00a7ae029082bde883787e4f4af684a058de1487f35"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-23-member-turn-outcomes"
    after: "636aaae3c1c75887030ae867eb09b8205342e3e86e7dc77bfbf220bd505ea416"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-23-member-turn-outcomes"
    after: "e05b0578f57d2d62e43494695137cbb6ed8892acd66f9bfc98d87ceb537ae6ed"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。该 kind 只标注一条用户消息的来源；不认识该生产方的读取方会保留这条提醒，没有任何校验、回放或授权依赖它。未挂载结算插件时写出的日志不会包含它。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team-settlement：15 个测试通过，其中包含对写入日志的提醒来源字段的断言。

<a id="dev-note"></a>
## 开发备注

无。
