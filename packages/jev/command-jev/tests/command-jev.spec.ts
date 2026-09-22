/**
 * The real command registry and Jev seam with only the network boundary
 * stubbed; the receiving agent is a stub over a real Session so state
 * derivation and the injected notice are observed exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import JevRuntime from '@deepseek-ai/dsh-jev'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm/message'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandJev from '@deepseek-ai/dsh-command-jev'
import { describeAnswer, JEV_COMMAND_USAGE, parseJevCommand, recentConversation } from '@deepseek-ai/dsh-command-jev'

const BASE = 'https://api.typesafe.test'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function choiceBody(): unknown {
  return { model: 'jev-1.13.0', answers: { answer: { type: 'choice', choice: 'sqlite', probabilities: { jsonl: 0.18, sqlite: 0.82 }, confidence: 0.71 } } }
}

function noulBody(noul: number): unknown {
  return { model: 'jev-1.13.0', answers: { answer: { type: 'noul', noul } } }
}

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly injected: UserMessage[]
}

/** A minimal receiving agent over a real Session. */
function stubAgent(id = 'command-jev'): StubAgent {
  const session = Session.create(SessionId(id))
  const injected: UserMessage[] = []
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    inject: (message: UserMessage) => { injected.push(message) },
    reserveTurnAdmission: () => () => undefined,
  } as never as Agent
  return { agent, session, injected }
}

/** Append one human/model exchange the way the loop records it. */
function exchange(session: Session, turn: number, user: string, assistant?: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  if (assistant !== undefined) {
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: assistant }], source: { provider: 'p', model: 'm' } }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

let ctx: Context
let plugin: Awaited<ReturnType<Context['plugin']>>

async function mount(config: commandJev.Config = {}, jevConfig: ConstructorParameters<typeof JevRuntime>[1] = { apiKey: 'k', baseURL: BASE }): Promise<void> {
  ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(JevRuntime, jevConfig)
  plugin = await ctx.plugin(commandJev, config)
}

beforeEach(() => mount())

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.unstubAllGlobals()
})

async function run(agent: Agent, line: string, controller = new AbortController()): Promise<{ commandId: string; result: CommandResult }> {
  const execution = await ctx.commands.execute(agent, line, [], controller.signal)
  if (execution === undefined) throw new Error('jev command was not registered')
  return execution
}

/** The executor-owned lifecycle pair for the last invocation, proven log-only. */
function lastLifecycle(session: Session): { args: string | undefined; outcome: Record<string, unknown> } {
  const events = session.snapshotEvents().filter(event => event.type === 'command/run' || event.type === 'command/done').slice(-2)
  const runEvent = events[0]
  const doneEvent = events[1]
  if (runEvent?.type !== 'command/run' || doneEvent?.type !== 'command/done') throw new Error('expected a command lifecycle pair')
  expect(doneEvent.data.commandId).toBe(runEvent.data.commandId)
  expect(runEvent.data.name).toBe('jev')
  const { commandId: _id, ...outcome } = doneEvent.data
  return { args: runEvent.data.args, outcome }
}

describe('grammar', () => {
  it.each([
    ['', JEV_COMMAND_USAGE],
    ['   ', JEV_COMMAND_USAGE],
    [' ship it? | yes', 'A choice needs at least two options.'],
    [' pick | a | ', 'Every option must be non-empty.'],
    [' pick | a | a', 'Options must be distinct.'],
  ])('rejects %j', (input, message) => {
    expect(parseJevCommand(input)).toEqual({ error: expect.stringContaining(message) as string })
  })

  it('parses a bare question as noul and a piped question as choice', () => {
    expect(parseJevCommand(' Is this safe to merge?')).toEqual({ kind: 'noul', question: 'Is this safe to merge?' })
    expect(parseJevCommand(' Storage? | sqlite | jsonl ')).toEqual({ kind: 'choice', question: 'Storage?', options: ['sqlite', 'jsonl'] })
  })

  it('accepts the full-width bar a CJK keyboard produces', () => {
    expect(parseJevCommand(' 用哪个存储？｜sqlite ｜ jsonl')).toEqual({ kind: 'choice', question: '用哪个存储？', options: ['sqlite', 'jsonl'] })
    expect(parseJevCommand(' 二选一｜a | b')).toEqual({ kind: 'choice', question: '二选一', options: ['a', 'b'] })
  })
})

