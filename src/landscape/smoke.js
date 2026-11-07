import * as THREE from 'three';

// Chimney smoke as long curling wisps.
//
// Each strand is a thin ribbon whose whole shape is computed in the vertex
// shader from (position along the strand, time):
//   - a sideways wave whose amplitude grows with height (sway), and
//   - a vertical wave of growing amplitude. Once that is big enough relative
//     to the wavelength, the path folds back on itself: a trochoid, which is
//     what draws the loops and curls.
// The waves travel upward, so curls form near the chimney and rise away.
// The ribbon always turns its flat side to the camera, widens and fades with
// height. Several strands with different seeds wind around each other.

const vertexShader = /* glsl */ `
  attribute float aS;     // 0 at the chimney, 1 at the tip
  attribute float aSide;  // -1 / 1 across the ribbon
  uniform float uTime;
  uniform float uLength;
  uniform float uSeed;
  uniform float uSpeed;
  uniform float uFreq;
  uniform float uCurl;
  uniform float uSway;
  uniform float uWidth;
  uniform float uDrift;
  uniform vec3 uOrigin;
  uniform vec3 uWind;
  varying float vS;
  varying float vSide;

  vec3 centre(float s) {
    float h = s * uLength;
    float ph = h * uFreq - uTime * uSpeed + uSeed;
    float grow = smoothstep(0.02, 0.4, s);
    float sway = 0.05 + uSway * pow(s, 1.4);
    vec3 p = uOrigin;
    // Lateral motion: two waves in x and z for a 3D wander.
    p.x += sway * (sin(ph) + 0.45 * sin(ph * 0.53 + uSeed * 1.7));
    p.z += sway * (cos(ph * 0.9 + 0.6) + 0.4 * cos(ph * 0.41 + uSeed));
    // Vertical fold-back: loops appear where uCurl * grow * uFreq > 1.
    p.y += h - uCurl * grow * cos(ph);
    // Carried off by the wind higher up.
    p += uWind * uDrift * pow(s, 1.7);
    return p;
  }

  void main() {
    vS = aS;
    vSide = aSide;
    vec3 c = centre(aS);
    vec3 t = centre(aS + 0.004) - centre(aS - 0.004);
    vec3 toCam = normalize(cameraPosition - c);
    vec3 across = normalize(cross(t, toCam));
    float width = uWidth * (0.25 + 1.6 * aS) * smoothstep(0.0, 0.03, aS);
    vec3 pos = c + across * aSide * width * 0.5;
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uSeed;
  varying float vS;
  varying float vSide;

  float hash(float n) { return fract(sin(n) * 43758.5453); }
  float noise(float x) {
    float i = floor(x), f = fract(x);
    return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f));
  }

  void main() {
    float edge = 1.0 - pow(abs(vSide), 2.2);                // soft ribbon edges
    float along = smoothstep(0.0, 0.04, vS) * pow(1.0 - vS, 0.8); // fade to nothing
    // Breaks the strand up slightly so it thins and thickens as it rises.
    float streak = 0.65 + 0.35 * noise(vS * 22.0 - uTime * 1.4 + uSeed * 10.0);
    float a = edge * along * streak * uOpacity;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }
`;

function strandGeometry(segments) {
  const count = (segments + 1) * 2;
  const s = new Float32Array(count);
  const side = new Float32Array(count);
  const indices = [];
  for (let i = 0; i <= segments; i++) {
    s[i * 2] = s[i * 2 + 1] = i / segments;
    side[i * 2] = -1;
    side[i * 2 + 1] = 1;
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  // three needs a position attribute; the real position comes from the shader.
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aS', new THREE.BufferAttribute(s, 1));
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  geo.setIndex(indices);
  return geo;
}

export function createSmoke(anchor, {
  wind = new THREE.Vector3(1, 0, -0.35).normalize(),
  color = '#c3cbdc',
  strands = [
    // length, width, curl, sway, speed, freq, drift, opacity, seed
    // Loops form where curl * freq > 1; wavelength = 2π / freq.
    { length: 12, width: 0.5, curl: 1.15, sway: 1.4, speed: 1.3, freq: 1.55, drift: 4.0, opacity: 0.8, seed: 0.0 },
    { length: 10, width: 0.34, curl: 0.95, sway: 1.1, speed: 1.5, freq: 1.8, drift: 3.4, opacity: 0.6, seed: 2.3 },
    { length: 8, width: 0.24, curl: 0.8, sway: 0.9, speed: 1.2, freq: 2.1, drift: 2.8, opacity: 0.45, seed: 4.9 },
  ],
} = {}) {
  const origin = new THREE.Vector3();
  anchor.updateWorldMatrix(true, false);
  anchor.getWorldPosition(origin);

  const group = new THREE.Group();
  group.name = 'chimneySmoke';
  const time = { value: 0 };
  const geo = strandGeometry(260);

  for (const st of strands) {
    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: time,
        uOrigin: { value: origin },
        uWind: { value: wind },
        uColor: { value: new THREE.Color(color) },
        uLength: { value: st.length },
        uWidth: { value: st.width },
        uCurl: { value: st.curl },
        uSway: { value: st.sway },
        uSpeed: { value: st.speed },
        uFreq: { value: st.freq },
        uDrift: { value: st.drift },
        uOpacity: { value: st.opacity },
        uSeed: { value: st.seed },
      },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; // shape lives in the shader
    group.add(mesh);
  }

  return {
    object: group,
    update(t) { time.value = t; },
  };
}
