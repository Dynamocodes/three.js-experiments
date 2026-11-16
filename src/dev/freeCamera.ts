import * as THREE from 'three';
import type { CameraRig } from '../landscape/camera/cameraRig';

// The fly-through camera both dev editors use. It only knows how to move the
// view; it saves nothing and knows nothing about props.

/** Physical keys (KeyboardEvent.code): the same places on QWERTY and AZERTY (Z Q S D, A E). */
export const KEYS = { forward: 'KeyW', left: 'KeyA', back: 'KeyS', right: 'KeyD', down: 'KeyQ', up: 'KeyE' } as const;

export type FreeCamera = ReturnType<typeof createFreeCamera>;

export function createFreeCamera(camera: THREE.Camera, rig: CameraRig) {
  // The view: where the camera is and the point it looks at.
  const position = new THREE.Vector3();
  const target = new THREE.Vector3();

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const spherical = new THREE.Spherical();
  const offset = new THREE.Vector3();
  const updateAxes = () => {
    forward.subVectors(target, position).normalize();
    right.crossVectors(forward, camera.up).normalize();
    up.crossVectors(right, forward);
  };
  const move = (v: THREE.Vector3, amount: number) => {
    position.addScaledVector(v, amount);
    target.addScaledVector(v, amount);
  };

  return {
    position,
    target,

    /** Puts the camera where the view is. */
    apply() {
      camera.position.copy(position);
      camera.lookAt(target);
    },

    /** Back to the saved resting framing. */
    snapToRest() {
      position.copy(rig.position);
      target.copy(rig.target);
    },

    /**
     * Turns the camera in place: the target swings around it. Like grabbing
     * the scene: it follows the cursor (drag right, the view turns left).
     */
    look(dx: number, dy: number) {
      offset.subVectors(target, position);
      spherical.setFromVector3(offset);
      spherical.theta += dx * 0.003;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi - dy * 0.003, 0.15, Math.PI - 0.15);
      target.copy(position).add(offset.setFromSpherical(spherical));
    },

    /** Slides sideways and up/down, by a pointer drag in pixels. */
    slide(dx: number, dy: number) {
      updateAxes();
      move(right, -dx * 0.03);
      move(up, dy * 0.03);
    },

    /** Moves forward (or back, negative) along the view. */
    dolly(amount: number) {
      updateAxes();
      move(forward, amount);
    },

    /** Directions on the ground as seen from the camera. */
    groundAxes() {
      updateAxes();
      return { forward: forward.clone().setY(0).normalize(), right: right.clone().setY(0).normalize() };
    },

    /** Flies with the keys; false if `code` isn't a flying key. */
    key(code: string, step: number) {
      const { forward: flat, right: side } = this.groundAxes();
      const dir = {
        [KEYS.forward]: flat, [KEYS.back]: flat.clone().negate(), [KEYS.right]: side, [KEYS.left]: side.clone().negate(),
        [KEYS.up]: camera.up.clone(), [KEYS.down]: camera.up.clone().negate(),
      }[code];
      if (!dir) return false;
      move(dir, step);
      return true;
    },
  };
}
