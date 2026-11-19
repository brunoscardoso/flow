/**
 * THE CANVAS VIEWER PAGE — Flow-owned, never generated. Served on the drafts
 * host at `flow-page://drafts/<root>/<canvas>/`, it draws one sandboxed frame
 * per screen, laid out from the canvas's layout, under a toolbar with the
 * canvas's name, the zoom and Fit.
 *
 *   - The layout, and which screens cannot be read, are embedded by main at
 *     serve time as inert JSON, so the page fetches nothing (the scheme is not
 *     fetch-enabled, and `connect-src` stays 'none').
 *   - Each screen is an `<iframe sandbox="allow-scripts">` — never
 *     `allow-same-origin` — whose relative `src` resolves inside this canvas.
 *   - Every agent-written string (the name, titles) reaches the DOM through
 *     `textContent`; the `<title>` is escaped.
 *   - The layout math is `draft-canvas-layout.ts`, inlined from its own source.
 *   - The view (zoom, pan) is kept in the address's `#view=` fragment through
 *     `history.replaceState`: the page has no storage (opaque scheme, no IPC),
 *     and the fragment survives a reload, the single-screen view and Back.
 *   - `window.flowCanvas.changed(files)` is the host's door: the browser tab
 *     calls it when the drafts observer reports a change to this canvas, and
 *     only the changed frames reload. A layout change, or a screen that could
 *     not be read, reloads the page — the view survives in the fragment.
 *   - UNDO AND VERSIONS. The toolbar's Undo steps back one change, whoever made
 *     it (the agent's or the person's); Versions opens a menu to save the
 *     canvas under a name and to restore a saved one (after a confirmation).
 *     The menu and both dialogs are drawn here, in the toolbar's style. The
 *     page has no IPC: it asks the host by posting a history request to itself
 *     (relayed by the guest preload, like a pick) and the host answers through
 *     `flowCanvas.history(state)` with the undo count, the versions, or a short
 *     sentence for a person — never a path. Cmd/Ctrl+Z undoes too, unless focus
 *     is in a text field.
 *   - Screen frames take no pointer events in the canvas: the canvas pans and
 *     zooms over them, and a double-click opens the screen alone, where it is
 *     the whole page.
 *   - INSPECT. The toolbar's inspect toggle (or the host, through
 *     `flowCanvas.setInspect`) gives the frames pointer events and tells each
 *     frame's picker — injected by main, `draft-frame-inject.ts` — to start.
 *     A pick arrives from a frame; the page decides WHICH screen from the frame
 *     that sent it (never the frame's own claim), outlines that frame, and posts
 *     the pick to itself, where the guest preload relays it to the host. The
 *     selection is kept here, so a frame that reloads (an edit) is re-selected
 *     by id when its new picker reports ready.
 */
import {
  DRAFT_CANVAS_INSPECT,
  DRAFT_CANVAS_PICK,
  DRAFT_FRAME_ESCAPE,
  DRAFT_FRAME_PICK,
  DRAFT_FRAME_READY,
  DRAFT_FRAME_STATE,
} from '../../shared/draft-pick'
import { DRAFT_CANVAS_HISTORY, DRAFT_VERSION_NAME_MAX, draftVersionTimeText } from '../../shared/draft-history-messages'
import { DEFAULT_DRAFT_FRAME, type DraftLayout } from '../../shared/ui-drafts'
import { draftCanvasMathSource } from '../../shared/draft-canvas-layout'

/** JSON that is safe inside a `<script type="application/json">` block. */
function inertJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Why a screen file cannot be shown — a sentence for a person. */
export function screenProblemSentence(reason: 'missing' | 'empty'): string {
  const why = reason === 'missing' ? 'The file is missing.' : 'The file is empty.'
  return `This screen could not be read. ${why} Ask the agent to draw it again.`
}

export interface CanvasPageInput {
  canvas: string
  layout: DraftLayout | null
  /** Replaces the frames with a sentence (a layout that cannot be read). */
  problem?: string
  /** Screens that cannot be read, by id, with the sentence to show in their place. */
  screenProblems?: Record<string, string>
}

