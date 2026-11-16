import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Low-poly snow-loaded Lapland trees ("tykky"), with seeded variants.
 *
 *   import { createSnowTree, createSnowForest, TREE_TYPES } from './snowTrees';
 *
 *   // one tree (a Mesh, origin at its base)
 *   const tree = createSnowTree('hook', { seed: 4 });
 *   tree.position.set(x, terrain.heightAt(x, z), z);
 *   scene.add(tree);
 *
 *   // a whole forest, instanced (a few draw calls for hundreds of trees)
 *   const forest = createSnowForest({
 *     count: 250,
 *     bounds: [-60, 60, -90, -20],          // minX, maxX, minZ, maxZ
 *     heightAt: terrain.heightAt,
 *     exclude: (x, z) => nearLake(x, z),   // optional: keep areas clear
 *   });
 *   scene.add(forest);
 *
 * Types:
 *   column  slender spruce encased in lumpy snow
 *   hook    column whose top curls over under the snow load
 *   ghost   chunky "snow monster" with drooping arms
 *   pine    Scots pine: visible trunk, clumpy snow pads
 *   spruce  greener tiered spruce, lightly dusted (forest edges, lower ground)
 *   mound   small buried sapling
 *   arch    young tree bent into an arch by the snow
 *
 * Every tree is a single merged geometry with vertex colours, so all trees can
 * share one material. The same `type` + `seed` always gives the same tree.
 */

export const TREE_TYPES = ['column', 'hook', 'ghost', 'pine', 'spruce', 'mound', 'arch'] as const;
export type TreeType = (typeof TREE_TYPES)[number];
/** Relative weights per tree type; types left out don't appear. */
export type TreeMix = Partial<Record<TreeType, number>>;
export type TreeDetail = 'high' | 'low';
export type TreeColors = typeof DEFAULT_TREE_COLORS;

export const DEFAULT_TREE_HEIGHTS: Record<TreeType, number> = {
  column: 8, hook: 8.5, ghost: 6, pine: 10, spruce: 7, mound: 1.3, arch: 1.4,
};

export const DEFAULT_TREE_COLORS = {
  snow: '#f3f6fc',
  snowShade: '#c2cee6', // undersides of snow lumps
  needles: '#2c4a3b',
  needlesDark: '#203a2f',
  bark: '#5c4a3e',
  pineBark: '#7a6150',
};

/** Shared default material: vertex colours, flat shading. */
export function createSnowTreeMaterial() {
  return new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
}

// ---------------------------------------------------------------------------
// geometry builder
// ---------------------------------------------------------------------------

function makeBuilder(seed: number, colors: TreeColors, lowDetail = false) {
  let state = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  const rnd = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const parts: THREE.BufferGeometry[] = [];
  const col = new THREE.Color();

  // Deterministic per-vertex noise, so duplicated vertices of a face move together.
  const hash = (x: number, y: number, z: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };

  function push(geo: THREE.BufferGeometry, color: string, isSnow: boolean) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    const s = new Float32Array(n);
    col.set(color);
    for (let i = 0; i < n; i++) {
      c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
      s[i] = isSnow ? 1 : 0;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('snow', new THREE.BufferAttribute(s, 1));
    parts.push(g);
  }

  /** A lumpy ellipsoid. */
  function blob(x: number, y: number, z: number, rx: number, ry: number, rz: number, color = colors.snow, detail = rx > 0.55 ? 1 : 0, jitter = 0.2) {
    const g = new THREE.IcosahedronGeometry(1, lowDetail ? 0 : detail);
    const p = g.attributes.position;
    const sd = rnd() * 1000;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      const k = 1 + hash(vx * 3.1 + sd, vy * 2.7 - sd, vz * 1.9) * jitter;
      p.setXYZ(i, vx * k, vy * k, vz * k);
    }
    g.rotateY(rnd() * Math.PI * 2);
    g.scale(rx, ry, rz);
    g.rotateX((rnd() - 0.5) * 0.7);
    g.rotateZ((rnd() - 0.5) * 0.7);
    g.translate(x, y, z);
    push(g, color, color === colors.snow);
  }

  const up = new THREE.Vector3(0, 1, 0);
  /** A tapered cylinder between two points. */
  function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, color: string, seg = 5) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    push(g, color, false);
  }

  /** A jittered cone (tier of a spruce). */
  function cone(x: number, y: number, z: number, r: number, h: number, color: string, seg = 7) {
    const g = new THREE.ConeGeometry(r, h, seg, 1);
    const p = g.attributes.position;
    const sd = rnd() * 1000;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) < 0) {
        const k = 1 + hash(p.getX(i) + sd, 0, p.getZ(i)) * 0.18;
        p.setXYZ(i, p.getX(i) * k, p.getY(i) + hash(p.getZ(i), sd, p.getX(i)) * h * 0.08, p.getZ(i) * k);
      }
    }
    g.rotateY(rnd() * Math.PI * 2);
    g.translate(x, y + h / 2, z);
    push(g, color, color === colors.snow);
  }

  function finish() {
    const merged = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    merged.computeVertexNormals(); // non-indexed: one normal per face (low-poly look)
    // Shade the undersides of snow so lumps read as lumps.
    const n = merged.attributes.normal;
    const c = merged.attributes.color;
    const s = merged.attributes.snow;
    const shade = new THREE.Color(colors.snowShade);
    const base = new THREE.Color();
    for (let i = 0; i < c.count; i++) {
      if (!s.getX(i)) continue;
      const ny = n.getY(i);
      const t = Math.min(1, Math.max(0, (0.25 - ny) * 0.9));
      base.setRGB(c.getX(i), c.getY(i), c.getZ(i)).lerp(shade, t);
      c.setXYZ(i, base.r, base.g, base.b);
    }
    merged.deleteAttribute('snow');
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  return { rnd, blob, limb, cone, finish, V: (x: number, y: number, z: number) => new THREE.Vector3(x, y, z) };
}

