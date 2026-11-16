import * as THREE from 'three';
import { createSnowman, type SnowmanApi, type SnowmanHat } from '../models/snowman';
import type { Terrain } from '../types';

export interface SnowmanPlacement {
  x: number;
  z: number;
  /** World point the snowman turns to face (e.g. the camera's resting spot). */
  lookAt: { x: number; z: number };
  /** Extra turn after facing `lookAt` (radians), for a slightly side-on pose. */
  turn?: number;
  seed?: number;
  hat?: SnowmanHat;
}

/**
 * Places a snowman on the drawn ground, facing a point. Hooks it up for
 * snowballs: anything in the scene with `userData.onSnowballHit` reacts when
 * hit (see interactions/snowballs.ts).
 */
export function placeSnowman(terrain: Terrain, { x, z, lookAt, turn = 0, seed = 2, hat = 'tophat' }: SnowmanPlacement) {
  const snowman = createSnowman({ seed, hat, castShadow: false, receiveShadow: false });
  const api = snowman.userData as SnowmanApi;
  // Sink a touch so the packed-snow ring at its base meets the slope.
  snowman.position.set(x, terrain.surfaceAt(x, z) - 0.04, z);
  // The model faces +Z.
  snowman.rotation.y = Math.atan2(lookAt.x - x, lookAt.z - z) + turn;
  snowman.userData.clickable = true;
  snowman.userData.onSnowballHit = (point: THREE.Vector3) => api.react(point);

  return {
    object: snowman,
    api,
    update(_time: number, dt: number) { api.update(dt); },
  };
}
