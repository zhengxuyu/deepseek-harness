#!/bin/bash
# Run `pnpm run standard-case` inside the OpenROAD flow image, which carries
# yosys, openroad, and the open platforms that the chip design cases need.
#
#   scripts/standard-case/in-orfs.sh <out-dir> [standard-case arguments...]
#
# The checkout is copied into the container without node_modules, which hold
# host binaries, and without any case's judge/ directory. Dependencies are
# installed there and the cases run. Only after the runs have ended are the
# judge/ directories copied in and the runs analyzed, so no agent can read a
# reference solution or a judge's testbench. Results land in <out-dir>, which
# must be outside the checkout.
#
# The model key is passed by name, to the run only, and never written anywhere.
# ORFS_IMAGE selects the image; the default is pinned by digest, so runs at
# different revisions use the same tools. STANDARD_CASE_API_KEY_ENV names the
# key variable.
set -euo pipefail

[[ $# -ge 1 ]] || { echo "usage: in-orfs.sh <out-dir> [standard-case arguments...]" >&2; exit 2; }
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"; shift
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ "$OUT/" != "$ROOT/"* ]] || { echo "in-orfs.sh: $OUT is inside the checkout; choose a directory outside it" >&2; exit 2; }
IMAGE="${ORFS_IMAGE:-openroad/orfs@sha256:13f2e9da79b09d2fa7222204f74159266483ea0655de2a1dd93ff6aeec3bdd1c}"
KEY_ENV="${STANDARD_CASE_API_KEY_ENV:-OPENROUTER_API_KEY}"

ANALYZE_ONLY=0
for argument in "$@"; do [[ "$argument" != --analyze ]] || ANALYZE_ONLY=1; done
[[ "$ANALYZE_ONLY" == 1 || -n "${!KEY_ENV:-}" ]] || { echo "in-orfs.sh: $KEY_ENV is not set" >&2; exit 2; }

DIRTY=0
[[ -z "$(git -C "$ROOT" status --porcelain)" ]] || DIRTY=1

CONTAINER="$(docker run -d --platform linux/amd64 \
  -e STANDARD_CASE_API_KEY_ENV="$KEY_ENV" \
  -e STANDARD_CASE_PROVIDER -e STANDARD_CASE_ROUTE -e STANDARD_CASE_MODEL_SPEC \
  -e STANDARD_CASE_REVISION="$(git -C "$ROOT" rev-parse HEAD)" -e STANDARD_CASE_DIRTY="$DIRTY" \
  -e STANDARD_CASE_ENVIRONMENT="image $IMAGE" \
  -e DSH_TELEMETRY_DISABLED=1 \
  -v "$OUT":/out \
  -v dsh-standard-case-pnpm:/root/.local/share/pnpm \
  "$IMAGE" sleep infinity)"
trap 'docker rm -f "$CONTAINER" >/dev/null' EXIT

# Copy paths of the checkout into /work of the container; the arguments are tar's.
cd "$ROOT"
into_work() {
  COPYFILE_DISABLE=1 tar -cf - "$@" | docker exec -i "$CONTAINER" tar -C /work -xf -
}

docker exec "$CONTAINER" mkdir -p /work
into_work --exclude=node_modules --exclude=.artifacts --exclude=lib --exclude=.git \
  --exclude='scripts/standard-case/cases/*/judge' .
docker exec "$CONTAINER" bash /work/scripts/standard-case/orfs-setup.sh
if [[ "$ANALYZE_ONLY" == 0 ]]; then
  docker exec -e "$KEY_ENV" "$CONTAINER" bash /work/scripts/standard-case/orfs-entry.sh --run-only "$@"
  into_work scripts/standard-case/cases/*/judge
  docker exec "$CONTAINER" bash /work/scripts/standard-case/orfs-entry.sh --analyze "$@"
else
  into_work scripts/standard-case/cases/*/judge
  docker exec "$CONTAINER" bash /work/scripts/standard-case/orfs-entry.sh "$@"
fi
