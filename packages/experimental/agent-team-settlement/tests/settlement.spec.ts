/** Settlement over the Team board: waiting, waking, stalling, deadlines, and disposal. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
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
  workspace?: string,
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-settlement-'))
  roots.push(storageRoot)
  if (workspace !== undefined) await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService, { trackSubagentRuns: true })
  const fiber = await ctx.plugin(Settlement, { deadlineMs: 3_600_000, stallMs: 10_000, outputs: [], ...config })
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

/** Every settlement reminder in the root's log. */
function reminders(agent: Agent) {
  return agent.session.snapshotEvents()
    .flatMap(event => event.type === 'user/message' && event.data.source.kind === 'agent-team-settlement' ? [event.data] : [])
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
  it('validates config: both windows are required and bounded', () => {
    expect(() => new Config({ deadlineMs: 1 } as never)).toThrow()
    expect(() => new Config({ deadlineMs: 2_147_483_648, stallMs: 10_000, outputs: [] })).toThrow()
    expect(new Config({ deadlineMs: 1, stallMs: 10_000 } as never)).toEqual({ deadlineMs: 1, stallMs: 10_000, outputs: [] })
    expect(() => new Config({ deadlineMs: 1, stallMs: 10_000, outputs: [{ path: 'a', kind: 'folder' }] } as never)).toThrow()
  })

  it('records the run\'s task as in-progress work owned by the root, cut to the board\'s limits', async () => {
    const { ctx, lead, begin } = await setup([])
    await begin(lead, `  ${'s'.repeat(250)}\n${'d'.repeat(20_000)}`)
    await begin(lead, 'one line')
    const [long, short] = ctx.agentTeams.listTasks(lead)
    expect(long).toMatchObject({ status: 'in_progress', ownerName: 'lead', subject: 's'.repeat(200) })
    expect(long!.description).toHaveLength(16_384)
    expect(short).toMatchObject({ status: 'in_progress', subject: 'one line', description: 'one line' })
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
      unsettled: [`${task!.id} "the request" owned by lead: no turn ran`],
    })
    expect(ctx.agentTeams.getTask(lead, task!.id)).toMatchObject({ status: 'lost', lostCause: 'owner-failed' })
  })

  it('loses the run\'s task when the root\'s turn did not complete', async () => {
    const { ctx, lead, begin } = await setup([maxTokensResponse('cut off')])
    const run = await begin(lead)
    lead.followup(prompt('the request'))
    const [task] = ctx.agentTeams.listTasks(lead)
    await expect(run.settle()).resolves.toEqual({
      unsettled: [`${task!.id} "the request" owned by lead: the turn ended max-tokens`],
    })
    expect(ctx.agentTeams.getTask(lead, task!.id)).toMatchObject({ status: 'lost', lostCause: 'owner-failed' })
  })

  it('reminds the root once to complete a run\'s task that declares outputs, then loses it', async () => {
    const { ctx, lead, begin } = await setup(
      [textResponse('done'), textResponse('still done')],
      { outputs: [{ path: 'out/result.json', kind: 'json' }] },
    )
    const run = await begin(lead)
    lead.followup(prompt('the request'))
    const [task] = ctx.agentTeams.listTasks(lead)
    expect(task).toMatchObject({ status: 'in_progress', outputs: [{ path: 'out/result.json', kind: 'json' }] })
    await expect(run.settle()).resolves.toEqual({
      unsettled: [
        `${task!.id} "the request" owned by lead: the turn completed without completing the task and its declared outputs, after one reminder`,
      ],
    })
    expect(ctx.agentTeams.getTask(lead, task!.id)).toMatchObject({ status: 'lost', lostCause: 'owner-failed' })
    expect(reminders(lead)).toHaveLength(1)
    const [reminder] = reminders(lead)
    expect(reminder!.source).toMatchObject({
      taskId: task!.id, form: 'notice', summary: `reminded to complete ${task!.id} and its declared outputs`,
    })
    expect(reminder!.content).toEqual([{
      type: 'text',
      text: `Your turn ended, but task ${task!.id}, which this run was started with and you own, is still in progress. `
        + 'It declares outputs that are checked on disk: out/result.json. '
        + `Produce them, then call team_task_update with action complete on ${task!.id} at revision 1. `
        + 'This reminder is sent once; if your next turn ends with the task still in progress, the run records it as lost.',
    }])
  })

  it('accepts a run\'s task with declared outputs that the root completes after the reminder', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-team-settlement-workspace-'))
    roots.push(workspace)
    const { ctx, lead, begin } = await setup(
      [textResponse('done'), 'hang'],
      { outputs: [{ path: 'result.txt', kind: 'file' }] },
      workspace,
    )
    const run = await begin(lead)
    lead.followup(prompt('the request'))
    const [task] = ctx.agentTeams.listTasks(lead)
    const settled = run.settle()
    await vi.waitFor(() => {
      expect(reminders(lead)).toHaveLength(1)
    }, { timeout: 5_000 })
    writeFileSync(join(workspace, 'result.txt'), 'the result')
    await ctx.agentTeams.updateTask(lead, { taskId: task!.id, expectedRevision: task!.revision, action: 'complete' })
    lead.cancel({ kind: 'user' })
    await expect(settled).resolves.toEqual({ unsettled: [] })
    expect(ctx.agentTeams.getTask(lead, task!.id)).toMatchObject({ status: 'completed', artifacts: [{ path: 'result.txt', bytes: 10 }] })
  })

  it('accepts a run\'s task the root completed itself and reports one it moved out of progress', async () => {
    const { ctx, lead, begin } = await setup([])
    const completed = await begin(lead, 'completed by the root')
    const released = await begin(lead, 'released by the root')
    const [first, second] = ctx.agentTeams.listTasks(lead)
    await ctx.agentTeams.updateTask(lead, { taskId: first!.id, expectedRevision: first!.revision, action: 'complete' })
    await ctx.agentTeams.updateTask(lead, { taskId: second!.id, expectedRevision: second!.revision, action: 'release' })
    await expect(completed.settle()).resolves.toEqual({ unsettled: [] })
    await expect(released.settle()).resolves.toEqual({
      unsettled: [`${second!.id} "released by the root": the run's task was left pending`],
    })
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
    const why = 'its owner was not running and nothing changed for 10000 ms'
    await expect(settled).resolves.toEqual({
      unsettled: [`${own!.id} "the request" owned by lead: ${why}`, `${task.id} "held by lead" owned by lead: ${why}`],
    })
    expect(ctx.agentTeams.getTask(lead, own!.id)).toMatchObject({ status: 'lost', lostCause: 'run-ended' })
    expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ lostCause: 'run-ended', ownerName: 'lead' })
  })

  it('keeps waiting on a running owner until the deadline, then marks its task lost', async () => {
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
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('lost')
    })
    const why = 'still in progress at the 15000 ms deadline'
    await expect(settled).resolves.toEqual({
      unsettled: [`${own!.id} "the request" owned by lead: ${why}`, `${task.id} "long" owned by mate: ${why}`],
    })
    vi.useRealTimers()
    ctx.agentTeams.interrupt(lead, 'mate')
    await vi.waitFor(() => { expect(ctx.agents.get(mate.id)).toBeUndefined() }, { timeout: 5_000 })
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
      unsettled: [`${own!.id} "the request" owned by lead: still in progress at the 15000 ms deadline`],
    })
    expect(lead.status).toBe('idle')
    expect(ctx.agentTeams.getTask(lead, own!.id)).toMatchObject({ status: 'lost', lostCause: 'run-ended' })
  })

  it('does not report a task whose owner finished while it was being abandoned', async () => {
    const { ctx, lead, begin } = await setup([], { deadlineMs: 1 })
    const run = await begin(lead)
    const [own] = ctx.agentTeams.listTasks(lead)
    const second = await ctx.agentTeams.createTask(lead, { subject: 'second', description: 'second' })
    await ctx.agentTeams.updateTask(lead, { taskId: second.id, expectedRevision: second.revision, action: 'claim' })
    vi.spyOn(ctx.agentTeams, 'markLost').mockRejectedValueOnce(
      new TeamError('completed first', 'TEAM_TASK_INVALID_TRANSITION'),
    )
    vi.useFakeTimers()
    const settled = run.settle()
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.agentTeams.getTask(lead, second.id).status).toBe('lost')
    })
    await expect(settled).resolves.toEqual({
      unsettled: [`${second.id} "second" owned by lead: still in progress at the 1 ms deadline`],
    })
    expect(ctx.agentTeams.getTask(lead, TeamTaskId(own!.id)).status).toBe('in_progress')
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
    vi.useFakeTimers()
    const settled = run.settle()
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ctx.agentTeams.getTask(lead, third!.id).status).toBe('lost')
    })
    await expect(settled).resolves.toEqual({
      unsettled: [
        `${first!.id} "first" owned by lead: still in progress at the 1 ms deadline; recording it as lost failed: disk full`,
        `${second!.id} "second" owned by lead: still in progress at the 1 ms deadline; recording it as lost failed: refused`,
        `${third!.id} "third" owned by lead: still in progress at the 1 ms deadline`,
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
