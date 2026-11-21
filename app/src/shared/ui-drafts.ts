/**
 * UI DRAFTS — the canvas folder's shape, its path rule and the page address,
 * shared by main (which serves, stamps and edits drafts) and the renderer
 * (which opens them). DOM-free and node-free on purpose: both sides import this
 * one module, so the rule a surface addresses and the rule the server accepts
 * can never disagree (allowed-pattern #14).
 *
 * A canvas is one folder in the knowledge folder:
 *
 *   flow/drafts/<canvas>/layout.json      screens, order, frames, titles, token sources
 *   flow/drafts/<canvas>/tokens.css       the shared tokens stylesheet
 *   flow/drafts/<canvas>/<screen>.html    one plain HTML file per screen
 *   flow/drafts/<canvas>/.history/        undo snapshots (personal, never synced)
 *   flow/drafts/<canvas>/versions/<v>/    named versions (synced)
 *
 * Only the first three are ADDRESSABLE: `resolveDraftPath` is the one gate
 * serving and writing both use, and it refuses anything else lexically —
 * traversal, nesting, other kinds. History and versions are written by main
 * alone, from a canvas folder the gate already accepted.
 */

import { WALKTHROUGH_PAGE_SCHEME } from './walkthrough-page'

/** The knowledge folder's drafts dir, relative to a project root. */
export const DRAFTS_DIR = 'flow/drafts'

/** The canvas's layout file. */
export const DRAFT_LAYOUT_FILE = 'layout.json'

/** The canvas's shared tokens stylesheet. */
export const DRAFT_TOKENS_FILE = 'tokens.css'

/** The undo snapshots of one canvas (personal — a knowledge-class row). */
export const DRAFT_HISTORY_DIR = '.history'

/** The named versions of one canvas (authored — synced with the team). */
export const DRAFT_VERSIONS_DIR = 'versions'

/** One version's own description, beside its copied files. */
export const DRAFT_VERSION_FILE = 'version.json'

/** Per-machine view state of a canvas (zoom, pan) — personal. */
export const DRAFT_VIEW_STATE_FILE = '.view-state.json'

/** The attribute Flow stamps on every element of a screen. */
export const DRAFT_ID_ATTRIBUTE = 'data-flow-id'

/** The host the drafts are served from, on the walkthrough page scheme. */
export const DRAFTS_PAGE_HOST = 'drafts'

/** How many undo snapshots one screen keeps. */
export const DRAFT_HISTORY_LIMIT = 50

/** A canvas slug, a screen name, a version slug: lowercase words joined by dashes. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const SLUG_MAX = 64

/** Whether `value` is a canvas, screen or version slug. */
export function isDraftSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SLUG_MAX && SLUG_PATTERN.test(value)
}

// ── Layout ───────────────────────────────────────────────────────────────

/** Where a screen's frame sits on the canvas, in canvas pixels. */
export interface DraftFrame {
  x: number
  y: number
  w: number
  h: number
}

/** One screen of a canvas, as the layout file names it. */
export interface DraftScreenRef {
  /** The screen's slug — its file is `<id>.html`. */
  id: string
  /** The screen's file name inside the canvas folder (`<id>.html`). */
  file: string
  /** The name shown on its frame. */
  title: string
  /** Position in the flow (ascending). */
  order: number
  frame: DraftFrame
}

/** A canvas's layout file. */
export interface DraftLayout {
  /** The canvas's display name. */
  name: string
  /** The project files the agent read its tokens from. */
  tokenSources: string[]
  screens: DraftScreenRef[]
}

