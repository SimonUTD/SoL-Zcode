# Container feasibility spike — results (2026-09-13)

Question (DESIGN §7 m7, PLAN risk table): can the mac app-bundle `zcode.cjs`
run headless inside a Linux container on this OrbStack host?

## Conclusion: FEASIBLE — no fallback route needed

| check | result | evidence |
|---|---|---|
| zcode.cjs is portable pure-JS esbuild bundle | yes | `version` = 0.16.5 on linux/arm64, node v25.9.0 AND v22.23.2 |
| `--prompt --mode yolo --json` model roundtrip | yes | `response: "PONG"`, exit 0, both node versions (`pong-node25.txt`, `pong-node22.txt`) |
| usage block emitted on linux (G4) | yes | input 9332 / output 4-20 / `cacheReadTokens` 64; `totalTokens = input+output` proves input INCLUDES cached tokens |
| container -> open.bigmodel.cn network | yes | direct fetch → HTTP 200 (no proxy needed) |
| native deps | none required | only zcode.cjs was mounted; app-bundle native pkgs (koffi/sharp) live in optional plugin packages not used by the CLI |
| node >= 22 | both 22 and 25 work | deliverable said ≥22; G1 said ≥25 — 22.23.2 empirically OK; benchmark pins bundled v22.23.2 tarballs (arm64+x64) |
| plugin install path in pristine debian | yes | `spike/install-dryrun.sh`: config write (G2 formula), install-plugin.mjs, `plugins list` shows 7 hooks + `plugin:sol-zcode:sol` MCP |
| gotcha found & fixed | PATH | hook/MCP configs invoke bare `node` from non-login shells; a PATH edit is not enough → agent symlinks the pinned node into `/usr/local/bin/node` |

## Cost of the spike

2 prompt-level model calls (PONG × 2) ≈ 18.7k input tokens total.

## What would have triggered the fallback (not triggered)

- native module load errors (`.node` binaries for darwin) → PLAN risk row 2
  (mac-host zcode + container-only task env).
- network block to open.bigmodel.cn → proxy wiring.
