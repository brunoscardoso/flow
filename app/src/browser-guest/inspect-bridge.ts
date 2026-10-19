/**
 * In-guest inspect bridge for the embedded browser's <webview>.
 *
 * This module runs INSIDE the guest page (loaded by the guest preload,
 * browser-guest.ts) — it is DOM code. It lives under src/browser-guest/ (its own
 * compilation target, tsconfig.guest.json, which enables the DOM lib) rather than
 * src/main, so the DOM lib is scoped to the guest bundle and never leaks into the
 * main/preload/test program. It touches NO Electron API — the host-side toggle
 * helper lives in src/main/browser/inspect-host.ts.
 *
 * What it does:
 *   - an inspect-mode element picker (hover highlight overlay + click to select);
 *   - it is STICKY: after a pick it stays active, so every subsequent click adds
 *     another element to context. The host toggle (or Escape) ends the session;
 *     on Escape the bridge tells the host so the toolbar button resets.
 *   - on click, resolves the picked element back to its React source by walking
 *     the React fiber to `_debugSource`, behind a small version adapter that
 *     accepts React 16 (`__reactInternalInstance$`) and 17+ (`__reactFiber$`);
 *   - falls back to selector + DOM summary when `_debugSource` is absent
 *     (production builds, or a non-React page);
 *   - produces a `BrowserElementPayload` (the shared capture type).
 *
 * React fiber internals are untyped — every access goes through the narrow
 * `ReactFiber` interface below plus a single cast at the DOM boundary, never
 * `any` sprawl.
 */
import type { BrowserElementPayload } from '../shared/browser-capture-types'

// ── React fiber shapes (untyped internals — narrow local interfaces) ─────────

/** The `_debugSource` shape emitted by the JSX dev transform. */
interface ReactDebugSource {
  fileName?: string
  lineNumber?: number
  columnNumber?: number
}

/** The slice of a React fiber node this bridge reads. */
interface ReactFiber {
  return: ReactFiber | null
  /** A component fiber's type is its function/class; a host fiber's is a tag string. */
  type: unknown
  memoizedProps?: Record<string, unknown> | null
  _debugSource?: ReactDebugSource | null
}

/** A function/class component's carrier of a display name. */
interface NamedComponent {
  displayName?: string
  name?: string
  render?: { displayName?: string; name?: string }
}

/** How many named ancestor components to include in a component path. */
const MAX_PATH_DEPTH = 5
/** Hard cap on fiber walks — guards against a corrupt/cyclic chain. */
const MAX_FIBER_WALK = 200
/** How many props to serialize before truncating. */
const MAX_PROPS = 20

/**
 * The React fiber for a DOM node, or null. React 17+ stashes it under a
 * `__reactFiber$<hash>` key; React 16 under `__reactInternalInstance$<hash>`.
 */
function fiberFromNode(node: Element): ReactFiber | null {
  const holder = node as unknown as Record<string, unknown>
  for (const key of Object.keys(holder)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      return (holder[key] as ReactFiber | undefined) ?? null
    }
  }
  return null
}

/** The display name of a component fiber's `type`, or null for host/anonymous. */
function componentName(type: unknown): string | null {
  if (typeof type === 'function') {
    const fn = type as NamedComponent
    return fn.displayName ?? (fn.name || null)
  }
  // memo() / forwardRef() wrappers are objects carrying a name or a `render`.
  if (typeof type === 'object' && type !== null) {
    const wrapper = type as NamedComponent
    return wrapper.displayName ?? wrapper.render?.displayName ?? wrapper.render?.name ?? null
  }
  return null
}

/** `App > Sidebar > NavItem` — the nearest named component ancestors, outermost first. */
function componentPath(fiber: ReactFiber | null): string {
  const names: string[] = []
  let current = fiber
  let steps = 0
  while (current !== null && steps < MAX_FIBER_WALK) {
    steps += 1
    const name = componentName(current.type)
    if (name !== null) {
      names.unshift(name)
      if (names.length >= MAX_PATH_DEPTH) break
    }
    current = current.return
  }
  return names.join(' > ')
}

/** The nearest `_debugSource` walking up the fiber chain, or null. */
function resolveSource(fiber: ReactFiber | null): ReactDebugSource | null {
  let current = fiber
  let steps = 0
  while (current !== null && steps < MAX_FIBER_WALK) {
    steps += 1
    const source = current._debugSource
    if (source && typeof source.fileName === 'string' && source.fileName.length > 0) return source
    current = current.return
  }
  return null
}

