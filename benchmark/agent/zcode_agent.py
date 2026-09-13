"""ZcodeAgent: Harbor custom agent driving zcode.cjs headless inside task containers.

Registered with Harbor as an import-path agent:

    harbor run --agent agent.zcode_agent:ZcodeAgent --ak zcode_arm=<control|treatment>

Design (docs/DESIGN.md §7, docs/RESEARCH/terminal-bench-4.md §4):
  install()  node >=22 (bundled pinned tarball, else nvm) -> upload bundle
             (zcode.cjs + plugin tree + install-plugin.mjs + assets) ->
             install-plugin.mjs with the arm's plugins.options (REPLACE
             semantics, G19) -> write G2 three-part cli config; the apiKey
             comes from --ae ZCODE_BIGMODEL_KEY or the host's
             ~/.zcode/v2/config.json (read-only) and reaches the container
             only via exec env — never argv, never logs, never the image.
  run()      node zcode.cjs --prompt <instruction> --mode yolo --json
             (G3/G18: --max-turns/--allowed-tools are broken; timeout is the
             trial-level agent timeout plus an in-band `timeout` cap), with
             SOL_ZCODE_ZCODE_BIN pinned (G22 — headless zcode renames its
             process, ps-sniffing fails). The agent is wrapped by
             rl-watchdog.mjs (audit MAJOR-1): 3 consecutive model requests
             each > RL_ABORT_SEC observed from the plugin trajectory ->
             kill the process group + RateLimitDegeneracyError, so the trial
             is booked as errored instead of silently burning the cap.
             Blind/fail-open on arms with trajectory=false (no observation
             source). The watchdog runs inside the container, independent
             of the host runner.
  populate_context_post_run()  parse the captured --json (G4 usage block:
             inputTokens includes cached tokens) back into AgentContext.

Arm differences are ONLY plugins.options["sol-zcode@<marketplace>"]:
  control   plugin installed, every mechanism off (zero behavior, C2)
  treatment five mechanisms on, actionFusionGate OFF (DESIGN §7 — the gate is
            a separate ablation, not part of the treatment arm)

File-copy safety inside trials: the bundle tarball is built once per process
(module-level cache, asyncio event loop makes the sync build atomic) so
concurrent trials share one build; installs are idempotent (rmSync in
install-plugin.mjs, REPLACE options).
"""

from __future__ import annotations

import json
import os
import shlex
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any, override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

BENCH_ROOT = Path(__file__).resolve().parent.parent
# Make sibling modules importable however this module is loaded.
if str(BENCH_ROOT) not in sys.path:
    sys.path.insert(0, str(BENCH_ROOT))
from bench_config import (  # noqa: E402
    ARM_OPTIONS,
    CONTAINER_ROOT,
    DEFAULT_MODEL,
    DEFAULT_ZCODE_CJS,
    MARKETPLACE,
    PLUGIN_ID,
    RL_ABORT_MARKER,
    RL_ABORT_SEC,
    RL_CONSECUTIVE,
    RL_POLL_SEC,
    SELF_CAP_SEC,
)
from pricing import cost_usd  # noqa: E402

REPO_ROOT = BENCH_ROOT.parent

_bundle_path: str | None = None


class RateLimitDegeneracyError(NonZeroAgentExitCodeError):
    """Audit MAJOR-1: 3 consecutive model requests each > RL_ABORT_SEC.

    Raised after the in-container watchdog (assets/rl-watchdog.mjs) kills the
    agent process group. Subclassing NonZeroAgentExitCodeError keeps Harbor's
    timeout accounting path: the trial is recorded with exceptionType
    "RateLimitDegeneracyError" and the verifier still runs, so the ledger
    shows the true cause instead of a silent burn to the in-band cap.
    """


def _host_api_key() -> str | None:
    """Read the provider apiKey from the host's app config (read-only).

    Precedence: explicit ZCODE_BIGMODEL_KEY (--ae) beats the host v2 config.
    The host file is the app's own logged-in credential — the benchmark never
    stores it anywhere; it is injected into the container exec env only.
    """
    path = Path.home() / ".zcode" / "v2" / "config.json"
    try:
        cfg = json.loads(path.read_text())
        entry = cfg.get("provider", {}).get("builtin:bigmodel-coding-plan", {})
        return entry.get("options", {}).get("apiKey") or None
    except (OSError, json.JSONDecodeError):
        return None


