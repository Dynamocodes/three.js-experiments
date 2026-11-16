# Drop-in assets

Files you put here are picked up automatically at build time; no code changes
needed. Until a folder has files, the scene uses its built-in stand-in.

Create the folder when you add the first file: git doesn't keep empty folders,
which is why none exist yet.

## Models (`models/<category>/*.glb`)

| Folder | Replaces | Notes |
| --- | --- | --- |
| `models/rock/` | the procedural shore rocks | Several files = several variants; rocks are spread across them. Scaled to about 1.1 units tall. |
| `models/cabin/` | the log cabin's meshes | The first file (by name) is used, scaled to 5.5 units tall. The window light, smoke and woodpile stay. |

- `.glb` or `.gltf`. Meshopt compression is supported
  (`gltf-transform optimize --compress meshopt`); Draco is not.
- Export scale doesn't matter: each model is re-centred on its base and
  scaled to the height above.
- Loading code: `src/landscape/loaders/models.ts`; where they're used:
  `src/landscape/props/vegetation.ts` (rocks) and `src/landscape/index.ts` (cabin).

## Sounds (`sounds/<category>/*`)

| Folder | Replaces |
| --- | --- |
| `sounds/owl/` | the synthesised owl call |
| `sounds/wolf/` | the synthesised wolf howls |

- `.mp3`, `.ogg`, `.wav`, `.m4a` or `.webm`. With several files, one is
  picked at random each time.
- Keep them short, dry recordings: reverb, distance and stereo position are
  added in code (`src/audio/ambience.ts`).
