# Revontulet: a low-poly Lapland night

A live three.js scene used as a website background: a snowy Finnish lake
under the northern lights, with a log cabin, a lakeside sauna, a pier, crown-snow forest,
falling snow and ambient sound. Moving the mouse shifts the camera slightly,
so the 3D depth gives parallax for free.

Built with Vite, TypeScript and three.js. No framework: `createLandscape()`
mounts on any canvas and returns `dispose()`, so it drops into React, Next.js
or plain HTML.

## Running it

```bash
npm install
```

```bash
npm run dev
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload. |
| `npm run typecheck` | TypeScript check (strict), no output files. |
| `npm run build` | Type-check, then build to `dist/`. |
| `npm run preview` | Serve the built `dist/` locally. |

In development, `landscape` and `ambience` are on `window` for poking at
things from the console, e.g. `landscape.aurora.heading = 0.3` or
`ambience.wolves()`.

### Framing the camera and placing the props

Two dev-only editors, each saving only its own file:

- **C: camera editor.** Frame the resting shot. **Save camera** writes
  `src/landscape/camera/framing.json`.
- **P: prop editor.** Move and turn the props: cabin, woodpile (it moves
  with the cabin), pier, snowman, sauna. **Save layout** writes
  `src/landscape/layout.json`. The camera flies freely here to get a good
  look, but that view is never saved; closing returns to the saved framing.

The buttons at the bottom left do the same. Pressing the other key switches
editor; the same key, **Close** or Esc closes it. Keys go by their place on
the keyboard, so on AZERTY they are Z Q S D and A E; the panel shows your
keyboard's letters.

| Input | Flying the camera | Selected prop (prop editor) |
| --- | --- | --- |
| Drag | Look around (turns in place) | Drag the prop: move it over the ground |
| Right-drag or Shift-drag | Slide sideways and up/down | (same) |
| Wheel | Move forward/back | (same) |
| W A S D (Z Q S D) | Move along the ground | Move it, as seen from the camera |
| Q E (A E) | Down/up | Turn it |
| Esc | Close | Let go of it |

Click a prop, or its name in the panel, to select it. Shift gives bigger
steps. After saving, the page reloads and each prop is grounded properly
again (the pier's snowdrift, for example, is rebuilt). **Revert** puts back
what that editor saved; closing drops unsaved prop moves. The editors and
their save endpoint (in `vite.config.ts`) only exist in development.

## Layout

```
index.html                 page: background canvas, placeholder content, sound button
src/
  main.ts                  page entry: mounts the scene, wires the sound button
  styles/main.css
  dev/devTools.ts          dev only: the editors' launcher, panel and saving
  dev/freeCamera.ts        dev only: the fly-through camera both editors use
  dev/cameraEditor.ts      dev only: camera editor (C), saves framing.json
  dev/propEditor.ts        dev only: prop editor (P), saves layout.json
  audio/ambience.ts        wind, owls, wolves (Web Audio)
  assets/                  drop-in models and sounds, see src/assets/README.md
  landscape/               the 3D scene
    index.ts               createLandscape(): builds the scene, runs the loop
    layout.json            where the props stand (written by the dev tool)
    palette.ts             scene colours
    types.ts               shared types (Terrain, Updatable, Circle)
    world/                 terrain, lake (mirror), sky dome and stars
    effects/               aurora, snowfall, shooting stars, chimney smoke
    props/                 placing things in the world: cabin + woodpile, sauna, pier, snowman, trees
    models/                standalone model builders: log cabin, sauna, woodpile, pier, snowman, snow trees, snow rocks
    interactions/          things the visitor can do: throw snowballs
    camera/                camera rig (pointer parallax, idle drift), default framing.json
    loaders/               GLB loading for drop-in models
    utils/                 seeded random, math helpers
docs/
  deferred/                experiments set aside, with write-ups
```

**`models/` vs `props/`:** a model builder makes an object at the origin and
knows nothing about the scene; it could be reused anywhere. A prop places a
model in this landscape: on the terrain, facing the camera, clear of other
things.

## Conventions

- **Deterministic:** everything random comes from a seeded generator
  (`utils/random.ts`), so the same seed always gives the same scene.
- **Grounding:** to sit something on the ground use `terrain.surfaceAt()`,
  the height of the triangle actually drawn. `heightAt()` is the smooth
  formula, which can be half a unit off on slopes.
- **Shaders** are inline GLSL strings next to the code that uses them.
- **Snowball hits:** give any object a `userData.onSnowballHit(point, normal)`
  function and it reacts when a snowball lands on it (the snowman wobbles).
  It also has to be one of the snowball `targets` in `landscape/index.ts`.
- **Performance:** no real-time shadows; repeated objects are instanced;
  rendering pauses when the tab is hidden; `prefers-reduced-motion` gets a
  single still frame.
