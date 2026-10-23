#!/usr/bin/env bash
#
# Run dsh on one task in a container built from this directory's Dockerfile.
#
# The host side of harness_automation.py: it starts a container from the
# image, hands it the task and the settings, and runs
# /opt/dsh-launch/run_dsh.sh in it. The run's records and the agent's git
# repository come back into the output directory. PaperBench does not use this;
# it starts the same scripts through mllm-benchs' DshSolver (PaperBench/run-dsh-bench.sh).
#
#   ./launch.sh <out-dir> --task FILE [options]
#
# Build the image first (BASE_IMAGE defaults to openclaw-task:latest):
#   docker build --platform=linux/amd64 -t openclaw-task-dsh:latest \
#     --build-arg DSH_GIT_REF=<sha> <this directory>
#
# Options (all but --task have defaults):
#   --task FILE         the task text, given to the agent as /home/agent/full_instructions.txt   (required)
#   --paper DIR         mounted read-only at /home/paper (PaperBench's layout; the job names it)
#   --image I           image to run                            (default openclaw-task-dsh:latest)
#   --model ID          model id for dsh                        (default deepseek/deepseek-v4.1-flash)
#   --effort L          reasoning effort                        (default high)
#   --delegation D      agent-team, team-mode or none           (default agent-team)
#   --time-limit H      hours the agent gets                    (default 1)
#   --provider P        dsh provider route                      (default openrouter)
#   --api-key-env V     host variable holding that route's key (default OPENROUTER_API_KEY)
#   --model-spec F      JSON file declaring the model           (default: the spec below)
#   --route-spec F      JSON file of route-level fields         (default: OpenRouter's, below, when --provider openrouter)
#   --settlement F      JSON file for agent-team-settlement; needs a dsh build that ships it
#   --mem-limit M       memory cap for the container, swap included, docker notation   (default 14g)
#   --gpus              give the container the host's GPUs
#   --name N            container name                          (default dsh-<out-dir name>)
#   --detach            start and return; follow with `docker logs -f <name>`, remove with `docker rm <name>`
#   --check             validate the image and settings, run nothing
#
# The key is passed by name (`-e VAR`), so it never appears on a command line,
# in a file or in the output directory. HTTP_PROXY, HTTPS_PROXY and NO_PROXY
# are passed through when set, with NODE_USE_ENV_PROXY=1 so Node's fetch uses them.
#
# Output, for <out-dir>:
#   logs/         dsh-run.json (status, exit code, elapsed, commits), dsh-stdout.log, dsh-stderr.log,
#                 dsh-sessions/ (lead and teammates), cordis.patch.yml, job.txt, dsh-revision,
#                 dsh-patches.txt, full_instructions.txt
#   submission/   the git repository the agent worked in
#   launch.json   what this script ran: image and its id, settings (no key), container name
set -euo pipefail
die() { echo "launch.sh: $*" >&2; exit 2; }

# The model declaration MLE-Bench, ASI-Bench and the PaperBench solver make for
# the DeepSeek flash family (mllm-benchs solvers/dsh/solver.py, DEFAULT_MODEL_SPEC).
DEFAULT_MODEL_SPEC='{"contextWindow": 1048576, "maxTokens": 65536, "input": ["text"], "reasoningEfforts": {"high": "high", "xhigh": "xhigh"}, "compat": {"supportsDeveloperRole": false, "thinkingFormat": "openrouter", "requiresReasoningContentOnAssistantMessages": true}}'
# pi-ai's catalog does not describe newer OpenRouter models, so the route says
# which wire protocol its endpoint speaks.
OPENROUTER_ROUTE_SPEC='{"api": "openai-completions", "baseURL": "https://openrouter.ai/api/v1"}'