describe('recentConversation', () => {
  it('keeps only human and model text, newest first bounded by count', () => {
    const { agent, session } = stubAgent()
    for (let turn = 1; turn <= 4; turn++) exchange(session, turn, `u${turn}`, `a${turn}`)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'plugin context' }],
      source: { kind: 'jev', form: 'notice', summary: 'another consult' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      stream: [],
      turn: 5,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    expect(recentConversation(agent, { contextMessages: 3, contextChars: 1000 })).toEqual([
      { role: 'assistant', text: 'a3' },
      { role: 'user', text: 'u4' },
      { role: 'assistant', text: 'a4' },
    ])
  })

  it('drops the oldest entries over the character budget and keeps a lone entry tail', () => {
    const { agent, session } = stubAgent()
    exchange(session, 1, 'first message', 'second message')
    expect(recentConversation(agent, { contextMessages: 10, contextChars: 15 })).toEqual([{ role: 'assistant', text: 'second message' }])
    expect(recentConversation(agent, { contextMessages: 10, contextChars: 5 })).toEqual([{ role: 'assistant', text: '…sage' }])
    expect(recentConversation(stubAgent('empty').agent, { contextMessages: 10, contextChars: 5 })).toEqual([])
  })
})

describe('registration', () => {
  it('registers one command with a hint, Loader-safe exports, and disposes it', async () => {
    const { agent } = stubAgent()
    expect(commandJev.name).toBe('command-jev')
    expect(commandJev.inject).toEqual(['commands', 'jev'])
    expect('default' in commandJev).toBe(false)
    expect((Object.create(Loader.prototype) as Loader).unwrapExports(commandJev)).toBe(commandJev)
    expect(ctx.commands.list(agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-command-jev',
      name: 'jev',
      description: 'Ask Jev, the fast-thinking teammate, for a quick judgment',
      input: { hint: 'question | option | option' },
    })
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'jev')).toBeUndefined()
  })

  it.each([
    ['contextMessages', { contextMessages: 0 }],
    ['contextChars', { contextChars: 2.5 }],
    ['timeoutMs', { timeoutMs: -1 }],
  ])('fails loud when %s is not a positive integer', async (field, config) => {
    const other = new Context()
    await other.plugin(CommandRuntime)
    await other.plugin(JevRuntime, { apiKey: 'k', baseURL: BASE })
    await expect(other.plugin(commandJev, config)).rejects.toThrow(`command-jev: ${field} must be a positive integer`)
    await other.fiber.dispose()
  })
})

