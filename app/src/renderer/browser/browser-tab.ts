/**
 * Embedded browser tab — a sandboxed <webview> pointed at the user's dev app,
 * mounted as an EDITOR-AREA tab (id 'flow://browser', icon 'globe').
 *
 * Same shape as the Blueprint / Tasks / Change-review tabs (renderer/blueprint):
 * ONE element for the life of the window, opened on demand through
 * `EditorApi.openView`, which is idempotent per id (reopening focuses the
 * existing tab and the element survives tab closes, so page state is preserved).
 * The open trigger is the activity bar's Browser action, which dispatches
 * `flow:open-browser` on document — the same decoupled convention Blueprint uses.
 *
 * The guest is context-isolated (`webpreferences="contextIsolation=yes"`) with
 * and no `nodeintegration` (off by default). Navigation is driven through the
 * `browser:*` IPC (main's BrowserController owns the guest it tracks via
 * `did-attach-webview`), except the very FIRST load, which is set as the
 * webview's `src` — deferred until the tab is first OPENED (mounted into the
 * DOM), because a <webview> that loads while detached can come up blank.
 *
 * Context gestures (Cursor-style):
 *   - inspect toggle → STICKY element picker: every click adds a chip until the
 *     toggle is turned off or Escape ends the session;
 *   - ⌘/Ctrl+L (while this tab is focused) → add the whole console to context;
 *   - the debug drawer's per-row Tag / "Tag recent" / "Add all" cover console
 *     and network.
 *
 * An empty-state overlay covers the guest's blank frame whenever there is no
 * page to show — before the first navigation, while loading, or when a load
 * fails (e.g. no dev server running) — so the tab always shows SOMETHING with a
 * next step, never a black void.
 *
 * webviewTag must be enabled on the host window (main/index.ts) or `<webview>`
 * does not instantiate.
 */
import type { EditorApi } from '../editor'
import { BrowserChrome } from './browser-chrome'
import { DebugDrawer } from './debug-drawer'
import { detectDevServerUrl } from './dev-server-detect'
import { initInspectMode } from './inspect-mode'
import { addCapturesToContext } from './browser-capture-chip'
import { adoptBrowserScope } from './browser-scope'
import { runInWantedScope, tabScopeGate } from '../tab-scope-gate'
import type { TabScopeKey } from '../tab-scope-model'

const BROWSER_TAB_ID = 'flow://browser'
/** The persisted identity of the browser in a conversation's tab set. */
const BROWSER_VIEW_KIND = 'browser'

/** What a conversation that never had the browser sees: nothing at all. */
const BLANK_URL = 'about:blank'

/** "Add all" / ⌘L tags every buffered entry of a kind (the buffer caps at 500). */
const ADD_ALL_N = 100000

/**
 * The slice of Electron's <webview> element this tab drives. Electron's DOM
 * types are not in the renderer's lib (the renderer never imports electron), so
 * we name only what we use — the task's expected cast for the webview element.
 */
interface WebviewElement extends HTMLElement {
  src: string
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  /** Load a page directly on the guest (resolves when it has loaded). */
  loadURL(url: string): Promise<void>
  /** Forget the back/forward list — another conversation's pages are not ours. */
  clearHistory(): void
  /** Send an IPC message to the guest (received in its preload by ipcRenderer). */
  send(channel: string, ...args: unknown[]): void
}

/** A webview navigation event carries the destination url. */
interface WebviewNavigationEvent extends Event {
  url?: string
}

/** did-fail-load carries the error code, a description, and the URL that failed. */
interface WebviewFailLoadEvent extends Event {
  errorCode?: number
  errorDescription?: string
  validatedURL?: string
  isMainFrame?: boolean
}

/** Chromium's ERR_ABORTED — a benign "load replaced by a newer navigation",
 *  fired constantly during normal navigation; never treat it as a failure. */
const ERR_ABORTED = -3

