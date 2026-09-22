/**
 * Model-facing `jev` tool: the agent consults Jev, a fast-thinking System One
 * teammate, through `ctx.jev`. The tool owns the model-visible name, schema,
 * prompt guidance, argument checks the schema DSL cannot express, and result
 * rendering; the seam owns credentials, transport, and answer validation.
 * @module @deepseek-ai/dsh-tool-jev
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JevAnswer, JevQuestion, JevResult } from '@deepseek-ai/dsh-jev'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-jev'
export const inject = ['tools', 'jev', 'systemPrompt']

/** Cooperative timeout budget when the entry names none. */
const DEFAULT_TIMEOUT_MS = 30_000
/** Questions accepted per call when the entry names none. */
const DEFAULT_MAX_QUESTIONS = 16
/** Serialized state characters accepted per call when the entry names none. */
const DEFAULT_MAX_STATE_CHARS = 64_000

/** Plugin config: the per-call budgets the deployment allows the model to spend on Jev. */
export interface Config {
  /** Cooperative timeout budget (ms) attached to the tool definition. Defaults to 30000. */
  timeoutMs?: number
  /** Upper bound on questions in one call. Defaults to 16. */
  maxQuestions?: number
  /** Upper bound on serialized `state` characters in one call. Defaults to 64000. */
  maxStateChars?: number
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxQuestions: z.number().default(DEFAULT_MAX_QUESTIONS),
  maxStateChars: z.number().default(DEFAULT_MAX_STATE_CHARS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Configured budgets must be positive integers. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-jev: ${field} must be a positive integer`)
  }
}

/** Stable model-facing description. */
export const JEV_TOOL_DESCRIPTION =
  'Ask Jev, a fast-thinking teammate, for calibrated judgments about facts you supply. '
  + 'Jev is a System One model: it does not reason, browse, or write prose; it returns typed answers with probabilities. '
  + 'Send complete `state` (Jev sees nothing else) and one or more independent questions: '
  + '`choice` picks one named option, `noul` gives the probability that a condition holds, `score` rates along ordered levels. '
  + 'Use it for quick decisions that hinge on semantic reading — picking between candidates, triage, ranking, checking a condition — '
  + 'not for lookups, arithmetic, or facts outside `state`. Ask every independent question about the same state in one call.'

/** Stable system-prompt guidance registered as `tool:jev`. */
export const JEV_PROMPT_TEXT =
  'Jev is a fast-thinking teammate available through the `jev` tool: a System One model that returns calibrated judgments instead of prose. '
  + 'Consult it for quick decisions that hinge on reading rather than lookup or computation; put every fact the judgment needs in `state`, '
  + 'ask independent questions together, and treat the returned probabilities and confidence as signals to threshold on — '
  + 'a low-confidence answer on a consequential decision is a reason to gather more evidence or ask the user, not to guess. '
  + 'You keep responsibility for exact facts, calculations, and the final decision.'

/** One model-supplied question after schema validation. */
interface RawQuestion {
  id: string
  type: 'choice' | 'noul' | 'score'
  instructions: string
  options?: Record<string, JsonValue>
  levels?: string[]
}

/**
 * Convert one schema-checked question into its typed seam form, enforcing the
 * cross-field rules the DSL cannot: `options` only and always with `choice`,
 * `levels` only and always with `score`, and string-or-null option values.
 * @param raw - the model's question.
 * @returns the typed question.
 */
function toQuestion(raw: RawQuestion): JevQuestion {
  switch (raw.type) {
    case 'choice': {
      if (raw.options === undefined) throw new Error(`question "${raw.id}": choice requires \`options\``)
      if (raw.levels !== undefined) throw new Error(`question "${raw.id}": choice does not take \`levels\``)
      const options: Record<string, string | null> = {}
      for (const [option, description] of Object.entries(raw.options)) {
        if (description !== null && typeof description !== 'string') {
          throw new Error(`question "${raw.id}": option ${JSON.stringify(option)} needs a string description or null`)
        }
        options[option] = description
      }
      return { type: 'choice', instructions: raw.instructions, options }
    }
    case 'noul':
      if (raw.options !== undefined || raw.levels !== undefined) {
        throw new Error(`question "${raw.id}": noul takes neither \`options\` nor \`levels\``)
      }
      return { type: 'noul', instructions: raw.instructions }
    case 'score':
      if (raw.levels === undefined) throw new Error(`question "${raw.id}": score requires \`levels\``)
      if (raw.options !== undefined) throw new Error(`question "${raw.id}": score does not take \`options\``)
      return { type: 'score', instructions: raw.instructions, levels: raw.levels }
    /* v8 ignore next 2 -- the schema enum closes the union; every member is handled above */
    default: throw new TypeError(`unknown question type: ${String(raw.type)}`)
  }
}

/** Whole-percent rendering of one probability. */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** Distribution entries ordered by descending probability, as `name 82%` fragments. */
function distribution(probabilities: Readonly<Record<string, number>>, label: (key: string) => string): string {
  return Object.entries(probabilities)
    .sort(([, left], [, right]) => right - left)
    .map(([key, value]) => `${label(key)} ${percent(value)}`)
    .join(', ')
}

/**
 * Render one answer as a single model-facing line.
 * @param id - the question id.
 * @param answer - the validated answer.
 * @returns the line without a trailing newline.
 */
