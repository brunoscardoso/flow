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
// not start another. It JOINS the running one — answered as soon as that
// settles — and ONE trailing re-read is queued behind it, shared by every
// caller in that window, so what was written after the running read began
// still reaches the screen. A caller that must see the tree as it is AFTER
// something it just did (a commit it is about to push from) asks for
// `fresh` and waits for that trailing run instead. Not a cache: nothing is
// held after the last run settles.
//
// MEASURED (throwaway probe, 4 roots x 5 doors arriving over 40 ms, each a
// real status + log(100) + merge-state on a 3,000-file repo with 460 changes):
//   before (every door its own read)       20 rounds, 60 IPC reads, last answer ~560 ms
//   queue-only (every joiner waits trailing) 8 rounds, 24 IPC reads, last answer ~900-1600 ms
//   join + one trailing (this)              8 rounds, 24 IPC reads, last answer ~515 ms
// The queue-only shape cut the reads and made every answer later: a joiner
// always waited for a SECOND run. Joining keeps the cut and answers in one.
//
// Pure (no DOM, no IPC): `run` is injected, so it is unit-tested directly.

export interface Coalescer<K> {
  /** Run (or join) the refresh for `key`. Resolves when the running refresh
   *  settles; with `fresh`, when a run that STARTED after this call has. */
  request(key: K, options?: { fresh?: boolean }): Promise<void>
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
    request(key, options) {
      const current = inFlight.get(key)
      if (current === undefined) return start(key)
      let trailing = queued.get(key)
      if (trailing === undefined) {
        trailing = current.then(() => {
          queued.delete(key)
          return start(key)
        })
        queued.set(key, trailing)
      }
      return options?.fresh === true ? trailing : current
    },
    running(key) {
      return inFlight.has(key)
    },
  }
}
