# Agent Note: Jev 作为快思考的决策队友

Status: implemented

[English](2026-09-18-jev-fast-decision-teammate.md) | 中文

## 问题

harness 只有一种智能：生成文本的推理模型。编程会话中的许多决策并不需要它——一个请求指的是三个候选文件中的哪一个，一个 diff 是否危险到需要先询问再应用，用户陈述的约束更偏向两种存储设计中的哪一种，一个上报的 bug 有多严重。把每一个这样的判断都交给会话模型，要付出一整个推理轮次的代价，产出调用方必须解析的文本，而且对答案有多可靠没有任何校准信号。

TypeSafe 的 Jev 是专为这类判断构建的 System One 模型：它读取提供的状态，在一次快速请求中返回带概率的类型化答案，不生成任何文本。harness 需要一种让主导 agent（智能体）和用户都能咨询它的方式，用户的咨询对 agent 可见，使两者不会基于不同信息行动，同时不把面向模型的约定绑定到 TypeSafe 的协议格式上。

## 决策

Jev 作为 `packages/jev/` 下的能力家族加入 harness：

1. `@deepseek-ai/dsh-jev`（`packages/jev/jev`）拥有 `ctx.jev`。它在一个包内同时是 Service Definition 和 TypeSafe 实现：请求与答案词汇（`choice`、`noul`、`score`）、调用方侧校验、通过 `ctx.credentials` 并回退到启动环境的逐次调用凭据解析、`POST /v1/systemone` 传输、协议响应校验，以及 `JevError` 分类。
2. `@deepseek-ai/dsh-tool-jev`（`packages/jev/tool-jev`）注册面向模型的 `jev` 工具和把 Jev 介绍为快思考队友的 `tool:jev` 提示词区段。工具只发送模型提供的 `state`，接受一次调用中的多个独立问题，强制执行 schema DSL 无法表达的跨字段规则，并以整数百分比概率和 confidence 渲染每个答案。
3. `@deepseek-ai/dsh-command-jev`（`packages/jev/command-jev`）注册用户的 `/jev` 命令。其语法是 `question` 表示是／否判断，或 `question | option | option` 表示 choice；其状态是会话中最新的人类文本和模型文本，按数量和字符数限制。答案直接渲染，并作为 `command-jev` 通知注入接收的 agent，使用户的咨询在 agent 的下一个步骤成为共享上下文。

`dsh-base` 组合包挂载全部三行，并把该 seam 路由到 OpenRouter（`baseURL: https://openrouter.ai/api`、`model: typesafe/jev-1.13`、`apiKeyEnv: OPENROUTER_API_KEY`）：OpenRouter 原样提供 TypeSafe 的 System One 端点，一个 OpenRouter 密钥就能同时覆盖 Jev 和部署已经路由到那里的其他模型；包默认值仍指向 `api.typesafe.ai`，供直接持有 TypeSafe 密钥的场景使用。Web 组合包在全局禁用工具行与命令行，并把它们列入自己的 `cordis` 与 `standard` agent preset，与 goal 的工具和命令做法相同，因此 agent 看到的工具来自它的 preset。没有密钥的部署保持工具和命令可见；此时调用以 `JEV_CREDENTIAL_MISSING` 失败并给出应存储的引用，遵循 web seam 的规则：凭据状态是执行时事实，而非注册时事实。

### 为什么 seam 与厂商共用一个包

能力 seam 规则只在角色独立演化时才拆分 Service Definition、Service Provider 和 Consumer。Jev 是 TypeSafe 的模型和 TypeSafe 的 API；不存在第二个 System One 提供方可注册到共享 registry 中，而发明一个只有一个成员的提供方 registry 是没有消费方的结构。两个 Consumer 是独立的包，因为它们的注入不同（`tools` 和 `systemPrompt` 对比 `commands`），部署也不同：没有命令适配器的自动化组合只挂载工具。出现第二个厂商时按 `dsh-web` 的模式拆分 `dsh-jev`，请求和答案类型保持原位。

### 为什么新会话需要 `ui-jev`

Web GUI 会把从未提示过的会话停留在空白欢迎页上，其 Chat 把孤立的通用命令行视为不会激活会话的控制面内容。因此在新会话上执行 `/jev` 会运行、得到答案，却什么都不显示——与 `/goal` 曾用[目标命令输入投影](../../archived/feature/2026-08-01-goal-command-input-projection.md)补上的是同一个缺口。`@deepseek-ai/dsh-client-ui-jev`（`packages/client/ui-jev`）沿用该路线：Jev 自有的 Conversation Definition 根据持久化的 `command/run` 在通用结果行之前构建 `jev-command-input` Chat Node，其 keyed renderer 显示一个带变暗 `/jev` 和问题的用户样式气泡；该插件还拥有命令视图插槽的 `jev` 条目，使结算结果读起来像来自 Jev 的消息，而不是折叠的命令行。可见的非命令 Node 会激活会话，因此问题和回答行会出现在新会话上并在重新加载后保留。语法还接受中文键盘打出的全角 `｜`，因为第一次真实咨询输入的正是它，却悄悄变成了一个是／否问题。

### 为什么校验放在 seam 中

