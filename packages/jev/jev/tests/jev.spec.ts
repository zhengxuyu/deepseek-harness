import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import JevRuntime, {
  assertRequest,
  JEV_DEFAULT_BASE_URL,
  JEV_DEFAULT_MODEL,
  JevError,
  SYSTEM_ONE_PATH,
  toResult,
  toWireRequest,
  type JevRequest,
} from '@deepseek-ai/dsh-jev'

const BASE = 'https://api.typesafe.test'

/** A request exercising all three question types. */
const REQUEST: JevRequest = {
  state: { ticket: 'The export button crashes Safari.' },
  questions: {
    team: { type: 'choice', instructions: 'Which team should handle this?', options: { frontend: 'UI bugs', backend: null } },
    urgent: { type: 'noul', instructions: 'Is this urgent?' },
    severity: { type: 'score', instructions: 'How severe is it?', levels: ['Cosmetic', 'Degraded', 'Blocking'] },
  },
}

/** A well-formed wire body answering {@link REQUEST}. */
function wireBody(): Record<string, unknown> {
  return {
    model: 'jev-1.13.0',
    answers: {
      team: { type: 'choice', choice: 'frontend', probabilities: { frontend: 0.9, backend: 0.1 }, confidence: 0.8 },
      urgent: { type: 'noul', noul: 0.35 },
      severity: { type: 'score', score: 1.3, legend: { 0: 'Cosmetic', 1: 'Degraded', 2: 'Blocking' }, probabilities: { 0: 0, 1: 0.7, 2: 0.3 }, confidence: 0.54 },
    },
    usage: { input_tokens: 312, output_tokens: 48 },
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function mount(config: ConstructorParameters<typeof JevRuntime>[1] = {}): Promise<{ ctx: Context; jev: JevRuntime }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(JevRuntime, config)
  cleanups.push(() => fiber.dispose())
  return { ctx, jev: ctx.jev }
}

async function code(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error: unknown) {
    if (error instanceof JevError) return error.code
    throw error
  }
  throw new Error('expected a JevError')
}

describe('request validation', () => {
  it.each([
    ['no questions', { state: 's', questions: {} }, /at least one question/],
    ['a blank id', { state: 's', questions: { ' ': { type: 'noul', instructions: 'x' } } }, /question id must not be blank/],
    ['blank instructions', { state: 's', questions: { q: { type: 'noul', instructions: ' ' } } }, /instructions must not be blank/],
    ['one choice option', { state: 's', questions: { q: { type: 'choice', instructions: 'x', options: { a: null } } } }, /at least 2 options/],
    ['a blank option name', { state: 's', questions: { q: { type: 'choice', instructions: 'x', options: { a: null, ' ': null } } } }, /option name must not be blank/],
    ['one score level', { state: 's', questions: { q: { type: 'score', instructions: 'x', levels: ['only'] } } }, /2 through 10 levels/],
    ['eleven score levels', { state: 's', questions: { q: { type: 'score', instructions: 'x', levels: Array.from({ length: 11 }, (_, i) => `L${i}`) } } }, /2 through 10 levels/],
    ['a blank score level', { state: 's', questions: { q: { type: 'score', instructions: 'x', levels: ['a', ' '] } } }, /level must not be blank/],
  ] as const)('rejects %s as JEV_INVALID_REQUEST', (_label, request, message) => {
    expect(() => { assertRequest(request) }).toThrow(expect.objectContaining({ code: 'JEV_INVALID_REQUEST' }))
    expect(() => { assertRequest(request) }).toThrow(message)
  })

  it('accepts a request with every question type', () => {
    expect(() => { assertRequest(REQUEST) }).not.toThrow()
  })
})

describe('wire request mapping', () => {
  it('maps options and levels to criteria and leaves noul without criteria', () => {
    expect(toWireRequest(REQUEST, 'jev-latest')).toEqual({
      state: REQUEST.state,
      model: 'jev-latest',
      questions: {
        team: { type: 'choice', instructions: 'Which team should handle this?', criteria: { frontend: 'UI bugs', backend: null } },
        urgent: { type: 'noul', instructions: 'Is this urgent?' },
        severity: { type: 'score', instructions: 'How severe is it?', criteria: ['Cosmetic', 'Degraded', 'Blocking'] },
      },
    })
  })

  it('lets a request model override the configured default', () => {
    expect(toWireRequest({ ...REQUEST, model: 'jev-preview' }, 'jev-latest').model).toBe('jev-preview')
  })
})

