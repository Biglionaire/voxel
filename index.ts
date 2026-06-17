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
  PlayerCameraMode,
  PlayerEntity,
  PlayerEvent,
  PlayerUIEvent,
  RigidBodyType,
  SceneUI,
  SimpleEntityController,
} from 'hytopia';

import worldMap from './assets/map.json';

/* ------------------------------------------------------------------ *
 *  Config
 * ------------------------------------------------------------------ */

const WORLD_RADIUS = 96; // expanded world (193×193)
const SEA_LEVEL = 11;
const MOUNTAIN_LEVEL = 22;
const MAX_HP = 100;
const TOTAL_ITEMS = 40;
const SIGNUP_BONUS_COINS = 1000; // coins granted once on account signup (placeholder for on-chain $CUBIT / Solana)
const MOB_COUNT = 16;
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

// Tuned for ~17% water inland, with an island falloff so the map edges are all ocean.
const heightAt = (x: number, z: number) => {
  let h = fbm((x + 1000) * 0.025, (z + 1000) * 0.025) * 30;
  const edge = Math.max(Math.abs(x), Math.abs(z)) / WORLD_RADIUS; // 0 = center, 1 = edge
  if (edge > 0.72) h -= ((edge - 0.72) / 0.28) * 34; // ramp down into deep ocean at the rim
  return Math.floor(h);
};

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
    { uri: 'models/environment/Plains/oak-tree-big.gltf', collide: true, chance: 0.01 },
    { uri: 'models/environment/Plains/oak-tree-medium.gltf', collide: true, chance: 0.01 },
    { uri: 'models/environment/Plains/flower-tuft.gltf', collide: false, chance: 0.03 },
    { uri: 'models/environment/Plains/bush-berry.gltf', collide: false, chance: 0.02 },
    { uri: 'models/environment/Plains/grass-tall.gltf', collide: false, chance: 0.035 },
    { uri: 'models/environment/Pine Forest/mossy-boulder.gltf', collide: true, chance: 0.008 },
  ],
  forest: [
    { uri: 'models/environment/Pine Forest/pine-tree-big.gltf', collide: true, chance: 0.022 },
    { uri: 'models/environment/Pine Forest/pine-tree-medium.gltf', collide: true, chance: 0.018 },
    { uri: 'models/environment/Pine Forest/forest-fern.gltf', collide: false, chance: 0.03 },
    { uri: 'models/environment/Pine Forest/redcap-mushroom-group.gltf', collide: false, chance: 0.015 },
    { uri: 'models/environment/Pine Forest/mossy-boulder.gltf', collide: true, chance: 0.01 },
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
  // furniture / structure props (placed as entities)
  lantern: '🏮', chest: '🧰', bed: '🛏️', fence: '🚧', door: '🚪', window: '🪟',
  'lamp-post': '💡', bench: '🪑', barrel: '🛢️', torch: '🔥', bookshelf: '📚', crate: '📦',
  // fishing
  'fishing-rod': '🎣', 'fishing-rod-2': '🎣', 'fishing-rod-3': '🎏', bait: '🪱', pickup: '🚗',
  'school-bus': '🚌', jetski: '🚤', boat: '⛵', kayak: '🛶', paddle: '🛶',
  'coal-ore': '⚫', 'iron-ore': '🔩', 'gold-ore': '🟡', 'iron-ingot': '⚙️',
  'axe-wood': '🪓', 'axe-stone': '🪓', 'axe-iron': '🪓', 'axe-gold': '🪓', 'axe-diamond': '🪓',
  'pickaxe-wood': '⛏️', 'pickaxe-stone': '⛏️', 'pickaxe-iron': '⛏️', 'pickaxe-gold': '⛏️', 'pickaxe-diamond': '⛏️',
  plank: '🟫', stick: '🪵',
  'cod-raw': '🐟', 'cod-cooked': '🍤', 'salmon-raw': '🐠', 'salmon-cooked': '🍣',
  pufferfish: '🐡', clownfish: '🐠', catfish: '🐟', parrotfish: '🐠', lionfish: '🐟', sailfish: '🐟', swordfish: '🗡️', anglerfish: '🎏',
};

// Furniture / structure props — placed as entities (not voxel blocks) via the build system.
const PROP_MODELS: Record<string, string> = {
  lantern: 'models/environment/House/lantern.gltf',
  chest: 'models/environment/House/chest-blocky-wood.gltf',
  bed: 'models/environment/House/bed-red.gltf',
  fence: 'models/environment/House/fence-wood-1.gltf',
  door: 'models/environment/House/door-oak.gltf',
  window: 'models/environment/House/cottage-window-1x1.gltf',
  'lamp-post': 'models/environment/City/lamp-post.gltf',
  bench: 'models/environment/City/park-bench.gltf',
  barrel: 'models/environment/City/barrel-wood-1.gltf',
  torch: 'models/environment/Dungeon/dungeon-torch-1.gltf',
  bookshelf: 'models/environment/Dungeon/bookshelf.gltf',
  crate: 'models/environment/Dungeon/crate-1.gltf',
};

// Measured model bottom (min Y of bounding box). A prop's base rests on a floor
// surface S when spawned at y = S - ymin. (origin at base → ymin 0; centered → ymin < 0)
const PROP_YMIN: Record<string, number> = {
  lantern: -0.12, 'lamp-post': -0.25, bench: -0.35, bed: 0, chest: -0.15,
  barrel: -0.5, crate: 0, door: -0.31, bookshelf: -0.69, torch: -0.28, fence: 0, window: 0,
};
// Y to spawn a prop so it rests on the block whose TOP surface is `surfaceY`.
const propRestY = (key: string, surfaceY: number) => surfaceY - (PROP_YMIN[key] ?? 0);

