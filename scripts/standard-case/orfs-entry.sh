#!/bin/bash
# Inside the OpenROAD flow image: install what the image lacks, then run the
# standard cases from a private copy of the checkout mounted at /src.
# Started by in-orfs.sh.
set -euo pipefail

bash /src/scripts/standard-case/orfs-setup.sh
source /tmp/orfs-env.sh

mkdir -p /work
tar -C /src --exclude=node_modules --exclude=.artifacts --exclude='lib' --exclude='.git' -cf - . | tar -C /work -xf -
cd /work
# The copy keeps the host's file owners; git refuses a directory another user owns.
git config --global --add safe.directory /work
git init -q && git add -A >/dev/null && git -c user.name=standard-case -c user.email=standard-case@localhost commit -qm snapshot
corepack enable
pnpm install --frozen-lockfile
pnpm run standard-case "$@" --out /out
