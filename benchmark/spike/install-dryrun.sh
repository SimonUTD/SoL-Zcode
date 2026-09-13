#!/usr/bin/env bash
# Local rehearsal of ZcodeAgent.install()'s command sequence in a pristine
# debian container (no Harbor, no model calls). Catches shell/permission
# breakage before burning a real probe trial.
set -euo pipefail
BENCH="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${ZCODE_BIGMODEL_KEY:?ZCODE_BIGMODEL_KEY must be set from host v2 config}"
CID=$(docker run -d --rm debian:bookworm-sleep infinity 2>/dev/null || docker run -d --rm debian:bookworm-slim sleep infinity)
trap 'docker rm -f "$CID" >/dev/null' EXIT
echo "container: $CID"

# --- root: system deps (mirrors ensure_system_dependencies) + agent user
docker exec -u root "$CID" bash -c '
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl bash coreutils xz-utils ca-certificates procps >/dev/null
  useradd -m -s /bin/bash agent
'

# --- bundle (same tarball the agent uploads)
TARBALL=$(cd "$BENCH" && python3 - <<'EOF'
import sys; sys.path.insert(0, ".")
# build without importing harbor (standalone copy of build_bundle)
import tarfile, tempfile, os
from pathlib import Path
BENCH = Path(".").resolve(); REPO = BENCH.parent
tmp = tempfile.NamedTemporaryFile(prefix="sol-dryrun-", suffix=".tar.gz", delete=False); tmp.close()
with tarfile.open(tmp.name, "w:gz") as tar:
    def add_dir(path, arcname):
        for entry in sorted(path.rglob("*")):
            if entry.is_dir(): continue
            rel = entry.relative_to(path)
            if rel.parts[0] in ("tests", "node_modules") or "node_modules" in rel.parts: continue
            tar.add(entry, arcname=f"{arcname}/{rel.as_posix()}")
    tar.add(os.environ.get("SOL_BENCH_ZCODE_CJS", "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"), arcname="zcode.cjs")
    add_dir(REPO / "plugin", "plugin")
    tar.add(REPO / "scripts" / "install-plugin.mjs", arcname="install-plugin.mjs")
    tar.add(BENCH / "assets" / "provider-template.json", arcname="provider-template.json")
    tar.add(BENCH / "assets" / "write-cli-config.mjs", arcname="write-cli-config.mjs")
    for tb in sorted((BENCH / "assets" / "node").glob("node-v*-linux-*.tar.xz")):
        tar.add(tb, arcname=f"node/{tb.name}")
print(tmp.name)
EOF
)
docker cp "$TARBALL" "$CID":/tmp/sol-bench-bundle.tar.gz
rm -f "$TARBALL"

docker exec -u root "$CID" bash -c '
  set -e
  mkdir -p /opt/sol-bench
  tar -xzf /tmp/sol-bench-bundle.tar.gz -C /opt/sol-bench
  chmod 755 /opt/sol-bench/zcode.cjs /opt/sol-bench/*.mjs
  chown -R agent /opt/sol-bench
  rm -f /tmp/sol-bench-bundle.tar.gz
  ls /opt/sol-bench
'

echo "--- node env setup (as agent user, then root symlink) ---"
docker exec -u agent -e HOME=/home/agent "$CID" bash -c '
set -e
node_ge() { command -v node >/dev/null 2>&1 || return 1; [ "$(node -p "Number(process.versions.node.split(\".\")[0])>=22?0:1" 2>/dev/null || echo 1)" -eq 0]; }
NODE_DIR=""
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) TARBALL=$(ls /opt/sol-bench/node/node-v*-linux-arm64.tar.xz 2>/dev/null | head -1) ;;
  x86_64|amd64)  TARBALL=$(ls /opt/sol-bench/node/node-v*-linux-x64.tar.xz 2>/dev/null | head -1) ;;
  *) TARBALL="" ;;
esac
if node_ge; then echo "system node $(node --version)";
elif [ -n "$TARBALL" ]; then
  mkdir -p /opt/sol-bench/node/runtime
  tar -xJf "$TARBALL" -C /opt/sol-bench/node/runtime --strip-components=1
  NODE_DIR=/opt/sol-bench/node/runtime/bin
  export PATH="$NODE_DIR:$PATH"
  echo "bundled node $(node --version) at $NODE_DIR"
else echo "no node path available" >&2; exit 1; fi
printf "%s\n" "$NODE_DIR" > "$HOME/.sol-bench-node-path"
node --version
'
docker exec -u root "$CID" bash -c '
NODE_BIN="$(cat /home/agent/.sol-bench-node-path 2>/dev/null)"
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN/node" ]; then
  ln -sf "$NODE_BIN/node" /usr/local/bin/node
  ln -sf "$NODE_BIN/npm" /usr/local/bin/npm 2>/dev/null || true
  echo "pinned /usr/local/bin/node -> $NODE_BIN/node"
fi
node --version
'

echo "--- cli config write (key via env only; fresh shell proves symlink works) ---"
docker exec -u agent -e HOME=/home/agent -e ZCODE_BIGMODEL_KEY="$KEY" "$CID" bash -c '
node /opt/sol-bench/write-cli-config.mjs /opt/sol-bench/provider-template.json --home "$HOME/.zcode" --model builtin:bigmodel-coding-plan/GLM-5.3-Flash
node -e "const c=require(\"/home/agent/.zcode/cli/config.json\"); console.log(\"config keys:\", Object.keys(c), \"model:\", c.model, \"apiKey present:\", Boolean(c.provider[\"builtin:bigmodel-coding-plan\"].options.apiKey))"
'

echo "--- plugin install: control arm ---"
docker exec -u agent -e HOME=/home/agent "$CID" bash -c '
node /opt/sol-bench/install-plugin.mjs /opt/sol-bench/plugin sol-zcode-bench --home "$HOME/.zcode" --options "{\"actionFusion\":false,\"observationPack\":false,\"evidenceReducer\":false,\"onlineCompact\":false,\"trajectory\":false,\"actionFusionGate\":false,\"reducerModel\":\"\"}"
'

echo "--- smoke: version + plugins list in a bare env shell (no model calls) ---"
docker exec -u agent -e HOME=/home/agent -i "$CID" env -i HOME=/home/agent PATH=/usr/local/bin:/usr/bin:/bin bash -c '
node /opt/sol-bench/zcode.cjs version
node /opt/sol-bench/zcode.cjs plugins list
'
