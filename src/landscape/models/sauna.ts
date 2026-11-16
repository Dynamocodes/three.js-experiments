import * as THREE from 'three';

/**
 * Low-poly lakeside sauna: a small log hut, honey-coloured logs on a stone
 * plinth, a gable roof reaching out over a little porch, a big glass door and
 * window, a stone chimney, and a side deck with a wooden hot tub, lanterns,
 * a bench with towels and a bucket of firewood.
 *
 * Usage:
 *   import { createSauna } from './sauna';
 *   const sauna = createSauna();     // THREE.Group, origin at floor level
 *   scene.add(sauna);
 *
 * Orientation: the porch and door face +Z, the ridge runs along Z, the hot
 * tub deck is on the +X side. The room is about 3.7 (x) by 3.2 (z) units,
 * about 6.5 by 5 with the decks. The plinth and deck posts reach 1.5 units
 * below the origin, so set the origin at the highest ground under the room
 * and the downhill side still meets the snow.
 *
 * Anchors (Object3D children by name): 'smokeAnchor' (chimney top),
 * 'steamAnchor' (hot tub water), 'lightAnchor' (in front of the door, for a
 * warm point light).
 */

export const DEFAULT_SAUNA_COLORS = {
  bark: ['#a07a55', '#8f6c4a', '#ad8660'], // log sides, picked at random per log
  cut: '#e3b880', // log end grain
  roof: '#5b4737',
  roofUnderside: '#c48f5a',
  deck: ['#8a6a4e', '#7b5e45'], // alternating planks
  stone: ['#7d8088', '#6c6f77', '#8d9097'],
  snow: '#f4f6fc',
  glass: '#4a5363',
  frame: '#6b4a2e',
  metal: '#2a2d33',
  tub: '#8d5c3a',
  water: '#35506e',
  lanternGlow: '#ffc27a',
  towel: '#eef0f4',
};

export interface SaunaOptions {
  seed?: number;
  colors?: Partial<typeof DEFAULT_SAUNA_COLORS>;
  castShadow?: boolean;
  receiveShadow?: boolean;
  snowOnRoof?: boolean;
  hotTub?: boolean;
}

