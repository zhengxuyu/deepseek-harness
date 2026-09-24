---
description: "在一个会话中运行一个小型具名 agent（智能体）团队：成员之间的持久消息与共享任务板，用于组合实验性 Team 插件的部署。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team` 把一个编码会话变成一个小型工作团队：会话中的 agent 成为 Lead，创建具名 teammate 处理委派的工作，与它们交换持久消息，并在公共任务板上跟踪共享任务。消息与任务状态能挺过崩溃、reload 与中断，因此离线的 teammate 会在恢复后收到排队的消息。它本身不提供任何工具——请挂载兄弟包 `dsh-experimental-tool-agent-team`，让模型能够创建 teammate、给它们发消息并使用任务板。它以实验性名称公开发布、不承诺稳定性，并且需要持久会话存储才能激活。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当一个 agent 应该在自己的工作目录中运行一支小型具名助手团队、且消息与任务状态需要挺过崩溃与重启时，把本包加入组合。它本身不带工具：请与 `@deepseek-ai/dsh-experimental-tool-agent-team` 一起挂载，让模型能够创建 teammate、给它们发消息并使用任务板。

### 何时选择

当多个 agent 必须在同一个共享工作区协作、且 roster、消息与任务状态需要挺过崩溃与重启时，选择它。当 teammate 需要独立工作目录、多个进程需要协调同一支团队、或任务 owner 需要自动释放时，请不要选择——这些都不受支持。团队功能需要持久会话存储才能激活。

### 最小工作配置

<a id="smallest-working-setup"></a>

对现有组合的最小增量是持久会话存储加两个 Team 包：

```yaml
# smallest team setup — durable storage plus both Team packages
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

工具安装后，模型会按请求完成其余工作——例如先「创建一个名为 reviewer 的 teammate 检查 diff」，再「把变更摘要发给 reviewer」。所有限制都是可选的，并在启动时校验：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxMembers` | `16` | 一支团队最多可创建的 teammate 数，包括失败的 |
| `maxTasks` | `256` | 任务板上最多的活动任务数 |
| `maxPendingMessagesPerMember` | `64` | 单个成员最多可排队的消息数 |
| `maxMessageBytes` | `65,536` | 单条发送消息的最大尺寸 |
| `disposalTimeoutMs` | `5,000` | 关闭清理允许的时间 |
| `trackSubagentRuns` | `false` | 把 Lead 之下的普通 `subagent` 运行记录为任务板上有 owner 的任务，并在每次运行结束时结算 |
| `artifactRoot` | 无 | harness 本地的绝对目录，每个已完成的输出以 `<team>/<task>/<path>` 保留在其下；缺省时只做哈希不保留 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。

### Teammate

请 Lead 创建 teammate：给它一个唯一的小写名字（例如 `reviewer`）并描述其职责。teammate 可以 fresh 启动（不携带 Lead 对话的任何记忆），也可以作为 fork 启动（继承 Lead 已完成的轮次）；创建请求决定用哪种。teammate 名字是永久的——即使创建失败的 teammate 也保留其名字，任何名字都不会被复用。

roster 显示每个成员的职责（`lead` 或 `teammate`）与当前状态：`running`、`inactive`（当前没有执行轮次，包括已加载和仅存储的成员）、`provisioning` 或 `failed`。未加载的成员会在唤醒后收到其消息。

只有 Lead 可以创建 teammate 或中断它们。

### teammate 之间的消息

任何成员都可以向任何其他成员或 Lead 发送消息。live 成员会立即收到；离线成员的消息会排队，并在其恢复后到达。消息不会丢失，也不会重复投递。

每条消息都使用 Steer：running target 在最近的步骤边界收到消息，inactive target 在已加载时启动一个轮次，否则冷恢复。发送方始终能看到结果——target inbox 已接受，或在投递暂时不可用时保留为 queued。排队的消息已经安全存储，因此绝不能重发。

### 共享任务板

