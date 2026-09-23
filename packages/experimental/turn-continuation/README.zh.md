---
description: "当回合将以空消息、仅推理的消息或被输出上限截断的消息结束时让 Agent 继续，每回合的提醒次数有上限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-turn-continuation

[English](README.md) | 中文

## 概述

当无人值守的 Agent 不能停在一个「无事可做」的回合上时，挂载本插件。在回合的停止边界，它读取最后一条 assistant 消息：没有工具调用也没有文本的消息，或在设置了 `onMaxTokens` 时被输出上限截断的消息，会得到一条记入日志并 steer 回模型的提醒，每回合最多 `maxContinuations` 次。回合记录的结束原因不变，因此被截断的回合仍以 `max-tokens` 结束。代价是每条提醒多一次模型请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 profile 的 patch 层中把该行插入到 `dsh-base` 之后，并设置两个上限。

### 何时选择它

用于 headless 或基准测试运行：没有人会输入「继续」，仅推理的回复否则会让运行以空答案结束。交互式会话不需要它：由人来决定是否继续。进程中的每个 Agent 都被覆盖，包括子 Agent 与队友。

### 最小配置

```yaml
- insert:
    - id: turn-continuation
      name: '@deepseek-ai/dsh-experimental-turn-continuation'
      config:
        maxContinuations: 2
        onMaxTokens: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxContinuations` | 必填，至少 1 | 一个回合内最多发送多少条提醒，之后允许它按原样结束。 |
| `onMaxTokens` | 必填 | 被输出上限截断的消息是否也继续，而不只是空消息。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-turn-continuation)是所有可接受字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

插件监听 `agent/turn-stopping`，agent loop 在模型不再欠回复时派发它。它从 Session 日志读取该回合最新的 `assistant/message`：stream 中带 `max-tokens` 原因的 `finish` 块把它归为被截断；否则没有 `tool-call` 块且没有非空 `text` 块的消息归为空消息。两种情况下，在每回合上限之内，它调用 `agent.steer()` 发送一条 source 为 `{ kind: 'turn-continuation', reason, attempt, form: 'notice' }` 的用户消息；loop 随后再执行一步。上限按 Agent 与回合保存在内存中，也可以从日志中的 `attempt` 值读出。监听器顺序无关紧要：loop 在每个监听器之后重新读取收件箱。

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、分类器、提醒文本，以及 turn-stopping 监听器 |
| — | 不发布运行时 invariant 伴随插件；提醒是普通的记入日志的用户消息，回合边界由 loop 拥有。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Agent loop](../../core/agent-loop/README.zh.md)：turn-stopping 钩子与 steer 语义。
- [Headless 组合包](../../bundle/headless/README.zh.md)：本插件所防止的空最终答案所在的一次性运行器。
- [重复工具提醒](../../guard/repeat-tool-reminder/README.zh.md)：另一个建议性提醒插件，针对循环的工具调用。
- [实验性包](../README.zh.md)：孵化状态与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

### 继续提醒

#### 模型看到什么

空消息或仅推理的消息之后，Agent 收到第一条提醒；设置了 `onMaxTokens` 时，被输出上限截断的消息之后收到第二条。系统提示词与工具 schema 不受影响。

##### 空消息提醒

```markdown
Your previous message contained no tool call and no text, so nothing happened and the task is not finished. Continue: call a tool, or reply with your answer.
```

##### 输出上限提醒

```markdown
Your previous message was cut off at the output limit before it finished. Continue from where it stopped: call a tool, or reply with your answer, in fewer words.
```

#### Token 影响

回合停滞前为零 token。每条提醒成为该 Agent 的保留历史，并多消耗一次模型请求。

#### KV Cache 影响

仅追加；提醒位于可复用的请求前缀之后，不会使已有的 KV cache 条目失效。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

这些限制描述提醒能改变什么、不能改变什么。

- **持续推理的模型会用尽上限**：`maxContinuations` 条提醒之后回合按原样结束；插件不改变结束原因或运行器的退出码。
- **尚无 keyless snapshot**：提醒文本由包测试固定；录制回放场景需要一次真实的、会停滞的模型运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
