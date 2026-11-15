// "Questions asked" on a feature's brief — what the section shows, DOM-free
// (plan `ask_the_blueprint`, Phase 4). The board reads the saved answers once,
// when the brief opens, and this decides the rows: newest first, a verdict
// chip, who asked and when, how many follow-ups, and whether the code under
// the answer changed since.

import type { AskSavedThread, AskStaleResult } from '../../shared/ask-contract'
import { ageLabel } from './ask-panel-model'

/** How many saved questions the brief lists before "See all". */
export const SAVED_ROWS_SHOWN = 3

export interface SavedRowView {
  id: string
  question: string
  /** "Yes · medium effort"; null when the answer carried no verdict. */
  chip: string | null
  /** "You · just now · 2 follow-ups". */
  meta: string
  /** The code under this answer changed since it was written. */
  stale: boolean
  /** The tags the question was asked with — what Ask again asks it with. */
  tags: string[]
}

export interface SavedSectionView {
  /** "Questions asked · 4". */
  heading: string
  rows: SavedRowView[]
  /** More saved questions than rows shown. */
  hasMore: boolean
}

/** The section, or null when there is nothing to show — the brief then draws none. */
export function savedSectionView(
  threads: readonly AskSavedThread[],
  stale: readonly AskStaleResult[],
  now: number,
): SavedSectionView | null {
  if (threads.length === 0) return null
  const staleIds = new Set(stale.filter((result) => result.stale).map((result) => result.id))
  const ordered = [...threads].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
  const rows = ordered.slice(0, SAVED_ROWS_SHOWN).map((thread): SavedRowView => {
    const isStale = staleIds.has(thread.id)
    const followUps = thread.followUps.length
    const parts = [
      thread.author,
      ageLabel(thread.ts, now),
      followUps > 0 ? `${followUps} follow-up${followUps === 1 ? '' : 's'}` : '',
    ].filter((part) => part !== '')
    return {
      id: thread.id,
      question: thread.question,
      chip: thread.verdict === undefined ? null : [thread.verdict.label, thread.verdict.risk ?? ''].filter((p) => p !== '').join(' · '),
      meta: parts.join(' · '),
      stale: isStale,
      tags: thread.tags,
    }
  })
  return { heading: `Questions asked · ${threads.length}`, rows, hasMore: threads.length > rows.length }
}
