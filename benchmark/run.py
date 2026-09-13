#!/usr/bin/env python3
"""Dual-arm Terminal-Bench 4.0 runner for sol-zcode (P3).

Discipline (docs/DESIGN.md §7, SoL-OpenCode heldout protocol):
  freeze  plugin source tree (per-file sha256) + both arms' plugins.options +
          task list hash + zcode.cjs/node/provider-template hashes ->
          benchmark/freeze/manifest-<id>.json (immutable, never rewritten)
  run     one Harbor job per invocation; both arms ride the SAME job as two
          agent configs (task x agent trials interleave under one -n cap).
          Results append to benchmark/results/ledger.jsonl, one line per
          task x arm attempt; re-invocation skips combos already in the
          ledger (unattended resume).
  probe   single task, no freeze consumed, nothing written to the ledger,
          evidence collection on. Plumbing validation only.
  report  derived ONLY from the ledger.

Usage:
  python3 run.py freeze --label tb4-cpu63
  python3 run.py --freeze <id> [-n 4] [--arms control,treatment] [--tasks a,b]
  python3 run.py --probe --task html-js-filter [--arms control,treatment] [--cap-sec 3600]
  python3 run.py report [--freeze-id <id>]
  python3 run.py status --freeze <id>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BENCH = Path(__file__).resolve().parent
REPO = BENCH.parent
sys.path.insert(0, str(BENCH))

from bench_config import (  # noqa: E402
    ARM_OPTIONS,
    DEFAULT_MODEL,
    DEFAULT_ZCODE_CJS,
    MARKETPLACE,
    PLUGIN_ID,
    RL_ABORT_MARKER,
)
from pricing import cost_usd  # noqa: E402

HARBOR = BENCH / ".venv" / "bin" / "harbor"
DATASET = "terminal-bench/terminal-bench@4.0.0"
FREEZE_DIR = BENCH / "freeze"
LEDGER = BENCH / "results" / "ledger.jsonl"
JOBS_DIR = BENCH / "jobs"
PROBE_DIR = BENCH / "probe"
TASKS_JSON = BENCH / "tasks.json"
AGENT_IMPORT = "agent.zcode_agent:ZcodeAgent"
DEFAULT_CONCURRENCY = 4  # DESIGN §7: OrbStack resource ceiling
CPU_TASKS: list[str] = json.loads(TASKS_JSON.read_text())["cpu_tasks"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def plugin_file_hashes() -> dict[str, str]:
    plugin_dir = REPO / "plugin"
    files: dict[str, str] = {}
    for path in sorted(plugin_dir.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(plugin_dir).as_posix()
        if rel.split("/")[0] in ("tests", "node_modules") or "node_modules" in rel.split("/"):
            continue
        files[rel] = sha256_file(path)
    return files


# ------------------------------------------------------------------- freeze

def build_manifest(label: str | None) -> dict[str, Any]:
    tasks = json.loads(TASKS_JSON.read_text())
    node_dir = BENCH / "assets" / "node"
    manifest = {
        "schema": 1,
        "createdAt": now_iso(),
        "label": label,
        "dataset": DATASET,
        "model": DEFAULT_MODEL,
        "harborVersion": "0.23.0",
        "plugin": {
            "id": PLUGIN_ID,
            "marketplace": MARKETPLACE,
            "version": json.loads((REPO / "plugin" / ".zcode-plugin" / "plugin.json").read_text())["version"],
            "files": plugin_file_hashes(),
        },
        "zcodeCjs": {"path": str(DEFAULT_ZCODE_CJS), "sha256": sha256_file(DEFAULT_ZCODE_CJS)},
        "nodeTarballs": {
            f.name: sha256_file(f) for f in sorted(node_dir.glob("node-v*-linux-*.tar.xz"))
        },
        "providerTemplateSha256": sha256_file(BENCH / "assets" / "provider-template.json"),
        "arms": {arm: dict(options) for arm, options in ARM_OPTIONS.items()},
        "tasks": {
            "cpuTasks": tasks["cpu_tasks"],
            "gpuTasks": tasks["gpu_tasks"],
            "count": len(tasks["cpu_tasks"]),
            "tasksListSha256": tasks["tasks_list_sha256"],
        },
        "pricing": {
            "sourceDate": __import__("pricing").SOURCE_DATE,
            "usdPerM": {
                "input": __import__("pricing").INPUT_USD_PER_M,
                "output": __import__("pricing").OUTPUT_USD_PER_M,
                "cacheRead": __import__("pricing").CACHE_READ_USD_PER_M,
                "cacheWrite": __import__("pricing").CACHE_WRITE_USD_PER_M,
            },
        },
    }
    digest = hashlib.sha256(
        canonical({k: v for k, v in manifest.items() if k != "createdAt"}).encode()
    ).hexdigest()
    manifest["freezeId"] = digest[:12]
    return manifest


def cmd_freeze(args: argparse.Namespace) -> int:
    manifest = build_manifest(args.label)
    path = FREEZE_DIR / f"manifest-{manifest['freezeId']}.json"
    if path.exists():
        existing = json.loads(path.read_text())
        if existing != manifest:
            print(f"ERROR: immutable manifest {path} differs from current tree", file=sys.stderr)
            return 1
        print(f"freeze {manifest['freezeId']} already exists (identical): {path}")
        return 0
    FREEZE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        f"froze {manifest['freezeId']}: {manifest['tasks']['count']} CPU tasks, "
        f"{len(manifest['plugin']['files'])} plugin files -> {path}"
    )
    return 0


def load_manifest(freeze_id: str) -> dict[str, Any]:
    path = FREEZE_DIR / f"manifest-{freeze_id}.json"
    if not path.exists():
        raise SystemExit(f"no frozen manifest {freeze_id} — run `python3 run.py freeze` first")
    return json.loads(path.read_text())


def assert_tree_matches(manifest: dict[str, Any]) -> None:
    current = plugin_file_hashes()
    frozen = manifest["plugin"]["files"]
    if current != frozen:
        changed = sorted(set(current) ^ set(frozen)) + sorted(
            k for k in set(current) & set(frozen) if current[k] != frozen[k]
        )
        raise SystemExit(
            f"plugin tree drifted from freeze {manifest['freezeId']}: {changed[:5]} "
            f"({len(changed)} file(s)) — refreeze instead of running a mutant"
        )
    if sha256_file(DEFAULT_ZCODE_CJS) != manifest["zcodeCjs"]["sha256"]:
        raise SystemExit(f"zcode.cjs drifted from freeze {manifest['freezeId']}")


# ------------------------------------------------------------------- ledger

def ledger_entries() -> list[dict[str, Any]]:
    if not LEDGER.exists():
        return []
    entries = []
    for line in LEDGER.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


def append_ledger(entry: dict[str, Any]) -> None:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with open(LEDGER, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")
    LEDGER.chmod(0o644)


def done_combos(freeze_id: str, retry_failed: bool = False) -> set[tuple[str, str]]:
    """Combos already ledgered. With retry_failed, only successful (or
    verifier-judged) lines count as done — pure-exception lines may re-run
    and append a second attempt line."""
    done: set[tuple[str, str]] = set()
    errored: set[tuple[str, str]] = set()
    for entry in ledger_entries():
        if entry.get("kind") != "run" or entry.get("freezeId") != freeze_id:
            continue
        combo = (entry["task"], entry["arm"])
        if entry.get("errored"):
            errored.add(combo)
        else:
            done.add(combo)
    return done if retry_failed else done | errored


# ------------------------------------------------------------------ harbor

def harbor_config(
    *,
    tasks: list[str],
    arms: list[str],
    job_name: str,
    concurrency: int,
    evidence: bool,
    model: str | None,
) -> dict[str, Any]:
    agents = []
    for arm in arms:
        agent: dict[str, Any] = {
            "import_path": AGENT_IMPORT,
            "kwargs": {"zcode_arm": arm},
        }
        if model:
            agent["model_name"] = model
        if evidence:
            # Consumed by ZcodeAgent to tar the plugin data root into the logs.
            agent["env"] = {"SOL_BENCH_COLLECT_EVIDENCE": "1"}
        agents.append(agent)
    config: dict[str, Any] = {
        "job_name": job_name,
        "jobs_dir": str(JOBS_DIR),
        "n_concurrent_trials": concurrency,
        "quiet": True,
        "agents": agents,
        "datasets": [
            {
                "name": DATASET.split("@")[0],
                "version": DATASET.split("@")[1],
                # Dataset task filters match the full "terminal-bench/<task>"
                # name (same as --include-task-name on the CLI).
                "task_names": sorted(f"terminal-bench/{t}" for t in tasks),
                "overwrite": False,
            }
        ],
    }
    return config


def run_harbor(
    config: dict[str, Any], cap_sec: int | None, extra_env: dict[str, str] | None = None
) -> int:
    import tempfile

    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    cfg_file = JOBS_DIR / f".config-{config['job_name']}.json"
    cfg_file.write_text(json.dumps(config, indent=2))
    argv = [str(HARBOR), "run", "-c", str(cfg_file), "-y"]
    env = dict(os.environ)
    env["PYTHONPATH"] = str(BENCH) + (
        ":" + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
    )
    if cap_sec is not None:
        env["SOL_BENCH_AGENT_CAP_SEC"] = str(cap_sec)
    if extra_env:
        env.update(extra_env)
    print(f"$ {' '.join(argv)}  (cwd={BENCH})", flush=True)
    started = time.monotonic()
    proc = subprocess.run(argv, cwd=str(BENCH), env=env)
    print(f"harbor exited {proc.returncode} after {(time.monotonic() - started):.0f}s", flush=True)
    return proc.returncode


# ----------------------------------------------------------- result parsing

def parse_job_dir(job_dir: Path) -> list[dict[str, Any]]:
    trials = []
    if not job_dir.is_dir():
        return trials
    for entry in sorted(job_dir.iterdir()):
        result_file = entry / "result.json"
        if not entry.is_dir() or not result_file.exists():
            continue
        record = json.loads(result_file.read_text())
        agent_cfg = (record.get("config") or {}).get("agent") or {}
        arm = (agent_cfg.get("kwargs") or {}).get("zcode_arm")
        if arm is None:  # not our agent — skip
            continue
        agent_result = record.get("agent_result") or {}
        meta = (agent_result.get("metadata") or {}).get("zcode") or {}
        verifier = record.get("verifier_result") or {}
        rewards = verifier.get("rewards") or {}
        timing = record.get("agent_execution") or {}
        started, finished = timing.get("started_at"), timing.get("finished_at")
        wall_ms = None
        if started and finished:
            from datetime import datetime as _dt

            wall_ms = int(
                (
                    _dt.fromisoformat(finished) - _dt.fromisoformat(started)
                ).total_seconds()
                * 1000
            )
        trials.append(
            {
                "kind": "run",
                "ts": now_iso(),
                "task": record.get("task_name", "").removeprefix("terminal-bench/"),
                "arm": arm,
                "trialDir": str(entry),
                "trialId": record.get("id"),
                "sessionId": meta.get("sessionId"),
                "usage": {
                    "inputTokens": agent_result.get("n_input_tokens") or 0,
                    "outputTokens": agent_result.get("n_output_tokens") or 0,
                    "cacheRead": agent_result.get("n_cache_tokens") or 0,
                    "cacheWrite": meta.get("cacheWriteTokens") or 0,
                    "modelRequestCount": meta.get("modelRequestCount"),
                },
                "costUsd": agent_result.get("cost_usd"),
                "reward": rewards.get("reward"),
                "solved": (rewards.get("reward") or 0) >= 1,
                "errored": record.get("exception_info") is not None,
                "exceptionType": (record.get("exception_info") or {}).get("exception_type"),
                "wallMs": wall_ms or meta.get("agentWallMs"),
            }
        )
        # Rate-limit degeneracy abort (audit MAJOR-1): carry the watchdog's
        # own evidence into the ledger line when it fired.
        if meta.get("rateLimitAbort"):
            trials[-1]["rateLimitAbort"] = meta["rateLimitAbort"]
    return trials


# ------------------------------------------------------------------ commands

def cmd_run(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.freeze)
    assert_tree_matches(manifest)

    arms = [a.strip() for a in args.arms.split(",")]
    done = done_combos(args.freeze, args.retry_failed)
    all_tasks = args.tasks.split(",") if args.tasks else manifest["tasks"]["cpuTasks"]
    unknown = [t for t in all_tasks if t not in manifest["tasks"]["cpuTasks"]]
    if unknown:
        raise SystemExit(f"tasks not in frozen CPU set: {unknown}")

    plan = [(task, arm) for task in all_tasks for arm in arms if (task, arm) not in done]
    if not plan:
        print(f"nothing to do: all {len(all_tasks) * len(arms)} combo(s) already in ledger")
        return 0
    print(
        f"freeze {args.freeze}: {len(plan)} trial(s) to run "
        f"({len(all_tasks) * len(arms) - len(plan)} already in ledger), "
        f"arms={arms}, -n {args.n}, retry_failed={args.retry_failed}"
    )

    job_name = f"sol-{args.freeze}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    config = harbor_config(
        tasks=sorted({t for t, _ in plan}),
        arms=sorted({a for _, a in plan}),
        job_name=job_name,
        concurrency=args.n,
        evidence=False,
        model=args.model,
    )
    code = run_harbor(config, cap_sec=args.cap_sec)

    job_dir = JOBS_DIR / job_name
    trials = parse_job_dir(job_dir)
    done_now = done_combos(args.freeze, args.retry_failed)
    appended = 0
    for trial in trials:
        combo = (trial["task"], trial["arm"])
        if combo in done_now:
            continue
        trial["freezeId"] = args.freeze
        trial["probe"] = False
        trial["retryAttempt"] = args.retry_failed or None
        trial["harborExitCode"] = code
        append_ledger(trial)
        appended += 1
    print(f"appended {appended}/{len(plan)} trial result(s) to {LEDGER}")
    missing = len(plan) - appended
    if missing > 0:
        print(
            f"WARNING: {missing} planned combo(s) produced no result.json — "
            "re-run this command to resume (completed combos are skipped)",
            file=sys.stderr,
        )
    return 0 if appended == len(plan) else 2


def cmd_probe(args: argparse.Namespace) -> int:
    arms = [a.strip() for a in args.arms.split(",")]
    if args.task not in CPU_TASKS:
        raise SystemExit(f"{args.task} not in verified CPU set")
    job_name = f"probe-{args.task}-{''.join(a[0] for a in arms)}-{datetime.now().strftime('%H%M%S')}"
    config = harbor_config(
        tasks=[args.task],
        arms=arms,
        job_name=job_name,
        concurrency=args.n,
        evidence=True,
        model=args.model,
    )
    print(
        f"PROBE (not recorded to ledger, freeze not consumed): task={args.task} "
        f"arms={arms} job={job_name} cap={args.cap_sec}s"
    )
    started = time.monotonic()
    code = run_harbor(config, cap_sec=args.cap_sec)
    wall = time.monotonic() - started

    job_dir = JOBS_DIR / job_name
    trials = parse_job_dir(job_dir)
    out_dir = PROBE_DIR / f"{args.task}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    out_dir.mkdir(parents=True, exist_ok=True)
    summary: dict[str, Any] = {
        "kind": "probe",
        "ts": now_iso(),
        "task": args.task,
        "jobName": job_name,
        "jobDir": str(job_dir),
        "harborExitCode": code,
        "totalWallSec": round(wall),
        "capSec": args.cap_sec,
        "trials": [],
    }
    for trial in trials:
        trial_dir = Path(trial["trialDir"])
        arm = trial["arm"]
        arm_out = out_dir / arm
        arm_out.mkdir(parents=True, exist_ok=True)
        for name in ("zcode.txt", "sol-data.tgz", "trajectory.json", RL_ABORT_MARKER):
            src = trial_dir / "agent" / name
            if src.exists():
                (arm_out / name).write_bytes(src.read_bytes())
        # usage snapshot (the deliverable: per-arm --json usage + data-root digest)
        (arm_out / "usage.json").write_text(json.dumps(trial, indent=2, default=str))
        summary["trials"].append(trial)
        usage = trial["usage"]
        print(
            f"  [{arm}] solved={trial['solved']} reward={trial['reward']} "
            f"in={usage['inputTokens']} out={usage['outputTokens']} "
            f"cacheRead={usage['cacheRead']} reqs={usage['modelRequestCount']} "
            f"cost=${trial['costUsd'] or 0:.4f} wall={((trial['wallMs'] or 0) / 1000):.0f}s "
            f"exc={trial['exceptionType']}"
        )
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
    print(f"probe evidence -> {out_dir}")
    return 0 if trials else 1


def cmd_report(args: argparse.Namespace) -> int:
    entries = [e for e in ledger_entries() if e.get("kind") == "run"]
    if args.freeze_id:
        entries = [e for e in entries if e.get("freezeId") == args.freeze_id]
    by_arm: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        by_arm.setdefault(entry["arm"], []).append(entry)
    print(f"ledger: {LEDGER} ({len(entries)} run lines)")
    totals = {}
    for arm, rows in sorted(by_arm.items()):
        solved = sum(1 for r in rows if r["solved"])
        agg = {
            "tasks": len(rows),
            "solved": solved,
            "input": sum(r["usage"]["inputTokens"] for r in rows),
            "output": sum(r["usage"]["outputTokens"] for r in rows),
            "cacheRead": sum(r["usage"]["cacheRead"] for r in rows),
            "costUsd": round(sum(r["costUsd"] or 0 for r in rows), 4),
            "exceptions": sum(1 for r in rows if r["errored"]),
            "wallSec": round(sum((r["wallMs"] or 0) / 1000 for r in rows)),
        }
        totals[arm] = agg
        print(f"\n[{arm}] " + " ".join(f"{k}={v}" for k, v in agg.items()))
    if "control" in totals and "treatment" in totals:
        c, t = totals["control"], totals["treatment"]
        paired = []
        for task, rows in _group_tasks(entries).items():
            byarm = {r["arm"]: r for r in rows}
            if "control" in byarm and "treatment" in byarm:
                paired.append(byarm)
        if paired:
            cin = sum(v["control"]["usage"]["inputTokens"] for v in paired)
            tin = sum(v["treatment"]["usage"]["inputTokens"] for v in paired)
            cc = sum(v["control"]["costUsd"] or 0 for v in paired)
            tc = sum(v["treatment"]["costUsd"] or 0 for v in paired)
            cs = sum(1 for v in paired if v["control"]["solved"])
            ts = sum(1 for v in paired if v["treatment"]["solved"])
            print(
                f"\npaired tasks={len(paired)} solved {cs}->{ts} | "
                f"input {cin}->{tin} ({_pct(tin, cin)}) | "
                f"cost ${cc:.4f}->${tc:.4f} ({_pct(tc, cc)})"
            )
    return 0


def _group_tasks(entries: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        groups.setdefault(entry["task"], []).append(entry)
    return groups


def _pct(new: float, old: float) -> str:
    if not old:
        return "n/a"
    return f"{(new - old) / old * 100:+.1f}%"


def cmd_status(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.freeze)
    done = done_combos(args.freeze)
    tasks = manifest["tasks"]["cpuTasks"]
    for arm in sorted(ARM_OPTIONS):
        missing = [t for t in tasks if (t, arm) not in done]
        print(f"{arm}: {len(tasks) - len(missing)}/{len(tasks)} done")
        if missing and len(missing) <= 10:
            print(f"  missing: {', '.join(missing)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command")

    p_freeze = sub.add_parser("freeze", help="write an immutable manifest of the current candidate")
    p_freeze.add_argument("--label", default=None)
    p_freeze.set_defaults(func=cmd_freeze)

    p_run = sub.add_parser("run", help="run remaining task x arm combos (resume-safe)")
    p_run.add_argument("--freeze", required=True)
    p_run.add_argument("--arms", default="control,treatment")
    p_run.add_argument("-n", type=int, default=DEFAULT_CONCURRENCY)
    p_run.add_argument("--tasks", default=None, help="comma list (default: frozen CPU set)")
    p_run.add_argument("--model", default=None)
    p_run.add_argument("--cap-sec", type=int, default=None, help="override in-band agent cap")
    p_run.add_argument("--retry-failed", action="store_true", help="(reserved) re-attempt exception-ed trials")
    p_run.set_defaults(func=cmd_run)

    p_probe = sub.add_parser("probe", help="single-task infrastructure probe (not recorded)")
    p_probe.add_argument("--task", required=True)
    p_probe.add_argument("--arms", default="control,treatment")
    p_probe.add_argument("-n", type=int, default=2)
    p_probe.add_argument("--model", default=None)
    p_probe.add_argument("--cap-sec", type=int, default=3600)
    p_probe.set_defaults(func=cmd_probe)

    p_report = sub.add_parser("report", help="summarize the ledger")
    p_report.add_argument("--freeze-id", default=None)
    p_report.set_defaults(func=cmd_report)

    p_status = sub.add_parser("status", help="per-arm completion vs a freeze")
    p_status.add_argument("--freeze", required=True)
    p_status.set_defaults(func=cmd_status)

    args = parser.parse_args()
    if not getattr(args, "func", None):
        parser.print_help()
        return 1
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
