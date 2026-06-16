#!/usr/bin/env bash
# Build the static game client for production.
#
# The client is a SEPARATE MIT repo (hytopia-source) — it is NOT part of this
# game-server repo and does NOT come with `git clone`. This script clones &
# builds it, emitting static files to ./client-dist for Caddy to serve.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${HYTOPIA_SOURCE:-$HOME/hytopia-source}"
OUT_DIR="$REPO_DIR/client-dist"

if [ ! -d "$SRC_DIR" ]; then
	echo "==> Cloning hytopia-source → $SRC_DIR"
	git clone https://github.com/hytopiagg/hytopia-source.git "$SRC_DIR"
fi

# Optional cosmetic mods (per CLAUDE.md): browser tab title → CUBIT, and a vite
# public/basis copy-timing fix. Apply them in $SRC_DIR/client before building if
# you want them; they are not required for the client to function.

echo "==> Building client…"
cd "$SRC_DIR/client"
npm install
npm run build   # → dist/

rm -rf "$OUT_DIR"
cp -r dist "$OUT_DIR"
echo "==> Client built → $OUT_DIR (served by Caddy at play.cubit.cash)"
echo "    Players land on https://cubit.cash → login → /play → play.cubit.cash/?join=game.cubit.cash:8080"
