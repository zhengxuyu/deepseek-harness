# Agent Note: The frontier on every task edit and wait

Status: implemented

English | [中文](2026-09-24-frontier-on-every-reply.zh.md)

## Problem

The Lead learned the board only by calling `team_task_list`, so between calls it worked from memory and narration: it waited for teammates it never re-listed, re-solved work it had delegated, and after `wait_agent` returned it had to remember to list again before acting. A Lead that had lost the plot kept acting on a stale picture for as long as it did not ask.

## Decision

Every task edit (`team_task_create`, `team_task_update`) and every `wait_agent` result carries `frontier`, composed by the tool plugin from the current views after the operation: the ready, running, and lost task rows (id, subject, status, owner, declared outputs, recorded artifacts), the counts of blocked and completed tasks, `around` with the edited task's upstream and downstream neighbours out to `frontierHops` dependency hops (absent for a wait or when hops is 0), and every member's status and `lastStop`. Each list keeps at most `frontierRows` rows and a cut list says `truncated`. The policy text tells the Lead to read the frontier instead of re-listing or remembering. `team_task_get` and `team_task_list` stay reads without a frontier: they are how the Lead asks for more than the bounded frontier shows.

The frontier is a pure function of the Team views, so it lives in the tool package beside its schema and adds nothing to the durable Team record or the Remote types.

## Alternatives considered

**A runtime-context snapshot re-sent whenever the board changes.** Rejected because the board changes at every teammate step, so the snapshot would re-enter history every step and break prompt caching, while the design's reply is the edit that caused the change.

**Serving the whole board.** Rejected because a board of dozens of tasks would repeat itself in every reply; the frontier is the ready set plus the neighbourhood of the edit, which is what the next decision needs, and the reads remain for the rest.

## Testing

`frontier.spec.ts` pins the rows, counts, member statuses, the hop-bounded neighbourhood nearest first, the row bound, and `truncated`. The tool tests pin the frontier on create, claim, the no-progress wait, and a woken wait. The `team-targets` snapshot pins the policy text and the result schemas.

## Consequences

Every edit and wait costs the frontier's tokens, bounded by `frontierRows`; a Lead that acts on the reply needs no list call between edits. Cost against budget, which the same reply is meant to carry, waits on the budget work.