/** Escape a string for use in a CSS selector (`CSS.escape` with a fallback). */
function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS
  if (css?.escape) return css.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`)
}

/** The class tokens of an element, whatever `className`'s runtime shape. */
function classTokens(el: Element): string[] {
  const raw = typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? ''
  return raw.trim().split(/\s+/).filter((token) => token.length > 0)
}

/** A short, reasonably-stable CSS selector locating `el` in the live DOM. */
function cssSelector(el: Element): string {
  const parts: string[] = []
  let node: Element | null = el
  let depth = 0
  while (node !== null && node.nodeType === 1 && depth < MAX_PATH_DEPTH) {
    if (node.id.length > 0) {
      parts.unshift(`#${cssEscape(node.id)}`)
      break
    }
    let part = node.tagName.toLowerCase()
    const classes = classTokens(node)
    if (classes.length > 0) part += `.${classes.slice(0, 2).map(cssEscape).join('.')}`
    const parent = node.parentElement
    if (parent !== null) {
      const tag = node.tagName
      const twins = Array.from(parent.children).filter((child) => child.tagName === tag)
      if (twins.length > 1) part += `:nth-of-type(${String(twins.indexOf(node) + 1)})`
    }
    parts.unshift(part)
    node = node.parentElement
    depth += 1
  }
  return parts.join(' > ')
}

/** `<button#save.primary> "Save changes"` — a one-line human summary. */
function domSummary(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const id = el.id.length > 0 ? `#${el.id}` : ''
  const classes = classTokens(el)
  const cls = classes.length > 0 ? `.${classes.slice(0, 3).join('.')}` : ''
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)
  return `<${tag}${id}${cls}>${text.length > 0 ? ` "${text}"` : ''}`
}

/** Stringify a single prop value without leaking a DOM/React object graph. */
function stringifyValue(value: unknown): string {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string') return value as string
  if (type === 'number' || type === 'boolean' || type === 'bigint' || type === 'undefined') {
    return String(value)
  }
  if (type === 'function') return `ƒ ${(value as NamedComponent).name ?? 'anonymous'}`
  try {
    return JSON.stringify(value)?.slice(0, 200) ?? String(value)
  } catch {
    return '[unserializable]'
  }
}

/** Serialized props (per-value stringified), or undefined when there are none. */
function serializeProps(props: Record<string, unknown> | null | undefined): Record<string, string> | undefined {
  if (!props) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue
    out[key] = stringifyValue(value)
    if (Object.keys(out).length >= MAX_PROPS) break
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Resolve a picked DOM element to a `BrowserElementPayload`. Always yields a
 * selector + DOM summary; adds `componentPath` / `sourceFile` / `sourceLine` /
 * `props` only when the React fiber (and, for source, `_debugSource`) is present.
 */
export function captureElement(el: Element): BrowserElementPayload {
  const fiber = fiberFromNode(el)
  const source = resolveSource(fiber)
  const path = componentPath(fiber)
  const payload: BrowserElementPayload = {
    componentPath: path.length > 0 ? path : el.tagName.toLowerCase(),
    selector: cssSelector(el),
    domSummary: domSummary(el),
  }
  if (source?.fileName) {
    payload.sourceFile = source.fileName
    if (typeof source.lineNumber === 'number') payload.sourceLine = source.lineNumber
  }
  const props = serializeProps(fiber?.memoizedProps)
  if (props) payload.props = props
  return payload
}

// ── The picker: hover highlight + click-to-select (sticky) ───────────────────

const OVERLAY_ATTR = 'data-flow-inspect-overlay'

/** The in-guest picker; `createInspectBridge` wires it to a capture sink. */
export interface InspectBridge {
  activate(): void
  deactivate(): void
  readonly active: boolean
}

/** Callbacks the guest preload wires the picker to. */
export interface InspectBridgeHandlers {
  /** One payload per click. The picker STAYS active — click again for another. */
  onCapture: (payload: BrowserElementPayload) => void
  /** The picker deactivated itself from inside the guest (Escape). Lets the host
   *  reset its toolbar toggle. NOT called for a host-driven `deactivate()`. */
  onDeactivate: () => void
}

/** A one-line descriptor of an element for the hover label: `<tag>#id.class`. */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const id = el.id.length > 0 ? `#${el.id}` : ''
  const cls =
    typeof el.className === 'string' && el.className.trim().length > 0
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : ''
  return `${tag}${id}${cls}`
}

/**
 * Build the picker. It is STICKY: `onCapture` fires once per click and the
 * picker stays active so a whole set of elements can be added in one session.
 * Escape ends the session (and calls `onDeactivate` so the host untoggles); the
 * host can also end it by calling `deactivate()`.
 *
 * While active it makes the mode UNMISTAKABLE and takes the page out of the loop:
 *   - a crosshair cursor forced EVERYWHERE (`!important`, overriding the page);
 *   - a highlight box with a label naming the targeted element;
 *   - a banner across the top;
 *   - every mouse/pointer interaction is swallowed, so a click SELECTS an
 *     element instead of activating the page (a link never navigates).
 */
