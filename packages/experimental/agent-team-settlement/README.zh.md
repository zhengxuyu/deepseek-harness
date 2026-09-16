# @deepseek-ai/dsh-experimental-agent-team-settlement

[English](README.md) | 中文

在 Agent Teams 任务板之上提供 headless 运行器的可选 [`ctx.headlessSettlement`](../../bundle/headless/README.zh.md)。没有它时，一次性运行在根 Agent 的回合结束时就结束，根 Agent 委派出去而没有等待的工作会随进程一起丢失。有了它，只要根 Agent 任务板上还有 `in_progress` 的任务，运行就继续；子 Agent 结算时可以再唤醒根 Agent 跑一回合；运行必须结束时仍未完成的任务会在任务板上标记为 `lost` 并输出到 stderr，因此运行永远不会记录一个它并未收集到的结果。

## 配置

```yaml
- id: agent-team-settlement
  name: '@deepseek-ai/dsh-experimental-agent-team-settlement'
  config:
    deadlineMs: 3600000
    stallMs: 120000
```

两项均为必填。`deadlineMs` 限定从根回合首次结束起整个结算等待的上限；超过后，所有仍在进行中的任务都被标记为 lost。`stallMs`（10,000 到 3,600,000）是在没有任何任务 owner 在运行、且 Team 上没有任何变化的情况下，插件在把剩余任务视为被放弃之前等待的时长；仅仅处于 idle 的 owner 在这个窗口内仍可被邮件或结算通知唤醒。插件依赖 `ctx.agentTeams`（[`dsh-experimental-agent-team`](../agent-team/README.zh.md)）；若要跟踪普通的 `subagent` 委派而不只是成员认领的任务，该服务需以 `trackSubagentRuns: true` 运行。

## 结算

`settle(root)` 循环执行：等待根 Agent 处于 idle 且下一回合队列为空，列出任务板上未完成的任务（`TeamService.outstandingTasks`），没有则返回。否则等待下一次 Team 变化：有 owner 在运行时等到剩余的 deadline，没有时等 `stallMs`。停滞超时或到达 deadline 时，对每个剩余任务调用 `TeamService.markLost(root, id, 'run-ended')`，并为每个被标记的任务返回一行；期间被 owner 完成的任务既不会被标记也不会被报告。运行器把每一行打印为 `dsh: unsettled: <row>` 并以非零退出。lost 的任务保留其 owner 记录；之后恢复的 Lead 可通过 `reopen` 找回它们。

## 模型体验

无，结算只等待任务板并标记任务 lost，不向任何模型请求添加内容；根 Agent 看到的只是其子 Agent 与队友本来就会发送的结算通知和同伴消息。

#### KV 缓存影响

无；本插件不向任何请求前缀添加内容。

## 已知限制与后续工作

- **deadline 与 stall 只按墙钟计时** — 没有按任务的预算，也没有比"一次 Team 变化"更细的进度概念；一个长时间运行却不触碰任务板的子 Agent，只要处于 `running` 就会让运行一直持续。
- **进程外子 Agent 在结束前一律视为运行中** — 由从不进入 agent 注册表的 provider 承载的子 Agent 无法被观察到 idle，因此只有它的 `subagent/end` 或 deadline 才能结算其任务。