describe('wire response validation', () => {
  it('maps a complete body to a typed result', () => {
    expect(toResult(REQUEST, wireBody())).toEqual({
      model: 'jev-1.13.0',
      answers: {
        team: { type: 'choice', choice: 'frontend', probabilities: { frontend: 0.9, backend: 0.1 }, confidence: 0.8 },
        urgent: { type: 'noul', noul: 0.35 },
        severity: { type: 'score', score: 1.3, legend: { 0: 'Cosmetic', 1: 'Degraded', 2: 'Blocking' }, probabilities: { 0: 0, 1: 0.7, 2: 0.3 }, confidence: 0.54 },
      },
      usage: { inputTokens: 312, outputTokens: 48 },
    })
  })

  it('reports zero usage when the body omits it', () => {
    const body = wireBody()
    delete body.usage
    expect(toResult(REQUEST, body).usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it.each([
    ['a non-object body', 'nope', /not a JSON object/],
    ['no model', { ...wireBody(), model: '' }, /no model/],
    ['no answers', { ...wireBody(), answers: [] }, /no answers object/],
    ['a missing answer', { ...wireBody(), answers: { ...wireBody().answers as object, urgent: undefined } }, /answer "urgent" is missing/],
    ['a type mismatch', { ...wireBody(), answers: { ...wireBody().answers as object, urgent: { type: 'choice' } } }, /has type "choice", expected noul/],
    ['a malformed choice', { ...wireBody(), answers: { ...wireBody().answers as object, team: { type: 'choice', choice: 'frontend', probabilities: { frontend: 'high' }, confidence: 1 } } }, /not a well-formed choice/],
    ['an unknown chosen option', { ...wireBody(), answers: { ...wireBody().answers as object, team: { type: 'choice', choice: 'ops', probabilities: { ops: 1 }, confidence: 1 } } }, /chose unknown option "ops"/],
    ['a malformed noul', { ...wireBody(), answers: { ...wireBody().answers as object, urgent: { type: 'noul', noul: 'yes' } } }, /not a well-formed noul/],
    ['a malformed score', { ...wireBody(), answers: { ...wireBody().answers as object, severity: { type: 'score', score: 1, legend: { 0: 1 }, probabilities: {}, confidence: 1 } } }, /not a well-formed score/],
  ])('rejects %s as JEV_PROVIDER_ERROR', (_label, body, message) => {
    expect(() => toResult(REQUEST, body)).toThrow(expect.objectContaining({ code: 'JEV_PROVIDER_ERROR' }))
    expect(() => toResult(REQUEST, body)).toThrow(message)
  })
})

describe('JevRuntime construction', () => {
  it('applies defaults, strips a trailing slash, and never exposes the key', async () => {
    const { jev } = await mount({ apiKey: 'secret', baseURL: `${BASE}/` })
    expect(jev.describe()).toEqual({ apiKeyEnv: credentialRef('TYPESAFE_API_KEY'), baseURL: BASE, model: JEV_DEFAULT_MODEL })
    expect(JSON.stringify(jev.describe())).not.toContain('secret')
  })

  it('applies the constant fallbacks under direct construction', () => {
    const jev = new JevRuntime(new Context())
    expect(jev.describe()).toEqual({ apiKeyEnv: credentialRef('TYPESAFE_API_KEY'), baseURL: JEV_DEFAULT_BASE_URL, model: JEV_DEFAULT_MODEL })
  })

  it('reads the public base and TYPESAFE_BASE_URL fallbacks', async () => {
    expect((await mount()).jev.describe().baseURL).toBe(JEV_DEFAULT_BASE_URL)
    vi.stubEnv('TYPESAFE_BASE_URL', 'https://gateway.internal')
    expect((await mount()).jev.describe().baseURL).toBe('https://gateway.internal')
  })

  it('fails loud on an unparseable base URL', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(JevRuntime, { baseURL: 'not a url' })).rejects.toThrow(/not an absolute URL/)
  })
})

describe('JevRuntime.decide', () => {
  it('posts the wire body with bearer auth and returns the validated result', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(wireBody()))
    vi.stubGlobal('fetch', fetchMock)
    const { jev } = await mount({ apiKey: 'literal-key', baseURL: BASE, model: 'jev-preview' })

    const result = await jev.decide(REQUEST)

    expect(result.model).toBe('jev-1.13.0')
    expect(result.answers.team).toMatchObject({ choice: 'frontend' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}${SYSTEM_ONE_PATH}`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer literal-key')
    expect(JSON.parse(init.body as string)).toEqual(toWireRequest(REQUEST, 'jev-preview'))
    expect(init.signal).toBeUndefined()
  })

  it('validates before resolving a credential or dialing', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const { jev } = await mount({ baseURL: BASE })
    expect(await code(jev.decide({ state: 's', questions: {} }))).toBe('JEV_INVALID_REQUEST')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails as JEV_CREDENTIAL_MISSING without dialing when nothing resolves', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const { jev } = await mount({ baseURL: BASE, apiKeyEnv: 'JEV_TEST_UNSET_KEY' })
    await expect(jev.decide(REQUEST)).rejects.toThrow(expect.objectContaining({
      code: 'JEV_CREDENTIAL_MISSING',
      message: expect.stringContaining('JEV_TEST_UNSET_KEY') as string,
    }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves the key from the launch environment when no credentials seam is mounted', async () => {
    vi.stubEnv('JEV_TEST_ENV_KEY', 'env-key')
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(wireBody()))
    vi.stubGlobal('fetch', fetchMock)
    const { jev } = await mount({ baseURL: BASE, apiKeyEnv: 'JEV_TEST_ENV_KEY' })
    await jev.decide(REQUEST)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer env-key')
  })

  it('resolves the key through a mounted credentials seam at each call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-credentials-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const provider = await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    cleanups.push(() => provider.dispose())
    const fiber = await ctx.plugin(JevRuntime, { baseURL: BASE, apiKeyEnv: 'JEV_TEST_STORED_KEY' })
    cleanups.push(() => fiber.dispose())
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(wireBody()))
    vi.stubGlobal('fetch', fetchMock)

    expect(await code(ctx.jev.decide(REQUEST))).toBe('JEV_CREDENTIAL_MISSING')
    await ctx.credentials.set(credentialRef('JEV_TEST_STORED_KEY'), 'stored-key')
    await ctx.jev.decide(REQUEST)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer stored-key')
  })

  it('wraps a failing credential backend as JEV_PROVIDER_ERROR', async () => {
    const ctx = new Context()
    ctx.provide('credentials', { resolve: () => Promise.reject(new Error('store offline')) } as never)
    const fiber = await ctx.plugin(JevRuntime, { baseURL: BASE })
    cleanups.push(() => fiber.dispose())
    await expect(ctx.jev.decide(REQUEST)).rejects.toThrow(expect.objectContaining({
      code: 'JEV_PROVIDER_ERROR',
      message: expect.stringContaining('store offline') as string,
    }))
  })

  it('rejects a pre-aborted signal as JEV_ABORTED without dialing', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const { jev } = await mount({ apiKey: 'k', baseURL: BASE })
    const controller = new AbortController()
    controller.abort()
    expect(await code(jev.decide(REQUEST, controller.signal))).toBe('JEV_ABORTED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards the signal and maps a fetch abort to JEV_ABORTED', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => { throw new DOMException('aborted', 'AbortError') })
    vi.stubGlobal('fetch', fetchMock)
    const { jev } = await mount({ apiKey: 'k', baseURL: BASE })
    const signal = new AbortController().signal
    expect(await code(jev.decide(REQUEST, signal))).toBe('JEV_ABORTED')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBe(signal)
  })

  it('maps a network failure to JEV_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const { jev } = await mount({ apiKey: 'k', baseURL: BASE })
    await expect(jev.decide(REQUEST)).rejects.toThrow(expect.objectContaining({ code: 'JEV_PROVIDER_ERROR', message: expect.stringContaining('fetch failed') as string }))
  })

  it.each([
    [400, { error: 'bad state' }, 'JEV_INVALID_REQUEST', 'TypeSafe API error (HTTP 400): bad state'],
    [422, { error: { message: 'malformed question' } }, 'JEV_INVALID_REQUEST', 'TypeSafe API error (HTTP 422): malformed question'],
    [401, { message: 'invalid key' }, 'JEV_UNAUTHORIZED', 'TypeSafe API error (HTTP 401): invalid key'],
    [403, {}, 'JEV_UNAUTHORIZED', 'TypeSafe API error (HTTP 403)'],
    [429, { error: '' }, 'JEV_RATE_LIMITED', 'TypeSafe API error (HTTP 429)'],
    [529, { error: 'overloaded' }, 'JEV_RATE_LIMITED', 'TypeSafe API error (HTTP 529): overloaded'],
    [500, 'not json', 'JEV_PROVIDER_ERROR', 'TypeSafe API error (HTTP 500)'],
  ])('maps HTTP %s to %s', async (status, body, expectedCode, message) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status })))
    const { jev } = await mount({ apiKey: 'k', baseURL: BASE })
    await expect(jev.decide(REQUEST)).rejects.toThrow(expect.objectContaining({ code: expectedCode, message }))
  })

  it('reports an abort while reading an error body as JEV_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    })))
    const { jev } = await mount({ apiKey: 'k', baseURL: BASE })
    expect(await code(jev.decide(REQUEST))).toBe('JEV_ABORTED')
  })

  it('reports an abort while reading a success body as JEV_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    })))
    const { jev } = await mount({ apiKey: 'k', baseURL: BASE })
    expect(await code(jev.decide(REQUEST))).toBe('JEV_ABORTED')
  })

  it('reports a non-JSON success body as JEV_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })))
    const { jev } = await mount({ apiKey: 'k', baseURL: BASE })
    expect(await code(jev.decide(REQUEST))).toBe('JEV_PROVIDER_ERROR')
  })

  it('reports a malformed success body as JEV_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ model: 'jev-1.13.0', answers: {} })))
    const { jev } = await mount({ apiKey: 'k', baseURL: BASE })
    await expect(jev.decide(REQUEST)).rejects.toThrow(expect.objectContaining({ code: 'JEV_PROVIDER_ERROR', message: expect.stringContaining('answer "team" is missing') as string }))
  })
})
