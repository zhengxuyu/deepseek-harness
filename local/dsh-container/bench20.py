#!/usr/bin/env python3
"""Run dsh on tasks from the bench20-harbor dataset (huggingface.co/datasets/Paper-Data/bench20-harbor).

Only the task is taken from the dataset: its instruction.md, task.toml and
environment/materials/. The run uses this directory's image and launch.sh, not
the task's own Harbor environment. tests/ (the hidden target paper, the rubric
and the verifier) is never downloaded, so nothing of it can reach the agent.

    ./bench20.py list
    ./bench20.py run rtp-kc-001 [rtp-kc-004 ... | all] [options] [-- launch.sh options]

Options of `run`:
    --model ID        dsh's model                       (default deepseek/deepseek-v4.1-flash)
    --image I         image with dsh                    (default openclaw-task-dsh:latest)
    --out-root DIR    one output directory per task under it   (default ~/data/bench20-runs)
    --time-limit H    hours; default the task's [agent] timeout_sec
    --mem-limit M     docker notation; default the task's [environment] memory_mb
    --foreground      wait for the run (one task only); default is launch.sh --detach
    --cache DIR       where tasks are downloaded        (default ~/data/bench20-harbor)
    --revision REV    dataset revision                  (default main, resolved to its commit)

Anything after `--` goes to launch.sh as is (for example --model-spec, --effort,
--delegation). The key is the one launch.sh reads (OPENROUTER_API_KEY by
default); HF_TOKEN is sent to the Hub when set.

The task text is instruction.md with its two container paths rewritten to
launch.sh's layout: /workspace/materials -> /home/paper (the materials, mounted
read-only with --paper) and /workspace/submission -> /home/submission (the
output's submission/). Each output directory also gets task.md (that text),
bench20.json (dataset commit, task, settings) and launch.sh's own records.

The image has network access, which the dataset's own environment denies; the
instruction's "There is no general internet access" line is kept as written.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import tomllib
import urllib.parse
import urllib.request
from pathlib import Path

REPO = "Paper-Data/bench20-harbor"
HUB = "https://huggingface.co"
HERE = Path(__file__).resolve().parent
PATH_MAP = {"/workspace/materials": "/home/paper", "/workspace/submission": "/home/submission"}


def hub_get(url: str) -> bytes:
    req = urllib.request.Request(url)
    if os.environ.get("HF_TOKEN"):
        req.add_header("Authorization", f"Bearer {os.environ['HF_TOKEN']}")
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def dataset_info(revision: str) -> dict:
    """The dataset's commit and file list at `revision`."""
    url = f"{HUB}/api/datasets/{REPO}/revision/{urllib.parse.quote(revision, safe='')}"
    return json.loads(hub_get(url))


def task_names(info: dict) -> list[str]:
    return sorted({s["rfilename"].split("/")[0] for s in info["siblings"]
                   if s["rfilename"].endswith("/task.toml") and s["rfilename"].count("/") == 1})


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(info: dict, task: str, cache: Path) -> Path:
    """Download the task's instruction.md, task.toml and materials into cache/<commit12>/<task>, verified."""
    commit = info["sha"]
    root = cache / commit[:12] / task
    done = root / ".complete"
    if done.exists():
        return root
    wanted = [s["rfilename"] for s in info["siblings"]
              if s["rfilename"] in (f"{task}/instruction.md", f"{task}/task.toml")
              or s["rfilename"].startswith(f"{task}/environment/materials/")]
    for name in wanted:
        assert not name.startswith(f"{task}/tests/"), name
        rel = name[len(task) + 1:].replace("environment/materials/", "materials/", 1)
        dest = root / rel
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        tmp.write_bytes(hub_get(f"{HUB}/datasets/{REPO}/resolve/{commit}/{urllib.parse.quote(name)}"))
        tmp.rename(dest)
        print(f"  {name}", flush=True)
    manifest = json.loads((root / "materials" / "MANIFEST.json").read_text())
    for item in manifest["items"]:
        if item.get("sha256") is None:
            continue
        item_dir = root / "materials" / item["path"].removeprefix("/workspace/materials/")
        for f in item["files"]:
            got = sha256(item_dir / f["path"])
            if got != f["sha256"]:
                sys.exit(f"bench20: {task}: {item_dir / f['path']} has SHA-256 {got}, MANIFEST says {f['sha256']}")
    done.write_text(commit + "\n")
    return root


