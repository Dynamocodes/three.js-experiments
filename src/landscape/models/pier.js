import * as THREE from 'three';

/**
 * Low-poly Nordic pier: a floating pontoon with a swim ladder and cleats,
 * a hinged gangway with an X-braced railing, a landing on posts, and a short
 * flight of steps up the shore.
 *
 * Usage:
 *   import { createPier } from './pier.js';
 *   const pier = createPier();          // THREE.Group, y = 0 is the water level
 *   pier.position.set(x, WATER_LEVEL, z);
 *   scene.add(pier);
 *
 *   // in your frame loop: the pontoon bobs and the gangway follows on its hinge
 *   pier.userData.update(elapsedSeconds);
 *
 *   // seasons: show or hide all snow
 *   pier.userData.setSnow(false);
 *
 * Orientation: the pontoon is centred on the origin with its long side along X.
 * The shore is towards -Z: the landing and steps sit there, at a height you
 * choose with `landingHeight`.
 */

export const DEFAULT_PIER_COLORS = {
  deck: ['#d8bf8a', '#cfb47d', '#dcc595'], // fresh pine, picked per plank
  frame: '#c9ad73',
  float: '#d6d9dc', // concrete pontoon float
  post: '#3a3b42',
  stairs: '#7c7f87',
  metal: '#c9ced6', // stainless ladder
  cleat: '#9aa0a8',
  snow: '#f4f6fc',
};

