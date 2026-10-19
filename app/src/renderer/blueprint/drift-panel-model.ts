// Pure model for the blueprint "Drift" panel. DOM-free and testable: given the
// snapshot's BlueprintDrift projection, it splits the changed nodes into an
// `external` (dominant — someone else changed it) group and a `selfAgent`
// (dimmed — your own / the agent's edits) group, buckets the system changes by
// fileClass. No IPC, no DOM. (The retired header button's label and unacked
// badge derivations left with the button — blueprint header cleanup.)

import type {
  BlueprintDrift,
  BlueprintDriftNode,
  BlueprintMustReviewItem,
  BlueprintSystemChange,
} from '../../shared/ipc-contract'

/** Deterministic display order for the system-change sub-sections. */
export const DRIFT_FILE_CLASS_ORDER: readonly BlueprintSystemChange['fileClass'][] = [
  'dependency',
  'schema',
  'config',
]

/** Human labels for each system-change bucket heading. */
export const DRIFT_FILE_CLASS_LABEL: Record<BlueprintSystemChange['fileClass'], string> = {
  dependency: 'Dependencies',
  schema: 'Schema',
  config: 'Config',
}

/** One system-change sub-section: a fileClass bucket and its changes (order preserved). */
export interface DriftSystemGroup {
  fileClass: BlueprintSystemChange['fileClass']
  label: string
  changes: BlueprintSystemChange[]
}

/** One map-structure change (drift OQ1): a graph-delta must-review item —
 *  "New external integration: Stripe", "Data store gained tables: orders". */
export interface DriftMapChange {
  title: string
  severity: BlueprintMustReviewItem['severity']
  /** The node the delta anchors to, when it resolves (click → focus it). */
  nodeId: string | null
}

/** The view model the drift panel renders — pre-split, pre-grouped, pre-counted. */
export interface DriftViewModel {
  /** External (someone else's) changes — the dominant group, incoming order preserved. */
  external: BlueprintDriftNode[]
  /** Your own + agent changes — the dimmed group, incoming order preserved. */
  selfAgent: BlueprintDriftNode[]
  /** System changes bucketed by fileClass (only non-empty buckets, deterministic order). */
  system: DriftSystemGroup[]
  /** Map-structure changes since the previous derive (graph-delta must-review
   *  items — the genuinely map-native "what appeared on your system" signals,
   *  absorbed here per the drift design's OQ1). Rounds/decision signals stay
   *  where the user acts on them; only graph-delta is surfaced. */
  mapChanges: DriftMapChange[]
  /** "…and N more" affordance when nodes were capped, else null. */
  overflowLabel: string | null
  /** True when there is anything to show (a node, a system change, or a map change). */
  hasEntries: boolean
}

/**
 * Project a BlueprintDrift into the panel view model. Backward compatible: an
 * undefined/empty drift yields an empty view (no groups, no badge, hasEntries
 * false) so the trigger/panel simply don't appear. Deterministic — incoming
 * node order is preserved (main already ranked by blast radius); system buckets
 * follow DRIFT_FILE_CLASS_ORDER.
 */
export function driftViewModel(
  drift: BlueprintDrift | null | undefined,
  mustReview: readonly BlueprintMustReviewItem[] = [],
): DriftViewModel {
  const nodes = drift?.nodes ?? []
  const systemChanges = drift?.system ?? []
  const overflow = drift?.overflow ?? 0
  // Absorb the map-native must-review signals (OQ1): graph deltas only —
  // new integrations / new-or-grown datastores vs the previous derive.
  const mapChanges: DriftMapChange[] = mustReview
    .filter((item) => item.source === 'graph-delta')
    .map((item) => ({ title: item.title, severity: item.severity, nodeId: item.nodeId ?? null }))

  const external = nodes.filter((n) => n.origin === 'external')
  const selfAgent = nodes.filter((n) => n.origin !== 'external')

  const system: DriftSystemGroup[] = []
  for (const fileClass of DRIFT_FILE_CLASS_ORDER) {
    const changes = systemChanges.filter((c) => c.fileClass === fileClass)
    if (changes.length > 0) {
      system.push({ fileClass, label: DRIFT_FILE_CLASS_LABEL[fileClass], changes })
    }
  }

  return {
    external,
    selfAgent,
    system,
    mapChanges,
    overflowLabel: overflow > 0 ? `…and ${overflow} more` : null,
    hasEntries: nodes.length > 0 || systemChanges.length > 0 || mapChanges.length > 0,
  }
}

