/**
 * Per-thread composer drafts (#1067): a prompt typed but not sent belongs to
 * the thread it was written for. The composer persists it on thread switch /
 * blur / debounced input and restores it when the thread is reopened — so a
 * switch never destroys typed work (the composer analog of the editor's #955
 * dirty buffers). Storage is a small LRU-capped list in localStorage, keyed by
 * thread id, so drafts also survive an app relaunch.
 *
 * Pure and DOM-free: the composer owns localStorage + the textarea; this
 * module owns the store shape and its invariants (cap, dedup, empty-removal).
 */

/** Newest-last list of [threadId, draftText] pairs (LRU order). */
export type DraftStore = ReadonlyArray<readonly [string, string]>

/** Bound the store so deleted/abandoned threads can't grow it forever. */
export const DRAFT_STORE_CAP = 50

/** localStorage key for the persisted per-thread drafts (#1067). */
export const DRAFT_STORE_KEY = 'flow.composer.thread-drafts.v1'

/** Parse a persisted store; malformed/foreign data degrades to empty. */
export function parseDraftStore(raw: string | null): DraftStore {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: Array<readonly [string, string]> = []
    for (const entry of parsed) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        entry[0].length > 0 &&
        typeof entry[1] === 'string'
      ) {
        out.push([entry[0], entry[1]])
      }
    }
    return out.slice(-DRAFT_STORE_CAP)
  } catch {
    return []
  }
}

export function serializeDraftStore(store: DraftStore): string {
  return JSON.stringify(store)
}

/** The saved draft for a thread ('' when none). */
export function draftFor(store: DraftStore, threadId: string): string {
  for (const [id, text] of store) {
    if (id === threadId) return text
  }
  return ''
}

/**
 * Record a thread's draft. A whitespace-only draft REMOVES the entry (nothing
 * worth restoring); a real draft moves to the end (most-recent) and the cap
 * drops the oldest entries. Returns the same store when nothing changes.
 */
export function withDraft(store: DraftStore, threadId: string, text: string): DraftStore {
  const existing = draftFor(store, threadId)
  const empty = text.trim().length === 0
  if (empty && existing === '') return store
  const rest = store.filter(([id]) => id !== threadId)
  if (empty) return rest
  if (existing === text && store[store.length - 1]?.[0] === threadId) return store
  return [...rest, [threadId, text] as const].slice(-DRAFT_STORE_CAP)
}
