import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { palette } from './palette.js';
import { lerp } from './rng.js';
import { LAKE } from './terrain.js';

// --- Procedural placeholder models ---------------------------------------
// These stand in for real assets. Swap them later for GLBs (Quaternius, Kenney,
// your own Blender models): the scatter code only needs a BufferGeometry with
// vertex colours, with its origin at the base of the model.

function colorize(geo, hex) {
  const c = new THREE.Color(hex);
  const arr = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) arr.set([c.r, c.g, c.b], i);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function makeSpruce() {
  const parts = [];
  parts.push(colorize(new THREE.CylinderGeometry(0.15, 0.25, 1.3, 5).translate(0, 0.65, 0), palette.trunk));

  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = lerp(1.7, 0.55, t);
    const h = lerp(2.4, 1.6, t);
    const y = 0.9 + i * 1.15;
    parts.push(colorize(new THREE.ConeGeometry(r, h, 7).translate(0, y + h / 2, 0), i % 2 ? palette.spruce : palette.spruceDark));
    // Snow cap: a slightly fatter cone sitting on the upper part of the tier.
    const sh = h * 0.55;
    parts.push(colorize(new THREE.ConeGeometry(r * 0.58, sh, 7).translate(0, y + h - sh / 2 + 0.04, 0), palette.snow));
  }
  return mergeGeometries(parts);
}

function makeBirch(rng) {
  const parts = [];
  const height = 7;
  parts.push(colorize(new THREE.CylinderGeometry(0.11, 0.18, height, 6).translate(0, height / 2, 0), palette.birch));

  // Black bark marks.
  for (let i = 0; i < 5; i++) {
    const y = rng.range(0.6, height - 1);
    const r = lerp(0.18, 0.11, y / height) + 0.01;
    parts.push(colorize(new THREE.CylinderGeometry(r, r, rng.range(0.08, 0.2), 6).translate(0, y, 0), palette.birchMark));
  }

  // Bare winter branches.
  for (let i = 0; i < 6; i++) {
    const len = rng.range(1.2, 2.4);
    const branch = new THREE.CylinderGeometry(0.025, 0.05, len, 4).translate(0, len / 2, 0);
    branch.rotateZ(rng.range(0.5, 0.9));
    branch.rotateY((i / 6) * Math.PI * 2 + rng.range(-0.3, 0.3));
    branch.translate(0, rng.range(3.2, height - 0.6), 0);
    parts.push(colorize(branch, palette.birch));
  }
  return mergeGeometries(parts);
}

function makeRock(rng) {
  let geo = new THREE.IcosahedronGeometry(1, 0);
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
// Dart-throwing Poisson disk: random candidates, rejected if too close to an
// accepted one. A grid keeps neighbour lookups cheap.
function poisson(rng, { minX, maxX, minZ, maxZ, radius, attempts, accept }) {
  const cell = radius / Math.SQRT2;
  const cols = Math.ceil((maxX - minX) / cell);
  const grid = new Map();
  const points = [];
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

const placeholderMaterial = () =>
  new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });

/**
 * Builds InstancedMeshes for one model. `parts` is [{geometry, material}]
 * (one entry for a procedural model, one per material for a loaded GLB);
 * every part shares the same instance transforms.
 */
function instanced(name, parts, transforms, { flatten = true } = {}) {
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

// Target heights loaded models are normalised to, matching the placeholders.
const MODEL_HEIGHT = { spruce: 6, birch: 7.5, rock: 1.1 };

export function createVegetation(rng, terrain, { avoid = [] } = {}) {
  const { heightAt, lakeDistance, fbm } = terrain;
  const group = new THREE.Group();
  group.name = 'vegetation';

  const blocked = (x, z) => avoid.some((a) => (a.x - x) ** 2 + (a.z - z) ** 2 < a.r * a.r);

  // Forest density mask: noise makes stands of forest with open snowfields
  // between them, so the hill shapes stay readable.
  const density = (x, z) => {
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

  const spruces = [];
  const birches = [];
  for (const { x, z } of spots) {
    const nearShore = lakeDistance(x, z) < 2.2;
    const isBirch = rng() < (nearShore ? 0.35 : 0.1);
    const t = {
      x, z,
      y: heightAt(x, z) - 0.2,
      rotY: rng() * Math.PI * 2,
      tiltX: rng.range(-0.05, 0.05),
      tiltZ: rng.range(-0.05, 0.05),
      s: rng.range(0.8, 1.5) * (z < -40 ? 1.25 : 1),
      shade: rng.range(0.82, 1.05),
      variant: rng(), // picks a model variant once real models exist
    };
    (isBirch ? birches : spruces).push(t);
  }

  // Rocks around the shoreline.
  const rocks = [];
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

  const sets = {
    spruce: { transforms: spruces, placeholder: () => makeSpruce() },
    birch: { transforms: birches, placeholder: () => makeBirch(rng) },
    rock: { transforms: rocks, placeholder: () => makeRock(rng) },
  };

  // Placeholders go in immediately so the scene is never empty.
  for (const [name, set] of Object.entries(sets)) {
    set.object = instanced(name, [{ geometry: set.placeholder(), material: placeholderMaterial() }], set.transforms);
    group.add(set.object);
  }

  /**
   * Swaps placeholders for real models wherever files exist in
   * src/assets/models/<name>/. Instances are spread across the variants.
   */
  async function upgrade(modelUrls, loadInstanceParts) {
    await Promise.all(Object.entries(sets).map(async ([name, set]) => {
      const urls = modelUrls[name];
      if (!urls?.length) return;
      try {
        const variants = await Promise.all(urls.map((u) => loadInstanceParts(u, { height: MODEL_HEIGHT[name] })));
        const replacement = new THREE.Group();
        replacement.name = name;
        variants.forEach((parts, v) => {
          const subset = set.transforms.filter((t) => Math.floor(t.variant * variants.length) === v);
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

  return {
    object: group,
    upgrade,
    counts: { spruces: spruces.length, birches: birches.length, rocks: rocks.length },
  };
}

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose?.();
  });
}
