---
description: "The human-facing /jev slash command for users and maintainers choosing, composing, or debugging quick Jev consults that are shared back with the agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-jev

English | [中文](README.zh.md)

## Summary

`dsh-command-jev` gives users `/jev` to ask Jev a yes/no or multiple-choice question about the recent conversation without a model turn. The answer renders directly in the UI and is also injected into the agent as a bounded notice, so the lead agent sees what its teammate told the user. Choose it in interactive deployments with a command adapter and a mounted `ctx.jev`; grammar errors, failures, and deadlines inject nothing.

## Table of Contents

- [Overview](#overview)
- [Grammar](#grammar)
- [Config](#config)
- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="overview"></a>
## Overview

The human-facing `/jev` command: the user consults Jev, the fast-thinking System One teammate, about the recent conversation through [`ctx.jev`](../jev/README.md). The answer renders directly in the UI and is also injected into the receiving agent as a plugin notice, so the lead agent sees what its teammate told the user. It is a function plugin (`inject: ['commands', 'jev']`) over the [command registry](../../interaction/commands/README.md).

<a id="grammar"></a>
## Grammar

`/jev <question>` asks a yes/no (noul) judgment. `/jev <question> | <option> | <option> [| …]` asks Jev to pick one option (choice); the full-width `｜` a CJK keyboard produces separates too. Segments are trimmed; an empty question, an empty option, a single option, or a repeated option is rejected with a usage line before anything is sent. The composer hint is `question | option | option`.

No runtime invariant companion is published; the command adapter owns no event stream or projection, and the log-only `command/run` and `command/done` pair belongs to the command registry.

<a id="config"></a>
## Config

| Key | Default | Meaning |
|---|---|---|
| `contextMessages` | `12` | Newest user and assistant messages included as state. |
| `contextChars` | `16000` | Upper bound on conversation characters in state; older messages drop first, and a lone oversized newest message keeps its tail. |
| `timeoutMs` | `30000` | Answer deadline in milliseconds. |

Every value must be a positive integer; anything else fails at load.

<a id="behavior"></a>
## Behavior

State is `{ question, conversation }`, where `conversation` holds the newest human-typed and model-said text of the session, oldest first, bounded by `contextMessages` then `contextChars`; plugin context, tool results, and text-free tool-call turns are excluded. The command waits for the dispatching request's signal or `timeoutMs`, whichever fires first. Success renders `Jev picks "<option>" (<p>%); <other> <p>%, …. Confidence <c> (<model>).` or `Jev yes <p>%, no <p>% (<model>).`. A seam failure renders `Jev is unavailable (<code>): <message>`; the deadline renders `Jev did not answer within <ms> ms.`; a caller abort is settled by the registry as an error. The command registry appends the log-only `command/run` and `command/done` pair; the command itself never turns its input into a user message.

<a id="model-experience"></a>
## Model Experience

### Shared consult notice

#### What the model sees

After a successful consult, one injected user-role message with source `{ kind: 'jev', form: 'notice' }` whose summary is `Jev consult: <question>` bounded to the shared notice limit. Its text is `The user consulted Jev, the fast-thinking System One teammate, about the recent conversation.`, then `Question: <question>`, then `Options: <a> | <b> | …` for a choice, then `Jev (<model>) answered: <the same sentence the user saw>.`. Grammar errors, seam failures, deadlines, and aborts inject nothing.

#### Token effect

One short notice per successful consult, claimed at the agent's next step boundary; an idle agent holds it until the user's next message wakes it.

#### KV Cache effect

Append-only after the reusable prefix; the notice enters history like any other injected context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **No score questions from the command line** — the grammar covers yes/no and choice; a rating on ordered levels is available through the `jev` tool.
- **Recent text only** — attachments, tool results, and file contents are not part of the state Jev sees; ask about what the conversation says.
- **A fresh session needs the browser projection** — the web GUI hides a lone generic command row behind its empty hero, so [`dsh-client-ui-jev`](../../client/ui-jev/README.md) projects the question as a Chat Node that activates the conversation; a web composition without that plugin shows a `/jev` answer only once the session has other content.

<a id="dev-note"></a>
### Dev Note

None.
