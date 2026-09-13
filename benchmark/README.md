# sol-zcode Terminal-Bench 4.0 dual-arm benchmark (P3)

Evaluates the sol-zcode plugin on the real Terminal-Bench 4.0 task set under
Harbor, comparing two arms that differ ONLY in `plugins.options`:

| arm | plugins.options | meaning |
|---|---|---|
| `control` | all five mechanisms `false` (+ gate `false`) | plugin installed, zero behavior (C2) |
| `treatment` | actionFusion / observationPack / evidenceReducer / onlineCompact / trajectory `true`, gate `false` | five mechanisms on; the exit-2 gate is a separate ablation arm, not treatment (DESIGN §7) |

Everything else — task image, prompt protocol, model
(`builtin:bigmodel-coding-plan/GLM-5.3-Flash`), timeout, verifier — is
identical between arms.

## Layout

```
benchmark/
  agent/zcode_agent.py     ZcodeAgent (Harbor BaseInstalledAgent): install/run/populate
  bench_config.py          arm options + shared constants (no harbor import needed)
  pricing.py               GLM-5.3-Flash pricing table (sources + date pinned)
  rate_limit_guard.py      rate-limit degeneracy criterion: logic + offline audit CLI
  run.py                   freeze / run / probe / report / status
  assets/rl-watchdog.mjs   in-container watchdog enforcing the criterion (MAJOR-1)
  bin/verify-tasks.py      per-task.toml GPU verification -> tasks.json
  bin/fetch-node.mjs       pin+fetch node v22.23.2 linux tarballs (arm64+x64)
  bin/test-rate-limit-guard.py  offline self-check for the criterion (no model)
  assets/                  provider-template.json (apiKey-stripped), write-cli-config.mjs,
                           node/*.tar.xz (gitignored, sha256 in freeze manifest)
  tasks.json               verified 66-total / 3-GPU / 63-CPU classification
  dataset/                 exported TB 4.0.0 task sources (gitignored; harbor uses its own cache)
  freeze/                  immutable manifests (commit these)
  results/ledger.jsonl     append-only ledger (commit this)
  probe/                   probe evidence snapshots
  jobs/                    harbor job outputs (gitignored — may contain env values)
  spike/                   container feasibility spike evidence + install rehearsal script
```

## Prerequisites

- macOS + OrbStack (docker), the ZCode app at
  `/Applications/ZCode.app` (zcode.cjs is read from it; override with
  `SOL_BENCH_ZCODE_CJS`), host `~/.zcode/v2/config.json` with the
  `builtin:bigmodel-coding-plan` provider logged in (read-only key source).
- Python venv with harbor 0.23.0 (already at `benchmark/.venv`) and node on
  the host for helper scripts.

```bash
cd benchmark
.venv/bin/pip install harbor==0.23.0          # only if .venv is missing
node bin/fetch-node.mjs                        # node tarballs (once; sha256-pinned)
.venv/bin/python bin/verify-tasks.py           # re-verify 66/3/63 from task.toml files
```

## Probe (single task, both arms — no ledger, no freeze consumed)

```bash
python3 run.py probe --task html-js-filter --arms control,treatment --cap-sec 3600
```

- Runs one Harbor job with the task × both agent configs (interleaved).
- Evidence lands in `probe/<task>-<ts>/<arm>/`: `zcode.txt` (captured
  `--json`), `sol-data.tgz` (container plugin data root: trajectory/ledger/
  occ state), `usage.json`, plus `summary.json`.
- `--cap-sec` bounds each arm's in-band agent timeout (default 3600 for
  probes; the full-run default is the task-level 8 h).
- Costs one real model session per arm.

## Full run (63 CPU tasks × 2 arms)

```bash
python3 run.py freeze --label <label>                 # 1. immutable manifest
python3 run.py status --freeze <id>                   # 2. what is left
python3 run.py run --freeze <id> -n 4                 # 3. both arms, interleaved
python3 run.py run --freeze <id> --retry-failed       #    (optional) re-attempt exception-ed trials
python3 run.py report --freeze-id <id>                # 4. ledger-derived report
```

