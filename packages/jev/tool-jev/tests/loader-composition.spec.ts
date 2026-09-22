// Boots the tool over the seam through the real Loader from a cordis.yml, so
// the shipping registration path (not a hand-mounted plugin) proves the tool
// and its prompt section exist and that budgets fail at load when invalid.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import JevRuntime from '@deepseek-ai/dsh-jev'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolJev from '@deepseek-ai/dsh-tool-jev'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-jev-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-jev'",
    "- name: '@deepseek-ai/dsh-tool-jev'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-jev', JevRuntime],
    ['@deepseek-ai/dsh-tool-jev', ToolJev],
  ])
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

describe('tool-jev real Loader composition through cordis.yml', () => {
  it('registers the jev tool with the configured timeout and its prompt section', async () => {
    const ctx = await boot(['    timeoutMs: 5000'])
    expect(ctx.tools.get('jev')?.timeoutMs).toBe(5000)
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:jev')).toBe(true)
  }, 30_000)

  it('fails loading when a budget is not a positive integer', async () => {
    // The Loader keeps the tree alive around a failed row; the row's own fiber
    // carries the load-time rejection.
    const ctx = await boot(['    maxQuestions: 0'])
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-tool-jev')
    await expect(entry?.fiber?.await()).rejects.toThrow('tool-jev: maxQuestions must be a positive integer')
  }, 30_000)
})
