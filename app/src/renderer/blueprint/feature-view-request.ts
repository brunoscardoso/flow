/**
 * Generating a feature's curated view, from the board — PURE, no DOM, no IPC.
 *
 * THE GENERATOR HAD NO DOOR
 * =========================
 * `learn:generateFeatureView` existed end to end — contract, preload, main
 * handler, caged pass, validated write — and NOTHING in the renderer ever
 * called it. The six curated views that exist anywhere were written during the
 * plan execution that built the pass. Every other feature could only ever open
 * a DERIVED level: the code map's own wiring, drawn from directories, which the
 * level itself tells the reader is not what the feature does.
 *
 * So the reader was told "this is not the picture you want" and given no way to
 * get the picture they want. This module decides where that way appears.
 *
 * WHERE THE ACTION BELONGS — MOVED OUT
 * ===================================
 * `decideGenerateAction` used to live here. It is gone: "Draw this feature" and
 * "Learn this feature" were one act wearing two labels, and the single control
 * that replaced them is decided in `understand-action.ts`. What stays here is
 * the WIRE — the payload shape and the notification matcher — which is about
 * `learn:generateFeatureView` itself rather than about any button.
 *
 * WHY THE FAILURE MATCHER IS HERE TOO
 * ===================================
 * The pass is fire-and-forget. Success broadcasts `learn:featureViewed`;
 * failure broadcasts nothing but a toast. A running indicator with no failure
 * path is the SAME BUG as a button with no feedback, one layer up — it just
 * spins forever instead of doing nothing. So the toast is the second half of
 * the completion signal, and reading it is a decision, which means it is
 * tested here rather than asserted in a 14,000-line board.
 */

import {
  FEATURE_VIEW_DONE_TITLE,
  FEATURE_VIEW_FAILED_TITLE,
} from '../../shared/feature-view-notice'

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** The exact payload `learn:generateFeatureView` takes. */
export interface FeatureViewRequest {
  rootId: string
  featureRef: string
  featureName: string
  modulePaths: string[]
}

/**
 * Build the IPC payload.
 *
 * ⚠️ `rootId` CARRIES THE ROOT PATH, NOT THE PROJECT UUID. Every `learn:*`
 * channel works this way — the board sets `#activeRoot = rootPath`, main sends
 * `{ rootId: root.rootPath }` on `learn:basicDiscoveryAsk`, and `drawFeatureView`
 * feeds the value straight into `defaultEnumerateModuleEntries(rootPath, …)` and
 * `runFeatureViewPass({ rootPath })`. Passing a UUID does not error: it
 * enumerates a directory that does not exist, finds no files, and produces
 * nothing at all. That cost a live debugging session once; the parameter name
 * lies, so the check lives here where a test can hold it.
 *
 * Returns null when any part is missing, so a caller cannot dispatch half a
 * request.
 */
export function buildFeatureViewRequest(input: {
  rootPath: string | null
  featureRef: string | null
  featureName: string | null
  modulePaths: readonly string[]
}): FeatureViewRequest | null {
  const rootPath = clean(input.rootPath)
  const featureRef = clean(input.featureRef)
  const featureName = clean(input.featureName)
  if (rootPath === null || featureRef === null || featureName === null) return null
  return {
    // The PATH. See the warning above.
    rootId: rootPath,
    featureRef,
    featureName,
    modulePaths: [...input.modulePaths],
  }
}

/** What a `flow:notification` says about a drawing that was in flight. */
export type FeatureViewOutcome = { done: true } | { done: false; reason: string }

/**
 * Read a notification as the end of a drawing for `rootPath`, or null when it
 * is about something else entirely.
 *
 * Matching is by TITLE, against the constants main raises them with — not by
 * sniffing the body, which is prose and changes. The root must match too: two
 * projects can be open, and a failure in one must not stop the other's spinner.
 */
export function matchFeatureViewNotice(
  notice: { title?: unknown; body?: unknown; rootId?: unknown },
  rootPath: string | null,
): FeatureViewOutcome | null {
  const root = clean(rootPath)
  if (root === null) return null
  if (clean(notice.rootId as string | null) !== root) return null
  const title = clean(notice.title as string | null)
  if (title === FEATURE_VIEW_DONE_TITLE) return { done: true }
  if (title === FEATURE_VIEW_FAILED_TITLE) {
    return { done: false, reason: clean(notice.body as string | null) ?? 'unknown reason' }
  }
  return null
}
