#!/usr/bin/env bash
# CUBIT server provisioning — installs the toolchain and restores everything a
# fresh `git clone` needs to run (deps + bundled assets come from the package
# manager, NOT from git — see deploy/README.md "What git clone does/doesn't ship").
#
# Run from the repo root on a fresh Ubuntu/Debian VPS:  bash deploy/setup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KTX_HOME="${KTX_HOME:-/opt/ktx}"
KTX_VERSION="${KTX_VERSION:-4.4.2}"

echo "==> CUBIT setup in: $REPO_DIR"

# 1) Bun (WSL/Linux native). Installs to ~/.bun.
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
	echo "==> Installing Bun…"
	curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
bun --version

# 2) toktx (KTX-Software) — the SDK shells out to it at startup to build the
#    block-texture atlas. Without it the game server crashes (spawn toktx ENOENT).
if [ ! -x "$KTX_HOME/bin/toktx" ]; then
	echo "==> Installing KTX-Software $KTX_VERSION → $KTX_HOME …"
	tmp="$(mktemp -d)"
	url="https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}/KTX-Software-${KTX_VERSION}-Linux-x86_64.tar.bz2"
	curl -fsSL "$url" -o "$tmp/ktx.tar.bz2"
	sudo mkdir -p "$KTX_HOME"
	sudo tar -xjf "$tmp/ktx.tar.bz2" -C "$KTX_HOME" --strip-components=1
	rm -rf "$tmp"
fi
export PATH="$KTX_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$KTX_HOME/lib:${LD_LIBRARY_PATH:-}"
toktx --version

# 3) Restore dependencies + the bundled @hytopia.com/assets (NOT in git).
echo "==> bun install (restores hytopia SDK + ~3,300 art assets)…"
cd "$REPO_DIR"
bun install

# 4) Env file
if [ ! -f "$REPO_DIR/deploy/.env" ]; then
	cp "$REPO_DIR/deploy/.env.example" "$REPO_DIR/deploy/.env"
	echo "==> Created deploy/.env — EDIT IT: set CUBIT_SECRET (openssl rand -hex 32) and your domains."
fi

cat <<EOF

==> Toolchain ready.
Next:
  1. Edit deploy/.env (secret + domains).
  2. Build the client:  bash deploy/build-client.sh
  3. Install services:  see deploy/README.md (systemd + Caddy).

For an interactive shell, persist the toolchain in ~/.bashrc:
  export PATH="\$HOME/.bun/bin:$KTX_HOME/bin:\$PATH"
  export LD_LIBRARY_PATH="$KTX_HOME/lib:\$LD_LIBRARY_PATH"
EOF
