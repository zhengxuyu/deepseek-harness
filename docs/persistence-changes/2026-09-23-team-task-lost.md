---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-team-task-lost

English | [中文](2026-09-23-team-task-lost.zh.md)

## Summary

Adds team/task payload version 3 with the harness-only `lost` task status and its `lostCause`.

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
    after: "cc80b86c80b0f4a334297abb4b6aa0398ef60abf81d54d3de632b37247458c4f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing version-2 team/task records remain valid and are projected unchanged; the version-2 declaration keeps the four-status union. New records are written at version 3, whose status union adds `lost` and whose optional `lostCause` is present exactly while the status is lost. A reader that knows only version 2 records a projection failure for a version-3 record instead of misreading it. The other Team events stay at version 2.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team --coverage --coverage.include='packages/experimental/agent-team/src/**/*.ts': 93 tests passed with per-file 100% coverage, including the version-2 rejection of a lost task, version-3 status-cause consistency, and the unsupported version-3 team/member record.

<a id="dev-note"></a>
## Dev Note

None.
