import * as THREE from 'three';
import { palette } from './palette';
import { createRng } from './utils/random';
import { createTerrain } from './world/terrain';
import { createWater } from './world/water';
import { createSky } from './world/sky';
import { createVegetation } from './props/vegetation';
import { placeCabin } from './props/cabin';
import { placePier } from './props/pier';
import { placeSnowman } from './props/snowman';
import { createAurora } from './effects/aurora';
import { createSnowfall } from './effects/snowfall';
import { createShootingStars } from './effects/shootingStars';
import { createSmoke } from './effects/smoke';
import { createCameraRig } from './camera/cameraRig';
import { createSnowballs } from './interactions/snowballs';
import { modelUrls, loadInstanceParts, loadModel } from './loaders/models';
import type { Updatable } from './types';

export interface LandscapeOptions {
  /** Same seed => same terrain, forest and sky. */
  seed?: number;
}

export interface Landscape {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  aurora: ReturnType<typeof createAurora>;
  /** Resolves once any drop-in models (src/assets/models/) have loaded. */
  assetsReady: Promise<void>;
  /** Stops rendering and frees GPU resources. */
  dispose(): void;
}

/**
 * Mounts the landscape on a canvas. Framework-agnostic: in Next.js, call this
 * from a client component's useEffect and call dispose() in the cleanup.
 */
export function createLandscape(canvas: HTMLCanvasElement, { seed = 1 }: LandscapeOptions = {}): Landscape {
  const rng = createRng(seed);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(palette.fog, 45, 240);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1500);

  // Lighting: cool moonlight + sky/ground fill. No real-time shadows (cheap).
  scene.add(new THREE.HemisphereLight(palette.hemiSky, palette.hemiGround, 1.3));
  const moon = new THREE.DirectionalLight(palette.moon, 1.6);
  moon.position.set(-40, 60, 30);
  scene.add(moon);

  // World.
  const terrain = createTerrain(rng);
  scene.add(terrain.mesh);

  // Foreground hero: on the bank in the lower left, turned three-quarters so
  // the porch faces the camera and the lit side windows face the lake.
  const cabinSpot = { x: -10, z: 19 };
  const toCamera = Math.atan2(0 - cabinSpot.x, 40 - cabinSpot.z);
  const cabinTurn = -0.65;
  const cabin = placeCabin(terrain, {
    ...cabinSpot,
    facing: toCamera + cabinTurn,
    woodpileFacing: -cabinTurn, // relative to the cabin: end grain straight at the camera
  });
  scene.add(cabin.object);
  const smokeAnchor = cabin.model.getObjectByName('smokeAnchor');
  if (!smokeAnchor) throw new Error('log cabin model has no smokeAnchor');
  const smoke = createSmoke(smokeAnchor);
  scene.add(smoke.object);

  // Pier on the near shore, right of the cabin, reaching out into the lake.
  const pier = placePier(terrain, { x: 16, turn: -0.45 });

  // Snowman on the open snow left of the cabin, turned a little toward the
  // cabin. On wide screens it sits in the bottom-left corner; on narrower ones
  // it is out of frame. It has its own seed, so it doesn't change anything else.
  const snowman = placeSnowman(terrain, { x: -15, z: 22.5, lookAt: { x: -4, z: 40 }, turn: 0.35 });
  scene.add(snowman.object);
  scene.add(pier.object);

  const vegetation = createVegetation(rng, terrain, {
    avoid: [{ ...cabinSpot, r: 9 }, pier.footprint],
  });
  scene.add(vegetation.object);

  // Swap placeholders for any models dropped into src/assets/models/*.
  const upgradeCabin = async () => {
    const url = modelUrls.cabin?.[0];
    if (!url) return;
    const model = await loadModel(url, { height: 5.5 });
    // Hide the procedural cabin's meshes but keep its warm window light.
    cabin.model.traverse((c) => { if (c instanceof THREE.Mesh) c.visible = false; });
    cabin.object.add(model.object);
  };
  const assetsReady = Promise.all([
    vegetation.upgrade(modelUrls, loadInstanceParts),
    upgradeCabin().catch((err) => console.warn('[landscape] cabin model failed, keeping placeholder', err)),
  ]).then(() => { if (reducedMotion) renderer.render(scene, camera); });

  const sky = createSky(rng);
  const aurora = createAurora(rng);
  const snowfall = createSnowfall(rng);
  const water = createWater(renderer);
  // Created last: it takes its own seed, so it can't change anything above.
  const shootingStars = createShootingStars(rng);
  scene.add(sky.object, aurora.object, snowfall.object, water.object, shootingStars.object);
  sky.setPixelRatio(pixelRatio);
  snowfall.setPixelRatio(pixelRatio);

  const rig = createCameraRig(camera);

  // Click the scene to throw a snowball. Trees and rocks are instanced, so
  // three.js tests each copy's bounding sphere first and the raycast on a
  // click stays cheap even with the whole forest as a target.
  const snowballs = createSnowballs({
    camera,
    canvas,
    targets: [terrain.mesh, water.object, cabin.object, pier.object, snowman.object, vegetation.object],
  });
  scene.add(snowballs.object);

  // Resize.
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.fov = camera.aspect < 1 ? 62 : 45; // portrait phones need a wider view
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    water.resize();
    if (reducedMotion) renderer.render(scene, camera);
  };
  window.addEventListener('resize', resize);
  resize();

  // Loop. Paused when the tab is hidden; a single still frame for reduced motion.
  const clock = new THREE.Clock();
  let time = 0;
  const updatables: Updatable[] = [sky, aurora, snowfall, shootingStars, smoke, pier, snowman, snowballs];

  const tick = () => {
    const dt = Math.min(clock.getDelta(), 0.1);
    time += dt;
    for (const u of updatables) u.update(time, dt);
    // Placeholder aurora "event": slowly swells and fades. Will move to the event scheduler.
    aurora.intensity = 0.55 + 0.45 * Math.sin(time * 0.08);
    rig.update(time, dt);
    renderer.render(scene, camera);
  };

  const onVisibility = () => {
    if (reducedMotion) return;
    if (document.hidden) renderer.setAnimationLoop(null);
    else { clock.getDelta(); renderer.setAnimationLoop(tick); }
  };
  document.addEventListener('visibilitychange', onVisibility);

  if (reducedMotion) {
    time = 8;
    for (const u of updatables) u.update(time, 0);
    renderer.render(scene, camera);
  } else {
    renderer.setAnimationLoop(tick);
  }

  // Handy for poking at the scene from the devtools console.
  if (import.meta.env.DEV) {
    window.landscape = { scene, camera, renderer, aurora, shootingStars, snowman, snowballs, terrain, pier, counts: vegetation.counts, modelUrls, vegetation };
  }

  return {
    scene,
    camera,
    renderer,
    aurora,
    assetsReady,
    dispose() {
      renderer.setAnimationLoop(null);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      rig.dispose();
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh || obj instanceof THREE.Points)) return;
        obj.geometry.dispose();
        const mats: THREE.Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => m.dispose());
      });
      water.object.getRenderTarget().dispose();
      snowballs.dispose();
      renderer.dispose();
    },
  };
}
