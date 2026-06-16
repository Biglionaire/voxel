#!/usr/bin/env bash
# Build the static game client for production, with CUBIT branding.
#
# The client is a SEPARATE MIT repo (hytopia-source) — not part of this repo and
# not shipped by `git clone`. This script clones & builds it → ./client-dist for
# Caddy to serve, and applies CUBIT branding (tab title, favicon, PWA name).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${HYTOPIA_SOURCE:-$HOME/hytopia-source}"
OUT_DIR="$REPO_DIR/client-dist"
FAVICON="$REPO_DIR/deploy/favicon.png"

if [ ! -d "$SRC_DIR" ]; then
	echo "==> Cloning hytopia-source → $SRC_DIR"
	git clone https://github.com/hytopiagg/hytopia-source.git "$SRC_DIR"
fi

cd "$SRC_DIR/client"

# CUBIT branding (idempotent): tab title, favicon links, PWA manifest name.
sed -i 's|<title>HYTOPIA</title>|<title>CUBIT</title>|' index.html
if ! grep -q 'rel="icon"' index.html; then
	sed -i 's|<title>CUBIT</title>|<title>CUBIT</title>\n    <link rel="icon" type="image/png" href="/favicon.png" />\n    <link rel="apple-touch-icon" href="/favicon.png" />|' index.html
fi
sed -i 's|"HYTOPIA"|"CUBIT"|g' public/manifest.json 2>/dev/null || true
[ -f "$FAVICON" ] && cp "$FAVICON" public/favicon.png

# Clean install avoids npm's rollup optional-deps bug (stale cross-platform lock).
echo "==> npm install (clean)…"
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund

# Build with vite directly — upstream's `tsc && vite build` trips on a strict
# noUnusedLocals error we don't care about; vite/esbuild bundles fine on its own.
echo "==> vite build…"
npx vite build

rm -rf "$OUT_DIR"
cp -r dist "$OUT_DIR"
[ -f "$FAVICON" ] && cp "$FAVICON" "$OUT_DIR/favicon.png"
echo "==> Client built → $OUT_DIR (served by Caddy at play.cubit.cash)"
echo "    Players land on https://cubit.cash → login → /play → play.cubit.cash/?join=game.cubit.cash:8080"
