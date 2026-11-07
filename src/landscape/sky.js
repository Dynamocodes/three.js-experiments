import * as THREE from 'three';
import { palette } from './palette.js';

export function createSky(rng) {
  const group = new THREE.Group();
  group.name = 'sky';

  // Gradient dome. Horizon colour matches the fog so far hills melt into it.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(600, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color(palette.skyZenith) },
        uHorizon: { value: new THREE.Color(palette.skyHorizon) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        varying vec3 vDir;
        void main() {
          float h = pow(smoothstep(-0.02, 0.55, vDir.y), 0.6);
          gl_FragColor = vec4(mix(uHorizon, uZenith, h), 1.0);
          #include <colorspace_fragment>
        }
      `,
    }),
  );
  dome.renderOrder = -2;
  group.add(dome);

  // Stars: points on the upper hemisphere that twinkle in the shader.
  const COUNT = 1800;
  const positions = new Float32Array(COUNT * 3);
  const sizes = new Float32Array(COUNT);
  const phases = new Float32Array(COUNT);
  const v = new THREE.Vector3();
  for (let i = 0; i < COUNT; i++) {
    do {
      v.set(rng() * 2 - 1, rng(), rng() * 2 - 1);
    } while (v.lengthSq() > 1 || v.y < 0.04);
    v.normalize().multiplyScalar(560);
    positions.set([v.x, v.y, v.z], i * 3);
    sizes[i] = rng() < 0.05 ? rng() * 2 + 2.2 : rng() * 1.4 + 0.6;
    phases[i] = rng() * Math.PI * 2;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const starMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vec3 dir = normalize(position);
        vAlpha = smoothstep(0.04, 0.3, dir.y) * (0.65 + 0.35 * sin(uTime * 1.7 + aPhase));
        gl_PointSize = aSize * uPixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vAlpha;
        gl_FragColor = vec4(vec3(0.9, 0.94, 1.0), a);
        #include <colorspace_fragment>
      }
    `,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -1;
  group.add(stars);

  return {
    object: group,
    update(time) {
      starMat.uniforms.uTime.value = time;
    },
    setPixelRatio(pr) {
      starMat.uniforms.uPixelRatio.value = pr;
    },
  };
}
