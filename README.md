# Revontulet: a low-poly Lapland night

A live three.js scene used as a website background: a snowy Finnish lake
under the northern lights, with a log cabin, a pier, crown-snow forest,
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

## Layout

```
index.html                 page: background canvas, placeholder content, sound button
src/
  main.ts                  page entry: mounts the scene, wires the sound button
  styles/main.css
  audio/ambience.ts        wind, owls, wolves (Web Audio)
  assets/                  drop-in models and sounds, see src/assets/README.md
  landscape/               the 3D scene
    index.ts               createLandscape(): builds the scene, runs the loop
    palette.ts             scene colours
    types.ts               shared types (Terrain, Updatable, Circle)
    world/                 terrain, lake (mirror), sky dome and stars
    effects/               aurora, snowfall, shooting stars, chimney smoke
    props/                 placing things in the world: cabin + woodpile, pier, snowman, trees and rocks
    models/                standalone model builders: log cabin, woodpile, pier, snowman, snow trees, snow rocks
    interactions/          things the visitor can do: throw snowballs
    camera/                camera rig (pointer parallax, idle drift)
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
