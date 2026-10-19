// The one CLI limit the app has to know about a hunt's text.
//
// A MIRRORED CONSTANT, and it is deliberately alone in its own file so the
// mirroring is visible rather than buried: `MAX_FOCUS_LENGTH` in
// src/cli/loop/types.ts is 200, and `normalizeFocus` REFUSES over it rather than
// truncating ("half a sentence is a different instruction from the one that was
// typed"). The app cannot import the CLI's module — different build, different
// module system — so the number is copied, named after the thing it bounds, and
// checked before a spawn instead of after a refusal.
//
// If the CLI's limit ever moves, the consequence here is bounded and visible: a
// control refuses a sentence the CLI would have accepted, or offers one it will
// refuse with its own one-line reason. Neither writes anything.

/** `MAX_FOCUS_LENGTH` in src/cli/loop/types.ts — a `--focus` over this refuses. */
export const MAX_HUNT_TEXT_LENGTH = 200

/**
 * `DEFAULT_INSTRUCTION_CAP` in src/cli/loop/instructions.ts — the guard rail a
 * hunt gets when nobody names one.
 *
 * MIRRORED FOR THE SAME REASON AND WITH THE SAME BOUNDED CONSEQUENCE: it is what
 * the Loops screen prefills into the "stop after" box for a producer with no
 * standing hunt yet, so a person who never touches that box asks for exactly
 * what the CLI would have chosen for them. If the CLI's default ever moves, the
 * box offers the old number until this line follows it — visible, and never a
 * write nobody asked for.
 */
export const DEFAULT_HUNT_CAP = 20

/**
 * `MAX_INSTRUCTION_STOP_RULE_LENGTH` in src/cli/loop/instructions.ts — the
 * longest a CUSTOM stop rule may be.
 *
 * Mirrored on the same terms as the two above. Longer than the focus limit on
 * purpose: a focus is what to look FOR and a stop rule is when to STOP, and the
 * second is a condition ("if the same bug appears in a second place, and the
 * first one is already filed, stop") which does not fit in a title's worth.
 */
export const MAX_HUNT_RULE_LENGTH = 400

/**
 * The hour choices offered for a time-bounded hunt — `INSTRUCTION_STOP_HOURS`
 * in src/cli/loop/instructions.ts.
 *
 * A LIST, NOT A RANGE, and the reason is the decision it stands for: how long
 * to leave an agent working unattended. A free number box invites `0.25` and
 * `720`, neither of which is a thing anybody means.
 */
export const HUNT_STOP_HOURS = [1, 2, 3, 4, 8, 12, 24] as const
