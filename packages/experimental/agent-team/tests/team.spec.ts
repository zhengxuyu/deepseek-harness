import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SessionLogOffset, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { deliverSubagentPrompt, type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService, { TeamError, TeamId, TeamMessageId, TeamTaskId } from '../src/index.ts'
import { pythonImports } from '../src/settle.ts'
import { TeamRuntimeLifecycle } from '../src/lifecycle.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Detached durable Team read through the same projection definition as the service. */
function durable(agent: Agent): {
  members: TeamMemberSnapshot[]
  tasks: TeamTaskSnapshot[]
  pendingMessages: TeamMessageSnapshot[]
} {
  let projected = teamProjectionDefinition.init(agent.session.header)
  for (const event of agent.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
  if (projected.failure !== undefined) throw new Error(projected.failure)
  const state = projected
  return {
    members: state.members,
    tasks: state.tasks,
    pendingMessages: state.messages.filter(message => !state.delivered.includes(message.id)),
  }
}

/** Read one stored session's full event log through a short-lived read handle. */
async function storedEvents(ctx: Context, id: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  config: ConstructorParameters<typeof TeamService>[1] = {},
  workspace?: string,
  leadCwd = true,
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-'))
  roots.push(storageRoot)
  if (workspace !== undefined) await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  const teamFiber = await ctx.plugin(TeamService, config)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(
    SessionId('lead'),
    { provider: 'mock', model: 'mock' },
    workspace !== undefined && leadCwd ? { cwd: workspace } : {},
  )
  return { ctx, lead, adapter, storageRoot, teamFiber }
}

function content(text: string) {
  return [{ type: 'text' as const, text }]
}

interface TeamServiceInternals {
  readonly roster: {
    readonly inFlightCreations: Set<Promise<unknown>>
    recordStop(root: Agent, memberId: SessionId, reason: string): Promise<boolean>
    checkpointInitialPrompt(childId: SessionId, messageId: string, signal: AbortSignal): Promise<void>
    reconcileProvisioning(root: Agent, signal: AbortSignal): Promise<void>
    liveChildrenByRoot(): Map<Agent, SessionId[]>
  }
  readonly mailbox: {
    send(caller: Agent, request: unknown): Promise<unknown>
    tryDispatch(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean>
    serializeDispatch(message: TeamMessageSnapshot, operation: () => Promise<boolean>): Promise<boolean>
    markDelivered(root: Agent, messageId: ReturnType<typeof TeamMessageId>, targetId: SessionId): Promise<void>
  }
  readonly journal: {
    state(root: Agent): unknown
  }
  readonly tasks: {
    markOwnerLost(root: Agent, ownerId: SessionId, cause: string): Promise<TeamTaskId[]>
  }
  disposeRuntime(): Promise<void>
  recoverFor(agent: Agent): Promise<void>
  scheduleRecovery(agent: Agent): void
}

/** White-box access follows the runtime owners so coverage does not widen the service API. */
function teamInternals(ctx: Context): TeamServiceInternals {
  return ctx.agentTeams as unknown as TeamServiceInternals
}

function spawn(
  ctx: Context,
  lead: Agent,
  name: string,
  options: { context?: 'fresh' | 'fork'; provider?: string } = {},
) {
  const context = options.context ?? 'fresh'
  return ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: `${name} responsibility`,
    prompt: content(`${name} initial`),
    context,
    provider: options.provider ?? (context === 'fork' ? 'fork' : 'spawn'),
    signal: SIGNAL,
  })
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const agent = ctx.agents.get(id)
    expect(agent?.status).toBe('running')
    return agent!
  }, { timeout: 5_000 })
}

