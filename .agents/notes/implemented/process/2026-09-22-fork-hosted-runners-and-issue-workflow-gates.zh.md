# Agent Note: Fork 上的托管 runner 回退与规范仓库的 issue 工作流门控

Status: implemented

[English](2026-09-22-fork-hosted-runners-and-issue-workflow-gates.md) | 中文

## Problem

必需的 Linux 与原生 Windows CI 作业选择企业级大型 runner 池，两个 failover 开关也只会把它们转向 Blacksmith 或自托管 VM。个人 fork 无法触达其中任何一个池，因此每个 fork 的 pull request 都会让必需作业永久排队，永远得不到结论。

Issue lifecycle 与 Issue policy 工作流假定运行在规范的 `deepseek-harness/deepseek-harness` 仓库：lifecycle 作业要从 fork 并不拥有的 App 安装签发 token，policy 预检则用 fork 的 PR 编号去读取规范仓库的 pull request。两个工作流在每个 fork 事件上都失败，把真实的失败淹没在永久红色的检查之后。

## Decision

[CI 工作流](../../../../.github/workflows/ci.yml)中三个企业级 Linux 作业与三个原生 Windows 作业的 runner 选择器在企业级默认值之前增加一个分支：当 `github.event.repository.fork` 为真时，作业运行在 `ubuntu-latest` 或 `windows-latest` 上。两个 failover 开关保持优先，因此规范仓库的选择不变；汇总裁决作业本来就运行在标准托管 runner 上。

[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) 作业在工作流文件中以 `github.repository == 'deepseek-harness/deepseek-harness'` 为门控，因为它的 token 步骤在任何脚本运行之前就已失败。[Issue policy](../../../../.github/workflows/issue-policy.yml) 作业按其可信预检约定保持无条件；改由预检脚本对 `repository.full_name` 不是规范仓库的事件做豁免，写出 `exempt=true`、`needs-project=false` 与 `legacy-automated=true`，使 token 与校验步骤在不发起任何 API 读取的情况下跳过。预检步骤的 shell 脚本会先以 `GITHUB_REPOSITORY` 为键做同样的豁免，因为策略脚本从默认分支检出，而工作流文件来自 pull request 本身，所以 fork 的第一个 pull request 在其默认分支携带脚本变更之前就已豁免。[Cloudflare 预览](../../../../.github/workflows/build-preview-cloudflare.yml)作业同样以规范仓库为门控，因为其部署需要 fork 并不拥有的 secrets。

## Verification

[工作流测试](../../../../scripts/ci-workflow.spec.ts)固定每个企业级选择器中的 fork 分支，在置位 fork 标志的情况下求值每个选择器以证明托管回退只在没有 failover 开关生效时胜出，并固定 lifecycle 作业上的规范仓库条件。[Issue 管理测试](../../../../.github/issue-management/policy.test.mjs)固定非规范仓库的事件在不发起请求的情况下被豁免，规范仓库仍执行完整预检，并且工作流的 shell 脚本对外来的 `GITHUB_REPOSITORY` 直接写出豁免输出而不调用策略脚本。

## Alternatives considered

**在 fork 上设置 failover 变量。** 两个开关的取值指向的池 fork 仍然无法触达，而增加第三个取值会为一个并非 failover 的场景扩大规范选择器。

**也在工作流文件中门控 policy 作业。** policy 工作流的测试要求该作业及其预检保持无条件，使必需检查永远不会被一次工作流编辑跳过；脚本级豁免保住了这一约定，而 fork 只需付出一次 checkout 的代价。

**从 fork 的工作流中移除企业级池。** 这会让 fork 的 CI 在每次同步时都与上游分叉；一个纯增量分支可以干净合并，并在标志为假时逐字节保持规范行为。

## Consequences

Fork 的 pull request 在标准托管 runner 上以标准 runner 的速度得到真实的 CI 结论，issue 工作流报告为跳过而非失败。fork 的 coverage 通道运行两个而非默认三个插桩分区，因为在 4 核托管 runner 上，三个分区会让自带 60 s 预算的测试得不到 CPU。DeepSeek 默认值 headless fixture 把流空闲预算从 150 ms 放宽到 1 s，与 pi-ai 默认值 fixture 一致，因为标准 runner 可能把 fixture 服务器 60 ms 一次的 keep-alive 拖延到触发重试，从而破坏请求计数。规范仓库的选择不变。裁决作业不依赖的 Windows coverage 通道在 fork 上仍然是红的：`windows-latest` 只有两个核心且账户模型不同，沙箱 ACL、工作区准备与 persistence-schema 套件在那里的失败不是分区数量能解决的。`ci-master.yml` 推送工作流仍直接指定自托管与企业级池，因此向 fork 默认分支的推送会让这些作业排队；该工作流不是 pull request 门控，保持上游原样。
