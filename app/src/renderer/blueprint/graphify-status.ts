// Pure blueprint status-label decision (#142). Kept DOM-free so it's testable
// under the node-env jest that can't import the DOM-coupled blueprint view.
import type { BlueprintCoverage } from '../../shared/ipc-contract'

/**
 * The honest graphify segment of the board's coverage line.
 *
 * The label used to read `graphify on/off` off `coverage.graphifyEnriched`
 * alone — but "off" conflated two very different states: graphify genuinely
 * disabled vs. a derive that simply ran native-only (graphify absent this run).
 * With graphify always-on (#142), a non-enriched derive means graphify wasn't
 * available for it, so the honest wording is **"native only"**, never a
 * misleading "off." Enriched derives read **"graphify on."**
 */
export function graphifyStatusLabel(coverage: Pick<BlueprintCoverage, 'graphifyEnriched'>): string {
  return coverage.graphifyEnriched ? 'graphify on' : 'native only'
}

/** A degraded-structure banner the board shows above the graph (#535). */
export interface BlueprintDegradedBanner {
  /** User-facing message. */
  text: string
  /** Whether to offer a retry affordance (a failed build the user can re-run). */
  retry: boolean
}

/**
 * How long a `'building'` state may persist before the board stops trusting it
 * and offers a retry. Mirrors the CLI's `GRAPHIFY_BUILD_MARKER_TTL_MS`
 * (src/cli/blueprint/graphify-enrich.ts) — past this age the background job is
 * presumed dead, not slow.
 */
export const GRAPHIFY_BUILD_STALE_MS = 15 * 60 * 1000

/**
 * Decide the degraded-structure banner from a derive's coverage (#535).
 *
 * A large non-TS repo's first graphify build runs for minutes in the background;
 * until it lands, the board would otherwise show a near-empty native-only sheet
 * with no explanation. This turns the silent gap into an honest banner:
 *   - `'building'` → "structure limited — code graph building…" (no retry; it's running)
 *   - `'failed'`   → "…code graph build didn't finish" + retry (the user re-runs it)
 *
 * Two silent-degradation holes this also closes (orbit-app, 2026-07-20):
 *
 * 1. `graphifyEnriched: false` with NO `graphifyBuild` state rendered a
 *    native-only graph — no `imports`/`calls` edges, so NO connection lines —
 *    with full confidence and no banner at all. A derive that found no graphify
 *    graph and launched no build must still say so.
 * 2. A `'building'` state could stick forever. The banner assumed the graph.json
 *    watcher would fire when the build landed; when the build wrote somewhere
 *    the watcher wasn't looking, the board sat on "building…" for 3 days with
 *    nothing clickable. Past `GRAPHIFY_BUILD_STALE_MS` the build is presumed
 *    dead and retry is offered.
 *
 * `derivedAt`/`now` are optional — omit them and a `'building'` state is always
 * treated as live (the prior behavior). Pure/DOM-free.
 */
/** Edge relations that draw as connection wires / feed the Used-by/Uses panel.
 *  Native extractors emit these too (#727 phase-1.task-3) — presence of any
 *  means the board's connections genuinely work without graphify. */
const USAGE_EDGE_RELATIONS = new Set(['imports', 'uses', 'exposes', 'calls'])

/** Whether a graph's edges include any drawable usage/connection edge. */
export function hasUsageEdges(edges: ReadonlyArray<{ relation: string }>): boolean {
  return edges.some((edge) => USAGE_EDGE_RELATIONS.has(edge.relation))
}

export function blueprintDegradedBanner(
  coverage: Partial<Pick<BlueprintCoverage, 'graphifyBuild' | 'graphifyEnriched'>>,
  derivedAt?: string,
  now: number = Date.now(),
  /** Whether the graph carries drawable connection edges (native or enriched).
   *  Defaults to false — callers without a graph keep the prior behavior. */
  graphHasUsageEdges = false,
): BlueprintDegradedBanner | null {
  if (coverage.graphifyBuild === 'building') {
    const startedAt = derivedAt === undefined ? Number.NaN : Date.parse(derivedAt)
    // An unparseable/absent derivedAt can't prove staleness — treat as live.
    const stale = Number.isFinite(startedAt) && now - startedAt > GRAPHIFY_BUILD_STALE_MS
    return stale
      ? { text: 'Structure limited — code graph build stalled.', retry: true }
      : { text: 'Structure limited — building code graph…', retry: false }
  }
  if (coverage.graphifyBuild === 'failed') {
    return { text: 'Structure limited — code graph build didn’t finish.', retry: true }
  }
  if (coverage.graphifyEnriched === false) {
    // Native-only derives DO emit imports/uses/exposes edges (#727) — when those
    // exist the board's wires and connections panel work, so a "connections not
    // shown" banner would contradict what the user sees (#729). Only a graph
    // with genuinely nothing to draw earns the degraded banner.
    if (graphHasUsageEdges) {
      return null
    }
    return { text: 'Structure limited — no code graph, connections not shown.', retry: true }
  }
  return null
}
