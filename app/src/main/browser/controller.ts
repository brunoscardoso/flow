// Main-process controller for the embedded <webview> browser tab.
//
// The Phase-1 `browser:*` contract carries NO webContentsId on its requests, so
// the controller tracks the guest itself: it listens for `did-attach-webview`
// on every window-type webContents and holds the most-recently-attached guest.
// One guest is sufficient for the single v1 browser tab. Later phases (5/6)
// fill in the capture/tag/buffer surface — the STUBS here exist so every
// `browser:*` handler can register and the contract typechecks now.

import { join } from 'node:path'

import { app, shell, webFrameMain, type WebContents } from 'electron'

import type {
  BrowserCapabilities,
  BrowserCapture,
  BrowserCaptureKind,
  BrowserPageTimings,
  TagWindow,
} from '../../shared/browser-capture-types'
import { replayRequest } from '../../shared/network-detail'
import { redactAndBound } from '../../shared/browser-capture-boundary'
import type { IpcEventPayload } from '../../shared/ipc-contract'
import { opensInFlow, tabShortcut } from '../../shared/browser-tabs'
import { attachDraftFramePicker } from '../drafts/draft-frame-inject'
import { attachCdpCapture, type CdpCaptureHandle } from './cdp-capture'
import { setGuestInspect, setGuestRecording } from './inspect-host'
import { RollingBuffer } from './rolling-buffer'

/**
 * How the controller reaches the renderer — the two browser event channels,
 * wired to `broadcast` in ipc/index.ts. Phases 5/6 call the `emit*` helpers
 * below when captures land; phase 2 wires this and leaves them unused.
 */
export interface BrowserBroadcast {
  bufferUpdated(payload: IpcEventPayload<'browser:bufferUpdated'>): void
  tagPosted(payload: IpcEventPayload<'browser:tagPosted'>): void
  openTab?(payload: IpcEventPayload<'browser:openTab'>): void
  shortcut?(payload: IpcEventPayload<'browser:shortcut'>): void
}

/** One tab's page: its guest and the captures it made. Captures are kept per tab. */
interface GuestEntry {
  guest: WebContents
  buffer: RollingBuffer
  cdp: CdpCaptureHandle
  /** Console errors logged so far — a background tab's red dot. */
  errors: number
}

/**
 * Absolute path to the guest preload bundle, attached to the <webview> MAIN-side
 * via the host's `will-attach-webview` event — the reliable way to attach a
 * webview preload in current Electron. The renderer's `preload` ATTRIBUTE is not
 * honored, which is why inspect mode (which needs the guest preload) was dead
 * while CDP capture (main-side) worked. `__dirname` is out/main at runtime; the
 * preload bundles to out/preload/browser-guest.js.
 */
const GUEST_PRELOAD_PATH = join(__dirname, '..', 'preload', 'browser-guest.js')

class BrowserController {
  /** Every tab's live page, by webContents id. */
  #guests = new Map<number, GuestEntry>()
  /** The tab on screen — what every browser:* call acts on. */
  #activeId: number | null = null
  #initialized = false
  #broadcast: BrowserBroadcast | null = null

  #active(): GuestEntry | null {
    if (this.#activeId === null) return null
    const entry = this.#guests.get(this.#activeId) ?? null
    if (entry !== null && entry.guest.isDestroyed()) return null
    return entry
  }

