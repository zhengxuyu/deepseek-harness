---
description: "Keep a headless run alive while delegated Team tasks finish, bound the wait with a deadline and a stall window, and record what the run gave up on as lost."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team-settlement

English | [中文](README.zh.md)

## Summary

Mount this package when a one-shot `dsh --profile headless` run delegates work to teammates or subagents and must not exit before that work settles. It provides the runner's optional `ctx.headlessSettlement` over the Agent Teams board: the run keeps going while any task is `in_progress`, a settling child may wake the root for another turn, and whatever is still open at the deadline or after a stall is marked `lost` on the board and reported on stderr with a non-zero exit. The cost is the wait itself, bounded by two required windows.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside `agent-team` in the headless profile's patch layer and give it both windows.

### When to choose it

Choose it for unattended runs, such as benchmarks, where the root may end its turn while children still run and the exit code must say whether every delegated task finished. Skip it for interactive sessions, where teammates stay resumable and nothing needs to settle at a process boundary. Without it the headless runner exits when the root turn ends, whatever the root delegated.

### Minimal configuration

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

| Field | Default | Meaning |
|---|---|---|
| `deadlineMs` | required | Milliseconds after the root turn first ends before every task still in progress is marked lost. |
| `stallMs` | required, 10000 through 3600000 | Milliseconds without any Team change, while no task owner is running, before the remaining tasks are marked lost. |

`trackSubagentRuns` on `agent-team` makes plain `subagent` delegations appear on the board; without it only tasks members claimed are followed. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team-settlement) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`settle(root)` loops: wait for the root to be idle, list the board's outstanding tasks through `TeamService.outstandingTasks`, and return when there are none. Otherwise it waits for the next Team change: for the remaining deadline while some owner is running, for `stallMs` while none is. A stall timeout or the deadline calls `TeamService.markLost(root, id, 'run-ended')` on each remaining task and returns one row per task marked; a task whose owner completed it in the meantime is neither marked nor reported. The runner prints each row as `dsh: unsettled: <row>` and exits non-zero. Lost tasks keep their owner recorded; a later resumed Lead recovers them through `reopen`. Plugin disposal aborts a wait in progress.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the settlement loop, and the `ctx.headlessSettlement` provider |
| — | No runtime invariant companion is published; the Team service's own projection validates every transition this plugin requests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Headless bundle](../../bundle/headless/README.md) — the runner that consumes `ctx.headlessSettlement` and maps the report to the exit code.
- [Agent Teams service](../agent-team/README.md) — `lost`, `outstandingTasks`, `markLost`, and `trackSubagentRuns`.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and the service API.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as settlement waits on the board and marks tasks lost without adding to any model request; the root sees only the settlement notices and peer mail that its children and teammates already send.

#### KV Cache effect

None; this plugin adds nothing to any request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the settlement wait can and cannot observe.

- **Deadline and stall are wall-clock only** — there is no per-task budget and no notion of progress finer than a Team change; a child that runs for a long time without touching the board keeps the run alive as long as it is `running`.
- **Out-of-process children count as running until they end** — a child behind a provider that never enters the agent registry cannot be observed idle, so only its `subagent/end` or the deadline settles its task.
- **No keyless snapshot yet** — the assembled plugin is covered by package tests and the headless runner's seam tests; recording a replay scenario needs a real delegating model run.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
