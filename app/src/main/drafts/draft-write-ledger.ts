/**
 * FLOW'S OWN WRITES. Every file Flow writes into a canvas — an edit, an undo,
 * a version restore, a stamp — is recorded here by path AND content hash
 * before the rename lands. The drafts observer asks before acting on a change:
 * a change whose bytes match a recorded write is Flow's own, so it is neither
 * re-stamped (no stamping loop) nor broadcast (no reload for our own write,
 * allowed-pattern #17).
 *
 * Content, not timing: an agent write that lands in the same instant as one of
 * ours has different bytes and is still seen. Entries expire, so a write the
 * watcher never reported cannot hide a later identical agent write for ever.
 */
import { createHash } from 'crypto'

/** How long an unclaimed record of our own write is kept. */
const OWN_WRITE_TTL_MS = 30_000

export interface DraftWriteLedger {
  /** Record that Flow is about to write `content` to `absPath`. */
  mark(absPath: string, content: string): void
  /** Whether a change of `absPath` to `content` is Flow's own write. Claims the record. */
  claim(absPath: string, content: string): boolean
}

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function createDraftWriteLedger(now: () => number = Date.now): DraftWriteLedger {
  const entries = new Map<string, Array<{ hash: string; at: number }>>()
  const prune = (absPath: string): Array<{ hash: string; at: number }> => {
    const fresh = (entries.get(absPath) ?? []).filter((entry) => now() - entry.at < OWN_WRITE_TTL_MS)
    if (fresh.length === 0) entries.delete(absPath)
    else entries.set(absPath, fresh)
    return fresh
  }
  return {
    mark(absPath, content) {
      const list = prune(absPath)
      list.push({ hash: hashOf(content), at: now() })
      entries.set(absPath, list)
    },
    claim(absPath, content) {
      const list = prune(absPath)
      const hash = hashOf(content)
      const at = list.findIndex((entry) => entry.hash === hash)
      if (at === -1) return false
      list.splice(at, 1)
      if (list.length === 0) entries.delete(absPath)
      return true
    },
  }
}