[[ $# -ge 1 && "$1" != -* ]] || die "usage: launch.sh <out-dir> --task FILE [options]; see the header"
OUT="$1"; shift
TASK=""; PAPER=""; IMAGE=openclaw-task-dsh:latest; MODEL=deepseek/deepseek-v4.1-flash; EFFORT=high
DELEGATION=agent-team; HOURS=1; PROVIDER=openrouter; API_KEY_ENV=OPENROUTER_API_KEY
MODEL_SPEC_FILE=""; ROUTE_SPEC_FILE=""; SETTLEMENT_FILE=""; MEM_LIMIT=14g; GPUS=0; NAME=""; DETACH=0; CHECK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)        TASK="$2"; shift 2 ;;
    --paper)       PAPER="$2"; shift 2 ;;
    --image)       IMAGE="$2"; shift 2 ;;
    --model)       MODEL="$2"; shift 2 ;;
    --effort)      EFFORT="$2"; shift 2 ;;
    --delegation)  DELEGATION="$2"; shift 2 ;;
    --time-limit)  HOURS="$2"; shift 2 ;;
    --provider)    PROVIDER="$2"; shift 2 ;;
    --api-key-env) API_KEY_ENV="$2"; shift 2 ;;
    --model-spec)  MODEL_SPEC_FILE="$2"; shift 2 ;;
    --route-spec)  ROUTE_SPEC_FILE="$2"; shift 2 ;;
    --settlement)  SETTLEMENT_FILE="$2"; shift 2 ;;
    --mem-limit)   MEM_LIMIT="$2"; shift 2 ;;
    --gpus)        GPUS=1; shift ;;
    --name)        NAME="$2"; shift 2 ;;
    --detach)      DETACH=1; shift ;;
    --check)       CHECK=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

# ── Check the inputs ─────────────────────────────────────────────────────────
case "$DELEGATION" in agent-team|team-mode|none) ;; *) die "--delegation must be agent-team, team-mode or none" ;; esac
[[ "$MEM_LIMIT" =~ ^[0-9]+[kmg]$ ]] || die "--mem-limit must be like 14g"
[[ -n "${!API_KEY_ENV:-}" ]] || die "$API_KEY_ENV is not set (dsh's key)"
[[ "$CHECK" == 1 || -f "$TASK" ]] || die "--task FILE is required and must exist"
[[ -z "$PAPER" || -d "$PAPER" ]] || die "--paper $PAPER is not a directory"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "no image $IMAGE; build it (see the header)"
json_file() { python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))" "$1" || die "$1 is not readable JSON"; }
MODEL_SPEC="$DEFAULT_MODEL_SPEC"; [[ -n "$MODEL_SPEC_FILE" ]] && MODEL_SPEC="$(json_file "$MODEL_SPEC_FILE")"
ROUTE_SPEC=""; [[ "$PROVIDER" == openrouter ]] && ROUTE_SPEC="$OPENROUTER_ROUTE_SPEC"
[[ -n "$ROUTE_SPEC_FILE" ]] && ROUTE_SPEC="$(json_file "$ROUTE_SPEC_FILE")"
SETTLEMENT=""; [[ -n "$SETTLEMENT_FILE" ]] && SETTLEMENT="$(json_file "$SETTLEMENT_FILE")"
TIME_LIMIT=$(python3 -c "print(int(float('$HOURS') * 3600))")

mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
NAME="${NAME:-dsh-$(basename "$OUT" | tr -c 'A-Za-z0-9_.\n-' '-')}"
docker ps -a --format '{{.Names}}' | grep -qx "$NAME" && die "a container named $NAME exists; pass --name or remove it"

# ── The container ────────────────────────────────────────────────────────────
ARGS=(--name "$NAME" --memory "$MEM_LIMIT" --memory-swap "$MEM_LIMIT"
  -e TIME_LIMIT_SECS="$TIME_LIMIT" -e DSH_MODEL="$MODEL" -e DSH_PROVIDER="$PROVIDER" -e DSH_EFFORT="$EFFORT"
  -e DSH_DELEGATION="$DELEGATION" -e DSH_API_KEY_ENV="$API_KEY_ENV" -e DSH_MODEL_SPEC="$MODEL_SPEC"
  -e DSH_ROUTE_SPEC="$ROUTE_SPEC" -e DSH_SETTLEMENT="$SETTLEMENT" -e "$API_KEY_ENV")
