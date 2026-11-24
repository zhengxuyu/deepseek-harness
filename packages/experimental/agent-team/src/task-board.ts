/** Shared Team task DAG commands and runtime-enriched views. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamMembership } from './roster.ts'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamState } from './projection.ts'
import { resolveActiveMember } from './roster.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
import { isOutstanding, taskOpen, taskStarted } from './task-status.ts'
import type { TeamTaskGraphViolation } from './task-graph.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  CreateTeamTaskRequest,
  DeletedTeamTask,
  InProgressTeamTask,
  LostTeamTask,
  OutstandingTeamTask,
  PendingTeamTask,
  TeamTaskFields,
  TeamTaskLostCause,
  TeamTaskSnapshot,
  TeamTaskView,
  UpdateTeamTaskRequest,
} from './types.ts'
import { requiredText, writeScope } from './validation.ts'

/** Whether two normalized file or directory prefixes overlap on path components. */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

const TASK_GRAPH_ERROR_CODES: Record<TeamTaskGraphViolation, string> = {
  missing: 'TEAM_TASK_NOT_FOUND',
  duplicate: 'TEAM_INVALID_ARGUMENT',
  cycle: 'TEAM_TASK_DEPENDENCY_CYCLE',
}

/** Work already under way that the harness records on the Lead board as one owned in-progress task. */
export interface TrackedRunRequest {
  readonly subject: string
  readonly description: string
  readonly ownerId: SessionId
}

/** The fields a transition carries over unchanged, with the status, owner, and cause removed. */
function fields(task: TeamTaskSnapshot): TeamTaskFields {
  const { status: _status, ownerId: _ownerId, lostCause: _lostCause, ...rest } = task
  return rest
}

/** The task returned to `pending`, with no owner and no cause. */
function pending(task: TeamTaskSnapshot): PendingTeamTask {
  return { ...fields(task), status: 'pending' }
}

/** The task in progress under one owner. */
function inProgress(task: TeamTaskSnapshot, ownerId: SessionId): InProgressTeamTask {
  return { ...fields(task), status: 'in_progress', ownerId }
}

/** The in-progress task marked `lost`; its owner stays recorded. */
function lost(task: InProgressTeamTask, lostCause: TeamTaskLostCause): LostTeamTask {
  return { ...fields(task), status: 'lost', ownerId: task.ownerId, lostCause }
}

/** The tombstone of a pending or lost task; a lost task's owner stays recorded and its cause does not. */
function deleted(task: TeamTaskSnapshot): DeletedTeamTask {
  return { ...fields(task), status: 'deleted', ...task.ownerId === undefined ? {} : { ownerId: task.ownerId } }
}

/**
 * A task that left its owner through another member's action: the previous
 * owner and what happened, for the notice the owner receives.
 */
export interface DisplacedOwner {
  readonly ownerId: SessionId
  /** Whether the owner holds no other in-progress task after the change. */
  readonly idle: boolean
  /** What the acting member did, completing the sentence "the Lead ...". */
  readonly action: string
}

/** One committed member transition and, when it took the task from its owner, whom to tell. */
export interface TeamTaskUpdate {
  readonly view: TeamTaskView
  readonly displaced?: DisplacedOwner
}

/** What a new task adds to its id, revision, and text: the pending or the in-progress variant's remaining fields. */
type NewTaskRest =
  | Omit<PendingTeamTask, 'id' | 'revision' | 'subject' | 'description'>
  | Omit<InProgressTeamTask, 'id' | 'revision' | 'subject' | 'description'>

/** Owns Team task limits, authorization, transitions, and derived views. */
export class TeamTaskBoard {
  /**
   * @param journal - authoritative Lead-log transaction owner.
   * @param maxTasks - maximum non-deleted tasks retained by one Team.
   */
  constructor(
    private readonly journal: TeamJournal,
    private readonly maxTasks: number,
  ) {}

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async create(membership: TeamMembership, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return this.record(membership.root, request, state => ({
      status: 'pending',
      blockedBy: this.dependencies(request.blockedBy ?? [], state),
      writeScopes: this.writeScopes(request.writeScopes ?? []),
    }))
  }

