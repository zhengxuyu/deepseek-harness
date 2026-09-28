/** Shared Team task DAG commands and runtime-enriched views. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { TeamMembership } from './roster.ts'
import { taskBrief } from './brief.ts'
import { errorMessage, TeamError } from './error.ts'
import { checkOutputs } from './settle.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamState } from './projection.ts'
import { resolveActiveMember } from './roster.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
import type { TeamTaskGraphViolation } from './task-graph.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  NoteTeamTaskRequest,
  NoteTeamTaskResult,
  ArtifactContract,
  CreateTeamTaskRequest,
  OutstandingTeamTask,
  TaskArtifact,
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

/** A run the harness records on the Lead board as one owned in-progress task. */
export interface TrackedRunRequest {
  readonly subject: string
  readonly description: string
  readonly ownerId: SessionId
}

/** Whether a task is on the open part of the graph, where its text and edges may still change. */
function editable(task: TeamTaskSnapshot): boolean {
  return task.status === 'pending' || task.status === 'lost'
}

/** Whether a task may still produce its outputs, so its declared paths are taken. */
function live(task: TeamTaskSnapshot): boolean {
  return task.status === 'pending' || task.status === 'in_progress' || task.status === 'lost'
}

/** The task recorded under `id`, or the not-found refusal. */
function taskOn(state: TeamState, id: TeamTaskId): TeamTaskSnapshot {
  const task = state.tasks.find(candidate => candidate.id === id)
  if (task === undefined) throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
  return task
}

