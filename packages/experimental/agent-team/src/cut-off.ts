/** Whether a turn the agent loop ended `max-tokens` finished what it was writing. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Whether a model message ended at the output limit. */
function cutOff(message: SessionEvent<'assistant/message'>['data']): boolean {
  return message.stream.some(entry =>
    entry.type === 'chunk' && entry.chunk.type === 'finish' && entry.chunk.reason.kind === 'max-tokens')
}

/**
 * Follows the model messages of one Session. The agent loop reports
 * `max-tokens` for a turn in which any model message was cut off at the output
 * limit, also when the model went on afterwards. Such a turn finished its work
 * only when each cut-off message was answered by the continuation notice of
 * `@deepseek-ai/dsh-experimental-turn-continuation`, which tells the model to
 * write the message again, and the message after the last notice was whole. A
 * cut-off message followed by a step that any other message started stays cut
 * off: nothing asked the model to write it again.
 */
export class TurnCutOffs {
  /** The latest model message was cut off and no later message replaced it. */
  private open = false
  /** A continuation notice arrived after the latest model message. */
  private continued = false
  /** A cut-off message was followed by a step that no continuation notice started. */
  private abandoned = false

  /**
   * Feed one event of the followed Session, in log order.
   * @param event - any Session event; only turn starts, user messages, and model messages are read.
   */
  observe(event: SessionEvent): void {
    if (event.type === 'turn/start') {
      this.open = false
      this.continued = false
      this.abandoned = false
      return
    }
    if (event.type === 'user/message') {
      // The source kind is declared by the continuation plugin, which this package does not import.
      const source: { readonly kind: string; readonly reason?: unknown } = event.data.source
      if (source.kind === 'turn-continuation' && source.reason === 'max-tokens') this.continued = true
      return
    }
    if (event.type !== 'assistant/message') return
    if (this.open && !this.continued) this.abandoned = true
    this.open = cutOff(event.data)
    this.continued = false
  }

  /**
   * How a turn that just ended is counted.
   * @param reason - the end or stop reason the agent loop reported for the turn.
   * @returns `completed` for a `max-tokens` turn whose cut-off messages were all continued and written again, else `reason`.
   */
  outcome<Reason extends string>(reason: Reason): Reason | 'completed' {
    return reason === 'max-tokens' && !this.open && !this.abandoned ? 'completed' : reason
  }
}
