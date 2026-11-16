import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Low-poly snowman: three lumpy snowballs, coal face and buttons, a carrot
 * nose, twig arms, a knitted scarf and a choice of hat. Seeded, so every
 * snowman built with the same seed looks the same, and different seeds give
 * slightly different proportions, poses and smiles.
 *
 *   import { createSnowman } from './snowman';
 *
 *   const snowman = createSnowman({ seed: 2, hat: 'tophat' });
 *   snowman.position.set(x, terrain.heightAt(x, z), z);
 *   scene.add(snowman);
 *
 *   // every frame: idle scarf sway, plus any reaction in progress
 *   snowman.userData.update(deltaSeconds);
 *
 *   // on click or snowball hit: wobble, hat hop, arm wave
 *   snowman.userData.react();
 *   // or pass where it was hit (world space) to wobble away from the impact
 *   snowman.userData.react(hitPoint);
 *
 * Faces +Z. About 1.75 units tall without a hat (the cabin door is 1.85).
 *
 * Hats: 'tophat', 'beanie', 'bucket', 'none'.
 * Named anchors: `hatAnchor`, `noseAnchor`, `headAnchor`.
 * `snowman.userData.hitTargets` lists the meshes worth raycasting against.
 */

export const SNOWMAN_HATS = ['tophat', 'beanie', 'bucket', 'none'] as const;
export type SnowmanHat = (typeof SNOWMAN_HATS)[number];
export type SnowmanColors = typeof DEFAULT_SNOWMAN_COLORS;

export const DEFAULT_SNOWMAN_COLORS = {
  snow: '#f3f6fc',
  snowShade: '#c6d1e8',
  coal: '#26262c',
  carrot: '#e8772e',
  carrotDark: '#c95f1f',
  twig: '#5a4334',
  scarf: '#c8323a', // knit red
  scarfStripe: '#f1e6d2',
  hatMain: '#24242a',
  hatBand: '#b8323a',
  beanie: '#2f5d8c',
  beanieStripe: '#f1e6d2',
  bucket: '#8f969e',
  bucketRim: '#6c727a',
};

