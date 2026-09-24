---
description: "Keep an agent going when a turn is about to end with an empty or reasoning-only message or one cut off at the output limit, with a per-turn bound on the nudges."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-turn-continuation

English | [中文](README.zh.md)

## Summary

Mount this plugin when an unattended agent must not stop on a turn that produced nothing to act on. At the turn's stop boundary it reads the last assistant message: one with no tool call and no text, or one cut off at the output limit when `onMaxTokens` is set, gets a logged notice steered back to the model, at most `maxContinuations` times per turn. The turn's recorded end reason is unchanged, so a cut-off turn still ends `max-tokens`. The cost is one extra model request per notice.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Insert the row after `dsh-base` in a profile's patch layer and set both bounds.

### When to choose it

Choose it for headless or benchmark runs, where nobody types "continue" and a reasoning-only reply would otherwise end the run with an empty answer. Skip it for interactive sessions, where the person decides whether to continue. Every agent in the process is covered, including subagents and teammates.

### Minimal configuration

```yaml
- insert:
    - id: turn-continuation
      name: '@deepseek-ai/dsh-experimental-turn-continuation'
      config:
        maxContinuations: 2
        onMaxTokens: true
```

| Field | Default | Meaning |
|---|---|---|
| `maxContinuations` | required, at least 1 | Notices sent within one turn before it may end as it is. |
| `onMaxTokens` | required | Whether a message cut off at the output limit is continued as well as an empty one. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-turn-continuation) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin listens on `agent/turn-stopping`, which the agent loop dispatches when the model owes no response. It reads the turn's latest `assistant/message` from the Session log: a `finish` chunk with reason `max-tokens` in its stream classifies it as cut off; otherwise a message with no `tool-call` block and no non-blank `text` block is empty. For either, within the per-turn bound, it calls `agent.steer()` with a user message whose source is `{ kind: 'turn-continuation', reason, attempt, form: 'notice' }`; the loop then runs another step. The bound is held per agent and turn in memory and is also readable from the logged `attempt` values. No listener order matters: the loop re-reads its inbox after every listener.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the classifier, the notice texts, and the turn-stopping listener |
| — | No runtime invariant companion is published; the notice is an ordinary logged user message and the loop owns the turn boundary. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent loop](../../core/agent-loop/README.md) — the turn-stopping hook and steering semantics.
- [Headless bundle](../../bundle/headless/README.md) — the one-shot runner whose empty final answers this plugin prevents.
- [Repeat tool reminder](../../guard/repeat-tool-reminder/README.md) — the other advisory notice plugin, for looping tool calls.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Continuation notice

#### What the model sees

After an empty or reasoning-only message the agent receives the first notice; after a message cut off at the output limit, with `onMaxTokens`, the second. Nothing is added to the system prompt or tool schemas.

##### Empty-message notice

```markdown
Your previous message contained no tool call and no text, so nothing happened and the task is not finished. Continue: call a tool, or reply with your answer.
```

##### Output-limit notice

```markdown
Your previous message was cut off at the output limit before it finished. Continue from where it stopped: call a tool, or reply with your answer, in fewer words.
```

#### Token effect

Zero tokens until a turn stalls. Each notice is retained history for that agent and costs one further model request.

#### KV Cache effect

Append-only; the notice follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the notice can and cannot change.

- **A model that keeps deliberating exhausts the bound** — after `maxContinuations` notices the turn ends as it is; the plugin does not change the end reason or the runner's exit code.
- **No keyless snapshot yet** — the notice is pinned by package tests; recording a replay scenario needs a real model run that stalls.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