export function initBrowserTab(editorApi: EditorApi): () => void {
  const api = window.flow
  if (!api?.browser) {
    console.warn('flow: preload bridge missing — embedded browser disabled')
    return () => undefined
  }
  const browser = api.browser

  // ── Element: chrome over a sandboxed <webview> in an overlaid viewport ──────
  const container = document.createElement('div')
  container.className = 'fl-browser-tab'
  container.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;'

  // The <webview> and the empty-state overlay share a relative viewport so the
  // overlay can cover the guest's blank frame.
  const viewport = document.createElement('div')
  viewport.className = 'fl-browser-viewport'
  viewport.style.cssText = 'position:relative;flex:1;min-height:0;width:100%;'

  const webview = document.createElement('webview') as unknown as WebviewElement
  webview.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;'
  // Guest isolation: context-isolated, no node integration (off by
  // default). allowpopups stays off so window.open can't spawn extra guests.
  // NOTE: no sandbox — a sandboxed <webview> preload crashes on load in this
  // Electron ("preloadScripts of startupData is null"), which took inspect mode
  // down with it. contextIsolation + node integration off keeps the guest isolated.
  webview.setAttribute('webpreferences', 'contextIsolation=yes')
  // A persisted partition keeps the dev app's cookies/storage across reloads,
  // isolated from the host and from other partitions.
  webview.setAttribute('partition', 'persist:flow-browser')
  // The guest preload carries the inspect bridge (element → React source). Its
  // file:// URL is resolved by the main preload (out/preload/browser-guest.js);
  // without it the toolbar still navigates, only inspect mode is unavailable.
  const guestPreloadUrl = window.flowBrowserGuestPreloadUrl
  if (typeof guestPreloadUrl === 'string' && guestPreloadUrl.length > 0) {
    webview.setAttribute('preload', guestPreloadUrl)
  } else {
    console.warn('flow: browser guest preload URL missing — inspect mode disabled')
  }

  const overlay = buildOverlay((url) => {
    void browser.navigate({ url }).catch((error: unknown) => console.warn('flow: browser navigate failed', error))
    chrome.setUrl(url)
  })
  // Host-side inspect affordance — a strip shown the moment inspect is armed, so
  // the user gets feedback even before the guest's own crosshair paints. The
  // guest bridge still draws the per-element highlight + does the selecting.
  const inspectHint = document.createElement('div')
  inspectHint.textContent = 'Inspect mode — click an element in the page · Esc to stop'
  inspectHint.hidden = true
  inspectHint.style.cssText = [
    'position:absolute', 'top:0', 'left:0', 'right:0', 'z-index:2', 'pointer-events:none',
    'padding:6px 10px', 'text-align:center',
    'background:var(--fl-color-accent, #2b6cff)', 'color:#fff',
    'font:600 12px/1.3 var(--fl-font-ui, sans-serif)',
  ].join(';')
  viewport.append(webview as unknown as HTMLElement, overlay.element, inspectHint)

  // Inspect mode: the toggle routes through main to the guest picker; captured
  // elements arrive as the webview's `ipc-message` events.
  const inspectMode = initInspectMode(webview, browser)

  const chrome = new BrowserChrome({
    onBack: () => {
      void browser.back({}).catch((error: unknown) => console.warn('flow: browser back failed', error))
    },
    onForward: () => {
      void browser.forward({}).catch((error: unknown) => console.warn('flow: browser forward failed', error))
    },
    onReload: () => {
      void browser.reload({}).catch((error: unknown) => console.warn('flow: browser reload failed', error))
    },
    onNavigate: (url) => {
      chrome.setUrl(url)
      void browser.navigate({ url }).catch((error: unknown) => console.warn('flow: browser navigate failed', error))
    },
    onToggleInspect: (on) => {
      inspectMode.setActive(on)
      inspectHint.hidden = !on
      webview.style.cursor = on ? 'crosshair' : ''
    },
  })

  // Sticky inspect: each click posts a capture and the picker STAYS on, so a
  // whole set of elements can be added in one session. Each capture rides a
  // decoupled document event that the capture-boundary phase turns into a chip.
  const stopCapture = inspectMode.onElementCapture((payload) => {
    document.dispatchEvent(new CustomEvent('flow:browser-element-captured', { detail: payload }))
  })
  // The toolbar toggle resets only when the session actually ends — the guest
  // told us it deactivated itself (Escape). A user toggle-off already sets it.
  const stopDeactivate = inspectMode.onDeactivated(() => {
    chrome.setInspect(false)
    inspectHint.hidden = true
    webview.style.cursor = ''
  })

  // Debug drawer: console/network capture list beneath the webview, the UI
  // trigger for console/network tagging (rows + "Tag recent" + "Add all").
  const debugDrawer = new DebugDrawer(browser)

  container.append(chrome.element, viewport, debugDrawer.element)

  // ── ⌘/Ctrl+L → add the whole console to context ─────────────────────────────
  // Gated so it only fires while the Browser tab is on screen AND focus is
  // within it (chrome, drawer, or the webview element) — never hijacked elsewhere.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'l') return
    if (container.offsetParent === null) return
    if (!container.contains(document.activeElement)) return
    event.preventDefault()
    void (async () => {
      const slice = await browser.bufferSlice({ kind: 'console', selector: { mode: 'last-n', n: ADD_ALL_N } })
      addCapturesToContext(slice, 'Console')
    })().catch((error: unknown) => console.warn('flow: add console to context failed', error))
  }
  document.addEventListener('keydown', onKeyDown, true)

  // ── Empty-state overlay driven by the webview's own load lifecycle ──────────
  let loadFailed = false
  const onStartLoading = (): void => {
    loadFailed = false
    let url = ''
    try {
      url = webview.getURL()
    } catch {
      // getURL throws before the guest attaches — the overlay just omits the URL.
    }
    overlay.set('loading', { url })
  }
  const onStopLoading = (): void => {
    if (loadFailed) return
    // The blank page a conversation starts on is not a page to look at: the
    // empty state (with its URL form) stays up over it.
    let url = ''
    try {
      url = webview.getURL()
    } catch {
      // Not attached yet — treat as a real load.
    }
    overlay.set(url === BLANK_URL ? 'idle' : 'hidden')
  }
  const onFailLoad = (event: Event): void => {
    const failure = event as WebviewFailLoadEvent
    // Sub-resource failures and benign aborts must not blank the whole tab.
    if (failure.isMainFrame === false) return
    if (failure.errorCode === ERR_ABORTED) return
    loadFailed = true
    overlay.set('failed', {
      url: failure.validatedURL ?? '',
      description: failure.errorDescription ?? '',
    })
  }
  webview.addEventListener('did-start-loading', onStartLoading)
  webview.addEventListener('did-stop-loading', onStopLoading)
  webview.addEventListener('did-finish-load', onStopLoading)
  webview.addEventListener('did-fail-load', onFailLoad)

  // ── Live toolbar state from the webview's own navigation events ─────────────
  const syncNavState = (): void => {
    // getURL/canGo* exist only after the guest has attached; guard so an early
    // event (dom-ready before first nav) never throws.
    try {
      chrome.setUrl(webview.getURL())
      chrome.setCanGoBack(webview.canGoBack())
      chrome.setCanGoForward(webview.canGoForward())
    } catch {
      // Guest not ready yet — the next navigation event will sync it.
    }
  }
  const onNavigated = (event: Event): void => {
    const url = (event as WebviewNavigationEvent).url
    if (typeof url === 'string') chrome.setUrl(url)
    syncNavState()
  }
  webview.addEventListener('did-navigate', onNavigated)
  webview.addEventListener('did-navigate-in-page', onNavigated)
  webview.addEventListener('did-frame-finish-load', syncNavState)
  webview.addEventListener('dom-ready', syncNavState)

  // ── Initial target: the best-guess dev-server URL, loaded on first OPEN ─────
  // Deferred (not set at construction) because a <webview> that loads its guest
  // while detached from the document can come up blank. The URL bar goes anywhere.
  const initialUrl = detectDevServerUrl()
  chrome.setUrl(initialUrl ?? '')
  overlay.set(initialUrl !== null ? 'loading' : 'idle', { url: initialUrl ?? '' })
  let hasNavigated = false

  /** Where the browser is now — what a conversation's tab set remembers. */
  const currentUrl = (): string | null => {
    try {
      const url = webview.getURL()
      if (typeof url === 'string' && url !== '' && url !== BLANK_URL) return url
      if (url === BLANK_URL) return null
    } catch {
      // getURL throws before the guest attaches — fall back to the first target.
    }
    return hasNavigated ? (initialUrl ?? null) : null
  }

  /**
   * The conversation whose page the guest holds. One webview per window: when
   * another conversation takes the browser it must not see this one's page,
   * and its "Add all" must not attach this one's console (`browser-scope.ts`).
   */
  let owner: TabScopeKey | null = null

  /** Forget the back/forward list once the current load lands. */
  const clearHistorySoon = (load: Promise<void>): void => {
    void load
      .catch((error: unknown) => console.warn('flow: browser load failed', error))
      .finally(() => {
        try {
          webview.clearHistory()
        } catch {
          // Not attached — there is no history to clear.
        }
        syncNavState()
      })
  }

  /** Go to `url`. `fresh`: the page is a new owner's, so the way back to the
   *  previous owner's pages is cut. */
  const go = (url: string, fresh: boolean): void => {
    chrome.setUrl(url)
    overlay.set('loading', { url })
    // BEFORE THE FIRST MOUNT THERE IS NOTHING TO NAVIGATE. `src` is how the
    // guest gets its first page (the webview comes up blank if it loads while
    // detached); after that the controller drives it, because `src` does not
    // re-navigate to a URL it already holds.
    if (!hasNavigated) {
      hasNavigated = true
      webview.src = url
      return
    }
    if (fresh) {
      clearHistorySoon(webview.loadURL(url))
      return
    }
    void browser.navigate({ url }).catch((error: unknown) => console.warn('flow: browser navigate failed', error))
  }

  /** Start empty: the previous owner's page goes, the empty state shows. */
  const goBlank = (): void => {
    chrome.setUrl(initialUrl ?? '')
    overlay.set('idle')
    if (!hasNavigated) return
    clearHistorySoon(webview.loadURL(BLANK_URL))
  }

  // ── Open trigger (same pattern as flow:open-blueprint) ──────────────────────
  const openBrowserTab = (event?: Event): void => {
    // A DESTINATION, WHEN THE CALLER HAS ONE. The rail's Browser action opens
    // wherever the browser already was; a chat link to a generated page opens
    // at that page. Same tab either way — a second browser tab per file would
    // be a tab strip of pages nobody closed.
    const asked = (event as CustomEvent<{ url?: string }> | undefined)?.detail?.url
    const target = typeof asked === 'string' && asked.trim() !== '' ? asked.trim() : null
    // Opened into the conversation it was pressed in, once its set is on screen.
    void runInWantedScope(() => openAt(target, { reveal: true, restoring: false, scope: tabScopeGate.shown }))
  }

  /** Open the tab (revealing the editor for a person's press, never for a
   *  tab-set restore) and go to `target` when there is one. */
  const openAt = (
    target: string | null,
    options: { reveal: boolean; restoring: boolean; scope: TabScopeKey | null },
  ): void => {
    // The browser is taken by this set when the set brings it back, or when it
    // is opened while not open in it (a switch closed the previous set's tab).
    const adopting = options.restoring || !editorApi.hasTab(BROWSER_TAB_ID)
    // Reveal the editor host first — the tab opens into it even when the editor
    // is hidden (⌘⌥D), matching every other view tab.
    if (options.reveal) document.dispatchEvent(new CustomEvent('flow:show-editor'))
    editorApi.openView({
      id: BROWSER_TAB_ID,
      label: 'Browser',
      icon: 'globe',
      element: container,
      // The browser belongs to a conversation's tab set, with the page it was on.
      persist: { kind: BROWSER_VIEW_KIND, state: () => ({ url: currentUrl() }) },
    })
    if (adopting) {
      const decision = adoptBrowserScope({
        owner,
        next: options.scope,
        // A press with a destination is a destination like a saved page.
        saved: target,
        current: currentUrl(),
        restoring: options.restoring || target !== null,
        hasNavigated,
      })
      owner = options.scope
      if (decision.clearCaptures) {
        void browser.clearCaptures({}).catch((error: unknown) => console.warn('flow: browser capture clear failed', error))
      }
      if (decision.load.kind === 'url') {
        go(decision.load.url, true)
        return
      }
      if (decision.load.kind === 'blank') {
        goBlank()
        return
      }
      if (target !== null) return // already on it
    } else if (target !== null) {
      go(target, false)
      return
    }
    // First open with no destination: kick the dev-server guess.
    if (!hasNavigated && initialUrl !== null) go(initialUrl, false)
  }
  document.addEventListener('flow:open-browser', openBrowserTab)

  // A conversation's tab set coming back with the browser in it: reopen it on
  // the page that conversation was looking at (one browser per window), or
  // blank when it never had one.
  editorApi.registerViewRestorer(BROWSER_VIEW_KIND, (state, scope) => {
    const saved = typeof state.url === 'string' && state.url !== '' ? state.url : null
    openAt(saved, { reveal: false, restoring: true, scope })
    return BROWSER_TAB_ID
  })

  return () => {
    document.removeEventListener('flow:open-browser', openBrowserTab)
    document.removeEventListener('keydown', onKeyDown, true)
    webview.removeEventListener('did-start-loading', onStartLoading)
    webview.removeEventListener('did-stop-loading', onStopLoading)
    webview.removeEventListener('did-finish-load', onStopLoading)
    webview.removeEventListener('did-fail-load', onFailLoad)
    webview.removeEventListener('did-navigate', onNavigated)
    webview.removeEventListener('did-navigate-in-page', onNavigated)
    webview.removeEventListener('did-frame-finish-load', syncNavState)
    webview.removeEventListener('dom-ready', syncNavState)
    stopCapture()
    stopDeactivate()
    inspectMode.dispose()
    debugDrawer.dispose()
  }
}