describe('Team identity and provisioning', () => {
  it('rejects missing and failed authoritative Team projections', async () => {
    const first = await setup([])
    const journal = teamInternals(first.ctx).journal
    const stateOf = first.ctx.sessionProjections.stateOf.bind(first.ctx.sessionProjections)
    const stateOfSpy = vi.spyOn(first.ctx.sessionProjections, 'stateOf').mockImplementation((session, key) => (
      key === 'agentTeam' ? undefined : stateOf(session, key)
    ))
    expect(() => journal.state(first.lead)).toThrow('Agent Teams projection is not registered')
    stateOfSpy.mockImplementation((session, key) => key === 'agentTeam'
      ? { ...teamProjectionDefinition.init(session.header), failure: 'failed Team projection' }
      : stateOf(session, key))
    expect(() => journal.state(first.lead)).toThrow('failed Team projection')
    stateOfSpy.mockRestore()
  })

  it('rejects deployment limits that are not positive safe integers', async () => {
    const fields = [
      'maxMembers',
      'maxTasks',
      'maxPendingMessagesPerMember',
      'maxMessageBytes',
      'disposalTimeoutMs',
    ] as const
    for (const field of fields) {
      for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(setup([], { [field]: value })).rejects.toThrow()
      }
    }
  })

  it('supports direct-constructor defaults and recovers roots that already exist', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-direct-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    const lead = await ctx.agentLoop.create(SessionId('preexisting-lead'), {})
    const service = new TeamService(ctx)

    expect(service.listMembers(lead)).toEqual([expect.objectContaining({
      name: 'lead',
      status: 'inactive',
      diagnostics: [],
    })])
    const provisioning = {
      id: SessionId('preexisting-child'),
      name: 'preexisting-worker',
      description: 'preexisting responsibility',
      provider: 'spawn',
      context: 'fresh' as const,
      phase: 'provisioning' as const,
    }
    lead.session.append('team/member', {
      version: 2,
      teamId: TeamId(lead.id),
      member: provisioning,
    })
    expect(service.listMembers(lead)[1]).toEqual(expect.objectContaining({
      name: 'preexisting-worker',
      status: 'provisioning',
      diagnostics: [],
    }))
    expect(service.listMembers(lead)[1]).not.toHaveProperty('model')
    await Promise.resolve()
  })

  it('creates fresh and fork teammates with immutable names and bounded roster size', async () => {
    const { ctx, lead } = await setup([
      textResponse('lead answer'),
      textResponse('fork answer'),
      textResponse('fresh answer'),
    ], { maxMembers: 2 })
    lead.followup(createUserMessage({ content: content('lead turn'), source: { kind: 'user' } }))
    await lead.whenIdle()

    const forked = await spawn(ctx, lead, 'fork-worker', { context: 'fork' })
    await waitNoAgent(ctx, forked.member.id)
    const fresh = await spawn(ctx, lead, 'fresh-worker')
    await waitNoAgent(ctx, fresh.member.id)

    expect((await ctx.sessionPersistence.stat(forked.member.id))?.header.isSeeded).toBe(true)
    expect((await ctx.sessionPersistence.stat(fresh.member.id))?.header.isSeeded).toBe(false)
    expect(ctx.agentTeams.listMembers(lead).map(row => [row.name, row.context, row.status])).toEqual([
      ['lead', undefined, 'inactive'],
      ['fork-worker', 'fork', 'inactive'],
      ['fresh-worker', 'fresh', 'inactive'],
    ])
    await expect(spawn(ctx, lead, 'third-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
    await expect(spawn(ctx, lead, 'fresh-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
  })

  it('flushes the accepted child prompt before committing the active roster edge', async () => {
    const { ctx, lead } = await setup([textResponse('checkpointed child answer')])
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const order: string[] = []
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session.id === lead.id && durable(lead).members[0]?.phase === 'active') {
        order.push('lead-active')
      } else if (session.id !== lead.id) {
        order.push('child')
      }
      return flush(session)
    })

    const started = await spawn(ctx, lead, 'checkpoint-worker')
    expect(order.indexOf('child')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('child')).toBeLessThan(order.indexOf('lead-active'))
    await waitNoAgent(ctx, started.member.id)
  })

  it('checkpoints live and detached inbox receipts and aborts an unresolved checkpoint', async () => {
    const { ctx, lead } = await setup([])
    const internal = teamInternals(ctx).roster
    let liveSession: Session | undefined
    const liveFiber = await ctx.plugin(Object.assign(function checkpointFixture(childCtx: Context) {
      liveSession = childCtx.sessions.create(SessionId('checkpoint-child'))
    }, { inject: ['sessions'] }))
    if (liveSession === undefined) throw new Error('checkpoint fixture did not create its Session')
    const initial = createUserMessage({ content: content('checkpoint me'), source: { kind: 'user' } })
    const checkpoint = internal.checkpointInitialPrompt(liveSession.id, initial.id, SIGNAL)
    await Promise.resolve()
    lead.inject(createUserMessage({ content: content('unrelated progress'), source: { kind: 'user' } }))
    const unrelatedFiber = await ctx.plugin(Object.assign(function unrelatedCheckpointFixture(childCtx: Context) {
      childCtx.sessions.create(SessionId('unrelated-checkpoint-child'))
    }, { inject: ['sessions'] }))
    await unrelatedFiber.dispose()
    liveSession.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [initial],
    })
    await checkpoint
    // Live sessions persist only through an attached agent-loop writer; this
    // bare fixture session seeds its durable log directly for the cold reread.
    const persisted = await ctx.sessionPersistence.create(liveSession.header)
    await persisted.append(liveSession.snapshotEvents())
    await persisted.close()
    await liveFiber.dispose()

    await expect(internal.checkpointInitialPrompt(liveSession.id, initial.id, SIGNAL)).resolves.toBeUndefined()
    const missing = createUserMessage({ content: content('missing'), source: { kind: 'user' } })
    await expect(internal.checkpointInitialPrompt(liveSession.id, missing.id, SIGNAL))
      .rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })

    let disposedSession: Session | undefined
    const disposedFiber = await ctx.plugin(Object.assign(function disposedCheckpointFixture(childCtx: Context) {
      disposedSession = childCtx.sessions.create(SessionId('disposed-checkpoint-child'))
    }, { inject: ['sessions'] }))
    if (disposedSession === undefined) throw new Error('disposed checkpoint fixture did not create its Session')
    const disposed = internal.checkpointInitialPrompt(disposedSession.id, missing.id, SIGNAL)
    const disposedResult = expect(disposed).rejects.toThrow('not found')
    await Promise.resolve()
    await disposedFiber.dispose()
    await disposedResult

    let abortedSession: Session | undefined
    const abortedFiber = await ctx.plugin(Object.assign(function abortedCheckpointFixture(childCtx: Context) {
      abortedSession = childCtx.sessions.create(SessionId('aborted-checkpoint-child'))
    }, { inject: ['sessions'] }))
    if (abortedSession === undefined) throw new Error('aborted checkpoint fixture did not create its Session')
    const controller = new AbortController()
    const aborted = internal.checkpointInitialPrompt(abortedSession.id, missing.id, controller.signal)
    await Promise.resolve()
    controller.abort({ kind: 'test' })
    await expect(aborted).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })

    const errorController = new AbortController()
    const errorAborted = internal.checkpointInitialPrompt(abortedSession.id, missing.id, errorController.signal)
    const errorResult = expect(errorAborted).rejects.toThrow('checkpoint stopped')
    await Promise.resolve()
    errorController.abort(new Error('checkpoint stopped'))
    await errorResult
    await abortedFiber.dispose()
  })

  it('drains an accepted child when its initial durability checkpoint fails', async () => {
    const { ctx, lead } = await setup(['hang'])
    vi.spyOn(teamInternals(ctx).roster, 'checkpointInitialPrompt')
      .mockRejectedValueOnce(new Error('checkpoint failed'))

    await expect(spawn(ctx, lead, 'checkpoint-failure')).rejects.toThrow('checkpoint failed')
    const member = durable(lead).members[0]
    expect(member).toMatchObject({ phase: 'failed', error: 'checkpoint failed' })
    if (member !== undefined) await waitNoAgent(ctx, member.id)
  })

  it('records failed provisioning durably, reserves its name, and counts it against the limit', async () => {
    const { ctx, lead } = await setup([], { maxMembers: 1 })
    await expect(spawn(ctx, lead, 'failed-worker', { provider: 'missing' })).rejects.toThrow()

    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({
      name: 'failed-worker',
      status: 'failed',
      provider: 'missing',
    })
    await expect(spawn(ctx, lead, 'failed-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
    await expect(spawn(ctx, lead, 'other-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
  })

  it('records non-Error provider failures and contains a reversed provisioning settlement race', async () => {
    const first = await setup([])
    vi.spyOn(first.ctx.subagents, 'startContinuable').mockRejectedValueOnce('string provider failure')
    await expect(spawn(first.ctx, first.lead, 'string-failure')).rejects.toBe('string provider failure')
    expect(first.ctx.agentTeams.listMembers(first.lead)[1]).toMatchObject({
      status: 'failed',
      diagnostics: ['string provider failure'],
    })
    await expect(first.ctx.agentTeams.sendMessage(first.lead, {
      target: 'string-failure', content: content('cannot deliver'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })

    const second = await setup([])
    vi.spyOn(second.ctx.subagents, 'startContinuable').mockImplementationOnce(async () => {
      const provisioning = durable(second.lead).members[0]
      if (provisioning === undefined) throw new Error('missing provisioning edge')
      second.lead.session.append('team/member', {
        version: 2,
        teamId: TeamId(second.lead.id),
        member: { ...provisioning, phase: 'active' },
      })
      await second.ctx.sessions.flush(second.lead.session)
      throw new Error('creator failed after recovery settled active')
    })
    await expect(spawn(second.ctx, second.lead, 'reverse-race')).rejects.toBeInstanceOf(AggregateError)
    expect(durable(second.lead).members[0]?.phase).toBe('active')
  })

  it('cleans up a child when recovery settles its provisioning record first', async () => {
    const { ctx, lead } = await setup(['hang'])
    const start = ctx.subagents.startContinuable.bind(ctx.subagents)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let childId: SessionId | undefined
    vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      childId = spec.childId
      entered.resolve(undefined)
      await release.promise
      return start(spec)
    })

    const spawning = spawn(ctx, lead, 'racing-worker')
    const rejected = expect(spawning).rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    await entered.promise
    await teamInternals(ctx).roster.reconcileProvisioning(lead, SIGNAL)
    expect(durable(lead).members[0]?.phase).toBe('failed')

    release.resolve(undefined)
    await rejected
    if (childId === undefined) throw new Error('reserved child id was not observed')
    await waitNoAgent(ctx, childId)
  })

  it('handles a continuation that settles before the active roster view or conflict cleanup lookup', async () => {
    const first = await setup([])
    vi.spyOn(teamInternals(first.ctx).roster, 'checkpointInitialPrompt').mockResolvedValueOnce()
    vi.spyOn(first.ctx.subagents, 'startContinuable').mockImplementationOnce(async spec => ({
      childId: spec.childId!,
      messageId: createUserMessage({ content: content('accepted'), source: { kind: 'user' } }).id,
    }))
    const inactive = await spawn(first.ctx, first.lead, 'instant-worker')
    expect(inactive.member).toMatchObject({ status: 'inactive', diagnostics: [] })
    expect(inactive.member).not.toHaveProperty('model')

    const second = await setup([])
    vi.spyOn(teamInternals(second.ctx).roster, 'checkpointInitialPrompt').mockResolvedValueOnce()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(second.ctx.subagents, 'startContinuable').mockImplementationOnce(async (spec) => {
      entered.resolve(undefined)
      await release.promise
      return {
        childId: spec.childId!,
        messageId: createUserMessage({ content: content('accepted'), source: { kind: 'user' } }).id,
      }
    })
    const spawning = spawn(second.ctx, second.lead, 'instant-conflict')
    const rejected = expect(spawning).rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    await entered.promise
    await teamInternals(second.ctx).roster.reconcileProvisioning(second.lead, SIGNAL)
    release.resolve(undefined)
    await rejected
  })

  it('validates names and permits only the Lead to create or interrupt teammates', async () => {
    const { ctx, lead } = await setup(['hang'])
    for (const name of ['Lead', 'lead', '-bad', 'bad-', 'bad_name', 'x'.repeat(65)]) {
      await expect(spawn(ctx, lead, name)).rejects.toMatchObject({ code: 'TEAM_INVALID_MEMBER_NAME' })
    }
    const started = await spawn(ctx, lead, 'worker')
    const worker = await waitRunning(ctx, started.member.id)
    await expect(spawn(ctx, worker, 'nested')).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    expect(() => ctx.agentTeams.interrupt(worker, 'worker')).toThrow(expect.objectContaining({ code: 'TEAM_LEAD_REQUIRED' }))
    expect(ctx.agentTeams.interrupt(lead, 'worker')).toEqual({ previousStatus: 'running' })
    await waitNoAgent(ctx, worker.id)
    expect(ctx.agentTeams.interrupt(lead, 'worker')).toEqual({ previousStatus: 'inactive' })
    expect(() => ctx.agentTeams.interrupt(lead, 'lead')).toThrow(expect.objectContaining({ code: 'TEAM_INVALID_TARGET' }))
  })

  it('validates teammate text fields and pre-provisioning cancellation', async () => {
    const { ctx, lead } = await setup([])
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'empty-description',
      description: ' ',
      prompt: content('unused'),
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'empty-provider',
      description: 'valid description',
      prompt: content('unused'),
      context: 'fresh',
      provider: ' ',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const controller = new AbortController()
    controller.abort(new TeamError('cancelled before provisioning', 'TEST_CANCELLED'))
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'cancelled-worker',
      description: 'never provisioned',
      prompt: content('unused'),
      context: 'fresh',
      provider: 'spawn',
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'TEST_CANCELLED' })
    expect(durable(lead).members).toEqual([])
  })

  it('treats an ordinary fork as a new Root Team and filters inherited Team state', async () => {
    const { ctx, lead } = await setup([])
    await ctx.agentTeams.createTask(lead, { subject: 'parent task', description: 'belongs to parent' })
    const handle = await ctx.agents.create({
      sessionId: SessionId('ordinary-fork'),
      seed: lead.session.snapshotEvents(),
      meta: { parentSession: lead.id, isSeeded: true },
      inheritedEventCount: SessionLogOffset(lead.session.seq),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    expect(ctx.agentTeams.membership(handle.agent)).toMatchObject({
      id: TeamId(handle.agent.id),
      role: 'lead',
      name: 'lead',
    })
    expect(durable(handle.agent)).toMatchObject({ members: [], tasks: [], pendingMessages: [] })
    await handle.dispose()
  })

  it('rejects stale Agent identities and non-Team subagent children', async () => {
    const { ctx, lead } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'ordinary worker',
      request: { prompt: content('ordinary'), parent: lead },
      signal: SIGNAL,
    })
    const live = ctx.agents.get(started.childId)
    if (live !== undefined) expect(ctx.agentTeams.tryMembership(live)).toBeUndefined()
    await waitNoAgent(ctx, started.childId)
    expect(() => ctx.agentTeams.membership(lead)).not.toThrow()

    const impostor = { ...lead } as Agent
    expect(ctx.agentTeams.tryMembership(impostor)).toBeUndefined()
    expect(() => ctx.agentTeams.membership(impostor)).toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))

    const orphanRoot = await ctx.agents.create({
      sessionId: SessionId('orphan-ordinary-root'),
      meta: { parentSession: SessionId('absent-parent') },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.agentTeams.membership(orphanRoot.agent)).toMatchObject({ role: 'lead', name: 'lead' })
    await orphanRoot.dispose()
  })

  it('does not reinterpret an orphaned provider child or malformed parent stream as a Team root', async () => {
    const first = await setup([textResponse('ordinary child done')])
    const parent = await first.ctx.agents.create({
      sessionId: SessionId('temporary-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await first.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'ordinary child',
      request: { prompt: content('finish'), parent: parent.agent },
      signal: SIGNAL,
    })
    await waitNoAgent(first.ctx, started.childId)
    await parent.dispose()
    const orphan = await first.ctx.agents.resume({
      resumeSessionId: started.childId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(first.ctx.agentTeams.tryMembership(orphan.agent)).toBeUndefined()
    expect(teamInternals(first.ctx).roster.liveChildrenByRoot()).toEqual(new Map())
    await orphan.dispose()

    const second = await setup([])
    const child = await second.ctx.agents.create({
      sessionId: SessionId('malformed-parent-child'),
      meta: { parentSession: second.lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const journal = teamInternals(second.ctx).journal
    const state = journal.state.bind(journal)
    journal.state = () => { throw new Error('malformed Team stream') }
    expect(second.ctx.agentTeams.tryMembership(child.agent)).toBeUndefined()
    journal.state = state
    await child.dispose()
  })
})

describe('Team shared task DAG', () => {
  it('fails loudly when the durable numeric task id space is exhausted', async () => {
    const { ctx, lead } = await setup([])
    const id = TeamTaskId(`task-${Number.MAX_SAFE_INTEGER}`)
    lead.session.append('team/task', {
      version: 2,
      teamId: TeamId(lead.id),
      task: {
        id,
        revision: 1,
        subject: 'last numeric task',
        description: 'occupies the final safe numeric task id',
        status: 'pending',
        blockedBy: [],
        writeScopes: [],
      },
    })
    await ctx.sessions.flush(lead.session)

    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'cannot allocate',
      description: 'no safe numeric task id remains',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })
  })

  it('bounds non-deleted tasks while retaining deleted task ids as tombstones', async () => {
    const { ctx, lead } = await setup([], { maxTasks: 1 })
    const first = await ctx.agentTeams.createTask(lead, { subject: 'first', description: 'first task' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'overflow', description: 'overflow task' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })

    const deleted = await ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'delete',
    })
    const second = await ctx.agentTeams.createTask(lead, { subject: 'second', description: 'second task' })
    expect(deleted.status).toBe('deleted')
    expect(second.id).toBe(TeamTaskId('task-2'))
    expect(ctx.agentTeams.getTask(lead, first.id).status).toBe('deleted')
    expect(ctx.agentTeams.listTasks(lead).map(task => task.id)).toEqual([second.id])
  })

  it('enforces CAS, ownership, dependencies, transitions, and write-scope warnings', async () => {
    const { ctx, lead } = await setup(['hang', 'hang', textResponse('beta integrated update')])
    const firstMember = await spawn(ctx, lead, 'alpha')
    const alpha = await waitRunning(ctx, firstMember.member.id)
    const secondMember = await spawn(ctx, lead, 'beta')
    const beta = await waitRunning(ctx, secondMember.member.id)

    const first = await ctx.agentTeams.createTask(alpha, {
      subject: 'first',
      description: 'first task',
      writeScopes: ['src', './src/', 'src'],
    })
    const second = await ctx.agentTeams.createTask(beta, {
      subject: 'second',
      description: 'second task',
      blockedBy: [first.id],
      writeScopes: ['src/feature'],
    })
    expect(first.writeScopes).toEqual(['src'])
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: second.revision,
      action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })

    const claimed = await ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_ALREADY_CLAIMED' })
    expect(ctx.agentTeams.getTask(beta, second.id)).toMatchObject({
      ready: false,
      writeScopeWarnings: [`write scopes overlap with ${first.id}`],
    })
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'edit',
      subject: 'stolen',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_UNAUTHORIZED' })
    await expect(ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })

    const completed = await ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'complete',
    })
    expect(completed.status).toBe('completed')
    expect(ctx.agentTeams.getTask(beta, second.id).ready).toBe(true)
    const secondClaim = await ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: second.revision,
      action: 'claim',
    })
    const released = await ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: secondClaim.revision,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 'pending', ready: true })
    expect('ownerId' in released).toBe(false)

    ctx.agentTeams.interrupt(lead, 'alpha')
    ctx.agentTeams.interrupt(lead, 'beta')
    await Promise.all([waitNoAgent(ctx, alpha.id), waitNoAgent(ctx, beta.id)])
  })

  it('rejects malformed scopes and every invalid dependency relation', async () => {
    const { ctx, lead } = await setup([])
    const first = await ctx.agentTeams.createTask(lead, { subject: 'one', description: 'one' })
    const second = await ctx.agentTeams.createTask(lead, {
      subject: 'two', description: 'two', blockedBy: [first.id],
    })
    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'bad', description: 'bad', blockedBy: [TeamTaskId('missing')],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [second.id],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [first.id],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [second.id, second.id],
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    for (const scope of ['', '.', '..', '/root', 'C:\\root', 'C:root', 'a//b', 'a/../b']) {
      await expect(ctx.agentTeams.createTask(lead, {
        subject: 'scope', description: 'scope', writeScopes: [scope],
      })).rejects.toMatchObject({ code: 'TEAM_INVALID_WRITE_SCOPE' })
    }
  })

  it('rejects incomplete mutations, invalid transitions, and deletion of a live blocker', async () => {
    const { ctx, lead } = await setup([])
    await expect(ctx.agentTeams.createTask(lead, { subject: ' ', description: 'invalid' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'invalid', description: '' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'x'.repeat(201), description: 'too long' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'blocker', description: 'blocker' })
    await ctx.agentTeams.createTask(lead, {
      subject: 'dependent', description: 'dependent', blockedBy: [blocker.id],
    })
    expect(() => ctx.agentTeams.getTask(lead, TeamTaskId('missing')))
      .toThrow(expect.objectContaining({ code: 'TEAM_TASK_NOT_FOUND' }))
    for (const action of ['release', 'complete', 'reopen'] as const) {
      await expect(ctx.agentTeams.updateTask(lead, {
        taskId: blocker.id,
        expectedRevision: blocker.revision,
        action,
      })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    }
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'edit',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'set_dependencies',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'delete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_HAS_DEPENDENTS' })
  })

  it('supports Lead reassignment, completion, reopen, and deletion permissions', async () => {
    // The reassignment mails the owner its brief; the second reply is the turn that mail resumes.
    const { ctx, lead } = await setup(['hang', textResponse('brief received')])
    const started = await spawn(ctx, lead, 'owner')
    const owner = await waitRunning(ctx, started.member.id)
    const task = await ctx.agentTeams.createTask(owner, { subject: 'lifecycle', description: 'lifecycle' })
    const assigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      owner: 'owner',
    })
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: 'reassign',
      owner: 'lead',
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    const complete = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: 'complete',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: complete.revision,
      action: 'reassign',
      owner: 'lead',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    const reopened = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: complete.revision,
      action: 'reopen',
    })
    const claimed = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: reopened.revision,
      action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'delete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    const released = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'release',
    })
    const deleted = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: released.revision,
      action: 'delete',
    })
    expect(deleted.status).toBe('deleted')
    expect(ctx.agentTeams.listTasks(lead)).toEqual([])
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: deleted.revision,
      action: 'edit',
      subject: 'late',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DELETED' })
    ctx.agentTeams.interrupt(lead, 'owner')
    // The brief mail follows the owner across the interruption and is delivered on its resumed turn.
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) }, { timeout: 5_000 })
    await vi.waitFor(() => { expect(ctx.agents.get(owner.id)?.status).not.toBe('running') }, { timeout: 5_000 })
  })

  it('covers partial edits, Lead ownership, unassignment, and blocked reassignment', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('brief received')])
    const started = await spawn(ctx, lead, 'editor')
    const editor = await waitRunning(ctx, started.member.id)
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'blocker', description: 'blocker' })
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'draft',
      description: 'draft description',
      blockedBy: [blocker.id],
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: TeamTaskId('missing-update'), expectedRevision: 1, action: 'delete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'editor',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })

    const leadClaim = await ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id, expectedRevision: blocker.revision, action: 'claim',
    })
    expect(leadClaim.ownerName).toBe('lead')
    const completedBlocker = await ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id, expectedRevision: leadClaim.revision, action: 'complete',
    })
    expect(completedBlocker.status).toBe('completed')
    const subject = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'edit', subject: 'edited subject',
    })
    const description = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: subject.revision,
      action: 'edit',
      description: 'edited description',
    })
    const scopes = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: description.revision,
      action: 'edit',
      writeScopes: ['src/nested'],
    })
    expect(scopes).toMatchObject({
      subject: 'edited subject',
      description: 'edited description',
      writeScopes: ['src/nested'],
    })
    const assigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: scopes.revision, action: 'reassign', owner: 'editor',
    })
    // The executed part of the graph is frozen: a running task keeps the text
    // and edges its owner started from, and cannot move to another member.
    await expect(ctx.agentTeams.updateTask(editor, {
      taskId: task.id, expectedRevision: assigned.revision, action: 'edit', subject: 'late edit',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    await expect(ctx.agentTeams.updateTask(editor, {
      taskId: task.id, expectedRevision: assigned.revision, action: 'set_dependencies', blockedBy: [],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: assigned.revision, action: 'reassign', owner: 'lead',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    const unassigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: assigned.revision, action: 'reassign', owner: ' ',
    })
    expect(unassigned).toMatchObject({ status: 'pending' })
    expect('ownerId' in unassigned).toBe(false)

    const broad = await ctx.agentTeams.createTask(lead, {
      subject: 'broad scope', description: 'broad scope', writeScopes: ['src'],
    })
    const narrow = await ctx.agentTeams.createTask(lead, {
      subject: 'narrow scope', description: 'narrow scope', writeScopes: ['src/nested'],
    })
    const disjoint = await ctx.agentTeams.createTask(lead, {
      subject: 'disjoint scope', description: 'disjoint scope', writeScopes: ['docs'],
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: broad.id, expectedRevision: broad.revision, action: 'claim',
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: narrow.id, expectedRevision: narrow.revision, action: 'claim',
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: disjoint.id, expectedRevision: disjoint.revision, action: 'claim',
    })
    expect(ctx.agentTeams.getTask(lead, broad.id).writeScopeWarnings)
      .toEqual([`write scopes overlap with ${narrow.id}`])

    ctx.agentTeams.interrupt(lead, 'editor')
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) }, { timeout: 5_000 })
    await vi.waitFor(() => { expect(ctx.agents.get(editor.id)?.status).not.toBe('running') }, { timeout: 5_000 })
  })
})

