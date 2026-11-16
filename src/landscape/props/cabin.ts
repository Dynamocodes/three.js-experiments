import * as THREE from 'three';
import { palette } from '../palette';
import { createCabin as buildLogCabin } from '../models/logCabin';
import { createWoodpile } from '../models/woodpile';
import type { Terrain } from '../types';

type Point = [x: number, z: number];

// Footprint of the log cabin in its own space (porch faces +Z), used to sit
// it on the terrain. Includes the corner-log overhang.
const FOOTPRINT = { minX: -2.85, maxX: 2.85, minZ: -3.45, maxZ: 3.35 };

// Woodpile footprint in its own space: pile along X, block toward +Z.
const WOODPILE_EXTENT = { minX: -1.7, maxX: 1.7, minZ: -0.5, maxZ: 1.8 };

/** Lowest terrain height under a set of local (x, z) points of a placed object. */
function lowestGround(terrain: Terrain, x: number, z: number, facing: number, points: Point[]) {
  let ground = Infinity;
  const c = new THREE.Vector2();
  const o = new THREE.Vector2();
  for (const [px, pz] of points) {
    c.set(px, pz).rotateAround(o, -facing);
    ground = Math.min(ground, terrain.heightAt(x + c.x, z + c.y));
  }
  return ground;
}

const corners = (minX: number, maxX: number, minZ: number, maxZ: number): Point[] => [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]];

/**
 * Places the log cabin in the scene: on the terrain, turned to `facing`,
 * with the windows lit for night.
 */
export interface CabinPlacement {
  x: number;
  z: number;
  /** Rotation of the cabin (radians). */
  facing: number;
  seed?: number;
  /** Woodpile position and rotation relative to the cabin (default: off its front-right corner). */
  woodpile?: { x: number; z: number; facing: number };
}

export function placeCabin(terrain: Terrain, { x, z, facing, seed = 7, woodpile: W = { x: 4.6, z: 1.0, facing: 0 } }: CabinPlacement) {
  const cabin = buildLogCabin({ seed, castShadow: false, receiveShadow: false });

  // Night: the windows glow warm instead of reflecting a daytime sky.
  const { glass } = cabin.userData.materials;
  glass.color.set(palette.windowGlow);
  glass.emissive.set(palette.windowGlow);
  glass.emissiveIntensity = 1.4;

  // Warm light spilling out over the porch and the snow in front.
  const light = new THREE.PointLight(palette.windowGlow, 30, 22, 2);
  light.position.set(0, 1.9, 2.4);
  cabin.add(light);

  const root = new THREE.Group();
  root.name = 'cabinRoot';
  root.userData.clickable = true;
  root.add(cabin);

  // Sit on the lowest corner so nothing floats; the uphill side just tucks
  // into the snow.
  const F = FOOTPRINT;
  const ground = lowestGround(terrain, x, z, facing, corners(F.minX, F.maxX, F.minZ, F.maxZ));
  root.position.set(x, ground - 0.05, z);
  root.rotation.y = facing;

  // Woodpile: a sibling of the cabin model (so swapping the cabin for a GLB
  // keeps it), grounded on its own footprint.
  const woodpile = createWoodpile({ castShadow: false, receiveShadow: false });
  const e = WOODPILE_EXTENT;
  const cos = Math.cos(W.facing), sin = Math.sin(W.facing);
  // Footprint corners: pile space -> cabin space (rotation about Y).
  const footprint = corners(e.minX, e.maxX, e.minZ, e.maxZ).map(([px, pz]): Point => [
    W.x + px * cos + pz * sin,
    W.z - px * sin + pz * cos,
  ]);
  const pileGround = lowestGround(terrain, x, z, facing, footprint);
  woodpile.position.set(W.x, pileGround - root.position.y - 0.04, W.z);
  woodpile.rotation.y = W.facing;
  root.add(woodpile);

  return {
    object: root,
    model: cabin, // anchors: cabin.getObjectByName('smokeAnchor' | 'doorAnchor')
    woodpile, // anchor: woodpile.getObjectByName('axeAnchor')
  };
}
