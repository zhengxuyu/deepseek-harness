---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-23-member-turn-outcomes

[English](2026-09-23-member-turn-outcomes.md) | 中文

## 概述

新增 team/member payload 版本 3，携带成员最近一次回合的结果；lost 的被跟踪任务记录 owner 的 stop reason；新增 turn-continuation 提醒的归属。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-member-turn-outcomes
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-22-jev-consult-attribution"
    after: "f39a7491b02d505b28462f522bfc49799cf3eee35c70c72fe701c6470799c9da"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-22-jev-consult-attribution"
    after: "9078147d4cfb4cf7c279cd7782c59eb6c07de5d51a5c83d6c03f7ddcd0db4497"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-22-jev-consult-attribution"
    after: "8d737da518e6fcdf76d705af2a23673d46c724108ba6edd458c64d4d75467ae9"
    decision: same-version
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "27989ff93f248945ef82782308e267102e6bbeecdcee529a869f48d1af961498"
    decision: same-version
  - root: "event:team/task"
    previous: "2026-09-23-team-task-lost"
    after: "3effdd3101817efa6d603d8a62fdff3d2e2509272e1b0c36ec87ccd82e2f2469"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-22-jev-consult-attribution"
    after: "4a128b9c42f80e4fd947672025ffdfbff2fe616dc868d04664b2d638fe3bb9a1"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有的版本 2 team/member 记录仍然有效并按原样投影；版本 2 的声明保持不带 `lastStop` 的记录。新成员记录以版本 3 写入，active 成员每结束一个回合多一条只改变 `lastStop` 的记录。team/task 上可选的 `ownerStop` 只在 `owner-failed` 原因下出现，所有已有记录都没有它。`turn-continuation` 消息 source 仅用于归属：读取方在没有该生产者时也保留该提醒。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team packages/experimental/turn-continuation --coverage：127 个测试通过，逐文件 100% 覆盖，包括版本 2 拒绝带 lastStop 的成员记录、active 到 active 的结果转换、ownerStop 的原因规则，以及记入日志的继续提醒。

<a id="dev-note"></a>
## 开发备注

无。
