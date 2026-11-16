import * as THREE from 'three';

/**
 * Low-poly firewood stack (domed, end grain facing out) with an optional
 * chopping block and axe.
 *
 * Usage:
 *   import { createWoodpile } from './woodpile';
 *   const pile = createWoodpile();          // THREE.Group, origin at ground level
 *   pile.position.set(x, terrain.heightAt(x, z), z);
 *   scene.add(pile);
 *
 * Orientation: the pile runs along X, the pieces point along Z, and the
 * chopping block stands in front of it (+Z).
 *
 * Packing: split firewood is roughly triangular in section, so the pieces are
 * laid out on a triangle tiling (alternating point-up / point-down), which
 * fills the face with no holes. Each piece is then slightly oversized, rotated
 * and nudged so the stack looks hand-built rather than machined. All pieces
 * share one InstancedMesh, so a big pile is a single draw call.
 */

export const DEFAULT_WOODPILE_COLORS = {
  split: '#b8926f', // split faces of each piece
  endGrain: '#e2bf93', // the visible cut ends
  core: '#4e3d30', // hidden filler inside the stack
  stumpBark: '#6f6b58',
  stumpTop: '#c9a77c',
  snow: '#f4f6fc',
  axeHandle: '#2b2d33',
  axeGrip: '#f08a24',
  axeHead: '#9aa0a8',
  chips: '#d9b88f',
};

export interface WoodpileOptions {
  seed?: number;
  colors?: Partial<typeof DEFAULT_WOODPILE_COLORS>;
  width?: number;
  height?: number;
  layers?: number;
  pieceLength?: number;
  pieceSize?: number;
  snowOnTop?: boolean;
  snowThickness?: number;
  choppingBlock?: boolean;
  chips?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

type Vec2 = [x: number, y: number];

interface Piece {
  variant: number;
  x: number;
  y: number;
  z: number;
  roll: number;
  sx: number;
  sy: number;
  sz: number;
  shade: number;
}

export function createWoodpile(options: WoodpileOptions = {}) {
  const {
    seed = 11,
    colors: colorOverrides = {},
    width = 3.2, // along X
    height = 1.45,
    layers = 2, // rows of pieces front to back
    pieceLength = 0.44,
    pieceSize = 0.25, // edge length of a piece's triangular section
    snowOnTop = true,
    snowThickness = 0.16,
    choppingBlock = true,
    chips = true,
    castShadow = true,
    receiveShadow = true,
  } = options;

  const colors = { ...DEFAULT_WOODPILE_COLORS, ...colorOverrides };
  let state = Math.max(1, Math.floor(seed)) % 2147483647;
  const rnd = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const jitter = (amount: number) => (rnd() - 0.5) * 2 * amount;

  const mat = (c: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.95, ...extra });
  const materials = {
    split: mat(colors.split),
    endGrain: mat(colors.endGrain),
    core: mat(colors.core),
    stumpBark: mat(colors.stumpBark),
    stumpTop: mat(colors.stumpTop),
    snow: mat(colors.snow, { roughness: 0.8 }),
    axeHandle: mat(colors.axeHandle),
    axeGrip: mat(colors.axeGrip),
    axeHead: mat(colors.axeHead, { roughness: 0.4, metalness: 0.5 }),
    chips: mat(colors.chips),
  };

  const group = new THREE.Group();
  group.name = 'woodpile';
  const shadow = <T extends THREE.Object3D>(m: T): T => {
    m.castShadow = castShadow;
    m.receiveShadow = receiveShadow;
    return m;
  };
  const extrude = (pts: Vec2[], depth: number, z0: number) => {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.translate(0, 0, z0);
    return geo;
  };

  // ---------- target silhouette ----------
  // A flattened dome: steep sides, broad rounded top.
  const hw = width / 2;
  const profile = (x: number) => {
    const t = Math.min(1, Math.abs(x) / hw);
    return height * Math.pow(Math.max(0, 1 - Math.pow(t, 2.4)), 0.55);
  };

