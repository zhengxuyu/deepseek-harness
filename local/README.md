# `local/` — fork-only tooling

English | [中文](README.zh.md)

Nothing in this directory is part of DeepSeek Harness. It is workflow tooling for this fork, kept in the repository so it is versioned alongside the harness revision it was written against. Upstream does not accept external pull requests, so none of it is proposed there, and it should stay out of any change intended to be portable back.

## `dsh-run/`

A launcher that boots `dsh` in one of a few named modes, differing only in which patch overlays reach the composed config tree.

```sh
local/dsh-run/dsh-run.sh normal [app args...]     # web UI, stock config
local/dsh-run/dsh-run.sh trace  [app args...]     # web UI, collection-mode session logs
local/dsh-run/dsh-run.sh batch "<job>"            # headless one-shot, collection-mode logs
local/dsh-run/dsh-run.sh dump   [normal|trace]    # print the composed tree, boot nothing
```

`DSH_BIN` selects how `dsh` is invoked (default `dsh`; accepts a multi-word launcher such as `npx @deepseek-ai/dsh`). `DSH_TRACE_ROOT` selects where the collecting modes write (default `~/data/dsh-traces`).

### Why an overlay instead of a config edit

Collection settings arrive through `--patch`, which composes after the bundle layers, the profile's `cordis.patch.yml`, and the home-level `$DSH_HOME/cordis.patch.yml` ([layer order](../apps/cli/reference/README.md)). The overlay therefore applies per launch: a stock run and a collecting run can alternate without either editing a shared file or leaving state behind for the next launch.

`trace.patch.yml` changes three fields on `session-persistence-jsonl`:

| Field | Stock | Collecting | Why |
|---|---|---|---|
| `root` | `$DSH_HOME/sessions` | `$DSH_TRACE_ROOT` | A root holds one encoding; startup discovery rejects a mismatched suffix rather than ignoring it, so raw logs need their own directory. |
| `compression` | `zstd` | `none` | The default artifact is concatenated Zstandard frames, which a line-oriented reader cannot consume directly. |
| `packChunks` | `true` | `false` | The default collapses runs of three or more consecutive same-block `assistant/chunk` deltas into packed `text-chunks` / `reasoning-chunks` / `tool-call-chunks` rows, which a naive one-JSON-object-per-line reader mis-parses. |

An id-targeted patch replaces the row's whole `config` rather than deep-merging, so the overlay restates `root` — the key is required and the package ships no default.

### Guards

The script refuses a `DSH_TRACE_ROOT` under the default session root (the encoding conflict above), refuses `batch` without a job string, and forwards no app arguments to `dump`, which `--dump-config` rejects. Run `dump trace` before a collecting session: the dump annotates each row with the file that supplied it, so the overlay winning on `session-persistence-jsonl` is visible without booting.

## `dsh-container/`

A container image with `dsh` and its dependencies, and the scripts that run one headless task in it. The same four files are in mllm-benchs at `PaperBench/project/paperbench/paperbench/solvers/dsh/`, where PaperBench's solver uploads `run_dsh.sh` and `harness_automation.py` into each paper's container; keep the two copies identical.

| File | Role |
|---|---|
| `Dockerfile` | Installs Node (when the base lacks ^22.19 or >=24), pnpm, and `dsh` at a pinned commit on `BASE_IMAGE`, default `openclaw-task:latest`. Clears the base's entrypoint and applies the launcher's patches. |
| `harness_automation.py` | In the container: `run` (patch, write the dsh home, run `dsh --profile headless` under the time limit, write `/home/logs/dsh-run.json`), `check` (validate the image and settings, run nothing), `patch`. |
| `run_dsh.sh` | In the container: loads `DSH_ENV_FILE` (default `/home/agent/dsh.env`) or the environment, then starts `harness_automation.py`. |
| `launch.sh` | On the host: starts a container from the image with a memory cap and the key passed by name, runs one task, and writes `logs/`, `submission/` and `launch.json` to an output directory. |

```sh
docker build --platform=linux/amd64 -t openclaw-task-dsh:latest --build-arg DSH_GIT_REF=<sha> local/dsh-container/
export OPENROUTER_API_KEY=...
local/dsh-container/launch.sh out/run1 --task task.txt --time-limit 2      # --check, --detach, --mem-limit, --model: see its header
```

The task runs in PaperBench's layout: the task text at `/home/agent/full_instructions.txt`, an optional paper at `/home/paper`, the work in the git repository `/home/submission`, the records in `/home/logs`. `harness_automation.py`'s `PATCHES` lists each textual change made to the dsh build for benchmarking, with the defect it answers; every run records their state in `logs/dsh-patches.txt`.
