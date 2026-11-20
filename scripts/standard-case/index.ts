/**
 * The one command that runs and analyzes the Agent Team standard case:
 *
 *   pnpm run standard-case [out-dir]            run, then analyze
 *   pnpm run standard-case --analyze <out-dir>  analyze an existing run again
 *
 * The output directory defaults to `.artifacts/standard-case/<UTC timestamp>`.
 * It receives the workspace, the Harness home with every Session log,
 * `stdout.jsonl`, `stderr.log`, `run.json`, `analysis.json`, and `summary.md`.
 * The summary is printed, and appended to `GITHUB_STEP_SUMMARY` when set.
 * `--strict` exits 1 unless every rubric item passed.
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { analyze, renderSummary } from './analyze.ts'
import { runCase } from './run.ts'

const root = resolve(import.meta.dirname, '../..')

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter(arg => arg.startsWith('--')))
  const [outArg] = argv.filter(arg => !arg.startsWith('--'))
  const unknown = [...flags].filter(flag => flag !== '--analyze' && flag !== '--strict')
  if (unknown.length > 0 || (flags.has('--analyze') && outArg === undefined)) {
    console.error('usage: pnpm run standard-case [--strict] [out-dir] | --analyze [--strict] <out-dir>')
    return 2
  }
  const stamp = new Date().toISOString().replaceAll(/[-:]|\.\d+/gu, '')
  // pnpm runs the script from the repository root; a relative directory is relative to where it was invoked.
  const out = resolve(process.env.INIT_CWD ?? process.cwd(), outArg ?? join(root, '.artifacts/standard-case', stamp))
  if (!flags.has('--analyze')) {
    const record = await runCase(out)
    console.error(`standard-case: dsh exited ${record.exitCode ?? record.signal} after ${Math.round(record.elapsedMs / 1000)} s`)
  }
  const analysis = analyze(out)
  const summary = renderSummary(analysis)
  writeFileSync(join(out, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`)
  writeFileSync(join(out, 'summary.md'), summary)
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
  console.error(`standard-case: results in ${out}`)
  return flags.has('--strict') && analysis.score.passed < analysis.score.total ? 1 : 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error: unknown) {
  console.error(`standard-case: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
