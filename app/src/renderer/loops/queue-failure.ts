/**
 * What to SAY, and what to OFFER, when a loop's list could not be read.
 *
 * ONE PLACE FOR BOTH SURFACES. The tasks board and the loops panel each render
 * the same failure off the same snapshot field, and each used to relay the
 * CLI's prose. gh's own diagnosis is "gh issue list failed for owner/name: To
 * get started with GitHub CLI, please run: gh auth login" — right in a
 * terminal, and in a window it hands the reader a command they cannot press
 * (forbidden-pattern #12). Reported from the loops panel exactly that way.
 *
 * Keyed off the CLI's CLASSIFICATION (`queueErrorKind`), never its wording, so
 * a reworded diagnosis cannot change which sentence appears — and so the one
 * failure with a remedy can be told apart from the ones without.
 */

/** The queue failures the CLI can name — mirrors the IPC contract's union. */
export type QueueFailureKind =
  | 'not-installed'
  | 'signed-out'
  | 'bad-credentials'
  | 'unreachable'
  | 'rate-limited'
  | 'unknown'

/**
 * The sentence for a named failure, or null when the CLI could not name one —
 * in which case the caller keeps the CLI's own text, which is deliberately
 * verbatim ("the reason a directive would not parse is the finding").
 */
export function queueFailureSentence(
  kind: string | null | undefined,
  list: string | null,
): string | null {
  const name = list === null ? 'this project' : list
  switch (kind) {
    case 'signed-out':
      return `Flow isn't signed in to GitHub, so it can't read ${name}'s list.`
    case 'bad-credentials':
      return `GitHub refused Flow's credential, so it can't read ${name}'s list.`
    case 'not-installed':
      return `Reading ${name}'s list needs the GitHub CLI, which isn't installed on this machine.`
    case 'unreachable':
      return `Flow couldn't reach ${name} — it may be private, renamed or gone.`
    case 'rate-limited':
      return `GitHub is rate-limiting Flow, so ${name}'s list can't be read right now.`
    default:
      return null
  }
}

/**
 * The press that fixes it, or null when there is nothing a button can do.
 *
 * ONLY WHERE A REMEDY REALLY EXISTS. A missing gh CLI is an install, and
 * rate-limiting is a wait — offering "Connect GitHub" for either would be a
 * control that cannot act, which is the failure this whole change is about.
 * Credentials are the two that a person can fix from here, and connecting one
 * now reaches the queue: the CLI is spawned with the integration's token as
 * GH_TOKEN, so the dialog and the list stopped being separate grants.
 */
export function queueFailureAction(
  kind: string | null | undefined,
): { label: string; event: string } | null {
  if (kind !== 'signed-out' && kind !== 'bad-credentials') return null
  return { label: 'Connect GitHub', event: 'flow:open-integrations' }
}
