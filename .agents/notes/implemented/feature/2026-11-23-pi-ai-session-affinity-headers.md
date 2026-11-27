# Agent Note: Session-affinity headers on hand-declared Chat Completions routes

Status: implemented

English | [中文](2026-11-23-pi-ai-session-affinity-headers.zh.md)

## Problem

A self-hosted Chat Completions endpoint behind a recording gateway, such as an RL rollout server in front of SGLang, must attribute every model call to the Session that made it. One run interleaves calls from a lead Session and its teammate or subagent Sessions on the same route, and neither the request URL nor the message body names the Session. The Session log records the calls but carries no token ids, so the gateway's record and the Session log can be joined only through an identifier that both sides see.

The direct DeepSeek adapter already sends `x-deepseek-harness-session-id`, but it speaks Anthropic Messages, which these servers do not necessarily accept. pi-ai's `openai-completions` transport can send the Session id as session-affinity headers, and the `sendSessionAffinityHeaders` compat switch controls that behavior. The [wire-compat surface](../../archived/feature/2026-08-18-pi-ai-wire-compat-surface.md) withheld that switch because it treated the switch as owned by named catalog vendors. As a result, a hand-declared route could not enable it.

## Decision

The `openai-completions` compat gate offers `sendSessionAffinityHeaders`. `PiAiCompatProfile`, the `compat` schema and the generated configuration catalog name it. Like every offered switch, a route or a single model sets it. When it is `true` and the request carries a Session id, pi-ai sends that id as `x-client-request-id` and `x-session-affinity` headers, plus `session_id` under its default `openai` affinity format. The agent loop supplies that Session id for ordinary agent, title and compaction requests. A request without a Session id, or one whose route sets `cacheRetention: none`, sends no affinity header. A route that does not set the switch keeps its installed or detected value.

The decision is limited to `openai-completions`. `sessionAffinityFormat` remains withheld, so a hand-declared route uses the spelling pi-ai detects from it: a route whose provider is `openrouter` or whose `baseURL` contains `openrouter.ai` sends only `x-session-id`, and every other route sends the three headers above. The Anthropic Messages gate still withholds `sendSessionAffinityHeaders`, so resolution refuses the key on that protocol.

## Alternatives considered

**Keep the switch withheld and join by content.** A gateway can match each recorded completion against the assistant messages in the Session log. Identical completions in different Sessions are ambiguous, and the match depends on byte-exact text, tool-call, and reasoning serialization across two components. The header is an identifier that the harness already owns.

**Set the header through the route's `headers`.** Profile headers are fixed for the route, so every Session on it would send the same value.

**Route through the direct DeepSeek adapter.** It sends the Session id, but it requires an Anthropic Messages endpoint. A Chat Completions server would therefore need a translating proxy.

**Offer `sessionAffinityFormat` as well.** No current endpoint needs another spelling: a gateway that the deployment owns can read `x-session-affinity`, which every format except OpenRouter's sends. The switch remains withheld until an endpoint requires another spelling.

## Consequences

A rollout gateway can group recorded calls by Session from a request header that the harness controls. Joining a recorded call to the Session log entry still depends on per-Session call order, and that join is outside the harness.

The archived catalog-ownership rule now has one exception. A hand-declared route that enables the switch sends a stable per-Session identifier to its endpoint. That route therefore receives the Session-correlation exposure that the direct DeepSeek adapter already gives its endpoint.
