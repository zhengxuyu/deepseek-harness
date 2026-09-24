/** Scoped model-facing tools for the opt-in Agent Teams runtime. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']

/** Tool routing configuration. */
export interface Config {
  /** Continuable-subagent provider used for fresh teammates. */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates. */
  readonly forkProvider?: string
}

/** Loader schema for the opt-in Team tool plugin. */
export const Config: z<Config> = z.object({
  freshProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
})

/** Model-facing collaboration guidance shared by Lead and teammates. */
const POLICY = `Agent Teams is available in this session, but create teammates only when the user explicitly asks to use Agent Teams or teammates.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. lastStop is how a member's latest turn ended: completed, aborted, error, max-tokens (cut off at the output limit), or refusal; an inactive member whose lastStop is not completed did not finish that turn's work. A delivered peer item starts with its stable message id and sender name. A successful send is already durable even when its result says queued; do not resend it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Every task declares outputs, the files it must produce; complete is refused until every non-optional output exists on disk and passes its kind's check, so a task is done only when its artifacts are. Two live tasks cannot declare the same output path, and a subject a live task already carries is refused: depend on that task, edit it, or reopen it if it is lost, instead of creating a twin. A blocker entry may carry an instruction saying what the task takes from that blocker's artifacts. claim returns a brief composed from the recorded task, its inputs, and its outputs; a reassigned member receives the same brief by mail. Task readiness never starts an owner. A lost task's owner can no longer finish it: reopen it, then claim or reassign it. In-progress and completed tasks cannot be edited, rewired, or deleted. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Its result lists the members and tasks that changed while it waited; act on those before re-listing. The Lead must wait for required teammates before giving the final answer.`

const ACTIVE_WAIT_STATUSES: ReadonlySet<TeamMemberView['status']> = new Set(['running', 'provisioning'])
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.'

/**
 * One model-facing roster row. The Lead pseudo-row omits the
 * teammate-only provisioning fields, so only identity, role, status, and
 * diagnostics are required.
 */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
    lastStop: { type: 'string' },
  },
} as const

/** Expose the member name as its model-facing target. */
function modelMember(member: TeamMemberView): InferValue<typeof MEMBER_VIEW_SCHEMA> {
  const { id: _id, name, ...details } = member
  return { target: name, ...details }
}

/** One declared output: the path and the check it must pass at completion. */
const OUTPUT_CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true, description: 'Workspace-relative file path.' },
    kind: {
      type: 'string',
      required: true,
      enum: ['file', 'json', 'csv', 'npy', 'image', 'python'],
      description: 'file: exists and non-empty; json: parses and matches schema when given; csv: has a header and rows; npy and image: format magic bytes; python: an entry file that imports no workspace module, so it runs alone.',
    },
    schema: { type: 'object', additionalProperties: true, description: 'JSON Schema a json output must satisfy.' },
    optional: { type: 'boolean', description: 'Whether completion may proceed without this file.' },
  },
} as const

/** One recorded artifact of a completed task. */
const TASK_ARTIFACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    sha256: { type: 'string', required: true },
    supersedes: {
      type: 'object',
      additionalProperties: false,
      properties: { task: { type: 'string', required: true }, sha256: { type: 'string', required: true } },
    },
    previousVersion: { type: 'string' },
  },
} as const

/** A blocker reference: a task id, or the id with what this task takes from that blocker's artifacts. */
const BLOCKER_SCHEMA = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', required: true, description: 'Blocking task id.' },
        instruction: { type: 'string', required: true, description: 'What this task takes from the blocker\'s artifacts.' },
      },
    },
  ],
} as const

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'lost', 'deleted'] },
    ownerName: { type: 'string' },
    lostCause: { type: 'string', enum: ['owner-failed', 'run-ended'] },
    ownerStop: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    edgeInstructions: { type: 'object', additionalProperties: true },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    outputs: { type: 'array', required: true, items: OUTPUT_CONTRACT_SCHEMA },
    artifacts: { type: 'array', items: TASK_ARTIFACT_SCHEMA },
    brief: { type: 'string' },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

type BlockerArg = InferValue<typeof BLOCKER_SCHEMA>

