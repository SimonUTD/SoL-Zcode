"""Rate-limit degeneracy abort criterion — shared logic + offline audit CLI.

Audit MAJOR-1 (2026-09-14): the P3 three-arm probe claimed a stop criterion
("abort when a single model request exceeds 10 min, 3 times in a row") that
existed only as an operator protocol. This module is the code implementation.

Criterion
  A single model request OBSERVED to last > ``abort_sec`` (default 600 s),
  ``consecutive`` (default 3) times in a row -> the trial is aborted and
  booked as errored (``exceptionType=RateLimitDegeneracyError`` via
  agent/zcode_agent.py), never silently continued. The observation counts an
  in-flight request as soon as its elapsed time crosses the threshold, so a
  fully hung third request still aborts at ~3 x abort_sec of stall instead of
  waiting out the in-band cap.

Observation source
  The sol-zcode plugin trajectory JSONL (one line per event, ISO-8601 ``ts``,
  ``event`` in {session_start, user_prompt, pre_tool, post_tool, stop}),
  written in-container for arms with the trajectory mechanism ON. Single-model
  request duration is OBSERVED as the wall time between consecutive events,
  classified by the earlier event's kind:

    gap after pre_tool      -> tool execution time (NOT a model request)
    gap after anything else -> model request (thinking + provider
                               queueing / rate-limit stall)

  This is the same classification the independent audit used; it reproduces
  the probe numbers exactly (C arm first request 1,896.8 s and next-max
  170.5 s; B arm 1,286.7 s). A pending gap after a ``stop`` event is never a
  request (the run already finished).

Known boundaries (documented in benchmark/README.md)
  - Arms with ``trajectory=false`` (control) write no trajectory: the
    in-container watchdog runs blind and fails open; the in-band cap is the
    only bound there.
  - Post-hoc evaluation of a finished trajectory sees completed gaps only
    (the live pending gap is unknowable after the fact). A run aborted live
    carries its evidence in the rl-abort marker file instead.

CLI (offline recompute — no model, no container):
  python3 rate_limit_guard.py <trajectory.jsonl | sol-data.tgz>... \
      [--abort-sec 600] [--consecutive 3]

  Accepts raw trajectory files or a probe ``sol-data.tgz`` (every
  ``*/store/trajectory/*.jsonl`` member inside is evaluated). Exit code 0 =
  criterion not met, 3 = criterion met, 2 = usage error.

The container-side watchdog (benchmark/assets/rl-watchdog.mjs) implements the
identical classification; parity on shared fixtures is asserted by
bin/test-rate-limit-guard.py.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_ABORT_SEC = 600
DEFAULT_CONSECUTIVE = 3
TRAJECTORY_MEMBER_SUFFIX = "store/trajectory/"


# ------------------------------------------------------------------ parsing


def _parse_ts(value: str) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def parse_events(text: str) -> list[dict[str, Any]]:
    """Tolerant JSONL reader: keeps only lines with a parsable ts."""
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict) and _parse_ts(record.get("ts")) is not None:
            events.append(record)
    return events


# ------------------------------------------------------------- classification


@dataclass
class Gap:
    from_ts: str
    to_ts: str | None  # None => pending (in-flight) observation
    seconds: float
    kind: str  # "request" | "tool-exec" | "none"
    from_event: str
    to_event: str | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "fromTs": self.from_ts,
            "toTs": self.to_ts,
            "seconds": round(self.seconds, 3),
            "kind": self.kind,
            "fromEvent": self.from_event,
            "toEvent": self.to_event,
            "pending": self.to_ts is None,
        }


def _gap_kind(from_event: str) -> str:
    return "tool-exec" if from_event == "pre_tool" else "request"


def classify_gaps(
    events: list[dict[str, Any]], now: datetime | None = None
) -> list[Gap]:
    """Adjacent-event gaps, each attributed to a model request or a tool
    execution. With ``now``, a final pending gap is appended for the time
    since the last event — classified like a gap after that event, except a
    pending gap after ``stop`` is dropped (run already finished)."""
    gaps: list[Gap] = []
    for prev, nxt in zip(events, events[1:]):
        a, b = _parse_ts(prev["ts"]), _parse_ts(nxt["ts"])  # type: ignore[index]
        seconds = (b - a).total_seconds()  # type: ignore[operator]
        gaps.append(
            Gap(
                from_ts=prev["ts"],
                to_ts=nxt["ts"],
                seconds=seconds,
                kind=_gap_kind(str(prev.get("event"))),
                from_event=str(prev.get("event")),
                to_event=str(nxt.get("event")),
            )
        )
    if now is not None and events:
        last = events[-1]
        last_event = str(last.get("event"))
        end = _parse_ts(last["ts"])
        pending = (now - end).total_seconds()  # type: ignore[operator]
        if last_event != "stop" and pending > 0:
            gaps.append(
                Gap(
                    from_ts=last["ts"],
                    to_ts=None,
                    seconds=pending,
                    kind=_gap_kind(last_event),
                    from_event=last_event,
                    to_event=None,
                )
            )
    return gaps


def evaluate(
    events: list[dict[str, Any]],
    *,
    abort_sec: int = DEFAULT_ABORT_SEC,
    consecutive: int = DEFAULT_CONSECUTIVE,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Verdict for one trajectory. ``abort`` iff the trailing run of
    request-kind gaps each strictly > ``abort_sec`` (pending included) reaches
    ``consecutive``. Also reports the max request/tool gaps so the output
    stays comparable with the audit's adjacent-gap methodology."""
    gaps = classify_gaps(events, now=now)
    request_gaps = [g for g in gaps if g.kind == "request"]
    trailing: list[Gap] = []
    for gap in reversed(request_gaps):
        if gap.seconds > abort_sec:
            trailing.append(gap)
        else:
            break
    trailing.reverse()
    max_streak = streak = 0
    for gap in request_gaps:
        streak = streak + 1 if gap.seconds > abort_sec else 0
        max_streak = max(max_streak, streak)

    def _max(kind: str) -> float | None:
        values = [g.seconds for g in gaps if g.kind == kind]
        return max(values) if values else None

    return {
        "abort": len(trailing) >= consecutive,
        "abortSec": abort_sec,
        "consecutive": consecutive,
        "streak": len(trailing),
        "maxStreak": max_streak,
        "events": len(events),
        "maxRequestGapSec": round(_max("request"), 3) if _max("request") is not None else None,
        "maxToolGapSec": round(_max("tool-exec"), 3) if _max("tool-exec") is not None else None,
        "evidence": [g.as_dict() for g in trailing],
    }


