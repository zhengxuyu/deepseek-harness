/**
 * The brief a task's owner works to, composed by the harness from the durable
 * graph: the task's own text, what it takes from each blocker's recorded
 * artifacts under that edge's instruction, and its output contract as the
 * definition of done. Delivered on `claim` and, by mail, on `reassign`.
 */

import type { TeamState } from './projection.ts'
import type { ArtifactContract, TeamTaskSnapshot } from './types.ts'

function contractLine(contract: ArtifactContract): string {
  const notes: string[] = [contract.kind]
  if (contract.kind === 'json' && contract.schema !== undefined) notes.push('schema declared')
  if (contract.kind === 'python') notes.push('must run alone: no imports of workspace modules')
  if (contract.optional === true) notes.push('optional')
  return `- ${contract.path} (${notes.join(', ')})`
}

/**
 * Compose the brief for one task from the current board.
 * @param state - the board the task belongs to, at least as new as the task.
 * @param task - the task the brief is for.
 * @returns model-facing text.
 */
export function taskBrief(state: TeamState, task: TeamTaskSnapshot): string {
  const inputs = task.blockedBy.map((id) => {
    const blocker = state.tasks.find(candidate => candidate.id === id)
    /* v8 ignore next -- a blocker is validated at create and cannot be deleted while depended on. */
    if (blocker === undefined) throw new Error(`blocker ${id} is not on the board`)
    const subject = ` "${blocker.subject}"`
    const status = blocker.status
    const artifacts = blocker.artifacts ?? []
    const produced = artifacts.length === 0
      ? 'no recorded artifacts'
      : artifacts.map(artifact => `${artifact.path} (${artifact.bytes} bytes, sha256 ${artifact.sha256.slice(0, 12)})`).join(', ')
    const instruction = task.edgeInstructions?.[id]
    return `- ${id}${subject} (${status}): ${produced}${instruction === undefined ? '' : `; instruction: ${instruction}`}`
  })
  const outputs = (task.outputs ?? []).map(contractLine)
  const notes = (task.notes ?? []).map(note => `- ${note.id} from ${note.from}: ${note.text}`)
  return [
    `Task ${task.id}: ${task.subject}`,
    task.description,
    '',
    'Inputs:',
    ...inputs.length === 0 ? ['- none'] : inputs,
    ...notes.length === 0 ? [] : ['', 'Notes sent to this task:', ...notes],
    '',
    'Outputs (definition of done; complete is refused until every non-optional one exists on disk and passes its check):',
    ...outputs.length === 0 ? ['- none declared'] : outputs,
  ].join('\n')
}