def task_text(root: Path) -> str:
    text = (root / "instruction.md").read_text(encoding="utf-8")
    for old, new in PATH_MAP.items():
        text = text.replace(old, new)
    return text


def cmd_list(args) -> None:
    info = dataset_info(args.revision)
    print(f"{REPO} @ {info['sha'][:12]}")
    for t in task_names(info):
        toml = tomllib.loads(hub_get(f"{HUB}/datasets/{REPO}/resolve/{info['sha']}/{t}/task.toml").decode())
        print(f"  {t}  {toml['agent']['timeout_sec'] / 3600:5.1f}h  {toml['environment']['memory_mb'] // 1024:3d}GB  "
              f"{toml['environment']['cpus']:2d} cpus  {toml['task']['description']}")


def cmd_run(args, launch_args: list[str]) -> None:
    info = dataset_info(args.revision)
    tasks = task_names(info) if args.tasks == ["all"] else args.tasks
    unknown = set(tasks) - set(task_names(info))
    if unknown:
        sys.exit(f"bench20: no such task: {', '.join(sorted(unknown))}; see `bench20.py list`")
    if args.foreground and len(tasks) > 1:
        sys.exit("bench20: --foreground runs one task")
    cache, out_root = Path(args.cache).expanduser(), Path(args.out_root).expanduser()
    model_tag = re.sub(r"[^A-Za-z0-9_.-]+", "-", args.model.split("/")[-1])
    stamp = time.strftime("%m%d-%H%M")
    for task in tasks:
        print(f"{task}: fetching from {REPO} @ {info['sha'][:12]}", flush=True)
        root = fetch(info, task, cache)
        toml = tomllib.loads((root / "task.toml").read_text())
        hours = args.time_limit if args.time_limit is not None else toml["agent"]["timeout_sec"] / 3600
        mem = args.mem_limit or f"{toml['environment']['memory_mb'] // 1024}g"
        out = out_root / f"{task}-{model_tag}-{stamp}"
        out.mkdir(parents=True, exist_ok=False)
        (out / "task.md").write_text(task_text(root), encoding="utf-8")
        (out / "bench20.json").write_text(json.dumps({
            "dataset": REPO, "commit": info["sha"], "task": task, "task_name": toml["task"]["name"],
            "model": args.model, "image": args.image, "time_limit_hours": hours, "mem_limit": mem,
            "path_map": PATH_MAP, "launch_args": launch_args,
        }, indent=2) + "\n")
        cmd = ["bash", str(HERE / "launch.sh"), str(out), "--task", str(out / "task.md"), "--paper", str(root / "materials"),
               "--image", args.image, "--model", args.model, "--time-limit", f"{hours:g}", "--mem-limit", mem,
               "--name", f"dsh-{out.name}"]
        if not args.foreground:
            cmd.append("--detach")
        code = subprocess.run(cmd + launch_args).returncode
        if code != 0:
            sys.exit(f"bench20: launch.sh exited {code} for {task}")


def main() -> None:
    argv = sys.argv[1:]
    launch_args = argv[argv.index("--") + 1:] if "--" in argv else []
    argv = argv[:argv.index("--")] if "--" in argv else argv
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    pl = sub.add_parser("list", help="the dataset's tasks with their time limit and resources")
    pl.add_argument("--revision", default="main")
    pr = sub.add_parser("run", help="run dsh on tasks")
    pr.add_argument("tasks", nargs="+")
    pr.add_argument("--model", default="deepseek/deepseek-v4.1-flash")
    pr.add_argument("--image", default="openclaw-task-dsh:latest")
    pr.add_argument("--out-root", default="~/data/bench20-runs")
    pr.add_argument("--time-limit", type=float)
    pr.add_argument("--mem-limit")
    pr.add_argument("--foreground", action="store_true")
    pr.add_argument("--cache", default="~/data/bench20-harbor")
    pr.add_argument("--revision", default="main")
    args = p.parse_args(argv)
    if args.cmd == "list":
        cmd_list(args)
    else:
        cmd_run(args, launch_args)


if __name__ == "__main__":
    main()
