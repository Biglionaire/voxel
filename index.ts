/**
 * SURVIVAL EXPLORER — an open-world HYTOPIA game.
 *
 * Features (v2):
 *  1) Procedural multi-biome world (plains, pine forest, desert, mountains, ocean/beach)
 *  2) Inventory — collected items stack in a hotbar; food can be eaten to heal
 *  3) Combat & health — hostile Wumpus mobs chase & damage you; attack to kill them
 *  4) Vehicles — drive pickup trucks on land and boats on water
 *
 * All models/textures/audio come from the @hytopia.com/assets library (referenced by URI).
 * Interaction handlers are wrapped defensively so a bad call logs instead of crashing.
 */

import {
  startServer,
  Audio,
  BaseEntityControllerEvent,
  BlockType,
  ColliderShape,
  DefaultPlayerEntity,
  Entity,
  EntityModelAnimationLoopMode,
  PlayerEntity,
  PlayerEvent,
  RigidBodyType,
  SceneUI,
  SimpleEntityController,
} from 'hytopia';

import worldMap from './assets/map.json';

/* ------------------------------------------------------------------ *
 *  Config
 * ------------------------------------------------------------------ */

const WORLD_RADIUS = 64;
const SEA_LEVEL = 11;
const MOUNTAIN_LEVEL = 22;
const MAX_HP = 100;
const TOTAL_ITEMS = 28;
const MOB_COUNT = 10;
const ATTACK_RANGE = 4;
const ATTACK_DAMAGE = 34;
const ATTACK_COOLDOWN_MS = 450;
const MOB_DAMAGE = 12;
const MOB_AGGRO_RANGE = 18;

const BLOCK = {
  ANDESITE: 1, COBBLESTONE: 5, GRASS_PINE: 6, GRASS: 7,
  OAK_LEAVES: 10, OAK_LOG: 11, SAND: 12, STONE: 15, WATER: 16,
} as const;

/* ------------------------------------------------------------------ *
 *  Deterministic value-noise terrain
 * ------------------------------------------------------------------ */

const fract = (n: number) => n - Math.floor(n);
const hash2 = (x: number, z: number) => fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453123);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = smooth(xf), v = smooth(zf);
  return lerp(
    lerp(hash2(xi, zi), hash2(xi + 1, zi), u),
    lerp(hash2(xi, zi + 1), hash2(xi + 1, zi + 1), u),
    v,
  );
}

function fbm(x: number, z: number): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < 4; o++) { sum += valueNoise(x * freq, z * freq) * amp; norm += amp; amp *= 0.5; freq *= 2; }
  return sum / norm;
}

// Tuned (via distribution sim) for ~17% water, ~75% land, ~7% mountains.
const heightAt = (x: number, z: number) => Math.floor(fbm((x + 1000) * 0.025, (z + 1000) * 0.025) * 30);

type Biome = 'ocean' | 'beach' | 'desert' | 'plains' | 'forest' | 'mountain';
function biomeAt(x: number, z: number, h: number): Biome {
  if (h < SEA_LEVEL) return 'ocean';
  if (h <= SEA_LEVEL + 1) return 'beach';
  if (h >= MOUNTAIN_LEVEL) return 'mountain';
  const m = fbm((x - 500) * 0.02, (z - 500) * 0.02);
  if (m < 0.40) return 'desert';
  if (m > 0.60) return 'forest';
  return 'plains';
}

/* ------------------------------------------------------------------ *
 *  Asset pools
 * ------------------------------------------------------------------ */

const PROPS: Record<Biome, { uri: string; collide: boolean; chance: number }[]> = {
  plains: [
    { uri: 'models/environment/Plains/oak-tree-big.gltf', collide: true, chance: 0.018 },
    { uri: 'models/environment/Plains/oak-tree-medium.gltf', collide: true, chance: 0.018 },
    { uri: 'models/environment/Plains/flower-tuft.gltf', collide: false, chance: 0.05 },
    { uri: 'models/environment/Plains/bush-berry.gltf', collide: false, chance: 0.03 },
    { uri: 'models/environment/Plains/grass-tall.gltf', collide: false, chance: 0.06 },
  ],
  forest: [
    { uri: 'models/environment/Pine Forest/pine-tree-big.gltf', collide: true, chance: 0.04 },
    { uri: 'models/environment/Pine Forest/pine-tree-medium.gltf', collide: true, chance: 0.04 },
    { uri: 'models/environment/Pine Forest/forest-fern.gltf', collide: false, chance: 0.05 },
    { uri: 'models/environment/Pine Forest/redcap-mushroom-group.gltf', collide: false, chance: 0.02 },
  ],
  desert: [
    { uri: 'models/environment/Plains/scattered-pebbles.gltf', collide: false, chance: 0.02 },
    { uri: 'models/environment/Pine Forest/mossy-boulder.gltf', collide: true, chance: 0.008 },
  ],
  mountain: [
    { uri: 'models/environment/Pine Forest/mossy-boulder.gltf', collide: true, chance: 0.03 },
    { uri: 'models/environment/Pine Forest/mossy-stump.gltf', collide: true, chance: 0.01 },
  ],
  beach: [],
  ocean: [],
};

