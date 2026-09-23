# Jev 判断

[English](jev.md) | 中文

Jev 判断 seam——一个[能力 seam](../../.agents/notes/implemented/feature/2026-09-18-jev-fast-decision-teammate.zh.md)，由一个 Service Definition 兼 TypeSafe 实现（[dsh-jev](../../packages/jev/jev)，`ctx.jev`）和两个 Consumer 组成：[dsh-tool-jev](../../packages/jev/tool-jev) 是面向模型的 `jev` 工具，[dsh-command-jev](../../packages/jev/command-jev) 是用户的 `/jev` 命令。Jev 是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇放在这里而非 [core.md](core.zh.md)。消费方发送无损 JSON 状态和带类型的问题，收到的是概率，绝不是文本。

来源：[`packages/jev/jev/src/types.ts`](../../packages/jev/jev/src/types.ts) 与 [`packages/jev/jev/src/index.ts`](../../packages/jev/jev/src/index.ts)

## 请求

一次请求携带共享状态和以调用方 id 为键的相互独立的问题。id 只留在代码中；到达模型的只有 `instructions` 和判据，因此每个问题必须自成一体。

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

`JevQuestion` 是 `choice`（带可选描述的具名选项）、`noul`（一个是／否条件）和 `score`（两到十个有序等级描述）的封闭联合类型；消费方按 `type` 做 `switch` 并以 `assertNever` 收尾。

## 结果

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

`JevAnswer` 与问题联合类型一一对应：choice 答案携带胜出的 `choice`、逐选项的 `probabilities` 和 `confidence`；noul 答案携带 `noul`，即"是"的概率；score 答案携带概率加权的 `score`、从等级索引到描述的 `legend`、逐索引的 `probabilities` 和 `confidence`。confidence 概括分布的集中程度，不代表工作流是否正确；接近 0.5 的 noul 表示真正的不确定，而非"中等强度"。

## 端点描述

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

## 错误

`JevError extends HarnessError`（[core.md](core.zh.md) 错误分类）并带有开放的 `code`：`JEV_INVALID_REQUEST`、`JEV_CREDENTIAL_MISSING`、`JEV_UNAUTHORIZED`、`JEV_RATE_LIMITED`、`JEV_ABORTED` 和 `JEV_PROVIDER_ERROR`。请求校验在读取凭据之前运行；协议响应会先对照请求校验，然后才发布任何答案。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
