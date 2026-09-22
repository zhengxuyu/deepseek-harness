/**
 * Domain and wire types for the Jev judgment seam. Types only — no runtime
 * code. The domain half is what `ctx.jev` callers send and receive; the wire
 * half is TypeSafe's `POST /v1/systemone` JSON, kept separate so a caller
 * never depends on provider field spelling.
 * @module @deepseek-ai/dsh-jev/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Select exactly one named option; the answer carries the full distribution. */
export interface JevChoiceQuestion {
  readonly type: 'choice'
  /** The judgment, written to stand alone; question ids are never sent to the model. */
  readonly instructions: string
  /** Option name → short description, or `null` when the name is self-explanatory. At least two. */
  readonly options: Readonly<Record<string, string | null>>
}

/** Whether a condition holds; the answer is the probability of yes. */
export interface JevNoulQuestion {
  readonly type: 'noul'
  /** The yes/no condition, written to stand alone. */
  readonly instructions: string
}

/** Degree along ordered, described levels; the answer is a probability-weighted position. */
export interface JevScoreQuestion {
  readonly type: 'score'
  /** The dimension being rated, written to stand alone. */
  readonly instructions: string
  /** Ordered level descriptions from lowest to highest, two through ten, each describing a concrete situation. */
  readonly levels: readonly string[]
}

/** One typed question; switch on `type`, which is a closed union. */
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion

/** One judgment request: shared state plus independent named questions answered in parallel. */
export interface JevRequest {
  /** Every fact the questions need — source text, identities, constraints. Prefer named fields over one blob. */
  readonly state: JsonValue
  /** Questions keyed by caller-owned id; at least one. Ids stay in code and never reach the model. */
  readonly questions: Readonly<Record<string, JevQuestion>>
  /** Per-request model override; the service's configured model otherwise. */
  readonly model?: string
}

/** Answer to a {@link JevChoiceQuestion}. */
export interface JevChoiceAnswer {
  readonly type: 'choice'
  /** The option with the highest probability. */
  readonly choice: string
  /** Probability per option name, summing to one. */
  readonly probabilities: Readonly<Record<string, number>>
  /** Zero through one: how concentrated the distribution is, not workflow correctness. */
  readonly confidence: number
}

/** Answer to a {@link JevNoulQuestion}. */
export interface JevNoulAnswer {
  readonly type: 'noul'
  /** Probability that the condition holds; near 0.5 means genuinely uncertain, not medium intensity. */
  readonly noul: number
}

/** Answer to a {@link JevScoreQuestion}. */
export interface JevScoreAnswer {
  readonly type: 'score'
  /** Probability-weighted level position, zero through `levels.length - 1`. */
  readonly score: number
  /** Level index (as a string) → the level description that was sent. */
  readonly legend: Readonly<Record<string, string>>
  /** Probability per level index (as a string), summing to one. */
  readonly probabilities: Readonly<Record<string, number>>
  /** Zero through one: how concentrated the distribution is. */
  readonly confidence: number
}

/** One typed answer; switch on `type`, which is a closed union. */
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer

/** Token accounting for one request; output tokens are reported but not billed by TypeSafe. */
export interface JevUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** One settled judgment request. */
export interface JevResult {
  /** The exact model that answered (an alias such as `jev-latest` resolves to a version). */
  readonly model: string
  /** One answer per request question id, each matching its question's `type`. */
  readonly answers: Readonly<Record<string, JevAnswer>>
  readonly usage: JevUsage
}

/** One question as TypeSafe's System One endpoint receives it. */
export interface SystemOneWireQuestion {
  type: 'choice' | 'noul' | 'score'
  instructions: string
  /** Choice: option name → description or null. Score: ordered level array. Noul: absent. */
  criteria?: Readonly<Record<string, string | null>> | readonly string[]
}

/** Request body of `POST /v1/systemone`. */
export interface SystemOneWireRequest {
  state: JsonValue
  model: string
  questions: Record<string, SystemOneWireQuestion>
}

/** Response body of `POST /v1/systemone` (best-effort fields; the seam validates before trusting). */
export interface SystemOneWireResponse {
  model?: unknown
  answers?: unknown
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
}

/** Error envelope TypeSafe returns on a non-2xx status (fields vary by failure). */
export interface SystemOneWireError {
  error?: string | { message?: string }
  message?: string
}