// ── Empty-state overlay ───────────────────────────────────────────────────────

/** The overlay's display states. `hidden` reveals the guest page beneath it. */
type OverlayState = 'idle' | 'loading' | 'failed' | 'hidden'

interface OverlayDetail {
  url?: string
  description?: string
}

/**
 * Build the empty-state overlay: a centered message layered over the webview,
 * shown whenever there is no page to display. `onNavigate` is fired by the
 * inline "enter a URL" affordance so the overlay is a way OUT of the empty state,
 * not just a sign (forbidden-pattern #12 — offer an action, not a dead end).
 */
function buildOverlay(onNavigate: (url: string) => void): {
  element: HTMLElement
  set: (state: OverlayState, detail?: OverlayDetail) => void
} {
  ensureOverlayStyles()

  const el = document.createElement('div')
  el.className = 'fl-browser-overlay'

  const icon = document.createElement('fl-icon')
  icon.setAttribute('name', 'globe')
  icon.setAttribute('size', '32')
  icon.className = 'fl-browser-overlay-icon'

  const title = document.createElement('div')
  title.className = 'fl-browser-overlay-title'

  const sub = document.createElement('div')
  sub.className = 'fl-browser-overlay-sub'

  const form = document.createElement('form')
  form.className = 'fl-browser-overlay-form'
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'fl-browser-overlay-input'
  input.placeholder = 'http://localhost:3000'
  input.spellcheck = false
  const go = document.createElement('fl-button')
  go.setAttribute('variant', 'primary')
  go.setAttribute('small', '')
  go.textContent = 'Open'
  form.append(input, go)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const value = input.value.trim()
    if (value.length > 0) onNavigate(normalizeUrl(value))
  })

  el.append(icon, title, sub, form)

  const set = (state: OverlayState, detail: OverlayDetail = {}): void => {
    if (state === 'hidden') {
      el.hidden = true
      return
    }
    el.hidden = false
    if (state === 'loading') {
      title.textContent = 'Loading…'
      sub.textContent = detail.url ?? ''
      form.hidden = true
    } else if (state === 'failed') {
      title.textContent = "This page didn't load"
      const where = detail.url ?? 'the page'
      const why = detail.description && detail.description.length > 0 ? ` (${detail.description})` : ''
      sub.textContent = `Couldn't reach ${where}${why}. Start your dev server, then reload — or open another URL:`
      form.hidden = false
      if (detail.url) input.value = detail.url
    } else {
      title.textContent = 'No page open'
      sub.textContent = 'Enter a URL to load, or start your dev server (e.g. http://localhost:3000):'
      form.hidden = false
    }
  }
  set('idle')

  return { element: el, set }
}

