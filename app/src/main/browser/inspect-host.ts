// Host-side (main process) helper for the embedded browser's inspect mode.
//
// This is the ONE method the host uses to reach the guest picker. It is DOM-free
// node code (it only calls `send` on the guest), so it lives under src/main — the
// DOM picker it toggles lives in src/browser-guest/inspect-bridge.ts, compiled
// with the DOM lib under its own tsconfig so that lib never leaks into the
// main/test program (a `/// <reference lib="dom" />` in a src/main file would).

import {
  BROWSER_INSPECT_TOGGLE,
  BROWSER_RECORD_TOGGLE,
  type BrowserInspectToggle,
  type BrowserRecordToggle,
} from '../../shared/browser-inspect-channels'

/** A structural slice of Electron's `WebContents` — so this file imports no
 *  `electron` and stays trivially unit-testable. */
interface InspectGuest {
  send(channel: string, ...args: unknown[]): void
}

/**
 * Toggle the in-guest picker from the host. The controller wires this into
 * `BrowserController.setInspect` — `setGuestInspect(this.currentGuest(), on)`.
 * A no-op when there is no guest.
 */
export function setGuestInspect(guest: InspectGuest | null, on: boolean): void {
  if (guest === null) return
  guest.send(BROWSER_INSPECT_TOGGLE, { on } satisfies BrowserInspectToggle)
}

/**
 * Turn the guest's interaction RECORDING on or off.
 *
 * Separate from the picker above, and not just by channel: the picker is a mode
 * a person enters to choose one element, and it swallows the page's own clicks
 * to do it. Recording is passive, runs for a whole debug session, and must
 * change nothing about how the page behaves — a reproduction that behaves
 * differently because it is being recorded is not a reproduction.
 *
 * A no-op when there is no guest: a session recording only terminals is a real
 * session, not a failed one.
 */
export function setGuestRecording(guest: InspectGuest | null, on: boolean): void {
  if (guest === null) return
  guest.send(BROWSER_RECORD_TOGGLE, { on } satisfies BrowserRecordToggle)
}