for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
  if [[ -n "${!v:-}" ]]; then ARGS+=(-e "$v"); fi
done
[[ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]] && ARGS+=(-e NODE_USE_ENV_PROXY=1)
[[ "$GPUS" == 1 ]] && ARGS+=(--gpus all)

if [[ "$CHECK" == 1 ]]; then
  exec docker run --rm "${ARGS[@]}" "$IMAGE" bash /opt/dsh-launch/run_dsh.sh check
fi

[[ -z "$(find "$OUT/logs" "$OUT/submission" -mindepth 1 -print -quit 2>/dev/null)" ]] || die "$OUT already holds a run; use a new directory"
mkdir -p "$OUT/logs" "$OUT/submission"
ARGS+=(-v "$(cd "$(dirname "$TASK")" && pwd)/$(basename "$TASK"):/home/agent/full_instructions.txt:ro"
  -v "$OUT/logs:/home/logs" -v "$OUT/submission:/home/submission")
[[ -n "$PAPER" ]] && ARGS+=(-v "$(cd "$PAPER" && pwd):/home/paper:ro")

# The submission mount hides the image's empty repository, so one is made in
# the mount. Afterwards the output is handed to the caller's user (the
# container runs as root).
INNER="git -C /home/submission rev-parse --git-dir >/dev/null 2>&1 || git init -q /home/submission
bash /opt/dsh-launch/run_dsh.sh; code=\$?
chown -R $(id -u):$(id -g) /home/logs /home/submission
exit \$code"

python3 - "$OUT/launch.json" <<EOF
import json, subprocess, sys, time
image_id = subprocess.run(["docker", "image", "inspect", "-f", "{{.Id}}", "$IMAGE"], capture_output=True, text=True).stdout.strip()
revision = subprocess.run(["docker", "run", "--rm", "--entrypoint", "cat", "$IMAGE", "/opt/dsh-revision"], capture_output=True, text=True).stdout.split()
json.dump({
    "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "container": "$NAME", "image": "$IMAGE", "image_id": image_id,
    "dsh_revision": revision[0] if revision else None, "task": "$TASK", "paper": "$PAPER" or None,
    "model": "$MODEL", "effort": "$EFFORT", "delegation": "$DELEGATION", "time_limit_seconds": $TIME_LIMIT,
    "provider": "$PROVIDER", "api_key_env": "$API_KEY_ENV", "mem_limit": "$MEM_LIMIT", "gpus": bool($GPUS),
    "model_spec": json.loads('''$MODEL_SPEC'''), "route_spec": json.loads('''${ROUTE_SPEC:-null}'''),
    "settlement": json.loads('''${SETTLEMENT:-null}'''),
}, open(sys.argv[1], "w"), indent=2)
EOF

printf 'run          : %s   container: %s\n' "$OUT" "$NAME"
printf 'image        : %s\n' "$IMAGE"
printf 'agent        : %s (%s), delegation %s, %sh, memory %s%s\n' "$MODEL" "$EFFORT" "$DELEGATION" "$HOURS" "$MEM_LIMIT" "$([[ $GPUS == 1 ]] && echo ', gpus')"
if [[ "$DETACH" == 1 ]]; then
  docker run -d "${ARGS[@]}" "$IMAGE" bash -c "$INNER" >/dev/null
  printf 'started      : docker logs -f %s ; result in %s/logs/dsh-run.json ; then docker rm %s\n' "$NAME" "$OUT" "$NAME"
  printf 'stop         : docker exec %s pkill -INT -f "dsh --profile" (dsh flushes its session)\n' "$NAME"
else
  docker run --rm "${ARGS[@]}" "$IMAGE" bash -c "$INNER"
fi