- `run` refuses if the plugin tree or zcode.cjs drifted from the freeze
  (refreeze instead of running a mutant).
- Resume (automatic): re-invoke `run`; combos already present in the ledger
  are skipped.
- Kill/restart boundary (actual semantics, as observed in the P3 probes):
  killing the runner does not lose finished trials — each trial's
  `result.json`, logs, and verifier verdict live on disk under
  `jobs/<job>/<trial>/` — but the ledger line is only appended after the
  whole harbor job returns, so trials that finished inside a killed job are
  not auto-ledgered. Re-starting is safe (a re-run never produces wrong
  data), and there are two ways to account for the orphaned trials: re-run
  them (burns quota again; the ledger only knows what it has), or manually
  salvage — append the ledger line from the trial's own `result.json` and
  copy the evidence, which is exactly how the killed A-arm probe was
  recovered (no quota re-burned; the verifier had already run inside the
  job). There is no committed salvage script; this step is manual.
- Concurrency: `-n` caps concurrent trials across BOTH arms (default 4,
  OrbStack ceiling; the two arms of one task may run simultaneously).
- Unattended-safe (bounded): every finished trial appends exactly one ledger
  line (task, arm, sessionId, usage, cost, wall, verifier reward, exception)
  when the runner survives to job completion; report derives only from the
  ledger. Hung trials are aborted by the rate-limit guard below without an
  operator watching; the control arm is the remaining blind spot (see
  boundary note).

## Cost and time budget (measured from the 2026-09-13 three-arm probe)

Pricing: GLM-5.3-Flash per 1M tokens — input $0.15, output $0.50, cached
input $0.03 (Z.ai international list, 2026-09-13; CN list ¥0.8/¥2.8/¥0.23 —
see `pricing.py`). Actual consumption goes through the coding-plan quota;
USD here is comparable accounting, not an invoice.

Measured per-task, per-arm (probe task `html-js-filter`, N=1; evidence in
`probe/*/usage.json`, cross-checked by the P3 audit):

| arm | cost | wall | model requests |
|---|---|---|---|
| control | $0.3464 | 3,184 s (53.1 min) | 77 |
| treatment | $0.2722 | 3,668 s (61.1 min)¹ | 50 |
| gate (ablation arm, not in the default full run) | $0.1890 | 3,578 s (59.6 min)¹ | 30 |
| **both default arms / task** | **$0.6186** | **6,852 s serial** | 127 |

¹ Walls include one 21–32 min provider throttle stall per mechanism arm
(observed: C first request 1,897 s, B one gap 1,287 s); net working time
≈40 min (B) / ≈28 min (C).

Full-run extrapolation (63 CPU tasks × 2 arms; two tiers, both carry
rate-limit uncertainty):

| tier | cost (list-price accounting) | wall | uncertainty |
|---|---|---|---|
| serial | ≈$39 (63 × $0.6186) | ≈120 h (63 × 6,852 s) | linear N=1 extrapolation |
| `-n 4` | ≈$39 (cost does not drop with concurrency) | ideal ≈30 h; realistically **~1–2 days** | throttle frequency may rise with concurrency; treatment-side request collapse should partly offset it |

These exceed the early DESIGN §7 estimate (~$10) because the probe task ran
heavy (77 requests in control); SoL-OpenCode saw ~$0.08–0.12 per task-arm on
a similarly priced model, so the true full-run mean may land lower — budget
to the table's ceiling, replace with measured means as the ledger fills.

## Rate-limit degeneracy guard (audit MAJOR-1, 2026-09-14)

A single model request observed >600 s, 3 times in a row, aborts the trial —
`exceptionType=RateLimitDegeneracyError` in the ledger, with the observed gap
list attached as `rateLimitAbort` — instead of silently burning wall and quota
until the in-band cap. The in-flight request counts as soon as it crosses the
threshold, so a fully hung third request aborts at ~30 min of stall.

