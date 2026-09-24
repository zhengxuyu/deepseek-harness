# Agent Note: One live task per subject

Status: implemented

[English](2026-09-24-one-node-per-subject.md) | 中文

## 问题

b1 team-mode sweep 中有五个 Lead 创建了 `blocked_by` 指向不存在 id 的任务，收到拒绝后又用同一个 subject 再创建一次，于是任务板上出现了同一项工作的孪生节点：两个节点分别被认领、简报和完成，却对应一个交付物，图的边指向 Lead 碰巧记得的那一个。任务板已经在 `create` 和 `set_dependencies` 时拒绝无法解析的边，并冻结已执行的历史；没有任何东西拒绝重复的节点。

## 决策

`create` 以及改名的 `edit` 拒绝另一个活跃任务已使用的 subject。活跃指 `pending`、`in_progress` 或 `lost`；已完成或已删除的任务释放其 subject，因此第二轮可以复用同名。subject 比较忽略大小写与内部空白，因为运行中出现的孪生只在这两点上不同。拒绝码为 `TEAM_TASK_DUPLICATE_SUBJECT`，指出该任务、其状态和补救方式：依赖它或编辑它，lost 时则 reopen 它。被跟踪的委托运行不做此检查：两个并行委托可以合理地带同一个 prompt，且其 subject 从不由 Lead 撰写。

## 考虑过的替代方案

**把重复的 create 合并进已有任务。** 被拒绝：第二个请求可能带有不同的文本、边或输出，静默合并要么丢弃它们，要么编辑了调用方没有点名的任务；指出任务的拒绝让调用方自己选择。

**精确匹配比较。** 被拒绝：观察到的孪生只在大小写和空白上不同；放过这些的检查对运行中产生的情况一个也拒绝不了。

## 测试

包测试覆盖创建与改名时的拒绝、大小写与空白折叠、完成后与删除后的复用、lost 任务的补救文案，以及工具面把拒绝作为观察返回。`team-targets` 快照固定了策略文本与工具描述。

## 后果

丢失自己任务板状态的 Lead 会被告知已有节点，而不是长出孪生，代价是一次被拒绝的调用。想要两个同名任务的 Lead 必须给它们不同的 subject。
