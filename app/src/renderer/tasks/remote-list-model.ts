// THE REMOTE LIST — what is assigned to YOU on the trackers you have connected.
//
// WHAT IT IS NOT, and the distinction is the whole design. A loop's QUEUE is a
// repository's list of work that somebody pointed a loop at, in a committed
// directive. This is a different question with a different answer: "what is
// mine, wherever it lives". A person opening the board wants the second, which
// is why connecting GitHub is enough to get this column and no file has to be
// edited — the first cut got that backwards and built the column on the queue,
// so a project whose loops read a local list could never show one at all.
//
// THE COLUMN IS OPT-IN, PER PROJECT. An extra column costs width on a board
// whose four lanes are already tight, and somebody with a connected tracker may
// simply not want their tracker on this screen. So the icon that reveals it only
// exists when there is something to reveal, and its state is remembered.
//
// Pure — no DOM, no IPC. It decides which providers can be asked, which one is
// showing, and what every sentence says.

import type {
  IntegrationProvider,
  IssueListConfig,
  IssueListMode,
  RemoteIssue,
} from '../../shared/ipc-contract'

/** The trackers this column can read, in the order it offers them. */
export const REMOTE_PROVIDERS: readonly IntegrationProvider[] = ['github', 'jira', 'azure']

/**
 * One tracker's answer to "are you connected?" — THREE outcomes, not two.
 *
 * `connected` / `disconnected` are what a resolved `integrations:status` says.
 * `unknown` is what a FAILED status call means — and it is a distinct answer,
 * not a synonym for `disconnected`.
 */
export type ConnectionOutcome = 'connected' | 'disconnected' | 'unknown'

/**
 * Which trackers are connected, folding a fresh status sweep over what was
 * last known.
 *
 * THE THIRD OUTCOME IS THE WHOLE POINT. A status probe can resolve
 * connected:true / false, or it can FAIL — a `gh`/`az` token resolve that timed
 * out, a status handler not yet registered between an update and a restart. A
 * failure is NOT a disconnection: treating the two alike once dropped a
 * connected tracker for the entire session, because nothing re-checks a root
 * that has not changed, so the Remote toggle vanished and never came back. On
 * `unknown` we keep the last-known answer for that tracker; only an explicit
 * `disconnected` removes one, and only a `connected` adds one.
 */
export function mergeConnected(
  previous: readonly IntegrationProvider[],
  outcomes: ReadonlyMap<IntegrationProvider, ConnectionOutcome>,
): IntegrationProvider[] {
  return REMOTE_PROVIDERS.filter((provider) => {
    const outcome = outcomes.get(provider)
    if (outcome === 'connected') return true
    if (outcome === 'disconnected') return false
    return previous.includes(provider)
  })
}

/** What each list mode is called on the selector. */
const MODE_WORDS: Record<IssueListMode, string> = {
  assigned: 'Assigned',
  list: 'My list',
  both: 'Both',
}

/** The mode's name, for a selector entry. */
export function modeLabel(mode: IssueListMode): string {
  return MODE_WORDS[mode]
}

/** What each is called on this surface. */
const PROVIDER_WORDS: Record<string, string> = {
  github: 'GitHub',
  jira: 'Jira',
  azure: 'Azure DevOps',
}

/** The tracker's name, for a dropdown entry or a sentence. */
export function providerLabel(provider: IntegrationProvider): string {
  return PROVIDER_WORDS[provider] ?? provider
}

/** One provider's answer, as the board holds it. */
export interface RemoteRead {
  provider: IntegrationProvider
  ok: boolean
  items: RemoteIssue[]
  /** Why it could not be read, or null. Shown verbatim. */
  reason: string | null
}

