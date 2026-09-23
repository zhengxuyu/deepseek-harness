---
description: "在委派的 Team 任务完成前保持 headless 运行存活，用 deadline 与停滞窗口限定等待，并把运行放弃的工作记录为 lost。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team-settlement

[English](README.md) | 中文

## 概述

当一次性的 `dsh --profile headless` 运行把工作委派给队友或子 Agent、且不能在这些工作结算前退出时，挂载本包。它在 Agent Teams 任务板之上提供运行器可选的 `ctx.headlessSettlement`：只要有任务处于 `in_progress`，运行就继续；结算中的子 Agent 可以再次唤醒根 Agent 执行一个回合；到 deadline 或停滞后仍未完成的任务会在任务板上标记为 `lost`，并在 stderr 上报告、以非零退出。代价是等待本身，由两个必填窗口限定。

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

在 headless profile 的 patch 层中把它挂载在 `agent-team` 旁边，并提供两个窗口。

### 何时选择它

用于无人值守的运行（例如基准测试）：根 Agent 可能在子 Agent 仍在运行时结束回合，而退出码必须说明每个委派任务是否完成。交互式会话不需要它：队友保持可恢复，进程边界上没有需要结算的东西。没有它时，headless 运行器在根回合结束时就退出，无论根 Agent 委派了什么。

### 最小配置

```yaml
- insert:
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config:
        trackSubagentRuns: true
    - id: agent-team-settlement
      name: '@deepseek-ai/dsh-experimental-agent-team-settlement'
      config:
        deadlineMs: 3600000
        stallMs: 120000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `deadlineMs` | 必填 | 根回合首次结束后经过多少毫秒，把所有仍在进行中的任务标记为 lost。 |
| `stallMs` | 必填，10000 到 3600000 | 在没有任务 owner 运行时，Team 多少毫秒没有任何变化后把剩余任务标记为 lost。 |

`agent-team` 上的 `trackSubagentRuns` 让普通的 `subagent` 委派出现在任务板上；没有它时只跟踪成员认领的任务。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team-settlement)是所有可接受字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`settle(root)` 循环执行：等待根 Agent idle，通过 `TeamService.outstandingTasks` 列出任务板上未结算的任务，没有时返回。否则等待下一次 Team 变化：有 owner 在运行时等到剩余的 deadline，没有时等 `stallMs`。停滞超时或 deadline 到期时，对每个剩余任务调用 `TeamService.markLost(root, id, 'run-ended')`，并为每个标记的任务返回一行；期间被其 owner 完成的任务既不会被标记也不会被报告。运行器把每一行打印为 `dsh: unsettled: <row>` 并以非零退出。lost 任务保留其 owner 记录；之后恢复的 Lead 通过 `reopen` 恢复它们。插件 dispose 会中止进行中的等待。

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、结算循环，以及 `ctx.headlessSettlement` 提供方 |
| — | 不发布运行时 invariant 伴随插件；本插件请求的每个转换都由 Team 服务自身的 projection 校验。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Headless 组合包](../../bundle/headless/README.zh.md)：消费 `ctx.headlessSettlement` 并把报告映射为退出码的运行器。
- [Agent Teams 服务](../agent-team/README.zh.md)：`lost`、`outstandingTasks`、`markLost` 与 `trackSubagentRuns`。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)：持久 Team 类型与服务 API。
- [实验性包](../README.zh.md)：孵化状态与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

无，因为结算只在任务板上等待并把任务标记为 lost，不向任何模型请求添加内容；根 Agent 看到的只是其子 Agent 与队友本来就会发送的结算通知与 peer 消息。

#### KV Cache 影响

无；本插件不向任何请求前缀添加内容。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

这些限制描述结算等待能观察到什么、不能观察到什么。

- **deadline 与停滞只按墙钟计时**：没有按任务的预算，也没有比一次 Team 变化更细的进度概念；长时间运行却不触碰任务板的子 Agent 只要处于 `running` 就会让运行一直存活。
- **进程外子 Agent 在结束前都视为运行中**：从不进入 agent 注册表的 provider 承载的子 Agent 无法被观察到 idle，因此只有它的 `subagent/end` 或 deadline 能结算它的任务。
- **尚无 keyless snapshot**：组装后的插件由包测试与 headless 运行器的 seam 测试覆盖；录制回放场景需要一次真实的委派模型运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
