/**
 * @deepseek-ai/dsh-experimental-agent-team-settlement — provides the headless
 * runner's `ctx.headlessSettlement` over the Agent Teams board. The task a run
 * is started with is recorded as an in-progress task owned by the root, like
 * any task a member works on. The run keeps going while the root is in a turn
 * or any task on its board is in progress; a settling child may wake the root
 * again. A run's task without declared outputs completes when the root's last
 * turn completed with nothing else outstanding. One with declared outputs is
 * completed only by the root, through the task tool that checks them on disk;
 * the root is reminded once. When the deadline passes the root's turn is
 * cancelled, and work still open then, or when nothing is running and nothing
 * changes for the stall window, is marked `lost` and reported, so the run never
 * records a result it did not collect.
 *
 * @module @deepseek-ai/dsh-experimental-agent-team-settlement
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamError } from '@deepseek-ai/dsh-experimental-agent-team'
import type { ArtifactContract, OutstandingTeamTask, TeamService, TeamTaskId, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { HeadlessSettlement, HeadlessSettlementReport } from '@deepseek-ai/dsh-headless'

/** Stable Cordis plugin name. */
export const name = 'agent-team-settlement'

/** The Team board this plugin settles over. */
export const inject = ['agentTeams']

/** Source of the reminder sent to a root whose turn completed with the run's declared outputs unsettled. */
export interface AgentTeamSettlementSource {
  kind: 'agent-team-settlement'
  /** The run's task the reminder is about. */
  taskId: TeamTaskId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Reminder attribution; readers preserve the notice without this producer,
     * and the kind imposes no validation, replay, or authority requirement.
     * @persistenceAttribution
     */
    'agent-team-settlement': AgentTeamSettlementSource & ContextFormed
  }
}

/** Deployment limits for how long a one-shot run follows delegated work, and what the run must produce. */
export interface Config {
  /**
   * Milliseconds from the start of the run before the root's turn is cancelled
   * and every task still in progress is marked lost. At most 2147483647, the
   * longest delay a timer accepts.
   */
  readonly deadlineMs: number
  /**
   * Milliseconds without any Team change, while no task owner is running, before
   * the remaining tasks are marked lost. At least ten seconds, at most one hour.
   */
  readonly stallMs: number
  /**
   * Files the run's task must produce, declared on it like any task's outputs.
   * When any is declared, only the root completes the run's task, through the
   * task tool that checks them on disk. Empty when omitted.
   */
  readonly outputs: ArtifactContract[]
}

/** The longest delay `setTimeout` accepts without firing at once. */
const MAX_TIMER_MS = 2_147_483_647

export const Config: z<Config> = z.object({
  deadlineMs: z.number().step(1).min(1).max(MAX_TIMER_MS).required(),
  stallMs: z.number().step(1).min(10_000).max(3_600_000).required(),
  outputs: z.array(z.object({
    path: z.string().required(),
    kind: z.union(['file', 'json', 'csv', 'npy', 'image', 'python'] as const).required(),
    schema: z.any(),
    optional: z.boolean(),
  })),
})

/** The Team change wait accepts ten seconds through one hour. */
const MIN_WAIT_MS = 10_000
const MAX_WAIT_MS = 3_600_000

/** The board's subject and description length limits, which the run's task text is cut to. */
const SUBJECT_LIMIT = 200
const DESCRIPTION_LIMIT = 16_384

/** One run being followed: its task on the board, its deadline, how the root's latest turn ended, and whether the root was reminded. */
interface FollowedRun {
  readonly task: TeamTaskId
  readonly deadline: number
  lastTurnEnd?: string
  reminded: boolean
}

/** One reported row for a task the run gave up on. */
function row(task: OutstandingTeamTask, why: string): string {
  return `${task.id} "${task.subject}" owned by ${task.ownerName}: ${why}`
}

/**
 * Mark every outstanding task lost and describe each. A task that settled
 * between the listing and the mark is not lost and not reported. A task whose
 * mark failed for any other reason is reported with that failure, so the run
 * still exits non-zero for work it neither collected nor recorded as lost.
 */
async function abandon(
  teams: TeamService,
  root: Agent,
  outstanding: readonly OutstandingTeamTask[],
  why: string,
): Promise<HeadlessSettlementReport> {
  const unsettled: string[] = []
  for (const task of outstanding) {
    try {
      await teams.markLost(root, task.id, 'run-ended')
    } catch (error) {
      // The board refuses the mark with this code only when the task left
      // in_progress first, which is the owner settling it.
      if (error instanceof TeamError && error.code === 'TEAM_TASK_INVALID_TRANSITION') continue
      const failure = error instanceof Error ? error.message : String(error)
      unsettled.push(row(task, `${why}; recording it as lost failed: ${failure}`))
      continue
    }
    unsettled.push(row(task, why))
  }
  return { unsettled }
}

/**
 * Wait for the root to be idle, giving up when the time runs out.
 * @param root - the run's exact live root Agent.
 * @param ms - how long to wait.
 * @returns whether the root reached idle in time.
 */
