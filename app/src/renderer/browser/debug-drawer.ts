/**
 * Debug drawer for the embedded browser tab — a collapsible bar mounted BELOW
 * the `<webview>` with **Console** and **Network** sub-tabs. It is the missing
 * UI trigger for console/network tagging: the toolbar's "Tag recent" and each
 * row's "Tag" call `browser.tagRecent` / `browser.tagEntry`, which route the
 * capture through the Phase-6 boundary and post it as a composer chip. This
 * drawer wires none of that chip logic — it only fires the two verbs.
 *
 * ── Visibility gating (allowed-pattern #17) ────────────────────────────────
 * `browser:bufferUpdated` is a HOT stream (CDP captures arrive continuously
 * while the page runs). The subscription therefore does the cheapest possible
 * thing off-screen: it stores the latest counts in a field and, when the tab is
 * not visible (`element.offsetParent === null` — the same test the blueprint
 * board uses), sets a dirty flag and RETURNS without touching the DOM. An
 * IntersectionObserver settles a single refresh when the tab is revealed. On
 * screen, a badge repaint is cheap and the row list is re-read only when the
 * drawer is expanded and the changed kind is the active sub-tab.
 *
 * Entries are read through a BOUNDED slice (`bufferSlice(..., last-n)`), never
 * the whole buffer (allowed-pattern #18 — the main side owns the store).
 */
import '../components'
import type { FlButton } from '../components'
import type {
  BrowserBufferCounts,
  BrowserCapture,
  BrowserCaptureKind,
} from '../../shared/browser-capture-types'
import type { FlowBrowserApi } from '../../shared/ipc-contract'
import { renderConsoleRow } from './console-row'
import { renderNetworkRow } from './network-row'
import { DEFAULT_DRAWER_HEIGHT, HEIGHT_KEY, clampDrawerHeight } from './drawer-height'
import { addCapturesToContext } from './browser-capture-chip'

/** The two kinds this drawer surfaces (element captures come from inspect mode). */
type DebugKind = 'console' | 'network'

/** Just the browser IPC surface the drawer needs — a subset of the live bridge,
 *  so `window.flow.browser` is assignable without adaptation. */
export type DebugDrawerBrowserApi = Pick<
  FlowBrowserApi,
  'bufferSlice' | 'tagRecent' | 'tagEntry' | 'onBufferUpdated'
>

/** How many entries the row list shows (a bounded slice, newest at the bottom). */
const SLICE_N = 100
/** The window "Tag recent" tags — the most-recent N of the active kind. */
const RECENT_TAG_N = 20
/** "Add all" tags every buffered entry of the active kind (buffer caps at 500). */
const ALL_TAG_N = 100000

const KIND_LABEL: Record<DebugKind, string> = { console: 'Console', network: 'Network' }

/** The remembered height, or the default. Storage can throw — a private window,
 *  cleared site data — and a drawer that fails to open because it could not read
 *  a preference would be a poor trade. */
function readStoredHeight(): number {
  try {
    const raw = window.localStorage.getItem(HEIGHT_KEY)
    return raw === null ? DEFAULT_DRAWER_HEIGHT : clampDrawerHeight(Number(raw))
  } catch {
    return DEFAULT_DRAWER_HEIGHT
  }
}

function storeHeight(px: number): void {
  try {
    window.localStorage.setItem(HEIGHT_KEY, String(px))
  } catch {
    // A height that does not survive a restart is a small loss; a throw here
    // would end the drag.
  }
}

export class DebugDrawer {
  readonly element: HTMLElement
  #browser: DebugDrawerBrowserApi
  #body: HTMLElement
  #grip: HTMLElement
  #onTerminalShown: (event: Event) => void
  #collapseBtn: FlButton
  #tabButtons: Record<DebugKind, HTMLButtonElement>
  #badges: Record<DebugKind, HTMLElement>

  #activeKind: DebugKind = 'console'
  #collapsed = true
  #counts: BrowserBufferCounts = { element: 0, console: 0, network: 0 }
  /** A buffer change arrived while the tab was off-screen — refresh on reveal. */
  #dirtyWhileHidden = false
  /** Bumped per row render so a superseded async slice never writes stale DOM. */
  #renderSeq = 0

  #unsubscribe: () => void
  #observer: IntersectionObserver

