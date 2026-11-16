import * as THREE from 'three';

// Snowball throwing.
//
// Click (or tap) on the scene and a snowball flies from just below the camera,
// in an arc, to the point under the cursor, then bursts into a puff of snow.
// Clicks on links, buttons and form fields are left alone, so the page on top
// keeps working.
//
// Anything hit can react: if the hit object, or one of its parents, has a
// `userData.onSnowballHit(point, normal)` function, it's called on impact.
// This module knows nothing about what it hits; the snowman, for example,
// wobbles because its prop sets that hook.

/** What a hit object can implement in `userData.onSnowballHit`. */
export type SnowballHitHandler = (point: THREE.Vector3, normal: THREE.Vector3) => void;

export interface SnowballOptions {
  camera: THREE.Camera;
  /** The canvas the scene is drawn on (for mapping clicks to the view). */
  canvas: HTMLCanvasElement;
  /**
   * What snowballs can land on. Every click raycasts against all of them,
   * children included. Instanced meshes are fine: three.js checks each
   * copy's bounding sphere before its triangles.
   */
  targets: THREE.Object3D[];
  /** Listen for clicks on the page (default true). Off: call throwAt yourself. */
  listen?: boolean;
  /** Clicks on the sky send the snowball this far before it fades away. */
  missDistance?: number;
  gravity?: number;
}

interface Flight {
  mesh: THREE.Mesh;
  start: THREE.Vector3;
  velocity: THREE.Vector3;
  t: number;
  duration: number;
  hit: THREE.Intersection | null;
}

interface Burst {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  velocities: Float32Array;
  age: number;
}

const BURST_PARTICLES = 22;
const BURST_LIFE = 0.75; // seconds
// Elements whose clicks belong to the page, not the scene.
const PAGE_CONTROLS = 'a, button, input, textarea, select, label, summary, [contenteditable], [role="button"]';

export function createSnowballs({
  camera,
  canvas,
  targets,
  listen = true,
  missDistance = 45,
  gravity = 14,
}: SnowballOptions) {
  const group = new THREE.Group();
  group.name = 'snowballs';
  const g = new THREE.Vector3(0, -gravity, 0);

  const ballGeometry = new THREE.IcosahedronGeometry(0.11, 1);
  const ballMaterial = new THREE.MeshStandardMaterial({ color: '#f3f6fc', flatShading: true, roughness: 0.85 });
  const flights: Flight[] = [];
  const bursts: Burst[] = [];
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  /** Throws a snowball at a point on screen (client pixels). */
  function throwAt(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(targets, true)[0] ?? null;
    const target = hit ? hit.point.clone() : raycaster.ray.at(missDistance, new THREE.Vector3());

    // From a hand just below and right of the eye.
    const start = new THREE.Vector3(0.35, -0.45, -0.6).applyMatrix4(camera.matrixWorld);
    // Further throws take longer and arc higher.
    const duration = THREE.MathUtils.clamp(0.3 + start.distanceTo(target) * 0.016, 0.35, 1.4);
    // Ballistic: start + v t + g t^2 / 2 reaches the target at t = duration.
    const velocity = target.clone().sub(start).divideScalar(duration).addScaledVector(g, -0.5 * duration);

    const mesh = new THREE.Mesh(ballGeometry, ballMaterial);
    mesh.position.copy(start);
    group.add(mesh);
    flights.push({ mesh, start, velocity, t: 0, duration, hit });
  }

  /** A puff of snow flying out from the impact, falling and fading. */
  function burst(point: THREE.Vector3, normal: THREE.Vector3) {
    const positions = new Float32Array(BURST_PARTICLES * 3);
    const velocities = new Float32Array(BURST_PARTICLES * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < BURST_PARTICLES; i++) {
      positions.set([point.x, point.y, point.z], i * 3);
      // Mostly out of the surface, spread in a cone, varied speeds.
      v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
        .addScaledVector(normal, 1.2).normalize()
        .multiplyScalar(1.2 + Math.random() * 2.6);
      velocities.set([v.x, v.y + 1, v.z], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: '#eef3ff', size: 0.09, transparent: true, depthWrite: false, opacity: 1,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    group.add(points);
    bursts.push({ points, velocities, age: 0 });
  }

  /** Calls `userData.onSnowballHit` on the hit object or its nearest parent that has one. */
  function notify(hit: THREE.Intersection, normal: THREE.Vector3) {
    for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
      const handler = o.userData.onSnowballHit as SnowballHitHandler | undefined;
      if (handler) { handler(hit.point, normal); return; }
    }
  }

  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  function land(f: Flight) {
    if (!f.hit) return;
    // Surface normal in world space (straight up if the hit has no face).
    if (f.hit.face) {
      normalMatrix.getNormalMatrix(f.hit.object.matrixWorld);
      normal.copy(f.hit.face.normal).applyMatrix3(normalMatrix).normalize();
    } else {
      normal.set(0, 1, 0);
    }
    burst(f.hit.point, normal);
    notify(f.hit, normal);
  }

  function update(_time: number, dt: number) {
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      f.t = Math.min(f.t + dt, f.duration);
      f.mesh.position.copy(f.start).addScaledVector(f.velocity, f.t).addScaledVector(g, 0.5 * f.t * f.t);
      f.mesh.rotation.x += dt * 9;
      // A miss shrinks away into the distance instead of landing.
      if (!f.hit) f.mesh.scale.setScalar(1 - THREE.MathUtils.smoothstep(f.t / f.duration, 0.6, 1));
      if (f.t >= f.duration) {
        group.remove(f.mesh);
        land(f);
        flights.splice(i, 1);
      }
    }
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.age += dt;
      const pos = b.points.geometry.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < BURST_PARTICLES; k++) {
        b.velocities[k * 3 + 1] -= gravity * 0.6 * dt; // snow is light
        pos.setXYZ(k,
          pos.getX(k) + b.velocities[k * 3] * dt,
          pos.getY(k) + b.velocities[k * 3 + 1] * dt,
          pos.getZ(k) + b.velocities[k * 3 + 2] * dt);
      }
      pos.needsUpdate = true;
      b.points.material.opacity = 1 - THREE.MathUtils.smoothstep(b.age / BURST_LIFE, 0.3, 1);
      if (b.age >= BURST_LIFE) {
        group.remove(b.points);
        b.points.geometry.dispose();
        b.points.material.dispose();
        bursts.splice(i, 1);
      }
    }
  }

  // Clicks anywhere on the page, except on its own controls or while
  // selecting text. The canvas sits behind the content, so listening on it
  // directly would miss most clicks.
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest(PAGE_CONTROLS)) return;
    if (window.getSelection()?.toString()) return;
    throwAt(e.clientX, e.clientY);
  };
  if (listen) window.addEventListener('click', onClick);

  return {
    object: group,
    throwAt,
    update,
    dispose() {
      window.removeEventListener('click', onClick);
      for (const b of bursts) { b.points.geometry.dispose(); b.points.material.dispose(); }
      ballGeometry.dispose();
      ballMaterial.dispose();
    },
  };
}
