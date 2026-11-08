import * as THREE from 'three';
import { palette } from './palette.js';

// Northern lights as a real volume.
//
// 1. Curtains (where they are). A small pool of curtains runs lengthwise
//    along the view direction, from far behind the hills toward the viewer.
//    Each grows out of the distance, lives a while, then streams forward and
//    fades, and respawns with a new random shape. New curtains follow a
//    shared heading that wanders slowly.
//
// 2. Footprint map. Every frame the curtains are drawn top-down, as soft
//    strips, into a small float texture covering the aurora's area. Per texel:
//      r = density (soft across the curtain: this is its thickness)
//      g = density * curtain height here
//      b = density * edge softness here
//    Height, brightness, thickness and softness all vary along each curtain
//    with slow noise.
//
// 3. Raymarch. For every sky pixel a ray is stepped through the altitude band
//    the aurora lives in. At each step the footprint says how much curtain is
//    there and how tall it is; the vertical profile (sharp lower edge, fade
//    upward), rays and colour are added up. Because it's a real volume, a
//    curtain seen edge-on is thick and bright and one seen face-on is thin
//    and see-through, from any angle.
//
// The main view is marched at reduced resolution into a texture and drawn
// behind the scene; reflections (the lake) march directly with fewer steps.

const noiseGLSL = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return s;
  }