  constructor(browser: DebugDrawerBrowserApi) {
    this.#browser = browser
    ensureStyles()

    const root = document.createElement('div')
    root.className = 'fl-bdrawer'

    // ── Header: sub-tabs + Tag recent + collapse ─────────────────────────────
    const head = document.createElement('div')
    head.className = 'fl-bdrawer-head'
    head.setAttribute('role', 'tablist')

    const consoleTab = this.#buildTab('console')
    const networkTab = this.#buildTab('network')
    this.#tabButtons = { console: consoleTab.button, network: networkTab.button }
    this.#badges = { console: consoleTab.badge, network: networkTab.badge }

    const spacer = document.createElement('div')
    spacer.className = 'fl-bdrawer-spacer'

    const tagRecentBtn = document.createElement('fl-button')
    tagRecentBtn.setAttribute('variant', 'ghost')
    tagRecentBtn.setAttribute('small', '')
    tagRecentBtn.textContent = 'Add recent'
    tagRecentBtn.title = 'Tag the most recent entries of this tab into the chat'
    tagRecentBtn.addEventListener('click', () => void this.#tagRecent())

    const addAllBtn = document.createElement('fl-button')
    addAllBtn.setAttribute('variant', 'primary')
    addAllBtn.setAttribute('small', '')
    addAllBtn.textContent = 'Add all'
    addAllBtn.title = 'Add every captured entry of this tab to the chat context'
    addAllBtn.addEventListener('click', () => void this.#tagAll())

    this.#collapseBtn = document.createElement('fl-button')
    this.#collapseBtn.setAttribute('variant', 'ghost')
    this.#collapseBtn.setAttribute('small', '')
    this.#collapseBtn.setAttribute('icon', '')
    this.#collapseBtn.addEventListener('click', () => this.#toggleCollapsed())

    head.append(consoleTab.button, networkTab.button, spacer, tagRecentBtn, addAllBtn, this.#collapseBtn)

    // ── A GRIP, BECAUSE 180px IS SOMEBODY'S GUESS ────────────────────────────
    // The body was a fixed height, which is fine for four console lines and
    // useless for a response body or a stack trace (user, 2026-09-21). The
    // height is dragged and remembered per machine — a per-viewer convenience,
    // which is what localStorage is for.
    this.#grip = document.createElement('div')
    this.#grip.className = 'fl-bdrawer-grip'
    this.#grip.setAttribute('role', 'separator')
    this.#grip.setAttribute('aria-orientation', 'horizontal')
    this.#grip.setAttribute('aria-label', 'Resize the debug drawer')
    this.#grip.tabIndex = 0
    this.#grip.hidden = this.#collapsed
    this.#wireGrip()

    // ── Body: the bounded row list (hidden while collapsed) ──────────────────
    this.#body = document.createElement('div')
    this.#body.className = 'fl-bdrawer-body'
    this.#body.setAttribute('role', 'list')
    this.#body.hidden = this.#collapsed
    this.#body.style.height = `${readStoredHeight()}px`

    root.append(head, this.#grip, this.#body)
    this.element = root

    this.#syncTabs()
    this.#syncCollapseGlyph()

    // The other half of the rule above: the terminal coming back closes this.
    //
    // ON THE TRANSITION, announced from `reconcileEditorStack` — the one
    // function every reveal path converges on. See the comment there for the
    // three signals that looked right and were not.
    this.#onTerminalShown = (event: Event): void => {
      const visible = (event as CustomEvent<{ visible?: boolean }>).detail?.visible
      if (visible !== true || this.#collapsed) return
      this.#collapsed = true
      this.#body.hidden = true
      this.#grip.hidden = true
      this.#syncCollapseGlyph()
    }
    document.addEventListener('flow:terminal-visibility', this.#onTerminalShown)

    // Hot broadcast: store counts always; repaint only when on-screen (#17).
    this.#unsubscribe = browser.onBufferUpdated((event) => this.#onBufferUpdated(event))

    // Reveal → settle one refresh if anything changed while we were hidden.
    this.#observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) this.#handleRevealed()
    })
    this.#observer.observe(this.element)
  }

  /** Detach the hot subscription and the reveal observer. */
  dispose(): void {
    this.#unsubscribe()
    this.#observer.disconnect()
    // A document listener outlives its tab unless it is taken off.
    document.removeEventListener('flow:terminal-visibility', this.#onTerminalShown)
  }

  // ── Hot path ───────────────────────────────────────────────────────────────

  #onBufferUpdated(event: { kind: BrowserCaptureKind; counts: BrowserBufferCounts }): void {
    this.#counts = event.counts
    if (!this.#isTabVisible()) {
      this.#dirtyWhileHidden = true
      return // off-screen: touch no DOM (allowed-pattern #17)
    }
    this.#syncBadges()
    // Only the active sub-tab's list is on screen; refresh it when its kind
    // changed. Other kinds (incl. `element`, which has no sub-tab) only move a
    // badge, already done above.
    if (!this.#collapsed && event.kind === this.#activeKind) void this.#renderRows()
  }

  /** The board's own hidden-tab test — offsetParent is null when an ancestor
   *  (the editor tab) is display:none or the element is detached. */
  #isTabVisible(): boolean {
    return this.element.offsetParent !== null
  }

  #handleRevealed(): void {
    if (!this.#dirtyWhileHidden) return
    this.#dirtyWhileHidden = false
    this.#syncBadges()
    if (!this.#collapsed) void this.#renderRows()
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  /** Re-read the active kind's bounded slice and rebuild the row list. Guarded
   *  against races: a slice that resolves after the active kind changed, or
   *  after a newer render started, is discarded. */
  async #renderRows(): Promise<void> {
    const kind = this.#activeKind
    const seq = ++this.#renderSeq
    let slice: BrowserCapture[]
    try {
      slice = await this.#browser.bufferSlice({ kind, selector: { mode: 'last-n', n: SLICE_N } })
    } catch (error) {
      console.warn('flow: browser debug drawer slice failed', error)
      return
    }
    if (seq !== this.#renderSeq || kind !== this.#activeKind) return // superseded

    const stick = this.#isNearBottom()
    const onTag = (id: string): void => this.#tagEntry(kind, id)
    const rows: HTMLElement[] = []
    for (const capture of slice) {
      if (capture.kind === 'console') rows.push(renderConsoleRow(capture, onTag))
      else if (capture.kind === 'network') rows.push(renderNetworkRow(capture, onTag))
    }

    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'fl-bdrawer-empty'
      empty.textContent = `No ${KIND_LABEL[kind].toLowerCase()} entries captured yet.`
      this.#body.replaceChildren(empty)
      return
    }
    this.#body.replaceChildren(...rows)
    if (stick) this.#body.scrollTop = this.#body.scrollHeight
  }

  #isNearBottom(): boolean {
    const { scrollHeight, scrollTop, clientHeight } = this.#body
    return scrollHeight - scrollTop - clientHeight < 40
  }

  #syncBadges(): void {
    this.#badges.console.textContent = String(this.#counts.console)
    this.#badges.network.textContent = String(this.#counts.network)
  }

  #syncTabs(): void {
    for (const kind of ['console', 'network'] as const) {
      const active = kind === this.#activeKind
      this.#tabButtons[kind].classList.toggle('is-active', active)
      this.#tabButtons[kind].setAttribute('aria-selected', String(active))
    }
    this.#syncBadges()
  }

  #syncCollapseGlyph(): void {
    this.#collapseBtn.replaceChildren(iconGlyph(this.#collapsed ? 'chevron-up' : 'chevron-down'))
    const label = this.#collapsed ? 'Show captured console and network' : 'Hide the debug drawer'
    this.#collapseBtn.setAttribute('aria-label', label)
    this.#collapseBtn.title = label
    this.#collapseBtn.setAttribute('aria-expanded', String(!this.#collapsed))
  }

