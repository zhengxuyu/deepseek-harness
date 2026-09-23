---
description: "jev 包组：把 TypeSafe 的 System One 模型作为快思考队友，包含判断 seam、面向模型的 jev 工具与面向人的 /jev 命令，供选择或浏览该包族的读者使用。"
kind: "package-group"
---

# jev/ — Jev 判断能力家族

[English](README.md) | 中文

## 概述

jev 包组把 TypeSafe 的 System One 模型变成 harness 的快思考队友。agent 通过 `jev` 工具咨询它，用户通过 `/jev` 咨询它，答案会共享回 agent。`jev` 拥有 seam、请求与答案词汇以及 TypeSafe 传输；`tool-jev` 与 `command-jev` 是它的两个消费者。Jev 只返回经校准的类型化判断而非散文，且只看到各消费者发送的状态。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

Jev 是 [TypeSafe](https://typesafe.ai) 的 System One 模型：它读取提供的状态，返回经过校准的类型化判断（选出的选项、"是"的概率、有序等级上的评分），而不是文本。这个家族让 Jev 成为 harness 的快思考队友：agent（智能体）通过工具咨询它，用户通过斜杠命令咨询它，命令的答案会分享给 agent。

| 包 | 职责 | ctx key |
|---|---|---|
| [`jev/`](jev/README.zh.md) | 定义判断请求、答案和错误词汇，并把请求提交给 TypeSafe | `ctx.jev` |
| [`tool-jev/`](tool-jev/README.zh.md) | 以 `jev` 工具向模型公开 Jev | 注册到 `ctx.tools` |
| [`command-jev/`](command-jev/README.zh.md) | 以 `/jev` 向用户公开 Jev，并把咨询分享给 agent | 注册到 `ctx.commands` |

<a id="related-documentation"></a>
## 相关文档

seam 与其唯一的 TypeSafe 实现共用一个包，因为不存在第二个 System One 厂商可供拆分；[Jev 队友 Agent Note](../../.agents/notes/implemented/feature/2026-09-18-jev-fast-decision-teammate.zh.md) 负责说明这一选择及其余设计。

子系统参考——`JevRequest`、`JevResult`、`JevError`——见 [docs/subsystems/jev.md](../../docs/subsystems/jev.zh.md)。

<a id="dev-note"></a>
## 开发备注

无。