/** The frame a screen gets when the layout names none: a row, left to right. */
export const DEFAULT_DRAFT_FRAME = { w: 390, h: 844, gap: 80 } as const

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Read a parsed layout file. Strict on what it relies on (screen ids are slugs,
 * files are `<id>.html`, no screen twice), forgiving on what it can default (a
 * missing frame or order is placed in a row; a missing name is the canvas's).
 * A layout that cannot be read answers a sentence.
 */
export function parseDraftLayout(
  raw: unknown,
  canvas: string,
): { ok: true; layout: DraftLayout } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'The layout is not an object.' }
  }
  const record = raw as Record<string, unknown>
  const name = typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : canvas
  const tokenSources = Array.isArray(record.tokenSources)
    ? record.tokenSources.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (!Array.isArray(record.screens)) return { ok: false, reason: 'The layout lists no screens.' }
  const screens: DraftScreenRef[] = []
  const seen = new Set<string>()
  for (const [index, entry] of record.screens.entries()) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, reason: `Screen ${index + 1} in the layout is not an object.` }
    }
    const screen = entry as Record<string, unknown>
    const fileName = typeof screen.file === 'string' ? screen.file : undefined
    const id =
      typeof screen.id === 'string' ? screen.id : fileName?.endsWith('.html') ? fileName.slice(0, -5) : undefined
    if (!isDraftSlug(id)) return { ok: false, reason: `Screen ${index + 1} in the layout has no valid name.` }
    const file = `${id}.html`
    if (fileName !== undefined && fileName !== file) {
      return { ok: false, reason: `Screen "${id}" names a file other than its own.` }
    }
    if (seen.has(id)) return { ok: false, reason: `Screen "${id}" is listed twice.` }
    seen.add(id)
    const frame = (screen.frame ?? {}) as Record<string, unknown>
    const order = isFiniteNumber(screen.order) ? screen.order : index
    screens.push({
      id,
      file,
      title: typeof screen.title === 'string' && screen.title.trim().length > 0 ? screen.title.trim() : id,
      order,
      frame: {
        x: isFiniteNumber(frame.x) ? frame.x : index * (DEFAULT_DRAFT_FRAME.w + DEFAULT_DRAFT_FRAME.gap),
        y: isFiniteNumber(frame.y) ? frame.y : 0,
        w: isFiniteNumber(frame.w) && frame.w > 0 ? frame.w : DEFAULT_DRAFT_FRAME.w,
        h: isFiniteNumber(frame.h) && frame.h > 0 ? frame.h : DEFAULT_DRAFT_FRAME.h,
      },
    })
  }
  screens.sort((a, b) => a.order - b.order)
  return { ok: true, layout: { name, tokenSources, screens } }
}

// ── The path rule (note 1) ───────────────────────────────────────────────

/** What an addressable draft file is. */
export type DraftFileKind = 'layout' | 'tokens' | 'screen'

export type DraftPathResolution =
  | { ok: true; relPath: string; kind: DraftFileKind; screen?: string }
  | { ok: false; reason: string }

/**
 * THE lexical path rule for drafts: one canvas folder directly under
 * `flow/drafts/`, and one known file directly inside it — the layout, the
 * tokens stylesheet, or a screen. Slugs only, so `..`, `/`, `\`, dotfiles,
 * nesting and absolute paths are all refused before any filesystem is touched.
 * `root` is NOT judged here beyond being present — only main knows which roots
 * exist, and it gates them before calling this.
 */
export function resolveDraftPath(root: string, canvas: string, file: string): DraftPathResolution {
  if (typeof root !== 'string' || root.length === 0) return { ok: false, reason: 'no project root' }
  if (!isDraftSlug(canvas)) return { ok: false, reason: 'not a canvas name' }
  if (typeof file !== 'string') return { ok: false, reason: 'not a draft file' }
  const base = `${DRAFTS_DIR}/${canvas}`
  if (file === DRAFT_LAYOUT_FILE) return { ok: true, relPath: `${base}/${file}`, kind: 'layout' }
  if (file === DRAFT_TOKENS_FILE) return { ok: true, relPath: `${base}/${file}`, kind: 'tokens' }
  if (file.endsWith('.html')) {
    const screen = file.slice(0, -5)
    if (isDraftSlug(screen)) return { ok: true, relPath: `${base}/${file}`, kind: 'screen', screen }
  }
  return { ok: false, reason: 'not a draft file' }
}

/** The canvas folder, relative to the root — or null for a name that is not a slug. */
/**
 * The draft screen an absolute file path names — `<root>/flow/drafts/<canvas>/<screen>.html`
 * — or null. Lets a link to a screen file open as the screen Flow serves (which
 * scrolls and stays sandboxed) rather than as a raw file.
 */
