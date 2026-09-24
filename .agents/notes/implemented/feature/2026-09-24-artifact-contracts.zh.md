# Agent Note: Output contracts on Team tasks, checked at completion

Status: implemented

[English](2026-09-24-artifact-contracts.md) | 中文

## 问题

Team 任务板上的 `complete` 相信调用方。owner 说完成就算完成，磁盘上有什么无关紧要：被 kill 前只写了一个文件的交付被当成诚实的错误答案打分，拆在两个队友手里的模块因为打分器只取一个文件而得零分，验证者的重跑把第一次已经做对的输出改坏了，却没有任何东西记着先前的版本。没有东西声明任务会产出什么，于是两个活跃任务可以承诺同一个文件，队友从 Lead 的散文而不是记录的任务开始工作。

## 决策

任务声明 `outputs`，即一组 `ArtifactContract`：一个像写范围一样规范化、任务内唯一的 workspace 相对路径，以及一种 kind。`file` 必须存在且非空；`json` 必须可解析，带 `schema` 时还须符合 `@deepseek-ai/dsh-tools` 强制的 JSON Schema 子集；`csv` 需要表头和一行数据；`npy` 与 `image` 必须以其格式的魔数开头；`python` 必须是一个入口文件，其 import 不指向 workspace 中定义的模块（扫描 import 行并检查 `<name>.py` 与 `<name>/__init__.py`），因此能单独运行。`complete` 通过 `ctx.fs` 相对 Lead 的工作目录检查每个非可选契约，以 `TEAM_TASK_OUTPUT_MISSING` 逐个指出不合格的输出而拒绝；没有文件系统服务时，声明了输出的任务无法完成（`TEAM_OUTPUTS_UNCHECKABLE`）。通过的输出记为带字节数与 sha256 的 `artifacts`，只出现在已完成任务上，`reopen` 时清除。若某路径上更早的已完成任务产出过不同内容，则记该任务为 `supersedes`；配置了 `artifactRoot` 时，每个已完成的输出保留在 `<artifactRoot>/<team>/<task>/<path>` 下，被取代版本的保留副本记为 `previousVersion`。活跃任务不能声明另一个活跃任务已声明的路径（`TEAM_TASK_OUTPUT_CONFLICT`）。

`edgeInstructions` 记录任务从每个 blocker 取什么，按 blocker id 键控并对照 `blockedBy` 校验。`claim` 的结果与 `reassign` 给成员的结果携带由 harness 从持久图组合的 `brief`：任务文本、每个 blocker 的状态、记录的产物与说明，以及作为完成定义的输出。被重新分配的成员还会以来自 Lead 的持久邮件收到该简报，发送时不等待投递。Team 工具在 `team_task_create` 上要求 `outputs`，blocker 条目接受 id 或 `{task, instruction}`，任务视图暴露新字段；策略文本说明该规则。三个持久字段都是现有版本 3 `team/task` payload 上的可选属性，作为同版本变更确认。

## 考虑过的替代方案

**把缺少输出的完成声明标为 `failed`。** 被拒绝：按更早的决定，任务板没有 failed 状态；以指名缺失输出的方式拒绝 `complete` 正是「前置条件失败作为观察返回」的规则，让任务留在进行中由 owner 完成，且绝不记录 workspace 不支持的完成。

**运行 Python 入口文件来证明它能独立运行。** 暂时拒绝：在 `complete` 里执行交付物是任务板不该拥有的副作用，且需要 Team 服务进程里有 Python；对照 workspace 静态扫描 import 行已能抓住基准测试中测到的模块拆分情形。

**在 workspace 内保留先前版本。** 被拒绝：打分器会收集 workspace；保留放在配置的 harness 本地根目录下，没有配置的部署仍记录哈希与取代关系。

**在共享类型中用 `dsh-tools` 的 `JsonSchemaNode` 给契约 schema 定型。** 被拒绝：Team 类型由浏览器客户端读取，且 Remote 边界拒绝无约束数据；schema 是 `Record<string, JsonValue>`，在声明契约时对照受支持子集断言。

## 测试

包测试覆盖契约规范化及其拒绝、创建与编辑时的活跃路径冲突、每种 kind 的接受与拒绝信息、schema 校验、含相对 import 的独立运行扫描、空文件、路径上是目录、记录带哈希的产物并在 reopen 时清除、有无保留先前版本的取代、没有文件系统服务时的完成、经校验并进入简报的边说明、claim 返回且 reassign 邮寄的简报、该邮件失败时的包含、import 扫描器、projection 对产物与说明的规则，以及工具面：必填的 outputs、blocker 对象、编辑后的契约列表、claim 结果中的简报。`team-targets` 快照固定了变化的策略文本与 schema。

## 后果

`completed` 现在意味着声明的产物存在且符合声明，这正是结算、沿产物谱系的信用分配和打分器都需要的；格式良好但错误的产物照样完成。每次创建任务都要点明交付物，这让 Lead 预先付出声明的代价，并拒绝从不说明产出的分解。
