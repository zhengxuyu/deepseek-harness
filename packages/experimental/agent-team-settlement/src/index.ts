/**
 * @deepseek-ai/dsh-experimental-agent-team-settlement — provides the headless
 * runner's `ctx.headlessSettlement` over the Agent Teams board. After the root
 * turn ends, the run keeps going while any task on the root's board is in
 * progress; a settling child may wake the root again. Work that is still open
 * when the deadline passes, or when nothing is running and nothing changes for
 * the stall window, is marked `lost` and reported, so the run never records a
 * result it did not collect.
 *
 * @module @deepseek-ai/dsh-experimental-agent-team-settlement
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { OutstandingTeamTask, TeamService } from '@deepseek-ai/dsh-experimental-agent-team'
import type { HeadlessSettlement, HeadlessSettlementReport } from '@deepseek-ai/dsh-headless'

/** Stable Cordis plugin name. */
export const name = 'agent-team-settlement'

/** The Team board this plugin settles over. */
export const inject = ['agentTeams']

/** Deployment limits for how long a one-shot run follows delegated work. */
export interface Config {
  /** Milliseconds after the root turn ends before every task still in progress is marked lost. */
  readonly deadlineMs: number
  /**
   * Milliseconds without any Team change, while no task owner is running, before
   * the remaining tasks are marked lost. At least ten seconds, at most one hour.
   */
  readonly stallMs: number
}

export const Config: z<Config> = z.object({
  deadlineMs: z.number().step(1).min(1).required(),
  stallMs: z.number().step(1).min(10_000).max(3_600_000).required(),
})

/** The Team change wait accepts ten seconds through one hour. */
const MIN_WAIT_MS = 10_000
const MAX_WAIT_MS = 3_600_000

/** One reported row for a task the run gave up on. */
function row(task: OutstandingTeamTask, why: string): string {
  return `${task.id} "${task.subject}" owned by ${task.ownerName}: ${why}`
}

/**
 * Mark every outstanding task lost and describe each. A task that settled
 * between the listing and the mark is not lost and not reported.
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
    } catch {
      // The only transition the mark can lose is to the owner finishing first,
      // which the board rejects as a no-longer-in-progress task.
      continue
    }
    unsettled.push(row(task, why))
  }
  return { unsettled }
}

/**
 * Follow the root's board until nothing is in progress and the root is idle,
 * or until the deadline or a stall ends the wait.
 * @param ctx - plugin context carrying the Team service.
 * @param root - the run's exact live root Agent.
 * @param config - deadline and stall windows.
 * @param signal - plugin disposal, which abandons the wait.
 * @returns the rows marked lost, empty when everything settled.
 */
async function settle(ctx: Context, root: Agent, config: Config, signal: AbortSignal): Promise<HeadlessSettlementReport> {
  const teams = ctx.agentTeams
  const deadline = Date.now() + config.deadlineMs
  for (;;) {
    // A child's settlement notice is delivered to the root before the child's
    // terminal edge settles its task, so the wake that follows a change is
    // already a driver by the time the board reads empty.
    await root.whenIdle()
    const outstanding = teams.outstandingTasks(root)
    if (outstanding.length === 0) return { unsettled: [] }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return await abandon(teams, root, outstanding, `still in progress at the ${config.deadlineMs} ms deadline`)
    const live = outstanding.some(task => task.live)
    const wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, live ? remaining : Math.min(remaining, config.stallMs)))
    const { timedOut } = await teams.waitForChange(root, wait, signal)
    if (timedOut && !live) {
      return await abandon(teams, root, outstanding, `its owner was not running and nothing changed for ${config.stallMs} ms`)
    }
  }
}

/**
 * Provide `ctx.headlessSettlement` over the Team board.
 * @param ctx - plugin context carrying the Team service.
 * @param config - validated deadline and stall windows.
 */
export function apply(ctx: Context, config: Config): void {
  const disposal = new AbortController()
  ctx.effect(() => () => { disposal.abort(new Error('agent-team-settlement disposed')) }, 'agentTeamSettlement.disposal()')
  const settlement: HeadlessSettlement = {
    settle: root => settle(ctx, root, config, disposal.signal),
  }
  ctx.provide('headlessSettlement', settlement)
}
