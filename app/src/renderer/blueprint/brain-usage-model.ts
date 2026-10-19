// Brain-retrieval counters line for the Learning panel (brain-first-retrieval,
// Phase 4). Pure and DOM-free: format the cumulative totals served by
// `learn:brainUsage` into the panel's compact one-liner, or null when there is
// nothing to show (the panel renders no line then — the section only exists
// when non-zero).

import type { BrainUsageTotals } from '../../shared/ipc-contract'
import { formatSavedTokens } from '../../shared/brain-savings-format'

/** Percentage of searches NOT followed by a grep/glob fallback burst — the
 *  "the brain answered it" rate. Rounded to a whole percent. */
export function brainHitRatePercent(totals: BrainUsageTotals): number {
  if (totals.searches <= 0) return 0
  const served = Math.max(0, totals.searches - totals.misses)
  return Math.round((served / totals.searches) * 100)
}

/**
 * `Brain retrieval — N searches · H% hit-rate · M misses · S stale`, plus a
 * trailing `~Nk tokens saved` segment once the savings estimate is positive
 * (zero savings render no segment — same "no chrome at zero" rule as the
 * conversation surfaces). Null when no search was ever counted (missing store
 * reads as zeros → hidden).
 *
 * #1280: while the per-hit price is still the flat default the segment reads
 * `savings estimate calibrating` instead — publishing 8,000 × hits as though
 * it were measured is the bug that report was about.
 */
export function formatBrainUsageLine(totals: BrainUsageTotals | null): string | null {
  if (totals === null || totals.searches <= 0) return null
  const counted = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`
  const parts = [
    `Brain retrieval — ${counted(totals.searches, 'search', 'searches')}`,
    `${brainHitRatePercent(totals)}% hit-rate`,
    counted(totals.misses, 'miss', 'misses'),
    `${totals.staleHits} stale`,
  ]
  // #1280: the token figure only appears once the per-hit price is MEASURED
  // from this project's own exploration bursts. Uncalibrated, every hit is
  // priced at a flat 8,000 — a constant, not an estimate — so the line says
  // what it is instead of publishing the number.
  if (totals.calibrated === false) {
    parts.push('savings estimate calibrating')
    return parts.join(' · ')
  }
  const saved = formatSavedTokens(totals.savedTokens)
  if (saved !== null) parts.push(`${saved} tokens saved`)
  return parts.join(' · ')
}
