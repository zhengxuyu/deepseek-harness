# Agent Note: Lost tasks, a frozen executed graph, and headless settlement over the Team board

Status: implemented

English | [中文](2026-09-23-lost-tasks-and-headless-settlement.zh.md)

## Problem

The headless runner exits when the root turn ends. A root that delegates through background `subagent` calls and ends its turn while the children run leaves the process with their results uncollected: the run records the root's last text as the answer, and the settlement notices the children would have delivered never reach a turn. On a 60-task benchmark sweep this destroyed the delegated work of 12 instances, and every one of them scored zero on work the children had in fact finished.

The Team board recorded none of this. A task whose owner had died looked identical to one whose owner was still working, so a Lead had to cross-reference the roster to tell them apart, and a runner had nothing to write when it gave up on one. The board also let any authorized caller rewrite the text or edges of a task already in progress or completed, so what came back from an owner could disagree with what the board said it was asked for, and reassigning a running task left two members having worked on one node.

## Decision

`TeamTaskStatus` gains `lost`, entered only by the harness. `TeamService.markLost(caller, id, cause)` moves one `in_progress` task there with `lostCause` `owner-failed` or `run-ended`, keeping `ownerId` on record; a member whose provisioning fails loses whatever it claimed while provisioning. `claim` and `complete` refuse a lost task; `reopen` returns it to `pending` with no owner and no cause; `edit` and `set_dependencies` may revise it first. Dependents of a lost task stay blocked and its write scopes no longer warn. The Web Team panel shows a lost task with the error dot and a `Lost` label. There is no `lose` member action, because the model never writes an outcome it did not produce.

The executed part of the graph is frozen: `edit`, `set_dependencies`, and `delete` apply only to `pending` or `lost` tasks; `reassign` to a member only to a ready `pending` task; Lead-side unassignment to `pending` or `in_progress`. The rest answer `TEAM_TASK_INVALID_TRANSITION`.

`trackSubagentRuns` (off by default) makes the service record every `subagent/start` below a Team as an owned `in_progress` task on the nearest Lead's board, found by walking the delegating parent's lineage, and settle it from the paired `subagent/end`: `completed` completes it, any other stop reason marks it `lost` with `owner-failed`. Roster members' own epochs are skipped. `outstandingTasks(caller)` lists `in_progress` tasks with whether each owner is running; a tracked run behind an out-of-process provider counts as running until it ends.

The headless runner gains one optional seam, `ctx.headlessSettlement` (`HeadlessSettlement`, exported by `@deepseek-ai/dsh-headless`): after the root turn ends it calls `settle(root)` when the service is present and exits non-zero, printing `dsh: unsettled: <row>` per row, when the report is non-empty. `@deepseek-ai/dsh-experimental-agent-team-settlement` provides it over the Team board: it loops on root idleness and `outstandingTasks`, waits for Team changes for the remaining `deadlineMs` while an owner is running and for `stallMs` while none is, and on either expiry marks the remainder `lost` with `run-ended`. Both windows are required config. The package publishes no invariant companion; the Team service's projection validates every transition it requests.

`team/task` records are written at payload version 3, which adds `lost` and `lostCause`; version 2 records stay readable, and the change is acknowledged as a same-version persistence record rather than a Session format bump, because a widened persisted status union would otherwise require format 5. No shipped bundle wires it; a deployment mounts `agent-team` with `trackSubagentRuns: true` and the settlement plugin through its patch layer.

## Alternatives considered

**Wait in the runner for every descendant to leave the agent registry.** Rejected because it cannot see a child behind an out-of-process provider that never enters the registry, cannot tell a child that reported from one that finished and was ignored, and has nowhere to record what it gave up on. It would also have coupled a release bundle to an experimental package, which the workspace constraints forbid.

**Mark a task lost when its owner leaves the registry.** Rejected because an `inactive` teammate is cold-resumable by design, not failed; keying `lost` on registry departure would discard recoverable work in interactive sessions and free it for reassignment. `lost` is therefore keyed on a terminal member phase, a terminal run stop reason, or a one-shot host's decision to end.

**Release the task instead of losing it.** Rejected because `release` returns a claimable `pending` task, which erases who held it and hides that the harness, not the owner, ended the attempt. Recovery goes through `reopen` explicitly and in the log.

**Give the settlement loop a per-task budget or progress signal.** Deferred: the board has no progress notion finer than a Team change, and a per-task budget belongs with the artifact contract a task will carry, not with this settlement.

**Record the child's prompt as the tracked task's description.** Rejected for now because the lifecycle edge carries provider and child identity only, and reading the child's Session at start time observes a continuable child's whole history rather than the epoch's prompt. The declaring spawn that owns the contract is separate work.

## Testing

Package tests cover the lost transitions and their refusals, frozen-history guards on every action, `reopen` from lost, `markLost` on missing and non-in-progress tasks, provisioning failure losing an early claim, the projection's status–cause consistency check, tracked runs completing, losing, skipping roster epochs and orphaned parents, walking a plain child's lineage to the Lead, and warning without throwing when a record or settlement fails. The settlement package covers config validation, an idle board, a run that completes and wakes the root, a stall with nothing running, a running owner held to the deadline, a task that finished while being abandoned, and disposal during the wait. The headless runner covers a provider that extends the run and fails the exit, and one that reports nothing outstanding. The touched packages hold per-file 100% coverage. No keyless snapshot exercises the assembled settlement plugin yet; recording one needs a real delegating model run.

## Consequences

A one-shot run over a Team board no longer ends before the work it delegated does, and when it must end early the board says so per task, with the owner still named. The cost is the settlement wait itself, bounded by two required windows, and a Lead that can no longer edit or move a task once it has started; recovery from a dead owner takes an explicit `reopen`. A tracked run's completion is its stop reason, not a check of what it produced.
