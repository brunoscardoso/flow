// One refresh per key in flight, at most one queued behind it.
//
// THE DEFECT. Adding a project fires the panel's refresh from four doors in
// the same breath — the root sync, the active-project switch, the thread
// scope landing, and the first git/file event — and each one started its own
// status + log + merge-state round trip. Main shares a running `git status`
// between concurrent callers, but the log and merge-state reads were not
// shared, and a caller arriving just after a scan settled started a whole new
// one. Measured on project add: the renderer asked 3–5 times for one root and
// waited up to 9.8 s for the answers to drain through a busy main process.
//
// THE RULE. A caller that arrives while a refresh for its key is running does
// not start another; it gets a promise for the NEXT one, which starts the
// moment the running one settles — so nobody is answered with data read
// before their request, and any number of callers in that window share one
// trailing run. Not a cache: nothing is held after the last run settles.
//
// Pure (no DOM, no IPC): `run` is injected, so it is unit-tested directly.

export interface Coalescer<K> {
  /** Run (or join) the refresh for `key`. Resolves when a run that STARTED
   *  after this call has finished. */
  request(key: K): Promise<void>
  /** Whether a refresh for `key` is running. */
  running(key: K): boolean
}

export function createCoalescer<K>(run: (key: K) => Promise<void>): Coalescer<K> {
  const inFlight = new Map<K, Promise<void>>()
  const queued = new Map<K, Promise<void>>()

  const start = (key: K): Promise<void> => {
    const promise = run(key)
      .catch(() => undefined)
      .finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key)
      })
    inFlight.set(key, promise)
    return promise
  }

  return {
    request(key) {
      const current = inFlight.get(key)
      if (current === undefined) return start(key)
      const waiting = queued.get(key)
      if (waiting !== undefined) return waiting
      const next = current.then(() => {
        queued.delete(key)
        return start(key)
      })
      queued.set(key, next)
      return next
    },
    running(key) {
      return inFlight.has(key)
    },
  }
}
