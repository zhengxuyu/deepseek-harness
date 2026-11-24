/** Agent Teams service façade over roster, mailbox, task, and runtime lifecycle owners. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SubagentRuntime, SubagentRunEndInfo, SubagentRunId, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TeamActivity } from './activity.ts'
import { errorMessage, TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { TeamRuntimeLifecycle } from './lifecycle.ts'
import { TeamMailbox } from './mailbox.ts'
import { teamProjectionDefinition } from './projection.ts'
import { TeamRoster } from './roster.ts'
import type { TeamMembership } from './roster.ts'
import { TeamTaskBoard } from './task-board.ts'
import type { DisplacedOwner } from './task-board.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  Config,
  CreateTeamTaskRequest,
  OutstandingTeamTask,
  SendTeamMessageRequest,
  SendTeamMessageResult,
  SpawnTeammateRequest,
  SpawnTeammateResult,
  TeamMemberView,
  TeamTaskLostCause,
  TeamTaskView,
  TeamView,
  TeamWaitResult,
  UpdateTeamTaskRequest,
} from './types.ts'

export type * from './types.ts'
export type { TeamMembership } from './roster.ts'
export { TeamId, TeamMessageId, TeamTaskId } from './types.ts'
export { TeamError } from './error.ts'
export { taskOpen, taskOutstanding, taskStarted, taskUncollected } from './task-status.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
  }
}

const DEFAULT_MAX_MEMBERS = 16
const DEFAULT_MAX_TASKS = 256
const DEFAULT_MAX_PENDING_MESSAGES = 64
const DEFAULT_MAX_MESSAGE_BYTES = 65_536
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000

/** One delegated run below a Lead, keyed by its lifecycle run id: a member's turn or a tracked plain run. */
interface TrackedRun {
  readonly root: Agent
  readonly childId: SessionId
  readonly local: boolean
  /** The board row of a tracked plain run, settled once its creation transaction commits; absent for a member's turn. */
  readonly task?: Promise<TeamTaskView>
}

