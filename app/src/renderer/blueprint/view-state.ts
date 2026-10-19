/**
 * Blueprint view pane state — the pure decision of WHAT the view shows for a
 * given (root, graph, derive) situation, kept DOM-free so the transitions
 * are unit-testable (blueprint-board.ts renders whatever this resolves).
 *
 * The auto-derive contract: a missing graph triggers ONE under-the-hood
 * derive per root ('auto-derive' pane — the view starts the derive and
 * shows the deriving state). If the full derive cannot produce a graph, the
 * view falls back to the BASIC board ('basic' pane — the in-memory graph
 * main derives itself, with a banner + retry). Only when even the basic
 * derivation found zero nodes does the view settle on the calm 'failed'
 * pane (Retry button) instead of looping.
 */

import type { ProvisioningState } from '../../shared/ipc-contract'

export type DeriveState = 'idle' | 'running' | 'failed'

export type BlueprintPane =
  /** No active project — nothing to show or derive. */
  | 'no-project'
  /** The active root is being provisioned (#513 phase 2) — a calm "setting up
   *  plan-flow…" wait state, shown until it reaches ready/failed. Gates the
   *  board because a derive against a half-provisioned root is meaningless. */
  | 'provisioning'
  /** Full graph present — render the node board. */
  | 'board'
  /** No full graph, but the basic fallback exists — board + fallback banner. */
  | 'basic'
  /** The snapshot read for a freshly-opened/switched root is in flight —
   *  'Loading blueprint…' (user call 2026-07-27: no indicator while loading,
   *  and the PREVIOUS project's map must never linger). */
  | 'loading'
  /** A derive is running — 'Deriving blueprint…' progress state. */
  | 'deriving'
  /** Graph missing, no attempt spent yet — start a derive, show progress. */
  | 'auto-derive'
  /** Derive failed AND even the basic fallback is empty — message + Retry. */
  | 'failed'
  /**
   * No graph of any kind, but the project HAS features — draw them (#1436).
   *
   * The feature board and the code map are two different data sources that
   * happen to share a screen: the feature graph is `readFeatures` +
   * `readModuleLearning` + `computeFeatureLimitations`, and it never opens
   * `graph.json`. Gating it on the derive meant an unwritable `.structure/` or
   * a crashed extractor took out the DEFAULT view of a project whose knowledge
   * store was perfectly intact — and said nothing about the features it was
   * hiding.
   *
   * The code map keeps its own gate, because it genuinely needs the graph. A
   * feature's derived LEVEL degrades to its empty state here, which is a much
   * smaller loss than showing nothing and already explains itself.
   */
  | 'features'

export interface PaneInput {
  hasRoot: boolean
  hasGraph: boolean
  /** True while the root's snapshot read is in flight (no graph yet). */
  readPending?: boolean
  /** True when the in-memory basic fallback graph is available. */
  hasBasicGraph: boolean
  deriveState: DeriveState
  /** True once this root's one automatic derive has already been triggered. */
  autoDeriveSpent: boolean
  /** The active root's provisioning readiness (#513 phase 2). `provisioning`
   *  gates the board with a wait pane; every other value (including absent =
   *  legacy/never-seeded) leaves the derive lifecycle untouched. */
  provisioningState?: ProvisioningState
  /**
   * True when the project has features on disk. Lets the board fall back to
   * drawing them instead of refusing everything when no graph can be produced
   * (#1436). Absent reads as false, so a caller that does not know keeps the
   * old behaviour.
   */
  hasFeatures?: boolean
  /**
   * True while the FEATURE GRAPH fetch is in flight.
   *
   * A separate wait from `readPending`, because they are separate requests and
   * only the first one had a pane. The snapshot read finishes, the loader goes
   * away, and the feature query is still running — during which `hasFeatures`
   * is false because nothing has arrived yet, and the board resolved that as
   * the FAILURE pane on any open after the first (auto-derive already spent).
   * The default sheet appearing to fail on its way in is what a reader saw as
   * "no loader".
   *
   * Absent reads as false, so a caller that does not track it keeps the old
   * behaviour.
   */
  featuresPending?: boolean
}

/**
 * True when a derive error means the `planflow-ai` CLI itself is missing (a
 * spawn miss / "not found"), as opposed to the CLI running and failing. The
 * view uses this to guide installation instead of showing a generic failure —
 * the rich blueprint (and the discovery/planning proposals) all need the CLI.
 */
export function isCliUnavailable(error: string | null | undefined): boolean {
  if (!error) return false
  return /not found|ENOENT|no usable CLI|command not found|not recognized/i.test(error)
}

/**
 * Whether an Escape keydown should zoom the board out one layer. The handler is
 * a GLOBAL document listener, but the editor keeps the blueprint element mounted
 * (`display:none`) when another tab is active or after the tab is closed — so a
 * mere `isConnected` guard always passed and Escape mutated the hidden board's
 * layer stack from anywhere in the app (#221). Gate on actual visibility AND
 * having depth to pop. `visible` is supplied by the DOM (`offsetParent !== null`).
 */
