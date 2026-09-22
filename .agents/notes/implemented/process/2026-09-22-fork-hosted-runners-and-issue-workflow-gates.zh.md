# Agent Note: Fork 上的托管 runner 回退与规范仓库的 issue 工作流门控

Status: implemented

[English](2026-09-22-fork-hosted-runners-and-issue-workflow-gates.md) | 中文

## Problem

必需的 Linux 与原生 Windows CI 作业选择企业级大型 runner 池，两个 failover 开关也只会把它们转向 Blacksmith 或自托管 VM。个人 fork 无法触达其中任何一个池，因此每个 fork 的 pull request 都会让必需作业永久排队，永远得不到结论。

Issue lifecycle 与 Issue policy 工作流假定运行在规范的 `deepseek-harness/deepseek-harness` 仓库：lifecycle 作业要从 fork 并不拥有的 App 安装签发 token，policy 预检则用 fork 的 PR 编号去读取规范仓库的 pull request。两个工作流在每个 fork 事件上都失败，把真实的失败淹没在永久红色的检查之后。

## Decision

[CI 工作流](../../../../.github/workflows/ci.yml)中三个企业级 Linux 作业与三个原生 Windows 作业的 runner 选择器在企业级默认值之前增加一个分支：当 `github.event.repository.fork` 为真时，作业运行在 `ubuntu-latest` 或 `windows-latest` 上。两个 failover 开关保持优先，因此规范仓库的选择不变；汇总裁决作业本来就运行在标准托管 runner 上。

[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) 与 [Issue policy](../../../../.github/workflows/issue-policy.yml) 作业以 `github.repository == 'deepseek-harness/deepseek-harness'` 为门控。门控放在工作流文件而非策略脚本中，因为两个工作流都检出默认分支上的脚本，而 fork 的默认分支可能尚未携带它；同时 lifecycle 的 token 步骤在任何脚本运行之前就已失败。

## Verification

[工作流测试](../../../../scripts/ci-workflow.spec.ts)固定每个企业级选择器中的 fork 分支，在置位 fork 标志的情况下求值每个选择器以证明托管回退只在没有 failover 开关生效时胜出，并固定两个 issue 作业上的规范仓库条件。

## Alternatives considered

**在 fork 上设置 failover 变量。** 两个开关的取值指向的池 fork 仍然无法触达，而增加第三个取值会为一个并非 failover 的场景扩大规范选择器。

**在策略脚本内部做防护。** 脚本从默认分支运行，因此无法保护默认分支早于该防护的 fork；而且 lifecycle 的 token 步骤在脚本启动之前就已失败。

**从 fork 的工作流中移除企业级池。** 这会让 fork 的 CI 在每次同步时都与上游分叉；一个纯增量分支可以干净合并，并在标志为假时逐字节保持规范行为。

## Consequences

Fork 的 pull request 在标准托管 runner 上以标准 runner 的速度得到真实的 CI 结论，issue 工作流报告为跳过而非失败。规范仓库的选择不变。`ci-master.yml` 推送工作流仍直接指定自托管与企业级池，因此向 fork 默认分支的推送会让这些作业排队；该工作流不是 pull request 门控，保持上游原样。