export interface SnowmanOptions {
  seed?: number;
  hat?: SnowmanHat;
  scarf?: boolean;
  arms?: boolean;
  /** Height without the hat. */
  height?: number;
  colors?: Partial<SnowmanColors>;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** What createSnowman puts on `userData` (cast `snowman.userData as SnowmanApi`). */
export interface SnowmanApi {
  /** Call every frame with the seconds since the last frame. */
  update(dt: number): void;
  /** Wobble, hat hop and arm wave; pass a world-space hit point to wobble away from it. */
  react(hitPoint?: THREE.Vector3): void;
  /** The meshes worth raycasting against. */
  hitTargets: THREE.Mesh[];
  parts: {
    body: THREE.Group;
    headPivot: THREE.Group;
    hat: THREE.Group;
    arms: THREE.Group[];
    scarfTail: THREE.Group | null;
  };
  materials: Record<string, THREE.Material>;
  dispose(): void;
}

type Rnd = () => number;
type Attr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function makeRng(seed: number): Rnd {
  let state = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

function makeNoise(rnd: Rnd, octaves = 4) {
  const waves: { d: THREE.Vector3; f: number; p: number; a: number }[] = [];
  for (let i = 0; i < octaves; i++) {
    const d = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    waves.push({ d, f: 2 * 1.9 ** i, p: rnd() * Math.PI * 2, a: 0.6 ** i });
  }
  const norm = waves.reduce((s, w) => s + w.a, 0);
  return (x: number, y: number, z: number) => {
    let s = 0;
    for (const w of waves) s += Math.sin((x * w.d.x + y * w.d.y + z * w.d.z) * w.f + w.p) * w.a;
    return s / norm;
  };
}

export function createSnowman(options: SnowmanOptions = {}) {
  const {
    seed = 1,
    hat = 'tophat',
    scarf = true,
    arms = true,
    height = 1.75, // without the hat
    colors: colorOverrides = {},
    castShadow = true,
    receiveShadow = true,
  } = options;

  const colors = { ...DEFAULT_SNOWMAN_COLORS, ...colorOverrides };
  const rnd = makeRng(seed * 7919 + 17);

  const mat = (c: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.9, ...extra });
  const materials = {
    snow: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }),
    coal: mat(colors.coal, { roughness: 0.6 }),
    carrot: mat(colors.carrot),
    twig: mat(colors.twig),
    knit: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }),
    hatMain: mat(colors.hatMain, { roughness: 0.7 }),
    hatBand: mat(colors.hatBand),
    bucket: mat(colors.bucket, { roughness: 0.45, metalness: 0.5 }),
    bucketRim: mat(colors.bucketRim, { roughness: 0.45, metalness: 0.5 }),
  };

  const root = new THREE.Group();
  root.name = 'snowman';
  const hitTargets: THREE.Mesh[] = [];

  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, hit = true) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = castShadow;
    m.receiveShadow = receiveShadow;
    parent.add(m);
    if (hit) hitTargets.push(m);
    return m;
  };

  // ---------- snowballs ----------
  /** Lumpy, flat-shaded snowball with darker underside (vertex colours). */
  function snowball(r: number, squash = 1, detail = 2, lump = 0.06) {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const p = g.attributes.position;
    const noise = makeNoise(rnd);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + noise(x, y, z) * lump;
      p.setXYZ(i, x * k * r, y * k * r * squash, z * k * r);
    }
    g = g.toNonIndexed();
    g.computeVertexNormals();
    const n = g.attributes.normal;
    const snow = new THREE.Color(colors.snow);
    const shade = new THREE.Color(colors.snowShade);
    const c = new THREE.Color();
    const pos = g.attributes.position;
    const out = new Float32Array(pos.count * 3);
    for (let f = 0; f < pos.count; f += 3) {
      const ny = (n.getY(f) + n.getY(f + 1) + n.getY(f + 2)) / 3;
      c.copy(snow).lerp(shade, clamp((0.1 - ny) * 0.9) * 0.9);
      c.multiplyScalar(0.98 + rnd() * 0.04);
      for (let k = 0; k < 3; k++) c.toArray(out, (f + k) * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(out, 3));
    return g;
  }

  const S = height / 1.75;
  const rB = 0.56 * S * lerp(0.95, 1.06, rnd());
  const rM = 0.41 * S * lerp(0.94, 1.05, rnd());
  const rH = 0.29 * S * lerp(0.95, 1.05, rnd());
  // Balls sink a little into each other, like real packed snow.
  const yB = rB * 0.82;
  const yM = yB + rB * 0.86 * 0.92 + rM * 0.72;
  const yH = yM + rM * 0.9 + rH * 0.78;

  // The body group squashes and wobbles during reactions; pivot at the base.
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);

  add(body, snowball(rB, 0.86, 2, 0.07), materials.snow, 0, yB, 0);
  // Packed snow ring around the base.
  const ring = snowball(rB * 1.18, 0.22, 1, 0.12);
  add(body, ring, materials.snow, 0, 0.02, 0, false);
  add(body, snowball(rM, 0.92, 2, 0.06), materials.snow, (rnd() - 0.5) * 0.03, yM, (rnd() - 0.5) * 0.03);

  // Head pivot sits on the middle ball, so the head can tilt and nod.
  const headPivot = new THREE.Group();
  headPivot.name = 'headPivot';
  headPivot.position.set(0, yM + rM * 0.82, 0);
  headPivot.rotation.z = (rnd() - 0.5) * 0.16;
  headPivot.rotation.x = (rnd() - 0.4) * 0.12;
  body.add(headPivot);
  const hy = yH - headPivot.position.y; // head centre, local to the pivot
  add(headPivot, snowball(rH, 0.96, 2, 0.05), materials.snow, 0, hy, 0);

  const headAnchor = new THREE.Object3D();
  headAnchor.name = 'headAnchor';
  headAnchor.position.set(0, hy, 0);
  headPivot.add(headAnchor);

  // Puts a point on the surface of a sphere at (yaw, pitch) facing +Z.
  const onSphere = (r: number, cy: number, yaw: number, pitch: number, out = 0) => new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch) * (r + out),
    cy + Math.sin(pitch) * (r + out),
    Math.cos(yaw) * Math.cos(pitch) * (r + out),
  );

  // ---------- face ----------
  const coal = (size: number) => {
    const g = new THREE.DodecahedronGeometry(size, 0);
    g.scale(1, 1, 0.75);
    g.rotateY(rnd() * Math.PI);
    return g;
  };
  for (const side of [-1, 1]) {
    const p = onSphere(rH, hy, side * 0.33, 0.22, -0.01);
    add(headPivot, coal(0.042 * S), materials.coal, p.x, p.y, p.z);
  }
  // Coal smile: an arc of pebbles.
  const smile = lerp(0.1, 0.22, rnd());
  const pebbles = 5;
  for (let i = 0; i < pebbles; i++) {
    const t = i / (pebbles - 1) - 0.5;
    const p = onSphere(rH, hy, t * 0.75, -0.3 + smile * (1 - (2 * t) ** 2) * -1 + smile * 0.5, -0.008);
    add(headPivot, coal(0.024 * S), materials.coal, p.x, p.y, p.z);
  }

  // Carrot nose: a ribbed, slightly crooked cone.
  const noseLen = 0.3 * S * lerp(0.85, 1.15, rnd());
  const noseGeo = new THREE.ConeGeometry(0.05 * S, noseLen, 6, 3);
  {
    const p = noseGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / noseLen + 0.5; // 0 at base, 1 at tip
      // Rings where the carrot narrows, and a little droop towards the tip.
      const ring = Math.abs(((y * 3) % 1) - 0.5) < 0.12 && y < 0.95 ? 0.85 : 1;
      p.setX(i, p.getX(i) * ring);
      p.setZ(i, p.getZ(i) * ring + y * y * 0.035 * S);
    }
    noseGeo.computeVertexNormals();
  }
  noseGeo.rotateX(Math.PI / 2); // tip towards +Z
  const nosePos = onSphere(rH, hy, (rnd() - 0.5) * 0.08, 0.02, -0.03);
  const nose = add(headPivot, noseGeo, materials.carrot, nosePos.x, nosePos.y, nosePos.z + noseLen * 0.45);
  nose.rotation.x = 0.12 + rnd() * 0.08; // droops a little
  nose.rotation.y = (rnd() - 0.5) * 0.25;
  const noseAnchor = new THREE.Object3D();
  noseAnchor.name = 'noseAnchor';
  noseAnchor.position.set(0, 0, noseLen * 0.5);
  nose.add(noseAnchor);

  // ---------- buttons ----------
  const buttons = 3;
  for (let i = 0; i < buttons; i++) {
    const pitch = lerp(0.5, -0.35, i / (buttons - 1));
    const p = onSphere(rM, yM, (rnd() - 0.5) * 0.06, pitch, -0.01);
    add(body, coal(0.045 * S), materials.coal, p.x, p.y, p.z);
  }
  {
    const p = onSphere(rB, yB, 0.03, 0.25, -0.01);
    add(body, coal(0.05 * S), materials.coal, p.x, p.y, p.z);
  }

  // ---------- twig arms ----------
  const up = new THREE.Vector3(0, 1, 0);
  const stick = (parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(r1, r0, len, 5, 1);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    return add(parent, g, materials.twig);
  };
  const armPivots: THREE.Group[] = [];
  if (arms) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.name = side < 0 ? 'armRight' : 'armLeft';
      const shoulder = onSphere(rM, yM, side * 1.5, 0.28, -0.08);
      pivot.position.copy(shoulder);
      body.add(pivot);
      // Arm: elbowed twig, raised at a seeded angle, with two or three fingers.
      const raise = lerp(0.15, 0.75, rnd());
      const len = 0.62 * S * lerp(0.9, 1.1, rnd());
      const fwd = (rnd() - 0.3) * 0.35;
      const elbow = new THREE.Vector3(side * len * 0.55, len * 0.55 * Math.sin(raise) * 0.7, fwd * len * 0.5);
      const hand = elbow.clone().add(new THREE.Vector3(side * len * 0.45, len * 0.45 * Math.sin(raise + 0.3), fwd * len * 0.3));
      stick(pivot, new THREE.Vector3(), elbow, 0.03 * S, 0.024 * S);
      stick(pivot, elbow, hand, 0.024 * S, 0.014 * S);
      const fingers = 2 + (rnd() < 0.5 ? 1 : 0);
      for (let f = 0; f < fingers; f++) {
        const a = (f / Math.max(1, fingers - 1) - 0.5) * 1.1 + (rnd() - 0.5) * 0.3;
        const dir = new THREE.Vector3().subVectors(hand, elbow).normalize();
        const side2 = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
        const tip = hand.clone()
          .addScaledVector(dir, Math.cos(a) * 0.11 * S)
          .addScaledVector(new THREE.Vector3(0, 1, 0), Math.sin(a) * 0.1 * S)
          .addScaledVector(side2, (rnd() - 0.5) * 0.06 * S);
        stick(pivot, hand, tip, 0.013 * S, 0.006 * S);
      }
      // A small side twig partway along the forearm.
      const mid = elbow.clone().lerp(hand, 0.4);
      stick(pivot, mid, mid.clone().add(new THREE.Vector3(side * 0.05 * S, 0.1 * S, (rnd() - 0.5) * 0.06)), 0.012 * S, 0.006 * S);
      pivot.userData.baseZ = pivot.rotation.z;
      pivot.userData.side = side;
      armPivots.push(pivot);
    }
  }

  // ---------- knitted scarf ----------
  let scarfTail: THREE.Group | null = null;
  if (scarf) {
    const knitColor = (g: THREE.BufferGeometry, stripeAxis: (pos: Attr, i: number) => number, stripeEvery: number) => {
      const pos = g.attributes.position;
      const out = new Float32Array(pos.count * 3);
      const a = new THREE.Color(colors.scarf);
      const b = new THREE.Color(colors.scarfStripe);
      const c = new THREE.Color();
      for (let f = 0; f < pos.count; f += 3) {
        const v = (stripeAxis(pos, f) + stripeAxis(pos, f + 1) + stripeAxis(pos, f + 2)) / 3;
        const stripe = Math.floor(v / stripeEvery) % 2 !== 0;
        c.copy(stripe ? b : a).multiplyScalar(0.94 + rnd() * 0.1);
        for (let k = 0; k < 3; k++) c.toArray(out, (f + k) * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(out, 3));
      return g;
    };
    const neckY = yM + rM * 0.84;
    const wrapR = rH * 0.95;
    let tor: THREE.BufferGeometry = new THREE.TorusGeometry(wrapR, 0.075 * S, 5, 14);
    tor.rotateX(Math.PI / 2);
    tor.scale(1, 0.8, 1);
    tor = tor.toNonIndexed();
    tor.computeVertexNormals();
    knitColor(tor, (p, i) => Math.atan2(p.getZ(i), p.getX(i)) + Math.PI, Math.PI / 5);
    add(body, tor, materials.knit, 0, neckY, 0);

    // Hanging tail. It drapes over the middle snowball (following its curve),
    // then hangs free below the widest point. It pivots at the knot to sway.
    const yaw = (0.5 + rnd() * 0.35) * (rnd() < 0.5 ? -1 : 1);
    const tailLen = 0.5 * S;
    const tailW = 0.13 * S;
    const tailT = 0.035 * S;
    const clearance = 0.03 * S;
    const pitch0 = 0.78;
    const arcLen = rM * pitch0; // length of the part lying on the ball
    const C = new THREE.Vector3(0, yM, 0);
    const out = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const W = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)); // across the scarf
    const pathAt = (d: number): { p: THREE.Vector3; n: THREE.Vector3 } => {
      // d = distance down the tail from the knot
      if (d <= arcLen) {
        const pch = pitch0 * (1 - d / arcLen);
        const pt = out.clone().multiplyScalar(Math.cos(pch) * (rM + clearance));
        pt.y = Math.sin(pch) * (rM * 0.92 + clearance);
        const nrm = out.clone().multiplyScalar(Math.cos(pch)).setY(Math.sin(pch)).normalize();
        return { p: pt.add(C), n: nrm };
      }
      const p = out.clone().multiplyScalar(rM + clearance).add(C);
      p.y -= d - arcLen;
      // Below the equator it hangs straight, tipping out a touch.
      p.addScaledVector(out, (d - arcLen) * 0.12);
      return { p, n: out.clone() };
    };
    const N = 10;
    const stripeA = new THREE.Color(colors.scarf);
    const stripeB = new THREE.Color(colors.scarfStripe);
    const positions: number[] = [];
    const cols: number[] = [];
    const ring: THREE.Vector3[][] = [];
    for (let k = 0; k <= N; k++) {
      const d = (k / N) * tailLen;
      const { p, n } = pathAt(d);
      const wid = tailW * (1 + (d / tailLen) * 0.12);
      ring.push([
        p.clone().addScaledVector(W, -wid / 2).addScaledVector(n, tailT / 2),
        p.clone().addScaledVector(W, wid / 2).addScaledVector(n, tailT / 2),
        p.clone().addScaledVector(W, wid / 2).addScaledVector(n, -tailT / 2),
        p.clone().addScaledVector(W, -wid / 2).addScaledVector(n, -tailT / 2),
      ]);
    }
    const c = new THREE.Color();
    const quad = (a: THREE.Vector3, b: THREE.Vector3, cc: THREE.Vector3, dd: THREE.Vector3, color: THREE.Color) => {
      for (const v of [a, b, cc, a, cc, dd]) { positions.push(v.x, v.y, v.z); cols.push(color.r, color.g, color.b); }
    };
    for (let k = 0; k < N; k++) {
      const stripe = Math.floor((k / N) * 4.5) % 2 === 1;
      c.copy(stripe ? stripeB : stripeA).multiplyScalar(0.94 + rnd() * 0.1);
      const r0 = ring[k];
      const r1 = ring[k + 1];
      for (let e = 0; e < 4; e++) quad(r0[e], r0[(e + 1) % 4], r1[(e + 1) % 4], r1[e], c);
    }
    quad(ring[N][3], ring[N][2], ring[N][1], ring[N][0], c);
    const tail = new THREE.BufferGeometry();
    tail.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    tail.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    // Fringe at the end.
    const end = pathAt(tailLen);
    const fringe: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 4; k++) {
      const f = new THREE.BoxGeometry(0.02 * S, 0.07 * S, 0.02 * S).toNonIndexed();
      const fp = end.p.clone().addScaledVector(W, (k / 3 - 0.5) * tailW * 0.9);
      f.translate(fp.x, fp.y - 0.035 * S, fp.z);
      const fc = new Float32Array(f.attributes.position.count * 3);
      for (let i = 0; i < fc.length; i += 3) stripeA.toArray(fc, i);
      f.setAttribute('color', new THREE.BufferAttribute(fc, 3));
      f.deleteAttribute('normal');
      f.deleteAttribute('uv');
      fringe.push(f);
    }
    // Into the knot's local frame, so the pivot sways around the knot.
    const knot = pathAt(0).p;
    const tailGroup = new THREE.Group();
    tailGroup.name = 'scarfTail';
    tailGroup.position.copy(knot);
    tailGroup.rotation.y = yaw;
    body.add(tailGroup);
    for (const g of [tail, ...fringe]) {
      g.translate(-knot.x, -knot.y, -knot.z);
      g.rotateY(-yaw);
      g.computeVertexNormals();
      add(tailGroup, g, materials.knit);
    }
    // A small knot bump where the tail leaves the wrap.
    const knotGeo = new THREE.IcosahedronGeometry(0.06 * S, 0);
    knotGeo.scale(1.3, 0.9, 0.8);
    knotGeo.computeVertexNormals();
    const kc = new Float32Array(knotGeo.attributes.position.count * 3);
    for (let i = 0; i < kc.length; i += 3) stripeA.toArray(kc, i);
    knotGeo.setAttribute('color', new THREE.BufferAttribute(kc, 3));
    add(tailGroup, knotGeo, materials.knit, 0, 0.02 * S, 0.01 * S);
    tailGroup.userData.baseX = 0;
    scarfTail = tailGroup;
  }

  // ---------- hat ----------
  const hatPivot = new THREE.Group();
  hatPivot.name = 'hat';
  const hatBaseY = hy + rH * 0.78;
  hatPivot.position.set(0, hatBaseY, 0);
  hatPivot.rotation.z = (rnd() - 0.5) * 0.25;
  hatPivot.rotation.x = -0.06;
  headPivot.add(hatPivot);

  if (hat === 'tophat') {
    const h = 0.34 * S;
    add(hatPivot, new THREE.CylinderGeometry(0.34 * S, 0.34 * S, 0.03 * S, 10), materials.hatMain, 0, 0.015 * S, 0);
    add(hatPivot, new THREE.CylinderGeometry(0.2 * S, 0.21 * S, h, 9), materials.hatMain, 0, h / 2, 0);
    add(hatPivot, new THREE.CylinderGeometry(0.212 * S, 0.215 * S, 0.06 * S, 9), materials.hatBand, 0, 0.065 * S, 0);
  } else if (hat === 'beanie') {
    let dome: THREE.BufferGeometry = new THREE.SphereGeometry(rH * 1.02, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.5);
    dome.scale(1, 1.15, 1);
    dome.translate(0, -0.06 * S, 0);
    dome = dome.toNonIndexed();
    const beanieColor = (g: THREE.BufferGeometry, every: number) => {
      const pos = g.attributes.position;
      const out = new Float32Array(pos.count * 3);
      const a = new THREE.Color(colors.beanie);
      const b = new THREE.Color(colors.beanieStripe);
      const c = new THREE.Color();
      for (let f = 0; f < pos.count; f += 3) {
        const y = (pos.getY(f) + pos.getY(f + 1) + pos.getY(f + 2)) / 3;
        c.copy(Math.floor((y + 1) / every) % 2 ? b : a).multiplyScalar(0.95 + rnd() * 0.08);
        for (let k = 0; k < 3; k++) c.toArray(out, (f + k) * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(out, 3));
      return g;
    };
    dome.computeVertexNormals();
    add(hatPivot, beanieColor(dome, 0.07 * S), materials.knit);
    let cuff: THREE.BufferGeometry = new THREE.TorusGeometry(rH * 1.0, 0.05 * S, 4, 12);
    cuff.rotateX(Math.PI / 2);
    cuff = cuff.toNonIndexed();
    cuff.computeVertexNormals();
    const cuffMesh = add(hatPivot, cuff, materials.knit, 0, -0.05 * S, 0);
    const cc = new Float32Array(cuff.attributes.position.count * 3);
    const cuffC = new THREE.Color(colors.beanie).multiplyScalar(0.8);
    for (let i = 0; i < cc.length; i += 3) cuffC.toArray(cc, i);
    cuffMesh.geometry.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    const pom = new THREE.IcosahedronGeometry(0.08 * S, 1);
    pom.computeVertexNormals();
    const pc = new Float32Array(pom.attributes.position.count * 3);
    const pomC = new THREE.Color(colors.beanieStripe);
    for (let i = 0; i < pc.length; i += 3) pomC.toArray(pc, i);
    pom.setAttribute('color', new THREE.BufferAttribute(pc, 3));
    add(hatPivot, pom, materials.knit, 0, rH * 1.15 - 0.03 * S, 0);
  } else if (hat === 'bucket') {
    const h = 0.3 * S;
    // Upside-down bucket: wide at the head, narrow on top.
    add(hatPivot, new THREE.CylinderGeometry(0.17 * S, 0.24 * S, h, 9, 1), materials.bucket, 0, h / 2 - 0.03 * S, 0);
    add(hatPivot, new THREE.CylinderGeometry(0.25 * S, 0.25 * S, 0.035 * S, 9), materials.bucketRim, 0, -0.03 * S, 0);
    add(hatPivot, new THREE.CylinderGeometry(0.18 * S, 0.18 * S, 0.03 * S, 9), materials.bucketRim, 0, h - 0.03 * S, 0);
    const handle = new THREE.TorusGeometry(0.23 * S, 0.008 * S, 3, 10, Math.PI);
    const hm = add(hatPivot, handle, materials.bucketRim, 0, h * 0.25, 0);
    hm.rotation.set(Math.PI, 0, 0.2);
  }
  const hatAnchor = new THREE.Object3D();
  hatAnchor.name = 'hatAnchor';
  hatPivot.add(hatAnchor);

  // ---------- animation ----------
  const base = {
    hatY: hatPivot.position.y,
    hatRotZ: hatPivot.rotation.z,
    hatRotX: hatPivot.rotation.x,
    headRotZ: headPivot.rotation.z,
    headRotX: headPivot.rotation.x,
  };
  let time = rnd() * 100;
  let reactT = Infinity; // seconds since the last reaction
  const wobbleDir = new THREE.Vector2(1, 0);
  const tmp = new THREE.Vector3();

  function react(hitPoint?: THREE.Vector3) {
    reactT = 0;
    if (hitPoint) {
      // Wobble away from the impact, in the snowman's own frame.
      tmp.copy(hitPoint);
      root.worldToLocal(tmp);
      wobbleDir.set(-tmp.x, -tmp.z);
      if (wobbleDir.lengthSq() < 1e-6) wobbleDir.set(1, 0);
      wobbleDir.normalize();
    } else {
      const a = Math.random() * Math.PI * 2;
      wobbleDir.set(Math.cos(a), Math.sin(a));
    }
  }

  function update(dt: number) {
    time += dt;
    reactT += dt;

    // Idle: the scarf tail sways and the arms twitch slightly in the wind.
    if (scarfTail) {
      scarfTail.rotation.x = -(0.5 + 0.5 * Math.sin(time * 1.3)) * 0.07;
      scarfTail.rotation.z = Math.sin(time * 0.9 + 1) * 0.05;
    }
    armPivots.forEach((p, i) => {
      p.rotation.z = p.userData.baseZ + Math.sin(time * 1.1 + i * 2) * 0.015;
    });

    // Reaction: a damped wobble and squash, the hat hops off and lands, the arms wave.
    const t = reactT;
    if (t < 2.2) {
      const decay = Math.exp(-t * 2.4);
      const w = Math.sin(t * 13) * 0.16 * decay;
      body.rotation.z = -wobbleDir.x * w;
      body.rotation.x = wobbleDir.y * w;
      const squash = 1 - Math.sin(Math.min(t, 0.25) / 0.25 * Math.PI) * 0.08;
      body.scale.set(2 - squash, squash, 2 - squash);

      const hop = t < 0.7 ? Math.sin((t / 0.7) * Math.PI) * 0.32 * S : 0;
      const settle = t >= 0.7 ? Math.sin((t - 0.7) * 18) * Math.exp(-(t - 0.7) * 7) * 0.03 * S : 0;
      hatPivot.position.y = base.hatY + hop + settle;
      hatPivot.rotation.z = base.hatRotZ + Math.sin(clamp(t / 0.7) * Math.PI) * 0.5 * -wobbleDir.x;
      hatPivot.rotation.x = base.hatRotX + Math.sin(clamp(t / 0.7) * Math.PI) * 0.3 * wobbleDir.y;

      headPivot.rotation.z = base.headRotZ + Math.sin(t * 9 + 0.5) * 0.12 * decay;
      headPivot.rotation.x = base.headRotX + Math.sin(t * 7) * 0.06 * decay;

      const wave = Math.sin(t * 14) * 0.35 * Math.exp(-t * 1.6);
      armPivots.forEach((p) => { p.rotation.z += wave * p.userData.side; });
    } else if (body.rotation.z !== 0 || body.scale.y !== 1) {
      body.rotation.set(0, 0, 0);
      body.scale.set(1, 1, 1);
      hatPivot.position.y = base.hatY;
      hatPivot.rotation.z = base.hatRotZ;
      hatPivot.rotation.x = base.hatRotX;
      headPivot.rotation.z = base.headRotZ;
      headPivot.rotation.x = base.headRotX;
    }
  }

  const api: SnowmanApi = {
    update,
    react,
    hitTargets,
    parts: { body, headPivot, hat: hatPivot, arms: armPivots, scarfTail },
    materials,
    dispose: () => {
      root.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
      Object.values(materials).forEach((m) => m.dispose());
    },
  };
  Object.assign(root.userData, api);
  // Mark every mesh so a raycast hit can be traced back to its snowman.
  hitTargets.forEach((m) => { m.userData.snowman = root; });

  return root;
}
