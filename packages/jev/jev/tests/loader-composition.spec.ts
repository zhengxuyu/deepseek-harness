// Boots the seam through the real Loader from a cordis.yml so the config
// declaration, its defaults, and load-time misconfiguration are proven on the
// shipping path rather than through hand-mounted plugins.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import JevRuntime from '@deepseek-ai/dsh-jev'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-jev-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-jev'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-jev', JevRuntime]])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as never
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('dsh-jev real Loader composition through cordis.yml', () => {
  it('applies schema defaults for an empty config', async () => {
    const ctx = await boot([])
    expect(ctx.jev.describe()).toEqual({ apiKeyEnv: 'TYPESAFE_API_KEY', baseURL: 'https://api.typesafe.ai', model: 'jev-latest' })
  }, 30_000)

  it('honors configured reference, base, and model', async () => {
    const ctx = await boot(['    apiKeyEnv: JEV_KEY', '    baseURL: https://gateway.internal/', '    model: jev-preview'])
    expect(ctx.jev.describe()).toEqual({ apiKeyEnv: 'JEV_KEY', baseURL: 'https://gateway.internal', model: 'jev-preview' })
  }, 30_000)

  it('fails loading on an unparseable base URL', async () => {
    // The Loader keeps the tree alive around a failed row; the row's own fiber
    // carries the load-time rejection.
    const ctx = await boot(['    baseURL: not a url'])
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-jev')
    await expect(entry?.fiber?.await()).rejects.toThrow(/not an absolute URL/)
  }, 30_000)
})
