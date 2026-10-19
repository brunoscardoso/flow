/**
 * Stuck claims — the item a run took and then died still holding it.
 *
 * THE USER'S NAMED WORST CASE, and until now nothing answered it. A background
 * agent is killed — the machine sleeps, the harness is quit, the process is
 * OOM-ed — and the item it claimed stays claimed forever. No other run may take
 * it (`claimBlocker`), no surface mentions it, and the open-issue cap slowly
 * fills with ghosts nobody can name. The only thing that ever noticed was the
 * consecutive-failure breaker, which noticed something else entirely and is
 * being removed.
 *
 * WHAT THIS IS: a pure function over two inputs — the claims a queue currently
 * holds, and the live background sessions for that project root. Nothing here
 * spawns a process, reads a file or knows what a `claude` binary is. The
 * snapshot arrives as an argument, so this module is testable without a machine
 * that happens to have agents running on it, and so the one place that decides
 * "is this run still alive" cannot be re-decided differently by a second reader
 * (allowed-pattern #14).
 *
 * THE SAFETY PROPERTY, which is the whole reason the types look like this: the
 * live-session list has THREE answers, not two — these sessions are alive, or
 * *we could not tell*. Collapsing "could not tell" into "no runs are alive"
 * would report every live claim in the project as stuck, which is worse than
 * the silence it replaces: a report that cries wolf on healthy runs is a report
 * people learn to ignore, and the one real stuck claim goes with it. So
 * `LiveRuns` is a discriminated union with a `known` flag, and an unknown
 * snapshot yields an empty result rather than a full one.
 *
 * TWO ENTRY SHAPES, ONE OF WHICH IS NOT A RUN. `claude agents --json` returns
 * background agents AND the user's own interactive chat sessions in one array:
 * a `background` entry carries `id` + `state`, an `interactive` one carries
 * `pid` + `status`. Observed live during planning — this very session appeared
 * in the output. Counting an interactive session as a live run would be wrong in
 * both directions: it would keep a genuinely dead claim off the report while the
 * user has a chat open, and drop claims off it the moment they close one. Only
 * `kind === 'background'` is ever considered a run.
 */

/**
 * What separates a run's id from the session it is running in, inside one owner
 * string.
 *
 * `~` IS NOT DECORATION, for the same reason `FOREIGN_CLAIMANT_PREFIX` is not.
 * Every owner this CLI generates is `run-<timestamp>-<pid>` and every session id
 * is a UUID, so both alphabets are `[A-Za-z0-9-]` — a separator outside it can
 * never appear by accident in either half, which makes the split unambiguous
 * without anyone having to remember a second rule.
 */
export const RUN_SESSION_SEPARATOR = '~';

/**
 * The owner recorded on a claim, carrying the session the run lives in.
 *
 * THE CLAIM ALREADY HAD A FIELD FOR THIS. `claimedBy` is "the run that took
 * it" — the same string the run lock is keyed on, the same string `claimHeld`
 * compares and `close` authorizes against. Storing the session as a SECOND
 * identity field on the item would mean teaching all three stores (the GitHub
 * body marker, the ledger event, the local record for a person's issue) a
 * second fact about one run, with nothing keeping the two from disagreeing —
 * and a stuck-claim check reading a fact that none of those equality checks use.
 * So the session rides inside the identity that already exists.
 *
 * A run with no known session keeps exactly the owner it had before, so nothing
 * about the old shape changes for a caller that never learned about sessions.
 */
export function runOwner(runId: string, sessionId?: string): string {
  const session = sessionId?.trim() ?? '';
  if (session.length === 0) return runId;
  return `${runId}${RUN_SESSION_SEPARATOR}${session}`;
}

/**
 * The session an owner names, or null when it names none.
 *
 * NULL IS A REAL ANSWER, not a failure: a claim taken before this existed, one
 * taken by a run that was handed an `--owner` by a person, and — most
 * importantly — a claim held by an engineer on ANOTHER machine (`@<login>`,
 * derived from the assignee) all name no session here. None of them is
 * checkable against this machine's session list, and none of them may be
 * reported stuck on the strength of a list that could never have contained it.
 */
export function ownerSessionId(owner: string | undefined): string | null {
  if (owner === undefined) return null;
  const at = owner.indexOf(RUN_SESSION_SEPARATOR);
  if (at < 0) return null;
  const session = owner.slice(at + RUN_SESSION_SEPARATOR.length).trim();
  return session.length === 0 ? null : session;
}

/** The `kind` an entry must carry to be a loop run at all. */
export const BACKGROUND_KIND = 'background';

/**
 * What is running right now, or the reason nobody could say.
 *
 * The `known` flag is load-bearing — see the safety property above. Every
 * consumer must branch on it; a consumer that reads `sessionIds` off an unknown
 * answer cannot compile.
 */
export type LiveRuns =
  | { known: true; sessionIds: ReadonlySet<string> }
  | { known: false; reason: string };

/** The "could not tell" answer, with the reason a reader can act on. */
export function unknownRuns(reason: string): LiveRuns {
  return { known: false, reason };
}

