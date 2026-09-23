// @vitest-environment jsdom
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatConversationViewNode, ChatSnapshot,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { commandDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/command.ts'
import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { JevAnswerView } from '../src/client/JevAnswerView.tsx'
import { JevCommandInputView } from '../src/client/JevCommandInputView.tsx'
import { jevCommandInputDefinition, jevQuestionText } from '../src/client/jev-command-input.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const ANSWER = 'Jev picks "sqlite" (82%); jsonl 18%. Confidence 0.71 (jev-1.13.0).'

/** Assemble one chat window over the generic command Definition plus the Jev projection. */
function chat(events: readonly { seq: number; type: string; data: unknown }[], hasMore = false): ChatSnapshot {
  const definitions = {
    entries: (): readonly ConversationNodeDefinition[] => [commandDefinition, jevCommandInputDefinition],
    fallbackEntry: () => undefined,
  }
  const views = { entries: (): readonly ConversationViewDefinition[] => [chatViewDefinition] }
  const assembler = new ConversationNodeAssembler(definitions, views)
  const entries: SessionLiveEventEntry[] = events.map(({ seq, type, data }) => ({
    type: 'event',
    event: { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent,
  }))
  assembler.replaceWindow(entries, hasMore)
  assembler.activateTarget('chat')
  const value = assembler.snapshot('chat') as ChatSnapshot | undefined
  if (value === undefined) throw new Error('chat view was not registered')
  return value
}

const run = { seq: 7, type: 'command/run', data: { commandId: 'cmd-jev', name: 'jev', args: ' 用哪个存储？ | sqlite | jsonl ', source: { kind: 'user' } } }
const done = { seq: 8, type: 'command/done', data: { commandId: 'cmd-jev', kind: 'success', text: ANSWER } }

function nodesOf(value: ChatSnapshot): ChatConversationViewNode[] {
  return value.order.flatMap(key => value.nodes.get(key) ?? [])
}

describe('jev command input projection', () => {
  it('places the question bubble right before the generic answer row', () => {
    const nodes = nodesOf(chat([run, done]))
    expect(nodes.map(node => node.kind)).toEqual(['jev-command-input', 'command'])
    expect(nodes[0]).toMatchObject({ anchorSeq: 6.9, data: { commandId: 'cmd-jev', question: '用哪个存储？ | sqlite | jsonl' } })
    expect(nodes[1]?.data).toMatchObject({ name: 'jev', outcome: { kind: 'success', text: ANSWER } })
  })

  it('leaves a done-only window with the generic row alone', () => {
    const nodes = nodesOf(chat([done], true))
    expect(nodes.map(node => node.kind)).toEqual(['command'])
  })

  it('matches only /jev runs and trims the parser separator', () => {
    const compact = { ...run, data: { ...run.data, name: 'compact', args: '' } }
    expect(jevCommandInputDefinition.match(compact as never)).toBeNull()
    expect(jevQuestionText({ data: { name: 'jev', args: ' Ship it? ' } } as never)).toBe('Ship it?')
    expect(jevQuestionText({ data: { name: 'jev' } } as never)).toBe('')
  })

  it('stays total across the Definition interface', () => {
    const match = { event: { seq: 3, time: 3, type: 'command/run', data: run.data }, role: 'start', location: { kind: 'session' } }
    const state = jevCommandInputDefinition.start({} as never, match as never, {} as never)
    expect(jevCommandInputDefinition.update({ state } as never, match as never)).toBe(state)
    expect(jevCommandInputDefinition.buildViewNode!({ state: undefined } as never)).toBeNull()
    expect(jevCommandInputDefinition.buildViewNode!({ key: 'k', id: 'cmd-jev', state, start: undefined } as never))
      .toMatchObject({ kind: 'jev-command-input', location: { kind: 'unresolved' } })
    const wrong = { ...match, event: { ...match.event, type: 'command/done' } }
    expect(() => jevCommandInputDefinition.start({} as never, wrong as never, {} as never)).toThrow('requires command/run')
  })

  it('renders the dimmed command name and the question as a user-style bubble without actions', () => {
    const t = makeTranslate(zh, commonZh)
    const propsFor = (question: string): Parameters<typeof JevCommandInputView>[0] =>
      ({ node: { key: 'k', data: { commandId: 'cmd-jev', question, time: 1 } }, t }) as never
    const view = render(<JevCommandInputView {...propsFor('二选一｜a｜b')} />)
    const bubble = view.getByRole('group', { name: '向 Jev 提问' })
    expect(bubble.textContent).toBe('/jev 二选一｜a｜b')
    expect(within(bubble).queryByRole('button')).toBeNull()

    cleanup()
    const bare = render(<JevCommandInputView {...propsFor('')} />)
    expect(bare.getByRole('group', { name: '向 Jev 提问' }).textContent).toBe('/jev')
  })
})

describe('jev answer view', () => {
  const t = makeTranslate(zh, commonZh)
  const view = (outcome: { kind: 'success' | 'error'; text?: string } | null) => {
    const props = {
      node: { kind: 'command', seq: 1, time: 1, commandId: 'cmd-jev', name: 'jev', args: ' q', outcome },
      t,
    } as never as Parameters<typeof JevAnswerView>[0]
    return render(<JevAnswerView {...props} />)
  }

  it('renders the settled answer as a message from Jev', () => {
    const group = view({ kind: 'success', text: ANSWER }).getByRole('group', { name: 'Jev 的回答' })
    expect(group.getAttribute('data-state')).toBe('ok')
    expect(group.textContent).toBe(`Jev · 快思考队友${ANSWER}`)
    cleanup()
    expect(view({ kind: 'success' }).getByRole('group').textContent).toContain('已完成')
  })

  it('marks a failure and shows the placeholder while the run is open', () => {
    const failed = view({ kind: 'error', text: 'Jev is unavailable (JEV_CREDENTIAL_MISSING): no key' }).getByRole('group')
    expect(failed.getAttribute('data-state')).toBe('error')
    expect(failed.textContent).toContain('JEV_CREDENTIAL_MISSING')
    cleanup()
    expect(view({ kind: 'error' }).getByRole('group').textContent).toContain('Jev 没有给出回答')
    cleanup()
    const running = view(null).getByRole('group')
    expect(running.getAttribute('data-state')).toBe('running')
    expect(running.textContent).toContain('Jev 正在判断…')
  })
})
