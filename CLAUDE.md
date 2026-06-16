# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What this is

**CUBIT** — an open-world multiplayer voxel game ("Survival Explorer") built on the
[HYTOPIA SDK](https://github.com/hytopiagg/sdk). The entire game lives in **`index.ts`**;
the HUD is **`assets/ui/index.html`**. It runs on **Bun**, not Node.

> ⚠️ The HYTOPIA platform (hytopia.com) is **paused (~1–3 months, funding)** as of June 2026,
> so `hytopia.com/play` is down. We run **fully self-hosted** — see "Running" below.

## Running (local dev)

Two processes: the game **server** (this repo) and the browser **client** (a separate clone).

1. **Toolchain (one-time).** Bun is installed WSL-native at `~/.bun/bin`. The SDK requires
   the external **`toktx`** binary (KTX-Software, at `~/ktx/...`) on `PATH` + `LD_LIBRARY_PATH`
   to build the block-texture atlas at startup — **without it the server crashes** (`spawn toktx ENOENT`).
   Both are wired into `~/.bashrc`.
2. **Server:** `hytopia start` → serves on `https://localhost:8080` (HTTP/2 + WebTransport).
   Auto-reloads on file change (nodemon). Assets come from the npm pkg `@hytopia.com/assets`
   (~3,300 models) — referenced by URI; never committed.
3. **Client:** cloned to `~/hytopia-source` (MIT). Run `cd ~/hytopia-source/client && npm run dev -- --host`
   → serves on `http://localhost:5173`. (Client-side mods: tab title → `CUBIT`, and a vite
   `public/basis` copy-timing fix — both live in that separate clone, not this repo.)
4. **Play:** open **`http://localhost:5173/?join=local.hytopiahosting.com:8080`**.
   Use `local.hytopiahosting.com:8080` (NOT `localhost:8080`) — it resolves to 127.0.0.1 but
   has a valid Amazon TLS cert, so WebTransport works. `localhost:8080` falls back to WebSocket.

## Architecture (`index.ts`)

Everything is inside the single `startServer(world => { … })` callback:

- **Terrain** — deterministic value-noise/fbm heightmap (`heightAt`), tuned to ~17% water /
  75% land / 7% mountains (`SEA_LEVEL 11`, `MOUNTAIN_LEVEL 22`). Biomes via a moisture noise
  (`biomeAt`): plains / forest / desert / mountain / ocean+beach. Blocks placed with
  `world.chunkLattice.setBlock`; block types registered from `assets/map.json`.
- **Inventory / hotbar** — per-player `Map<name,count>`; number keys `1-9` select a slot;
  food eaten with `F` heals.
- **Build/break** — left-click raycast mines a block (loots its specific type); right-click
  places the **selected** block (`getNeighborGlobalCoordinateFromHitPoint`). `PLACEABLE` set
  + `BLOCK_NAME_TO_ID` map drive this.
- **Combat/health** — 100 HP; left-click melee or (with `Q`-equipped AK-47) hitscan gunfire
  via `world.simulation.raycast` from `player.camera.facingDirection`; `damageMob()` helper;
  hostile Wumpus mobs chase + deal contact damage; `SceneUI` floating health bars; death→respawn.
- **Vehicles** — `KINEMATIC_POSITION` pickups (land) + boats (water). `E` mounts via `setParent`;
  a driving tick reads the driver's `lastInput` and sets position/rotation each frame; boats are
  constrained to water columns, cars follow the terrain surface.
- **Day/night** — `setInterval` cycle driving lights/skybox/fog + adaptive music.

Input is hooked via `pe.controller.on(BaseEntityControllerEvent.TICK_WITH_PLAYER_INPUT)`.
All interaction handlers are wrapped in `try/catch` so a bad call logs instead of crashing.
Use `Date.now()` for cooldowns (it works in the game runtime).

## Conventions / gotchas

- Match the existing single-file style; keep comments at the current density.
- Confirm SDK API shapes against `node_modules/hytopia/server.d.ts` before using them.
- Input keys: `w a s d sp sh ml mr e q r f z x c v` and digits `1-9` (`input['1']`).
- `index.mjs`, `assets/blocks/.atlas/`, `dev/`, `node_modules` are generated/ignored.
- Deploying to your own domain is possible (engine is MIT): host the static client + run the
  server with a real Let's Encrypt cert (patch `hytopia-source/server/.../ssl/certs.ts`).
  Caveat: the bundled art assets are under HYTOPIA's Limited Use License.
