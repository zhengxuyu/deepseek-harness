/**
 * The standard a case implements. A case is one fixed task a real-model
 * `dsh --profile headless` run is given, together with what makes the run
 * judgeable: the files its workspace starts with, the check of the files the
 * run must produce, and what the Team is expected to do on the way.
 *
 * To add a case: create `cases/<name>/` with a `task.md` and a `case.ts` that
 * exports one subclass of {@link StandardCase}, then list an instance in
 * `cases/index.ts`. `cases.spec.ts` holds every listed case to this standard.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One judged criterion of a run. */
export interface RubricItem {
  /** Stable identifier, unique within one case's rubric. */
  readonly id: string
  readonly criterion: string
  readonly passed: boolean
  /** What was observed, so a failed item explains itself. */
  readonly detail: string
}

/** What one agent did, measured from its own Session log. */
export interface AgentMeasure {
  readonly id: string
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly turns: number
  readonly turnEnds: string[]
  readonly modelRequests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly toolCalls: Record<string, number>
  readonly toolErrors: number
}

/** The final state of one task on the Team board. */
export interface TaskOutcome {
  readonly id: string
  readonly subject: string
  readonly status: string
  readonly owner: string | undefined
  readonly lostCause: string | undefined
  readonly revisions: number
}

/** What the trajectory judgment reads: how the run ended and what the Team did. */
export interface TrajectoryEvidence {
  /** The process exit code, or undefined when no run record was written. */
  readonly exitCode: number | null | undefined
  /** Whether the outer time limit, not dsh, ended the run. */
  readonly timedOut: boolean
  /** The rows the runner printed as unsettled. */
  readonly unsettled: readonly string[]
  readonly agents: readonly AgentMeasure[]
  readonly tasks: readonly TaskOutcome[]
}

/** What a case expects of the Team, beyond a clean exit and a settled board. */
export interface TeamExpectations {
  /** Teammates that must be spawned and must each make a model request. */
  readonly minTeammates: number
  /** Distinct teammates that must each own a completed task. */
  readonly minTeammatesCompletingTasks: number
}

/**
 * One standard case. Subclasses state the case's identity and expectations,
 * prepare its workspace, and judge its outputs; the task text is the
 * `task.md` beside the subclass. The trajectory judgment is shared, so every
 * case is held to the same exit, turn, and board criteria.
 */
export abstract class StandardCase {
  /** The case's name: lowercase words joined by hyphens, equal to its directory under `cases/`. */
  abstract readonly name: string
  /** One sentence saying what behavior the case exercises. */
  abstract readonly description: string
  /** The directory holding the subclass and its `task.md`; pass `import.meta.dirname`. */
  protected abstract readonly directory: string
  /** What the case expects of the Team. */
  abstract readonly expectations: TeamExpectations

  /**
   * Write the files the run starts with into a fresh workspace. The result
   * must depend only on reviewed constants, so every run reads the same input.
   * @param workspace - an existing empty directory, the run's cwd.
   */
  abstract prepare(workspace: string): void

  /**
   * Judge the files the task asks for. A workspace the run never touched must
   * fail every item.
   * @param workspace - the workspace after the run.
   * @returns at least one rubric item, with ids unique within the case.
   */
  abstract judgeOutputs(workspace: string): RubricItem[]

  /**
   * The task text given to the Lead as the run's one message.
   * @returns the trimmed content of the case's `task.md`.
   */
  task(): string {
    return readFileSync(join(this.directory, 'task.md'), 'utf8').trim()
  }

  /**
   * Judge how the run ended and how the Team worked, against the criteria
   * every case shares and this case's {@link expectations}.
   * @param evidence - the run's exit, unsettled rows, agents, and final board.
   * @returns the rubric items about the trajectory.
   */
  judgeTrajectory(evidence: TrajectoryEvidence): RubricItem[] {
    const { exitCode, timedOut, unsettled, agents, tasks } = evidence
    const { minTeammates, minTeammatesCompletingTasks } = this.expectations
    const lead = agents.find(agent => agent.role === 'lead')
    const teammates = agents.filter(agent => agent.role === 'teammate')
    const live = tasks.filter(task => task.status !== 'deleted')
    const completed = live.filter(task => task.status === 'completed')
    const open = live.filter(task => task.status !== 'completed')
    const teammateOwners = new Set(completed.flatMap(task => task.owner === undefined || task.owner === 'lead' ? [] : [task.owner]))
    const idle = teammates.filter(agent => agent.modelRequests === 0).map(agent => agent.name)
    const items: RubricItem[] = [
      {
        id: 'exit',
        criterion: 'dsh exited 0 with nothing unsettled',
        passed: exitCode === 0 && unsettled.length === 0,
        detail: `exit ${exitCode ?? 'unknown'}${timedOut ? ' (stopped by the outer time limit)' : ''}, ${unsettled.length} unsettled row(s)`,
      },
      {
        id: 'lead-turn',
        criterion: 'the Lead\'s last turn completed',
        passed: lead?.turnEnds.at(-1) === 'completed',
        detail: lead === undefined ? 'no Lead log found' : `turn ends: ${lead.turnEnds.join(', ') || 'none'}`,
      },
      {
        id: 'board',
        criterion: 'every task on the board ended completed, none lost',
        passed: live.length > 0 && open.length === 0,
        detail: live.length === 0
          ? 'the board recorded no task'
          : open.length === 0
            ? `${live.length} task(s), all completed`
            : open.map(task => `${task.id} is ${task.status}${task.lostCause === undefined ? '' : ` (${task.lostCause})`}`).join('; '),
      },
    ]
    if (minTeammates > 0) {
      items.push({
        id: 'teammates',
        criterion: `at least ${minTeammates} teammate(s) were spawned and each made a model request`,
        passed: teammates.length >= minTeammates && idle.length === 0,
        detail: `${teammates.length} teammate(s): ${teammates.map(agent => agent.name).join(', ') || 'none'}${idle.length === 0 ? '' : `; never ran: ${idle.join(', ')}`}`,
      })
    }
    if (minTeammatesCompletingTasks > 0) {
      items.push({
        id: 'division',
        criterion: `at least ${minTeammatesCompletingTasks} different teammate(s) each completed a task`,
        passed: teammateOwners.size >= minTeammatesCompletingTasks,
        detail: `completed tasks are owned by: ${completed.map(task => `${task.id}=${task.owner ?? 'nobody'}`).join(', ') || 'none'}`,
      })
    }
    return items
  }
}
