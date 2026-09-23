/**
 * Human-facing `/jev` command: the user consults Jev, the fast-thinking System
 * One teammate, about the recent conversation. The judgment renders directly
 * in the UI and is also injected into the receiving agent as a plugin notice,
 * so the lead agent sees what its teammate told the user.
 * @module @deepseek-ai/dsh-command-jev
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { JevError } from '@deepseek-ai/dsh-jev'
import type { JevAnswer, JevQuestion, JevResult } from '@deepseek-ai/dsh-jev'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Message } from '@deepseek-ai/dsh-llm'
import { JEV_COMMAND_HINT, parseJevCommand } from './grammar.ts'
import type { JevCommandParse } from './grammar.ts'

/** Source of the notice `/jev` shares with the agent: one bounded line names the consult. */
export interface JevMessageSource {
  kind: 'jev'
  /** The shared judgment is a `notice`: the model reads it without a row to expand. */
  form: 'notice'
  /** One-line account of the consult, bounded by {@link boundContextSummary}. */
  summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Consult attribution; readers preserve the notice without this producer,
     * and the kind imposes no validation, replay, or authority requirement.
     * @persistenceAttribution
     */
    jev: JevMessageSource
  }
}

export { JEV_COMMAND_HINT, JEV_COMMAND_USAGE, parseJevCommand } from './grammar.ts'
export type { JevCommandParse, JevCommandParseError } from './grammar.ts'

export const name = 'command-jev'
export const inject = ['commands', 'jev']

/** The one question id this command sends; the answer is read back under it. */
const QUESTION_ID = 'answer'

/** Recent messages sent as state when the entry names none. */
const DEFAULT_CONTEXT_MESSAGES = 12
/** Serialized conversation characters sent as state when the entry names none. */
const DEFAULT_CONTEXT_CHARS = 16_000
/** Answer deadline when the entry names none. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Plugin config: how much recent conversation Jev sees and how long the command waits. */
export interface Config {
  /** Newest user and assistant messages included as state. Defaults to 12. */
  contextMessages?: number
  /** Upper bound on conversation characters included as state; older messages drop first. Defaults to 16000. */
  contextChars?: number
  /** Answer deadline in milliseconds. Defaults to 30000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  contextMessages: z.number().default(DEFAULT_CONTEXT_MESSAGES),
  contextChars: z.number().default(DEFAULT_CONTEXT_CHARS),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Configured budgets must be positive integers. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`command-jev: ${field} must be a positive integer`)
  }
}

/** One conversation entry as Jev sees it (an object type so it is lossless JSON). */
type ConversationEntry = {
  role: 'user' | 'assistant'
  text: string
}

/** Text of one message's text blocks, or `undefined` when it has none. */
function messageText(message: Message): string | undefined {
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return text.length > 0 ? text : undefined
}

/**
 * The newest human and model messages of a session, oldest first, bounded by
 * count and then by characters (older entries drop first; a lone oversized
 * newest entry keeps its tail).
 * @param agent - the receiving agent whose log is read.
 * @param config - the count and character bounds.
 * @returns the bounded conversation.
 */
export function recentConversation(agent: Agent, config: Pick<ResolvedConfig, 'contextMessages' | 'contextChars'>): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  for (const message of agent.session.deriveMessages()) {
    // Only what the human typed and what the model said: plugin context,
    // tool results, and text-free tool-call turns are not conversation.
    const role = message.source.kind === 'user' ? 'user' : message.source.kind === 'model' ? 'assistant' : undefined
    if (role === undefined) continue
    const text = messageText(message)
    if (text !== undefined) entries.push({ role, text })
  }
  const window = entries.slice(-config.contextMessages)
  let total = window.reduce((sum, entry) => sum + entry.text.length, 0)
  let dropped = 0
  for (const entry of window) {
    if (window.length - dropped <= 1 || total <= config.contextChars) break
    total -= entry.text.length
    dropped++
  }
  return window.slice(dropped).map(entry => entry.text.length > config.contextChars
    ? { role: entry.role, text: `…${entry.text.slice(entry.text.length - config.contextChars + 1)}` }
    : entry)
}

/** The typed question one parsed line asks. */
function toQuestion(parsed: JevCommandParse): JevQuestion {
  switch (parsed.kind) {
    case 'noul':
      return { type: 'noul', instructions: parsed.question }
    case 'choice':
      return { type: 'choice', instructions: parsed.question, options: Object.fromEntries(parsed.options.map(option => [option, null])) }
    /* v8 ignore next 2 -- JevCommandParse is closed and every member is handled above */
    default: throw new TypeError(`unknown /jev parse kind: ${String((parsed as { kind: unknown }).kind)}`)
  }
}

