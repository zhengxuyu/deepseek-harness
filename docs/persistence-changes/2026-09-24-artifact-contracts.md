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
    after: "2ec38aab48aedd826f356fd89275ed1a525bb9a915c4df0af3e55cef86c87d06"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing team/task records remain valid: `outputs`, `artifacts`, and `edgeInstructions` are optional and absent from every earlier record, and the version-2 declaration is unchanged. New records may carry declared output contracts, per-blocker instructions whose keys name current blockers, and, on the `completed` variant only, the artifacts recorded at completion. A reader that predates the fields ignores them.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team packages/bundle/headless: 268 tests passed, including the projection's refusal of artifacts on a task that is not completed and of an instruction that names no blocker, and the version-3 replay of contracts and artifacts.

<a id="dev-note"></a>
## Dev Note

None.
