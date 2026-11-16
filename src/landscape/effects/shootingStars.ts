import * as THREE from 'three';
import { createRng, type Rng } from '../utils/random';

// Occasional shooting stars: a quick streak with a bright head and a fading
// tail, now and then followed by a second one, like a small shower.
//
// Each meteor is a thin ribbon whose shape lives in the vertex shader: points
// along it trail behind the head, and it always turns its flat side to the
// camera. The CPU only moves a few uniforms per frame.

const vertexShader = /* glsl */ `
  attribute float aS;    // 0 at the tail tip, 1 at the head
  attribute float aSide; // -1 / 1 across the streak
  uniform vec3 uStart;
  uniform vec3 uDir;
  uniform float uHead;   // how far the head has travelled
  uniform float uTail;
  uniform float uWidth;
  varying float vS;
  varying float vSide;
  varying float vShown;
  void main() {
    float d = uHead - (1.0 - aS) * uTail;
    vShown = step(0.0, d);          // the tail never reaches back past the start
    vec3 p = uStart + uDir * max(d, 0.0);
    vec3 across = normalize(cross(uDir, cameraPosition - p));
    p += across * aSide * uWidth * mix(0.12, 1.0, aS) * 0.5;
    vS = aS;
    vSide = aSide;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uAlpha;
  uniform vec3 uHeadColor;
  uniform vec3 uTailColor;
  varying float vS;
  varying float vSide;
  varying float vShown;
  void main() {
    float edge = 1.0 - vSide * vSide;
    float along = pow(vS, 3.5); // the tail fades out fast behind the head
    vec3 col = mix(uTailColor, uHeadColor, pow(vS, 6.0));
    gl_FragColor = vec4(col, edge * along * uAlpha * vShown);
    #include <colorspace_fragment>
  }
`;

function streakGeometry(segments: number) {
  const count = (segments + 1) * 2;
  const s = new Float32Array(count);
  const side = new Float32Array(count);
  const indices: number[] = [];
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

interface Meteor {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  start: number; // time it appears
  duration: number;
  travel: number;
  /** Brightness at its peak, 0..1. */
  peak: number;
}

export interface ShootingStarOptions {
  /** Seconds between showers, [min, max]. */
  interval?: [number, number];
  /** Chance a shower has a second meteor right after the first. */
  pairChance?: number;
  /** Distance of the streaks from the centre of the scene. */
  distance?: number;
}

export function createShootingStars(seedRng: Rng, {
  interval = [8, 25],
  pairChance = 0.2,
  distance = 480,
}: ShootingStarOptions = {}) {
  // Own generator, so meteor timing doesn't shift anything else's randomness.
  const rng = createRng(Math.floor(seedRng() * 2 ** 31));
  const group = new THREE.Group();
  group.name = 'shootingStars';
  const geometry = streakGeometry(32);

  const meteors: Meteor[] = [0, 1, 2].map(() => {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uStart: { value: new THREE.Vector3() },
        uDir: { value: new THREE.Vector3(1, 0, 0) },
        uHead: { value: 0 },
        uTail: { value: 40 },
        uWidth: { value: 1 },
        uAlpha: { value: 0 },
        uHeadColor: { value: new THREE.Color('#e6eeff') },
        uTailColor: { value: new THREE.Color('#9fc4ff') },
      },
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false; // shape lives in the shader
    mesh.visible = false;
    mesh.renderOrder = -1; // with the stars, behind snow and smoke
    group.add(mesh);
    return { mesh, start: -Infinity, duration: 1, travel: 0, peak: 0 };
  });

  const toRad = THREE.MathUtils.degToRad;
  const up = new THREE.Vector3(0, 1, 0);

  /** Starts a meteor at `time` somewhere in the visible sky. */
  function launch(m: Meteor, time: number) {
    // Inside the resting view (toward -z): between the treeline (~10 deg up)
    // and the top of the frame (~22 deg), so most of each streak is seen.
    const azimuth = toRad(rng.range(-32, 32));
    const elevation = toRad(rng.range(12, 21));
    const dir = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      -Math.cos(azimuth) * Math.cos(elevation),
    );
    const start = dir.clone().multiplyScalar(distance);
    // Travel down and sideways across the sky (tangent to it).
    const right = new THREE.Vector3().crossVectors(dir, up).normalize();
    const down = new THREE.Vector3().crossVectors(right, dir).negate().normalize();
    const angle = toRad(rng.range(18, 55));
    const sideways = rng() < 0.5 ? -1 : 1;
    const motion = right.multiplyScalar(Math.cos(angle) * sideways).addScaledVector(down, Math.sin(angle));

    const u = m.mesh.material.uniforms;
    u.uStart.value.copy(start);
    u.uDir.value.copy(motion.normalize());
    // Real ones are a glance: a short, faint, thin flick, gone before your
    // eyes get there. The tail is barely more than the head's smear.
    u.uTail.value = rng.range(10, 22);
    u.uWidth.value = rng.range(0.45, 0.7);
    // Mostly white-blue; now and then a greenish one.
    u.uTailColor.value.set(rng() < 0.25 ? '#86cfae' : '#7f9cc8');
    m.start = time;
    m.duration = rng.range(0.18, 0.4);
    m.travel = rng.range(25, 55);
    m.peak = rng.range(0.45, 0.8); // some are barely there
  }

  // The first shower comes a while after load (also keeps the reduced-motion
  // still frame clean).
  let next = rng.range(10, 18);

  return {
    object: group,
    /** Starts a shower now (handy from the devtools console). */
    trigger(time: number) { next = time; },
    update(time: number) {
      if (time >= next) {
        const free = meteors.filter((m) => time > m.start + m.duration);
        if (free[0]) launch(free[0], time);
        if (free[1] && rng() < pairChance) launch(free[1], time + rng.range(0.25, 1.2));
        next = time + rng.range(interval[0], interval[1]);
      }
      for (const m of meteors) {
        const t = (time - m.start) / m.duration;
        m.mesh.visible = t >= 0 && t <= 1;
        if (!m.mesh.visible) continue;
        const u = m.mesh.material.uniforms;
        // Decelerates a little; flicks on almost at once, then fades out.
        u.uHead.value = m.travel * (1 - (1 - t) ** 1.6);
        u.uAlpha.value = m.peak * THREE.MathUtils.smoothstep(t, 0, 0.06) * (1 - THREE.MathUtils.smoothstep(t, 0.35, 1));
      }
    },
  };
}
