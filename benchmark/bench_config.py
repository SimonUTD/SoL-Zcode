"""Benchmark-wide constants shared by the agent (needs harbor) and the
runner (must not require harbor to be importable for freeze/report/status)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

BENCH_ROOT = Path(__file__).resolve().parent
REPO_ROOT = BENCH_ROOT.parent

DEFAULT_ZCODE_CJS = Path(
    os.environ.get(
        "SOL_BENCH_ZCODE_CJS",
        "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    )
)
CONTAINER_ROOT = "/opt/sol-bench"
MARKETPLACE = "sol-zcode-bench"
PLUGIN_ID = "sol-zcode@{MARKETPLACE}".replace("{MARKETPLACE}", MARKETPLACE)
DEFAULT_MODEL = "builtin:bigmodel-coding-plan/GLM-5.3-Flash"

# Self-managed cap on top of Harbor's trial-level agent timeout (task.toml
# [agent] timeout_sec = 28800 for every TB 4.0 task).
SELF_CAP_SEC = int(os.environ.get("SOL_BENCH_AGENT_CAP_SEC", "28800"))

# Rate-limit degeneracy abort criterion (audit MAJOR-1, implemented 2026-09-14):
# a single model request OBSERVED to take > RL_ABORT_SEC, RL_CONSECUTIVE times
# in a row -> abort the trial (exceptionType=RateLimitDegeneracyError) instead
# of silently burning wall/quota until the in-band cap. Observation source is
# the plugin trajectory JSONL (see rate_limit_guard.py); the in-flight request
# counts as soon as it crosses the threshold, so a fully hung third request
# still aborts. Enforced in-container by assets/rl-watchdog.mjs — it does not
# depend on the host runner being alive. Arms with trajectory=false (control)
# write no trajectory and run watchdog-blind (fail-open, cap only).
RL_ABORT_SEC = int(os.environ.get("SOL_BENCH_RL_ABORT_SEC", "600"))
RL_CONSECUTIVE = int(os.environ.get("SOL_BENCH_RL_CONSECUTIVE", "3"))
RL_POLL_SEC = int(os.environ.get("SOL_BENCH_RL_POLL_SEC", "30"))
# Written next to zcode.txt by the watchdog when it aborts; lifted into the
# ledger line by run.py (parse_job_dir) as evidence.
RL_ABORT_MARKER = "zcode.txt.rl-abort.json"

ARM_OPTIONS: dict[str, dict[str, Any]] = {
    # control: plugin installed but every mechanism off (zero behavior, C2)
    "control": {
        "actionFusion": False,
        "observationPack": False,
        "evidenceReducer": False,
        "onlineCompact": False,
        "trajectory": False,
        "actionFusionGate": False,
        "reducerModel": "",
    },
    # treatment: five mechanisms on, gate OFF (DESIGN §7 — the exit-2 gate is
    # a separate ablation arm, not part of treatment)
    "treatment": {
        "actionFusion": True,
        "observationPack": True,
        "evidenceReducer": True,
        "onlineCompact": True,
        "trajectory": True,
        "actionFusionGate": False,
        "reducerModel": "",
    },
    # gate ablation (probe arm C, 2026-09-13 coordinator order): treatment +
    # the hard gate — native Write/Edit blocked via exit-2 so the model must
    # use sol_write/sol_edit. Observability: gated attempts appear as
    # trajectory pre_tool(Write|Edit) entries with no matching post_tool
    # (and PostToolUseFailure -> tool_failure entries when the host emits it).
    "gate": {
        "actionFusion": True,
        "observationPack": True,
        "evidenceReducer": True,
        "onlineCompact": True,
        "trajectory": True,
        "actionFusionGate": True,
        "reducerModel": "",
    },
}
