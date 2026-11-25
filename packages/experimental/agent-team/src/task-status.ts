/** The groups of task statuses that Team code decides on, defined once. */

import type { InProgressTeamTask, TeamTaskSnapshot, TeamTaskStatus } from './types.ts'

/**
 * Whether a status is outstanding: an owner holds the task and may still
 * finish it. A run that follows the board waits only on outstanding tasks.
 * @param status - task status to classify.
 * @returns true only for `in_progress`.
 */
export function taskOutstanding(status: TeamTaskStatus): boolean {
  return status === 'in_progress'
}

/**
 * Whether a status is open: the task's text, edges, and existence may still
 * change. An `in_progress` or `completed` task is the executed part of the
 * graph and is frozen.
 * @param status - task status to classify.
 * @returns true for `pending` and `lost`.
 */
export function taskOpen(status: TeamTaskStatus): boolean {
  return status === 'pending' || status === 'lost'
}

/**
 * Whether a status is started: the task is, or was, worked on to completion.
 * A started task keeps every blocker completed.
 * @param status - task status to classify.
 * @returns true for `in_progress` and `completed`.
 */
export function taskStarted(status: TeamTaskStatus): boolean {
  return status === 'in_progress' || status === 'completed'
}

/**
 * Whether a status leaves the task's result uncollected: the task exists and
 * nobody finished it.
 * @param status - task status to classify.
 * @returns true for `pending`, `in_progress`, and `lost`.
 */
export function taskUncollected(status: TeamTaskStatus): boolean {
  return status === 'pending' || status === 'in_progress' || status === 'lost'
}

/**
 * Narrow a snapshot to the outstanding variant, which always carries its owner.
 * @param task - task snapshot to test.
 * @returns whether the task is in progress.
 */
export function isOutstanding(task: TeamTaskSnapshot): task is InProgressTeamTask {
  return taskOutstanding(task.status)
}
