/**
 * Channels + payloads for the embedded browser's in-guest inspect bridge.
 *
 * Three processes speak these two channels and must agree on the strings, so
 * they live in `shared/` (compiled by BOTH tsconfig.node.json and
 * tsconfig.web.json):
 *
 *   host → guest   `BROWSER_INSPECT_TOGGLE`  — activate/deactivate the picker.
 *                  Delivered via `WebContents.send` (main) or `webview.send`
 *                  (renderer); received in the guest preload by `ipcRenderer.on`.
 *   guest → host   `BROWSER_INSPECT_CAPTURE` — a picked element's payload.
 *                  Sent from the guest preload via `ipcRenderer.sendToHost`,
 *                  received by the host as the `<webview>` element's
 *                  `ipc-message` event.
 *
 * DOM-FREE BY CONTRACT — plain string constants and a structural payload only,
 * so both compilers accept it unchanged (mirrors browser-capture-types.ts).
 */

/** host → guest: toggle the in-guest element picker. */
export const BROWSER_INSPECT_TOGGLE = 'flow:browser-inspect-toggle'

/** guest → host: a picked element, resolved to `BrowserElementPayload`. */
export const BROWSER_INSPECT_CAPTURE = 'flow:browser-inspect-capture'

/** guest -> host: the picker deactivated itself (Escape) so the host can reset
 *  its toolbar toggle. NOT sent for a host-driven deactivate. */
export const BROWSER_INSPECT_DEACTIVATED = 'flow:browser-inspect-deactivated'

/** Payload the host sends on `BROWSER_INSPECT_TOGGLE`. */
export interface BrowserInspectToggle {
  on: boolean
}

// ── Debug-session interaction recording ─────────────────────────────────────
//
// SEPARATE FROM THE PICKER, though both live in the same guest bridge. The
// picker is a mode a person enters to choose ONE element and it swallows the
// page's own clicks; recording is passive, runs for a whole session, and must
// never interfere with the app being debugged — a reproduction that behaves
// differently because it is being recorded is not a reproduction.

/** host → guest: start/stop recording what the person does in the page. */
export const BROWSER_RECORD_TOGGLE = 'flow:browser-record-toggle'

/** guest → host: one interaction, already reduced to an identity. */
export const BROWSER_RECORD_INTERACTION = 'flow:browser-record-interaction'

/** Payload the host sends on `BROWSER_RECORD_TOGGLE`. */
export interface BrowserRecordToggle {
  on: boolean
}

/**
 * One thing the person did, as the artifact will name it.
 *
 * `target` IS AN IDENTITY, NOT CONTENT — see `interaction-identity.ts` for the
 * rule and why it is drawn where it is. There is deliberately no field for the
 * element's text or an input's value: typed input is not captured at all, and
 * a shape with nowhere to put it cannot capture it by accident.
 */
export interface BrowserInteractionEvent {
  kind: 'click' | 'navigate' | 'load'
  /** Epoch ms, taken in the guest — the same clock everything else is on. */
  at: number
  /** What was interacted with, named from authored attributes only. */
  target: string
  /** Where the page was, for a navigate or a load. */
  url?: string
}
