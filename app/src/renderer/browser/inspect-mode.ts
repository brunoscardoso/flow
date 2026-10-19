/**
 * Renderer-side wiring for the embedded browser's inspect mode.
 *
 * It sits between the toolbar inspect toggle and the sandboxed guest:
 *   - `setActive(on)` routes the toggle through `browser.setInspect` (main's
 *     BrowserController → the guest preload), which activates/deactivates the
 *     in-guest picker;
 *   - it listens for the guest's posted captures — the `<webview>` element's
 *     `ipc-message` event on `BROWSER_INSPECT_CAPTURE` — and hands each one to
 *     registered consumers. The picker is STICKY, so a session yields one
 *     message per click until it ends;
 *   - it listens for `BROWSER_INSPECT_DEACTIVATED` (the guest ended the session
 *     itself, via Escape) and notifies `onDeactivated` consumers so the toolbar
 *     toggle can reset.
 *
 * `onElementCapture` exposes each captured element so the capture-boundary phase
 * can turn it into a composer chip. No chip is built here.
 */
import type { BrowserElementPayload } from '../../shared/browser-capture-types'
import {
  BROWSER_RECORD_INTERACTION,
  type BrowserInteractionEvent,
  BROWSER_INSPECT_CAPTURE,
  BROWSER_INSPECT_DEACTIVATED,
} from '../../shared/browser-inspect-channels'

/** The slice of Electron's <webview> element inspect mode drives. */
interface InspectWebview extends HTMLElement {
  send(channel: string, ...args: unknown[]): void
}

/** A webview `ipc-message` event: the guest channel plus the posted args. */
interface WebviewIpcMessageEvent extends Event {
  channel: string
  args: unknown[]
}

/** The slice of the browser IPC surface inspect mode needs (from FlowBrowserApi). */
interface InspectBrowserApi {
  setInspect(request: { on: boolean }): Promise<void>
}

export type ElementCaptureListener = (payload: BrowserElementPayload) => void
export type DeactivateListener = () => void

export interface InspectMode {
  /** Activate/deactivate inspect mode — routes to the guest via main. */
  setActive(on: boolean): void
  /** Register a consumer of captured elements. Returns an unsubscribe. */
  onElementCapture(listener: ElementCaptureListener): () => void
  /** Register a consumer for "the guest ended inspect itself" (Escape). */
  onDeactivated(listener: DeactivateListener): () => void
  /** Detach the webview listener and drop all consumers. */
  dispose(): void
}

export function initInspectMode(webview: InspectWebview, browser: InspectBrowserApi): InspectMode {
  const captureListeners = new Set<ElementCaptureListener>()
  const deactivateListeners = new Set<DeactivateListener>()

  const onIpcMessage = (event: Event): void => {
    const message = event as WebviewIpcMessageEvent
    if (message.channel === BROWSER_INSPECT_DEACTIVATED) {
      for (const listener of deactivateListeners) {
        try {
          listener()
        } catch (error) {
          console.error('flow: browser inspect deactivate listener failed', error)
        }
      }
      return
    }
    // ── A CLICK ON ITS WAY TO A LIVE DEBUG SESSION ─────────────────────────
    //
    // The guest can only `sendToHost`, which reaches this window; the session
    // lives in main. This is the hop between them, and its absence is why every
    // artifact said "nothing was captured from the page itself" while the
    // person had been clicking throughout (user, 2026-09-21).
    //
    // Fire-and-forget: a dropped interaction must never interrupt the page
    // being debugged, and main ignores these unless a session is live.
    if (message.channel === BROWSER_RECORD_INTERACTION) {
      const event = message.args[0] as BrowserInteractionEvent | undefined
      if (event === undefined) return
      void window.flow.debug
        .interaction({
          kind: event.kind,
          at: event.at,
          target: event.target,
          ...(event.url === undefined ? {} : { url: event.url }),
        })
        .catch(() => undefined)
      return
    }
    if (message.channel !== BROWSER_INSPECT_CAPTURE) return
    const payload = message.args[0] as BrowserElementPayload | undefined
    if (!payload) return
    for (const listener of captureListeners) {
      try {
        listener(payload)
      } catch (error) {
        console.error('flow: browser inspect capture listener failed', error)
      }
    }
  }

  webview.addEventListener('ipc-message', onIpcMessage)

  return {
    setActive(on) {
      void browser
        .setInspect({ on })
        .catch((error: unknown) => console.warn('flow: browser setInspect failed', error))
    },
    onElementCapture(listener) {
      captureListeners.add(listener)
      return () => {
        captureListeners.delete(listener)
      }
    },
    onDeactivated(listener) {
      deactivateListeners.add(listener)
      return () => {
        deactivateListeners.delete(listener)
      }
    },
    dispose() {
      webview.removeEventListener('ipc-message', onIpcMessage)
      captureListeners.clear()
      deactivateListeners.clear()
    },
  }
}
