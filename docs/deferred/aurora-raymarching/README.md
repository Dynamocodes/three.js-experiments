# Deferred: volumetric (raymarched) aurora

**Status:** deferred. Built, working, and verified in the browser, then set
aside. The live aurora went back to the simpler sheet version: three
left-to-right ribbons whose shared direction slowly swings. Everything needed
to bring the volumetric version back is in this folder.

**Note:** this archive also holds the only copy of the *procedural curtain
system* (section 3.1): curtains running from the back toward the viewer,
growing, streaming away and respawning with random shapes, with noise in
height, brightness, softness and thickness. None of that is in the live code
any more. Copying `aurora.js` from here brings it back together with the
volume.

| File | What it is |
| --- | --- |
| `README.md` | This document. |
| `aurora.js` | The complete volumetric aurora module, a drop-in replacement for `src/landscape/aurora.js`. |
| `index.js.patch` | The small render-loop change it needs in `src/landscape/index.js`. |

---

## 1. Why it was built

The sheet aurora (`src/landscape/aurora.js`) draws each curtain as a flat
ribbon. A ribbon has no thickness, which shows when a curtain turns edge-on to
the camera. The first fix tried was stacking three sheets a few units apart.
That looked thick from some angles and fell apart from others, because the
separate sheets became visible.

Three directions were considered:

1. **View-angle brightening.** Make a single sheet glow brighter when seen
   edge-on, which is how an optically thin emitting layer behaves. Cheap, but
   it gives no real width.
2. **A camera-facing soft strip per column.** The same trick as the chimney
   smoke: each vertical column of the curtain is a strip that faces the
   camera, with a soft falloff across its width. Cheap, works from all angles,
   and fakes thickness convincingly.
3. **True volume (raymarching).** This document.

Option 3 was built because it is the only one where thickness, overlap and
edge-on brightening all come out of the rendering itself instead of being
faked.

## 2. Outcome and why it was deferred

**What worked:**

- Thickness holds from every angle; there are no layers to separate.
- A curtain seen along its length becomes a deep, bright mass; one seen
  across it is thin and see-through. The change is smooth as curtains fold
  and turn.
- Overlapping curtains add up naturally.
- The lake reflects it.
- On an RTX 4090 at 1280×760 it added about 0.02 ms per frame (0.81 ms
  against 0.79 ms without the aurora).

**Why it was set aside:**

- **The look.** It is softer and hazier than the sheets. Curtains read as
  glowing fog rather than crisp draped curtains. The sharp lower edge and the
  fine vertical rays, which were a big part of the original's appeal, get
  averaged out along long sightlines. Ray contrast was pushed hard to keep
  some of it.
- **Performance is unknown on normal hardware.** It was only measured on a
  high-end desktop GPU. A per-pixel raymarch is exactly the kind of work that
  hurts integrated GPUs and phones, which is a real risk for a website
  background.
- **Complexity.** Extra render passes, render targets, a compositing trick
  and two GPU gotchas (section 7) make it more fragile than a few meshes.

Option 2 (the soft camera-facing strip, plus option 1) is the recommended
next attempt at thickness before reviving this.

---

## 3. Architecture overview

Three stages run every frame:

```
 update(time)            prepare(renderer, camera)                   renderer.render(scene, camera)
 ────────────            ─────────────────────────                   ──────────────────────────────
 curtain life cycle  ─▶  1. footprint pass: curtains drawn       ─▶  3. composite: a screen quad at the
 (spawn, grow, fade)        top-down into a float map                   far plane shows the low-res result
 heading wander          2. march pass: raymarch the sky at             behind everything opaque
                            half resolution into a texture           (mirror cameras, i.e. the lake,
                                                                        raymarch directly instead)
```

Everything lives in one module with the same public API as the live aurora
(`object`, `intensity`, `heading`, `update(time)`), plus two additions:
`prepare(renderer, camera)` and `dispose()`. One difference: in this version
`heading` is the direction new curtains run in, measured from straight
toward the viewer, while in the live version it is the swing of the
left-to-right band.

### 3.1 Curtains (procedural; shared with the earlier sheet experiment, not in the live code)

- **Pool:** `count` curtains (default 5). Each starts far behind the hills
  (z ≈ -430 to -360) and runs toward the viewer for 240–380 units.
- **Lanes:** curtains are spread left to right across `spread` (±150) so they
  don't pile up.
- **Shape:** each curtain is a CatmullRom curve that meanders sideways with
  two sine waves of random amplitude, frequency and phase, giving S-curves and
  hooks.
- **Heading:** a shared direction wanders slowly, up to `maxTurn` (0.35 rad)
  either side of straight-on. Each new curtain picks it up, ±0.12 rad.
