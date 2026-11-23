/**
 * Case `rtl-to-layout`: one design taken through the whole digital flow, from
 * RTL coding and functional verification through logic synthesis to placement
 * and routing on the Nangate45 platform of the OpenROAD flow. The design is
 * problem `multi_pipe_8bit` of the RTLLM benchmark, as published in the
 * Hugging Face dataset `observerw/RTLLM` (revision 36a90436b38a). `spec.md`
 * is its specification and `judge/dataset/` its testbench and reference
 * implementation, all unchanged apart from trailing whitespace. The run is
 * given only the specification; `case.ts` says where the rest is hidden from it.
 *
 * Every stage is judged by running the tools again on what the run left, not
 * by reading the run's own logs or reports. Function is judged with
 * `judge/judge_tb.v`, which samples away from clock edges and assumes no
 * latency. The dataset's testbench changes inputs on clock edges, so its
 * verdict depends on simulator event order; it is reported for the RTL only
 * and left out of the score.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StandardCase } from '../../case.ts'
import type { RequiredTool, RubricItem, TeamExpectations } from '../../case.ts'

const TOP = 'multi_pipe_8bit'
const DATASET_PASSED = 'Your Design Passed'
const JUDGE_PASSED = 'JUDGE passed'

/** The outcome of one tool invocation: whether it exited 0, and its combined output. */
interface ToolRun {
  readonly ok: boolean
  readonly output: string
}

function tool(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): ToolRun {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 })
  const output = `${result.stdout}${result.stderr}${result.error === undefined ? '' : `\n${result.error.message}`}`
  return { ok: result.status === 0, output }
}

function lastLines(output: string, lines = 3): string {
  return output.trim().split('\n').slice(-lines).join(' / ').slice(0, 400)
}

/** The rtl-to-layout case; see the module comment. */
export class RtlToLayoutCase extends StandardCase {
  readonly name = 'rtl-to-layout'
  readonly description = 'A pipelined 8-bit multiplier from RTLLM is taken from RTL through verification and synthesis to a routed Nangate45 layout, one stage per member.'
  protected readonly directory = import.meta.dirname
  readonly expectations: TeamExpectations = { minTeammates: 2, minTeammatesCompletingTasks: 2 }
  readonly cadence = 'named'
  readonly timeLimitMs = 3_600_000
  readonly requiredTools: readonly RequiredTool[] = [
    { command: 'iverilog', versionArgs: ['-V'] },
    { command: 'vvp', versionArgs: ['-V'] },
    { command: 'yosys', versionArgs: ['-V'] },
    { command: 'openroad', versionArgs: ['-version'] },
  ]
  readonly toolsHint = 'run inside the openroad/orfs image with iverilog installed and FLOW_HOME set; see scripts/standard-case/in-orfs.sh'

  /** The flow's home, which holds the platform files the judgment reads. */
  private flowHome(): string {
    return process.env.FLOW_HOME ?? '/OpenROAD-flow-scripts/flow'
  }

  private liberty(): string {
    return join(this.flowHome(), 'platforms/nangate45/lib/NangateOpenCellLibrary_typical.lib')
  }

  prepare(workspace: string): void {
    mkdirSync(join(workspace, 'spec'), { recursive: true })
    cpSync(join(this.directory, 'spec.md'), join(workspace, 'spec', `${TOP}.md`))
  }

