/**
 * Shell-style message-history recall for the composer (#776): ArrowUp on the
 * first line steps back through previously-sent messages, ArrowDown on the
 * last line steps forward and finally restores the in-progress draft. Pure and
 * DOM-free — the composer owns the textarea; this owns the decision.
 *
 * Semantics (matching shells / browser devtools):
 *  - History is per-thread and session-scoped (what you sent this session).
 *  - Entering navigation saves the current draft; stepping forward past the
 *    newest entry restores it.
 *  - Any user EDIT while navigating resets the cursor — the modified text is a
 *    new draft, and the next ArrowUp starts again from the newest entry.
 *  - Consecutive duplicates collapse; the history is capped.
 */

export interface ComposerHistory {
  /** Sent texts, oldest → newest. */
  entries: string[]
  /** Current position while navigating; null = not navigating. */
  index: number | null
  /** The live draft saved when navigation began (restored on forward-past-newest). */
  draft: string
}

export const HISTORY_CAP = 50

/**
 * Upper bound on messages fetched to SEED recall from prior sessions (#776).
 * seedEntries keeps only the last HISTORY_CAP (50) *user* entries, so there is
 * no reason to pull a whole thread's transcript — measured at 2.74 MB for 1,260
 * messages — across IPC just to filter for user strings. `messages:list` with a
 * limit returns the most-recent N (store-side DESC + LIMIT, re-reversed), and a
 * generous 400-message tail contains far more than 50 user turns in any
 * realistic thread while cutting the payload by roughly an order of magnitude.
 * It also bounds the handler's per-message attachment N+1 to the same window.
 * (allowed-pattern #18: bound the payload at the boundary.)
 */
export const RECALL_SEED_MESSAGE_LIMIT = 400

export function emptyHistory(): ComposerHistory {
  return { entries: [], index: null, draft: '' }
}

/** Record a sent message. Blank texts and immediate duplicates are skipped;
 *  navigation resets (the next ArrowUp starts from this newest entry). */
export function pushEntry(history: ComposerHistory, text: string): ComposerHistory {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { ...history, index: null, draft: '' }
  }
  const entries =
    history.entries[history.entries.length - 1] === trimmed
      ? history.entries
      : [...history.entries, trimmed].slice(-HISTORY_CAP)
  return { entries, index: null, draft: '' }
}

/** A user edit while navigating makes the text a NEW draft — reset the cursor. */
export function resetNavigation(history: ComposerHistory): ComposerHistory {
  if (history.index === null) return history
  return { ...history, index: null, draft: '' }
}

/**
 * Step through history. Returns the new state + the text the composer should
 * show, or null when the step does nothing (no entries; back at the oldest;
 * forward while not navigating).
 */
export function navigate(
  history: ComposerHistory,
  direction: 'back' | 'forward',
  currentText: string,
): { history: ComposerHistory; text: string } | null {
  const { entries, index } = history
  if (direction === 'back') {
    if (entries.length === 0) return null
    if (index === null) {
      // Entering navigation — save the live draft.
      const next = entries.length - 1
      return {
        history: { ...history, index: next, draft: currentText },
        text: entries[next],
      }
    }
    if (index === 0) return null // already at the oldest
    return { history: { ...history, index: index - 1 }, text: entries[index - 1] }
  }
  // forward
  if (index === null) return null
  if (index >= entries.length - 1) {
    // Past the newest — leave navigation and restore the draft.
    return { history: { ...history, index: null, draft: '' }, text: history.draft }
  }
  return { history: { ...history, index: index + 1 }, text: entries[index + 1] }
}

/**
 * The recallable TYPED text of a persisted message content (#776 cross-session
 * seeding). Sent contents are serialized with a preamble the user never typed —
 * `[blueprint: …]` chip lines, then `Context from <label>:` fenced blocks —
 * followed by a blank line and the typed text. Recalling those blobs verbatim
 * would flood the composer, so strip the preamble and return only the tail.
 * Returns '' when the message was preamble-only (attachment-only sends).
 */
export function recallableText(content: string): string {
  const lines = content.split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index].trim()
    if (line === '') {
      index += 1
      continue
    }
    // Blueprint chip line: [blueprint: …] / [blueprint story: …]
    if (/^\[blueprint[ :]/.test(line)) {
      index += 1
      continue
    }
    // Context block: "Context from <label>:" then a fence — skip through its close.
    if (/^Context from .*:$/.test(line)) {
      const fenceLine = lines[index + 1]?.trim() ?? ''
      const fence = /^(`{3,})/.exec(fenceLine)?.[1]
      if (fence) {
        let cursor = index + 2
        while (cursor < lines.length) {
          const t = lines[cursor].trim()
          if (t.startsWith(fence) && !t.slice(fence.length).startsWith('`')) break
          cursor += 1
        }
        index = cursor + 1
        continue
      }
    }
    break // first genuinely-typed line
  }
  return lines.slice(index).join('\n').trim()
}

/**
 * Seed a thread's history from PERSISTED sent texts (oldest → newest), placed
 * BEFORE any in-session entries so ArrowUp still reaches this session's sends
 * first. Blank texts drop, boundary duplicates collapse, the cap holds, and
 * navigation state is untouched. Idempotence is the caller's job (seed once
 * per thread).
 */
export function seedEntries(history: ComposerHistory, sentTexts: readonly string[]): ComposerHistory {
  const seeded: string[] = []
  for (const text of sentTexts) {
    const trimmed = text.trim()
    if (trimmed.length === 0) continue
    if (seeded[seeded.length - 1] === trimmed) continue
    seeded.push(trimmed)
  }
  if (seeded.length === 0) return history
  // Collapse the seam duplicate (last persisted == first in-session entry).
  const existing =
    history.entries[0] === seeded[seeded.length - 1] ? history.entries.slice(1) : history.entries
  return { ...history, entries: [...seeded, ...existing].slice(-HISTORY_CAP) }
}

/** Whether the caret sits on the FIRST line of the value (ArrowUp = history). */
export function caretOnFirstLine(value: string, caret: number): boolean {
  return !value.slice(0, caret).includes('\n')
}

/** Whether the caret sits on the LAST line of the value (ArrowDown = history). */
export function caretOnLastLine(value: string, caret: number): boolean {
  return !value.slice(caret).includes('\n')
}