- **Life cycle** (all in seconds, random per curtain):
  - `grow` (14–24): the near end extends out of the distance.
  - `hold` (30–70): full length.
  - `fade` (14–24): the far end lets go and the curtain streams forward.
  - `rest` (2–10): gap, then it respawns with a new random shape.
- **Stagger:** starting ages are staggered so the sky isn't empty on load.
- **Shader uniforms:** the life cycle reaches the shader as `uHead` and
  `uTail`, with `smootherstep` easing.

### 3.2 Footprint map (pass 1)

Each curtain is drawn as a flat strip into a top-down map:

- **Target:** a 1024×1024 `HalfFloatType` render target, `mapSize`.
- **Area covered:** world x from -420 to 420 and z from -470 to 70 (the
  `BOUNDS` constant). That is about 0.8 × 0.5 world units per texel.
- **Geometry:** the strip is 300 segments along the curve and two vertices
  across it (uv.y = -1 and 1). Each vertex carries `aFold` (horizontal, across
  the curtain) and `aTangent` (horizontal, along it).
- **Vertex shader:**
  - Widens the strip across by `uThick × (0.5 + thickNoise) × 2.2`, so
    thickness varies along the curtain with slow fbm noise.
  - Applies the same fold and sway motion as the procedural sheet experiment: a large
    sideways fold that travels toward the viewer, plus smaller wobbles.
  - Writes world xz straight to clip space:
    `gl_Position = vec4((p.xz - uMin) / uSize * 2.0 - 1.0, 0.0, 1.0)`. No
    camera is involved, so the `THREE.Camera` passed to `render()` is only a
    placeholder.
