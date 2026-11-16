import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Low-poly Finnish granite rocks with a real snow layer, plus seeded variants.
 *
 *   import { createSnowRock, createRockField, ROCK_TYPES } from './snowRocks';
 *
 *   // one rock (a Group: 'rock' + 'snow' meshes, origin at ground level)
 *   const rock = createSnowRock('boulder', { seed: 3, size: 1.5 });
 *   rock.position.set(x, terrain.heightAt(x, z), z);
 *   scene.add(rock);
 *
 *   // a scatter of rocks, instanced
 *   const rocks = createRockField({
 *     count: 60,
 *     bounds: [-60, 60, -80, 10],
 *     heightAt: terrain.heightAt,
 *     exclude: (x, z) => nearLake(x, z),
 *   });
 *   scene.add(rocks);
 *
 *   rock.userData.setSnow(0.5);   // 0 = bare rock, 1 = full snow layer (grows smoothly)
 *
 * Types:
 *   boulder   rounded glacial erratic
 *   slab      flat, tilted tabular rock
 *   shard     tall, angular, frost-split rock
 *   outcrop   wide glacier-smoothed bedrock (gentle on one side, steep on the other)
 *   cluster   a few rocks leaning on each other
 *   pebbles   a scatter of small stones, mostly buried
 *
 * How it's built: an icosphere is bent with smooth noise, then sliced by random
 * planes, which gives the flat facets of split granite. The snow is a shell of
 * the rock pushed outward wherever the surface faces up, so it has real
 * thickness and a soft overhanging lip. Snow also piles into a wind drift on
 * one side of the base.
 *
 * The snow layer is a morph target, so `setSnow(t)` grows or melts it smoothly
 * (including on instanced fields, where one call changes every rock).
 */

export const ROCK_TYPES = ['boulder', 'slab', 'shard', 'outcrop', 'cluster', 'pebbles'] as const;
export type RockType = (typeof ROCK_TYPES)[number];
/** Relative weights per rock type; types left out don't appear. */
export type RockMix = Partial<Record<RockType, number>>;
export type RockDetail = 'high' | 'low';
export type RockColors = typeof DEFAULT_ROCK_COLORS;
/** A direction on the ground plane, [x, z]. */
export type Wind = [x: number, z: number];
/** Snow amount: 0..1, or true/false for full/none. */
export type SnowAmount = number | boolean;

export const DEFAULT_ROCK_COLORS = {
  granite: ['#8d8890', '#9a8f8f', '#827f87', '#a1999a'], // grey with a hint of pink
  dark: '#55535d', // shadowed undersides, near the ground
  lichen: '#9c9d7a',
  snow: '#f3f6fc',
  snowShade: '#c4cfe6',
};

/** Shared material for both rock and snow: vertex colours, flat shading. */
export function createRockMaterial() {
  return new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92 });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Rnd = () => number;
type Noise3 = (x: number, y: number, z: number) => number;

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const snowValue = (t: SnowAmount) => (typeof t === 'boolean' ? (t ? 1 : 0) : clamp(t));

