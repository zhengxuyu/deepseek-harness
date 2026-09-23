---
description: "The model-facing jev tool for users and maintainers choosing, bounding, or debugging how an agent consults Jev for calibrated judgments."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-jev

English | [中文](README.zh.md)

## Summary

`dsh-tool-jev` exposes Jev to the model as the `jev` tool with a fixed prompt section, so an agent can ask calibrated choice, yes/no, and score questions about state it supplies in one call. Choose it wherever `ctx.jev` is mounted and the agent should decide quickly on semantic reading; the tool bounds question count and state size and renders answers as whole-percent lines. The seam owns credentials, transport, and answer validation. It mounts only when `DSH_JEV_ENABLED=yes`.

## Table of Contents

- [Overview](#overview)
- [Config](#config)
- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="overview"></a>
## Overview

The model-facing `jev` tool: the agent consults Jev, the fast-thinking System One teammate, through [`ctx.jev`](../jev/README.md). The tool owns the model-visible name, schema, prompt guidance, the argument rules the schema DSL cannot express, and result rendering; the seam owns credentials, transport, and answer validation. It is a function plugin (`inject: ['tools', 'jev', 'systemPrompt']`).

No runtime invariant companion is published; the tool registers one schema whose disposal the HMR-safety spec proves, and the `tool/call` and `tool/result` pair it writes is owned by the tool registry.

<a id="config"></a>
## Config

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `30000` | Cooperative timeout budget attached as `ToolDefinition.timeoutMs`; the tool-call timeout policy enforces it. |
| `maxQuestions` | `16` | Upper bound on questions in one call. |
| `maxStateChars` | `64000` | Upper bound on serialized `state` characters in one call. |

Every value must be a positive integer; anything else fails at load.

<a id="behavior"></a>
## Behavior

The generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-jev) owns the exact schema. `state` is a string or an object; `questions` is an array of `{ id, type, instructions, options?, levels? }`. Before dialing, the tool rejects an empty list, more than `maxQuestions` questions, a duplicate id, oversized state, a `choice` without `options` or with `levels`, a `noul` with either, a `score` without `levels` or with `options`, and an option description that is neither a string nor null; the seam's own rules (option and level counts, blank text) reject next. Answers return in the request's question order as the canonical value `{ model, answers: [{ id, ...answer }], usage }`, and the rendered text lists one line per answer with whole-percent probabilities and two-decimal confidence. A seam failure is a structured tool error carrying the `JevError` code. The pending card is a generic `Ask Jev` card over the raw arguments.

<a id="model-experience"></a>
## Model Experience

### Tool guidance section

#### What the model sees

The `tool:jev` prompt section at the centrally allocated `TOOL_JEV` order (2500, after the goal tool guidance):

##### Verbatim `tool:jev` section

```markdown
Jev is a fast-thinking teammate available through the `jev` tool: a System One model that returns calibrated judgments instead of prose. Consult it for quick decisions that hinge on reading rather than lookup or computation; put every fact the judgment needs in `state`, ask independent questions together, and treat the returned probabilities and confidence as signals to threshold on — a low-confidence answer on a consequential decision is a reason to gather more evidence or ask the user, not to guess. You keep responsibility for exact facts, calculations, and the final decision.
```

#### Token effect

Fixed on every request while the plugin is mounted.

#### KV Cache effect

Prefix-stable: the text is a constant, so it does not invalidate reuse across requests; mounting or unmounting the plugin changes the prefix once.

### Tool schema

#### What the model sees

The `jev` schema in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-jev); the `questions` description carries the configured `maxQuestions`.

#### Token effect

Fixed on every request while the plugin is mounted.

#### KV Cache effect

Prefix-stable for a fixed `maxQuestions`; changing that value changes the schema text and the prefix once.

### Tool result

#### What the model sees

`Jev (<model>) answered:` followed by one line per answer: `- <id> (choice): <choice> — <option> <p>%, …; confidence <c>`, `- <id> (noul): yes <p>%`, or `- <id> (score): <score> on 0–<top> — <index> "<level>" <p>%, …; confidence <c>`. A rejected call shows the rejection reason; a seam failure shows the `JevError` message.

#### Token effect

Grows with the number of questions, options, and levels; probabilities are whole percents and every level description is repeated once.

#### KV Cache effect

Append-only after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Jev sees only `state`** — the tool sends no conversation history, so the model must restate the facts a judgment needs; that keeps the request bounded and the judgment reproducible.
- **Option and level probabilities are open objects in the output schema** — the DSL cannot type a numeric-valued record, so Code Mode reads `probabilities` and `legend` as `Record<string, JsonValue>`.
- **No confidence gate** — the tool returns every answer; thresholds belong to the calling model or a policy listener, not to a fixed number here.

<a id="dev-note"></a>
### Dev Note

None.
