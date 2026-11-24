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
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
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
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService, { trackSubagentRuns: true })
  const fiber = await ctx.plugin(Settlement, { deadlineMs: 3_600_000, stallMs: 10_000, stopGraceMs: 5_000, ...config })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  const begin = (root: Agent, task = 'the request') => {
    const settlement = ctx.get('headlessSettlement')
    if (settlement === undefined) throw new Error('settlement not provided')
    return settlement.begin(root, task)
  }
  return { ctx, lead, fiber, begin }
}

function prompt(text: string) {
  return createUserMessage({ content: content(text), source: { kind: 'user' } })
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
  it('validates config: all three windows are required and bounded', () => {
    expect(() => new Config({ deadlineMs: 1 } as never)).toThrow()
    expect(() => new Config({ deadlineMs: 1, stallMs: 10_000 } as never)).toThrow()
    expect(() => new Config({ deadlineMs: 2_147_483_648, stallMs: 10_000, stopGraceMs: 1 })).toThrow()
    expect(new Config({ deadlineMs: 1, stallMs: 10_000, stopGraceMs: 1 })).toEqual({ deadlineMs: 1, stallMs: 10_000, stopGraceMs: 1 })
  })

  it('records the run\'s task as in-progress work owned by the root, cut to the board\'s limits', async () => {
    const long = await setup([])
    await long.begin(long.lead, `  ${'s'.repeat(250)}\n${'d'.repeat(20_000)}`)
    const [cut] = long.ctx.agentTeams.listTasks(long.lead)
    expect(cut).toMatchObject({ status: 'in_progress', ownerName: 'lead', subject: 's'.repeat(200) })
    expect(cut!.description).toHaveLength(16_384)
    const short = await setup([])
    await short.begin(short.lead, 'one line')
    expect(short.ctx.agentTeams.listTasks(short.lead)).toMatchObject([
      { status: 'in_progress', subject: 'one line', description: 'one line' },
    ])
  })

  it('completes the run\'s task when the root\'s turn completed with nothing else outstanding, and unregisters on dispose', async () => {
    const { ctx, lead, fiber, begin } = await setup([textResponse('done')])
    const run = await begin(lead)
    lead.followup(prompt('the request'))
    await expect(run.settle()).resolves.toEqual({ unsettled: [] })
    expect(ctx.agentTeams.listTasks(lead)).toMatchObject([{ status: 'completed', ownerName: 'lead' }])
    await fiber.dispose()
    expect(ctx.get('headlessSettlement')).toBeUndefined()
  })

  it('loses the run\'s task when the root never ran a turn', async () => {
    const { ctx, lead, begin } = await setup([])
    const run = await begin(lead)
    const [task] = ctx.agentTeams.listTasks(lead)
    await expect(run.settle()).resolves.toEqual({
      unsettled: [{ id: task!.id, subject: 'the request', owner: 'lead', state: 'lost', reason: 'no turn ran' }],
    })
    expect(ctx.agentTeams.getTask(lead, task!.id)).toMatchObject({ status: 'lost', lostCause: 'owner-failed' })
  })

  it('loses the run\'s task when the root\'s turn did not complete', async () => {
    const { ctx, lead, begin } = await setup([maxTokensResponse('cut off')])
    const run = await begin(lead)
    lead.followup(prompt('the request'))
    const [task] = ctx.agentTeams.listTasks(lead)
    await expect(run.settle()).resolves.toEqual({
      unsettled: [{ id: task!.id, subject: 'the request', owner: 'lead', state: 'lost', reason: 'the turn ended max-tokens' }],
    })
    expect(ctx.agentTeams.getTask(lead, task!.id)).toMatchObject({ status: 'lost', lostCause: 'owner-failed' })
  })

  it('accepts a run\'s task the root completed or deleted itself and reports one it left pending', async () => {
    const completed = await setup([])
    const completedRun = await completed.begin(completed.lead, 'completed by the root')
    const [first] = completed.ctx.agentTeams.listTasks(completed.lead)
    await completed.ctx.agentTeams.updateTask(completed.lead, { taskId: first!.id, expectedRevision: first!.revision, action: 'complete' })
    await expect(completedRun.settle()).resolves.toEqual({ unsettled: [] })

    const released = await setup([])
    const releasedRun = await released.begin(released.lead, 'released by the root')
    const [second] = released.ctx.agentTeams.listTasks(released.lead)
    const pending = await released.ctx.agentTeams.updateTask(released.lead, { taskId: second!.id, expectedRevision: second!.revision, action: 'release' })
    await expect(releasedRun.settle()).resolves.toEqual({
      unsettled: [{ id: second!.id, subject: 'released by the root', state: 'pending', reason: 'the run\'s task was left pending' }],
    })

    const deleted = await setup([])
    const deletedRun = await deleted.begin(deleted.lead, 'deleted by the root')
    const [third] = deleted.ctx.agentTeams.listTasks(deleted.lead)
    const open = await deleted.ctx.agentTeams.updateTask(deleted.lead, { taskId: third!.id, expectedRevision: third!.revision, action: 'release' })
    await deleted.ctx.agentTeams.updateTask(deleted.lead, { taskId: open.id, expectedRevision: open.revision, action: 'delete' })
    await expect(deletedRun.settle()).resolves.toEqual({ unsettled: [] })
    expect(pending.status).toBe('pending')
  })

  it('reports a task nobody started and a task whose owner stopped without completing it', async () => {
    const { ctx, lead, begin } = await setup([textResponse('done')])
    const run = await begin(lead)
    const idle = await ctx.agentTeams.createTask(lead, { subject: 'never started', description: 'never started' })
    const held = await ctx.agentTeams.createTask(lead, { subject: 'dropped', description: 'dropped' })
    await ctx.agentTeams.updateTask(lead, { taskId: held.id, expectedRevision: held.revision, action: 'claim' })
    await ctx.agentTeams.markLost(lead, held.id, 'owner-failed')
    lead.followup(prompt('the request'))
    await expect(run.settle()).resolves.toEqual({
      unsettled: [
        { id: idle.id, subject: 'never started', state: 'pending', reason: 'nobody is working on it' },
        { id: held.id, subject: 'dropped', owner: 'lead', state: 'lost', reason: 'its owner stopped without completing it' },
      ],
    })
    expect(ctx.agentTeams.listTasks(lead)[0]).toMatchObject({ status: 'completed' })
  })

  it('marks work left in progress by an earlier process lost, and reports only what this run touched', async () => {
    const { ctx, lead, begin } = await setup([textResponse('done')])
    const stale = await ctx.agentTeams.beginTask(lead, { subject: 'earlier run', description: 'earlier run' })
    const untouched = await ctx.agentTeams.createTask(lead, { subject: 'earlier pending', description: 'earlier pending' })
    const edited = await ctx.agentTeams.createTask(lead, { subject: 'earlier edited', description: 'earlier edited' })
    const run = await begin(lead)
    expect(ctx.agentTeams.getTask(lead, stale.id)).toMatchObject({ status: 'lost', lostCause: 'run-ended' })
    await ctx.agentTeams.updateTask(lead, { taskId: edited.id, expectedRevision: edited.revision, action: 'edit', subject: 'edited now' })
    lead.followup(prompt('the request'))
    await expect(run.settle()).resolves.toEqual({
      unsettled: [{ id: edited.id, subject: 'edited now', state: 'pending', reason: 'nobody is working on it' }],
    })
    expect(ctx.agentTeams.getTask(lead, untouched.id).status).toBe('pending')
  })

  it('follows a delegated run to completion and lets its notice run the root again', async () => {
    const { ctx, lead, begin } = await setup([
      textResponse('child done'),
      textResponse('root closes after the notice'),
    ])
    const followed = await begin(lead)
    const controller = new AbortController()
    const run = await ctx.subagents.start('spawn', {
      prompt: content('delegated'), parent: lead, signal: controller.signal,
    })
    await vi.waitFor(() => { expect(ctx.agentTeams.outstandingTasks(lead)).toHaveLength(2) })
    const settled = followed.settle()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    // The root is woken exactly as a settlement notice would wake it.
    lead.followup(prompt('notice'))
    await run.dispose()
    await expect(settled).resolves.toEqual({ unsettled: [] })
    expect(lead.status).toBe('idle')
    expect(ctx.agentTeams.listTasks(lead)).toMatchObject([{ status: 'completed' }, { status: 'completed' }])
  })

  it('marks the run\'s task and other Lead-held work lost after a stall with nothing running', async () => {
    const { ctx, lead, begin } = await setup([])
    const run = await begin(lead)
    const [own] = ctx.agentTeams.listTasks(lead)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'held by lead', description: 'held' })
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    vi.useFakeTimers()
    const settled = run.settle()
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('lost')
    })
    const reason = 'its owner was not running and nothing changed for 10000 ms'
    await expect(settled).resolves.toEqual({
      unsettled: [
        { id: own!.id, subject: 'the request', owner: 'lead', state: 'lost', reason },
        { id: task.id, subject: 'held by lead', owner: 'lead', state: 'lost', reason },
      ],
    })
    expect(ctx.agentTeams.getTask(lead, own!.id)).toMatchObject({ status: 'lost', lostCause: 'run-ended' })
    expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ lostCause: 'run-ended', ownerName: 'lead' })
  })

  it('ends at the deadline, not as a stall, when less than a stall window remains', async () => {
    const { ctx, lead, begin } = await setup([], { deadlineMs: 4_000 })
    const run = await begin(lead)
    const [own] = ctx.agentTeams.listTasks(lead)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'held by lead', description: 'held' })
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    vi.useFakeTimers()
    const settled = run.settle()
    await vi.advanceTimersByTimeAsync(3_999)
    expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('in_progress')
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1)
      expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('lost')
    })
    const reason = 'still in progress at the 4000 ms deadline'
    await expect(settled).resolves.toEqual({
      unsettled: [
        { id: own!.id, subject: 'the request', owner: 'lead', state: 'lost', reason },
        { id: task.id, subject: 'held by lead', owner: 'lead', state: 'lost', reason },
      ],
    })
  })

  it('keeps waiting on a running owner until the deadline, then interrupts it and marks its task lost', async () => {
    const { ctx, lead, begin } = await setup(['hang'], { deadlineMs: 15_000 })
    const run = await begin(lead)
    const [own] = ctx.agentTeams.listTasks(lead)
    const mate = await spawnTeammate(ctx, lead, 'mate')
    const task = await ctx.agentTeams.createTask(lead, { subject: 'long', description: 'long' })
    await ctx.agentTeams.updateTask(mate, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    vi.useFakeTimers()
    const settled = run.settle()
    // A stall window passes with the owner still running: not a stall.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('in_progress')
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    const reason = 'still in progress at the 15000 ms deadline'
    await expect(settled).resolves.toEqual({
      unsettled: [
        { id: own!.id, subject: 'the request', owner: 'lead', state: 'lost', reason },
        { id: task.id, subject: 'long', owner: 'mate', state: 'lost', reason },
      ],
    })
    // The deadline stopped the teammate's turn; nothing is left running.
    expect(mate.status).not.toBe('running')
    expect(ctx.agentTeams.listMembers(lead).find(member => member.name === 'mate')?.status).toBe('inactive')
    await vi.waitFor(() => { expect(ctx.agents.get(mate.id)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('reports without a member that has not stopped when the stop window passes', async () => {
    const { ctx, lead, begin } = await setup([], { deadlineMs: 1, stopGraceMs: 2_000 })
    const run = await begin(lead)
    const [own] = ctx.agentTeams.listTasks(lead)
    vi.spyOn(ctx.agentTeams, 'interruptTeammates').mockReturnValue(new Promise(() => undefined))
    vi.useFakeTimers()
    const settled = run.settle()
    await vi.advanceTimersByTimeAsync(2_001)
    vi.useRealTimers()
    await expect(settled).resolves.toEqual({
      unsettled: [{
        id: own!.id,
        subject: 'the request',
        owner: 'lead',
        state: 'lost',
        reason: 'still in progress at the 1 ms deadline; its owner had not stopped 2000 ms after the deadline',
      }],
    })
  })

  it('cancels a root turn still running at the deadline and marks the run\'s task lost', async () => {
    const { ctx, lead, begin } = await setup(['hang'], { deadlineMs: 15_000 })
    const run = await begin(lead)
    const [own] = ctx.agentTeams.listTasks(lead)
    lead.followup(prompt('the request'))
    await vi.waitFor(() => { expect(lead.status).toBe('running') })
    vi.useFakeTimers()
    const settled = run.settle()
    await vi.advanceTimersByTimeAsync(15_000)
    vi.useRealTimers()
    await expect(settled).resolves.toEqual({
      unsettled: [{
        id: own!.id, subject: 'the request', owner: 'lead', state: 'lost', reason: 'still in progress at the 15000 ms deadline',
      }],
    })
    expect(lead.status).toBe('idle')
    expect(ctx.agentTeams.getTask(lead, own!.id)).toMatchObject({ status: 'lost', lostCause: 'run-ended' })
  })

  it('reports a task by the state its owner left it in while it was being abandoned', async () => {
    const { ctx, lead, begin } = await setup([], { deadlineMs: 1 })
    const run = await begin(lead)
    const [own] = ctx.agentTeams.listTasks(lead)
    const tasks = []
    for (const subject of ['completed first', 'released first', 'unchanged']) {
      const task = await ctx.agentTeams.createTask(lead, { subject, description: subject })
      tasks.push(await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' }))
    }
    const [completed, released, unchanged] = tasks
    const markLost = ctx.agentTeams.markLost.bind(ctx.agentTeams)
    const refused = new TeamError('left in progress first', 'TEAM_TASK_INVALID_TRANSITION')
    vi.spyOn(ctx.agentTeams, 'markLost').mockImplementation(async (caller, id, cause) => {
      if (id === completed!.id) {
        await ctx.agentTeams.markCompleted(caller, id)
        throw refused
      }
      if (id === released!.id) {
        await ctx.agentTeams.updateTask(caller, { taskId: id, expectedRevision: released!.revision, action: 'release' })
        throw refused
      }
      if (id === unchanged!.id) throw refused
      return await markLost(caller, id, cause)
    })
    await expect(run.settle()).resolves.toEqual({
      unsettled: [
        { id: own!.id, subject: 'the request', owner: 'lead', state: 'lost', reason: 'still in progress at the 1 ms deadline' },
        { id: released!.id, subject: 'released first', state: 'pending', reason: 'nobody is working on it' },
        { id: unchanged!.id, subject: 'unchanged', owner: 'lead', state: 'in_progress', reason: 'it was left in progress' },
      ],
    })
    expect(ctx.agentTeams.getTask(lead, TeamTaskId(completed!.id)).status).toBe('completed')
  })

  it('reports a task whose lost mark failed, and still marks the tasks after it', async () => {
    const { ctx, lead, begin } = await setup([], { deadlineMs: 1 })
    const run = await begin(lead, 'first')
    const [first] = ctx.agentTeams.listTasks(lead)
    const tasks = []
    for (const subject of ['second', 'third']) {
      const task = await ctx.agentTeams.createTask(lead, { subject, description: subject })
      await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
      tasks.push(task)
    }
    const [second, third] = tasks
    vi.spyOn(ctx.agentTeams, 'markLost')
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce('refused')
    const reason = 'still in progress at the 1 ms deadline'
    await expect(run.settle()).resolves.toEqual({
      unsettled: [
        { id: first!.id, subject: 'first', owner: 'lead', state: 'in_progress', reason: `${reason}; recording it as lost failed: disk full` },
        { id: second!.id, subject: 'second', owner: 'lead', state: 'in_progress', reason: `${reason}; recording it as lost failed: refused` },
        { id: third!.id, subject: 'third', owner: 'lead', state: 'lost', reason },
      ],
    })
    expect(ctx.agentTeams.getTask(lead, first!.id).status).toBe('in_progress')
  })

  it('abandons its wait when the plugin is disposed', async () => {
    const { ctx, lead, fiber, begin } = await setup([])
    const run = await begin(lead)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'waiting', description: 'waiting' })
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    const settled = run.settle()
    await new Promise(resolve => setTimeout(resolve, 5))
    await fiber.dispose()
    await expect(settled).rejects.toThrow('agent-team-settlement disposed')
    expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('in_progress')
  })
})
