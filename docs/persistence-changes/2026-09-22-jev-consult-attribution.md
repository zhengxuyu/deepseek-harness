---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-jev-consult-attribution

English | [中文](2026-09-22-jev-consult-attribution.zh.md)

## Summary

Adds the attribution-only `jev` message-source kind that `/jev` stamps on the consult notice it injects into the agent. The kind carries only the notice form and its one-line summary and retains the Session format version.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-jev-consult-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "c9e69823cdc9f748b98ba3c8991b739e69631baf1dde609107bb6c58874d783d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "48bae64c4f84ce2749b26385788b3700573d9d86993c755ab586079a3f910ca6"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "b0bcf7d757863f48d38899c30ab608ae55864200c09ef6296b2390a2a3c2fb1a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "d634b0e4a22f5525bb396007039f9625faeccbaf821ed8e42e011e3b2290b768"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The `jev` kind is qualified with `@persistenceAttribution`: older readers preserve a user or developer message whose source kind they do not know, together with its `form` and `summary` metadata, and derive history from it without `dsh-command-jev`. The kind imposes no validation, replay, or authority requirement; the producer never inspects it on resume. Existing records are unchanged because no event, header, or envelope field was added, removed, or retyped.

<a id="verification"></a>
## Verification

`pnpm exec tsx scripts/persistence-changes.ts --check` classifies every touched root as an attribution-only source kind addition at the same version, and `pnpm run gen-persistence-catalog` regenerated the catalog and schema. The `dsh-command-jev` unit suite pins the injected notice's source, and the keyless headless and Web snapshots replay a `/jev` consult over the shipped profiles.

<a id="dev-note"></a>
## Dev Note

None.
