---
description: "/jev 的浏览器投影，供调试 Jev 提问与回答如何出现在 Web transcript（文本记录）中的用户和维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jev

[English](README.md) | 中文

## 概述

`dsh-client-ui-jev` 把每条 `/jev` 提问显示为用户风格的气泡，并把 Jev 的最终回答渲染为来自 Jev 的消息，而非折叠的命令行。在挂载了 `dsh-command-jev` 的 Web 组合中选择它，这样在新会话上发起的咨询会激活对话，而不是藏在空白 hero 之下。它只投影持久的命令运行：没有模型消息、没有 store，也没有事件监听。仅当 `DSH_JEV_ENABLED=yes` 时才会挂载。

## 目录

- [概览](#overview)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="overview"></a>
## 概览

Jev 界面插件（浏览器端部分）。它通过自有的 Conversation Definition 投影每条持久化的 `/jev` `command/run`：在通用命令结果 Node 之前构建一个 `jev-command-input` Chat Node，由本插件的 keyed renderer 渲染为右对齐的用户样式气泡，气泡先显示变暗的 `/jev`，随后是原样输入的问题，使用本地化分组名称 `Question to Jev`／`向 Jev 提问`，且不含时间戳、复制或分支操作。它还注册命令视图插槽的 `jev` 条目，使命令的结算结果渲染为来自 Jev 的左对齐消息（发送者行 `Jev · 快思考队友`，随后是回答文本、失败文本，或运行未结束时的思考占位），而不是折叠的通用命令行。可见的非命令 Node 会激活新会话的 Chat，因此在第一条提示之前发起的咨询会显示问题和 Jev 的回答，而不是把页面留在空白的欢迎页；仅包含 `command/done` 的历史窗口只保留通用结果行。该投影只读取持久化的 run：不创建 `user/message`，不产生模型轮次，不持有 store，也不挂事件监听。命令本身归 [`dsh-command-jev`](../../jev/command-jev/README.zh.md) 所有。

`/client` 的导出接口包括插件本体（`apply`/`inject`）以及 Node 数据和 locale 键的类型。

不发布运行时不变量伴随插件；该插件只把持久的命令运行投影为展示，不拥有 store、监听器或事件。

<a id="model-experience"></a>
## 模型体验

无，因为该插件只把持久化的命令 run 投影为浏览器呈现；命令的模型可见通知归 `dsh-command-jev` 所有。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>
- **仅文本**——回答消息重复命令结算的那句话；概率不会渲染成图表，仅包含 `command/done` 的窗口只显示回答而没有问题。

<a id="dev-note"></a>
### 开发备注

无。