export function createInspectBridge(handlers: InspectBridgeHandlers): InspectBridge {
  let active = false
  let overlay: HTMLDivElement | null = null
  let hoverLabel: HTMLDivElement | null = null
  let banner: HTMLDivElement | null = null
  let cursorStyle: HTMLStyleElement | null = null

  const ensureUi = (): void => {
    if (overlay === null) {
      overlay = document.createElement('div')
      overlay.setAttribute(OVERLAY_ATTR, '')
      overlay.style.cssText = [
        'position:fixed', 'z-index:2147483646', 'pointer-events:none',
        'background:rgba(80,140,255,0.22)', 'border:2px solid rgba(80,140,255,0.95)',
        'border-radius:3px', 'box-shadow:0 0 0 1px rgba(255,255,255,0.5)',
        'transition:all 40ms ease-out', 'display:none',
      ].join(';')
      document.documentElement.appendChild(overlay)
    }
    if (hoverLabel === null) {
      hoverLabel = document.createElement('div')
      hoverLabel.setAttribute(OVERLAY_ATTR, '')
      hoverLabel.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'pointer-events:none',
        'padding:2px 6px', 'border-radius:3px',
        'background:rgba(40,90,200,0.97)', 'color:#fff',
        'font:600 11px/1.4 ui-monospace,Menlo,Consolas,monospace',
        'white-space:nowrap', 'max-width:60vw', 'overflow:hidden',
        'text-overflow:ellipsis', 'display:none',
      ].join(';')
      document.documentElement.appendChild(hoverLabel)
    }
    if (banner === null) {
      banner = document.createElement('div')
      banner.setAttribute(OVERLAY_ATTR, '')
      banner.textContent = 'Inspect mode — click any element to add it to chat · Esc to stop'
      banner.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'pointer-events:none',
        'top:10px', 'left:50%', 'transform:translateX(-50%)',
        'padding:6px 12px', 'border-radius:999px',
        'background:rgba(40,90,200,0.97)', 'color:#fff',
        'font:600 12px/1 -apple-system,Segoe UI,sans-serif',
        'box-shadow:0 4px 14px rgba(0,0,0,0.35)', 'display:none',
      ].join(';')
      document.documentElement.appendChild(banner)
    }
    if (cursorStyle === null) {
      cursorStyle = document.createElement('style')
      cursorStyle.textContent = '*,*::before,*::after{cursor:crosshair !important;}'
    }
  }

  const isOwnUi = (node: EventTarget | null): boolean =>
    node instanceof Element && node.hasAttribute(OVERLAY_ATTR)

  const positionOverlay = (el: Element): void => {
    ensureUi()
    const rect = el.getBoundingClientRect()
    if (overlay !== null) {
      overlay.style.display = 'block'
      overlay.style.left = `${String(rect.left)}px`
      overlay.style.top = `${String(rect.top)}px`
      overlay.style.width = `${String(rect.width)}px`
      overlay.style.height = `${String(rect.height)}px`
    }
    if (hoverLabel !== null) {
      hoverLabel.textContent = describeElement(el)
      hoverLabel.style.display = 'block'
      const top = rect.top - 20 < 4 ? rect.top + 4 : rect.top - 20
      hoverLabel.style.left = `${String(Math.max(2, rect.left))}px`
      hoverLabel.style.top = `${String(top)}px`
    }
  }

  const onMove = (event: MouseEvent): void => {
    const target = event.target
    if (target instanceof Element && !isOwnUi(target)) positionOverlay(target)
  }

  /** Swallow a page interaction so a pick never drives the app. */
  const swallow = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  const onClick = (event: MouseEvent): void => {
    swallow(event)
    const target = event.target
    if (!(target instanceof Element) || isOwnUi(target)) return
    // STICKY: capture and stay active so the next click adds another element.
    try {
      handlers.onCapture(captureElement(target))
    } catch (error) {
      console.error('flow: inspect capture failed', error)
    }
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    deactivate()
    handlers.onDeactivate()
  }

  /** Interactions swallowed while active (click is handled separately). */
  const SWALLOWED = [
    'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu', 'submit',
  ]

  const activate = (): void => {
    if (active) return
    active = true
    ensureUi()
    if (cursorStyle !== null && cursorStyle.parentNode === null) document.head.appendChild(cursorStyle)
    if (banner !== null) banner.style.display = 'block'
    // Capture phase so we see events before the guest app's own handlers.
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    for (const type of SWALLOWED) document.addEventListener(type, swallow, true)
  }

  function deactivate(): void {
    if (!active) return
    active = false
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
    for (const type of SWALLOWED) document.removeEventListener(type, swallow, true)
    if (cursorStyle !== null && cursorStyle.parentNode !== null) cursorStyle.remove()
    if (overlay !== null) overlay.style.display = 'none'
    if (hoverLabel !== null) hoverLabel.style.display = 'none'
    if (banner !== null) banner.style.display = 'none'
  }

  return {
    activate,
    deactivate,
    get active() {
      return active
    },
  }
}