  /**
   * Record a delegated run, or work a member has begun, as an owned in-progress task with no blockers or scopes.
   * @param root - exact live Team Lead whose log records the work.
   * @param request - subject, description, and the owning member or the run's child Session.
   * @returns the revision-one task view.
   */
  async trackRun(root: Agent, request: TrackedRunRequest): Promise<TeamTaskView> {
    return this.record(root, request, () => ({
      status: 'in_progress',
      ownerId: request.ownerId,
      blockedBy: [],
      writeScopes: [],
    }))
  }

  /**
   * Complete one in-progress task from the harness, bypassing member authorization.
   * @param root - exact live Team Lead whose log holds the task.
   * @param id - task the harness observed finished.
   * @returns the completed task view.
   */
  async completeRun(root: Agent, id: TeamTaskId): Promise<TeamTaskView> {
    return this.transition(root, id, current => ({ ...fields(current), status: 'completed', ownerId: current.ownerId }))
  }

  /**
   * Mark one in-progress task `lost`, keeping its owner on record.
   * @param root - exact live Team Lead whose log holds the task.
   * @param id - task whose owner can no longer finish it.
   * @param cause - why the harness gave up on the owner.
   * @returns the lost task view.
   */
  async markLost(root: Agent, id: TeamTaskId, cause: TeamTaskLostCause): Promise<TeamTaskView> {
    return this.transition(root, id, current => lost(current, cause))
  }

