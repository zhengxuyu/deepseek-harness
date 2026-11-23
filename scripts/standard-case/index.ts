/**
 * The one command that runs and analyzes the standard cases:
 *
 *   pnpm run standard-case                     run every case, then analyze each
 *   pnpm run standard-case <case>...           run only the named cases
 *   pnpm run standard-case --cadence default   run only the cases of that cadence
 *   pnpm run standard-case --list              print the cases and exit
 *   pnpm run standard-case --out <dir>         choose the output directory
 *   pnpm run standard-case --run-only --out <dir>  run without analyzing
 *   pnpm run standard-case --analyze --out <dir>   analyze existing runs, again or for the first time
 *   pnpm run standard-case --strict            exit 1 unless every scored rubric item passed
 *
 * The output directory defaults to `~/dsh-standard-case/<UTC timestamp>`.
 * A run's directory must be outside this checkout: the workspace is the
 * agents' cwd, and inside the checkout dsh would read the repository's own
 * instruction files and git state. It holds one directory per case: the workspace, the Harness home with
 * every Session log, `stdout.jsonl`, `stderr.log`, `run.json`,
 * `analysis.json`, and `summary.md`. Each summary is printed. `case.ts` says
 * how to add a case.
 *
 * A maintainer starts every run by hand; no CI workflow runs the cases.
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { analyze, renderSummary } from './analyze.ts'
import { cases } from './cases/index.ts'
import { runCase } from './run.ts'

const root = resolve(import.meta.dirname, '../..')

function onPath(command: string): boolean {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' }).status === 0
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      list: { type: 'boolean', default: false },
      analyze: { type: 'boolean', default: false },
      'run-only': { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      out: { type: 'string' },
      cadence: { type: 'string' },
    },
  })
  if (values.list) {
    for (const standardCase of cases) console.log(`${standardCase.name}\t${standardCase.cadence}\t${standardCase.description}`)
    return 0
  }
  const unknown = positionals.filter(name => !cases.some(standardCase => standardCase.name === name))
  if (unknown.length > 0) throw new Error(`unknown case(s): ${unknown.join(', ')}; --list prints the cases`)
  if (values.analyze && values.out === undefined) throw new Error('--analyze needs --out <dir>, the directory of the runs to analyze')
  if (values.analyze && values['run-only']) throw new Error('--analyze and --run-only exclude each other')
  if (values.cadence !== undefined && values.cadence !== 'default' && values.cadence !== 'named') throw new Error('--cadence takes default or named')
  const selected = cases.filter(standardCase =>
    (positionals.length === 0 || positionals.includes(standardCase.name))
    && (values.cadence === undefined || standardCase.cadence === values.cadence))
  for (const standardCase of selected) {
    const missing = standardCase.requiredTools.map(tool => tool.command).filter(command => !onPath(command))
    if (missing.length > 0) throw new Error(`${standardCase.name} needs ${missing.join(', ')} on PATH: ${standardCase.toolsHint}`)
  }
  const stamp = new Date().toISOString().replaceAll(/[-:]|\.\d+/gu, '')
  // pnpm runs the script from the repository root; a relative directory is relative to where it was invoked.
  const out = resolve(process.env.INIT_CWD ?? process.cwd(), values.out ?? join(homedir(), 'dsh-standard-case', stamp))
  const fromRoot = relative(root, out)
  const outside = fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
  if (!values.analyze && !outside) throw new Error(`${out} is inside this checkout; choose an --out outside it`)
  let failed = 0
  for (const standardCase of selected) {
    const directory = join(out, standardCase.name)
    if (!values.analyze) {
      console.error(`standard-case: running ${standardCase.name}`)
      const record = await runCase(standardCase, directory)
      console.error(`standard-case: ${standardCase.name}: dsh exited ${record.exitCode ?? record.signal} after ${Math.round(record.elapsedMs / 1000)} s`)
    }
    if (values['run-only']) continue
    const analysis = analyze(standardCase, directory)
    const summary = renderSummary(analysis)
    writeFileSync(join(directory, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`)
    writeFileSync(join(directory, 'summary.md'), summary)
    console.log(summary)
    if (analysis.score.passed < analysis.score.total) failed += 1
  }
  console.error(`standard-case: results in ${out}`)
  return values.strict && failed > 0 ? 1 : 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error: unknown) {
  console.error(`standard-case: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