模型工具和用户命令是各自跨越一个 JSON 边界的两个调用方，而 TypeSafe 只在一次往返之后才拒绝畸形问题。`decide()` 在读取凭据之前校验 id、instructions、选项数量和等级数量，并在发布之前对照产生它的问题校验每个协议答案，因此任何消费方都不会收到请求从未提供的选项。工具只增加存在于其自身边界的规则：哪些字段属于哪种问题类型、预算和重复 id。

### 为什么 `/jev` 把答案分享给 agent

只有一方能听到建议的队友会分裂团队。把咨询作为命令自有 `jev` 来源 kind 下的 `form: 'notice'` 消息注入（该 kind 以 `@persistenceAttribution` 标记，使较旧的读取器在同一 Session 格式下保留它），遵循 plan mode 对于模型必须知晓的人类操作的先例：被认领后即持久，不会唤醒空闲的 agent，其摘要让 transcript（文本记录）行保持简短。命令把最近对话作为状态发送，因为用户是在对话语境中提问；而工具不发送任何隐式内容，因为模型已经知道自己在决定什么，有界且显式的状态让每次判断可复现。

## 测试

`ui-jev` 在 jsdom 规格中固定其 Definition、位于结果行之前的顺序、仅含 done 的窗口、renderer 语义和 fiber 释放；无密钥的组装浏览器场景 `jev-command-presentation` 在新会话上以未设置的凭据引用提交 `/jev`，验证气泡、确定性的失败行、模型面事件的缺席以及重新加载后的 transcript。每个包都通过它所注册的真实 registry 证明其约定，只 mock 网络：seam 套件覆盖每条校验规则、凭据路径、HTTP 状态类别、中止时机和畸形响应体；工具套件通过 `ctx.tools.execute()` 执行并固定渲染文本和规范值；命令套件通过 `ctx.commands.execute()` 在真实 Session 上执行，并固定状态请求体、直接结果、注入的通知和生命周期配对。每个包还从 `cordis.yml` 经 Loader 启动，证明默认值和加载时拒绝。`apps/cli/tests/profiles/headless` 快照套件在真实 headless 应用上运行无密钥的 `jev-decision` 场景，使用脚本化适配器和回环 TypeSafe 替身，端到端固定模型可见的工具往返。

## 考虑过的替代方案

**把 Jev 注册为 subagent 提供方。** 否决：subagent seam 把提示词交给运行一个轮次并返回文本的子 agent；Jev 接收类型化问题并返回分布，因此每次 subagent 形态的调用都得发明一套提示词到问题的转换，再从文本中解析出结果，丢掉了作为核心价值的校准信号。

**让 Jev 成为 Agent Teams 的 teammate。** 暂时否决：实验性的 Team 名册建模的是带邮箱和任务板的持久可续子 agent，这些都以对话式成员为前提。一个工具加一个命令让主导 agent 和用户获得同样的访问能力，而不需要那套机制；如果 Teams 日后需要非对话式成员，可以在 `ctx.jev` 之上增加面向 Team 的适配器。

**使用 `@typesafe-ai/sdk` 包。** 本版本否决：端点只有一个 POST，harness 的其他外部提供方（Exa、Perplexity、DeepSeek 搜索）都用相同的重定向、中止和状态码映射规则手写 `fetch`，而 SDK 的重试和超时机制会夹在工具调用超时策略与请求之间。当重试策略有了消费方时，SDK 再作为依赖回归。

**在空白会话上把 `/jev` 的答案作为输入框通知呈现。** 否决：通知是瞬时的，重新加载后 transcript 中不会留下这次咨询；而 goal 的先例已经确立，人类命令要在新会话上占有一席之地，靠的是功能自有的 Chat Node。

**在注册时按密钥门控工具。** 否决：凭据可用性是异步的，且在进程运行期间可能变化，web seam 已经确立稳定 schema 加执行时失败才是正确的面向模型约定。

**从 `/jev` 提出 score 问题。** 延后：第三种语法形式会让命令行在选项与等级之间产生歧义；工具已公开 score，命令在用户需求出现时再增加形式。

## 后果

**每次 base 请求多两项模型可见内容。** `jev` schema 和 `tool:jev` 区段在 base 组合包的每次请求上花费固定 token，无论是否有密钥；profile 补丁可以禁用这些行。

**判断的质量取决于提供的状态。** Jev 看不到调用方没有发送的任何内容，因此不完整的 `state` 会得到对错误事实的自信答案。提示词区段和工具描述都说明了这一点，命令的有界对话窗口也被记录为用户咨询所能看到的全部内容。

**不重试。** 限流或瞬时的提供方故障作为 `JevError` 呈现一次；由模型或用户决定是否重试。

**一个包里只有一个厂商。** 增加第二个 System One 提供方意味着把 `dsh-jev` 拆成一个定义和两个实现，这是预发布立场允许的、无需兼容垫片的重命名。

在 `dsh-base` 中挂载 `tool-jev` 会把它的 schema 与提示词区段加入每个 profile 的请求前缀，因此无密钥快照语料采用刷新而非重新录制；`persistent-tools` SDK 场景排除该工具以保持最小化；两个 compaction 场景把上下文窗口按新增前缀（估算 632 个 token）放宽，使触发点保持相同的相对位置。
