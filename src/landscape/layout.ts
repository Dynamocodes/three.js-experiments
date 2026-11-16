import type * as THREE from 'three';
import layout from './layout.json';

// Where the props stand: positions (world x, z) and turns (radians) in
// layout.json. Each prop's placement function still sits it on the ground
// (and the pier's stairs in the snow). In development, the prop editor
// (press P) can move them by hand and save this file (src/dev/propEditor.ts).
//
// The woodpile is relative to the cabin, so it moves with it.

export type Layout = typeof layout;
export type PropName = keyof Layout;
export const LAYOUT: Layout = layout;

/** A prop the dev tool can move, turn and save. */
export interface EditableProp {
  name: PropName;
  /** The object to move. */
  object: THREE.Object3D;
  /** Point it turns around, in world space (default: the object's origin). */
  pivot?: () => THREE.Vector3;
  /** Keep it on the ground while moving (default true; the pier floats). */
  followGround?: boolean;
  /** Its layout.json entry, read from where it stands now. */
  read(): Layout[PropName];
}
