/**
 * The real tool registry, prompt registry, and Jev seam with only the network
 * boundary stubbed: nothing bypasses `ctx.tools.execute()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import JevRuntime from '@deepseek-ai/dsh-jev'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolJev from '@deepseek-ai/dsh-tool-jev'
import { JEV_PROMPT_TEXT, JEV_TOOL_DESCRIPTION, renderAnswer } from '@deepseek-ai/dsh-tool-jev'

const BASE = 'https://api.typesafe.test'
const signal = new AbortController().signal

const QUESTIONS = [
  { id: 'team', type: 'choice', instructions: 'Which team should handle this?', options: { frontend: 'UI bugs', backend: null } },
  { id: 'urgent', type: 'noul', instructions: 'Is this urgent?' },
  { id: 'severity', type: 'score', instructions: 'How severe is it?', levels: ['Cosmetic', 'Degraded', 'Blocking'] },
]

function wireBody(): unknown {
  return {
    model: 'jev-1.13.0',
    answers: {
      team: { type: 'choice', choice: 'frontend', probabilities: { backend: 0.1, frontend: 0.9 }, confidence: 0.8 },
      urgent: { type: 'noul', noul: 0.35 },
      severity: { type: 'score', score: 1.3, legend: { 0: 'Cosmetic', 1: 'Degraded', 2: 'Blocking' }, probabilities: { 0: 0, 1: 0.7, 2: 0.3 }, confidence: 0.54 },
    },
    usage: { input_tokens: 312, output_tokens: 48 },
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
let counter = 0

async function mount(config: ToolJev.Config = {}, jevConfig: ConstructorParameters<typeof JevRuntime>[1] = { apiKey: 'k', baseURL: BASE }): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JevRuntime, jevConfig)
  fiber = await ctx.plugin(ToolJev, config)
}

beforeEach(() => mount())

afterEach(async () => {
  await fiber.dispose()
  await ctx.fiber.dispose()
  vi.unstubAllGlobals()
})

function call(args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal, callId: ToolCallId(`call-${++counter}`), name: 'jev', arguments: args })
}

function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('')
}

describe('registration', () => {
  it('registers the stable schema, timeout, and prompt section', async () => {
    const schema = ctx.tools.schemas().find(s => s.name === 'jev')
    expect(schema?.description).toBe(JEV_TOOL_DESCRIPTION)
    const parameters = schema?.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(parameters.properties)).toEqual(['state', 'questions'])
    expect(parameters.required).toEqual(['state', 'questions'])
    expect(ctx.tools.get('jev')?.timeoutMs).toBe(30_000)
    expect((await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:jev')?.text).toBe(JEV_PROMPT_TEXT)
  })

  it('has no default export and keeps name/inject through unwrapExports', () => {
    expect('default' in ToolJev).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(ToolJev)).toBe(ToolJev)
    expect(ToolJev.name).toBe('tool-jev')
    expect(ToolJev.inject).toEqual(['tools', 'jev', 'systemPrompt'])
  })

  it('removes the tool and section when the fiber is disposed (HMR safety)', async () => {
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'jev')).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:jev')).toBe(false)
    fiber = await ctx.plugin(ToolJev, {})
  })

  it.each([
    ['timeoutMs', { timeoutMs: 0 }],
    ['maxQuestions', { maxQuestions: 1.5 }],
    ['maxStateChars', { maxStateChars: -1 }],
  ])('fails loud when %s is not a positive integer', async (field, config) => {
    const other = new Context()
    await other.plugin(SystemPrompt)
    await other.plugin(ToolRuntime)
    await other.plugin(JevRuntime, { apiKey: 'k', baseURL: BASE })
    await expect(other.plugin(ToolJev, config)).rejects.toThrow(`tool-jev: ${field} must be a positive integer`)
    await other.fiber.dispose()
  })
})

describe('execution', () => {
  it('sends every question type and renders the validated answers in request order', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(wireBody()))
    vi.stubGlobal('fetch', fetchMock)
    const result = await call({ state: { ticket: 'Export crashes Safari.' }, questions: QUESTIONS })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      'Jev (jev-1.13.0) answered:',
      '- team (choice): frontend — frontend 90%, backend 10%; confidence 0.80',
      '- urgent (noul): yes 35%',
      '- severity (score): 1.30 on 0–2 — 1 "Degraded" 70%, 2 "Blocking" 30%, 0 "Cosmetic" 0%; confidence 0.54',
    ].join('\n'))
    expect(result.value).toEqual({
      model: 'jev-1.13.0',
      answers: [
        { id: 'team', type: 'choice', choice: 'frontend', probabilities: { backend: 0.1, frontend: 0.9 }, confidence: 0.8 },
        { id: 'urgent', type: 'noul', noul: 0.35 },
        { id: 'severity', type: 'score', score: 1.3, legend: { 0: 'Cosmetic', 1: 'Degraded', 2: 'Blocking' }, probabilities: { 0: 0, 1: 0.7, 2: 0.3 }, confidence: 0.54 },
      ],
      usage: { inputTokens: 312, outputTokens: 48 },
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      state: { ticket: 'Export crashes Safari.' },
      model: 'jev-latest',
      questions: {
        team: { type: 'choice', instructions: 'Which team should handle this?', criteria: { frontend: 'UI bugs', backend: null } },
        urgent: { type: 'noul', instructions: 'Is this urgent?' },
        severity: { type: 'score', instructions: 'How severe is it?', criteria: ['Cosmetic', 'Degraded', 'Blocking'] },
      },
    })
  })

  it('accepts a string state', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ model: 'jev-1.13.0', answers: { urgent: { type: 'noul', noul: 0.9 } } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await call({ state: 'Payouts failing for 3 days.', questions: [QUESTIONS[1]] })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('yes 90%')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ state: 'Payouts failing for 3 days.' })
  })

  it.each([
    ['no questions', { state: 's', questions: [] }, 'at least one question'],
    ['a duplicate id', { state: 's', questions: [QUESTIONS[1], QUESTIONS[1]] }, 'duplicate question id "urgent"'],
    ['a choice without options', { state: 's', questions: [{ id: 'q', type: 'choice', instructions: 'x' }] }, 'choice requires `options`'],
    ['a choice with levels', { state: 's', questions: [{ ...QUESTIONS[0], levels: ['a', 'b'] }] }, 'choice does not take `levels`'],
    ['a non-string option description', { state: 's', questions: [{ id: 'q', type: 'choice', instructions: 'x', options: { a: 1, b: null } }] }, 'option "a" needs a string description or null'],
    ['a noul with options', { state: 's', questions: [{ ...QUESTIONS[1], options: { a: null } }] }, 'noul takes neither'],
    ['a score without levels', { state: 's', questions: [{ id: 'q', type: 'score', instructions: 'x' }] }, 'score requires `levels`'],
    ['a score with options', { state: 's', questions: [{ ...QUESTIONS[2], options: { a: null } }] }, 'score does not take `options`'],
    ['a seam-level violation', { state: 's', questions: [{ id: 'q', type: 'choice', instructions: 'x', options: { only: null } }] }, 'needs at least 2 options'],
  ])('rejects %s before dialing', async (_label, args, message) => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const result = await call(args)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('enforces the configured question and state budgets', async () => {
    await fiber.dispose()
    fiber = await ctx.plugin(ToolJev, { maxQuestions: 1, maxStateChars: 10 })
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const tooMany = await call({ state: 's', questions: [QUESTIONS[1], QUESTIONS[0]] })
    expect(text(tooMany)).toContain('at most 1 questions per call (got 2)')
    const tooBig = await call({ state: 'x'.repeat(11), questions: [QUESTIONS[1]] })
    expect(text(tooBig)).toContain('state is 13 characters; the limit is 10')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a seam failure as a structured tool error', async () => {
    await ctx.fiber.dispose()
    await mount({}, { baseURL: BASE, apiKeyEnv: 'JEV_TOOL_TEST_UNSET' })
    const result = await call({ state: 's', questions: [QUESTIONS[1]] })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('JEV_CREDENTIAL_MISSING')
  })

  it('renders a pending card from the arguments alone', () => {
    const definition = ctx.tools.get('jev')
    const args = { state: 's', questions: [QUESTIONS[1]] }
    expect(definition?.presentCall?.(args)).toEqual({ card: 'generic', title: 'Ask Jev', kind: 'other', rawInput: args })
  })
})

describe('renderAnswer', () => {
  it('renders a score with an unknown legend index as an empty label', () => {
    expect(renderAnswer('q', { type: 'score', score: 0.5, legend: { 0: 'low' }, probabilities: { 0: 0.5, 1: 0.5 }, confidence: 0.1 }))
      .toBe('- q (score): 0.50 on 0–0 — 0 "low" 50%, 1 "" 50%; confidence 0.10')
  })
})
