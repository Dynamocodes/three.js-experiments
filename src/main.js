import { createLandscape } from './landscape/index.js';
import { createAmbience } from './audio/ambience.js';

const canvas = document.querySelector('#bg');
const landscape = createLandscape(canvas, { seed: 1917 });

// Sound starts off: browsers only allow audio after a user gesture.
const ambience = createAmbience();
const button = document.querySelector('#sound-toggle');
button.addEventListener('click', () => {
  const on = ambience.toggle();
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? 'Turn ambient sound off' : 'Turn ambient sound on');
  button.querySelector('.label').textContent = on ? 'Sound on' : 'Sound off';
});

if (import.meta.env.DEV) window.ambience = ambience; // e.g. ambience.wolves() from the console

// Clean up on hot reload so we don't stack WebGL contexts during development.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    landscape.dispose();
    ambience.dispose();
  });
}
