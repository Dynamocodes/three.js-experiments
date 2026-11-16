import * as THREE from 'three';

// Steam off open hot water in freezing air.
//
// Not a plume from one point: soft puffs rise from all over the water
// surface, spread out and slow down as they cool, lean with the wind and
// thin away to nothing. A share of them stay low and wide, so a mist hugs
// the water. Each puff loops through its life in the vertex shader and comes
// back somewhere else on the surface, so there's no per-frame CPU work.

const vertexShader = /* glsl */ `
  attribute vec4 aSeed;     // phase, place, place, kind
  uniform float uTime;
  uniform float uLife;
  uniform float uRise;
  uniform float uRadius;
  uniform float uSize;
  uniform float uDrift;
  uniform float uOpacity;
  uniform float uPxPerUnit; // pixels per world unit at distance 1
  uniform vec3 uOrigin;
  uniform vec3 uWind;
  varying float vAlpha;
  varying float vSeed;
  varying float vAge;

  float hash(float n) { return fract(sin(n) * 43758.5453); }

  void main() {
    // Mist puffs (kind < 0.25) live longer, stay low and spread wide.
    float mist = step(aSeed.w, 0.25);
    float life = uLife * mix(1.0, 1.6, mist);
    float cyc = uTime / life + aSeed.x;
    float age = fract(cyc);
    float n = floor(cyc); // new spot on the water every lifetime

    float ang = hash(aSeed.y * 91.7 + n * 13.13) * 6.2832;
    float r = sqrt(hash(aSeed.z * 47.3 + n * 7.71)) * uRadius * 0.92;
    float h = hash(aSeed.w * 23.9 + n * 3.37);
    vec3 p = uOrigin + vec3(cos(ang) * r, 0.0, sin(ang) * r);

    // Rises fast off the water, then slows as it cools.
    float rise = uRise * life * mix(1.0, 0.18, mist) * (0.7 + 0.6 * h);
    p.y += rise * (age - 0.42 * age * age);
    // Spreads out from the middle, wobbles, leans with the wind.
    p.xz += normalize(p.xz - uOrigin.xz + 1e-4) * age * mix(0.25, 0.55, mist);
    p.x += 0.12 * age * sin(age * 6.0 + h * 6.28);
    p.z += 0.12 * age * cos(age * 5.0 + h * 4.1);
    p += uWind * uDrift * age * age;

    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = uSize * (0.45 + 1.3 * age) * mix(1.0, 1.5, mist) * (0.75 + 0.5 * h);
    gl_PointSize = size * uPxPerUnit * projectionMatrix[1][1] / -mv.z;

    vAlpha = uOpacity * smoothstep(0.0, 0.15, age) * pow(1.0 - age, 0.9) * mix(1.0, 0.8, mist) * (0.6 + 0.4 * h);
    vSeed = h * 37.0 + n;
    vAge = age;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying float vAlpha;
  varying float vSeed;
  varying float vAge;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    // Turn each puff a different way so the wisps don't line up.
    float a = vSeed * 2.4;
    uv = mat2(cos(a), -sin(a), sin(a), cos(a)) * uv;
    float d = length(uv) * 2.0;
    float body = 1.0 - smoothstep(0.15, 1.0, d);
    // Wispy, uneven inside; the shape keeps churning as it rises.
    vec2 q = uv * 3.2 + vec2(vSeed, vSeed * 0.7);
    float wisp = vnoise(q + vec2(0.0, -vAge * 1.6)) * 0.65 + vnoise(q * 2.3 - vAge) * 0.35;
    float alpha = body * smoothstep(0.2, 0.8, wisp + 0.25 * (1.0 - d)) * vAlpha;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <colorspace_fragment>
  }
`;

export interface SteamOptions {
  /** Puffs alive at once. */
  count?: number;
  /** Radius of the water surface the steam comes off. */
  radius?: number;
  /** Seconds each puff lives. */
  life?: number;
  /** Rising speed off the water (units / s). */
  rise?: number;
  /** Puff diameter when it leaves the water (units); it grows as it rises. */
  size?: number;
  opacity?: number;
  color?: THREE.ColorRepresentation;
  /** Same wind as the chimney smoke, so they lean the same way. */
  wind?: THREE.Vector3;
  drift?: number;
  seed?: number;
}

/** Steam rising off the water whose surface centre is `anchor`. */
export function createSteam(anchor: THREE.Object3D, {
  count = 72,
  radius = (anchor.userData.radius as number | undefined) ?? 0.8,
  life = 3.4,
  rise = 0.75,
  size = 0.7,
  opacity = 0.42,
  color = '#e4eaf5',
  wind = new THREE.Vector3(1, 0, -0.35).normalize(),
  drift = 0.55,
  seed = 1,
}: SteamOptions = {}) {
  const origin = new THREE.Vector3();
  anchor.updateWorldMatrix(true, false);
  anchor.getWorldPosition(origin);

  // Evenly spread phases (plus jitter) keep the amount of steam steady.
  let s = seed * 9301 + 49297;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds.set([(i + rand() * 0.8) / count, rand() * 100, rand() * 100, rand()], i * 4);
  }
  const geometry = new THREE.BufferGeometry();
  // Positions come from the shader; three just needs the attribute.
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

  const uniforms = {
    uTime: { value: 0 },
    uLife: { value: life },
    uRise: { value: rise },
    uRadius: { value: radius },
    uSize: { value: size },
    uDrift: { value: drift },
    uOpacity: { value: opacity },
    uPxPerUnit: { value: 500 },
    uOrigin: { value: origin },
    uWind: { value: wind },
    uColor: { value: new THREE.Color(color) },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'tubSteam';
  points.frustumCulled = false; // positions live in the shader
  // Point sizes are in pixels, so they depend on what's being drawn into:
  // the screen, or a mirror's (smaller) reflection texture.
  const size2 = new THREE.Vector2();
  points.onBeforeRender = (renderer) => {
    const target = renderer.getRenderTarget();
    uniforms.uPxPerUnit.value = target ? target.height / 2 : renderer.getDrawingBufferSize(size2).y / 2;
  };

  return {
    object: points,
    update(t: number) {
      uniforms.uTime.value = t;
      // Follow the tub if its building moves (e.g. in the dev layout tool).
      anchor.updateWorldMatrix(true, false);
      anchor.getWorldPosition(origin);
    },
  };
}
