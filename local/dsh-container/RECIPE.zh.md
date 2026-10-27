# dsh-container 快速上手

在 `openclaw-task` 镜像上装好 dsh，用它跑一个 headless 任务。各文件的作用见 [`local/README.zh.md`](../README.zh.md#dsh-container)，`launch.sh` 的全部参数见它开头的注释。

## 1. 准备底座镜像

底座默认是 `openclaw-task:latest`：openclaw 沙箱镜像，来自 `wypush123pop321-beep/openclaw-task` 仓库 `feat/docker-sandbox` 分支的 `docker/Dockerfile`。它的构建需要那个仓库里未入库的证书和网关文件，所以要在那个仓库里构建，不能在这里构建。

```sh
docker image inspect openclaw-task:latest >/dev/null && echo ok
```

也可以换成 PaperBench 的 `pb-env:latest` 作底座，构建时加 `--build-arg BASE_IMAGE=pb-env:latest`。两种底座最后装的是同一个 dsh 构建、同一套启动脚本和补丁。

## 2. 构建 dsh 镜像

在仓库根目录执行。dsh 必须用 commit 固定，不能用分支名：Docker 会按命令字符串缓存 clone 这一层，用分支名会悄悄复用旧的构建。

```sh
SHA=$(git rev-parse HEAD)          # 或者要测的那个 dsh commit
docker build --platform=linux/amd64 -t openclaw-task-dsh:${SHA:0:12} \
  --build-arg DSH_GIT_REF=$SHA local/dsh-container/
```

在代理后面构建时，Docker 会把 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 传进每一步 `RUN`；openclaw 底座已经信任代理的 CA。

## 3. 准备任务

```sh
mkdir -p ~/dsh-runs && cd ~/dsh-runs
cat > task.txt <<'EOF'
<任务说明：做什么、交付什么、交付到 /home/submission>
EOF
```

容器里的目录按 PaperBench 的约定：

| 路径 | 内容 |
|---|---|
| `/home/agent/full_instructions.txt` | `--task` 指定的文件，只读 |
| `/home/paper` | `--paper` 指定的目录，只读，可选 |
| `/home/submission` | agent 工作的 git 仓库，映射到输出目录的 `submission/` |
| `/home/logs` | 运行记录，映射到输出目录的 `logs/` |

## 4. 设置 key 并检查

key 只按变量名传给容器（`-e VAR`），不会出现在命令行、文件或输出目录里。

```sh
export OPENROUTER_API_KEY=...
LAUNCH=~/projects/llm-ma/deepseek-harness/local/dsh-container/launch.sh
IMG=openclaw-task-dsh:<sha12>
$LAUNCH run1 --image $IMG --check      # 只检查镜像和设置，打印补丁层和 job，不运行
```

## 5. 运行

前台运行，跑完才返回：

```sh
$LAUNCH run1 --image $IMG --task task.txt --time-limit 2
```

后台运行：

```sh
$LAUNCH run1 --image $IMG --task task.txt --time-limit 12 --detach
docker logs -f dsh-run1
```

常用参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--time-limit H` | `1` | agent 可用的小时数，可以是小数 |
| `--model ID` | `deepseek/deepseek-v4.1-flash` | 模型 id |
| `--effort L` | `high` | reasoning effort |
| `--delegation D` | `agent-team` | `agent-team`、`team-mode` 或 `none` |
| `--model-spec F` | DeepSeek flash 系列的声明 | 模型声明的 JSON 文件（上下文窗口、输出上限、reasoning 等级、兼容设置）；换成非 DeepSeek flash 系列的模型时要给 |
| `--provider P` / `--api-key-env V` | `openrouter` / `OPENROUTER_API_KEY` | 换 provider 时一起改 |
| `--mem-limit M` | `14g` | 容器内存上限，含 swap |
| `--paper DIR` | 无 | 挂到 `/home/paper` |
| `--gpus` | 关 | 把宿主机的 GPU 给容器 |
| `--name N` | `dsh-<输出目录名>` | 容器名 |

## 6. 看结果

```sh
cat run1/logs/dsh-run.json            # status、exit_code、elapsed_seconds、commits、restarts
git -C run1/submission log --oneline  # agent 的提交
ls run1/logs/dsh-sessions/            # Lead 和各成员的会话记录
cat run1/launch.json                  # 这次用的镜像、dsh commit 和设置（不含 key）
```

`dsh-run.json` 的 `status`：

| 值 | 含义 |
|---|---|
| `completed` | dsh 正常结束 |
| `timeout` | 到了时间上限 |
| `failed` | 出错退出，且错误重试也解决不了，或者重启次数用完 |

dsh 因为其他原因退出时，脚本会在时间上限内重新启动它，接着 Lead 原来的会话继续跑；`restarts` 是重启的次数。

## 7. 中途停止和清理

```sh
docker exec dsh-run1 pkill -INT -f "dsh --profile"   # dsh 会先保存会话再退出
docker rm dsh-run1                                    # 只有 --detach 的容器需要手动删
```

## 常见报错

| 报错 | 处理 |
|---|---|
| `no image ...; build it` | 先做第 2 步，或者用 `--image` 指定已有的镜像 |
| `OPENROUTER_API_KEY is not set` | 在当前 shell 里 `export` key；换了 provider 时，检查 `--api-key-env` 指的变量 |
| `a container named ... exists` | `docker rm` 掉旧容器，或者用 `--name` 换个名字 |
| `... already holds a run; use a new directory` | 每次运行用一个新的输出目录 |