describe('Team Remote API', () => {
  it('reads tasks created and updated by Team agents', async () => {
    const { ctx, lead } = await setup([])
    expect(ctx.agentTeams.typertRemote).toMatchObject({ serviceKey: 'agentTeams', namespace: 'agentTeams' })
    expect(ctx.agentTeams.remoteView(lead)).toEqual({
      members: [expect.objectContaining({ name: 'lead', role: 'lead', status: 'inactive' })],
      tasks: [],
    })
    const created = await ctx.agentTeams.createTask(lead, {
      subject: 'Agent task', description: 'Created by the Team Lead',
    })
    const updated = await ctx.agentTeams.updateTask(lead, {
      taskId: created.id, expectedRevision: 1, action: 'claim',
    })
    // The claim result adds the owner's brief; the listed row is the view without it.
    const { brief, ...listed } = updated
    expect(brief).toContain(`Task ${created.id}: Agent task`)
    expect(ctx.agentTeams.remoteView(lead).tasks).toEqual([listed])
  })
})

describe('Team mailbox and waiting', () => {
  it('steers a message addressed to the Lead and checkpoints its receipt', async () => {
    const { ctx, lead } = await setup(['hang'])
    const message: TeamMessageSnapshot = {
      id: TeamMessageId('steer-lead-message'),
      senderId: SessionId('team-worker'),
      senderName: 'worker',
      targetId: lead.id,
      content: content('progress report'),
    }
    lead.session.append('team/message/queued', {
      version: 2,
      teamId: TeamId(lead.id),
      message,
    })

    await expect(teamInternals(ctx).mailbox.tryDispatch(lead, message, SIGNAL)).resolves.toBe(true)
    expect(lead.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(input => input.source.kind === 'team-message'
        && input.source.messageId === message.id))).toBe(true)
    expect(durable(lead).pendingMessages).toEqual([])
    lead.cancel({ kind: 'parent' })
    await lead.whenIdle()
  })

  it('acknowledges steered messages persisted by a busy Lead before model claim', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang', 'hang'], { maxPendingMessagesPerMember: 1 })
    const started = await spawn(ctx, lead, 'lead-reporter')
    const reporter = await waitRunning(ctx, started.member.id)
    lead.followup(createUserMessage({ content: content('keep the Lead busy'), source: { kind: 'user' } }))
    await waitRunning(ctx, lead.id)

    const first = await ctx.agentTeams.sendMessage(reporter, {
      target: 'lead', content: content('first progress report'), signal: SIGNAL,
    })
    const second = await ctx.agentTeams.sendMessage(reporter, {
      target: 'lead', content: content('second progress report'), signal: SIGNAL,
    })
    expect([first.status, second.status]).toEqual(['accepted', 'accepted'])
    expect(lead.status).toBe('running')
    expect(durable(lead).pendingMessages).toEqual([])

    const messageIds = new Set([first.messageId, second.messageId])
    const persisted = await storedEvents(ctx, lead.id)
    const receiptOrder = persisted.flatMap((event) => {
      if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message =>
        message.source.kind === 'team-message' && messageIds.has(message.source.messageId))) {
        return ['agent/inbox/spliced']
      }
      if (event.type === 'team/message/delivered' && messageIds.has(event.data.messageId)) {
        return ['team/message/delivered']
      }
      return []
    })
    expect(receiptOrder).toEqual([
      'agent/inbox/spliced',
      'team/message/delivered',
      'agent/inbox/spliced',
      'team/message/delivered',
    ])

    const receiptCount = lead.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'team-message'
        && messageIds.has(message.source.messageId))).length
    await teamFiber.dispose()
    await ctx.plugin(TeamService, { maxPendingMessagesPerMember: 1 })
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) })
    expect(lead.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'team-message'
        && messageIds.has(message.source.messageId)))).toHaveLength(receiptCount)

    lead.cancel({ kind: 'parent' })
    await lead.whenIdle()
  })

  it('flushes a live pending receipt before acknowledgement without inserting a duplicate', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'pending-target')
    const target = await waitRunning(ctx, started.member.id)
    const immediate = await ctx.agentTeams.sendMessage(lead, {
      target: 'pending-target',
      content: content('live steer receipt'),
      signal: SIGNAL,
    })
    expect(immediate.status).toBe('accepted')
    expect(durable(lead).pendingMessages).toEqual([])
    expect(target.inbox.nextStep.some(item => item.source.kind === 'team-message'
      && item.source.messageId === immediate.messageId)).toBe(true)

    const message: TeamMessageSnapshot = {
      id: TeamMessageId('live-pending-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: target.id,
      content: content('durable pending receipt'),
    }
    lead.session.append('team/message/queued', {
      version: 2,
      teamId: TeamId(lead.id),
      message,
    })
    await ctx.sessions.flush(lead.session)
    target.inject(createUserMessage({
      content: content('durable pending receipt'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: message.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    }))

    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushed: SessionId[] = []
    const flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      flushed.push(session.id)
      return flush(session)
    })
    const delivered = await teamInternals(ctx).mailbox.tryDispatch(lead, message, SIGNAL)

    expect(delivered).toBe(true)
    expect(flushed.slice(0, 2)).toEqual([target.id, lead.id])
    expect(target.inbox.nextStep.filter(item => item.source.kind === 'team-message'
      && item.source.messageId === message.id)).toHaveLength(1)
    expect(durable(lead).pendingMessages).toEqual([])

    const disappearing: TeamMessageSnapshot = {
      ...message,
      id: TeamMessageId('disappearing-pending-message'),
      content: content('canceled before checkpoint'),
    }
    lead.session.append('team/message/queued', {
      version: 2,
      teamId: TeamId(lead.id),
      message: disappearing,
    })
    await flush(lead.session)
    const disappearingInput = createUserMessage({
      content: content('canceled before checkpoint'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: disappearing.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    })
    target.inject(disappearingInput)
    flushSpy.mockImplementationOnce(async (session) => {
      target.inbox.remove(disappearingInput.id)
      return flush(session)
    })
    await expect(teamInternals(ctx).mailbox.tryDispatch(lead, disappearing, SIGNAL)).resolves.toBe(false)
    expect(durable(lead).pendingMessages.map(pending => pending.id)).toEqual([disappearing.id])

    ctx.agentTeams.interrupt(lead, 'pending-target')
    target.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, target.id)
  })

  it('acknowledges steered messages accepted by a busy target inbox', async () => {
    const { ctx, lead } = await setup(['hang'], { maxPendingMessagesPerMember: 1 })
    const started = await spawn(ctx, lead, 'busy-target')
    const target = await waitRunning(ctx, started.member.id)
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushed: SessionId[] = []
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      flushed.push(session.id)
      return flush(session)
    })

    const first = await ctx.agentTeams.sendMessage(lead, {
      target: 'busy-target', content: content('first steered message'), signal: SIGNAL,
    })

    expect(first.status).toBe('accepted')
    expect(flushed).toEqual([lead.id, target.id, lead.id])
    expect(durable(lead).pendingMessages).toEqual([])
    expect(target.inbox.nextStep.some(message => message.source.kind === 'team-message'
      && message.source.messageId === first.messageId)).toBe(true)

    flushed.length = 0
    const second = await ctx.agentTeams.sendMessage(lead, {
      target: 'busy-target', content: content('second steered message'), signal: SIGNAL,
    })

    expect(second.status).toBe('accepted')
    expect(flushed).toEqual([lead.id, target.id, lead.id])
    expect(durable(lead).pendingMessages).toEqual([])
    expect(target.inbox.nextStep.filter(message => message.source.kind === 'team-message'
      && (message.source.messageId === first.messageId || message.source.messageId === second.messageId)))
      .toHaveLength(2)

    ctx.agentTeams.interrupt(lead, 'busy-target')
    target.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, target.id)
  })

  it('serializes concurrent Steer delivery admission for one target', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'ordered-target')
    const target = await waitRunning(ctx, started.member.id)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const admitted: string[] = []
    vi.spyOn(ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt)
      .mockImplementation(async (_parent, _childId, blocks, source) => {
        const last = blocks.at(-1)
        const text = last?.type === 'text' ? last.text : ''
        admitted.push(text)
        if (text === 'first steer') {
          entered.resolve(undefined)
          await release.promise
        }
        const input = createUserMessage({ content: blocks, source })
        target.inject(input)
        return input.id
      })

    const first = ctx.agentTeams.sendMessage(lead, {
      target: 'ordered-target', content: content('first steer'), signal: SIGNAL,
    })
    await entered.promise
    let secondSettled = false
    const second = ctx.agentTeams.sendMessage(lead, {
      target: 'ordered-target', content: content('second steer'), signal: SIGNAL,
    }).finally(() => { secondSettled = true })
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toHaveLength(2) })
    expect(admitted).toEqual(['first steer'])
    expect(secondSettled).toBe(false)

    release.resolve(undefined)
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'accepted' },
      { status: 'accepted' },
    ])
    expect(admitted).toEqual(['first steer', 'second steer'])

    ctx.agentTeams.interrupt(lead, 'ordered-target')
    target.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, target.id)
  })

  it('delivers persisted mail before the later message that cold-resumes its target', async () => {
    const { ctx, lead } = await setup([textResponse('target initial'), 'hang', 'hang'])
    const started = await spawn(ctx, lead, 'reordered-target')
    await waitNoAgent(ctx, started.member.id)
    const earlier: TeamMessageSnapshot = {
      id: TeamMessageId('earlier-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: started.member.id,
      content: content('earlier steer'),
    }
    lead.session.append('team/message/queued', {
      version: 2,
      teamId: TeamId(lead.id),
      message: earlier,
    })
    await ctx.sessions.flush(lead.session)

    const later = await ctx.agentTeams.sendMessage(lead, {
      target: 'reordered-target', content: content('later steer'), signal: SIGNAL,
    })
    expect(later.status).toBe('accepted')
    const target = await waitRunning(ctx, started.member.id)
    await vi.waitFor(() => {
      const accepted = target.session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced'
        ? event.data.inserted.flatMap(message => message.source.kind === 'team-message'
          ? [message.source.messageId]
          : [])
        : [])
      expect(accepted).toEqual([earlier.id, later.messageId])
    })

    ctx.agentTeams.interrupt(lead, 'reordered-target')
    target.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, target.id)
  })

  it('deduplicates live target history and contains inspection and delivery failures', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('inactive target initial')])
    const liveStarted = await spawn(ctx, lead, 'live-target')
    const live = await waitRunning(ctx, liveStarted.member.id)
    const internal = teamInternals(ctx).mailbox
    const message: TeamMessageSnapshot = {
      id: TeamMessageId('live-recorded-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: live.id,
      content: content('already in live history'),
    }
    lead.session.append('team/message/queued', {
      version: 2, teamId: TeamId(lead.id), message,
    })
    await ctx.sessions.flush(lead.session)
    live.session.append('user/message', createUserMessage({
      content: content('different Team message first'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: TeamMessageId('other-message'),
        senderId: lead.id,
        senderName: 'lead',
      },
    }), { surfaceOp: 'append' })
    live.session.append('user/message', createUserMessage({
      content: content('already in live history'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: message.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    }), { surfaceOp: 'append' })
    await expect(internal.tryDispatch(lead, message, SIGNAL)).resolves.toBe(true)
    await internal.markDelivered(lead, message.id, live.id)
    await expect(internal.tryDispatch(lead, message, SIGNAL)).resolves.toBe(true)

    const wrongTarget: TeamMessageSnapshot = {
      ...message,
      id: TeamMessageId('wrong-target-message'),
    }
    lead.session.append('team/message/queued', {
      version: 2, teamId: TeamId(lead.id), message: wrongTarget,
    })
    await ctx.sessions.flush(lead.session)
    await internal.markDelivered(lead, wrongTarget.id, SessionId('wrong-target'))
    await expect(internal.serializeDispatch(wrongTarget, async () => true)).resolves.toBe(true)
    const serialEntered = Promise.withResolvers<undefined>()
    const releaseSerial = Promise.withResolvers<undefined>()
    const serialFirst = internal.serializeDispatch(wrongTarget, async () => {
      serialEntered.resolve(undefined)
      await releaseSerial.promise
      return true
    })
    await serialEntered.promise
    const serialSecond = internal.serializeDispatch({
      ...wrongTarget, id: TeamMessageId('second-serialized-message'),
    }, async () => true)
    releaseSerial.resolve(undefined)
    await expect(Promise.all([serialFirst, serialSecond])).resolves.toEqual([true, true])

    const warnings: string[] = []
    ctx.logger.warn = ((value: unknown) => { warnings.push(String(value)) }) as typeof ctx.logger.warn
    const failedAck = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('acknowledgement flush failed'))
    live.session.append('user/message', createUserMessage({
      content: content('acknowledgement failure'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: wrongTarget.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    }), { surfaceOp: 'append' })
    await vi.waitFor(() => {
      expect(warnings.some(warning => warning.includes('acknowledgement flush failed'))).toBe(true)
    })
    failedAck.mockRestore()

    const inactiveStarted = await spawn(ctx, lead, 'inactive-target')
    await waitNoAgent(ctx, inactiveStarted.member.id)
    const openRead = vi.spyOn(ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('read unavailable'))
    const uncertain = await ctx.agentTeams.sendMessage(lead, {
      target: 'inactive-target', content: content('inspection failure'), signal: SIGNAL,
    })
    expect(uncertain.status).toBe('queued')
    openRead.mockRestore()

    vi.spyOn(ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt)
      .mockRejectedValueOnce(new Error('delivery unavailable'))
    const failed = await ctx.agentTeams.sendMessage(lead, {
      target: 'inactive-target', content: content('delivery failure'), signal: SIGNAL,
    })
    expect(failed.status).toBe('queued')
    expect(warnings.some(warning => warning.includes('read unavailable'))).toBe(true)
    expect(warnings.some(warning => warning.includes('delivery unavailable'))).toBe(true)

    ctx.agentTeams.interrupt(lead, 'live-target')
    await waitNoAgent(ctx, live.id)
  })

  it('cold-resumes an inactive sibling with sender attribution', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const alphaStarted = await spawn(ctx, lead, 'alpha')
    const alpha = await waitRunning(ctx, alphaStarted.member.id)
    const betaStarted = await spawn(ctx, lead, 'beta')
    const beta = await waitRunning(ctx, betaStarted.member.id)
    ctx.agentTeams.interrupt(lead, 'beta')
    await waitNoAgent(ctx, beta.id)

    const first = await ctx.agentTeams.sendMessage(alpha, {
      target: 'beta', content: content('first update'), signal: SIGNAL,
    })
    expect(first.status).toBe('accepted')
    await waitNoAgent(ctx, betaStarted.member.id)
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) })

    const stored = await storedEvents(ctx, betaStarted.member.id)
    const peerMessages = stored.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'team-message')
    expect(peerMessages.map((event) => {
      if (event.type !== 'user/message') return undefined
      const block = event.data.content.at(-1)
      return block?.type === 'text' ? block.text : undefined
    })).toEqual(['first update'])
    expect(peerMessages.map(event => event.type === 'user/message'
      ? event.data.content[0]?.type === 'text' && event.data.content[0].text
      : undefined)).toEqual([
      expect.stringMatching(/^Team message .* from alpha:$/u),
    ])
    expect(peerMessages.map(event => event.type === 'user/message' && event.data.source.kind === 'team-message'
      ? [event.data.source.messageId, event.data.source.senderName]
      : undefined)).toEqual([
      [first.messageId, 'alpha'],
    ])

    ctx.agentTeams.interrupt(lead, 'alpha')
    await waitNoAgent(ctx, alpha.id)
  })

  it('enforces message byte and pending-count limits without encouraging retry after enqueue', async () => {
    const { ctx, lead } = await setup([textResponse('idle')], {
      maxMessageBytes: 256,
      maxPendingMessagesPerMember: 1,
    })
    const target = await spawn(ctx, lead, 'target')
    await waitNoAgent(ctx, target.member.id)
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('x'.repeat(300)), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    vi.spyOn(ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('temporary read failure'))
    const queued = await ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('one'), signal: SIGNAL,
    })
    expect(queued.status).toBe('queued')
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('two'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'lead', content: content('self'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_SELF_MESSAGE' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'missing', content: content('unknown target'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    const controller = new AbortController()
    controller.abort(new TeamError('cancelled before queue', 'TEST_CANCELLED'))
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('cancelled'), signal: controller.signal,
    })).rejects.toMatchObject({ code: 'TEST_CANCELLED' })
  })

  it('interrupts only the current turn and retains an already accepted follow-up', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('after interrupt')])
    const started = await spawn(ctx, lead, 'worker')
    const worker = await waitRunning(ctx, started.member.id)
    const followup = await ctx.agentTeams.sendMessage(lead, {
      target: 'worker', content: content('retained follow-up'), signal: SIGNAL,
    })
    expect(followup.status).toBe('accepted')
    expect(ctx.agentTeams.interrupt(lead, 'worker')).toEqual({ previousStatus: 'running' })
    await vi.waitFor(() => { expect(worker.status).toBe('idle') })
    expect(worker.inbox.nextStep.some(message => message.source.kind === 'team-message'
      && message.source.messageId === followup.messageId)).toBe(true)
    worker.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, worker.id)
  })

  it('waits for one change, supports cancellation, times out, and releases waiters on HMR disposal', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-wait-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    const fiber = await ctx.plugin(TeamService)
    const service = ctx.agentTeams
    const lead = await ctx.agentLoop.create(SessionId('wait-lead'), {})

    await expect(service.waitForChange(lead, 9_999, SIGNAL))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_TIMEOUT' })
    const alreadyAborted = new AbortController()
    alreadyAborted.abort(new TeamError('cancelled before wait', 'TEST_CANCELLED'))
    await expect(service.waitForChange(lead, 10_000, alreadyAborted.signal))
      .rejects.toMatchObject({ code: 'TEST_CANCELLED' })

    const changed = service.waitForChange(lead, 10_000, SIGNAL)
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushEntered = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      flushEntered.resolve(undefined)
      await releaseFlush.promise
      return await flush(session)
    })
    let waitSettled = false
    void changed.finally(() => { waitSettled = true })
    const creating = service.createTask(lead, { subject: 'wake', description: 'wake waiter' })
    await flushEntered.promise
    expect(waitSettled).toBe(false)
    releaseFlush.resolve(undefined)
    await creating
    await expect(changed).resolves.toEqual({ timedOut: false })

    const controller = new AbortController()
    const cancelled = service.waitForChange(lead, 10_000, controller.signal)
    controller.abort(new TeamError('cancelled', 'TEST_CANCELLED'))
    await expect(cancelled).rejects.toMatchObject({ code: 'TEST_CANCELLED' })

    const stringAbort = new AbortController()
    const firstWaiter = service.waitForChange(lead, 10_000, stringAbort.signal)
    const secondWaiter = service.waitForChange(lead, 10_000, SIGNAL)
    stringAbort.abort('string cancellation')
    await expect(firstWaiter).rejects.toMatchObject({
      code: 'TEAM_WAIT_ABORTED',
      message: 'wait_agent aborted: string cancellation',
    })
    await service.createTask(lead, { subject: 'second waiter', description: 'second waiter remains registered' })
    await expect(secondWaiter).resolves.toEqual({ timedOut: false })

    const objectAbort = new AbortController()
    const objectCancelled = service.waitForChange(lead, 10_000, objectAbort.signal)
    objectAbort.abort({ kind: 'user' })
    await expect(objectCancelled).rejects.toMatchObject({
      code: 'TEAM_WAIT_ABORTED',
      message: "wait_agent aborted: { kind: 'user' }",
    })

    await service.createTask(lead, { subject: 'already changed', description: 'edge-triggered wait' })
    vi.useFakeTimers()
    const timeout = service.waitForChange(lead, 10_000, SIGNAL)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(timeout).resolves.toEqual({ timedOut: true })
    vi.useRealTimers()

    const disposed = service.waitForChange(lead, 10_000, SIGNAL)
    await fiber.dispose()
    await expect(disposed).resolves.toEqual({ timedOut: false })
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('disposes live teammate Activations and their waits when the Team service unloads', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'dispose-worker')
    await waitRunning(ctx, started.member.id)
    const waiting = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)

    await teamFiber.dispose()

    await expect(waiting).resolves.toEqual({ timedOut: false })
    expect(ctx.agents.get(started.member.id)).toBeUndefined()
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('closes creation admission and drains an in-flight spawn before unload completes', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'])
    const service = ctx.agentTeams
    const start = ctx.subagents.startContinuable.bind(ctx.subagents)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let childId: SessionId | undefined
    vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      childId = spec.childId
      entered.resolve(undefined)
      await release.promise
      return start(spec)
    })
    const spawning = spawn(ctx, lead, 'disposing-worker')
    const rejected = expect(spawning).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    await entered.promise

    const disposal = teamFiber.dispose()
    await Promise.resolve()
    await expect(service.waitForChange(lead, 3_600_000, SIGNAL)).resolves.toEqual({ timedOut: false })
    await expect(service.spawnTeammate(lead, {
      name: 'late-worker',
      description: 'must not enter after disposal',
      prompt: content('late task'),
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    release.resolve(undefined)

    await rejected
    await disposal
    if (childId !== undefined) expect(ctx.agents.get(childId)).toBeUndefined()
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('retains an in-flight creation cleanup failure during disposal', async () => {
    const { ctx } = await setup([])
    const internal = teamInternals(ctx)
    const cleanupFailure = new Error('creation cleanup failed')
    const rejected = Promise.reject(cleanupFailure)
    void rejected.catch(() => undefined)
    internal.roster.inFlightCreations.add(rejected)

    await expect(internal.disposeRuntime()).rejects.toMatchObject({ errors: [cleanupFailure] })
  })

  it('recognizes wrapped and coded runtime cancellation during disposal settlement', async () => {
    const open = new TeamRuntimeLifecycle(100)
    const ordinaryFailure = new Error('ordinary failure before disposal')
    const openFailures: unknown[] = []
    await open.settle([Promise.reject(ordinaryFailure)], openFailures)
    expect(openFailures).toEqual([ordinaryFailure])

    const lifecycle = new TeamRuntimeLifecycle(100)
    lifecycle.close()
    const failures: unknown[] = []
    await lifecycle.settle([
      Promise.reject(new Error('wrapped cancellation', { cause: lifecycle.reason })),
      Promise.reject(new TeamError('translated cancellation', 'TEAM_DISPOSED')),
    ], failures)
    expect(failures).toEqual([])

    const cyclic = new Error('unrelated cyclic failure')
    cyclic.cause = cyclic
    await lifecycle.settle([Promise.reject(cyclic)], failures)
    expect(failures).toEqual([cyclic])
  })

  it('disposes a live child even after its durable member edge becomes failed', async () => {
    const { ctx, lead } = await setup(['hang'])
    const childId = SessionId('failed-live-child')
    const member = {
      id: childId,
      name: 'failed-live-worker',
      description: 'failed-live-worker responsibility',
      provider: 'spawn',
      context: 'fresh' as const,
      phase: 'provisioning' as const,
    }
    lead.session.append('team/member', {
      version: 2,
      teamId: TeamId(lead.id),
      member,
    })
    await ctx.subagents.startContinuable({
      childId,
      provider: 'spawn',
      label: member.description,
      request: { prompt: content('failed child task'), parent: lead },
      signal: SIGNAL,
    })
    await waitRunning(ctx, childId)
    lead.session.append('team/member', {
      version: 2,
      teamId: TeamId(lead.id),
      member: {
        ...member,
        phase: 'failed',
        error: 'creation cleanup is pending',
      },
    })
    await ctx.sessions.flush(lead.session)
    expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('failed')

    const internal = ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }
    await internal.disposeRuntime()
    expect(ctx.agents.get(childId)).toBeUndefined()
  })

  it('aborts and awaits an admitted cold mailbox dispatch during disposal', async () => {
    const { ctx, lead } = await setup([textResponse('worker done')])
    const started = await spawn(ctx, lead, 'mailbox-worker')
    await waitNoAgent(ctx, started.member.id)
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt)
      .mockImplementation(async (_parent, _childId, _content, _source, signal) => {
        entered.resolve(undefined)
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted.resolve(undefined)
            void release.promise.then(() => {
              const reason: unknown = signal.reason
              reject(reason instanceof Error ? reason : new Error(String(reason)))
            })
          }, { once: true })
        })
      })

    const sending = ctx.agentTeams.sendMessage(lead, {
      target: 'mailbox-worker',
      content: content('resume during disposal'),
      signal: SIGNAL,
    })
    await entered.promise
    const internal = ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }
    let disposed = false
    const disposal = internal.disposeRuntime().then(() => { disposed = true })
    await aborted.promise
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve(undefined)

    await expect(sending).resolves.toMatchObject({ status: 'queued' })
    await disposal
    expect(disposed).toBe(true)
    expect(ctx.agents.get(started.member.id)).toBeUndefined()
  })

  it('awaits an admitted asynchronous acknowledgement before disposal completes', async () => {
    const { ctx, lead } = await setup([])
    const message: TeamMessageSnapshot = {
      id: TeamMessageId('dispose-ack-message'),
      senderId: SessionId('sender'),
      senderName: 'sender',
      targetId: lead.id,
      content: content('acknowledge before disposal'),
    }
    lead.session.append('team/message/queued', {
      version: 2,
      teamId: TeamId(lead.id),
      message,
    })
    await ctx.sessions.flush(lead.session)

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let blockReceipt = true
    const flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (blockReceipt && session === lead.session) {
        blockReceipt = false
        entered.resolve(undefined)
        await release.promise
      }
      return flush(session)
    })
    lead.session.append('user/message', createUserMessage({
      content: content('acknowledge before disposal'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
      },
    }), { surfaceOp: 'append' })

    const internal = ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }
    let disposed = false
    const disposal = internal.disposeRuntime().then(() => { disposed = true })
    await entered.promise
    await Promise.resolve()
    const disposedBeforeRelease = disposed
    release.resolve(undefined)
    await disposal

    expect(disposedBeforeRelease).toBe(false)
    expect(disposed).toBe(true)
    expect(durable(lead).pendingMessages).toEqual([])
    flushSpy.mockRestore()
  })

  it('bounds Team runtime disposal when a continuation drain never settles', { timeout: 30_000 }, async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'], { disposalTimeoutMs: 25 })
    const started = await spawn(ctx, lead, 'stuck-worker')
    await waitRunning(ctx, started.member.id)
    const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren')
      .mockImplementation(() => new Promise(() => {}))

    const outcome = await Promise.race([
      teamFiber.dispose().then(() => 'disposed'),
      new Promise<'hung'>((resolve) => { setTimeout(() => { resolve('hung') }, 1_000) }),
    ])
    expect(outcome).toBe('disposed')
    expect(drain).toHaveBeenCalledWith(lead, [started.member.id])
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('bounds disposal while an admitted creation ignores cancellation', async () => {
    const { ctx, lead } = await setup([], { disposalTimeoutMs: 25 })
    const internal = teamInternals(ctx)
    internal.roster.inFlightCreations.add(new Promise(() => {}))

    await expect(internal.disposeRuntime()).rejects.toBeInstanceOf(AggregateError)
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'after-timeout',
      description: 'admission remains closed',
      prompt: content('must reject'),
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'nobody', content: content('must reject'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    await expect(internal.mailbox.tryDispatch(lead, {
      id: TeamMessageId('post-disposal-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: lead.id,
      content: content('must not dispatch'),
    }, SIGNAL)).resolves.toBe(false)
  })

  it('contains recovery callback failures and ignores work scheduled after disposal', async () => {
    const { ctx, lead, teamFiber } = await setup([])
    const warnings: string[] = []
    ctx.logger.warn = ((value: unknown) => { warnings.push(String(value)) }) as typeof ctx.logger.warn
    const internal = teamInternals(ctx)
    internal.recoverFor = async () => { throw new Error('forced recovery failure') }
    internal.scheduleRecovery(lead)
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings.some(warning => warning.includes('forced recovery failure'))).toBe(true)

    lead.session.append('user/message', createUserMessage({
      content: content('orphan Team source'),
      source: {
        kind: 'team-message',
        teamId: TeamId('absent-team'),
        messageId: TeamMessageId('absent-team-message'),
        senderId: SessionId('absent-sender'),
        senderName: 'absent',
      },
    }), { surfaceOp: 'append' })
    await Promise.resolve()

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    internal.recoverFor = async () => {
      entered.resolve(undefined)
      await release.promise
      throw new Error('failure after disposal')
    }
    internal.scheduleRecovery(lead)
    await entered.promise
    await teamFiber.dispose()
    release.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    internal.scheduleRecovery(lead)
    await Promise.resolve()
  })

  it('reports contained teardown failures without retaining the Team service', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'failing-drain')
    await waitRunning(ctx, started.member.id)
    vi.spyOn(ctx.subagents, 'drainContinuableDescendants').mockRejectedValueOnce(new Error('drain failure'))

    await teamFiber.dispose()
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('reconciles mismatched persisted children and ignores a concurrently settled member', async () => {
    const first = await setup([])
    const liveId = SessionId('live-provisioning-child')
    const live = await first.ctx.agents.create({
      sessionId: liveId,
      meta: { parentSession: first.lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const provisioning = {
      id: liveId,
      name: 'mismatched-child',
      description: 'mismatched persisted child',
      provider: 'spawn',
      context: 'fresh' as const,
      phase: 'provisioning' as const,
    }
    first.lead.session.append('team/member', {
      version: 2, teamId: TeamId(first.lead.id), member: provisioning,
    })
    const reconcileFirst = teamInternals(first.ctx).roster
    await reconcileFirst.reconcileProvisioning(first.lead, SIGNAL)
    expect(durable(first.lead).members[0]?.phase).toBe('provisioning')
    live.agent.session.append('user/message', createUserMessage({
      content: content('persist mismatched child'), source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await first.ctx.sessions.flush(live.agent.session)
    await live.dispose()
    await reconcileFirst.reconcileProvisioning(first.lead, SIGNAL)
    expect(durable(first.lead).members[0]).toMatchObject({
      phase: 'failed',
      error: 'persisted child Session does not match the provisioned continuation',
    })

    const second = await setup([])
    const childId = SessionId('concurrently-settled-child')
    const member = { ...provisioning, id: childId, name: 'concurrent-child' }
    second.lead.session.append('team/member', {
      version: 2, teamId: TeamId(second.lead.id), member,
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(second.ctx.sessionPersistence, 'open').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      throw new Error('late inspection failure')
    })
    const reconcileSecond = teamInternals(second.ctx).roster
    const reconciling = reconcileSecond.reconcileProvisioning(second.lead, SIGNAL)
    await entered.promise
    second.lead.session.append('team/member', {
      version: 2,
      teamId: TeamId(second.lead.id),
      member: { ...member, phase: 'failed', error: 'settled elsewhere' },
    })
    release.resolve(undefined)
    await reconciling
    expect(durable(second.lead).members[0]).toMatchObject({
      phase: 'failed', error: 'settled elsewhere',
    })
  })
})

describe('Lost tasks and the frozen executed graph', () => {
  it('marks a claimed task lost, keeps its owner, and recovers only through reopen', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'worker')
    const worker = await waitRunning(ctx, started.member.id)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'work', description: 'work' })
    const claimed = await ctx.agentTeams.updateTask(worker, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    expect(ctx.agentTeams.outstandingTasks(lead)).toEqual([
      { id: task.id, subject: 'work', ownerName: 'worker', live: true },
    ])

    await expect(ctx.agentTeams.markLost(lead, TeamTaskId('missing'), 'run-ended'))
      .rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    const lost = await ctx.agentTeams.markLost(lead, task.id, 'run-ended')
    expect(lost).toMatchObject({ status: 'lost', lostCause: 'run-ended', ownerName: 'worker', ready: false })
    expect(durable(lead).tasks[0]).toMatchObject({ status: 'lost', lostCause: 'run-ended', ownerId: worker.id })
    expect(ctx.agentTeams.outstandingTasks(lead)).toEqual([])
    await expect(ctx.agentTeams.markLost(lead, task.id, 'run-ended'))
      .rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })

    // The owner cannot finish or re-take it, and nobody can move it, until it is reopened.
    await expect(ctx.agentTeams.updateTask(worker, {
      taskId: task.id, expectedRevision: lost.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    await expect(ctx.agentTeams.updateTask(worker, {
      taskId: task.id, expectedRevision: lost.revision, action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: lost.revision, action: 'reassign', owner: 'worker',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: lost.revision, action: 'reassign',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    // Lost is on the open part of the graph: its text and edges may change.
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'blocker', description: 'blocker' })
    const edited = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: lost.revision, action: 'edit', description: 'retry with the diagnosis',
    })
    const rewired = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: edited.revision, action: 'set_dependencies', blockedBy: [blocker.id],
    })
    expect(rewired).toMatchObject({ status: 'lost', lostCause: 'run-ended', blockedBy: [blocker.id] })
    const reopened = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: rewired.revision, action: 'reopen',
    })
    expect(reopened).toMatchObject({ status: 'pending', ready: false })
    expect('ownerId' in reopened).toBe(false)
    expect('lostCause' in reopened).toBe(false)
    const deleted = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: reopened.revision, action: 'delete',
    })
    expect(deleted.status).toBe('deleted')

    ctx.agentTeams.interrupt(lead, 'worker')
    await waitNoAgent(ctx, worker.id)
    expect(claimed.status).toBe('in_progress')
  })

  it('freezes completed tasks and reports Lead-owned work as not live while the Lead is idle', async () => {
    const { ctx, lead } = await setup([])
    const task = await ctx.agentTeams.createTask(lead, { subject: 'own', description: 'own' })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    expect(ctx.agentTeams.outstandingTasks(lead)).toEqual([
      { id: task.id, subject: 'own', ownerName: 'lead', live: false },
    ])
    const completed = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: claimed.revision, action: 'complete',
    })
    for (const action of ['edit', 'set_dependencies', 'delete'] as const) {
      await expect(ctx.agentTeams.updateTask(lead, {
        taskId: task.id, expectedRevision: completed.revision, action, subject: 'late', blockedBy: [],
      })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    }
    const reopened = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: completed.revision, action: 'reopen',
    })
    expect(reopened.status).toBe('pending')
    const deleted = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: reopened.revision, action: 'delete',
    })
    expect(deleted.status).toBe('deleted')
  })

  it('loses what a member claimed while provisioning once its provisioning fails', async () => {
    const { ctx, lead } = await setup(['hang'])
    const internals = teamInternals(ctx)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'early', description: 'claimed while provisioning' })
    const untouched = await ctx.agentTeams.createTask(lead, { subject: 'untouched', description: 'never claimed' })
    vi.spyOn(internals.roster, 'checkpointInitialPrompt').mockImplementationOnce(async (childId) => {
      const child = await waitRunning(ctx, childId)
      await ctx.agentTeams.updateTask(child, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
      throw new Error('checkpoint failed')
    })
    // The mark commits after the failed member record; hold its transaction so
    // the flush lands before the storage root is removed.
    const marks: Promise<TeamTaskId[]>[] = []
    const markOwnerLost = internals.tasks.markOwnerLost.bind(internals.tasks)
    vi.spyOn(internals.tasks, 'markOwnerLost').mockImplementation((root, ownerId, cause) => {
      const mark = markOwnerLost(root, ownerId, cause)
      marks.push(mark)
      return mark
    })
    await expect(spawn(ctx, lead, 'early-claimer')).rejects.toThrow('checkpoint failed')
    const member = durable(lead).members[0]
    expect(member).toMatchObject({ phase: 'failed' })
    await vi.waitFor(() => { expect(marks).toHaveLength(1) })
    await expect(marks[0]).resolves.toEqual([task.id])
    expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ status: 'lost', lostCause: 'owner-failed', ownerName: 'early-claimer' })
    expect(ctx.agentTeams.getTask(lead, untouched.id).status).toBe('pending')
    if (member !== undefined) await waitNoAgent(ctx, member.id)
  })

  it('contains a failed lost mark for a member that failed provisioning', async () => {
    const { ctx, lead } = await setup([])
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(teamInternals(ctx).tasks, 'markOwnerLost').mockRejectedValueOnce(new Error('disk full'))
    await expect(spawn(ctx, lead, 'never-starts', { provider: 'missing' })).rejects.toThrow()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not mark tasks of failed member'))
    })
  })
})

