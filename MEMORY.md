# MEMORY.md — CUBIT project log

A running record of key decisions, fixes, and state. See `CLAUDE.md` for how to run.

## Context

- **CUBIT** = an open-world voxel game on the HYTOPIA SDK (Bun runtime). Single-file game logic in `index.ts`, HUD in `assets/ui/index.html`.
- The HYTOPIA platform is **paused (~1–3 months, funding)** since June 2026 → `hytopia.com/play` is down. We run **fully self-hosted** (own client from `hytopia-source`, no hytopia.com dependency).

## Environment fixes (so the thing runs at all)

- **Bun**: installed WSL-native at `~/.bun/bin` (the pre-existing `bun` was a Windows build). In `~/.bashrc`.
- **toktx REQUIRED**: SDK ≥0.15 shells out to `toktx` (KTX-Software) to build the block atlas at startup; missing → server crashes (`spawn toktx ENOENT`). Installed KTX-Software 4.4.2 to `~/ktx`, added `bin`→PATH and `lib`→LD_LIBRARY_PATH in `~/.bashrc`. No sudo in this env, so binaries are extracted manually.
- **Self-hosted client**: cloned `hytopiagg/hytopia-source` (MIT) to `~/hytopia-source`; run `client` via `npm run dev -- --host` on :5173.
  - Connect via **`local.hytopiahosting.com:8080`** (valid cert → WebTransport) not `localhost:8080` (self-signed → WebSocket fallback).
  - Fixed a client bug: `vite.config.js` copied the KTX2 `basis_transcoder.*` in `buildStart` (after static middleware) → `/basis/*` served `index.html` → KTX2 worker `SyntaxError 'html'` → white/untextured blocks. Patched to copy at config-eval time. (Lives in the separate clone.)
  - Tab title changed to **CUBIT** in `hytopia-source/client/index.html` (separate clone).

## Game feature timeline

- **v1** — procedural island, collectible items, wandering Wumpus NPCs, day/night + music, basic HUD.
- **v2** — multi-biome terrain (plains/forest/desert/mountain/ocean), inventory, combat + health (melee, hostile mobs, respawn), vehicles (drive pickups on land, boats on water). Fixed: terrain had almost no water (retuned noise → ~17% water); vehicle bugs (boats on land / cars sinking / can't exit) by switching to manual `KINEMATIC_POSITION` control + `Date.now()` cooldowns.
- **v3** — build/break blocks, ranged guns (equip AK-47 with `Q`, hitscan + tracer), polish (mob `SceneUI` health bars, crosshair, hurt flash, gun indicator).
- **v3.1** — hotbar selection: mining loots the specific block type; number keys `1-9` select a slot; right-click places the selected block.

## Known rough edges / TODO

- Equipped gun is parented by a rough offset (floats beside the player, not in-hand) — wants a proper hand-node attach.
- Vehicle steering direction may need sign tweaks if it feels inverted.
- Combat/build/scene-UI were largely implemented without live interaction testing — verify in-browser and check the console (F12) for handler errors.
- Possible next: crafting, more enemy types, structures/dungeons, favicon image, production deploy to own domain.
