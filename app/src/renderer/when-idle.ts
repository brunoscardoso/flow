/**
 * Run work when the app is not busy — the "later, and not now" seam.
 *
 * WHY IT IS ITS OWN MODULE. Background work scheduled with `setTimeout(0)` is
 * not background work: it runs on the next tick, which is exactly the tick the
 * reader's own click is waiting for. `requestIdleCallback` waits for a frame
 * with room in it, which is what "when nothing is happening" actually means.
 *
 * THE TIMEOUT IS THE POINT OF THE FALLBACK. An idle callback with no deadline
 * can be starved indefinitely by a busy app — and a busy app is precisely where
 * this is used — so every caller gets one either way: the browser's own
 * deadline where the API exists, a plain timer where it does not.
 */

/** How long a deferred piece of work may wait for quiet before it runs anyway. */
const IDLE_DEADLINE_MS = 8_000

type IdleWindow = typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
}

export function whenIdle(work: () => void, deadlineMs = IDLE_DEADLINE_MS): void {
  const host = globalThis as IdleWindow
  if (typeof host.requestIdleCallback === 'function') {
    host.requestIdleCallback(work, { timeout: deadlineMs })
    return
  }
  // No idle API (older WebKit, a test env): a plain delay is still strictly
  // better than "now", because "now" is the frame the reader is waiting on.
  setTimeout(work, Math.min(deadlineMs, 3_000))
}