const COLLECTIBLES = ['carrot', 'golden-apple', 'bread', 'cookie', 'gold-ingot', 'melon', 'bone', 'book', 'compass', 'clock'];
const ITEM_EMOJI: Record<string, string> = {
  carrot: '🥕', 'golden-apple': '🍎', bread: '🍞', cookie: '🍪', 'gold-ingot': '🪙',
  melon: '🍈', bone: '🦴', book: '📖', compass: '🧭', clock: '🕐',
  // blocks (mined → placeable)
  'grass-block': '🟩', 'grass-block-pine': '🟩', 'grass-flower-block': '🌼', 'grass-flower-block-pine': '🌼',
  stone: '🪨', andesite: '🪨', cobblestone: '🧱', bricks: '🧱', sand: '🟨', 'coal-ore': '⚫',
  'oak-log': '🪵', 'spruce-log': '🪵', 'oak-leaves': '🍃', 'spruce-leaves': '🍃', 'birch-leaves': '🍃', water: '💧',
};

// Block name <-> id maps + the set of placeable block names (everything except water).
const BLOCK_TYPES = (worldMap as any).blockTypes as { id: number; name: string }[];
const BLOCK_NAME_TO_ID: Record<string, number> = {};
const BLOCK_ID_TO_NAME: Record<number, string> = {};
for (const bt of BLOCK_TYPES) { BLOCK_NAME_TO_ID[bt.name] = bt.id; BLOCK_ID_TO_NAME[bt.id] = bt.name; }
const PLACEABLE = new Set(BLOCK_TYPES.filter(b => b.id !== 16).map(b => b.name));
const FOOD_HEAL: Record<string, number> = { carrot: 15, bread: 25, cookie: 10, 'golden-apple': 50, melon: 20 };

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

/* ================================================================== *
 *  GAME
 * ================================================================== */