async function idleWithin(root: Agent, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, ms) })
  try {
    return await Promise.race([root.whenIdle().then(() => true as const), expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Start a root turn telling the root its task's declared outputs are still unsettled. */
function remind(root: Agent, task: TeamTaskView): void {
  const paths = task.outputs.map(output => output.path).join(', ')
  root.followup(createUserMessage({
    content: [{
      type: 'text',
      text: `Your turn ended, but task ${task.id}, which this run was started with and you own, is still in progress. `
        + `It declares outputs that are checked on disk: ${paths}. `
        + `Produce them, then call team_task_update with action complete on ${task.id} at revision ${task.revision}. `
        + 'This reminder is sent once; if your next turn ends with the task still in progress, the run records it as lost.',
    }],
    source: {
      kind: 'agent-team-settlement',
      taskId: task.id,
      form: 'notice',
      summary: `reminded to complete ${task.id} and its declared outputs`,
    },
  }))
}

/**
 * Settle the run's own task once nothing else is outstanding. A task the root
 * completed is accepted, and one it moved out of progress is reported. A task
 * still in progress is lost when the root's latest turn did not complete.
 * After a completed turn, a task without declared outputs is completed here,
 * and one with declared outputs is left to the root: reminded once, then lost.
 * @returns the report, or undefined when the root was reminded and runs again.
 */
async function close(teams: TeamService, root: Agent, run: FollowedRun): Promise<HeadlessSettlementReport | undefined> {
  const task = teams.getTask(root, run.task)
  if (task.status === 'completed') return { unsettled: [] }
  if (task.status !== 'in_progress') {
    return { unsettled: [`${task.id} "${task.subject}": the run's task was left ${task.status}`] }
  }
  let ended: string
  if (run.lastTurnEnd === undefined) {
    ended = 'no turn ran'
  } else if (run.lastTurnEnd !== 'completed') {
    ended = `the turn ended ${run.lastTurnEnd}`
  } else if (task.outputs.length === 0) {
    await teams.markCompleted(root, task.id)
    return { unsettled: [] }
  } else if (!run.reminded) {
    run.reminded = true
    remind(root, task)
    return undefined
  } else {
    ended = 'the turn completed without completing the task and its declared outputs, after one reminder'
  }
  await teams.markLost(root, task.id, 'owner-failed')
  return { unsettled: [`${task.id} "${task.subject}" owned by ${task.ownerName}: ${ended}`] }
}

/**
 * Follow the root and its board until the run's task and everything else on
 * the board settled, or until the deadline or a stall ends the wait.
 * @param ctx - plugin context carrying the Team service.
 * @param root - the run's exact live root Agent.
 * @param run - the run's task, deadline, and latest turn outcome.
 * @param config - deadline and stall windows.
 * @param signal - plugin disposal, which abandons the wait.
 * @returns the rows that did not settle, empty when everything did.
 */
async function settle(
  ctx: Context,
  root: Agent,
  run: FollowedRun,
  config: Config,
  signal: AbortSignal,
): Promise<HeadlessSettlementReport> {
  const teams = ctx.agentTeams
  for (;;) {
    // A child's settlement notice is delivered to the root before the child's
    // terminal edge settles its task, so the wake that follows a change is
    // already a driver by the time the board reads empty.
    const remaining = run.deadline - Date.now()
    if (remaining <= 0 || !await idleWithin(root, remaining)) {
      // The deadline bounds the root's own turns as well as the work it delegated.
      root.cancel({ kind: 'hook', reason: `agent-team-settlement: the ${config.deadlineMs} ms run deadline passed` })
      await root.whenIdle()
      return await abandon(teams, root, teams.outstandingTasks(root), `still in progress at the ${config.deadlineMs} ms deadline`)
    }
    const outstanding = teams.outstandingTasks(root)
    const others = outstanding.filter(task => task.id !== run.task)
    if (others.length === 0) {
      const report = await close(teams, root, run)
      if (report !== undefined) return report
      continue
    }
    const live = others.some(task => task.live)
    const left = run.deadline - Date.now()
    const wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, live ? left : Math.min(left, config.stallMs)))
    const { timedOut } = await teams.waitForChange(root, wait, signal)
    if (timedOut && !live) {
      return await abandon(teams, root, outstanding, `its owner was not running and nothing changed for ${config.stallMs} ms`)
    }
  }
}

/**
 * Cut the run's task text to the board's limits: the first non-empty line is
 * the subject and the whole text is the description.
 */
function taskText(task: string): { subject: string; description: string } {
  const text = task.trim()
  const lineEnd = text.indexOf('\n')
  const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd)
  return { subject: firstLine.trim().slice(0, SUBJECT_LIMIT), description: text.slice(0, DESCRIPTION_LIMIT) }
}

/**
 * Provide `ctx.headlessSettlement` over the Team board.
 * @param ctx - plugin context carrying the Team service.
 * @param config - validated deadline and stall windows.
 */
export function apply(ctx: Context, config: Config): void {
  const disposal = new AbortController()
  ctx.effect(() => () => { disposal.abort(new Error('agent-team-settlement disposed')) }, 'agentTeamSettlement.disposal()')
  const runs = new Map<Agent['id'], FollowedRun>()
  ctx.on('session/event', (session, event) => {
    const run = runs.get(session.id)
    if (run !== undefined && event.type === 'turn/end') run.lastTurnEnd = event.data.reason.kind
  })
  const settlement: HeadlessSettlement = {
    async begin(root, task) {
      const deadline = Date.now() + config.deadlineMs
      const recorded = await ctx.agentTeams.beginTask(root, { ...taskText(task), outputs: config.outputs })
      const run: FollowedRun = { task: recorded.id, deadline, reminded: false }
      runs.set(root.id, run)
      return {
        async settle() {
          try {
            return await settle(ctx, root, run, config, disposal.signal)
          } finally {
            runs.delete(root.id)
          }
        },
      }
    },
  }
  ctx.provide('headlessSettlement', settlement)
}
