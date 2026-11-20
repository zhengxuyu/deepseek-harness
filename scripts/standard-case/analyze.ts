/**
 * Analyze one finished standard-case run from what it left on disk: the
 * Session logs of the Lead and every teammate, the workspace, stderr, and
 * `run.json`. The analysis has three parts: measurements of the trajectory,
 * a timeline of the Team's events, and a rubric that judges the result and
 * the way the Team worked.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expectedRegionTotals, expectedTopCustomers } from './fixture.ts'
import type { RunRecord } from './run.ts'

/** One event of a Session log, as far as the analysis reads it. */
export interface LogEvent {
  readonly type: string
  readonly time: number
  readonly data: Record<string, unknown>
}

/** One Session log read from disk. */
export interface SessionLog {
  readonly id: string
  readonly events: readonly LogEvent[]
}

/** What one agent did, measured from its own log. */
export interface AgentMeasure {
  readonly id: string
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly turns: number
  readonly turnEnds: string[]
  readonly modelRequests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly toolCalls: Record<string, number>
  readonly toolErrors: number
}

/** The final state of one task on the Team board. */
export interface TaskOutcome {
  readonly id: string
  readonly subject: string
  readonly status: string
  readonly owner: string | undefined
  readonly lostCause: string | undefined
  readonly revisions: number
}

/** One line of the Team timeline. */
export interface TimelineEntry {
  readonly atSeconds: number
  readonly text: string
}

/** One judged criterion. */
export interface RubricItem {
  readonly id: string
  readonly criterion: string
  readonly passed: boolean
  readonly detail: string
}

/** The whole analysis of one run. */
export interface Analysis {
  readonly run: RunRecord | undefined
  readonly unsettled: string[]
  readonly agents: AgentMeasure[]
  readonly tasks: TaskOutcome[]
  readonly timeline: TimelineEntry[]
  readonly rubric: RubricItem[]
  readonly score: { readonly passed: number; readonly total: number }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Parse one Session log's text into its identity and events.
 * @param source - newline-delimited JSON: one header line, then events.
 * @returns the log, or undefined when the text carries no Session header.
 */
export function parseSessionLog(source: string): SessionLog | undefined {
  let id: string | undefined
  const events: LogEvent[] = []
  for (const line of source.split('\n')) {
    if (line.trim() === '') continue
    const row = record(JSON.parse(line))
    if (row.type === 'session' && id === undefined) {
      id = text(row.id)
      continue
    }
    const type = text(row.type)
    if (type !== undefined) events.push({ type, time: count(row.time), data: record(row.data) })
  }
  return id === undefined ? undefined : { id, events }
}

/**
 * Read every uncompressed Session log below a Harness home; `run.ts` configures the run to write them so.
 * @param home - the run's Harness home.
 * @returns the logs found, in directory order.
 */
export function readSessionLogs(home: string): SessionLog[] {
  const logs: SessionLog[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
      } else if (/^session\.v\d+\.jsonl$/u.test(entry)) {
        const log = parseSessionLog(readFileSync(path, 'utf8'))
        if (log !== undefined) logs.push(log)
      }
    }
  }
  const sessions = join(home, 'sessions')
  if (existsSync(sessions)) walk(sessions)
  return logs
}

function measure(log: SessionLog, name: string, role: AgentMeasure['role']): AgentMeasure {
  const toolCalls: Record<string, number> = {}
  const turnEnds: string[] = []
  let modelRequests = 0
  let inputTokens = 0
  let outputTokens = 0
  let toolErrors = 0
  for (const event of log.events) {
    if (event.type === 'assistant/message') {
      modelRequests += 1
      const usage = record(event.data.usage)
      inputTokens += count(usage.inputTokens)
      outputTokens += count(usage.outputTokens)
    } else if (event.type === 'tool/call') {
      const tool = text(event.data.name) ?? 'unknown'
      toolCalls[tool] = (toolCalls[tool] ?? 0) + 1
    } else if (event.type === 'tool/result') {
      const content = record(event.data.message).content
      if (Array.isArray(content) && content.some(block => record(block).isError === true)) toolErrors += 1
    } else if (event.type === 'turn/end') {
      turnEnds.push(text(record(event.data.reason).kind) ?? 'unknown')
    }
  }
  return { id: log.id, name, role, turns: turnEnds.length, turnEnds, modelRequests, inputTokens, outputTokens, toolCalls, toolErrors }
}

