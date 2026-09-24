/**
 * The frontier: the bounded board state every task edit and every wait hands
 * back, so the Lead reads the graph instead of remembering it.
 * @module dsh-experimental-tool-agent-team/frontier
 */

import type { TeamMemberView, TeamTaskId, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import type { InferValue } from '@deepseek-ai/dsh-tools'

const FRONTIER_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    subject: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'lost'] },
    ownerName: { type: 'string' },
    /** Declared outputs, and how many of them a completed task recorded as artifacts. */
    outputs: { type: 'integer', required: true },
    artifacts: { type: 'integer' },
  },
} as const

/** Model-facing schema of the frontier carried by task edits and waits. */
export const FRONTIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ready: { type: 'array', required: true, items: FRONTIER_ROW_SCHEMA },
    running: { type: 'array', required: true, items: FRONTIER_ROW_SCHEMA },
    lost: { type: 'array', required: true, items: FRONTIER_ROW_SCHEMA },
    blocked: { type: 'integer', required: true },
    completed: { type: 'integer', required: true },
    truncated: { type: 'boolean' },
    around: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', required: true },
        upstream: { type: 'array', required: true, items: FRONTIER_ROW_SCHEMA },
        downstream: { type: 'array', required: true, items: FRONTIER_ROW_SCHEMA },
      },
    },
    members: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
          lastStop: { type: 'string' },
        },
      },
    },
  },
} as const

/** The frontier value. */
export type Frontier = InferValue<typeof FRONTIER_SCHEMA>
type FrontierRow = InferValue<typeof FRONTIER_ROW_SCHEMA>

/** How much of the board a frontier carries. */
export interface FrontierBounds {
  /** Dependency hops around the edited task included in `around`; `0` omits the neighbourhood. */
  readonly hops: number
  /** Rows kept per list; a cut list sets `truncated`. */
  readonly rows: number
}

function row(task: TeamTaskView): FrontierRow {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status as FrontierRow['status'],
    ...task.ownerName === undefined ? {} : { ownerName: task.ownerName },
    outputs: task.outputs.length,
    ...task.artifacts === undefined ? {} : { artifacts: task.artifacts.length },
  }
}

/** Tasks within `hops` dependency hops of `start` along `next`, nearest first, excluding `start` and deleted blockers. */
function reach(
  start: TeamTaskView,
  hops: number,
  next: (task: TeamTaskView) => readonly TeamTaskId[],
  byId: ReadonlyMap<TeamTaskId, TeamTaskView>,
): TeamTaskView[] {
  const seen = new Set<TeamTaskId>([start.id])
  const found: TeamTaskView[] = []
  let ring: TeamTaskView[] = [start]
  for (let hop = 0; hop < hops && ring.length > 0; hop++) {
    const following: TeamTaskView[] = []
    for (const task of ring) {
      for (const id of next(task)) {
        if (seen.has(id)) continue
        seen.add(id)
        const neighbour = byId.get(id)
        if (neighbour === undefined) continue
        found.push(neighbour)
        following.push(neighbour)
      }
    }
    ring = following
  }
  return found
}

/**
 * Compose the frontier from the current views.
 * @param tasks - every task the caller may read, deleted tombstones included.
 * @param members - the current roster.
 * @param bounds - hop and row limits.
 * @param focus - the task an edit touched, whose neighbourhood `around` describes; absent for a wait.
 * @returns the bounded frontier.
 */
export function frontier(
  tasks: readonly TeamTaskView[],
  members: readonly TeamMemberView[],
  bounds: FrontierBounds,
  focus?: TeamTaskId,
): Frontier {
  const live = tasks.filter(task => task.status !== 'deleted')
  const byId = new Map(live.map(task => [task.id, task]))
  const cut = { any: false }
  const take = (list: readonly TeamTaskView[]): FrontierRow[] => {
    if (list.length > bounds.rows) cut.any = true
    return list.slice(0, bounds.rows).map(row)
  }
  const ready = take(live.filter(task => task.status === 'pending' && task.ready))
  const running = take(live.filter(task => task.status === 'in_progress'))
  const lost = take(live.filter(task => task.status === 'lost'))
  const focused = focus === undefined ? undefined : byId.get(focus)
  let around: Frontier['around']
  if (focused !== undefined && bounds.hops > 0) {
    const dependents = (task: TeamTaskView): TeamTaskId[] =>
      live.flatMap(candidate => (candidate.blockedBy.includes(task.id) ? [candidate.id] : []))
    around = {
      task: focused.id,
      upstream: take(reach(focused, bounds.hops, task => task.blockedBy, byId)),
      downstream: take(reach(focused, bounds.hops, dependents, byId)),
    }
  }
  return {
    ready,
    running,
    lost,
    blocked: live.filter(task => task.status === 'pending' && !task.ready).length,
    completed: live.filter(task => task.status === 'completed').length,
    ...cut.any ? { truncated: true } : {},
    ...around === undefined ? {} : { around },
    members: members.map(member => ({
      target: member.name,
      status: member.status,
      ...member.lastStop === undefined ? {} : { lastStop: member.lastStop },
    })),
  }
}
