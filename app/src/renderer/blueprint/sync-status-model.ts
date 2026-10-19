// Pure model for the blueprint "Sync status" dashboard. DOM-free and testable:
// given the parts of a BlueprintSnapshot that carry staleness, it computes one
// combined summary — stale annotations (per file), module learning-state, and
// graph freshness — that the panel view renders. No IPC, no DOM.

import type {
  BlueprintAnnotation,
  BlueprintLearningEntry,
  BlueprintTierSummary,
  GraphifyBuildState,
} from '../../shared/ipc-contract'

/** A file with one or more STALE annotations (its anchored code drifted). */
export interface StaleAnnotationFile {
  file: string
  count: number
}

export interface SyncStatusSummary {
  annotations: {
    total: number
    stale: number
    /** Files carrying stale annotations, most-stale first (then alphabetical). */
    staleFiles: StaleAnnotationFile[]
  }
  modules: {
    total: number
    learned: number
    learning: number
    queued: number
    stale: number
    /** Module ids whose learning-state is `stale` (code drifted since learned). */
    staleModules: string[]
  }
  graph: {
    /** graph.json mtime (ms since epoch), or null when the graph is missing. */
    mtime: number | null
    /** First-build lifecycle when there is no graph yet, else undefined. */
    building?: GraphifyBuildState
  }
  /** True when ANYTHING is out of sync — drives the button's warning dot. */
  outOfSync: boolean
}

export interface SyncStatusInput {
  annotations: readonly BlueprintAnnotation[]
  /** undefined when the learning store is missing/empty. */
  learning?: readonly BlueprintLearningEntry[]
  /** graph.json mtime, ms since epoch — null when the graph is missing. */
  mtime: number | null
  /** coverage.graphifyBuild — the first-build lifecycle, absent once a graph exists. */
  graphifyBuild?: GraphifyBuildState
}

/**
 * One-line claim-doc tallies for the Sync section's Docs row (trust-tiers
 * Phase 4), e.g. `14 docs · 9 verified · 3 contradicted · 2 unverified`.
 * Vocabulary mapping: verified = corroborated; unverified = unadjudicated +
 * unverifiable (both mean "no standing verification"). The docs count always
 * leads; the verdict parts appear only when non-zero. Returns null when the
 * summary is absent or there are no claim docs at all — the row is then
 * withheld entirely (no empty-state claim).
 */
export function tierTalliesLine(tiers: BlueprintTierSummary | undefined): string | null {
  if (tiers === undefined || tiers.claimTotal === 0) {
    return null
  }
  const parts = [`${tiers.claimTotal} doc${tiers.claimTotal === 1 ? '' : 's'}`]
  if (tiers.corroborated > 0) parts.push(`${tiers.corroborated} verified`)
  if (tiers.contradicted > 0) parts.push(`${tiers.contradicted} contradicted`)
  const unverified = tiers.unadjudicated + tiers.unverifiable
  if (unverified > 0) parts.push(`${unverified} unverified`)
  return parts.join(' · ')
}

/** Aggregate the snapshot's staleness signals into one dashboard summary. */
export function computeSyncStatus(input: SyncStatusInput): SyncStatusSummary {
  const annotations = input.annotations ?? []
  const stale = annotations.filter((a) => a.status === 'stale')

  // Group stale annotations by anchored file (an annotation can anchor several).
  const perFile = new Map<string, number>()
  for (const annotation of stale) {
    for (const anchor of annotation.anchors) {
      if (!anchor.file) continue
      perFile.set(anchor.file, (perFile.get(anchor.file) ?? 0) + 1)
    }
  }
  const staleFiles: StaleAnnotationFile[] = [...perFile.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))

  const learning = input.learning ?? []
  const byStatus = { learned: 0, learning: 0, queued: 0, stale: 0 }
  const staleModules: string[] = []
  for (const entry of learning) {
    byStatus[entry.status] += 1
    if (entry.status === 'stale') staleModules.push(entry.module)
  }
  staleModules.sort((a, b) => a.localeCompare(b))

  const buildFailedOrRunning =
    input.graphifyBuild === 'building' || input.graphifyBuild === 'failed'
  const outOfSync = stale.length > 0 || byStatus.stale > 0 || buildFailedOrRunning

  return {
    annotations: { total: annotations.length, stale: stale.length, staleFiles },
    modules: {
      total: learning.length,
      learned: byStatus.learned,
      learning: byStatus.learning,
      queued: byStatus.queued,
      stale: byStatus.stale,
      staleModules,
    },
    graph: { mtime: input.mtime, building: input.graphifyBuild },
    outOfSync,
  }
}