# ------------------------------------------------------------------ file CLI


def _iter_inputs(paths: list[Path]):
    for path in paths:
        if path.name.endswith((".tgz", ".tar.gz")):
            with tarfile.open(path, "r:gz") as tar:
                for member in tar.getmembers():
                    if TRAJECTORY_MEMBER_SUFFIX in member.name and member.name.endswith(
                        ".jsonl"
                    ):
                        handle = tar.extractfile(member)
                        if handle is not None:
                            yield f"{path}!{member.name}", io.TextIOWrapper(
                                handle, encoding="utf-8", errors="replace"
                            ).read()
        else:
            yield str(path), path.read_text(errors="replace")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        prog="rate_limit_guard.py",
    )
    parser.add_argument("inputs", nargs="+", help="trajectory .jsonl or sol-data.tgz")
    parser.add_argument("--abort-sec", type=int, default=DEFAULT_ABORT_SEC)
    parser.add_argument("--consecutive", type=int, default=DEFAULT_CONSECUTIVE)
    args = parser.parse_args(argv)

    any_abort = False
    for label, text in _iter_inputs([Path(p) for p in args.inputs]):
        verdict = evaluate(
            parse_events(text),
            abort_sec=args.abort_sec,
            consecutive=args.consecutive,
        )
        any_abort = any_abort or verdict["abort"]
        flag = "ABORT" if verdict["abort"] else "ok"
        print(
            f"[{flag}] {label}: events={verdict['events']} "
            f"streak={verdict['streak']}/{args.consecutive} "
            f"maxRequestGap={verdict['maxRequestGapSec']}s "
            f"maxToolGap={verdict['maxToolGapSec']}s"
        )
        for item in verdict["evidence"]:
            print(
                f"    {item['fromTs']} -> {item['toTs'] or '(pending)'} "
                f"{item['seconds']}s ({item['kind']})"
            )
    return 3 if any_abort else 0


if __name__ == "__main__":
    sys.exit(main())
