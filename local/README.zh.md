# `local/` — 仅属于本 fork 的工具

[English](README.md) | 中文

本目录中的任何内容都不属于 DeepSeek Harness。它是本 fork 的工作流工具，之所以放进仓库，是为了与它所针对的那个 harness 版本一起被版本化。上游不接受外部 pull request，因此这里的东西都不会提交上去，也不应混进任何打算移植回上游的改动。

## `dsh-run/`

一个启动器：以若干具名模式启动 `dsh`，模式之间的唯一差别是哪些 patch 覆盖层进入合成后的配置树。

```sh
local/dsh-run/dsh-run.sh normal [app args...]     # web UI, stock config
local/dsh-run/dsh-run.sh trace  [app args...]     # web UI, collection-mode session logs
local/dsh-run/dsh-run.sh batch "<job>"            # headless one-shot, collection-mode logs
local/dsh-run/dsh-run.sh dump   [normal|trace]    # print the composed tree, boot nothing
```

`DSH_BIN` 决定如何调用 `dsh`（默认 `dsh`；也接受多词启动方式，例如 `npx @deepseek-ai/dsh`）。`DSH_TRACE_ROOT` 决定采集模式写到哪里（默认 `~/data/dsh-traces`）。

### 为什么用覆盖层而不是改配置文件

采集设置通过 `--patch` 传入，它在 bundle 层、profile 的 `cordis.patch.yml` 和 home 级 `$DSH_HOME/cordis.patch.yml` 之后合成（[层级顺序](../apps/cli/reference/README.zh.md)）。因此覆盖层是逐次启动生效的：原样运行与采集运行可以交替进行，两者都不改动共享文件，也不给下一次启动留下状态。

`trace.patch.yml` 修改 `session-persistence-jsonl` 上的三个字段：

| 字段 | 原样 | 采集 | 原因 |
|---|---|---|---|
| `root` | `$DSH_HOME/sessions` | `$DSH_TRACE_ROOT` | 一个 root 只持有一种编码；启动发现阶段会拒绝后缀不匹配的产物，而不是忽略它，因此原始日志需要独立目录。 |
| `compression` | `zstd` | `none` | 默认产物是拼接的 Zstandard 帧，面向行的读取器无法直接消费。 |
| `packChunks` | `true` | `false` | 默认会把三条及以上连续同块 `assistant/chunk` 增量折叠成打包行 `text-chunks` / `reasoning-chunks` / `tool-call-chunks`，朴素的"一行一个 JSON 对象"读取器会解析错误。 |

id 定向 patch 会整体替换该行的 `config` 而非深度合并，因此覆盖层重述了 `root`——该键是必填的，且本包不提供默认值。

### 护栏

脚本会拒绝位于默认会话根目录之下的 `DSH_TRACE_ROOT`（即上述编码冲突），拒绝不带任务字符串的 `batch`，并且不向 `dump` 转发任何 app 参数——`--dump-config` 本身就拒绝这类调用。在采集会话之前先运行 `dump trace`：dump 会为每一行标注提供它的文件，因此无需启动即可看到覆盖层在 `session-persistence-jsonl` 上生效。

## `dsh-container/`

一个装好 `dsh` 及其依赖的容器镜像，以及在其中运行一个 headless 任务的脚本。这四个文件在 mllm-benchs 的 `PaperBench/project/paperbench/paperbench/solvers/dsh/` 下也有一份，PaperBench 的 solver 会把 `run_dsh.sh` 和 `harness_automation.py` 上传进每篇论文的容器；两份须保持一致。

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 在 `BASE_IMAGE`（默认 `openclaw-task:latest`）上安装 Node（底座没有 ^22.19 或 >=24 时）、pnpm 和固定 commit 的 `dsh`。清空底座的 entrypoint，并应用启动器的补丁。 |
| `harness_automation.py` | 容器内：`run`（打补丁、写 dsh home、在时间上限内运行 `dsh --profile headless`、写 `/home/logs/dsh-run.json`）、`check`（检查镜像和设置，不运行）、`patch`。 |
| `run_dsh.sh` | 容器内：加载 `DSH_ENV_FILE`（默认 `/home/agent/dsh.env`）或环境变量，然后启动 `harness_automation.py`。 |
| `launch.sh` | 宿主机：用该镜像启动容器（带内存上限，key 只按变量名传入），运行一个任务，把 `logs/`、`submission/` 和 `launch.json` 写到输出目录。 |

```sh
docker build --platform=linux/amd64 -t openclaw-task-dsh:latest --build-arg DSH_GIT_REF=<sha> local/dsh-container/
export OPENROUTER_API_KEY=...
local/dsh-container/launch.sh out/run1 --task task.txt --time-limit 2      # --check, --detach, --mem-limit, --model: see its header
```

任务按 PaperBench 的目录约定运行：任务说明在 `/home/agent/full_instructions.txt`，可选的论文在 `/home/paper`，工作在 git 仓库 `/home/submission` 中进行，记录写到 `/home/logs`。`harness_automation.py` 的 `PATCHES` 列出为 benchmark 对 dsh 构建所做的每一处文本改动及其对应的缺陷；每次运行都会把它们的状态记录到 `logs/dsh-patches.txt`。
