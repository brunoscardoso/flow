/**
 * Pure, DOM-free density projection for the conversation feed.
 *
 * The feed folds on three axes — the request (`request-summary.ts`), the turn
 * (`turn-summary.ts`) and the activity run (`tool-group-model.ts`) — and a
 * reader chooses how much of that folding applies. That choice is EXACTLY ONE
 * function, here, because the failure mode it exists to prevent is the
 * densities drifting apart: the chat-feed-signal report (plan_chat-feed-signal_v1,
 * C-2 / FR-7) names the reference product's own shipped bug, filed by its users
 * as "hides tool call details in defiance of setting" — a release where the
 * detail escape hatch stopped being an escape hatch. That cannot happen here
 * because `detailed` is not a code path that renders detail; it is
 * `units => units`, the identity, asserted directly in `feed-density.test.ts`.
 *
 * Two disciplines are inherited from the models it composes:
 *   - Order is NEVER reordered, at any density. Chronology is the record.
 *   - No DOM, no view types, so it runs under the app's node-env jest and the
 *     view can change without touching it.
 *
 * ── The ladder (plan_chat-cleanup, FR-15) ────────────────────────────────────
 *   - `compact` (default) — the REQUEST fold: a person's message, one work row
 *     for every step up to the final answer, the answer. Cards a person must
 *     act on are never folded.
 *   - `balanced` — the per-message TURN fold: each assistant message, then one
 *     row for the tools it ran. This was `compact` before the request fold; a
 *     reader who wants it still has it, one level down.
 *   - `detailed` — nothing folded. The identity.
 *
 * What moved: the activity-only rung (`planToolGroups` over the flat list,
 * which `balanced` used to be) is no longer a density of its own. The activity
 * fold still applies inside `balanced` to the entries no turn owns, and inside
 * `compact` to the entries no request owns. Stated here rather than left for a
 * reader of the old note to discover.
 */
import { planToolGroups } from './tool-group-model'
import { planRequests, type Request, type RequestRole } from './request-summary'
import { planTurns, type TurnRole } from './turn-summary'

/**
 * How much of the feed's folding applies.
 *
 * - `compact` — the request fold. One work row per request, then its answer.
 * - `balanced` — the turn fold. Each message, then one row for its tools.
 * - `detailed` — no folds. The identity; see the note above.
 */
export type FeedDensity = 'compact' | 'balanced' | 'detailed'

export const FEED_DENSITIES: readonly FeedDensity[] = ['compact', 'balanced', 'detailed']

/** The default: the fold this whole feature exists to deliver. */
export const DEFAULT_FEED_DENSITY: FeedDensity = 'compact'

/** True for the three strings above and nothing else — for reading a stored
 *  preference back, where the value came from a file a person can edit. */
export function isFeedDensity(value: unknown): value is FeedDensity {
  return typeof value === 'string' && (FEED_DENSITIES as readonly string[]).includes(value)
}

/**
 * One render unit of the feed, at whatever depth the density left it.
 *
 * The three shapes are the three folds' outputs expressed over one type, which
 * is what lets a single function return all three densities and lets the pane
 * render them with one `switch`. `entry` is the atomic rung — the identity's
 * domain and its codomain both.
 *
 * Generic over the caller's entry type so this model never imports view types.
 */
export type FeedUnit<T> =
  | { level: 'entry'; entry: T }
  | { level: 'group'; key: string; entries: T[] }
  | { level: 'turn'; messageId: string; head: T; tools: T[] }
  | { level: 'request'; request: Request<T> }

/**
 * How the projection reads an entry. Both classifiers are the caller's, for the
 * same reason `planTurns` and `planToolGroups` each take theirs: this module
 * imports no `HistoryEntry`, so the pane owns the translation in one place.
 */
export interface FeedClassifiers<T> {
  /** What an entry is to the TURN fold — see `TurnRole`. */
  turnRole: (entry: T) => TurnRole
  /** What an entry is to the REQUEST fold — see `RequestRole`. Required, so
   *  a caller cannot reach `compact` without saying how to fold a request. */
  requestRole: (entry: T) => RequestRole
  /** An entry's activity-group key, or null when it must never group. */
  groupKey: (entry: T) => string | null
}

