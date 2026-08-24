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
