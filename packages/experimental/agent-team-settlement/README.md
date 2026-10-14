---
description: "Record a headless run's task on the Team board, keep the run alive while it and delegated Team tasks finish, bound the whole run with a deadline and a stall window, and record what the run gave up on as lost."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team-settlement

English | [中文](README.zh.md)

## Summary

Mount this package when a `dsh --profile headless` run delegates work and must not exit before it settles. It provides the runner's `ctx.headlessSettlement` over the Agent Teams board: the run's task is recorded as an `in_progress` task the root owns, the run continues while the root is in a turn or any task is `in_progress`, and the run's task completes with the root's last completed turn, or, when it declares outputs, only when the root completes it. At the deadline the root's turn is cancelled; work still open then or after a stall is marked `lost` and reported.

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
| `deadlineMs` | required, 1 through 2147483647 | Milliseconds from the start of the run before the root's turn is cancelled and every task still in progress is marked lost. |
| `stallMs` | required, 10000 through 3600000 | Milliseconds without any Team change, while no task owner is running, before the remaining tasks are marked lost. |
| `outputs` | `[]` | Files the run's task must produce, each `{ path, kind, schema?, optional? }` as on any Team task. When any is declared, only the root completes the run's task, through `team_task_update`, which checks them on disk. |

`trackSubagentRuns` on `agent-team` makes plain `subagent` delegations appear on the board; without it only tasks members claimed are followed. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team-settlement) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`begin(root, task)` records the task through `TeamService.beginTask` as the root's own `in_progress` task, with the first line as subject and the text as description, each cut to the board's length limit, and the configured `outputs` as its declared outputs, and starts the deadline. The returned run's `settle()` loops: wait for the root to be idle for at most the remaining deadline, then list the board's outstanding tasks through `TeamService.outstandingTasks`. When only the run's task remains, it is settled from the root's latest `turn/end`: `completed` completes it through `TeamService.markCompleted` when it declares no outputs, any other reason or no turn at all marks it `lost` with cause `owner-failed` and reports it, and a run's task the root already completed is accepted while one it released or deleted is reported as left in that status. A run's task that declares outputs is never completed by the plugin: after a `completed` turn that left it `in_progress`, the root receives one logged reminder as a follow-up message, which starts another turn, and a second such turn marks the task `lost` with cause `owner-failed` and reports it. Otherwise the loop waits for the next Team change: for the remaining deadline while some owner is running, for `stallMs` while none is. When the deadline passes, a root still in a turn is cancelled with a `hook` cause naming the deadline. A stall timeout or the deadline calls `TeamService.markLost(root, id, 'run-ended')` on each remaining task, the run's task included, and returns one row per task marked; a task whose owner completed it in the meantime is neither marked nor reported, while a task whose mark failed for any other reason stays `in_progress` on the board and is reported with that failure. Under the Team's pull assignment a ready task nobody has claimed is outstanding too, live while any teammate runs; when the run gives up on it, it is reported as `claimed by nobody` and stays `pending`, since there is no owner to lose it. The runner prints each row as `dsh: unsettled: <row>` and exits non-zero. Lost tasks keep their owner recorded; a later resumed Lead recovers them through `reopen`. Plugin disposal aborts a wait in progress.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the settlement loop, and the `ctx.headlessSettlement` provider |
| — | No runtime invariant companion is published; the Team service's own projection validates every transition this plugin requests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Headless bundle](../../bundle/headless/README.md) — the runner that consumes `ctx.headlessSettlement` and maps the report to the exit code.
- [Agent Teams service](../agent-team/README.md) — `lost`, `beginTask`, `markCompleted`, `outstandingTasks`, `markLost`, and `trackSubagentRuns`.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and the service API.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Completion reminder

#### What the model sees

The Team task tools show the root one more board row: the run's task, `in_progress` and owned by the root, with the submitted task text as its description and the configured outputs. When that task declares outputs and the root's turn completes with it still `in_progress`, the root receives this message once, with the task id, output paths, and revision filled in. Nothing is added to the system prompt or tool schemas.

##### Reminder message

```markdown
Your turn ended, but task task-1, which this run was started with and you own, is still in progress. It declares outputs that are checked on disk: out/result.json. Produce them, then call team_task_update with action complete on task-1 at revision 1. This reminder is sent once; if your next turn ends with the task still in progress, the run records it as lost.
```

#### Token effect

Zero tokens unless the run's task declares outputs and a root turn completes without completing it. The reminder is retained history for the root and costs at least one further model request.

#### KV Cache effect

Append-only; the reminder follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the settlement wait can and cannot observe.

- **Deadline and stall are wall-clock only** — there is no per-task budget and no notion of progress finer than a Team change; a child that runs for a long time without touching the board keeps the run alive as long as it is `running`.
- **A run's task without declared outputs carries no check of what was produced** — it completes on the root's `completed` turn end with nothing else outstanding; configure `outputs` to require files checked on disk.
- **Out-of-process children count as running until they end** — a child behind a provider that never enters the agent registry cannot be observed idle, so only its `subagent/end` or the deadline settles its task.
- **No keyless snapshot yet** — the assembled plugin is covered by package tests and the headless runner's seam tests; recording a replay scenario needs a real delegating model run.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
