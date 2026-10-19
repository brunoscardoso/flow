/**
 * One settings dialog at a time (#1395) — the family's shared chrome.
 *
 * Settings, Flow settings and Integrations are all `.fl-settings-overlay`, all
 * `z-index: 2000`, and all appended to `document.body` at boot in that order.
 * Nothing stopped a second one opening over the first, and nothing raised the
 * newcomer — equal z-indexes paint in DOM order, so the dialog opened LAST was
 * drawn UNDERNEATH the ones created before it.
 *
 * The app menu's ⌘, is the one open path that deliberately survives an open
 * modal ("the overlay's own guards apply"), and no overlay had such a guard.
 * So ⌘, over Flow settings opened Settings invisibly behind it: keyboard focus
 * moved into a dialog the user could not see, Escape closed the one they were
 * looking at and revealed a second they never asked for.
 *
 * Rather than teach each consumer to check its siblings — convention restated
 * per surface drifts (allowed-pattern #14) — the family registers here, and
 * opening one closes the others.
 */

/** Close callbacks for the currently-registered overlays, keyed by name. */
const registry = new Map<string, () => void>()

/**
 * Register a settings-family overlay's close function. Returns an unregister
 * callback. Registering the same name twice replaces the entry, so a
 * re-created view never leaves a stale closer behind.
 */
export function registerSettingsOverlay(name: string, close: () => void): () => void {
  registry.set(name, close)
  return () => {
    if (registry.get(name) === close) registry.delete(name)
  }
}

/**
 * Close every settings-family overlay EXCEPT `name` — call it as the first
 * thing an overlay does when opening. Fail-soft: a closer that throws must not
 * stop the dialog the user actually asked for from opening.
 */
export function closeOtherSettingsOverlays(name: string): void {
  for (const [registered, close] of registry) {
    if (registered === name) continue
    try {
      close()
    } catch {
      // A sibling that cannot close is not a reason to refuse this open.
    }
  }
}

/** Registered overlay names — for tests and diagnostics. */
export function registeredSettingsOverlays(): string[] {
  return [...registry.keys()]
}