  // ---------- triangle tiling ----------
  const a = pieceSize;
  const h = (a * Math.sqrt(3)) / 2; // row height
  const circumR = a / Math.sqrt(3); // cylinder radius for this triangle
  const layerSpacing = pieceLength * 1.02;

  // ---------- piece cross-sections ----------
  // Real split wood isn't a perfect triangle: one side is the curved bark,
  // corners get knocked off. A few variants, randomly rotated in 120° steps
  // (which keeps them fitting the tiling), break up the pattern.
  const tri: Vec2[] = [
    [0, -circumR],
    [circumR * Math.cos(Math.PI / 6), circumR * 0.5],
    [-circumR * Math.cos(Math.PI / 6), circumR * 0.5],
  ];
  const bulge = (p: Vec2, q: Vec2, amt: number): Vec2 => {
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    const len = Math.hypot(mx, my);
    return [mx + (mx / len) * amt * circumR, my + (my / len) * amt * circumR];
  };
  const clip = (prev: Vec2, v: Vec2, next: Vec2, t: number): Vec2[] => [
    [v[0] + (prev[0] - v[0]) * t, v[1] + (prev[1] - v[1]) * t],
    [v[0] + (next[0] - v[0]) * t, v[1] + (next[1] - v[1]) * t],
  ];
  const [B, Rr, L] = tri; // bottom, right, left (pointing down)
  const sections: Vec2[][] = [
    [B, Rr, L], // clean wedge
    [B, Rr, bulge(Rr, L, 0.22), L], // bark side on top
    [...clip(L, B, Rr, 0.28), Rr, L], // knocked-off point
    [B, ...clip(B, Rr, L, 0.22), bulge(Rr, L, 0.14), L, bulge(L, B, 0.16)], // irregular chunk
  ];
  const sectionPolys = sections;