任何成员都可以添加任务，包含标题、详情、对其他任务的可选依赖，以及可选的文件触及提示。只有其全部依赖完成后，任务才可 claim。

任务有 owner：成员 claim 任务开始工作，完成后标记完成、释放回板或重新打开；Lead 可以把任务分配给任意成员。每次变更都是 compare-and-set：基于过期副本的更新会被拒绝，因此两个成员不会悄悄覆盖彼此的成果。

当两个 in-progress 任务计划触及重叠路径时，文件提示会产生警告——它们绝不阻止任何操作。已删除任务保留在历史中，但从活动列表中消失。

harness 放弃了其 owner 的任务是 `lost`，owner 仍然记着；重新打开它才能再次 claim。任务一旦进行中或已完成，其文本与依赖不再改变，运行中的任务也不能转交给另一个成员。

任务声明它将产出的文件。在每个文件都在磁盘上且符合声明之前，完成会被拒绝，所以任务只有在产物存在时才算完成；两个任务不能同时承诺同一个文件。blocker 可以带一条说明，写明依赖它的任务从它取什么；开始一个任务的人会收到由记录的任务、其输入和输出组合而成的简报。

### 等待与中断

成员可以等待下一次团队变化——teammate 的状态、新消息或任务更新——而不必反复轮询；等待只报告是否超时，调用方随后重新读取当前状态。

Lead 可以停止 teammate 的当前轮次，而不会删除其排队的消息；任务归属不变。

### 成功与失败的表现

成功的表现是：teammate 出现在 roster 中、消息报告 `accepted` 或 `queued`、任务 revision 随每次变更递增。可能的失败会以具体错误报告，而不会悄悄破坏状态：发给不存在的成员名字、claim 尚未就绪的任务、用过期 revision 编辑、或超出成员上限创建 teammate。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本服务建立在一个分离与三项承诺之上：

- **持久日志，派生状态。** Lead 会话日志是唯一真源；roster、mailbox 与任务状态每次读取都从中回放。
- **进程内归属。** 所有协作都位于单一进程；保证是重试加去重，绝不是跨进程共识。
- **显式权限。** 每个服务方法都接收确切的实时调用方 `Agent`；只有 Lead 可以 spawn、reassign 或 interrupt。
- **超出上限时明确失败。** 每个限制都是经过校验的部署值，耗尽时报告类型化错误，而不是复用 id 或名字。

[Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、任务与共享 checkout 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、服务注册、恢复调度 |
| [`src/roster.ts`](src/roster.ts) | Team 身份、成员关系解析、provisioning 与 roster 拆除 |
| [`src/mailbox.ts`](src/mailbox.ts) | 持久队列、目标本地投递、确认与恢复 |
| [`src/task-board.ts`](src/task-board.ts) | 任务 CAS 命令、DAG 校验与派生视图 |
| [`src/journal.ts`](src/journal.ts) | 串行化的 Lead 日志事务与提交通知 |
| [`src/projection.ts`](src/projection.ts) | 解码并校验 Team 事件的严格回放投影 |
| [`src/activity.ts`](src/activity.ts) | 一次性变更等待者与 dispose（资源释放）时的等待解除 |
| [`src/lifecycle.ts`](src/lifecycle.ts) | 共享准入截止与有界结算 |
| [`src/invariant.ts`](src/invariant.ts) | 在 append 前回放候选事件的不变式伴生插件 |

### Team 身份与 roster

每个普通运行时 root 都是一个隐式 Team 的 Lead，其 `TeamId` 等于 `SessionId`；不存在创建事件，持久状态从第一条成员、消息或任务记录开始。`spawnTeammate()` 先追加并 flush 一条 `provisioning` 成员记录，再要求配置的提供方创建预留 child；提供方失败会追加一条持久的 `failed` 成员。fresh child 不携带 Lead 历史；fork child 只捕获一次 Lead 的已完成 turn 前缀。恢复把未终结的 provisioning 记录对照 child 独立持久化的会话进行对账：直接 parent 与 continuable descriptor 匹配、且初始用户消息已记录则产生 `active`，其他任何情况都产生 `failed`。如果恢复在同进程竞争中先完成，creator 会接受终态，或报告 `TEAM_PROVISIONING_CONFLICT` 并 drain 该 child。名字由第一条 provisioning 记录保留，且永不复用。

### 持久 mailbox

`sendMessage()` 校验 peer 成员关系，追加 `team/message/queued` 并在尝试投递前 flush。目标消息以 `Team message <id> from <name>:` 开头，并在 `TeamMessageSource` 中保留同一 id 与发送者。只有目标会话在 pending inbox 或已记录历史中持久持有消息身份后，才会以 `team/message/delivered` 确认投递。即时准入按目标与持久队列顺序串行化；恢复按同一顺序重新投递 queued-minus-delivered 记录。重试前会同时折叠 live 与持久目标 inbox／历史状态，因此 inbox 已接受但模型尚未 claim 时发生崩溃不会复制消息。该保证是进程内重试加 target 会话去重，而不是跨进程 exactly-once 投递。

投递给 Lead 时直接调用 `Agent.steer()`。投递给 teammate 时使用 continuation owner 的 host-only Steer 路径；该路径会保留 Team 发送者 source，同时授权 Lead-to-child edge 并冷恢复 inactive target。sibling 消息绝不会通过公开的相邻 Agent 消息操作伪装成 Lead。

### 共享任务板

任务是完整版本化快照；每次变更都携带 `expectedRevision`，陈旧调用方会收到 `TEAM_TASK_STALE_REVISION`，而不会覆盖更新的值。数字 `task-<n>` id 的后缀必须是安全整数，id 空间耗尽时报告 `TEAM_TASK_LIMIT`，而不是复用最后一个 id。已删除任务作为 tombstone 保留以供回放与维持 id 稳定，但不占用 `maxTasks`，也不出现在 `listTasks()` 中。`writeScopes` 是规范化后的 workspace 相对前缀；视图会对与 in-progress 任务的重叠发出警告，但绝不阻止 claim 或授予写权限。

图中已执行的部分是冻结的。`edit`、`set_dependencies` 与 `delete` 只接受 `pending` 或 `lost` 任务；`reassign` 给成员只接受 ready 的 `pending` 任务；不带 owner 的 `reassign`（Lead 侧的释放）接受 `pending` 或 `in_progress`。其余情况一律回答 `TEAM_TASK_INVALID_TRANSITION`，因此运行中的任务保持其 owner 开始时的文本与边，已完成的任务保持其结果所对应的记录。

`lost` 是 harness 的状态，绝不是成员动作：`markLost(caller, id, cause)` 把一个 `in_progress` 任务移入该状态并保留其 owner 记录；provisioning 失败的成员会丢失它在 provisioning 期间认领的一切（`owner-failed`）。lost 任务不能被 claim 或 complete；`reopen` 把它变回无 owner 的 `pending`，在此之前可以先用 `edit` 或 `set_dependencies` 修订它。它的依赖方保持阻塞，它的写范围不再产生警告。`outstandingTasks(caller)` 列出调用方任务板上的 `in_progress` 任务以及每个 owner 当前是否在运行（进程外 provider 承载的被跟踪运行在结束前都视为运行中），这正是一次性宿主在退出前等待的东西。

`outputs` 是任务的完成定义。每个 `ArtifactContract` 指定一个 workspace 相对路径（像写范围一样规范化，任务内唯一）和一种 kind：`file` 必须存在且非空；`json` 必须可解析，带 `schema` 时还须符合 `dsh-tools` 强制的 JSON Schema 子集；`csv` 需要表头和至少一行数据；`npy` 与 `image` 必须以其格式的魔数开头；`python` 必须是一个入口文件，其 import 不指向 workspace 中定义的模块，因此能单独运行。`complete` 通过 `ctx.fs` 相对 Lead 的工作目录检查每个非可选契约，以 `TEAM_TASK_OUTPUT_MISSING` 逐个指出不合格的输出；声明了输出的任务没有文件系统服务时无法完成（`TEAM_OUTPUTS_UNCHECKABLE`）。通过的输出记为 `artifacts`，带字节数与 sha256；若某路径上更早的已完成任务产出过不同内容，则记该任务为 `supersedes`；配置了 `artifactRoot` 时，每个已完成的输出以 `<artifactRoot>/<team>/<task>/<path>` 保留，被取代版本的保留副本记为 `previousVersion`。活跃任务（`pending`、`in_progress`、`lost`）不能声明另一个活跃任务已声明的路径（`TEAM_TASK_OUTPUT_CONFLICT`）；已完成任务的路径可以再次声明。`reopen` 清除记录的 artifacts。

任务板为每项工作只保留一个节点。`create` 以及改名的 `edit` 会拒绝另一个活跃（`pending`、`in_progress` 或 `lost`）任务已经使用的 subject，比较时忽略大小写和空白，以 `TEAM_TASK_DUPLICATE_SUBJECT` 指出该任务及其状态：调用方应依赖它、编辑它，或在它 lost 时 reopen 它。已完成或已删除的任务会释放其 subject，因此第二轮可以复用同名。

`edgeInstructions` 记录任务从每个 blocker 取什么，按 blocker id 键控，随 `blockedBy` 一起由 `set_dependencies` 替换。`claim` 的结果与 `reassign` 给成员的结果携带 `brief`：任务文本、每个 blocker 的状态、记录的 artifacts 与说明，以及作为完成定义的输出契约。被重新分配的成员还会以来自 Lead 的持久邮件收到该简报，这会启动或恢复它。

`trackSubagentRuns` 会把 Team 之下的每一次 `subagent/start` 记录为该 Team Lead 任务板上一个有 owner 的 `in_progress` 任务，并根据配对的 `subagent/end` 结算：`completed` 完成该任务，其他任何 stop reason 都把它标记为 `lost`，原因为 `owner-failed`，并把该 stop reason 记为 `ownerStop`。Lead 通过沿委派 parent 的谱系向上查找最近的成员或 Root 得到；roster 成员自身的 epoch 不会被记录，因为 roster 已经拥有它们。

### 等待与中断

`waitForChange()` 等待注册之后发生的下一条 roster、task、mailbox 或实时状态边，时长从 10 秒到 1 小时，并且只报告是否超时；运行时 dispose 会释放当前等待。取消会保留 Error reason；非 Error reason 则通过 `TEAM_WAIT_ABORTED` 报告。`interrupt()` 仅限 Lead，委托 continuable-subagent 的 interrupt 路径，以 `keepInbox` 只取消 live teammate 的当前 turn；它既不释放任务 owner，也不删除持久 mail。

### 持久性模型

Team 事件追加到精确的 live Lead 会话，并在操作报告成功或唤醒等待者之前 flush。`team/member`、`team/task`、`team/message/queued` 与 `team/message/delivered` 仅存在于日志：它们从不进入会话表面，因此派生模型历史不受协作记录影响。顺序与时间由会话事件的 `seq` 与 `time` 负责，快照不重复保存。`./invariant` 伴生插件把每条候选 Team 事件对照已提交前缀回放，并在 append 前拒绝非法转换。

原生 V4 的 Team 事件及检查点准入会拒绝退役的 `tool-result` 内容，防止它进入邮箱状态。历史转换由 Session 格式迁移负责，Team 投影不转换旧包装。

Mailbox 投影与 checkpoint 准入保留本地声明的校验器之外获准内容中全部已解码 JSON 字段，包括自有 `__proto__` 键。本地字段检查覆盖 `text`、`reasoning`、`image` 和 `tool-call`；获准的未知标签保持不透明。Team 投影缓存版本 4 从 Session 日志重建较早缓存版本的 checkpoint；Session 格式版本保持不变。`team/task` 记录以 payload 版本 3 写入，新增 `lost` 状态、`lostCause` 与 `ownerStop`；`team/member` 记录以版本 3 写入，新增 `lastStop`，即成员最近一次结束的回合的 stop reason，active 成员每结束一个回合追加一条。此前写入的版本 2 记录仍可读取，mailbox event 保持版本 2。

### Dispose

dispose 会关闭准入、中止并等待已获准的创建与 mailbox dispatch 事务，再让 continuation owner 释放 roster 中确切的 live direct child 及其后代；Lead 的非 Team continuable child 不受影响。cleanup 失败会让 dispose 明确失败，并以 `disposalTimeoutMs` 为上限。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享子系统类型逐步进入工具表面与设计背后的决策。

- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [tool-agent-team 包](../tool-agent-team/README.zh.md)——让模型创建 teammate、向其发送消息并进行协调的工具。
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)——身份、mailbox、任务与共享 checkout 决策。
- [实验包决策](../../../.agents/notes/implemented/architecture/2026-08-18-experimental-agent-teams-packages.zh.md)——位置、公开发布与依赖隔离。