/** Everything the column needs to draw itself. */
export interface RemoteListView {
  /**
   * True when the column can exist at all — at least one tracker is connected.
   *
   * NOT "has items". A connected tracker with nothing assigned is an answer
   * worth showing ("nothing assigned to you"), and hiding the column for it
   * would make an empty inbox indistinguishable from a broken one.
   */
  available: boolean
  /** The connected trackers, in offer order. */
  providers: IntegrationProvider[]
  /** Which one is showing — null when none can be. */
  showing: IntegrationProvider | null
  /** The items to draw. Empty when the read failed or found none. */
  items: RemoteIssue[]
  /** The failure sentence, or null. */
  reason: string | null
  /**
   * True while the request is in flight.
   *
   * A STATE OF ITS OWN, not "no items yet". The two look identical in a list
   * and mean opposite things — one is an answer and the other is the absence of
   * one — and this read goes to somebody else's server, which on a cold token
   * means seconds. A column that showed nothing during those seconds is a
   * column that looks broken; the user's own report: "is taking a long time and
   * there no loader".
   */
  loading: boolean
  /** What the column says when it has nothing to draw and nothing went wrong. */
  emptyText: string
  /** The toggle's accessible name and tooltip, in the state it is in. */
  toggleLabel: string
  /**
   * The mode the column is EFFECTIVELY showing.
   *
   * Forced to `assigned` when the showing provider has no saved query, whatever
   * the stored mode says — `list`/`both` cannot mean anything without a query,
   * and the fetch falls back the same way, so the two never disagree.
   */
  mode: IssueListMode
  /**
   * The modes the selector may offer. `['assigned']` alone when no query is
   * saved — which the board reads as "hide the selector", the same rule the
   * provider picker follows when there is nothing to pick between.
   */
  modeOptions: IssueListMode[]
  /**
   * What the column is ACTUALLY showing, in one line — the effective question
   * plus how many it answered ("Your saved list · 4 results").
   *
   * THE POINT IS TO TELL "wrong query" FROM "broken board" APART. A list that
   * diverges from the tracker looks identical to a bug until the column says
   * which question it asked and how many came back. Empty (`''`) while loading
   * or when a read has not landed — those states speak for themselves through
   * `loading` / `reason` / `emptyText`, and a caption there would just repeat
   * them.
   */
  provenance: string
}

export interface RemoteListInput {
  /** Which providers are connected — from `integrations:status`. */
  connected: readonly IntegrationProvider[]
  /** The read for the provider currently chosen, when one has landed. */
  read: RemoteRead | null
  /** Which provider a person picked, or null for "the first connected one". */
  chosen: IntegrationProvider | null
  /** Whether the column is switched on for this project. */
  on: boolean
  /** True while a read is in flight — see `RemoteListView.loading`. */
  reading?: boolean
  /**
   * The showing provider's list preference — mode + saved query. `null` while it
   * has not been read yet, which reads as the default (assigned, no query).
   */
  config?: IssueListConfig | null
}

/**
 * The column, from what is connected and what was read.
 *
 * FALLS BACK TO THE FIRST CONNECTED PROVIDER, never to nothing: a stored choice
 * can name a tracker that has since been disconnected, and an empty column
 * would report "nothing assigned to you" about a question asked of nobody.
 */
export function remoteListView(input: RemoteListInput): RemoteListView {
  const providers = REMOTE_PROVIDERS.filter((provider) => input.connected.includes(provider))
  const showing =
    providers.find((provider) => provider === input.chosen) ?? providers[0] ?? null
  const available = providers.length > 0
  // The read is only this view's read when it is about the provider on screen —
  // a snapshot left over from a previous choice is not an answer to this one.
  const read = input.read !== null && input.read.provider === showing ? input.read : null
  const loading = input.reading === true
  // A SAVED QUERY IS WHAT UNLOCKS `list`/`both`. Without one, the stored mode is
  // meaningless, so the effective mode is forced to `assigned` and the selector
  // has nothing to offer — the same fallback the main-process fetch makes.
  const hasQuery = (input.config?.query ?? '').trim().length > 0
  const mode: IssueListMode = hasQuery ? (input.config?.mode ?? 'assigned') : 'assigned'
  const modeOptions: IssueListMode[] = hasQuery ? ['assigned', 'list', 'both'] : ['assigned']
  return {
    available,
    providers,
    showing,
    loading,
    mode,
    modeOptions,
    items: read?.ok === true ? read.items : [],
    reason: read !== null && !read.ok ? remoteReadFailure(read.reason) : null,
    // ONLY EVER THE "NOTHING" SENTENCE. "Reading…" used to live here, which
    // made the empty state carry two opposite meanings depending on a field
    // nobody looking at it could see. Loading is its own state now, and this is
    // the answer — and it says which QUESTION came back empty, so "nothing on
    // your list" never reads as "nothing assigned".
    emptyText: emptyTextFor(mode, showing),
    toggleLabel: loading
      ? 'Reading what is assigned to you…'
      : input.on
        ? 'Hide what is assigned to you'
        : 'Show what is assigned to you',
    // Only once a read has landed with items — see the field doc. A failed or
    // still-empty read is already explained by `reason` / `emptyText`.
    provenance:
      !loading && read?.ok === true && read.items.length > 0
        ? `${questionWord(mode)} · ${countWord(read.items.length)}`
        : '',
  }
}