type Builder = ReturnType<typeof makeBuilder>;
type BuildTree = (b: Builder, H: number, colors: TreeColors) => void;

// ---------------------------------------------------------------------------
// tree types
// ---------------------------------------------------------------------------

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Stacked lumps around a (gently leaning) axis. Returns the axis function. */
function snowColumn(b: Builder, H: number, colors: TreeColors, { width = 1, from = 0, to = 1, baseR = 1.05, topR = 0.32, greenChance = 0.35 } = {}) {
  const { rnd, blob } = b;
  const lx = (rnd() - 0.5) * 0.9;
  const lz = (rnd() - 0.5) * 0.9;
  const axis = (y: number): [number, number] => [lx * (y / H) ** 2, lz * (y / H) ** 2];
  const n = Math.max(3, Math.round((H * (to - from)) / 0.36));
  for (let i = 0; i < n; i++) {
    const t = from + (i / (n - 1)) * (to - from);
    const y = 0.4 + t * (H - 0.8);
    const [ax, az] = axis(y);
    const r = lerp(baseR, topR, t) * (0.8 + rnd() * 0.4) * width;
    const count = 2 + (rnd() < 0.6 ? 1 : 0);
    for (let j = 0; j < count; j++) {
      const ang = rnd() * Math.PI * 2;
      const off = r * (0.25 + rnd() * 0.25);
      blob(
        ax + Math.cos(ang) * off, y + (rnd() - 0.5) * 0.25, az + Math.sin(ang) * off,
        r * (0.65 + rnd() * 0.3), r * (0.62 + rnd() * 0.25), r * (0.65 + rnd() * 0.3),
      );
    }
    // Snow ledges that stick out and droop.
    if (rnd() < 0.3 && t < 0.85) {
      const ang = rnd() * Math.PI * 2;
      blob(ax + Math.cos(ang) * r * 0.85, y - 0.08, az + Math.sin(ang) * r * 0.85, r * 0.48, r * 0.36, r * 0.48);
    }
    // Needles peeking through (not right at the ground).
    if (y > 1.3 && rnd() < greenChance) {
      const ang = rnd() * Math.PI * 2;
      blob(ax + Math.cos(ang) * r * 0.66, y - 0.12, az + Math.sin(ang) * r * 0.66, r * 0.26, r * 0.24, r * 0.26, colors.needles, 0);
    }
  }
  return axis;
}

