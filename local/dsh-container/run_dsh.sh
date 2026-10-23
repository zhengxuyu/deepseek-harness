#!/bin/bash
# Run dsh headless on one task in PaperBench's layout. mllm-benchs' DshSolver uploads this
# and harness_automation.py to /home/agent and starts it detached; the solver polls for
# /home/logs/dsh-run.json. The image also carries both in /opt/dsh-launch, for
# running a task without the solver. What a run does is harness_automation.py's
# docstring.
#
#   bash run_dsh.sh           the run
#   bash run_dsh.sh check     validate the image and settings, run nothing
#
# The route, model, delegation, time limit and the key come from DSH_ENV_FILE
# (default /home/agent/dsh.env, a root-only file outside the directories the
# benchmark tars into the run), or from the environment when that file is absent.
set -u

DSH_ENV_FILE="${DSH_ENV_FILE:-/home/agent/dsh.env}"
if [ -f "$DSH_ENV_FILE" ]; then
  set -a; source "$DSH_ENV_FILE"; set +a
fi

exec python3 "$(dirname "$(readlink -f "$0")")/harness_automation.py" "${1:-run}"
