#!/bin/bash
# Run `pnpm run standard-case` inside the OpenROAD flow image, which carries
# yosys, openroad, and the open platforms that the chip design cases need.
#
#   scripts/standard-case/in-orfs.sh <out-dir> [standard-case arguments...]
#
# The checkout is copied into the container (without node_modules, which hold
# host binaries), dependencies are installed there, and results land in
# <out-dir>. The model key is passed by name and never written anywhere.
# ORFS_IMAGE selects the image; STANDARD_CASE_API_KEY_ENV the key variable.
set -euo pipefail

[[ $# -ge 1 ]] || { echo "usage: in-orfs.sh <out-dir> [standard-case arguments...]" >&2; exit 2; }
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"; shift
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${ORFS_IMAGE:-openroad/orfs:latest}"
KEY_ENV="${STANDARD_CASE_API_KEY_ENV:-OPENROUTER_API_KEY}"
[[ -n "${!KEY_ENV:-}" ]] || { echo "in-orfs.sh: $KEY_ENV is not set" >&2; exit 2; }

exec docker run --rm --platform linux/amd64 \
  -e "$KEY_ENV" -e STANDARD_CASE_API_KEY_ENV="$KEY_ENV" \
  -e STANDARD_CASE_PROVIDER -e STANDARD_CASE_ROUTE -e STANDARD_CASE_MODEL_SPEC \
  -e DSH_TELEMETRY_DISABLED=1 \
  -v "$ROOT":/src:ro -v "$OUT":/out \
  -v dsh-standard-case-pnpm:/root/.local/share/pnpm \
  "$IMAGE" bash /src/scripts/standard-case/orfs-entry.sh "$@"