- **Fragment shader:** writes one texel of curtain data.
  - Density across the curtain: `dens = exp(-across² × 4.8)`, a Gaussian
    falloff. This is what gives the curtain its soft thickness.
  - The same per-curtain noise as the procedural sheet experiment: bands that flow toward
    the viewer (`present`), brightness (`bright`, 0.6–1.35), height (`tall`,
    35–115 % of the curtain's height) and edge softness (`soft`).
  - The `ends` and `life` masks.
  - Output, with `k = dens × present × bright × ends × life × strength × intensity`:

    | Channel | Value |
    | --- | --- |
    | r | `k` |
    | g | `k × height` |
    | b | `k × soft` |
    | a | 1 (unused) |

- **Blending:** additive (`CustomBlending`, One + One), so overlapping
  curtains add up. Dividing g/r and b/r recovers the density-weighted average
  height and softness at any texel, even where curtains overlap.

### 3.3 Volume raymarch (pass 2)

The march draws a full-screen quad (`PlaneGeometry(2, 2)`) into a `lowRes`
`HalfFloatType` target at `resolution` × the canvas size (default 0.5). The
fragment shader `march(ro, rd)` does the following for each pixel:

1. **Builds the view ray:** `ro` is the camera position; `rd` is
   reconstructed from the projection matrix (section 7.1).
2. **Rejects** rays that don't go up (`rd.y < 0.01`).
3. **Intersects the altitude slab:** from y = `BASE - 8` (32) to `TOP` (140).
4. **Clips to the map's xz box** with a ray–box slab test, and caps the
   marched length at 900 units.
5. **Steps** `STEPS` times (64 for the main view) with a per-pixel jitter
   offset. It uses interleaved gradient noise,
   `fract(52.98 × fract(dot(fragCoord, (0.0671, 0.00584))))`, which turns the
   banding from fixed steps into fine grain.
6. **At each sample point `p`:**
   - Reads the footprint at `(p.xz - uMin) / uSize` and skips the sample if
     `r < 0.002`.
   - Recovers `height = g / r` and `soft = b / r`.
   - **Lower edge:** `base = 40 + (vnoise(p.xz × 0.015) - 0.5) × 12`, so the
     edge undulates across the sky.
   - **Height within the curtain:** `h = (p.y - base) / height`; the sample
     is skipped outside 0–1.
   - **Vertical profile:** the same as the sheet aurora. The lower edge is
     `smoothstep(0, 0.03 + 0.2 × soft, h)`; the upward fade is
     `pow(1 - h, mix(1.0, 2.8, 1 - soft))`.
   - **Rays:** two octaves of value noise on `p.xz` only. Because the noise
     ignores height, the rays come out as vertical columns. They scroll along
     the current heading (`uFlow`) plus a slow sideways drift, with high
     contrast: `0.15 + 2.2 × n³`.
   - **Colour:** `auroraLow` to `auroraHigh` by `h`, plus the hot green-white
     rim near the lower edge, weakened where the edge is soft.
   - **Accumulates:**
     `acc += col × density × lowerEdge × upwardFade × rays`.
7. **Soft limit:** returns `1 - exp(-acc × dt × uEmission)`. Long edge-on
   paths glow instead of clipping to flat colour. `emission` (default 0.1)
   is the overall brightness.

There is no absorption: aurora is an optically thin emitter, so emission
simply adds up.

### 3.4 Composite (pass 3)

A second quad with the same shader sits in the scene (`skyMesh`, inside
`aurora.object`):

- **Vertex shader:** `gl_Position = vec4(position.xy, 0.9999, 1.0)`, a
  full-screen quad just in front of the far plane.
- **Depth test:** on, with depth writes off. It only shows where nothing
  opaque has written depth, so trees, hills and the cabin hide it.
- **Blending:** additive over the sky dome.
- **Draw order:** `renderOrder = -1`, so it draws before snow and smoke.
- **Per camera, via `onBeforeRender(renderer, scene, camera)`:**
  - **Main camera** (the one passed to `prepare`): samples the low-res
    texture at `gl_FragCoord.xy / uResolution`, with bilinear upsampling.
  - **Any other camera** (the Reflector's mirror camera for the lake):
    raymarches directly with `reflectionSteps` (28). The mirror view renders
    at half resolution already, so this is cheap.

Two things in the existing scene make this work:

- The sky dome and stars already have `depthWrite: false` (`sky.js`). The
  depth buffer stays at 1.0 in the sky, so the far-plane quad passes the
  depth test there. If the dome ever writes depth, the aurora disappears.
- The renderer's default depth function is `LessEqual`.

### 3.5 Render-loop integration

`prepare(renderer, camera)` has to run before every `renderer.render(scene,
camera)`. See `index.js.patch`: all four render calls in `index.js` go through
a `draw()` helper:

```js
const draw = () => {
  aurora.prepare(renderer, camera);
  renderer.render(scene, camera);
};
```

The four calls are the animation tick, the reduced-motion still frame, the
redraw after assets load, and the redraw on resize. `dispose()` is also
called from the landscape's `dispose()`, because the footprint scene and both
render targets are not part of the main scene.

`prepare` performs these steps:

1. Saves the render target, clear colour and clear alpha.
2. Clears to transparent black.
3. Renders the footprint scene into `footTarget`.
4. Resizes `lowRes` if the canvas size changed.
5. Updates the march camera uniforms.
6. Renders the march quad into `lowRes`.
7. Restores the saved state.

---

## 4. Parameters

All parameters are options of `createAurora(rng, { ... })`:

| Option | Default | Effect |
| --- | --- | --- |
| `count` | 5 | Number of curtains alive at once. |
| `maxTurn` | 0.35 | How far (rad) the shared heading wanders either side of straight-on. |
| `turnSpeed` | 0.015 | Speed of that wander. |
| `spread` | 150 | Width of the lanes curtains start in. |
| `resolution` | 0.5 | Main-view march resolution as a fraction of the canvas. The biggest performance lever. |
| `steps` | 64 | March steps, main view. Fewer is faster but grainier, and thin curtains can be missed. |
| `reflectionSteps` | 28 | March steps for the lake reflection. |
| `emission` | 0.1 | Overall glow before the soft limit. |
| `mapSize` | 1024 | Footprint map resolution. Below about 512, thin curtains alias. |

Ranges for each new curtain are in `randomCurtain()`:

| Field | Range | Meaning |
| --- | --- | --- |
| `length` | 240–380 | Curtain length. |
| `height` | 40–75 | Curtain height. |
| `thick` | 4–9 | Base thickness; the strip's half-width is about `thick × (0.5–1.5) × 2.2`. |
| `strength` | 0.5–1.0 | Brightness. |
| `grow`, `hold`, `fade`, `rest` | see 3.1 | Life-cycle timings. |

Constants at the top of the file:

- `BOUNDS`: the map area. Grow it if curtains are made longer or spread wider.
- `BASE` (40): the average lower-edge altitude.
- `TOP` (140): the top of the march band.

## 5. Cost model

- **Footprint pass:** 5 strips of 300 segments into a 1024² half-float target.
  Negligible.
- **Main march:** for each low-res pixel whose ray goes upward,
  `steps` × (1 texture fetch + about 3 value-noise evaluations for samples
  inside a curtain). Pixels looking at the ground leave early. At 1080p with
  pixel ratio 1.5 and `resolution` 0.5, that is about 1.2 M pixels, roughly
  half of them sky.
- **Reflection march:** `reflectionSteps` per pixel of the lake's half-res
  mirror target, where the lake is visible.
- **Memory:** about 8 MB for the footprint map, plus the low-res target.

**Measured:** RTX 4090, 1280×760 canvas, pixel ratio 1: 0.81 ms per frame with
the aurora against 0.79 ms without. That was timed in the browser with
`gl.finish()`, so it is a rough number. **No measurement exists for
integrated, mobile or older GPUs.**

## 6. Known look issues

- **Haze instead of crisp curtains.** The lower edge blurs because each
  curtain is a thick Gaussian slab seen from below at an angle. Thinner `thick`
  values sharpen it but bring back the thin-sheet look.
- **Rays wash out.** A ray through a curtain seen lengthwise crosses many ray
  columns, and they average out. High contrast (`n³`) helps but doesn't fully
  fix it. Real aurora has this effect too, but the stylised original read
  better.
- **Grain.** The per-pixel jitter is fixed in screen space and visible as fine
  grain, especially in the reflection's 28-step march.
- **Soft silhouettes.** Bilinear upsampling at half resolution softens where
  the aurora meets treetops. The full-resolution depth test hides most of it.

## 7. Gotchas found while building it

### 7.1 Mirror cameras use an oblique projection

`three/addons/objects/Reflector.js` copies the camera's projection matrix and
rewrites its third row so the near plane becomes the water plane (oblique
near-plane clipping). Reconstructing the view ray with
`inverse(projection) × (ndc, 1, 1)` then breaks: the skewed far plane can put
that point behind the camera, the ray flips downward, and the lake showed no
aurora at all.

**Fix:** build the view ray only from the parts of the projection the
Reflector doesn't touch, the x/y scale and offset:

```glsl
vec3 view = vec3((ndc.x + P[2][0]) / P[0][0], (ndc.y + P[2][1]) / P[1][1], -1.0);
vec3 rd = normalize(mat3(cameraWorld) * view);
```

### 7.2 Feedback loop on the low-res target

The march material and the composite material share one shader. The march
pass renders into `lowRes`, and its material also has a `uLowRes` sampler,
which goes unused there because a branch skips it. WebGL still raises a
"feedback loop" error if that texture is bound while it is the render
target. **Fix:** set `marchMat.uniforms.uLowRes.value = null`.

### 7.3 GLSL vector comparisons

`abs(v) < vec2(x) ? a : b` doesn't compile: `<` is only defined for scalars
in GLSL ES. Compare per component, or use `lessThan()` with `mix()`.

### 7.4 Uniforms set in `onBeforeRender`

These do reach the GPU. `onBeforeRender` runs before three binds the
material, and three re-uploads ShaderMaterial uniforms on the first draw of
each `render()` call. The lake's mirror pass is a separate `render()` call,
so the composite mesh correctly gets the mirror camera there.

### 7.5 Vite hot reload on Windows

During development, Vite sometimes served a stale timestamped module URL
after several quick edits, so the page ran half-edited code. `touch`-ing the
file and doing a full reload fixed it. This isn't specific to this feature,
but it cost time while verifying it.

## 8. How to bring it back

1. Copy `docs/deferred/aurora-raymarching/aurora.js` over
   `src/landscape/aurora.js`.
2. Apply the render-loop change from the project root:

   ```bash
   git apply docs/deferred/aurora-raymarching/index.js.patch
   ```

   If the patch no longer applies, make the change by hand. Add the `draw()`
   helper (section 3.5), route all four `renderer.render(scene, camera)` calls
   through it, and call `aurora.dispose()` in `dispose()`.
3. Check that `sky.js` still has `depthWrite: false` on the dome and the
   stars (section 3.4).
4. Verify:
   - The aurora shows above the treeline and is hidden by trees and hills.
   - The lake reflects it.
   - The console shows no shader or feedback-loop errors.
   - Reduced motion (`prefers-reduced-motion`) still renders a still frame
     with the aurora.

## 9. Ideas if it is revisited

- **Adaptive quality:** measure frame time and lower `resolution` and `steps`
  on slow devices, or fall back to the sheet aurora.
- **Temporal accumulation:** jitter the step offset per frame and blend with
  the previous frame (reprojected). That keeps quality at fewer steps per
  frame and removes the grain.
- **Directional rays:** store the local curtain direction in the footprint's
  free alpha channel and stretch the ray noise along it. Rays would then
  follow each curtain instead of being world-aligned blobs.
- **Sharper lower edge:** use a sharper falloff across the curtain than a
  Gaussian (for example a smoothstep with a plateau). The curtain would have
  a dense core and a crisp edge while keeping some thickness.
- **Empty-space skipping:** build a low-resolution max-density mip of the
  footprint and take big steps where it is empty.
- **Edge-aware upsampling:** a depth-aware (bilateral) upsample would keep
  silhouettes crisp at lower `resolution`.
- **Hybrid:** keep the sheet aurora for the crisp lower edge and rays, and add
  a cheap low-step volume as a soft glow halo around it.
