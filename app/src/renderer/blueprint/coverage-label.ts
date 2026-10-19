// Pure blueprint coverage-label decision (blueprint-connections). Kept DOM-free
// so it's testable under the node-env jest that can't import the DOM-coupled
// blueprint view (extract-pure-logic pattern, like graphify-status.ts).
import type { BlueprintCoverage } from '../../shared/ipc-contract'

/** State of the graph's usage edges, in ascending trust/completeness. */
export type UsageEdgeState = 'native-only' | 'building' | 'enriched'

/** An honest, structured coverage signal for the board banner/meta line. */
export interface BlueprintCoverageLabel {
  /** Native structural parse coverage as a whole-number percent (0–100). */
  percent: number
  /** Where the usage edges came from this derive. */
  usageState: UsageEdgeState
  /** Human-facing one-liner, e.g. "code graph: 82% parsed · usage edges: native-only". */
  text: string
}

/**
 * Turn a derive's coverage into an honest label — replacing the vague
 * "Structure limited" with a truthful two-part signal: how much of the repo
 * the native pass actually parsed (`filesScanned/filesTotal`), and where the
 * usage edges came from.
 *
 * Usage-edge state (trust order):
 *   - `enriched`    — graphify enriched this derive (`calls` + `imports`)
 *   - `building`    — graphify's code graph is still building (native-only for now)
 *   - `native-only` — native import edges only (graphify absent or its build failed)
 *
 * Deterministic and defensive: a missing/zero `filesTotal` yields 0% (never
 * NaN/Infinity), and `filesScanned` is clamped to `filesTotal` so a stale
 * count can't report >100%.
 */
export function blueprintCoverageLabel(
  coverage: Pick<BlueprintCoverage, 'filesScanned' | 'filesTotal' | 'graphifyEnriched' | 'graphifyBuild'>,
): BlueprintCoverageLabel {
  const total = coverage.filesTotal > 0 ? coverage.filesTotal : 0
  const scanned = Math.max(0, Math.min(coverage.filesScanned, total))
  const percent = total > 0 ? Math.round((scanned / total) * 100) : 0

  const usageState: UsageEdgeState = coverage.graphifyEnriched
    ? 'enriched'
    : coverage.graphifyBuild === 'building'
      ? 'building'
      : 'native-only'

  return {
    percent,
    usageState,
    text: `code graph: ${percent}% parsed · usage edges: ${usageState}`,
  }
}