/** Prefix a bare host/path with http:// so the URL bar accepts `localhost:3000`. */
function normalizeUrl(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  return `http://${value}`
}

const OVERLAY_STYLE_ID = 'fl-browser-overlay-styles'

/** Inject the overlay stylesheet once. All colours resolve from existing tokens
 *  so both themes follow. */
function ensureOverlayStyles(): void {
  if (document.getElementById(OVERLAY_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = OVERLAY_STYLE_ID
  style.textContent = `
    .fl-browser-overlay {
      position: absolute;
      inset: 0;
      z-index: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-lg);
      text-align: center;
      background: var(--fl-color-surface);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
    }
    .fl-browser-overlay[hidden] { display: none; }
    .fl-browser-overlay-icon { color: var(--fl-color-text-secondary); opacity: 0.7; }
    .fl-browser-overlay-title {
      font-size: var(--fl-text-heading-size, 15px);
      font-weight: var(--fl-text-ui-weight-medium, 600);
    }
    .fl-browser-overlay-sub {
      max-width: 420px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-ui-size);
      line-height: 1.4;
    }
    .fl-browser-overlay-form {
      display: flex;
      gap: var(--fl-space-xs);
      margin-top: var(--fl-space-xs);
      width: 100%;
      max-width: 360px;
    }
    .fl-browser-overlay-form[hidden] { display: none; }
    .fl-browser-overlay-input {
      flex: 1;
      min-width: 0;
      height: 28px;
      padding: 0 var(--fl-space-sm);
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
    }
    .fl-browser-overlay-input:focus {
      outline: none;
      border-color: var(--fl-color-accent);
    }
  `
  document.head.appendChild(style)
}
