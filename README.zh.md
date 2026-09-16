# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 委派：`subagent` 与 Agent Teams

dsh 提供两种让 agent 把工作交给其他 agent 的方式。`tool-subagent` 挂在 `dsh-base` 里，默认可用。Agent Teams —— `packages/experimental/agent-team` 与 `tool-agent-team` —— 是可选的：部署方通过 patch 层挂载这两个插件，且只有当对话中明确要求使用 Agent Teams 或 teammates 时，Lead 才会创建团队。

| | `tool-subagent` | Agent Teams |
|---|---|---|
| 模型可见的工具 | 一个 `subagent(description, prompt)` 调用，即发即忘，返回 `started subagent <id>`；另有 `list_agents` 与 `send_message` | `spawn_teammate`、`team_task_create` / `list` / `get` / `update`、`send_message` / `followup_task`、`wait_agent`、`interrupt_agent`；另有一段固定的工作流策略写入系统提示 |
| 协调模型 | 仅父 ↔ 子；子之间互不可寻址；没有共享状态；任务就是那段 prompt 文本 | 扁平的具名花名册、持久的 peer 信箱、共享任务板（DAG 依赖、每任务一个 owner、compare-and-set 修订号、建议性的写范围） |
| 等待结果 | 父 agent 结束回合，子 agent 停稳后将其唤醒 | `wait_agent` 让 Lead 阻塞等待团队事件；策略要求 Lead 在给出最终答案前等待所需的 teammate |
| 持久化 | 每个子 agent 是持久会话；无共享 | 花名册、任务与信件均从 Lead 会话日志折叠而来：持久、可冷恢复、可重放 |
| 身份 | 匿名 session id | 不可变的 kebab-case 名字，可寻址，永不复用；失败的成员保留其槽位 |
| 激活 | 默认挂载；prompt 要求时使用 | 需显式挂载；仅当用户明确要求 Agent Teams 或 teammates 时才创建 teammate |
| 文件隔离 | 无 | 无 —— 写范围只对重叠发出警告，不是锁 |
| ASI-Bench b1 上的观察（本 fork `fac9bd0`，`--profile headless`） | 60 个实例中 12 个在 subagent 仍在运行时退出，未交付任何产物 | 目前 52 个中 0 个；完成实例的中位耗时 3255s，单 agent 基线约 1950s |

最后一行是 `--profile headless` 下的实际差别：headless 在 root agent 回合结束时结束运行。派发了后台 subagent 然后让出的 root 已经结束了回合，于是运行退出，子 agent 的工作丢失；而 Lead 会在 `wait_agent` 中阻塞。两种方式都没有类型化产物、由 harness 判定的"完成"、或对丢失工作的记录状态；这些记录在 [zhengxuyu/mllm-benchs](https://github.com/zhengxuyu/mllm-benchs/blob/main/DEFECTS.md)。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
