// What the learner has actually been doing — a log a person can read.
//
// The panel could say "Learning src" and a filename, and that was the whole
// account: with a pass that takes minutes, there was no way to tell a slow one
// from a stopped one. Asked for directly — "show the logs really" — after
// watching one module for six minutes with no way to know if anything moved.
//
// A bounded ring in memory. It is a window on the current session, not a
// record: nothing here is persisted, nothing here is authoritative, and the
// oldest line is dropped the moment the newest arrives.

/** One thing that happened, in the order it happened. */
export interface LearnLogEntry {
  /** Epoch ms — the panel renders relative time from it. */
  at: number
  kind: 'queued' | 'start' | 'read' | 'learned' | 'failed' | 'stopped' | 'note'
  module: string
  /** The file being read, the failure's reason, or a free line for 'note'. */
  detail?: string
}

/** How many lines the ring holds — enough to see a pass, not a session. */
const MAX_ENTRIES = 200

const entries: LearnLogEntry[] = []

/**
 * Record one event. Consecutive 'read' lines for the same module collapse into
 * the latest — a pass reads dozens of files a minute and a log that scrolls
 * faster than it can be read is not a log.
 */
export function recordLearnEvent(entry: LearnLogEntry): void {
  const last = entries[entries.length - 1]
  if (
    last !== undefined &&
    last.kind === 'read' &&
    entry.kind === 'read' &&
    last.module === entry.module
  ) {
    entries[entries.length - 1] = entry
    return
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

/** The log, oldest first. A copy — callers must not hold the ring itself. */
export function readLearnLog(): LearnLogEntry[] {
  return [...entries]
}

/** Test-only: empty the ring. */
export function clearLearnLog(): void {
  entries.length = 0
}
