/**
 * BASIC DISCOVERY BEFORE A CONVERSATION — the words and the shapes both sides
 * share (main decides, the renderer draws; see main/learn/basic-discovery.ts).
 *
 * Every sentence a person reads about it lives here, names projects by their
 * folder name only, and names no path, command or setting (forbidden-pattern
 * #12). DOM-free, so it is testable under the node jest environment.
 */

/**
 * Where a project stands:
 *   · `done`         — it has its basic discovery;
 *   · `queued`       — its sweep is waiting its turn (or for setup to finish);
 *   · `running`      — its sweep is running;
 *   · `failed`       — its last sweep ended without learning anything; a
 *                      person's Try again runs it again;
 *   · `not-required` — outside every Workspace, so never swept automatically.
 */
export type BasicDiscoveryStatus = 'done' | 'queued' | 'running' | 'failed' | 'not-required'

/** Statuses that keep a project out of a conversation's folders for now. */
export function isLearningStatus(status: BasicDiscoveryStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running' || status === 'failed'
}

/** "A", "A and B", "A, B and C". */
export function joinProjectNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The thread's line while its first message waits on a project's basic discovery. */
export function learningFirstWaiting(names: readonly string[]): string {
  return `Learning ${joinProjectNames(names)} first — your message will be sent when it's done`
}

/** The thread's sentence when that discovery could not finish. */
export function learningFirstFailed(names: readonly string[], reason: string | null): string {
  const lead = `Flow couldn't learn ${joinProjectNames(names)}, so your message hasn't been sent yet.`
  return reason === null || reason.trim() === '' ? lead : `${lead} ${reason}`
}

/** The failure card's button. */
export const LEARNING_FIRST_RETRY = 'Try again'

/** A project chip whose project is still being learned. */
export const LEARNING_CHIP_LABEL = 'Learning…'

/**
 * A project chip whose basic discovery ended without learning anything. Not
 * "Learning…": nothing is running any more, and a chip that says otherwise
 * reads as a learner that never finishes.
 */
export const LEARNING_FAILED_CHIP_LABEL = "Couldn't learn"

/** The hover text of that chip. */
export function learningChipTitle(name: string, failed: boolean): string {
  return failed
    ? `${name} — Flow couldn't learn this project yet. It joins the conversation once it has been learned; sending a message tries again.`
    : `${name} — Flow is learning this project first. It joins the conversation with your next message after that.`
}

/**
 * A conversation's first message, held until its project is learned — the
 * `learning-first` stream event and the `threads:learningFirst` answer.
 * `waiting` draws the line, `failed` the sentence and Try again, `done`
 * nothing (the turn's own activity takes over).
 */
export interface LearningFirstState {
  state: 'waiting' | 'failed' | 'done'
  /** The projects being learned, by name. */
  projects: string[]
  /** One sentence a person reads (`failed` only). */
  detail?: string
}
