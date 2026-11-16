import * as THREE from 'three';
import { palette } from '../palette';
import { createSauna, SAUNA_FOOTPRINT, SAUNA_ROOM } from '../models/sauna';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { createSmoke } from '../effects/smoke';
import { fitReflectionToMirror, skipNestedReflections } from '../world/water';
import type { Circle, Terrain } from '../types';

export interface SaunaPlacement {
  x: number;
  z: number;
  /** Rotation of the sauna (radians); its door faces local +Z. */
  facing: number;
  /** Mirror it, putting the hot tub deck on the left (seen from the front). */
  mirror?: boolean;
  seed?: number;
}

/**
 * Places the lakeside sauna: on its stone plinth at the highest ground under
 * the room (the plinth and deck posts reach down into the snow on the lower
 * side), windows and lanterns lit, smoke from the chimney and steam off the
 * hot tub.
 */
export function placeSauna(terrain: Terrain, { x, z, facing, mirror = false, seed = 11 }: SaunaPlacement) {
  const sauna = createSauna({ seed, castShadow: false, receiveShadow: false });

  const { glass } = sauna.userData.materials as { glass: THREE.MeshStandardMaterial };
  glass.color.set(palette.windowGlow);
  glass.emissive.set(palette.windowGlow);
  glass.emissiveIntensity = 1.4;

  const root = new THREE.Group();
  root.name = 'saunaRoot';
  root.userData.clickable = true;
  root.add(sauna);
  if (mirror) sauna.scale.x = -1; // three.js flips the face winding for us

  const cos = Math.cos(facing), sin = Math.sin(facing);
  const mx = mirror ? -1 : 1;
  const toWorld = (px: number, pz: number) => ({ x: x + mx * px * cos + pz * sin, z: z - mx * px * sin + pz * cos });
  const r = SAUNA_ROOM;
  const heights = [[r.minX, r.minZ], [r.maxX, r.minZ], [r.minX, r.maxZ], [r.maxX, r.maxZ], [0, 0]].map(([px, pz]) => {
    const p = toWorld(px, pz);
    return terrain.surfaceAt(p.x, p.z);
  });
  // Floor at the highest ground under the room, lowered a little so the deck
  // posts on the downhill side stay short; the uphill plinth stones sink into
  // the snow instead (the plinth is 0.38 tall).
  const high = Math.max(...heights);
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
  root.position.set(x, Math.max(high - 0.3, mean), z);
  root.rotation.y = facing;
  root.updateMatrixWorld(true);

  // Warm light from the door and window over the porch and the snow.
  const light = new THREE.PointLight(palette.windowGlow, 22, 16, 2);
  const lightAnchor = sauna.getObjectByName('lightAnchor');
  if (lightAnchor) light.position.copy(lightAnchor.position);
  sauna.add(light);

  // Hot tub water mirrors the sky and aurora: a small mirror disc on top of
  // the water, its reflection rendered for just the tub's patch of screen
  // (and only while the tub is on screen).
  const tubWater = sauna.getObjectByName('water') as THREE.Mesh<THREE.CylinderGeometry> | undefined;
  let tubMirror: Reflector | undefined;
  if (tubWater) {
    const { radiusTop, height, radialSegments } = tubWater.geometry.parameters;
    // thetaStart PI/2 lines the disc's corners up with the cylinder's.
    tubMirror = new Reflector(new THREE.CircleGeometry(radiusTop, radialSegments, Math.PI / 2), {
      color: 0x6f86a2,
      textureWidth: 512,
      textureHeight: 512,
      clipBias: 0.003,
      multisample: 4, // smooth edge where the rim meets its reflection
    });
    tubMirror.name = 'tubMirror';
    tubMirror.rotation.x = -Math.PI / 2;
    tubMirror.position.copy(tubWater.position);
    tubMirror.position.y += height / 2 + 0.002;
    fitReflectionToMirror(tubMirror);
    skipNestedReflections(tubMirror); // outermost: checked first
    sauna.add(tubMirror);
  }

  const smokeAnchor = sauna.getObjectByName('smokeAnchor');
  if (!smokeAnchor) throw new Error('sauna model has no smokeAnchor');
  const smoke = createSmoke(smokeAnchor, {
    strands: [
      { length: 9, width: 0.4, curl: 1.1, sway: 1.2, speed: 1.2, freq: 1.6, drift: 3.4, opacity: 0.7, seed: 1.3 },
      { length: 7, width: 0.28, curl: 0.9, sway: 0.9, speed: 1.4, freq: 1.9, drift: 2.8, opacity: 0.5, seed: 3.7 },
    ],
  });

  // Steam off the hot tub: short, wide, slow and faint.
  const steamAnchor = sauna.getObjectByName('steamAnchor');
  const steam = steamAnchor && createSmoke(steamAnchor, {
    color: '#dfe6f2',
    strands: [
      { length: 2.6, width: 0.7, curl: 0.5, sway: 0.5, speed: 0.6, freq: 2.2, drift: 0.8, opacity: 0.35, seed: 0.4 },
      { length: 2.0, width: 0.55, curl: 0.4, sway: 0.4, speed: 0.5, freq: 2.6, drift: 0.6, opacity: 0.28, seed: 2.9 },
      { length: 1.6, width: 0.5, curl: 0.3, sway: 0.35, speed: 0.7, freq: 3.0, drift: 0.5, opacity: 0.22, seed: 5.1 },
    ],
  });

  const object = new THREE.Group();
  object.name = 'saunaProp';
  object.add(root, smoke.object);
  if (steam) object.add(steam.object);

  // Area to keep clear of trees, around the hut and both decks.
  const f = SAUNA_FOOTPRINT;
  const centre = toWorld((f.minX + f.maxX) / 2, (f.minZ + f.maxZ) / 2);
  const clearing: Circle = { ...centre, r: Math.hypot(f.maxX - f.minX, f.maxZ - f.minZ) / 2 + 1.5 };

  return {
    object,
    /** The building itself (snowball target). */
    building: root,
    clearing,
    update(time: number) {
      smoke.update(time);
      steam?.update(time);
    },
    dispose() {
      tubMirror?.dispose();
    },
  };
}
