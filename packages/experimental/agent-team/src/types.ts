/** Public Agent Teams identities, durable records, and service request values. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * How a member's or delegated run's turn ended: the subagent stop reason
 * (`completed`, `aborted`, `error`, `max-tokens`, `refusal`, or a backend's
 * merged variant). Kept as a string so browser clients read Team records
 * without the host-only subagent types.
 */
export type TeamStopReason = string

/** Identifies the implicit team rooted at one top-level Session. */
export type TeamId = Branded<'TeamId'>

/**
 * Brand one root Session identity as its implicit Team identity.
 * @param id - Root Session identity.
 * @returns the same string branded as a Team identity.
 */
export function TeamId(id: SessionId | string): TeamId {
  return id as TeamId
}

/** Stable identifier for one task in a Team. */
export type TeamTaskId = Branded<'TeamTaskId'>

/**
 * Brand a validated task id.
 * @param id - Team-local task identity.
 * @returns the same string branded as a Team task identity.
 */
export function TeamTaskId(id: string): TeamTaskId {
  return id as TeamTaskId
}

/** Stable identifier for one durable peer message. */
export type TeamMessageId = Branded<'TeamMessageId'>

/**
 * Brand a generated peer-message id.
 * @param id - Durable mailbox message identity.
 * @returns the same string branded as a Team message identity.
 */
export function TeamMessageId(id: string): TeamMessageId {
  return id as TeamMessageId
}

/** Durable teammate lifecycle. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** Whole durable value written on every teammate lifecycle change and turn end. */
export interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
  /** How the member's latest turn ended; present once an active member's first turn has ended. */
  readonly lastStop?: TeamStopReason
}

/**
 * Member record as written by `team/member` payload version 2, before turn
 * outcomes were recorded: the same record with no `lastStop`. Read-only; new
 * records are written at version 3 as {@link TeamMemberSnapshot}.
 */
export interface TeamMemberSnapshotV2 {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/** Current runtime-enriched roster row. */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed'
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  readonly model?: string
  readonly diagnostics: string[]
  /** How the member's latest turn ended; absent until an active member's first turn has ended. */
  readonly lastStop?: TeamStopReason
}

/**
 * Durable task lifecycle. `lost` is entered only by the harness, when an
 * in-progress task's owner can no longer finish it; the owner stays recorded
 * and only `reopen` clears it.
 */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'lost' | 'deleted'

/**
 * Why the harness marked a task `lost`: `owner-failed` when the owning member
 * or delegated run ended without completing it, `run-ended` when the process
 * settled the run before the task finished.
 */
export type TeamTaskLostCause = 'owner-failed' | 'run-ended'

/** What kind of file an output contract names; each kind has its own check at `complete`. */
export type ArtifactKind = 'file' | 'json' | 'csv' | 'npy' | 'image' | 'python'

/**
 * One file a task promises to produce: the definition of done the harness
 * checks on disk when the task completes.
 */
export interface ArtifactContract {
  /** Workspace-relative file path, normalized like a write scope. */
  readonly path: string
  /**
   * `file` must exist and be non-empty; `json` must parse and, with `schema`,
   * validate; `csv` needs a header line; `npy` and `image` must carry their
   * format's magic bytes; `python` must parse as an entry file that imports no
   * module defined in the workspace, so it runs alone.
   */
  readonly kind: ArtifactKind
  /** JSON Schema (the subset `@deepseek-ai/dsh-tools` enforces) a `json` output must satisfy. */
  readonly schema?: Record<string, JsonValue>
  /** Whether completion may proceed without this file. */
  readonly optional?: boolean
}

/** One produced output recorded at completion: where the artifact is and what it was. */
export interface TaskArtifact {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  /** The earlier completed task whose artifact at this path this one replaced, when the content differs. */
  readonly supersedes?: { readonly task: TeamTaskId; readonly sha256: string }
  /** Harness-local path of the retained previous version, when `artifactRoot` retained it. */
  readonly previousVersion?: string
}

/** Whole durable task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  /** Present exactly while {@link status} is `lost`. */
  readonly lostCause?: TeamTaskLostCause
  /** How the owning run ended when it lost the task; present only with an `owner-failed` cause from a tracked run. */
  readonly ownerStop?: TeamStopReason
  readonly blockedBy: TeamTaskId[]
  /** What this task takes from each blocker's artifacts, keyed by blocker id; keys are a subset of {@link blockedBy}. */
  readonly edgeInstructions?: Record<string, string>
  readonly writeScopes: string[]
  /** Files the task must produce; absent means none declared. */
  readonly outputs?: ArtifactContract[]
  /** Outputs recorded at completion; present only while {@link status} is `completed` and outputs were declared. */
  readonly artifacts?: TaskArtifact[]
  /** Notes sent to this task, in arrival order; absent means none. */
  readonly notes?: TaskNote[]
  /**
   * Notes on other tasks that name one of this task's outputs and that the Lead has not acknowledged;
   * `complete` is refused while any remain.
   */
  readonly holds?: TaskHold[]
}

/** One note linked to a task: a message whose recipient is the task rather than a member. */
export interface TaskNote {
  /** `<task>-note-<n>`, unique on the board. */
  readonly id: string
  /** Sending member's name. */
  readonly from: string
  readonly text: string
}

