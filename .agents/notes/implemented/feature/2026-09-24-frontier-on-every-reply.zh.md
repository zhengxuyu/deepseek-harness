# Agent Note: The frontier on every task edit and wait

Status: implemented

[English](2026-09-24-frontier-on-every-reply.md) | 中文

## 问题

Lead 只能通过调用 `team_task_list` 了解任务板，于是两次调用之间它靠记忆和叙述工作：等待从未重新列出的队友、重做已经委托出去的工作，`wait_agent` 返回后还得记得先列表再行动。跑偏的 Lead 只要不去问，就一直按过时的图景行动。

## 决策

每次任务编辑（`team_task_create`、`team_task_update`）和每次 `wait_agent` 的结果都携带 `frontier`，由工具插件在操作之后从当前视图组合：ready、running、lost 三类任务行（id、subject、状态、owner、声明的输出数、记录的产物数），blocked 与 completed 的计数，`around` 给出被编辑任务在 `frontierHops` 跳依赖内的上游与下游邻居（wait 或 hops 为 0 时省略），以及每个成员的状态和 `lastStop`。每个列表最多保留 `frontierRows` 行，被截断的列表标记 `truncated`。策略文本要求 Lead 读 frontier 而不是重新列表或凭记忆。`team_task_get` 和 `team_task_list` 仍是不带 frontier 的读操作：Lead 需要比有界 frontier 更多的信息时用它们。

frontier 是 Team 视图的纯函数，所以放在工具包里与其 schema 相邻，不给持久的 Team 记录和 Remote 类型增加任何东西。

## 考虑过的替代方案

**任务板一变就重发的 runtime-context 快照。** 被拒绝：任务板在队友的每一步都会变，快照会每步进入历史并破坏 prompt 缓存，而设计中的回复正是引起变化的那次编辑。

**返回整个任务板。** 被拒绝：几十个任务的板会在每次回复里重复自己；frontier 是 ready 集加上编辑处的邻域，正是下一个决定所需要的，其余的交给读操作。

## 测试

`frontier.spec.ts` 固定行、计数、成员状态、按跳数限定且最近优先的邻域、行数上限与 `truncated`。工具测试固定 create、claim、无进展的 wait 和被唤醒的 wait 上的 frontier。`team-targets` 快照固定策略文本与结果 schema。

## 后果

每次编辑和 wait 都要付出 frontier 的 token，上限由 `frontierRows` 决定；按回复行动的 Lead 在两次编辑之间不需要列表调用。同一回复本应携带的预算消耗，等预算工作完成后再加。
