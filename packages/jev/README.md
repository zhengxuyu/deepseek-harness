---
description: "The jev package group: TypeSafe's System One model as a fast-thinking teammate, with the judgment seam, the model-facing jev tool, and the human /jev command, for readers choosing or navigating the family."
kind: "package-group"
---

# jev/ — Jev judgment capability family

English | [中文](README.zh.md)

## Summary

The jev group makes TypeSafe's System One model a fast-thinking teammate of the harness. The agent consults it through the `jev` tool, and the user consults it through `/jev`, whose answer is shared back with the agent. `jev` owns the seam, the request and answer vocabulary, and the TypeSafe transport; `tool-jev` and `command-jev` are its two consumers. Jev returns calibrated typed judgments, never prose, and sees only the state each consumer sends. The rows ship disabled; `DSH_JEV_ENABLED=yes` in the launching environment mounts them.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Jev is [TypeSafe](https://typesafe.ai)'s System One model: it reads supplied state and returns calibrated, typed judgments (a chosen option, a yes probability, a rating on ordered levels) instead of prose. This family makes Jev a fast-thinking teammate of the harness: the agent consults it through a tool, and the user consults it through a slash command whose answer is shared with the agent.

| Package | Role | ctx key |
|---|---|---|
| [`jev/`](jev/README.md) | Defines the judgment request, answer, and error vocabulary and posts requests to TypeSafe | `ctx.jev` |
| [`tool-jev/`](tool-jev/README.md) | Exposes Jev to the model as the `jev` tool | registers on `ctx.tools` |
| [`command-jev/`](command-jev/README.md) | Exposes Jev to the user as `/jev` and shares the consult with the agent | registers on `ctx.commands` |

<a id="related-documentation"></a>
## Related documentation

The seam and its one TypeSafe implementation share a package because no second System One vendor exists to split them over; the [Jev teammate Agent Note](../../.agents/notes/implemented/feature/2026-09-18-jev-fast-decision-teammate.md) owns that choice and the rest of the design.

The subsystem reference — `JevRequest`, `JevResult`, `JevError` — is [docs/subsystems/jev.md](../../docs/subsystems/jev.md).

<a id="dev-note"></a>
## Dev Note

None.
