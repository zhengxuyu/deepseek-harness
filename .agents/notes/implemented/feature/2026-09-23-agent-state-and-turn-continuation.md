# Agent Note: Member turn outcomes on the Team board, wait changes, and bounded turn continuation

Status: implemented

English | [中文](2026-09-23-agent-state-and-turn-continuation.zh.md)

## Problem

A Lead could not tell how a teammate's turn ended. The roster reported `running` or `inactive`, and `inactive` covers a teammate that finished, one whose provider failed, and one cut off at the output limit alike; a task lost when a tracked run died said `owner-failed` and nothing more. `wait_agent` returned only whether it timed out, so a Lead that woke had to re-list everything and compare by hand. In the benchmark traces a Lead learned of a teammate's death from a `wait_agent` return fifteen minutes later, and the outcome was never durable.

Separately, a turn ends when the model returns a message with no tool call, including one whose only block is reasoning. Headless takes that as the task being finished and exits with an empty answer; a message cut off at the output limit ends the same way. Four of 52 benchmark instances ended like this with nothing written, three of them recorded as successful runs.

## Decision

`team/member` records are written at payload version 3 with an optional `lastStop`, the stop reason of the member's latest ended turn. The Team service follows every `subagent/start` below a Lead; for a roster member's epoch it records the paired `subagent/end` stop reason through the roster, one further active-to-active record per ended turn, which the projection admits only when `lastStop` is present and the identity and phase are unchanged. Version 2 member records stay readable. `TeamMemberView` and the Team `list_agents` row carry `lastStop`; the policy text names its values. A tracked plain run that ends without completing marks its task `lost` with `ownerStop` set to the run's stop reason, an optional `team/task` field admitted only under the `owner-failed` cause and cleared by `reopen`.

The Team `wait_agent` reads the roster and board before waiting and again after waking, and returns `changes`: the member rows whose availability or `lastStop` differ and the task rows whose status, revision, owner, cause, or owner stop differ, plus rows that appeared. The no-progress shortcut returns empty changes. The service's `waitForChange` is unchanged; the diff is the tool's.

`@deepseek-ai/dsh-experimental-turn-continuation` listens on `agent/turn-stopping`. When the turn's last assistant message has no tool call and no non-blank text, or, with `onMaxTokens`, ended with a `max-tokens` finish, it steers a logged user message with source `{ kind: 'turn-continuation', reason, attempt, form: 'notice' }` back to the model, at most `maxContinuations` times per turn; both bounds are required config. The loop's end reason is untouched, so a cut-off turn still ends `max-tokens`. The headless runner writes `dsh: turn ended: max-tokens` to stderr for a final turn cut off at the output limit, beside its existing exit code 1; other non-completed reasons keep their existing signals. No shipped bundle mounts the plugin; the benchmark mounts it through its patch layer.

## Alternatives considered

**Derive the member's outcome from its own Session log on every `list_agents`.** Rejected because an inactive member is not in the agent registry and reading its log through the query service on every listing is a per-call scan of unbounded history; the Lead log is where the Lead's view is projected from, and one small record per ended turn keeps it reconstructable after resume.

**Record the outcome on `team/task` alone.** Rejected because a member holds no task while it answers mail or works outside the board, and the plan's defect A is a member death the Lead never sees; the roster row is what `list_agents` returns.

**Continue an empty turn inside the agent loop.** Rejected because the loop's `agent/turn-stopping` hook exists for exactly this and a plugin keeps the loop unchanged; interactive sessions keep the person's "continue" as the continuation.

**Make headless exit non-zero on an empty final answer.** Deferred: the runner's contract is the turn's end reason, and a recorded snapshot corpus of tool-only turns would flip; the stderr line names the outcome without changing the exit mapping.

## Testing

Package tests cover the version-2 rejection of a member record with `lastStop`, the active-to-active outcome record and the refusal of any other post-settlement member transition, `ownerStop` admitted only under `owner-failed`, a teammate's completed and interrupted turns reaching the roster and the Lead log, a lost tracked run carrying its stop reason and `reopen` clearing it, the contained failure of a stop record, `list_agents` rows with `lastStop`, `wait_agent` changes for a completed task, a created task, and rows carrying `lastStop` and `ownerStop`, the empty and max-tokens notices with their logged sources, the per-turn bound, and the untouched `max-tokens` end reason. The headless runner covers the named `max-tokens` end. The `team-targets` snapshot pins the changed policy text and tool schemas. No keyless snapshot exercises a stalling model; recording one needs a real run.

## Consequences

A Lead reads how each teammate's latest turn ended and what changed while it waited, and a lost task says how its run ended; each ended teammate turn costs one Lead-log record. An unattended agent that stops with nothing to act on gets a bounded second chance, at one model request per notice, and a run that still ends cut off is named as such on stderr.
