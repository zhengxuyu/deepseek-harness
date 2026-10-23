"""Start dsh headless on one PaperBench paper, inside the agent container.

DshSolver (mllm-benchs, PaperBench/project/paperbench/paperbench/solvers/dsh/
solver.py) uploads this file and run_dsh.sh to /home/agent, writes the run's
settings to /home/agent/dsh.env, and starts run_dsh.sh detached. run_dsh.sh
loads dsh.env and hands over to `harness_automation.py run`, which:

1. applies the benchmark-side patches to the dsh build (`PATCHES`; the image
   has them baked in when it was built from this directory's Dockerfile, so
   this is a check that changes nothing);
2. points dsh at a home whose sessions land under /home/logs, where the
   solver's snapshots pick them up and agent.log is built from them;
3. writes that home's cordis.patch.yml: the model and its route, and Agent
   Teams when the delegation asks for it;
4. runs `dsh --profile headless` with one message that says where the task is,
   under `timeout --signal=INT` at the time limit;
5. writes /home/logs/dsh-run.json, which is what the solver polls for.

Every file the run used is copied to /home/logs: full_instructions.txt,
job.txt, cordis.patch.yml, dsh-revision and dsh-patches.txt.

`harness_automation.py check` validates the same settings and the image without running
anything and prints the patch layer and the job; `harness_automation.py patch` applies
`PATCHES` only (the Dockerfile's last step).

The patch layer is the one ASI-Bench's adapter composes
(mllm-benchs ASI-Bench/ai4sci_bench/adapters/dsh_cli.py, `model_rows` and `patch_layer`),
so a model declared for one benchmark behaves identically in the other:

- `agent-default-model` and `llm-pi-ai` select the run's model and declare its
  provider route. Both rows exist in dsh-base, so the patch changes their
  config. The model is declared whole (context window, output cap, reasoning
  levels, wire compatibility) because pi-ai's bundled catalog is a stale
  snapshot. A harness-home settings.yaml is not written: newer dsh imports that
  pre-release format only after the headless runner has taken the composition
  default, which is how the first run here ended on the `deepseek-official`
  route asking for DEEPSEEK_API_KEY.
- `agent-team` mounts dsh's experimental Agent Teams, withholds the plain
  subagent tools so the model has one delegation surface, and retains
  teammates' completed outputs beside the session traces. With
  `DSH_SETTLEMENT` (JSON: deadlineMs, stallMs, optional leadTurnHolds) it also
  mounts `agent-team-settlement`, which keeps the headless run alive while
  tasks or teammates are unfinished and can hold the Lead's final answer.

One deliberate difference from ASI-Bench and MLE-Bench: the network tool stays
on. PaperBench's instructions allow browsing (only `blacklist.txt` is off
limits, enforced by the benchmark's monitor over agent.log), and the reference
agent runs with web search.

`apiKeyEnv` is a reference, never the secret; the key reaches dsh through the
environment dsh.env sets. `DSH_ROUTE_SPEC` (JSON) adds route-level fields for
a provider pi-ai's catalog does not ship — `api`, `baseURL`, `headers`,
`streamIdleTimeoutMs` — and lands in the patch file as written.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

AGENT_DIR = Path("/home/agent")
LOGS_DIR = Path("/home/logs")
SUBMISSION_DIR = Path("/home/submission")
INSTRUCTIONS = AGENT_DIR / "full_instructions.txt"
RUN_JSON = LOGS_DIR / "dsh-run.json"
# The image initialized this home at build time (Dockerfile).
DSH_HOME = Path("/opt/dsh-home")
DSH_REVISION = Path("/opt/dsh-revision")
DSH_ROOT = Path("/opt/dsh")

DELEGATIONS = ("none", "team-mode", "agent-team")
# SIGINT lets dsh flush its session; this long after it, dsh is killed. The
# solver also enforces the limit from outside, with a margin, in case the
# launcher itself is stuck.
KILL_AFTER_SECS = 120


@dataclass(frozen=True)
class Patch:
    """One textual change to the dsh build, made for the benchmark and recorded with every run."""

    id: str
    path: str  # relative to DSH_ROOT
    old: str
    new: str
    why: str


PATCHES = (
    # The container has no IPv6 route. web_fetch's pinned agent passes
    # autoSelectFamily: true (which overrides --no-network-family-autoselection),
    # so an IPv4 connect slower than 250 ms falls through to IPv6, fails with
    # ENETUNREACH, and the unhandled socket error kills dsh: Lead and teammates.
    Patch(
        id="web-fetch-no-autoselect-family",
        path="packages/web/web-fetch-http/lib/index.js",
        old="autoSelectFamily: true,",
        new="autoSelectFamily: false,",
        why="mllm-benchs DEFECTS.md D14: an unreachable IPv6 fallback kills dsh",
    ),
)


@dataclass(frozen=True)
class Config:
    time_limit: int
    model: str
    provider: str
    effort: str
    api_key_env: str
    delegation: str
    model_spec: dict | None
    route_spec: dict | None
    settlement: dict | None


def _json_env(name: str) -> dict | None:
    raw = os.environ.get(name, "")
    if not raw.strip():
        return None
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value


def load_config() -> Config:
    """The run's settings, from the environment dsh.env sets. Raises ValueError on a bad one."""
    missing = [k for k in ("TIME_LIMIT_SECS", "DSH_MODEL", "DSH_DELEGATION") if not os.environ.get(k)]
    if missing:
        raise ValueError(f"not set: {', '.join(missing)}")
    delegation = os.environ["DSH_DELEGATION"]
    if delegation not in DELEGATIONS:
        raise ValueError(f"unknown DSH_DELEGATION {delegation!r}")
    try:
        model_spec = _json_env("DSH_MODEL_SPEC")
        route_spec = _json_env("DSH_ROUTE_SPEC")
        settlement = _json_env("DSH_SETTLEMENT")
    except json.JSONDecodeError as e:
        raise ValueError(f"bad JSON setting: {e}") from e
    if settlement and delegation != "agent-team":
        raise ValueError("DSH_SETTLEMENT follows the Agent Teams board; it needs DSH_DELEGATION=agent-team")
    api_key_env = os.environ.get("DSH_API_KEY_ENV", "OPENROUTER_API_KEY")
    if not os.environ.get(api_key_env):
        raise ValueError(f"{api_key_env} (DSH_API_KEY_ENV) is not set")
    return Config(
        time_limit=int(os.environ["TIME_LIMIT_SECS"]),
        model=os.environ["DSH_MODEL"],
        provider=os.environ.get("DSH_PROVIDER", "openrouter"),
        effort=os.environ.get("DSH_EFFORT", "high"),
        api_key_env=api_key_env,
        delegation=delegation,
        model_spec=model_spec,
        route_spec=route_spec,
        settlement=settlement,
    )


