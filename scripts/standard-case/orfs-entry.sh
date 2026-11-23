#!/bin/bash
# Inside the OpenROAD flow image, after orfs-setup.sh: run the standard-case
# command from the checkout's copy at /work, with results in /out.
# Started by in-orfs.sh, which passes the arguments.
set -euo pipefail

source /tmp/orfs-env.sh
cd /work
pnpm run standard-case "$@" --out /out
