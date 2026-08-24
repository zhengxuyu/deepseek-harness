#!/usr/bin/env bash
#
# Launch DeepSeek Harness in one of a few named modes.
#
# The only thing that varies between modes is which patch overlays go on the
# composed config tree and which profile boots. Nothing here mutates
# ~/.dsh/cordis.patch.yml, so a trace run and a normal run can coexist and
# neither leaves state behind for the next launch.
#
#   ./dsh-run.sh normal [app args...]     web UI, stock config
#   ./dsh-run.sh trace  [app args...]     web UI, collection-mode session logs
#   ./dsh-run.sh batch "<job>"            headless one-shot, collection-mode logs
#   ./dsh-run.sh dump   [normal|trace]    print the composed tree, boot nothing
#
# Environment:
#   DSH_BIN         how to invoke dsh          (default: dsh)
#   DSH_TRACE_ROOT  where trace mode writes    (default: ~/data/dsh-traces)
#   DSH_HOME        harness home               (dsh's own default: ~/.dsh)

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TRACE_PATCH="$HERE/trace.patch.yml"

DSH_BIN="${DSH_BIN:-dsh}"
DSH_TRACE_ROOT="${DSH_TRACE_ROOT:-$HOME/data/dsh-traces}"
DSH_SESSIONS_DEFAULT="${DSH_HOME:-$HOME/.dsh}/sessions"

die() { printf 'dsh-run: %s\n' "$1" >&2; exit 1; }

usage() {
  awk 'NR>2 && /^#/ { sub(/^# ?/, ""); print; next } NR>2 { exit }' "${BASH_SOURCE[0]}"
  exit "${1:-0}"
}

# `dsh` is not always on PATH (it ships as a package bin, not a global). Accept
# a multi-word launcher too, e.g. DSH_BIN="pnpm --filter @deepseek-ai/dsh exec dsh".
read -r -a DSH_CMD <<< "$DSH_BIN"
check_bin() {
  command -v "${DSH_CMD[0]}" >/dev/null 2>&1 \
    || die "cannot find '${DSH_CMD[0]}' on PATH. Set DSH_BIN, e.g. DSH_BIN='npx @deepseek-ai/dsh'"
}

# One root holds one encoding. Trace mode writes raw .jsonl; the default root
# holds .jsonl.zstd, and startup discovery rejects the mismatched suffix rather
# than ignoring it — so refuse the overlap here with a clearer message.
prepare_trace_root() {
  [[ -f "$TRACE_PATCH" ]] || die "missing overlay: $TRACE_PATCH"
  local resolved
  resolved="$(cd -- "$(dirname -- "$DSH_TRACE_ROOT")" 2>/dev/null && pwd)/$(basename -- "$DSH_TRACE_ROOT")" \
    || die "DSH_TRACE_ROOT parent does not exist: $DSH_TRACE_ROOT"
  [[ "$resolved" != "$DSH_SESSIONS_DEFAULT"* ]] \
    || die "DSH_TRACE_ROOT must not live under the default session root ($DSH_SESSIONS_DEFAULT): one root holds one encoding"
  mkdir -p "$resolved"
  DSH_TRACE_ROOT="$resolved"
  export DSH_TRACE_ROOT
  printf 'dsh-run: traces -> %s  (raw .jsonl, one event per line)\n' "$DSH_TRACE_ROOT" >&2
}

mode="${1:-}"; shift || true
case "$mode" in
  normal)
    check_bin
    printf 'dsh-run: traces -> %s  (.jsonl.zstd, packed chunks)\n' "$DSH_SESSIONS_DEFAULT" >&2
    exec "${DSH_CMD[@]}" --profile web "$@"
    ;;
  trace)
    check_bin; prepare_trace_root
    exec "${DSH_CMD[@]}" --profile web --patch "$TRACE_PATCH" "$@"
    ;;
  batch)
    [[ $# -ge 1 && -n "$1" ]] || die 'batch needs a job string: ./dsh-run.sh batch "run the tests"'
    check_bin; prepare_trace_root
    exec "${DSH_CMD[@]}" --profile headless --patch "$TRACE_PATCH" "$@"
    ;;
  dump)
    # --dump-config takes no app arguments, so this deliberately forwards none.
    check_bin
    case "${1:-normal}" in
      normal) exec "${DSH_CMD[@]}" --profile web --dump-config ;;
      trace)  prepare_trace_root
              exec "${DSH_CMD[@]}" --profile web --patch "$TRACE_PATCH" --dump-config ;;
      *) die "dump takes 'normal' or 'trace', got '$1'" ;;
    esac
    ;;
  ''|-h|--help|help) usage 0 ;;
  *) printf 'dsh-run: unknown mode %s\n\n' "$mode" >&2; usage 1 ;;
esac
