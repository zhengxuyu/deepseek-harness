# Agent Note: Notes are edges

Status: implemented

English | [中文](2026-09-24-notes-are-edges.zh.md)

## Problem

Team members told each other things by mail addressed to a member, and the board never learned of it: a teammate's closing report named a defect in another task's output, the Lead read it and moved on, and that task completed and scored zero on the import error the report described. Information that moved outside the graph left no edge, so nothing could hold a node on account of it and later credit over the artifact ancestry could not see it.

## Decision

A note is a message whose recipient is a task. `noteTask` records it on the task as `notes` (id `<task>-note-<n>`, sending member, text) in the same Lead transaction that bumps the task's revision, mails it to the task's current owner from the note's author without awaiting delivery, and the brief composed on `claim` and `reassign` lists the notes, so whoever works the task next has them as inputs. A note needs a live task: `pending`, `in_progress`, or `lost`.

A note that names another live task's declared output path, by plain substring, holds that task: a `holds` entry (note id, the task the note was sent to, sender) is appended to the held task in the same transaction, `complete` answers `TEAM_TASK_HELD` naming every hold, and only the Lead clears a hold with the `acknowledge` action naming the note. A completed task never carries holds. The Team tools add `team_task_note` and the `acknowledge` action, and the frontier rows count `notes` and `holds`. Both fields are optional properties on the version-3 `team/task` payload, acknowledged as a same-version change.

## Alternatives considered

**Re-purpose `send_message` with a task target.** Rejected because member names are free text and would collide with task ids, and the result of a note (note id, held tasks) is a different value from a mail receipt; a tenth tool keeps both contracts exact.

**Hold on any mention of the task, not of its outputs.** Rejected because a note about a task is the ordinary case and must not stall it; the design's rule is a note that names another node's output, which is what the scored failure looked like.

**Let the held task's owner acknowledge.** Rejected because the hold exists to make the Lead read the note; the owner acknowledging their own task's hold would restore the silence the rule removes.

## Testing

Package tests cover recording and mail to the owner, the brief listing notes, refusal for settled and missing tasks and empty text, the hold and its `TEAM_TASK_HELD` refusal, acknowledge clearing one hold while others remain, the Lead-only rule, and the projection's rules. The tool tests cover the note result with held tasks and frontier counts, and acknowledge through the tool. The `team-targets` snapshot pins the schemas and policy text.

## Consequences

A note costs one task revision plus one per held task, and a held task's owner cannot complete until the Lead has read the note that concerns it. The substring rule holds a task when a note merely quotes its path in passing; the Lead's acknowledgement is one call.