const BUILDERS: Record<TreeType, BuildTree> = {
  column(b, H, colors) {
    const { rnd, blob, limb, V } = b;
    const width = 0.85 + rnd() * 0.3;
    const axis = snowColumn(b, H, colors, { width });
    const [tx, tz] = axis(H);
    limb(V(0, 0, 0), V(tx * 0.8, H * 0.9, tz * 0.8), 0.13, 0.05, colors.bark);
    blob(tx, H - 0.25, tz, 0.3 * width, 0.34, 0.3 * width);
    blob(tx + 0.05, H + 0.05, tz, 0.2 * width, 0.24, 0.2 * width, colors.snow, 0);
  },

  hook(b, H, colors) {
    const { rnd, blob, limb, V } = b;
    const width = 0.8 + rnd() * 0.25;
    const straight = 0.68 + rnd() * 0.08;
    const axis = snowColumn(b, H, colors, { width, to: straight, topR: 0.5 });
    // Curl the top over: walk along an arc whose bend increases.
    const y0 = 0.4 + straight * (H - 0.8);
    const [ax, az] = axis(y0);
    const p = V(ax, y0, az);
    const yaw = rnd() * Math.PI * 2;
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    let theta = 0.1;
    const steps = 12 + Math.floor(rnd() * 3);
    const maxBend = 2.3 + rnd() * 0.6;
    limb(V(0, 0, 0), V(ax, y0, az), 0.13, 0.07, colors.bark);
    for (let k = 0; k < steps; k++) {
      const t = k / (steps - 1);
      theta = lerp(0.15, maxBend, t ** 1.4);
      const step = 0.27;
      p.x += Math.sin(theta) * dx * step;
      p.z += Math.sin(theta) * dz * step;
      p.y += Math.cos(theta) * step;
      const r = lerp(0.52, 0.26, t) * width;
      blob(p.x, p.y, p.z, r, r * 0.9, r);
      if (rnd() < 0.2) blob(p.x, p.y - r * 0.6, p.z, r * 0.4, r * 0.35, r * 0.4, colors.needles, 0);
    }
  },

  ghost(b, H, colors) {
    const { rnd, blob, limb, V } = b;
    const width = 1.15 + rnd() * 0.3;
    const axis = snowColumn(b, H, colors, { width, baseR: 1.25, topR: 0.6, greenChance: 0.2 });
    limb(V(0, 0, 0), V(0, H * 0.6, 0), 0.16, 0.08, colors.bark);
    // Drooping arms.
    const arms = 2 + Math.floor(rnd() * 2);
    for (let a = 0; a < arms; a++) {
      const y = H * lerp(0.35, 0.8, rnd());
      const [ax, az] = axis(y);
      const yaw = rnd() * Math.PI * 2;
      let x = ax, z = az, yy = y, r = 0.62 * width;
      const segs = 3 + Math.floor(rnd() * 2);
      for (let k = 0; k < segs; k++) {
        x += Math.cos(yaw) * r * 0.85;
        z += Math.sin(yaw) * r * 0.85;
        yy -= 0.14 + k * 0.06;
        blob(x, yy, z, r, r * 0.72, r);
        r *= 0.8;
      }
      blob(x + Math.cos(yaw) * r * 0.3, yy - r * 0.9, z + Math.sin(yaw) * r * 0.3, r * 0.6, r * 0.9, r * 0.6); // drip
    }
    // A head that leans off to one side.
    const [hx, hz] = axis(H);
    const hy = rnd() * Math.PI * 2;
    blob(hx + Math.cos(hy) * 0.35, H - 0.05, hz + Math.sin(hy) * 0.35, 0.55 * width, 0.5, 0.5 * width);
    blob(hx + Math.cos(hy) * 0.75, H + 0.2, hz + Math.sin(hy) * 0.75, 0.32 * width, 0.3, 0.3 * width);
  },

  pine(b, H, colors) {
    const { rnd, blob, limb, V } = b;
    const lean = [(rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5];
    const at = (y: number): [number, number] => [lean[0] * (y / H), lean[1] * (y / H)];
    const [tx, tz] = at(H);
    limb(V(0, 0, 0), V(tx * 0.55, H * 0.55, tz * 0.55), 0.2, 0.12, colors.pineBark, 6);
    limb(V(tx * 0.55, H * 0.55, tz * 0.55), V(tx, H * 0.97, tz), 0.12, 0.04, colors.pineBark, 6);
    const levels = 11 + Math.floor(rnd() * 3);
    let ang = rnd() * Math.PI * 2;
    for (let i = 0; i < levels; i++) {
      const t = i / (levels - 1);
      const y = lerp(H * 0.24, H * 0.95, t);
      const [ax, az] = at(y);
      const clumps = rnd() < 0.6 ? 2 : 1;
      for (let c = 0; c < clumps; c++) {
        ang += 2.4 + (rnd() - 0.5) * 0.6; // golden-angle-ish spiral
        const reach = lerp(1.8, 0.55, t) * (0.75 + rnd() * 0.45);
        const s = lerp(1.25, 0.75, t);
        for (const f of [0.2, 0.55, 0.9]) {
          const x = ax + Math.cos(ang) * reach * f;
          const z = az + Math.sin(ang) * reach * f;
          const yy = y - f * 0.35;
          blob(x, yy - 0.2 * s, z, 0.4 * s, 0.24 * s, 0.38 * s, colors.needlesDark, 0);
          blob(x, yy, z, 0.6 * s * (1.1 - f * 0.3), 0.46 * s, 0.55 * s);
        }
      }
    }
    blob(tx, H, tz, 0.38, 0.5, 0.36);
    blob(tx + 0.1, H + 0.38, tz, 0.22, 0.3, 0.2);
  },

  spruce(b, H, colors) {
    const { rnd, cone, limb, blob, V } = b;
    limb(V(0, 0, 0), V(0, H * 0.4, 0), 0.16, 0.1, colors.bark);
    const tiers = 6 + Math.floor(rnd() * 2);
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const y = lerp(0.55, H - 1.35, t);
      const r = lerp(1.55, 0.38, t) * (0.9 + rnd() * 0.2);
      const h = lerp(1.6, 1.15, t);
      cone(0, y, 0, r, h, rnd() < 0.5 ? colors.needles : colors.needlesDark);
      cone(0, y + h * 0.3, 0, r * 0.82, h * 0.32, colors.snow);
    }
    blob(0, H - 0.2, 0, 0.16, 0.32, 0.16, colors.snow, 0);
  },

  mound(b, H, colors) {
    const { rnd, blob } = b;
    const s = H / 1.3;
    blob(0, 0.35 * s, 0, 0.85 * s, 0.6 * s, 0.75 * s);
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      blob(Math.cos(a) * 0.45 * s, (0.55 + rnd() * 0.35) * s, Math.sin(a) * 0.45 * s, 0.45 * s, 0.4 * s, 0.42 * s);
    }
    if (rnd() < 0.6) blob(0.1 * s, 0.95 * s, 0, 0.18 * s, 0.25 * s, 0.18 * s, colors.needles, 0);
  },

  arch(b, H, colors) {
    const { rnd, blob } = b;
    const R = H * (0.7 + rnd() * 0.3);
    const k = 9;
    for (let i = 0; i < k; i++) {
      const a = (i / (k - 1)) * Math.PI;
      const x = Math.cos(a) * R;
      const y = Math.sin(a) * R * 0.95;
      const r = lerp(0.36, 0.26, Math.abs(i / (k - 1) - 0.5) * 2) * (0.9 + rnd() * 0.2);
      blob(x, y, 0, r * 1.1, r, r);
      if (rnd() < 0.25) blob(x, y - r * 0.5, 0.12, r * 0.4, r * 0.35, r * 0.4, colors.needles, 0);
    }
    blob(R * 1.05, 0.15, 0, 0.45, 0.3, 0.45); // snow piled at the buried tip
  },
};

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Geometry for one tree. Origin at the base, Y up.
 * detail: 'high' (rounder lumps, ~1.5-3.5k triangles) or 'low' (~0.4-1k, for forests/distance).
 */
