/**
 * Jev surface plugin, browser half. It projects each durable `/jev`
 * `command/run` as a user-style question bubble ahead of the command's result
 * (the route `/goal` takes: the visible non-command Chat Node activates a
 * fresh session's conversation, so a consult made before the first prompt is
 * shown instead of staying hidden under the empty hero), and it takes over the
 * `jev` key of the command-view slot so the result renders as a message from
 * Jev rather than a collapsed command row. The plugin owns no store, registers
 * no event listener, and creates no model message.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation Context merge (ctx.uiConversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-chat SlotMap merge (the chat node and command-view entries).
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { JevAnswerView } from './JevAnswerView.tsx'
import { JevCommandInputView } from './JevCommandInputView.tsx'
import { jevCommandInputDefinition } from './jev-command-input.ts'
import { en, zh, type JevKey } from './locales.ts'

export type { JevKey } from './locales.ts'
export type { JevCommandInputData } from './jev-command-input.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Jev question bubble's copy. */
    jev: JevKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'jev'

/** Required services for the command-input projection, both renderers, and copy. */
export const inject = ['slots', 'locale', 'uiConversation']

/**
 * Client plugin body: the `/jev` question projection, its keyed renderer, and
 * the `jev` command-view entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(jevCommandInputDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-jev: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'jev-command-input',
    locale: NS,
  }, JevCommandInputView))
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    key: 'jev',
    locale: NS,
  }, JevAnswerView))
}