export function renderAnswer(id: string, answer: JevAnswer): string {
  switch (answer.type) {
    case 'choice':
      return `- ${id} (choice): ${answer.choice} — ${distribution(answer.probabilities, key => key)}; confidence ${answer.confidence.toFixed(2)}`
    case 'noul':
      return `- ${id} (noul): yes ${percent(answer.noul)}`
    case 'score': {
      const top = Object.keys(answer.legend).length - 1
      const label = (key: string): string => `${key} ${JSON.stringify(answer.legend[key] ?? '')}`
      return `- ${id} (score): ${answer.score.toFixed(2)} on 0–${top} — ${distribution(answer.probabilities, label)}; confidence ${answer.confidence.toFixed(2)}`
    }
    /* v8 ignore next 2 -- JevAnswer is closed and every member is handled above */
    default: throw new TypeError(`unknown answer type: ${String((answer as { type: unknown }).type)}`)
  }
}

/** Canonical per-answer value: the seam answer plus its question id. */
type CanonicalAnswer = JevAnswer & { id: string }

/**
 * Project a seam result onto the canonical tool value in the request's question order.
 * @param result - the validated seam result.
 * @param ids - question ids in request order.
 * @returns the canonical value.
 */
/** The canonical tool value: answers in request order plus model and usage. */
interface CanonicalValue {
  model: string
  answers: CanonicalAnswer[]
  usage: { inputTokens: number; outputTokens: number }
}

function toCanonical(result: JevResult, ids: readonly string[]): CanonicalValue {
  return {
    model: result.model,
    answers: ids.map((id) => {
      const answer = result.answers[id]
      /* v8 ignore next -- the seam guarantees one answer per request id */
      if (answer === undefined) throw new Error(`Jev returned no answer for "${id}"`)
      return { id, ...answer }
    }),
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  }
}

/**
 * Register the `jev` tool and its prompt section.
 * @param ctx - context carrying the tool registry, the Jev seam, and the prompt registry.
 * @param config - per-call budgets; every field is defaulted by the schema.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('maxQuestions', resolved.maxQuestions)
  assertPositiveInteger('maxStateChars', resolved.maxStateChars)

  ctx.systemPrompt.section({ name: 'tool:jev', order: ctx.systemPrompt.getSectionOrder('TOOL_JEV'), text: JEV_PROMPT_TEXT })

  ctx.tools.register(defineTool({
    name: 'jev',
    description: JEV_TOOL_DESCRIPTION,
    timeoutMs: resolved.timeoutMs,
    parameters: {
      state: {
        oneOf: [
          { type: 'string' },
          { type: 'object', additionalProperties: true },
        ],
        required: true,
        description: 'Everything the judgment needs: source text, candidates, constraints, current facts. Prefer an object with named fields when the context has several parts.',
      },
      questions: {
        type: 'array',
        required: true,
        description: `Independent questions about the same state, at most ${resolved.maxQuestions}. Each id must be unique.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Your own handle for the answer; never shown to Jev.' },
            type: { type: 'string', required: true, enum: ['choice', 'noul', 'score'] },
            instructions: {
              type: 'string',
              required: true,
              description: 'The complete question, standing alone. Reference nested state with backticked paths such as `ticket.messages[0].text`.',
            },
            options: {
              type: 'object',
              additionalProperties: true,
              description: 'choice only: option name → short description, or null when the name explains itself. Include a no-match option when nothing may fit.',
            },
            levels: {
              type: 'array',
              items: { type: 'string' },
              description: 'score only: 2–10 ordered level descriptions from lowest to highest, each a concrete situation.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          answers: {
            type: 'array',
            required: true,
            items: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    type: { type: 'string', const: 'choice', required: true },
                    choice: { type: 'string', required: true },
                    probabilities: { type: 'object', additionalProperties: true, required: true },
                    confidence: { type: 'number', required: true },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    type: { type: 'string', const: 'noul', required: true },
                    noul: { type: 'number', required: true },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    type: { type: 'string', const: 'score', required: true },
                    score: { type: 'number', required: true },
                    legend: { type: 'object', additionalProperties: true, required: true },
                    probabilities: { type: 'object', additionalProperties: true, required: true },
                    confidence: { type: 'number', required: true },
                  },
                },
              ],
            },
          },
          usage: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              inputTokens: { type: 'integer', required: true },
              outputTokens: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [`Jev (${value.model}) answered:`, ...value.answers.map(answer => renderAnswer(answer.id, answer as CanonicalAnswer))].join('\n'),
      }],
    },
    async execute(args, exec) {
      if (args.questions.length === 0) throw new Error('jev needs at least one question')
      if (args.questions.length > resolved.maxQuestions) {
        throw new Error(`jev accepts at most ${resolved.maxQuestions} questions per call (got ${args.questions.length})`)
      }
      const stateChars = JSON.stringify(args.state).length
      if (stateChars > resolved.maxStateChars) {
        throw new Error(`jev state is ${stateChars} characters; the limit is ${resolved.maxStateChars}. Send only what the questions need.`)
      }
      const questions: Record<string, JevQuestion> = {}
      const ids: string[] = []
      for (const raw of args.questions) {
        if (Object.hasOwn(questions, raw.id)) throw new Error(`duplicate question id ${JSON.stringify(raw.id)}`)
        questions[raw.id] = toQuestion(raw)
        ids.push(raw.id)
      }
      const result = await ctx.jev.decide({ state: args.state, questions }, exec.signal)
      return toCanonical(result, ids)
    },
    presentCall: args => ({ card: 'generic', title: 'Ask Jev', kind: 'other', rawInput: args }),
  }))
}