// Block name <-> id maps + the set of placeable block names (everything except water).
const BLOCK_TYPES = (worldMap as any).blockTypes as { id: number; name: string }[];
const BLOCK_NAME_TO_ID: Record<string, number> = {};
const BLOCK_ID_TO_NAME: Record<number, string> = {};
for (const bt of BLOCK_TYPES) { BLOCK_NAME_TO_ID[bt.name] = bt.id; BLOCK_ID_TO_NAME[bt.id] = bt.name; }
const PLACEABLE = new Set(BLOCK_TYPES.filter(b => b.id !== 16).map(b => b.name));
const isPlaceable = (name: string) => PLACEABLE.has(name) || name in PROP_MODELS;
const FOOD_HEAL: Record<string, number> = { carrot: 15, bread: 25, cookie: 10, 'golden-apple': 50, melon: 20, 'cod-cooked': 22, 'salmon-cooked': 32, 'cod-raw': 5, 'salmon-raw': 6 };

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
  const trees = new Set<Entity>(); // choppable trees → wood
  const treeHits = new Map<Entity, number>();
  const rocks = new Set<Entity>(); // mineable rock/ore nodes → stone + ore
  const nodeMeta = new Map<Entity, { uri: string; x: number; y: number; z: number; scale: number; kind: 'tree' | 'rock'; ore: string | null }>();
  const mining = new Map<any, { target: Entity; endAt: number; dur: number }>(); // active mining session per player
  const scenery: { entity: Entity; x: number; z: number }[] = []; // for later town-clearing
  // Tool tiers = rarity. Higher tier mines faster. Index 0 = bare hands.
  const TOOL_TIERS = ['wood', 'stone', 'iron', 'gold', 'diamond'];
  const TIER_SPEED = [1.7, 1.1, 0.8, 0.55, 0.38, 0.25]; // mine-time multiplier by tier (0 = hands)
  const RARITY = ['Common', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']; // by tier index
  const townZones: { x: number; z: number; r: number }[] = [];    // village/city footprints to keep clear
  let propCount = 0;
  for (const c of landColumns) {
    let placed = false;
    for (const p of PROPS[c.biome]) {
      if (!placed && Math.random() < p.chance && propCount < 1000) {
        const scale = 0.7 + Math.random() * 0.6;
        const e = new Entity({
          modelUri: p.uri, modelScale: scale,
          rigidBodyOptions: { type: RigidBodyType.FIXED },
          modelPreferredShape: p.collide ? undefined : ColliderShape.NONE,
        });
        e.spawn(world, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
        const isTree = p.uri.includes('tree');
        const isRock = p.collide && /boulder|rock|stone|magma|pebble/.test(p.uri);
        if (isTree || isRock) {
          const ore = isRock ? pick(['coal-ore', 'coal-ore', 'iron-ore', 'gold-ore', null, null]) : null;
          nodeMeta.set(e, { uri: p.uri, x: c.x + 0.5, y: c.y, z: c.z + 0.5, scale, kind: isTree ? 'tree' : 'rock', ore });
          if (isTree) trees.add(e); else rocks.add(e);
        }
        scenery.push({ entity: e, x: c.x, z: c.z });
        propCount++;
        placed = true;
      }
    }
  }
  console.log(`[world] props: ${propCount}`);

  /* --- Villages & towns (assembled from blocks + furniture props) --- */
  const setB = (x: number, y: number, z: number, id: number) => { try { world.chunkLattice.setBlock({ x, y, z }, id); } catch {} };
  function placeModel(uri: string, wx: number, wy: number, wz: number, scale = 1, collide = false) {
    try {
      const e = new Entity({ modelUri: uri, modelScale: scale, rigidBodyOptions: { type: RigidBodyType.FIXED }, modelPreferredShape: collide ? undefined : ColliderShape.NONE });
      e.spawn(world, { x: wx, y: wy, z: wz });
    } catch {}
  }

  // Footprint flat enough (and dry, non-mountain) to build on?
  function flatEnough(cx: number, cz: number, rad: number, maxDelta = 2): boolean {
    let lo = Infinity, hi = -Infinity;
    for (let x = cx - rad; x <= cx + rad; x += 2) for (let z = cz - rad; z <= cz + rad; z += 2) {
      const h = heightAt(x, z);
      if (h <= SEA_LEVEL + 1 || h >= MOUNTAIN_LEVEL) return false;
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    return hi - lo <= maxDelta;
  }

  // A small block house with foundation, walls, doorway, windows, roof + furniture.
  // gy is the (already-leveled) ground height the house sits on.
  function buildHouse(cx: number, cz: number, gy: number) {
    const gh = gy;
    const W = 3, D = 3, H = 4;
    const x0 = cx - W, x1 = cx + W, z0 = cz - D, z1 = cz + D;
    const wall = BLOCK.COBBLESTONE;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      for (let y = gh - 2; y <= gh; y++) setB(x, y, z, BLOCK.COBBLESTONE); // foundation + floor
      for (let y = gh + 1; y <= gh + H + 2; y++) setB(x, y, z, 0);          // clear interior/roofspace
    }
    for (let y = gh + 1; y <= gh + H; y++) {
      for (let x = x0; x <= x1; x++) { setB(x, y, z0, wall); setB(x, y, z1, wall); }
      for (let z = z0; z <= z1; z++) { setB(x0, y, z, wall); setB(x1, y, z, wall); }
    }
    for (let y = gh + 1; y <= gh + H; y++) { // corner posts
      setB(x0, y, z0, BLOCK.OAK_LOG); setB(x1, y, z0, BLOCK.OAK_LOG);
      setB(x0, y, z1, BLOCK.OAK_LOG); setB(x1, y, z1, BLOCK.OAK_LOG);
    }
    setB(cx, gh + 1, z0, 0); setB(cx, gh + 2, z0, 0);                       // doorway
    setB(x0, gh + 2, cz, 0); setB(x1, gh + 2, cz, 0); setB(cx, gh + 2, z1, 0); // windows
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) setB(x, gh + H + 1, z, BLOCK.OAK_LOG);     // roof base
    for (let x = x0 + 1; x <= x1 - 1; x++) for (let z = z0 + 1; z <= z1 - 1; z++) setB(x, gh + H + 2, z, BLOCK.OAK_LEAVES); // roof peak
    const fy = gh + 1; // interior floor surface
    placeModel(PROP_MODELS.door, cx + 0.5, propRestY('door', fy), z0 + 0.5);
    placeModel(PROP_MODELS.bed, x0 + 1.5, propRestY('bed', fy), z1 - 0.5);
    placeModel(PROP_MODELS.chest, x1 - 0.5, propRestY('chest', fy), z0 + 1.5);
    placeModel(PROP_MODELS.lantern, cx + 0.5, propRestY('lantern', fy), cz + 0.5);
  }

  // A village: ring of houses + lamp posts + a central well + andesite paths.
  function buildVillage(cx: number, cz: number): number {
    const gy = heightAt(cx, cz);
    const spacing = 9;
    const R = spacing + 4;
    // Level the whole village plot to gy (grass) so houses sit flat — no hanging/stacking.
    for (let x = cx - R; x <= cx + R; x++) for (let z = cz - R; z <= cz + R; z++) {
      const h = heightAt(x, z);
      if (h > gy) for (let y = gy + 1; y <= h; y++) setB(x, y, z, 0);
      if (h < gy) for (let y = h + 1; y <= gy; y++) setB(x, y, z, BLOCK.COBBLESTONE);
      setB(x, gy, z, BLOCK.GRASS);
    }
    let built = 0;
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      if (gx === 0 && gz === 0) continue;
      const hx = cx + gx * spacing, hz = cz + gz * spacing;
      buildHouse(hx, hz, gy);
      placeModel(PROP_MODELS['lamp-post'], hx + 4.5, propRestY('lamp-post', gy + 1), hz + 0.5);
      built++;
    }
    for (let x = cx - 1; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++) setB(x, gy, z, BLOCK.COBBLESTONE); // well
    setB(cx, gy, cz, BLOCK.WATER);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([dx, dz]) => { for (let y = gy + 1; y <= gy + 2; y++) setB(cx + dx, y, cz + dz, BLOCK.OAK_LOG); });
    placeModel(PROP_MODELS.lantern, cx + 0.5, propRestY('lantern', gy + 3), cz + 0.5); // on the well posts
    for (let d = 2; d <= spacing; d++) { // andesite paths on the flat ground
      setB(cx + d, gy, cz, BLOCK.ANDESITE); setB(cx - d, gy, cz, BLOCK.ANDESITE);
      setB(cx, gy, cz + d, BLOCK.ANDESITE); setB(cx, gy, cz - d, BLOCK.ANDESITE);
    }
    return built;
  }

  // Place a few well-separated villages on flat plains/forest land.
  const villageCenters: { x: number; z: number }[] = [];
  {
    const candidates = landColumns.filter(c => c.biome === 'plains' || c.biome === 'forest');
    for (let attempt = 0; attempt < 600 && villageCenters.length < 4; attempt++) {
      const c = candidates[Math.floor(Math.random() * candidates.length)];
      if (!c) break;
      if (Math.abs(c.x) > 60 || Math.abs(c.z) > 60) continue; // stay on solid inland (off the ocean falloff)
      if (villageCenters.some(v => Math.hypot(v.x - c.x, v.z - c.z) < 45)) continue;
      if (!flatEnough(c.x, c.z, 12, 5)) continue;
      if (buildVillage(c.x, c.z) >= 3) { villageCenters.push({ x: c.x, z: c.z }); townZones.push({ x: c.x, z: c.z, r: 14 }); }
    }
    console.log(`[world] villages: ${villageCenters.length}`);
  }

  /* --- Downtown city (multi-story buildings) ----------------------- */
  function buildTower(cx: number, cz: number, gy: number, floors: number) {
    const W = 4, D = 4, FH = 4;
    const x0 = cx - W, x1 = cx + W, z0 = cz - D, z1 = cz + D;
    const mat = pick([3 /* bricks */, BLOCK.STONE, BLOCK.COBBLESTONE, BLOCK.ANDESITE]);
    const top = gy + floors * FH;
    // Foundation reaches down to the lowest ground under the footprint, so a building
    // at a coast / drop-off doesn't float over a gap on its exposed side.
    let base = gy - 3;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) base = Math.min(base, heightAt(x, z));
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      for (let y = base; y <= gy; y++) setB(x, y, z, BLOCK.COBBLESTONE);     // foundation (down to solid ground)
      for (let y = gy + 1; y <= top + 2; y++) setB(x, y, z, 0);             // hollow shell
    }
    for (let y = gy + 1; y <= top; y++) {
      const band = (y - gy) % FH;
      const windowRow = band === 2 || band === 3; // window band per floor
      for (let x = x0; x <= x1; x++) {
        const corner = x === x0 || x === x1;
        const win = windowRow && !corner && (x - x0) % 2 === 0;
        setB(x, y, z0, win ? 0 : mat); setB(x, y, z1, win ? 0 : mat);
      }
      for (let z = z0; z <= z1; z++) {
        const corner = z === z0 || z === z1;
        const win = windowRow && !corner && (z - z0) % 2 === 0;
        setB(x0, y, z, win ? 0 : mat); setB(x1, y, z, win ? 0 : mat);
      }
    }
    for (let y = gy + 1; y <= top; y++) { // stone corner pillars
      setB(x0, y, z0, BLOCK.STONE); setB(x1, y, z0, BLOCK.STONE);
      setB(x0, y, z1, BLOCK.STONE); setB(x1, y, z1, BLOCK.STONE);
    }
    for (let f = 1; f < floors; f++) { // interior floor slabs
      const fy = gy + f * FH;
      for (let x = x0 + 1; x <= x1 - 1; x++) for (let z = z0 + 1; z <= z1 - 1; z++) setB(x, fy, z, BLOCK.STONE);
    }
    for (let dx = -1; dx <= 1; dx++) { setB(cx + dx, gy + 1, z0, 0); setB(cx + dx, gy + 2, z0, 0); } // wide entrance
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) setB(x, top + 1, z, mat); // roof
    for (let x = x0; x <= x1; x++) { setB(x, top + 2, z0, mat); setB(x, top + 2, z1, mat); }  // parapet
    for (let z = z0; z <= z1; z++) { setB(x0, top + 2, z, mat); setB(x1, top + 2, z, mat); }
    placeModel(PROP_MODELS.lantern, cx + 0.5, top + 2, cz + 0.5);
  }

  // Re-seal a tower's walls (fill the window gaps solid) so functional buildings
  // like the Tavern/Clinic are fully enclosed — keeps only the front doorway.
  function sealBuilding(cx: number, cz: number, gy: number, floors: number) {
    const W = 4, D = 4, FH = 4;
    const x0 = cx - W, x1 = cx + W, z0 = cz - D, z1 = cz + D;
    const top = gy + floors * FH;
    const mat = 3; // bricks
    for (let y = gy + 1; y <= top; y++) {
      for (let x = x0; x <= x1; x++) { setB(x, y, z0, mat); setB(x, y, z1, mat); }
      for (let z = z0; z <= z1; z++) { setB(x0, y, z, mat); setB(x1, y, z, mat); }
    }
    for (let y = gy + 1; y <= top; y++) { // keep stone corner pillars for contrast
      setB(x0, y, z0, BLOCK.STONE); setB(x1, y, z0, BLOCK.STONE);
      setB(x0, y, z1, BLOCK.STONE); setB(x1, y, z1, BLOCK.STONE);
    }
    for (let dx = -1; dx <= 1; dx++) { setB(cx + dx, gy + 1, z0, 0); setB(cx + dx, gy + 2, z0, 0); } // doorway
  }

  function buildCity(cx: number, cz: number): { gy: number; towers: { x: number; z: number; floors: number }[] } {
    const gy = heightAt(cx, cz);
    const half = 18;
    // Level the plot to a flat paved platform: carve hills above gy, fill valleys/water
    // up to gy so the whole footprint is solid (no gaps), pave the top with andesite.
    for (let x = cx - half; x <= cx + half; x++) for (let z = cz - half; z <= cz + half; z++) {
      const h = heightAt(x, z);
      if (h > gy) for (let y = gy + 1; y <= h; y++) setB(x, y, z, 0);
      if (h < gy) for (let y = h + 1; y <= gy; y++) setB(x, y, z, BLOCK.COBBLESTONE);
      setB(x, gy, z, BLOCK.ANDESITE); // pavement
    }
    const lot = 12; const towers: { x: number; z: number; floors: number }[] = [];
    for (let lx = cx - half + 6; lx <= cx + half - 6; lx += lot) {
      for (let lz = cz - half + 6; lz <= cz + half - 6; lz += lot) {
        const floors = 3 + Math.floor(Math.random() * 4); // 3–6 floors
        buildTower(lx, lz, gy, floors);
        placeModel(PROP_MODELS['lamp-post'], lx - 5.5, propRestY('lamp-post', gy + 1), lz - 5.5);
        placeModel(PROP_MODELS.bench, lx + 5.5, propRestY('bench', gy + 1), lz - 5.5);
        towers.push({ x: lx, z: lz, floors });
      }
    }
    placeModel(PROP_MODELS.lantern, cx + 0.5, propRestY('lantern', gy + 1), cz + 0.5);
    return { gy, towers };
  }

  // Decorate a functional building's interior with themed props.
  function decorateBuilding(x: number, z: number, gy: number, type: string) {
    const S = gy + 1; // floor surface
    const pp = (key: string, wx: number, wz: number) => placeModel(PROP_MODELS[key], wx, propRestY(key, S), wz);
    if (type === 'market') { pp('barrel', x - 1.5, z + 1.5); pp('crate', x + 1.5, z + 1.5); pp('crate', x + 1.5, z - 1.5); pp('chest', x - 1.5, z - 1.5); }
    else if (type === 'clinic') { pp('bed', x - 1.5, z + 1.5); pp('bed', x + 1.5, z + 1.5); pp('lantern', x + 0.5, z + 0.5); }
    else if (type === 'armory') { pp('crate', x - 1.5, z - 1.5); pp('crate', x + 1.5, z - 1.5); pp('torch', x + 0.5, z + 0.5); }
    else if (type === 'library') { pp('bookshelf', x - 2, z - 2); pp('bookshelf', x - 2, z); pp('bookshelf', x - 2, z + 2); pp('lantern', x + 0.5, z + 0.5); }
    else if (type === 'tavern') { pp('barrel', x - 1.5, z + 1.5); pp('barrel', x - 1.5, z - 0.5); pp('bench', x + 1.5, z); }
  }

  let cityCenter: { x: number; z: number; gy: number } | null = null;
  const functionalBuildings: { x: number; z: number; type: string; label: string; emoji: string }[] = [];
  const BUILDING_THEMES = [
    { type: 'clinic', label: 'Clinic', emoji: '🏥' },
    { type: 'tavern', label: 'Tavern', emoji: '🍺' },
  ];
  {
    const cands = landColumns.filter(c => Math.abs(c.x) < 74 && Math.abs(c.z) < 74 && c.biome !== 'mountain');
    const farFromVillages = (c: { x: number; z: number }) =>
      !villageCenters.some(v => Math.hypot(v.x - c.x, v.z - c.z) < 42); // keep city plot off village plots
    // Validate the WHOLE plot (radius ~= half, not just the core) so a river/coast can't
    // cut a water trench through the city. plotIsLand rejects any water/mountain column.
    const RAD = 18;
    // The rongga is WATER cutting through the plot; hills get leveled flat, so only reject
    // water columns here (flatness is handled separately by the spread score below).
    const plotIsLand = (cx: number, cz: number) => {
      for (let x = cx - RAD; x <= cx + RAD; x += 2) for (let z = cz - RAD; z <= cz + RAD; z += 2) {
        if (heightAt(x, z) <= SEA_LEVEL + 1) return false; // any water inside the plot
      }
      return true;
    };
    const spread = (cx: number, cz: number) => {
      let lo = Infinity, hi = -Infinity;
      for (let x = cx - RAD; x <= cx + RAD; x += 3) for (let z = cz - RAD; z <= cz + RAD; z += 3) {
        const h = heightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      return hi - lo;
    };
    const pickFlattest = (filter: (c: { x: number; z: number }) => boolean) => {
      let best: { x: number; z: number } | null = null, bestScore = Infinity;
      for (const c of cands) {
        if (!farFromVillages(c) || !filter(c)) continue;
        const s = spread(c.x, c.z);
        if (s < bestScore) { bestScore = s; best = c; }
      }
      return best ? { site: best, score: bestScore } : null;
    };
    let site: { x: number; z: number } | null = null;
    // Strict: a fully-land plot that's already quite flat (minimal carving → no cliffs).
    for (let attempt = 0; attempt < 1200 && !site; attempt++) {
      const c = cands[Math.floor(Math.random() * cands.length)];
      if (!c) break;
      if (plotIsLand(c.x, c.z) && spread(c.x, c.z) <= 10 && farFromVillages(c)) site = { x: c.x, z: c.z };
    }
    // Relax flatness but KEEP the all-land requirement (avoid any water in the city).
    if (!site) { const r = pickFlattest(c => plotIsLand(c.x, c.z)); if (r) { site = r.site; console.log(`[world] city: flattest all-land site (spread ${r.score})`); } }
    // Last resort: flattest anywhere (may touch water) — better a city than none.
    if (!site) { const r = pickFlattest(() => true); if (r) { site = r.site; console.log(`[world] city: last-resort site (spread ${r.score}, may touch water)`); } }
    if (site) {
      const r = buildCity(site.x, site.z);
      cityCenter = { x: site.x, z: site.z, gy: r.gy };
      townZones.push({ x: site.x, z: site.z, r: 20 });
      const sx = site.x + 6.5, sz = site.z + 0.5; // spawn street — make Market/Clinic the nearest buildings
      const ordered = [...r.towers].sort((a, b) => Math.hypot(a.x - sx, a.z - sz) - Math.hypot(b.x - sx, b.z - sz));
      ordered.forEach((t, i) => {
        if (i >= BUILDING_THEMES.length) return;
        const th = BUILDING_THEMES[i];
        functionalBuildings.push({ x: t.x, z: t.z, type: th.type, label: th.label, emoji: th.emoji });
        sealBuilding(t.x, t.z, r.gy, t.floors); // fully enclose functional buildings (no open windows)
        decorateBuilding(t.x, t.z, r.gy, th.type);
        // A small physical sign at the entrance (no floating sky label).
        placeModel(PROP_MODELS.window, t.x + 0.5, r.gy + 2.5, t.z - 4.4, 1.4);
      });
      console.log(`[world] city: ${r.towers.length} buildings (${functionalBuildings.length} functional) at (${site.x}, ${site.z})`);
    } else {
      console.log('[world] city: no suitable flat site found');
    }
  }

  // Remove scenery (trees/rocks/foliage) that ended up inside a village or city plot,
  // so nothing overlaps the buildings/streets.
  const inTown = (x: number, z: number) => townZones.some(t => Math.abs(x - t.x) <= t.r && Math.abs(z - t.z) <= t.r);
  let clearedScenery = 0;
  for (const s of scenery) {
    if (inTown(s.x, s.z)) { try { s.entity.despawn(); } catch {} trees.delete(s.entity); rocks.delete(s.entity); nodeMeta.delete(s.entity); treeHits.delete(s.entity); clearedScenery++; }
  }
  console.log(`[world] cleared ${clearedScenery} scenery inside towns`);
  // Land away from town centers — for scattering items & mobs without burying them in buildings.
  const openLand = landColumns.filter(c => !inTown(c.x, c.z));

  /* --- Fishing piers: jut out from the shoreline on support posts --- */
  {
    const piers: { x: number; z: number }[] = [];
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const isWater = (x: number, z: number) => heightAt(x, z) < SEA_LEVEL;
    for (let attempt = 0; attempt < 9000 && piers.length < 14; attempt++) {
      const w = waterColumns[Math.floor(Math.random() * waterColumns.length)];
      if (!w) break;
      if (Math.abs(w.x) > WORLD_RADIUS - 8 || Math.abs(w.z) > WORLD_RADIUS - 8) continue;
      if (piers.some(p => Math.hypot(p.x - w.x, p.z - w.z) < 26)) continue; // spread out
      // Anchor to a gentle beach: low land directly behind the root, open water ahead — deck juts seaward.
      let dir: number[] | null = null;
      for (const [dx, dz] of DIRS) {
        if (!isWater(w.x - dx, w.z - dz) && heightAt(w.x - dx, w.z - dz) <= SEA_LEVEL + 3 && isWater(w.x + dx * 5, w.z + dz * 5)) { dir = [dx, dz]; break; }
      }
      if (!dir) continue;
      const [dx, dz] = dir, px = dz, pz = dx; // px,pz = perpendicular (2-wide deck)
      const py = SEA_LEVEL + 1, LEN = 6;
      for (let i = 0; i < LEN; i++) for (let s = 0; s <= 1; s++) {
        const X = w.x + dx * i + px * s, Z = w.z + dz * i + pz * s;
        setB(X, py, Z, BLOCK.OAK_LOG);                                  // deck plank
        for (let y = py - 1; y > heightAt(X, Z); y--) setB(X, y, Z, BLOCK.OAK_LOG); // post to seabed
      }
      const ex = w.x + dx * (LEN - 1), ez = w.z + dz * (LEN - 1);       // seaward end
      setB(ex, py + 1, ez, BLOCK.OAK_LOG);
      placeModel(PROP_MODELS.lantern, ex + 0.5, propRestY('lantern', py + 1), ez + 0.5);
      piers.push({ x: w.x, z: w.z });
    }
    console.log(`[world] ${piers.length} fishing piers`);
  }

  /* --- Per-player state -------------------------------------------- */
  const players = new Set<any>();
  const hp = new Map<any, number>();
  const inventory = new Map<any, Map<string, number>>();
  const lastInput = new Map<any, Record<string, boolean>>();
  const lastAttack = new Map<any, number>();
  const driving = new Map<any, VehicleObj>();
  const mountCooldown = new Map<any, number>(); // prevents instant re-mount after exit
  const gunEntity = new Map<any, Entity>();     // player -> held gun entity (when equipped)
  const rodEntity = new Map<any, Entity>();     // player -> held fishing-rod entity (while casting)
  const fishingFx = new Map<any, { bobber: Entity | null; line: Entity[]; iv: any }>(); // cast bobber + line beads
  const hairEntity = new Map<any, Entity>();    // player -> hair cosmetic child entity (on the head)
  const cosmeticOf = new Map<any, { hair: number }>(); // chosen avatar cosmetics per player
  const HAIR_COUNT = 10;                        // hair-0001 .. hair-0010 (0 = bald)
  const lastBuild = new Map<any, number>();     // build/break rate limit
  const selectedSlot = new Map<any, number>();  // selected hotbar slot index
  const placedProps = new Set<Entity>();        // player-placed furniture/structure entities
  const fishing = new Set<any>();               // players currently casting a line

  function getInv(player: any): Map<string, number> {
    let inv = inventory.get(player);
    if (!inv) { inv = new Map(); inventory.set(player, inv); }
    return inv;
  }

  function sendHud(player: any) {
    const inv = getInv(player);
    const items = [...inv.entries()].map(([name, count]) => ({ name, count, emoji: ITEM_EMOJI[name] ?? '📦', placeable: isPlaceable(name) }));
    const sel = Math.min(selectedSlot.get(player) ?? 0, Math.max(0, items.length - 1));
    player.ui.sendData({ type: 'state', hp: hp.get(player) ?? MAX_HP, maxHp: MAX_HP, items, selected: sel, collected: [...inv.values()].reduce((a, b) => a + b, 0), total: TOTAL_ITEMS });
  }

  // A visible on-screen toast (UI overlay) — reliable even if the chat panel is hidden.
  function toast(player: any, text: string) { try { player.ui.sendData({ type: 'toast', text }); } catch {} }

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
  for (let i = 0; i < TOTAL_ITEMS && openLand.length; i++) {
    const c = pick(openLand);
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

  for (let i = 0; i < MOB_COUNT && openLand.length; i++) spawnMob(pick(openLand));
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
    if (mobHp.size < MOB_COUNT && openLand.length) spawnMob(pick(openLand));
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

  const pickupModel = () => `models/vehicles/${pick(['pickup-red', 'pickup-green', 'pickup-yellow', 'pickup-purple'])}.gltf`;
  const VEHICLE_SPEC: Record<string, { model: string; kind: 'land' | 'water'; emoji: string }> = {
    pickup: { model: 'pickup-red', kind: 'land', emoji: '🛻' },
    'school-bus': { model: 'school-bus', kind: 'land', emoji: '🚌' },
    jetski: { model: 'jetski', kind: 'water', emoji: '🚤' },
    boat: { model: 'boat', kind: 'water', emoji: '⛵' },
    kayak: { model: 'kayak', kind: 'water', emoji: '🛶' },
    paddle: { model: 'paddle', kind: 'water', emoji: '🛶' },
  };
  // No vehicles are placed in the world — players BUY them at the marketplace,
  // which spawns the vehicle right next to them (see buyItem).
  console.log('[world] vehicles: 0 (buy at marketplace)');

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

  /* --- Day / night cycle (driven by REAL UTC time) ----------------- *
   * 1 in-game day = 24h of real UTC. timeOfDay: 0 = 00:00 UTC (midnight),
   * 0.25 = 06:00, 0.5 = 12:00 (noon, brightest), 0.75 = 18:00.
   */
  const STEP_MS = 4000; // how often lighting/HUD refresh from the clock
  let night = false;
  const dayMusic = new Audio({ uri: 'audio/music/outworld-theme-looping.mp3', loop: true, volume: 0.1 });
  const nightMusic = new Audio({ uri: 'audio/music/night-theme-looping.mp3', loop: true, volume: 0.1 });

  function utcClock() {
    const d = new Date();
    const secs = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    const label = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
    return { t: secs / 86400, label };
  }
  let timeOfDay = utcClock().t;

  world.setSkyboxUri('skyboxes/partly-cloudy');
  world.setFogColor({ r: 200, g: 220, b: 240 });
  world.setFogNear(95); world.setFogFar(190);

  function tickSky() {
    const clock = utcClock();
    timeOfDay = clock.t;
    const daylight = Math.max(0, Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2));
    world.setAmbientLightIntensity(0.3 + daylight * 0.8);
    world.setDirectionalLightIntensity(daylight * 1.3);
    world.setSkyboxIntensity(0.25 + daylight * 0.85);
    world.setAmbientLightColor({ r: Math.round(lerp(70, 255, daylight)), g: Math.round(lerp(85, 250, daylight)), b: Math.round(lerp(150, 235, daylight)) });
    const ang = timeOfDay * Math.PI * 2;
    world.setDirectionalLightPosition({ x: Math.cos(ang) * 120, y: Math.max(15, Math.sin(ang) * 120), z: 60 });
    const isNight = daylight < 0.12;
    if (isNight !== night) { night = isNight; if (night) { dayMusic.pause(); nightMusic.play(world); } else { nightMusic.pause(); dayMusic.play(world); } }
    players.forEach(p => p.ui.sendData({ type: 'time', t: timeOfDay, phase: night ? 'night' : 'day', label: clock.label }));
  }
  // Start the correct music for the current UTC time, then run the cycle.
  night = Math.max(0, Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2)) < 0.12;
  (night ? nightMusic : dayMusic).play(world);
  setInterval(tickSky, STEP_MS);
  tickSky();

  /* --- Spawn point — next to a village if we built one ------------- */
  let spawn = { x: 0.5, y: heightAt(0, 0) + 3, z: 0.5 };
  if (cityCenter) {
    // On a street INSIDE the leveled city plaza, so there's solid pavement underfoot.
    spawn = { x: cityCenter.x + 6.5, y: cityCenter.gy + 3, z: cityCenter.z + 0.5 };
  } else if (villageCenters.length) {
    const v = villageCenters[0];
    spawn = { x: v.x + 14.5, y: heightAt(v.x + 14, v.z) + 3, z: v.z + 0.5 };
  } else {
    for (let r = 0; r <= WORLD_RADIUS; r += 2) {
      const h = heightAt(r, r);
      if (h > SEA_LEVEL + 1 && h < MOUNTAIN_LEVEL) { spawn = { x: r + 0.5, y: h + 3, z: r + 0.5 }; break; }
    }
  }

  /* --- Flatland: an empty flat creative plot (in the void, far from the terrain).
   * Block break/place is allowed ONLY here; the main survival world is protected.
   * Reach it with /build, return with /home. */
  const FLAT = { x: 400, z: 400, y: 64, half: 40 };
  const flatSpawn = { x: FLAT.x + 0.5, y: FLAT.y + 2, z: FLAT.z + 0.5 };
  const inFlatland = (x: number, z: number) => Math.abs(x - FLAT.x) <= FLAT.half + 1 && Math.abs(z - FLAT.z) <= FLAT.half + 1;
  const lastBlockMsg = new Map<any, number>();
  function buildBlocked(player: any) {
    const n = Date.now(); if (n - (lastBlockMsg.get(player) ?? 0) < 2500) return; lastBlockMsg.set(player, n);
    toast(player, '🚫 Build only in the Flatland — /build');
    world.chatManager.sendPlayerMessage(player, '🚫 Blocks can only be taken or placed in the Flatland. Type /build to go there · /home to return.', 'FF8844');
  }
  for (let x = FLAT.x - FLAT.half; x <= FLAT.x + FLAT.half; x++) for (let z = FLAT.z - FLAT.half; z <= FLAT.z + FLAT.half; z++) {
    setB(x, FLAT.y, z, BLOCK.GRASS);
    if (Math.abs(x - FLAT.x) === FLAT.half || Math.abs(z - FLAT.z) === FLAT.half) for (let y = FLAT.y + 1; y <= FLAT.y + 2; y++) setB(x, y, z, BLOCK.STONE); // rim so nobody falls into the void
  }
  console.log(`[world] flatland: ${FLAT.half * 2}x${FLAT.half * 2} build plot at (${FLAT.x}, ${FLAT.z})`);

  /* --- Building, guns & combat helpers ----------------------------- */
  const GUN_RANGE = 60, GUN_DAMAGE = 55, GUN_COOLDOWN_MS = 220;

  function castFromCamera(player: any, pe: PlayerEntity, range: number) {
    const dir = player.camera?.facingDirection;
    if (!dir) return null;
    // Start the ray slightly in FRONT of the player (eye height) so it never
    // self-hits the player's own collider, and aligns with the crosshair.
    const origin = { x: pe.position.x + dir.x * 0.6, y: pe.position.y + 0.7, z: pe.position.z + dir.z * 0.6 };
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
    if (!name || !isPlaceable(name)) return; // must hold a placeable block OR a prop
    const inv = getInv(player);
    if ((inv.get(name) ?? 0) <= 0) return;
    try {
      const coord = block.getNeighborGlobalCoordinateFromHitPoint(hitPoint);
      if (PLACEABLE.has(name)) {
        world.chunkLattice.setBlock(coord, BLOCK_NAME_TO_ID[name]); // voxel block
      } else {
        // furniture / structure prop → spawn an entity on top of the targeted cell
        const e = new Entity({ name: `prop:${name}`, modelUri: PROP_MODELS[name], modelScale: 1, rigidBodyOptions: { type: RigidBodyType.FIXED }, modelPreferredShape: ColliderShape.NONE });
        e.spawn(world, { x: coord.x + 0.5, y: propRestY(name, coord.y), z: coord.z + 0.5 }); // rest on the surface below
        placedProps.add(e);
      }
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
      // Attach as a held entity via the constructor (parent + node) — this is the
      // pattern the SDK shooter examples use; setParent-after-spawn doesn't render.
      const gun = new Entity({ name: 'Gun', modelUri: 'models/guns/ak47.gltf', modelScale: 0.6, parent: pe, parentNodeName: 'hand-right-anchor' });
      gun.spawn(world, { x: 0, y: 0.1, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
      gunEntity.set(player, gun);
      player.ui.sendData({ type: 'gun', equipped: true });
      world.chatManager.sendPlayerMessage(player, '🔫 AK-47 equipped! Aim with the crosshair, left-click to shoot · Q to holster.', 'FFCC00');
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

  /* --- Fishing visual effects (bobber float + a fish leaping on the strike) -- */
  // Rare fish item names match their model names; cod/salmon use their item models.
  const FISH_MODEL: Record<string, string> = { 'cod-raw': 'models/items/cod-raw.gltf', 'salmon-raw': 'models/items/salmon-raw.gltf' };
  const fishModelFor = (item: string) => FISH_MODEL[item] ?? `models/npcs/fish/${item}.gltf`;

  // Approximate the rod-tip world position (in front of the player at hand height).
  function rodTipOf(player: any, pe: PlayerEntity) {
    const d = player.camera?.facingDirection ?? { x: 0, y: 0, z: 1 };
    const hl = Math.hypot(d.x, d.z) || 1;
    return { x: pe.position.x + (d.x / hl) * 0.7, y: pe.position.y + 1.2, z: pe.position.z + (d.z / hl) * 0.7 };
  }
  const mkFx = (scale: number) => {
    try { return new Entity({ name: 'FishFX', modelUri: 'models/items/snowball.gltf', modelScale: scale,
      rigidBodyOptions: { type: RigidBodyType.KINEMATIC_POSITION }, modelPreferredShape: ColliderShape.NONE }); }
    catch { return null; }
  };
  function clearLine(player: any) {
    const fx = fishingFx.get(player); if (!fx) return;
    try { clearInterval(fx.iv); } catch {}
    try { fx.bobber?.despawn(); } catch {}
    for (const d of fx.line) { try { d.despawn(); } catch {} }
    fishingFx.delete(player);
  }
  // Quaternion that rotates the model's local +Z axis onto `dir` (so a z-stretched
  // model becomes a taut line pointing along dir).
  const quatToZ = (dx: number, dy: number, dz: number) => {
    const l = Math.hypot(dx, dy, dz) || 1; const bx = dx / l, by = dy / l, bz = dz / l;
    if (bz > 0.99999) return { x: 0, y: 0, z: 0, w: 1 };
    if (bz < -0.99999) return { x: 1, y: 0, z: 0, w: 0 };
    const cx = -by, cy = bx, w = 1 + bz; // cross((0,0,1), b) = (-by, bx, 0)
    const ql = Math.hypot(cx, cy, 0, w) || 1;
    return { x: cx / ql, y: cy / ql, z: 0, w: w / ql };
  };
  // Cast: the bobber is thrown from the rod tip, arcs out to the water, and a single
  // taut line connects the (moving) rod tip to it for the duration.
  function castLine(player: any, pe: PlayerEntity, wx: number, wz: number) {
    clearLine(player);
    const tip0 = rodTipOf(player, pe);
    const water = { x: wx, y: SEA_LEVEL + 1.0, z: wz };
    const bobber = mkFx(0.3); try { bobber?.spawn(world, tip0); } catch {}
    let lineE: Entity | null = null;
    try {
      lineE = new Entity({ name: 'FishLine', modelUri: 'models/items/snowball.gltf', modelScale: { x: 0.025, y: 0.025, z: 1 },
        rigidBodyOptions: { type: RigidBodyType.KINEMATIC_POSITION }, modelPreferredShape: ColliderShape.NONE });
      lineE.spawn(world, tip0);
    } catch {}
    let bpos = { ...tip0 }, t = 0; const throwSteps = 6;
    const iv = setInterval(() => {
      t++;
      if (t <= throwSteps) {                                   // throw arc: rod tip → water
        const f = t / throwSteps;
        bpos = { x: tip0.x + (water.x - tip0.x) * f, y: tip0.y + (water.y - tip0.y) * f + 1.4 * Math.sin(Math.PI * f), z: tip0.z + (water.z - tip0.z) * f };
        if (t === throwSteps) { try { new Audio({ uri: 'audio/sfx/liquid/splash-03.mp3', volume: 0.5 }).play(world); } catch {} }
      } else { bpos = water; }                                 // resting on the water
      try { bobber?.setPosition(bpos); } catch {}
      const tip = rodTipOf(player, pe);                         // follow the player if they move
      if (lineE) {
        const dx = bpos.x - tip.x, dy = bpos.y - tip.y, dz = bpos.z - tip.z, len = Math.hypot(dx, dy, dz) || 0.01;
        try {
          lineE.setPosition({ x: (tip.x + bpos.x) / 2, y: (tip.y + bpos.y) / 2, z: (tip.z + bpos.z) / 2 });
          lineE.setModelScale({ x: 0.03, y: 0.03, z: len });
          lineE.setRotation(quatToZ(dx, dy, dz));
        } catch {}
      }
    }, 50);
    fishingFx.set(player, { bobber, line: lineE ? [lineE] : [], iv });
  }

  // A fish leaps out of the water at (wx,wz) and arcs up toward the player as it's reeled in.
  function fishStrike(player: any, pe: PlayerEntity, wx: number, wz: number, item: string) {
    try { new Audio({ uri: 'audio/sfx/liquid/large-splash.mp3', volume: 0.7 }).play(world); } catch {}
    let fish: Entity;
    try {
      fish = new Entity({ name: 'CatchFX', modelUri: fishModelFor(item), modelScale: 0.7,
        rigidBodyOptions: { type: RigidBodyType.KINEMATIC_POSITION }, modelPreferredShape: ColliderShape.NONE });
      fish.spawn(world, { x: wx, y: SEA_LEVEL + 0.6, z: wz });
    } catch { return; }
    const sy = SEA_LEVEL + 0.6, ex = pe.position.x, ey = pe.position.y + 1.1, ez = pe.position.z;
    let t = 0; const steps = 12;
    const iv = setInterval(() => {
      t++; const f = t / steps;
      const x = wx + (ex - wx) * f, z = wz + (ez - wz) * f;
      const y = sy + (ey - sy) * f + 2.6 * Math.sin(Math.PI * f); // arc up, then down into the player's hands
      try { fish.setPosition({ x, y, z }); } catch {}
      if (t >= steps) { clearInterval(iv); try { fish.despawn(); } catch {} }
    }, 55);
  }

  /* --- Avatar cosmetics: hair as a child entity on the head-anchor (the same
   * pattern the SDK uses for platform cosmetics). hairId 0 = bald, 1..10 = styles.
   * Skin/outfit need atlas compositing (deferred); paid cosmetics come post-on-chain. */
  function applyHair(player: any, pe: PlayerEntity, hairId: number) {
    hairId = Math.max(0, Math.min(HAIR_COUNT, Math.floor(hairId) || 0));
    try { hairEntity.get(player)?.despawn(); } catch {} hairEntity.delete(player);
    cosmeticOf.set(player, { hair: hairId });
    if (hairId < 1) return; // bald
    try {
      const hair = new Entity({ name: 'Hair', modelUri: `models/players/hair/hair-${String(hairId).padStart(4, '0')}.gltf`,
        modelScale: 1, parent: pe, parentNodeName: 'head-anchor' });
      hair.spawn(world, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
      hairEntity.set(player, hair);
    } catch (e) { console.warn('hair error', e); }
  }

  /* --- Mining: trees & rocks are timed harvest nodes that regrow after 3 min.
   * A better tool (rarity tier) mines faster. Times: tree 3s, rock 5s, ore-rock 10s. */
  function bestToolTier(player: any, type: 'axe' | 'pickaxe'): number {
    const inv = getInv(player); let tier = 0;
    TOOL_TIERS.forEach((m, i) => { if ((inv.get(`${type}-${m}`) ?? 0) > 0) tier = Math.max(tier, i + 1); });
    return tier;
  }
  function respawnNode(meta: { uri: string; x: number; y: number; z: number; scale: number; kind: 'tree' | 'rock'; ore: string | null }) {
    try {
      const e = new Entity({ modelUri: meta.uri, modelScale: meta.scale, rigidBodyOptions: { type: RigidBodyType.FIXED } });
      e.spawn(world, { x: meta.x, y: meta.y, z: meta.z });
      nodeMeta.set(e, meta);
      if (meta.kind === 'tree') trees.add(e); else rocks.add(e);
    } catch {}
  }
  function harvestNode(player: any, target: Entity, kind: 'tree' | 'rock') {
    const meta = nodeMeta.get(target);
    if (kind === 'tree') { trees.delete(target); addItem(player, 'oak-log', 3 + Math.floor(Math.random() * 3)); toast(player, '🪵 Chopped a tree!'); }
    else {
      rocks.delete(target); addItem(player, 'stone', 2 + Math.floor(Math.random() * 3));
      if (meta?.ore) { addItem(player, meta.ore, 1 + Math.floor(Math.random() * 2)); toast(player, `⛏️ Mined ${meta.ore.replace('-', ' ')}!`); }
      else toast(player, '⛏️ Mined stone!');
    }
    nodeMeta.delete(target);
    try { target.despawn(); } catch {}
    try { new Audio({ uri: 'audio/sfx/ui/inventory-grab-item.mp3', volume: 0.5 }).play(world); } catch {}
    if (meta) setTimeout(() => respawnNode(meta), 180000); // regrows after 3 minutes
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

    // Open/close the marketplace shop (R) — works anywhere.
    if (input.r && !prev.r) { if (shopOpen.has(player)) closeShop(player); else openShop(player); }

    // Open/close the crafting Workbench (V) — works anywhere.
    if (input.v && !prev.v) { if (menuOpen.get(player) === 'workbench') closeMenu(player); else openMenu(player, 'workbench'); }

    // Fishing (X) — need a rod (any level) + bait, near water. Higher rod = faster + more rares.
    if (input.x && !prev.x && !fishing.has(player)) {
      const inv = getInv(player);
      const rodLv = (inv.get('fishing-rod-3') ?? 0) > 0 ? 3 : (inv.get('fishing-rod-2') ?? 0) > 0 ? 2 : (inv.get('fishing-rod') ?? 0) > 0 ? 1 : 0;
      if (rodLv > 0) {
        let nearWater = false, wx = pe.position.x, wz = pe.position.z; const bx = Math.round(pe.position.x), bz = Math.round(pe.position.z);
        for (let dx = -3; dx <= 3 && !nearWater; dx++) for (let dz = -3; dz <= 3; dz++) if (heightAt(bx + dx, bz + dz) < SEA_LEVEL) { nearWater = true; wx = bx + dx + 0.5; wz = bz + dz + 0.5; break; }
        if (nearWater) { // aim the cast at water in FRONT of the player (where they're looking), not just the nearest cell
          const fd = player.camera?.facingDirection ?? { x: 0, y: 0, z: 1 }, fl = Math.hypot(fd.x, fd.z) || 1;
          for (let r = 2; r <= 6; r++) { const cx = Math.round(pe.position.x + (fd.x / fl) * r), cz = Math.round(pe.position.z + (fd.z / fl) * r); if (heightAt(cx, cz) < SEA_LEVEL) { wx = cx + 0.5; wz = cz + 0.5; break; } }
        }
        if (!nearWater) { world.chatManager.sendPlayerMessage(player, '🎣 Stand near water — head to a fishing pier or the shore.', 'FF8844'); toast(player, '🎣 Stand closer to water'); }
        else if ((inv.get('bait') ?? 0) <= 0) {
          world.chatManager.sendPlayerMessage(player, '🪱 Out of bait — buy some at the Marketplace (R).', 'FF8844');
          toast(player, '🪱 Out of bait — buy at Marketplace (R)');
        }
        else {
          inv.set('bait', inv.get('bait')! - 1); if (inv.get('bait')! <= 0) inv.delete('bait'); sendHud(player);
          fishing.add(player);
          world.chatManager.sendPlayerMessage(player, '🎣 Cast! Waiting for a bite…', '88CCFF');
          toast(player, '🎣 Cast — reeling…');
          castLine(player, pe, wx, wz); // throw the bobber out to the water + draw the line
          // Show the rod in the player's hand for the duration (same held-entity pattern as the gun).
          try {
            rodEntity.get(player)?.despawn();
            const rod = new Entity({ name: 'Rod', modelUri: 'models/items/fishing-rod.gltf', modelScale: 0.6, parent: pe, parentNodeName: 'hand-right-anchor' });
            rod.spawn(world, { x: 0, y: 0.1, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
            rodEntity.set(player, rod);
          } catch (e) { console.warn('rod equip error', e); }
          try { (pe as any).startModelOneshotAnimations?.(['simple-interact']); } catch {}
          const rareChance = 0.1 + rodLv * 0.12;
          const delay = Math.max(1500, 4000 - rodLv * 600 + Math.random() * 2500);
          setTimeout(() => {
            try { rodEntity.get(player)?.despawn(); } catch {} rodEntity.delete(player); clearLine(player);
            if (!fishing.has(player)) return;
            fishing.delete(player);
            const roll = Math.random();
            const fish = roll < rareChance ? pick(['pufferfish', 'clownfish', 'catfish', 'parrotfish', 'lionfish', 'sailfish', 'swordfish', 'anglerfish'])
              : roll < rareChance + 0.4 ? 'salmon-raw' : 'cod-raw';
            addItem(player, fish);
            fishStrike(player, pe, wx, wz, fish); // the fish leaps from the water with a splash
            world.chatManager.sendPlayerMessage(player, `🎣 Caught a ${fish.replace(/-/g, ' ')}!`, '88FF88');
            toast(player, `🎣 Caught a ${fish.replace(/-/g, ' ')}!`);
          }, delay);
        }
      } else {
        world.chatManager.sendPlayerMessage(player, '🎣 You need a fishing-rod — press R to open the Marketplace, then buy one (15🪙).', 'FF8844');
        toast(player, '🎣 Need a fishing-rod (press R)');
      }
    }

    // Cook (C) — turn the selected raw fish into cooked.
    if (input.c && !prev.c) {
      const sel = selectedItemName(player);
      const cookable: Record<string, string> = { 'cod-raw': 'cod-cooked', 'salmon-raw': 'salmon-cooked' };
      if (sel && cookable[sel] && (getInv(player).get(sel) ?? 0) > 0) {
        const inv = getInv(player);
        inv.set(sel, inv.get(sel)! - 1); if (inv.get(sel)! <= 0) inv.delete(sel);
        addItem(player, cookable[sel]);
        new Audio({ uri: 'audio/sfx/player/eat.mp3', volume: 0.5 }).play(world);
        world.chatManager.sendPlayerMessage(player, `🍳 Cooked ${sel.replace('-raw', '')}!`, 'FFCC66');
      }
    }

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
          } else if (target && (trees.has(target) || rocks.has(target))) {
            const kind = trees.has(target) ? 'tree' : 'rock';
            const meta = nodeMeta.get(target);
            const base = kind === 'tree' ? 3000 : (meta?.ore ? 10000 : 5000); // 3s / 5s / 10s
            const tier = bestToolTier(player, kind === 'tree' ? 'axe' : 'pickaxe');
            const dur = Math.round(base * (TIER_SPEED[tier] ?? 1.7));
            const sess = mining.get(player);
            if (!sess || sess.target !== target) {
              mining.set(player, { target, endAt: now + dur, dur });
              toast(player, `${kind === 'tree' ? '🪓' : '⛏️'} Mining… ${(dur / 1000).toFixed(1)}s`);
              try { (pe as any).startModelOneshotAnimations?.(['sword-attack-1']); } catch {}
            } else if (now >= sess.endAt) {
              mining.delete(player); harvestNode(player, target, kind);
            } else if (now - (lastBuild.get(player) ?? 0) > 600) {
              lastBuild.set(player, now);
              toast(player, `${kind === 'tree' ? '🪓' : '⛏️'} ${Math.round((1 - (sess.endAt - now) / sess.dur) * 100)}%`);
              try { (pe as any).startModelOneshotAnimations?.(['sword-attack-1']); } catch {}
              try { new Audio({ uri: 'audio/sfx/player/player-swing-woosh.mp3', volume: 0.3 }).play(world); } catch {}
            }
          } else if (target && placedProps.has(target) && now - (lastBuild.get(player) ?? 0) > 200) {
            lastBuild.set(player, now);
            placedProps.delete(target);
            try { target.despawn(); } catch {}
            new Audio({ uri: 'audio/sfx/ui/inventory-grab-item.mp3', volume: 0.4 }).play(world);
          } else if (hit?.hitBlock && now - (lastBuild.get(player) ?? 0) > 200) {
            lastBuild.set(player, now);
            if (inFlatland(pe.position.x, pe.position.z)) breakBlock(player, hit.hitBlock);
            else buildBlocked(player);
          }
        }
      } catch (e) { console.warn('left-click error', e); }
    }

    // Right mouse: place a block on the targeted face.
    if (input.mr && !driving.has(player) && now - (lastBuild.get(player) ?? 0) > 200) {
      lastBuild.set(player, now);
      try {
        const hit = castFromCamera(player, pe, 6);
        if (hit?.hitBlock) { if (inFlatland(pe.position.x, pe.position.z)) placeBlock(player, hit.hitBlock, hit.hitPoint); else buildBlocked(player); }
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
    // Third-person camera: raise the focus over the head and shift over-the-shoulder
    // so the crosshair sits in open view, not on the character's head. Delayed so it
    // runs AFTER DefaultPlayerEntity's own async camera/cosmetic setup (which resets it).
    setTimeout(() => {
      try {
        player.camera.setMode(PlayerCameraMode.THIRD_PERSON);
        player.camera.setOffset({ x: 0, y: 1.4, z: 0 });
        player.camera.setFilmOffset(7);
      } catch (e) { console.warn('camera setup error', e); }
    }, 600);
    players.add(player);
    hp.set(player, MAX_HP);
    if (!inventory.has(player)) inventory.set(player, new Map());
    // Starter kit (blocks, props + gold to buy a rod + bait at the market).
    addItem(player, 'gold-ingot', 30);
    addItem(player, 'cobblestone', 40);
    addItem(player, 'oak-log', 20);
    addItem(player, 'fence', 12);
    addItem(player, 'lantern', 6);
    addItem(player, 'torch', 8);
    addItem(player, 'lamp-post', 4);

    try {
      pe.controller?.on(BaseEntityControllerEvent.TICK_WITH_PLAYER_INPUT, ({ input }: any) => {
        handleInput(player, pe, input);
      });
    } catch (e) { console.warn('input hook error', e); }

    // Receive UI events (shop buttons + login form).
    try {
      player.ui.on(PlayerUIEvent.DATA, ({ data }: any) => {
        handleShopUI(player, data);
        if (data?.type === 'auth') tryAuth(player, pe, data.mode, data.username, data.password, data.hair);
        if (data?.type === 'menu-action') handleMenuAction(player, data.action);
        if (data?.type === 'toggle-flat') {
          const pe2 = world.entityManager.getPlayerEntitiesByPlayer(player)[0] as PlayerEntity | undefined;
          if (pe2) (inFlatland(pe2.position.x, pe2.position.z) ? exitFlatland : enterFlatland)(player);
        }
      });
    } catch (e) { console.warn('ui hook error', e); }

    player.ui.load('ui/index.html');
    sendHud(player);
    player.ui.sendData({ type: 'time', t: timeOfDay, phase: night ? 'night' : 'day' });
    // Prompt login once the world has had time to stream in & render, so the
    // overlay appears over the game rather than the initial loading screen.
    setTimeout(() => {
      try { player.ui.sendData({ type: 'auth-required' }); player.ui.lockPointer(false); } catch {}
    }, 1800);

    world.chatManager.sendPlayerMessage(player, '🌲 Welcome to Survival Explorer!', '00FF00');
    world.chatManager.sendPlayerMessage(player, 'Explore biomes, collect items, fight Wumpus, drive vehicles.');
    world.chatManager.sendPlayerMessage(player, 'WASD move · Space jump · Shift sprint');
    world.chatManager.sendPlayerMessage(player, 'L-click attack/mine · R-click place selected block · Q gun');
    world.chatManager.sendPlayerMessage(player, '1-9 hotbar · E vehicle · F eat · R marketplace (anywhere)');
    world.chatManager.sendPlayerMessage(player, '🎣 Buy a fishing-rod, stand near water, press X to fish · C to cook fish');
    world.chatManager.sendPlayerMessage(player, '🏗️ The wild is protected — type /build to enter the Flatland and build freely (/home to return).');
    world.chatManager.sendPlayerMessage(player, 'Explore the villages! Commands: /build /home /heal /give /time');
  });

  world.on(PlayerEvent.LEFT_WORLD, ({ player }) => {
    saveProfile(player); // persist final inventory/gold
    players.delete(player);
    driving.delete(player);
    accountOf.delete(player); tokenOf.delete(player); authed.delete(player);
    try { gunEntity.get(player)?.despawn(); } catch {}
    gunEntity.delete(player);
    try { rodEntity.get(player)?.despawn(); } catch {}
    try { hairEntity.get(player)?.despawn(); } catch {}
    clearLine(player);
    rodEntity.delete(player); hairEntity.delete(player); cosmeticOf.delete(player); fishing.delete(player);
    world.entityManager.getPlayerEntitiesByPlayer(player).forEach(e => e.despawn());
  });

  world.on(PlayerEvent.RECONNECTED_WORLD, ({ player }) => {
    players.add(player);
    player.ui.load('ui/index.html');
    sendHud(player);
  });

  /* --- Commands ----------------------------------------------------- */
  const enterFlatland = (player: any) => {
    const pe = world.entityManager.getPlayerEntitiesByPlayer(player)[0] as PlayerEntity | undefined; if (!pe) return;
    if (driving.has(player)) dismount(player, pe);
    ['cobblestone', 'stone', 'bricks', 'oak-log', 'sand', 'grass-block'].forEach(b => addItem(player, b, 64));
    Object.keys(PROP_MODELS).forEach(p => addItem(player, p, 16));
    pe.setPosition(flatSpawn);
    world.chatManager.sendPlayerMessage(player, '🏗️ Welcome to the Flatland — build freely! Full kit added. /home or the button to return.', 'FFE066');
    toast(player, '🏗️ Flatland — build freely!');
    try { player.ui.sendData({ type: 'zone', flat: true }); } catch {}
  };
  const exitFlatland = (player: any) => {
    const pe = world.entityManager.getPlayerEntitiesByPlayer(player)[0] as PlayerEntity | undefined; if (!pe) return;
    if (driving.has(player)) dismount(player, pe);
    pe.setPosition(spawn);
    toast(player, '🏠 Back to the world');
    try { player.ui.sendData({ type: 'zone', flat: false }); } catch {}
  };
  world.chatManager.registerCommand('/home', exitFlatland);
  world.chatManager.registerCommand('/heal', player => { hp.set(player, MAX_HP); sendHud(player); world.chatManager.sendPlayerMessage(player, 'Healed to full.', '66FF66'); });
  world.chatManager.registerCommand('/give', player => { COLLECTIBLES.forEach(n => addItem(player, n, 1)); world.chatManager.sendPlayerMessage(player, 'Gave one of each item.', 'FFE066'); });
  world.chatManager.registerCommand('/hair', (player, args) => {
    const pe = world.entityManager.getPlayerEntitiesByPlayer(player)[0] as PlayerEntity | undefined;
    if (!pe) return;
    const n = Math.max(0, Math.min(HAIR_COUNT, parseInt(args[0] ?? '', 10) || 0));
    applyHair(player, pe, n); saveProfile(player);
    world.chatManager.sendPlayerMessage(player, n === 0 ? `💇 Bald. (/hair 1–${HAIR_COUNT} to pick a style)` : `💇 Hair style ${n}/${HAIR_COUNT} equipped.`, 'FFE066');
  });
  world.chatManager.registerCommand('/build', enterFlatland);
  world.chatManager.registerCommand('/time', player => world.chatManager.sendPlayerMessage(player, `It is ${night ? 'night' : 'day'} (t=${timeOfDay.toFixed(2)}).`));

  /* --- City building services (marketplace, clinic, …) ------------- */
  // gold-ingot is the currency. Prices below are in gold.
  // Buy stock split into marketplace categories (tabs).
  const SHOP_CATEGORIES: Record<string, Record<string, number>> = {
    items: { cobblestone: 1, 'oak-log': 2, stone: 2, bricks: 3, lantern: 3, fence: 1, 'lamp-post': 4, torch: 1, bench: 3, chest: 4, barrel: 2, bookshelf: 5 },
    vehicles: { pickup: 50, 'school-bus': 140, jetski: 80, boat: 60, kayak: 35, paddle: 30 },
    tools: { 'axe-wood': 8, 'pickaxe-wood': 8, 'axe-stone': 20, 'pickaxe-stone': 20, 'axe-iron': 50, 'pickaxe-iron': 50, 'axe-gold': 110, 'pickaxe-gold': 110 },
    fishing: { bait: 1, 'fishing-rod': 15, 'fishing-rod-2': 45, 'fishing-rod-3': 120 },
    health: { 'golden-apple': 8, bread: 2, cookie: 1, melon: 2, 'cod-cooked': 5, 'salmon-cooked': 8 },
  };
  const SHOP_BUY: Record<string, number> = Object.assign({}, ...Object.values(SHOP_CATEGORIES));
  // Sell: every fish + rare + staple item.
  const SHOP_SELL: Record<string, number> = {
    'cod-raw': 2, 'salmon-raw': 3, 'cod-cooked': 4, 'salmon-cooked': 6,
    pufferfish: 7, clownfish: 6, catfish: 5, parrotfish: 7, lionfish: 9, sailfish: 11, swordfish: 13, anglerfish: 12,
    bone: 1, book: 1, compass: 2, clock: 2, 'gold-nugget': 1, 'gold-ingot': 0, 'iron-ingot': 3, 'iron-nugget': 1,
    feather: 1, 'creepy-eye': 2, 'ink-bottle': 2, paper: 1, milk: 2, firework: 3, 'name-tag': 4, melon: 1,
    // mined blocks + foraged collectibles are all sellable too
    cobblestone: 1, stone: 1, bricks: 2, 'oak-log': 1, sand: 1, 'grass-block': 1, 'coal-ore': 3, 'iron-ore': 4, 'gold-ore': 6,
    carrot: 1, 'golden-apple': 4, bread: 1, cookie: 1, plank: 1, stick: 1,
    // tools (rarity-priced) + crafted goods are sellable
    'axe-wood': 4, 'pickaxe-wood': 4, 'axe-stone': 10, 'pickaxe-stone': 10, 'axe-iron': 25, 'pickaxe-iron': 25,
    'axe-gold': 55, 'pickaxe-gold': 55, 'axe-diamond': 120, 'pickaxe-diamond': 120,
  };
  delete (SHOP_SELL as any)['gold-ingot']; // never sell the currency itself
  const playerBuilding = new Map<any, any>();
  const shopOpen = new Set<any>();
  const goldOf = (player: any) => getInv(player).get('gold-ingot') ?? 0;
  const inMarket = (player: any) => playerBuilding.get(player)?.type === 'market';

  function buildingAt(pe: PlayerEntity) {
    for (const b of functionalBuildings) {
      // Only when actually inside the building footprint (walls sit at ±4), not just beside it.
      if (Math.abs(pe.position.x - (b.x + 0.5)) <= 3.5 && Math.abs(pe.position.z - (b.z + 0.5)) <= 3.5) return b;
    }
    return null;
  }

  function buyItem(player: any, item: string): string {
    item = (item || '').toLowerCase();
    const price = SHOP_BUY[item];
    if (!price) return `Can't buy "${item}".`;
    if (goldOf(player) < price) return `Need ${price} 🪙 (have ${goldOf(player)}).`;
    const inv = getInv(player);
    inv.set('gold-ingot', goldOf(player) - price);
    if ((inv.get('gold-ingot') ?? 0) <= 0) inv.delete('gold-ingot');
    new Audio({ uri: 'audio/sfx/ui/inventory-grab-item.mp3', volume: 0.5 }).play(world);
    if (VEHICLE_SPEC[item]) { // spawn the vehicle beside the buyer instead of inventory
      const spec = VEHICLE_SPEC[item];
      const pe = world.entityManager.getPlayerEntitiesByPlayer(player)[0] as PlayerEntity | undefined;
      if (pe) {
        const model = item === 'pickup' ? pickupModel() : `models/vehicles/${spec.model}.gltf`;
        spawnVehicle(model, spec.kind, Math.round(pe.position.x) + 2, Math.round(pe.position.z));
      }
      closeShop(player);
      return `Bought a ${spec.emoji} ${item.replace('-', ' ')} — parked next to you! ${spec.kind === 'water' ? 'Drive it on water · ' : ''}Press E to drive.`;
    }
    addItem(player, item, 1);
    return `Bought ${item} (−${price} 🪙)`;
  }

  function sellItem(player: any, item: string): string {
    item = (item || '').toLowerCase();
    const price = SHOP_SELL[item];
    if (!price) return `Can't sell "${item}".`;
    const inv = getInv(player);
    if ((inv.get(item) ?? 0) <= 0) return `You have no ${item}.`;
    inv.set(item, inv.get(item)! - 1);
    if (inv.get(item)! <= 0) inv.delete(item);
    addItem(player, 'gold-ingot', price);
    new Audio({ uri: 'audio/sfx/ui/inventory-place-item.mp3', volume: 0.5 }).play(world);
    return `Sold ${item} (+${price} 🪙)`;
  }

  const stockRow = (player: any, k: string, v: number) => ({ item: k, price: v, emoji: ITEM_EMOJI[k] ?? '📦', have: getInv(player).get(k) ?? 0 });
  function sendShopState(player: any) {
    const cats: Record<string, any[]> = {};
    for (const [cat, items] of Object.entries(SHOP_CATEGORIES)) cats[cat] = Object.entries(items).map(([k, v]) => stockRow(player, k, v));
    cats.sell = Object.entries(SHOP_SELL).map(([k, v]) => stockRow(player, k, v));
    player.ui.sendData({ type: 'shop', open: true, gold: goldOf(player), cats });
  }

  /* --- Clinic / Tavern menu pages ---------------------------------- */
  /* --- Crafting: a Workbench (V key) turns mined/chopped materials into planks,
   * sticks, ingots, bricks and tiered tools. Each craft takes 3s / 5s / 10s. */
  const CRAFT_RECIPES: Record<string, { in: Record<string, number>; out: number; time: number; label: string }> = {
    plank: { in: { 'oak-log': 1 }, out: 4, time: 3000, label: '🟫 Planks ×4' },
    stick: { in: { plank: 2 }, out: 4, time: 3000, label: '🪵 Sticks ×4' },
    bricks: { in: { stone: 4 }, out: 4, time: 3000, label: '🧱 Bricks ×4' },
    'iron-ingot': { in: { 'iron-ore': 2 }, out: 1, time: 5000, label: '⚙️ Iron Ingot (smelt)' },
    'axe-wood': { in: { plank: 3, stick: 2 }, out: 1, time: 3000, label: '🪓 Wood Axe (Common)' },
    'pickaxe-wood': { in: { plank: 3, stick: 2 }, out: 1, time: 3000, label: '⛏️ Wood Pickaxe (Common)' },
    'axe-stone': { in: { stone: 3, stick: 2 }, out: 1, time: 5000, label: '🪓 Stone Axe (Uncommon)' },
    'pickaxe-stone': { in: { stone: 3, stick: 2 }, out: 1, time: 5000, label: '⛏️ Stone Pickaxe (Uncommon)' },
    'axe-iron': { in: { 'iron-ingot': 3, stick: 2 }, out: 1, time: 10000, label: '🪓 Iron Axe (Rare)' },
    'pickaxe-iron': { in: { 'iron-ingot': 3, stick: 2 }, out: 1, time: 10000, label: '⛏️ Iron Pickaxe (Rare)' },
  };
  const crafting = new Set<any>(); // players mid-craft (one at a time)
  function craftItem(player: any, key: string) {
    const r = CRAFT_RECIPES[key]; if (!r) return;
    if (crafting.has(player)) { toast(player, '⏳ Already crafting…'); return; }
    const inv = getInv(player);
    for (const [m, q] of Object.entries(r.in)) if ((inv.get(m) ?? 0) < q) { toast(player, `❌ Need ${q} ${m.replace(/-/g, ' ')}`); return; }
    for (const [m, q] of Object.entries(r.in)) { inv.set(m, inv.get(m)! - q); if (inv.get(m)! <= 0) inv.delete(m); }
    sendHud(player); crafting.add(player);
    toast(player, `🔨 Crafting… ${(r.time / 1000).toFixed(0)}s`);
    if (menuOpen.get(player) === 'workbench') sendMenu(player, 'workbench');
    setTimeout(() => {
      crafting.delete(player);
      addItem(player, key, r.out);
      toast(player, `✅ Crafted ${r.label}`);
      try { new Audio({ uri: 'audio/sfx/ui/inventory-place-item.mp3', volume: 0.5 }).play(world); } catch {}
      if (menuOpen.get(player) === 'workbench') sendMenu(player, 'workbench');
    }, r.time);
  }

  const menuOpen = new Map<any, string>(); // player -> 'clinic' | 'tavern' | 'workbench'
  function sendMenu(player: any, kind: string) {
    let title: string, buttons: { label: string; action: string }[];
    if (kind === 'clinic') { title = '🏥 Clinic'; buttons = [{ label: '❤️ Heal to full (free)', action: 'heal' }, { label: '🩹 Buy a Golden Apple (8🪙)', action: 'buy-apple' }]; }
    else if (kind === 'workbench') {
      title = '🔨 Workbench — craft';
      const inv = getInv(player);
      buttons = Object.entries(CRAFT_RECIPES).map(([k, r]) => {
        const cost = Object.entries(r.in).map(([m, q]) => `${q} ${m.replace(/-/g, ' ')}`).join(' + ');
        const can = Object.entries(r.in).every(([m, q]) => (inv.get(m) ?? 0) >= q);
        return { label: `${r.label} — ${cost}${can ? '' : ' ❌'}`, action: `craft:${k}` };
      });
    }
    else { title = '🍺 Tavern'; buttons = [{ label: '🍳 Cook all raw fish', action: 'cook-all' }, { label: '🍺 Order a meal (+40 HP, 3🪙)', action: 'meal' }, { label: '🛏️ Rest (restore HP, free)', action: 'rest' }]; }
    player.ui.sendData({ type: 'menu', open: true, kind, title, gold: goldOf(player), hp: hp.get(player) ?? MAX_HP, buttons });
  }
  function openMenu(player: any, kind: string) { menuOpen.set(player, kind); try { player.ui.lockPointer(false); } catch {} sendMenu(player, kind); }
  function closeMenu(player: any) { if (!menuOpen.has(player)) return; menuOpen.delete(player); try { player.ui.sendData({ type: 'menu', open: false }); player.ui.lockPointer(true); } catch {} }
  function handleMenuAction(player: any, action: string) {
    const kind = menuOpen.get(player);
    if (action === 'close') { closeMenu(player); return; }
    if (action.startsWith('craft:')) { craftItem(player, action.slice(6)); return; }
    if (action === 'heal' || action === 'rest') { hp.set(player, MAX_HP); sendHud(player); world.chatManager.sendPlayerMessage(player, '❤️ Fully healed.', '66FF66'); }
    else if (action === 'buy-apple') { world.chatManager.sendPlayerMessage(player, buyItem(player, 'golden-apple'), '88FF88'); }
    else if (action === 'meal') { if (goldOf(player) >= 3) { const inv = getInv(player); inv.set('gold-ingot', goldOf(player) - 3); hp.set(player, MAX_HP); sendHud(player); world.chatManager.sendPlayerMessage(player, '🍺 Enjoyed a hearty meal! (+HP)', '66FF66'); } else world.chatManager.sendPlayerMessage(player, 'Need 3 🪙.', 'FF8844'); }
    else if (action === 'cook-all') {
      const inv = getInv(player); let cooked = 0;
      for (const [raw, done] of [['cod-raw', 'cod-cooked'], ['salmon-raw', 'salmon-cooked']] as const) {
        const n = inv.get(raw) ?? 0; if (n > 0) { inv.delete(raw); addItem(player, done, n); cooked += n; }
      }
      sendHud(player);
      world.chatManager.sendPlayerMessage(player, cooked ? `🍳 Cooked ${cooked} fish.` : 'No raw fish to cook.', 'FFCC66');
    }
    if (kind) sendMenu(player, kind); // refresh
  }
  function openShop(player: any) {
    shopOpen.add(player); // marketplace is global now — open from anywhere with R
    try { player.ui.lockPointer(false); } catch {}
    sendShopState(player);
  }
  function closeShop(player: any) {
    if (!shopOpen.has(player)) return;
    shopOpen.delete(player);
    try { player.ui.sendData({ type: 'shop', open: false }); player.ui.lockPointer(true); } catch {}
  }
  // Handle button clicks sent from the shop UI.
  function handleShopUI(player: any, data: any) {
    if (!data || !data.type) return;
    if (data.type === 'buy' || data.type === 'sell') {
      const msg = data.type === 'buy' ? buyItem(player, data.item) : sellItem(player, data.item);
      world.chatManager.sendPlayerMessage(player, msg, '88FF88');
      if (shopOpen.has(player)) sendShopState(player);
    } else if (data.type === 'shop-close') {
      closeShop(player);
    }
  }

  // Proximity tick: entering the Clinic/Tavern opens its menu page; leaving closes it.
  setInterval(() => {
    for (const player of players) {
      const pe = world.entityManager.getPlayerEntitiesByPlayer(player)[0] as PlayerEntity | undefined;
      if (!pe) continue;
      const b = buildingAt(pe);
      const prev = playerBuilding.get(player);
      if (b?.type !== prev?.type) {
        playerBuilding.set(player, b ?? null);
        if (b?.type === 'clinic') openMenu(player, 'clinic');
        else if (b?.type === 'tavern') openMenu(player, 'tavern');
        else if (menuOpen.has(player) && menuOpen.get(player) !== 'workbench') closeMenu(player);
      }
    }
  }, 1000);

  world.chatManager.registerCommand('/shop', player => openShop(player));
  world.chatManager.registerCommand('/buy', (player, args) => { world.chatManager.sendPlayerMessage(player, buyItem(player, args[0]), '88FF88'); if (shopOpen.has(player)) sendShopState(player); });
  world.chatManager.registerCommand('/sell', (player, args) => { world.chatManager.sendPlayerMessage(player, sellItem(player, args[0]), '88FF88'); if (shopOpen.has(player)) sendShopState(player); });

  /* --- Accounts: log in via the in-game overlay, persist to the backend --- */
  const CUBIT_BACKEND = process.env.CUBIT_BACKEND_URL ?? 'http://localhost:3001';
  const accountOf = new Map<any, string>(); // player -> username
  const tokenOf = new Map<any, string>();    // player -> JWT
  const authed = new Set<any>();

  async function tryAuth(player: any, pe: PlayerEntity, mode: string, username: string, password: string, hair?: number) {
    if (mode === 'guest') {
      try { player.ui.sendData({ type: 'auth-ok', username: 'Guest' }); player.ui.lockPointer(true); } catch {}
      world.chatManager.sendPlayerMessage(player, 'Playing as Guest — progress will NOT be saved.', 'FFAA44');
      return;
    }
    try {
      const res = await fetch(`${CUBIT_BACKEND}/api/${mode === 'signup' ? 'signup' : 'login'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      });
      const data: any = await res.json();
      if (!res.ok) { player.ui.sendData({ type: 'auth-err', msg: data.error || 'Failed.' }); return; }
      accountOf.set(player, data.username); tokenOf.set(player, data.token); authed.add(player);
      // Load saved profile (inventory/gold/hp).
      try {
        const pr = await fetch(`${CUBIT_BACKEND}/api/profile`, { headers: { Authorization: `Bearer ${data.token}` } });
        const prof: any = await pr.json();
        if (prof?.data?.inventory && Object.keys(prof.data.inventory).length) {
          const inv = getInv(player); inv.clear();
          for (const [k, v] of Object.entries(prof.data.inventory)) inv.set(k, Number(v));
          if (typeof prof.data.hp === 'number') hp.set(player, prof.data.hp);
          world.chatManager.sendPlayerMessage(player, '💾 Progress restored.', '88FF88');
        }
        applyHair(player, pe, Number(prof?.data?.cosmetic?.hair ?? 0)); // restore avatar look
      } catch {}
      if (mode === 'signup') {
        // Signup bonus: 1000 coins. TEMPORARY placeholder — to be replaced by an
        // on-chain $CUBIT balance (Solana) once payments are wired up.
        addItem(player, 'gold-ingot', SIGNUP_BONUS_COINS);
        if (hair != null) applyHair(player, pe, Number(hair)); // the avatar look chosen on the signup screen
        world.chatManager.sendPlayerMessage(player, `🪙 Welcome bonus: +${SIGNUP_BONUS_COINS} coins!`, 'FFD700');
        toast(player, `🪙 +${SIGNUP_BONUS_COINS} coin signup bonus!`);
        await saveProfile(player); // persist immediately so the bonus + look survive a quick disconnect
      }
      sendHud(player);
      try { (pe as any).nametagSceneUI?.setState({ username: data.username, profilePictureUrl: '' }); } catch {} // change the floating name
      try { player.ui.sendData({ type: 'auth-ok', username: data.username }); player.ui.lockPointer(true); } catch {}
      world.chatManager.sendPlayerMessage(player, `✅ Logged in as ${data.username}. Progress auto-saves.`, '00FF00');
    } catch (e) { try { player.ui.sendData({ type: 'auth-err', msg: 'Cannot reach account server.' }); } catch {} console.warn('auth error', e); }
  }

  async function saveProfile(player: any) {
    const token = tokenOf.get(player); if (!token) return;
    const inventory: Record<string, number> = {};
    for (const [k, v] of getInv(player)) inventory[k] = v;
    try {
      await fetch(`${CUBIT_BACKEND}/api/profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ data: { inventory, hp: hp.get(player) ?? MAX_HP, cosmetic: cosmeticOf.get(player) ?? { hair: 0 } } }),
      });
    } catch {}
  }

  setInterval(() => { for (const p of authed) saveProfile(p); }, 30000); // periodic autosave

  console.log('[world] Survival Explorer v2 ready.');
});