/** What the caller knows about the thread that the entries cannot say. */
export interface ProjectFeedOptions {
  /** True while the thread runs a turn — see `PlanRequestsOptions.running`. */
  running?: boolean
}

/**
 * Lift a flat, sorted entry list into the identity's domain: one unit per
 * entry, nothing folded. This is what the pane hands `projectFeed`, and what
 * `projectFeed('detailed', …)` hands straight back.
 */
export function feedUnits<T>(entries: readonly T[]): Array<FeedUnit<T>> {
  return entries.map((entry) => ({ level: 'entry', entry }))
}

/**
 * The entries behind a unit list, in order — the inverse of every fold.
 *
 * `compact` and `balanced` come through here first: they re-fold from entries
 * rather than from whatever depth they were handed, so each is idempotent and
 * each ignores which of the two produced its input. A reader toggling
 * Compact → Balanced lands on the same Balanced as one who went straight there.
 *
 * `detailed` DOES NOT, and the difference is the contract, not an oversight: it
 * returns its argument untouched — the identity, asserted with `toBe` — and so
 * never reaches this function. Nothing unfolds a unit it is handed. It is
 * therefore the CALLER's job to hand `projectFeed` atomic units (`feedUnits`
 * over a flat entry list, which is what the pane does); hand `detailed` a list
 * that is already folded and it will hand that same folded list straight back.
 */
export function feedEntries<T>(units: readonly FeedUnit<T>[]): T[] {
  const out: T[] = []
  for (const unit of units) {
    if (unit.level === 'entry') {
      out.push(unit.entry)
    } else if (unit.level === 'group') {
      out.push(...unit.entries)
    } else if (unit.level === 'request') {
      out.push(...unit.request.entries)
    } else {
      out.push(unit.head, ...unit.tools)
    }
  }
  return out
}

/**
 * THE projection: one function from a density to what renders.
 *
 * `detailed` returns its argument — the same array, not a copy — so there is no
 * code path on which "Detailed" can render less than everything. That is the
 * property C-2 asks for, and it is a property rather than a promise precisely
 * because there is nothing here to get wrong.
 *
 * `compact` is the request fold: requests become request units, and the
 * entries no request owns (a card, a system row before any request) pass
 * through the activity fold in contiguous runs.
 *
 * `balanced` is the turn fold — what `compact` was before the request fold:
 * turns fold into turn units, and the entries that belong to NO turn (the
 * user's messages, system rows, tool calls whose assistant message is outside
 * the slice) pass through the activity fold in contiguous runs — buffering
 * them rather than emitting one at a time is what keeps a run of ungrouped
 * tool calls grouping.
 */
export function projectFeed<T>(
  density: FeedDensity,
  units: readonly FeedUnit<T>[],
  classifiers: FeedClassifiers<T>,
  options: ProjectFeedOptions = {},
): readonly FeedUnit<T>[] {
  // The identity. Deliberately first, deliberately literal.
  if (density === 'detailed') return units

  const entries = feedEntries(units)
  const out: Array<FeedUnit<T>> = []
  let loose: T[] = []
  const flushLoose = (): void => {
    if (loose.length === 0) return
    out.push(...groupUnits(loose, classifiers.groupKey))
    loose = []
  }

  if (density === 'compact') {
    const requestOptions = options.running === undefined ? {} : { running: options.running }
    for (const unit of planRequests(entries, classifiers.requestRole, requestOptions)) {
      if (!unit.request) {
        loose.push(unit.entry)
        continue
      }
      flushLoose()
      out.push({ level: 'request', request: unit })
    }
    flushLoose()
    return out
  }

  for (const unit of planTurns(entries, classifiers.turnRole)) {
    if (!unit.turn) {
      loose.push(unit.entry)
      continue
    }
    flushLoose()
    out.push({ level: 'turn', messageId: unit.messageId, head: unit.head, tools: unit.tools })
  }
  flushLoose()
  return out
}

/** `planToolGroups` output lifted into `FeedUnit`. */
function groupUnits<T>(
  entries: readonly T[],
  keyOf: (entry: T) => string | null,
): Array<FeedUnit<T>> {
  return planToolGroups(entries, keyOf).map((unit): FeedUnit<T> =>
    unit.grouped
      ? { level: 'group', key: unit.key, entries: unit.entries }
      : { level: 'entry', entry: unit.entry },
  )
}
