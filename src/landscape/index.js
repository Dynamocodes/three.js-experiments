import * as THREE from 'three';
import { palette } from './palette.js';
import { createRng } from './rng.js';
import { createTerrain } from './terrain.js';
import { createWater } from './water.js';
import { createSky } from './sky.js';
import { createVegetation } from './vegetation.js';
import { createCabin } from './cabin.js';
import { createAurora } from './aurora.js';
import { createSnow } from './snow.js';
import { createSmoke } from './smoke.js';
import { createPier } from './pier.js';
import { createCameraRig } from './cameraRig.js';
import { modelUrls, loadInstanceParts, loadModel } from './assets.js';

/**
 * Mounts the landscape on a canvas. Framework-agnostic: in Next.js, call this
 * from a client component's useEffect and call dispose() in the cleanup.
 */
export function createLandscape(canvas, { seed = 1 } = {}) {
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
  const cabin = createCabin(terrain, {
    ...cabinSpot,
    facing: toCamera + cabinTurn,
    woodpileFacing: -cabinTurn, // relative to the cabin: end grain straight at the camera
  });
  scene.add(cabin.object);
  const smoke = createSmoke(cabin.model.getObjectByName('smokeAnchor'));
  scene.add(smoke.object);

  // Pier on the near shore, right of the cabin, reaching out into the lake.
  const pier = createPier(terrain, { x: 16, turn: -0.45 });
  scene.add(pier.object);

  const vegetation = createVegetation(rng, terrain, {
    avoid: [{ ...cabinSpot, r: 9 }, { x: pier.footprint.x, z: pier.footprint.z, r: pier.footprint.r }],
  });
  scene.add(vegetation.object);

  // Swap placeholders for any models dropped into src/assets/models/*.
  const upgradeCabin = async () => {
    const url = modelUrls.cabin?.[0];
    if (!url) return;
    const model = await loadModel(url, { height: 5.5 });
    // Hide the procedural cabin's meshes but keep its warm window light.
    cabin.model.traverse((c) => { if (c.isMesh) c.visible = false; });
    cabin.object.add(model.object);
  };
  const assetsReady = Promise.all([
    vegetation.upgrade(modelUrls, loadInstanceParts),
    upgradeCabin().catch((err) => console.warn('[landscape] cabin model failed, keeping placeholder', err)),
  ]).then(() => { if (reducedMotion) renderer.render(scene, camera); });

  const sky = createSky(rng);
  const aurora = createAurora(rng);
  const snow = createSnow(rng);
  const water = createWater(renderer);
  scene.add(sky.object, aurora.object, snow.object, water.object);
  sky.setPixelRatio(pixelRatio);
  snow.setPixelRatio(pixelRatio);

  const rig = createCameraRig(camera);

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
  const updatables = [sky, aurora, snow, smoke, pier];

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
    window.landscape = { scene, camera, renderer, aurora, terrain, pier, counts: vegetation.counts, modelUrls, vegetation };
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
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
        mats.forEach((m) => m.dispose());
      });
      water.object.getRenderTarget().dispose();
      renderer.dispose();
    },
  };
}
