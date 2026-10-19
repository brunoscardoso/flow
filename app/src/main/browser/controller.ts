// Main-process controller for the embedded <webview> browser tab.
//
// The Phase-1 `browser:*` contract carries NO webContentsId on its requests, so
// the controller tracks the guest itself: it listens for `did-attach-webview`
// on every window-type webContents and holds the most-recently-attached guest.
// One guest is sufficient for the single v1 browser tab. Later phases (5/6)
// fill in the capture/tag/buffer surface — the STUBS here exist so every
// `browser:*` handler can register and the contract typechecks now.

import { join } from 'node:path'

import { app, type WebContents } from 'electron'

import type {
  BrowserCapabilities,
  BrowserCapture,
  BrowserCaptureKind,
  TagWindow,
} from '../../shared/browser-capture-types'
import { redactAndBound } from '../../shared/browser-capture-boundary'
import type { IpcEventPayload } from '../../shared/ipc-contract'
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
  #guest: WebContents | null = null
  #initialized = false
  #broadcast: BrowserBroadcast | null = null
  /** The always-on console/network buffer for the current guest (Phase 5). */
  #buffer: RollingBuffer | null = null
  /** The live CDP attach for the current guest (Phase 5). */
  #cdp: CdpCaptureHandle | null = null

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
        this.#guest = guest
        // Always-on console/network capture over CDP (Phase 5). The handle
        // self-detaches on guest 'destroyed' / DevTools contention, so a missed
        // teardown can't leak the attach.
        const buffer = new RollingBuffer()
        this.#buffer = buffer
        this.#cdp = attachCdpCapture(guest, buffer, (kind, counts) => {
          this.emitBufferUpdated({ kind, counts })
        })
        guest.once('destroyed', () => {
          if (this.#guest === guest) {
            this.#cdp?.detach()
            this.#cdp = null
            this.#buffer?.clear()
            this.#buffer = null
            this.#guest = null
          }
        })
      })
    })
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
    if (this.#guest && this.#guest.isDestroyed()) this.#guest = null
    return this.#guest
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

  /** Read a slice of a kind's capture buffer without tagging it. */
  bufferSlice(kind: BrowserCaptureKind, selector: TagWindow): BrowserCapture[] {
    return this.#buffer?.slice(kind, selector) ?? []
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
      this.emitBufferUpdated({ kind, counts: buffer.counts() })
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
