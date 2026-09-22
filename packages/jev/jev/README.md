---
description: "The Jev judgment seam (ctx.jev) for users and maintainers configuring TypeSafe or OpenRouter credentials, the request and answer vocabulary, and JevError codes."
kind: "package-reference"
---

# @deepseek-ai/dsh-jev

English | [中文](README.zh.md)

## Summary

`dsh-jev` is the Jev judgment seam: `ctx.jev.decide()` validates one request, resolves its credential for that call, posts it to TypeSafe or OpenRouter, and validates every answer before a consumer sees it. Choose it when a plugin needs calibrated choice, yes/no, or score judgments about supplied state without a model turn; it registers no tool and no command. A deployment without a key learns that at the first call as `JEV_CREDENTIAL_MISSING`.

## Table of Contents

- [Overview](#overview)
- [Config](#config)
- [Service API](#service-api)
- [Errors](#errors)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="overview"></a>
## Overview

Service Definition and TypeSafe-backed implementation of the Jev judgment seam (`ctx.jev`). Jev is [TypeSafe](https://docs.typesafe.ai)'s System One model: it answers typed questions about supplied state with calibrated probabilities and generates no text. `decide()` validates one request, resolves its credential for that call, posts `POST {baseURL}/v1/systemone`, and validates every answer before a consumer sees it.

This package owns the `ctx.jev` key, the request and answer vocabulary, and the `JevError` taxonomy. It registers no tool and no command; [`dsh-tool-jev`](../tool-jev/README.md) and [`dsh-command-jev`](../command-jev/README.md) are the consumers. Like every other seam it is a default-export `Service`.

No runtime invariant companion is published; the seam owns no session event stream or mutable projection, and every request and answer is validated inside the call that carries it.

<a id="config"></a>
## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal TypeSafe API key. Prefer `apiKeyEnv` so no secret enters configuration; a non-empty literal wins. |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | Credential reference resolved for each request through `ctx.credentials`, or from the launch environment when that seam is absent. Nothing resolving fails the call as `JEV_CREDENTIAL_MISSING`. |
| `baseURL` | `https://api.typesafe.ai` | Endpoint base; `/v1/systemone` is appended and a trailing slash is dropped. Falls back to `$TYPESAFE_BASE_URL`. An unparseable value fails at load. |
| `model` | `jev-latest` | Model sent when a request names none. |

```yaml
- id: jev
  name: '@deepseek-ai/dsh-jev'
  config:
    apiKeyEnv: TYPESAFE_API_KEY
```

OpenRouter serves the same endpoint under `https://openrouter.ai/api/v1/systemone` with the same body and answers, accepting both `jev-1.13` and `typesafe/jev-1.13` model ids. The shipped `dsh-base` row uses that route:

```yaml
- id: jev
  name: '@deepseek-ai/dsh-jev'
  config:
    apiKeyEnv: OPENROUTER_API_KEY
    baseURL: https://openrouter.ai/api
    model: typesafe/jev-1.13
```

<a id="service-api"></a>
## Service API

`decide(request, signal?)` takes lossless-JSON `state` plus at least one question keyed by a caller-owned id and resolves one validated answer per id, the exact model that answered, and token usage. Questions run in parallel on the provider and cannot see one another's answers; ask every independent question about the same state in one call.

| Question | Answer | Caller-side rule |
|---|---|---|
| `choice` — `options: { name: description \| null }` | `choice`, `probabilities` per option, `confidence` | at least two non-blank option names |
| `noul` — a yes/no condition | `noul`, the probability of yes | none beyond non-blank instructions |
| `score` — `levels: string[]` ordered low to high | `score` (probability-weighted index), `legend`, `probabilities` per index, `confidence` | two through ten non-blank levels |

Validation rejects before any credential is read or byte is sent. The wire body is untrusted: an answer whose type differs from its question, a chosen option the request did not offer, or a non-numeric probability fails as `JEV_PROVIDER_ERROR` rather than reaching a consumer. `describe()` returns the credential reference, base URL, and default model in force and never a key value.

<a id="errors"></a>
## Errors

`JevError extends HarnessError` with an open `code`: `JEV_INVALID_REQUEST` (caller-side violation or HTTP 400/422), `JEV_CREDENTIAL_MISSING`, `JEV_UNAUTHORIZED` (401/403), `JEV_RATE_LIMITED` (429/529), `JEV_ABORTED` (the caller's signal fired before or during the call), and `JEV_PROVIDER_ERROR` (network failure, any other status, or an unprocessable body). HTTP redirects are rejected before the target is contacted. A provider error message is appended to the HTTP status when the body carries one.

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-jev`](../tool-jev/README.md) and [`dsh-command-jev`](../command-jev/README.md): this seam renders nothing itself, and each consumer owns the wording of the answers and of the exact `JevError` messages it surfaces.

#### KV Cache effect

No direct invalidation; the seam never enters a conversation request prefix, and each TypeSafe request is an independent auxiliary call outside the conversation model's cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **No retry** — a `JEV_RATE_LIMITED` or transient `JEV_PROVIDER_ERROR` is surfaced once; TypeSafe's SDKs retry with backoff and a retry policy here waits on a consumer that needs it.
- **Credential availability resolves inside the call** — there is no synchronous `available()`; a keyless deployment learns it at the first `decide()` as `JEV_CREDENTIAL_MISSING`.
- **Text-only state** — TypeSafe accepts no images or audio; `state` is lossless JSON and its size is bounded by consumers, not by this seam.
- **One vendor** — the Service Definition and the TypeSafe implementation share this package; a second System One provider splits them on the `dsh-web` model.

<a id="dev-note"></a>
### Dev Note

None.
