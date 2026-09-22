// Boots the command over the seam through the real Loader from a cordis.yml,
// proving discovery on the assembled command plane and load-time budget checks.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import JevRuntime from '@deepseek-ai/dsh-jev'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandJev from '@deepseek-ai/dsh-command-jev'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-command-jev-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-jev'",
    "- name: '@deepseek-ai/dsh-command-jev'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-jev', JevRuntime],
    ['@deepseek-ai/dsh-command-jev', commandJev],
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

describe('command-jev real Loader composition through cordis.yml', () => {
  it('discovers /jev on the assembled command plane and rejects bad grammar directly', async () => {
    const ctx = await boot([])
    const session = Session.create(SessionId('command-jev-loader'))
    const agent = { session, status: 'idle', options: {}, inject: () => {}, reserveTurnAdmission: () => () => undefined } as never as Agent
    expect(ctx.commands.list(agent).map(command => command.name)).toContain('jev')
    const execution = await ctx.commands.execute(agent, '/jev', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'error', text: commandJev.JEV_COMMAND_USAGE })
  }, 30_000)

  it('fails loading when a budget is not a positive integer', async () => {
    // The Loader keeps the tree alive around a failed row; the row's own fiber
    // carries the load-time rejection.
    const ctx = await boot(['    contextChars: 0'])
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-command-jev')
    await expect(entry?.fiber?.await()).rejects.toThrow('command-jev: contextChars must be a positive integer')
  }, 30_000)
})