  // ── Interaction ────────────────────────────────────────────────────────────

  #selectKind(kind: DebugKind): void {
    // Clicking a sub-tab OPENS the drawer (it starts collapsed) and shows that
    // kind. Re-clicking the already-active tab while it is open is the only no-op.
    if (kind === this.#activeKind && !this.#collapsed) return
    this.#activeKind = kind
    if (this.#collapsed) {
      this.#collapsed = false
      this.#setOpen(true)
      this.#syncCollapseGlyph()
    }
    this.#syncTabs()
    if (this.#isTabVisible()) void this.#renderRows()
  }

  /**
   * Drag, and arrow keys, to resize.
   *
   * The keyboard half is not decoration: a separator a pointer can move and a
   * keyboard cannot is a control half the people here can use, and this one is
   * already focusable because it is a real separator.
   */
  #wireGrip(): void {
    const applyHeight = (px: number): void => {
      const clamped = clampDrawerHeight(px)
      this.#body.style.height = `${clamped}px`
      storeHeight(clamped)
    }
    this.#grip.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      const startY = event.clientY
      const startHeight = this.#body.getBoundingClientRect().height
      this.#grip.setPointerCapture(event.pointerId)
      // DRAGGING UP GROWS IT: the drawer is pinned to the bottom, so the grip
      // moving up means more room, which is the opposite of the raw delta.
      const onMove = (move: PointerEvent): void => applyHeight(startHeight + (startY - move.clientY))
      const onUp = (): void => {
        this.#grip.removeEventListener('pointermove', onMove)
        this.#grip.removeEventListener('pointerup', onUp)
      }
      this.#grip.addEventListener('pointermove', onMove)
      this.#grip.addEventListener('pointerup', onUp)
    })
    this.#grip.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 64 : 16
      if (event.key === 'ArrowUp') applyHeight(this.#body.getBoundingClientRect().height + step)
      else if (event.key === 'ArrowDown') applyHeight(this.#body.getBoundingClientRect().height - step)
      else return
      event.preventDefault()
    })
  }

  /**
   * Open or close the body AND its grip together.
   *
   * They were set separately, and the sub-tab path — which is how the drawer is
   * usually opened — set only the body. The grip stayed hidden, so the drawer
   * was open and could not be resized, which looks exactly like a resize that
   * does not work.
   */
  #setOpen(open: boolean): void {
    this.#collapsed = !open
    this.#body.hidden = !open
    this.#grip.hidden = !open
    // ONE LOG SURFACE AT THE BOTTOM, NOT TWO.
    //
    // This drawer and the terminal panel both live along the bottom edge and
    // both show scrolling text, so with both open the screen reads as one
    // undifferentiated wall — "seems everything the same thing" (user,
    // 2026-09-21). They are also rarely wanted together: you are reading what
    // the PAGE did or what the SHELL did.
    //
    // Opening this closes that, and opening that closes this (the listener in
    // the constructor). No loop: hiding the terminal dispatches nothing.
    if (open) document.dispatchEvent(new CustomEvent('flow:hide-terminal'))
  }

  #toggleCollapsed(): void {
    this.#collapsed = !this.#collapsed
    this.#setOpen(!this.#collapsed)
    this.#syncCollapseGlyph()
    if (!this.#collapsed && this.#isTabVisible()) void this.#renderRows()
  }

  async #tagRecent(): Promise<void> {
    const kind = this.#activeKind
    try {
      const slice = await this.#browser.bufferSlice({ kind, selector: { mode: 'last-n', n: RECENT_TAG_N } })
      addCapturesToContext(slice, KIND_LABEL[kind])
    } catch (error) {
      console.warn('flow: browser add recent failed', error)
    }
  }

  /** Add every buffered entry of the active kind to the chat context. */
  async #tagAll(): Promise<void> {
    const kind = this.#activeKind
    try {
      const slice = await this.#browser.bufferSlice({ kind, selector: { mode: 'last-n', n: ALL_TAG_N } })
      addCapturesToContext(slice, KIND_LABEL[kind])
    } catch (error) {
      console.warn('flow: browser add all failed', error)
    }
  }

  #tagEntry(kind: DebugKind, id: string): void {
    void this.#browser
      .tagEntry({ kind, id })
      .catch((error: unknown) => console.warn('flow: browser tag entry failed', error))
  }

  #buildTab(kind: DebugKind): { button: HTMLButtonElement; badge: HTMLElement } {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-bdrawer-tab'
    button.setAttribute('role', 'tab')

    const label = document.createElement('span')
    label.textContent = KIND_LABEL[kind]

    const badge = document.createElement('span')
    badge.className = 'fl-bdrawer-badge'
    badge.textContent = '0'

    button.append(label, badge)
    button.addEventListener('click', () => this.#selectKind(kind))
    return { button, badge }
  }
}