def build_bundle() -> str:
    """Build the /opt/sol-bench payload tarball once per process.

    Contents: zcode.cjs, the plugin tree at its current source state, the
    repo's install-plugin.mjs, the provider template + config writer, and the
    pinned node tarballs (both arches) when present. Cached at module level —
    concurrent trials in one Harbor process share the build.
    """
    global _bundle_path
    if _bundle_path is not None:
        return _bundle_path

    zcode_cjs = DEFAULT_ZCODE_CJS
    if not zcode_cjs.exists():
        raise FileNotFoundError(
            f"zcode.cjs not found at {zcode_cjs} (set SOL_BENCH_ZCODE_CJS)"
        )

    tmp = tempfile.NamedTemporaryFile(
        prefix="sol-bench-bundle-", suffix=".tar.gz", delete=False
    )
    tmp.close()
    with tarfile.open(tmp.name, "w:gz") as tar:

        def add_dir(path: Path, arcname: str) -> None:
            for entry in sorted(path.rglob("*")):
                if entry.is_dir():
                    continue
                rel = entry.relative_to(path)
                # Benchmark plugin tree = current source state; tests and
                # node_modules never ship into containers.
                if rel.parts[0] in ("tests", "node_modules") or "node_modules" in rel.parts:
                    continue
                tar.add(entry, arcname=f"{arcname}/{rel.as_posix()}")

        tar.add(zcode_cjs, arcname="zcode.cjs")
        add_dir(REPO_ROOT / "plugin", "plugin")
        tar.add(REPO_ROOT / "scripts" / "install-plugin.mjs", arcname="install-plugin.mjs")
        tar.add(BENCH_ROOT / "assets" / "provider-template.json", arcname="provider-template.json")
        tar.add(BENCH_ROOT / "assets" / "write-cli-config.mjs", arcname="write-cli-config.mjs")
        # Bench infra (not freeze-hashed, same as write-cli-config.mjs): the
        # in-container rate-limit watchdog wrapped around the agent by run().
        tar.add(BENCH_ROOT / "assets" / "rl-watchdog.mjs", arcname="rl-watchdog.mjs")
        node_dir = BENCH_ROOT / "assets" / "node"
        if node_dir.is_dir():
            for tarball in sorted(node_dir.glob("node-v*-linux-*.tar.xz")):
                tar.add(tarball, arcname=f"node/{tarball.name}")

    _bundle_path = tmp.name
    return _bundle_path


