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
 * `STANDARD_CASE_MODEL_SPEC` (JSON). The time limit is the case's own.
 *
 * `run.json` names the code and the tools the run used. A wrapper that runs
 * the cases from a copy of the checkout, as `in-orfs.sh` does, states the
 * checkout's revision in `STANDARD_CASE_REVISION`, whether it had uncommitted
 * changes in `STANDARD_CASE_DIRTY` (`1` or `0`), and what it ran in, such as
 * the image, in `STANDARD_CASE_ENVIRONMENT`.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { dump } from 'js-yaml'
import type { RequiredTool, StandardCase } from './case.ts'

const root = resolve(import.meta.dirname, '../..')

/** What one standard-case run is configured with; recorded in `run.json` without the key. */
export interface RunSettings {
  readonly provider: string
  readonly model: string
  readonly effort: string
  readonly apiKeyEnv: string
  readonly route: Record<string, unknown>
  readonly modelSpec: Record<string, unknown>
}

/** What `run.json` records about a finished run. */
export interface RunRecord {
  readonly case: string
  readonly settings: RunSettings
  /** Whether the revision ships `agent-team-settlement`, which the run then mounts. */
  readonly settlement: boolean
  /** The commit of the dsh checkout the run executed. */
  readonly revision: string
  /** Whether that checkout had uncommitted changes, so the commit alone does not name the code. */
  readonly dirty: boolean
  /** What the run executed in beyond the host, as its wrapper stated it; undefined for a run started directly. */
  readonly environment: string | undefined
  /** The version each tool reported: Node, then the case's required tools. */
  readonly tools: Record<string, string>
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

/** How long a run stopped at its time limit has to exit before it is killed. */
const KILL_AFTER_MS = 120_000

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
  return {
    provider: set(env, 'STANDARD_CASE_PROVIDER') ?? 'openrouter',
    model: MODEL,
    effort: EFFORT,
    apiKeyEnv: set(env, 'STANDARD_CASE_API_KEY_ENV') ?? 'OPENROUTER_API_KEY',
    route: jsonEnv(env, 'STANDARD_CASE_ROUTE', DEFAULT_ROUTE),
    modelSpec: jsonEnv(env, 'STANDARD_CASE_MODEL_SPEC', DEFAULT_MODEL_SPEC),
  }
}

/**
 * Whether this checkout ships the settlement plugin. A revision without it
 * still runs the case; the run then ends with the Lead's turn.
 * @returns true when the package's manifest exists.
 */
export function shipsSettlement(): boolean {
  return existsSync(join(root, 'packages/experimental/agent-team-settlement/package.json'))
}

/**
 * Compose the home-level patch over `dsh-base`: the model and its route,
 * uncompressed Session logs, the Agent Team in place of the subagent tools,
 * and, when the revision ships it, settlement over the Team's board.
 * @param settings - the run's settings.
 * @param home - the run's Harness home.
 * @param settlement - the settlement deadline in milliseconds, or undefined to leave `agent-team-settlement` unmounted.
 * @returns the `cordis.patch.yml` text.
 */
export function patchLayer(settings: RunSettings, home: string, settlement: number | undefined): string {
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
    // Uncompressed logs, so the analysis and anyone opening the run directory read them as plain JSON lines.
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    ...disabled.map(id => ({ id, disabled: true })),
    {
      insert: [
        {
          id: 'agent-team',
          name: '@deepseek-ai/dsh-experimental-agent-team',
          ...settlement === undefined ? {} : { config: { trackSubagentRuns: true } },
        },
        {
          id: 'tool-agent-team',
          name: '@deepseek-ai/dsh-experimental-tool-agent-team',
          config: { freshProvider: 'spawn', forkProvider: 'fork' },
        },
        ...settlement !== undefined
          ? [{
            id: 'agent-team-settlement',
            name: '@deepseek-ai/dsh-experimental-agent-team-settlement',
            config: { deadlineMs: settlement, stallMs: 120_000 },
          }]
          : [],
      ],
    },
  ], { lineWidth: -1 })
}

