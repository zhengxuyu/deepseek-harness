# Agent Note: Lost tasks, a frozen executed graph, and headless settlement over the Team board

Status: implemented

[English](2026-09-23-lost-tasks-and-headless-settlement.md) | 中文

## 问题

headless 运行器在根回合结束时退出。通过后台 `subagent` 调用委派工作、并在子 Agent 仍在运行时结束回合的根 Agent，会让进程带着未收集的结果退出：运行把根 Agent 最后的文本记为答案，而子 Agent 本会投递的结算通知永远到不了任何一个回合。在一次 60 题的基准测试中，这毁掉了 12 个实例的委派工作，而这些实例在子 Agent 实际已完成的工作上全部得零分。

Team 任务板对此一无所知。owner 已死的任务与 owner 仍在工作的任务在任务板上看起来完全一样，Lead 只能对照 roster 才能区分，而运行器在放弃某个任务时也无处可写。任务板还允许任何有权限的调用方改写已经进行中或已完成任务的文本与边，于是 owner 交回来的东西可能与任务板记录的要求不一致；重新分配运行中的任务则会让两个成员在同一个节点上工作过。

## 决策

`TeamTaskStatus` 新增 `lost`，只能由 harness 进入。`TeamService.markLost(caller, id, cause)` 把一个 `in_progress` 任务移入该状态，`lostCause` 为 `owner-failed` 或 `run-ended`，并保留 `ownerId` 记录；provisioning 失败的成员会丢失它在 provisioning 期间认领的一切。`claim` 与 `complete` 拒绝 lost 任务；`reopen` 把它变回无 owner、无 cause 的 `pending`；在此之前 `edit` 与 `set_dependencies` 可以先修订它。lost 任务的依赖方保持阻塞，其写范围不再产生警告。Web 的 Team 面板以错误状态点和「已丢失」标签显示 lost 任务。没有 `lose` 成员动作，因为模型绝不写下它并未产生的结果。

图中已执行的部分是冻结的：`edit`、`set_dependencies` 与 `delete` 只作用于 `pending` 或 `lost` 任务；`reassign` 给成员只作用于 ready 的 `pending` 任务；Lead 侧的取消分配作用于 `pending` 或 `in_progress`。其余一律回答 `TEAM_TASK_INVALID_TRANSITION`。

`trackSubagentRuns`（默认关闭）让服务把 Team 之下的每一次 `subagent/start` 记录为最近 Lead 任务板上一个有 owner 的 `in_progress` 任务（沿委派 parent 的谱系向上查找），并根据配对的 `subagent/end` 结算：`completed` 完成它，其他任何 stop reason 都以 `owner-failed` 标记为 `lost`。roster 成员自身的 epoch 被跳过。`outstandingTasks(caller)` 列出 `in_progress` 任务以及每个 owner 是否在运行；进程外 provider 承载的被跟踪运行在结束前都视为运行中。

headless 运行器新增一个可选 seam：`ctx.headlessSettlement`（`HeadlessSettlement`，由 `@deepseek-ai/dsh-headless` 导出）。根回合结束后，若该服务存在，运行器调用 `settle(root)`；报告非空时以非零退出，并为每一行打印 `dsh: unsettled: <row>`。`@deepseek-ai/dsh-experimental-agent-team-settlement` 在 Team 任务板之上提供它：循环检查根 Agent 的 idle 状态与 `outstandingTasks`，有 owner 在运行时等待 Team 变化直到剩余的 `deadlineMs`，没有时等 `stallMs`，任一到期则把剩余任务以 `run-ended` 标记为 `lost`。两个窗口都是必填配置。该包不发布 invariant 伴随插件；它请求的每个转换都由 Team 服务的 projection 校验。

`team/task` 记录以 payload 版本 3 写入，新增 `lost` 与 `lostCause`；版本 2 记录仍可读取，此变更作为同版本的持久化记录确认，而不是提升 Session 格式版本，因为扩宽持久化的状态联合否则需要格式 5。没有任何随附的 bundle 接线；部署通过自己的 patch 层挂载 `trackSubagentRuns: true` 的 `agent-team` 与结算插件。

## 考虑过的替代方案

**在运行器里等待每个后代离开 agent 注册表。** 被拒绝：它看不到从不进入注册表的进程外 provider 承载的子 Agent，分不清"已汇报"与"已完成但被忽略"的子 Agent，也无处记录它放弃了什么。它还会让一个发布 bundle 依赖实验性包，这是 workspace 约束禁止的。

**owner 离开注册表时就把任务标记为 lost。** 被拒绝：`inactive` 的队友按设计是可冷恢复的，不是失败；以离开注册表为依据会在交互式会话中丢弃可恢复的工作并把它放出去重新分配。因此 `lost` 只依据终态的成员 phase、终态的运行 stop reason，或一次性宿主的结束决定。

**用 release 代替 lost。** 被拒绝：`release` 返回一个可认领的 `pending` 任务，抹去了是谁持有它，也掩盖了是 harness 而非 owner 结束了这次尝试。恢复应通过 `reopen` 显式地、在日志中进行。

**给结算循环加按任务的预算或进度信号。** 暂缓：任务板没有比"一次 Team 变化"更细的进度概念，而按任务的预算应当与任务将来携带的产物契约放在一起，而不是放在这次结算里。

**把子 Agent 的 prompt 记为被跟踪任务的描述。** 暂时拒绝：生命周期边只携带 provider 与子 Agent 身份，而在开始时读取子 Agent 的 Session 看到的是 continuable 子 Agent 的完整历史而非本 epoch 的 prompt。拥有契约的声明式 spawn 是另一项工作。

## 测试

包测试覆盖 lost 的各个转换及其拒绝、对每个动作的冻结历史守卫、从 lost 的 `reopen`、对缺失与非进行中任务的 `markLost`、provisioning 失败导致早期认领丢失、projection 的状态–原因一致性检查、被跟踪运行的完成、丢失、跳过 roster epoch 与孤儿 parent、沿普通子 Agent 的谱系找到 Lead，以及记录或结算失败时只告警不抛出。结算包覆盖配置校验、空任务板、完成并唤醒根 Agent 的运行、无人运行时的停滞、坚持到 deadline 的运行中 owner、放弃过程中已完成的任务，以及等待期间的 dispose。headless 运行器覆盖延长运行并使退出失败的 provider，以及报告无未结算项的 provider。触及的包保持逐文件 100% 覆盖。尚无 keyless snapshot 演练组装后的结算插件；录制一个需要一次真实的委派模型运行。

## 后果

Team 任务板之上的一次性运行不再先于它委派的工作结束；当它必须提前结束时，任务板会按任务说明这一点，并仍然记着 owner。代价是结算等待本身（由两个必填窗口限定），以及 Lead 在任务开始后不能再编辑或移动它；从死掉的 owner 恢复需要显式的 `reopen`。被跟踪运行的完成只是它的 stop reason，不是对其产出的检查。