/** The Lead's log is the one that records the Team: its tasks and members. */
function leadOf(logs: readonly SessionLog[]): SessionLog | undefined {
  return logs.find(log => log.events.some(event => event.type === 'team/task' || event.type === 'team/member'))
}

/**
 * Fold the Lead log's Team events into members, final task states, and a timeline.
 * @param lead - the Lead's Session log.
 * @returns member names by Session id, each task's final state, and the ordered timeline.
 */
export function foldTeam(lead: SessionLog): { members: Map<string, string>; tasks: TaskOutcome[]; timeline: TimelineEntry[] } {
  const members = new Map<string, string>([[lead.id, 'lead']])
  const tasks = new Map<string, TaskOutcome>()
  const timeline: TimelineEntry[] = []
  const start = lead.events[0]?.time ?? 0
  const at = (event: LogEvent): number => Math.round((event.time - start) / 100) / 10
  const who = (id: string | undefined): string => id === undefined ? 'nobody' : members.get(id) ?? id
  for (const event of lead.events) {
    if (event.type === 'team/member') {
      const member = record(event.data.member)
      const id = text(member.id)
      const name = text(member.name)
      if (id === undefined || name === undefined) continue
      if (!members.has(id)) timeline.push({ atSeconds: at(event), text: `member ${name} joined` })
      members.set(id, name)
      if (member.phase === 'failed') timeline.push({ atSeconds: at(event), text: `member ${name} failed: ${text(member.error) ?? 'no reason recorded'}` })
    } else if (event.type === 'team/task') {
      const task = record(event.data.task)
      const id = text(task.id)
      const status = text(task.status)
      if (id === undefined || status === undefined) continue
      const previous = tasks.get(id)
      const owner = text(task.ownerId)
      const outcome: TaskOutcome = {
        id,
        subject: text(task.subject) ?? '',
        status,
        owner: owner === undefined ? undefined : who(owner),
        lostCause: text(task.lostCause),
        revisions: count(task.revision),
      }
      tasks.set(id, outcome)
      if (previous?.status !== status || previous.owner !== outcome.owner) {
        const cause = outcome.lostCause === undefined ? '' : ` (${outcome.lostCause})`
        timeline.push({ atSeconds: at(event), text: `${id} ${status}${cause}, owner ${outcome.owner ?? 'nobody'}: ${outcome.subject.slice(0, 80)}` })
      }
    } else if (event.type === 'team/message/queued') {
      const message = record(event.data.message)
      timeline.push({ atSeconds: at(event), text: `message ${who(text(message.senderId))} → ${who(text(message.targetId))}` })
    } else if (event.type === 'turn/end') {
      timeline.push({ atSeconds: at(event), text: `lead turn ended ${text(record(event.data.reason).kind) ?? 'unknown'}` })
    }
  }
  return { members, tasks: [...tasks.values()], timeline }
}

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

function sameAmount(left: unknown, right: number): boolean {
  const value = typeof left === 'string' ? Number(left) : left
  return typeof value === 'number' && Math.abs(value - right) < 0.005
}

/**
 * Judge the three files the task asks for against the fixture's results.
 * @param workspace - the run's workspace.
 * @returns one rubric item per file.
 */
