---
description: "把 headless 运行的任务记录到 Team 任务板上，在它与委派的 Team 任务完成前保持运行存活，用 deadline 与停滞窗口限定整个运行，在 deadline 停下队友，并报告运行没有收回的每个任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team-settlement

[English](README.md) | 中文

## 概述

当 `dsh --profile headless` 运行把工作委派给队友或子 Agent、且不能在这些工作结算前退出时，挂载本包。它在 Agent Teams 任务板之上提供运行器的 `ctx.headlessSettlement`：运行的任务是根 Agent 名下的 `in_progress` 任务；只要根 Agent 处于回合中或有任务处于 `in_progress`，运行就继续。到 deadline 时根 Agent 被取消，正在运行的队友被中断；此时或停滞后仍在进行中的工作会被标记为 `lost`。运行创建或改动过、但没有完成的每个任务都会被报告，并以非零退出。

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
        stopGraceMs: 30000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `deadlineMs` | 必填，1 到 2147483647 | 运行开始后经过多少毫秒，取消根 Agent 的回合、中断每个正在运行的队友，并把所有仍在进行中的任务标记为 lost。 |
| `stallMs` | 必填，10000 到 3600000 | 在没有任务 owner 运行时，Team 多少毫秒没有任何变化后把剩余任务标记为 lost。 |
| `stopGraceMs` | 必填，1 到 2147483647 | deadline 停下根 Agent 与队友之后，等待它们的回合结束的毫秒数；超过后不再等它们，直接报告。 |

`agent-team` 上的 `trackSubagentRuns` 让普通的 `subagent` 委派出现在任务板上；没有它时只跟踪成员认领的任务。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team-settlement)是所有可接受字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`begin(root, task)` 先把所有已经处于 `in_progress` 的任务以 `run-ended` 标记为 `lost`，因为这个进程里还没有回合运行过，这些工作是更早的进程留下的；然后记下此时任务板上每个任务的 revision。它通过 `TeamService.beginTask` 把运行的任务记录为根 Agent 自己的 `in_progress` 任务，首行作为 subject、全文作为 description，各自截断到任务板的长度上限，并开始计算 deadline。返回的运行的 `settle()` 循环执行：最多用剩余的 deadline 等待根 Agent idle，然后通过 `TeamService.outstandingTasks` 列出任务板上未结算的任务。只剩运行的任务时，按根 Agent 最近的 `turn/end` 结算它：`completed` 时通过 `TeamService.markCompleted` 完成它，其他原因或根本没有回合时以 `owner-failed` 标记为 `lost`。否则循环等待下一次 Team 变化：有 owner 在运行时等到剩余的 deadline，没有时等 `stallMs`，但都不会超过 deadline。deadline 到期时，根 Agent 被取消，取消原因是指明该 deadline 的 `hook`；`TeamService.interruptTeammates` 中断每个正在运行的队友；插件最多等待 `stopGraceMs` 让它们都变为 idle。停滞或 deadline 到期时，对每个仍在进行中的任务（包括运行的任务）调用 `TeamService.markLost(root, id, 'run-ended')`。每条路径都以同一份报告结束：处于 `pending`、`in_progress` 或 `lost`，并且是本次运行在 `begin` 之后创建或改动过的每个任务各占一行，带有 id、subject、owner、状态和原因。没有人开始的任务、运行期间变为 `lost` 的任务、标记失败的任务都会成为一行；更早的运行留下、本次运行没有碰过的任务不会。运行器把每一行打印为 `dsh: unsettled: <id> "<subject>" owned by <owner>: <reason>`，在 `--json` 下把这些行放在 `final` 事件上，并以非零退出。lost 任务保留其 owner 记录；之后恢复的 Lead 通过 `reopen` 恢复它们。插件 dispose 会中止进行中的等待。

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、结算循环，以及 `ctx.headlessSettlement` 提供方 |
| — | 不发布运行时 invariant 伴随插件；本插件请求的每个转换都由 Team 服务自身的 projection 校验。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Headless 组合包](../../bundle/headless/README.zh.md)：消费 `ctx.headlessSettlement` 并把报告映射为退出码的运行器。
- [Agent Teams 服务](../agent-team/README.zh.md)：`lost`、`beginTask`、`markCompleted`、`outstandingTasks`、`markLost` 与 `trackSubagentRuns`。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)：持久 Team 类型与服务 API。
- [实验性包](../README.zh.md)：孵化状态与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

间接通过 Team 任务工具产生影响，它们的结果让根 Agent 在任务板上多看到一行：运行的任务，状态 `in_progress`，owner 是根 Agent，description 是提交的任务文本。

#### KV Cache 影响

无；本插件不向任何请求前缀添加内容，任务行只出现在工具结果中。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

这些限制描述结算等待能观察到什么、不能观察到什么。

- **deadline 与停滞只按墙钟计时**：没有按任务的预算，也没有比一次 Team 变化更细的进度概念；长时间运行却不触碰任务板的子 Agent 只要处于 `running` 就会让运行一直存活。
- **运行的任务不检查产出**：它在根 Agent 的回合以 `completed` 结束且没有其他未结算任务时完成，而不是在检查了根 Agent 的产出之后。
- **进程外子 Agent 在结束前都视为运行中**：从不进入 agent 注册表的 provider 承载的子 Agent 无法被观察到 idle，因此只有它的 `subagent/end` 或 deadline 能结算它的任务。
- **尚无 keyless snapshot**：组装后的插件由包测试与 headless 运行器的 seam 测试覆盖；录制回放场景需要一次真实的委派模型运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
