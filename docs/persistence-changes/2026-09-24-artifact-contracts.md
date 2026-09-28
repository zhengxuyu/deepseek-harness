---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-artifact-contracts

English | [中文](2026-09-24-artifact-contracts.zh.md)

## Summary

Adds output contracts, recorded artifacts, and edge instructions to team/task.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-artifact-contracts
baseline: false
changes:
  - root: "event:team/task"
    previous: "2026-09-23-member-turn-outcomes"
    after: "ed7e25aba4a4bbfd27d24e89d80bd1bc0172423427e959d503519ceb84564e6f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing team/task records remain valid: `outputs`, `artifacts`, and `edgeInstructions` are optional and absent from every earlier record, and the version-2 declaration is unchanged. New records may carry declared output contracts, the artifacts recorded at completion (present only on a completed task), and per-blocker instructions whose keys name current blockers. A reader that predates the fields ignores them.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team --coverage: 137 tests passed with per-file 100% coverage, including the projection's artifact-only-on-completed and instruction-names-a-blocker rules and the version-3 replay of contracts and artifacts.

<a id="dev-note"></a>
## Dev Note

None.
