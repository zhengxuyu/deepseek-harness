---
description: "面向模型的 jev 工具，供选择、限定或调试 agent 如何向 Jev 咨询经校准判断的用户和维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-jev

[English](README.md) | 中文

## 概述

`dsh-tool-jev` 以 `jev` 工具和一段固定的提示词区段把 Jev 暴露给模型，让 agent 在一次调用中对自己提供的状态提出经校准的选择、是否与评分问题。凡挂载了 `ctx.jev` 且 agent 应基于语义阅读快速决策的地方都可选择它；工具限定问题数量与状态大小，并把答案渲染为整数百分比的行。凭据、传输与答案校验由 seam 负责。

## 目录

- [概览](#overview)
- [配置](#config)
- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="overview"></a>
## 概览

面向模型的 `jev` 工具：agent（智能体）通过 [`ctx.jev`](../jev/README.zh.md) 咨询快思考的 System One 队友 Jev。该工具负责模型可见的名称、schema、提示词指引、schema DSL 无法表达的参数规则以及结果渲染；seam 负责凭据、传输和答案校验。它是函数插件（`inject: ['tools', 'jev', 'systemPrompt']`）。

不发布运行时不变量伴随插件；该工具只注册一个 schema，其释放由 HMR 安全规格证明，它写入的 `tool/call` 与 `tool/result` 配对归工具 registry 所有。

<a id="config"></a>
## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `30000` | 作为 `ToolDefinition.timeoutMs` 附加的协作式超时预算；由工具调用超时策略强制执行。 |
| `maxQuestions` | `16` | 一次调用中问题数的上限。 |
| `maxStateChars` | `64000` | 一次调用中序列化 `state` 字符数的上限。 |

每个值都必须是正整数；否则在加载时失败。

<a id="behavior"></a>
## 行为

生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-jev)负责确切的 schema。`state` 是字符串或对象；`questions` 是 `{ id, type, instructions, options?, levels? }` 的数组。在发起请求之前，工具会拒绝空列表、超过 `maxQuestions` 的问题数、重复 id、过大的状态、没有 `options` 或带 `levels` 的 `choice`、带任一者的 `noul`、没有 `levels` 或带 `options` 的 `score`，以及既非字符串也非 null 的选项描述；随后由 seam 自身的规则（选项和等级数量、空白文本）拒绝。答案按请求中的问题顺序作为规范值 `{ model, answers: [{ id, ...answer }], usage }` 返回，渲染文本每个答案一行，概率取整数百分比，confidence 保留两位小数。seam 故障是携带 `JevError` 代码的结构化工具错误。待处理卡片是覆盖原始参数的通用 `Ask Jev` 卡片。

<a id="model-experience"></a>
## 模型体验

### 工具指引区段

#### 模型看到的内容

位于集中分配的 `TOOL_JEV` 序号（2500，在 goal 工具指引之后）的 `tool:jev` 提示词区段：

##### `tool:jev` 区段原文

```markdown
Jev is a fast-thinking teammate available through the `jev` tool: a System One model that returns calibrated judgments instead of prose. Consult it for quick decisions that hinge on reading rather than lookup or computation; put every fact the judgment needs in `state`, ask independent questions together, and treat the returned probabilities and confidence as signals to threshold on — a low-confidence answer on a consequential decision is a reason to gather more evidence or ask the user, not to guess. You keep responsibility for exact facts, calculations, and the final decision.
```

#### Token 影响

插件挂载期间每次请求固定开销。

#### KV Cache 影响

前缀稳定：文本是常量，不会使跨请求复用失效；挂载或卸载插件只改变一次前缀。

### 工具 schema

#### 模型看到的内容

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-jev)中的 `jev` schema；`questions` 的描述携带配置的 `maxQuestions`。

#### Token 影响

插件挂载期间每次请求固定开销。

#### KV Cache 影响

在 `maxQuestions` 固定时前缀稳定；改变该值会改变 schema 文本，并使前缀改变一次。

### 工具结果

#### 模型看到的内容

`Jev (<model>) answered:` 之后每个答案一行：`- <id> (choice): <choice> — <option> <p>%, …; confidence <c>`、`- <id> (noul): yes <p>%` 或 `- <id> (score): <score> on 0–<top> — <index> "<level>" <p>%, …; confidence <c>`。被拒绝的调用显示拒绝原因；seam 故障显示 `JevError` 消息。

#### Token 影响

随问题、选项和等级的数量增长；概率为整数百分比，每个等级描述重复一次。

#### KV Cache 影响

在可复用前缀之后仅追加。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>
- **Jev 只看到 `state`**——工具不发送任何会话历史，模型必须重述判断所需的事实；这让请求保持有界，判断可复现。
- **输出 schema 中选项和等级概率是开放对象**——DSL 无法为数值型记录定型，因此 Code Mode 把 `probabilities` 和 `legend` 读作 `Record<string, JsonValue>`。
- **没有 confidence 门槛**——工具返回每个答案；阈值属于调用模型或策略监听器，而不是这里的固定数字。

<a id="dev-note"></a>
### 开发备注

无。