/** One unacknowledged note elsewhere on the board that names an output of the held task. */
export interface TaskHold {
  /** The note's id. */
  readonly note: string
  /** The task the note was sent to. */
  readonly task: TeamTaskId
  /** Sending member's name. */
  readonly from: string
}

/**
 * Task snapshot as written by `team/task` payload version 2, before `lost`
 * existed: the same record with no lost status and no cause. Read-only; new
 * snapshots are written at version 3 as {@link TeamTaskSnapshot}.
 */
export interface TeamTaskSnapshotV2 {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}

/** Runtime-enriched task view returned to tools and hosts. */
export interface TeamTaskView {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  readonly ownerName?: string
  readonly lostCause?: TeamTaskLostCause
  readonly ownerStop?: TeamStopReason
  readonly edgeInstructions?: Record<string, string>
  readonly outputs: ArtifactContract[]
  readonly artifacts?: TaskArtifact[]
  /** The harness-composed brief for the owner, present on the result of `claim` and of `reassign` to a member. */
  readonly brief?: string
  readonly notes?: TaskNote[]
  readonly holds?: TaskHold[]
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
}

/** One in-progress task that a settling run is still waiting on. */
export interface OutstandingTeamTask {
  readonly id: TeamTaskId
  readonly subject: string
  /** The Lead, a roster name, or the child Session id of a tracked run. */
  readonly ownerName: string
  /** Whether the owner is currently running, so the task can still make progress on its own. */
  readonly live: boolean
}

/** Point-in-time roster and task-board projection returned to browser clients. */
export interface TeamView {
  readonly members: TeamMemberView[]
  readonly tasks: TeamTaskView[]
}

/** One peer message retained until its target Session records it. */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}

/** Source retained by the target Session for durable mailbox de-duplication. */
export interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Team-service deployment limits. */
export interface Config {
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum queued-minus-delivered messages for one target member. */
  readonly maxPendingMessagesPerMember?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds allowed for Team-owned runtime disposal. */
  readonly disposalTimeoutMs?: number
  /**
   * Record every subagent run delegated below the Lead as an owned in-progress
   * task on the Lead's board, completed or lost when the run ends. Off by
   * default: the board then holds only tasks members created.
   */
  readonly trackSubagentRuns?: boolean
  /**
   * Absolute harness-local directory under which every completed output is
   * retained as `<team>/<task>/<path>`, so a later task that overwrites the
   * same path leaves the previous version and its diff recoverable. Absent
   * means outputs are hashed but not retained.
   */
  readonly artifactRoot?: string
}

/** Input for creating one durable teammate. */
export interface SpawnTeammateRequest {
  readonly name: string
  readonly description: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  readonly signal: AbortSignal
}

/** Result after one teammate reaches a durable active or failed edge. */
export interface SpawnTeammateResult {
  readonly member: TeamMemberView
}

/** Input for one durable peer message. */
export interface SendTeamMessageRequest {
  readonly target: string
  readonly content: ContentBlock[]
  readonly signal: AbortSignal
}

/** Result after a peer message enters the durable mailbox. */
export interface SendTeamMessageResult {
  readonly messageId: TeamMessageId
  readonly status: 'accepted' | 'queued'
}

/** Input for creating one shared task. */
export interface CreateTeamTaskRequest {
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly edgeInstructions?: Readonly<Record<string, string>>
  readonly writeScopes?: readonly string[]
  readonly outputs?: readonly ArtifactContract[]
}

/** Supported task mutation actions. */
export type TeamTaskAction =
  | 'acknowledge'
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'reassign'
  | 'delete'

/** Compare-and-set mutation of one shared task. */
export interface UpdateTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly edgeInstructions?: Readonly<Record<string, string>>
  readonly writeScopes?: readonly string[]
  readonly outputs?: readonly ArtifactContract[]
  readonly owner?: string
  /** The hold to clear for `acknowledge`: a note id from the task's `holds`. */
  readonly note?: string
}

/** Input for sending a note to a task. */
export interface NoteTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly text: string
  /** Cancels the mail to the task's owner, never the recorded note. */
  readonly signal: AbortSignal
}

/** Result of a recorded note: the task's next revision, the note's id, and the tasks the note now holds. */
export interface NoteTeamTaskResult extends TeamTaskView {
  readonly noteId: string
  readonly held: TeamTaskId[]
}

/** Result of waiting for Team activity. */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole teammate lifecycle value, stored only in the Team Lead Session.
     * Version 3 adds `lastStop`; version 2 records stay readable.
     */
    'team/member':
      | { version: 2; teamId: TeamId; member: TeamMemberSnapshotV2 }
      | { version: 3; teamId: TeamId; member: TeamMemberSnapshot }
    /**
     * Whole shared-task value, stored only in the Team Lead Session. Version 3
     * adds the `lost` status and `lostCause`; version 2 records stay readable.
     */
    'team/task':
      | { version: 2; teamId: TeamId; task: TeamTaskSnapshotV2 }
      | { version: 3; teamId: TeamId; task: TeamTaskSnapshot }
    /** Durable mailbox enqueue, stored before delivery is attempted. */
    'team/message/queued': { version: 2; teamId: TeamId; message: TeamMessageSnapshot }
    /** Durable acknowledgement that the target Session recorded the message. */
    'team/message/delivered': {
      version: 2
      teamId: TeamId
      messageId: TeamMessageId
      targetId: SessionId
    }
  }
}