export function createSauna(options: SaunaOptions = {}) {
  const {
    seed = 11,
    colors: colorOverrides = {},
    castShadow = true,
    receiveShadow = true,
    snowOnRoof = true,
    hotTub = true,
  } = options;
  const colors = { ...DEFAULT_SAUNA_COLORS, ...colorOverrides };

  let state = Math.max(1, Math.floor(seed)) % 2147483647;
  const rnd = () => (state = (state * 16807) % 2147483647) / 2147483647;

  const mat = (c: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.95, ...extra });
  const materials = {
    barks: colors.bark.map((c) => mat(c)),
    cut: mat(colors.cut),
    roof: mat(colors.roof),
    roofUnderside: mat(colors.roofUnderside),
    deck: colors.deck.map((c) => mat(c)),
    stones: colors.stone.map((c) => mat(c)),
    snow: mat(colors.snow, { roughness: 0.8 }),
    glass: mat(colors.glass, { roughness: 0.3 }),
    frame: mat(colors.frame),
    metal: mat(colors.metal),
    tub: mat(colors.tub),
    water: mat(colors.water, { roughness: 0.12, metalness: 0.25, emissive: '#1a2a3c', emissiveIntensity: 0.6 }),
    lantern: mat(colors.lanternGlow, { emissive: colors.lanternGlow, emissiveIntensity: 2 }),
    towel: mat(colors.towel),
  };

  const group = new THREE.Group();
  group.name = 'sauna';

  // ---------- helpers ----------
  function add(geo: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], x: number, y: number, z: number, name?: string) {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = castShadow;
    m.receiveShadow = receiveShadow;
    if (name) m.name = name;
    group.add(m);
    return m;
  }
  const box = (w: number, h: number, d: number, material: THREE.Material | THREE.Material[], x: number, y: number, z: number, name?: string) =>
    add(new THREE.BoxGeometry(w, h, d), material, x, y, z, name);
  const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)];

  /** A hexagonal log along the given axis, with end-grain caps. */
  function log(len: number, axis: 'x' | 'y' | 'z', x: number, y: number, z: number, r = R) {
    const geo = new THREE.CylinderGeometry(r * (0.9 + rnd() * 0.12), r, len, 6, 1);
    geo.rotateY(rnd() * Math.PI);
    if (axis === 'x') geo.rotateZ(Math.PI / 2);
    if (axis === 'z') geo.rotateX(Math.PI / 2);
    return add(geo, [pick(materials.barks), materials.cut, materials.cut], x, y, z, 'log');
  }

  /** Extrudes a 2D profile (in the XY plane) along +Z. */
  function prism(points: [x: number, y: number][], z0: number, depth: number, material: THREE.Material, name?: string) {
    const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.translate(0, 0, z0);
    return add(geo, material, 0, 0, 0, name);
  }

  /** A rough stone: a squashed, jittered icosahedron. */
  function stone(size: number, x: number, y: number, z: number, squash = 0.7) {
    const geo = new THREE.IcosahedronGeometry(size, 0);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i, p.getX(i) * (0.85 + rnd() * 0.3), p.getY(i) * squash, p.getZ(i) * (0.85 + rnd() * 0.3));
    }
    geo.computeVertexNormals();
    const m = add(geo, pick(materials.stones), x, y, z, 'stone');
    m.rotation.y = rnd() * Math.PI;
    return m;
  }

  /** A post from `top` down to 1.5 below the origin (it disappears into the snow). */
  const post = (x: number, z: number, top: number, r = 0.1) =>
    add(new THREE.CylinderGeometry(r, r * 1.1, top + 1.5, 6), pick(materials.barks), x, (top - 1.5) / 2, z, 'post');

  // ---------- dimensions ----------
  const R = 0.17; // log radius
  const STEP = 2 * R * 0.92;
  const A = 1.6; // centre to side walls
  const zb = -1.6; // back wall
  const zf = 1.2; // front wall
  const zp = 2.5; // front of the porch
  const ext = 0.3; // log ends past the corners
  const n = 8; // wall courses
  const s = 0.72; // roof rise per run
  const ov = 0.55; // roof overhang at the eaves
  const base = 0.38; // top of the stone plinth = floor and deck level

  // ---------- stone plinth ----------
  // A dark core block down into the ground, faced with a ring of stones.
  box(2 * A + 0.3, base + 1.5, zf - zb + 0.3, materials.stones[1], 0, (base - 1.5) / 2, (zb + zf) / 2, 'plinth');
  for (let x = -A; x <= A + 0.01; x += 0.55) {
    for (const z of [zb, zf]) stone(0.28 + rnd() * 0.08, x + (rnd() - 0.5) * 0.12, base * 0.45, z + (z > 0 ? 0.08 : -0.08));
  }
  for (let z = zb + 0.5; z < zf - 0.2; z += 0.55) {
    for (const x of [-A, A]) stone(0.28 + rnd() * 0.08, x + (x > 0 ? 0.08 : -0.08), base * 0.45, z + (rnd() - 0.5) * 0.12);
  }

  // ---------- walls ----------
  const ys = (i: number) => base + R + i * STEP; // side-wall courses
  const yf = (i: number) => ys(i) + STEP / 2; // front/back courses interlock half a log higher
  for (let i = 0; i < n; i++) {
    for (const sx of [-A, A]) log(zf - zb + 2 * ext, 'z', sx, ys(i), (zb + zf) / 2);
  }
  for (let i = 0; i < n - 1; i++) {
    for (const sz of [zb, zf]) log(2 * A + 2 * ext, 'x', 0, yf(i), sz);
  }

  // ---------- roof ----------
  const cos = Math.cos(Math.atan(s));
  const Y0 = ys(n - 1) + R / cos;
  const under = (x: number) => Y0 + s * (A - Math.abs(x));
  const tp = 0.12 / cos;
  const T = 0.3 / cos;
  const top = (x: number) => under(x) + tp;

  // Gable logs up to the roof line.
  for (let i = n - 1; ; i++) {
    const y = yf(i);
    if (y - R > under(0) - 0.15) break;
    const half = Math.min(A + ext, A - (y - R - Y0) / s - 0.02);
    for (const sz of [zb, zf]) log(2 * half, 'x', 0, y, sz);
  }

  const run = A + ov;
  const rz0 = zb - 0.5;
  const rz1 = zp + 0.25;
  const D = rz1 - rz0;
  // Dark roof boards with a warm, lit underside.
  prism([[-run, under(run)], [0, under(0)], [run, under(run)], [run, under(run) + 0.03], [0, under(0) + 0.03], [-run, under(run) + 0.03]],
    rz0, D, materials.roofUnderside, 'roofUnderside');
  prism([[-run, under(run) + 0.03], [0, under(0) + 0.03], [run, under(run) + 0.03], [run, top(run)], [0, top(0)], [-run, top(run)]],
    rz0, D, materials.roof, 'roof');
  // Barge boards along the gable ends.
  for (const z of [rz0, rz1 - 0.08]) {
    prism([[-run - 0.05, under(run) - 0.06], [0, under(0) - 0.06], [run + 0.05, under(run) - 0.06], [run + 0.05, top(run) + 0.02], [0, top(0) + 0.02], [-run - 0.05, top(run) + 0.02]],
      z, 0.08, materials.frame, 'bargeBoard');
  }
  if (snowOnRoof) {
    const e = run + 0.1;
    const lip = 0.12;
    prism(
      [
        [-e, top(e) - lip], [-run, top(run)], [0, top(0)], [run, top(run)], [e, top(e) - lip],
        [e, top(e) + T * 0.7], [0, top(0) + T], [-e, top(e) + T * 0.7],
      ],
      rz0 - 0.05, D + 0.1, materials.snow, 'roofSnow',
    );
  }
  // Ridge beam sticking out at the front gable.
  const ridgeY = under(0) - 0.12;
  log(D + 0.3, 'z', 0, ridgeY, (rz0 + rz1) / 2 + 0.1, 0.13);

  // ---------- porch ----------
  const pw = 0.36;
  for (let x = -A - 0.2, k = 0; x < A + 0.2 - 0.01; x += pw, k++) {
    const w = Math.min(pw - 0.03, A + 0.2 - x);
    box(w, 0.08, zp - zf - R, materials.deck[k % 2], x + w / 2, base - 0.04, (zf + R + zp) / 2, 'deck');
  }
  for (const sx of [-A, A]) {
    post(sx, zp - 0.12, under(A) - 0.05, 0.13); // porch posts up to the eaves
    log(zp - zf + 0.2, 'z', sx, under(A) - 0.12, (zf + zp) / 2, 0.12); // beam from wall to post
  }
  // Two plank steps down to the snow, each on a stone block reaching into
  // the ground (so they meet the snow on a slope too).
  for (const [i, dz] of [[1, 0.32], [2, 0.64]] as const) {
    const h = base - i * 0.14;
    box(1.5, 0.08, 0.3, materials.deck[i % 2], -0.55, h - 0.04, zp + dz - 0.16, 'step');
    box(1.3, h + 1.42, 0.26, materials.stones[i % 3], -0.55, (h - 0.08 - 1.5) / 2, zp + dz - 0.16, 'stepStone');
  }

  // ---------- door, windows, wall lamp ----------
  const fz = zf + R + 0.02;
  const dx = -0.55;
  const dh = 1.95;
  box(0.95, dh + 0.1, 0.06, materials.frame, dx, base + (dh + 0.1) / 2, fz, 'doorFrame');
  box(0.75, dh - 0.12, 0.08, materials.glass, dx, base + dh / 2, fz + 0.01, 'window'); // all-glass sauna door
  box(0.05, 0.3, 0.12, materials.metal, dx + 0.28, base + 1.0, fz + 0.05, 'handle');
  const wx = 0.75;
  box(1.15, 1.25, 0.06, materials.frame, wx, base + 1.3, fz, 'windowFrame');
  box(0.95, 1.05, 0.08, materials.glass, wx, base + 1.3, fz + 0.01, 'window');
  box(0.05, 1.05, 0.1, materials.frame, wx, base + 1.3, fz + 0.02, 'windowFrame');
  // Lamp by the door.
  box(0.14, 0.2, 0.1, materials.metal, dx - 0.65, base + 1.85, fz + 0.04, 'wallLamp');
  box(0.1, 0.14, 0.1, materials.lantern, dx - 0.65, base + 1.85, fz + 0.08, 'wallLampGlow');
  // Small windows on both sides.
  for (const sx of [-1, 1]) {
    const x = sx * (A + R + 0.02);
    box(0.06, 0.7, 0.95, materials.frame, x, base + 1.6, -0.3, 'windowFrame');
    box(0.08, 0.52, 0.77, materials.glass, x + sx * 0.01, base + 1.6, -0.3, 'window');
  }

  // Bench under the window with folded towels.
  const benchZ = zf + R + 0.3;
  box(1.1, 0.08, 0.36, materials.deck[0], wx, base + 0.45, benchZ, 'bench');
  for (const lx of [wx - 0.42, wx + 0.42]) box(0.08, 0.45, 0.32, materials.deck[1], lx, base + 0.22, benchZ, 'bench');
  box(0.42, 0.1, 0.28, materials.towel, wx + 0.15, base + 0.54, benchZ, 'towel');
  box(0.38, 0.09, 0.26, materials.towel, wx + 0.17, base + 0.635, benchZ, 'towel');

  // ---------- stone chimney ----------
  const chX = -0.75;
  const chZ = -0.6;
  const chTop = top(chX) + T + 0.7;
  const chBot = under(chX) - 0.1;
  for (let y = chBot, k = 0; y < chTop; y += 0.22, k++) {
    const w = 0.56 + (rnd() - 0.5) * 0.06;
    const layer = box(w, 0.23, w, pick(materials.stones), chX + (rnd() - 0.5) * 0.04, y + 0.11, chZ + (rnd() - 0.5) * 0.04, 'chimney');
    layer.rotation.y = (rnd() - 0.5) * 0.1;
  }
  box(0.66, 0.08, 0.66, materials.stones[0], chX, chTop + 0.04, chZ, 'chimneyCap');
  box(0.6, 0.12, 0.6, materials.snow, chX, chTop + 0.13, chZ, 'chimneySnow');
  const smokeAnchor = new THREE.Object3D();
  smokeAnchor.name = 'smokeAnchor';
  smokeAnchor.position.set(chX, chTop + 0.2, chZ);
  group.add(smokeAnchor);

  // ---------- side deck and hot tub ----------
  const sx0 = A + 0.2;
  const sx1 = A + 3.6;
  const sz0 = -1.1;
  const sz1 = zp;
  for (let z = sz0, k = 0; z < sz1 - 0.01; z += pw, k++) {
    const w = Math.min(pw - 0.03, sz1 - z);
    box(sx1 - sx0, 0.08, w, materials.deck[k % 2], (sx0 + sx1) / 2, base - 0.12, z + w / 2, 'deck');
  }
  for (const [x, z] of [[sx1 - 0.1, sz0 + 0.1], [sx1 - 0.1, sz1 - 0.1], [(sx0 + sx1) / 2, sz1 - 0.1]]) post(x, z, base - 0.16, 0.09);
  // Snow drifted onto the outer edge of the deck.
  box(0.5, 0.08, sz1 - sz0 - 0.3, materials.snow, sx1 - 0.3, base - 0.04, (sz0 + sz1) / 2, 'deckSnow');

  const tubX = A + 1.9;
  const tubZ = 0.55;
  const tubH = 0.95;
  const tubFloor = base - 0.08;
  if (hotTub) {
    const staves = new THREE.CylinderGeometry(0.95, 0.88, tubH, 14, 1, true);
    const tub = add(staves, materials.tub, tubX, tubFloor + tubH / 2, tubZ, 'hotTub');
    (tub.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    for (const by of [0.2, 0.75]) {
      add(new THREE.CylinderGeometry(0.88 + 0.07 * by + 0.02, 0.88 + 0.07 * by + 0.02, 0.06, 14, 1, true), materials.metal, tubX, tubFloor + by * tubH, tubZ, 'tubBand');
    }
    // Rim: a flat wooden ring (lathed rectangle), open in the middle so the water shows.
    const rimProfile = [[0.86, -0.035], [0.98, -0.035], [0.98, 0.035], [0.86, 0.035], [0.86, -0.035]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    add(new THREE.LatheGeometry(rimProfile, 14), materials.tub, tubX, tubFloor + tubH, tubZ, 'tubRim');
    // Water filled to just under the rim (lower, and the reflection is mostly the
    // tub's own inner wall), wide enough to meet the staves.
    add(new THREE.CylinderGeometry(0.93, 0.93, 0.08, 14), materials.water, tubX, tubFloor + tubH - 0.08, tubZ, 'water');
    // Stove chimney of the wood-fired tub.
    add(new THREE.CylinderGeometry(0.07, 0.07, 1.3, 6), materials.metal, tubX + 0.75, tubFloor + tubH + 0.35, tubZ - 0.6, 'tubStovePipe');
    // Steps up to the rim.
    box(0.6, 0.35, 0.4, materials.deck[1], tubX - 0.95, tubFloor + 0.17, tubZ + 0.75, 'tubStep');
    const steamAnchor = new THREE.Object3D();
    steamAnchor.name = 'steamAnchor';
    steamAnchor.position.set(tubX, tubFloor + tubH + 0.05, tubZ);
    group.add(steamAnchor);
  }

  // ---------- lanterns and firewood ----------
  function lantern(x: number, y: number, z: number) {
    box(0.24, 0.04, 0.24, materials.metal, x, y + 0.02, z, 'lantern');
    box(0.17, 0.26, 0.17, materials.lantern, x, y + 0.17, z, 'lanternGlow');
    for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(0.03, 0.26, 0.03, materials.metal, x + cx * 0.095, y + 0.17, z + cz * 0.095, 'lantern');
    const cap = add(new THREE.ConeGeometry(0.17, 0.12, 4), materials.metal, x, y + 0.36, z, 'lantern');
    cap.rotation.y = Math.PI / 4;
    add(new THREE.TorusGeometry(0.05, 0.012, 4, 8), materials.metal, x, y + 0.45, z, 'lantern');
  }
  lantern(0.45, base - 0.28, zp + 0.5); // on the snow beside the steps
  lantern(sx1 - 0.35, base - 0.08, sz1 - 0.35); // corner of the tub deck
  lantern(-A - 0.05, base, zp - 0.3); // porch corner

  // Bucket of firewood by the steps.
  const bx = -1.75, bz = zp + 0.55, by = base - 0.42;
  add(new THREE.CylinderGeometry(0.3, 0.25, 0.4, 10), materials.tub, bx, by + 0.2, bz, 'woodBucket');
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rnd();
    const r = i === 0 ? 0 : 0.14;
    const geo = new THREE.CylinderGeometry(0.06, 0.06, 0.36, 6);
    const m = add(geo, [pick(materials.barks), materials.cut, materials.cut], bx + Math.cos(a) * r, by + 0.42 + rnd() * 0.06, bz + Math.sin(a) * r, 'firewood');
    m.rotation.set((rnd() - 0.5) * 0.4, rnd(), (rnd() - 0.5) * 0.4);
  }

  // A few boulders around the hut, half in the snow.
  for (const [x, z, sz] of [[-A - 0.7, zb + 0.4, 0.5], [-A - 0.5, 0.6, 0.35], [A + 0.4, zb - 0.5, 0.42]] as const) {
    stone(sz, x, base - 0.5, z, 0.8);
  }

  const lightAnchor = new THREE.Object3D();
  lightAnchor.name = 'lightAnchor';
  lightAnchor.position.set(0.2, base + 1.6, zp + 0.6);
  group.add(lightAnchor);

  group.userData.materials = materials;
  group.userData.dispose = () => {
    group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    const all = [
      ...materials.barks, ...materials.deck, ...materials.stones,
      materials.cut, materials.roof, materials.roofUnderside, materials.snow, materials.glass,
      materials.frame, materials.metal, materials.tub, materials.water, materials.lantern, materials.towel,
    ];
    all.forEach((m) => m.dispose());
  };

  return group;
}

/** Footprint of the room and decks in the sauna's own space, for grounding and clearing trees. */
export const SAUNA_FOOTPRINT = { minX: -2.0, maxX: 5.3, minZ: -2.2, maxZ: 3.3 };
/** Corners of the room itself (stone plinth), for grounding. */
export const SAUNA_ROOM = { minX: -1.75, maxX: 1.75, minZ: -1.75, maxZ: 1.35 };
