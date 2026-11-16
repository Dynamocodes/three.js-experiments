import type { Editor, EditorContext } from './devTools';

// Camera editor (C): frame the resting shot. "Save camera" writes
// src/landscape/camera/framing.json, and nothing else.

export function createCameraEditor({ landscape, view }: EditorContext): Editor {
  return {
    title: 'Camera editor',
    launch: 'Camera',
    shortcut: 'KeyC',
    tooltip: 'Dev tool: frame the camera and save it as the default',
    saveLabel: 'Save camera',

    enter() {
      // Framing starts from the saved shot, not wherever the prop editor flew to.
      view.snapToRest();
    },

    save() {
      return { camera: { position: view.position.toArray(), target: view.target.toArray() } };
    },
    saved() {
      landscape.rig.position.copy(view.position);
      landscape.rig.target.copy(view.target);
      return 'Saved framing.json, reloading…';
    },

    revert() {
      view.snapToRest();
      return 'Back to the saved framing.';
    },
  };
}
