/** Pull assignment's offers: idle teammates are mailed about ready work nobody has claimed. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorMessage } from './error.ts'
import type { TeamMailbox } from './mailbox.ts'
import type { TeamRoster } from './roster.ts'
import type { ReadyTask, TeamTaskBoard } from './task-board.ts'
import type { TeamId } from './types.ts'

/** What the dispatcher reads and sends through. */
export interface TeamPullHost {
  readonly roster: TeamRoster
  readonly tasks: TeamTaskBoard
  readonly mailbox: TeamMailbox
  /** Aborted when the service disposes; no offer is queued or sent after that. */
  readonly signal: AbortSignal
  readonly warn: (message: string) => void
}

/** An offer is one task at one revision: a task reopened or released is offered again. */
function offerKey(task: ReadyTask): string {
  return `${task.id}@${task.revision}`
}

/** The mail an idle teammate receives; which task it claims is its own choice. */
function offerText(ready: readonly ReadyTask[]): string {
  const lines = ready.map(task => `- ${task.id} "${task.subject}" (revision ${task.revision})`)
  return `Ready on the shared board and claimed by nobody (assignment is pull, so nobody will assign them):\n${lines.join('\n')}\n\nClaim one you can take at its current revision. If another member claimed it first, claim another ready task.`
}

/**
 * Under pull assignment, mail inactive teammates about ready tasks nobody has
 * claimed, so an idle member starts a turn and claims work itself. Each
 * teammate is offered a task once while it stays ready at one revision, and
 * one change wakes at most as many teammates as there are ready tasks, in
 * roster order. A teammate that reads an offer and claims nothing is not
 * offered the same tasks again; headless settlement reports such tasks.
 */
export class TeamPullDispatcher {
  /** Per Team and member name, the offers that member has been mailed. */
  private readonly offered = new Map<TeamId, Map<string, Set<string>>>()
  /** Teams with a dispatch already queued. */
  private readonly queued = new Set<Agent>()

  constructor(private readonly host: TeamPullHost) {}

  /**
   * Queue one dispatch for the Team after the current change. It runs as a
   * macrotask, so a burst of edits in one turn (the Lead creating several
   * tasks) yields a single offer.
   * @param root - exact live Team Lead whose board changed.
   */
  schedule(root: Agent): void {
    if (this.queued.has(root) || this.host.signal.aborted) return
    this.queued.add(root)
    setTimeout(() => {
      this.queued.delete(root)
      if (this.host.signal.aborted) return
      try {
        this.dispatch(root)
      } catch (error: unknown) {
        this.host.warn(`Agent Teams could not offer ready tasks: ${errorMessage(error)}`)
      }
    }, 0)
  }

  /** Offer the Team's ready, unclaimed tasks to inactive teammates that have not been offered them. */
  private dispatch(root: Agent): void {
    const membership = this.host.roster.tryMembership(root)
    if (membership === undefined || membership.role !== 'lead') return
    const ready = this.host.tasks.readyUnclaimed(root)
    const offered = this.offersIn(membership.id)
    // An offer stands while its task stays ready at that revision; the next time it is ready is a new offer.
    const standing = new Set(ready.map(offerKey))
    for (const keys of offered.values()) {
      for (const key of keys) if (!standing.has(key)) keys.delete(key)
    }
    if (ready.length === 0) return
    let woken = 0
    for (const member of this.host.roster.list(membership)) {
      if (woken >= ready.length) break
      if (member.role !== 'teammate' || member.status !== 'inactive') continue
      const keys = offered.get(member.name) ?? new Set<string>()
      offered.set(member.name, keys)
      if (ready.every(task => keys.has(offerKey(task)))) continue
      woken += 1
      this.offer(root, member.name, ready, keys)
    }
  }

  /** Mail one teammate the ready tasks; an offer that is not delivered is made again on the next change. */
  private offer(root: Agent, name: string, ready: readonly ReadyTask[], keys: Set<string>): void {
    const sent = ready.map(offerKey)
    for (const key of sent) keys.add(key)
    void this.host.mailbox.send(root, {
      target: name,
      content: [{ type: 'text', text: offerText(ready) }],
      signal: this.host.signal,
    }).catch((error: unknown) => {
      for (const key of sent) keys.delete(key)
      this.host.warn(`Agent Teams could not offer ready tasks to "${name}": ${errorMessage(error)}`)
    })
  }

  /** The offers already mailed in one Team, by member name. */
  private offersIn(team: TeamId): Map<string, Set<string>> {
    let offered = this.offered.get(team)
    if (offered === undefined) {
      offered = new Map()
      this.offered.set(team, offered)
    }
    return offered
  }
}
