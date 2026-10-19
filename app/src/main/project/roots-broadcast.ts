/**
 * The `project:listChanged` broadcast, coalesced at the source and sent only
 * when the list a renderer would draw actually changed (allowed-pattern #17).
 *
 * The registry emits `roots-changed` for every provisioning transition, every
 * stamp, every availability check — measured 2026-10-09 with five projects:
 * ~16 events in a launch's first half-minute, and each one made the renderer
 * re-read `flow:state` AND `tasks:list` for every project (82 + 81 calls in
 * 25 s; 30 + 30 on a plain relaunch where nothing changed at all). Main is the
 * one place that sees them all, so the debounce lives here ONCE rather than in
 * every listener.
 */

import type { RegisteredProject } from '../../shared/ipc-contract'

/** Trailing quiet window before a burst is sent. */
export const ROOTS_BROADCAST_DEBOUNCE_MS = 50
/** A burst that never pauses still goes out this often. */
export const ROOTS_BROADCAST_MAX_WAIT_MS = 250

export interface RootsBroadcast {
  push: (roots: readonly RegisteredProject[]) => void
  dispose: () => void
}

export function makeRootsBroadcast(
  send: (roots: RegisteredProject[]) => void,
  options: {
    now?: () => number
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
  } = {},
): RootsBroadcast {
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  let latest: RegisteredProject[] | null = null
  let lastSent: string | null = null
  let timer: unknown = null
  let firstAt = 0

  const flush = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
    const roots = latest
    latest = null
    if (roots === null) return
    const key = JSON.stringify(roots)
    // The same list again (a provisioning state re-set to what it was, an
    // availability sweep that found nothing new) is no news to anyone.
    if (key === lastSent) return
    lastSent = key
    send(roots)
  }

  return {
    push: (roots) => {
      if (latest === null) firstAt = now()
      latest = [...roots]
      if (now() - firstAt >= ROOTS_BROADCAST_MAX_WAIT_MS) {
        flush()
        return
      }
      if (timer !== null) clearTimer(timer)
      timer = setTimer(flush, ROOTS_BROADCAST_DEBOUNCE_MS)
    },
    dispose: () => {
      if (timer !== null) clearTimer(timer)
      timer = null
      latest = null
    },
  }
}
