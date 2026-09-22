# Agent Note: Jev as a fast-thinking decision teammate

Status: implemented

English | [中文](2026-09-18-jev-fast-decision-teammate.zh.md)

## Problem

The harness has one kind of intelligence: a reasoning model that generates text. Many decisions inside a coding session do not need that — which of three candidate files a request is about, whether a diff is risky enough to ask before applying, which of two storage designs a user's stated constraints favor, how severe a reported bug is. Routing every such judgment through the conversation model costs a full reasoning turn, produces prose the caller must parse, and gives no calibrated signal about how sure the answer is.

TypeSafe's Jev is a System One model built for exactly these judgments: it reads supplied state and returns a typed answer with probabilities, in one fast request, with no generated text. The harness needs a way for both the lead agent and the user to consult it, with the user's consult visible to the agent so the two do not act on different information, without binding the model-facing contract to TypeSafe's wire format.

## Decision

Jev joins the harness as a capability family under `packages/jev/`:

1. `@deepseek-ai/dsh-jev` (`packages/jev/jev`) owns `ctx.jev`. It is the Service Definition and the TypeSafe implementation in one package: the request and answer vocabulary (`choice`, `noul`, `score`), caller-side validation, per-call credential resolution through `ctx.credentials` with a launch-environment fallback, the `POST /v1/systemone` transport, wire-response validation, and the `JevError` taxonomy.
2. `@deepseek-ai/dsh-tool-jev` (`packages/jev/tool-jev`) registers the model-facing `jev` tool and the `tool:jev` prompt section that introduces Jev as a fast-thinking teammate. The tool sends only the `state` the model supplies, accepts many independent questions in one call, enforces the cross-field rules the schema DSL cannot express, and renders every answer with whole-percent probabilities and confidence.
3. `@deepseek-ai/dsh-command-jev` (`packages/jev/command-jev`) registers the human `/jev` command. Its grammar is `question` for a yes/no judgment or `question | option | option` for a choice; its state is the newest human and model text of the session, bounded by count and characters. The answer renders directly and is injected into the receiving agent as a `command-jev` notice, so the user's consult becomes shared context at the agent's next step.

The `dsh-base` bundle mounts all three rows and routes the seam through OpenRouter (`baseURL: https://openrouter.ai/api`, `model: typesafe/jev-1.13`, `apiKeyEnv: OPENROUTER_API_KEY`), which serves TypeSafe's System One endpoint unchanged and lets one OpenRouter key cover Jev beside the other models a deployment already routes there; the package defaults stay on `api.typesafe.ai` for a direct TypeSafe key. A deployment without the key keeps the tool and command visible; a call then fails as `JEV_CREDENTIAL_MISSING` with the reference to store, following the web seam's rule that credential state is an execution-time fact, not a registration-time one.

### Why the seam and the vendor share one package

The capability-seam rule splits Service Definition, Service Provider, and Consumer only when the roles evolve independently. Jev is TypeSafe's model and TypeSafe's API; no second System One provider exists to register into a shared registry, and inventing a provider registry with one member would be structure without a consumer. The two Consumers are separate packages because they have different injections (`tools` and `systemPrompt` versus `commands`) and different deployments: an automation composition without a command adapter mounts the tool alone. A second vendor splits `dsh-jev` on the `dsh-web` model, with the request and answer types staying where they are.

### Why a fresh session needs `ui-jev`

The web GUI keeps a never-prompted session on its empty hero, and its Chat treats a lone generic command row as control-plane content that does not activate the conversation. `/jev` on a fresh session therefore ran, answered, and showed nothing, the same gap `/goal` closed with the [goal command-input projection](../../archived/feature/2026-08-01-goal-command-input-projection.md). `@deepseek-ai/dsh-client-ui-jev` (`packages/client/ui-jev`) follows that route: a Jev-owned Conversation Definition builds a `jev-command-input` Chat Node before the generic result row from the durable `command/run`, and its keyed renderer shows a user-style bubble with a dimmed `/jev` and the question; the plugin also owns the `jev` entry of the command-view slot, so the settled result reads as a message from Jev rather than a collapsed command row. The visible non-command Node activates the conversation, so the question and the answer row appear on a fresh session and survive reload. The grammar also accepts the full-width `｜` a CJK keyboard produces, because the first real consult typed exactly that and silently became a yes/no question.