`;

// Area the footprint map covers (world xz) and the altitude band.
const BOUNDS = { minX: -420, minZ: -470, sizeX: 840, sizeZ: 540 };
const BASE = 40; // average height of the lower edge
const TOP = 140; // nothing above this

// ---------------------------------------------------------------------------
// Footprint pass: curtains as soft strips seen from above.

const footVertex = /* glsl */ `
  attribute vec3 aFold;    // horizontal, across the curtain
  attribute vec3 aTangent; // horizontal, along the curtain
  uniform float uTime;
  uniform float uSeed;
  uniform float uThick;
  uniform vec2 uMin;
  uniform vec2 uSize;
  varying vec2 vUv; // x: along (0 far, 1 near), y: across (-1..1)
  ${noiseGLSL}
  void main() {
    vUv = uv;
    vec3 p = position;
    float t = uv.x + uSeed;
    // Thickness varies along the curtain.
    float thick = smoothstep(0.25, 0.75, fbm(vec2(uv.x * 2.5 - uSeed, uTime * 0.015 + 7.0)));
    p += aFold * uv.y * uThick * (0.5 + thick) * 2.2;
    // Folds and sway, travelling toward the viewer.
    p += aFold * (sin(t * 9.0 - uTime * 0.12) * 14.0 + sin(t * 23.0 - uTime * 0.21) * 4.0);
    p += aTangent * sin(t * 17.0 + uTime * 0.17) * 4.0;
    // Straight to the map: world xz -> clip space.
    gl_Position = vec4((p.xz - uMin) / uSize * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const footFragment = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uStrength;
  uniform float uHeight;
  uniform float uHead;
  uniform float uTail;
  uniform float uIntensity;
  varying vec2 vUv;
  ${noiseGLSL}
  void main() {
    float x = vUv.x;
    // Soft across: a smooth falloff instead of a hard sheet.
    float dens = exp(-vUv.y * vUv.y * 4.8);

    // Big slow bands flowing toward the viewer: where the curtain is lit.
    float bands = fbm(vec2(x * 6.0 - uTime * 0.05 + uSeed, uTime * 0.04 + uSeed));
    float present = smoothstep(0.3, 0.7, bands);
    float glow = fbm(vec2(x * 4.0 + uSeed * 2.0, uTime * 0.03 + 3.0));
    float bright = mix(0.6, 1.35, smoothstep(0.25, 0.75, glow));
    float tall = fbm(vec2(x * 3.5 + uSeed, uTime * 0.02 + uSeed * 0.3));
    float height = uHeight * mix(0.35, 1.15, smoothstep(0.2, 0.75, tall));
    float soft = smoothstep(0.2, 0.8, fbm(vec2(x * 3.0 - uSeed, uTime * 0.025 + 11.0)));

    float ends = smoothstep(0.0, 0.15, x) * smoothstep(1.0, 0.85, x);
    float life = smoothstep(uHead, uHead - 0.2, x) * smoothstep(uTail, uTail + 0.2, x);

    float k = dens * present * bright * ends * life * uStrength * uIntensity;
    gl_FragColor = vec4(k, k * height, k * soft, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Volume pass: a screen-filling quad at the far plane that marches the sky.

const volumeVertex = /* glsl */ `
  varying vec2 vNdc;
  void main() {
    vNdc = position.xy;
    // Just in front of the far plane: only shows where nothing else is drawn.
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`;

const volumeFragment = /* glsl */ `
  uniform sampler2D uFoot;
  uniform sampler2D uLowRes;
  uniform bool uUseLowRes;
  uniform vec2 uResolution;
  uniform vec2 uMin;
  uniform vec2 uSize;
  uniform mat4 uProj;
  uniform mat4 uCamWorld;
  uniform float uTime;
  uniform float uEmission;
  uniform vec2 uFlow;
  uniform vec3 uColorLow;
  uniform vec3 uColorHigh;
  varying vec2 vNdc;
  ${noiseGLSL}

  vec3 march(vec3 ro, vec3 rd) {
    if (rd.y < 0.01) return vec3(0.0);
    // Altitude band...
    float t0 = max((${(BASE - 8).toFixed(1)} - ro.y) / rd.y, 0.0);
    float t1 = (${TOP.toFixed(1)} - ro.y) / rd.y;
    // ...clipped to the area the map covers.
    vec2 d = vec2(abs(rd.x) < 1e-4 ? 1e-4 : rd.x, abs(rd.z) < 1e-4 ? 1e-4 : rd.z);
    vec2 inv = 1.0 / d;
    vec2 ta = (uMin - ro.xz) * inv;
    vec2 tb = (uMin + uSize - ro.xz) * inv;
    vec2 tmin = min(ta, tb), tmax = max(ta, tb);
    t0 = max(t0, max(tmin.x, tmin.y));
    t1 = min(t1, min(tmax.x, tmax.y));
    t1 = min(t1, t0 + 900.0);
    if (t1 <= t0) return vec3(0.0);

    float dt = (t1 - t0) / float(STEPS);
    // Per-pixel offset hides the step pattern as fine grain.
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float t = t0 + dt * jitter;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < STEPS; i++) {
      vec3 p = ro + rd * t;
      t += dt;
      vec4 f = texture2D(uFoot, (p.xz - uMin) / uSize);
      if (f.r < 0.002) continue;
      float height = f.g / f.r;
      float soft = f.b / f.r;
      // Lower edge undulates a little over the sky.
      float base = ${BASE.toFixed(1)} + (vnoise(p.xz * 0.015) - 0.5) * 12.0;
      float h = (p.y - base) / height;
      if (h < 0.0 || h > 1.0) continue;

      float lower = smoothstep(0.0, 0.03 + 0.2 * soft, h);
      float upper = pow(1.0 - h, mix(1.0, 2.8, 1.0 - soft));
      // Rays: vertical columns (noise ignores height), streaming forward.
      vec2 q = p.xz - uFlow * uTime * 2.0 + vec2(0.0, uTime * 0.3);
      float rays = 0.65 * vnoise(q * 0.6) + 0.35 * vnoise(q * 1.7 + 5.0);
      rays = 0.15 + 2.2 * rays * rays * rays; // high contrast so rays survive the long sightlines

      vec3 col = mix(uColorLow, uColorHigh, smoothstep(0.3, 0.95, h));
      col += vec3(0.5, 1.0, 0.75) * (1.0 - smoothstep(0.0, 0.12, h)) * 0.6 * (1.0 - soft * 0.6);
      acc += col * f.r * lower * upper * rays;
    }
    // Soft limit so long edge-on paths glow instead of clipping.
    return 1.0 - exp(-acc * dt * uEmission);
  }

  void main() {
    vec3 col;
    if (uUseLowRes) {
      col = texture2D(uLowRes, gl_FragCoord.xy / uResolution).rgb;
    } else {
      // View ray from the projection's x/y scale and offset only: mirror
      // cameras skew the depth row (oblique clipping), which these ignore.
      vec3 view = vec3((vNdc.x + uProj[2][0]) / uProj[0][0], (vNdc.y + uProj[2][1]) / uProj[1][1], -1.0);
      vec3 rd = normalize(mat3(uCamWorld) * view);
      col = march(uCamWorld[3].xyz, rd);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------

function curtainGeometry(curve, segments) {
  const count = (segments + 1) * 2;
  const positions = new Float32Array(count * 3);
  const folds = new Float32Array(count * 3);
  const tangents = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const indices = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    t.y = 0;
    t.normalize();
    positions.set([p.x, 0, p.z, p.x, 0, p.z], i * 6);
    folds.set([-t.z, 0, t.x, -t.z, 0, t.x], i * 6);
    tangents.set([t.x, 0, t.z, t.x, 0, t.z], i * 6);
    uvs.set([u, -1, u, 1], i * 4);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aFold', new THREE.BufferAttribute(folds, 3));
  geo.setAttribute('aTangent', new THREE.BufferAttribute(tangents, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/**
 * A random curtain: starts far back, runs toward the viewer along `heading`
 * (0 = straight at the camera, positive leans right), meandering sideways.
 */
function randomCurtain(rng, heading, lane) {
  const length = rng.range(240, 380);
  const far = new THREE.Vector3(lane + rng.range(-25, 25), 0, rng.range(-430, -360));
  const dir = new THREE.Vector3(Math.sin(heading), 0, 1).normalize(); // toward the viewer
  const side = new THREE.Vector3(dir.z, 0, -dir.x);

  // Sideways meander: two waves with random phase, for S-curves and hooks.
  const a1 = rng.range(15, 45), f1 = rng.range(0.6, 1.4), p1 = rng.range(0, Math.PI * 2);
  const a2 = rng.range(5, 18), f2 = rng.range(1.8, 3.2), p2 = rng.range(0, Math.PI * 2);
  const pts = [];
  const n = 9;
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const wander = a1 * Math.sin(u * Math.PI * f1 + p1) + a2 * Math.sin(u * Math.PI * f2 + p2);
    pts.push(far.clone().addScaledVector(dir, u * length).addScaledVector(side, wander));
  }
  return {
    curve: new THREE.CatmullRomCurve3(pts),
    height: rng.range(40, 75),
    thick: rng.range(4, 9),
    strength: rng.range(0.5, 1.0),
    seed: rng.range(0, 100),
    grow: rng.range(14, 24),   // seconds to reach full length
    hold: rng.range(30, 70),   // seconds at full length
    fade: rng.range(14, 24),   // seconds to stream away
    rest: rng.range(2, 10),    // seconds before the next one starts
  };
}

export function createAurora(rng, {
  count = 5,
  maxTurn = 0.35, // radians the shared heading wanders either side of straight-on
  turnSpeed = 0.015,
  spread = 150, // how far left/right of the view line curtains can start
  resolution = 0.5, // main-view march resolution (fraction of the canvas)
  steps = 64, // march steps for the main view
  reflectionSteps = 28,
  emission = 0.1,
  mapSize = 1024,
} = {}) {
  const group = new THREE.Group();
  group.name = 'aurora';

  const shared = {
    uTime: { value: 0 },
    uIntensity: { value: 1 },
    uMin: { value: new THREE.Vector2(BOUNDS.minX, BOUNDS.minZ) },
    uSize: { value: new THREE.Vector2(BOUNDS.sizeX, BOUNDS.sizeZ) },
  };

  // --- Footprint map -------------------------------------------------------
  const footTarget = new THREE.WebGLRenderTarget(mapSize, mapSize, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const footScene = new THREE.Scene();
  const footCamera = new THREE.Camera(); // unused by the shader, required by render()

  let headingOverride = null;
  const autoHeading = (t) =>
    maxTurn * (0.7 * Math.sin(t * turnSpeed + 0.8) + 0.3 * Math.sin(t * turnSpeed * 2.3 + 2.1));
  const headingAt = (t) => headingOverride ?? autoHeading(t);
  const laneFor = (i) => ((i + 0.5) / count - 0.5) * 2 * spread;

  const curtains = [];
  const spawn = (c, time) => {
    const r = randomCurtain(rng, headingAt(time) + rng.range(-0.12, 0.12), laneFor(c.index));
    c.mesh.geometry.dispose();
    c.mesh.geometry = curtainGeometry(r.curve, 300);
    const u = c.mesh.material.uniforms;
    u.uSeed.value = r.seed;
    u.uStrength.value = r.strength;
    u.uHeight.value = r.height;
    u.uThick.value = r.thick;
    Object.assign(c, { start: time, grow: r.grow, hold: r.hold, fade: r.fade, rest: r.rest });
  };

  for (let i = 0; i < count; i++) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: footVertex,
      fragmentShader: footFragment,
      uniforms: {
        ...shared,
        uSeed: { value: 0 },
        uStrength: { value: 1 },
        uHeight: { value: 50 },
        uThick: { value: 6 },
        uHead: { value: 0 },
        uTail: { value: -0.2 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.frustumCulled = false;
    footScene.add(mesh);
    const c = { index: i, mesh };
    spawn(c, 0);
    // Stagger: start each one somewhere in its life so the sky isn't empty at first.
    c.start = -rng.range(0, c.grow + c.hold);
    curtains.push(c);
  }

  // --- Volume --------------------------------------------------------------
  const lowRes = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const volumeUniforms = () => ({
    ...shared,
    uFoot: { value: footTarget.texture },
    uLowRes: { value: lowRes.texture },
    uUseLowRes: { value: false },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uEmission: { value: emission },
    uFlow: { value: new THREE.Vector2(0, 1) },
    uColorLow: { value: new THREE.Color(palette.auroraLow) },
    uColorHigh: { value: new THREE.Color(palette.auroraHigh) },
  });
  const volumeMaterial = (stepCount) => new THREE.ShaderMaterial({
    vertexShader: volumeVertex,
    fragmentShader: volumeFragment,
    defines: { STEPS: stepCount },
    uniforms: volumeUniforms(),
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
  });
  const quad = new THREE.PlaneGeometry(2, 2);

  // Main-view march, rendered offscreen at reduced resolution.
  const marchMat = volumeMaterial(steps);
  marchMat.blending = THREE.NoBlending;
  marchMat.uniforms.uLowRes.value = null; // never sample the texture being drawn into
  const marchScene = new THREE.Scene();
  const marchMesh = new THREE.Mesh(quad, marchMat);
  marchMesh.frustumCulled = false;
  marchScene.add(marchMesh);

  // In the scene: shows the low-res result for the main camera, and marches
  // directly for any other camera (the lake's mirror view).
  const skyMat = volumeMaterial(reflectionSteps);
  const skyMesh = new THREE.Mesh(quad, skyMat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -1; // first of the see-through things, behind snow and smoke
  group.add(skyMesh);

  let mainCamera = null;
  const size = new THREE.Vector2();
  const setCamera = (u, camera) => {
    u.uProj.value.copy(camera.projectionMatrix);
    u.uCamWorld.value.copy(camera.matrixWorld);
  };
  skyMesh.onBeforeRender = (renderer, scene, camera) => {
    const u = skyMat.uniforms;
    u.uUseLowRes.value = camera === mainCamera;
    if (u.uUseLowRes.value) {
      const target = renderer.getRenderTarget();
      if (target) u.uResolution.value.set(target.width, target.height);
      else renderer.getDrawingBufferSize(u.uResolution.value);
    } else {
      setCamera(u, camera);
    }
  };

  // A faint green light so the aurora tints the snow.
  const light = new THREE.DirectionalLight(palette.auroraLow, 0.5);
  light.position.set(0, 60, -200);
  group.add(light);

  const clearColor = new THREE.Color();

  return {
    object: group,
    get intensity() { return shared.uIntensity.value; },
    set intensity(v) {
      shared.uIntensity.value = v;
      light.intensity = 0.5 * v;
    },
    // Direction new curtains run in (radians, 0 = straight toward the viewer).
    // null = slow automatic wander.
    get heading() { return headingAt(shared.uTime.value); },
    set heading(v) { headingOverride = v; },

    update(time) {
      shared.uTime.value = time;
      for (const c of curtains) {
        let age = time - c.start;
        if (age > c.grow + c.hold + c.fade + c.rest) {
          spawn(c, time);
          age = 0;
        }
        const u = c.mesh.material.uniforms;
        u.uHead.value = THREE.MathUtils.smootherstep(age, 0, c.grow) * 1.2;
        u.uTail.value = THREE.MathUtils.smootherstep(age, c.grow + c.hold, c.grow + c.hold + c.fade) * 1.4 - 0.2;
      }
      // Rays stream along the current general direction, toward the viewer.
      const h = headingAt(time);
      for (const m of [marchMat, skyMat]) m.uniforms.uFlow.value.set(Math.sin(h), Math.cos(h));
    },

    /** Call once per frame before rendering the scene with `camera`. */
    prepare(renderer, camera) {
      mainCamera = camera;
      const prevTarget = renderer.getRenderTarget();
      renderer.getClearColor(clearColor);
      const prevAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);

      renderer.setRenderTarget(footTarget);
      renderer.render(footScene, footCamera);

      renderer.getDrawingBufferSize(size);
      const w = Math.max(1, Math.floor(size.x * resolution));
      const hgt = Math.max(1, Math.floor(size.y * resolution));
      if (lowRes.width !== w || lowRes.height !== hgt) lowRes.setSize(w, hgt);
      camera.updateMatrixWorld();
      setCamera(marchMat.uniforms, camera);
      renderer.setRenderTarget(lowRes);
      renderer.render(marchScene, camera);

      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(clearColor, prevAlpha);
    },

    dispose() {
      footTarget.dispose();
      lowRes.dispose();
      for (const c of curtains) { c.mesh.geometry.dispose(); c.mesh.material.dispose(); }
      marchMat.dispose();
      skyMat.dispose();
      quad.dispose();
    },
  };
}