const VERSION_TIME = draftVersionTimeText.toString()
const MATH = draftCanvasMathSource({ w: DEFAULT_DRAFT_FRAME.w, h: DEFAULT_DRAFT_FRAME.h, gap: DEFAULT_DRAFT_FRAME.gap })

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #f4f4f5; --dot: #d4d4d8; --bar: #ffffff; --edge: #e4e4e7; --fg: #18181b; --muted: #71717a;
    --button: #f4f4f5; --button-hover: #e4e4e7; --accent: #2b6cff; --frame: #ffffff;
    --shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.08);
    --bad: #dc2626; --bad-bg: #fef2f2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #18181b; --dot: #3f3f46; --bar: #202023; --edge: #2e2e33; --fg: #f4f4f5; --muted: #a1a1aa;
      --button: #2a2a2e; --button-hover: #35353a; --frame: #ffffff;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35);
      --bad: #f87171; --bad-bg: #2a1616;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--fg);
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { display: flex; flex-direction: column; }
  .bar { flex: none; display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px;
    background: var(--bar); border-bottom: 1px solid var(--edge); user-select: none; min-width: 0; }
  .bar .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .bar .meta { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .bar .spacer { flex: 1; }
  .bar button { height: 26px; min-width: 26px; padding: 0 8px; border: 0; border-radius: 6px; background: var(--button);
    color: var(--fg); font: inherit; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .bar button:hover { background: var(--button-hover); }
  .bar button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .bar button svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; }
  .zoom { display: inline-flex; align-items: center; gap: 2px; }
  .zoom .level { min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; color: var(--fg); }
  .stage { position: relative; flex: 1; min-height: 0; overflow: hidden; cursor: default;
    background-color: var(--bg);
    background-image: radial-gradient(circle, var(--dot) 1px, transparent 1.2px); }
  .stage.panning, .stage.space { cursor: grab; }
  .stage.panning { cursor: grabbing; }
  .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .labels { position: absolute; inset: 0; pointer-events: none; }
  .frame { position: absolute; background: var(--frame); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }
  .frame iframe { display: block; border: 0; pointer-events: none; background: var(--frame); }
  .stage.inspecting .frame iframe { pointer-events: auto; }
  .frame.picked { overflow: visible; }
  .frame.picked::after { content: ''; position: absolute; inset: -3px; border: 2px solid var(--accent);
    border-radius: 14px; pointer-events: none; }
  .bar button[aria-pressed="true"] { background: var(--accent); color: #fff; }
  .frame.bad { background: var(--bad-bg); box-shadow: none; border: 2px dashed var(--bad); display: flex;
    align-items: center; justify-content: center; padding: 32px; text-align: center; color: var(--bad);
    font-size: 15px; line-height: 1.5; }
  .label { position: absolute; left: 0; top: 0; display: flex; gap: 6px; align-items: baseline; white-space: nowrap;
    overflow: hidden; pointer-events: auto; cursor: default; user-select: none; }
  .label .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .label .order { color: var(--muted); }
  .bar button:disabled { opacity: .4; cursor: default; }
  .bar button:disabled:hover { background: var(--button); }
  .bar .menuwrap { position: relative; display: inline-flex; }
  .bar .menuwrap > button { gap: 4px; }
  .bar .menuwrap > button svg { width: 12px; height: 12px; }
  .bar .menu { position: absolute; top: 32px; right: 0; z-index: 20; min-width: 240px; max-width: 320px; padding: 4px;
    background: var(--bar); border: 1px solid var(--edge); border-radius: 8px; box-shadow: var(--shadow); }
  .bar .menu[hidden], .overlay[hidden], .toast[hidden] { display: none; }
  .menu .head { padding: 6px 8px 4px; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .04em; }
  .menu .sep { height: 1px; margin: 4px 0; background: var(--edge); }
  .menu .empty { padding: 6px 8px; color: var(--muted); }
  .bar .menu .item { display: flex; width: 100%; height: auto; min-height: 28px; padding: 5px 8px; gap: 12px;
    justify-content: space-between; align-items: baseline; text-align: left; background: transparent; border-radius: 5px; }
  .bar .menu .item:hover, .bar .menu .item:focus-visible { background: var(--button-hover); }
  .menu .item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .menu .item .when { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .overlay { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,.35); }
  .dialog { width: min(360px, calc(100vw - 32px)); padding: 16px; background: var(--bar); color: var(--fg);
    border: 1px solid var(--edge); border-radius: 12px; box-shadow: var(--shadow); }
  .dialog h2 { margin: 0 0 8px; font-size: 14px; }
  .dialog p { margin: 0 0 12px; color: var(--fg); overflow-wrap: anywhere; }
  .dialog .field { width: 100%; height: 30px; margin: 0 0 8px; padding: 0 8px; border: 1px solid var(--edge);
    border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; }
  .dialog .field:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .dialog .error { margin: 0 0 8px; color: var(--bad); }
  .dialog .error[hidden] { display: none; }
  .dialog .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .dialog button { height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: var(--button); color: var(--fg);
    font: inherit; cursor: pointer; }
  .dialog button:hover { background: var(--button-hover); }
  .dialog button.primary { background: var(--accent); color: #fff; }
  .dialog button:disabled { opacity: .4; cursor: default; }
  .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 25; max-width: calc(100vw - 32px);
    padding: 8px 14px; background: var(--fg); color: var(--bg); border-radius: 8px; box-shadow: var(--shadow); }
  .problem { margin: auto; padding: 32px; max-width: 480px; text-align: center; color: var(--muted); }
`

const MSG = JSON.stringify({
  ready: DRAFT_FRAME_READY,
  pick: DRAFT_FRAME_PICK,
  escape: DRAFT_FRAME_ESCAPE,
  state: DRAFT_FRAME_STATE,
  canvasPick: DRAFT_CANVAS_PICK,
  inspect: DRAFT_CANVAS_INSPECT,
  history: DRAFT_CANVAS_HISTORY,
})

const SCRIPT = `
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('flow-canvas-data').textContent);
  var math = ${MATH};
  var stage = document.getElementById('stage');
  var world = document.getElementById('world');
  var labels = document.getElementById('labels');
  var levelText = document.getElementById('level');
  var problems = data.screenProblems || {};

  if (!data.layout) {
    var note = document.createElement('p');
    note.className = 'problem';
    note.textContent = data.problem || 'This canvas has no screens yet.';
    stage.replaceWith(note);
    ['zoom', 'fit', 'inspect', 'undo', 'versions-wrap'].forEach(function (id) {
      var control = document.getElementById(id);
      if (control) control.remove();
    });
    return;
  }

  var screens = data.layout.screens;
  var rects = math.frameRects(screens);
  var box = math.bounds(rects);
  var frames = {};
  var labelEls = [];
  var version = 0;
  var inspecting = false;
  var selected = null;
  var wantFacts = false;
  var MSG = ${MSG};

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function openSingle(id) {
    keepView();
    location.href = encodeURIComponent(id) + '.html?view=single';
  }

  function screenSrc(id) {
    return encodeURIComponent(id) + '.html' + (version > 0 ? '?v=' + version : '');
  }

  screens.forEach(function (screen, index) {
    var rect = rects[index];
    var frame = el('div', 'frame');
    frame.style.left = rect.x + 'px';
    frame.style.top = rect.y + 'px';
    frame.style.width = rect.w + 'px';
    frame.style.height = rect.h + 'px';
    frame.dataset.screen = screen.id;
    var reason = problems[screen.id];
    if (typeof reason === 'string') {
      frame.classList.add('bad');
      frame.textContent = reason;
    } else {
      var iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.setAttribute('title', screen.title);
      iframe.width = String(rect.w);
      iframe.height = String(rect.h);
      iframe.src = screenSrc(screen.id);
      iframe.dataset.screen = screen.id;
      frame.appendChild(iframe);
      frames[screen.id] = iframe;
    }
    frame.addEventListener('dblclick', function () { openSingle(screen.id); });
    world.appendChild(frame);

    var label = el('div', 'label');
    label.dataset.screen = screen.id;
    label.appendChild(el('span', 'title', screen.title));
    label.appendChild(el('span', 'order', String(index + 1)));
    label.title = screen.title;
    label.addEventListener('dblclick', function () { openSingle(screen.id); });
    labels.appendChild(label);
    labelEls.push({ node: label, rect: rect });
  });

  // ── The view ────────────────────────────────────────────────────────────
  var view = math.parseViewHash(location.hash);
  var keepTimer = 0;

  function size() {
    return { w: stage.clientWidth, h: stage.clientHeight };
  }

  function keepView() {
    clearTimeout(keepTimer);
    try {
      history.replaceState(null, '', location.pathname + location.search + math.formatViewHash(view));
    } catch (error) { /* the view simply is not kept */ }
  }

  function render() {
    world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')';
    var dot = 20 * view.zoom;
    while (dot < 12) dot *= 2;
    stage.style.backgroundSize = dot + 'px ' + dot + 'px';
    stage.style.backgroundPosition = view.x + 'px ' + view.y + 'px';
    labelEls.forEach(function (entry) {
      var left = view.x + entry.rect.x * view.zoom;
      var top = view.y + entry.rect.y * view.zoom - 22;
      entry.node.style.transform = 'translate(' + left + 'px,' + top + 'px)';
      entry.node.style.maxWidth = Math.max(24, entry.rect.w * view.zoom) + 'px';
    });
    levelText.textContent = Math.round(view.zoom * 100) + '%';
  }

  function setView(next) {
    view = next;
    render();
    clearTimeout(keepTimer);
    keepTimer = setTimeout(keepView, 250);
  }

  function fit() {
    setView(math.fitToView(box, size()));
  }

  function pointIn(event) {
    var r = stage.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  }

  // Like a design tool: a pinch (ctrl+wheel) or cmd/ctrl+wheel zooms around the
  // cursor; a plain wheel or two-finger scroll pans.
  stage.addEventListener('wheel', function (event) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      setView(math.wheelZoom(view, event.deltaY, event.deltaMode, pointIn(event)));
      return;
    }
    var unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    setView({ zoom: view.zoom, x: view.x - event.deltaX * unit, y: view.y - event.deltaY * unit });
  }, { passive: false });

  var drag = null;
  var spaceDown = false;
  stage.addEventListener('pointerdown', function (event) {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target.closest && event.target.closest('.label') && !spaceDown) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, view: view, moving: false };
  });
  stage.addEventListener('pointermove', function (event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.moving) {
      // Captured only once it really moves: a capture taken on press would
      // retarget the click, and a double-click on a frame would never reach it.
      if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) < 4) return;
      drag.moving = true;
      try { stage.setPointerCapture(event.pointerId); } catch (error) { /* pans without capture */ }
      stage.classList.add('panning');
    }
    setView({ zoom: drag.view.zoom, x: drag.view.x + event.clientX - drag.x, y: drag.view.y + event.clientY - drag.y });
  });
  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    stage.classList.remove('panning');
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  window.addEventListener('keydown', function (event) {
    if (event.code === 'Space' && !event.repeat) {
      spaceDown = true;
      stage.classList.add('space');
      event.preventDefault();
    }
  });
  window.addEventListener('keyup', function (event) {
    if (event.code === 'Space') {
      spaceDown = false;
      stage.classList.remove('space');
    }
  });
  window.addEventListener('blur', function () {
    spaceDown = false;
    stage.classList.remove('space');
  });

  // ── Inspect: pick an element inside a screen ────────────────────────────
  var inspectButton = document.getElementById('inspect');

  function screenOfSource(source) {
    var ids = Object.keys(frames);
    for (var i = 0; i < ids.length; i += 1) if (frames[ids[i]].contentWindow === source) return ids[i];
    return null;
  }

  function tellFrame(id, reportFacts) {
    var frame = frames[id];
    if (!frame || !frame.contentWindow) return;
    var report = reportFacts === true && !!selected && selected.screen === id;
    if (report) wantFacts = false;
    frame.contentWindow.postMessage({
      type: MSG.state,
      on: inspecting,
      select: selected && selected.screen === id ? selected.id : null,
      report: report
    }, '*');
  }

  function markPicked() {
    world.querySelectorAll('.frame').forEach(function (node) {
      node.classList.toggle('picked', !!selected && node.dataset.screen === selected.screen);
    });
  }

  function setInspect(on) {
    inspecting = on === true;
    stage.classList.toggle('inspecting', inspecting);
    inspectButton.setAttribute('aria-pressed', inspecting ? 'true' : 'false');
    Object.keys(frames).forEach(function (id) { tellFrame(id); });
    window.postMessage({ type: MSG.inspect, on: inspecting }, '*');
  }

  function select(screen, id) {
    selected = typeof screen === 'string' && typeof id === 'string' ? { screen: screen, id: id } : null;
    markPicked();
    Object.keys(frames).forEach(function (id) { tellFrame(id); });
  }

  inspectButton.addEventListener('click', function () { setInspect(!inspecting); });
  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (closeTransient()) return;
    if (inspecting) setInspect(false);
  });
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    var screen = screenOfSource(event.source);
    if (screen === null) return;
    if (data.type === MSG.ready) { tellFrame(screen, wantFacts); return; }
    if (data.type === MSG.escape) { setInspect(false); return; }
    if (data.type !== MSG.pick || !data.facts || typeof data.facts.id !== 'string') return;
    // A re-read after an undo or a restore reaches the host even with inspect off.
    if (!inspecting && data.refresh !== true) return;
    select(screen, data.facts.id);
    var r = frames[screen].getBoundingClientRect();
    window.postMessage({
      type: MSG.canvasPick,
      screen: screen,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      facts: data.facts
    }, '*');
  });


  // ── Undo and versions ───────────────────────────────────────────────────
  var versionTime = ${VERSION_TIME};
  var NAME_MAX = ${DRAFT_VERSION_NAME_MAX};
  var undoButton = document.getElementById('undo');
  var versionsButton = document.getElementById('versions');
  var menu = document.getElementById('versions-menu');
  var overlay = document.getElementById('overlay');
  var toast = document.getElementById('toast');
  var undoCount = 0;
  var versionList = [];
  var dialog = null;
  var toastTimer = 0;
  var wantTimer = 0;
  var isMac = /Mac/i.test(navigator.platform || '');

  function ask(op, extra) {
    var message = { type: MSG.history, op: op };
    if (extra) Object.keys(extra).forEach(function (key) { message[key] = extra[key]; });
    window.postMessage(message, '*');
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 4000);
  }

  function setUndoCount(count) {
    undoCount = count > 0 ? Math.floor(count) : 0;
    undoButton.disabled = undoCount === 0;
  }

  function requestUndo() {
    if (dialog) return;
    if (undoCount === 0) { showToast('Nothing to undo.'); return; }
    ask('undo');
  }

  function menuItem(label, when) {
    var item = el('button', 'item');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.appendChild(el('span', 'name', label));
    if (when) item.appendChild(el('span', 'when', when));
    return item;
  }

  function renderMenu() {
    menu.textContent = '';
    menu.appendChild(el('div', 'head', 'Versions'));
    var save = menuItem('Save this version…');
    save.addEventListener('click', function () { closeMenu(); openSaveDialog(); });
    menu.appendChild(save);
    menu.appendChild(el('div', 'sep'));
    if (versionList.length === 0) menu.appendChild(el('div', 'empty', 'No saved versions yet.'));
    versionList.forEach(function (entry) {
      var item = menuItem(entry.name, versionTime(entry.savedAt, Date.now()));
      item.title = entry.name;
      item.dataset.version = entry.version;
      item.addEventListener('click', function () { closeMenu(); openRestoreDialog(entry); });
      menu.appendChild(item);
    });
  }

  function openMenu() {
    renderMenu();
    menu.hidden = false;
    versionsButton.setAttribute('aria-expanded', 'true');
    ask('list');
  }

  function closeMenu() {
    menu.hidden = true;
    versionsButton.setAttribute('aria-expanded', 'false');
  }

  function closeDialog() {
    dialog = null;
    overlay.hidden = true;
    overlay.textContent = '';
  }

  /** Closes the menu or the dialog when one is open; answers whether it did (or is busy). */
  function closeTransient() {
    if (dialog) {
      if (!dialog.pending) closeDialog();
      return true;
    }
    if (!menu.hidden) { closeMenu(); return true; }
    return false;
  }

  function syncDialog() {
    if (!dialog) return;
    var empty = dialog.input ? dialog.input.value.trim().length === 0 : false;
    dialog.confirm.disabled = dialog.pending || empty;
    dialog.cancel.disabled = dialog.pending;
    if (dialog.input) dialog.input.disabled = dialog.pending;
  }

  function setDialogError(text) {
    if (!dialog) return;
    dialog.error.textContent = text || '';
    dialog.error.hidden = !text;
  }

  function submitDialog() {
    if (!dialog || dialog.pending) return;
    if (dialog.kind === 'save') {
      var name = dialog.input.value.trim();
      if (!name) return;
      dialog.pending = true;
      setDialogError('');
      syncDialog();
      ask('save', { name: name });
    } else {
      dialog.pending = true;
      setDialogError('');
      syncDialog();
      ask('restore', { version: dialog.version });
    }
  }

  function openDialog(kind, title, confirmLabel, build) {
    closeDialog();
    var box = el('div', 'dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    var state = { kind: kind, pending: false, input: null, version: null };
    build(box, state);
    state.error = el('p', 'error');
    state.error.setAttribute('role', 'alert');
    state.error.hidden = true;
    box.appendChild(state.error);
    var actions = el('div', 'actions');
    state.cancel = el('button', 'cancel', 'Cancel');
    state.cancel.type = 'button';
    state.confirm = el('button', 'primary confirm', confirmLabel);
    state.confirm.type = 'button';
    state.cancel.addEventListener('click', function () { if (!state.pending) closeDialog(); });
    state.confirm.addEventListener('click', submitDialog);
    actions.appendChild(state.cancel);
    actions.appendChild(state.confirm);
    box.appendChild(actions);
    overlay.appendChild(box);
    overlay.hidden = false;
    dialog = state;
    syncDialog();
    (state.input || state.confirm).focus();
  }

  function openSaveDialog() {
    openDialog('save', 'Save this version', 'Save', function (box, state) {
      box.appendChild(el('h2', undefined, 'Save this version'));
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'field';
      input.maxLength = NAME_MAX;
      input.placeholder = 'Version name';
      input.setAttribute('aria-label', 'Version name');
      input.addEventListener('input', syncDialog);
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); submitDialog(); }
      });
      box.appendChild(input);
      state.input = input;
    });
  }

  function openRestoreDialog(entry) {
    openDialog('restore', 'Restore a version', 'Replace', function (box, state) {
      state.version = entry.version;
      box.appendChild(el('p', undefined, "Replace the current screens with '" + entry.name + "'? You can undo this."));
    });
  }

  undoButton.addEventListener('click', requestUndo);
  versionsButton.addEventListener('click', function () { if (menu.hidden) openMenu(); else closeMenu(); });
  overlay.addEventListener('pointerdown', function (event) {
    if (event.target === overlay && dialog && !dialog.pending) closeDialog();
  });
  window.addEventListener('pointerdown', function (event) {
    if (menu.hidden) return;
    var wrap = document.getElementById('versions-wrap');
    if (!wrap || !wrap.contains(event.target)) closeMenu();
  });
  window.addEventListener('keydown', function (event) {
    if (event.key !== 'z' && event.key !== 'Z') return;
    if (!(isMac ? event.metaKey : event.ctrlKey) || event.shiftKey || event.altKey) return;
    var target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    event.preventDefault();
    if (menu.hidden) requestUndo();
  });

  function validVersion(entry) {
    return !!entry && typeof entry.version === 'string' && typeof entry.name === 'string' && typeof entry.savedAt === 'string';
  }

  function applyHistory(state) {
    if (!state || typeof state !== 'object') return false;
    if (typeof state.undoCount === 'number') setUndoCount(state.undoCount);
    if (Array.isArray(state.versions)) {
      versionList = state.versions.filter(validVersion);
      if (!menu.hidden) renderMenu();
    }
    if (typeof state.error === 'string') {
      if (dialog) { dialog.pending = false; syncDialog(); setDialogError(state.error); }
      else showToast(state.error);
      return true;
    }
    if (state.done === 'save') { closeDialog(); showToast('Version saved.'); }
    if (state.done === 'restore' || state.done === 'undo') {
      closeDialog();
      wantFacts = state.refresh === true;
      clearTimeout(wantTimer);
      if (wantFacts) wantTimer = setTimeout(function () { wantFacts = false; }, 5000);
      showToast(state.done === 'undo' ? 'Undone.' : 'Version restored.');
    }
    return true;
  }

  document.getElementById('zoom-out').addEventListener('click', function () { setView(math.stepZoom(view, -1, size())); });
  document.getElementById('zoom-in').addEventListener('click', function () { setView(math.stepZoom(view, 1, size())); });
  document.getElementById('fit').addEventListener('click', fit);
  window.addEventListener('pagehide', keepView);

  // ── The host's door: reload only what changed ───────────────────────────
  window.flowCanvas = {
    view: function () { return { zoom: view.zoom, x: view.x, y: view.y }; },
    setInspect: function (on) { setInspect(on === true); return inspecting; },
    inspecting: function () { return inspecting; },
    select: function (screen, id) { select(screen, id); return selected; },
    frameRect: function (screen) {
      var frame = frames[screen];
      if (!frame) return null;
      var r = frame.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    history: applyHistory,
    undoCount: function () { return undoCount; },
    changed: function (files) {
      if (!Array.isArray(files)) return { page: false, reloaded: [] };
      var needPage = false;
      var reload = {};
      files.forEach(function (file) {
        if (file === 'layout.json') { needPage = true; return; }
        if (file === 'tokens.css') { Object.keys(frames).forEach(function (id) { reload[id] = true; }); return; }
        var match = /^([a-z0-9][a-z0-9-]*)\\.html$/.exec(String(file));
        if (!match) return;
        if (frames[match[1]]) reload[match[1]] = true;
        else if (Object.prototype.hasOwnProperty.call(problems, match[1])) needPage = true;
      });
      if (needPage) {
        keepView();
        location.reload();
        return { page: true, reloaded: [] };
      }
      var ids = Object.keys(reload);
      if (ids.length > 0) {
        version += 1;
        ids.forEach(function (id) { frames[id].src = screenSrc(id); });
      }
      return { page: false, reloaded: ids };
    }
  };

  if (view) render();
  else {
    view = math.fitToView(box, size());
    render();
  }
  var lastSize = size();
  window.addEventListener('resize', function () {
    var now = size();
    // A page shown before it had a size (a hidden tab) fits once it gets one.
    if ((lastSize.w === 0 || lastSize.h === 0) && now.w > 0 && now.h > 0 && !math.parseViewHash(location.hash)) fit();
    lastSize = now;
  });
})();
`

const MINUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9"/></svg>'
const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9"/></svg>'
const UNDO =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6" stroke-linejoin="round"/><path d="M5.5 3.5L2.5 6.5l3 3" stroke-linejoin="round"/></svg>'
const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke-linejoin="round"/></svg>'
const CURSOR =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5l9 4.2-3.9 1.2-1.4 3.9z" stroke-linejoin="round"/><path d="M8.8 9.2l3.4 3.4"/></svg>'

/** The muted line beside the canvas name. */
export function canvasMetaText(layout: DraftLayout): string {
  const count = layout.screens.length
  const screens = `${count} ${count === 1 ? 'screen' : 'screens'}`
  return layout.tokenSources.length > 0 ? `${screens} · colours from the app's theme` : screens
}

