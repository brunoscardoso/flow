/**
 * PICKING AN ELEMENT OF A DRAFT SCREEN — what a pick knows about the element,
 * and the messages that carry it from a screen frame to the host.
 *
 * ONE READER, TWO PICKERS (allowed-pattern #14). A draft is picked in two
 * places:
 *
 *   - the single-screen view, where the screen is the guest's top document and
 *     the stock picker (`inspect-bridge.ts` → `captureElement`) runs;
 *   - the canvas, where each screen is a sandboxed out-of-process frame the
 *     guest preload cannot reach, so main injects a small picker into each frame
 *     (`draftFramePickerSource`, run with `frame.executeJavaScript`).
 *
 * Both read the element through `readDraftElement`. The frame picker gets it
 * INLINED from its own source (`readDraftElement.toString()`), so the function
 * must name nothing outside itself: every constant it uses is defined inside
 * it, and the DOM reaches it through the narrow structural types below. That
 * also keeps this module DOM-free, so main, the renderer and the guest all
 * compile it unchanged.
 *
 * THE RELAY. A frame cannot talk to the host: it has no preload and an opaque
 * origin. It posts to its parent, the canvas page; the canvas page knows which
 * of ITS frames sent it (so the screen is never the frame's own claim), adds the
 * screen and the frame's box, and posts the result to itself; the guest preload
 * on the canvas page hears that same-origin message and relays it to the host
 * with `sendToHost`. Every hop re-validates with `parseDraftCanvasPick`.
 */

/** frame → canvas: the injected picker is up (the canvas answers with its state). */
export const DRAFT_FRAME_READY = 'flow-draft-frame-ready'
/** frame → canvas: one element picked. */
export const DRAFT_FRAME_PICK = 'flow-draft-frame-pick'
/** frame → canvas: Escape pressed inside a frame. */
export const DRAFT_FRAME_ESCAPE = 'flow-draft-frame-escape'
/** canvas → frame: inspect on or off, which element (by id) is selected there, and (`report`) whether to read it again. */
export const DRAFT_FRAME_STATE = 'flow-draft-frame-state'
/** canvas → itself (relayed to the host): one element picked, with its screen. */
export const DRAFT_CANVAS_PICK = 'flow-draft-pick'
/** canvas → itself (relayed to the host): the canvas's inspect toggle changed. */
export const DRAFT_CANVAS_INSPECT = 'flow-draft-inspect-state'

/** The computed style properties a pick reports, to seed the edit panel. */
export const DRAFT_PICK_STYLE_PROPERTIES = [
  'color',
  'background-color',
  'border-color',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
] as const

export type DraftPickStyleProperty = (typeof DRAFT_PICK_STYLE_PROPERTIES)[number]

/** What a pick knows about one stamped element of a screen. */
export interface DraftElementFacts {
  /** The element's stamped `data-flow-id` (the picked element's, or its nearest ancestor's). */
  id: string
  /** Lowercase tag name. */
  tag: string
  /** The element's explicit `role`, or ''. */
  role: string
  /** A short name: its label, alt or placeholder, else its text (at most 40 characters). */
  name: string
  /** The element's own text — what a text edit replaces. '' when it has none of its own. */
  text: string
  /** Whether a text edit can change this element in place. */
  textEditable: boolean
  /** Computed values of `DRAFT_PICK_STYLE_PROPERTIES`. */
  styles: Partial<Record<DraftPickStyleProperty, string>>
  /** A one-line summary for the agent: `<button data-flow-id="b7k2qx"> "Pay $27"`. */
  summary: string
}

// ── The structural DOM slice `readDraftElement` reads ────────────────────

export interface DraftPickNode {
  nodeType: number
  textContent: string | null
}

export interface DraftPickElement extends DraftPickNode {
  tagName: string
  getAttribute(name: string): string | null
  parentElement: DraftPickElement | null
  childNodes: ArrayLike<DraftPickNode>
  children: ArrayLike<unknown>
}

export interface DraftPickStyle {
  getPropertyValue(property: string): string
}

/**
 * Read a picked element: walk up to the nearest element carrying `idAttribute`
 * and report it, or null when no element up the tree carries one (an ordinary
 * page, or the screen's own `<html>`/`<body>` plumbing).
 *
 * SELF-CONTAINED ON PURPOSE — inlined into the frame picker by `toString()`.
 */
