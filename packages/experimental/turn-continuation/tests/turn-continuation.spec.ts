/** Turn continuation: empty and cut-off messages, the per-turn bound, and the logged notice. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as TurnContinuation from '../src/index.ts'
import { Config, EMPTY_TURN_NOTICE, MAX_TOKENS_NOTICE } from '../src/index.ts'

/** A reply whose only block is reasoning: nothing to act on and nothing to print. */
function reasoningOnly(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(script: ConstructorParameters<typeof MockAdapter>[0], config: TurnContinuation.Config) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TurnContinuation, config)
  ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  const reasons: TurnEndReason[] = []
  ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })
  const run = async (text: string) => {
    const idle = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { dispose(); resolve() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await idle
  }
  return { ctx, adapter, agent, reasons, run }
}

/** Every continuation notice in the log: text plus its source. */
function notices(agent: Agent): { text: string; source: unknown }[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'turn-continuation')
    .map(event => ({
      text: event.data.content.map(block => block.type === 'text' ? block.text : '').join(''),
      source: event.data.source,
    }))
}

describe('turn-continuation', () => {
  it('requires both bounds', () => {
    expect(() => new Config({} as never)).toThrow()
    expect(() => new Config({ maxContinuations: 0, onMaxTokens: true })).toThrow()
    expect(new Config({ maxContinuations: 2, onMaxTokens: false })).toEqual({ maxContinuations: 2, onMaxTokens: false })
  })

  it('continues a reasoning-only turn with a logged notice until the model acts', async () => {
    const { adapter, agent, reasons, run } = await harness([
      reasoningOnly('let me get started with probes'),
      toolCallResponse('c1', 'probe', {}),
      textResponse('done'),
    ], { maxContinuations: 2, onMaxTokens: false })
    await run('go')
    expect(adapter.requests).toHaveLength(3)
    expect(notices(agent)).toEqual([{
      text: EMPTY_TURN_NOTICE,
      source: { kind: 'turn-continuation', reason: 'empty', attempt: 1, form: 'notice', summary: 'continued after an empty message (1/2)' },
    }])
    expect(reasons).toEqual([{ kind: 'completed' }])
  })

  it('stops nudging at the bound and lets the turn end empty', async () => {
    const { adapter, agent, reasons, run } = await harness([
      reasoningOnly('thinking'),
      reasoningOnly('still thinking'),
      reasoningOnly('and again'),
      textResponse('next turn'),
    ], { maxContinuations: 2, onMaxTokens: false })
    await run('go')
    expect(adapter.requests).toHaveLength(3)
    expect(notices(agent).map(notice => notice.source)).toMatchObject([{ attempt: 1 }, { attempt: 2 }])
    expect(reasons).toEqual([{ kind: 'completed' }])
    // The bound is per turn: a later turn gets its own budget.
    await run('again')
    expect(adapter.requests).toHaveLength(4)
    expect(notices(agent)).toHaveLength(2)
  })

  it('continues a message cut off at the output limit only when opted in, and keeps the max-tokens end reason', async () => {
    const opted = await harness([maxTokensResponse('partial'), textResponse('finished')], { maxContinuations: 1, onMaxTokens: true })
    await opted.run('go')
    expect(opted.adapter.requests).toHaveLength(2)
    expect(notices(opted.agent)).toEqual([{
      text: MAX_TOKENS_NOTICE,
      source: { kind: 'turn-continuation', reason: 'max-tokens', attempt: 1, form: 'notice', summary: 'continued after the output limit (1/1)' },
    }])
    expect(opted.reasons).toEqual([{ kind: 'max-tokens' }])

    const declined = await harness([maxTokensResponse('partial'), textResponse('unused')], { maxContinuations: 1, onMaxTokens: false })
    await declined.run('go')
    expect(declined.adapter.requests).toHaveLength(1)
    expect(notices(declined.agent)).toEqual([])
    expect(declined.reasons).toEqual([{ kind: 'max-tokens' }])
  })

  it('leaves a turn that answered or called a tool alone', async () => {
    const { adapter, agent, run } = await harness([textResponse('answer')], { maxContinuations: 3, onMaxTokens: true })
    await run('go')
    expect(adapter.requests).toHaveLength(1)
    expect(notices(agent)).toEqual([])
  })
})
