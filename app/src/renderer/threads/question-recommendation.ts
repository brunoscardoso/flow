/**
 * Recommendation marker parsing for AskUserQuestion options.
 *
 * The tool has no structured "recommended" field — the convention is that the
 * agent appends a literal `(Recommended)` to the option's label. Rendered
 * verbatim that reads as noise inside the label line (or is missed entirely),
 * so the card strips the marker and renders it as its own badge.
 *
 * Two rules follow from that and are load-bearing:
 *
 * 1. The ORIGINAL label is what gets submitted back. The agent matches answers
 *    against the options it sent, markers included — stripping is a display
 *    concern only, and `question-card` keeps passing `option.label` untouched.
 * 2. The stripped label is what `.fl-qcard-option-label` shows, so that node's
 *    textContent stays equal to the user-visible choice (the e2e selection
 *    assertions read exactly that).
 *
 * Pure and DOM-free so it runs under the app's node-env ts-jest.
 */

/** One option label, split into what to show and whether it carries the marker. */
export interface ParsedOptionLabel {
  /** The label with the recommendation marker removed. */
  label: string
  /** True when the agent marked this option as its recommendation. */
  recommended: boolean
}

/**
 * A trailing recommendation marker: `(Recommended)` or `[Recommended]`, with
 * any separator the agent may have used before it (space, dash, en/em dash).
 * Case-insensitive — agents write `(recommended)` too.
 */
const TRAILING_MARKER = /[\s–—-]*[([]\s*recommended\s*[)\]]\s*$/i

/** The same marker written as a prefix — accepted because agents do write it. */
const LEADING_MARKER = /^\s*[([]\s*recommended\s*[)\]][\s–—-]*/i

/**
 * Split an option label into its display text and its recommended flag.
 *
 * A label consisting of NOTHING but the marker is left intact and unflagged:
 * there is no choice left to recommend, and a badge floating beside an empty
 * label reads as a rendering bug rather than as information.
 */
export function parseOptionLabel(label: string): ParsedOptionLabel {
  for (const marker of [TRAILING_MARKER, LEADING_MARKER]) {
    if (!marker.test(label)) continue
    const stripped = label.replace(marker, '').trim()
    if (stripped.length === 0) break
    return { label: stripped, recommended: true }
  }
  return { label: label.trim(), recommended: false }
}
