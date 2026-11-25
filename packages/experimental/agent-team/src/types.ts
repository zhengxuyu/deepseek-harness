/** Public Agent Teams identities, durable records, and service request values. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

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

/** Whole durable value written on every teammate lifecycle change. */
export interface TeamMemberSnapshot {
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
}

/**
 * Durable task lifecycle. `lost` means only that the owner is gone: the
 * harness enters it when an in-progress task's owner can no longer finish the
 * task, the owner stays recorded, and only `reopen` clears it. It says nothing
 * about whether finished work was accepted.
 */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'lost' | 'deleted'

/**
 * Why the harness marked a task `lost`: `owner-failed` when the owning member's
 * turn or the delegated run ended without completing it, `run-ended` when the
 * process settled the run before the task finished.
 */
export type TeamTaskLostCause = 'owner-failed' | 'run-ended'

/**
 * How one earlier ownership of a task ended: `released` when the owner or the
 * Lead returned the task to `pending`, `reassigned` when the Lead moved it to
 * another member, `completed` or `lost` when the task was reopened from that
 * status.
 */
export type TeamTaskAttemptEnd = 'released' | 'reassigned' | 'completed' | 'lost'

/** One earlier ownership of a task, recorded when the task left that owner. */
export interface TeamTaskAttempt {
  readonly ownerId: SessionId
  readonly ended: TeamTaskAttemptEnd
  /** Present exactly when {@link ended} is `lost`. */
  readonly lostCause?: TeamTaskLostCause
  /** Why the acting member took the task back or reopened it, when it said so. */
  readonly reason?: string
  /**
   * The revision of the subject and description this owner worked toward. Absent,
   * or 1, for the text the task was created with. An edit made after the owner
   * was lost does not change it.
   */
  readonly goalRevision?: number
}

/** The fields every task snapshot carries in every status. */
export interface TeamTaskFields {
  readonly id: TeamTaskId
  /** Incremented by every mutation. */
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  /**
   * The revision that last changed `subject` or `description`; absent while
   * the task still has the text it was created with. Two attempts with the
   * same value worked toward the same goal.
   */
  readonly goalRevision?: number
  /** Earlier ownerships in the order they ended; absent while there are none. */
  readonly attempts?: TeamTaskAttempt[]
}

/** A task nobody owns yet. */
export interface PendingTeamTask extends TeamTaskFields {
  readonly status: 'pending'
  readonly ownerId?: never
  readonly lostCause?: never
  readonly ownerGoalRevision?: never
}

/** A task its owner is working on. */
export interface InProgressTeamTask extends TeamTaskFields {
  readonly status: 'in_progress'
  readonly ownerId: SessionId
  readonly lostCause?: never
  readonly ownerGoalRevision?: never
}

/** A finished task; the owner that held it when it completed stays recorded. */
export interface CompletedTeamTask extends TeamTaskFields {
  readonly status: 'completed'
  readonly ownerId: SessionId
  readonly lostCause?: never
  readonly ownerGoalRevision?: never
}

/** A task whose owner is gone; the owner and the cause stay recorded. */
export interface LostTeamTask extends TeamTaskFields {
  readonly status: 'lost'
  readonly ownerId: SessionId
  readonly lostCause: TeamTaskLostCause
  /**
   * The goal revision the lost owner worked toward, recorded when the subject
   * or description is edited while the task is lost; 1 is the text the task was
   * created with. Absent while the goal is the one the owner had.
   */
  readonly ownerGoalRevision?: number
}

/** A tombstone. A task deleted by a build that allowed deleting owned tasks keeps its owner. */
export interface DeletedTeamTask extends TeamTaskFields {
  readonly status: 'deleted'
  readonly ownerId?: SessionId
  readonly lostCause?: never
  readonly ownerGoalRevision?: never
}

/**
 * Whole durable task snapshot, one variant per status. The variants state
 * which of `ownerId`, `lostCause`, and `ownerGoalRevision` a status carries,
 * so a snapshot with the wrong fields for its status does not compile and is
 * refused when read.
 */
export type TeamTaskSnapshot =
  | PendingTeamTask
  | InProgressTeamTask
  | CompletedTeamTask
  | LostTeamTask
  | DeletedTeamTask

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
  /** The revision that last changed the subject or description; absent while the creation text stands. */
  readonly goalRevision?: number
  /** Earlier ownerships in the order they ended; absent while there are none. */
  readonly attempts?: TeamTaskAttemptView[]
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
}

/** One earlier ownership as shown to tools and hosts, with the owner's model-facing name. */
export interface TeamTaskAttemptView {
  /** The Lead, a roster name, or the child Session id of a tracked run. */
  readonly ownerName: string
  readonly ended: TeamTaskAttemptEnd
  readonly lostCause?: TeamTaskLostCause
  readonly reason?: string
  readonly goalRevision?: number
}

/** One in-progress task that a settling run is still waiting on. */
export interface OutstandingTeamTask {
  readonly id: TeamTaskId
  readonly subject: string
  /** The member, or the child Session of a tracked run, that holds the task. */
  readonly ownerId: SessionId
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
  readonly writeScopes?: readonly string[]
}

/** Supported task mutation actions. */
export type TeamTaskAction =
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
  readonly writeScopes?: readonly string[]
  readonly owner?: string
  /**
   * Why the task is taken from its owner or reopened; accepted on `release`,
   * `reassign`, and `reopen`, and recorded on the attempt that the action ends.
   * It leaves the subject and description unchanged; `edit` changes those.
   */
  readonly reason?: string
}

/** Result of waiting for Team activity. */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole teammate lifecycle value, stored only in the Team Lead Session. */
    'team/member': { version: 2; teamId: TeamId; member: TeamMemberSnapshot }
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
