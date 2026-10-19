// Pure ranking + merge for the command palette. DOM-free so it's unit-testable
// under node-env jest. Takes the blended candidate set from all source providers
// and returns ONE deterministically ordered list.
//
// Blended score = per-kind base weight + fuzzy score + a recency boost. The base
// weights encode the intended tiers (exact/prefix filename › recent thread ›
// fuzzy path › body hit): a strong filename match wins on fuzzy score, while a
// recent thread's recency boost lets it out-rank a weak fuzzy path. Recency is
// normalized WITHOUT a clock — candidates are ranked by their ISO `recencyAt`
// relative to each other — so ranking is deterministic for the same inputs.

import type { PaletteCandidate, PaletteKind, RankWeights } from './palette-types'

/** The single source of truth for the ranking tiers — kept in one constant so
 *  the per-kind priorities can't quietly drift across providers/tests. */
export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  // Files edge out threads on an equal fuzzy match (filename intent is strong),
  // commands sit just under files so a typed command label still surfaces.
  base: { file: 10, thread: 8, command: 9 },
  // Recency can lift a recent thread by up to this much — enough to beat a weak
  // fuzzy path (base+small score) but not a strong filename hit.
  recency: 9,
}

/** Max results kept per kind so one source can't crowd out the others. */
export const DEFAULT_PER_KIND_CAP = 20

/** Deterministic tiebreak ordering across kinds. */
const KIND_ORDER: Record<PaletteKind, number> = { file: 0, thread: 1, command: 2 }

/**
 * Normalize the ISO `recencyAt` stamps present in the set to [0, 1] by their
 * relative order (newest → 1, oldest → 0), clock-free. A single distinct stamp
 * maps to 1 (it's the most recent thing there is).
 */
function buildRecencyRanks(candidates: readonly PaletteCandidate[]): Map<string, number> {
  const stamps = candidates
    .map((candidate) => candidate.recencyAt)
    .filter((stamp): stamp is string => typeof stamp === 'string' && stamp.length > 0)
  const distinctDesc = [...new Set(stamps)].sort((a, b) => b.localeCompare(a))
  const ranks = new Map<string, number>()
  const denom = distinctDesc.length - 1
  distinctDesc.forEach((stamp, index) => {
    ranks.set(stamp, denom <= 0 ? 1 : 1 - index / denom)
  })
  return ranks
}

/**
 * Merge and rank all candidates into one deterministic list. Combines each
 * candidate's fuzzy `score` (absent → 0) with its per-kind base weight and a
 * recency boost, sorts by the blended score with stable tiebreaks (kind order,
 * then label, then original position), and caps the kept results per kind.
 * Never mutates the input candidates.
 */
export function rankCandidates(
  candidates: readonly PaletteCandidate[],
  weights: RankWeights = DEFAULT_RANK_WEIGHTS,
  perKindCap: number = DEFAULT_PER_KIND_CAP,
): PaletteCandidate[] {
  const recencyRanks = buildRecencyRanks(candidates)

  const scored = candidates.map((candidate, index) => {
    const fuzzy = candidate.score ?? 0
    const base = weights.base[candidate.kind]
    const recency = candidate.recencyAt
      ? weights.recency * (recencyRanks.get(candidate.recencyAt) ?? 0)
      : 0
    return { candidate, blended: base + fuzzy + recency, index }
  })

  scored.sort(
    (a, b) =>
      b.blended - a.blended ||
      KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind] ||
      // Preserve each source's own order on a tie (registry order for commands,
      // recency for threads, alpha for the already-sorted file list) rather than
      // re-sorting alphabetically — so the curated command order is honored.
      a.index - b.index,
  )

  const counts: Record<PaletteKind, number> = { file: 0, thread: 0, command: 0 }
  const ranked: PaletteCandidate[] = []
  for (const entry of scored) {
    const kind = entry.candidate.kind
    if (counts[kind] >= perKindCap) continue
    counts[kind] += 1
    ranked.push(entry.candidate)
  }
  return ranked
}

/**
 * The empty-term list: recents first (recent files/threads the view supplies),
 * then suggested actions (top commands). Both are already ordered by the caller;
 * this just concatenates them, capping each side so the overlay stays compact.
 */
export function emptyStateResults(
  recents: readonly PaletteCandidate[],
  actions: readonly PaletteCandidate[],
  recentsCap = 8,
  actionsCap = 6,
): PaletteCandidate[] {
  return [...recents.slice(0, recentsCap), ...actions.slice(0, actionsCap)]
}