function makeRng(seed: number): Rnd {
  let state = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

/** Bounding box of a geometry's positions. */
function boundsOf(g: THREE.BufferGeometry) {
  return new THREE.Box3().setFromBufferAttribute(g.attributes.position as THREE.BufferAttribute);
}

/** Cheap smooth 3D noise: a few sine waves along random directions. Range ~[-1, 1]. */
function makeNoise(rnd: Rnd, octaves = 5): Noise3 {
  const waves: { d: THREE.Vector3; f: number; p: number; a: number }[] = [];
  for (let i = 0; i < octaves; i++) {
    const d = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    waves.push({ d, f: 1.3 * 1.9 ** i, p: rnd() * Math.PI * 2, a: 0.6 ** i });
  }
  const norm = waves.reduce((s, w) => s + w.a, 0);
  return (x, y, z) => {
    let s = 0;
    for (const w of waves) s += Math.sin((x * w.d.x + y * w.d.y + z * w.d.z) * w.f + w.p) * w.a;
    return s / norm;
  };
}

// ---------------------------------------------------------------------------
// rock pieces
// ---------------------------------------------------------------------------

interface PieceOptions {
  detail?: number;
  bumpiness?: number;
  cuts?: number;
  /** Plane distance from the centre, as a fraction of the radius: [min, max]. */
  cutDepth?: [number, number];
  /** A near-horizontal cut on top (null to skip). */
  flatTop?: number | null;
  /** A steep plucked face. */
  steepSide?: { dir: Wind; depth: number } | null;
  scale?: [number, number, number];
}

/**
 * One rock piece as an indexed geometry (shared vertices, so the snow shell
 * can be offset smoothly). Shape: noisy sphere, sliced by planes, scaled.
 */
function rockPiece(rnd: Rnd, {
  detail = 2,
  bumpiness = 0.18,
  cuts = 6,
  cutDepth = [0.62, 0.9],
  flatTop = 0.75,
  steepSide = null,
  scale = [1, 1, 1],
}: PieceOptions) {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position;
  const noise = makeNoise(rnd);
  const v = new THREE.Vector3();

  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + noise(v.x, v.y, v.z) * bumpiness);
    p.setXYZ(i, v.x, v.y, v.z);
  }

  const planes: { n: THREE.Vector3; d: number }[] = [];
  for (let k = 0; k < cuts; k++) {
    // Mostly sideways cuts, some tilted: split granite has large flat faces.
    const a = rnd() * Math.PI * 2;
    const tilt = (rnd() - 0.35) * 1.2;
    planes.push({ n: new THREE.Vector3(Math.cos(a), tilt, Math.sin(a)).normalize(), d: lerp(cutDepth[0], cutDepth[1], rnd()) });
  }
  if (flatTop != null) {
    planes.push({ n: new THREE.Vector3((rnd() - 0.5) * 0.35, 1, (rnd() - 0.5) * 0.35).normalize(), d: flatTop * lerp(0.92, 1.05, rnd()) });
  }
  if (steepSide) {
    const [dx, dz] = steepSide.dir;
    planes.push({ n: new THREE.Vector3(dx, 0.15, dz).normalize(), d: steepSide.depth });
  }
  for (const { n, d } of planes) {
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const dist = v.dot(n) - d;
      if (dist > 0) {
        v.addScaledVector(n, -dist);
        p.setXYZ(i, v.x, v.y, v.z);
      }
    }
  }
  g.scale(scale[0], scale[1], scale[2]);
  return g;
}

interface Placement {
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  tiltX?: number;
  tiltZ?: number;
  /** How much of the piece's height sinks below ground. */
  sink?: number;
}

/** Bakes position, rotation and tilt into an indexed piece. */
function place(g: THREE.BufferGeometry, { x = 0, y = 0, z = 0, yaw = 0, tiltX = 0, tiltZ = 0, sink = 0.25 }: Placement) {
  g.rotateX(tiltX);
  g.rotateZ(tiltZ);
  g.rotateY(yaw);
  const bb = boundsOf(g);
  const h = bb.max.y - bb.min.y;
  g.translate(x, y - bb.min.y - h * sink, z);
  return g;
}

// ---------------------------------------------------------------------------
// colouring and snow
// ---------------------------------------------------------------------------

