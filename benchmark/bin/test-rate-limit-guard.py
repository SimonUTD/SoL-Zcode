#!/usr/bin/env python3
"""Offline self-check for the rate-limit degeneracy abort criterion (MAJOR-1).

No model, no container, no network. Verifies, against synthetic fixtures and
the archived C-arm probe trajectory:

  1. the reference evaluator (benchmark/rate_limit_guard.py):
     - 3 consecutive >600 s model-request gaps  -> abort
     - an isolated 1,897 s gap then normal work -> no abort (C-arm shape)
     - 3 x 700 s tool-execution gaps            -> no abort (pre_tool gaps
       are tool runtime, not model requests)
     - gaps of exactly 600 s                    -> no abort (strictly >)
     - slow requests separated by fast ones     -> no abort (streak resets)
     - the in-flight (pending) request counts once it crosses the threshold
       (a hung third request still aborts), except after a `stop` event
  2. parity: assets/rl-watchdog.mjs --evaluate-file returns the same
     verdicts on the same fixtures (this is the code that runs in-container)
  3. the live wrap path: the watchdog actually kills a degenerate child,
     writes the marker, tees output, and exits 75; natural exits and nonzero
     child exits propagate unchanged
  4. the offline CLI (python3 rate_limit_guard.py <file|sol-data.tgz>)

Run:  python3 benchmark/bin/test-rate-limit-guard.py
Exit: 0 all green, 1 any failure (node-dependent checks are skips, counted).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BENCH))

from rate_limit_guard import (  # noqa: E402
    evaluate,
    main as guard_cli,
    parse_events,
)

WATCHDOG = BENCH / "assets" / "rl-watchdog.mjs"
C_ARM_TGZ = BENCH / "probe/html-js-filter-20260913-235742/gate/sol-data.tgz"
BASE = datetime(2026, 9, 13, 10, 0, 0, tzinfo=timezone.utc)

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail and not ok else ''}")


def iso(sec: float) -> str:
    moment = BASE + timedelta(seconds=sec)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def write_traj(path: Path, events: list[tuple[str, float, dict | None]]) -> Path:
    """events: (kind, offset_sec, extra-fields-or-None)."""
    lines = []
    for kind, offset, extra in events:
        record = {"schema": "sol_zcode_trajectory_v1", "runId": "test", "ts": iso(offset), "event": kind}
        if extra:
            record.update(extra)
        lines.append(json.dumps(record))
    path.write_text("\n".join(lines) + "\n")
    return path


def node() -> str | None:
    return shutil.which("node")


def node_eval(path: Path, *, abort_sec: int = 600, now: str | None = None) -> dict | None:
    argv = [node(), str(WATCHDOG), "--evaluate-file", str(path), "--abort-sec", str(abort_sec)]
    if now:
        argv += ["--now", now]
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=60)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"_raw": proc.stdout, "_stderr": proc.stderr, "_rc": proc.returncode}


def py_eval(path: Path, *, abort_sec: int = 600, now: datetime | None = None) -> dict:
    return evaluate(parse_events(path.read_text()), abort_sec=abort_sec, consecutive=3, now=now)


def parity(name: str, path: Path, *, abort_sec: int = 600, now: datetime | None = None) -> None:
    py = py_eval(path, abort_sec=abort_sec, now=now)
    if node() is None:
        check(f"node parity: {name} (SKIPPED — no node on PATH)", True)
        return
    js = node_eval(path, abort_sec=abort_sec, now=iso_with_now(now))
    same = (
        isinstance(js, dict)
        and js.get("abort") == py["abort"]
        and js.get("streak") == py["streak"]
        and js.get("maxStreak") == py["maxStreak"]
        and abs((js.get("maxRequestGapSec") or 0) - (py["maxRequestGapSec"] or 0)) < 0.01
    )
    check(f"node parity: {name}", same, f"py={py['abort']}/{py['streak']} js={js}")


def iso_with_now(now: datetime | None) -> str | None:
    if now is None:
        return None
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="rl-guard-test-"))
    print(f"fixtures in {tmp}")

    print("\n[1] reference evaluator (rate_limit_guard.py)")
    degenerate = write_traj(tmp / "degenerate.jsonl", [
        ("session_start", 0, None),
        ("user_prompt", 1, None),
        # three consecutive model requests, each observed >600 s; the file
        # ends here (aborted mid-run — no stop event yet)
        ("post_tool", 701, {"tool": "sol_bash"}),
        ("post_tool", 1402, {"tool": "sol_bash"}),
        ("post_tool", 2103, {"tool": "sol_bash"}),
    ])
    v = py_eval(degenerate)
    check("3 consecutive >600s request gaps -> abort", v["abort"] and v["streak"] == 3, str(v))
    check("abort evidence carries the 3 gaps", len(v["evidence"]) == 3 and all(g["seconds"] > 600 for g in v["evidence"]))

    healthy = write_traj(tmp / "healthy-carm-shape.jsonl", [
        ("session_start", 0, None),
        ("user_prompt", 1, None),
        ("post_tool", 1897.8, {"tool": "Bash"}),   # the one rate-limited request
        ("post_tool", 1920.0, {"tool": "sol_bash"}),
        ("post_tool", 2090.5, {"tool": "sol_bash"}),
        ("post_tool", 2245.0, {"tool": "sol_bash"}),
        ("stop", 2246, None),
    ])
    v = py_eval(healthy)
    check("isolated 1896.8s gap then normal -> no abort", not v["abort"] and v["maxStreak"] == 1, str(v))
    check("max request gap recomputes to ~1896.8s", abs(v["maxRequestGapSec"] - 1896.8) < 0.01, str(v["maxRequestGapSec"]))

    long_tools = write_traj(tmp / "long-tool-execs.jsonl", [
        ("session_start", 0, None),
        ("user_prompt", 1, None),
        ("pre_tool", 2, {"tool": "Bash"}),
        ("post_tool", 702, {"tool": "Bash"}),   # 700 s TOOL execution
        ("pre_tool", 703, {"tool": "Bash"}),
        ("post_tool", 1403, {"tool": "Bash"}),  # 700 s TOOL execution
        ("pre_tool", 1404, {"tool": "Bash"}),
        ("post_tool", 2104, {"tool": "Bash"}),  # 700 s TOOL execution
        ("stop", 2105, None),
    ])
    v = py_eval(long_tools)
    check("3 x 700s tool-exec gaps -> no abort (pre_tool gaps excluded)",
          not v["abort"] and v["maxToolGapSec"] and v["maxToolGapSec"] > 699 and (v["maxRequestGapSec"] or 0) < 10, str(v))

    boundary = write_traj(tmp / "boundary-600.jsonl", [
        ("session_start", 0, None),
        ("user_prompt", 1, None),
        ("post_tool", 601, {"tool": "sol_bash"}),
        ("post_tool", 1201, {"tool": "sol_bash"}),
        ("post_tool", 1801, {"tool": "sol_bash"}),
        ("stop", 1802, None),
    ])
    v = py_eval(boundary)
    check("request gaps of exactly 600s -> no abort (strictly greater)", not v["abort"], str(v))

    nonconsec = write_traj(tmp / "non-consecutive.jsonl", [
        ("session_start", 0, None),
        ("user_prompt", 1, None),
        ("post_tool", 701, {"tool": "sol_bash"}),
        ("post_tool", 761, {"tool": "sol_bash"}),   # fast
        ("post_tool", 1462, {"tool": "sol_bash"}),
        ("post_tool", 1522, {"tool": "sol_bash"}),  # fast
        ("post_tool", 2223, {"tool": "sol_bash"}),
        ("stop", 2224, None),
    ])
    v = py_eval(nonconsec)
    check("slow requests separated by fast ones -> no abort (streak resets)",
          not v["abort"] and v["maxStreak"] == 1, str(v))

    pending = write_traj(tmp / "pending-hung.jsonl", [
        ("session_start", 0, None),
        ("user_prompt", 1, None),
        ("post_tool", 701, {"tool": "sol_bash"}),
        ("post_tool", 1402, {"tool": "sol_bash"}),
        # third request never completes: 1,900 s in flight at "now"
    ])
    v = py_eval(pending, now=BASE + timedelta(seconds=3302))
    check("hung third request counts via pending gap -> abort",
          v["abort"] and v["streak"] == 3 and v["evidence"][-1]["pending"], str(v))

    pending_stop = write_traj(tmp / "pending-after-stop.jsonl", [
        ("session_start", 0, None),
        ("user_prompt", 1, None),
        ("post_tool", 701, {"tool": "sol_bash"}),
        ("post_tool", 1402, {"tool": "sol_bash"}),
        ("stop", 1403, None),
        # 1,899 s after stop: NOT a request — the run already finished
    ])
    v = py_eval(pending_stop, now=BASE + timedelta(seconds=3302))
    check("pending after stop is not a request -> no abort", not v["abort"], str(v))

    print("\n[2] node/py parity (the in-container watchdog agrees with the reference)")
    parity("degenerate", degenerate)
    parity("healthy-carm-shape", healthy)
    parity("long-tool-execs", long_tools)
    parity("boundary-600", boundary)
    parity("non-consecutive", nonconsec)
    parity("pending-hung", pending, now=BASE + timedelta(seconds=3302))

    print("\n[3] live wrap path (spawn/tee/kill/marker/exit-code; no model, no docker)")
    if node() is None:
        check("live wrap (SKIPPED — no node on PATH)", True)
    else:
        home = tmp / "abort-home"
        traj_dir = home / ".zcode/cli/plugins/data/sol-zcode@sol-zcode-bench/store/trajectory"
        traj_dir.mkdir(parents=True)
        # two completed 700 s request gaps + a third already 2,299 s in flight
        write_traj(traj_dir / "sess_test.jsonl", [
            ("session_start", 0, None),
            ("user_prompt", 1, None),
            ("post_tool", 701, {"tool": "sol_bash"}),
            ("post_tool", 1402, {"tool": "sol_bash"}),
        ])
        real_base = datetime.now(timezone.utc)
        # rebase fixture timestamps into the recent past so the pending gap is real
        lines = []
        for kind, offset in [("session_start", -3700), ("user_prompt", -3699),
                             ("post_tool", -2999), ("post_tool", -2299)]:
            ts = real_base + timedelta(seconds=offset)
            ts_str = ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"
            lines.append(json.dumps({"schema": "sol_zcode_trajectory_v1", "runId": "t", "ts": ts_str, "event": kind}))
        (traj_dir / "sess_test.jsonl").write_text("\n".join(lines) + "\n")

        out = tmp / "abort" / "zcode.txt"
        marker = tmp / "abort" / "zcode.txt.rl-abort.json"
        started = time.monotonic()
        proc = subprocess.run(
            [node(), str(WATCHDOG), "--out", str(out), "--abort-marker", str(marker),
             "--abort-sec", "600", "--consecutive", "3", "--poll-sec", "1",
             "--", "echo hello-rl; sleep 60"],
            capture_output=True, text=True, timeout=90,
            env={**os.environ, "HOME": str(home)},
        )
        elapsed = time.monotonic() - started
        check("degenerate child is killed, watchdog exits 75", proc.returncode == 75,
              f"rc={proc.returncode} stderr={proc.stderr[:300]}")
        check("abort fires fast (first poll, not 60 s)", elapsed < 30, f"elapsed={elapsed:.1f}s")
        check("marker written with reason + 3-gap evidence",
              marker.exists() and json.loads(marker.read_text()).get("reason") == "rate-limit-degeneracy"
              and len(json.loads(marker.read_text()).get("verdict", {}).get("evidence", [])) == 3)
        check("child stdout teed to --out", "hello-rl" in out.read_text())

        natural = tmp / "natural" / "zcode.txt"
        natural_marker = tmp / "natural" / "zcode.txt.rl-abort.json"
        proc = subprocess.run(
            [node(), str(WATCHDOG), "--out", str(natural), "--abort-marker", str(natural_marker),
             "--abort-sec", "600", "--consecutive", "3", "--poll-sec", "1", "--", "echo hi"],
            capture_output=True, text=True, timeout=60,
            env={**os.environ, "HOME": str(tmp / "empty-home")},
        )
        check("healthy child: exit code 0 propagates, no marker, output teed",
              proc.returncode == 0 and not natural_marker.exists() and "hi" in natural.read_text(),
              f"rc={proc.returncode}")

        failing = tmp / "failing" / "zcode.txt"
        failing_marker = tmp / "failing" / "zcode.txt.rl-abort.json"
        proc = subprocess.run(
            [node(), str(WATCHDOG), "--out", str(failing), "--abort-marker", str(failing_marker),
             "--abort-sec", "600", "--consecutive", "3", "--poll-sec", "1", "--", "exit 42"],
            capture_output=True, text=True, timeout=60,
            env={**os.environ, "HOME": str(tmp / "empty-home")},
        )
        check("nonzero child exit propagates unchanged (42, no marker)",
              proc.returncode == 42 and not failing_marker.exists(), f"rc={proc.returncode}")

    print("\n[4] offline CLI (rate_limit_guard.py)")
    check("CLI: degenerate fixture exits 3", guard_cli([str(degenerate)]) == 3)
    check("CLI: healthy fixture exits 0", guard_cli([str(healthy)]) == 0)
    if C_ARM_TGZ.exists():
        check("CLI: archived C-arm sol-data.tgz evaluates clean (exit 0)",
              guard_cli([str(C_ARM_TGZ)]) == 0)
        with tarfile.open(C_ARM_TGZ, "r:gz") as tar:
            member = next(m for m in tar.getmembers() if "store/trajectory/" in m.name)
            extracted = tmp / "carm-real.jsonl"
            extracted.write_bytes(tar.extractfile(member).read())
        v = py_eval(extracted)
        check("real C-arm replay: no abort, max request gap 1896.8s (audit number)",
              not v["abort"] and abs(v["maxRequestGapSec"] - 1896.826) < 0.01, str(v["maxRequestGapSec"]))
        parity("real C-arm replay", extracted)
    else:
        check("archived C-arm replay (SKIPPED — probe tgz not present)", True)

    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
