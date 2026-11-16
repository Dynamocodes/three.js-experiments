import * as THREE from 'three';
import framing from './framing.json';

// Camera that rests at a fixed framing and drifts slightly toward the mouse.
// Keeping the movement small preserves the composition; the depth layers
// in the scene turn that small movement into parallax.
//
// The resting framing lives in framing.json. Low near the shore, because a
// mirror shows more sky (and aurora) the shallower the viewing angle is; set
// back so the cabin, sauna and snowman all fit, and off to the left looking
// across the lake toward the sauna. In development, press C on the page to
// frame it by hand and save it there (src/dev/cameraEditor.ts).

/** The default resting framing, from framing.json. */
export const DEFAULT_FRAMING = {
  position: new THREE.Vector3().fromArray(framing.position),
  target: new THREE.Vector3().fromArray(framing.target),
};

export function createCameraRig(camera: THREE.PerspectiveCamera, {
  position = DEFAULT_FRAMING.position.clone(),
  target = DEFAULT_FRAMING.target.clone(),
  sway = new THREE.Vector2(4, 1.6), // max offset in world units (x, y)
  damping = 2.2,
} = {}) {
  const pointer = new THREE.Vector2();
  const offset = new THREE.Vector2();
  let paused = false;

  const onPointer = (e: PointerEvent) => {
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
  };
  window.addEventListener('pointermove', onPointer, { passive: true });

  const apply = () => {
    camera.position.set(position.x + offset.x * sway.x, position.y + offset.y * sway.y, position.z);
    camera.lookAt(target);
  };
  apply();

  return {
    /** Where the camera rests (before mouse sway). Changing these moves it. */
    position,
    target,
    /** While paused the rig leaves the camera alone (e.g. for hand framing). */
    get paused() { return paused; },
    set paused(value: boolean) {
      paused = value;
      if (!paused) apply();
    },
    update(time: number, dt: number) {
      if (paused) return;
      // Frame-rate independent easing, plus a slow idle drift so the scene
      // never looks frozen even when the mouse is still.
      const k = 1 - Math.exp(-dt * damping);
      const idleX = Math.sin(time * 0.07) * 0.25;
      const idleY = Math.sin(time * 0.11) * 0.15;
      offset.x += (pointer.x + idleX - offset.x) * k;
      offset.y += (pointer.y + idleY - offset.y) * k;
      apply();
    },
    dispose() {
      window.removeEventListener('pointermove', onPointer);
    },
  };
}

export type CameraRig = ReturnType<typeof createCameraRig>;
