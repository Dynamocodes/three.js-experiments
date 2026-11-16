import * as THREE from 'three';
import type { Landscape } from '../landscape';
import { createCameraEditor } from './cameraEditor';
import { createFreeCamera, KEYS, type FreeCamera } from './freeCamera';
import { createPropEditor } from './propEditor';

// Development only: the editors, each saving only its own file.
//
//   C  Camera editor (cameraEditor.ts): frame the resting shot, saves framing.json.
//   P  Prop editor (propEditor.ts): move and turn the props, saves layout.json.
// (Or the buttons, bottom left.) Pressing another editor's key switches to
// it; the same key, Close or Esc closes it. While open, the mouse sway stops.
//
// This file is the shared part: the launcher, the panel, the save request,
// and the free camera (freeCamera.ts) in every editor:
//   drag on the scene: look around (the camera turns in place; the scene follows the cursor)
//   right-drag or shift-drag: slide sideways and up/down
//   wheel: move forward/back
//   W A S D: move forward/left/back/right, Q E: down/up
// An editor can take over a drag or a key first (the prop editor does while
// a prop is selected). Hold Shift for bigger steps. Keys go by their place on
// the keyboard, so on AZERTY they're Z Q S D and A E; the panel shows your
// layout's letters.
//
// Saving goes through the dev server (see vite.config.ts), which then reloads
// the page with the new defaults. Closing drops unsaved changes and returns to
// the saved framing. While open, drags anywhere on the page work (including
// over the page content), and clicks don't throw snowballs.

/** What the shared tool gives each editor. */
export interface EditorContext {
  landscape: Landscape;
  view: FreeCamera;
  /** Puts the camera at the view, refreshes the panel and draws a frame. */
  render(): void;
  refreshHelp(): void;
  /** The letter on the visitor's keyboard for a key code. */
  key(code: string): string;
  buttonStyle: string;
}

/** One editor. Optional parts fall back to plain flying. */
export interface Editor {
  title: string;
  /** Launcher button text; the key's letter is added. */
  launch: string;
  /** Opens/closes it (KeyboardEvent.code). */
  shortcut: string;
  tooltip: string;
  saveLabel: string;
  /** A line under the help, e.g. that the view isn't saved. */
  viewNote?: string;
  /** Its own part of the panel. */
  section?: HTMLElement;

  /** Opening it; `previous` is the editor it replaces (null when the tool was closed). */
  enter?(previous: Editor | null): void;
  /** Switching to another editor, or closing. */
  leave?(): void;
  /** Closing the tool: drop unsaved changes. */
  discard?(): void;

  /** Help text: a line added under the flying help, or text replacing it. */
  help?(): { extra?: string; replace?: string };
  /** After each render: refresh its readouts. */
  update?(): void;

  /** A press on the scene; true takes the drag (then pointerMove until pointerUp). */
  pointerDown?(e: PointerEvent): boolean;
  pointerMove?(e: PointerEvent): void;
  pointerUp?(): void;
  /** A click (not a drag) on the scene, outside anything pointerDown took. */
  clickEmpty?(): void;
  /** A key; true if handled (then the camera doesn't fly). */
  key?(e: KeyboardEvent, step: number): boolean;
  /** Esc; true if handled, otherwise the tool closes. */
  escape?(): boolean;

  /** The body of POST /__dev/save. */
  save(): Record<string, unknown>;
  /** After a successful save; returns the status line. */
  saved(): string;
  /** Back to what's saved; returns the status line. */
  revert(): string;
  dispose?(): void;
}

const STYLE = `
  position: fixed; top: 12px; right: 12px; z-index: 10000; width: 320px;
  padding: 12px 14px; border-radius: 10px;
  background: rgba(8, 12, 24, 0.88); color: #e8eefc; border: 1px solid rgba(255, 255, 255, 0.15);
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4); user-select: none;
`;
const BUTTON_STYLE = `
  font: inherit; color: inherit; cursor: pointer; padding: 5px 9px; border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(255, 255, 255, 0.08);
`;