/** Non-indexed, flat-shaded rock with per-face colours. */
function colourRock(indexed: THREE.BufferGeometry, rnd: Rnd, colors: RockColors, { lichen = 0.12 }: { lichen?: number }) {
  const g = indexed.toNonIndexed();
  g.computeVertexNormals();
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const out = new Float32Array(pos.count * 3);
  const palette = colors.granite.map((c) => new THREE.Color(c));
  const dark = new THREE.Color(colors.dark);
  const lich = new THREE.Color(colors.lichen);
  const patch = makeNoise(rnd, 3);
  const c = new THREE.Color();
  for (let f = 0; f < pos.count; f += 3) {
    const cx = (pos.getX(f) + pos.getX(f + 1) + pos.getX(f + 2)) / 3;
    const cy = (pos.getY(f) + pos.getY(f + 1) + pos.getY(f + 2)) / 3;
    const cz = (pos.getZ(f) + pos.getZ(f + 1) + pos.getZ(f + 2)) / 3;
    const nx = nrm.getX(f), ny = nrm.getY(f), nz = nrm.getZ(f);
    // Colour by facet orientation (coplanar faces of a cut share one colour,
    // so the flat faces of split granite read clearly), plus a little position
    // noise for mottled patches.
    const n = patch(nx * 2.4 + cx * 0.25, ny * 2.4 + cy * 0.25, nz * 2.4 + cz * 0.25);
    const idx = Math.floor(clamp((n + 1) / 2, 0, 0.999) * palette.length);
    c.copy(palette[idx]);
    // Undersides and faces near the ground are darker (cheap ambient occlusion).
    c.lerp(dark, clamp(0.55 * smoothstep(0.1, -0.7, ny) + 0.35 * smoothstep(0.35, -0.05, cy)));
    // Lichen on sunny upper faces.
    if (lichen > 0 && ny > 0.2 && ny < 0.8 && patch(cx * 1.7, cy * 1.7, cz * 1.7) > 1 - lichen * 3) c.lerp(lich, 0.6);
    c.multiplyScalar(0.97 + rnd() * 0.06);
    for (let k = 0; k < 3; k++) c.toArray(out, (f + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(out, 3));
  return g;
}

/**
 * Snow shell for one indexed piece. Returns a non-indexed geometry whose base
 * positions are tucked just inside the rock, with a morph target holding the
 * full snow layer. Triangles that never get snow are dropped.
 */
function snowShell(indexed: THREE.BufferGeometry, rnd: Rnd, { coverage, thickness, wind }: { coverage: number; thickness: number; wind: Wind }) {
  const index = indexed.index;
  if (!index) throw new Error('snowShell needs an indexed geometry');
  indexed.computeVertexNormals(); // smooth normals: the offset direction
  const p = indexed.attributes.position;
  const n = indexed.attributes.normal;
  const noise = makeNoise(rnd, 4);
  const count = p.count;
  const amount = new Float32Array(count);
  const thr = lerp(0.95, 0.1, coverage); // how flat a surface must be to hold snow
  for (let i = 0; i < count; i++) {
    const ny = n.getY(i);
    const windward = (n.getX(i) * wind[0] + n.getZ(i) * wind[1]) * 0.18; // wind strips one side
    const jit = noise(p.getX(i) * 1.7, p.getY(i) * 1.7, p.getZ(i) * 1.7) * 0.16;
    amount[i] = smoothstep(thr, thr + 0.22, ny + jit - windward);
  }
  const base: number[] = [];
  const full: number[] = [];
  const idx = index.array;
  const v = new THREE.Vector3();
  const nn = new THREE.Vector3();
  const pushVertex = (i: number) => {
    v.fromBufferAttribute(p, i);
    nn.fromBufferAttribute(n, i);
    const a = amount[i];
    // Hidden position: slightly inside the rock.
    base.push(v.x - nn.x * 0.03, v.y - nn.y * 0.03, v.z - nn.z * 0.03);
    // Full snow: pushed out along the normal, thicker on top, a little extra
    // upward lift so the layer looks pillowy and overhangs at the edges.
    const t = thickness * a * (0.55 + 0.45 * clamp(nn.y));
    const lift = thickness * a * 0.35;
    const inset = (1 - a) * 0.03;
    full.push(v.x + nn.x * (t - inset), v.y + nn.y * (t - inset) + lift, v.z + nn.z * (t - inset));
  };
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k], b = idx[k + 1], c = idx[k + 2];
    if (amount[a] + amount[b] + amount[c] < 0.02) continue;
    pushVertex(a); pushVertex(b); pushVertex(c);
  }
  if (!base.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(base, 3));
  g.morphAttributes.position = [new THREE.Float32BufferAttribute(full, 3)];
  return g;
}