function set(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // An empty variable counts as unset.
  return (env[name] ?? '').trim() === '' ? undefined : env[name]
}

/**
 * Name the code a run executes: what its wrapper stated, otherwise what git reports for this checkout.
 * @param env - the process environment.
 * @returns the commit and whether the checkout had uncommitted changes.
 * @throws Error when `STANDARD_CASE_REVISION` is set and `STANDARD_CASE_DIRTY` is not `1` or `0`.
 */
export function resolveRevision(env: NodeJS.ProcessEnv): { revision: string; dirty: boolean } {
  const stated = set(env, 'STANDARD_CASE_REVISION')
  if (stated === undefined) {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    return { revision: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '' }
  }
  const dirty = env.STANDARD_CASE_DIRTY
  if (dirty !== '1' && dirty !== '0') throw new Error('STANDARD_CASE_DIRTY must be 1 or 0 when STANDARD_CASE_REVISION is set')
  return { revision: stated, dirty: dirty === '1' }
}

/**
 * Ask Node and each required tool for its version.
 * @param tools - the case's required tools.
 * @returns the first line each one printed, by command; `unknown` for one that printed nothing.
 */
export function toolVersions(tools: readonly RequiredTool[]): Record<string, string> {
  const versions: Record<string, string> = { node: process.version }
  for (const { command, versionArgs } of tools) {
    const result = spawnSync(command, versionArgs, { encoding: 'utf8', timeout: 60_000 })
    // A command that could not be started leaves both streams null.
    const printed = [result.stdout, result.stderr].filter((stream): stream is string => typeof stream === 'string').join('')
    versions[command] = printed.trim().split('\n')[0] || 'unknown'
  }
  return versions
}

/**
 * Run one case once and leave everything under `out`.
 * @param standardCase - the case to run.
 * @param out - absolute output directory; created when missing.
 * @returns the run record also written to `run.json`.
 * @throws Error when the configured key variable is unset, or when `out` already holds files, which the analysis would read as this run's.
 */
export async function runCase(standardCase: StandardCase, out: string): Promise<RunRecord> {
  const settings = resolveSettings(process.env)
  if ((process.env[settings.apiKeyEnv] ?? '') === '') throw new Error(`${settings.apiKeyEnv} is not set`)
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty; choose a new --out, or pass --analyze to analyze the run it holds`)
  const code = resolveRevision(process.env)
  const tools = toolVersions(standardCase.requiredTools)
  const workspace = join(out, 'workspace')
  const home = join(out, 'dsh-home')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(home, 'tmp'), { recursive: true })
  standardCase.prepare(workspace)
  const settlement = shipsSettlement()
  writeFileSync(join(home, 'cordis.patch.yml'), patchLayer(settings, home, settlement ? standardCase.timeLimitMs : undefined))
  const task = standardCase.task()

  const startedAt = new Date()
  // The outer limit ends a run that its own settlement deadline did not, or that has none.
  const limitMs = standardCase.timeLimitMs + 180_000
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
  const stdout = child.stdout.pipe(createWriteStream(join(out, 'stdout.jsonl')))
  const stderr = child.stderr.pipe(createWriteStream(join(out, 'stderr.log')))
  child.stderr.pipe(process.stderr)
  let timedOut = false
  // SIGINT lets dsh flush its Session logs; a run that ignores it is killed after the grace period.
  let killer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGINT')
    killer = setTimeout(() => { child.kill('SIGKILL') }, KILL_AFTER_MS)
  }, limitMs)
  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) => {
    child.on('close', (code, closeSignal) => { done([code, closeSignal]) })
  })
  clearTimeout(timer)
  clearTimeout(killer)
  // The analysis reads both files next; the child closing does not mean they reached the disk.
  await Promise.all([finished(stdout), finished(stderr)])
  const record: RunRecord = {
    case: standardCase.name,
    settings,
    settlement,
    ...code,
    environment: set(process.env, 'STANDARD_CASE_ENVIRONMENT'),
    tools,
    exitCode,
    signal,
    timedOut,
    startedAt: startedAt.toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
  }
  writeFileSync(join(out, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
  return record
}
