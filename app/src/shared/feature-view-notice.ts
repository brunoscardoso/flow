/**
 * The two titles `drawFeatureView` puts on its toasts — shared, because the
 * BOARD reads them back.
 *
 * The curated-view pass is fire-and-forget over `learn:generateFeatureView`:
 * main runs a long caged session and reports the outcome as an ordinary
 * notification. Success also broadcasts `learn:featureViewed`, but FAILURE has
 * no event of its own — the toast is the whole signal.
 *
 * A board that shows "drawing…" therefore has exactly one way to learn that the
 * drawing stopped, and matching the toast's title by hand in the renderer would
 * be a string literal in two processes that can silently drift apart. These
 * constants are that coupling, made typed and greppable instead.
 */

/** Title of the toast a finished (successful) drawing raises. */
export const FEATURE_VIEW_DONE_TITLE = 'Feature view'

/** Title of the toast every failing branch of the drawing raises. */
export const FEATURE_VIEW_FAILED_TITLE = 'Feature view failed'

/**
 * Title for a mid-pass NOTE — something the user must be told while the drawing
 * is still running (today: no resolvable credentials, falling back to the
 * ambient login).
 *
 * It must be distinct from both titles above, because those two END the board's
 * running state. A note that borrowed the success title would wipe the spinner
 * while the pass was still going, and the reader would be told it finished
 * before it started.
 */
export const FEATURE_VIEW_NOTE_TITLE = 'Feature view · heads up'
