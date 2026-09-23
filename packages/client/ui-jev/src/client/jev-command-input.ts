import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The registered command name whose runs this projection owns. */
export const JEV_COMMAND = 'jev'

/** Jev-owned human command input projected independently of model messages. */
export interface JevCommandInputData {
  readonly commandId: CommandId
  /** The question as typed, without the command name; empty when the line was bare. */
  readonly question: string
  readonly time: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Human-entered `/jev` question. */
    'jev-command-input': JevCommandInputData
  }
}

interface JevCommandInputState extends JevCommandInputData {
  readonly seq: number
}

/**
 * Derive the visible question from its structured durable run: the argument
 * text with the parser's separator whitespace trimmed away.
 * @param event - `/jev` command run.
 * @returns the question text, empty for a bare `/jev`.
 */
export function jevQuestionText(event: SessionEvent<'command/run'>): string {
  return (event.data.args ?? '').trim()
}

/**
 * Jev-owned command input projection. The generic command Definition keeps the
 * result row; this Node is the visible non-command content that activates a
 * fresh Chat, so an answer on a never-prompted session is not hidden behind the hero.
 */
export const jevCommandInputDefinition: ConversationNodeDefinition<JevCommandInputState> = {
  kind: 'jev-command-input',
  target: 'chat',
  match: event => event.type === 'command/run' && event.data.name === JEV_COMMAND
    ? { id: String(event.data.commandId), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'command/run') throw new Error('jev-command-input start requires command/run')
    return {
      commandId: match.event.data.commandId,
      seq: match.event.seq,
      time: match.event.time,
      question: jevQuestionText(match.event),
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : {
      key: context.key,
      kind: 'jev-command-input',
      id: context.id,
      target: 'chat',
      // Immediately before the generic result row that shares the run's seq.
      anchorSeq: context.state.seq - 0.1,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: { commandId: context.state.commandId, question: context.state.question, time: context.state.time },
    },
}