- Implementation chain: `assets/rl-watchdog.mjs` wraps the agent inside the
  container (spawns it in its own process group, tees output to `zcode.txt`,
  kills the group and writes `zcode.txt.rl-abort.json` next to it);
  `agent/zcode_agent.py` turns the marker into the exception;
  `run.py` lifts the evidence into the ledger line. The watchdog runs
  in-container — it does not depend on the host runner or any foreground
  process being alive.
- Observation source: the plugin trajectory JSONL. Single-model-request
  duration is observed as the gap between consecutive trajectory events,
  classified by the earlier event (gap after `pre_tool` = tool runtime,
  excluded; other gaps = model request). This is the same classification the
  independent audit used — it reproduces the probe numbers exactly (C arm
  1,896.8 s / 170.5 s; B arm 1,286.7 s).
- Boundary: arms with `trajectory=false` (control) write no trajectory — the
  watchdog runs blind there and fails open; the in-band cap is the only
  bound on the control arm. Aborted trials count as errored in the ledger
  (`--retry-failed` re-attempts them).
- Tunables (env vars, read at invocation, defaults): `SOL_BENCH_RL_ABORT_SEC`
  (600), `SOL_BENCH_RL_CONSECUTIVE` (3), `SOL_BENCH_RL_POLL_SEC` (30). The
  values in effect are baked into the container command line, so each
  job.log records exactly what ran.
- Offline recompute (no model, no container):
  `python3 rate_limit_guard.py <trajectory.jsonl | sol-data.tgz>` exits 3
  when the criterion is met. Self-check — synthetic fixtures including a
  3-consecutive->10-min abort sequence, node/py parity, and the live
  kill/marker/exit-code path — `python3 bin/test-rate-limit-guard.py`.

## Failure handling

| symptom | where to look | fix |
|---|---|---|
| agent install fails | `jobs/<job>/<trial>/agent/setup/` + trial.log | check node path (`/usr/local/bin/node`), bundle extract; rerun probe |
| model auth error | `zcode.txt` in trial agent dir | host `~/.zcode/v2/config.json` key expired (re-login in the app) or pass `--ae ZCODE_BIGMODEL_KEY=...` |
| `json-parse-failed` in ledger | trial `agent/zcode.txt` | zcode printed no `--json` block (crash/kill); inspect stderr in the same file |
| trial timeout (exit 124 / `Agent execution timed out`) | ledger `exceptionType` | expected on hard tasks (8 h cap); re-run with `--retry-failed` if wanted |
| `RateLimitDegeneracyError` in ledger | trial `agent/zcode.txt.rl-abort.json` (gap evidence) | provider throttling hung 3 consecutive requests; the trial was aborted instead of burning the cap; re-run with `--retry-failed` if wanted (control arm cannot hit this — no trajectory to observe) |
| plugin tree drifted | `run.py run` guard | intentional change → `freeze` a new manifest; never edit an existing one |
| dataset/registry network errors | harbor stderr | re-run; dataset is cached under `~/.cache/harbor` after first pull |

## Discipline notes

- Freeze manifests and the ledger are append-only and meant to be committed;
  `jobs/` is gitignored (job configs record env templates) — never commit it.
- Probe results are stamped and never enter the ledger; a probe cannot be
  mistaken for an evaluation.
- The apiKey never appears in: the repo, freeze manifests, argv, or harbor
  logs (env is redacted). It reaches containers only via docker-exec env.
- Tasks: 66 total, 3 GPU (`jax-speedrun-gpu`, `fp8-rmsnorm-gemm`,
  `math-eval-grader`), 63 CPU-only — verified per `task.toml`, not by name
  (`sglang-qwen-burst` / `vllm-deepseek-streaming` declare `gpus=0` and are
  in the CPU set).
