# DeepSeek Harness (dsh) and everything it needs to run, on top of a base image.
#
# The base is a build argument:
# - `openclaw-task:latest` (the default) is the openclaw sandbox image from
#   wypush123pop321-beep/openclaw-task, branch feat/docker-sandbox,
#   docker/Dockerfile: python:3.12-slim with Node 22, the openclaw CLI and the
#   corporate CA. Its build needs that repository's untracked certificate and
#   gateway files, so it is built there, not here.
# - `pb-env:latest` is PaperBench's agent image (ubuntu 24.04, docker CLI,
#   conda `agent` env, /home/{paper,submission,logs,agent}). mllm-benchs'
#   PaperBench/run-dsh-bench.sh builds pb-env-dsh from it.
# Each step below skips what the base already has, so both bases end with the
# same dsh build, launcher and patches.
#
# dsh is built with the same recipe as mllm-benchs' MLE-Bench/agents/dsh/Dockerfile
# and ASI-Bench task image, so all benchmarks run one binary. Pin by commit,
# never by branch: Docker caches the clone layer on the command string, so a
# branch name would silently reuse a stale build.
#
#   docker build --platform=linux/amd64 -t openclaw-task-dsh:<sha12> \
#     --build-arg DSH_GIT_REF=<sha> <this directory>
#   docker build --platform=linux/amd64 -t pb-env-dsh:<sha12> --build-arg BASE_IMAGE=pb-env:latest \
#     --build-arg DSH_GIT_REF=<sha> <this directory>
#
# Behind a proxy, Docker passes HTTP_PROXY / HTTPS_PROXY / NO_PROXY build args
# into every RUN; the openclaw base already trusts the proxy's CA.
ARG BASE_IMAGE=openclaw-task:latest
FROM ${BASE_IMAGE}

# The base's entrypoint (openclaw-task's starts an openclaw gateway and runs a
# task from /app) is not this image's job: containers start a shell and the
# caller runs dsh in them.
ENTRYPOINT []
CMD ["/bin/bash"]
USER root

# ── System packages ────────────────────────────────────────────────────────
# git, curl and xz fetch and unpack Node and dsh; build-essential and python3
# build the native modules pnpm compiles; zstd reads dsh's session traces;
# procps gives pkill, which the PaperBench solver uses to stop dsh.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils git zstd procps build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# ── Node ───────────────────────────────────────────────────────────────────
# dsh requires node ^22.19 || >=24. Kept when the base has a version that fits
# (openclaw-task has 22.22.1); otherwise the official tarball.
ARG NODE_VERSION=22.19.0
RUN if node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a >= 24 || (a === 22 && b >= 19) ? 0 : 1)' 2>/dev/null; then \
        echo "node $(node -v) from the base"; \
    else \
        curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
          | tar -xJ -C /usr/local --strip-components=1; \
    fi \
    && node -v && corepack enable && corepack prepare pnpm@11.7.0 --activate

# ── dsh ────────────────────────────────────────────────────────────────────
ARG DSH_GIT_URL=https://github.com/zhengxuyu/deepseek-harness.git
ARG DSH_GIT_REF
RUN test -n "${DSH_GIT_REF}" || (echo "DSH_GIT_REF build-arg is required" && exit 1) \
    && git clone --filter=blob:none ${DSH_GIT_URL} /opt/dsh \
    && cd /opt/dsh && git checkout ${DSH_GIT_REF} \
    && pnpm install --frozen-lockfile && pnpm run build \
    && ln -sf /opt/dsh/apps/cli/lib/bin.js /usr/local/bin/dsh \
    && chmod +x /opt/dsh/apps/cli/lib/bin.js \
    && git -C /opt/dsh rev-parse HEAD > /opt/dsh-revision \
    && echo ${DSH_GIT_URL} >> /opt/dsh-revision \
    && pnpm store prune \
    && mkdir -p /opt/dsh-home \
    && DSH_HOME=/opt/dsh-home /usr/local/bin/dsh --profile headless --dump-config > /dev/null \
    && mkdir -p /opt/dsh-home/profiles/node_modules/@deepseek-ai \
    && ln -sfn /opt/dsh/packages/experimental/agent-team \
         /opt/dsh-home/profiles/node_modules/@deepseek-ai/dsh-experimental-agent-team \
    && ln -sfn /opt/dsh/packages/experimental/tool-agent-team \
         /opt/dsh-home/profiles/node_modules/@deepseek-ai/dsh-experimental-tool-agent-team \
    && chmod -R 0777 /opt/dsh-home

# ── The run layout ─────────────────────────────────────────────────────────
# harness_automation.py works in PaperBench's layout: the task under /home/agent and
# /home/paper, the work in the git repository /home/submission, the records in
# /home/logs. pb-env has it; on another base it is made here.
RUN mkdir -p /home/agent /home/logs /home/paper /home/submission \
    && (git -C /home/submission rev-parse --git-dir >/dev/null 2>&1 || git init -q /home/submission) \
    && (git config --global user.email >/dev/null || git config --global user.email "agent@example.com") \
    && (git config --global user.name >/dev/null || git config --global user.name "agent")

# ── Launcher and benchmark-side patches ────────────────────────────────────
# harness_automation.py starts dsh in the layout above (`run`), validates an image and
# its settings without running (`check`), and applies PATCHES, the textual
# changes made to the dsh build for benchmarking, each naming the mllm-benchs
# DEFECTS.md entry it answers (`patch`). They are applied here and again at every start,
# so an image built before a patch existed still runs patched; their state is
# in /opt/dsh-patches and in each run's /home/logs/dsh-patches.txt. Last, so
# the dsh build layer above stays cached.
COPY harness_automation.py run_dsh.sh /opt/dsh-launch/
RUN python3 /opt/dsh-launch/harness_automation.py patch | tee /opt/dsh-patches
WORKDIR /home
