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
  run.py                   freeze / run / probe / report / status
  bin/verify-tasks.py      per-task.toml GPU verification -> tasks.json
  bin/fetch-node.mjs       pin+fetch node v22.23.2 linux tarballs (arm64+x64)
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
- Resume: re-invoke `run`; combos already present in the ledger are skipped.
  Kill/restart safe — harbor trials are independent containers.
- Concurrency: `-n` caps concurrent trials across BOTH arms (default 4,
  OrbStack ceiling; the two arms of one task may run simultaneously).
- Unattended-safe: every finished trial appends exactly one ledger line
  (task, arm, sessionId, usage, cost, wall, verifier reward, exception);
  report derives only from the ledger.

## Cost and time budget (measured, updated per probe)

Pricing: GLM-5.3-Flash per 1M tokens — input $0.15, output $0.50, cached
input $0.03 (Z.ai international list, 2026-09-13; CN list ¥0.8/¥2.8/¥0.23 —
see `pricing.py`). Actual consumption goes through the coding-plan quota;
USD here is comparable accounting, not an invoice.

| scope | cost (est.) | wall @ -n 4 (est.) |
|---|---|---|
| probe (1 task × 2 arms) | see `probe/*/summary.json` | ~1 h |
| full 63 × 2 | extrapolate: per-arm cost × 126 | ~1–2 days |

Fill these from the probe numbers before the full run; do not trust
estimates over measurements (SoL-OpenCode saw ~$0.08–0.12 per task-arm on a
similarly priced model; zcode+GLM may differ).

## Failure handling

| symptom | where to look | fix |
|---|---|---|
| agent install fails | `jobs/<job>/<trial>/agent/setup/` + trial.log | check node path (`/usr/local/bin/node`), bundle extract; rerun probe |
| model auth error | `zcode.txt` in trial agent dir | host `~/.zcode/v2/config.json` key expired (re-login in the app) or pass `--ae ZCODE_BIGMODEL_KEY=...` |
| `json-parse-failed` in ledger | trial `agent/zcode.txt` | zcode printed no `--json` block (crash/kill); inspect stderr in the same file |
| trial timeout (exit 124 / `Agent execution timed out`) | ledger `exceptionType` | expected on hard tasks (8 h cap); re-run with `--retry-failed` if wanted |
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
