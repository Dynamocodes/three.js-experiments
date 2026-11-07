import * as THREE from 'three';

// Camera that rests at a fixed framing and drifts slightly toward the mouse.
// Keeping the movement small preserves the composition; the depth layers
// in the scene turn that small movement into parallax.
export function createCameraRig(camera, {
  // Low camera close to the shore: a mirror shows more sky (and aurora)
  // the shallower the viewing angle is.
  position = new THREE.Vector3(-4, 7.5, 40),
  target = new THREE.Vector3(2, 7, -40),
  sway = new THREE.Vector2(4, 1.6), // max offset in world units (x, y)
  damping = 2.2,
} = {}) {
  const pointer = new THREE.Vector2();
  const offset = new THREE.Vector2();
  const lookTarget = target.clone();

  const onPointer = (e) => {
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
  };
  window.addEventListener('pointermove', onPointer, { passive: true });

  const apply = () => {
    camera.position.set(position.x + offset.x * sway.x, position.y + offset.y * sway.y, position.z);
    camera.lookAt(lookTarget);
  };
  apply();

  return {
    update(time, dt) {
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
