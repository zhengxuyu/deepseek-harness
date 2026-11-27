/**
 * @deepseek-ai/dsh-experimental-agent-team-settlement — provides the headless
 * runner's `ctx.headlessSettlement` over the Agent Teams board. The task a run
 * is started with is recorded as an in-progress task owned by the root, like
 * any task a member works on. The run keeps going while the root is in a turn
 * or any task on its board is in progress; a settling child may wake the root
 * again. The run's task completes when the root's last turn completed with
 * nothing else outstanding. When the deadline passes, the root's turn is
 * cancelled and every running teammate is interrupted; work still in progress
 * then, or when nothing is running and nothing changes for the stall window,
 * is marked `lost`. The report lists every task the run created or changed
 * that is not completed when the run ends, so the run never records a result
 * it did not collect.
 *
 * @module @deepseek-ai/dsh-experimental-agent-team-settlement
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamError, taskUncollected } from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeamService, TeamTaskId, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import type { HeadlessSettlement, HeadlessSettlementReport, HeadlessUnsettledWork } from '@deepseek-ai/dsh-headless'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/** Stable Cordis plugin name. */
export const name = 'agent-team-settlement'

/** The Team board this plugin settles over. */
export const inject = ['agentTeams']

/** Deployment limits for how long a one-shot run follows delegated work. */
export interface Config {
  /**
   * Milliseconds from the start of the run before the root's turn is cancelled,
   * every running teammate is interrupted, and every task still in progress is
   * marked lost. At most 2147483647, the longest delay a timer accepts.
   */
  readonly deadlineMs: number
  /**
   * Milliseconds without any Team change, while no task owner is running, before
   * the remaining tasks are marked lost. At least ten seconds, at most one hour.
   */
  readonly stallMs: number
  /**
   * Milliseconds to wait, after the deadline stopped the root and the
   * teammates, for their turns to end. When it passes the run is reported
   * without them, so the run ends at most this long after the deadline.
   */
  readonly stopGraceMs: number
}

/** The longest delay `setTimeout` accepts without firing at once. */
const MAX_TIMER_MS = 2_147_483_647

export const Config: z<Config> = z.object({
  deadlineMs: z.number().step(1).min(1).max(MAX_TIMER_MS).required(),
  stallMs: z.number().step(1).min(10_000).max(3_600_000).required(),
  stopGraceMs: z.number().step(1).min(1).max(MAX_TIMER_MS).required(),
})

/** The board's subject and description length limits, which the run's task text is cut to. */
const SUBJECT_LIMIT = 200
const DESCRIPTION_LIMIT = 16_384

/** One run being followed. */
interface FollowedRun {
  /** The run's own task on the board. */
  readonly task: TeamTaskId
  /** When the run stops waiting, in epoch milliseconds. */
  readonly deadline: number
  /**
   * The revision of every task that was on the board before the run began. A
   * task still at that revision when the run ends was not touched by this run
   * and is not reported.
   */
  readonly baseline: ReadonlyMap<TeamTaskId, number>
  /**
   * How the root's latest turn ended; absent until one ends. A turn the loop
   * ended `max-tokens` whose latest model message was not cut off is `completed`.
   */
  lastTurnEnd?: TurnEndReason['kind']
  /** Whether the root's latest model message was cut off at the output limit. */
  lastMessageCutOff: boolean
  /** Why this run could not collect a task, for tasks whose reason the board does not record. */
  readonly reasons: Map<TeamTaskId, string>
}

/**
 * Wait for an operation, giving up when the time runs out.
 * @param operation - the wait to bound.
 * @param ms - how long to wait.
 * @returns whether the operation settled in time.
 */
async function within(operation: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, ms) })
  try {
    return await Promise.race([operation.then(() => true as const), expired])
  } finally {
    clearTimeout(timer)
  }
}

/** The Team change wait accepts ten seconds through one hour. */
const MIN_WAIT_MS = 10_000
const MAX_WAIT_MS = 3_600_000

/**
 * Wait for the next Team change for at most `ms`, which may be shorter than
 * the shortest wait the Team service accepts.
 * @param teams - the Team service.
 * @param root - the run's exact live root Agent.
 * @param ms - how long to wait.
 * @param signal - plugin disposal, which rejects the wait.
 * @returns whether the time ran out with no change.
 */
