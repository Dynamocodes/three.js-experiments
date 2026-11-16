import * as THREE from 'three';
import type { EditableProp, Layout, PropName } from '../landscape/layout';
import type { Editor, EditorContext } from './devTools';
import { KEYS } from './freeCamera';

// Prop editor (P): move and turn the props. "Save layout" writes
// src/landscape/layout.json, and nothing else; the camera flies freely here,
// but that view is never saved.
//
//   click a prop (or its name in the panel): select it
//   drag it: move it over the ground
//   W A S D: move it forward/left/back/right, as seen from the camera
//   Q E: turn it left/right
//   Esc, or a click on empty scene: let go of it
//
// After saving, the page reloads and each prop's placement function grounds
// it properly again (e.g. rebuilds the pier's snowdrift). Closing the editors
// drops unsaved moves.

const SELECTED_STYLE = 'background: #8a6a1f; border-color: #ffd36b;';

interface Saved {
  position: THREE.Vector3;
  rotationY: number;
}

export function createPropEditor({ landscape, view, render, refreshHelp, key, buttonStyle }: EditorContext): Editor {
  const { camera, renderer, terrain, props } = landscape;
  // Where each prop stands as saved, for Revert and Close.
  const saved = new Map<EditableProp, Saved>(props.map((p) => [p, { position: p.object.position.clone(), rotationY: p.object.rotation.y }]));
  let selected: EditableProp | null = null;
  let groundOffset = 0; // selected prop's height above the drawn ground
  let held: { prop: EditableProp; grab: THREE.Vector3 } | null = null; // prop being dragged

  // ---------- panel ----------
  const section = document.createElement('div');
  section.innerHTML = `
    <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
      ${props.map((p) => `<button type="button" data-prop="${p.name}" style="${buttonStyle} padding: 3px 7px;">${p.name}</button>`).join('')}
    </div>
    <div data-out="prop" style="margin-top: 6px; min-height: 1.45em;"></div>`;
  const readout = section.querySelector<HTMLElement>('[data-out="prop"]')!;
  section.addEventListener('click', (e) => {
    const name = (e.target as HTMLElement).closest<HTMLElement>('[data-prop]')?.dataset.prop;
    if (name) select(props.find((p) => p.name === name) ?? null);
  });

  // Ring on the ground around the selected prop.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.12, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffd36b', transparent: true, opacity: 0.85, depthTest: false }),
  );
  ring.renderOrder = 999;
  ring.visible = false;
  landscape.scene.add(ring);

  // ---------- props ----------
  const pivotOf = (p: EditableProp) => p.pivot?.() ?? p.object.getWorldPosition(new THREE.Vector3());

  function showProp() {
    section.querySelectorAll<HTMLElement>('[data-prop]').forEach((b) => {
      b.style.cssText = buttonStyle + ' padding: 3px 7px;' + (b.dataset.prop === selected?.name ? SELECTED_STYLE : '');
    });
    if (!selected) { readout.textContent = ''; ring.visible = false; return; }
    const entry = selected.read() as Record<string, number | boolean>;
    readout.textContent = `${selected.name} ` + Object.entries(entry)
      .map(([k, v]) => `${k} ${typeof v === 'number' ? v.toFixed(2) : v}`).join(' · ');
    const p = pivotOf(selected);
    ring.position.set(p.x, terrain.surfaceAt(p.x, p.z) + 0.05, p.z);
    ring.visible = true;
  }

  function select(p: EditableProp | null) {
    selected = p;
    if (p) {
      const at = pivotOf(p);
      groundOffset = at.y - terrain.surfaceAt(at.x, at.z);
      // Ring size from the prop's footprint.
      const size = new THREE.Box3().setFromObject(p.object).getSize(new THREE.Vector3());
      ring.scale.setScalar(Math.min(Math.max(size.x, size.z) / 2 + 0.4, 9));
    }
    refreshHelp();
    render();
  }

  /** Moves a prop so its pivot is at world (x, z), on the ground. */
  function moveTo(p: EditableProp, x: number, z: number) {
    const from = pivotOf(p);
    const y = p.followGround === false ? from.y : terrain.surfaceAt(x, z) + groundOffset;
    const parent = p.object.parent;
    if (!parent) return;
    // The world move, in the parent's space (the woodpile sits inside the turned cabin).
    const a = parent.worldToLocal(from.clone());
    const b = parent.worldToLocal(new THREE.Vector3(x, y, z));
    p.object.position.add(b.sub(a));
  }

  /** Turns a prop around its pivot (radians, + is to the left). */
  function turn(p: EditableProp, angle: number) {
    const pivot = pivotOf(p);
    const origin = p.object.getWorldPosition(new THREE.Vector3());
    if (origin.distanceToSquared(pivot) > 1e-6 && p.object.parent === landscape.scene) {
      // Pier: its group sits at the world origin, so swing the group around the pontoon.
      const v = p.object.position.clone().sub(pivot).applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle);
      p.object.position.copy(pivot).add(v);
    }
    p.object.rotation.y += angle;
  }

  function revertProps() {
    for (const [p, s] of saved) {
      p.object.position.copy(s.position);
      p.object.rotation.y = s.rotationY;
    }
  }

  // ---------- picking ----------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ray = (clientX: number, clientY: number) => {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    return raycaster;
  };
  /** The prop under the cursor (the innermost one: the woodpile, not the cabin around it). */
  function propAt(clientX: number, clientY: number) {
    const hit = ray(clientX, clientY).intersectObjects(props.map((p) => p.object), true)[0];
    if (!hit) return null;
    for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
      const p = props.find((q) => q.object === o);
      if (p) return p;
    }
    return null;
  }
  const groundAt = (clientX: number, clientY: number) =>
    ray(clientX, clientY).intersectObject(terrain.mesh, false)[0]?.point ?? null;

  return {
    title: 'Prop editor',
    launch: 'Props',
    shortcut: 'KeyP',
    tooltip: 'Dev tool: move the props and save the layout',
    saveLabel: 'Save layout',
    viewNote: 'free view, not saved',
    section,

    enter(previous) {
      if (!previous) view.snapToRest();
    },
    leave() {
      held = null;
      if (selected) select(null);
    },
    discard() {
      revertProps();
      selected = null;
      ring.visible = false;
    },

    help() {
      if (!selected) return { extra: 'click a prop to move it' };
      const move = `${key(KEYS.forward)}${key(KEYS.left)}${key(KEYS.back)}${key(KEYS.right)}`;
      return { replace: `drag it: move · ${move}: move · ${key(KEYS.down)}/${key(KEYS.up)}: turn<br>Shift: bigger steps · Esc: let go` };
    },
    update: showProp,

    pointerDown(e) {
      const prop = propAt(e.clientX, e.clientY);
      if (!prop) return false;
      if (prop !== selected) select(prop);
      // Keep the point under the cursor under it while dragging.
      const ground = groundAt(e.clientX, e.clientY);
      held = { prop, grab: ground ? pivotOf(prop).sub(ground).setY(0) : new THREE.Vector3() };
      return true;
    },
    pointerMove(e) {
      const ground = held && groundAt(e.clientX, e.clientY);
      if (held && ground) moveTo(held.prop, ground.x + held.grab.x, ground.z + held.grab.z);
    },
    pointerUp() {
      held = null;
    },
    clickEmpty() {
      if (selected) select(null);
    },

    key(e, step) {
      if (!selected) return false;
      if (e.code === KEYS.down || e.code === KEYS.up) {
        turn(selected, (e.code === KEYS.down ? 1 : -1) * (e.shiftKey ? 0.2 : 0.05));
        return true;
      }
      const { forward, right } = view.groundAxes();
      const dir = {
        [KEYS.forward]: forward, [KEYS.back]: forward.clone().negate(), [KEYS.right]: right, [KEYS.left]: right.clone().negate(),
      }[e.code];
      if (!dir) return false;
      const p = pivotOf(selected);
      moveTo(selected, p.x + dir.x * step, p.z + dir.z * step);
      return true;
    },
    escape() {
      if (!selected) return false;
      select(null);
      return true;
    },

    save() {
      return { layout: Object.fromEntries(props.map((p) => [p.name, p.read()])) as Partial<Record<PropName, Layout[PropName]>> };
    },
    saved() {
      for (const [p, s] of saved) { s.position.copy(p.object.position); s.rotationY = p.object.rotation.y; }
      return 'Saved layout.json, reloading…';
    },
    revert() {
      revertProps();
      return 'Back to the saved layout.';
    },

    dispose() {
      landscape.scene.remove(ring);
      ring.geometry.dispose();
      ring.material.dispose();
    },
  };
}
