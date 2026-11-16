import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { LAKE } from './terrain';

// A mirror plane: the lake reflects the aurora, sky and treeline.
// Rendered at reduced resolution since it's a second scene render.
//
// Ripples: a snowball landing in the lake sends out rings of small waves.
// They're drawn in the water's shader (no extra geometry): each ripple bends
// the reflection and catches a little light on its wave crests. A handful
// can run at once; a new one replaces the oldest.

const MAX_RIPPLES = 8;
const RIPPLE_LIFE = 4.5; // seconds

const rippleShader = {
  name: 'LakeShader',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    time: { value: 0 },
    // x, z, start time, strength. Start far in the past = unused.
    ripples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -1e4, 0)) },
  },

  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec2 vWorld;

    #include <common>
    #include <logdepthbuf_pars_vertex>

    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vWorld = (modelMatrix * vec4(position, 1.0)).xz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,

  fragmentShader: /* glsl */ `
    #define MAX_RIPPLES ${MAX_RIPPLES}
    #define LIFE ${RIPPLE_LIFE.toFixed(2)}
    #define SPEED 2.4         // how fast the rings spread (units / s)
    #define WAVENUMBER 4.5    // 2 pi / wavelength
    #define DISTORT 0.022     // how far the reflection bends

    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform vec4 ripples[MAX_RIPPLES];
    varying vec4 vUv;
    varying vec2 vWorld;

    #include <logdepthbuf_pars_fragment>

    float blendOverlay(float base, float blend) {
      return base < 0.5 ? (2.0 * base * blend) : (1.0 - 2.0 * (1.0 - base) * (1.0 - blend));
    }
    vec3 blendOverlay(vec3 base, vec3 blend) {
      return vec3(blendOverlay(base.r, blend.r), blendOverlay(base.g, blend.g), blendOverlay(base.b, blend.b));
    }

    // Surface slope (xy, in world x / z) and height (z) of all ripples here.
    vec3 rippleField(vec2 p) {
      vec3 acc = vec3(0.0);
      for (int i = 0; i < MAX_RIPPLES; i++) {
        vec4 r = ripples[i];
        float age = time - r.z;
        if (age < 0.0 || age > LIFE) continue;
        vec2 d = p - r.xy;
        float dist = length(d);
        float front = age * SPEED;
        // A train of rings behind the leading one, lengthening as it spreads.
        float train = min(front, 1.4 + age * 0.9);
        float x = front - dist; // distance behind the leading ring
        if (x < 0.0 || x > train) continue;
        float env = smoothstep(0.0, 0.3, x) * (1.0 - x / train) // soft front, fading tail
                  * (1.0 - age / LIFE)                            // dies out
                  * r.w / (1.0 + front * 0.3);                    // spreads thinner
        float phase = x * WAVENUMBER;
        acc.z += sin(phase) * env;
        acc.xy += (d / max(dist, 1e-4)) * (-cos(phase) * WAVENUMBER * env);
      }
      return acc;
    }

    void main() {
      #include <logdepthbuf_fragment>

      vec3 wave = rippleField(vWorld);
      vec4 uv = vUv;
      // World +z is toward the camera, which is down in the reflection.
      uv.xy += vec2(wave.x, -wave.y) * DISTORT * uv.w;
      vec4 base = texture2DProj(tDiffuse, uv);
      vec3 col = blendOverlay(base.rgb, color);

      // Crests catch a cool sheen; the far-facing slopes darken a touch.
      float slope = clamp(wave.y * 0.3, -1.0, 1.0);
      col += vec3(0.55, 0.68, 0.85) * (max(wave.z, 0.0) * 0.18 + max(slope, 0.0) * 0.14);
      col *= 1.0 - max(-slope, 0.0) * 0.18;

      gl_FragColor = vec4(col, 1.0);

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

/**
 * Stops a mirror re-rendering itself while another mirror is drawing the
 * scene (the lake seeing the hot tub, or the other way round). Inside that
 * pass it shows its last frame instead, so each mirror costs one render.
 */
export function skipNestedReflections(mirror: Reflector) {
  const render = mirror.onBeforeRender;
  mirror.onBeforeRender = function (renderer, ...rest) {
    if (renderer.getRenderTarget() !== null) return;
    render.call(this, renderer, ...rest);
  };
}

/**
 * For a small mirror: renders its reflection for just the mirror's own
 * rectangle on screen instead of the whole view. A mirror texture normally
 * spans the screen, so a hot tub covering a few percent of it would get a
 * handful of texels; this gives it all of them, and the reflection pass culls
 * everything outside that small view. Falls back to the whole view when the
 * camera is right on top of the mirror.
 */
export function fitReflectionToMirror(mirror: Reflector) {
  const render = mirror.onBeforeRender;
  mirror.geometry.computeBoundingBox();
  const local = mirror.geometry.boundingBox!;
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  const saved = new THREE.Matrix4();
  const fit = new THREE.Matrix4();

  mirror.onBeforeRender = function (renderer, scene, camera, ...rest) {
    const cam = camera as THREE.PerspectiveCamera;
    box.copy(local).applyMatrix4(mirror.matrixWorld);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    let inFront = true;
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
        .applyMatrix4(cam.matrixWorldInverse);
      if (p.z > -cam.near) { inFront = false; break; }
      p.applyMatrix4(cam.projectionMatrix);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    if (!inFront) { render.call(this, renderer, scene, camera, ...rest); return; }
    // Only the part that's on screen needs texels.
    x0 = Math.max(x0, -1); x1 = Math.min(x1, 1);
    y0 = Math.max(y0, -1); y1 = Math.min(y1, 1);
    if (x0 >= x1 || y0 >= y1) return; // off screen: nothing to draw

    // Square in pixels (the texture is square), with a little margin.
    const aspect = cam.aspect ?? 1;
    const half = 0.53 * Math.max((x1 - x0) * aspect, y1 - y0);
    const sx = half / aspect, sy = half;
    // The reflection camera sees the mirror image of this view, so the
    // mirror's rectangle is flipped left to right for it.
    const cx = -(x0 + x1) / 2, cy = (y0 + y1) / 2;
    fit.set(
      1 / sx, 0, 0, -cx / sx,
      0, 1 / sy, 0, -cy / sy,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    saved.copy(cam.projectionMatrix);
    cam.projectionMatrix.premultiply(fit);
    render.call(this, renderer, scene, camera, ...rest);
    cam.projectionMatrix.copy(saved);
  };
}

export function createWater(renderer: THREE.WebGLRenderer) {
  const geo = new THREE.PlaneGeometry(LAKE.rx * 2.6, LAKE.rz * 2.6);
  const scale = 0.5;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());

  const water = new Reflector(geo, {
    color: 0x7a8aa0,
    textureWidth: Math.max(256, Math.floor(size.x * scale)),
    textureHeight: Math.max(256, Math.floor(size.y * scale)),
    clipBias: 0.003,
    shader: rippleShader,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.set(LAKE.x, LAKE.waterLevel, LAKE.z);
  water.name = 'lake';
  skipNestedReflections(water);

  const uniforms = (water.material as THREE.ShaderMaterial).uniforms;
  const slots = uniforms.ripples.value as THREE.Vector4[];
  let now = 0;
  let next = 0;

  /** Starts a ripple at (x, z), `delay` seconds from now. */
  function ripple(x: number, z: number, strength = 1, delay = 0) {
    slots[next].set(x, z, now + delay, strength);
    next = (next + 1) % MAX_RIPPLES;
  }

  // A snowball plops in: a strong ring, then a weaker one as the water settles back.
  water.userData.onSnowballHit = (point: THREE.Vector3) => {
    ripple(point.x, point.z, 1);
    ripple(point.x, point.z, 0.45, 0.28);
  };

  const resize = () => {
    renderer.getDrawingBufferSize(size);
    water.getRenderTarget().setSize(
      Math.max(256, Math.floor(size.x * scale)),
      Math.max(256, Math.floor(size.y * scale)),
    );
  };

  function update(time: number) {
    now = time;
    uniforms.time.value = time;
  }

  return { object: water, resize, ripple, update };
}