/** Subject identity for the duplicate-node check: case and interior whitespace do not distinguish two subjects. */
function subjectKey(subject: string): string {
  return subject.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/** What the board needs from its host to check outputs at completion. */
export interface TeamTaskBoardHost {
  /** The workspace filesystem, read at completion; absent refuses to complete a task with declared outputs. */
  readonly fs: () => FileSystem | undefined
  /** Where completed outputs are retained, or undefined for hashing only. */
  readonly artifactRoot: string | undefined
}

/** Owns Team task limits, authorization, transitions, and derived views. */
export class TeamTaskBoard {
  /**
   * @param journal - authoritative Lead-log transaction owner.
   * @param maxTasks - maximum non-deleted tasks retained by one Team.
   */
  constructor(
    private readonly journal: TeamJournal,
    private readonly maxTasks: number,
    private readonly host: TeamTaskBoardHost,
  ) {}

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async create(membership: TeamMembership, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return this.record(membership.root, request, (state) => {
      this.assertSubjectFree(state, request.subject)
      const blockedBy = this.dependencies(request.blockedBy ?? [], state)
      const outputs = this.outputs(request.outputs ?? [])
      return {
        status: 'pending',
        blockedBy,
        ...this.edgeInstructions(request.edgeInstructions, blockedBy),
        writeScopes: this.writeScopes(request.writeScopes ?? []),
        ...outputs.length === 0 ? {} : { outputs },
      }
    })
  }

  /**
   * Record one delegated run as an owned in-progress task with no blockers or scopes.
   * @param root - exact live Team Lead whose log records the run.
   * @param request - subject, description, and the run's child Session as owner.
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
   * Complete one tracked run's task from the harness, bypassing member authorization.
   * @param root - exact live Team Lead whose log holds the task.
   * @param id - task recorded by {@link trackRun}.
   * @returns the completed task view.
   */
  async completeRun(root: Agent, id: TeamTaskId): Promise<TeamTaskView> {
    return this.transition(root, id, current => ({ ...current, status: 'completed' }))
  }

  /**
   * Mark one in-progress task `lost`, keeping its owner on record.
   * @param root - exact live Team Lead whose log holds the task.
   * @param id - task whose owner can no longer finish it.
   * @param cause - why the harness gave up on the owner.
   * @param ownerStop - how the owning run ended, when the cause is a run's stop reason.
   * @returns the lost task view.
   */
  async markLost(root: Agent, id: TeamTaskId, cause: TeamTaskLostCause, ownerStop?: SubagentStopReason): Promise<TeamTaskView> {
    return this.transition(root, id, current => ({
      ...current,
      status: 'lost',
      lostCause: cause,
      ...ownerStop === undefined ? {} : { ownerStop },
    }))
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
        if (current.status !== 'in_progress' || current.ownerId !== ownerId) continue
        const task: TeamTaskSnapshot = { ...current, status: 'lost', lostCause: cause, revision: current.revision + 1 }
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
      if (task.status !== 'in_progress') continue
      // An in-progress task always carries the owner that claimed it.
      const ownerId = task.ownerId as SessionId
      const ownerName = this.ownerName(root, state, ownerId)
      rows.push({ id: task.id, subject: task.subject, ownerName, live: live(ownerId) })
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
   * @returns the committed next task revision.
   */
  async update(
    caller: Agent,
    membership: TeamMembership,
    request: UpdateTeamTaskRequest,
  ): Promise<TeamTaskView> {
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const current = taskOn(state, request.taskId)
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
      switch (request.action) {
        case 'claim':
          if (current.ownerId !== undefined && current.ownerId !== caller.id) {
            throw new TeamError(`team task "${current.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED')
          }
          if (current.status !== 'pending' || !this.taskReady(state, current)) {
            throw new TeamError(`team task "${current.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED')
          }
          next = { ...current, status: 'in_progress', ownerId: caller.id }
          break
        case 'release':
          authorizeOwner()
          if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can be released', 'TEAM_TASK_INVALID_TRANSITION')
          next = this.withoutOwner({ ...current, status: 'pending' })
          break
        case 'edit': {
          authorizeOwner()
          this.assertEditable(current, 'edited')
          if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined
            && request.outputs === undefined) {
            throw new TeamError('task edit requires subject, description, write_scopes, or outputs', 'TEAM_INVALID_ARGUMENT')
          }
          if (request.subject !== undefined) this.assertSubjectFree(state, request.subject, current.id)
          const { outputs: _outputs, ...withoutOutputs } = current
          const outputs = request.outputs === undefined ? current.outputs : this.outputs(request.outputs)
          next = {
            ...withoutOutputs,
            ...request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', 200) },
            ...request.description === undefined
              ? {}
              : { description: requiredText(request.description, 'description', 16_384) },
            ...request.writeScopes === undefined ? {} : { writeScopes: this.writeScopes(request.writeScopes) },
            ...outputs === undefined || outputs.length === 0 ? {} : { outputs },
          }
          break
        }
        case 'set_dependencies': {
          authorizeOwner()
          this.assertEditable(current, 'rewired')
          if (request.blockedBy === undefined) throw new TeamError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT')
          const blockedBy = this.dependencies(request.blockedBy, state, current.id)
          const { edgeInstructions: _edges, ...withoutEdges } = current
          next = { ...withoutEdges, blockedBy, ...this.edgeInstructions(request.edgeInstructions, blockedBy) }
          break
        }
        case 'acknowledge': {
          if (!lead) throw new TeamError('only the Team Lead can acknowledge a hold', 'TEAM_LEAD_REQUIRED')
          const holds = current.holds ?? []
          const hold = holds.find(candidate => candidate.note === request.note)
          if (hold === undefined) {
            throw new TeamError(`team task "${current.id}" is not held by note ${JSON.stringify(request.note ?? '')}`, 'TEAM_INVALID_ARGUMENT')
          }
          const remaining = holds.filter(candidate => candidate !== hold)
          const { holds: _holds, ...withoutHolds } = current
          next = remaining.length === 0 ? withoutHolds : { ...withoutHolds, holds: remaining }
          break
        }
        case 'complete': {
          authorizeOwner()
          if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
          if (current.holds !== undefined && current.holds.length > 0) {
            const held = current.holds.map(hold => `${hold.note} on ${hold.task} from ${hold.from}`).join(', ')
            throw new TeamError(
              `team task "${current.id}" is held until the Lead acknowledges: ${held}`,
              'TEAM_TASK_HELD',
            )
          }
          const artifacts = await this.settle(root, state, current)
          next = { ...current, status: 'completed', ...artifacts.length === 0 ? {} : { artifacts } }
          break
        }
        case 'reopen':
          authorizeOwner()
          if (current.status !== 'completed' && current.status !== 'lost') {
            throw new TeamError('only a completed or lost task can reopen', 'TEAM_TASK_INVALID_TRANSITION')
          }
          next = this.withoutOwner({ ...current, status: 'pending' })
          break
        case 'reassign': {
          if (!lead) throw new TeamError('only the Team Lead can reassign tasks', 'TEAM_LEAD_REQUIRED')
          if (request.owner === undefined || request.owner.trim().length === 0) {
            if (current.status !== 'pending' && current.status !== 'in_progress') {
              throw new TeamError(
                'only a pending or in-progress task can be unassigned',
                'TEAM_TASK_INVALID_TRANSITION',
              )
            }
            next = this.withoutOwner({ ...current, status: 'pending' })
            break
          }
          if (current.status !== 'pending') {
            throw new TeamError(
              `only a pending task can be assigned; reopen team task "${current.id}" first`,
              'TEAM_TASK_INVALID_TRANSITION',
            )
          }
          if (!this.taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
          const assignee = resolveActiveMember(root, state, request.owner)
          next = { ...current, status: 'in_progress', ownerId: assignee.id }
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
          next = { ...current, status: 'deleted' }
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
      this.assertOutputsFree(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task })
      const view = this.taskView(root, state, task)
      // Starting work is where the owner reads what it is working to.
      const starts = request.action === 'claim' || (request.action === 'reassign' && task.ownerId !== undefined)
      return starts ? { ...view, brief: taskBrief(state, task) } : view
    })
  }

  /** Check every declared output on disk and return the artifacts to record. */
  private async settle(root: Agent, state: TeamState, task: TeamTaskSnapshot): Promise<TaskArtifact[]> {
    if (task.outputs === undefined || task.outputs.length === 0) return []
    const fs = this.host.fs()
    if (fs === undefined) {
      throw new TeamError('completing a task with declared outputs requires the fs service', 'TEAM_OUTPUTS_UNCHECKABLE')
    }
    return await checkOutputs({
      fs,
      task,
      cwd: root.session.header.cwd,
      teamId: TeamId(root.id),
      completed: state.tasks.filter(candidate => candidate.status === 'completed' && candidate.id !== task.id),
      artifactRoot: this.host.artifactRoot,
    })
  }

  /** Append one harness-owned transition to an in-progress task. */
  private async transition(
    root: Agent,
    id: TeamTaskId,
    next: (current: TeamTaskSnapshot) => TeamTaskSnapshot,
  ): Promise<TeamTaskView> {
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const current = taskOn(state, id)
      if (current.status !== 'in_progress') {
        throw new TeamError(`team task "${id}" is ${current.status}, not in progress`, 'TEAM_TASK_INVALID_TRANSITION')
      }
      const task: TeamTaskSnapshot = { ...next(current), revision: current.revision + 1 }
      await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task })
      return this.taskView(root, state, task)
    })
  }

  /**
   * Record one note on a task and hold every other live task whose declared output the note names.
   * @param membership - the sending member.
   * @param request - target task and note text.
   * @returns the task's next revision with the note's id and the held task ids.
   */
  async note(membership: TeamMembership, request: NoteTeamTaskRequest): Promise<NoteTeamTaskResult> {
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const current = taskOn(state, request.taskId)
      if (!live(current)) throw new TeamError(`team task "${current.id}" is ${current.status}; a note needs a live task`, 'TEAM_TASK_INVALID_TRANSITION')
      const text = requiredText(request.text, 'note', 16_384)
      const note = { id: `${current.id}-note-${(current.notes ?? []).length + 1}`, from: membership.name, text }
      const task: TeamTaskSnapshot = { ...current, revision: current.revision + 1, notes: [...current.notes ?? [], note] }
      await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task })
      const held: TeamTaskId[] = []
      for (const other of state.tasks) {
        if (other.id === current.id || !live(other)) continue
        if (!(other.outputs ?? []).some(contract => text.includes(contract.path))) continue
        const hold = { note: note.id, task: current.id, from: membership.name }
        const heldTask: TeamTaskSnapshot = { ...other, revision: other.revision + 1, holds: [...other.holds ?? [], hold] }
        await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task: heldTask })
        held.push(other.id)
      }
      return { ...this.taskView(root, this.journal.state(root), task), noteId: note.id, held }
    })
  }

  /** Append one revision-one task inside the Lead transaction. */
  private async record(
    root: Agent,
    text: { readonly subject: string; readonly description: string },
    rest: (state: TeamState) => Omit<TeamTaskSnapshot, 'id' | 'revision' | 'subject' | 'description'>,
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
      this.assertOutputsFree(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 3, teamId: TeamId(root.id), task })
      return this.taskView(root, state, task)
    })
  }

  /**
   * Refuse a subject a live task already carries: the board holds one node per piece of work,
   * so the caller links to, reopens, or edits that task instead of adding a twin.
   */
  private assertSubjectFree(state: TeamState, subject: string, self?: TeamTaskId): void {
    const key = subjectKey(subject)
    const other = state.tasks.find(candidate => candidate.id !== self && live(candidate) && subjectKey(candidate.subject) === key)
    if (other !== undefined) {
      const remedy = other.status === 'lost' ? 'reopen it' : 'depend on it or edit it'
      throw new TeamError(
        `subject ${JSON.stringify(subject.trim())} is already live task "${other.id}" (${other.status}); ${remedy} instead of creating a twin`,
        'TEAM_TASK_DUPLICATE_SUBJECT',
      )
    }
  }

  /** Refuse an output path another task may still produce: two live nodes cannot claim one file. */
  private assertOutputsFree(state: TeamState, task: TeamTaskSnapshot): void {
    if (task.outputs === undefined || !live(task)) return
    for (const contract of task.outputs) {
      const other = state.tasks.find(candidate =>
        candidate.id !== task.id && live(candidate) && (candidate.outputs ?? []).some(item => item.path === contract.path))
      if (other !== undefined) {
        throw new TeamError(`output ${JSON.stringify(contract.path)} is already declared by live task "${other.id}"`, 'TEAM_TASK_OUTPUT_CONFLICT')
      }
    }
  }

  /** Normalize and validate declared outputs: workspace-relative paths, unique within the task, schemas the harness can enforce. */
  private outputs(values: readonly ArtifactContract[]): ArtifactContract[] {
    const seen = new Set<string>()
    const result: ArtifactContract[] = []
    for (const contract of values) {
      const path = writeScope(contract.path)
      if (seen.has(path)) throw new TeamError(`duplicate output ${JSON.stringify(path)}`, 'TEAM_INVALID_ARGUMENT')
      seen.add(path)
      if (contract.schema !== undefined) {
        if (contract.kind !== 'json') throw new TeamError(`output ${JSON.stringify(path)}: only a json output takes a schema`, 'TEAM_INVALID_ARGUMENT')
        try {
          assertSupportedJsonSchema(contract.schema)
        } catch (error: unknown) {
          throw new TeamError(`output ${JSON.stringify(path)}: ${errorMessage(error)}`, 'TEAM_INVALID_ARGUMENT', { cause: error })
        }
      }
      result.push({
        path,
        kind: contract.kind,
        ...contract.schema === undefined ? {} : { schema: structuredClone(contract.schema) },
        ...contract.optional === undefined ? {} : { optional: contract.optional },
      })
    }
    return result
  }

  /** Validate edge instructions: non-empty text keyed by a current blocker. */
  private edgeInstructions(
    values: Readonly<Record<string, string>> | undefined,
    blockedBy: readonly TeamTaskId[],
  ): { edgeInstructions?: Record<string, string> } {
    if (values === undefined) return {}
    const result: Record<string, string> = {}
    for (const [id, instruction] of Object.entries(values)) {
      if (!blockedBy.includes(TeamTaskId(id))) {
        throw new TeamError(`edge instruction names "${id}", which is not a blocker`, 'TEAM_INVALID_ARGUMENT')
      }
      result[id] = requiredText(instruction, `edge instruction for ${id}`, 4096)
    }
    return Object.keys(result).length === 0 ? {} : { edgeInstructions: result }
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
    if (!editable(task)) {
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

  /** Remove the owner, lost-cause, owner-stop, and recorded-artifact fields under exactOptionalPropertyTypes. */
  private withoutOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
    const { ownerId: _ownerId, lostCause: _lostCause, ownerStop: _ownerStop, artifacts: _artifacts, ...without } = task
    return without
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
      if (other.id === task.id || other.status !== 'in_progress') continue
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
      ...task.ownerStop === undefined ? {} : { ownerStop: task.ownerStop },
      ...task.edgeInstructions === undefined ? {} : { edgeInstructions: structuredClone(task.edgeInstructions) },
      outputs: structuredClone(task.outputs ?? []),
      ...task.artifacts === undefined ? {} : { artifacts: structuredClone(task.artifacts) },
      ...task.notes === undefined ? {} : { notes: structuredClone(task.notes) },
      ...task.holds === undefined ? {} : { holds: structuredClone(task.holds) },
      ready: task.status === 'pending' && this.taskReady(state, task),
      writeScopeWarnings: [...warnings],
    }
  }
}