export function createDevTools(landscape: Landscape) {
  const { camera, renderer, rig } = landscape;
  const view = createFreeCamera(camera, rig);
  let editor: Editor | null = null; // the open one

  // ---------- panel ----------
  const panel = document.createElement('div');
  panel.style.cssText = STYLE;
  panel.hidden = true;
  panel.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 6px;"><span data-out="title"></span> <span style="opacity: .6">(dev)</span></div>
    <div data-out="help" style="opacity: .7; margin-bottom: 8px;"></div>
    <div data-out="view-note" style="opacity: .7;"></div>
    <div>camera <span data-out="position"></span></div>
    <div>target <span data-out="target"></span></div>
    <div data-out="section"></div>
    <div style="display: flex; gap: 6px; margin-top: 10px;">
      <button type="button" data-action="save" style="${BUTTON_STYLE} background: #2f6f5a;"></button>
      <button type="button" data-action="revert" style="${BUTTON_STYLE}">Revert</button>
      <button type="button" data-action="close" style="${BUTTON_STYLE}">Close</button>
    </div>
    <div data-out="status" style="margin-top: 8px; min-height: 1.45em; opacity: .85;"></div>
  `;
  const out = (name: string) => panel.querySelector<HTMLElement>(`[data-out="${name}"]`)!;
  const fmt = (v: THREE.Vector3) => `[${v.toArray().map((n) => n.toFixed(2)).join(', ')}]`;
  const setStatus = (text: string) => { out('status').textContent = text; };

  // Show the letters of the visitor's own keyboard layout where the browser can tell.
  const labels: Record<string, string> = {};
  const key = (code: string) => (labels[code] ?? code.replace(/^Key/, '')).toUpperCase();
  const writeHelp = () => {
    const move = `${key(KEYS.forward)}${key(KEYS.left)}${key(KEYS.back)}${key(KEYS.right)}`;
    const own = editor?.help?.() ?? {};
    out('help').innerHTML = own.replace
      ?? `drag: look · right/shift-drag: slide · wheel: forward/back<br>${move}: move · ${key(KEYS.down)}/${key(KEYS.up)}: down/up · Shift: faster`
        + (own.extra ? `<br>${own.extra}` : '');
  };

  const render = () => {
    view.apply();
    out('position').textContent = fmt(view.position);
    out('target').textContent = fmt(view.target);
    editor?.update?.();
    renderer.render(landscape.scene, camera); // also when the loop is paused (hidden tab, reduced motion)
  };

  const context: EditorContext = { landscape, view, render, refreshHelp: writeHelp, key, buttonStyle: BUTTON_STYLE };
  const editors = [createCameraEditor(context), createPropEditor(context)];

  // ---------- launcher ----------
  const launcher = document.createElement('div');
  launcher.style.cssText = 'position: fixed; left: 12px; bottom: 12px; z-index: 10000; display: flex; gap: 6px;';
  const launchStyle = `${BUTTON_STYLE} background: rgba(8, 12, 24, 0.7); color: #e8eefc; font: 12px ui-monospace, Consolas, monospace;`;
  const launchButtons = editors.map((ed) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = ed.tooltip;
    b.style.cssText = launchStyle;
    b.addEventListener('click', (e) => { e.stopPropagation(); toggle(ed); });
    launcher.append(b);
    return b;
  });
  const writeLaunchers = () => editors.forEach((ed, i) => { launchButtons[i].textContent = `${ed.launch} (${key(ed.shortcut)})`; });
  document.body.append(launcher, panel);

  const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
  void keyboard?.getLayoutMap().then((map) => {
    for (const [code, letter] of map) labels[code] = letter;
    writeHelp();
    writeLaunchers();
  }).catch(() => {});
  writeHelp();
  writeLaunchers();

  // ---------- pointer ----------
  type Drag = { kind: 'look' | 'slide' | 'editor'; x: number; y: number; startX: number; startY: number };
  let drag: Drag | null = null;

  const onPointerDown = (e: PointerEvent) => {
    const at = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY };
    if (e.button === 2 || (e.button === 0 && e.shiftKey)) { drag = { kind: 'slide', ...at }; return; }
    if (e.button !== 0) return;
    drag = { kind: editor?.pointerDown?.(e) ? 'editor' : 'look', ...at };
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.kind === 'editor') editor?.pointerMove?.(e);
    else if (drag.kind === 'slide') view.slide(dx, dy);
    else view.look(dx, dy);
    render();
  };
  const onPointerUp = (e: PointerEvent) => {
    if (drag?.kind === 'editor') editor?.pointerUp?.();
    // A click (not a drag) on empty scene.
    else if (drag?.kind === 'look' && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) editor?.clickEmpty?.();
    drag = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    view.dolly(-Math.sign(e.deltaY) * (e.shiftKey ? 3 : 1));
    render();
  };
  const onContextMenu = (e: Event) => e.preventDefault();

  // Swallow page clicks (snowballs, links) while open, except on the panel.
  const blockClicks = (e: MouseEvent) => {
    if (e.target instanceof Node && panel.contains(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
  };

  // ---------- open / close / save ----------
  function open(next: Editor) {
    if (editor === next) return;
    const previous = editor;
    previous?.leave?.();
    editor = next;
    if (!previous) {
      rig.paused = true;
      // On the whole page: the canvas sits behind the content.
      window.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('contextmenu', onContextMenu);
      window.addEventListener('click', blockClicks, true);
      document.body.style.userSelect = 'none';
      panel.hidden = false;
    }
    drag = null;
    next.enter?.(previous);
    out('title').textContent = next.title;
    out('view-note').textContent = next.viewNote ?? '';
    out('section').replaceChildren(...(next.section ? [next.section] : []));
    panel.querySelector<HTMLElement>('[data-action="save"]')!.textContent = next.saveLabel;
    editors.forEach((ed, i) => { launchButtons[i].style.outline = ed === next ? '2px solid #ffd36b' : ''; });
    setStatus('');
    writeHelp();
    render();
  }

  function close() {
    if (!editor) return;
    editor.leave?.();
    editor = null;
    drag = null;
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('click', blockClicks, true);
    document.body.style.userSelect = '';
    panel.hidden = true;
    for (const ed of editors) ed.discard?.(); // leaving without saving
    launchButtons.forEach((b) => { b.style.outline = ''; });
    rig.paused = false; // back to the saved framing, with mouse sway
  }

  const toggle = (ed: Editor) => { if (editor === ed) close(); else open(ed); };

  /** Saves what the open editor edits, and only that. */
  async function save() {
    const ed = editor;
    if (!ed) return;
    setStatus('Saving…');
    try {
      const res = await fetch('/__dev/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ed.save()) });
      if (!res.ok) throw new Error(await res.text());
      setStatus(ed.saved());
    } catch (err) {
      setStatus(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Panel buttons. Pointer events stop here so dragging on the panel doesn't move anything.
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  panel.addEventListener('wheel', (e) => e.stopPropagation());
  panel.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'save') void save();
    if (action === 'revert' && editor) { setStatus(editor.revert()); render(); }
    if (action === 'close') close();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ed = editors.find((x) => x.shortcut === e.code);
    if (ed) { toggle(ed); return; }
    if (!editor) return;
    if (e.key === 'Escape') { if (!editor.escape?.()) close(); return; }
    const step = e.shiftKey ? 2 : 0.5;
    if (!editor.key?.(e, step) && !view.key(e.code, step)) return;
    e.preventDefault();
    render();
  };
  window.addEventListener('keydown', onKey);

  return {
    close,
    dispose() {
      close();
      window.removeEventListener('keydown', onKey);
      for (const ed of editors) ed.dispose?.();
      launcher.remove();
      panel.remove();
    },
  };
}
