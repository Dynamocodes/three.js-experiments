import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { palette } from './palette.js';
import { lerp, smoothstep } from './rng.js';

// The lake is an ellipse carved into the terrain. Other modules use this
// (water plane, keeping trees out of the lake, later the fish).
export const LAKE = {
  x: 6, z: -4, rx: 52, rz: 24, waterLevel: 0,
  // A snowy bank pushing into the near-left of the lake: the cabin's spot.
  bank: { x: -11, z: 20, radius: 6, push: 1.0 },
};

export function createTerrain(rng) {
  const noise = createNoise2D(rng);

  const fbm = (x, z, octaves = 4) => {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, z * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm; // roughly -1..1
  };

  // 0 at the lake centre, 1 at the ellipse edge.
  const lakeDistance = (x, z) => {
    const dx = (x - LAKE.x) / LAKE.rx;
    const dz = (z - LAKE.z) / LAKE.rz;
    const b = LAKE.bank;
    const bank = b.push * Math.exp(-((x - b.x) ** 2 + (z - b.z) ** 2) / (2 * b.radius * b.radius));
    return Math.sqrt(dx * dx + dz * dz) + bank + fbm(x * 0.08, z * 0.08, 2) * 0.12;
  };

  // Height field: gentle rolling ground, hills rising behind the lake,
  // ridges on the far sides, lake carved out of the middle.
  const heightAt = (x, z) => {
    let h = 1.6 + fbm(x * 0.03, z * 0.03) * 1.8;

    const back = smoothstep(-20, -110, z);
    h += back * (16 + fbm(x * 0.012 + 40, z * 0.012) * 14);

    h += smoothstep(45, 110, Math.abs(x)) * (8 + fbm(x * 0.02, z * 0.02 + 9) * 6);

    const shore = smoothstep(0.75, 1.25, lakeDistance(x, z));
    return lerp(-1.6, h, shore);
  };

  // Big plane, offset backwards so it reaches the far hills.
  const SIZE = 420;
  const SEG = 170;
  let geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -70);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  }

  // Non-indexed so every triangle can get its own flat colour.
  geo = geo.toNonIndexed();
  geo.computeVertexNormals();

  const colors = new Float32Array(geo.attributes.position.count * 3);
  const p = geo.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const col = new THREE.Color();
  const snow = new THREE.Color(palette.snow);
  const snowShade = new THREE.Color(palette.snowShade);
  const rock = new THREE.Color(palette.rock);
  const shore = new THREE.Color(palette.shore);

  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    n.subVectors(c, b).cross(b.clone().sub(a)).normalize();
    const ny = Math.abs(n.y);
    const y = (a.y + b.y + c.y) / 3;

    if (y < -0.25) col.copy(shore); // below the waterline only, so the shore edge stays clean
    else if (ny < 0.72) col.copy(rock);
    else col.copy(snow).lerp(snowShade, rng() * 0.6);

    // Tiny per-face jitter gives the faceted low-poly sparkle.
    const j = 1 + (rng() - 0.5) * 0.06;
    for (let k = 0; k < 3; k++) {
      colors[(i + k) * 3 + 0] = col.r * j;
      colors[(i + k) * 3 + 1] = col.g * j;
      colors[(i + k) * 3 + 2] = col.b * j;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 }),
  );
  mesh.name = 'terrain';

  return { mesh, heightAt, lakeDistance, fbm };
}