startServer(world => {
  // Register block textures from the bundled atlas (without placing the default map).
  for (const bt of (worldMap as any).blockTypes) {
    world.blockTypeRegistry.registerBlockType(new BlockType({
      id: bt.id, name: bt.name, textureUri: bt.textureUri, isLiquid: bt.id === BLOCK.WATER,
    }));
  }

  /* --- Terrain generation ------------------------------------------ */
  const landColumns: { x: number; z: number; y: number; biome: Biome }[] = [];
  const waterColumns: { x: number; z: number }[] = [];

  for (let x = -WORLD_RADIUS; x <= WORLD_RADIUS; x++) {
    for (let z = -WORLD_RADIUS; z <= WORLD_RADIUS; z++) {
      const h = heightAt(x, z);
      const biome = biomeAt(x, z, h);

      let top: number;
      switch (biome) {
        case 'forest': top = BLOCK.GRASS_PINE; break;
        case 'plains': top = BLOCK.GRASS; break;
        case 'mountain': top = BLOCK.STONE; break;
        default: top = BLOCK.SAND; break; // desert, beach, ocean bed
      }

      const bottom = Math.max(0, h - 3);
      for (let y = bottom; y <= h; y++) {
        const block = y === h ? top : (biome === 'mountain' ? BLOCK.STONE : y >= h - 1 ? BLOCK.COBBLESTONE : BLOCK.STONE);
        world.chunkLattice.setBlock({ x, y, z }, block);
      }

      if (h < SEA_LEVEL) {
        for (let y = h + 1; y <= SEA_LEVEL; y++) world.chunkLattice.setBlock({ x, y, z }, BLOCK.WATER);
        waterColumns.push({ x, z });
      } else if (biome !== 'beach') {
        landColumns.push({ x, z, y: h + 1, biome });
      }
    }
  }
  console.log(`[world] terrain: ${landColumns.length} land cols, ${waterColumns.length} water cols`);

  /* --- Scatter biome props ----------------------------------------- */
  let propCount = 0;
  for (const c of landColumns) {
    for (const p of PROPS[c.biome]) {
      if (Math.random() < p.chance && propCount < 700) {
        const e = new Entity({
          modelUri: p.uri,
          modelScale: 0.7 + Math.random() * 0.6,
          rigidBodyOptions: { type: RigidBodyType.FIXED },
          modelPreferredShape: p.collide ? undefined : ColliderShape.NONE,
        });
        e.spawn(world, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
        propCount++;
        break;
      }
    }
  }
  console.log(`[world] props: ${propCount}`);

  /* --- Per-player state -------------------------------------------- */
  const players = new Set<any>();
  const hp = new Map<any, number>();
  const inventory = new Map<any, Map<string, number>>();
  const lastInput = new Map<any, Record<string, boolean>>();
  const lastAttack = new Map<any, number>();
  const driving = new Map<any, VehicleObj>();
  const mountCooldown = new Map<any, number>(); // prevents instant re-mount after exit
  const gunEntity = new Map<any, Entity>();     // player -> held gun entity (when equipped)
  const lastBuild = new Map<any, number>();     // build/break rate limit
  const selectedSlot = new Map<any, number>();  // selected hotbar slot index

  function getInv(player: any): Map<string, number> {
    let inv = inventory.get(player);
    if (!inv) { inv = new Map(); inventory.set(player, inv); }
    return inv;
  }

  function sendHud(player: any) {
    const inv = getInv(player);
    const items = [...inv.entries()].map(([name, count]) => ({ name, count, emoji: ITEM_EMOJI[name] ?? '📦', placeable: PLACEABLE.has(name) }));
    const sel = Math.min(selectedSlot.get(player) ?? 0, Math.max(0, items.length - 1));
    player.ui.sendData({ type: 'state', hp: hp.get(player) ?? MAX_HP, maxHp: MAX_HP, items, selected: sel, collected: [...inv.values()].reduce((a, b) => a + b, 0), total: TOTAL_ITEMS });
  }

  // The item name in the currently selected hotbar slot (or null).
  function selectedItemName(player: any): string | null {
    const keys = [...getInv(player).keys()];
    if (!keys.length) return null;
    return keys[Math.min(selectedSlot.get(player) ?? 0, keys.length - 1)] ?? null;
  }

  function addItem(player: any, name: string, qty = 1) {
    const inv = getInv(player);
    inv.set(name, (inv.get(name) ?? 0) + qty);
    sendHud(player);
  }

  function healPlayer(player: any, amount: number) {
    const cur = hp.get(player) ?? MAX_HP;
    hp.set(player, Math.min(MAX_HP, cur + amount));
    sendHud(player);
  }

  function damagePlayer(player: any, amount: number) {
    const cur = hp.get(player) ?? MAX_HP;
    const next = cur - amount;
    if (next <= 0) {
      hp.set(player, MAX_HP);
      world.chatManager.sendPlayerMessage(player, '💀 You died! Respawning…', 'FF4444');
      world.entityManager.getPlayerEntitiesByPlayer(player).forEach(e => {
        try { (e as any).startModelOneshotAnimations?.(['death-front']); } catch {}
        e.setPosition(spawn);
      });
    } else {
      hp.set(player, next);
      world.entityManager.getPlayerEntitiesByPlayer(player).forEach(e => {
        try { (e as any).startModelOneshotAnimations?.(['damage-hit-upper']); } catch {}
      });
    }
    try { player.ui.sendData({ type: 'hurt' }); } catch {}
    sendHud(player);
  }

  /* --- Collectible items (feed the inventory) ---------------------- */
  const activeItems = new Set<Entity>();
  for (let i = 0; i < TOTAL_ITEMS && landColumns.length; i++) {
    const c = pick(landColumns);
    const name = pick(COLLECTIBLES);
    let item: Entity;
    item = new Entity({
      name: `item:${name}`,
      modelUri: `models/items/${name}.gltf`,
      modelScale: 0.7,
      rigidBodyOptions: {
        type: RigidBodyType.FIXED,
        colliders: [{
          shape: ColliderShape.BALL, radius: 1.4, isSensor: true,
          onCollision: (other: BlockType | Entity, started: boolean) => {
            if (started && other instanceof PlayerEntity && activeItems.has(item)) {
              activeItems.delete(item);
              item.despawn();
              const player = (other as PlayerEntity).player;
              new Audio({ uri: 'audio/sfx/ui/inventory-grab-item.mp3', volume: 0.5 }).play(world);
              addItem(player, name);
              world.chatManager.sendPlayerMessage(player, `${ITEM_EMOJI[name] ?? '📦'} Picked up ${name.replace(/-/g, ' ')}`, 'FFE066');
            }
          },
        }],
      },
    });
    item.spawn(world, { x: c.x + 0.5, y: c.y + 1.3, z: c.z + 0.5 });
    activeItems.add(item);
  }
  console.log(`[world] collectibles: ${activeItems.size}`);

  /* --- Hostile Wumpus mobs ----------------------------------------- */
  const mobHp = new Map<Entity, number>();
  const mobBars = new Map<Entity, SceneUI>();
  const MOB_MAX_HP = 100;

  function spawnMob(at: { x: number; z: number }) {
    const y = heightAt(at.x, at.z) + 1;
    const mob = new Entity({
      name: 'Wumpus',
      modelUri: 'models/npcs/wumpus.gltf',
      modelScale: 0.75,
      modelAnimations: [{ name: 'idle', loopMode: EntityModelAnimationLoopMode.LOOP, play: true }],
      controller: new SimpleEntityController(),
    });
    mob.spawn(world, { x: at.x + 0.5, y, z: at.z + 0.5 });
    mobHp.set(mob, MOB_MAX_HP);
    // Floating health bar above the mob.
    try {
      const bar = new SceneUI({ templateId: 'mob-health', attachedToEntity: mob, offset: { x: 0, y: 1.1, z: 0 }, state: { pct: 100 }, viewDistance: 40 });
      bar.load(world);
      mobBars.set(mob, bar);
    } catch {}
    return mob;
  }

  // Apply damage to a mob: update HP + health bar, knockback, and kill if dead.
  function damageMob(mob: Entity, dmg: number, byPlayer: any, dir?: { x: number; z: number }) {
    if (!mobHp.has(mob)) return;
    const left = (mobHp.get(mob) ?? 0) - dmg;
    if (dir) { try { mob.applyImpulse({ x: dir.x * 6, y: 3, z: dir.z * 6 }); } catch {} }
    if (left <= 0) { killMob(mob, byPlayer); return; }
    mobHp.set(mob, left);
    try { mobBars.get(mob)?.setState({ pct: Math.round((left / MOB_MAX_HP) * 100) }); } catch {}
  }

  for (let i = 0; i < MOB_COUNT && landColumns.length; i++) spawnMob(pick(landColumns));
  console.log(`[world] mobs: ${mobHp.size}`);

  function nearestPlayerEntity(pos: { x: number; y: number; z: number }, maxDist: number): PlayerEntity | null {
    let best: PlayerEntity | null = null;
    let bestD = maxDist;
    for (const player of players) {
      for (const pe of world.entityManager.getPlayerEntitiesByPlayer(player)) {
        const d = Math.hypot(pe.position.x - pos.x, pe.position.z - pos.z);
        if (d < bestD) { bestD = d; best = pe as PlayerEntity; }
      }
    }
    return best;
  }

  // Mob AI tick: chase nearest player, deal contact damage.
  setInterval(() => {
    for (const mob of [...mobHp.keys()]) {
      if (!mob.isSpawned) { mobHp.delete(mob); try { mobBars.get(mob)?.unload(); } catch {} mobBars.delete(mob); continue; }
      const target = nearestPlayerEntity(mob.position, MOB_AGGRO_RANGE);
      if (!target) continue;
      const d = Math.hypot(target.position.x - mob.position.x, target.position.z - mob.position.z);
      try {
        const ctrl = mob.controller as SimpleEntityController;
        ctrl.face(target.position, 5);
        if (d > 1.6) ctrl.move({ x: target.position.x, y: mob.position.y, z: target.position.z }, 3.5);
        else damagePlayer(target.player, MOB_DAMAGE); // in melee range
      } catch {}
    }
  }, 700);

  // Respawn mobs over time to keep the world populated.
  setInterval(() => {
    if (mobHp.size < MOB_COUNT && landColumns.length) spawnMob(pick(landColumns));
  }, 8000);

  function killMob(mob: Entity, byPlayer: any) {
    mobHp.delete(mob);
    try { mobBars.get(mob)?.unload(); } catch {}
    mobBars.delete(mob);
    try { mob.despawn(); } catch {}
    new Audio({ uri: 'audio/sfx/entity/spider/spider-death.mp3', volume: 0.5 }).play(world);
    // Drop loot straight into the killer's inventory.
    if (byPlayer) {
      const loot = pick(['bone', 'gold-ingot', 'cookie']);
      addItem(byPlayer, loot);
      world.chatManager.sendPlayerMessage(byPlayer, `⚔️ Wumpus defeated! Looted ${loot}.`, 'FF8800');
    }
  }

  /* --- Vehicles (manual kinematic control) -------------------------- *
   * Each vehicle's world position (px,pz) and heading (yaw) are tracked by us
   * and applied every tick with setPosition/setRotation. This lets us:
   *  - keep boats ON water only (block movement onto land columns)
   *  - keep cars ON the terrain surface (no sinking) and off deep water
   * Entities face their local -Z axis, so forward = (-sin yaw, -cos yaw).
   */
  type VehicleObj = { entity: Entity; kind: 'land' | 'water'; px: number; pz: number; yaw: number; driver: any | null };
  const vehicles: VehicleObj[] = [];

  const surfaceY = (kind: 'land' | 'water', wx: number, wz: number) =>
    kind === 'water' ? SEA_LEVEL + 1 : Math.max(heightAt(Math.round(wx), Math.round(wz)) + 1, SEA_LEVEL + 1) + 0.4;

  function spawnVehicle(uri: string, kind: 'land' | 'water', gx: number, gz: number) {
    const px = gx + 0.5, pz = gz + 0.5;
    const entity = new Entity({
      name: 'Vehicle',
      modelUri: uri,
      modelScale: kind === 'water' ? 0.9 : 0.7,
      rigidBodyOptions: { type: RigidBodyType.KINEMATIC_POSITION },
    });
    entity.spawn(world, { x: px, y: surfaceY(kind, px, pz), z: pz });
    vehicles.push({ entity, kind, px, pz, yaw: 0, driver: null });
  }

  for (let i = 0; i < 4 && landColumns.length; i++) {
    const c = pick(landColumns);
    spawnVehicle(`models/vehicles/${pick(['pickup-red', 'pickup-green', 'pickup-yellow', 'pickup-purple'])}.gltf`, 'land', c.x, c.z);
  }
  for (let i = 0; i < 4 && waterColumns.length; i++) {
    const c = pick(waterColumns);
    spawnVehicle(`models/vehicles/${pick(['boat', 'jetski', 'kayak'])}.gltf`, 'water', c.x, c.z);
  }
  console.log(`[world] vehicles: ${vehicles.length}`);

  const yawToQuat = (yaw: number) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });

  function nearestVehicle(pos: { x: number; y: number; z: number }, maxDist: number): VehicleObj | null {
    let best: VehicleObj | null = null, bestD = maxDist;
    for (const v of vehicles) {
      if (!v.entity.isSpawned || v.driver) continue;
      const d = Math.hypot(v.px - pos.x, v.pz - pos.z);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  function mount(player: any, pe: PlayerEntity, v: VehicleObj) {
    v.driver = player;
    driving.set(player, v);
    try { pe.setParent(v.entity, undefined, { x: 0, y: 1.1, z: 0 }); } catch {}
    world.chatManager.sendPlayerMessage(player, `🚗 Mounted ${v.kind === 'water' ? 'boat' : 'vehicle'}! WASD to drive · E to exit`, '00FFFF');
  }

  function dismount(player: any, pe: PlayerEntity) {
    const v = driving.get(player);
    if (!v) return;
    v.driver = null;
    driving.delete(player);
    mountCooldown.set(player, Date.now());
    try { pe.setParent(undefined); } catch {}
    // Drop the player onto solid ground beside the vehicle.
    const gy = Math.max(heightAt(Math.round(v.px), Math.round(v.pz)) + 1, SEA_LEVEL + 1) + 1.5;
    try { pe.setPosition({ x: v.px + 1.5, y: gy, z: v.pz + 1.5 }); } catch {}
    world.chatManager.sendPlayerMessage(player, '🚶 Exited vehicle.', '00FFFF');
  }

  // Driving tick — manual kinematic movement with terrain/water constraints.
  setInterval(() => {
    for (const v of vehicles) {
      if (!v.entity.isSpawned || !v.driver) continue;
      const input = lastInput.get(v.driver) ?? {};
      if (input.a) v.yaw += 0.05;
      if (input.d) v.yaw -= 0.05;
      const fwd = (input.w ? 1 : 0) - (input.s ? 1 : 0);
      if (fwd !== 0) {
        const step = (v.kind === 'water' ? 0.33 : 0.45) * fwd;
        const nx = v.px + -Math.sin(v.yaw) * step;
        const nz = v.pz + -Math.cos(v.yaw) * step;
        const hDest = heightAt(Math.round(nx), Math.round(nz));
        const onWater = hDest < SEA_LEVEL;
        // Boats only move across water; cars only across (non-deep-water) land.
        const allowed = v.kind === 'water' ? onWater : !onWater && hDest < MOUNTAIN_LEVEL + 4;
        if (allowed) { v.px = nx; v.pz = nz; }
      }
      try {
        v.entity.setPosition({ x: v.px, y: surfaceY(v.kind, v.px, v.pz), z: v.pz });
        v.entity.setRotation(yawToQuat(v.yaw));
      } catch {}
    }
  }, 60);

  /* --- Day / night cycle + music ----------------------------------- */
  let timeOfDay = 0.30;
  const CYCLE_MS = 8 * 60 * 1000;
  const STEP_MS = 4000;
  let night = false;
  const dayMusic = new Audio({ uri: 'audio/music/outworld-theme-looping.mp3', loop: true, volume: 0.1 });
  const nightMusic = new Audio({ uri: 'audio/music/night-theme-looping.mp3', loop: true, volume: 0.1 });

  world.setSkyboxUri('skyboxes/partly-cloudy');
  world.setFogColor({ r: 200, g: 220, b: 240 });
  world.setFogNear(95); world.setFogFar(190);
  dayMusic.play(world);

  function tickSky() {
    timeOfDay = (timeOfDay + STEP_MS / CYCLE_MS) % 1;
    const daylight = Math.max(0, Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2));
    world.setAmbientLightIntensity(0.3 + daylight * 0.8);
    world.setDirectionalLightIntensity(daylight * 1.3);
    world.setSkyboxIntensity(0.25 + daylight * 0.85);
    world.setAmbientLightColor({ r: Math.round(lerp(70, 255, daylight)), g: Math.round(lerp(85, 250, daylight)), b: Math.round(lerp(150, 235, daylight)) });
    const ang = timeOfDay * Math.PI * 2;
    world.setDirectionalLightPosition({ x: Math.cos(ang) * 120, y: Math.max(15, Math.sin(ang) * 120), z: 60 });
    const isNight = daylight < 0.12;
    if (isNight !== night) { night = isNight; if (night) { dayMusic.pause(); nightMusic.play(world); } else { nightMusic.pause(); dayMusic.play(world); } }
    players.forEach(p => p.ui.sendData({ type: 'time', t: timeOfDay, phase: night ? 'night' : 'day' }));
  }
  setInterval(tickSky, STEP_MS);
  tickSky();

  /* --- Spawn point (first dry land near origin) -------------------- */
  let spawn = { x: 0.5, y: heightAt(0, 0) + 3, z: 0.5 };
  for (let r = 0; r <= WORLD_RADIUS; r += 2) {
    const h = heightAt(r, r);
    if (h > SEA_LEVEL + 1 && h < MOUNTAIN_LEVEL) { spawn = { x: r + 0.5, y: h + 3, z: r + 0.5 }; break; }
  }

  /* --- Building, guns & combat helpers ----------------------------- */
  const GUN_RANGE = 60, GUN_DAMAGE = 55, GUN_COOLDOWN_MS = 220;

  function castFromCamera(player: any, pe: PlayerEntity, range: number) {
    const dir = player.camera?.facingDirection;
    if (!dir) return null;
    const origin = { x: pe.position.x, y: pe.position.y + 0.6, z: pe.position.z };
    return world.simulation.raycast(origin as any, dir as any, range, { filterExcludeRigidBody: (pe as any).rawRigidBody } as any);
  }

  function breakBlock(player: any, block: any) {
    try {
      const name = block.blockType?.name as string | undefined; // the mined block's type
      world.chunkLattice.setBlock(block.globalCoordinate, 0);    // 0 = remove
      if (name) addItem(player, name, 1);                        // loot the specific block
      new Audio({ uri: 'audio/sfx/ui/inventory-grab-item.mp3', volume: 0.4 }).play(world);
    } catch (e) { console.warn('break error', e); }
  }

  function placeBlock(player: any, block: any, hitPoint: any) {
    const name = selectedItemName(player);
    if (!name || !PLACEABLE.has(name)) return; // selected slot must hold a placeable block
    const inv = getInv(player);
    if ((inv.get(name) ?? 0) <= 0) return;
    try {
      const coord = block.getNeighborGlobalCoordinateFromHitPoint(hitPoint);
      world.chunkLattice.setBlock(coord, BLOCK_NAME_TO_ID[name]);
      inv.set(name, inv.get(name)! - 1);
      if (inv.get(name)! <= 0) inv.delete(name);
      sendHud(player);
      new Audio({ uri: 'audio/sfx/ui/inventory-place-item.mp3', volume: 0.4 }).play(world);
    } catch (e) { console.warn('place error', e); }
  }

  function toggleGun(player: any, pe: PlayerEntity) {
    const existing = gunEntity.get(player);
    if (existing) {
      try { existing.despawn(); } catch {}
      gunEntity.delete(player);
      player.ui.sendData({ type: 'gun', equipped: false });
      world.chatManager.sendPlayerMessage(player, '🔫 Gun holstered.', 'AAAAAA');
      return;
    }
    try {
      const gun = new Entity({ name: 'Gun', modelUri: 'models/guns/ak47.gltf', modelScale: 0.6, parent: pe });
      gun.spawn(world, { x: 0.3, y: 0.0, z: -0.5 });
      gunEntity.set(player, gun);
      player.ui.sendData({ type: 'gun', equipped: true });
      world.chatManager.sendPlayerMessage(player, '🔫 AK-47 equipped! Left-click shoots · Q to holster.', 'FFCC00');
    } catch (e) { console.warn('equip error', e); }
  }

  function fireGun(player: any, pe: PlayerEntity, dir: any, hit: any) {
    if (!dir) return;
    try { (pe as any).startModelOneshotAnimations?.(['shoot-gun-right']); } catch {}
    new Audio({ uri: 'audio/sfx/entity/phantom/phantom-shoot.mp3', volume: 0.35 }).play(world);
    const target = hit?.hitEntity;
    if (target && mobHp.has(target)) damageMob(target, GUN_DAMAGE, player, { x: dir.x, z: dir.z });
    // Visual tracer (no collision; despawns shortly).
    try {
      const tracer = new Entity({
        name: 'Tracer',
        modelUri: 'models/projectiles/laser-bullet-green-small.gltf',
        modelScale: 0.5,
        rigidBodyOptions: { type: RigidBodyType.KINEMATIC_VELOCITY },
        modelPreferredShape: ColliderShape.NONE,
      });
      tracer.spawn(world, { x: pe.position.x + dir.x * 1.2, y: pe.position.y + 0.7, z: pe.position.z + dir.z * 1.2 });
      tracer.setLinearVelocity({ x: dir.x * 55, y: dir.y * 55, z: dir.z * 55 });
      setTimeout(() => { try { tracer.despawn(); } catch {} }, 600);
    } catch {}
  }

  /* --- Player input handler (attack / build / interact / eat) ------ */
  function handleInput(player: any, pe: PlayerEntity, input: Record<string, boolean>) {
    const prev = lastInput.get(player) ?? {};

    const now = Date.now();

    // Hotbar slot selection (number keys 1-9) — edge-triggered.
    for (let n = 1; n <= 9; n++) {
      const k = String(n);
      if (input[k] && !prev[k]) { selectedSlot.set(player, n - 1); sendHud(player); }
    }

    // Equip / holster gun (Q) — edge-triggered.
    if (input.q && !prev.q && !driving.has(player)) toggleGun(player, pe);

    // Left mouse: fire gun OR melee a mob OR mine a block.
    if (input.ml && !driving.has(player)) {
      try {
        const dir = player.camera?.facingDirection;
        if (gunEntity.has(player)) {
          if (now - (lastAttack.get(player) ?? 0) > GUN_COOLDOWN_MS) {
            lastAttack.set(player, now);
            fireGun(player, pe, dir, castFromCamera(player, pe, GUN_RANGE));
          }
        } else {
          const hit = castFromCamera(player, pe, ATTACK_RANGE);
          const target = hit?.hitEntity;
          if (target && mobHp.has(target)) {
            if (now - (lastAttack.get(player) ?? 0) > ATTACK_COOLDOWN_MS) {
              lastAttack.set(player, now);
              try { (pe as any).startModelOneshotAnimations?.(['sword-attack-1']); } catch {}
              new Audio({ uri: 'audio/sfx/player/player-swing-woosh.mp3', volume: 0.4 }).play(world);
              damageMob(target, ATTACK_DAMAGE, player, dir ? { x: dir.x, z: dir.z } : undefined);
            }
          } else if (hit?.hitBlock && now - (lastBuild.get(player) ?? 0) > 200) {
            lastBuild.set(player, now);
            breakBlock(player, hit.hitBlock);
          }
        }
      } catch (e) { console.warn('left-click error', e); }
    }

    // Right mouse: place a block on the targeted face.
    if (input.mr && !driving.has(player) && now - (lastBuild.get(player) ?? 0) > 200) {
      lastBuild.set(player, now);
      try {
        const hit = castFromCamera(player, pe, 6);
        if (hit?.hitBlock) placeBlock(player, hit.hitBlock, hit.hitPoint);
      } catch (e) { console.warn('place error', e); }
    }

    // Interact / mount-dismount (E) — edge-triggered.
    if (input.e && !prev.e) {
      try {
        if (driving.has(player)) dismount(player, pe);
        else if (Date.now() - (mountCooldown.get(player) ?? 0) > 800) {
          const v = nearestVehicle(pe.position, 4);
          if (v) mount(player, pe, v);
        }
      } catch (e) { console.warn('interact error', e); }
    }

    // Eat food (F) — prefer the selected slot if it's food, else any food.
    if (input.f && !prev.f) {
      try {
        const inv = getInv(player);
        const sel = selectedItemName(player);
        const order = sel && FOOD_HEAL[sel] ? [sel, ...Object.keys(FOOD_HEAL)] : Object.keys(FOOD_HEAL);
        for (const food of order) {
          if ((inv.get(food) ?? 0) > 0) {
            inv.set(food, inv.get(food)! - 1);
            if (inv.get(food)! <= 0) inv.delete(food);
            healPlayer(player, FOOD_HEAL[food]);
            new Audio({ uri: 'audio/sfx/player/eat.mp3', volume: 0.6 }).play(world);
            try { (pe as any).startModelOneshotAnimations?.(['consume-upper']); } catch {}
            world.chatManager.sendPlayerMessage(player, `Ate ${food} (+${FOOD_HEAL[food]} HP)`, '66FF66');
            break;
          }
        }
      } catch (e) { console.warn('eat error', e); }
    }

    lastInput.set(player, { ...input });
  }

  /* --- Player lifecycle -------------------------------------------- */
  world.on(PlayerEvent.JOINED_WORLD, ({ player }) => {
    const pe = new DefaultPlayerEntity({ player, name: 'Player' });
    pe.spawn(world, spawn);
    players.add(player);
    hp.set(player, MAX_HP);
    if (!inventory.has(player)) inventory.set(player, new Map());
    addItem(player, 'cobblestone', 20); // starter building blocks (placeable)
    addItem(player, 'oak-log', 10);

    try {
      pe.controller?.on(BaseEntityControllerEvent.TICK_WITH_PLAYER_INPUT, ({ input }: any) => {
        handleInput(player, pe, input);
      });
    } catch (e) { console.warn('input hook error', e); }

    player.ui.load('ui/index.html');
    sendHud(player);
    player.ui.sendData({ type: 'time', t: timeOfDay, phase: night ? 'night' : 'day' });

    world.chatManager.sendPlayerMessage(player, '🌲 Welcome to Survival Explorer!', '00FF00');
    world.chatManager.sendPlayerMessage(player, 'Explore biomes, collect items, fight Wumpus, drive vehicles.');
    world.chatManager.sendPlayerMessage(player, 'WASD move · Space jump · Shift sprint');
    world.chatManager.sendPlayerMessage(player, 'L-click attack/mine · R-click place selected block · Q gun');
    world.chatManager.sendPlayerMessage(player, '1-9 pick hotbar slot · E vehicle · F eat');
    world.chatManager.sendPlayerMessage(player, 'Commands: /home /heal /give /time');
  });

  world.on(PlayerEvent.LEFT_WORLD, ({ player }) => {
    players.delete(player);
    driving.delete(player);
    try { gunEntity.get(player)?.despawn(); } catch {}
    gunEntity.delete(player);
    world.entityManager.getPlayerEntitiesByPlayer(player).forEach(e => e.despawn());
  });

  world.on(PlayerEvent.RECONNECTED_WORLD, ({ player }) => {
    players.add(player);
    player.ui.load('ui/index.html');
    sendHud(player);
  });

  /* --- Commands ----------------------------------------------------- */
  world.chatManager.registerCommand('/home', player => {
    if (driving.has(player)) world.entityManager.getPlayerEntitiesByPlayer(player).forEach(e => dismount(player, e as PlayerEntity));
    world.entityManager.getPlayerEntitiesByPlayer(player).forEach(e => e.setPosition(spawn));
  });
  world.chatManager.registerCommand('/heal', player => { hp.set(player, MAX_HP); sendHud(player); world.chatManager.sendPlayerMessage(player, 'Healed to full.', '66FF66'); });
  world.chatManager.registerCommand('/give', player => { COLLECTIBLES.forEach(n => addItem(player, n, 1)); world.chatManager.sendPlayerMessage(player, 'Gave one of each item.', 'FFE066'); });
  world.chatManager.registerCommand('/time', player => world.chatManager.sendPlayerMessage(player, `It is ${night ? 'night' : 'day'} (t=${timeOfDay.toFixed(2)}).`));

  console.log('[world] Survival Explorer v2 ready.');
});
