# Agent Note: Member turn outcomes on the Team board, wait changes, and bounded turn continuation

Status: implemented

[English](2026-09-23-agent-state-and-turn-continuation.md) | 中文

## 问题

Lead 无法得知队友的回合是如何结束的。roster 只报告 `running` 或 `inactive`，而 `inactive` 同时覆盖已完成的队友、provider 失败的队友和被输出上限截断的队友；被跟踪运行死亡而 lost 的任务只写 `owner-failed`，别无其他。`wait_agent` 只返回是否超时，被唤醒的 Lead 只能重新列出一切再手工比对。在基准测试的 trace 中，一个 Lead 在十五分钟后才从 `wait_agent` 的返回得知队友已死，而这个结果从未持久化。

另一方面，模型返回一条没有工具调用的消息时回合就结束，包括只含 reasoning 块的消息。headless 把它当作任务完成，以空答案退出；被输出上限截断的消息同样如此。52 个基准实例中有 4 个这样结束且什么都没写出，其中 3 个被记为成功运行。

## 决策

`team/member` 记录以 payload 版本 3 写入，带可选的 `lastStop`，即成员最近一次结束的回合的 stop reason。Team 服务跟随 Lead 之下的每一次 `subagent/start`；对于 roster 成员的 epoch，它通过 roster 记录配对的 `subagent/end` 的 stop reason，每结束一个回合追加一条 active 到 active 的记录，projection 只在 `lastStop` 存在且身份与 phase 不变时接受它。版本 2 的成员记录仍可读取。`TeamMemberView` 与 Team 的 `list_agents` 行携带 `lastStop`；策略文本说明其取值。未完成即结束的被跟踪普通运行把任务标为 `lost`，并把运行的 stop reason 记为 `ownerStop`，这是 `team/task` 上可选的字段，只在 `owner-failed` 原因下接受，`reopen` 时清除。

Team 的 `wait_agent` 在等待前和唤醒后各读取一次 roster 与任务板，返回 `changes`：可用性或 `lastStop` 有变化的成员行，状态、revision、owner、原因或 owner stop 有变化的任务行，以及新出现的行。no-progress 捷径返回空的 changes。服务的 `waitForChange` 不变；diff 由工具完成。

`@deepseek-ai/dsh-experimental-turn-continuation` 监听 `agent/turn-stopping`。当回合最后一条 assistant 消息没有工具调用也没有非空文本，或在设置 `onMaxTokens` 时以 `max-tokens` finish 结束，它把一条 source 为 `{ kind: 'turn-continuation', reason, attempt, form: 'notice' }` 的用户消息 steer 回模型，每回合最多 `maxContinuations` 次；两个上限都是必填配置。loop 的结束原因不受影响，因此被截断的回合仍以 `max-tokens` 结束。headless 运行器对被输出上限截断的最终回合向 stderr 写入 `dsh: turn ended: max-tokens`，退出码 1 保持不变；其他非完成的原因保留既有的信号。没有随附的 bundle 挂载该插件；基准测试通过自己的 patch 层挂载它。

## 考虑过的替代方案

**每次 `list_agents` 都从成员自己的 Session 日志推导结果。** 被拒绝：inactive 的成员不在 agent 注册表中，每次列出都通过查询服务读取其日志意味着按调用扫描无界的历史；Lead 的视图是从 Lead 日志投影出来的，每结束一个回合一条小记录让它在恢复后仍可重建。

**只在 `team/task` 上记录结果。** 被拒绝：成员回复邮件或在任务板之外工作时不持有任务，而计划中的缺陷 A 正是 Lead 看不到的成员死亡；roster 行才是 `list_agents` 返回的东西。

**在 agent loop 内部继续空回合。** 被拒绝：loop 的 `agent/turn-stopping` 钩子正是为此而存在，插件让 loop 保持不变；交互式会话里由人输入的「继续」就是继续。

**让 headless 在最终答案为空时以非零退出。** 暂缓：运行器的契约是回合的结束原因，而已录制的仅工具回合的快照语料会因此翻转；stderr 行说明了结果而不改变退出映射。

## 测试

包测试覆盖版本 2 拒绝带 `lastStop` 的成员记录、active 到 active 的结果记录以及对结算后其他成员转换的拒绝、`ownerStop` 只在 `owner-failed` 下接受、队友完成与被中断的回合到达 roster 与 Lead 日志、lost 的被跟踪运行携带其 stop reason 且 `reopen` 清除它、stop 记录失败时的包含、带 `lastStop` 的 `list_agents` 行、`wait_agent` 对已完成任务、新建任务以及携带 `lastStop` 与 `ownerStop` 的行的 changes、空消息与 max-tokens 提醒及其记入日志的 source、每回合上限，以及不受影响的 `max-tokens` 结束原因。headless 运行器覆盖命名的 `max-tokens` 结束。`team-targets` 快照固定了变化的策略文本与工具 schema。尚无 keyless snapshot 演练停滞的模型；录制一个需要一次真实运行。

## 后果

Lead 能读到每个队友最近一次回合如何结束、等待期间发生了什么变化，lost 的任务会说明其运行如何结束；每个结束的队友回合花费一条 Lead 日志记录。停在「无事可做」上的无人值守 Agent 得到有上限的第二次机会，每条提醒一次模型请求；仍以截断结束的运行会在 stderr 上被如此命名。