/** The viewer page for one canvas. */
export function canvasPageHtml(input: CanvasPageInput): string {
  const title = input.layout?.name ?? input.canvas
  const data = inertJson({
    layout: input.layout,
    problem: input.problem ?? null,
    screenProblems: input.screenProblems ?? {},
  })
  const meta = input.layout === null ? '' : canvasMetaText(input.layout)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<script type="application/json" id="flow-canvas-data">${data}</script>
<header class="bar">
  <span class="name">${escapeHtml(title)}</span>
  <span class="meta">${escapeHtml(meta)}</span>
  <span class="spacer"></span>
  <button type="button" id="inspect" aria-pressed="false" aria-label="Pick an element" title="Pick an element">${CURSOR}</button>
  <button type="button" id="undo" disabled aria-label="Undo" title="Undo">${UNDO}</button>
  <span class="menuwrap" id="versions-wrap">
    <button type="button" id="versions" aria-haspopup="menu" aria-expanded="false" title="Versions">Versions ${CHEVRON}</button>
    <div class="menu" id="versions-menu" role="menu" hidden></div>
  </span>
  <span class="zoom" id="zoom">
    <button type="button" id="zoom-out" aria-label="Zoom out" title="Zoom out">${MINUS}</button>
    <span class="level" id="level">100%</span>
    <button type="button" id="zoom-in" aria-label="Zoom in" title="Zoom in">${PLUS}</button>
  </span>
  <button type="button" id="fit" title="Show every screen">Fit</button>
</header>
<main class="stage" id="stage"><div class="world" id="world"></div><div class="labels" id="labels"></div></main>
<div class="overlay" id="overlay" hidden></div>
<div class="toast" id="toast" role="status" hidden></div>
<script>${SCRIPT}</script>
</body>
</html>
`
}