export function shouldZoomOutOnEscape(key: string, visible: boolean, stackDepth: number): boolean {
  return key === 'Escape' && visible && stackDepth > 1
}

/**
 * The header's primary CTA + Refresh state for a pane (#449). In the no-project
 * empty state a derive is impossible, so the loud primary button and Refresh
 * were dead clicks — clicking did nothing, no feedback. The primary CTA is an
 * honest "Open Project…" (mirroring the Files panel's empty-state affordance)
 * and Refresh is hidden.
 *
 * THE "New Blueprint" CTA IS GONE. It read as "create a new blueprint" while
 * its handler was plain `derive()` — the same call as Refresh, and the same
 * call the board already makes ITSELF via the one-shot `auto-derive` pane
 * whenever a project has no graph. So on the empty board it advertised, loudly,
 * work that was already underway. Derive stays reachable where it means
 * something: the auto-derive, the retry on a failed pane, and Recheck inside
 * the Learning panel.
 *
 * ITS SLOT NOW OPENS THE LEARNING PANEL. That panel was reachable only through
 * the learn chip, which hides itself when there is nothing learned yet
 * (`progress.total === 0`) — precisely the empty state where a user most wants
 * to see whether learning is happening at all. A permanent button removes that
 * catch-22.
 */
export interface HeaderActions {
  /** Primary button caption (only meaningful when `showPrimary`). */
  primaryLabel: string
  /** What a primary-button click does. */
  primaryAction: 'open-project'
  /** Primary button style — loud unless a full board already shows. */
  primaryVariant: 'primary' | 'ghost'
  /** Whether the primary CTA is shown at all. */
  showPrimary: boolean
  /** Whether the Learning button is shown (learning needs a project). */
  showLearning: boolean
}

// #711 note: HeaderActions used to gate a dedicated "Sync status" header button
// (showSync). That surface folded into the Learning panel — reached via the
// learn chip, which is hidden whenever there is no project/graph — so the
// no-project honesty (#449/#676 class) now holds by construction.
export function resolveHeaderActions(pane: BlueprintPane): HeaderActions {
  if (pane === 'no-project') {
    return {
      primaryLabel: 'Open Project…',
      primaryAction: 'open-project',
      primaryVariant: 'primary',
      showPrimary: true,
      // Nothing to learn without a project.
      showLearning: false,
    }
  }
  if (pane === 'provisioning') {
    // Mid-provision nothing is actionable yet: assets aren't in place, so a
    // derive is meaningless and there is no learning state to show. The header
    // signals "wait" rather than offering dead actions.
    return {
      primaryLabel: 'Open Project…',
      primaryAction: 'open-project',
      primaryVariant: 'ghost',
      showPrimary: false,
      showLearning: false,
    }
  }
  return {
    primaryLabel: 'Open Project…',
    primaryAction: 'open-project',
    primaryVariant: 'ghost',
    showPrimary: false,
    // Every pane with a project: the panel must be reachable even when the
    // learn chip has nothing to report.
    showLearning: true,
  }
}

export function resolvePane(input: PaneInput): BlueprintPane {
  if (!input.hasRoot) {
    return 'no-project'
  }
  // Gate the whole derive lifecycle while the root is still being set up (#513
  // phase 2): a derive against a half-provisioned project is meaningless, so
  // show the calm "setting up…" wait pane until it settles ready/failed. Any
  // other provisioning value (ready/idle/failed/absent) falls through to the
  // normal graph/derive resolution below — a failed provision still lets the
  // user try (and hit the derive's own CLI-missing guidance).
  if (input.provisioningState === 'provisioning') {
    return 'provisioning'
  }
  if (input.hasGraph) {
    return 'board'
  }
  // The basic board keeps showing through a running retry-full-derive (its
  // banner button goes busy) and after a failed one — never a dead end.
  if (input.hasBasicGraph) {
    return 'basic'
  }
  if (input.readPending === true) {
    return 'loading'
  }
  // THE FEATURES ARE THE DEFAULT SHEET, so fetching them is a wait like any
  // other and gets the same pane. Guarded on `hasFeatures` so a REFRESH never
  // flashes: a board that already has features keeps drawing them while the
  // new ones are fetched, which is the same rule `#loadFeatureGraph` follows by
  // replacing rather than nulling first.
  if (input.featuresPending === true && input.hasFeatures !== true) {
    return 'loading'
  }
  if (input.deriveState === 'running') {
    return 'deriving'
  }
  // FEATURES BEFORE FAILURE, and only here: every branch above is either a
  // real graph (which the code map needs) or a lifecycle state that has not
  // finished yet. This is the point where the old code gave up, and it is the
  // only point where "there is still something worth drawing" is new
  // information.
  if (input.deriveState === 'failed') {
    return input.hasFeatures === true ? 'features' : 'failed'
  }
  if (input.autoDeriveSpent) {
    return input.hasFeatures === true ? 'features' : 'failed'
  }
  return 'auto-derive'
}
