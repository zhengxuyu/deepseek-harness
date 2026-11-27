---
description: "Record a headless run's task on the Team board, keep the run alive while it and delegated Team tasks finish, bound the whole run with a deadline and a stall window, stop the teammates at the deadline, and report every task the run did not collect."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team-settlement

English | [中文](README.zh.md)

## Summary

Mount this package when a `dsh --profile headless` run delegates work and must not exit first. It provides `ctx.headlessSettlement` over the Agent Teams board: the run's task is an `in_progress` task the root owns, and the run continues while the root is in a turn or any task is `in_progress`. The run's task completes with the root's last completed turn or, when it declares outputs, only when the root completes it. At the deadline the root and running teammates are stopped; work still in progress is marked `lost`. Every task the run left uncompleted is reported with a non-zero exit.

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
    - id: agent-team-settlement
      name: '@deepseek-ai/dsh-experimental-agent-team-settlement'
      config:
        deadlineMs: 3600000
        stallMs: 120000
        stopGraceMs: 30000
```

| Field | Default | Meaning |
|---|---|---|
| `deadlineMs` | required, 1 through 2147483647 | Milliseconds from the start of the run before the root's turn is cancelled, every running teammate is interrupted, and every task still in progress is marked lost. |
| `stallMs` | required, 10000 through 3600000 | Milliseconds without any Team change, while no task owner is running, before the remaining tasks are marked lost. |
| `stopGraceMs` | required, 1 through 2147483647 | Milliseconds to wait, after the deadline stopped the root and the teammates, for their turns to end before the run is reported without them. |
| `outputs` | `[]` | Files the run's task must produce, each `{ path, kind, schema?, optional? }` as on any Team task. When any is declared, only the root completes the run's task, through `team_task_update`, which checks them on disk. |

`trackSubagentRuns` on `agent-team` is off by default; setting it makes plain `subagent` delegations appear on the board, and without it only tasks members hold are followed. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team-settlement) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`begin(root, task)` first marks every task already `in_progress` as `lost` with cause `run-ended`, because no turn has run in this process and that work was left by an earlier one, and records the revision of every task then on the board. It records the run's task through `TeamService.beginTask` as the root's own `in_progress` task, with the first line as subject and the text as description, each cut to the board's length limit, and the configured `outputs` as its declared outputs, and starts the deadline. The returned run's `settle()` loops: wait for the root to be idle for at most the remaining deadline, then list the board's outstanding tasks through `TeamService.outstandingTasks`. When only the run's task remains and the root still holds it, it is settled from the root's latest `turn/end`: `completed` completes it through `TeamService.markCompleted` when it declares no outputs, and any other reason or no turn at all marks it `lost` with cause `owner-failed`. A run's task that declares outputs is never completed by the plugin: after a `completed` turn that left it `in_progress`, the root receives one logged reminder as a follow-up message, which starts another turn, and a second such turn marks the task `lost` with cause `owner-failed`. A run's task the root reassigned to a teammate is waited on like any other task. Otherwise the loop waits for the next Team change: for the remaining deadline while some owner is running, for `stallMs` while none is, and never past the deadline. When the deadline passes, the root is cancelled with a `hook` cause naming the deadline, `TeamService.interruptTeammates` interrupts every running teammate, and the plugin waits at most `stopGraceMs` for all of them to be idle. A stall or the deadline calls `TeamService.markLost(root, id, 'run-ended')` on each task still in progress, the run's task included. Every path ends with the same report: one row, with id, subject, owner, status, and reason, for each task that is `pending`, `in_progress`, or `lost` and that this run created or changed since `begin`. A task nobody started, a task that became `lost` during the run, and a task whose mark failed are all rows; a task from an earlier run that this run did not touch is not. The runner prints each row as `dsh: unsettled: <id> "<subject>" owned by <owner>: <reason>`, puts the rows on the `final` event under `--json`, and exits non-zero. Lost tasks keep their owner recorded; a later resumed Lead recovers them through `reopen`. Plugin disposal aborts a wait in progress.

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
