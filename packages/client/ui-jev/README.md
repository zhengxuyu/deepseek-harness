---
description: "The browser projection of /jev for users and maintainers debugging how a Jev question and answer appear in the web transcript."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jev

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-jev` shows each `/jev` question as a user-style bubble and renders Jev's settled answer as a message from Jev instead of a collapsed command row. Choose it in web compositions that mount `dsh-command-jev`, so a consult made on a fresh session activates the conversation instead of hiding under the empty hero. It projects the durable command run only: no model message, no store, and no event listener.

## Table of Contents

- [Overview](#overview)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="overview"></a>
## Overview

Jev surface plugin, browser half. It projects each durable `/jev` `command/run` through its own Conversation Definition: a `jev-command-input` Chat Node built immediately before the generic command result Node, rendered by this plugin's keyed renderer as a right-aligned user-style bubble that shows a dimmed `/jev` followed by the question as typed, under the localized group name `Question to Jev` / `向 Jev 提问`, with no timestamp, copy, or branch actions. It also registers the `jev` entry of the command-view slot, so the command's settled result renders as a left-aligned message from Jev (sender line `Jev · fast-thinking teammate`, then the answer text, the failure text, or a thinking placeholder while the run is open) instead of the generic collapsed command row. A visible non-command Node activates a fresh session's Chat, so a consult made before the first prompt shows its question and Jev's answer instead of leaving the page on the empty hero; a history window holding only `command/done` keeps the generic result row alone. The projection reads the durable run only: it creates no `user/message`, no model turn, no store, and no event listener. [`dsh-command-jev`](../../jev/command-jev/README.md) owns the command itself.

The `/client` exports are the plugin body (`apply`/`inject`) and the node data and locale key types.

No runtime invariant companion is published; the plugin projects a durable command run into presentation and owns no store, listener, or event.

<a id="model-experience"></a>
## Model Experience

None, as the plugin only projects a durable command run into browser presentation; the command's model-visible notice belongs to `dsh-command-jev`.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Text only** — the answer message repeats the command's settled sentence; the probabilities are not rendered as a chart, and a window holding only `command/done` shows the answer without its question.

<a id="dev-note"></a>
### Dev Note

None.
