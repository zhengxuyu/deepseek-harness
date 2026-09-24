# Agent Note: One live task per subject

Status: implemented

English | [中文](2026-09-24-one-node-per-subject.zh.md)

## Problem

Five Leads in the b1 team-mode sweep created a task whose `blocked_by` named an id that did not exist, received the refusal, and created the same subject again, so the board carried twins of one piece of work: two nodes claimed, briefed, and completed separately for one deliverable, and the graph's edges pointed at whichever twin the Lead remembered. The board already refuses unresolved edges at `create` and `set_dependencies` and freezes executed history; nothing refused the repeated node.

## Decision

`create`, and an `edit` that renames, refuse a subject another live task carries. Live means `pending`, `in_progress`, or `lost`; a completed or deleted task frees its subject, so a second pass may reuse the name. Subjects compare case- and interior-whitespace-insensitively, because the twins in the runs differed only that way. The refusal is `TEAM_TASK_DUPLICATE_SUBJECT`, naming the task and its status and the remedy: depend on it or edit it, or reopen it when it is lost. Tracked delegated runs are not checked: two parallel delegations may legitimately carry one prompt, and the Lead never authored their subjects.

## Alternatives considered

**Merge the repeated create into the existing task.** Rejected because the second request may carry different text, edges, or outputs, and a silent merge would either discard them or edit a task the caller did not name; a refusal that names the task lets the caller choose.

**Exact-match comparison.** Rejected because the observed twins differed in case and spacing; a check that lets those through refuses nothing the runs produced.

## Testing

Package tests cover the refusal at create and at rename, the case and whitespace folding, reuse after completion and after deletion, the lost-task remedy text, and the tool surface returning the refusal as an observation. The `team-targets` snapshot pins the policy text and the tool description.

## Consequences

A Lead that loses track of its own board is told the existing node instead of growing a twin, at the cost of one refused call. A Lead that wants two tasks with one title must give them distinct subjects.
