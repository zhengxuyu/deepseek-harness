// @vitest-environment jsdom
/**
 * ui-jev browser half on a real cordis Context with fake slot and locale
 * faces: the plugin registers the Jev command-input Definition and the keyed
 * Chat renderer, and both leave with the plugin fiber (HMR safety). The node
 * half rides the same Context.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

async function bench() {
  const ctx = new Context()
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  ctx.provide('sessions', sessions)
  const conversationEvents = new UiConversation(ctx, sessions).events
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx,
    fiber,
    kinds: () => conversationEvents.entries().map(definition => definition.kind),
    chatKeys: () => ctx.slots.entries('conversation.chat.node').map(entry => entry.options.key),
    commandKeys: () => ctx.slots.entries('conversation.chat.commandview').map(entry => entry.options.key),
  }
}

describe('ui-jev browser plugin', () => {
  it('registers the Jev command-input Definition, its keyed renderer, and the jev command view', async () => {
    const b = await bench()
    expect(inject).toEqual(['slots', 'locale', 'uiConversation'])
    expect(b.kinds()).toEqual(['jev-command-input'])
    expect(b.chatKeys()).toEqual(['jev-command-input'])
    expect(b.commandKeys()).toEqual(['jev'])
    expect(b.ctx.slots.entries('conversation.chat.node')[0]?.locale).toBe('jev')
    expect(b.ctx.slots.entries('conversation.chat.commandview')[0]?.locale).toBe('jev')
  })

  it('removes every registration with the plugin fiber', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(b.kinds()).toEqual([])
    expect(b.chatKeys()).toEqual([])
    expect(b.commandKeys()).toEqual([])
  })

  it('has an inert node half', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