/** Split blocker arguments into the id list and the instructions keyed by id. */
function blockers(values: readonly BlockerArg[]): { blockedBy: TeamTaskId[]; edgeInstructions: Record<string, string> } {
  const blockedBy: TeamTaskId[] = []
  const edgeInstructions: Record<string, string> = {}
  for (const value of values) {
    if (typeof value === 'string') {
      blockedBy.push(TeamTaskId(value))
    } else {
      blockedBy.push(TeamTaskId(value.task))
      edgeInstructions[value.task] = value.instruction
    }
  }
  return { blockedBy, edgeInstructions }
}

const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
  },
} as const

const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA } as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
  },
} as const

/** A roster row as it changed while waiting: availability and latest turn outcome. */
const MEMBER_CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    lastStop: { type: 'string' },
  },
} as const

/** A task row as it changed while waiting: status, revision, owner, and how it was lost. */
const TASK_CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'lost', 'deleted'] },
    ownerName: { type: 'string' },
    lostCause: { type: 'string', enum: ['owner-failed', 'run-ended'] },
    ownerStop: { type: 'string' },
  },
} as const

/**
 * `changes` lists what differs between the roster and board read when the wait
 * started and when it ended; `noProgress` is present only on the model-only
 * shortcut that skips the wait.
 */
const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timedOut: { type: 'boolean', required: true },
    changes: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        members: { type: 'array', required: true, items: MEMBER_CHANGE_SCHEMA },
        tasks: { type: 'array', required: true, items: TASK_CHANGE_SCHEMA },
      },
    },
    noProgress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true, const: 'no-active-peer' },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

type MemberChange = InferValue<typeof MEMBER_CHANGE_SCHEMA>
type TaskChange = InferValue<typeof TASK_CHANGE_SCHEMA>
type WaitChanges = InferValue<typeof WAIT_VALUE_SCHEMA>['changes']

/** The roster and board facts a wait compares. */
interface WaitObservation {
  readonly members: readonly TeamMemberView[]
  readonly tasks: readonly TeamTaskView[]
}

function memberChange(member: TeamMemberView): MemberChange {
  return { target: member.name, status: member.status, ...member.lastStop === undefined ? {} : { lastStop: member.lastStop } }
}

function taskChange(task: TeamTaskView): TaskChange {
  return {
    id: task.id,
    revision: task.revision,
    status: task.status,
    ...task.ownerName === undefined ? {} : { ownerName: task.ownerName },
    ...task.lostCause === undefined ? {} : { lostCause: task.lostCause },
    ...task.ownerStop === undefined ? {} : { ownerStop: task.ownerStop },
  }
}

/** Rows whose model-facing change fields differ from the earlier observation, plus rows that appeared. */
function waitChanges(before: WaitObservation, after: WaitObservation): WaitChanges {
  const members = new Map(before.members.map(member => [member.id, JSON.stringify(memberChange(member))]))
  const tasks = new Map(before.tasks.map(task => [task.id, JSON.stringify(taskChange(task))]))
  return {
    members: after.members.flatMap((member) => {
      const row = memberChange(member)
      return members.get(member.id) === JSON.stringify(row) ? [] : [row]
    }),
    tasks: after.tasks.flatMap((task) => {
      const row = taskChange(task)
      return tasks.get(task.id) === JSON.stringify(row) ? [] : [row]
    }),
  }
}

const INTERRUPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previousStatus: { type: 'string', required: true, enum: ['running', 'inactive'] },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * Team result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: Required<Config>): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  try {
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: POLICY,
    }))

    register(scoped.tools.register(defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate. Only the Team Lead may call this tool.',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
        description: { type: 'string', required: true, description: 'Short description of the delegated responsibility.' },
        prompt: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
      },
      output: jsonOutput(SPAWN_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'spawn_teammate')
        const context = args.context ?? 'fresh'
        const result = await ctx.agentTeams.spawnTeammate(agent, {
          name: args.name,
          description: args.description,
          prompt: [
            { type: 'text', text: `<system-reminder>\nYou are teammate "${args.name.trim()}".\n</system-reminder>\n\n` },
            { type: 'text', text: args.prompt },
          ],
          context,
          provider: context === 'fork' ? config.forkProvider : config.freshProvider,
          signal: exec.signal,
        })
        return { member: modelMember(result.member) }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'send_message',
      description: 'Send one durable message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member target returned by spawn_teammate or list_agents, including lead.' },
        message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
      },
      output: jsonOutput(SEND_VALUE_SCHEMA),
      execute(args, exec) {
        return ctx.agentTeams.sendMessage(callingAgent(exec.agent, 'send_message'), {
          target: args.target,
          content: [{ type: 'text', text: args.message }],
          signal: exec.signal,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'list_agents',
      description: 'List the Lead and every durable teammate with an addressable target, current availability, and lastStop, how its latest turn ended. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.',
      parameters: {},
      output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
      execute(_args, exec) {
        return Promise.resolve(ctx.agentTeams.listMembers(callingAgent(exec.agent, 'list_agents')).map(modelMember))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'wait_agent',
      description: 'Wait for the next teammate status, mailbox, or shared-task change after this call starts, and return the members and tasks that changed. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning.',
      parameters: {
        timeout_ms: {
          type: 'integer',
          description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
        },
      },
      output: jsonOutput(WAIT_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent')
        const timeoutMs = args.timeout_ms ?? 30_000
        // Preserve TeamService's authoritative timeout validation before the
        // model-only no-progress shortcut.
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
          await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
        }
        // The active-peer read and waiter registration must remain one synchronous
        // span; awaiting between them can lose the only peer-status edge.
        const before: WaitObservation = { members: ctx.agentTeams.listMembers(caller), tasks: ctx.agentTeams.listTasks(caller) }
        const hasActivePeer = before.members.some(member =>
          member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))
        if (!hasActivePeer) {
          return {
            timedOut: false,
            changes: { members: [], tasks: [] },
            noProgress: {
              reason: 'no-active-peer' as const,
              message: NO_ACTIVE_PEER_MESSAGE,
            },
          }
        }
        const { timedOut } = await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
        const after: WaitObservation = { members: ctx.agentTeams.listMembers(caller), tasks: ctx.agentTeams.listTasks(caller) }
        return { timedOut, changes: waitChanges(before, after) }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'interrupt_agent',
      description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
      parameters: {
        target: { type: 'string', required: true, description: 'Teammate target returned by spawn_teammate or list_agents.' },
      },
      output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
      execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, 'interrupt_agent'), args.target))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_create',
      description: 'Create one unowned pending task on the shared Team task board. outputs is the definition of done: complete is refused until every non-optional output exists and passes its check. A subject a live task already carries is refused; depend on that task instead.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        outputs: {
          type: 'array',
          required: true,
          items: OUTPUT_CONTRACT_SCHEMA,
          description: 'Files this task must produce; empty for a task with no file deliverable.',
        },
        blocked_by: { type: 'array', items: BLOCKER_SCHEMA, description: 'Tasks that must complete first, each optionally with what this task takes from it.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.',
        },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const edges = args.blocked_by === undefined ? undefined : blockers(args.blocked_by)
        return await ctx.agentTeams.createTask(callingAgent(exec.agent, 'team_task_create'), {
          subject: args.subject,
          description: args.description,
          outputs: args.outputs,
          ...edges === undefined ? {} : { blockedBy: edges.blockedBy, edgeInstructions: edges.edgeInstructions },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'lost'],
          description: 'Optional exact status filter.',
        },
        owner: { type: 'string', description: 'Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const status = args.status
        const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, 'team_task_list')).filter(task =>
          (status === undefined || task.status === status)
          && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
          && (args.ready === undefined || task.ready === args.ready))
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.getTask(
          callingAgent(exec.agent, 'team_task_get'),
          TeamTaskId(args.task_id),
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'],
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        outputs: { type: 'array', items: OUTPUT_CONTRACT_SCHEMA, description: 'Replacement output contracts for edit.' },
        blocked_by: { type: 'array', items: BLOCKER_SCHEMA, description: 'Complete blocker list for set_dependencies, each optionally with an instruction.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory write scopes for edit.' },
        owner: { type: 'string', description: 'Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const edges = args.blocked_by === undefined ? undefined : blockers(args.blocked_by)
        return await ctx.agentTeams.updateTask(callingAgent(exec.agent, 'team_task_update'), {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.outputs === undefined ? {} : { outputs: args.outputs },
          ...edges === undefined ? {} : { blockedBy: edges.blockedBy, edgeInstructions: edges.edgeInstructions },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          ...args.owner === undefined ? {} : { owner: args.owner },
        })
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Install Team tools in every live or subsequently published Team member scope. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Config> = {
    freshProvider: config.freshProvider ?? 'spawn',
    forkProvider: config.forkProvider ?? 'fork',
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    installed.set(agent, install(agent, ctx, resolved))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team.scopedTools()')
}
