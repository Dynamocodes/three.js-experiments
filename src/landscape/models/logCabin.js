import * as THREE from 'three';

/**
 * Low-poly Lapland log cabin.
 *
 * Usage:
 *   import { createCabin } from './cabin.js';
 *   const cabin = createCabin();            // THREE.Group, origin at ground level
 *   cabin.position.set(x, terrain.heightAt(x, z), z);
 *   scene.add(cabin);
 *
 * Orientation: the porch faces +Z, the ridge runs along Z.
 * Footprint: about 5.7 (x) by 7.4 (z) units, ridge about 5.1 units high.
 *
 * Every option is optional. Pass the same `seed` to get the same log jitter.
 */

export const DEFAULT_COLORS = {
  bark: ['#9b9189', '#8b8179', '#a89f96'], // log sides, picked at random per log
  cut: '#dcb689', // log end grain
  roofUnderside: '#d9aa6c',
  deck: ['#8f7966', '#82705f'], // alternating porch planks
  snow: '#f4f6fc',
  glass: '#4a5363',
  door: '#5c6470',
  frame: '#c9955d',
  metal: '#2d3038', // chimney, ladder
};

export function createCabin(options = {}) {
  const {
    seed = 7,
    colors: colorOverrides = {},
    castShadow = true,
    receiveShadow = true,

    // Log size: R is the log radius, STEP the vertical spacing between courses.
    logRadius: R = 0.2,
    halfWidth: A = 2.4, // distance from centre to the side walls
    backZ: zb = -3, // back wall
    frontZ: zf = 1, // front wall of the enclosed room
    porchZ: zp = 2.9, // front of the porch
    cornerOverhang: ext = 0.42, // how far logs stick out past the corners
    courses: n = 8, // wall height in logs
    roofSlope: s = 0.78, // rise per unit run (~38 degrees)
    roofOverhang: ov = 0.8,
    porchGap = 0.95, // half-width of the porch entrance

    snowOnRoof = true,
    chimney = true,
    ladder = true,
  } = options;

  const STEP = 2 * R * 0.92;
  const colors = { ...DEFAULT_COLORS, ...colorOverrides };

  let state = Math.max(1, Math.floor(seed)) % 2147483647;
  const rnd = () => (state = (state * 16807) % 2147483647) / 2147483647;

  const mat = (c, extra = {}) =>
    new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.95, ...extra });
  const materials = {
    barks: colors.bark.map((c) => mat(c)),
    cut: mat(colors.cut),
    roofUnderside: mat(colors.roofUnderside),
    deck: colors.deck.map((c) => mat(c)),
    snow: mat(colors.snow, { roughness: 0.8 }),
    glass: mat(colors.glass, { roughness: 0.3 }),
    door: mat(colors.door),
    frame: mat(colors.frame),
    metal: mat(colors.metal),
  };

  const group = new THREE.Group();
  group.name = 'cabin';

  // ---------- helpers ----------
  function add(geo, material, x, y, z, name) {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = castShadow;
    m.receiveShadow = receiveShadow;
    if (name) m.name = name;
    group.add(m);
    return m;
  }

  /** A hexagonal log along the given axis, with end-grain caps. */
  function log(len, axis, x, y, z, r = R) {
    const geo = new THREE.CylinderGeometry(r * (0.9 + rnd() * 0.12), r, len, 6, 1);
    geo.rotateY(rnd() * Math.PI); // vary which facet faces up
    if (axis === 'x') geo.rotateZ(Math.PI / 2);
    if (axis === 'z') geo.rotateX(Math.PI / 2);
    const bark = materials.barks[Math.floor(rnd() * materials.barks.length)];
    return add(geo, [bark, materials.cut, materials.cut], x, y, z, 'log');
  }

  const box = (w, h, d, material, x, y, z, name) =>
    add(new THREE.BoxGeometry(w, h, d), material, x, y, z, name);

  /** Extrudes a 2D profile (in the XY plane) along +Z. */
  function prism(points, z0, depth, material, name) {
    const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.translate(0, 0, z0);
    return add(geo, material, 0, 0, 0, name);
  }

  const ys = (i) => R + i * STEP; // side-wall course heights
  const yf = (i) => ys(i) + STEP / 2; // front/back courses sit half a log higher (interlock)
  const porchCourses = [0, 1, 2];
  const eaveCourses = [n - 2, n - 1];

  // ---------- walls ----------
  // Side walls. The porch-rail courses and the two top courses run out past
  // the porch as single long logs, like a real log cabin.
  for (let i = 0; i < n; i++) {
    const long = porchCourses.includes(i) || eaveCourses.includes(i);
    const z0 = zb - ext;
    const z1 = long ? zp + ext : zf + ext;
    for (const sx of [-A, A]) log(z1 - z0, 'z', sx, ys(i), (z0 + z1) / 2);
  }
  // Front and back walls, interlocking with the side walls.
  for (let i = 0; i < n - 1; i++) {
    for (const sz of [zb, zf]) log(2 * A + 2 * ext, 'x', 0, yf(i), sz);
  }

  // ---------- roof geometry ----------
  const th = Math.atan(s);
  const cos = Math.cos(th);
  const ysTop = ys(n - 1);
  const Y0 = ysTop + R / cos; // roof underside rests tangent on the top side logs
  const under = (x) => Y0 + s * (A - Math.abs(x)); // roof underside height at x
  const tp = 0.13 / cos; // roof board thickness (vertical)
  const T = 0.36 / cos; // snow thickness (vertical)
  const top = (x) => under(x) + tp;

  // Gable logs: each runs until its bottom meets the roof line, so the ends
  // tuck into the roof thickness and leave no gaps under the slope.
  for (let i = n - 1; ; i++) {
    const y = yf(i);
    if (y - R > under(0) - 0.15) break;
    const half = Math.min(A + ext, A - (y - R - Y0) / s - 0.02);
    for (const sz of [zb, zf]) log(2 * half, 'x', 0, y, sz);
  }

  // Roof boards and snow: one continuous profile each, so no seam at the ridge.
  const run = A + ov;
  const rz0 = zb - 0.65;
  const rz1 = zp + ext + 0.12;
  const D = rz1 - rz0;
  prism(
    [[-run, under(run)], [0, under(0)], [run, under(run)], [run, top(run)], [0, top(0)], [-run, top(run)]],
    rz0, D, materials.roofUnderside, 'roof',
  );
  if (snowOnRoof) {
    const e = run + 0.14;
    const lip = 0.14;
    prism(
      [
        [-e, top(e) - lip], [-run, top(run)], [0, top(0)], [run, top(run)], [e, top(e) - lip],
        [e, top(e) + T * 0.75], [0, top(0) + T], [-e, top(e) + T * 0.75],
      ],
      rz0 - 0.06, D + 0.12, materials.snow, 'roofSnow',
    );
  }

  // Ridge beam and purlins, visible under the roof and sticking out at the gables.
  const rr = 0.17;
  const ridgeY = under(0) - rr / cos + 0.04;
  log(D + 0.35, 'z', 0, ridgeY, (rz0 + rz1) / 2, rr);
  for (const side of [-1, 1]) {
    log(D + 0.25, 'z', side * A * 0.55, under(A * 0.55) - 0.15 / cos + 0.03, (rz0 + rz1) / 2, 0.15);
  }

  // ---------- porch ----------
  const deckY = 0.34;
  const pw = 0.42;
  for (let x = -A + R, k = 0; x < A - R - 0.01; x += pw, k++) {
    const w = Math.min(pw - 0.03, A - R - x);
    box(
      w, 0.1, zp - R - zf - R,
      materials.deck[k % materials.deck.length],
      x + w / 2, deckY - 0.05, (zf + R + zp - R) / 2, 'deck',
    );
  }

  // Front rail logs on either side of the entrance.
  const railLen = A + ext - porchGap;
  for (const i of porchCourses) {
    log(railLen, 'x', -(porchGap + railLen / 2), yf(i), zp);
    log(railLen, 'x', porchGap + railLen / 2, yf(i), zp);
  }
  const railTop = yf(2) + R;
  for (const sx of [-1, 1]) {
    box(railLen, 0.14, 0.42, materials.snow, sx * (porchGap + railLen / 2), railTop + 0.04, zp, 'railSnow');
    box(0.42, 0.14, zp + ext - zf - R, materials.snow, sx * A, ys(2) + R + 0.04, (zf + R + zp + ext) / 2, 'railSnow');
  }

  // Lintel across the porch front, two posts, and the king post up to the ridge.
  const lintelY = yf(n - 2);
  const lintelR = 0.21;
  log(2 * A + 2 * ext, 'x', 0, lintelY, zp, lintelR);
  const postBot = railTop;
  const postTop = lintelY - 0.18;
  for (const sx of [-A, A]) {
    add(new THREE.CylinderGeometry(0.17, 0.19, postTop - postBot, 6), materials.barks[0], sx, (postBot + postTop) / 2, zp, 'post');
  }
  const kBot = lintelY + lintelR * 0.8;
  const kTop = ridgeY;
  add(new THREE.CylinderGeometry(0.2, 0.24, kTop - kBot, 6), materials.barks[2 % materials.barks.length], 0, (kTop + kBot) / 2, zp, 'kingPost');

  // ---------- door and windows ----------
  const fz = zf + R + 0.02;
  const dh = 1.85;
  box(1.0, dh + 0.1, 0.06, materials.frame, 0, deckY + (dh + 0.1) / 2, fz, 'doorFrame');
  box(0.82, dh - 0.02, 0.08, materials.door, 0, deckY + dh / 2, fz + 0.01, 'door');
  for (const wx of [-1.45, 1.45]) {
    box(1.0, 1.0, 0.06, materials.frame, wx, 1.8, fz, 'windowFrame');
    box(0.8, 0.8, 0.08, materials.glass, wx, 1.8, fz + 0.01, 'window');
    box(0.05, 0.8, 0.1, materials.frame, wx, 1.8, fz + 0.02, 'windowFrame');
  }
  const sxw = A + R + 0.02;
  for (const wz of [-0.6, -2.1]) {
    box(0.06, 1.0, 0.9, materials.frame, sxw, 1.8, wz, 'windowFrame');
    box(0.08, 0.8, 0.7, materials.glass, sxw + 0.01, 1.8, wz, 'window');
  }

  // ---------- chimney ----------
  if (chimney) {
    const chX = 1.25;
    const chZ = -1.7;
    const chBot = under(chX);
    const chTop = top(chX) + T + 0.85;
    const stack = box(0.4, chTop - chBot, 0.4, materials.metal, chX, (chBot + chTop) / 2, chZ, 'chimney');
    box(0.56, 0.16, 0.56, materials.snow, chX, chTop + 0.06, chZ, 'chimneySnow');
    // Handy anchor for a smoke particle effect.
    const smokeAnchor = new THREE.Object3D();
    smokeAnchor.name = 'smokeAnchor';
    smokeAnchor.position.set(chX, chTop + 0.15, chZ);
    group.add(smokeAnchor);
    void stack;
  }

  // ---------- ladder, on standoff brackets ----------
  if (ladder) {
    const wallX = A + R;
    const lx = wallX + 0.38;
    const lz = -0.15;
    const ladderTop = under(lx + 0.1) - 0.08;
    for (const dz of [-0.22, 0.22]) box(0.05, ladderTop, 0.05, materials.metal, lx, ladderTop / 2, lz + dz, 'ladder');
    for (let y = 0.4; y < ladderTop - 0.05; y += 0.38) box(0.05, 0.04, 0.44, materials.metal, lx, y, lz, 'ladder');
    for (const by of [0.9, ladderTop - 0.4]) {
      for (const dz of [-0.22, 0.22]) {
        const len = lx - wallX + 0.1;
        box(len, 0.05, 0.05, materials.metal, wallX - 0.1 + len / 2, by, lz + dz, 'ladderBracket');
      }
    }
  }

  // Useful anchors for interactions (e.g. snowball target, door animation).
  const doorAnchor = new THREE.Object3D();
  doorAnchor.name = 'doorAnchor';
  doorAnchor.position.set(0, deckY, fz);
  group.add(doorAnchor);

  group.userData.materials = materials;
  group.userData.dispose = () => {
    group.traverse((o) => o.isMesh && o.geometry.dispose());
    const all = [
      ...materials.barks, ...materials.deck,
      materials.cut, materials.roofUnderside, materials.snow, materials.glass,
      materials.door, materials.frame, materials.metal,
    ];
    all.forEach((m) => m.dispose());
  };

  return group;
}
