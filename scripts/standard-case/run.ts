/**
 * Run one standard case: one `dsh --profile headless` run from source, with a
 * real model, on the case's task in a fresh workspace the case prepared. Everything
 * the run leaves goes under the output directory: the workspace, the Harness
 * home with every Session log, stdout, stderr, and `run.json`.
 *
 * Started through `pnpm run standard-case`; see `index.ts`.
 *
 * The model and its reasoning effort are fixed, so runs at different
 * revisions differ only by the code. Where the model is reached comes from the
 * environment: `STANDARD_CASE_PROVIDER`, `STANDARD_CASE_API_KEY_ENV` (the name
 * of the variable holding the key), `STANDARD_CASE_ROUTE` and
 * `STANDARD_CASE_MODEL_SPEC` (JSON), and `STANDARD_CASE_DEADLINE_MS`.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump } from 'js-yaml'
import type { StandardCase } from './case.ts'

const root = resolve(import.meta.dirname, '../..')

/** What one standard-case run is configured with; recorded in `run.json` without the key. */
export interface RunSettings {
  readonly provider: string
  readonly model: string
  readonly effort: string
  readonly apiKeyEnv: string
  readonly route: Record<string, unknown>
  readonly modelSpec: Record<string, unknown>
  readonly deadlineMs: number
}

/** What `run.json` records about a finished run. */
export interface RunRecord {
  readonly case: string
  readonly settings: RunSettings
  readonly revision: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly startedAt: string
  readonly elapsedMs: number
}

/** The model every standard-case run uses. */
export const MODEL = 'deepseek/deepseek-v4.1-flash'
/** The reasoning effort every standard-case run uses. */
export const EFFORT = 'high'

const DEFAULT_ROUTE = { api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1' }
const DEFAULT_MODEL_SPEC = {
  contextWindow: 1_048_576,
  maxTokens: 65_536,
  input: ['text'],
  reasoningEfforts: { high: 'high', xhigh: 'xhigh' },
  compat: { supportsDeveloperRole: false, thinkingFormat: 'openrouter', requiresReasoningContentOnAssistantMessages: true },
}

function jsonEnv(env: NodeJS.ProcessEnv, name: string, fallback: Record<string, unknown>): Record<string, unknown> {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be a JSON object`)
  return { ...value }
}

/**
 * Resolve the run's settings: the fixed model and effort, and the route from
 * the environment, defaulting to OpenRouter.
 * @param env - the process environment.
 * @returns the settings; the key itself is read later, by name.
 */
export function resolveSettings(env: NodeJS.ProcessEnv): RunSettings {
  // A workflow passes an unset repository variable as an empty string.
  const set = (name: string): string | undefined => (env[name] ?? '').trim() === '' ? undefined : env[name]
  const deadlineMs = Number(set('STANDARD_CASE_DEADLINE_MS') ?? 900_000)
  if (!Number.isInteger(deadlineMs) || deadlineMs < 60_000) throw new Error('STANDARD_CASE_DEADLINE_MS must be an integer of at least 60000')
  return {
    provider: set('STANDARD_CASE_PROVIDER') ?? 'openrouter',
    model: MODEL,
    effort: EFFORT,
    apiKeyEnv: set('STANDARD_CASE_API_KEY_ENV') ?? 'OPENROUTER_API_KEY',
    route: jsonEnv(env, 'STANDARD_CASE_ROUTE', DEFAULT_ROUTE),
    modelSpec: jsonEnv(env, 'STANDARD_CASE_MODEL_SPEC', DEFAULT_MODEL_SPEC),
    deadlineMs,
  }
}

/**
 * Compose the home-level patch over `dsh-base`: the model and its route,
 * uncompressed Session logs, the Agent Team in place of the subagent tools,
 * and settlement over its board.
 * @param settings - the run's settings.
 * @param home - the run's Harness home.
 * @returns the `cordis.patch.yml` text.
 */
export function patchLayer(settings: RunSettings, home: string): string {
  const disabled = ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents']
  return dump([
    { id: 'agent-default-model', config: { provider: settings.provider, model: settings.model, reasoningEffort: settings.effort } },
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          [settings.provider]: {
            apiKeyEnv: settings.apiKeyEnv,
            ...settings.route,
            models: [{ id: settings.model, ...settings.modelSpec }],
          },
        },
      },
    },
    // Uncompressed logs, so the analysis and anyone opening the artifact read them as plain JSON lines.
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    ...disabled.map(id => ({ id, disabled: true })),
    {
      insert: [
        {
          id: 'agent-team',
          name: '@deepseek-ai/dsh-experimental-agent-team',
          config: { trackSubagentRuns: true, artifactRoot: join(home, 'sessions', 'team-artifacts') },
        },
        {
          id: 'tool-agent-team',
          name: '@deepseek-ai/dsh-experimental-tool-agent-team',
          config: { freshProvider: 'spawn', forkProvider: 'fork' },
        },
        {
          id: 'agent-team-settlement',
          name: '@deepseek-ai/dsh-experimental-agent-team-settlement',
          config: { deadlineMs: settings.deadlineMs, stallMs: 120_000 },
        },
      ],
    },
  ], { lineWidth: -1 })
}

function revision(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

/**
 * Run one case once and leave everything under `out`.
 * @param standardCase - the case to run.
 * @param out - absolute output directory; created when missing.
 * @returns the run record also written to `run.json`.
 * @throws Error when the configured key variable is unset.
 */
export async function runCase(standardCase: StandardCase, out: string): Promise<RunRecord> {
  const settings = resolveSettings(process.env)
  if ((process.env[settings.apiKeyEnv] ?? '') === '') throw new Error(`${settings.apiKeyEnv} is not set`)
  const workspace = join(out, 'workspace')
  const home = join(out, 'dsh-home')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(home, 'tmp'), { recursive: true })
  standardCase.prepare(workspace)
  writeFileSync(join(home, 'cordis.patch.yml'), patchLayer(settings, home))
  const task = standardCase.task()

  const startedAt = new Date()
  // The outer limit only ends a run whose own settlement deadline did not.
  const limitMs = settings.deadlineMs + 180_000
  const child = spawn(process.execPath, [
    '--import', fileURLToPath(import.meta.resolve('tsx/esm')),
    join(root, 'apps/cli/src/bin.ts'), '--profile', 'headless', '--json', task,
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'danger-full-access',
      TMPDIR: join(home, 'tmp'),
      // tsx reads the path mapping from the cwd, which is the workspace here.
      TSX_TSCONFIG_PATH: join(root, 'tsconfig.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(createWriteStream(join(out, 'stdout.jsonl')))
  child.stderr.pipe(createWriteStream(join(out, 'stderr.log')))
  child.stderr.pipe(process.stderr)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGINT')
  }, limitMs)
  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) => {
    child.on('close', (code, closeSignal) => { done([code, closeSignal]) })
  })
  clearTimeout(timer)
  const record: RunRecord = {
    case: standardCase.name,
    settings,
    revision: revision(),
    exitCode,
    signal,
    timedOut,
    startedAt: startedAt.toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
  }
  writeFileSync(join(out, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
  return record
}
