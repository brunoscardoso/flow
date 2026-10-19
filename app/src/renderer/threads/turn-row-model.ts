/**
 * The turn row's one decidable rule, kept DOM-free.
 *
 * The row itself (`turn-row.ts`) builds elements, and the app's jest runs under
 * `testEnvironment: 'node'` with no DOM lib — a test that imported the view
 * would not compile, let alone run. So the rule that decides which words wear
 * the error tint lives here, on the same terms `tool-group-model.ts` is
 * separated from `tool-group-card.ts`.
 *
 * That separation is not bookkeeping in this case. Letting failures fold behind
 * a summary row is the risky half of this design — the screenshot that started
 * it is five failed commits going unnoticed inside a wall of successes (R-1) —
 * and "the failure is visible on the row's face" has to be an assertion, not a
 * claim about a constructor nobody can run.
 */
import type { TurnSummary } from './turn-summary'
import { turnSummaryLabel } from './turn-summary'

/** One piece of the summary line, with whether it is the failure fact. */
export interface TurnRowSegment {
  text: string
  /** True for the `N failed` segment — the only one that carries the error tint. */
  failed: boolean
}

/**
 * Split a turn's summary line into its rendered segments.
 *
 * The label is taken WHOLE from `turnSummaryLabel` rather than rebuilt from the
 * counts — one place decides what a turn's row says, including which segments
 * are omitted when zero — and split back on the middle dot it joined with. The
 * failure segment is identified by VALUE (`${summary.failed} failed`), never by
 * position or by a suffix match, so a segment added later that happens to end
 * in the same word could not accidentally inherit the error tint.
 *
 * A turn with no tool calls yields an empty label and therefore no segments;
 * the caller renders no row at all rather than an empty one.
 */
export function turnRowSegments(summary: TurnSummary): TurnRowSegment[] {
  const label = turnSummaryLabel(summary)
  if (label === '') return []
  const failedSegment = summary.failed > 0 ? summary.failed + ' failed' : null
  return label
    .split(String.fromCharCode(183))
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((text) => ({ text, failed: text === failedSegment }))
}
