/**
 * @deepseek-ai/dsh-experimental-turn-continuation — continues a turn that is
 * about to end with nothing to act on. When the turn's last assistant message
 * carries no tool call and no text (an empty or reasoning-only reply), or was
 * cut off at the output limit, the plugin steers a logged notice back to the
 * model instead of letting the turn close, at most `maxContinuations` times per
 * turn. The turn's recorded end reason is unchanged: a `max-tokens` turn stays
 * `max-tokens` however many continuations ran.
 *
 * @module @deepseek-ai/dsh-experimental-turn-continuation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Stable Cordis plugin name. */
export const name = 'turn-continuation'

/** Why a turn was continued: it produced nothing, or it was cut off. */
export type TurnContinuationReason = 'empty' | 'max-tokens'

/** Source of every continuation notice: the reason and which attempt of the turn's bound this is. */
export interface TurnContinuationSource {
  kind: 'turn-continuation'
  /** Why the turn was continued. */
  reason: TurnContinuationReason
  /** One-based attempt within the turn, at most the configured bound. */
  attempt: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Continuation attribution; readers preserve the notice without this
     * producer, and the kind imposes no validation, replay, or authority
     * requirement.
     * @persistenceAttribution
     */
    'turn-continuation': TurnContinuationSource & ContextFormed
  }
}

/** Deployment bounds for how often one turn is continued. */
export interface Config {
  /** Maximum continuation notices sent within one turn before it is allowed to end as it is. */
  readonly maxContinuations: number
  /** Whether a message cut off at the output limit is continued too, not only an empty one. */
  readonly onMaxTokens: boolean
}

export const Config: z<Config> = z.object({
  maxContinuations: z.number().step(1).min(1).required(),
  onMaxTokens: z.boolean().required(),
})

/** Notice sent when the last message had no tool call and no text. */
export const EMPTY_TURN_NOTICE =
  'Your previous message contained no tool call and no text, so nothing happened and the task is not finished. '
  + 'Continue: call a tool, or reply with your answer.'

/** Notice sent when the last message was cut off at the output limit. */
export const MAX_TOKENS_NOTICE =
  'Your previous message was cut off at the output limit before it finished. '
  + 'Continue from where it stopped: call a tool, or reply with your answer, in fewer words.'

/** What the turn's last assistant message amounts to. */
type LastMessage = { readonly reason: TurnContinuationReason } | { readonly reason: 'actionable' } | undefined

/**
 * Classify the turn's last assistant message from the durable log. The stop
 * boundary is reached only after a model call in the turn, so the latest
 * `assistant/message` belongs to this turn; the guards below name the
 * conditions the loop rules out rather than assume them.
 */
function classifyLastMessage(session: Session, turn: number): LastMessage {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event: SessionEvent | undefined = session.eventAt(SessionSeq(seq))
    /* v8 ignore next -- every seq below the captured length is readable. */
    if (event === undefined || event.type !== 'assistant/message') continue
    /* v8 ignore next -- the stop boundary follows a model call in this turn. */
    if (event.data.turn !== turn) return undefined
    const { message, stream } = event.data
    if (stream.some(entry => entry.type === 'chunk' && entry.chunk.type === 'finish' && entry.chunk.reason.kind === 'max-tokens')) {
      return { reason: 'max-tokens' }
    }
    const actionable = message.content.some(block =>
      block.type === 'tool-call' || (block.type === 'text' && block.text.trim() !== ''))
    return actionable ? { reason: 'actionable' } : { reason: 'empty' }
  }
  /* v8 ignore next -- see above: a turn at its stop boundary has an assistant message. */
  return undefined
}

/** Continuation notices already sent in one agent's current turn. */
interface TurnBudget {
  turn: number
  used: number
}

/**
 * Install the turn-stopping listener.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - validated bound and max-tokens opt-in.
 */
export function apply(ctx: Context, config: Config): void {
  const budgets = new WeakMap<Agent, TurnBudget>()
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const last = classifyLastMessage(agent.session, turn)
    if (last === undefined || last.reason === 'actionable') return
    if (last.reason === 'max-tokens' && !config.onMaxTokens) return
    const budget = budgets.get(agent)
    const used = budget?.turn === turn ? budget.used : 0
    if (used >= config.maxContinuations) return
    const attempt = used + 1
    budgets.set(agent, { turn, used: attempt })
    const text = last.reason === 'empty' ? EMPTY_TURN_NOTICE : MAX_TOKENS_NOTICE
    agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'turn-continuation',
        reason: last.reason,
        attempt,
        form: 'notice',
        summary: `continued after ${last.reason === 'empty' ? 'an empty message' : 'the output limit'} (${attempt}/${config.maxContinuations})`,
      },
    }))
  })
}
