---
description: "面向人的 /jev 斜杠命令，供选择、组合或调试可共享回 agent 的 Jev 快速咨询的用户和维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-jev

[English](README.md) | 中文

## 概述

`dsh-command-jev` 让用户用 `/jev` 就最近的对话向 Jev 提出是否或多选问题，而不消耗模型回合。答案直接渲染在 UI 中，并作为有界通知注入 agent，因此 lead agent 能看到队友告诉用户的内容。在带有命令适配器且挂载了 `ctx.jev` 的交互式部署中选择它；语法错误、失败与超时不会注入任何内容。仅当 `DSH_JEV_ENABLED=yes` 时才会挂载。

## 目录

- [概览](#overview)
- [语法](#grammar)
- [配置](#config)
- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="overview"></a>
## 概览

面向用户的 `/jev` 命令：用户通过 [`ctx.jev`](../jev/README.zh.md) 就最近的对话咨询快思考的 System One 队友 Jev。答案直接在 UI 中渲染，同时作为插件通知注入接收的 agent（智能体），这样主导 agent 能看到队友告诉了用户什么。它是构建在[命令 registry](../../interaction/commands/README.zh.md) 之上的函数插件（`inject: ['commands', 'jev']`）。

<a id="grammar"></a>
## 语法

`/jev <question>` 询问一个是／否（noul）判断。`/jev <question> | <option> | <option> [| …]` 让 Jev 选出一个选项（choice）；中文键盘打出的全角 `｜` 同样可作分隔符。各段会被修剪；空问题、空选项、单个选项或重复选项会在发送任何内容之前以用法行拒绝。输入框提示为 `question | option | option`。

不发布运行时不变量伴随插件；该命令适配器不拥有事件流或投影，仅写日志的 `command/run` 与 `command/done` 配对归命令 registry 所有。

<a id="config"></a>
## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `contextMessages` | `12` | 作为状态包含的最新用户和助手消息数。 |
| `contextChars` | `16000` | 状态中会话字符数的上限；较旧的消息先被丢弃，唯一一条过长的最新消息保留其尾部。 |
| `timeoutMs` | `30000` | 答复截止时间，单位毫秒。 |

每个值都必须是正整数；否则在加载时失败。

<a id="behavior"></a>
## 行为

状态为 `{ question, conversation }`，其中 `conversation` 保存会话中最新的人类输入文本和模型输出文本，从旧到新，先按 `contextMessages` 再按 `contextChars` 限制；插件上下文、工具结果和无文本的工具调用轮次被排除。命令等待分发请求的信号或 `timeoutMs`，以先触发者为准。成功时渲染 `Jev picks "<option>" (<p>%); <other> <p>%, …. Confidence <c> (<model>).` 或 `Jev yes <p>%, no <p>% (<model>).`。seam 故障渲染 `Jev is unavailable (<code>): <message>`；超过截止时间渲染 `Jev did not answer within <ms> ms.`；调用方中止由 registry 以错误结算。命令 registry 追加仅记日志的 `command/run` 与 `command/done` 配对；命令本身绝不把输入变成用户消息。

<a id="model-experience"></a>
## 模型体验

### 共享的咨询通知

#### 模型看到的内容

一次成功咨询后，注入一条 user 角色消息，来源为 `{ kind: 'jev', form: 'notice' }`，其摘要为 `Jev consult: <question>`，受共享通知长度限制。其文本依次为 `The user consulted Jev, the fast-thinking System One teammate, about the recent conversation.`、`Question: <question>`、choice 时的 `Options: <a> | <b> | …`，以及 `Jev (<model>) answered: <用户看到的同一句话>.`。语法错误、seam 故障、超时和中止不注入任何内容。

#### Token 影响

每次成功咨询一条简短通知，在 agent 的下一个步骤边界被认领；空闲的 agent 会保留它直到用户的下一条消息将其唤醒。

#### KV Cache 影响

在可复用前缀之后仅追加；通知像其他任何注入上下文一样进入历史。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>
- **命令行不支持 score 问题**——语法覆盖是／否和 choice；有序等级评分通过 `jev` 工具提供。
- **仅最近文本**——附件、工具结果和文件内容不属于 Jev 看到的状态；请针对对话内容提问。
- **新会话依赖浏览器投影**——Web GUI 会把孤立的通用命令行藏在空白欢迎页之后，因此 [`dsh-client-ui-jev`](../../client/ui-jev/README.zh.md) 把问题投影为激活会话的 Chat Node；没有该插件的 Web 组合只有在会话已有其他内容时才显示 `/jev` 的回答。

<a id="dev-note"></a>
### 开发备注

无。
