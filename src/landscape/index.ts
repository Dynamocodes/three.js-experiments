import * as THREE from 'three';
import { palette } from './palette';
import { createRng } from './utils/random';
import { createTerrain } from './world/terrain';
import { createWater } from './world/water';
import { createSky } from './world/sky';
import { createVegetation } from './props/vegetation';
import { placeCabin } from './props/cabin';
import { placeSauna } from './props/sauna';
import { placePier } from './props/pier';
import { placeSnowman } from './props/snowman';
import { createAurora } from './effects/aurora';
import { createSnowfall } from './effects/snowfall';
import { createShootingStars } from './effects/shootingStars';
import { createSmoke } from './effects/smoke';
import { createCameraRig, type CameraRig } from './camera/cameraRig';
import { createSnowballs } from './interactions/snowballs';
import { modelUrls, loadModel } from './loaders/models';
import { LAYOUT, type EditableProp } from './layout';
import type { Terrain, Updatable } from './types';

export interface LandscapeOptions {
  /** Same seed => same terrain, forest and sky. */
  seed?: number;
}

export interface Landscape {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  aurora: ReturnType<typeof createAurora>;
  /** Moves the camera: resting framing plus mouse sway. */
  rig: CameraRig;
  /** Ground heights (e.g. for keeping moved props on the ground). */
  terrain: Terrain;
  /** Props the dev tool can move (see layout.ts). */
  props: EditableProp[];
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

  // Props, placed from layout.json (positions and turns; each placement
  // function grounds its prop). The dev tool (press C) can move and save them.
  //   cabin: on the bank in the lower left, three-quarters to the camera,
  //          the woodpile off its front-right corner, end grain to the camera
  //   pier: on the near shore, reaching out into the lake
  //   snowman: on the open snow left of the cabin
  //   sauna: right of the pier, its hot tub deck (mirrored to the pier side)
  //          reaching out over the slope on posts
  const cabin = placeCabin(terrain, { ...LAYOUT.cabin, woodpile: LAYOUT.woodpile });
  scene.add(cabin.object);
  const smokeAnchor = cabin.model.getObjectByName('smokeAnchor');
  if (!smokeAnchor) throw new Error('log cabin model has no smokeAnchor');
  const smoke = createSmoke(smokeAnchor);
  scene.add(smoke.object);

  const pier = placePier(terrain, LAYOUT.pier);
  scene.add(pier.object);
  // The snowman and sauna have their own seeds, so they don't change anything else.
  const snowman = placeSnowman(terrain, LAYOUT.snowman);
  scene.add(snowman.object);
  const sauna = placeSauna(terrain, LAYOUT.sauna);
  scene.add(sauna.object);

  // Trees. `avoid` is fixed where the cabin and pier first stood:
  // it changes the random draws, so moving it would reshuffle the whole
  // forest. `clear` empties the spots where the props stand now, without
  // changing any draws.
  const vegetation = createVegetation(rng, terrain, {
    avoid: [
      { x: -10, z: 19, r: 9 },
      { x: 5.4390368317793545, z: 17.862855645122927, r: 7 },
    ],
    clear: [
      { x: cabin.object.position.x, z: cabin.object.position.z, r: 9 },
      pier.footprint,
      { x: snowman.object.position.x, z: snowman.object.position.z, r: 1.5 },
      sauna.clearing,
    ],
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

  // Props the dev tool can move, and how to read each back into layout.json.
  const flat = (o: THREE.Object3D) => ({ x: o.position.x, z: o.position.z, facing: o.rotation.y });
  const pierYaw = () => pier.object.rotation.y + pier.model.rotation.y;
  const props: EditableProp[] = [
    { name: 'woodpile', object: cabin.woodpile, read: () => flat(cabin.woodpile) }, // first: it sits inside the cabin
    { name: 'cabin', object: cabin.object, read: () => flat(cabin.object) },
    {
      name: 'pier',
      object: pier.object, // its stairs' snowdrift is in world space, so the group turns around the pontoon
      pivot: () => pier.model.getWorldPosition(new THREE.Vector3()),
      followGround: false,
      read: () => {
        const p = pier.model.getWorldPosition(new THREE.Vector3());
        return { x: p.x, z: p.z, turn: pierYaw() - Math.PI };
      },
    },
    { name: 'snowman', object: snowman.object, read: () => flat(snowman.object) },
    { name: 'sauna', object: sauna.building, read: () => ({ ...flat(sauna.building), mirror: LAYOUT.sauna.mirror }) },
  ];

  // Click the scene to throw a snowball. Trees are instanced, so
  // three.js tests each copy's bounding sphere first and the raycast on a
  // click stays cheap even with the whole forest as a target.
  const snowballs = createSnowballs({
    camera,
    canvas,
    targets: [terrain.mesh, water.object, cabin.object, pier.object, snowman.object, sauna.building, vegetation.object],
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
  const updatables: Updatable[] = [sky, aurora, snowfall, shootingStars, smoke, sauna, pier, snowman, snowballs];

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
    window.landscape = { scene, sauna, camera, renderer, aurora, shootingStars, snowman, snowballs, terrain, pier, counts: vegetation.counts, modelUrls, vegetation };
  }

  return {
    scene,
    camera,
    renderer,
    aurora,
    rig,
    terrain,
    props,
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
