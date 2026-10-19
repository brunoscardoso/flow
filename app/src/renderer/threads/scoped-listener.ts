// A listener whose life is a field's, not the window's.
//
// The thread rename field put a capture `keydown` listener on `window` and
// removed it only lazily, on the NEXT keydown after the field was gone — so a
// committed or cancelled rename left it attached until someone pressed a key,
// and a menu torn down another way kept it for good. The remover this returns
// is what the field's own teardown calls: idempotent, so commit, Escape and the
// menu's cleanup may all call it.

/** The parts of an EventTarget this needs (testable without a DOM). */
export interface ListenerTarget<E> {
  addEventListener(type: string, listener: (event: E) => void, capture: boolean): void
  removeEventListener(type: string, listener: (event: E) => void, capture: boolean): void
}

/** Attach `listener`; the answer removes it, once, however often it is called. */
export function listenUntilRemoved<E>(
  target: ListenerTarget<E>,
  type: string,
  listener: (event: E) => void,
  capture: boolean,
): () => void {
  let attached = true
  target.addEventListener(type, listener, capture)
  return () => {
    if (!attached) return
    attached = false
    target.removeEventListener(type, listener, capture)
  }
}

/** Run `first`, then `second` — a menu's cleanup, extended by what it now holds. */
export function chainCleanup(first: (() => void) | null, second: () => void): () => void {
  return () => {
    second()
    first?.()
  }
}
