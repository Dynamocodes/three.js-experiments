import * as THREE from 'three';
import { LAKE } from '../world/terrain';
import {
  createSnowTreeGeometry, createSnowTreeMaterial, DEFAULT_FOREST_MIX,
  type TreeDetail, type TreeMix, type TreeType,
} from '../models/snowTrees';
import type { Rng } from '../utils/random';
import type { Circle, Terrain } from '../types';

// --- Trees -------------------------------------------------------------------
// Snow-loaded Lapland trees from models/snowTrees.ts. The mix of types depends
// on where a tree stands: more pines and young buried trees along the shore,
// heavy crown-snow ("tykky") columns, hooks and ghosts up on the hills.
// The lightly dusted `spruce` type is left out everywhere: next to the
// snow-encased trees it looked out of place.
const { spruce: _lightlyDusted, ...FOREST_MIX } = DEFAULT_FOREST_MIX;
type Zone = 'shore' | 'hills' | 'forest';
const TREE_MIX: Record<Zone, TreeMix> = {
  shore: { pine: 0.35, column: 0.3, ghost: 0.06, hook: 0.04, mound: 0.15, arch: 0.1 },
  hills: { column: 0.36, hook: 0.13, ghost: 0.26, pine: 0.07, mound: 0.12, arch: 0.06 },
  forest: FOREST_MIX,
};
const VARIANTS_PER_TYPE = 3;

// Trees closer than this to the camera use the rounder, high-detail geometry.
const NEAR = { x: -4, z: 40, distance: 60 };

function pickType(rng: Rng, mix: TreeMix): TreeType {
  const entries = Object.entries(mix) as [TreeType, number][];
  let r = rng() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [type, w] of entries) if ((r -= w) <= 0) return type;
  return entries[entries.length - 1][0];
}

// --- Scatter --------------------------------------------------------------

interface Spot {
  x: number;
  z: number;
}

/**
 * Dart-throwing Poisson disk: random candidates, rejected if too close to an
 * accepted one. A grid keeps neighbour lookups cheap.
 */
function poisson(rng: Rng, { minX, maxX, minZ, maxZ, radius, attempts, accept }: {
  minX: number; maxX: number; minZ: number; maxZ: number;
  radius: number;
  attempts: number;
  accept: (x: number, z: number) => boolean;
}): Spot[] {
  const cell = radius / Math.SQRT2;
  const cols = Math.ceil((maxX - minX) / cell);
  const grid = new Map<number, Spot>();
  const points: Spot[] = [];
  for (let n = 0; n < attempts; n++) {
    const x = rng.range(minX, maxX);
    const z = rng.range(minZ, maxZ);
    const gx = Math.floor((x - minX) / cell);
    const gz = Math.floor((z - minZ) / cell);
    let ok = true;
    for (let dz = -2; dz <= 2 && ok; dz++) {
      for (let dx = -2; dx <= 2 && ok; dx++) {
        const q = grid.get((gz + dz) * cols + (gx + dx));
        if (q && (q.x - x) ** 2 + (q.z - z) ** 2 < radius * radius) ok = false;
      }
    }
    if (!ok || !accept(x, z)) continue;
    const pt = { x, z };
    grid.set(gz * cols + gx, pt);
    points.push(pt);
  }
  return points;
}

/** Where and how one instance sits. */
interface Transform {
  x: number;
  y: number;
  z: number;
  rotY: number;
  tiltX?: number;
  tiltZ?: number;
  /** Uniform scale. */
  s: number;
  /** Brightness multiplier. */
  shade?: number;
}