### Why validation lives in the seam

The model tool and the human command are two callers over one JSON boundary each, and TypeSafe rejects a malformed question only after a round trip. `decide()` validates ids, instructions, option counts, and level counts before a credential is read, and validates every wire answer against the question that produced it before publishing, so neither consumer can receive a choice the request never offered. The tool adds only the rules that exist at its own boundary: which fields belong with which question type, budgets, and duplicate ids.

### Why `/jev` shares its answer with the agent

A teammate whose advice only one party hears splits the team. Injecting the consult as a `form: 'notice'` message under the command's own `jev` source kind, qualified with `@persistenceAttribution` so older readers preserve it at the same Session format, follows plan mode's precedent for human actions the model must know about: it is durable once claimed, it does not wake an idle agent, and its summary keeps the transcript row short. The command sends the recent conversation as state because the user asks in the context of the conversation, while the tool sends nothing implicit because the model already knows what it is deciding and a bounded, explicit state keeps each judgment reproducible.

## Testing

`ui-jev` pins its Definition, ordering before the result row, done-only windows, renderer semantics, and fiber disposal in jsdom specs, and the keyless assembled-browser scenario `jev-command-presentation` submits `/jev` on a fresh session with an unset credential reference, verifies the bubble, the deterministic failure row, the absence of model-surface events, and the reloaded transcript. Each package proves its contract through the real registry it registers into with only the network stubbed: the seam suite covers every validation rule, credential path, HTTP status class, abort timing, and malformed body; the tool suite executes through `ctx.tools.execute()` and pins the rendered text and canonical value; the command suite executes through `ctx.commands.execute()` over a real Session and pins the state body, the direct result, the injected notice, and the lifecycle pair. Each package also boots through the Loader from a `cordis.yml`, proving defaults and load-time rejection. The `apps/cli/tests/profiles/headless` snapshot suite runs a keyless `jev-decision` scenario over the real headless app with a scripted adapter and a loopback TypeSafe stub, pinning the model-visible tool round trip end to end.

## Alternatives considered

**Register Jev as a subagent provider.** Rejected: the subagent seam delivers a prompt to a child that runs a turn and returns text; Jev takes typed questions and returns distributions, so every subagent-shaped call would have to invent a prompt-to-question translation and parse a result back out of prose, losing the calibrated signal that is the point.

**Make Jev an Agent Teams teammate.** Rejected for now: the experimental Team roster models durable continuable children with mailboxes and a task board, all of which presume a conversational member. A tool and a command give the lead agent and the user the same access with none of that machinery; a Team-facing adapter can be added over `ctx.jev` if Teams ever needs a non-conversational member.

**Use the `@typesafe-ai/sdk` package.** Rejected for this version: the endpoint is one POST, the harness's other external providers (Exa, Perplexity, DeepSeek search) hand-roll `fetch` with the same redirect, abort, and status-mapping rules, and the SDK's retry and timeout machinery would sit between the tool-call timeout policy and the request. The SDK returns as a dependency when a retry policy has a consumer.

**Surface the `/jev` answer as a composer notice on a blank session.** Rejected because a notice is transient and leaves the transcript without the consult on reload, while the goal precedent already established that a feature-owned Chat Node is how a human command earns a place on a fresh session.

**Gate the tool on a key at registration.** Rejected: credential availability is asynchronous and can change while the process runs, and the web seam already established that a stable schema with an execution-time failure is the right model-facing contract.

**Ask score questions from `/jev`.** Deferred: a third grammar form would make the command line ambiguous between options and levels; the tool exposes score, and the command grows a form when a user need shows it.

## Consequences

**Two model-visible additions on every base request.** The `jev` schema and the `tool:jev` section cost fixed tokens on every request in the base bundle, whether or not a key is present; a profile patch can disable the rows.

**Judgments are only as good as the supplied state.** Jev sees nothing the caller does not send, so an incomplete `state` yields a confident answer about the wrong facts. The prompt section and the tool description both say so, and the command's bounded conversation window is documented as the whole of what the user's consult sees.

**No retry.** A rate limit or transient provider failure surfaces once as a `JevError`; the model or the user decides whether to try again.

**One vendor in one package.** Adding a second System One provider means splitting `dsh-jev` into a definition and two implementations, a rename the pre-release stance permits without a compatibility shim.
