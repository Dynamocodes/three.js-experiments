import * as THREE from 'three';
import { palette } from './palette.js';

// Northern lights: a few tall ribbons following curves far behind the hills.
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

function ribbonGeometry(curve, height, segments) {
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

export function createAurora(rng, {
  maxTurn = 0.6, // radians either side of left-to-right
  turnSpeed = 0.02, // how fast the heading wanders
} = {}) {
  const group = new THREE.Group();
  group.name = 'aurora';
  group.position.copy(PIVOT);
  // Ribbons are built in world coordinates; this offsets them so the outer
  // group's rotation happens around PIVOT.
  const ribbonsGroup = new THREE.Group();
  ribbonsGroup.position.copy(PIVOT).negate();
  group.add(ribbonsGroup);

  const shared = {
    uTime: { value: 0 },
    uIntensity: { value: 1 },
    uColorLow: { value: new THREE.Color(palette.auroraLow) },
    uColorHigh: { value: new THREE.Color(palette.auroraHigh) },
  };

  const ribbons = [
    { z: -230, y: 38, height: 55, strength: 1.0 },
    { z: -270, y: 48, height: 65, strength: 0.7 },
    { z: -200, y: 34, height: 40, strength: 0.5 },
  ];

  for (const [index, r] of ribbons.entries()) {
    const pts = [];
    for (let k = 0; k <= 7; k++) {
      pts.push(new THREE.Vector3(-320 + (640 * k) / 7 + rng.range(-20, 20), r.y + rng.range(-6, 6), r.z + rng.range(-45, 45)));
    }
    const curve = new THREE.CatmullRomCurve3(pts);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        ...shared,
        uSeed: { value: index * 17.3 + rng() * 10 },
        uStrength: { value: r.strength },
      },
      vertexShader: /* glsl */ `
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
      `,
      fragmentShader: /* glsl */ `
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
      `,
    });

    const mesh = new THREE.Mesh(ribbonGeometry(curve, r.height, 400), mat);
    mesh.frustumCulled = false; // vertices move in the shader
    ribbonsGroup.add(mesh);
  }

  // A faint green light so the aurora actually tints the snow.
  const light = new THREE.DirectionalLight(palette.auroraLow, 0.5);
  light.position.set(0, 60, -200);
  ribbonsGroup.add(light);

  // Heading: null = automatic slow wander; a number (radians) pins it.
  let headingOverride = null;
  const autoHeading = (t) =>
    maxTurn * (0.7 * Math.sin(t * turnSpeed) + 0.3 * Math.sin(t * turnSpeed * 2.3 + 1.7));

  return {
    object: group,
    get intensity() { return shared.uIntensity.value; },
    set intensity(v) {
      shared.uIntensity.value = v;
      light.intensity = 0.5 * v;
    },
    get heading() { return group.rotation.y; },
    set heading(v) { headingOverride = v; },
    update(time) {
      shared.uTime.value = time;
      group.rotation.y = headingOverride ?? autoHeading(time);
    },
  };
}