export function draftScreenAtPath(absPath: string): { root: string; canvas: string; screen: string } | null {
  const path = absPath.replace(/\\/g, '/')
  const marker = `/${DRAFTS_DIR}/`
  const at = path.lastIndexOf(marker)
  if (at <= 0) return null
  const match = /^([^/]+)\/([^/]+)\.html$/.exec(path.slice(at + marker.length))
  if (match === null) return null
  const [, canvas, screen] = match
  if (!isDraftSlug(canvas) || !isDraftSlug(screen)) return null
  return { root: path.slice(0, at), canvas, screen }
}

export function draftCanvasDir(canvas: string): string | null {
  return isDraftSlug(canvas) ? `${DRAFTS_DIR}/${canvas}` : null
}

// ── Edits ────────────────────────────────────────────────────────────────

export type DraftColourProperty = 'color' | 'background-color' | 'border-color'
export const DRAFT_COLOUR_PROPERTIES: readonly DraftColourProperty[] = ['color', 'background-color', 'border-color']

export type DraftSpacingProperty =
  | 'padding'
  | 'padding-top'
  | 'padding-right'
  | 'padding-bottom'
  | 'padding-left'
  | 'margin'
  | 'margin-top'
  | 'margin-right'
  | 'margin-bottom'
  | 'margin-left'
  | 'gap'
export const DRAFT_SPACING_PROPERTIES: readonly DraftSpacingProperty[] = [
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
]

/** One in-place change to one element, addressed by its stamped id. */
export type DraftEdit =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'colour'; property: DraftColourProperty; value: string }
  | { id: string; kind: 'spacing'; property: DraftSpacingProperty; value: string }

/** The CSS named colours (CSS Color 4), plus `transparent` and `currentcolor`. */
const NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
    'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
    'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
    'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
    'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor'
  ).split(' '),
)

const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_NUMBER = '\\s*\\d{1,3}(?:\\.\\d+)?%?\\s*'
const RGB_ALPHA = '\\s*(?:0|1|0?\\.\\d+|\\d{1,3}%)\\s*'
const RGB_COLOUR = new RegExp(`^rgba?\\(${RGB_NUMBER},${RGB_NUMBER},${RGB_NUMBER}(?:,${RGB_ALPHA})?\\)$`, 'i')

/** Whether `value` is a colour an edit may write: hex, rgb()/rgba(), or a CSS named colour. */
export function isDraftColour(value: string): boolean {
  const trimmed = value.trim()
  return HEX_COLOUR.test(trimmed) || RGB_COLOUR.test(trimmed) || NAMED_COLOURS.has(trimmed.toLowerCase())
}

const SPACING_VALUE = /^(?:0|\d{1,4}(?:\.\d{1,3})?(?:px|rem))$/

/** Whether `value` is a spacing an edit may write: a number with px or rem, or 0. */
export function isDraftSpacing(value: string): boolean {
  return SPACING_VALUE.test(value.trim())
}

/** An element id an edit may address (Flow's own ids, or a short agent-written one). */
const ELEMENT_ID = /^[A-Za-z0-9_-]{1,64}$/

/** The longest text an in-place edit may write. */
export const DRAFT_TEXT_MAX = 10_000

/**
 * Validate an edit at the boundary. Every value is checked strictly — a colour
 * is hex, rgb() or named; a spacing is a number with px/rem or 0 — because the
 * value is written into a `style` attribute, and anything looser could close it.
 */
export function validateDraftEdit(raw: unknown): { ok: true; edit: DraftEdit } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'The change is not readable.' }
  const edit = raw as Record<string, unknown>
  if (typeof edit.id !== 'string' || !ELEMENT_ID.test(edit.id)) {
    return { ok: false, reason: 'The change does not name an element.' }
  }
  const id = edit.id
  if (edit.kind === 'text') {
    if (typeof edit.text !== 'string') return { ok: false, reason: 'The new text is missing.' }
    if (edit.text.length > DRAFT_TEXT_MAX) return { ok: false, reason: 'The new text is too long.' }
    return { ok: true, edit: { id, kind: 'text', text: edit.text } }
  }
  if (edit.kind === 'colour') {
    const property = DRAFT_COLOUR_PROPERTIES.find((candidate) => candidate === edit.property)
    if (property === undefined) return { ok: false, reason: 'That colour cannot be changed here.' }
    if (typeof edit.value !== 'string' || !isDraftColour(edit.value)) {
      return { ok: false, reason: 'That is not a colour Flow can write.' }
    }
    return { ok: true, edit: { id, kind: 'colour', property, value: edit.value.trim() } }
  }
  if (edit.kind === 'spacing') {
    const property = DRAFT_SPACING_PROPERTIES.find((candidate) => candidate === edit.property)
    if (property === undefined) return { ok: false, reason: 'That spacing cannot be changed here.' }
    if (typeof edit.value !== 'string' || !isDraftSpacing(edit.value)) {
      return { ok: false, reason: 'That is not a spacing Flow can write.' }
    }
    return { ok: true, edit: { id, kind: 'spacing', property, value: edit.value.trim() } }
  }
  return { ok: false, reason: 'That kind of change is not supported.' }
}

