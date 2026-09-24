import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { frontier } from '../src/frontier.ts'

function task(id: string, patch: Partial<TeamTaskView> = {}): TeamTaskView {
  return {
    id: TeamTaskId(id),
    revision: 1,
    subject: `subject ${id}`,
    description: 'd',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    outputs: [],
    ready: true,
    writeScopeWarnings: [],
    ...patch,
  }
}

const members: TeamMemberView[] = [
  { id: brandString<SessionId>('lead'), name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
  { id: brandString<SessionId>('mate'), name: 'mate', role: 'teammate', status: 'inactive', diagnostics: [], lastStop: 'completed' },
]

describe('frontier', () => {
  const chain = [
    task('task-1', { status: 'completed', artifacts: [{ path: 'a', bytes: 1, sha256: 'x' }], outputs: [{ path: 'a', kind: 'file' }] }),
    task('task-2', { status: 'in_progress', ownerName: 'mate', blockedBy: [TeamTaskId('task-1')] }),
    task('task-3', { blockedBy: [TeamTaskId('task-2')], ready: false }),
    task('task-4', { blockedBy: [TeamTaskId('task-3')], ready: false }),
    task('task-5', { status: 'lost', ownerName: 'gone', lostCause: 'owner-failed' }),
    task('task-6'),
    task('task-7', { status: 'deleted' }),
  ]

  it('lists ready, running, and lost rows with counts and member statuses', () => {
    expect(frontier(chain, members, { hops: 1, rows: 20 })).toEqual({
      ready: [{ id: 'task-6', subject: 'subject task-6', status: 'pending', outputs: 0 }],
      running: [{ id: 'task-2', subject: 'subject task-2', status: 'in_progress', ownerName: 'mate', outputs: 0 }],
      lost: [{ id: 'task-5', subject: 'subject task-5', status: 'lost', ownerName: 'gone', outputs: 0 }],
      blocked: 2,
      completed: 1,
      members: [{ target: 'lead', status: 'running' }, { target: 'mate', status: 'inactive', lastStop: 'completed' }],
    })
  })

  it('describes the edited task\'s neighbourhood out to the configured hops, nearest first', () => {
    const one = frontier(chain, members, { hops: 1, rows: 20 }, TeamTaskId('task-3')).around
    expect(one).toEqual({
      task: 'task-3',
      upstream: [{ id: 'task-2', subject: 'subject task-2', status: 'in_progress', ownerName: 'mate', outputs: 0 }],
      downstream: [{ id: 'task-4', subject: 'subject task-4', status: 'pending', outputs: 0 }],
    })
    const two = frontier(chain, members, { hops: 2, rows: 20 }, TeamTaskId('task-3')).around
    expect(two?.upstream.map(row => row.id)).toEqual(['task-2', 'task-1'])
    expect(two?.upstream[1]).toMatchObject({ status: 'completed', outputs: 1, artifacts: 1 })
    const far = frontier(chain, members, { hops: 5, rows: 20 }, TeamTaskId('task-3')).around
    expect(far?.upstream.map(row => row.id)).toEqual(['task-2', 'task-1'])
    expect(far?.downstream.map(row => row.id)).toEqual(['task-4'])
    const orphan = [...chain, task('task-8', { blockedBy: [TeamTaskId('task-7'), TeamTaskId('task-6')], ready: false })]
    expect(frontier(orphan, members, { hops: 1, rows: 20 }, TeamTaskId('task-8')).around?.upstream.map(row => row.id)).toEqual(['task-6'])
    // A diamond reaches task-3 twice; it is listed once, at its nearest hop.
    const diamond = [...chain, task('task-9', { blockedBy: [TeamTaskId('task-3'), TeamTaskId('task-4')], ready: false })]
    expect(frontier(diamond, members, { hops: 2, rows: 20 }, TeamTaskId('task-9')).around?.upstream.map(row => row.id))
      .toEqual(['task-3', 'task-4', 'task-2'])
    expect(frontier(chain, members, { hops: 0, rows: 20 }, TeamTaskId('task-3')).around).toBeUndefined()
    expect(frontier(chain, members, { hops: 1, rows: 20 }, TeamTaskId('task-7')).around).toBeUndefined()
  })

  it('cuts every list at the row bound and says so', () => {
    const wide = [task('hub'), ...Array.from({ length: 4 }, (_, index) => task(`task-${index}`, { blockedBy: [TeamTaskId('hub')], ready: false }))]
    const view = frontier(wide, [], { hops: 1, rows: 3 }, TeamTaskId('hub'))
    expect(view.ready.map(row => row.id)).toEqual(['hub'])
    expect(view.blocked).toBe(4)
    expect(view.around?.downstream).toHaveLength(3)
    expect(view.truncated).toBe(true)
    expect(frontier(wide, [], { hops: 1, rows: 4 }, TeamTaskId('hub')).truncated).toBeUndefined()
  })
})
