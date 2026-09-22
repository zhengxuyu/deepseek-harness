# Jev Judgments

English | [中文](jev.zh.md)

The Jev judgment seam — a [capability seam](../../.agents/notes/implemented/feature/2026-09-18-jev-fast-decision-teammate.md) with one Service Definition and TypeSafe implementation ([dsh-jev](../../packages/jev/jev), `ctx.jev`) and two Consumers: [dsh-tool-jev](../../packages/jev/tool-jev), the model-facing `jev` tool, and [dsh-command-jev](../../packages/jev/command-jev), the human `/jev` command. Jev is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md). A consumer sends lossless-JSON state and typed questions and receives probabilities, never prose.

Source: [`packages/jev/jev/src/types.ts`](../../packages/jev/jev/src/types.ts) and [`packages/jev/jev/src/index.ts`](../../packages/jev/jev/src/index.ts)

## Request

One request carries shared state and independent questions keyed by caller ids. Ids stay in code; only `instructions` and criteria reach the model, so each question must stand alone.

```ts type-equiv
/** One judgment request: shared state plus independent named questions answered in parallel. */
interface JevRequest {
  /** Every fact the questions need — source text, identities, constraints. Prefer named fields over one blob. */
  readonly state: JsonValue
  /** Questions keyed by caller-owned id; at least one. Ids stay in code and never reach the model. */
  readonly questions: Readonly<Record<string, JevQuestion>>
  /** Per-request model override; the service's configured model otherwise. */
  readonly model?: string
}
```

`JevQuestion` is the closed union of `choice` (named options with optional descriptions), `noul` (a yes/no condition), and `score` (two through ten ordered level descriptions); consumers `switch` on `type` and end in `assertNever`.

## Result

```ts type-equiv
/** One settled judgment request. */
interface JevResult {
  /** The exact model that answered (an alias such as `jev-latest` resolves to a version). */
  readonly model: string
  /** One answer per request question id, each matching its question's `type`. */
  readonly answers: Readonly<Record<string, JevAnswer>>
  readonly usage: JevUsage
}
```

`JevAnswer` mirrors the question union: a choice answer carries the winning `choice`, `probabilities` per option, and `confidence`; a noul answer carries `noul`, the probability of yes; a score answer carries the probability-weighted `score`, a `legend` from level index to description, `probabilities` per index, and `confidence`. Confidence summarizes how concentrated a distribution is; it is not workflow correctness, and a noul near 0.5 means genuine uncertainty rather than medium intensity.

## Endpoint description

```ts type-equiv
/** Resolved endpoint facts a consumer may show without a value. */
interface JevEndpointInfo {
  /** The credential reference each request resolves. */
  readonly apiKeyEnv: CredentialRef
  /** The endpoint base requests are posted under. */
  readonly baseURL: string
  /** The model sent when a request names none. */
  readonly model: string
}
```

## Errors

`JevError extends HarnessError` ([core.md](core.md) error taxonomy) with an open `code`: `JEV_INVALID_REQUEST`, `JEV_CREDENTIAL_MISSING`, `JEV_UNAUTHORIZED`, `JEV_RATE_LIMITED`, `JEV_ABORTED`, and `JEV_PROVIDER_ERROR`. Request validation runs before the credential is read; the wire response is validated against the request before any answer is published.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjev--jevruntime"></a>

### `ctx.jev` — `JevRuntime`

The Jev judgment service, registered as `ctx.jev`. One request is one `decide()` call; questions inside it run in parallel on the provider and cannot see one another's answers.

```ts cordis-catalog
/**
 * Describe the endpoint without exposing any credential value.
 * @returns the credential reference, base URL, and default model in force.
 */
describe(): JevEndpointInfo

/**
 * Answer one request. Validation failures reject before any network call;
 * the credential is resolved per call so a stored or rotated key reaches the
 * next request without a restart.
 * @param request - state plus at least one typed question.
 * @param signal - optional cancellation; an abort rejects as `JEV_ABORTED`.
 * @returns one validated answer per question id.
 * @throws {JevError} with a code from the {@link JevError} taxonomy.
 */
async decide(request: JevRequest, signal?: AbortSignal): Promise<JevResult>
```

Source: [`packages/jev/jev/src/index.ts`](../../packages/jev/jev/src/index.ts)
<!-- END GENERATED cordis-surface -->
