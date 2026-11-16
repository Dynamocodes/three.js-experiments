import type * as THREE from 'three';

/** Something animated by the render loop. */
export interface Updatable {
  update(time: number, dt: number): void;
}

/** A point on the ground plane with a radius: an area to keep clear. */
export interface Circle {
  x: number;
  z: number;
  r: number;
}

/** What placed objects need from the terrain. */
export interface Terrain {
  mesh: THREE.Mesh;
  /** The smooth height formula. */
  heightAt(x: number, z: number): number;
  /** Height of the drawn triangle under (x, z): use it to sit things on the ground. */
  surfaceAt(x: number, z: number): number;
  /** 0 at the lake centre, 1 at its edge (plus a little noise). */
  lakeDistance(x: number, z: number): number;
  /** Fractal noise, roughly -1..1. */
  fbm(x: number, z: number, octaves?: number): number;
}
