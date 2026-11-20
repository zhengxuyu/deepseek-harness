/**
 * Analyze one finished standard-case run from what it left on disk: the
 * Session logs of the Lead and every teammate, the workspace, stderr, and
 * `run.json`. The analysis has three parts: measurements of the trajectory,
 * a timeline of the Team's events, and the rubric the case judges the result
 * and the Team's work by.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMeasure, RubricItem, StandardCase, TaskOutcome } from './case.ts'
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

/** One line of the Team timeline. */
export interface TimelineEntry {
  readonly atSeconds: number
  readonly text: string
}

/** The whole analysis of one run. */
export interface Analysis {
  readonly case: string
  readonly description: string
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

/**
 * Analyze one run directory written by `run.ts`.
 * @param standardCase - the case the run was given, which judges it.
 * @param out - the run's output directory.
 * @returns the measurements, timeline, and rubric.
 */
export function analyze(standardCase: StandardCase, out: string): Analysis {
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
  const rubric = [
    ...standardCase.judgeTrajectory({ exitCode: run?.exitCode, timedOut: run?.timedOut === true, unsettled, agents, tasks }),
    ...standardCase.judgeOutputs(join(out, 'workspace')),
  ]
  return {
    case: standardCase.name,
    description: standardCase.description,
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
    `# Standard case: ${analysis.case}`,
    '',
    analysis.description,
    '',
    `**Rubric: ${score.passed}/${score.total} passed.**`,
    '',
  ]
  if (run !== undefined) {
    lines.push(
      `Revision \`${run.revision.slice(0, 10)}\`, model \`${run.settings.model}\` over \`${run.settings.provider}\`, effort \`${run.settings.effort}\`, `
      + `settlement ${run.settlement ? 'mounted' : 'not shipped by this revision'}, ${Math.round(run.elapsedMs / 1000)} s, exit ${run.exitCode ?? run.signal ?? 'unknown'}.`,
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
