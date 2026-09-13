#!/usr/bin/env python3
"""Verify the TB 4.0.0 task set per-task.toml and emit benchmark/tasks.json.

GPU classification reads BOTH [environment].gpus (agent env) and
[verifier.environment].gpus (verifier env) — a task is GPU iff either >= 1.
Never infers from task names (sglang-qwen-burst / vllm-deepseek-streaming
sound GPU but declare gpus=0 and are included).
"""
import hashlib
import json
import sys
from pathlib import Path

import tomllib

DATASET = Path(__file__).resolve().parent.parent / "dataset" / "terminal-bench"
OUT = Path(__file__).resolve().parent.parent / "tasks.json"

def main() -> int:
    tasks = []
    for task_dir in sorted(p for p in DATASET.iterdir() if p.is_dir()):
        toml_path = task_dir / "task.toml"
        if not toml_path.exists():
            print(f"SKIP (no task.toml): {task_dir.name}", file=sys.stderr)
            continue
        with open(toml_path, "rb") as fh:
            doc = tomllib.load(fh)
        env = doc.get("environment", {}) or {}
        venv = doc.get("verifier", {}).get("environment", {}) or {}
        meta = doc.get("metadata", {}) or {}
        gpu_agent = int(env.get("gpus", 0) or 0)
        gpu_verifier = int(venv.get("gpus", 0) or 0)
        tasks.append({
            "name": doc["task"]["name"].split("/")[-1],
            "full_name": doc["task"]["name"],
            "gpu_agent": gpu_agent,
            "gpu_verifier": gpu_verifier,
            "is_gpu": gpu_agent >= 1 or gpu_verifier >= 1,
            "cpus": env.get("cpus"),
            "memory_mb": env.get("memory_mb"),
            "agent_timeout_sec": doc.get("agent", {}).get("timeout_sec"),
            "verifier_timeout_sec": doc.get("verifier", {}).get("timeout_sec"),
            "verifier_environment_mode": doc.get("verifier", {}).get("environment_mode"),
            "agent_image": env.get("docker_image"),
            "verifier_image": venv.get("docker_image"),
            "category": meta.get("category"),
            "expert_hours": meta.get("expert_time_estimate_hours"),
        })
    cpu = [t["name"] for t in tasks if not t["is_gpu"]]
    gpu = [t["name"] for t in tasks if t["is_gpu"]]
    cpu.sort(); gpu.sort()
    listing = json.dumps({"cpu": cpu, "gpu": gpu}, sort_keys=True).encode()
    payload = {
        "dataset": "terminal-bench/terminal-bench@4.0.0",
        "harbor_version": "0.23.0",
        "verified_at": Path(__file__).stat().st_mtime and __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "total": len(tasks),
        "gpu_tasks": gpu,
        "cpu_tasks": cpu,
        "method": "per task.toml parse (tomllib): is_gpu = environment.gpus>=1 or verifier.environment.gpus>=1",
        "tasks_list_sha256": hashlib.sha256(listing).hexdigest(),
        "tasks": tasks,
    }
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"total={len(tasks)} gpu={len(gpu)} cpu={len(cpu)}")
    print("gpu tasks:", ", ".join(gpu))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