/** Validate one positive safe-integer deployment limit. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

  static Config: z<Config> = z.object({
    maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_MESSAGES),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
    trackSubagentRuns: z.boolean().default(false),
  })

  /** Validated deployment limits used by every Team operation. */
  private readonly config: Required<Config>
  /** Member turns and, with `trackSubagentRuns`, plain delegated runs still in flight. */
  private readonly runs = new Map<SubagentRunId, TrackedRun>()

  private readonly activity: TeamActivity
  private readonly lifecycle: TeamRuntimeLifecycle
  private readonly journal: TeamJournal
  private readonly roster: TeamRoster
  private readonly mailbox: TeamMailbox
  private readonly tasks: TeamTaskBoard

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentTeams')
    this.config = {
      maxMembers: positiveLimit('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS),
      maxTasks: positiveLimit('maxTasks', config.maxTasks ?? DEFAULT_MAX_TASKS),
      maxPendingMessagesPerMember: positiveLimit(
        'maxPendingMessagesPerMember',
        config.maxPendingMessagesPerMember ?? DEFAULT_MAX_PENDING_MESSAGES,
      ),
      maxMessageBytes: positiveLimit('maxMessageBytes', config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
      disposalTimeoutMs: positiveLimit(
        'disposalTimeoutMs',
        config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
      ),
      trackSubagentRuns: config.trackSubagentRuns ?? false,
    }

    this.activity = new TeamActivity()
    this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs)
    this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) })
    this.roster = new TeamRoster(ctx, this.journal, this.lifecycle, this.config.maxMembers)
    this.mailbox = new TeamMailbox(
      ctx,
      this.journal,
      this.roster,
      this.lifecycle,
      this.config.maxPendingMessagesPerMember,
      this.config.maxMessageBytes,
    )
    this.tasks = new TeamTaskBoard(this.journal, this.config.maxTasks)

    ctx.on('session/event', (session, event) => {
      this.mailbox.observeSessionEvent(session, event)
      this.observeMemberFailure(session, event)
    })
    ctx.on('agent/created', ({ agent }) => { this.scheduleRecovery(agent) })
    ctx.on('agent/status', ({ agent }) => {
      const membership = this.roster.tryMembership(agent)
      if (membership !== undefined) this.activity.notify(membership.id)
    })
    const observeRunStart = (parent: Agent, info: SubagentRunInfo): void => { this.observeRunStart(parent, info) }
    // The delegating parent travels as the scoped dispatch carrier, not in the payload.
    ctx.on('subagent/start', function (this: Scoped<SubagentRuntime>, info: SubagentRunInfo) {
      observeRunStart(carrierKeyOf(this) as Agent, info)
    })
    ctx.on('subagent/end', (info: SubagentRunEndInfo) => { this.observeRunEnd(info) })
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(teamProjectionDefinition)
      return async () => {
        try {
          await this.disposeRuntime()
        } finally {
          disposeProjection()
        }
      }
    }, 'agentTeams.runtimeLifecycle()')
    for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    return this.roster.membership(agent)
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param agent - exact live Team member.
   * @returns Lead and teammate rows in creation order.
   */
  listMembers(agent: Agent): TeamMemberView[] {
    return this.roster.list(this.roster.membership(agent))
  }

  /**
   * Create one named, continuable direct child of the Team Lead.
   * @param caller - exact live Lead Agent.
   * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
   * @returns the active roster row.
   */
  async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    return await this.roster.spawn(caller, request)
  }

  /**
   * Queue one durable peer message, then attempt immediate delivery.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, and pre-queue cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    return await this.mailbox.send(caller, request)
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.create(this.roster.membership(caller), request)
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param caller - exact live Team member reading the task.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView {
    return this.tasks.get(this.roster.membership(caller), id)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param caller - exact live Team member reading the board.
   * @returns detached current task views.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    return this.tasks.list(this.roster.membership(caller))
  }

  /**
   * Compare-and-set one authorized task transition. When the Lead takes an
   * in-progress task from a teammate, by unassigning it, reassigning it, or
   * completing it, the teammate is told through its Team mailbox; a teammate
   * that then holds no other in-progress task has its current turn interrupted.
   * @param caller - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    const { view, displaced } = await this.tasks.update(caller, this.roster.membership(caller), request)
    if (displaced !== undefined) await this.tellDisplacedOwner(caller, view, displaced)
    return view
  }

  /**
   * Record work the caller has already begun as an in-progress task it owns.
   * Any member may be the caller; the harness uses it for work no member
   * created a task for, such as the request a run was started with.
   * @param caller - exact live Team member that owns the work.
   * @param request - subject and description of the work.
   * @returns the revision-one task view, in progress and owned by the caller.
   */
  async beginTask(caller: Agent, request: Pick<CreateTeamTaskRequest, 'subject' | 'description'>): Promise<TeamTaskView> {
    const { root } = this.roster.membership(caller)
    return await this.tasks.trackRun(root, { ...request, ownerId: caller.id })
  }

  /**
   * Complete one in-progress task on behalf of the harness, bypassing member authorization.
   * @param caller - exact live Team member whose board holds the task.
   * @param id - task the harness observed finished.
   * @returns the completed task view.
   */
  async markCompleted(caller: Agent, id: TeamTaskId): Promise<TeamTaskView> {
    return await this.tasks.completeRun(this.roster.membership(caller).root, id)
  }

  /**
   * List in-progress tasks on the caller's Team board with whether each owner is still running.
   * @param caller - exact live Team member reading the board.
   * @returns outstanding rows in creation order; empty once every claimed task settled.
   */
  outstandingTasks(caller: Agent): OutstandingTeamTask[] {
    const { root } = this.roster.membership(caller)
    const inFlight = new Set<SessionId>()
    for (const run of this.runs.values()) {
      if (run.root === root && run.task !== undefined && !run.local) inFlight.add(run.childId)
    }
    return this.tasks.outstanding(root, ownerId =>
      inFlight.has(ownerId) || this.ctx.agents.get(ownerId)?.status === 'running')
  }

  /**
   * Mark one in-progress task `lost` on behalf of the harness; the owner stays recorded.
   * @param caller - exact live Team member whose board holds the task.
   * @param id - task whose owner can no longer finish it.
   * @param cause - why the harness gave up on the owner.
   * @returns the lost task view.
   */
  async markLost(caller: Agent, id: TeamTaskId, cause: TeamTaskLostCause): Promise<TeamTaskView> {
    return await this.tasks.markLost(this.roster.membership(caller).root, id, cause)
  }

  /**
   * Wait for the next Team-domain or member-status change.
   * @param caller - exact live Team member waiting for activity.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for the wait only.
   * @returns one observed change or a timeout result.
   */
  async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    const membership = this.roster.membership(caller)
    return await this.activity.wait(membership.id, timeoutMs, signal)
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' } {
    return this.roster.interrupt(caller, targetName)
  }

  /**
   * Interrupt the current turn of every running teammate and wait until each is idle.
   * Pending inboxes are kept. The harness uses it when a run ends with teammates still working.
   * @param caller - exact live Lead Agent.
   * @returns the names of the teammates that were running, in roster order.
   */
  async interruptTeammates(caller: Agent): Promise<string[]> {
    return await this.roster.interruptRunning(caller)
  }

  /**
   * Resolve a caller without throwing, used by scoped-tool installation and observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.roster.tryMembership(agent)
  }

  /**
   * Read the current roster and non-deleted task board through the generated Remote API.
   * @param agent - exact live Team member used as the authority credential.
   * @returns detached current roster and task views.
   */
  @Remote('view')
  remoteView(agent: Agent): TeamView {
    return {
      members: this.listMembers(agent),
      tasks: this.listTasks(agent),
    }
  }

  /** A member that failed provisioning can never finish what it claimed while provisioning. */
  private observeMemberFailure(session: Session, event: SessionEvent): void {
    if (event.type !== 'team/member' || event.data.member.phase !== 'failed') return
    const root = this.ctx.agents.get(session.id)
    /* v8 ignore next -- the journal appends member records only to a live Lead; the Lead can vanish only in a teardown race. */
    if (root === undefined) return
    const memberId = event.data.member.id
    // The failed edge commits inside a roster transaction on this root; the
    // task transaction queues behind it instead of nesting.
    void this.tasks.markOwnerLost(root, memberId, 'owner-failed').catch((error: unknown) => {
      this.ctx.logger.warn(`Agent Teams could not mark tasks of failed member "${memberId}" lost: ${errorMessage(error)}`)
    })
  }

  /**
   * Tell a teammate that the Lead took its in-progress task, and stop its turn
   * when that was its only one. The task change is already committed, so a
   * notice that cannot be queued is logged and does not fail the change.
   */
  private async tellDisplacedOwner(lead: Agent, task: TeamTaskView, displaced: DisplacedOwner): Promise<void> {
    const owner = this.journal.state(lead).members.find(member => member.id === displaced.ownerId)
    // A tracked plain run owns its row under a child Session id and has no mailbox.
    if (owner === undefined || owner.phase !== 'active') return
    const running = this.ctx.agents.get(owner.id)?.status === 'running'
    const why = displaced.reason === undefined ? '' : ` (reason: ${displaced.reason})`
    const text = `Task ${task.id} "${task.subject}" is no longer yours: the Lead ${displaced.action}${why}. `
      + 'Stop working on it and do not change its files further.'
    try {
      await this.mailbox.send(lead, { target: owner.name, content: [{ type: 'text', text }], signal: this.lifecycle.signal })
    } catch (error: unknown) {
      this.ctx.logger.warn(`Agent Teams could not tell "${owner.name}" that it lost ${task.id}: ${errorMessage(error)}`)
    }
    if (running && displaced.idle) this.roster.interrupt(lead, owner.name)
  }

  /** Follow a member's turn for its outcome, or record a plain delegated run on the nearest Team board above its parent. */
  private observeRunStart(parent: Agent, info: SubagentRunInfo): void {
    const root = this.leadOf(parent)
    if (root === undefined) return
    if (this.journal.state(root).members.some(member => member.id === info.id)) {
      this.runs.set(info.runId, { root, childId: info.id, local: info.local })
      return
    }
    if (!this.config.trackSubagentRuns) return
    const task = this.tasks.trackRun(root, {
      subject: `subagent run via ${info.provider}`,
      description: `Delegated by ${parent.id} to provider ${info.provider}; child session ${info.id}.`,
      ownerId: info.id,
    })
    task.catch((error: unknown) => {
      this.ctx.logger.warn(`Agent Teams could not record subagent run "${info.runId}": ${errorMessage(error)}`)
    })
    this.runs.set(info.runId, { root, childId: info.id, local: info.local, task })
  }

  /**
   * Settle what the ended run held. A member's turn that ended any way other
   * than `completed` or `aborted` loses the member's in-progress tasks: an
   * aborted turn was interrupted on purpose and the member can continue, any
   * other ending means it stopped without finishing. A tracked row completes
   * when its run completed and is lost on any other stop reason.
   */
  private observeRunEnd(info: SubagentRunEndInfo): void {
    const run = this.runs.get(info.runId)
    if (run === undefined) return
    this.runs.delete(info.runId)
    if (run.task === undefined) {
      if (info.stopReason === 'completed' || info.stopReason === 'aborted') return
      void this.tasks.markOwnerLost(run.root, run.childId, 'owner-failed').catch((error: unknown) => {
        this.ctx.logger.warn(`Agent Teams could not mark tasks of member "${run.childId}" lost after its turn ended ${info.stopReason}: ${errorMessage(error)}`)
      })
      return
    }
    // A row that was never recorded was already reported at start.
    void run.task.then(
      view => info.stopReason === 'completed'
        ? this.tasks.completeRun(run.root, view.id)
        : this.tasks.markLost(run.root, view.id, 'owner-failed'),
      () => undefined,
    ).catch((error: unknown) => {
      this.ctx.logger.warn(`Agent Teams could not settle subagent run "${info.runId}": ${errorMessage(error)}`)
    })
  }

  /** The Lead whose board records work delegated below `agent`, or undefined outside every live Team. */
  private leadOf(agent: Agent): Agent | undefined {
    for (let cursor: Agent | undefined = agent; cursor !== undefined;) {
      const membership = this.roster.tryMembership(cursor)
      if (membership !== undefined) return membership.root
      const parentId: SessionId | undefined = cursor.session.header.parentSession
      cursor = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
    }
    return undefined
  }

  /** Queue one contained recovery pass after publication has unwound. */
  private scheduleRecovery(agent: Agent): void {
    queueMicrotask(() => {
      if (this.lifecycle.disposed) return
      void this.recoverFor(agent).catch((error: unknown) => {
        if (this.lifecycle.disposed) return
        this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`)
      })
    })
  }

  /** Reconcile roster provisioning before retrying that member's pending mailbox. */
  private async recoverFor(agent: Agent): Promise<void> {
    await this.roster.recoverFor(agent, this.lifecycle.signal)
    await this.mailbox.recoverFor(agent, this.lifecycle.signal)
  }

  /** Stop Team-owned live branches and release every waiter before service disposal completes. */
  private async disposeRuntime(): Promise<void> {
    this.lifecycle.close()
    this.activity.close()

    const failures: unknown[] = []
    await this.lifecycle.settle(this.roster.pendingCreations(), failures)
    await this.lifecycle.settle(this.mailbox.pendingDispatches(), failures)
    for (const [root, childIds] of this.roster.liveChildrenByRoot()) {
      try {
        await this.roster.stopTeammates(root, childIds)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams runtime disposal failed')
  }
}

export default TeamService