/** A wind-shaped snow drift at the base of a piece. */
function snowDrift(indexed: THREE.BufferGeometry, rnd: Rnd, { thickness, wind }: { thickness: number; wind: Wind }) {
  const bb = boundsOf(indexed);
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  const rx = (bb.max.x - bb.min.x) / 2;
  const rz = (bb.max.z - bb.min.z) / 2;
  const parts: THREE.BufferGeometry[] = [];
  const blob = (x: number, z: number, sx: number, sy: number, sz: number) => {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 1);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const p = g.attributes.position;
    const noise = makeNoise(rnd, 3);
    for (let i = 0; i < p.count; i++) {
      const k = 1 + noise(p.getX(i) * 2, p.getY(i) * 2, p.getZ(i) * 2) * 0.12;
      p.setXYZ(i, p.getX(i) * k, Math.max(-0.2, p.getY(i)) * k, p.getZ(i) * k);
    }
    g.scale(sx, sy, sz);
    g.rotateY(Math.atan2(-wind[1], wind[0]));
    g.translate(x, -sy * 0.15, z);
    parts.push(g.toNonIndexed());
  };
  const h = Math.max(0.12, thickness * 1.3);
  // A collar around the base, and a tail on the lee side.
  blob(cx, cz, rx * 0.95 + 0.18, h * 1.2, rz * 0.95 + 0.18);
  blob(cx + wind[0] * rx * 0.75, cz + wind[1] * rz * 0.75, rx * 0.85 + 0.3, h, rz * 0.55 + 0.2);
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  // Base (no snow): flattened into the ground. Morph: the full drift.
  const p = merged.attributes.position as THREE.BufferAttribute;
  const base = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) base.set([p.getX(i), Math.min(p.getY(i), 0) - 0.02, p.getZ(i)], i * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(base, 3));
  g.morphAttributes.position = [new THREE.BufferAttribute(p.array.slice(), 3)];
  merged.dispose();
  return g;
}