// ── The page address ─────────────────────────────────────────────────────
//
// PATH-BASED ON PURPOSE. A screen links its stylesheet as `tokens.css`, and the
// canvas page frames `home.html`; both resolve against the document's URL. With
// the root in the PATH (one base64url segment) a relative link stays inside its
// own canvas and keeps its root — a query parameter would be dropped by every
// relative resolution.
//
//   flow-page://drafts/<root>/<canvas>/                  the canvas viewer page
//   flow-page://drafts/<root>/<canvas>/<screen>.html     a screen, framed
//   flow-page://drafts/<root>/<canvas>/<screen>.html?view=single   a screen alone
//   flow-page://drafts/<root>/<canvas>/tokens.css        the tokens stylesheet
//   flow-page://drafts/<root>/<canvas>/layout.json       the layout file
//
// `v=` is a cache-buster the server ignores.

export type DraftScreenMode = 'framed' | 'single'

export type DraftPageRequest =
  | { kind: 'canvas'; root: string; canvas: string }
  | { kind: 'screen'; root: string; canvas: string; screen: string; mode: DraftScreenMode }
  | { kind: 'asset'; root: string; canvas: string; file: typeof DRAFT_TOKENS_FILE | typeof DRAFT_LAYOUT_FILE }

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function utf8Bytes(text: string): number[] {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  }
  return bytes
}

function fromUtf8(bytes: number[]): string | null {
  let out = ''
  let index = 0
  while (index < bytes.length) {
    const first = bytes[index]
    let code: number
    let extra: number
    if (first < 0x80) [code, extra] = [first, 0]
    else if (first >> 5 === 6) [code, extra] = [first & 31, 1]
    else if (first >> 4 === 14) [code, extra] = [first & 15, 2]
    else if (first >> 3 === 30) [code, extra] = [first & 7, 3]
    else return null
    for (let step = 1; step <= extra; step += 1) {
      const next = bytes[index + step]
      if (next === undefined || next >> 6 !== 2) return null
      code = (code << 6) | (next & 63)
    }
    out += String.fromCodePoint(code)
    index += extra + 1
  }
  return out
}

/** A project root as one URL path segment (base64url, no padding). */
export function encodeDraftRoot(root: string): string {
  const bytes = utf8Bytes(root)
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const [a, b, c] = [bytes[index], bytes[index + 1], bytes[index + 2]]
    const chunk = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64_ALPHABET[(chunk >> 18) & 63] + BASE64_ALPHABET[(chunk >> 12) & 63]
    if (b !== undefined) out += BASE64_ALPHABET[(chunk >> 6) & 63]
    if (c !== undefined) out += BASE64_ALPHABET[chunk & 63]
  }
  return out
}

/** The inverse of `encodeDraftRoot`, or null for a segment that is not one. */
export function decodeDraftRoot(segment: string): string | null {
  if (segment.length === 0 || segment.length % 4 === 1) return null
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of segment) {
    const value = BASE64_ALPHABET.indexOf(char)
    if (value < 0) return null
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 255)
    }
  }
  const root = fromUtf8(bytes)
  return root !== null && root.length > 0 && encodeDraftRoot(root) === segment ? root : null
}