-----

<a id="model-experience"></a>

### 浏览器 Remote

`TeamService` 向浏览器客户端公开只读的 `agentTeams/view` Remote method。任务创建与更新由 Team agent 通过服务和模型工具执行。`./remote` 导出由 Web UI 挂载的 Client contribution，`./client` 导出可供浏览器使用的成员与任务视图。

## 模型体验

### Peer 消息

#### 模型看到什么

每条已投递 peer 消息都是用户角色消息。第一个短文本块包含稳定消息 id 与发送者，之后原样附加发送者的内容块。roster、task 与 mailbox 记录仅存在于日志，绝不进入派生模型历史。

#### Token 影响

每次 peer 投递都会把发送者前缀与消息内容加入 target 历史。任务与 roster 变更不增加模型 token；其面向模型的呈现属于 `@deepseek-ai/dsh-experimental-tool-agent-team` 结果。

#### KV Cache 影响

Peer 消息追加在 target 可复用历史前缀之后。冷恢复会先复用持久对话，再追加尚未投递的消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明一支团队目前不能做什么、或哪些方面需要特别的运维关注。它们是当前包约束，不是与其他协作机制的对比。

- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间约定仍可自由变更。
- **单进程、共享 checkout**——成员共享 cwd，修改立即可见；本包不提供 worktree、远端成员、merge 或文件锁。
- **write scope 仅作提示**——Bash、formatter、代码生成器与直接外部写入可以绕过文件版本检查；Lead 必须协调 owner 并检查最终 diff。
- **扁平且不可变的 roster**——只有 Lead 可以创建直接 teammate；不支持嵌套 Team、重命名、删除或名字复用。
- **不会自动释放 owner**——成员不活动、interrupt、进程退出与工作失败都不会释放任务 owner；放弃某个 owner 的一次性宿主会把任务标记为 `lost` 并保留 owner 记录，只有 `reopen` 会清除它。
- **被跟踪的运行不带契约**——通过 `trackSubagentRuns` 记录的运行只记下它的 provider 与子 Session，不记它收到的 prompt 或它应交付的产物；它的完成只是运行的 stop reason，不是对其产出的检查。
- **输出检查看形式，不看正确性**——存在、格式、schema 和静态 import 扫描；格式良好但错误的结果照样完成，`python` 检查读的是 import 行，不是文件运行时做了什么。
- **保留是进程本地的**——`artifactRoot` 通过运行 Team 服务的进程的 Node 文件系统复制，远端文件系统后端上的 workspace 只做哈希不保留。
- **mailbox 不保证跨进程 exactly-once**——不支持多个 harness 进程并发操作同一 Team。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

#### Promotion

promotion 到产品角色组需要按[实验子树规则](../AGENTS.md)审查公共约定、限制、测试证据、发布载荷、运行时依赖与具名稳定 owner。

#### 未来方向

尚未决定的探索方向包括嵌套 Team、自动释放 owner 的策略、跨进程 mailbox 事务，以及通过 worktree 实现文件系统隔离；这些都没有承诺。

</details>
