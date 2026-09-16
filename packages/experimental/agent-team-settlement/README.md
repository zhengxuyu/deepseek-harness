# @deepseek-ai/dsh-experimental-agent-team-settlement

English | [中文](README.zh.md)

Provides the headless runner's optional [`ctx.headlessSettlement`](../../bundle/headless/README.md) over the Agent Teams board. Without it, a one-shot run ends when the root turn ends, so work the root delegated and never waited for is dropped with the process. With it, the run keeps going while any task on the root's board is `in_progress`, a settling child may wake the root for another turn, and what is still open when the run must end is marked `lost` on the board and reported on stderr, so a run never records a result it did not collect.

## Config

```yaml
- id: agent-team-settlement
  name: '@deepseek-ai/dsh-experimental-agent-team-settlement'
  config:
    deadlineMs: 3600000
    stallMs: 120000
```

Both are required. `deadlineMs` bounds the whole settlement wait from the moment the root turn first ends; when it passes, every task still in progress is marked lost. `stallMs` (10,000 through 3,600,000) is how long the plugin waits while no task owner is running and nothing on the Team changes before it treats the remaining tasks as abandoned; an owner that is merely idle is given this window to be woken by mail or a settlement notice. The plugin requires `ctx.agentTeams` ([`dsh-experimental-agent-team`](../agent-team/README.md)); to follow plain `subagent` delegations rather than only member-claimed tasks, that service must run with `trackSubagentRuns: true`.

## Settlement

`settle(root)` loops: wait for the root to be idle with nothing queued for its next turn, list the board's outstanding tasks (`TeamService.outstandingTasks`), and return when there are none. Otherwise it waits for the next Team change: for the remaining deadline when some owner is running, for `stallMs` when none is. A stall timeout or the deadline calls `TeamService.markLost(root, id, 'run-ended')` on each remaining task and returns one row per task marked; a task whose owner completed it in the meantime is neither marked nor reported. The runner prints each row as `dsh: unsettled: <row>` and exits non-zero. Lost tasks keep their owner recorded; a later resumed Lead recovers them through `reopen`.

## Model Experience

None, as settlement waits on the board and marks tasks lost without adding to any model request; the root sees only the settlement notices and peer mail that its children and teammates already send.

#### KV Cache effect

None; this plugin adds nothing to any request prefix.

## Known Limitations and Deferred Work

- **Deadline and stall are wall-clock only** — there is no per-task budget and no notion of progress finer than a Team change; a child that runs for a long time without touching the board keeps the run alive as long as it is `running`.
- **Out-of-process children count as running until they end** — a child behind a provider that never enters the agent registry cannot be observed idle, so only its `subagent/end` or the deadline settles its task.