# ── Patches ────────────────────────────────────────────────────────────────


def apply_patches(write: bool = True) -> list[tuple[Patch, str]]:
    """Each patch's state after this call: applied, already, absent (dsh no longer has the line), or needed."""
    states = []
    for patch in PATCHES:
        path = DSH_ROOT / patch.path
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
        if patch.old in text:
            if write:
                path.write_text(text.replace(patch.old, patch.new), encoding="utf-8")
                state = "applied"
            else:
                state = "needed"
        elif patch.new in text:
            state = "already"
        else:
            state = "absent"
        states.append((patch, state))
    return states


def patch_report(states: list[tuple[Patch, str]]) -> str:
    return "".join(f"{p.id}: {state} ({p.path}; {p.why})\n" for p, state in states)


# ── The dsh home ───────────────────────────────────────────────────────────


def yaml_lines(value: object, indent: int) -> list[str]:
    """Block YAML for nested dicts/lists with JSON scalars (ASI-Bench's _yaml_lines)."""
    pad = " " * indent
    lines: list[str] = []
    if isinstance(value, dict):
        for key, sub in value.items():
            if isinstance(sub, (dict, list)):
                lines.append(f"{pad}{key}:\n")
                lines.extend(yaml_lines(sub, indent + 2))
            else:
                lines.append(f"{pad}{key}: {json.dumps(sub)}\n")
    else:
        for item in value:  # type: ignore[union-attr]
            if isinstance(item, dict):
                first = True
                for key, sub in item.items():
                    head = f"{pad}- " if first else f"{pad}  "
                    first = False
                    if isinstance(sub, (dict, list)):
                        lines.append(f"{head}{key}:\n")
                        lines.extend(yaml_lines(sub, indent + 4))
                    else:
                        lines.append(f"{head}{key}: {json.dumps(sub)}\n")
            else:
                lines.append(f"{pad}- {json.dumps(item)}\n")
    return lines


