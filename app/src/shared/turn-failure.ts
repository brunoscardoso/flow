/**
 * Turn-failure notes — the durable trace of a failed agent turn (#1048).
 *
 * Failures used to be emitted on the ephemeral `threads:stream` channel only:
 * a turn that died while the user was reading a different thread left NO trace
 * (the pane drops wrong-thread events, and `#loadHistory` rebuilds from
 * persisted rows). Main now persists the failure text as a `system` message
 * row at failure time — stream-bridge's failed-result path and agent-manager's
 * session-error path — and the renderer's history builder recognizes those
 * rows by prefix, rendering them as the same error card the live stream path
 * shows.
 *
 * Writer (main) and reader (renderer) share this ONE classification so the
 * two can never drift. A deliberate interrupt (#981) persists its calm
 * "Interrupted by you" note, which is NOT a failure note and stays a plain
 * system line.
 */

/** Prefix of a failed turn result (stream-bridge `handleResult`). */
export const TURN_FAILURE_PREFIX = 'Agent turn failed:'

/** Prefix of a crashed/failed session (agent-manager `markThreadFailed`). */
export const SESSION_FAILURE_PREFIX = 'Agent session error:'

/** True when a persisted system row is a failure note that must render as an
 *  error card rather than a calm system note. */
export function isTurnFailureNote(content: string): boolean {
  return (
    content.startsWith(TURN_FAILURE_PREFIX) || content.startsWith(SESSION_FAILURE_PREFIX)
  )
}

/**
 * The SDK's own internal diagnostics, which are not sentences.
 *
 * `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`
 * is the runtime talking to its own authors: a key-value dump whose fields name
 * the SDK's internals, and whose `stop_reason=tool_use` is a perfectly ORDINARY
 * mid-turn stop. Put in front of a person under the words "Agent turn failed",
 * it says something went wrong and offers nothing to do about it — reported
 * 2026-09-09 as "don't show that error anymore".
 *
 * Matched by SHAPE, not by a list of known strings: anything bracketed-tag +
 * `key=value` pairs is a diagnostic, so a renamed tag or a new field does not
 * quietly start leaking again.
 */
const SDK_DIAGNOSTIC = /^\[[a-z0-9_]+\]\s*(?:[a-z0-9_]+=\S*\s*)+$/i

/** What a person is told a turn failed FOR, or null when there is nothing
 *  honest to say beyond "it failed". */
export function turnFailureDetail(raw: string | null | undefined): string | null {
  const detail = raw?.trim() ?? ''
  if (detail === '') return null
  // A diagnostic is not an explanation. It still reaches the log (the caller
  // writes it there) — it just stops being the thing on screen.
  if (SDK_DIAGNOSTIC.test(detail)) return null
  return detail
}

/**
 * The note persisted and shown for a failed turn.
 *
 * WITH a real reason: `Agent turn failed: <reason>` — unchanged, because a
 * reason a person can act on is the whole value of the card.
 *
 * WITHOUT one: a sentence that says what is true and what to do, rather than
 * the runtime's internal spelling. The turn is over, nothing was lost, and
 * sending again is the actual remedy.
 */
export function turnFailureNote(raw: string | null | undefined): string {
  const detail = turnFailureDetail(raw)
  return detail === null
    ? `${TURN_FAILURE_PREFIX} the agent stopped before finishing. Nothing was lost — send again to pick it up.`
    : `${TURN_FAILURE_PREFIX} ${detail}`
}
