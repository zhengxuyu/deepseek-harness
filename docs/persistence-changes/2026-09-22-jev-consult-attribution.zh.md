---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-22-jev-consult-attribution

[English](2026-09-22-jev-consult-attribution.md) | 中文

## 概述

新增仅用于归因的 `jev` 消息来源 kind，`/jev` 把它标记在注入 agent 的咨询通知上。该 kind 只携带通知形式及其一行摘要，并保持 Session 格式版本不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-jev-consult-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "c9e69823cdc9f748b98ba3c8991b739e69631baf1dde609107bb6c58874d783d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "48bae64c4f84ce2749b26385788b3700573d9d86993c755ab586079a3f910ca6"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "b0bcf7d757863f48d38899c30ab608ae55864200c09ef6296b2390a2a3c2fb1a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "d634b0e4a22f5525bb396007039f9625faeccbaf821ed8e42e011e3b2290b768"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

`jev` kind 以 `@persistenceAttribution` 标记：较旧的读取器会保留来源 kind 未知的 user 或 developer 消息及其 `form` 与 `summary` 元数据，并在没有 `dsh-command-jev` 的情况下由此派生历史。该 kind 不引入校验、回放或权限要求；生产者在恢复时从不检查它。由于没有新增、删除或改动任何事件、头部或信封字段，既有记录保持不变。

<a id="verification"></a>
## 验证

`pnpm exec tsx scripts/persistence-changes.ts --check` 把每个受影响的根分类为同版本下仅归因的来源 kind 新增，`pnpm run gen-persistence-catalog` 重新生成了目录与 schema。`dsh-command-jev` 单元套件固定了注入通知的来源，无密钥的 headless 与 Web 快照在发布的 profile 上回放了一次 `/jev` 咨询。

<a id="dev-note"></a>
## 开发备注

无。