export function readDraftElement(
  start: DraftPickElement,
  styleOf: (element: DraftPickElement) => DraftPickStyle,
  idAttribute: string,
): DraftElementFacts | null {
  const VOID_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']
  const STYLE_PROPERTIES = [
    'color',
    'background-color',
    'border-color',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
  ]
  const TEXT_MAX = 10000
  let element: DraftPickElement | null = start
  let steps = 0
  while (element !== null && steps < 64) {
    const value = element.getAttribute(idAttribute)
    if (value !== null && value.length > 0) break
    element = element.parentElement
    steps += 1
  }
  if (element === null) return null
  const id = element.getAttribute(idAttribute)
  if (id === null || id.length === 0) return null
  const tag = element.tagName.toLowerCase()
  const role = (element.getAttribute('role') ?? '').trim()
  const runs: string[] = []
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes[index]
    if (node.nodeType === 3) {
      const run = (node.textContent ?? '').trim()
      if (run.length > 0) runs.push(run)
    }
  }
  const childElements = element.children.length
  const isVoid = VOID_TAGS.indexOf(tag) >= 0
  const textEditable = !isVoid && (childElements === 0 || runs.length === 1)
  const own = childElements === 0 ? (element.textContent ?? '').trim() : runs.length === 1 ? runs[0] : ''
  const whole = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
  const label = (
    element.getAttribute('aria-label') ??
    element.getAttribute('alt') ??
    element.getAttribute('placeholder') ??
    ''
  ).trim()
  const name = (label.length > 0 ? label : whole).slice(0, 40)
  const computed = styleOf(element)
  const styles: Record<string, string> = {}
  for (const property of STYLE_PROPERTIES) {
    const value = computed.getPropertyValue(property)
    if (typeof value === 'string' && value.length > 0) styles[property] = value.trim()
  }
  const shown = whole.slice(0, 60)
  return {
    id,
    tag,
    role,
    name,
    text: textEditable ? own.slice(0, TEXT_MAX) : '',
    textEditable,
    styles,
    summary: `<${tag} ${idAttribute}="${id}">${shown.length > 0 ? ` "${shown}"` : ''}`,
  }
}