def model_rows(cfg: Config) -> str:
    route: dict = {"apiKeyEnv": cfg.api_key_env, **(cfg.route_spec or {})}
    if cfg.model_spec:
        route["models"] = [{"id": cfg.model, **cfg.model_spec}]
    return (
        "- id: agent-default-model\n"
        "  config:\n"
        f"    provider: {cfg.provider}\n"
        f"    model: {cfg.model}\n"
        f"    reasoningEffort: {cfg.effort}\n"
        "- id: llm-pi-ai\n"
        "  config:\n"
        "    providers:\n"
        f"      {cfg.provider}:\n" + "".join(yaml_lines(route, 8))
    )


def agent_team_rows(home: Path) -> str:
    disabled = ["tool-subagent", "tool-subagent-fork", "tool-subagent-control", "tool-subagent-list-agents"]
    artifact_root = json.dumps(str(home / "sessions" / "team-artifacts"))
    return (
        "".join(f"- id: {row}\n  disabled: true\n" for row in disabled)
        + "- insert:\n"
        "    - id: agent-team\n"
        "      name: '@deepseek-ai/dsh-experimental-agent-team'\n"
        "      config:\n"
        f"        artifactRoot: {artifact_root}\n"
        "    - id: tool-agent-team\n"
        "      name: '@deepseek-ai/dsh-experimental-tool-agent-team'\n"
        "      config:\n"
        "        freshProvider: spawn\n"
        "        forkProvider: fork\n"
    )


def settlement_row(config: dict) -> str:
    return (
        "- insert:\n"
        "    - id: agent-team-settlement\n"
        "      name: '@deepseek-ai/dsh-experimental-agent-team-settlement'\n"
        "      config:\n" + "".join(yaml_lines(config, 8))
    )


def patch_layer(cfg: Config, home: Path) -> str:
    text = "# Benchmark patch layer over dsh-base; generated by harness_automation.py.\n" + model_rows(cfg)
    if cfg.delegation == "agent-team":
        text += agent_team_rows(home)
        if cfg.settlement:
            text += settlement_row(cfg.settlement)
    return text


def prepare_home(cfg: Config) -> None:
    """Sessions go under LOGS_DIR, so the benchmark's own snapshots carry them."""
    (DSH_HOME / "tmp").mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / "dsh-sessions").mkdir(parents=True, exist_ok=True)
    sessions = DSH_HOME / "sessions"
    if sessions.is_symlink() or sessions.is_file():
        sessions.unlink()
    elif sessions.is_dir():
        shutil.rmtree(sessions)
    sessions.symlink_to(LOGS_DIR / "dsh-sessions")
    (DSH_HOME / "cordis.patch.yml").write_text(patch_layer(cfg, DSH_HOME), encoding="utf-8")
    (DSH_HOME / "settings.yaml").unlink(missing_ok=True)


def dsh_env() -> dict[str, str]:
    env = dict(os.environ)
    env["DSH_HOME"] = str(DSH_HOME)
    # The container is the sandbox; dsh's own needs bwrap/landlock it does not have.
    env["DSH_PERMISSION_MODE"] = "danger-full-access"
    # dsh dlopen()s a loader staged under TMPDIR; keep it off a noexec /tmp.
    env["TMPDIR"] = str(DSH_HOME / "tmp")
    # Node's default for connections that do not choose (web_fetch's pinned
    # agent does, which is what PATCHES is for): connect to the first address.
    flag = "--no-network-family-autoselection"
    if flag not in env.get("NODE_OPTIONS", ""):
        env["NODE_OPTIONS"] = f"{env.get('NODE_OPTIONS', '')} {flag}".strip()
    return env


# ── The job ────────────────────────────────────────────────────────────────


def job_text(delegation: str) -> str:
    """The one user message (mllm-benchs MLE-Bench/agents/dsh/start.sh's): read the task from a file.

    The graded instructions then reach the model verbatim, by being read rather
    than interpolated into argv.
    """
    job = (
        f"Your working directory is /home. Read {INSTRUCTIONS} and carry out that task completely: "
        "the paper is in /home/paper, and your submission is the git repository at /home/submission, "
        "exactly as the instructions specify. Commit your work to that repository regularly; "
        "uncommitted files are deleted before grading. Do not ask for confirmation; keep working "
        "until the task is done or the time limit is reached."
    )
    if delegation == "team-mode":
        job = (
            "Decompose this task into reasonable subtasks and complete them in agent team mode using "
            f"the subagent tool, then coordinate the results into the final deliverables: {job}"
        )
    elif delegation == "agent-team":
        job = f"Use Agent Teams with teammates for this. {job}"
    return job