  // Highest wood surface per x-bin, so the snow can rest on the real pile.
  const BINS = 48;
  const binMin = -hw - a;
  const binW = (width + 2 * a) / BINS;
  const envelope = new Float32Array(BINS + 1);
  const binX = (i: number) => binMin + i * binW;
  /** Raises the envelope with the top outline of a transformed polygon. */
  const raisePoly = (poly: Vec2[]) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const [x] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    const i0 = Math.max(0, Math.ceil((x0 - binMin) / binW));
    const i1 = Math.min(BINS, Math.floor((x1 - binMin) / binW));
    for (let i = i0; i <= i1; i++) {
      const x = binX(i);
      let top = -Infinity;
      for (let k = 0; k < poly.length; k++) {
        const [ax, ay] = poly[k];
        const [bx, by] = poly[(k + 1) % poly.length];
        if ((ax <= x && x <= bx) || (bx <= x && x <= ax)) {
          const t = bx === ax ? 0 : (x - ax) / (bx - ax);
          top = Math.max(top, ay + (by - ay) * t);
        }
      }
      if (top > envelope[i]) envelope[i] = top;
    }
  };

  const pieces: Piece[] = [];
  for (let layer = 0; layer < layers; layer++) {
    const zc = (layer - (layers - 1) / 2) * layerSpacing;
    const layerShift = layer * a * 0.37; // back layer doesn't line up with the front
    for (let row = 0; row * h < height; row++) {
      const yb = row * h;
      const rowShift = (row % 2) * (a / 2) + layerShift;
      for (let x = -hw - a + rowShift; x <= hw + a; x += a) {
        // Point-up triangle in this cell, then the point-down one beside it.
        for (const up of [true, false]) {
          const cx = up ? x : x + a / 2;
          const cy = yb + (up ? h / 3 : (2 * h) / 3);
          if (Math.abs(cx) > hw - a * 0.25) continue;
          // Keep the piece's highest point near the silhouette (no spikes on top).
          const apex = cy + (up ? (2 * h) / 3 : h / 3);
          if (apex > profile(cx) + h * 0.12) continue;

          const s = 1.06 + rnd() * 0.1; // slight oversize: neighbours overlap, no holes
          const p: Piece = {
            variant: Math.floor(rnd() * sections.length),
            x: cx + jitter(a * 0.05),
            y: cy + jitter(h * 0.05),
            z: zc + jitter(pieceLength * 0.09), // ends stick out by different amounts
            // 120° steps keep the triangle fitting its cell; plus a little wobble.
            roll: (up ? Math.PI : 0) + Math.floor(rnd() * 3) * ((2 * Math.PI) / 3) + jitter(0.12),
            sx: s * (1 + jitter(0.06)),
            sy: s * (1 + jitter(0.06)),
            sz: 1 + jitter(0.1),
            shade: 0.8 + rnd() * 0.32,
          };
          pieces.push(p);
          const c = Math.cos(p.roll);
          const sn = Math.sin(p.roll);
          raisePoly(
            sectionPolys[p.variant].map(([px, py]): Vec2 => {
              const X = px * p.sx;
              const Y = py * p.sy;
              return [p.x + X * c - Y * sn, p.y + X * sn + Y * c];
            }),
          );
        }
      }
    }
  }

  // One InstancedMesh per section variant (4 draw calls in total).
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  sections.forEach((pts, v) => {
    const list = pieces.filter((p) => p.variant === v);
    if (!list.length) return;
    // Extrude groups: 0 = the two end faces, 1 = the long sides.
    const geo = extrude(pts, pieceLength, -pieceLength / 2);
    const mesh = new THREE.InstancedMesh(geo, [materials.endGrain, materials.split], list.length);
    mesh.name = 'firewood';
    list.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, 0, p.roll);
      dummy.scale.set(p.sx, p.sy, p.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tint.setScalar(p.shade));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(shadow(mesh));
  });

  // The raw envelope is jagged (piece tips and the valleys between them).
  // A smoothed version is where the snow settles.
  const binsUsed = [];
  for (let i = 0; i <= BINS; i++) if (envelope[i] > 0) binsUsed.push(i);
  const smooth = envelope.slice();
  for (let pass = 0; pass < 3; pass++) {
    const prev = smooth.slice();
    for (let i = 1; i < BINS; i++) {
      if (prev[i] > 0) smooth[i] = (prev[i - 1] + prev[i] * 2 + prev[i + 1]) / 4;
    }
  }
  const depth = layers * layerSpacing;

  // ---------- hidden core ----------
  // Dark filler inside the stack, so any sliver between pieces shows wood, not sky.
  if (binsUsed.length > 4) {
    const inner = binsUsed.filter((i) => smooth[i] - h > 0.02 && Math.abs(binX(i)) < hw - a * 0.6);
    if (inner.length > 2) {
      const pts: Vec2[] = [[binX(inner[0]), 0]];
      for (const i of inner) pts.push([binX(i), smooth[i] - h]);
      pts.push([binX(inner[inner.length - 1]), 0]);
      const coreDepth = depth - pieceLength * 0.45;
      const core = new THREE.Mesh(extrude(pts, coreDepth, -coreDepth / 2), materials.core);
      core.name = 'woodpileCore';
      group.add(shadow(core));
    }
  }

  // ---------- snow cap, settled into the top of the wood ----------
  // The bottom sinks into the pile (hidden inside the wood); the top drapes
  // over the smoothed surface, so a few piece tips can poke through.
  // Snow only settles where the surface is gentle, so the steep ends of the
  // pile stay bare.
  const slopeAt = (i: number) => (smooth[Math.min(BINS, i + 1)] - smooth[Math.max(0, i - 1)]) / (2 * binW);
  const snowBins = binsUsed.filter((i) => Math.abs(slopeAt(i)) < 1.4);
  if (snowOnTop && snowBins.length > 2) {
    const bottom: Vec2[] = [];
    const top: Vec2[] = [];
    for (let k = 0; k < snowBins.length; k++) {
      const i = snowBins[k];
      const x = binX(i);
      const y = smooth[i];
      const slope = slopeAt(i);
      const flat = 1 / (1 + slope * slope); // thicker where it's flat
      const edge = k === 0 || k === snowBins.length - 1;
      bottom.push([x, y - h * 0.55]);
      top.push([x, edge ? y - h * 0.45 : y + 0.01 + snowThickness * flat * flat]);
    }
    const pts = [...bottom, ...top.reverse()];
    const cap = new THREE.Mesh(extrude(pts, depth + 0.02, -(depth + 0.02) / 2), materials.snow);
    cap.name = 'woodpileSnow';
    group.add(shadow(cap));
  }

  // ---------- chopping block and axe ----------
  if (choppingBlock) {
    const block = new THREE.Group();
    block.name = 'choppingBlock';
    const stumpH = 0.48;
    const stump = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.3, stumpH, 7),
      [materials.stumpBark, materials.stumpTop, materials.stumpTop],
    );
    stump.position.y = stumpH / 2;
    stump.rotation.y = rnd() * Math.PI;
    block.add(shadow(stump));

    // Axe stuck in the block. Handle runs along +X; the blade hangs below
    // the handle end and tapers to a sharp edge.
    const axe = new THREE.Group();
    axe.name = 'axe';
    const handleLen = 0.78;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(handleLen * 0.72, 0.045, 0.045), materials.axeHandle);
    handle.position.x = handleLen * 0.36;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(handleLen * 0.28, 0.055, 0.055), materials.axeGrip);
    grip.position.x = handleLen * 0.86;

    const bladeTop = 0.05;
    const bladeBottom = -0.17;
    const thickness = 0.07;
    const headGeo = extrude(
      [[-0.035, bladeTop], [0.035, bladeTop], [0.05, -0.1], [0.075, bladeBottom], [-0.085, bladeBottom], [-0.055, -0.1]],
      thickness,
      -thickness / 2,
    );
    // Taper: full thickness at the eye, almost nothing at the cutting edge.
    const hp = headGeo.attributes.position;
    for (let i = 0; i < hp.count; i++) {
      const t = (bladeTop - hp.getY(i)) / (bladeTop - bladeBottom);
      hp.setZ(i, hp.getZ(i) * (1 - 0.9 * t));
    }
    headGeo.computeVertexNormals();
    const head = new THREE.Mesh(headGeo, materials.axeHead);
    head.position.set(0.02, 0, 0);

    [handle, grip, head].forEach((m) => axe.add(shadow(m)));
    axe.position.set(-0.06, stumpH + 0.1, 0);
    axe.rotation.z = 0.55;
    block.add(axe);

    // Anchor for an interaction (e.g. click the axe to chop).
    const axeAnchor = new THREE.Object3D();
    axeAnchor.name = 'axeAnchor';
    axeAnchor.position.set(0, stumpH, 0);
    block.add(axeAnchor);

    block.position.set(width * 0.12, 0, depth / 2 + 0.75);
    group.add(block);

    if (chips) {
      for (let i = 0; i < 9; i++) {
        const chip = new THREE.Mesh(
          new THREE.BoxGeometry(0.06 + rnd() * 0.12, 0.02, 0.03 + rnd() * 0.05),
          materials.chips,
        );
        const ang = rnd() * Math.PI * 2;
        const r = 0.4 + rnd() * 0.6;
        chip.position.set(block.position.x + Math.cos(ang) * r, 0.01, block.position.z + Math.sin(ang) * r);
        chip.rotation.y = rnd() * Math.PI;
        chip.name = 'chip';
        group.add(shadow(chip));
      }
    }
  }

  group.userData.materials = materials;
  group.userData.pieceCount = pieces.length;
  group.userData.dispose = () => {
    group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    Object.values(materials).forEach((m) => m.dispose());
  };

  return group;
}