// ── Validation at every hop ──────────────────────────────────────────────

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function record(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function shortString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

/** A pick's facts as sent by a page, or null when they are not readable. */
export function parseDraftElementFacts(raw: unknown): DraftElementFacts | null {
  const facts = record(raw)
  if (facts === null) return null
  const id = shortString(facts.id, 64)
  const tag = shortString(facts.tag, 64)
  if (id === null || !ID_PATTERN.test(id) || tag === null || !/^[a-z][a-z0-9-]*$/.test(tag)) return null
  const role = shortString(facts.role, 64) ?? ''
  const name = shortString(facts.name, 200) ?? ''
  const text = shortString(facts.text, 10_000) ?? ''
  const summary = shortString(facts.summary, 400) ?? `<${tag}>`
  const stylesIn = record(facts.styles) ?? {}
  const styles: Partial<Record<DraftPickStyleProperty, string>> = {}
  for (const property of DRAFT_PICK_STYLE_PROPERTIES) {
    const value = shortString(stylesIn[property], 120)
    if (value !== null) styles[property] = value
  }
  return { id, tag, role, name, text, textEditable: facts.textEditable === true, styles, summary }
}

/** Where a screen frame sits in the canvas page, in its CSS pixels. */
export interface DraftPickRect {
  x: number
  y: number
  width: number
  height: number
}

/** One pick in the canvas, as the canvas page relays it to the host. */
export interface DraftCanvasPick {
  /** The screen whose frame was picked in — decided by the canvas, never the frame. */
  screen: string
  /** The frame's box in the canvas page (for the screen's picture). */
  rect: DraftPickRect | null
  facts: DraftElementFacts
}

function parseRect(raw: unknown): DraftPickRect | null {
  const rect = record(raw)
  if (rect === null) return null
  const values = [rect.x, rect.y, rect.width, rect.height]
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
  const [x, y, width, height] = values as number[]
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** A relayed canvas pick, or null when it is not one. */
export function parseDraftCanvasPick(raw: unknown): DraftCanvasPick | null {
  const message = record(raw)
  if (message === null) return null
  const screen = shortString(message.screen, 64)
  if (screen === null || !SLUG_PATTERN.test(screen)) return null
  const facts = parseDraftElementFacts(message.facts)
  if (facts === null) return null
  return { screen, rect: parseRect(message.rect), facts }
}

// ── The injected frame picker ────────────────────────────────────────────
//
// Runs inside one sandboxed screen frame (opaque origin, no preload). Inert
// until the canvas turns inspect on; draws its own hover box, the selection
// outline and a small tag ("button · pay") in the frame's document — none of
// it is ever in the file, since edits go through main's patch. Re-injected by
// main on every frame load; a second injection into the same document is a
// no-op.

const FRAME_PICKER = `
(function (readDraftElement, idAttribute, MSG) {
  'use strict';
  if (window.__flowDraftPicker) return;
  window.__flowDraftPicker = true;
  var OWN = 'data-flow-draft-picker';
  var active = false;
  var selectedId = null;
  var hover = null, outline = null, tag = null, cursor = null;

  function box(css) {
    var node = document.createElement('div');
    node.setAttribute(OWN, '');
    node.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;display:none;box-sizing:border-box;' + css;
    document.documentElement.appendChild(node);
    return node;
  }
  function ensureUi() {
    if (hover) return;
    hover = box('background:rgba(43,108,255,0.14);border:1px solid rgba(43,108,255,0.9);border-radius:2px;');
    outline = box('border:2px solid #2b6cff;border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,0.6);');
    tag = box('z-index:2147483647;padding:2px 6px;border-radius:4px;background:#2b6cff;color:#fff;' +
      'font:600 11px/1.4 system-ui,-apple-system,sans-serif;white-space:nowrap;max-width:80vw;overflow:hidden;text-overflow:ellipsis;');
    cursor = document.createElement('style');
    cursor.setAttribute(OWN, '');
    cursor.textContent = '*,*::before,*::after{cursor:crosshair !important;}';
  }
  function carrier(node) {
    while (node && node.nodeType === 1) {
      if (node.hasAttribute(OWN)) return null;
      if (node.getAttribute(idAttribute)) return node;
      node = node.parentElement;
    }
    return null;
  }
  function byId(id) {
    if (!id) return null;
    var all = document.querySelectorAll('[' + idAttribute + ']');
    for (var i = 0; i < all.length; i += 1) if (all[i].getAttribute(idAttribute) === id) return all[i];
    return null;
  }
  function place(node, el) {
    var r = el.getBoundingClientRect();
    node.style.display = 'block';
    node.style.left = r.left + 'px';
    node.style.top = r.top + 'px';
    node.style.width = r.width + 'px';
    node.style.height = r.height + 'px';
    return r;
  }
  function tagText(facts) {
    var word = (facts.name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\\s+/)[0] || '';
    return word ? facts.tag + ' \\u00b7 ' + word : facts.tag;
  }
  function facts(el) {
    return readDraftElement(el, function (node) { return getComputedStyle(node); }, idAttribute);
  }
  function drawSelection() {
    ensureUi();
    var el = byId(selectedId);
    if (!el) { outline.style.display = 'none'; tag.style.display = 'none'; return; }
    var r = place(outline, el);
    var f = facts(el);
    tag.textContent = f ? tagText(f) : el.tagName.toLowerCase();
    tag.style.display = 'block';
    var top = r.top - 22 < 2 ? r.bottom + 4 : r.top - 22;
    tag.style.left = Math.max(2, r.left) + 'px';
    tag.style.top = top + 'px';
  }
  function onMove(event) {
    var el = carrier(event.target);
    if (!el) { hover.style.display = 'none'; return; }
    place(hover, el);
  }
  function swallow(event) { event.preventDefault(); event.stopPropagation(); }
  function onClick(event) {
    swallow(event);
    var el = carrier(event.target);
    if (!el) return;
    var f = facts(el);
    if (!f) return;
    selectedId = f.id;
    drawSelection();
    parent.postMessage({ type: MSG.pick, facts: f }, '*');
  }
  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    parent.postMessage({ type: MSG.escape }, '*');
  }
  var SWALLOWED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu', 'submit'];
  function setActive(on) {
    ensureUi();
    if (on === active) return;
    active = on;
    var method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('mousemove', onMove, true);
    document[method]('click', onClick, true);
    document[method]('keydown', onKey, true);
    SWALLOWED.forEach(function (type) { document[method](type, swallow, true); });
    if (on) document.head ? document.head.appendChild(cursor) : document.documentElement.appendChild(cursor);
    else if (cursor.parentNode) cursor.parentNode.removeChild(cursor);
    if (!on) hover.style.display = 'none';
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.type !== MSG.state) return;
    setActive(data.on === true);
    selectedId = typeof data.select === 'string' ? data.select : null;
    drawSelection();
    // After an undo or a restore the side panel asks again what the element is now.
    if (data.report === true && selectedId) {
      var again = byId(selectedId);
      var fresh = again ? facts(again) : null;
      if (fresh) parent.postMessage({ type: MSG.pick, facts: fresh, refresh: true }, '*');
    }
  });
  window.addEventListener('scroll', function () { if (selectedId) drawSelection(); }, true);
  window.addEventListener('resize', function () { if (selectedId) drawSelection(); });
  parent.postMessage({ type: MSG.ready }, '*');
})`

/**
 * The script main runs in each screen frame of a canvas: the picker above,
 * called with `readDraftElement` inlined from its source, the id attribute and
 * the message names.
 */
export function draftFramePickerSource(idAttribute: string): string {
  const messages = { ready: DRAFT_FRAME_READY, pick: DRAFT_FRAME_PICK, escape: DRAFT_FRAME_ESCAPE, state: DRAFT_FRAME_STATE }
  return `${FRAME_PICKER}(${readDraftElement.toString()}, ${JSON.stringify(idAttribute)}, ${JSON.stringify(messages)});`
}
