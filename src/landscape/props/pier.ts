import * as THREE from 'three';
import { createPier as buildPier } from '../models/pier';
import { LAKE } from '../world/terrain';
import { palette } from '../palette';
import type { Circle, Terrain } from '../types';

type AtFn = (origin: THREE.Vector3, s: number, lx: number) => THREE.Vector3;
type GroundFn = (v: THREE.Vector3) => number;

// Pier layout along its axis, measured from the pier's origin (the pontoon
// centre) toward the shore, i.e. along its local -Z. Matches the model's
// defaults: pontoon width 2.6, gangway 3.4, landing 1.7 x 1.5 at height 1.0,
// five steps of 0.3 run and 0.18 rise, stairs 1.0 wide.
const LANDING_HEIGHT = 1.0;
const LANDING_BACK = 5.72; // where the steps start
const LANDING_X = [1.05, 2.75]; // landing's sides, local x
const STAIRS = { x: 1.65, halfWidth: 0.5, run: 1.5, rise: 0.9 }; // 5 steps of 0.3 x 0.18
const TOP_STEP_BACK = LANDING_BACK + STAIRS.run;
// How far below the deck the snow may come at the landing's back edge.
const LANDING_CLEARANCE = 0.12;

/**
 * Places the pier on the lake shore and beds its stairs in the snow.
 *
 * Placement: walks from the lake toward the shore along the pier's axis until
 * the drawn ground under the landing's back edge comes just under the deck.
 * The landing then stands on its posts at the water's edge and the pontoon
 * floats. It uses the terrain's real triangles (surfaceAt), not the smooth
 * height formula: the mesh is coarse and the two differ a lot on the bank.
 *
 * Snowdrift: the stairs climb more steeply than the coarse terrain can, so a
 * low-poly snow bank fills the space under them: just under the treads, and
 * sloping into the ground on both sides and at the top.
 *
 * `x`    where along the shore (world x) the pier starts its search line.
 * `turn` how far the pier is turned from pointing straight away from the
 *        camera (radians, positive swings the lake end to the left).
 */
export interface PierPlacement {
  /** Where along the shore (world x) the pier starts its search line. */
  x: number;
  /** Turn from pointing straight away from the camera (radians, + swings the lake end left). */
  turn?: number;
  seed?: number;
}

export function placePier(terrain: Terrain, { x, turn = 0, seed = 21 }: PierPlacement) {
  const pier = buildPier({ seed, landingHeight: LANDING_HEIGHT, castShadow: false, receiveShadow: false });
  pier.userData.clickable = true;

  // Shore direction = the pier's local -Z in the world; side = its local +X.
  const yaw = Math.PI + turn;
  const shoreDir = new THREE.Vector3(Math.sin(turn), 0, Math.cos(turn));
  const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  // World point at distance s toward the shore and local x from an origin.
  const at: AtFn = (origin, s, lx) => origin.clone().addScaledVector(shoreDir, s).addScaledVector(side, lx);
  const ground: GroundFn = (v) => terrain.surfaceAt(v.x, v.z);

  // Walk until the ground under the landing's back corners reaches the deck.
  const origin = new THREE.Vector3(x, 0, LAKE.z).addScaledVector(shoreDir, -LANDING_BACK);
  for (let i = 0; i < 400; i++) {
    const g = Math.max(...LANDING_X.map((lx) => ground(at(origin, LANDING_BACK, lx))));
    if (g >= LANDING_HEIGHT - LANDING_CLEARANCE) break;
    origin.addScaledVector(shoreDir, 0.1);
  }
  pier.position.set(origin.x, LAKE.waterLevel, origin.z);
  pier.rotation.y = yaw;

  const group = new THREE.Group();
  group.name = 'pierRoot';
  group.add(pier, snowdrift(origin, at, ground));

  // Centre of the whole pier, for keeping trees and rocks away.
  const centre = origin.clone().addScaledVector(shoreDir, 3.5);

  return {
    object: group,
    model: pier,
    footprint: { x: centre.x, z: centre.z, r: 7 } satisfies Circle,
    update(time: number) { pier.userData.update(time); },
  };
}

/** Snow bank under the stairs, built as cross-sections from the landing up the bank. */
function snowdrift(origin: THREE.Vector3, at: AtFn, ground: GroundFn) {
  // The stairs' underside runs on a straight line from the landing's back
  // edge to the top step; stay a little under it so no tread is covered.
  const under = (s: number) => LANDING_HEIGHT + Math.min(1, Math.max(0, (s - LANDING_BACK) / STAIRS.run)) * STAIRS.rise - 0.06;
  // Across the stairs: foot, shoulder, shoulder, foot (local x offsets).
  const across = [-1.2, -STAIRS.halfWidth + 0.06, STAIRS.halfWidth - 0.06, 1.2];

  // Slices along the stairs. The first starts under the landing; the last
  // runs past the top step and drops into the ground to close the drift.
  const slices: THREE.Vector3[][] = [];
  const stations = [LANDING_BACK - 0.5, LANDING_BACK, LANDING_BACK + 0.5, LANDING_BACK + 1.0, TOP_STEP_BACK, TOP_STEP_BACK + 0.5, TOP_STEP_BACK + 1.1];
  stations.forEach((s, k) => {
    const end = k === 0 || k === stations.length - 1;
    slices.push(across.map((dx, j) => {
      const p = at(origin, s, STAIRS.x + dx);
      const g = ground(p);
      const foot = j === 0 || j === across.length - 1;
      // Feet and the closing ends sink below the ground; shoulders sit under the treads.
      p.y = foot || end ? g - 0.3 : Math.max(under(s), g);
      return p;
    }));
  });

  const positions: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => positions.push(...a.toArray(), ...b.toArray(), ...c.toArray(), ...a.toArray(), ...c.toArray(), ...d.toArray());
  for (let k = 0; k < slices.length - 1; k++) {
    const A = slices[k], B = slices[k + 1];
    for (let j = 0; j < across.length - 1; j++) quad(A[j], B[j], B[j + 1], A[j + 1]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: palette.snow,
    flatShading: true,
    roughness: 1,
    side: THREE.DoubleSide,
  }));
  mesh.name = 'pierSnowdrift';
  return mesh;
}