/** Colours the snow from the full (morphed) shape so shading matches the final look. */
function colourSnow(g: THREE.BufferGeometry, colors: RockColors) {
  const full = g.morphAttributes.position[0];
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', full);
  tmp.computeVertexNormals();
  const n = tmp.attributes.normal;
  const out = new Float32Array(full.count * 3);
  const snow = new THREE.Color(colors.snow);
  const shade = new THREE.Color(colors.snowShade);
  const c = new THREE.Color();
  for (let f = 0; f < full.count; f += 3) {
    const ny = (n.getY(f) + n.getY(f + 1) + n.getY(f + 2)) / 3;
    c.copy(snow).lerp(shade, clamp((0.45 - ny) * 1.1));
    for (let k = 0; k < 3; k++) c.toArray(out, (f + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(out, 3));
  g.morphTargetsRelative = false;
  return g;
}

// ---------------------------------------------------------------------------
// rock types
// ---------------------------------------------------------------------------

const TYPE_SIZES: Record<RockType, number> = { boulder: 1.4, slab: 1.6, shard: 1.3, outcrop: 4.5, cluster: 1.6, pebbles: 0.9 };

/** Builds a rock's pieces: rnd, size, detail level (0 low, 1 high). */
type BuildRock = (rnd: Rnd, S: number, d: number) => THREE.BufferGeometry[];

const BUILDERS: Record<RockType, BuildRock> = {
  boulder(rnd, S, d) {
    return [place(rockPiece(rnd, { detail: d + 1, bumpiness: 0.14, cuts: 5 + Math.floor(rnd() * 3), cutDepth: [0.6, 0.84], flatTop: 0.78, scale: [S * lerp(1, 1.3, rnd()), S * lerp(0.7, 0.9, rnd()), S * lerp(0.9, 1.1, rnd())] }), { yaw: rnd() * 6.28, tiltX: (rnd() - 0.5) * 0.25, sink: 0.22 })];
  },
  slab(rnd, S, d) {
    return [place(rockPiece(rnd, { detail: d + 1, bumpiness: 0.08, cuts: 7, cutDepth: [0.58, 0.8], flatTop: 0.42, scale: [S * 1.35, S * 0.9, S * lerp(0.85, 1.05, rnd())] }), { yaw: rnd() * 6.28, tiltX: (rnd() - 0.5) * 0.5, tiltZ: (rnd() - 0.5) * 0.4, sink: 0.3 })];
  },
  shard(rnd, S, d) {
    return [place(rockPiece(rnd, { detail: d + 1, bumpiness: 0.1, cuts: 9, cutDepth: [0.45, 0.72], flatTop: 0.85, scale: [S * 0.75, S * 1.55, S * 0.65] }), { yaw: rnd() * 6.28, tiltX: (rnd() - 0.5) * 0.45, tiltZ: (rnd() - 0.5) * 0.45, sink: 0.12 })];
  },
  outcrop(rnd, S, d) {
    const a = rnd() * Math.PI * 2;
    const main = place(rockPiece(rnd, { detail: d + 2, bumpiness: 0.12, cuts: 3, cutDepth: [0.8, 0.95], flatTop: 0.55, steepSide: { dir: [Math.cos(a), Math.sin(a)], depth: 0.5 }, scale: [S, S * 0.32, S * 0.72] }), { yaw: rnd() * 6.28, sink: 0.35 });
    const pieces = [main];
    // A couple of glacially rounded humps on the bedrock.
    for (let k = 0; k < 2; k++) {
      const ang = rnd() * Math.PI * 2;
      pieces.push(place(rockPiece(rnd, { detail: d + 1, bumpiness: 0.12, cuts: 3, cutDepth: [0.8, 0.95], flatTop: 0.6, scale: [S * 0.35, S * 0.16, S * 0.28] }), { x: Math.cos(ang) * S * 0.35, z: Math.sin(ang) * S * 0.25, y: S * 0.06, yaw: rnd() * 6.28, sink: 0.45 }));
    }
    return pieces;
  },
  cluster(rnd, S, d) {
    const pieces: THREE.BufferGeometry[] = [];
    const n = 3 + Math.floor(rnd() * 2);
    for (let k = 0; k < n; k++) {
      const big = k === 0;
      const s = S * (big ? 0.85 : lerp(0.4, 0.62, rnd()));
      const ang = (k / n) * Math.PI * 2 + rnd() * 0.8;
      const r = big ? 0 : S * lerp(0.55, 0.8, rnd());
      pieces.push(place(rockPiece(rnd, { detail: d + (big ? 1 : 0), bumpiness: 0.12, cuts: 6 + Math.floor(rnd() * 3), cutDepth: [0.52, 0.8], flatTop: 0.72, scale: [s * lerp(0.9, 1.3, rnd()), s * lerp(0.7, 1.1, rnd()), s] }), { x: Math.cos(ang) * r, z: Math.sin(ang) * r, yaw: rnd() * 6.28, tiltX: (rnd() - 0.5) * 0.6, tiltZ: (rnd() - 0.5) * 0.6, sink: 0.2 }));
    }
    return pieces;
  },
  pebbles(rnd, S, d) {
    const pieces: THREE.BufferGeometry[] = [];
    const n = 5 + Math.floor(rnd() * 5);
    for (let k = 0; k < n; k++) {
      const s = S * lerp(0.26, 0.55, rnd());
      const ang = rnd() * Math.PI * 2;
      const r = S * Math.sqrt(rnd()) * 1.1;
      pieces.push(place(rockPiece(rnd, { detail: d, bumpiness: 0.15, cuts: 5, cutDepth: [0.55, 0.85], flatTop: 0.7, scale: [s * 1.2, s * 0.75, s] }), { x: Math.cos(ang) * r, z: Math.sin(ang) * r, yaw: rnd() * 6.28, tiltX: (rnd() - 0.5) * 0.5, sink: 0.3 }));
    }
    return pieces;
  },
};

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export interface SnowRockOptions {
  /** Same seed = same rock. */
  seed?: number;
  /** Defaults per type (varies a little per seed). */
  size?: number;
  /** 0..1, how much of the surface can hold snow (default 0.6). */
  snow?: number;
  /** World units (default scales with size). */
  snowThickness?: number;
  /** Add a wind drift at the base (default true, not for outcrop). */
  drift?: boolean;
  /** Direction the wind blows towards (drift tail side). */
  wind?: Wind;
  /** 0..1 lichen patches on upper faces. */
  lichen?: number;
  detail?: RockDetail;
  /** Override any of DEFAULT_ROCK_COLORS. */
  colors?: Partial<RockColors>;
}

export interface SnowRockGeometry {
  rock: THREE.BufferGeometry;
  /** Null when `snow` is 0. Its morph target 0 is the full snow layer. */
  snow: THREE.BufferGeometry | null;
}

/** Geometries for one rock: { rock, snow }. Origin at ground level, Y up. */
export function createSnowRockGeometry(type: RockType = 'boulder', {
  seed = 1,
  size,
  snow = 0.6,
  snowThickness,
  drift = type !== 'outcrop',
  wind = [1, 0.3],
  lichen = 0.12,
  detail = 'high',
  colors = {},
}: SnowRockOptions = {}): SnowRockGeometry {
  const build = BUILDERS[type];
  if (!build) throw new Error(`Unknown rock type "${type}". Use one of: ${ROCK_TYPES.join(', ')}`);
  const c = { ...DEFAULT_ROCK_COLORS, ...colors };
  const rnd = makeRng(seed * 7919 + ROCK_TYPES.indexOf(type) * 104729);
  const S = size ?? TYPE_SIZES[type] * lerp(0.85, 1.15, rnd());
  const d = detail === 'low' ? 0 : 1;
  const wl = Math.hypot(wind[0], wind[1]) || 1;
  const w: Wind = [wind[0] / wl, wind[1] / wl];
  const thickness = snowThickness ?? clamp(0.07 + S * 0.06, 0.08, 0.35);

  const pieces = build(rnd, S, d);

  const rockParts = pieces.map((g) => colourRock(g, rnd, c, { lichen }));
  const rock = mergeGeometries(rockParts, false);
  rockParts.forEach((g) => g.dispose());
  rock.computeVertexNormals();
  rock.computeBoundingSphere();

  let snowGeo: THREE.BufferGeometry | null = null;
  if (snow > 0) {
    const shells: THREE.BufferGeometry[] = [];
    for (const g of pieces) {
      const s = snowShell(g, rnd, { coverage: snow, thickness, wind: w });
      if (s) shells.push(s);
    }
    if (drift && type !== 'pebbles') {
      const all = mergeGeometries(pieces.map((g) => g.clone()), false);
      shells.push(snowDrift(all, rnd, { thickness, wind: w }));
      all.dispose();
    }
    if (shells.length) {
      snowGeo = mergeGeometries(shells, false);
      shells.forEach((g) => g.dispose());
      colourSnow(snowGeo, c);
      snowGeo.computeVertexNormals();
      // Bounds from the full shape, so culling and shadows include the snow.
      const tmp = new THREE.BufferGeometry();
      tmp.setAttribute('position', snowGeo.morphAttributes.position[0]);
      tmp.computeBoundingBox();
      tmp.computeBoundingSphere();
      snowGeo.boundingBox = tmp.boundingBox;
      snowGeo.boundingSphere = tmp.boundingSphere;
    }
  }
  pieces.forEach((g) => g.dispose());
  rock.userData = { type, seed, size: S };
  return { rock, snow: snowGeo };
}

export interface SnowRockMeshOptions extends SnowRockOptions {
  material?: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** One rock as a Group with 'rock' and 'snow' meshes. */
export function createSnowRock(type: RockType = 'boulder', {
  material = createRockMaterial(),
  castShadow = true,
  receiveShadow = true,
  ...options
}: SnowRockMeshOptions = {}) {
  const { rock, snow } = createSnowRockGeometry(type, options);
  const group = new THREE.Group();
  group.name = `snowRock:${type}`;
  const rockMesh = new THREE.Mesh(rock, material);
  rockMesh.name = 'rock';
  rockMesh.castShadow = castShadow;
  rockMesh.receiveShadow = receiveShadow;
  group.add(rockMesh);
  let snowMesh: THREE.Mesh | null = null;
  const influences = [1];
  if (snow) {
    snowMesh = new THREE.Mesh(snow, material);
    snowMesh.name = 'snow';
    snowMesh.castShadow = castShadow;
    snowMesh.receiveShadow = receiveShadow;
    snowMesh.morphTargetInfluences = influences;
    group.add(snowMesh);
  }
  group.userData.setSnow = (t: SnowAmount) => {
    if (!snowMesh) return;
    const v = snowValue(t);
    influences[0] = v;
    snowMesh.visible = v > 0.001;
  };
  group.userData.dispose = () => {
    rock.dispose();
    snow?.dispose();
    material.dispose();
  };
  return group;
}

export const DEFAULT_ROCK_MIX: RockMix = { boulder: 0.34, slab: 0.16, shard: 0.12, cluster: 0.14, pebbles: 0.18, outcrop: 0.06 };

export interface RockFieldOptions {
  count?: number;
  /** [minX, maxX, minZ, maxZ] */
  bounds?: [number, number, number, number];
  heightAt?: (x: number, z: number) => number;
  /** Return true to keep a spot clear. */
  exclude?: (x: number, z: number) => boolean;
  seed?: number;
  mix?: RockMix;
  variantsPerType?: number;
  minDistance?: number;
  /** [min, max] random scale per rock. */
  scale?: [number, number];
  snow?: number;
  wind?: Wind;
  detail?: RockDetail;
  colors?: Partial<RockColors>;
  material?: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** A rock placed by createRockField. */
export interface PlacedRock {
  type: RockType;
  /** Minimum spacing this rock keeps from others. */
  gap: number;
  variant: number;
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
}

/**
 * A scatter of rocks. Each type gets `variantsPerType` unique shapes, drawn as
 * instanced meshes (two draw calls per variant: rock + snow).
 */
export function createRockField({
  count = 60,
  bounds = [-50, 50, -50, 50],
  heightAt = () => 0,
  exclude = () => false,
  seed = 1,
  mix = DEFAULT_ROCK_MIX,
  variantsPerType = 3,
  minDistance = 3,
  scale = [0.7, 1.3],
  snow = 0.6,
  wind = [1, 0.3],
  detail = 'low',
  colors,
  material = createRockMaterial(),
  castShadow = true,
  receiveShadow = true,
}: RockFieldOptions = {}) {
  const rnd = makeRng(seed);
  const [x0, x1, z0, z1] = bounds;
  const weight = (t: RockType) => mix[t] ?? 0;
  // Same order as the mix object, as in the original (it affects which
  // random numbers each type gets, so it keeps fields identical).
  const types = (Object.keys(mix) as RockType[]).filter((t) => weight(t) > 0);
  const total = types.reduce((s, t) => s + weight(t), 0);
  const pickType = (): RockType => {
    let r = rnd() * total;
    for (const t of types) if ((r -= weight(t)) <= 0) return t;
    return types[types.length - 1];
  };

  const placed: PlacedRock[] = [];
  let attempts = 0;
  while (placed.length < count && attempts < count * 50) {
    attempts++;
    const x = x0 + rnd() * (x1 - x0);
    const z = z0 + rnd() * (z1 - z0);
    if (exclude(x, z)) continue;
    const type = pickType();
    const gap = type === 'outcrop' ? minDistance * 3 : minDistance;
    if (placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < Math.max(gap, p.gap) ** 2)) continue;
    placed.push({ type, gap, variant: Math.floor(rnd() * variantsPerType), x, z, y: heightAt(x, z), scale: lerp(scale[0], scale[1], rnd()), rotation: rnd() * Math.PI * 2 });
  }

  const group = new THREE.Group();
  group.name = 'rockField';
  const snowInfluences: number[][] = [];
  const snowMeshes: THREE.InstancedMesh[] = [];
  const dummy = new THREE.Object3D();
  for (const type of types) {
    for (let v = 0; v < variantsPerType; v++) {
      const list = placed.filter((p) => p.type === type && p.variant === v);
      if (!list.length) continue;
      // Rotating an instance would also rotate its wind drift, so the drift
      // geometry is built for the un-rotated wind; drifts end up facing a
      // little differently per rock, which reads as natural variation.
      const geo = createSnowRockGeometry(type, { seed: seed * 31 + v + 1, snow, wind, detail, colors });
      const meshes = [new THREE.InstancedMesh(geo.rock, material, list.length)];
      if (geo.snow) {
        const s = new THREE.InstancedMesh(geo.snow, material, list.length);
        const influences = [1];
        s.morphTargetInfluences = influences;
        snowInfluences.push(influences);
        meshes.push(s);
        snowMeshes.push(s);
      }
      list.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rotation, 0);
        dummy.scale.setScalar(p.scale);
        dummy.updateMatrix();
        meshes.forEach((m) => m.setMatrixAt(i, dummy.matrix));
      });
      meshes.forEach((m, k) => {
        m.name = `rockField:${type}:${v}:${k ? 'snow' : 'rock'}`;
        m.castShadow = castShadow;
        m.receiveShadow = receiveShadow;
        m.instanceMatrix.needsUpdate = true;
        m.computeBoundingSphere();
        group.add(m);
      });
    }
  }
  group.userData.rocks = placed; // positions, for collisions or interactions
  group.userData.setSnow = (t: SnowAmount) => {
    const v = snowValue(t);
    snowInfluences.forEach((inf) => { inf[0] = v; });
    snowMeshes.forEach((m) => { m.visible = v > 0.001; });
  };
  group.userData.dispose = () => {
    group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    material.dispose();
  };
  return group;
}
