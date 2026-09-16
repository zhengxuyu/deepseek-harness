/** Settlement over the Team board: waiting, waking, stalling, deadlines, and disposal. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService, { TeamError, TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Settlement from '../src/index.ts'
import { Config } from '../src/index.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  config: Partial<Settlement.Config> = {},
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-settlement-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService, { trackSubagentRuns: true })
  const fiber = await ctx.plugin(Settlement, { deadlineMs: 3_600_000, stallMs: 10_000, ...config })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const lead = ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  const settle = (root: Agent) => {
    const settlement = ctx.get('headlessSettlement')
    if (settlement === undefined) throw new Error('settlement not provided')
    return settlement.settle(root)
  }
  return { ctx, lead, fiber, settle }
}

function content(text: string) {
  return [{ type: 'text' as const, text }]
}

async function spawnTeammate(ctx: Context, lead: Agent, name: string): Promise<Agent> {
  const started = await ctx.agentTeams.spawnTeammate(lead, {
    name, description: `${name} responsibility`, prompt: content(`${name} initial`), context: 'fresh', provider: 'spawn', signal: SIGNAL,
  })
  return vi.waitFor(() => {
    const agent = ctx.agents.get(started.member.id)
    expect(agent?.status).toBe('running')
    return agent!
  }, { timeout: 5_000 })
}

describe('agent-team-settlement', () => {
  it('validates config: both windows are required and the stall window is a wait bound', () => {
    expect(() => new Config({ deadlineMs: 1 } as never)).toThrow()
    expect(() => new Config({ deadlineMs: 1, stallMs: 9_999 })).toThrow()
    expect(new Config({ deadlineMs: 1, stallMs: 10_000 })).toEqual({ deadlineMs: 1, stallMs: 10_000 })
  })

  it('returns at once when the idle root has nothing outstanding, and unregisters on dispose', async () => {
    const { ctx, lead, fiber, settle } = await setup([])
    await expect(settle(lead)).resolves.toEqual({ unsettled: [] })
    await fiber.dispose()
    expect(ctx.get('headlessSettlement')).toBeUndefined()
  })

  it('follows a delegated run to completion and lets its notice run the root again', async () => {
    const { ctx, lead, settle } = await setup([
      textResponse('child done'),
      textResponse('root closes after the notice'),
    ])
    const controller = new AbortController()
    const run = await ctx.subagents.start('spawn', {
      prompt: content('delegated'), parent: lead, signal: controller.signal,
    })
    await vi.waitFor(() => { expect(ctx.agentTeams.outstandingTasks(lead)).toHaveLength(1) })
    const settled = settle(lead)
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    // The root is woken exactly as a settlement notice would wake it.
    lead.followup(createUserMessage({ content: content('notice'), source: { kind: 'user' } }))
    await run.dispose()
    await expect(settled).resolves.toEqual({ unsettled: [] })
    expect(lead.status).toBe('idle')
    expect(ctx.agentTeams.listTasks(lead)).toMatchObject([{ status: 'completed' }])
  })

  it('follows a turn already running at the root before judging the board', async () => {
    const { ctx, lead, settle } = await setup([textResponse('queued turn ran')])
    lead.followup(createUserMessage({ content: content('queued before settle'), source: { kind: 'user' } }))
    expect(lead.status).toBe('running')
    await expect(settle(lead)).resolves.toEqual({ unsettled: [] })
    expect(lead.status).toBe('idle')
    expect(lead.session.events.some(event => event.type === 'turn/end')).toBe(true)
    expect(ctx.agentTeams.outstandingTasks(lead)).toEqual([])
  })

  it('marks Lead-held work lost after a stall with nothing running', async () => {
    const { ctx, lead, settle } = await setup([])
    const task = await ctx.agentTeams.createTask(lead, { subject: 'held by lead', description: 'held' })
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    vi.useFakeTimers()
    const settled = settle(lead)
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('lost')
    })
    await expect(settled).resolves.toEqual({
      unsettled: [`${task.id} "held by lead" owned by lead: its owner was not running and nothing changed for 10000 ms`],
    })
    expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ lostCause: 'run-ended', ownerName: 'lead' })
  })

  it('keeps waiting on a running owner until the deadline, then marks its task lost', async () => {
    const { ctx, lead, settle } = await setup(['hang'], { deadlineMs: 15_000 })
    const mate = await spawnTeammate(ctx, lead, 'mate')
    const task = await ctx.agentTeams.createTask(lead, { subject: 'long', description: 'long' })
    await ctx.agentTeams.updateTask(mate, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    vi.useFakeTimers()
    const settled = settle(lead)
    // A stall window passes with the owner still running: not a stall.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('in_progress')
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('lost')
    })
    await expect(settled).resolves.toEqual({
      unsettled: [`${task.id} "long" owned by mate: still in progress at the 15000 ms deadline`],
    })
    vi.useRealTimers()
    ctx.agentTeams.interrupt(lead, 'mate')
    await vi.waitFor(() => { expect(ctx.agents.get(mate.id)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('does not report a task whose owner finished while it was being abandoned', async () => {
    const { ctx, lead, settle } = await setup([], { deadlineMs: 1 })
    const first = await ctx.agentTeams.createTask(lead, { subject: 'first', description: 'first' })
    const second = await ctx.agentTeams.createTask(lead, { subject: 'second', description: 'second' })
    for (const task of [first, second]) {
      await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    }
    vi.spyOn(ctx.agentTeams, 'markLost').mockRejectedValueOnce(
      new TeamError('completed first', 'TEAM_TASK_INVALID_TRANSITION'),
    )
    vi.useFakeTimers()
    const settled = settle(lead)
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.agentTeams.getTask(lead, second.id).status).toBe('lost')
    })
    await expect(settled).resolves.toEqual({
      unsettled: [`${second.id} "second" owned by lead: still in progress at the 1 ms deadline`],
    })
    expect(ctx.agentTeams.getTask(lead, TeamTaskId(first.id)).status).toBe('in_progress')
  })

  it('abandons its wait when the plugin is disposed', async () => {
    const { ctx, lead, fiber, settle } = await setup([])
    const task = await ctx.agentTeams.createTask(lead, { subject: 'waiting', description: 'waiting' })
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    const settled = settle(lead)
    await new Promise(resolve => setTimeout(resolve, 5))
    await fiber.dispose()
    await expect(settled).rejects.toThrow('agent-team-settlement disposed')
    expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('in_progress')
  })
})