export function judgeOutputs(workspace: string): RubricItem[] {
  const regions = expectedRegionTotals()
  const customers = expectedTopCustomers()
  const items: RubricItem[] = []

  const regionText = readText(join(workspace, 'out/region_totals.json'))
  let regionDetail = 'out/region_totals.json is missing'
  let regionPassed = false
  if (regionText !== undefined) {
    try {
      const actual = record(JSON.parse(regionText))
      const wrong = Object.entries(regions).filter(([region, total]) => !sameAmount(actual[region], total)).map(([region]) => region)
      const extra = Object.keys(actual).filter(region => !(region in regions))
      regionPassed = wrong.length === 0 && extra.length === 0
      regionDetail = regionPassed ? 'every region total matches' : `wrong or missing: ${wrong.join(', ') || 'none'}; unexpected keys: ${extra.join(', ') || 'none'}`
    } catch (error: unknown) {
      regionDetail = `not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  items.push({ id: 'region-totals', criterion: 'out/region_totals.json states the paid total of every region', passed: regionPassed, detail: regionDetail })

  const customerText = readText(join(workspace, 'out/top_customers.csv'))
  let customerDetail = 'out/top_customers.csv is missing'
  let customerPassed = false
  if (customerText !== undefined) {
    const [header, ...rows] = customerText.split('\n').map(line => line.trim()).filter(line => line !== '')
    const parsed = rows.map(row => row.split(',').map(cell => cell.trim()))
    customerPassed = header === 'customer,total' && parsed.length === customers.length
      && customers.every((expected, index) => parsed[index]?.[0] === expected.customer && sameAmount(parsed[index][1], expected.total))
    customerDetail = customerPassed ? 'header and all three rows match, in order' : `got header "${header ?? ''}" and rows ${JSON.stringify(parsed)}`
  }
  items.push({ id: 'top-customers', criterion: 'out/top_customers.csv lists the three highest-paying customers in order', passed: customerPassed, detail: customerDetail })

  const report = readText(join(workspace, 'out/report.md'))
  const topRegion = Object.entries(regions).toSorted((left, right) => right[1] - left[1]).slice(0, 1)
  const needed = [
    ...topRegion.flatMap(([region, total]) => [region, total.toFixed(2)]),
    ...customers.slice(0, 1).flatMap(top => [top.customer, top.total.toFixed(2)]),
  ]
  const missing = report === undefined ? needed : needed.filter(piece => !report.includes(piece))
  items.push({
    id: 'report',
    criterion: 'out/report.md names the top region and the top customer with their totals',
    passed: report !== undefined && missing.length === 0,
    detail: report === undefined ? 'out/report.md is missing' : missing.length === 0 ? 'all four facts are quoted' : `does not contain: ${missing.join(', ')}`,
  })
  return items
}

/**
 * Judge how the Team worked, from the board's final state and the agents' measures.
 * @param run - the run record, when one was written.
 * @param unsettled - the rows the runner printed as unsettled.
 * @param agents - every agent's measures.
 * @param tasks - every task's final state.
 * @returns the rubric items about the trajectory.
 */
export function judgeTrajectory(
  run: RunRecord | undefined,
  unsettled: readonly string[],
  agents: readonly AgentMeasure[],
  tasks: readonly TaskOutcome[],
): RubricItem[] {
  const lead = agents.find(agent => agent.role === 'lead')
  const teammates = agents.filter(agent => agent.role === 'teammate')
  const live = tasks.filter(task => task.status !== 'deleted')
  const open = live.filter(task => task.status !== 'completed')
  const teammateOwners = new Set(live.filter(task => task.status === 'completed' && task.owner !== undefined && task.owner !== 'lead').map(task => task.owner))
  const idle = teammates.filter(agent => agent.modelRequests === 0).map(agent => agent.name)
  return [
    {
      id: 'exit',
      criterion: 'dsh exited 0 with nothing unsettled',
      passed: run?.exitCode === 0 && unsettled.length === 0,
      detail: `exit ${run?.exitCode ?? 'unknown'}${run?.timedOut === true ? ' (stopped by the outer time limit)' : ''}, ${unsettled.length} unsettled row(s)`,
    },
    {
      id: 'lead-turn',
      criterion: 'the Lead\'s last turn completed',
      passed: lead?.turnEnds.at(-1) === 'completed',
      detail: lead === undefined ? 'no Lead log found' : `turn ends: ${lead.turnEnds.join(', ') || 'none'}`,
    },
    {
      id: 'teammates',
      criterion: 'at least two teammates were spawned and each made a model request',
      passed: teammates.length >= 2 && idle.length === 0,
      detail: `${teammates.length} teammate(s): ${teammates.map(agent => agent.name).join(', ') || 'none'}${idle.length === 0 ? '' : `; never ran: ${idle.join(', ')}`}`,
    },
    {
      id: 'division',
      criterion: 'two different teammates each completed a task',
      passed: teammateOwners.size >= 2,
      detail: `completed tasks are owned by: ${live.filter(task => task.status === 'completed').map(task => `${task.id}=${task.owner ?? 'nobody'}`).join(', ') || 'none'}`,
    },
    {
      id: 'board',
      criterion: 'every task on the board ended completed, none lost',
      passed: live.length > 0 && open.length === 0,
      detail: live.length === 0 ? 'the board recorded no task' : open.length === 0 ? `${live.length} task(s), all completed` : open.map(task => `${task.id} is ${task.status}${task.lostCause === undefined ? '' : ` (${task.lostCause})`}`).join('; '),
    },
  ]
}

/**
 * Analyze one run directory written by `run.ts`.
 * @param out - the run's output directory.
 * @returns the measurements, timeline, and rubric.
 */
export function analyze(out: string): Analysis {
  const runText = readText(join(out, 'run.json'))
  const run = runText === undefined ? undefined : JSON.parse(runText) as RunRecord
  const unsettled = (readText(join(out, 'stderr.log')) ?? '').split('\n')
    .flatMap(line => line.startsWith('dsh: unsettled: ') ? [line.slice('dsh: unsettled: '.length)] : [])
  const logs = readSessionLogs(join(out, 'dsh-home'))
  const lead = leadOf(logs)
  const team = lead === undefined ? undefined : foldTeam(lead)
  const agents = logs
    .filter(log => log === lead || team?.members.has(log.id) === true)
    .map(log => measure(log, team?.members.get(log.id) ?? log.id, log === lead ? 'lead' : 'teammate'))
    .toSorted((left, right) => Number(right.role === 'lead') - Number(left.role === 'lead') || left.name.localeCompare(right.name))
  const tasks = team?.tasks ?? []
  const rubric = [...judgeTrajectory(run, unsettled, agents, tasks), ...judgeOutputs(join(out, 'workspace'))]
  return {
    run,
    unsettled,
    agents,
    tasks,
    timeline: team?.timeline ?? [],
    rubric,
    score: { passed: rubric.filter(item => item.passed).length, total: rubric.length },
  }
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

/**
 * Render the analysis as the Markdown the workflow shows as its summary.
 * @param analysis - one run's analysis.
 * @returns Markdown with the verdict, rubric, agents, board, and timeline.
 */
export function renderSummary(analysis: Analysis): string {
  const { run, score } = analysis
  const lines = [
    '# Agent Team standard case',
    '',
    `**Rubric: ${score.passed}/${score.total} passed.**`,
    '',
  ]
  if (run !== undefined) {
    lines.push(
      `Revision \`${run.revision.slice(0, 10)}\`, model \`${run.settings.model}\` over \`${run.settings.provider}\`, effort \`${run.settings.effort}\`, `
      + `${Math.round(run.elapsedMs / 1000)} s, exit ${run.exitCode ?? run.signal ?? 'unknown'}.`,
      '',
    )
  }
  lines.push('## Rubric', '', '| | Criterion | Detail |', '|---|---|---|')
  for (const item of analysis.rubric) lines.push(`| ${item.passed ? '✅' : '❌'} | ${cell(item.criterion)} | ${cell(item.detail)} |`)
  lines.push('', '## Agents', '', '| Agent | Role | Turns | Turn ends | Model requests | Input tokens | Output tokens | Tool calls | Tool errors |', '|---|---|---|---|---|---|---|---|---|')
  for (const agent of analysis.agents) {
    const tools = Object.entries(agent.toolCalls).toSorted((left, right) => right[1] - left[1]).map(([name, calls]) => `${name}×${calls}`).join(', ')
    lines.push(`| ${cell(agent.name)} | ${agent.role} | ${agent.turns} | ${agent.turnEnds.join(', ')} | ${agent.modelRequests} | ${agent.inputTokens} | ${agent.outputTokens} | ${cell(tools)} | ${agent.toolErrors} |`)
  }
  lines.push('', '## Task board', '', '| Task | Status | Owner | Revisions | Subject |', '|---|---|---|---|---|')
  for (const task of analysis.tasks) {
    const status = task.lostCause === undefined ? task.status : `${task.status} (${task.lostCause})`
    lines.push(`| ${task.id} | ${status} | ${cell(task.owner ?? 'nobody')} | ${task.revisions} | ${cell(task.subject.slice(0, 100))} |`)
  }
  if (analysis.unsettled.length > 0) {
    lines.push('', '## Unsettled', '')
    for (const row of analysis.unsettled) lines.push(`- ${row}`)
  }
  lines.push('', '## Timeline', '', '| Seconds | Event |', '|---|---|')
  for (const entry of analysis.timeline) lines.push(`| ${entry.atSeconds.toFixed(1)} | ${cell(entry.text)} |`)
  return `${lines.join('\n')}\n`
}
