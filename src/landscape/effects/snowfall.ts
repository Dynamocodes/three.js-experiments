import * as THREE from 'three';
import type { Rng } from '../utils/random';

// Falling snow. All the motion happens in the vertex shader, so the CPU
// does no per-frame work no matter how many flakes there are.
export function createSnowfall(rng: Rng, { count = 3500 } = {}) {
  const BOX = { minX: -60, maxX: 60, minZ: -40, maxZ: 46, height: 40 };

  const positions = new Float32Array(count * 3);
  const speed = new Float32Array(count);
  const phase = new Float32Array(count);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions.set([rng.range(BOX.minX, BOX.maxX), rng() * BOX.height, rng.range(BOX.minZ, BOX.maxZ)], i * 3);
    speed[i] = rng.range(0.8, 2.2);
    phase[i] = rng() * Math.PI * 2;
    size[i] = rng.range(0.5, 1.4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uHeight: { value: BOX.height },
      uPixelRatio: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSpeed;
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform float uHeight;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.y = mod(p.y - uTime * aSpeed, uHeight) - 2.0;
        p.x += sin(uTime * 0.5 + aPhase) * 0.8;
        p.z += cos(uTime * 0.4 + aPhase * 1.3) * 0.5;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = -mv.z;
        gl_PointSize = clamp(aSize * uPixelRatio * (45.0 / dist), 0.0, 14.0 * uPixelRatio);
        vAlpha = smoothstep(1.0, 4.0, dist) * (1.0 - smoothstep(50.0, 85.0, dist));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.15, d) * 0.85 * vAlpha;
        gl_FragColor = vec4(vec3(0.88, 0.93, 1.0), a);
        #include <colorspace_fragment>
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.name = 'snow';
  points.frustumCulled = false;

  return {
    object: points,
    update(time: number) { mat.uniforms.uTime.value = time; },
    setPixelRatio(pr: number) { mat.uniforms.uPixelRatio.value = pr; },
  };
}
