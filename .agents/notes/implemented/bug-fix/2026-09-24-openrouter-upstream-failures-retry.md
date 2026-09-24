# Agent Note: OpenRouter upstream provider failures retry like a server error

Status: implemented

English | [中文](2026-09-24-openrouter-upstream-failures-retry.zh.md)

## Problem

OpenRouter reports an upstream provider that fails while producing a response in two wordings: a bare `error` finish_reason, which pi-ai renders as `Provider finish_reason: error`, and `Upstream error from <provider>: The model stopped before completing the response.`. `classifyPiAiError` recognized neither, so both fell through to `PI_AI_ERROR`, which no retry policy retries. The step failed, the turn ended with an error, and a headless run exited having delivered nothing. In one ASI-Bench b1 sweep, 3 of the first 20 instances ended this way inside their first minutes, before any work reached the workspace.

## Decision

Both wordings map to `SERVER`, the code a 5xx maps to, because the failure belongs to the provider, not to the request: the same request replayed succeeds when the provider recovers or OpenRouter routes elsewhere. The match runs after the specific classes, so an upstream message that names authentication, quota, rate limiting, a rejected body, a context overflow, or a transport drop keeps its own code. Other finish reasons pi-ai renders the same way, such as `content_filter`, stay `PI_AI_ERROR`: repeating a filtered request cannot succeed.

## Alternatives considered

**A new retryable code such as `UPSTREAM`.** Rejected because the retry policy's default code list is deployment configuration; a new code would silently not retry on any profile that had pinned the list, while `SERVER` is already in every default.

**Retry inside the pi-ai adapter.** Rejected because retry is owned by `dsh-llm-retry` under a provider-declared policy; the adapter's job is a stable classification.

## Testing

`convert.spec.ts` pins both wordings to `SERVER` and `Provider finish_reason: content_filter` to `PI_AI_ERROR`.

## Consequences

A run survives a provider that drops mid-response, at the cost of replaying the step under the retry policy's backoff. The upstream detail OpenRouter attaches to a streamed error is still discarded by pi-ai before it reaches the adapter, so the retried failure's message names no provider.