describe('/jev', () => {
  it('asks a choice over the recent conversation, renders it, and shares it with the agent', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(choiceBody()))
    vi.stubGlobal('fetch', fetchMock)
    const { agent, session, injected } = stubAgent()
    exchange(session, 1, 'We need durable sessions.', 'Two options: SQLite or JSONL.')

    const { result } = await run(agent, '/jev Which storage fits? | sqlite | jsonl')

    expect(result).toEqual({ kind: 'success', text: 'Jev picks "sqlite" (82%); jsonl 18%. Confidence 0.71 (jev-1.13.0).' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'jev-latest',
      state: {
        question: 'Which storage fits?',
        conversation: [
          { role: 'user', text: 'We need durable sessions.' },
          { role: 'assistant', text: 'Two options: SQLite or JSONL.' },
        ],
      },
      questions: { answer: { type: 'choice', instructions: 'Which storage fits?', criteria: { sqlite: null, jsonl: null } } },
    })
    expect(injected).toHaveLength(1)
    expect(injected[0]).toMatchObject({
      role: 'user',
      content: [{
        type: 'text',
        text: [
          'The user consulted Jev, the fast-thinking System One teammate, about the recent conversation.',
          'Question: Which storage fits?',
          'Options: sqlite | jsonl',
          'Jev (jev-1.13.0) answered: picks "sqlite" (82%); jsonl 18%. Confidence 0.71.',
        ].join('\n'),
      }],
      source: { kind: 'jev', form: 'notice', summary: 'Jev consult: Which storage fits?' },
    })
    expect(lastLifecycle(session)).toEqual({ args: ' Which storage fits? | sqlite | jsonl', outcome: { kind: 'success', text: result.text } })
    expect(session.deriveMessages().filter(message => message.source.kind === 'jev')).toEqual([])
  })

  it('asks a noul for a bare question', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(noulBody(0.12))))
    const { agent, injected } = stubAgent()
    const { result } = await run(agent, '/jev Is it safe to merge?')
    expect(result).toEqual({ kind: 'success', text: 'Jev yes 12%, no 88% (jev-1.13.0).' })
    expect(injected[0]?.content).toEqual([{ type: 'text', text: expect.stringContaining('Jev (jev-1.13.0) answered: yes 12%, no 88%.') as string }])
    expect(injected[0]?.content[0]).toEqual({ type: 'text', text: expect.not.stringContaining('Options:') as string })
  })

  it('renders a grammar error without dialing or injecting', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const { agent, session, injected } = stubAgent()
    const { result } = await run(agent, '/jev')
    expect(result).toEqual({ kind: 'error', text: JEV_COMMAND_USAGE })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(injected).toEqual([])
    expect(lastLifecycle(session).outcome).toEqual({ kind: 'error', text: JEV_COMMAND_USAGE })
  })

  it('renders a seam failure with its code', async () => {
    await ctx.fiber.dispose()
    await mount({}, { baseURL: BASE, apiKeyEnv: 'JEV_COMMAND_TEST_UNSET' })
    const { agent, injected } = stubAgent()
    const { result } = await run(agent, '/jev Ship it?')
    expect(result).toEqual({ kind: 'error', text: expect.stringMatching(/^Jev is unavailable \(JEV_CREDENTIAL_MISSING\): /) as string })
    expect(injected).toEqual([])
  })

  it('reports the deadline when Jev does not answer in time', async () => {
    await ctx.fiber.dispose()
    await mount({ timeoutMs: 20 })
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    })))
    const { agent } = stubAgent()
    const { result } = await run(agent, '/jev Ship it?')
    expect(result).toEqual({ kind: 'error', text: 'Jev did not answer within 20 ms.' })
  })

  it('lets the registry settle a caller abort and never injects afterwards', async () => {
    const controller = new AbortController()
    const abort = new Error('user cancelled')
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
      controller.abort(abort)
    })))
    const { agent, session, injected } = stubAgent()
    await expect(run(agent, '/jev Ship it?', controller)).rejects.toBe(abort)
    expect(lastLifecycle(session).outcome).toEqual({ kind: 'error', text: 'user cancelled' })
    await plugin.dispose()
    expect(injected).toEqual([])
  })

  it('lets an unexpected failure propagate through the registry as a logged error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(noulBody(0.5))))
    const { agent, session } = stubAgent()
    vi.spyOn(session, 'deriveMessages').mockImplementation(() => { throw new Error('log unreadable') })
    await expect(run(agent, '/jev Ship it?')).rejects.toThrow('log unreadable')
    expect(lastLifecycle(session).outcome).toEqual({ kind: 'error', text: 'log unreadable' })
  })

  it('rethrows a non-Jev seam failure instead of rendering it', async () => {
    vi.spyOn(ctx.jev, 'decide').mockRejectedValue(new Error('seam bug'))
    const { agent, session, injected } = stubAgent()
    await expect(run(agent, '/jev Ship it?')).rejects.toThrow('seam bug')
    expect(lastLifecycle(session).outcome).toEqual({ kind: 'error', text: 'seam bug' })
    expect(injected).toEqual([])
  })

  it('still answers the user when the agent cannot take the notice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(noulBody(0.5))))
    const { agent } = stubAgent()
    ;(agent as { inject: unknown }).inject = () => { throw new Error('disposed') }
    const { result } = await run(agent, '/jev Ship it?')
    expect(result).toEqual({ kind: 'success', text: 'Jev yes 50%, no 50% (jev-1.13.0).' })
  })

  it('waits for every in-flight consultation before the registration unwinds', async () => {
    const releases: ((response: Response) => void)[] = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { releases.push(resolve) })))
    const first = run(stubAgent('first').agent, '/jev Ship it?')
    const second = run(stubAgent('second').agent, '/jev Ship it?')
    await vi.waitFor(() => { expect(releases).toHaveLength(2) })
    let disposed = false
    const disposing = plugin.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    releases[0]?.(jsonResponse(noulBody(0.5)))
    await first
    await Promise.resolve()
    expect(disposed).toBe(false)
    releases[1]?.(jsonResponse(noulBody(0.5)))
    await second
    await disposing
    expect(disposed).toBe(true)
  })
})

describe('describeAnswer', () => {
  it('omits the others clause for a single-option distribution', () => {
    expect(describeAnswer({ type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 })).toBe('picks "a" (100%). Confidence 1.00')
  })

  it('renders a choice missing from its own distribution as zero', () => {
    expect(describeAnswer({ type: 'choice', choice: 'a', probabilities: { b: 1 }, confidence: 1 })).toBe('picks "a" (0%); b 100%. Confidence 1.00')
  })
})
