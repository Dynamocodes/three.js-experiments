import * as THREE from 'three';
import { palette } from '../palette';
import { createRng, type Rng } from '../utils/random';

// Northern lights: a few tall ribbons following curves far behind the hills,
// and more behind the camera that light the scene from the front.
// The fragment shader draws the curtain (bright lower edge, vertical rays,
// fade upwards); the vertex shader makes the curtain fold and sway.
//
// A volumetric (raymarched) alternative is documented and kept in
// docs/deferred/aurora-raymarching/.

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

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 p = position;
    float t = uv.x + uSeed;
    // Both edges of a column move together, so the curtain folds.
    p.z += sin(t * 9.0 + uTime * 0.12) * 14.0 + sin(t * 23.0 - uTime * 0.21) * 4.0;
    p.x += sin(t * 17.0 + uTime * 0.17) * 4.0;
    p.y += sin(t * 11.0 + uTime * 0.09) * 4.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uIntensity;
  uniform float uStrength;
  uniform vec3 uColorLow;
  uniform vec3 uColorHigh;
  varying vec2 vUv;
  ${noiseGLSL}
  void main() {
    float y = vUv.y;
    // Big slow bands: where the curtain is bright vs. absent.
    float bands = fbm(vec2(vUv.x * 6.0 - uTime * 0.025 + uSeed, uTime * 0.04 + uSeed));
    // Thin vertical rays drifting sideways.
    float rays = vnoise(vec2(vUv.x * 160.0 + bands * 8.0 - uTime * 0.6, uTime * 0.25));
    rays = 0.35 + 0.9 * rays * rays;

    float lower = smoothstep(0.0, 0.05 + 0.08 * bands, y);
    float upper = pow(1.0 - y, 1.7);
    float ends  = smoothstep(0.0, 0.15, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
    float a = lower * upper * ends * rays * smoothstep(0.3, 0.7, bands) * uIntensity * uStrength;

    vec3 col = mix(uColorLow, uColorHigh, smoothstep(0.3, 0.95, y));
    col += vec3(0.5, 1.0, 0.75) * (1.0 - smoothstep(0.0, 0.12, y)) * 0.6; // hot lower rim
    gl_FragColor = vec4(col, clamp(a * 1.4, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

function ribbonGeometry(curve: THREE.Curve<THREE.Vector3>, height: number, segments: number) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, p);
    positions.set([p.x, p.y, p.z, p.x, p.y + height, p.z], i * 6);
    uvs.set([t, 0, t, 1], i * 4);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

// All ribbons turn together around a point behind the hills, so the display
// keeps one general direction that slowly swings away from straight
// left-to-right: one end comes toward the viewer and climbs up the sky.
const PIVOT = new THREE.Vector3(0, 0, -240);

export function createAurora(rng: Rng, {
  maxTurn = 0.6, // radians either side of left-to-right
  turnSpeed = 0.02, // how fast the heading wanders
} = {}) {
  const root = new THREE.Group();
  root.name = 'aurora';
  const group = new THREE.Group();
  group.name = 'auroraFront';
  group.position.copy(PIVOT);
  // Ribbons are built in world coordinates; this offsets them so the outer
  // group's rotation happens around PIVOT.
  const ribbonsGroup = new THREE.Group();
  ribbonsGroup.position.copy(PIVOT).negate();
  group.add(ribbonsGroup);
  root.add(group);

  const shared = {
    uTime: { value: 0 },
    uColorLow: { value: new THREE.Color(palette.auroraLow) },
    uColorHigh: { value: new THREE.Color(palette.auroraHigh) },
  };
  const frontIntensity = { value: 1 };
  const backIntensity = { value: 1 };

  interface RibbonSpec { z: number; y: number; height: number; strength: number }

  function addRibbon(parent: THREE.Object3D, rand: Rng, r: RibbonSpec, index: number, intensity: { value: number }, span = 640) {
    const pts = [];
    for (let k = 0; k <= 7; k++) {
      pts.push(new THREE.Vector3(-span / 2 + (span * k) / 7 + rand.range(-20, 20), r.y + rand.range(-6, 6), r.z + rand.range(-45, 45)));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const seed = index * 17.3 + rand() * 10;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        ...shared,
        uIntensity: intensity,
        uSeed: { value: seed },
        uStrength: { value: r.strength },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
    });

    const mesh = new THREE.Mesh(ribbonGeometry(curve, r.height, 400), mat);
    mesh.frustumCulled = false; // vertices move in the shader
    parent.add(mesh);
  }

  const ribbons: RibbonSpec[] = [
    { z: -230, y: 38, height: 55, strength: 1.0 },
    { z: -270, y: 48, height: 65, strength: 0.7 },
    { z: -200, y: 34, height: 40, strength: 0.5 },
  ];
  for (const [index, r] of ribbons.entries()) addRibbon(ribbonsGroup, rng, r, index, frontIntensity);

  // A faint green light so the aurora actually tints the snow.
  const light = new THREE.DirectionalLight(palette.auroraLow, 0.5);
  light.position.set(0, 60, -200);
  ribbonsGroup.add(light);

  // ---------- behind the camera ----------
  // More ribbons in the sky at the viewer's back. They're out of shot, but
  // their light falls on everything facing the camera, so the snow on the
  // trees, roofs and drifts picks up a green glow that brightens and fades
  // on its own rhythm. Own random seed: adding them changes nothing else.
  const backRng = createRng(7331);
  const back = new THREE.Group();
  back.name = 'auroraBack';
  root.add(back);
  const backRibbons: RibbonSpec[] = [
    { z: 215, y: 42, height: 60, strength: 1.0 },
    { z: 260, y: 52, height: 70, strength: 0.75 },
    { z: 185, y: 36, height: 45, strength: 0.55 },
  ];
  for (const [index, r] of backRibbons.entries()) addRibbon(back, backRng, r, index + 5, backIntensity, 560);

  const BACK_LIGHT = 0.5;
  const backLight = new THREE.DirectionalLight(palette.auroraLow, BACK_LIGHT);
  backLight.position.set(15, 70, 230); // shines toward the origin (its default target)
  back.add(backLight);
  // Slow surges, never quite dark.
  const backPulse = (t: number) =>
    THREE.MathUtils.clamp(0.55 + 0.3 * Math.sin(t * 0.11 + 0.7) + 0.2 * Math.sin(t * 0.29 + 2.1), 0.15, 1);
  let backOverride: number | null = null;

  // Heading: null = automatic slow wander; a number (radians) pins it.
  let headingOverride: number | null = null;
  const autoHeading = (t: number) =>
    maxTurn * (0.7 * Math.sin(t * turnSpeed) + 0.3 * Math.sin(t * turnSpeed * 2.3 + 1.7));

  return {
    object: root,
    get intensity() { return frontIntensity.value; },
    set intensity(v: number) {
      frontIntensity.value = v;
      light.intensity = 0.5 * v;
    },
    /** Brightness of the ribbons behind the camera. null = automatic surges. */
    get backIntensity() { return backIntensity.value; },
    set backIntensity(v: number | null) { backOverride = v; },
    get heading() { return group.rotation.y; },
    set heading(v: number | null) { headingOverride = v; },
    update(time: number) {
      shared.uTime.value = time;
      group.rotation.y = headingOverride ?? autoHeading(time);
      backIntensity.value = backOverride ?? backPulse(time);
      backLight.intensity = BACK_LIGHT * backIntensity.value;
    },
  };
}
