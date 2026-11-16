---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-notes-are-edges

English | [中文](2026-09-24-notes-are-edges.zh.md)

## Summary

Adds notes and holds to team/task.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-notes-are-edges
baseline: false
changes:
  - root: "event:team/task"
    previous: "2026-09-24-artifact-contracts"
    after: "d326c8ee74f16d57610cb3141f1df26048d42ec8b4be5e8a9ed95cbaf4b090bf"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing team/task records remain valid: `notes` and `holds` are optional and absent from every earlier record, and the version-2 declaration is unchanged. New records may carry the notes sent to a task (id, sending member, text) and the unacknowledged holds on it (the note id, the task the note was sent to, and the sender), which are never present on a completed task. A reader that predates the fields ignores them.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team --coverage: every test passed with per-file 100% coverage, including the projection's unique-note-id and no-holds-on-completed rules and the replay of notes and holds.

<a id="dev-note"></a>
## Dev Note

None.
