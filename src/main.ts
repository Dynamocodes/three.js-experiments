import { createLandscape } from './landscape';
import { createAmbience } from './audio/ambience';

/** Finds an element the page must have, with a clear error if it doesn't. */
function required<T extends Element>(selector: string, type: { new (): T; prototype: T }): T {
  const el = document.querySelector(selector);
  if (!(el instanceof type)) throw new Error(`index.html is missing ${selector}`);
  return el;
}

const canvas = required('#bg', HTMLCanvasElement);
const landscape = createLandscape(canvas, { seed: 1917 });

// Sound starts off: browsers only allow audio after a user gesture.
const ambience = createAmbience();
const button = required('#sound-toggle', HTMLButtonElement);
const label = required('#sound-toggle .label', HTMLElement);
button.addEventListener('click', () => {
  const on = ambience.toggle();
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? 'Turn ambient sound off' : 'Turn ambient sound on');
  label.textContent = on ? 'Sound on' : 'Sound off';
});

if (import.meta.env.DEV) window.ambience = ambience; // e.g. ambience.wolves() from the console

// Dev only: press C for the camera editor, P for the prop editor; each saves its own defaults.
// (Left out of production builds: import.meta.env.DEV is false there.)
let devTools: { dispose(): void } | undefined;
if (import.meta.env.DEV) {
  void import('./dev/devTools').then(({ createDevTools }) => { devTools = createDevTools(landscape); });
}

// Clean up on hot reload so we don't stack WebGL contexts during development.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    devTools?.dispose();
    landscape.dispose();
    ambience.dispose();
  });
}