describe('Member turn outcomes', () => {
  it('records how each teammate turn ended on the roster and in the Lead log', async () => {
    const { ctx, lead } = await setup([textResponse('first turn done'), 'hang'])
    const started = await spawn(ctx, lead, 'mate')
    expect(started.member).not.toHaveProperty('lastStop')
    await vi.waitFor(() => {
      expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ name: 'mate', status: 'inactive', lastStop: 'completed' })
    })
    expect(durable(lead).members[0]).toMatchObject({ phase: 'active', lastStop: 'completed' })
    // The next turn is interrupted; the record follows the latest outcome.
    await ctx.agentTeams.sendMessage(lead, { target: 'mate', content: content('again'), signal: SIGNAL })
    const mate = await waitRunning(ctx, started.member.id)
    ctx.agentTeams.interrupt(lead, 'mate')
    await waitNoAgent(ctx, mate.id)
    await vi.waitFor(() => {
      const row = ctx.agentTeams.listMembers(lead)[1]
      expect(row).toMatchObject({ status: 'inactive' })
      // The mock hangs until torn down, which the epoch reports as an error; either way it did not complete.
      expect(row?.lastStop).toMatch(/^(aborted|error)$/)
    })
  })

  it('ignores a turn outcome for a member that is not active and warns when the record fails', async () => {
    const { ctx, lead } = await setup([textResponse('done')])
    const internals = teamInternals(ctx)
    await expect(internals.roster.recordStop(lead, SessionId('nobody'), 'completed')).resolves.toBe(false)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(internals.roster, 'recordStop').mockRejectedValueOnce(new Error('disk full'))
    await spawn(ctx, lead, 'mate')
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record the turn outcome of member'))
    })
  })
})