export function createPier(options = {}) {
  const {
    seed = 21,
    colors: colorOverrides = {},
    pontoonLength = 6, // along X
    pontoonWidth = 2.6, // along Z
    freeboard = 0.36, // pontoon deck height above water
    gangwayLength = 3.4,
    gangwayWidth = 1.1,
    gangwayOffsetX = 1.9, // where along the pontoon the gangway lands
    landingHeight = 1.0, // landing deck height above water
    landingSize = [1.7, 1.5], // [x, z]
    postDepth = 1.4, // how far landing posts go below the water line
    steps = 5,
    ladder = true,
    snow = true,
    castShadow = true,
    receiveShadow = true,
  } = options;

  const colors = { ...DEFAULT_PIER_COLORS, ...colorOverrides };
  let state = Math.max(1, Math.floor(seed)) % 2147483647;
  const rnd = () => (state = (state * 16807) % 2147483647) / 2147483647;

  const mat = (c, extra = {}) =>
    new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.9, ...extra });
  const materials = {
    deck: colors.deck.map((c) => mat(c)),
    frame: mat(colors.frame),
    float: mat(colors.float),
    post: mat(colors.post),
    stairs: mat(colors.stairs),
    metal: mat(colors.metal, { roughness: 0.3, metalness: 0.7 }),
    cleat: mat(colors.cleat, { roughness: 0.4, metalness: 0.5 }),
    snow: mat(colors.snow, { roughness: 0.8 }),
  };

  const root = new THREE.Group();
  root.name = 'pier';
  const snowMeshes = [];

  const mesh = (parent, geo, material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = castShadow;
    m.receiveShadow = receiveShadow;
    parent.add(m);
    return m;
  };
  const box = (parent, w, h, d, material, x, y, z) =>
    mesh(parent, new THREE.BoxGeometry(w, h, d), material, x, y, z);
  const snowBox = (parent, w, d, x, y, z, h = 0.04) => {
    const m = box(parent, w, h, d, materials.snow, x, y + h / 2, z);
    m.name = 'snow';
    snowMeshes.push(m);
    return m;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  /** A row of deck planks: `count` boards across `span`, each `len` long. */
  function planks(parent, { along, span, len, topY, center = [0, 0], thickness = 0.05, width = 0.15, gap = 0.014 }) {
    const n = Math.floor((span + gap) / (width + gap));
    const used = n * (width + gap) - gap;
    for (let i = 0; i < n; i++) {
      const offset = -used / 2 + width / 2 + i * (width + gap);
      const lenJ = len * (1 - rnd() * 0.01);
      if (along === 'z') {
        // planks run along Z, laid side by side across X
        box(parent, width, thickness, lenJ, pick(materials.deck), center[0] + offset, topY - thickness / 2, center[1]);
      } else {
        box(parent, lenJ, thickness, width, pick(materials.deck), center[0], topY - thickness / 2, center[1] + offset);
      }
    }
  }

  /** A railing along a straight run: posts, top and bottom rails, X braces. */
  function railing(parent, { from, to, baseY, height = 0.95, panels = 2, snowOnTop = false }) {
    const [x0, z0] = from;
    const [x1, z1] = to;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz); // local +Z along the run
    const g = new THREE.Group();
    g.position.set(x0, baseY, z0);
    g.rotation.y = yaw;
    parent.add(g);
    const post = 0.09;
    const railH = 0.09;
    const bottomY = 0.16;
    const topY = height - railH / 2;
    for (let i = 0; i <= panels; i++) {
      box(g, post, height, post, materials.frame, 0, height / 2, (i / panels) * len);
    }
    box(g, 0.1, railH, len + 0.1, materials.frame, 0, topY, len / 2);
    box(g, 0.06, 0.07, len, materials.frame, 0, bottomY, len / 2);
    if (snowOnTop) snowBox(g, 0.1, len + 0.1, 0, topY + railH / 2, len / 2, 0.035);
    // X braces inside each panel
    const pw = len / panels;
    const h = topY - bottomY;
    const diag = Math.hypot(pw, h);
    const ang = Math.atan2(h, pw);
    for (let i = 0; i < panels; i++) {
      for (const sgn of [1, -1]) {
        const b = box(g, 0.05, 0.07, diag - 0.08, materials.frame, 0, (bottomY + topY) / 2, (i + 0.5) * pw);
        b.rotation.x = sgn * ang;
      }
    }
    return g;
  }

  // ======================= PONTOON (floats, bobs) =======================
  const pontoon = new THREE.Group();
  pontoon.name = 'pontoon';
  root.add(pontoon);
  const L = pontoonLength;
  const W = pontoonWidth;
  const top = freeboard;

  // Concrete float under the deck.
  box(pontoon, L - 0.3, 0.55, W - 0.3, materials.float, 0, -0.18, 0);
  // Two stacked fascia boards around the edge, the lower one stepped in a touch.
  const fascia = [
    { y: top - 0.11, h: 0.17, inset: 0 },
    { y: top - 0.29, h: 0.17, inset: 0.02 },
  ];
  for (const { y, h, inset } of fascia) {
    const t = 0.08;
    box(pontoon, L - 2 * inset, h, t, materials.frame, 0, y, W / 2 - t / 2 - inset);
    box(pontoon, L - 2 * inset, h, t, materials.frame, 0, y, -W / 2 + t / 2 + inset);
    box(pontoon, t, h, W - 2 * inset - 2 * t, materials.frame, L / 2 - t / 2 - inset, y, 0);
    box(pontoon, t, h, W - 2 * inset - 2 * t, materials.frame, -L / 2 + t / 2 + inset, y, 0);
  }
  // Deck boards across the width.
  planks(pontoon, { along: 'z', span: L - 0.04, len: W - 0.04, topY: top + 0.01 });
  // Cleats along both long edges.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * (L / 2 - 0.35);
      const cz = sz * (W / 2 - 0.12);
      box(pontoon, 0.08, 0.05, 0.05, materials.cleat, cx, top + 0.035, cz);
      box(pontoon, 0.24, 0.035, 0.05, materials.cleat, cx, top + 0.075, cz);
    }
  }
  if (snow) snowBox(pontoon, L - 0.25, W - 0.25, 0, top + 0.01, 0);

  // Stainless swim ladder over the front edge.
  if (ladder) {
    const lx = -L / 2 + 0.95;
    const edge = W / 2;
    for (const dx of [-0.22, 0.22]) {
      // Foot on the deck, a rounded arch over the edge, then straight down into the water.
      const curve = new THREE.CatmullRomCurve3(
        [
          [edge - 0.38, top + 0.01],
          [edge - 0.37, top + 0.42],
          [edge - 0.32, top + 0.7],
          [edge - 0.2, top + 0.84],
          [edge - 0.04, top + 0.87],
          [edge + 0.09, top + 0.77],
          [edge + 0.15, top + 0.52],
          [edge + 0.16, top + 0.1],
          [edge + 0.16, -0.9],
        ].map(([z, y]) => new THREE.Vector3(lx + dx, y, z)),
        false,
        'centripetal',
      );
      mesh(pontoon, new THREE.TubeGeometry(curve, 28, 0.025, 5, false), materials.metal);
    }
    for (const y of [0.05, -0.27, -0.59]) box(pontoon, 0.44, 0.03, 0.13, materials.metal, lx, y, edge + 0.16);
  }

  // ======================= LANDING (fixed to the shore) =======================
  const landing = new THREE.Group();
  landing.name = 'landing';
  root.add(landing);
  const gx = gangwayOffsetX;
  const restZ = -W / 2 + 0.45; // where the gangway's wheels rest on the pontoon
  const restY = top + 0.01 + 0.2; // pontoon deck + roller/stringer depth
  const horiz = Math.sqrt(Math.max(0.01, gangwayLength ** 2 - (landingHeight - restY) ** 2));
  const hingeZ = restZ - horiz;
  const [lw, ld] = landingSize;
  const lz0 = hingeZ - ld; // back edge of the landing

  for (const px of [gx - lw / 2 + 0.12, gx + lw / 2 - 0.12]) {
    for (const pz of [hingeZ - 0.12, lz0 + 0.12]) {
      const h = landingHeight + postDepth;
      mesh(landing, new THREE.CylinderGeometry(0.1, 0.1, h, 6), materials.post, px, landingHeight - 0.08 - h / 2, pz);
    }
  }
  box(landing, lw, 0.16, 0.08, materials.frame, gx, landingHeight - 0.12, hingeZ - 0.04);
  box(landing, lw, 0.16, 0.08, materials.frame, gx, landingHeight - 0.12, lz0 + 0.04);
  box(landing, 0.08, 0.16, ld, materials.frame, gx - lw / 2 + 0.04, landingHeight - 0.12, hingeZ - ld / 2);
  box(landing, 0.08, 0.16, ld, materials.frame, gx + lw / 2 - 0.04, landingHeight - 0.12, hingeZ - ld / 2);
  planks(landing, { along: 'x', span: ld, len: lw, topY: landingHeight, center: [gx, hingeZ - ld / 2] });
  if (snow) snowBox(landing, lw - 0.15, ld - 0.15, gx, landingHeight, hingeZ - ld / 2);
  railing(landing, { from: [gx + lw / 2 - 0.05, lz0 + 0.05], to: [gx + lw / 2 - 0.05, hingeZ], baseY: landingHeight, panels: 1, snowOnTop: snow });

  // Steps up the shore from the back of the landing.
  const run = 0.3;
  const rise = 0.18;
  const sw = 1.0;
  const sx0 = gx - lw / 2 + sw / 2 + 0.1;
  for (let i = 0; i < steps; i++) {
    const y = landingHeight + (i + 1) * rise;
    const z = lz0 - (i + 0.5) * run;
    box(landing, sw, 0.05, run + 0.02, materials.stairs, sx0, y - 0.025, z);
    if (snow) snowBox(landing, sw - 0.1, run - 0.06, sx0, y, z, 0.035);
  }
  if (steps > 0) {
    const sLen = Math.hypot(steps * run, steps * rise) + 0.2;
    const sAng = Math.atan2(steps * rise, steps * run);
    for (const dx of [-sw / 2, sw / 2]) {
      const s = box(landing, 0.06, 0.18, sLen, materials.stairs, sx0 + dx, landingHeight + (steps * rise) / 2 - 0.05, lz0 - (steps * run) / 2);
      s.rotation.x = sAng;
    }
  }

  // ======================= GANGWAY (hinged at the landing) =======================
  const gangway = new THREE.Group();
  gangway.name = 'gangway';
  gangway.position.set(gx, landingHeight, hingeZ);
  root.add(gangway);
  const GL = gangwayLength;
  const GW = gangwayWidth;
  for (const sxg of [-1, 1]) box(gangway, 0.07, 0.18, GL, materials.frame, sxg * (GW / 2 - 0.035), -0.1, GL / 2);
  planks(gangway, { along: 'x', span: GL - 0.04, len: GW, topY: 0, center: [0, GL / 2] });
  if (snow) snowBox(gangway, GW - 0.15, GL - 0.2, 0, 0, GL / 2);
  // Roller at the pontoon end so it can slide as the pontoon moves.
  const roller = new THREE.CylinderGeometry(0.06, 0.06, GW - 0.1, 6);
  roller.rotateZ(Math.PI / 2);
  mesh(gangway, roller, materials.post, 0, -0.14, GL - 0.12);
  railing(gangway, { from: [GW / 2 - 0.05, 0.05], to: [GW / 2 - 0.05, GL - 0.05], baseY: 0, panels: 2, snowOnTop: snow });

  // Keeps the gangway resting on the pontoon wherever the pontoon is.
  const tmp = new THREE.Vector3();
  function fitGangway() {
    tmp.set(gx, restY, restZ); // rest point in pontoon space
    pontoon.localToWorld(tmp);
    root.worldToLocal(tmp);
    const dy = landingHeight - tmp.y;
    const dz = tmp.z - hingeZ;
    gangway.rotation.x = Math.atan2(dy, dz);
  }
  fitGangway();

  // ======================= API =======================
  root.userData.materials = materials;
  root.userData.parts = { pontoon, gangway, landing };
  /** Gentle bobbing. Call every frame with the elapsed time in seconds. */
  root.userData.update = (t, amplitude = 1) => {
    pontoon.position.y = Math.sin(t * 0.9) * 0.035 * amplitude;
    pontoon.rotation.z = Math.sin(t * 0.7) * 0.006 * amplitude;
    pontoon.rotation.x = Math.sin(t * 0.6 + 1.3) * 0.008 * amplitude;
    pontoon.updateMatrixWorld();
    root.updateMatrixWorld();
    fitGangway();
  };
  root.userData.setSnow = (visible) => snowMeshes.forEach((m) => (m.visible = visible));
  root.userData.dispose = () => {
    root.traverse((o) => o.isMesh && o.geometry.dispose());
    Object.values(materials).flat().forEach((m) => m.dispose());
  };

  return root;
}
