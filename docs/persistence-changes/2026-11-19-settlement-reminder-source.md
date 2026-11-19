---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-19-settlement-reminder-source

English | [中文](2026-11-19-settlement-reminder-source.zh.md)

## Summary

Adds the attribution-only message source kind `agent-team-settlement`, carried by the reminder the settlement plugin sends to a root whose turn completed with the run's declared outputs unsettled.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-19-settlement-reminder-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-23-member-turn-outcomes"
    after: "f68f6bcd4a80cb8e254770a60adb7b2dd94d2d9884b624d4bc6ff3c73cccb067"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-23-member-turn-outcomes"
    after: "22208a47bf9fb77d6ea7a00a7ae029082bde883787e4f4af684a058de1487f35"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-23-member-turn-outcomes"
    after: "636aaae3c1c75887030ae867eb09b8205342e3e86e7dc77bfbf220bd505ea416"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-23-member-turn-outcomes"
    after: "e05b0578f57d2d62e43494695137cbb6ed8892acd66f9bfc98d87ceb537ae6ed"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. The kind only attributes a user message; readers that do not know the producer preserve the notice, and nothing validates, replays, or authorizes by it. Logs written without the settlement plugin never contain it.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team-settlement: 15 tests passed, including the logged reminder's source fields.

<a id="dev-note"></a>
## Dev Note

None.