def write_run_json(record: dict) -> None:
    tmp = RUN_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record) + "\n", encoding="utf-8")
    tmp.replace(RUN_JSON)


def submission_commits() -> int:
    res = subprocess.run(
        ["git", "-C", str(SUBMISSION_DIR), "rev-list", "--count", "HEAD"], capture_output=True, text=True
    )
    return int(res.stdout.strip()) if res.returncode == 0 and res.stdout.strip().isdigit() else 0


def run() -> int:
    try:
        cfg = load_config()
        shutil.copy(INSTRUCTIONS, LOGS_DIR / "full_instructions.txt")
        states = apply_patches(write=True)
        (LOGS_DIR / "dsh-patches.txt").write_text(patch_report(states), encoding="utf-8")
        prepare_home(cfg)
    except Exception as e:  # noqa: BLE001 -- any setup failure ends the run with a record
        print(f"harness_automation: setup failed: {e}", file=sys.stderr)
        write_run_json({"status": "failed", "exit_code": 2, "error": f"setup: {e}"})
        return 2
    print(patch_report(states), end="")
    print(f"harness_automation: provider={cfg.provider} model={cfg.model} effort={cfg.effort} delegation={cfg.delegation}")
    shutil.copy(DSH_HOME / "cordis.patch.yml", LOGS_DIR / "cordis.patch.yml")
    shutil.copy(DSH_REVISION, LOGS_DIR / "dsh-revision")
    job = job_text(cfg.delegation)
    (LOGS_DIR / "job.txt").write_text(job + "\n", encoding="utf-8")

    start = time.time()
    with open(LOGS_DIR / "dsh-stdout.log", "wb") as out, open(LOGS_DIR / "dsh-stderr.log", "wb") as err:
        code = subprocess.run(
            ["timeout", "--signal=INT", f"--kill-after={KILL_AFTER_SECS}", str(cfg.time_limit),
             "dsh", "--profile", "headless", job],
            cwd="/home", stdout=out, stderr=err, env=dsh_env(),
        ).returncode
    elapsed = int(time.time() - start)
    status = "timeout" if code in (124, 137) else "completed" if code == 0 else "failed"
    record = {
        "status": status,
        "exit_code": code,
        "elapsed_seconds": elapsed,
        "time_limit_seconds": cfg.time_limit,
        "reproduce_sh": (SUBMISSION_DIR / "reproduce.sh").is_file(),
        "commits": submission_commits(),
        "model": cfg.model,
        "delegation": cfg.delegation,
    }
    write_run_json(record)
    print(
        f"dsh finished: status={status} exit={code} elapsed={elapsed}s "
        f"reproduce_sh={str(record['reproduce_sh']).lower()} commits={record['commits']}"
    )
    return 0


def check() -> int:
    """Validate the image and the settings; print the patch layer and the job. Writes nothing."""
    problems = []
    for tool in ("dsh", "node", "timeout", "zstd", "git"):
        if shutil.which(tool) is None:
            problems.append(f"{tool} not on PATH")
    revision = DSH_REVISION.read_text(encoding="utf-8").split()[0] if DSH_REVISION.is_file() else "missing"
    node = subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip() if shutil.which("node") else "-"
    print(f"dsh revision: {revision}   node: {node}")
    states = apply_patches(write=False)
    print(patch_report(states), end="")
    problems += [f"patch {p.id} not applied in the image (run applies it)" for p, s in states if s == "needed"]
    try:
        cfg = load_config()
    except ValueError as e:
        problems.append(f"settings: {e}")
        cfg = None
    if cfg is not None:
        print(f"settings: provider={cfg.provider} model={cfg.model} effort={cfg.effort} "
              f"delegation={cfg.delegation} time_limit={cfg.time_limit}s key={cfg.api_key_env} (set)")
        print("── cordis.patch.yml ──")
        print(patch_layer(cfg, DSH_HOME), end="")
        print("── job ──")
        print(job_text(cfg.delegation))
    for p in problems:
        print(f"PROBLEM: {p}")
    # A patch the image lacks is applied by `run`; only a real problem fails the check.
    return 1 if any(not p.startswith("patch ") for p in problems) else 0


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "run"
    if command == "run":
        return run()
    if command == "check":
        return check()
    if command == "patch":
        states = apply_patches(write=True)
        print(patch_report(states), end="")
        return 0
    print(f"usage: {argv[0]} [run|check|patch]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