/** What question the effective mode asks, named for the caption. */
function questionWord(mode: IssueListMode): string {
  if (mode === 'list') return 'Your saved list'
  if (mode === 'both') return 'Assigned + your list'
  return 'Assigned to you'
}

/** "1 result" / "4 results" — the count, pluralised. */
function countWord(n: number): string {
  return `${String(n)} ${n === 1 ? 'result' : 'results'}`
}

/** The "nothing here, and nothing went wrong" sentence — worded for the mode,
 *  so an empty `list` read never claims nothing is assigned. */
function emptyTextFor(mode: IssueListMode, showing: IntegrationProvider | null): string {
  const where = showing === null ? 'this tracker' : providerLabel(showing)
  if (mode === 'list') return `Nothing matches your list on ${where}.`
  if (mode === 'both') return `Nothing assigned or on your list on ${where}.`
  return `Nothing assigned to you on ${where}.`
}

/**
 * The sentence a failed read shows.
 *
 * A TRACKER'S OWN REASON PASSES THROUGH VERBATIM — it is the finding, and
 * rewording it would put a second opinion between the reader and the server
 * that refused.
 *
 * ONE THING DOES NOT: an IPC channel that is not registered. That is not a
 * fact about GitHub or Jira at all; it means the window is running newer code
 * than the process behind it, which happens between an update and a restart.
 * Showing `No handler registered for 'integrations:assigned'` hands a person
 * the app's own plumbing and tells them nothing they can do (forbidden-pattern
 * #12). Translated at the DISPLAY boundary only, and only for this one shape —
 * nothing that DECIDES behaviour reads another process's prose.
 */
export function remoteReadFailure(reason: string | null): string {
  const said = (reason ?? '').trim()
  if (said.length === 0) return 'Could not read your list.'
  if (/No handler registered for/i.test(said)) {
    return 'Flow needs restarting to finish updating — this part of it is newer than the app behind it.'
  }
  return said
}

/**
 * Where a project's choice is remembered.
 *
 * PER PROJECT, because the answer is: one repository's board wants its tracker
 * and another's does not. Kept in `localStorage` rather than in the project's
 * files — it is a view preference on this machine, not something to commit and
 * certainly not something to write into a directive the whole team reads.
 */
export function remoteListStorageKey(projectRoot: string): string {
  return `flow.board.remote:${projectRoot}`
}

/**
 * Where a project's LAST-OPENED tracker is remembered.
 *
 * A SECOND KEY, not a second meaning for the first. Whether the column is shown
 * and which tracker it shows are two answers, and a person who hides the column
 * has not changed their mind about which list is theirs — folding them together
 * would lose the tracker every time the column was closed.
 *
 * Per project and on this machine, for the same reasons the sibling above
 * gives: it is a view preference, not something to commit.
 */
export function remoteSourceStorageKey(projectRoot: string): string {
  return `flow.board.remote-source:${projectRoot}`
}

/**
 * A remembered tracker, or null.
 *
 * VALIDATED, NEVER TRUSTED. What comes back is a string this build did not
 * write: a value from a newer version that knows a tracker this one does not,
 * or a hand-edited one. An unrecognised word is no answer at all rather than a
 * provider name nothing can honour — and `remoteListView` then falls back to
 * the first connected tracker, which is what a board with no memory does.
 *
 * A remembered tracker that is no longer CONNECTED needs no handling here: the
 * view already keeps `chosen` only when it is among the available providers.
 */
export function rememberedRemoteSource(stored: string | null): IntegrationProvider | null {
  return REMOTE_PROVIDERS.find((provider) => provider === stored) ?? null
}
