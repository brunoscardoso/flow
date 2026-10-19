/**
 * The plan's heading grammar, shared by the plan parser and the change-note
 * parser so both agree on where a phase starts (allowed-pattern #14). Kept in
 * its own module because the plan parser calls the note parser — importing
 * these from `plan-parser.ts` would be a cycle.
 */

// Accept a colon OR a dash (-, en-dash, em-dash) as the phase-header separator —
// plans in the wild are authored with `### Phase 1 — Title`, not only `Phase 1:`.
export const PHASE_HEADER_RE = /^### Phase (\d+)\s*[:—–-]\s*(.+)$/;

/**
 * A line that LOOKS like a phase heading, whether or not the parser can read it.
 *
 * The two are different questions, and conflating them is what made a decimal
 * heading dangerous (#1847). `### Phase 3.5 — The address gate` does not match
 * the header above — `(\d+)` takes the `3` and the separator class cannot then
 * match the `.` — so it was not a heading. It was not SKIPPED either: it fell
 * through to the body handlers of the phase above it, and so did everything
 * under it until the next real heading. That phase silently absorbed the
 * decimal phase's tasks, its complexity and its dependencies.
 *
 * In `plan_thread-worktrees_v1.md` the absorbed line was
 * `**Dependencies**: Phase 3`, landing on Phase 3 itself and overwriting its
 * real `Phase 2` — so Phase 3 depended on ITSELF, a cycle, and
 * `compileRunScript` refused the whole plan for a reason with no visible cause
 * in the document. The damage lands on a phase that is written correctly.
 */
export const HEADING_SHAPED_RE = /^#{1,6} +Phase\b/;