/**
 * Read a session snapshot into the set of live background runs.
 *
 * DEFENSIVE BY DESIGN. The `claude agents --json` shape is unversioned and may
 * drift, so every departure from what was observed live is treated as "could
 * not tell" rather than quietly narrowing the set of live runs — narrowing it is
 * exactly how a healthy claim gets reported dead:
 *
 *   - not an array, or an entry that is not an object → unknown
 *   - an entry with no string `kind` → unknown, because a reader that cannot
 *     tell a background agent from the user's own chat cannot filter either way
 *   - a `background` entry with no usable `sessionId` → unknown, because that
 *     unidentifiable entry may be the very run holding the claim in question
 *
 * Entries of any other kind are simply not runs, and are skipped.
 */
export function liveRuns(snapshot: unknown): LiveRuns {
  if (!Array.isArray(snapshot)) {
    return unknownRuns('the list of running agents was not a list');
  }
  const sessionIds = new Set<string>();
  for (const entry of snapshot) {
    if (typeof entry !== 'object' || entry === null) {
      return unknownRuns('the list of running agents held something that was not an agent');
    }
    const record = entry as Record<string, unknown>;
    const kind = record['kind'];
    if (typeof kind !== 'string') {
      return unknownRuns('an entry in the list of running agents did not say what kind it was');
    }
    if (kind !== BACKGROUND_KIND) continue;
    const sessionId = record['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return unknownRuns('a running background agent did not say which session it is');
    }
    sessionIds.add(sessionId.trim());
  }
  return { known: true, sessionIds };
}

/**
 * The same read, from the raw JSON a caller was handed.
 *
 * ABSENT IS UNKNOWN, deliberately and by the same rule as everything else here:
 * a caller that supplied no snapshot has not told us that nothing is running,
 * and treating silence as an empty world is the failure this module exists to
 * avoid.
 */
export function parseLiveRuns(raw: string | undefined): LiveRuns {
  const text = raw?.trim() ?? '';
  if (text.length === 0) {
    return unknownRuns('nothing said which runs are alive, so no claim can be called dead');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unknownRuns('the list of running agents could not be read');
  }
  return liveRuns(parsed);
}

/** The parts of a queue item a claim check reads. Structural on purpose. */
export interface ClaimedItem {
  id: string;
  /** The run holding it, exactly as the queue recorded it. */
  claimedBy?: string;
  /** When it was taken, when the record carries a timestamp. */
  claimedAt?: string;
}

/** One held item, bound to the loop it belongs to and the run that took it. */
export interface ClaimBinding {
  id: string;
  loop: string;
  /** `claimedBy`, verbatim — the run identity every other check uses. */
  owner: string;
  claimedAt?: string;
}

/**
 * The claims a loop's OPEN items currently carry.
 *
 * Open only, and the caller filters: a closed item's claim is settled by the
 * close itself, so reporting one as stuck would be naming an item nobody is
 * waiting on.
 */
export function claimBindings(loop: string, items: readonly ClaimedItem[]): ClaimBinding[] {
  const out: ClaimBinding[] = [];
  for (const item of items) {
    const owner = item.claimedBy?.trim() ?? '';
    if (owner.length === 0) continue;
    const binding: ClaimBinding = { id: item.id, loop, owner };
    if (item.claimedAt !== undefined) binding.claimedAt = item.claimedAt;
    out.push(binding);
  }
  return out;
}

/** A claim whose run is gone — named so a person can act on it. */
export interface StuckClaim {
  /** The item still held. */
  id: string;
  /** The loop it belongs to. */
  loop: string;
  /** The run that took it, as recorded. */
  owner: string;
  /** The session that run lived in, and which no longer exists. */
  sessionId: string;
  /** When it was taken, when the record carries a timestamp. */
  claimedAt?: string;
}

/**
 * The claims whose run no longer exists.
 *
 * A REPORT, AND ONLY A REPORT. Nothing here releases anything, and nothing here
 * should ever grow the ability to: `loop status` is read-only, five engineers
 * share the queue, and a machine that unclaims on a guess will eventually
 * unclaim an item another machine is actively working. What was missing was
 * never the release — it was that the item was invisible.
 *
 * Three claims are deliberately NOT reported:
 *
 *   - every claim, when the snapshot is unknown (the safety property)
 *   - a claim whose owner names no session, which is any claim this machine
 *     could not have taken — including another engineer's `@<login>`
 *   - a claim whose session is in the live set, which is a run doing its job
 */
export function stuckClaims(claims: readonly ClaimBinding[], runs: LiveRuns): StuckClaim[] {
  if (!runs.known) return [];
  const out: StuckClaim[] = [];
  for (const claim of claims) {
    const sessionId = ownerSessionId(claim.owner);
    if (sessionId === null) continue;
    if (runs.sessionIds.has(sessionId)) continue;
    const stuck: StuckClaim = {
      id: claim.id,
      loop: claim.loop,
      owner: claim.owner,
      sessionId,
    };
    if (claim.claimedAt !== undefined) stuck.claimedAt = claim.claimedAt;
    out.push(stuck);
  }
  return out;
}

/**
 * One line naming what is stuck, in the vocabulary `loop status --human`
 * already uses for abandoned claims.
 *
 * NAMED, NOT COUNTED, for the reason the abandoned-claim line already gives: a
 * count cannot be chased. The item is what the reader must go and look at, and
 * the session is how they confirm the run really is gone.
 */
export function stuckClaimsPhrase(stuck: readonly StuckClaim[]): string {
  if (stuck.length === 0) return '';
  const named = stuck.map((claim) => `${claim.id} — run ${claim.sessionId} is gone`).join(', ');
  return `${String(stuck.length)} stuck claim${stuck.length === 1 ? '' : 's'} (${named})`;
}
