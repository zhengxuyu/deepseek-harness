/**
 * Pure request validation and wire mapping for the Jev seam: caller requests
 * become TypeSafe System One bodies, and response bodies become validated
 * {@link JevResult}s. No I/O lives here.
 * @module @deepseek-ai/dsh-jev/wire
 */

import { JevError } from './error.ts'
import type {
  JevAnswer,
  JevQuestion,
  JevRequest,
  JevResult,
  SystemOneWireQuestion,
  SystemOneWireRequest,
  SystemOneWireResponse,
} from './types.ts'

/** Fewest options a choice question may carry; one option is not a choice. */
export const JEV_MIN_CHOICE_OPTIONS = 2
/** Fewest levels a score question may carry (TypeSafe's floor). */
export const JEV_MIN_SCORE_LEVELS = 2
/** Most levels a score question may carry (TypeSafe's ceiling). */
export const JEV_MAX_SCORE_LEVELS = 10

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown Jev question type: ${String(value)}`)
}
/* v8 ignore stop */

function invalid(message: string): never {
  throw new JevError(message, 'JEV_INVALID_REQUEST')
}

function assertNonBlank(value: string, what: string): void {
  if (value.trim().length === 0) invalid(`${what} must not be blank`)
}

/**
 * Validate one question's caller-side constraints: non-blank instructions,
 * at least two distinct non-blank choice options, and two through ten
 * non-blank score levels.
 * @param id - the question id, for the failure message.
 * @param question - the question to check.
 * @throws {JevError} `JEV_INVALID_REQUEST` on the first violation.
 */
export function assertQuestion(id: string, question: JevQuestion): void {
  assertNonBlank(question.instructions, `question "${id}" instructions`)
  switch (question.type) {
    case 'choice': {
      const names = Object.keys(question.options)
      if (names.length < JEV_MIN_CHOICE_OPTIONS) {
        invalid(`question "${id}" needs at least ${JEV_MIN_CHOICE_OPTIONS} options`)
      }
      for (const name of names) assertNonBlank(name, `question "${id}" option name`)
      return
    }
    case 'noul':
      return
    case 'score': {
      const count = question.levels.length
      if (count < JEV_MIN_SCORE_LEVELS || count > JEV_MAX_SCORE_LEVELS) {
        invalid(`question "${id}" needs ${JEV_MIN_SCORE_LEVELS} through ${JEV_MAX_SCORE_LEVELS} levels`)
      }
      for (const level of question.levels) assertNonBlank(level, `question "${id}" level`)
      return
    }
    /* v8 ignore next 2 -- JevQuestion is closed and every member is handled above */
    default: return assertNever(question)
  }
}

/**
 * Validate a whole request: at least one question, non-blank ids, and each
 * question's own constraints. State is any lossless JSON value.
 * @param request - the caller's request.
 * @throws {JevError} `JEV_INVALID_REQUEST` on the first violation.
 */
export function assertRequest(request: JevRequest): void {
  const entries = Object.entries(request.questions)
  if (entries.length === 0) invalid('a Jev request needs at least one question')
  for (const [id, question] of entries) {
    assertNonBlank(id, 'question id')
    assertQuestion(id, question)
  }
}

/**
 * Map one validated question to its wire form.
 * @param question - a validated question.
 * @returns the System One question body.
 */
export function toWireQuestion(question: JevQuestion): SystemOneWireQuestion {
  switch (question.type) {
    case 'choice':
      return { type: 'choice', instructions: question.instructions, criteria: question.options }
    case 'noul':
      return { type: 'noul', instructions: question.instructions }
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: question.levels }
    /* v8 ignore next 2 -- JevQuestion is closed and every member is handled above */
    default: return assertNever(question)
  }
}

/**
 * Map a validated request to the `POST /v1/systemone` body.
 * @param request - a validated request.
 * @param model - the model to send when the request names none.
 * @returns the wire body.
 */
export function toWireRequest(request: JevRequest, model: string): SystemOneWireRequest {
  return {
    state: request.state,
    model: request.model ?? model,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, toWireQuestion(question)]),
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isFiniteNumber)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string')
}

function unprocessable(detail: string): never {
  throw new JevError(`Jev returned an unprocessable response body: ${detail}`, 'JEV_PROVIDER_ERROR')
}

/**
 * Validate one wire answer against the question type that was asked. The
 * wire body is untrusted: every field the seam publishes is checked here.
 * @param id - the question id, for the failure message.
 * @param question - the question that was sent.
 * @param raw - the answer object TypeSafe returned under that id.
 * @returns the typed answer.
 * @throws {JevError} `JEV_PROVIDER_ERROR` when the answer is missing or malformed.
 */
export function toAnswer(id: string, question: JevQuestion, raw: unknown): JevAnswer {
  if (!isRecord(raw)) unprocessable(`answer "${id}" is missing`)
  if (raw.type !== question.type) unprocessable(`answer "${id}" has type ${JSON.stringify(raw.type)}, expected ${question.type}`)
  switch (question.type) {
    case 'choice': {
      const { choice, probabilities, confidence } = raw
      if (typeof choice !== 'string' || !isNumberRecord(probabilities) || !isFiniteNumber(confidence)) {
        unprocessable(`answer "${id}" is not a well-formed choice`)
      }
      if (!Object.hasOwn(question.options, choice)) unprocessable(`answer "${id}" chose unknown option ${JSON.stringify(choice)}`)
      return { type: 'choice', choice, probabilities, confidence }
    }
    case 'noul': {
      const { noul } = raw
      if (!isFiniteNumber(noul)) unprocessable(`answer "${id}" is not a well-formed noul`)
      return { type: 'noul', noul }
    }
    case 'score': {
      const { score, legend, probabilities, confidence } = raw
      if (!isFiniteNumber(score) || !isStringRecord(legend) || !isNumberRecord(probabilities) || !isFiniteNumber(confidence)) {
        unprocessable(`answer "${id}" is not a well-formed score`)
      }
      return { type: 'score', score, legend, probabilities, confidence }
    }
    /* v8 ignore next 2 -- JevQuestion is closed and every member is handled above */
    default: return assertNever(question)
  }
}

/**
 * Validate a whole response body against the request that produced it.
 * @param request - the validated request that was sent.
 * @param body - the parsed JSON response.
 * @returns the typed result with one answer per request question.
 * @throws {JevError} `JEV_PROVIDER_ERROR` when the body is malformed.
 */
export function toResult(request: JevRequest, body: unknown): JevResult {
  if (!isRecord(body)) unprocessable('not a JSON object')
  const response = body as SystemOneWireResponse
  if (typeof response.model !== 'string' || response.model.length === 0) unprocessable('no model')
  if (!isRecord(response.answers)) unprocessable('no answers object')
  const answers: Record<string, JevAnswer> = {}
  for (const [id, question] of Object.entries(request.questions)) {
    answers[id] = toAnswer(id, question, response.answers[id])
  }
  const usage = response.usage
  return {
    model: response.model,
    answers,
    usage: {
      inputTokens: isFiniteNumber(usage?.input_tokens) ? usage.input_tokens : 0,
      outputTokens: isFiniteNumber(usage?.output_tokens) ? usage.output_tokens : 0,
    },
  }
}
