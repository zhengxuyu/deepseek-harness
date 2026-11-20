#!/bin/bash
# Prepare the OpenROAD flow image for the chip design cases: add iverilog and
# Node, and write /tmp/orfs-env.sh, which puts the flow's tools on PATH and
# names the flow's home. Source that file before running the cases.
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