describe('Tracked subagent runs', () => {
  it('records a delegated run as an owned task and completes it when the run completes', async () => {
    const { ctx, lead } = await setup([textResponse('child done')], { trackSubagentRuns: true })
    const controller = new AbortController()
    const run = await ctx.subagents.start('spawn', {
      prompt: content('do the delegated part'), parent: lead, signal: controller.signal,
    })
    const [tracked] = await vi.waitFor(() => {
      const tasks = ctx.agentTeams.listTasks(lead)
      expect(tasks).toHaveLength(1)
      return tasks
    })
    expect(tracked).toMatchObject({
      status: 'in_progress', subject: 'subagent run via spawn', ownerName: run.id, ready: false,
    })
    expect(ctx.agentTeams.outstandingTasks(lead)).toMatchObject([{ id: tracked!.id, ownerName: run.id }])
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose()
    await vi.waitFor(() => {
      expect(ctx.agentTeams.getTask(lead, tracked!.id)).toMatchObject({ status: 'completed', ownerName: run.id })
    })
    expect(ctx.agentTeams.outstandingTasks(lead)).toEqual([])
  })

  it('loses the task of a run that ends without completing', async () => {
    const { ctx, lead } = await setup(['hang'], { trackSubagentRuns: true })
    const controller = new AbortController()
    const run = await ctx.subagents.start('spawn', {
      prompt: content('never finishes'), parent: lead, signal: controller.signal,
    })
    await vi.waitFor(() => { expect(ctx.agentTeams.outstandingTasks(lead)).toHaveLength(1) })
    controller.abort()
    await run.result
    await run.dispose()
    await vi.waitFor(() => {
      expect(ctx.agentTeams.listTasks(lead)[0]).toMatchObject({ status: 'lost', lostCause: 'owner-failed', ownerStop: 'aborted' })
    })
    // Reopening clears how the run ended along with the owner.
    const lost = ctx.agentTeams.listTasks(lead)[0]!
    const reopened = await ctx.agentTeams.updateTask(lead, { taskId: lost.id, expectedRevision: lost.revision, action: 'reopen' })
    expect('ownerStop' in reopened).toBe(false)
    expect(durable(lead).tasks[0]).not.toHaveProperty('ownerStop')
  })

  it('does not track roster epochs, orphaned parents, or unknown runs, and warns on a failed record', async () => {
    const { ctx, lead } = await setup(['hang'], { trackSubagentRuns: true, maxTasks: 1 })
    const started = await spawn(ctx, lead, 'mate')
    const mate = await waitRunning(ctx, started.member.id)
    expect(ctx.agentTeams.listTasks(lead)).toEqual([])

    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const carrier = scopeTarget(ctx.subagents, lead)
    const orphan = { id: SessionId('orphan'), session: { header: {} } } as Agent
    ctx.emit(scopeTarget(ctx.subagents, orphan), 'subagent/start', {
      runId: SubagentRunId('orphan-run'), provider: 'spawn', id: SessionId('orphan-child'), local: true,
    } satisfies SubagentRunInfo)
    ctx.emit(carrier, 'subagent/end', {
      runId: SubagentRunId('never-started'), provider: 'spawn', id: SessionId('nobody'), local: true, stopReason: 'completed',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.agentTeams.listTasks(lead)).toEqual([])
    expect(warn).not.toHaveBeenCalled()

    // A remote child never enters the registry, so its run counts as live until it ends.
    const remote: SubagentRunInfo = { runId: SubagentRunId('remote-run'), provider: 'acp', id: SessionId('remote-child'), local: false }
    ctx.emit(carrier, 'subagent/start', remote)
    await vi.waitFor(() => {
      expect(ctx.agentTeams.outstandingTasks(lead)).toEqual([
        { id: TeamTaskId('task-1'), subject: 'subagent run via acp', ownerName: 'remote-child', live: true },
      ])
    })
    // The board is full, so the next run cannot be recorded; its end is then silent.
    const overflow: SubagentRunInfo = { runId: SubagentRunId('overflow-run'), provider: 'spawn', id: SessionId('overflow-child'), local: true }
    ctx.emit(carrier, 'subagent/start', overflow)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record subagent run "overflow-run"'))
    })
    ctx.emit(carrier, 'subagent/end', { ...overflow, stopReason: 'completed' })
    // A tracked task the harness already marked lost cannot be completed by its late run.
    await ctx.agentTeams.markLost(lead, TeamTaskId('task-1'), 'run-ended')
    ctx.emit(carrier, 'subagent/end', { ...remote, stopReason: 'completed' })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not settle subagent run "remote-run"'))
    })
    expect(warn).toHaveBeenCalledTimes(2)
    expect(ctx.agentTeams.outstandingTasks(lead)).toEqual([])

    ctx.agentTeams.interrupt(lead, 'mate')
    await waitNoAgent(ctx, mate.id)
  })

  it('records runs delegated below a teammate or below a plain child on the Lead board', async () => {
    const { ctx, lead } = await setup(
      ['hang', textResponse('grandchild done'), 'hang', textResponse('great-grandchild done')],
      { trackSubagentRuns: true },
    )
    const started = await spawn(ctx, lead, 'mate')
    const mate = await waitRunning(ctx, started.member.id)
    const controller = new AbortController()
    const run = await ctx.subagents.start('spawn', {
      prompt: content('nested'), parent: mate, signal: controller.signal,
    })
    await vi.waitFor(() => {
      expect(ctx.agentTeams.listTasks(lead)).toMatchObject([{ status: 'in_progress', ownerName: run.id }])
    })
    await run.result
    await run.dispose()
    await vi.waitFor(() => { expect(ctx.agentTeams.listTasks(lead)[0]?.status).toBe('completed') })

    // A plain child is not a member; the walk up its lineage still finds the Lead.
    const child = await ctx.subagents.start('spawn', {
      prompt: content('hangs while delegating'), parent: lead, signal: controller.signal,
    })
    const grandchild = await ctx.subagents.start('spawn', {
      prompt: content('nested twice'), parent: child.localAgent!, signal: controller.signal,
    })
    await vi.waitFor(() => {
      expect(ctx.agentTeams.listTasks(lead).map(task => task.ownerName)).toEqual([run.id, child.id, grandchild.id])
    })
    await grandchild.result
    await grandchild.dispose()
    controller.abort()
    await child.result
    await child.dispose()
    await vi.waitFor(() => {
      expect(ctx.agentTeams.listTasks(lead).map(task => task.status)).toEqual(['completed', 'lost', 'completed'])
    })
    ctx.agentTeams.interrupt(lead, 'mate')
    await waitNoAgent(ctx, mate.id)
  })
})