  /**
   * Mark every in-progress task held by one owner `lost`.
   * @param root - exact live Team Lead whose log holds the tasks.
   * @param ownerId - member or delegated child that can no longer finish its work.
   * @param cause - why the harness gave up on the owner.
   * @returns the ids marked, in creation order.
   */
  async markOwnerLost(root: Agent, ownerId: SessionId, cause: TeamTaskLostCause): Promise<TeamTaskId[]> {
    return this.journal.transact(root.id, async () => {
      const marked: TeamTaskId[] = []
      for (const current of [...this.journal.state(root).tasks]) {
        if (!isOutstanding(current) || current.ownerId !== ownerId) continue
        const task: TeamTaskSnapshot = { ...lost(current, cause), revision: current.revision + 1 }
        await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task })
        marked.push(task.id)
      }
      return marked
    })
  }

  /**
   * List in-progress tasks with whether each owner is still running.
   * @param root - exact live Team Lead whose board is read.
   * @param live - whether one owner can currently make progress.
   * @returns outstanding rows in creation order.
   */
  outstanding(root: Agent, live: (ownerId: SessionId) => boolean): OutstandingTeamTask[] {
    const state = this.journal.state(root)
    const rows: OutstandingTeamTask[] = []
    for (const task of state.tasks) {
      if (!isOutstanding(task)) continue
      const ownerName = this.ownerName(root, state, task.ownerId)
      rows.push({ id: task.id, subject: task.subject, ownerName, live: live(task.ownerId) })
    }
    return rows
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  get(membership: TeamMembership, id: TeamTaskId): TeamTaskView {
    const { root } = membership
    const state = this.journal.state(root)
    const task = state.tasks.find(candidate => candidate.id === id)
    if (task === undefined) throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
    return this.taskView(root, state, task)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param membership - exact caller membership resolved by the Team roster.
   * @returns detached current task views.
   */
  list(membership: TeamMembership): TeamTaskView[] {
    const { root } = membership
    const state = this.journal.state(root)
    return state.tasks
      .filter(task => task.status !== 'deleted')
      .map(task => this.taskView(root, state, task))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param membership - caller role and exact live Lead.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision and, when the change took the task from its owner, that owner.
   */
  async update(
    caller: Agent,
    membership: TeamMembership,
    request: UpdateTeamTaskRequest,
  ): Promise<TeamTaskUpdate> {
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const current = state.tasks.find(task => task.id === request.taskId)
      if (current === undefined) throw new TeamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
      if (current.revision !== request.expectedRevision) {
        throw new TeamError(
          `stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`,
          'TEAM_TASK_STALE_REVISION',
        )
      }
      if (current.status === 'deleted') throw new TeamError(`team task "${current.id}" is deleted`, 'TEAM_TASK_DELETED')
      const lead = membership.role === 'lead'
      const owner = current.ownerId === caller.id
      const authorizeOwner = (): void => {
        if (!lead && !owner) throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED')
      }
      let next: TeamTaskSnapshot
      // What the caller did to a task another member was working on.
      let action: string | undefined
      switch (request.action) {
        case 'claim':
          this.assertClaimable(state, current, caller)
          next = inProgress(current, caller.id)
          break
        case 'release':
          authorizeOwner()
          if (!isOutstanding(current)) throw new TeamError('only an in-progress task can be released', 'TEAM_TASK_INVALID_TRANSITION')
          next = pending(current)
          action = 'unassigned it'
          break
        case 'edit':
          authorizeOwner()
          this.assertEditable(current, 'edited')
          if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined) {
            throw new TeamError('task edit requires subject, description, or write_scopes', 'TEAM_INVALID_ARGUMENT')
          }
          next = {
            ...current,
            ...request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', 200) },
            ...request.description === undefined
              ? {}
              : { description: requiredText(request.description, 'description', 16_384) },
            ...request.writeScopes === undefined ? {} : { writeScopes: this.writeScopes(request.writeScopes) },
          }
          break
        case 'set_dependencies':
          authorizeOwner()
          this.assertEditable(current, 'rewired')
          if (request.blockedBy === undefined) throw new TeamError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT')
          next = { ...current, blockedBy: this.dependencies(request.blockedBy, state, current.id) }
          break
        case 'complete':
          authorizeOwner()
          if (!isOutstanding(current)) throw new TeamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
          next = { ...fields(current), status: 'completed', ownerId: current.ownerId }
          action = 'marked it completed'
          break
        case 'reopen':
          authorizeOwner()
          if (current.status !== 'completed' && current.status !== 'lost') {
            throw new TeamError('only a completed or lost task can reopen', 'TEAM_TASK_INVALID_TRANSITION')
          }
          this.assertNoStartedDependent(state, current)
          next = pending(current)
          break
        case 'reassign': {
          if (!lead) throw new TeamError('only the Team Lead can reassign tasks', 'TEAM_LEAD_REQUIRED')
          if (current.status !== 'pending' && !isOutstanding(current)) {
            throw new TeamError(
              `team task "${current.id}" is ${current.status} and only a pending or in-progress task can be reassigned; reopen it first`,
              'TEAM_TASK_INVALID_TRANSITION',
            )
          }
          if (request.owner === undefined || request.owner.trim().length === 0) {
            next = pending(current)
            action = 'unassigned it'
            break
          }
          if (!this.taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
          const assignee = resolveActiveMember(root, state, request.owner)
          if (assignee.id === current.ownerId) {
            throw new TeamError(`team task "${current.id}" is already owned by "${assignee.name}"`, 'TEAM_INVALID_ARGUMENT')
          }
          next = inProgress(current, assignee.id)
          action = `reassigned it to ${assignee.name}`
          break
        }
        case 'delete': {
          authorizeOwner()
          this.assertEditable(current, 'deleted')
          const dependent = state.tasks.find(task =>
            task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id))
          if (dependent !== undefined) {
            throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, 'TEAM_TASK_HAS_DEPENDENTS')
          }
          next = deleted(current)
          break
        }
        /* v8 ignore next 2 -- TeamTaskAction is closed and every member is handled above. */
        default:
          throw new TeamError(`unsupported task action ${String(request.action)}`, 'TEAM_INVALID_ARGUMENT')
      }
      const task: TeamTaskSnapshot = {
        ...next,
        revision: current.revision + 1,
      }
      this.assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task })
      const view = this.taskView(root, state, task)
      if (action === undefined || !isOutstanding(current) || owner) return { view }
      const ownerId = current.ownerId
      const idle = !state.tasks.some(other => other.id !== current.id && isOutstanding(other) && other.ownerId === ownerId)
      return { view, displaced: { ownerId, idle, action } }
    })
  }

  /** Append one harness-owned transition to an in-progress task. */
  private async transition(
    root: Agent,
    id: TeamTaskId,
    next: (current: InProgressTeamTask) => TeamTaskSnapshot,
  ): Promise<TeamTaskView> {
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const current = state.tasks.find(task => task.id === id)
      if (current === undefined) throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
      if (!isOutstanding(current)) {
        throw new TeamError(`team task "${id}" is ${current.status}, not in progress`, 'TEAM_TASK_INVALID_TRANSITION')
      }
      const task: TeamTaskSnapshot = { ...next(current), revision: current.revision + 1 }
      await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task })
      return this.taskView(root, state, task)
    })
  }

  /** Append one revision-one task inside the Lead transaction. */
  private async record(
    root: Agent,
    text: { readonly subject: string; readonly description: string },
    rest: (state: TeamState) => NewTaskRest,
  ): Promise<TeamTaskView> {
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const task: TeamTaskSnapshot = {
        id: this.allocate(state),
        revision: 1,
        subject: requiredText(text.subject, 'subject', 200),
        description: requiredText(text.description, 'description', 16_384),
        ...rest(state),
      }
      this.assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task })
      return this.taskView(root, state, task)
    })
  }

  /** Reserve the next numeric task id under the non-deleted task limit. */
  private allocate(state: TeamState): TeamTaskId {
    const active = state.tasks.filter(task => task.status !== 'deleted').length
    if (active >= this.maxTasks) {
      throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
    }
    const id = TeamTaskId(`task-${state.nextTaskNumber}`)
    if (state.tasks.some(task => task.id === id)) {
      throw new TeamError('Team task id space exhausted', 'TEAM_TASK_LIMIT')
    }
    return id
  }

  /** Refuse to change the executed part of the graph: in-progress and completed tasks are frozen. */
  private assertEditable(task: TeamTaskSnapshot, verb: string): void {
    if (!taskOpen(task.status)) {
      throw new TeamError(
        `team task "${task.id}" is ${task.status.replace('_', ' ')} and cannot be ${verb}; only pending or lost tasks can`,
        'TEAM_TASK_INVALID_TRANSITION',
      )
    }
  }

  /** Validate and de-duplicate dependency ids against the current task graph. */
  private dependencies(
    values: readonly TeamTaskId[],
    state: TeamState,
    self?: TeamTaskId,
  ): TeamTaskId[] {
    const seen = new Set<TeamTaskId>()
    const result: TeamTaskId[] = []
    for (const id of values) {
      if (id === self) throw new TeamError('a team task cannot block itself', 'TEAM_TASK_DEPENDENCY_CYCLE')
      if (seen.has(id)) throw new TeamError(`duplicate blocker "${id}"`, 'TEAM_INVALID_ARGUMENT')
      const task = state.tasks.find(candidate => candidate.id === id)
      if (task === undefined || task.status === 'deleted') {
        throw new TeamError(`blocker task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
      }
      seen.add(id)
      result.push(id)
    }
    return result
  }

  /** Normalize and de-duplicate task write scopes. */
  private writeScopes(values: readonly string[]): string[] {
    return [...new Set(values.map(writeScope))]
  }

  /** Map shared task-graph validation onto stable command error codes. */
  private assertTaskGraph(state: TeamState, candidate: TeamTaskSnapshot): void {
    try {
      assertTaskGraphCandidate(state.tasks, candidate)
    } catch (error: unknown) {
      /* v8 ignore next -- the shared validator is the only statement in the try and throws this exact error. */
      if (!(error instanceof TeamTaskGraphError)) throw error
      throw new TeamError(error.message, TASK_GRAPH_ERROR_CODES[error.violation], { cause: error })
    }
  }

  /** Whether all current blockers completed. */
  private taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
    return task.blockedBy.every(id => state.tasks.find(candidate => candidate.id === id)?.status === 'completed')
  }

  /**
   * Refuse a claim with the reason that applies to the task's status. Only a
   * ready `pending` task can be claimed.
   */
  private assertClaimable(state: TeamState, task: TeamTaskSnapshot, caller: Agent): void {
    switch (task.status) {
      case 'pending': {
        const blocker = task.blockedBy.find(id => state.tasks.find(candidate => candidate.id === id)?.status !== 'completed')
        if (blocker === undefined) return
        throw new TeamError(
          `team task "${task.id}" is not ready to claim: its blocker "${blocker}" is not completed`,
          'TEAM_TASK_BLOCKED',
        )
      }
      case 'in_progress':
        if (task.ownerId === caller.id) {
          throw new TeamError(`team task "${task.id}" is already in progress under you`, 'TEAM_TASK_INVALID_TRANSITION')
        }
        throw new TeamError(`team task "${task.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED')
      case 'lost':
        throw new TeamError(
          `team task "${task.id}" is lost (${task.lostCause}): its owner is gone; reopen it before it can be claimed`,
          'TEAM_TASK_INVALID_TRANSITION',
        )
      case 'completed':
        throw new TeamError(
          `team task "${task.id}" is completed; reopen it before it can be claimed`,
          'TEAM_TASK_INVALID_TRANSITION',
        )
      /* v8 ignore next 2 -- update refuses a deleted task before any action runs. */
      case 'deleted':
        throw new TeamError(`team task "${task.id}" is deleted`, 'TEAM_TASK_DELETED')
    }
  }

  /**
   * Refuse to reopen a completed task that started work depends on: a task in
   * progress or completed keeps every blocker completed. A lost task was never
   * completed, so nothing that depends on it has started.
   */
  private assertNoStartedDependent(state: TeamState, task: TeamTaskSnapshot): void {
    if (task.status !== 'completed') return
    const dependent = state.tasks.find(other =>
      taskStarted(other.status) && other.blockedBy.includes(task.id))
    if (dependent === undefined) return
    const first = dependent.status === 'in_progress' ? 'release or unassign' : 'reopen'
    throw new TeamError(
      `team task "${task.id}" is a completed blocker of "${dependent.id}", which is ${dependent.status.replace('_', ' ')}; ${first} "${dependent.id}" first`,
      'TEAM_TASK_HAS_DEPENDENTS',
    )
  }

  /** Model-facing owner name: the Lead, a roster name, or the child Session id of a tracked run. */
  private ownerName(root: Agent, state: TeamState, ownerId: SessionId): string {
    if (ownerId === root.id) return 'lead'
    return state.members.find(member => member.id === ownerId)?.name ?? ownerId
  }

  /**
   * Build one task view with owner name, readiness, and advisory write overlaps.
   * A committing caller may pass its pre-append state because `task` supplies the
   * new value explicitly; owner names, blocker readiness, and other task scopes
   * do not change when that snapshot is appended.
   */
  private taskView(root: Agent, state: TeamState, task: TeamTaskSnapshot): TeamTaskView {
    const ownerName = task.ownerId === undefined ? undefined : this.ownerName(root, state, task.ownerId)
    const warnings = new Set<string>()
    for (const other of state.tasks) {
      if (other.id === task.id || !isOutstanding(other)) continue
      if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
        warnings.add(`write scopes overlap with ${other.id}`)
      }
    }
    return {
      id: task.id,
      revision: task.revision,
      subject: task.subject,
      description: task.description,
      status: task.status,
      blockedBy: structuredClone(task.blockedBy),
      writeScopes: structuredClone(task.writeScopes),
      ...ownerName === undefined ? {} : { ownerName },
      ...task.lostCause === undefined ? {} : { lostCause: task.lostCause },
      ready: task.status === 'pending' && this.taskReady(state, task),
      writeScopeWarnings: [...warnings],
    }
  }
}
