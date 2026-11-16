import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { palette } from '../palette';
import { LAKE } from '../world/terrain';
import {
  createSnowTreeGeometry, createSnowTreeMaterial, DEFAULT_FOREST_MIX,
  type TreeDetail, type TreeMix, type TreeType,
} from '../models/snowTrees';
import type { InstancePart, LoadInstanceParts } from '../loaders/models';
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

// --- Rocks (procedural placeholder) ----------------------------------------
// Stands in for real assets: drop GLBs in src/assets/models/rock/ to replace
// it. The scatter code only needs a BufferGeometry with vertex colours, with
// its origin at the base of the model.

function colorize(geo: THREE.BufferGeometry, hex: string) {
  const c = new THREE.Color(hex);
  const arr = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) arr.set([c.r, c.g, c.b], i);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function makeRock(rng: Rng) {
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 0);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo); // share corners so jitter doesn't open cracks
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = rng.range(0.75, 1.25);
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s, p.getZ(i) * s);
  }
  geo.computeVertexNormals();
  return colorize(geo, palette.rock);
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
  /** Vertical scale, for squashing placeholders (ignored for loaded models). */
  sy?: number;
  /** Brightness multiplier. */
  shade?: number;
  /** 0..1, picks a model variant once real models are loaded. */
  variant?: number;
}

const placeholderMaterial = () =>
  new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });

/**
 * Builds InstancedMeshes for one model. `parts` has one entry for a
 * procedural model and one per material for a loaded GLB; every part shares
 * the same instance transforms.
 */
function instanced(name: string, parts: InstancePart[], transforms: Transform[], { flatten = true } = {}) {
  const group = new THREE.Group();
  group.name = name;
  if (!transforms.length) return group;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const c = new THREE.Color();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (const { geometry, material } of parts) {
    const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
    transforms.forEach((t, i) => {
      e.set(t.tiltX ?? 0, t.rotY, t.tiltZ ?? 0);
      q.setFromEuler(e);
      scl.set(t.s, flatten ? t.sy ?? t.s : t.s, t.s);
      m.compose(pos.set(t.x, t.y, t.z), q, scl);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.setScalar(t.shade ?? 1));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}

/** Things that can be swapped for loaded models (src/assets/models/<name>/). */
interface ReplaceableSet {
  transforms: Transform[];
  /** Height loaded models are normalised to, matching the placeholder. */
  height: number;
  object: THREE.Group;
}

export interface VegetationOptions {
  /** Areas to keep clear of trees and rocks. */
  avoid?: Circle[];
}

export function createVegetation(rng: Rng, terrain: Terrain, { avoid = [] }: VegetationOptions = {}) {
  const { heightAt, surfaceAt, lakeDistance, fbm } = terrain;
  const group = new THREE.Group();
  group.name = 'vegetation';

  const blocked = (x: number, z: number) => avoid.some((a) => (a.x - x) ** 2 + (a.z - z) ** 2 < a.r * a.r);

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
  const counts: Partial<Record<TreeType | 'rocks', number>> = {};
  for (const { x, z } of spots) {
    const zone: Zone = lakeDistance(x, z) < 2.2 ? 'shore' : z < -35 ? 'hills' : 'forest';
    const type = pickType(rng, TREE_MIX[zone]);
    const variant = Math.floor(rng() * VARIANTS_PER_TYPE);
    const detail: TreeDetail = Math.hypot(x - NEAR.x, z - NEAR.z) < NEAR.distance ? 'high' : 'low';
    const key = `${type}:${variant}:${detail}`;
    const set = treeSets.get(key) ?? { type, variant, detail, transforms: [] };
    treeSets.set(key, set);
    set.transforms.push({
      x, z,
      y: surfaceAt(x, z) - 0.1, // the drawn ground, so nothing floats on slopes
      rotY: rng() * Math.PI * 2,
      tiltX: rng.range(-0.04, 0.04),
      tiltZ: rng.range(-0.04, 0.04),
      s: rng.range(0.8, 1.2) * (z < -40 ? 1.2 : 1),
      shade: rng.range(0.88, 1.04),
    });
    counts[type] = (counts[type] ?? 0) + 1;
  }

  // Rocks around the shoreline.
  const rocks: Transform[] = [];
  for (let i = 0; i < 200 && rocks.length < 45; i++) {
    const ang = rng() * Math.PI * 2;
    const d = rng.range(0.95, 1.5);
    const x = LAKE.x + Math.cos(ang) * LAKE.rx * d;
    const z = LAKE.z + Math.sin(ang) * LAKE.rz * d;
    if (blocked(x, z)) continue;
    const s = rng.range(0.4, 1.4);
    rocks.push({
      x, z, y: Math.max(heightAt(x, z), -0.2) - s * 0.25,
      rotY: rng() * 6.28, s, sy: s * 0.6, shade: rng.range(0.8, 1.1), variant: rng(),
    });
  }
  counts.rocks = rocks.length;

  // One geometry per type x variant x detail, one shared material.
  const treeMaterial = createSnowTreeMaterial();
  const trees = new THREE.Group();
  trees.name = 'trees';
  for (const { type, variant, detail, transforms } of treeSets.values()) {
    const geometry = createSnowTreeGeometry(type, { seed: variant + 1, detail });
    trees.add(instanced(`${type}-${variant}-${detail}`, [{ geometry, material: treeMaterial }], transforms));
  }
  group.add(trees);

  // Placeholders go in immediately so the scene is never empty.
  const sets: Record<string, ReplaceableSet> = {
    rock: {
      transforms: rocks,
      height: 1.1,
      object: instanced('rock', [{ geometry: makeRock(rng), material: placeholderMaterial() }], rocks),
    },
  };
  for (const set of Object.values(sets)) group.add(set.object);

  /**
   * Swaps placeholders for real models wherever files exist in
   * src/assets/models/<name>/. Instances are spread across the variants.
   */
  async function upgrade(modelUrls: Record<string, string[]>, loadInstanceParts: LoadInstanceParts) {
    await Promise.all(Object.entries(sets).map(async ([name, set]) => {
      const urls = modelUrls[name];
      if (!urls?.length) return;
      try {
        const variants = await Promise.all(urls.map((u) => loadInstanceParts(u, { height: set.height })));
        const replacement = new THREE.Group();
        replacement.name = name;
        variants.forEach((parts, v) => {
          const subset = set.transforms.filter((t) => Math.floor((t.variant ?? 0) * variants.length) === v);
          replacement.add(instanced(`${name}-${v}`, parts, subset, { flatten: false }));
        });
        group.remove(set.object);
        disposeTree(set.object);
        set.object = replacement;
        group.add(replacement);
      } catch (err) {
        console.warn(`[landscape] couldn't load ${name} models, keeping placeholder`, err);
      }
    }));
  }

  return { object: group, upgrade, counts };
}

function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    const mats: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => m.dispose());
  });
}
