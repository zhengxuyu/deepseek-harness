---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-team-task-lost

English | [中文](2026-09-23-team-task-lost.zh.md)

## Summary

Adds team/task payload version 3 with the harness-only `lost` task status and its `lostCause`, declares the version 3 task as one variant per status, and adds the optional `attempts` and `goalRevision` fields.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-team-task-lost
baseline: false
changes:
  - root: "event:team/task"
    previous: "2026-09-11-initial"
    after: "b6c6715a42d588ef94092fa06603b51e146d4d1fe8402b0af9fdb4cebad1c0c5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing version-2 team/task records remain valid; the version-2 declaration keeps the four-status union and its optional owner. A version-2 record is read as the current variant of its status: an owner on a pending record is dropped, and an in-progress or completed record without an owner is refused, which no released build wrote. New records are written at version 3. Its status union adds `lost`, and each status states the owner and cause fields it carries: pending has neither, in-progress and completed require the owner, lost requires the owner and `lostCause` and may carry `ownerGoalRevision`, the goal revision its owner worked toward when the goal was edited after the owner was lost, and deleted may keep the owner. A version-3 record with the fields of another status is refused. Version 3 also carries two optional fields, absent until they have something to record: `attempts`, the task's earlier ownerships with how each ended, and `goalRevision`, the revision that last changed the subject or description. A version-2 record is read with neither. A reader that knows only version 2 records a projection failure for a version-3 record instead of misreading it. The other Team events stay at version 2.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team: 122 tests passed, including the version-2 rejection of a lost task, the owner a version-2 record keeps per status, the fields version 3 accepts and refuses for each status, the attempts version 3 accepts and refuses, the tombstone of a deleted lost task, and the unsupported version-3 team/member record.

<a id="dev-note"></a>
## Dev Note

None.
