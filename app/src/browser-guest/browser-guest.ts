/**
 * Guest preload for the embedded browser's <webview>.
 *
 * The guest is sandboxed with contextIsolation on and shipped no preload before
 * this feature. This script bridges the picker that runs in the guest page
 * (inspect-bridge.ts) and the host renderer:
 *
 *   - it listens on `BROWSER_INSPECT_TOGGLE` (delivered by the host via
 *     `WebContents.send` / `webview.send`) to activate/deactivate the picker;
 *   - it forwards each picked element to the host with `ipcRenderer.sendToHost`
 *     on `BROWSER_INSPECT_CAPTURE` (the picker is sticky — one message per click,
 *     the session stays open);
 *   - when the picker ends itself from inside the guest (Escape), it tells the
 *     host on `BROWSER_INSPECT_DEACTIVATED` so the toolbar toggle resets.
 *
 * A sandboxed preload may use `ipcRenderer` (and `sendToHost`) and has DOM
 * access — everything this bridge needs. It lives under src/browser-guest/ (its
 * own DOM-enabled compilation target) alongside inspect-bridge.ts.
 *
 * Registered as a build entry in electron.vite.config.ts (`browser-guest`) so it
 * bundles to out/preload/browser-guest.js; the renderer sets it as the webview's
 * `preload` attribute from the file:// URL the main preload exposes.
 */
import { ipcRenderer } from 'electron'

import {
  BROWSER_DRAFT_HISTORY,
  BROWSER_DRAFT_INSPECT,
  BROWSER_DRAFT_PICK,
  BROWSER_INSPECT_CAPTURE,
  BROWSER_INSPECT_DEACTIVATED,
  BROWSER_INSPECT_TOGGLE,
  BROWSER_RECORD_INTERACTION,
  BROWSER_RECORD_TOGGLE,
  type BrowserInspectToggle,
  type BrowserRecordToggle,
} from '../shared/browser-inspect-channels'
import { DRAFT_CANVAS_HISTORY, parseDraftHistoryRequest } from '../shared/draft-history-messages'
import { DRAFT_CANVAS_INSPECT, DRAFT_CANVAS_PICK, parseDraftCanvasPick } from '../shared/draft-pick'
import { parseDraftPageUrl } from '../shared/ui-drafts'
import { createInspectBridge } from './inspect-bridge'
import { createInteractionRecorder } from './interaction-recorder'

const bridge = createInspectBridge({
  onCapture: (payload) => {
    ipcRenderer.sendToHost(BROWSER_INSPECT_CAPTURE, payload)
  },
  onDeactivate: () => {
    ipcRenderer.sendToHost(BROWSER_INSPECT_DEACTIVATED)
  },
})

ipcRenderer.on(BROWSER_INSPECT_TOGGLE, (_event, toggle: BrowserInspectToggle) => {
  if (toggle.on) bridge.activate()
  else bridge.deactivate()
})

// UI drafts: the canvas page relays picks made inside its screen frames (which
// have no preload of their own) by posting them to ITSELF. Only a same-origin
// message on a canvas page is heard — a screen's frames are opaque origins, and
// a screen opened alone is not a canvas — and the pick is re-validated before
// it crosses to the host.
window.addEventListener('message', (event: MessageEvent) => {
  if (event.origin !== window.location.origin) return
  if (parseDraftPageUrl(window.location.href)?.kind !== 'canvas') return
  const data = event.data as { type?: unknown; on?: unknown } | null
  if (data === null || typeof data !== 'object') return
  if (data.type === DRAFT_CANVAS_PICK) {
    const pick = parseDraftCanvasPick(data)
    if (pick !== null) ipcRenderer.sendToHost(BROWSER_DRAFT_PICK, pick)
    return
  }
  if (data.type === DRAFT_CANVAS_HISTORY) {
    const request = parseDraftHistoryRequest(data)
    if (request !== null) ipcRenderer.sendToHost(BROWSER_DRAFT_HISTORY, request)
    return
  }
  if (data.type === DRAFT_CANVAS_INSPECT) ipcRenderer.sendToHost(BROWSER_DRAFT_INSPECT, { on: data.on === true })
})

// A debug session's record of what the person DID. Passive: off unless a
// session says otherwise, and it never touches the page's own behaviour.
const recorder = createInteractionRecorder((event) => {
  ipcRenderer.sendToHost(BROWSER_RECORD_INTERACTION, event)
})

ipcRenderer.on(BROWSER_RECORD_TOGGLE, (_event, toggle: BrowserRecordToggle) => {
  if (toggle.on) recorder.start()
  else recorder.stop()
})

// Diagnostic: confirms the guest preload actually loaded (visible in the page
// console AND captured by CDP -> the Console drawer).
console.info('[flow] embedded-browser inspect bridge ready')
