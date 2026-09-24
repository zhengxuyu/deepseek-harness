# Agent Teams

[English](agent-team.md) | 中文

实验性隐式 Root Team 领域、模型工具与宿主适配器共享的类型。[Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、task 与共享 checkout 决策；本页记录 [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts) 中的字面持久形式。

## 身份与 roster

`TeamId` 是具有独立[品牌](core.zh.md#branded-ids)的 Root `SessionId`。`TeamTaskId` 在 Team 内按 `task-<n>` 单调分配；`TeamMessageId` 是全局随机值。teammate 的 Session id 始终是持久身份，而 `name` 是不可变的模型／UI 标签。

```ts type-equiv
/** Whole durable value written on every teammate lifecycle change and turn end. */
interface TeamMemberSnapshot {
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
```

每个 member 都从 `provisioning` 开始，并且只到达一个终态 roster phase：`active` 或 `failed`。roster 的 `running`／`inactive` 状态单独派生，绝不会重写该记录。此后，active 成员每结束一个回合都会追加一条只改变 `lastStop`（该 epoch 的 stop reason：`completed`、`aborted`、`error`、`max-tokens`、`refusal`）的记录，以 payload 版本 3 写入；版本 2 记录仍可读取。

## 持久 mailbox

Lead Session 首先存储完整 queued message。只有 target 的 pending inbox 条目或已记录用户消息完成持久化，才会写入独立 acknowledgement event，queued-minus-delivered 因而构成恢复 mailbox。

```ts type-equiv
/** One peer message retained until its target Session records it. */
interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}
```

每条消息都会尝试 Steer 投递。running target 在最近的步骤边界收到消息，inactive target 在已加载时启动一个轮次，否则冷恢复。调用方不能选择其他模式，因此持久记录不存储调度方式。

target Session 会在 pending inbox 条目和最终用户消息上保留消息身份与发送者归因。跨 inbox 与历史折叠该 source 构成 target 侧去重键；模型可见的 framing 会重复 id 和发送者。

```ts type-equiv
/** Source retained by the target Session for durable mailbox de-duplication. */
interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}
```

## 共享任务 DAG

每条 task event 都存储完整快照。`revision` 是 compare-and-set 值，每次变更递增 1。`blockedBy` edge 必须指向未删除任务，并维持无环图。`writeScopes` 是规范化的提示性路径前缀，不是锁。

```ts type-equiv
/** Whole durable task snapshot; every mutation increments {@link revision}. */
interface TeamTaskSnapshot {
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
}
```

`pending` 表示尚未开始或已经释放，`in_progress` 携带 owner，`completed` 满足 blocker，`lost` 是 harness 已放弃其 owner 的进行中任务（`lostCause` 为 `owner-failed` 或 `run-ended`；owner 记录保留到 `reopen` 为止），`deleted` 是保留的 tombstone。`in_progress` 与 `completed` 任务是冻结的：其文本、边与分配不再改变。因被跟踪的运行未完成而 lost 的任务还会把该运行的 stop reason 记为 `ownerStop`。`outputs` 是任务的完成定义：每个 `ArtifactContract` 指定一个 workspace 相对路径和一种 kind（`file`、可带 schema 的 `json`、`csv`、`npy`、`image`、`python`），在每个非可选输出都存在于磁盘并通过其 kind 的检查之前，`complete` 以 `TEAM_TASK_OUTPUT_MISSING` 拒绝；通过的输出随后记为 `artifacts`（路径、字节数、sha256，以及该路径上被它取代的更早已完成任务）。两个活跃任务不能声明同一个输出路径。`edgeInstructions` 说明任务从每个 blocker 取什么。view 会添加 owner name、readiness、lost cause、owner stop 和 write-scope 重叠警告，但不会改变持久快照；`claim` 与 `reassign` 的结果还携带 harness 组合的 `brief`。

## 回放

`foldTeam()` 把一个 Root Session 回放成每个 Team 操作所读取的 roster、任务板与 queued-minus-delivered mailbox。它按 `TeamId` 选取记录，因此普通 fork 继承的 event 保留 ancestor id，绝不会进入新 Root 的状态。Session event 的 `seq` 与 `time` 继续负责顺序和时间记录，Team snapshot 不再重复保存它们。roster 与 task 读取以 view 形式到达调用方，而 pending 邮件仅供投递与恢复内部使用。`team/task` payload 以版本 3 写入，新增 `lost` 与 `lostCause`；版本 2 的 payload 仍可读取。包 [README](../../packages/experimental/agent-team/README.zh.md)负责 operation、authorization、recovery 和限制行为。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
/**
 * Resolve one exact live Agent's Team role.
 * @param agent - exact live Agent used as the authority credential.
 * @returns its root, Team identity, role, and model-facing name.
 */
membership(agent: Agent): TeamMembership

/**
 * List the runtime-enriched roster visible to one Team member.
 * @param agent - exact live Team member.
 * @returns Lead and teammate rows in creation order.
 */
listMembers(agent: Agent): TeamMemberView[]

/**
 * Create one named, continuable direct child of the Team Lead.
 * @param caller - exact live Lead Agent.
 * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
 * @returns the active roster row.
 */
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>

/**
 * Queue one durable peer message, then attempt immediate delivery.
 * @param caller - exact live sending Team member.
 * @param request - target name, content, and pre-queue cancellation.
 * @returns durable message identity and immediate-delivery observation.
 */
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>

/**
 * Create one unowned pending task in the Team Lead log.
 * @param caller - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task view.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Return one task, including a deleted tombstone.
 * @param caller - exact live Team member reading the task.
 * @param id - Team-local task identity.
 * @returns the latest task value and derived readiness diagnostics.
 */
getTask(caller: Agent, id: TeamTaskId): TeamTaskView

/**
 * List current non-deleted tasks in numeric creation order.
 * @param caller - exact live Team member reading the board.
 * @returns detached current task views.
 */
listTasks(caller: Agent): TeamTaskView[]

/**
 * Compare-and-set one authorized task transition.
 * @param caller - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns the committed next task revision.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>

/**
 * List in-progress tasks on the caller's Team board with whether each owner is still running.
 * @param caller - exact live Team member reading the board.
 * @returns outstanding rows in creation order; empty once every claimed task settled.
 */
outstandingTasks(caller: Agent): OutstandingTeamTask[]

/**
 * Mark one in-progress task `lost` on behalf of the harness; the owner stays recorded.
 * @param caller - exact live Team member whose board holds the task.
 * @param id - task whose owner can no longer finish it.
 * @param cause - why the harness gave up on the owner.
 * @param ownerStop - how the owning run ended, when the cause is a run's stop reason.
 * @returns the lost task view.
 */
async markLost(caller: Agent, id: TeamTaskId, cause: TeamTaskLostCause, ownerStop?: SubagentStopReason): Promise<TeamTaskView>

/**
 * Wait for the next Team-domain or member-status change.
 * @param caller - exact live Team member waiting for activity.
 * @param timeoutMs - bounded wait duration from ten seconds through one hour.
 * @param signal - caller cancellation for the wait only.
 * @returns one observed change or a timeout result.
 */
async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>

/**
 * Interrupt one live teammate turn without clearing its pending inbox.
 * @param caller - exact live Lead Agent.
 * @param targetName - durable teammate name.
 * @returns the target status sampled before cancellation.
 */
interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' }

/**
 * Resolve a caller without throwing, used by scoped-tool installation and observers.
 * @param agent - candidate exact live Agent.
 * @returns Team membership, or undefined for non-Team subagents and stale identities.
 */
tryMembership(agent: Agent): TeamMembership | undefined

/**
 * Read the current roster and non-deleted task board through the generated Remote API.
 * @param agent - exact live Team member used as the authority credential.
 * @returns detached current roster and task views.
 */
@Remote('view') remoteView(agent: Agent): TeamView
```

Types: [Agent](core.zh.md) · [SubagentStopReason](subagent.zh.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