/** A bare `<fl-icon>` glyph at the drawer's toolbar size. */
function iconGlyph(name: string): HTMLElement {
  const glyph = document.createElement('fl-icon')
  glyph.setAttribute('name', name)
  glyph.setAttribute('size', '14')
  return glyph
}

const STYLE_ID = 'fl-bdrawer-styles'

/** Inject the drawer stylesheet once (light-DOM rows, so a shared class sheet —
 *  the git-panel idiom — rather than per-row inline styles). All colours resolve
 *  from the existing tokens so both themes follow. */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .fl-bdrawer {
      display: flex;
      flex-direction: column;
      flex: none;
      /* Measured by the container queries above: the drawer's own width is what
         decides which columns fit, not the window's — it sits beside a sidebar
         whose width a reader changes. */
      container-type: inline-size;
      border-top: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    .fl-bdrawer-head {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      padding: var(--fl-space-xs) var(--fl-space-sm);
      flex: none;
    }
    .fl-bdrawer-tab {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
      height: 22px;
      padding: 0 var(--fl-space-sm);
      background: transparent;
      border: 0;
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text-secondary);
      font-family: inherit;
      font-size: var(--fl-text-ui-size);
      cursor: pointer;
    }
    .fl-bdrawer-tab:hover { background: var(--fl-color-surface-raised); }
    .fl-bdrawer-tab.is-active {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .fl-bdrawer-badge {
      min-width: 16px;
      padding: 0 4px;
      border-radius: 8px;
      background: var(--fl-color-surface-selected);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      line-height: 16px;
      text-align: center;
    }
    .fl-bdrawer-spacer { flex: 1; }
    /* A GRIP ON THE TOP EDGE. Three pixels of hit area is a control nobody can
       hit, so the bar is thin and its target is padded out around it. */
    .fl-bdrawer-grip {
      flex: none;
      height: 7px;
      margin-bottom: -4px;
      cursor: ns-resize;
      position: relative;
      z-index: 1;
    }
    .fl-bdrawer-grip::after {
      content: '';
      position: absolute;
      left: 50%;
      top: 2px;
      width: 36px;
      height: 3px;
      transform: translateX(-50%);
      border-radius: 2px;
      background: var(--fl-color-border);
      transition: background 120ms ease;
    }
    .fl-bdrawer-grip:hover::after,
    .fl-bdrawer-grip:focus-visible::after { background: var(--fl-color-accent); }
    .fl-bdrawer-grip:focus-visible { outline: none; }

    /* The scanning columns. Each holds its own width so a list of a hundred
       rows lines up — a column that sizes to its content makes every row a
       different shape and defeats the scan it exists for. */
    /* The request's own name: as wide as it needs, ellipsized when it cannot
       have that, and never stretched — the host follows it immediately. */
    .fl-bdrawer-name {
      flex: 0 1 auto;
      min-width: 4ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fl-bdrawer-grow { flex: 1; min-width: var(--fl-space-sm); }
    .fl-bdrawer-dim {
      flex: none;
      color: var(--fl-color-text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 22ch;
    }
    .fl-bdrawer-type {
      flex: none;
      width: 6ch;
      color: var(--fl-color-text-secondary);
      text-align: right;
    }
    .fl-bdrawer-size {
      flex: none;
      width: 8ch;
      color: var(--fl-color-text-secondary);
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    /* Narrow drawers drop the columns a reader can live without, newest first:
       the host, then the type. The name, status and time never go. */
    @container (max-width: 620px) {
      .fl-bdrawer-type { display: none; }
    }
    @container (max-width: 480px) {
      .fl-bdrawer-dim { display: none; }
    }

    .fl-bdrawer-entry { display: block; }
    /* A row that opens says so before it is clicked. */
    .fl-bdrawer-row.has-more,
    .fl-bdrawer-entry > .fl-bdrawer-row { cursor: pointer; }
    .fl-bdrawer-row.is-open { background: var(--fl-color-surface-raised); }

    .fl-bdrawer-detail {
      padding: var(--fl-space-sm) var(--fl-space-md);
      border-left: 2px solid var(--fl-color-accent);
      margin: 0 var(--fl-space-sm) var(--fl-space-xs);
      background: var(--fl-color-surface-raised);
      border-radius: var(--fl-radius-sm);
    }
    /* The detail's own tab strip — Headers / Request / Response. Sized below
       the drawer's main tabs so the two levels never read as one row. */
    .fl-bdrawer-tabs {
      display: flex;
      gap: 2px;
      margin-bottom: var(--fl-space-sm);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-bdrawer-subtab {
      height: 22px;
      padding: 0 var(--fl-space-sm);
      background: transparent;
      border: 0;
      border-bottom: 2px solid transparent;
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .fl-bdrawer-subtab:hover { color: var(--fl-color-text); }
    .fl-bdrawer-subtab.is-active {
      color: var(--fl-color-text);
      border-bottom-color: var(--fl-color-accent);
    }
    /* Empty, not absent: the strip keeps its shape so nothing moves between
       one row and the next. */
    .fl-bdrawer-subtab.is-empty { opacity: 0.45; }
    .fl-bdrawer-panel { min-height: 40px; }

    .fl-bdrawer-section { margin-bottom: var(--fl-space-sm); }
    .fl-bdrawer-section-title {
      margin: 0 0 4px;
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--fl-color-text-secondary);
    }
    /* Name/value pairs in two columns, with the value free to wrap — a long
       URL or a cookie must not push the panel sideways. */
    .fl-bdrawer-kv {
      display: grid;
      grid-template-columns: minmax(90px, max-content) 1fr;
      gap: 2px var(--fl-space-sm);
      margin: 0;
    }
    .fl-bdrawer-kv dt { color: var(--fl-color-text-secondary); }
    .fl-bdrawer-kv dd {
      margin: 0;
      overflow-wrap: anywhere;
      color: var(--fl-color-text);
    }
    .fl-bdrawer-body-text {
      margin: 0;
      padding: var(--fl-space-xs);
      max-height: 320px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--fl-color-surface);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
    }
    .fl-bdrawer-body-text.is-stack { color: var(--fl-color-text-secondary); }
    .fl-bdrawer-note {
      margin: 0;
      color: var(--fl-color-text-secondary);
      font-style: italic;
    }
    .fl-bdrawer-copy {
      margin-top: var(--fl-space-xs);
      height: 22px;
      padding: 0 var(--fl-space-sm);
      background: transparent;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .fl-bdrawer-copy:hover {
      background: var(--fl-color-surface);
      color: var(--fl-color-text);
    }

    .fl-bdrawer-body {
      /* Height is set inline from the remembered value and changed by the grip;
         180px is only the fallback for a renderer that has neither. */
      height: 180px;
      overflow-y: auto;
      padding: var(--fl-space-xs) 0;
      border-top: var(--fl-border-width) solid var(--fl-color-border);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
    }
    .fl-bdrawer-empty {
      padding: var(--fl-space-md);
      color: var(--fl-color-text-secondary);
      text-align: center;
    }
    .fl-bdrawer-row {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      min-height: 22px;
      margin: 0 var(--fl-space-xs);
      padding: 2px var(--fl-space-sm);
      border-radius: var(--fl-radius-sm);
      white-space: nowrap;
      color: var(--fl-color-text);
    }
    .fl-bdrawer-row:hover { background: var(--fl-color-surface-raised); }
    .fl-bdrawer-row.is-error { color: var(--fl-color-error); }
    .fl-bdrawer-row.is-warn { color: var(--fl-color-warning); }
    .fl-bdrawer-row.is-muted { color: var(--fl-color-text-secondary); }
    .fl-bdrawer-glyph { flex: none; }
    /* The timestamp stays muted whatever the row's tone. */
    .fl-bdrawer-time {
      flex: none;
      color: var(--fl-color-text-secondary);
      font-variant-numeric: tabular-nums;
    }
    .fl-bdrawer-method {
      flex: none;
      width: 44px;
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-bdrawer-status {
      flex: none;
      width: 32px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .fl-bdrawer-text {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fl-bdrawer-row-tag {
      flex: none;
      opacity: 0.8;
      transition: opacity var(--fl-transition-fast);
    }
    .fl-bdrawer-row:hover .fl-bdrawer-row-tag,
    .fl-bdrawer-row:focus-within .fl-bdrawer-row-tag { opacity: 1; }
  `
  document.head.appendChild(style)
}