  /** The active page's capture buffer (Phase 5). */
  get #buffer(): RollingBuffer | null {
    return this.#active()?.buffer ?? null
  }

  /** The active page's CDP attach (Phase 5). */
  get #cdp(): CdpCaptureHandle | null {
    return this.#active()?.cdp ?? null
  }

  /** The tab on screen changed. An id this controller has not seen is ignored. */
  setActive(guestId: number): void {
    if (this.#guests.has(guestId)) this.#activeId = guestId
  }

  /**
   * Begin tracking guest `<webview>` attachments. Idempotent.
   *
   * Registered on the app's `web-contents-created` stream rather than a specific
   * window because the controller is wired at IPC-registration time, BEFORE the
   * main window is created (`registerIpcHandlers` runs ahead of `createWindow`).
   * The listener is therefore in place when the window later attaches its guest.
   */
  init(): void {
    if (this.#initialized) return
    this.#initialized = true
    app.on('web-contents-created', (_event, contents) => {
      // CAPTURE FROM THE FIRST REQUEST. A guest is created before it loads
      // anything; attaching on 'did-attach-webview' was after its navigation
      // had begun, so the first load of every tab had no document and no
      // stylesheets in the Network panel.
      if (contents.getType() === 'webview') {
        this.#captureGuest(contents)
        return
      }
      // The host window is a 'window' webContents; its <webview> children arrive
      // via `did-attach-webview`. DevTools / other window contents never emit it,
      // so attaching to every window is harmless.
      if (contents.getType() !== 'window') return
      // Attach the guest preload MAIN-side — the <webview> `preload` attribute is
      // unreliable in current Electron. This also pins the guest's isolation
      // (context-isolated, no node integration, no sandbox — a sandboxed preload
      // crashes on load), independent of the element's attributes.
      contents.on('will-attach-webview', (_e, webPreferences) => {
        webPreferences.preload = GUEST_PRELOAD_PATH
        webPreferences.contextIsolation = true
        webPreferences.nodeIntegration = false
        webPreferences.sandbox = false
      })
      contents.on('did-attach-webview', (_e, guest) => {
        const guestId = guest.id
        // Usually already capturing — started when the guest was created (below).
        this.#captureGuest(guest)
        // The newest page is on screen until the renderer says otherwise: a
        // single-tab browser never has to say.
        this.#activeId = guestId
        // UI drafts: the canvas's screen frames get the picker main injects
        // (the guest preload never runs inside them).
        attachDraftFramePicker(guest, (processId, routingId) => webFrameMain.fromId(processId, routingId))
        // A new window the page asks for: the page's own site or a local server
        // opens as a Flow tab; any other site opens in the person's browser.
        // Never a new Electron window.
        guest.setWindowOpenHandler(({ url }) => {
          let opener: string | null = null
          try {
            opener = guest.getURL()
          } catch {
            opener = null
          }
          if (opensInFlow(opener, url)) {
            this.#broadcast?.openTab?.({ url, openerGuestId: guestId })
          } else if (/^https?:\/\//i.test(url)) {
            void shell.openExternal(url).catch((error: unknown) => console.warn('browser: open in default browser failed', error))
          }
          return { action: 'deny' }
        })
        // The page swallows its own keys: the tab shortcuts are taken here.
        guest.on('before-input-event', (event, input) => {
          if (input.type !== 'keyDown') return
          const action = tabShortcut(
            { key: input.key, meta: input.meta, control: input.control, shift: input.shift, alt: input.alt },
            process.platform === 'darwin',
          )
          if (action === null || this.#broadcast?.shortcut === undefined) return
          event.preventDefault()
          this.#broadcast.shortcut({ action, openerGuestId: guestId })
        })
        guest.once('destroyed', () => {
          const entry = this.#guests.get(guestId)
          if (entry === undefined || entry.guest !== guest) return
          entry.cdp.detach()
          entry.buffer.clear()
          this.#guests.delete(guestId)
          if (this.#activeId === guestId) this.#activeId = null
        })
      })
    })
  }

  /**
   * Start console/network capture over CDP for one guest, once. One buffer per
   * tab. The handle self-detaches on guest 'destroyed' / DevTools contention,
   * so a missed teardown can't leak the attach.
   */
  #captureGuest(guest: WebContents): GuestEntry {
    const guestId = guest.id
    const existing = this.#guests.get(guestId)
    if (existing !== undefined && existing.guest === guest) return existing
    const buffer = new RollingBuffer()
    const entry: GuestEntry = { guest, buffer, cdp: null as unknown as CdpCaptureHandle, errors: 0 }
    entry.cdp = attachCdpCapture(guest, buffer, (kind, counts) => {
      if (kind === 'console') {
        const newest = buffer.slice('console', { mode: 'last-n', n: 1 })[0]
        if (newest !== undefined && newest.kind === 'console' && newest.payload.level === 'error') entry.errors += 1
      }
      this.emitBufferUpdated({ kind, counts, guestId, errors: entry.errors })
    })
    this.#guests.set(guestId, entry)
    return entry
  }

  /** Wire the renderer broadcast channel (done once at IPC registration). */
  setBroadcast(broadcast: BrowserBroadcast): void {
    this.#broadcast = broadcast
  }

  /** Emit `browser:bufferUpdated` (Phase 5/6). No-op until a broadcast is wired. */
  emitBufferUpdated(payload: IpcEventPayload<'browser:bufferUpdated'>): void {
    this.#broadcast?.bufferUpdated(payload)
  }

  /** Emit `browser:tagPosted` (Phase 5/6). No-op until a broadcast is wired. */
  emitTagPosted(payload: IpcEventPayload<'browser:tagPosted'>): void {
    this.#broadcast?.tagPosted(payload)
  }

  /** The current guest webContents, or null when none is attached / alive. */
  currentGuest(): WebContents | null {
    return this.#active()?.guest ?? null
  }

  navigate(url: string): void {
    const guest = this.currentGuest()
    if (!guest) return
    // loadURL rejects on benign aborts (a redirect, an in-flight nav replaced),
    // so a failure is logged, never thrown back across IPC as a call error.
    void guest.loadURL(url).catch((error: unknown) => {
      console.warn(`browser: navigate to ${url} failed`, error)
    })
  }

  back(): void {
    const guest = this.currentGuest()
    // Electron 43: navigation moved onto webContents.navigationHistory; the bare
    // goBack/goForward are deprecated.
    if (guest?.navigationHistory.canGoBack()) guest.navigationHistory.goBack()
  }

  forward(): void {
    const guest = this.currentGuest()
    if (guest?.navigationHistory.canGoForward()) guest.navigationHistory.goForward()
  }

  reload(): void {
    this.currentGuest()?.reload()
  }

  /**
   * Best-effort capability probe. `cdp` reflects whether the CDP attach for the
   * current guest actually succeeded (false when DevTools already holds the
   * debugger); `sourceMapping` is assumed present whenever a guest is attached
   * (element→source is dev-build best-effort — Phase 4). Both false with no guest.
   */
  capabilities(): BrowserCapabilities {
    const hasGuest = this.currentGuest() !== null
    return { sourceMapping: hasGuest, cdp: this.#cdp?.available() ?? false }
  }

  // ── capture / tag / buffer ─────────────────────────────────────────────────
  // Element inspect runs in the guest preload (Phase 4); console/network flow
  // from CDP into the rolling buffer (Phase 5). Redaction of tagged payloads is
  // the Phase 6 capture boundary — inserted into the tag paths there.

  /** Toggle the guest's hover-to-tag inspect mode (Phase 4 guest preload). */
  setInspect(on: boolean): void {
    setGuestInspect(this.currentGuest(), on)
  }

  /**
   * Record what the person does in the page, for as long as a debug session is
   * open. Off at every other moment — nothing is listening in the guest unless
   * a session asked for it.
   */
  setRecording(on: boolean): void {
    setGuestRecording(this.currentGuest(), on)
  }

  /**
   * Read a slice of a kind's capture buffer without tagging it.
   *
   * `bodies: false` is the Network panel's list read: up to 500 requests, each
   * with up to two 64 KB bodies, is megabytes per refresh for a list that
   * prints none of them. The bodies stay here and are read one request at a
   * time when a row is opened (allowed-pattern #18).
   */
  bufferSlice(kind: BrowserCaptureKind, selector: TagWindow, bodies = true): BrowserCapture[] {
    const slice = this.#buffer?.slice(kind, selector) ?? []
    if (bodies || kind !== 'network') return slice
    return slice.map((capture) => {
      if (capture.kind !== 'network') return capture
      const { requestBody: _request, responseBody: _response, ...payload } = capture.payload
      return { ...capture, bodiesOmitted: true, payload }
    })
  }

  /** When the page on screen reached DOMContentLoaded and load. */
  pageTimings(): BrowserPageTimings {
    return this.#cdp?.pageTimings() ?? { domContentLoaded: null, load: null }
  }

  /**
   * Send a captured request again, from the page itself, so its cookies and
   * origin are the page's own. The new request is captured like any other and
   * appears as a new row. Main holds the unredacted capture, which is why this
   * lives here and not in the renderer: the page's real credentials go back to
   * the page they came from, and nowhere else.
   */
  async replay(id: string): Promise<{ ok: boolean; detail?: string }> {
    const capture = this.#buffer?.get(id) ?? null
    const guest = this.currentGuest()
    if (capture === null || capture.kind !== 'network') return { ok: false, detail: 'That request is no longer in the list.' }
    if (guest === null) return { ok: false, detail: 'The page is not open.' }
    const request = replayRequest(capture.payload)
    if (request === null) return { ok: false, detail: 'Only web requests can be sent again.' }
    try {
      const script = `fetch(${JSON.stringify(request.url)}, ${JSON.stringify(request.init)}).then(() => true, () => true)`
      await guest.executeJavaScript(script)
      return { ok: true }
    } catch {
      return { ok: false, detail: 'The page refused to send it.' }
    }
  }

  /**
   * Drop everything captured so far. The browser is one guest shared by every
   * conversation; when it passes to another one, what the previous page logged
   * must not be offered to the next thread's "Add all". The badge follows.
   */
  clearCaptures(): void {
    const buffer = this.#buffer
    if (buffer === null) return
    buffer.clear()
    // One event per listed kind, so whichever list the drawer shows re-reads.
    for (const kind of ['console', 'network'] as const) {
      this.emitBufferUpdated({ kind, counts: buffer.counts(), ...(this.#activeId === null ? {} : { guestId: this.#activeId }) })
    }
  }

  /** Tag a window of recent captures; emit `browser:tagPosted` for each.
   *  Each capture is redacted + bounded at the capture boundary (Phase 6)
   *  BEFORE it crosses IPC — the same code path the renderer runs for element
   *  captures (allowed-pattern #14). */
  tagRecent(kind: BrowserCaptureKind, window: TagWindow): BrowserCapture[] {
    const entries = this.#buffer?.slice(kind, window) ?? []
    const bounded = entries.map(redactAndBound)
    for (const capture of bounded) this.emitTagPosted(capture)
    return bounded
  }

  /** Tag one capture by id; emit `browser:tagPosted`. Redacted + bounded at the
   *  capture boundary before it leaves main (Phase 6). */
  tagEntry(kind: BrowserCaptureKind, id: string): BrowserCapture | null {
    const capture = this.#buffer?.get(id) ?? null
    if (capture && capture.kind === kind) {
      const bounded = redactAndBound(capture)
      this.emitTagPosted(bounded)
      return bounded
    }
    return null
  }
}

/** Single v1 controller — the guest tab it tracks is process-wide. */
export const browserController = new BrowserController()