  judgeOutputs(workspace: string): RubricItem[] {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-rtl-to-layout-'))
    try {
      return [
        ...this.judgeRtl(workspace, scratch),
        this.judgeTestbench(workspace, scratch),
        ...this.judgeNetlist(workspace, scratch),
        ...this.judgeLayout(workspace, scratch),
        this.judgeSummary(workspace),
      ]
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /** Simulate a design under one testbench and look for the line that testbench prints on success. */
  private simulate(testbench: string, design: string, marker: string, scratch: string, label: string): ToolRun {
    const binary = join(scratch, `${label}.vvp`)
    const compiled = tool('iverilog', ['-g2012', '-o', binary, this.judgeFile(testbench), design], scratch)
    if (!compiled.ok) return { ok: false, output: `does not compile: ${lastLines(compiled.output)}` }
    const simulated = tool('vvp', [binary], scratch)
    return simulated.output.includes(marker)
      ? { ok: true, output: 'passes' }
      : { ok: false, output: `fails: ${lastLines(simulated.output.split('\n').filter(line => line.includes('JUDGE') || line.includes('Failed') || line.includes('==')).join('\n') || simulated.output)}` }
  }

  private judgeRtl(workspace: string, scratch: string): RubricItem[] {
    const functional = `rtl/${TOP}.v multiplies correctly under the case's testbench`
    const dataset = `rtl/${TOP}.v passes the dataset's own testbench`
    const rtl = join(workspace, `rtl/${TOP}.v`)
    if (!existsSync(rtl)) {
      return [
        { id: 'rtl', criterion: functional, passed: false, detail: `rtl/${TOP}.v is missing` },
        { id: 'rtl-dataset', criterion: dataset, passed: false, detail: `rtl/${TOP}.v is missing`, informational: true },
      ]
    }
    const own = this.simulate('judge_tb.v', rtl, JUDGE_PASSED, scratch, 'rtl')
    const theirs = this.simulate('dataset/testbench.v', rtl, DATASET_PASSED, scratch, 'rtl-dataset')
    return [
      { id: 'rtl', criterion: functional, passed: own.ok, detail: own.output },
      { id: 'rtl-dataset', criterion: dataset, passed: theirs.ok, detail: theirs.output, informational: true },
    ]
  }

  private judgeTestbench(workspace: string, scratch: string): RubricItem {
    const criterion = 'verification/tb.v passes on the run\'s RTL and exits non-zero on a design whose product is off by one'
    const testbench = join(workspace, 'verification/tb.v')
    const rtl = join(workspace, `rtl/${TOP}.v`)
    if (!existsSync(testbench)) return { id: 'testbench', criterion, passed: false, detail: 'verification/tb.v is missing' }
    if (!existsSync(rtl)) return { id: 'testbench', criterion, passed: false, detail: `rtl/${TOP}.v is missing, so there is nothing to run it on` }
    const run = (design: string, label: string): ToolRun => {
      const binary = join(scratch, `${label}.vvp`)
      const compiled = tool('iverilog', ['-g2012', '-o', binary, testbench, design], scratch)
      return compiled.ok ? tool('vvp', [binary], scratch) : { ok: false, output: `does not compile: ${lastLines(compiled.output)}` }
    }
    const good = run(rtl, 'tb-good')
    if (!good.ok) return { id: 'testbench', criterion, passed: false, detail: `it fails on the run's own RTL: ${lastLines(good.output)}` }
    const bad = run(this.judgeFile('broken.v'), 'tb-bad')
    return bad.ok
      ? { id: 'testbench', criterion, passed: false, detail: 'it exits 0 on a design whose product is off by one, so it checks nothing' }
      : { id: 'testbench', criterion, passed: true, detail: 'passes on the run\'s RTL and rejects the wrong design' }
  }

  private judgeNetlist(workspace: string, scratch: string): RubricItem[] {
    const mapped = 'synthesis/netlist.v contains only Nangate45 standard cells, with flip-flops'
    const equivalent = 'synthesis/netlist.v multiplies correctly in gate-level simulation under the case\'s testbench'
    const netlist = join(workspace, 'synthesis/netlist.v')
    if (!existsSync(netlist)) {
      return [
        { id: 'netlist-cells', criterion: mapped, passed: false, detail: 'synthesis/netlist.v is missing' },
        { id: 'netlist-function', criterion: equivalent, passed: false, detail: 'synthesis/netlist.v is missing' },
      ]
    }
    const cells = tool('yosys', ['-q', '-p', [
      `read_liberty -lib ${this.liberty()}`,
      `read_verilog ${netlist}`,
      `hierarchy -check -top ${TOP}`,
      'select -assert-none t:$*',
      'select -assert-min 16 t:DFF*',
    ].join('; ')], scratch)
    const gateRun = this.simulateGates(netlist, scratch, 'gates')
    return [
      { id: 'netlist-cells', criterion: mapped, passed: cells.ok, detail: cells.ok ? 'only library cells, at least 16 flip-flops' : lastLines(cells.output) },
      { id: 'netlist-function', criterion: equivalent, passed: gateRun.ok, detail: gateRun.output },
    ]
  }

  /** Simulate a gate-level netlist under the case's testbench, with cell behavior taken from the library. */
  private simulateGates(netlist: string, scratch: string, label: string): ToolRun {
    const simulatable = join(scratch, `${label}.v`)
    const converted = tool('yosys', ['-q', '-p', [
      // Clock-gate and filler cells carry no function; the design's logic does not go through them.
      `read_liberty -ignore_miss_func ${this.liberty()}`,
      `read_verilog ${netlist}`,
      `hierarchy -check -top ${TOP}`,
      'proc', 'flatten', 'opt_clean',
      `write_verilog -noattr ${simulatable}`,
    ].join('; ')], scratch)
    return converted.ok
      ? this.simulate('judge_tb.v', simulatable, JUDGE_PASSED, scratch, label)
      : { ok: false, output: `yosys cannot read it against the library: ${lastLines(converted.output)}` }
  }

  private judgeLayout(workspace: string, scratch: string): RubricItem[] {
    const criteria = {
      'layout-placed': 'layout/final.odb holds the top module with every instance legally placed',
      'layout-routed': 'layout/final.odb has every signal net routed',
      'layout-timing': 'layout/final.odb meets setup timing at the 2.0 ns clock',
      'layout-function': 'the netlist read back from layout/final.odb multiplies correctly in gate-level simulation',
    }
    const failAll = (detail: string): RubricItem[] =>
      Object.entries(criteria).map(([id, criterion]) => ({ id, criterion, passed: false, detail }))
    const odb = join(workspace, 'layout/final.odb')
    if (!existsSync(odb)) return failAll('layout/final.odb is missing')
    const run = tool('openroad', ['-no_init', '-exit', this.judgeFile('judge.tcl')], workspace, {
      ...process.env,
      JUDGE_ODB: odb,
      JUDGE_LIB: this.liberty(),
      JUDGE_SDC: this.judgeFile('judge.sdc'),
      JUDGE_RC: join(this.flowHome(), 'platforms/nangate45/setRC.tcl'),
      JUDGE_NETLIST: join(scratch, 'layout-netlist.v'),
    })
    const facts = new Map(run.output.split('\n').flatMap((line) => {
      const [, key, value] = /^JUDGE (\S+) (.*)$/u.exec(line.trim()) ?? []
      return key === undefined || value === undefined ? [] : [[key, value] as const]
    }))
    const number = (key: string): number => Number(facts.get(key) ?? Number.NaN)
    if (!facts.has('top')) return failAll(`openroad cannot read it: ${lastLines(run.output)}`)
    const placed = facts.get('top') === TOP && number('instances') > 0 && number('unplaced') === 0 && number('placement_legal') === 1
    const routed = number('signal_nets') > 0 && number('unrouted') === 0
    const slack = number('worst_slack_ns')
    // The layout is judged for function too, so a routed design that is not this multiplier does not pass.
    const routedFunction = existsSync(join(scratch, 'layout-netlist.v'))
      ? this.simulateGates(join(scratch, 'layout-netlist.v'), scratch, 'layout-gates')
      : { ok: false, output: `openroad wrote no netlist from it: ${lastLines(run.output)}` }
    return [
      {
        id: 'layout-placed',
        criterion: criteria['layout-placed'],
        passed: placed,
        detail: `top ${facts.get('top')}, ${facts.get('instances') ?? '?'} instance(s), ${facts.get('unplaced') ?? '?'} unplaced, placement ${number('placement_legal') === 1 ? 'legal' : 'not legal'}`,
      },
      {
        id: 'layout-routed',
        criterion: criteria['layout-routed'],
        passed: routed,
        detail: `${facts.get('signal_nets') ?? '?'} signal net(s), ${facts.get('unrouted') ?? '?'} without a routed wire`,
      },
      {
        id: 'layout-timing',
        criterion: criteria['layout-timing'],
        passed: Number.isFinite(slack) && slack >= 0,
        detail: Number.isFinite(slack) ? `worst setup slack ${slack.toFixed(3)} ns with placement-estimated parasitics` : `no slack reported: ${lastLines(run.output)}`,
      },
      { id: 'layout-function', criterion: criteria['layout-function'], passed: routedFunction.ok, detail: routedFunction.output },
    ]
  }

  private judgeSummary(workspace: string): RubricItem {
    const criterion = 'reports/summary.json states cell_count, area_um2, worst_slack_ns, and drc_violations as numbers, with no DRC violation'
    const path = join(workspace, 'reports/summary.json')
    if (!existsSync(path)) return { id: 'summary', criterion, passed: false, detail: 'reports/summary.json is missing' }
    let summary: unknown
    try {
      summary = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error: unknown) {
      return { id: 'summary', criterion, passed: false, detail: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
    const fields: Record<string, unknown> = typeof summary === 'object' && summary !== null && !Array.isArray(summary) ? { ...summary } : {}
    const keys = ['cell_count', 'area_um2', 'worst_slack_ns', 'drc_violations']
    const missing = keys.filter(key => typeof fields[key] !== 'number')
    const passed = missing.length === 0 && fields.drc_violations === 0
    return {
      id: 'summary',
      criterion,
      passed,
      detail: missing.length > 0 ? `not numbers: ${missing.join(', ')}` : keys.map(key => `${key}=${String(fields[key])}`).join(', '),
    }
  }
}