class ZcodeAgent(BaseInstalledAgent):
    """Headless zcode.cjs agent; `zcode_arm` kwarg selects the plugins.options."""

    capabilities = AgentCapabilities()  # no atif/resume: plain installed agent
    _OUTPUT_FILENAME = "zcode.txt"

    # Node is provided by the bundled tarball when possible (deterministic,
    # offline); nvm is the fallback for unexpected architectures.
    NVM_FALLBACK = (
        "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh "
        "| env -u NODE_VERSION bash && "
        'export NVM_DIR="$HOME/.nvm" && \\. "$NVM_DIR/nvm.sh" && '
        "nvm install 22 && nvm alias default 22 && npm -v"
    )

    def __init__(self, *args: Any, zcode_arm: str = "control", **kwargs: Any) -> None:
        if zcode_arm not in ARM_OPTIONS:
            raise ValueError(
                f"zcode_arm must be one of {sorted(ARM_OPTIONS)}, got {zcode_arm!r}"
            )
        super().__init__(*args, **kwargs)
        self.zcode_arm = zcode_arm
        self._run_started: float | None = None
        self._run_finished: float | None = None

    @staticmethod
    @override
    def name() -> str:
        return "zcode"

    @override
    def get_version_command(self) -> str | None:
        return f"node {CONTAINER_ROOT}/zcode.cjs version"

    def _model(self) -> str:
        # `harbor run --model` overrides the provider-template default when
        # the caller pins one; both arms always share the same model.
        return self.model_name or DEFAULT_MODEL

    # ------------------------------------------------------------------ install
    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "coreutils", "xz", "ca_certificates")
        )
        await self._upload_bundle(environment)
        await self._node_env_setup(environment)
        await self._write_cli_config(environment)
        await self._install_plugin(environment)
        await self._smoke_check(environment)

    async def _upload_bundle(self, environment: BaseEnvironment) -> None:
        bundle = build_bundle()
        await environment.upload_file(bundle, "/tmp/sol-bench-bundle.tar.gz")
        user = environment.default_user
        chown = f"chown -R {shlex.quote(str(user))} {CONTAINER_ROOT}" if user else "true"
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {CONTAINER_ROOT} && "
                f"tar -xzf /tmp/sol-bench-bundle.tar.gz -C {CONTAINER_ROOT} && "
                f"chmod 755 {CONTAINER_ROOT}/zcode.cjs {CONTAINER_ROOT}/*.mjs && "
                f"{chown} && rm -f /tmp/sol-bench-bundle.tar.gz && "
                f"ls -la {CONTAINER_ROOT}"
            ),
        )

    async def _node_env_setup(self, environment: BaseEnvironment) -> None:
        """Make `node >=22` resolvable EVERYWHERE in the container.

        Hook and MCP configs invoke plain `node` (plugin/hooks/hooks.json,
        plugin/.mcp.json) from fresh non-login shells where neither nvm nor
        any PATH file is sourced — so a PATH edit is not enough. Order:
        existing system node >=22 (nothing to do), else the bundled pinned
        tarball for this arch, else nvm. The chosen bin dir is written to
        ~/.sol-bench-node-path and then symlinked into /usr/local/bin so
        `node` resolves from any shell and any hook subprocess.
        """
        setup = f"""
set -e
node_ge() {{ command -v node >/dev/null 2>&1 || return 1; [ "$(node -p 'Number(process.versions.node.split(".")[0])>=22?0:1' 2>/dev/null || echo 1)" -eq 0 ]; }}
NODE_DIR=""
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) TARBALL=$(ls {CONTAINER_ROOT}/node/node-v*-linux-arm64.tar.xz 2>/dev/null | head -1) ;;
  x86_64|amd64)  TARBALL=$(ls {CONTAINER_ROOT}/node/node-v*-linux-x64.tar.xz 2>/dev/null | head -1) ;;
  *) TARBALL="" ;;
esac
if node_ge; then
  echo "node $(node --version) already >=22 (system)"
elif [ -n "$TARBALL" ]; then
  mkdir -p {CONTAINER_ROOT}/node/runtime
  tar -xJf "$TARBALL" -C {CONTAINER_ROOT}/node/runtime --strip-components=1
  NODE_DIR={CONTAINER_ROOT}/node/runtime/bin
  export PATH="$NODE_DIR:$PATH"
  echo "bundled node $(node --version) at $NODE_DIR"
else
  {self.NVM_FALLBACK}
  NODE_DIR="$(dirname "$(command -v node)")"
  echo "nvm node $(node --version) at $NODE_DIR"
fi
printf '%s\\n' "$NODE_DIR" > "$HOME/.sol-bench-node-path"
node --version
"""
        await self.exec_as_agent(environment, command=setup)
        # Bare `node` must resolve for hook/MCP subprocesses spawned by the
        # zcode host with an arbitrary env — pin it at the system level.
        user = environment.default_user
        home = f"/root" if user is None else f"/home/{user}"
        await self.exec_as_root(
            environment,
            command=(
                f'NODE_BIN="$(cat {home}/.sol-bench-node-path 2>/dev/null)"; '
                f'if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN/node" ]; then '
                f'ln -sf "$NODE_BIN/node" /usr/local/bin/node && '
                f'ln -sf "$NODE_BIN/npm" /usr/local/bin/npm 2>/dev/null || true; '
                f'echo "pinned /usr/local/bin/node -> $NODE_BIN/node"; fi; '
                f"node --version"
            ),
        )

    async def _write_cli_config(self, environment: BaseEnvironment) -> None:
        key = self._get_env("ZCODE_BIGMODEL_KEY") or _host_api_key()
        if not key:
            raise RuntimeError(
                "no API key: set ZCODE_BIGMODEL_KEY via `harbor run --ae` or "
                "have ~/.zcode/v2/config.json on the host (read-only source)"
            )
        await self.exec_as_agent(
            environment,
            command=(
                f"node {CONTAINER_ROOT}/write-cli-config.mjs "
                f"{CONTAINER_ROOT}/provider-template.json "
                f"--home \"$HOME/.zcode\" --model {shlex.quote(self._model())}"
            ),
            # Key flows via exec env (redacted in harbor logs); never via
            # argv, never into the bundle, never into the image.
            env={"ZCODE_BIGMODEL_KEY": key},
        )

    async def _install_plugin(self, environment: BaseEnvironment) -> None:
        options = json.dumps(ARM_OPTIONS[self.zcode_arm], sort_keys=True)
        await self.exec_as_agent(
            environment,
            command=(
                f"node {CONTAINER_ROOT}/install-plugin.mjs "
                f"{CONTAINER_ROOT}/plugin {MARKETPLACE} "
                f"--home \"$HOME/.zcode\" --options {shlex.quote(options)}"
            ),
        )

    async def _smoke_check(self, environment: BaseEnvironment) -> None:
        """Free (no model call) evidence that the plugin registered."""
        result = await self.exec_as_agent(
            environment,
            command=(
                f"node --version && "
                f"node {CONTAINER_ROOT}/zcode.cjs version && "
                f"node {CONTAINER_ROOT}/zcode.cjs plugins list"
            ),
        )
        listing = (result.stdout or "").strip()
        if PLUGIN_ID not in listing:
            raise RuntimeError(
                f"plugin {PLUGIN_ID} missing from `zcode plugins list` output; "
                f"arm={self.zcode_arm}"
            )
        self.logger.info(
            "zcode install ok (arm=%s): %s", self.zcode_arm, listing[:500]
        )

    # --------------------------------------------------------------------- run
    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped = shlex.quote(instruction)
        self._run_started = time.monotonic()
        env: dict[str, str] = {
            # G22: reducer-subprocess must not ps-sniff; the headless CLI
            # renames itself to "zcode-cli".
            "SOL_ZCODE_ZCODE_BIN": f"{CONTAINER_ROOT}/zcode.cjs",
        }
        collect = self._get_env("SOL_BENCH_COLLECT_EVIDENCE")
        if collect:
            env["SOL_BENCH_COLLECT_EVIDENCE"] = collect
        logs_dir = self.environment_logs_dir.as_posix()
        agent_cmd = (
            # In-band cap: produces exit 124 + stderr instead of a
            # container-level kill; Harbor's trial timeout (task.toml
            # 8h) is the outer backstop.
            f"timeout {SELF_CAP_SEC}s node {CONTAINER_ROOT}/zcode.cjs "
            f"--prompt {escaped} --mode yolo --json "
            f"2>&1 </dev/null"
        )
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    # Stay in the container's task WORKDIR (where task files
                    # live) unless an explicit workdir was requested. `node`
                    # resolves via the /usr/local/bin symlink installed in
                    # install() — including for plugin hook/MCP subprocesses.
                    f'[ -n "${{SOL_BENCH_WORKDIR:-}}" ] && cd "$SOL_BENCH_WORKDIR"; '
                    f"mkdir -p {logs_dir} && "
                    # rl-watchdog (audit MAJOR-1): wraps the agent in its own
                    # process group, tees combined stdout+stderr to zcode.txt
                    # (and this exec's stdout), and kills the group when
                    # RL_CONSECUTIVE consecutive model requests each exceed
                    # RL_ABORT_SEC (observed from the plugin trajectory), then
                    # exits 75 with the marker written next to zcode.txt.
                    f"node {CONTAINER_ROOT}/rl-watchdog.mjs "
                    f"--out {logs_dir}/{self._OUTPUT_FILENAME} "
                    f"--abort-marker {logs_dir}/{RL_ABORT_MARKER} "
                    f"--abort-sec {RL_ABORT_SEC} --consecutive {RL_CONSECUTIVE} "
                    f"--poll-sec {RL_POLL_SEC} "
                    f"-- {shlex.quote(agent_cmd)}"
                ),
                env=env,
            )
        except RuntimeError as exc:
            # harbor's _exec raises NonZeroAgentExitCodeError (a RuntimeError)
            # on nonzero exit. If the watchdog fired (exit 75 + marker),
            # re-raise as the distinctive type so the ledger books the true
            # cause; otherwise propagate untouched (exit 124 stays 124).
            abort = self._read_abort_marker()
            if abort is not None:
                raise RateLimitDegeneracyError(_abort_detail(abort)) from exc
            raise
        else:
            abort = self._read_abort_marker()
            if abort is not None:
                raise RateLimitDegeneracyError(_abort_detail(abort))
        finally:
            self._run_finished = time.monotonic()
            if collect:
                # Probe-only: pull the plugin data root (trajectory/ledger/
                # occ summaries) out while the container still exists.
                await self._collect_plugin_evidence(environment)

    async def _collect_plugin_evidence(self, environment: BaseEnvironment) -> None:
        data_root = "$HOME/.zcode/cli/plugins/data"
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    f"tar -czf {self.environment_logs_dir.as_posix()}/sol-data.tgz "
                    f"-C \"$HOME/.zcode/cli/plugins\" data 2>/dev/null "
                    f"|| echo 'no plugin data root at {data_root}'"
                ),
            )
        except Exception:  # noqa: BLE001 — evidence collection is best-effort
            self.logger.warning("plugin evidence collection failed", exc_info=True)

    def _read_abort_marker(self) -> dict[str, Any] | None:
        """Watchdog abort marker from the (bind-mounted) logs dir, validated."""
        try:
            data = json.loads((self.logs_dir / RL_ABORT_MARKER).read_text())
        except (OSError, json.JSONDecodeError):
            return None
        if isinstance(data, dict) and data.get("reason") == "rate-limit-degeneracy":
            return data
        return None

    # -------------------------------------------------- populate_context_post_run
    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        out_path = self.logs_dir / self._OUTPUT_FILENAME
        raw = out_path.read_text(errors="replace") if out_path.exists() else ""
        payload = _parse_headless_json(raw)
        meta: dict[str, Any] = {
            "arm": self.zcode_arm,
            "model": self._model(),
            "sessionId": None,
            "modelRequestCount": None,
            "cacheWriteTokens": None,
            "exception": None,
        }
        if self._run_started is not None:
            meta["agentWallMs"] = int(
                ((self._run_finished or time.monotonic()) - self._run_started) * 1000
            )

        if payload is None:
            meta["exception"] = "json-parse-failed" if raw.strip() else "no-output"
            context.metadata = {"zcode": meta}
            context.n_input_tokens = context.n_input_tokens or 0
            context.n_output_tokens = context.n_output_tokens or 0
            return

        usage = payload.get("usage") or {}
        normalized = {
            "inputTokens": usage.get("inputTokens", 0),
            "outputTokens": usage.get("outputTokens", 0),
            "cacheRead": usage.get(
                "cacheRead", usage.get("cacheReadTokens", 0)
            ),
            "cacheWrite": usage.get(
                "cacheWrite", usage.get("cacheWriteTokens", 0)
            ),
            "modelRequestCount": usage.get("modelRequestCount"),
        }
        # AgentContext semantics: n_input_tokens INCLUDES cached tokens, which
        # matches zcode's usage.inputTokens (spike-verified 2026-09-13).
        context.n_input_tokens = normalized["inputTokens"]
        context.n_cache_tokens = normalized["cacheRead"]
        context.n_output_tokens = normalized["outputTokens"]
        context.cost_usd = cost_usd(normalized)

        meta.update(
            sessionId=payload.get("sessionId"),
            modelRequestCount=normalized["modelRequestCount"],
            cacheWriteTokens=normalized["cacheWrite"],
            responsePreview=(payload.get("response") or "")[:400] or None,
            contextWindow=payload.get("projection", {}).get("contextWindow"),
        )
        abort_marker = self._read_abort_marker()
        if abort_marker is not None:
            # Lift the watchdog's own evidence (gap list) into the trial
            # metadata so the ledger line carries the abort cause verbatim.
            meta["rateLimitAbort"] = {
                "reason": abort_marker.get("reason"),
                "abortSec": abort_marker.get("abortSec"),
                "consecutive": abort_marker.get("consecutive"),
                "ts": abort_marker.get("ts"),
                "evidence": (abort_marker.get("verdict") or {}).get("evidence"),
            }
        context.metadata = {"zcode": meta}


def _abort_detail(marker: dict[str, Any]) -> str:
    verdict = marker.get("verdict") or {}
    gaps = ", ".join(
        f"{g.get('seconds')}s{' (in flight)' if g.get('pending') else ''}"
        for g in (verdict.get("evidence") or [])
    )
    return (
        f"rate-limit degeneracy: {verdict.get('streak')} consecutive model "
        f"request(s) each > {marker.get('abortSec')}s "
        f"(abort-sec {marker.get('abortSec')} x {marker.get('consecutive')}); "
        f"observed gaps: {gaps or 'n/a'}; "
        f"trajectory: {marker.get('trajectoryFile')}"
    )


def _parse_headless_json(text: str) -> dict[str, Any] | None:
    """Parse the --json block out of captured stdout (same brace-scan as the
    repo's e2e harness — zcode may interleave non-JSON lines)."""
    stripped = text.strip()
    if not stripped:
        return None
    try:
        value = json.loads(stripped)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        pass
    first, last = stripped.find("{"), stripped.rfind("}")
    if first >= 0 and last > first:
        try:
            value = json.loads(stripped[first : last + 1])
            return value if isinstance(value, dict) else None
        except json.JSONDecodeError:
            return None
    return None