/** Whole-percent rendering of one probability. */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * One human-readable sentence for an answer, shared by the direct UI result
 * and the agent notice.
 * @param answer - the validated answer.
 * @returns the sentence without the model suffix.
 */
export function describeAnswer(answer: JevAnswer): string {
  switch (answer.type) {
    case 'noul':
      return `yes ${percent(answer.noul)}, no ${percent(1 - answer.noul)}`
    case 'choice': {
      const ranked = Object.entries(answer.probabilities).sort(([, left], [, right]) => right - left)
      const others = ranked.filter(([option]) => option !== answer.choice).map(([option, p]) => `${option} ${percent(p)}`)
      const winner = `picks ${JSON.stringify(answer.choice)} (${percent(answer.probabilities[answer.choice] ?? 0)})`
      return `${winner}${others.length > 0 ? `; ${others.join(', ')}` : ''}. Confidence ${answer.confidence.toFixed(2)}`
    }
    /* v8 ignore next 2 -- this command never asks a score question */
    default: throw new TypeError(`unexpected answer type: ${String((answer as { type: unknown }).type)}`)
  }
}

/** The text injected into the agent after a successful consult. */
function noticeText(parsed: JevCommandParse, result: JevResult, answer: JevAnswer): string {
  return [
    'The user consulted Jev, the fast-thinking System One teammate, about the recent conversation.',
    `Question: ${parsed.question}`,
    ...parsed.kind === 'choice' ? [`Options: ${parsed.options.join(' | ')}`] : [],
    `Jev (${result.model}) answered: ${describeAnswer(answer)}.`,
  ].join('\n')
}

/**
 * Map a failed consult to the direct human result. A caller abort is settled
 * by the command registry's own race, so an aborted seam call reaching here
 * is the deadline this command armed.
 */
function failure(error: unknown, timeoutMs: number): CommandResult {
  if (error instanceof JevError) {
    if (error.code === 'JEV_ABORTED') return { kind: 'error', text: `Jev did not answer within ${timeoutMs} ms.` }
    return { kind: 'error', text: `Jev is unavailable (${error.code}): ${error.message}` }
  }
  throw error
}

/** Execute one parsed `/jev` invocation. */
async function executeJev(ctx: Context, invocation: CommandInvocation, config: ResolvedConfig): Promise<CommandResult> {
  const parsed = parseJevCommand(invocation.rawInput)
  if ('error' in parsed) return { kind: 'error', text: parsed.error }
  const request = {
    state: { question: parsed.question, conversation: recentConversation(invocation.agent, config) },
    questions: { [QUESTION_ID]: toQuestion(parsed) },
  }
  let result: JevResult
  try {
    result = await ctx.jev.decide(request, AbortSignal.any([invocation.signal, AbortSignal.timeout(config.timeoutMs)]))
  } catch (error: unknown) {
    return failure(error, config.timeoutMs)
  }
  const answer = result.answers[QUESTION_ID]
  /* v8 ignore next -- the seam guarantees one answer per request id */
  if (answer === undefined) throw new Error('Jev returned no answer')
  try {
    invocation.agent.inject(createUserMessage({
      content: [{ type: 'text', text: noticeText(parsed, result, answer) }],
      source: { kind: 'jev', form: 'notice', summary: boundContextSummary(`Jev consult: ${parsed.question}`) },
    }))
  } catch {
    // A disposed agent cannot take context; the user still gets the direct answer.
  }
  return { kind: 'success', text: `Jev ${describeAnswer(answer)} (${result.model}).` }
}

/**
 * Register `/jev` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the Jev seam.
 * @param config - state and deadline budgets; every field is defaulted by the schema.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('contextMessages', resolved.contextMessages)
  assertPositiveInteger('contextChars', resolved.contextChars)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)

  let inFlight = 0
  let quiescent: (() => void) | undefined
  const handler = async (invocation: CommandInvocation): Promise<CommandResult> => {
    inFlight++
    try {
      return await executeJev(ctx, invocation, resolved)
    } finally {
      if (--inFlight === 0) quiescent?.()
    }
  }

  ctx.effect(function* () {
    // Yield the drain before registration: composite teardown is LIFO, so no
    // new invocation can enter while an already-started consult settles.
    yield () => inFlight === 0 ? undefined : new Promise<void>((resolve) => { quiescent = resolve })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-jev'),
      name: 'jev',
      description: 'Ask Jev, the fast-thinking teammate, for a quick judgment',
      input: { hint: JEV_COMMAND_HINT },
      handler,
    })
  }, 'command-jev lifecycle')
}
