#!/bin/bash
# Prepare the OpenROAD flow image for the chip design cases, once per
# container: add iverilog and Node, install the dependencies of the checkout's
# copy at /work, and write /tmp/orfs-env.sh, which puts the flow's tools on
# PATH and names the flow's home. orfs-entry.sh sources that file.
#
# The image is pinned by in-orfs.sh; iverilog and Node come from package
# repositories at whatever version those serve, and run.json records the
# versions each run used.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
if ! command -v iverilog >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends iverilog ca-certificates curl git xz-utils
fi
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq --no-install-recommends nodejs
fi

FLOW_HOME="${FLOW_HOME:-/OpenROAD-flow-scripts/flow}"
{
  echo "export FLOW_HOME=$FLOW_HOME"
  [[ -f "$FLOW_HOME/../env.sh" ]] && echo "source $FLOW_HOME/../env.sh >/dev/null"
  echo 'command -v yosys >/dev/null && command -v openroad >/dev/null && command -v iverilog >/dev/null'
} > /tmp/orfs-env.sh

cd /work
# The copy keeps the host's file owners; git refuses a directory another user owns.
git config --global --add safe.directory /work
# The install's postinstall step sets up git hooks and needs a repository. This one is not the
# checkout's: the run's revision comes from STANDARD_CASE_REVISION.
git init -q
corepack enable
pnpm install --frozen-lockfile