async function quietFor(teams: TeamService, root: Agent, ms: number, signal: AbortSignal): Promise<boolean> {
  const expired = new Error('agent-team-settlement wait expired')
  const stop = new AbortController()
  const timer = setTimeout(() => { stop.abort(expired) }, ms)
  try {
    const accepted = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, ms))
    return (await teams.waitForChange(root, accepted, AbortSignal.any([signal, stop.signal]))).timedOut
  } catch (error) {
    if (error === expired) return true
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Why a task the board left uncollected was not collected, when the run recorded no reason of its own. */
function boardReason(task: TeamTaskView): string {
  if (task.status === 'pending') return 'nobody is working on it'
  if (task.lostCause === 'owner-failed') return 'its owner stopped without completing it'
  return `it was left ${task.status.replace('_', ' ')}`
}

/**
 * List every task the run created or changed that is not completed.
 * @param teams - the Team service.
 * @param root - the run's exact live root Agent.
 * @param run - the followed run, with its baseline and recorded reasons.
 * @returns one row per uncollected task, in creation order.
 */
function report(teams: TeamService, root: Agent, run: FollowedRun): HeadlessSettlementReport {
  const unsettled: HeadlessUnsettledWork[] = []
  for (const task of teams.listTasks(root)) {
    if (!taskUncollected(task.status) || run.baseline.get(task.id) === task.revision) continue
    unsettled.push({
      id: task.id,
      subject: task.subject,
      ...task.ownerName === undefined ? {} : { owner: task.ownerName },
      state: task.status,
      reason: run.reasons.get(task.id) ?? boardReason(task),
    })
  }
  return { unsettled }
}

/**
 * Mark every outstanding task lost for one reason. A task that left
 * `in_progress` between the listing and the mark is left as its owner put it;
 * the report reads its state from the board. A mark that failed for any other
 * reason is recorded with that failure.
 */
async function abandon(teams: TeamService, root: Agent, run: FollowedRun, why: string): Promise<void> {
  for (const task of teams.outstandingTasks(root)) {
    try {
      await teams.markLost(root, task.id, 'run-ended')
      run.reasons.set(task.id, why)
    } catch (error) {
      if (error instanceof TeamError && error.code === 'TEAM_TASK_INVALID_TRANSITION') continue
      const failure = error instanceof Error ? error.message : String(error)
      run.reasons.set(task.id, `${why}; recording it as lost failed: ${failure}`)
    }
  }
}

/**
 * Settle the run's own task once nothing else is outstanding: complete it when
 * the root's latest turn completed, lose it when that turn ended any other way,
 * and record why when the root moved it out of progress without completing it.
 * The root's turn says how the task ended only while the root holds it.
 * @returns false when the root gave the task to another member in the meantime, so the run has to keep waiting.
 */
async function close(teams: TeamService, root: Agent, run: FollowedRun): Promise<boolean> {
  const task = teams.getTask(root, run.task)
  if (task.status === 'completed' || task.status === 'deleted') return true
  if (task.status !== 'in_progress') {
    run.reasons.set(task.id, `the run's task was left ${task.status}`)
    return true
  }
  try {
    if (run.lastTurnEnd === 'completed') {
      await teams.markCompleted(root, task.id, root.id)
      return true
    }
    await teams.markLost(root, task.id, 'owner-failed', root.id)
  } catch (error) {
    if (error instanceof TeamError && error.code === 'TEAM_TASK_INVALID_TRANSITION') return false
    throw error
  }
  run.reasons.set(task.id, run.lastTurnEnd === undefined ? 'no turn ran' : `the turn ended ${run.lastTurnEnd}`)
  return true
}

/**
 * Follow the root and its board until the run's task and everything else on
 * the board settled, or until the deadline or a stall ends the wait.
 * @param ctx - plugin context carrying the Team service.
 * @param root - the run's exact live root Agent.
 * @param run - the run's task, deadline, baseline, and latest turn outcome.
 * @param config - deadline, stall, and stop windows.
 * @param signal - plugin disposal, which abandons the wait.
 * @returns the tasks the run did not collect, empty when it collected all of them.
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
    if (remaining <= 0 || !await within(root.whenIdle(), remaining)) {
      // The deadline bounds the root's own turns and every teammate's.
      root.cancel({ kind: 'hook', reason: `agent-team-settlement: the ${config.deadlineMs} ms run deadline passed` })
      const stopped = await within(Promise.all([root.whenIdle(), teams.interruptTeammates(root)]), config.stopGraceMs)
      const late = stopped ? '' : `; its owner had not stopped ${config.stopGraceMs} ms after the deadline`
      await abandon(teams, root, run, `still in progress at the ${config.deadlineMs} ms deadline${late}`)
      return report(teams, root, run)
    }
    // The run's task is the root's own work only while the root holds it; once
    // the root gave it to a teammate it is waited on like any other task.
    const others = teams.outstandingTasks(root).filter(task => task.id !== run.task || task.ownerId !== root.id)
    if (others.length === 0) {
      if (await close(teams, root, run)) return report(teams, root, run)
      continue
    }
    const live = others.some(task => task.live)
    const left = Math.max(1, run.deadline - Date.now())
    // A stall is declared only after a full stall window; a shorter wait ends at the deadline.
    const stallWindow = !live && config.stallMs <= left
    const quiet = await quietFor(teams, root, stallWindow ? config.stallMs : left, signal)
    if (quiet && stallWindow) {
      await abandon(teams, root, run, `its owner was not running and nothing changed for ${config.stallMs} ms`)
      return report(teams, root, run)
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
    if (run === undefined) return
    if (event.type === 'assistant/message') {
      run.lastMessageCutOff = event.data.stream.some(entry =>
        entry.type === 'chunk' && entry.chunk.type === 'finish' && entry.chunk.reason.kind === 'max-tokens')
    }
    if (event.type !== 'turn/end') return
    // The loop reports max-tokens for a turn in which any message was cut off, also
    // when the root went on afterwards; such a turn completed.
    const { kind } = event.data.reason
    run.lastTurnEnd = kind === 'max-tokens' && !run.lastMessageCutOff ? 'completed' : kind
  })
  const settlement: HeadlessSettlement = {
    async begin(root, task) {
      const teams = ctx.agentTeams
      const deadline = Date.now() + config.deadlineMs
      // No turn has run in this process yet, so a task already in progress was
      // left by an earlier process that ended before the task finished.
      for (const left of teams.outstandingTasks(root)) await teams.markLost(root, left.id, 'run-ended')
      const baseline = new Map(teams.listTasks(root).map(existing => [existing.id, existing.revision]))
      const recorded = await teams.beginTask(root, taskText(task))
      const run: FollowedRun = { task: recorded.id, deadline, baseline, reasons: new Map(), lastMessageCutOff: false }
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