export interface SnowTreeOptions {
  seed?: number;
  /** Overrides the type's default height (which varies a little per seed). */
  height?: number;
  colors?: Partial<TreeColors>;
  detail?: TreeDetail;
}

export function createSnowTreeGeometry(type: TreeType = 'column', { seed = 1, height, colors = {}, detail = 'high' }: SnowTreeOptions = {}) {
  const build = BUILDERS[type];
  if (!build) throw new Error(`Unknown tree type "${type}". Use one of: ${TREE_TYPES.join(', ')}`);
  const c = { ...DEFAULT_TREE_COLORS, ...colors };
  const b = makeBuilder(seed * 7919 + TREE_TYPES.indexOf(type) * 104729, c, detail === 'low');
  const H = height ?? DEFAULT_TREE_HEIGHTS[type] * (0.85 + b.rnd() * 0.3);
  build(b, H, c);
  const geo = b.finish();
  geo.userData = { type, seed, height: H };
  return geo;
}

/** One tree as a Mesh. Pass `material` to share one across many trees. */
export interface SnowTreeMeshOptions extends SnowTreeOptions {
  material?: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export function createSnowTree(type: TreeType = 'column', { seed = 1, height, colors, detail, material, castShadow = true, receiveShadow = true }: SnowTreeMeshOptions = {}) {
  const mesh = new THREE.Mesh(
    createSnowTreeGeometry(type, { seed, height, colors, detail }),
    material ?? createSnowTreeMaterial(),
  );
  mesh.name = `snowTree:${type}`;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

export const DEFAULT_FOREST_MIX: TreeMix = {
  column: 0.3, hook: 0.08, ghost: 0.14, pine: 0.16, spruce: 0.14, mound: 0.12, arch: 0.06,
};

export interface SnowForestOptions {
  count?: number;
  /** [minX, maxX, minZ, maxZ] */
  bounds?: [number, number, number, number];
  heightAt?: (x: number, z: number) => number;
  /** Return true to keep a spot clear. */
  exclude?: (x: number, z: number) => boolean;
  seed?: number;
  mix?: TreeMix;
  variantsPerType?: number;
  minDistance?: number;
  /** [min, max] random scale per tree. */
  scale?: [number, number];
  colors?: Partial<TreeColors>;
  detail?: TreeDetail;
  material?: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** A tree placed by createSnowForest. */
export interface PlacedTree {
  type: TreeType;
  variant: number;
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
}

/**
 * A forest of instanced trees. Each type gets `variantsPerType` unique
 * geometries; every placed tree picks one and gets its own scale and rotation.
 */
export function createSnowForest({
  count = 200,
  bounds = [-50, 50, -50, 50], // minX, maxX, minZ, maxZ
  heightAt = () => 0,
  exclude = () => false,
  seed = 1,
  mix = DEFAULT_FOREST_MIX,
  variantsPerType = 3,
  minDistance = 1.8,
  scale = [0.8, 1.2],
  colors,
  detail = 'low',
  material = createSnowTreeMaterial(),
  castShadow = true,
  receiveShadow = true,
}: SnowForestOptions = {}) {
  let state = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  const rnd = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const [x0, x1, z0, z1] = bounds;

  const weight = (t: TreeType) => mix[t] ?? 0;
  const types = TREE_TYPES.filter((t) => weight(t) > 0);
  const total = types.reduce((s, t) => s + weight(t), 0);
  const pickType = (): TreeType => {
    let r = rnd() * total;
    for (const t of types) if ((r -= weight(t)) <= 0) return t;
    return types[types.length - 1];
  };

  // Rejection sampling with a spatial grid for the minimum spacing.
  const cell = minDistance;
  const grid = new Map<number, PlacedTree[]>();
  const key = (gx: number, gz: number) => gx * 73856093 ^ gz * 19349663;
  const placed: PlacedTree[] = [];
  let attempts = 0;
  while (placed.length < count && attempts < count * 40) {
    attempts++;
    const x = x0 + rnd() * (x1 - x0);
    const z = z0 + rnd() * (z1 - z0);
    if (exclude(x, z)) continue;
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    let ok = true;
    for (let i = -1; i <= 1 && ok; i++) {
      for (let j = -1; j <= 1 && ok; j++) {
        const list = grid.get(key(gx + i, gz + j));
        if (list) for (const p of list) if ((p.x - x) ** 2 + (p.z - z) ** 2 < minDistance ** 2) { ok = false; break; }
      }
    }
    if (!ok) continue;
    const tree: PlacedTree = {
      type: pickType(),
      variant: Math.floor(rnd() * variantsPerType),
      x, z, y: heightAt(x, z),
      scale: lerp(scale[0], scale[1], rnd()),
      rotation: rnd() * Math.PI * 2,
    };
    placed.push(tree);
    const k = key(gx, gz);
    const cellTrees = grid.get(k) ?? [];
    cellTrees.push(tree);
    grid.set(k, cellTrees);
  }

  const group = new THREE.Group();
  group.name = 'snowForest';
  const dummy = new THREE.Object3D();
  for (const type of types) {
    for (let v = 0; v < variantsPerType; v++) {
      const list = placed.filter((t) => t.type === type && t.variant === v);
      if (!list.length) continue;
      const geo = createSnowTreeGeometry(type, { seed: seed * 31 + v + 1, colors, detail });
      const mesh = new THREE.InstancedMesh(geo, material, list.length);
      mesh.name = `snowForest:${type}:${v}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      list.forEach((t, i) => {
        dummy.position.set(t.x, t.y - 0.05, t.z);
        dummy.rotation.set(0, t.rotation, 0);
        dummy.scale.setScalar(t.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
  group.userData.trees = placed; // positions, for interactions or collision
  group.userData.dispose = () => {
    group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    material.dispose();
  };
  return group;
}