describe('Preconditions', () => {
  it('refuses a subject a live task already carries, at create and at edit, until that task leaves the live set', async () => {
    const { ctx, lead } = await setup([])
    const first = await ctx.agentTeams.createTask(lead, { subject: 'Fit the model', description: 'd' })
    await expect(ctx.agentTeams.createTask(lead, { subject: '  fit   THE model ', description: 'd' }))
      .rejects.toMatchObject({
        code: 'TEAM_TASK_DUPLICATE_SUBJECT',
        message: 'subject "fit   THE model" is already live task "task-1" (pending); depend on it or edit it instead of creating a twin',
      })
    const second = await ctx.agentTeams.createTask(lead, { subject: 'Plot the fit', description: 'd' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: second.id, expectedRevision: second.revision, action: 'edit', subject: 'fit the model',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DUPLICATE_SUBJECT' })
    const renamed = await ctx.agentTeams.updateTask(lead, {
      taskId: second.id, expectedRevision: second.revision, action: 'edit', subject: 'Plot the fit', description: 'refined',
    })
    expect(renamed.subject).toBe('Plot the fit')

    const claimed = await ctx.agentTeams.updateTask(lead, { taskId: first.id, expectedRevision: first.revision, action: 'claim' })
    await ctx.agentTeams.updateTask(lead, { taskId: first.id, expectedRevision: claimed.revision, action: 'complete' })
    const again = await ctx.agentTeams.createTask(lead, { subject: 'Fit the model', description: 'a second pass' })
    expect(again.id).toBe('task-3')
    await expect(ctx.agentTeams.createTask(lead, { subject: 'fit the model', description: 'd' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_DUPLICATE_SUBJECT' })
    await ctx.agentTeams.updateTask(lead, { taskId: again.id, expectedRevision: again.revision, action: 'delete' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'fit the model', description: 'd' })).resolves.toMatchObject({ id: 'task-4' })
  })

  it('points a lost twin at reopen', async () => {
    const { ctx, lead } = await setup([])
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Verify', description: 'd' })
    const claimed = await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    await ctx.agentTeams.markLost(lead, claimed.id, 'run-ended')
    await expect(ctx.agentTeams.createTask(lead, { subject: 'verify', description: 'd' })).rejects.toMatchObject({
      code: 'TEAM_TASK_DUPLICATE_SUBJECT',
      message: 'subject "verify" is already live task "task-1" (lost); reopen it instead of creating a twin',
    })
  })
})

describe('Notes are edges', () => {
  it('records a note on a live task, mails the owner, folds it into the brief, and refuses notes to settled tasks', async () => {
    // The mailed note resumes the inactive owner, which answers with the second scripted reply.
    const { ctx, lead } = await setup([textResponse('mate done'), textResponse('noted')])
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Fit', description: 'd' })
    const noted = await ctx.agentTeams.noteTask(lead, { taskId: task.id, text: '  use the second seed  ', signal: SIGNAL })
    expect(noted).toMatchObject({ id: task.id, revision: 2, noteId: 'task-1-note-1', held: [], notes: [{ id: 'task-1-note-1', from: 'lead', text: 'use the second seed' }] })
    const claimed = await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: noted.revision, action: 'claim' })
    expect(claimed.brief).toContain('Notes sent to this task:\n- task-1-note-1 from lead: use the second seed')

    const mate = await spawn(ctx, lead, 'mate')
    await vi.waitFor(() => { expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ status: 'inactive', lastStop: 'completed' }) })
    const other = await ctx.agentTeams.createTask(lead, { subject: 'Plot', description: 'd' })
    const assigned = await ctx.agentTeams.updateTask(lead, { taskId: other.id, expectedRevision: other.revision, action: 'reassign', owner: 'mate' })
    const second = await ctx.agentTeams.noteTask(lead, { taskId: other.id, text: 'plot in log scale', signal: SIGNAL })
    expect(second.noteId).toBe('task-2-note-1')
    await vi.waitFor(() => {
      const queued = lead.session.snapshotEvents().flatMap(event => (event.type === 'team/message/queued' ? [event.data.message] : []))
      expect(queued.some(message => message.targetId === mate.member.id
        && message.content.some(block => block.type === 'text' && block.text === 'Note task-2-note-1 on task-2:\n\nplot in log scale'))).toBe(true)
    }, { timeout: 5_000 })
    expect(assigned.ownerName).toBe('mate')
    await vi.waitFor(() => {
      expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ status: 'inactive' })
      expect(durable(lead).pendingMessages).toHaveLength(0)
    }, { timeout: 10_000 })

    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: claimed.revision, action: 'complete' })
    await expect(ctx.agentTeams.noteTask(lead, { taskId: task.id, text: 'too late', signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    await expect(ctx.agentTeams.noteTask(lead, { taskId: TeamTaskId('task-9'), text: 'x', signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await expect(ctx.agentTeams.noteTask(lead, { taskId: other.id, text: '   ', signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
  }, 20_000)

  it('holds a task whose declared output a note names until the Lead acknowledges', async () => {
    const { ctx, lead } = await setup([])
    const producer = await ctx.agentTeams.createTask(lead, {
      subject: 'Produce', description: 'd', outputs: [{ path: 'out/model.json', kind: 'json' }],
    })
    const consumer = await ctx.agentTeams.createTask(lead, { subject: 'Consume', description: 'd' })
    const claimed = await ctx.agentTeams.updateTask(lead, { taskId: producer.id, expectedRevision: producer.revision, action: 'claim' })
    const noted = await ctx.agentTeams.noteTask(lead, {
      taskId: consumer.id, text: 'out/model.json is missing the bias term', signal: SIGNAL,
    })
    expect(noted.held).toEqual([producer.id])
    const held = ctx.agentTeams.getTask(lead, producer.id)
    expect(held).toMatchObject({ revision: claimed.revision + 1, holds: [{ note: 'task-2-note-1', task: consumer.id, from: 'lead' }] })
    await expect(ctx.agentTeams.updateTask(lead, { taskId: producer.id, expectedRevision: held.revision, action: 'complete' }))
      .rejects.toMatchObject({
        code: 'TEAM_TASK_HELD',
        message: 'team task "task-1" is held until the Lead acknowledges: task-2-note-1 on task-2 from lead',
      })
    await expect(ctx.agentTeams.updateTask(lead, { taskId: producer.id, expectedRevision: held.revision, action: 'acknowledge', note: 'nope' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const acknowledged = await ctx.agentTeams.updateTask(lead, {
      taskId: producer.id, expectedRevision: held.revision, action: 'acknowledge', note: 'task-2-note-1',
    })
    expect(acknowledged.holds).toBeUndefined()
    // Past the hold, complete reaches the output check; this setup mounts no filesystem service.
    await expect(ctx.agentTeams.updateTask(lead, { taskId: producer.id, expectedRevision: acknowledged.revision, action: 'complete' }))
      .rejects.toMatchObject({ code: 'TEAM_OUTPUTS_UNCHECKABLE' })
  })

  it('warns when the note mail cannot be sent and refuses an acknowledgement that names no hold', async () => {
    const { ctx, lead } = await setup([textResponse('mate initial')])
    const mate = await spawn(ctx, lead, 'mate')
    await vi.waitFor(() => { expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ status: 'inactive' }) })
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Fit', description: 'd' })
    const assigned = await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'mate' })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(teamInternals(ctx).mailbox, 'send').mockRejectedValueOnce(new Error('mailbox closed'))
    const noted = await ctx.agentTeams.noteTask(lead, { taskId: task.id, text: 'a note', signal: SIGNAL })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not mail note task-1-note-1')) })
    await expect(ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: noted.revision, action: 'acknowledge' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT', message: 'team task "task-1" is not held by note ""' })
    expect(assigned.ownerName).toBe('mate')
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toHaveLength(0) }, { timeout: 10_000 })
    await waitNoAgent(ctx, mate.member.id)
  }, 20_000)

  it('lets only the Lead acknowledge and keeps other holds when one is cleared', async () => {
    const { ctx, lead } = await setup(['hang'])
    const producer = await ctx.agentTeams.createTask(lead, {
      subject: 'Produce', description: 'd', outputs: [{ path: 'a.csv', kind: 'csv' }, { path: 'b.csv', kind: 'csv' }],
    })
    const consumer = await ctx.agentTeams.createTask(lead, { subject: 'Consume', description: 'd' })
    await ctx.agentTeams.noteTask(lead, { taskId: consumer.id, text: 'a.csv looks truncated', signal: SIGNAL })
    await ctx.agentTeams.noteTask(lead, { taskId: consumer.id, text: 'b.csv too', signal: SIGNAL })
    const held = ctx.agentTeams.getTask(lead, producer.id)
    expect(held.holds?.map(hold => hold.note)).toEqual(['task-2-note-1', 'task-2-note-2'])
    const mate = await spawn(ctx, lead, 'mate')
    const mateAgent = await waitRunning(ctx, mate.member.id)
    await expect(ctx.agentTeams.updateTask(mateAgent, { taskId: producer.id, expectedRevision: held.revision, action: 'acknowledge', note: 'task-2-note-1' }))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    const once = await ctx.agentTeams.updateTask(lead, { taskId: producer.id, expectedRevision: held.revision, action: 'acknowledge', note: 'task-2-note-1' })
    expect(once.holds?.map(hold => hold.note)).toEqual(['task-2-note-2'])
    ctx.agentTeams.interrupt(lead, 'mate')
    await waitNoAgent(ctx, mate.member.id)
  }, 20_000)
})

describe('Artifact contracts', () => {
  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-team-workspace-'))
    roots.push(dir)
    return dir
  }

  const sha = (text: string) => createHash('sha256').update(text).digest('hex')

  it('normalizes and validates declared outputs and refuses a path another live task declares', async () => {
    const { ctx, lead } = await setup([], {}, workspace())
    const bare = await ctx.agentTeams.createTask(lead, { subject: 'bare', description: 'no outputs', edgeInstructions: {} })
    expect(bare).not.toHaveProperty('edgeInstructions')
    expect(bare.outputs).toEqual([])
    for (const [outputs, code] of [
      [[{ path: '../escape.txt', kind: 'file' }], 'TEAM_INVALID_WRITE_SCOPE'],
      [[{ path: 'a.txt', kind: 'file' }, { path: './a.txt', kind: 'file' }], 'TEAM_INVALID_ARGUMENT'],
      [[{ path: 'a.csv', kind: 'csv', schema: { type: 'object' } }], 'TEAM_INVALID_ARGUMENT'],
      [[{ path: 'a.json', kind: 'json', schema: { type: 'nonsense' } }], 'TEAM_INVALID_ARGUMENT'],
    ] as const) {
      await expect(ctx.agentTeams.createTask(lead, { subject: 'bad', description: 'bad', outputs }))
        .rejects.toMatchObject({ code })
    }
    const first = await ctx.agentTeams.createTask(lead, {
      subject: 'first', description: 'first', outputs: [{ path: './out/a.json', kind: 'json', schema: { type: 'object' }, optional: false }],
    })
    expect(first.outputs).toEqual([{ path: 'out/a.json', kind: 'json', schema: { type: 'object' }, optional: false }])
    expect(durable(lead).tasks[1]?.outputs).toEqual(first.outputs)
    await expect(ctx.agentTeams.createTask(lead, { subject: 'second', description: 'second', outputs: [{ path: 'out/a.json', kind: 'file' }] }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_OUTPUT_CONFLICT' })
    const other = await ctx.agentTeams.createTask(lead, { subject: 'other', description: 'other', outputs: [{ path: 'b.txt', kind: 'file' }] })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: other.id, expectedRevision: other.revision, action: 'edit', outputs: [{ path: 'out/a.json', kind: 'file' }],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_OUTPUT_CONFLICT' })
    const cleared = await ctx.agentTeams.updateTask(lead, {
      taskId: other.id, expectedRevision: other.revision, action: 'edit', outputs: [],
    })
    expect(cleared.outputs).toEqual([])
    expect(durable(lead).tasks[2]).not.toHaveProperty('outputs')
    // A task with no declared outputs still needs something to edit.
    await expect(ctx.agentTeams.updateTask(lead, { taskId: other.id, expectedRevision: cleared.revision, action: 'edit' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
  })

  it('refuses completion until every declared output exists and passes its check, then records the artifacts', async () => {
    const dir = workspace()
    const { ctx, lead } = await setup([], {}, dir)
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'deliver', description: 'deliver', outputs: [
        { path: 'out/a.json', kind: 'json', schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false } },
        { path: 'data.csv', kind: 'csv' },
        { path: 'arr.npy', kind: 'npy' },
        { path: 'fig.png', kind: 'image' },
        { path: 'entry.py', kind: 'python' },
        { path: 'plain.bin', kind: 'file' },
        { path: 'notes.txt', kind: 'file', optional: true },
        { path: 'out/b.json', kind: 'json' },
      ],
    })
    const claimed = await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    expect(claimed.brief).toContain('- out/a.json (json, schema declared)')
    expect(claimed.brief).toContain('- entry.py (python, must run alone: no imports of workspace modules)')
    expect(claimed.brief).toContain('- notes.txt (file, optional)')
    const complete = () => ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: claimed.revision, action: 'complete' })
    await expect(complete()).rejects.toMatchObject({ code: 'TEAM_TASK_OUTPUT_MISSING' })
    await expect(complete()).rejects.toThrow('out/a.json: declared, not produced; data.csv: declared, not produced')

    mkdirSync(join(dir, 'out'))
    writeFileSync(join(dir, 'out/a.json'), '{not json')
    writeFileSync(join(dir, 'data.csv'), 'a,b\n')
    writeFileSync(join(dir, 'arr.npy'), 'nope')
    writeFileSync(join(dir, 'fig.png'), 'nope')
    mkdirSync(join(dir, 'helper'))
    writeFileSync(join(dir, 'helper/__init__.py'), '')
    writeFileSync(join(dir, 'sibling.py'), 'X = 1\n')
    writeFileSync(join(dir, 'entry.py'), 'import os, sibling\nfrom helper.sub import thing\nfrom . import rel\nimport json\n')
    mkdirSync(join(dir, 'plain.bin'))
    await expect(complete()).rejects.toThrow(new RegExp([
      'out/a\\.json: is not valid JSON .*',
      'data\\.csv: has no data rows below its header',
      'arr\\.npy: is not a NumPy \\.npy file',
      'fig\\.png: is not a PNG, JPEG, GIF, or WebP image',
      'entry\\.py: imports workspace modules \\(sibling, helper, a relative import\\), so it does not run alone',
      'plain\\.bin: is a directory, not a file',
    ].join('; '), 'u'))

    writeFileSync(join(dir, 'out/a.json'), '{"x":"1"}')
    await expect(complete()).rejects.toThrow('out/a.json: does not match its schema')
    writeFileSync(join(dir, 'out/a.json'), '{"x":1}')
    writeFileSync(join(dir, 'out/b.json'), '{}')
    writeFileSync(join(dir, 'data.csv'), 'a,b\n1,2\n')
    writeFileSync(join(dir, 'arr.npy'), Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]))
    writeFileSync(join(dir, 'fig.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
    writeFileSync(join(dir, 'entry.py'), 'import os\nimport json\nprint(1)\n')
    rmSync(join(dir, 'plain.bin'), { recursive: true })
    writeFileSync(join(dir, 'plain.bin'), '')
    await expect(complete()).rejects.toThrow('plain.bin: is empty')
    writeFileSync(join(dir, 'plain.bin'), 'x')

    const completed = await complete()
    expect(completed.status).toBe('completed')
    expect(completed.artifacts).toEqual([
      { path: 'out/a.json', bytes: 7, sha256: sha('{"x":1}') },
      { path: 'data.csv', bytes: 8, sha256: sha('a,b\n1,2\n') },
      { path: 'arr.npy', bytes: 8, sha256: createHash('sha256').update(Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0])).digest('hex') },
      { path: 'fig.png', bytes: 6, sha256: createHash('sha256').update(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])).digest('hex') },
      { path: 'entry.py', bytes: 31, sha256: sha('import os\nimport json\nprint(1)\n') },
      { path: 'plain.bin', bytes: 1, sha256: sha('x') },
      { path: 'out/b.json', bytes: 2, sha256: sha('{}') },
    ])
    expect(durable(lead).tasks[0]?.artifacts).toEqual(completed.artifacts)
    const reopened = await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: completed.revision, action: 'reopen' })
    expect(reopened).not.toHaveProperty('artifacts')
    expect(durable(lead).tasks[0]).not.toHaveProperty('artifacts')
  })

  it('records supersession and retains the previous version under the artifact root', async () => {
    const dir = workspace()
    const artifactRoot = join(workspace(), 'retained')
    // The Lead records no cwd here, so paths resolve against the filesystem's own base.
    const { ctx, lead } = await setup([], { artifactRoot }, dir, false)
    // A completed task with no outputs has no artifacts to supersede.
    const bare = await ctx.agentTeams.createTask(lead, { subject: 'bare', description: 'bare' })
    const bareClaim = await ctx.agentTeams.updateTask(lead, { taskId: bare.id, expectedRevision: bare.revision, action: 'claim' })
    await ctx.agentTeams.updateTask(lead, { taskId: bare.id, expectedRevision: bareClaim.revision, action: 'complete' })
    const produce = async (subject: string, content: string) => {
      const task = await ctx.agentTeams.createTask(lead, { subject, description: subject, outputs: [{ path: 'r.py', kind: 'python' }] })
      const claimed = await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
      writeFileSync(join(dir, 'r.py'), content)
      return ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: claimed.revision, action: 'complete' })
    }
    const one = 'import os\n'
    const two = 'import sys\n'
    const three = 'import json\n'
    const record = (content: string) => ({ path: 'r.py', bytes: content.length, sha256: sha(content) })
    const first = await produce('first', one)
    expect(first.artifacts).toEqual([record(one)])
    const retainedFirst = join(artifactRoot, 'lead', first.id, 'r.py')
    expect(readFileSync(retainedFirst, 'utf8')).toBe(one)

    const same = await produce('same', one)
    expect(same.artifacts).toEqual([record(one)])

    const second = await produce('second', two)
    expect(second.artifacts).toEqual([{
      ...record(two),
      supersedes: { task: same.id, sha256: sha(one) },
      previousVersion: join(artifactRoot, 'lead', same.id, 'r.py'),
    }])
    expect(readFileSync(second.artifacts![0]!.previousVersion!, 'utf8')).toBe(one)
    expect(readFileSync(join(dir, 'r.py'), 'utf8')).toBe(two)

    // A superseded version that was not retained is not named.
    unlinkSync(join(artifactRoot, 'lead', second.id, 'r.py'))
    const third = await produce('third', three)
    expect(third.artifacts![0]).toMatchObject({ supersedes: { task: second.id } })
    expect(third.artifacts![0]).not.toHaveProperty('previousVersion')
  })

  it('scans Python imports for workspace modules, tolerating malformed import lines', () => {
    expect(pythonImports('import os, sibling,\nfrom .pkg import x\nfrom helper.sub import thing\nimport json as j\nprint(1)\n'))
      .toEqual(['os', 'sibling', '.', 'helper', 'json'])
  })

  it('cannot complete a task with declared outputs without the fs service', async () => {
    const { ctx, lead } = await setup([])
    const task = await ctx.agentTeams.createTask(lead, { subject: 'deliver', description: 'deliver', outputs: [{ path: 'a.txt', kind: 'file' }] })
    const claimed = await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
    await expect(ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: claimed.revision, action: 'complete' }))
      .rejects.toMatchObject({ code: 'TEAM_OUTPUTS_UNCHECKABLE' })
  })

  it('carries edge instructions into the brief and mails the brief to a reassigned member', async () => {
    const dir = workspace()
    const { ctx, lead } = await setup([textResponse('mate initial'), textResponse('brief received')], {}, dir)
    const source = await ctx.agentTeams.createTask(lead, { subject: 'source', description: 'source', outputs: [{ path: 'a.txt', kind: 'file' }] })
    const claimed = await ctx.agentTeams.updateTask(lead, { taskId: source.id, expectedRevision: source.revision, action: 'claim' })
    writeFileSync(join(dir, 'a.txt'), 'hello')
    await ctx.agentTeams.updateTask(lead, { taskId: source.id, expectedRevision: claimed.revision, action: 'complete' })

    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'bad', description: 'bad', blockedBy: [source.id], edgeInstructions: { 'task-9': 'nope' },
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const consumer = await ctx.agentTeams.createTask(lead, {
      subject: 'consumer', description: 'use the source', blockedBy: [source.id], edgeInstructions: { [source.id]: 'read a.txt' },
    })
    expect(consumer.edgeInstructions).toEqual({ [source.id]: 'read a.txt' })
    const rewired = await ctx.agentTeams.updateTask(lead, {
      taskId: consumer.id, expectedRevision: consumer.revision, action: 'set_dependencies', blockedBy: [source.id],
    })
    expect(rewired).not.toHaveProperty('edgeInstructions')
    const restored = await ctx.agentTeams.updateTask(lead, {
      taskId: consumer.id, expectedRevision: rewired.revision, action: 'set_dependencies', blockedBy: [source.id], edgeInstructions: { [source.id]: 'read a.txt' },
    })
    const briefed = await ctx.agentTeams.updateTask(lead, { taskId: consumer.id, expectedRevision: restored.revision, action: 'claim' })
    expect(briefed.brief).toBe([
      `Task ${consumer.id}: consumer`,
      'use the source',
      '',
      'Inputs:',
      `- ${source.id} "source" (completed): a.txt (5 bytes, sha256 ${sha('hello').slice(0, 12)}); instruction: read a.txt`,
      '',
      'Outputs (definition of done; complete is refused until every non-optional one exists on disk and passes its check):',
      '- none declared',
    ].join('\n'))
    const released = await ctx.agentTeams.updateTask(lead, { taskId: consumer.id, expectedRevision: briefed.revision, action: 'release' })
    expect(released).not.toHaveProperty('brief')

    const started = await spawn(ctx, lead, 'mate')
    await vi.waitFor(() => { expect(ctx.agentTeams.listMembers(lead)[1]?.lastStop).toBe('completed') })
    const assigned = await ctx.agentTeams.updateTask(lead, {
      taskId: consumer.id, expectedRevision: released.revision, action: 'reassign', owner: 'mate',
    })
    expect(assigned.brief).toContain(`Task ${consumer.id}: consumer`)
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) }, { timeout: 5_000 })
    const mail = (await storedEvents(ctx, started.member.id))
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'team-message')
      .map(event => event.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
    expect(mail.some(text => text.includes(`You were assigned ${consumer.id} by the Lead.`) && text.includes('instruction: read a.txt'))).toBe(true)
    // Reassigning to the Lead itself hands the brief back without mail.
    const unassigned = await ctx.agentTeams.updateTask(lead, { taskId: consumer.id, expectedRevision: assigned.revision, action: 'reassign' })
    const toLead = await ctx.agentTeams.updateTask(lead, { taskId: consumer.id, expectedRevision: unassigned.revision, action: 'reassign', owner: 'lead' })
    expect(toLead.brief).toContain('Inputs:')
    expect(durable(lead).pendingMessages).toEqual([])
  })

  it('warns when the brief mail cannot be sent', async () => {
    const { ctx, lead } = await setup([textResponse('mate initial')])
    await spawn(ctx, lead, 'mate')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(teamInternals(ctx).mailbox, 'send').mockRejectedValueOnce(new Error('mailbox closed'))
    const task = await ctx.agentTeams.createTask(lead, { subject: 'work', description: 'work' })
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'mate' })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not mail the brief')) })
  })
})
