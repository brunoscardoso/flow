// Failure feedback for the inline AskUserQuestion card (#278). QuestionCard.#submit
// used to set terminal UI state ("Answered", disabled, #done=true) BEFORE awaiting
// threads:respondDialog and never caught a rejection — so a failed submit (main-process
// error, torn-down session, IPC failure) left the card lying "Answered" while the agent
// stayed parked forever with no user feedback, violating the module's "a question is
// NEVER dropped" invariant and forbidden-pattern #2. The card now mirrors PermissionCard:
// it rolls back to the interactive state and shows this inline error so the user can retry.
// The message is the DOM-free decision; the card owns the DOM (it imports '../components',
// so it can't load under the node jest env — this pure helper is what gets unit-tested).
import { errorText } from './redo-feedback'

/** The exact text the threads:respondDialog main handler throws when the dialog
 *  was disposed by a crashed/ended session (#290). Electron wraps a thrown error
 *  ("Error invoking remote method … Error: <msg>"), so classification substring-matches. */
export const SESSION_GONE_SENTINEL = 'the agent session is no longer active'

/**
 * Terminal failure: the agent session that asked the question is gone, so the
 * answer can NEVER be delivered — retrying is futile (#301). Distinguished from a
 * transient IPC failure so the card shows terminal copy + a Dismiss, not "Try again".
 */
export class SessionGoneError extends Error {
  constructor() {
    super(SESSION_GONE_SENTINEL)
    this.name = 'SessionGoneError'
  }
}

/** True when a respondDialog rejection is the terminal "session gone" case (#301). */
export function isSessionGone(error: unknown): boolean {
  return error instanceof Error && error.message.includes(SESSION_GONE_SENTINEL)
}

/** Inline "Failed to send" line shown on the card after a TRANSIENT rejected submit. */
export function submitFailureMessage(error: unknown): string {
  return `Failed to send — ${errorText(error)}. Try again.`
}

/** Terminal copy for an unrecoverable session-gone failure — no "Try again" (#301). */
export function sessionGoneMessage(): string {
  return 'This session ended — the question can no longer be answered.'
}