/** The URL of one draft page. */
export function draftPageUrl(request: DraftPageRequest, version?: number | string): string {
  const base = `${WALKTHROUGH_PAGE_SCHEME}://${DRAFTS_PAGE_HOST}/${encodeDraftRoot(request.root)}/${request.canvas}/`
  const query: string[] = []
  let url: string
  if (request.kind === 'canvas') url = base
  else if (request.kind === 'asset') url = `${base}${request.file}`
  else {
    url = `${base}${request.screen}.html`
    if (request.mode === 'single') query.push('view=single')
  }
  if (version !== undefined) query.push(`v=${encodeURIComponent(String(version))}`)
  return query.length === 0 ? url : `${url}?${query.join('&')}`
}

/**
 * Parse a drafts URL, or null when it is not one — wrong scheme or host, a root
 * segment that does not decode, a canvas or file outside the path rule. Root
 * membership is NOT decided here: only main knows which roots exist.
 */
export function parseDraftPageUrl(url: string): DraftPageRequest | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${WALKTHROUGH_PAGE_SCHEME}:`) return null
  if (parsed.hostname !== DRAFTS_PAGE_HOST) return null
  // Raw path: URL parsing has already collapsed `.`/`..` segments, so a
  // traversal attempt arrives here as a shorter path and fails the shape check.
  const segments = parsed.pathname.split('/')
  if (segments.length !== 4 || segments[0] !== '') return null
  const [, rootSegment, canvas, file] = segments
  const root = decodeDraftRoot(rootSegment)
  if (root === null || !isDraftSlug(canvas)) return null
  if (file === '') return { kind: 'canvas', root, canvas }
  const resolution = resolveDraftPath(root, canvas, file)
  if (!resolution.ok) return null
  if (resolution.kind === 'screen' && resolution.screen !== undefined) {
    const mode: DraftScreenMode = parsed.searchParams.get('view') === 'single' ? 'single' : 'framed'
    return { kind: 'screen', root, canvas, screen: resolution.screen, mode }
  }
  return { kind: 'asset', root, canvas, file: resolution.kind === 'layout' ? DRAFT_LAYOUT_FILE : DRAFT_TOKENS_FILE }
}

/** The host a `flow-page` URL names, or null when it is not one. */
export function flowPageHost(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === `${WALKTHROUGH_PAGE_SCHEME}:` ? parsed.hostname : null
  } catch {
    return null
  }
}

// ── Change events ────────────────────────────────────────────────────────

/** One canvas changed on disk: which project, which canvas, which of its files. */
export interface DraftsChangedEvent {
  rootPath: string
  canvas: string
  /** File names inside the canvas folder (`layout.json`, `home.html`, …). */
  files: string[]
}

// ── IPC answers ──────────────────────────────────────────────────────────

/** One canvas in a project's drafts folder, as `drafts:list` answers it. */
export interface DraftCanvasSummary {
  canvas: string
  /** The layout's name, or the canvas slug when the layout cannot be read. */
  name: string
  screenCount: number
  /** How many of the layout's screens exist as files — the writing's progress. */
  screensWritten?: number
  /** When the layout or its newest written screen last changed (ms since epoch). */
  updatedAt?: number
  /** Present when the layout cannot be read — a sentence for a person. */
  problem?: string
}

/** A named version of a canvas. */
export interface DraftVersionInfo {
  /** The version's folder name. */
  version: string
  /** The name a person gave it. */
  name: string
  /** ISO time it was saved. */
  savedAt: string
}

/** The answer of every verb that writes a draft: done, or a sentence saying why not. */
export type DraftWriteAnswer = { ok: true } | { ok: false; reason: string }

/** Done — with the canvas files it put back, so the page can reload them — or a sentence saying why not. */
export type DraftFilesAnswer = { ok: true; files: string[] } | { ok: false; reason: string }

/** The answer of `drafts:readLayout`. */
export type DraftLayoutAnswer = { ok: true; layout: DraftLayout } | { ok: false; reason: string }

/** The answer of `drafts:saveVersion`. */
export type DraftSaveVersionAnswer = { ok: true; version: DraftVersionInfo } | { ok: false; reason: string }

/**
 * A version's folder name, derived from the name a person typed: lowercase
 * words joined by dashes — or null when nothing usable is left. Sanitized, not
 * refused (allowed-pattern #22): the name shown is kept in `version.json`.
 */
export function draftVersionSlug(name: string): string | null {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  return isDraftSlug(slug) ? slug : null
}
