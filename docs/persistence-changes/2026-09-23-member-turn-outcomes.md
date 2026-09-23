---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-member-turn-outcomes

English | [中文](2026-09-23-member-turn-outcomes.zh.md)

## Summary

Adds team/member payload version 3 with the member's latest turn outcome, the owner stop reason on a lost tracked task, and the turn-continuation notice attribution.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-member-turn-outcomes
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-22-jev-consult-attribution"
    after: "f39a7491b02d505b28462f522bfc49799cf3eee35c70c72fe701c6470799c9da"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-22-jev-consult-attribution"
    after: "9078147d4cfb4cf7c279cd7782c59eb6c07de5d51a5c83d6c03f7ddcd0db4497"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-22-jev-consult-attribution"
    after: "8d737da518e6fcdf76d705af2a23673d46c724108ba6edd458c64d4d75467ae9"
    decision: same-version
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "27989ff93f248945ef82782308e267102e6bbeecdcee529a869f48d1af961498"
    decision: same-version
  - root: "event:team/task"
    previous: "2026-09-23-team-task-lost"
    after: "3effdd3101817efa6d603d8a62fdff3d2e2509272e1b0c36ec87ccd82e2f2469"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-22-jev-consult-attribution"
    after: "4a128b9c42f80e4fd947672025ffdfbff2fe616dc868d04664b2d638fe3bb9a1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing version-2 team/member records remain valid and are projected unchanged; the version-2 declaration keeps the record without `lastStop`. New member records are written at version 3, and an active member gains one further record per ended turn that changes only `lastStop`. On team/task, the optional `ownerStop` is present only with the `owner-failed` cause and is absent from every existing record. The `turn-continuation` message source is attribution only: readers preserve the notice without the producer.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team packages/experimental/turn-continuation --coverage: 127 tests passed with per-file 100% coverage, including the version-2 rejection of a member record with lastStop, the active-to-active outcome transition, the ownerStop cause rule, and the logged continuation notice.

<a id="dev-note"></a>
## Dev Note

None.
