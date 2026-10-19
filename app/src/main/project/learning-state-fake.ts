// An in-memory stand-in for the learning-state store — TEST SUPPORT ONLY, and
// deliberately the only one.
//
// Five suites used to fake this store, each with its own `readLearning` +
// `writeLearning` pair, and three of them passed the whole deps object through
// an `as never` cast. So when the seam changed, those three kept compiling and
// silently fell through to the REAL store — against `/repo/.structure`, a path
// no test ever meant to touch. The suites went green on a store that had failed
// to open. One fake, imported, cannot do that: a rename is a compile error and
// a mistake is fixed in one place (allowed-pattern #14).
//
// It implements the store's contract, not an approximation of it: `null` from
// the mutator means "leave the store alone", and each mutation sees the entries
// the previous one left behind.

import type { BlueprintLearningEntry } from '../../shared/ipc-contract'
import { dedupLearningEntries, type MutateLearningState } from './learning-state'

/** What a fake exposes beyond the seam itself, for assertions. */
export interface LearningStateFake {
  /** The seam to inject as `mutateLearning`. */
  mutate: MutateLearningState
  /** The store's current contents (deduped, as on disk). */
  entries: () => BlueprintLearningEntry[]
  /** One record per REWRITE, in order: the last entry each mutation wrote. */
  transitions: Array<{ module: string; status: string }>
  /** Structure dirs the seam was called with, in order. */
  calls: string[]
}

/**
 * Build an in-memory learning-state store seeded with `initial`.
 *
 * Every suite that injects `mutateLearning` should use this rather than a
 * hand-rolled closure — see the header for what hand-rolled cost.
 */
export function makeLearningStateFake(
  initial: readonly BlueprintLearningEntry[] = [],
): LearningStateFake {
  let entries: BlueprintLearningEntry[] = dedupLearningEntries(initial)
  const transitions: Array<{ module: string; status: string }> = []
  const calls: string[] = []

  const mutate: MutateLearningState = async (structureDir, mutation) => {
    calls.push(structureDir)
    const next = await mutation(entries.map((entry) => ({ ...entry })))
    // `null` is "nothing changed" — no rewrite, and so no transition recorded.
    if (next === null) return entries.map((entry) => ({ ...entry }))
    const last = next[next.length - 1]
    if (last) transitions.push({ module: last.module, status: last.status })
    entries = dedupLearningEntries(next)
    return entries.map((entry) => ({ ...entry }))
  }

  return { mutate, entries: () => entries.map((entry) => ({ ...entry })), transitions, calls }
}
