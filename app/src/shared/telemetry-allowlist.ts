/**
 * WHAT MAY LEAVE A CLIENT'S MACHINE — the whole list, as data.
 *
 * Flow holds conversations, tool outputs, terminal scrollback and browser
 * bodies. Instrumented the ordinary way — send the event and its context — a
 * telemetry layer would carry a client's source code off their machine, and the
 * first anyone knew would be an incident rather than a bug. So the allowlist is
 * not a guideline in a comment: it is the only thing that decides, and anything
 * absent from it is refused.
 *
 * REFUSED, NOT DROPPED. A quiet drop is how a new event's helpful `detail`
 * field ships: it works in development, nobody sees a warning, and "no content
 * leaves" stops being true without a single line saying so. A refusal is loud
 * in a test and visible in review.
 *
 * Ruled in by the person shipping this (2026-09-22): install facts and usage
 * events. Ruled OUT: error names, stack traces, breadcrumbs and error messages
 * — so a crash is a RATE here, never a diagnosis. See the plan's "the decision
 * the ruling forces".
 *
 * Pure and DOM-free: this is the contract, and a contract that needs a browser
 * to check is one nobody checks.
 */

/** Facts about the installation. No identity, no project, no content. */
export const INSTALL_FIELDS = [
  /** The id `app_settings` already mints per installation (`flow-ide-<hex>`). */
  'installId',
  'appVersion',
  'platform',
  'osVersion',
  'arch',
  'locale',
  'timezone',
  'firstRunAt',
  'sessionId',
  /**
   * THE JOIN, AND THE ONLY FIELD SIGN-IN ADDS.
   *
   * The provider's stable id for a signed-in person, so the events an
   * installation sent while anonymous belong to them afterwards. Absent until
   * somebody signs in, and absent for ever if nobody does.
   *
   * NOT DERIVED, unlike `installId`. That one is hashed because the value it
   * comes from is written into public GitHub issue bodies, so sending it would
   * join an anonymous row to a named repository. This one is the opposite case:
   * its whole purpose is to be resolvable to a person, by a server that already
   * holds the sign-in record. Hashing it would cost the feature and buy nothing
   * — the same server knows the email either way.
   */
  'identityId',
] as const

/**
 * Properties a usage event may carry.
 *
 * Counts, durations and coarse scale. Nothing here can hold a name: not a file,
 * not a project, not a branch, not a repository.
 */
export const EVENT_FIELDS = [
  'event',
  'at',
  'count',
  'durationMs',
  'provider',
  'model',
  'featureFlags',
  'projectCount',
  'threadCount',
  /**
   * WHICH AREA BROKE, from a vocabulary this app owns.
   *
   * Never read from an error object — its message and stack are ruled out. A
   * vocabulary is not a message: `db-write` says where to look without carrying
   * anything off the machine, and it is what makes a later upgrade to real
   * diagnosis a small change rather than a rebuild.
   */
  'errorKind',
] as const

/**
 * EVERY EVENT NAME THERE IS.
 *
 * `event` is a field on the allowlist, and the allowlist checks KEYS. That is
 * enough to stop an unapproved field, and no help at all against an approved
 * field carrying an unapproved VALUE — a name built as
 * `opened-${projectName}` passes a key check without a murmur, and it is a
 * project name on somebody else's server.
 *
 * So the vocabulary is closed, and `refusalsFor` checks membership. Adding an
 * event means adding a word here, in a diff a person reads, which is the same
 * bargain the field allowlist makes one level up.
 *
 * ONE NAME PER IDEA, in one spelling. Nobody can answer "how many sessions"
 * against a column holding four spellings of the same thing, so the list is
 * also what keeps the data queryable a month from now.
 *
 * What each name CARRIES is `telemetry-events.ts`, whose shapes are checked by
 * the compiler; this list is what the door checks at runtime.
 */
export const EVENT_NAMES = [
  'session.started',
  'session.ended',
  'thread.created',
  'debug.session.finished',
  'worktree.created',
  'app.failed',
] as const

export type EventName = (typeof EVENT_NAMES)[number]

export type InstallField = (typeof INSTALL_FIELDS)[number]
export type EventField = (typeof EVENT_FIELDS)[number]

/** Every field that may appear in an outbound payload. */
export const ALLOWED_FIELDS: readonly string[] = [...INSTALL_FIELDS, ...EVENT_FIELDS]

/**
 * Names that must never appear, whatever the allowlist says.
 *
 * A SECOND GUARD, ON PURPOSE. The allowlist alone is safe until somebody adds a
 * plausible-looking key to it; this list is what a reviewer reads to see that
 * the dangerous ones were considered and refused by name. Belt and braces on
 * the only promise this feature makes.
 */
export const FORBIDDEN_FIELDS: readonly string[] = [
  'prompt',
  'message',
  'content',
  'text',
  'path',
  'filePath',
  'file',
  'repo',
  'repository',
  'project',
  'projectRoot',
  'branch',
  'url',
  'stack',
  'stackTrace',
  'error',
  'errorMessage',
  'output',
  'command',
  'title',
  'email',
  'name',
]

/** Why a payload was refused. */
export interface TelemetryRefusal {
  field: string
  reason: 'not-on-the-allowlist' | 'forbidden-by-name' | 'not-in-the-event-vocabulary'
}

/**
 * Check a payload against the contract.
 *
 * Returns every problem rather than the first: a caller fixing an event wants
 * the whole list, and a test that reports one field at a time is a test somebody
 * runs four times.
 */
export function refusalsFor(payload: Record<string, unknown>): TelemetryRefusal[] {
  const out: TelemetryRefusal[] = []
  for (const field of Object.keys(payload)) {
    if (FORBIDDEN_FIELDS.includes(field)) {
      out.push({ field, reason: 'forbidden-by-name' })
      continue
    }
    if (!ALLOWED_FIELDS.includes(field)) {
      out.push({ field, reason: 'not-on-the-allowlist' })
    }
  }
  // AN APPROVED KEY CAN STILL CARRY AN UNAPPROVED VALUE. `event` is the one
  // field whose value is free-form enough to hold a name, so it is the one
  // whose value is checked — against the closed vocabulary above.
  const name = payload['event']
  if (name !== undefined && !EVENT_NAMES.includes(name as EventName)) {
    out.push({ field: 'event', reason: 'not-in-the-event-vocabulary' })
  }
  return out
}

/** True when every key in the payload is permitted. */
export function isAllowed(payload: Record<string, unknown>): boolean {
  return refusalsFor(payload).length === 0
}