/** Builds an InstancedMesh of one model, one instance per transform. */
function instanced(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, transforms: Transform[]) {
  const group = new THREE.Group();
  group.name = name;
  if (!transforms.length) return group;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const c = new THREE.Color();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  transforms.forEach((t, i) => {
    e.set(t.tiltX ?? 0, t.rotY, t.tiltZ ?? 0);
    q.setFromEuler(e);
    m.compose(pos.set(t.x, t.y, t.z), q, scl.setScalar(t.s));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.setScalar(t.shade ?? 1));
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  group.add(mesh);
  return group;
}

export interface VegetationOptions {
  /** Areas to keep clear of trees. */
  avoid?: Circle[];
  /**
   * Areas emptied after placement. Unlike `avoid`, this doesn't change any
   * random draws, so the rest of the forest stays exactly as it was. Use it
   * for things added to an existing scene.
   */
  clear?: Circle[];
}

export function createVegetation(rng: Rng, terrain: Terrain, { avoid = [], clear = [] }: VegetationOptions = {}) {
  const { surfaceAt, lakeDistance, fbm } = terrain;
  const group = new THREE.Group();
  group.name = 'vegetation';

  const inside = (circles: Circle[], x: number, z: number) => circles.some((a) => (a.x - x) ** 2 + (a.z - z) ** 2 < a.r * a.r);
  const blocked = (x: number, z: number) => inside(avoid, x, z);
  const cleared = (x: number, z: number) => inside(clear, x, z);

  // Forest density mask: noise makes stands of forest with open snowfields
  // between them, so the hill shapes stay readable.
  const density = (x: number, z: number) => {
    const n = fbm(x * 0.018 + 100, z * 0.018, 3);
    return 0.04 + 0.96 * Math.pow((n + 1) / 2, 1.5) * (n > -0.1 ? 1 : 0.15);
  };

  const spots = poisson(rng, {
    minX: -170, maxX: 170, minZ: -170, maxZ: 34,
    radius: 3.8,
    attempts: 30000,
    accept: (x, z) =>
      lakeDistance(x, z) > 1.3 &&
      !(z > 4 && Math.abs(x) < 10 + (z - 4) * 0.7) && // open wedge from camera to lake
      !blocked(x, z) &&
      rng() < density(x, z),
  });

  // Trees, bucketed by type, variant and detail level for instancing.
  const treeSets = new Map<string, { type: TreeType; variant: number; detail: TreeDetail; transforms: Transform[] }>();
  const counts: Partial<Record<TreeType, number>> = {};
  for (const { x, z } of spots) {
    const zone: Zone = lakeDistance(x, z) < 2.2 ? 'shore' : z < -35 ? 'hills' : 'forest';
    const type = pickType(rng, TREE_MIX[zone]);
    const variant = Math.floor(rng() * VARIANTS_PER_TYPE);
    const detail: TreeDetail = Math.hypot(x - NEAR.x, z - NEAR.z) < NEAR.distance ? 'high' : 'low';
    const transform: Transform = {
      x, z,
      y: surfaceAt(x, z) - 0.1, // the drawn ground, so nothing floats on slopes
      rotY: rng() * Math.PI * 2,
      tiltX: rng.range(-0.04, 0.04),
      tiltZ: rng.range(-0.04, 0.04),
      s: rng.range(0.8, 1.2) * (z < -40 ? 1.2 : 1),
      shade: rng.range(0.88, 1.04),
    };
    if (cleared(x, z)) continue; // after the draws, so later trees don't shift
    const key = `${type}:${variant}:${detail}`;
    const set = treeSets.get(key) ?? { type, variant, detail, transforms: [] };
    treeSets.set(key, set);
    set.transforms.push(transform);
    counts[type] = (counts[type] ?? 0) + 1;
  }

  skipRemovedRocks(rng, blocked);

  // One geometry per type x variant x detail, one shared material.
  const treeMaterial = createSnowTreeMaterial();
  const trees = new THREE.Group();
  trees.name = 'trees';
  for (const { type, variant, detail, transforms } of treeSets.values()) {
    const geometry = createSnowTreeGeometry(type, { seed: variant + 1, detail });
    trees.add(instanced(`${type}-${variant}-${detail}`, geometry, treeMaterial, transforms));
  }
  group.add(trees);

  return { object: group, counts };
}

/**
 * The shore rocks were removed, but the random draws they made are kept: the
 * sky, aurora, snowfall and shooting stars draw from the same sequence after
 * the trees, so skipping these would change all of them.
 */
function skipRemovedRocks(rng: Rng, blocked: (x: number, z: number) => boolean) {
  for (let i = 0, spots = 0; i < 200 && spots < 45; i++) {
    const ang = rng() * Math.PI * 2;
    const d = rng.range(0.95, 1.5);
    if (blocked(LAKE.x + Math.cos(ang) * LAKE.rx * d, LAKE.z + Math.sin(ang) * LAKE.rz * d)) continue;
    rng.range(0.4, 1.4); // size
    rng(); // turn
    rng.range(0.8, 1.1); // shade
    rng(); // model variant
    spots++;
  }
  for (let i = 0; i < 12; i++) rng.range(0.75, 1.25); // the placeholder rock's 12 corners
}
