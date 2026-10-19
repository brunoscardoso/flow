/**
 * The queue backend contract — one interface, two homes.
 *
 * A producer files findings and a consumer claims them, and NEITHER knows where
 * the queue physically lives. Swapping `queue: github` ↔ `queue: ledger` in a
 * directive changes no caller, no prompt and no prose: the same verbs
 * (`exists / file / claim / adopt / recordPlan / close / recordMerge / approve /
 * count`) mean the same thing on both sides, and the same refusal text comes back.
 *
 * INVARIANTS LIVE IN THIS FILE, NOT IN EACH BACKEND (allowed-pattern #14).
 * `LoopQueueBackendBase` implements every verb in terms of eight small
 * primitives a backend supplies (`listItems`, `createItem`, `setClaim`,
 * `setPlan`, `setClosed`, `setApproved`, `setAdopted`, `setMerged`). The cap, the dedup check, the
 * eligibility rules, the provenance rule and the evidence requirement are
 * therefore not conventions a backend is trusted to re-implement — they are code
 * a backend cannot route around. A third backend added later inherits every one
 * of them by construction.
 *
 * MARKERS ARE WRITTEN BY THE BACKEND, NEVER BY A CALLER. The composed body
 * carries `<!-- loop-fp: … -->` (the dedup key), `<!-- loop: … -->` (which loop
 * filed it) and `<!-- loop-file: … -->` (the primary file); a run working the
 * item adds `<!-- loop-claim: … -->` (who holds it) and `<!-- loop-plan: … -->`
 * (which pipeline they are advancing). GitHub has no field for any of those, so
 * the body IS the record; the ledger keeps real fields and writes the same
 * markers anyway, so one item copied from one backend to the other still reads
 * correctly.
 *
 * A LOOP MAY WORK ANY ITEM; IT MAY MUTATE ONLY ITS OWN. Those are two rules, and
 * conflating them shipped a consumer that could not see a single hand-filed
 * issue — `0 claimable` on a repo full of them, on a loop whose entire purpose is
 * draining that backlog.
 *
 *   - WORKING. Whoever filed an item is irrelevant to a loop whose job is to
 *     drain a queue, so a `consumer` claims anything claimable (`engineWorkBlocker`).
 *     A `producer` files and never claims, so it keeps the narrow rule.
 *   - MUTATING. On an item NO LOOP FILED — a person's — the only write is the
 *     `in-progress` label, added on claim and removed on release. No body
 *     rewrite, no invented fingerprint, no ad-hoc label, no closing comment and
 *     no close: the issue is closed by GitHub when the pull request carrying
 *     `Closes #<n>` merges. `humanWorkBlocker` still guards every other write,
 *     and `adopt` — a person's act, refused while a run holds the loop — is
 *     still the only thing that writes the marker onto someone else's item.
 *
 * WHAT A LOOP KNOWS ABOUT A PERSON'S ITEM IS LOCAL. With the body off limits,
 * the claim and the "already handled" record have nowhere on the item to live,
 * so they live in `foreign-items.ts` — see that module for why both are needed.
 *
 * CLOSING REQUIRES MACHINE-CHECKABLE EVIDENCE. A `done` close must carry the
 * commands that were actually run and the exit codes they actually returned —
 * prose is refused. This is the single most important safety property in the
 * feature: the loop closes issues at 3am with nobody reading the summary, and
 * forbidden-pattern #7 ("never trust the worker's success summary") stops being
 * a review habit and becomes the only thing standing between a green report and
 * an unfixed bug.
 *
 * SYNCHRONOUS, like every other store in this CLI. Determinism and one
 * call-shape matter more here than concurrency a single run never uses.
 */

import {
  bodyHasFingerprint,
  extractFingerprint,
  fingerprintMarker,
  loopFingerprint,
  stripFingerprintMarker,
} from './fingerprint.js';
import { createMemoryForeignItemState, foreignKey } from './foreign-items.js';
import type {
  ForeignHandled,
  ForeignItemEventName,
  ForeignItemRecord,
  ForeignItemState,
} from './foreign-items.js';
import type { LoopEngine, LoopQueueKind } from './types.js';

// ── labels: the small shared vocabulary ──────────────────
//
// GitHub's labels and the ledger's fields are different mechanisms for the same
// three facts. The NAMES are shared so a human reading either store sees the
// same words, and so `claim`'s eligibility rule is one predicate rather than
// two that can drift.

/** Filed behind an approval gate — never claimed until `approve` clears it. */
export const APPROVAL_LABEL = 'needs-approval';

/** Parked by a human. Never auto-picked; only a person un-parks it. */
export const PARKED_LABEL = 'not-now';

/**
 * Marks an item a run is currently working. Cleared on unclaim or close.
 *
 * The word is `in-progress` because that is the repo's OWN word for the same
 * fact — the claim label a human applies by hand when they start on an issue,
 * and the one the issue-claim protocol already names. Two words for one state
 * would mean a person and a loop could each believe an item was free.
 */
export const CLAIMED_LABEL = 'in-progress';

/** Labels this layer gives meaning to — everything else is passed through. */
export const RESERVED_LABELS: readonly string[] = [APPROVAL_LABEL, PARKED_LABEL, CLAIMED_LABEL];

/**
 * Prefix marking a claimant read off the QUEUE rather than out of a claim
 * record this machine wrote.
 *
 * `@` is not decoration. A run owner is `run-<timestamp>-<n>`, so a name
 * starting with `@` can never collide with one — which means every comparison
 * of a claimant against an owner fails closed against a claim held elsewhere,
 * without anyone having to remember a second rule.
 */
export const FOREIGN_CLAIMANT_PREFIX = '@';

/** The claimant an assignee stands for, when the item carries no claim marker. */
export function foreignClaimant(login: string): string {
  return `${FOREIGN_CLAIMANT_PREFIX}${login}`;
}

/** Whether a claimant was derived from the queue rather than recorded locally. */
export function isForeignClaimant(claimedBy: string | undefined): boolean {
  return claimedBy !== undefined && claimedBy.startsWith(FOREIGN_CLAIMANT_PREFIX);
}

// ── topics: the ONE label a loop may invent ──────────────

/**
 * The longest topic accepted. Long enough for any area name anyone actually
 * types, short enough to render inside a status bracket (`find [codemap]`) and
 * to sit in a label chip without wrapping. A topic longer than this is a
 * sentence, and a sentence is a mission, not a topic.
 */
export const TOPIC_MAX_LENGTH = 50;

/**
 * The topic grammar.
 *
 * LOOSER THAN A LOOP NAME, because a topic is never a filename or a branch
 * segment — it is a label — so `.`, `_` and `/` are allowed (`src/cli`,
 * `board.v2`). STILL BOUNDED, because it reaches `gh label create` as user text
 * and lands in someone's repo configuration:
 *
 *   - lowercase only, matching every other label in this vocabulary, so a repo
 *     never ends up with `Codemap` and `codemap` as two labels
 *   - starts AND ends with an alphanumeric — a leading dash reads as a flag to
 *     every CLI that ever sees it, and a trailing separator is a typo
 *   - no whitespace and no quoting-sensitive characters: the exec is
 *     `execFileSync`, so this is legibility and repo hygiene rather than shell
 *     safety, and a label nobody can retype by hand is a label nobody uses
 *
 * Violations REFUSE and never sanitize — a topic silently rewritten is a loop
 * filing under a word its owner never chose (see `topicProblem`).
 */
export const TOPIC_PATTERN = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/;

/**
 * Why a topic is unusable, or null when it is fine. The offending value is
 * always in the message: the whole point of refusing rather than sanitizing is
 * that the user sees exactly what was rejected.
 *
 * An EMPTY topic is not a problem here — absence is how a directive says it has
 * no topic, and callers check for it before asking.
 */
export function topicProblem(topic: string): string | null {
  if (topic.length === 0) return null;
  if (RESERVED_LABELS.includes(topic)) {
    return `reserved topic '${topic}' — ${RESERVED_LABELS.join(', ')} are queue state, and a topic names an area`;
  }
  if (topic.length > TOPIC_MAX_LENGTH) {
    return `malformed topic '${topic}' — expected at most ${TOPIC_MAX_LENGTH} characters`;
  }
  if (!TOPIC_PATTERN.test(topic)) {
    return `malformed topic '${topic}' — expected lowercase alphanumerics separated by - . _ /, starting and ending with a letter or digit, no spaces`;
  }
  return null;
}

// ── item vocabulary ──────────────────────────────────────

/** Whether an item is still workable or already resolved. */
export type QueueItemState = 'open' | 'closed';

/**
 * Why an item was closed.
 *
 * `wontfix` is the one that matters most: under GitHub, a closed item is still
 * SEARCHABLE, so a wontfix close is a permanent "never file this again". That
 * is the memory the queue is built on — without it a producer re-files every
 * rejected idea forever, and the human who rejected it has to reject it again.
 */
export type QueueCloseReason = 'done' | 'wontfix' | 'duplicate';

/** Every close reason, for validation and refusal messages. */
export const QUEUE_CLOSE_REASONS: readonly QueueCloseReason[] = ['done', 'wontfix', 'duplicate'];

/** Whether a value is a known close reason. */
export function isQueueCloseReason(value: string): value is QueueCloseReason {
  return (QUEUE_CLOSE_REASONS as readonly string[]).includes(value);
}

/**
 * One command that was actually run, and the exit code it actually returned.
 * This — not a sentence — is what "the work is done" is allowed to mean.
 */
export interface EvidenceCommand {
  /** The command as run, verbatim. */
  command: string;
  /** Its captured exit code. */
  exitCode: number;
}

/** The evidence attached to a close. */
export interface CloseEvidence {
  /** Commands run, with captured exit codes. Required for a `done` close. */
  commands: EvidenceCommand[];
  /** Optional artifact paths/URLs (screenshots, logs) produced while verifying. */
  artifacts?: string[];
  /** Optional prose. NEVER sufficient on its own — see the module header. */
  summary?: string;
}

/**
 * One queue item, in the shape every caller sees regardless of backend.
 *
 * `approved` is materialized per backend (a missing label under GitHub, a folded
 * field under the ledger) so eligibility stays one predicate — see
 * `claimBlocker`.
 */
export interface QueueItem {
  /** Backend-native id: a GitHub issue number, or the ledger's sequence id. */
  id: string;
  /** The loop that filed it. */
  loop: string;
  title: string;
  /** The full body, including the markers this layer wrote. */
  body: string;
  /** The dedup key, read back from the body's marker. */
  fingerprint: string;
  /** The file the finding is primarily about, when it named one. */
  primaryFile?: string;
  state: QueueItemState;
  /** Labels as the backend holds them, reserved ones included. */
  labels: string[];
  /** Whether the approval gate is clear. */
  approved: boolean;
  /** Who is working it, when claimed. */
  claimedBy?: string;
  /**
   * The queue's OWN record of who holds this item — GitHub assignees.
   *
   * Separate from `claimedBy`, and not a duplicate of it. `claimedBy` is the
   * run id a loop wrote for itself; this is the field a PERSON reads, in the
   * lists, filters and notifications they already use. It is also the only
   * shared record of a claim on an issue a person filed, where a loop may not
   * write prose.
   */
  assignees?: string[];
  /** ISO timestamp of the claim. */
  claimedAt?: string;
  /**
   * The plan whose pipeline a run is advancing on this item, when one is
   * recorded — the `loop-plan:` marker, read back.
   *
   * MATERIALIZED HERE SO NO READER RE-PARSES THE BODY. A person's item carries
   * no markers at all, so for those it is overlaid from local state
   * (`foreign-items.ts`) exactly as `claimedBy` is; a consumer asking "which
   * pipeline is this item's" therefore gets one answer from one field whichever
   * kind of item it holds.
   */
  plan?: string;
  /** ISO timestamp the item was filed. */
  createdAt: string;
  closedAt?: string;
  closeReason?: QueueCloseReason;
  /** A human-openable link, when the backend has one. */
  url?: string;
  /**
   * This loop's own record that it is FINISHED with an item it did not file.
   *
   * Only ever set on a person's item, and never by a backend: it is materialized
   * from local state (`foreign-items.ts`) by the shared layer, because the item
   * itself stays open until GitHub closes it on the merge. Without it the next
   * run re-claims the issue it just fixed, every run, forever.
   */
  handled?: ForeignHandled;
}

// ── body markers (the backend-agnostic record) ───────────

/** Which loop filed an item. */
export const LOOP_MARKER_PATTERN = /<!--\s*loop:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->/;
/** The primary file an item is about. */
export const PRIMARY_FILE_MARKER_PATTERN = /<!--\s*loop-file:\s*([^\s>][^>]*?)\s*-->/;
/** Who claimed an item, and when. Removed again on unclaim. */
export const CLAIM_MARKER_PATTERN = /<!--\s*loop-claim:\s*(\S+)\s+@\s+(\S+)\s*-->/;

/**
 * The plan a run is advancing on this item. Removed again when it is settled.
 *
 * BESIDE THE CLAIM, AND FOR THE SAME REASON. A run holds an item and works a
 * pipeline, and nothing recorded which pipeline: an item is `#1599`, a plan is
 * `state-md-handoff`, and no mapping between them existed. The next run then
 * asked what was in flight, got its answer from a file a prompt had to remember
 * to write, and heard `none` (#1599). The claim is the one record BOTH runs
 * already read, so the association lives on it.
 */
export const PLAN_MARKER_PATTERN = /<!--\s*loop-plan:\s*(\S+)\s*-->/;

/** Every marker pattern, in `stripMarkers` order. */
const MARKER_PATTERNS: readonly RegExp[] = [
  LOOP_MARKER_PATTERN,
  PRIMARY_FILE_MARKER_PATTERN,
  CLAIM_MARKER_PATTERN,
  PLAN_MARKER_PATTERN,
];

/**
 * The longest plan name accepted. A plan is `plan_<name>_v<N>.md` on disk, so
 * the name is one filename segment; anything longer is a sentence.
 */
export const PLAN_NAME_MAX_LENGTH = 100;

/**
 * The plan-name grammar.
 *
 * BOUNDED BY WHAT THE MARKER AND THE FILESYSTEM CAN BOTH CARRY. The marker's
 * capture is `\S+`, exactly like `loop-claim:`, so whitespace cannot round-trip;
 * and a plan name is a FILENAME SEGMENT (`flow/plans/plan_<name>_v1.md`,
 * `flow/plans/<name>.run.json`), so a path separator in one would point a
 * document lookup somewhere nobody asked for. Both are refused rather than
 * sanitized — a plan name silently rewritten is a run recording a handoff to a
 * pipeline that does not exist.
 */
export const PLAN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Why a plan name is unusable, or null when it is fine.
 *
 * An EMPTY name is not a problem here — absence is how a caller says "no plan",
 * and clearing the record is a legitimate act (see `recordPlan`).
 */
export function planNameProblem(plan: string): string | null {
  if (plan.length === 0) return null;
  if (plan.length > PLAN_NAME_MAX_LENGTH) {
    return `malformed plan name '${plan}' — expected at most ${PLAN_NAME_MAX_LENGTH} characters`;
  }
  if (!PLAN_NAME_PATTERN.test(plan)) {
    return `malformed plan name '${plan}' — expected letters, digits, '-', '_' or '.', starting with a letter or digit, with no spaces and no path separators`;
  }
  return null;
}

/** The metadata a composed body carries. */
export interface ItemMarkers {
  loop: string;
  fingerprint: string;
  primaryFile?: string;
}

/**
 * Compose a filed body: the agent's prose, then the machine-readable markers.
 *
 * Any markers already in the prose are stripped first, so re-filing or editing
 * can never leave two fingerprints in one body — an item with two dedup keys
 * matches both and is a duplicate of everything.
 */
export function composeItemBody(prose: string, markers: ItemMarkers): string {
  const clean = stripMarkers(prose);
  const lines = [`<!-- loop: ${markers.loop} -->`, fingerprintMarker(markers.fingerprint)];
  if (markers.primaryFile !== undefined && markers.primaryFile.length > 0) {
    lines.push(`<!-- loop-file: ${markers.primaryFile} -->`);
  }
  return `${clean.length > 0 ? `${clean}\n\n` : ''}${lines.join('\n')}\n`;
}

/** Remove every marker this layer writes, leaving the prose. */
export function stripMarkers(body: string): string {
  let out = stripFingerprintMarker(body);
  for (const pattern of MARKER_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, 'g'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** A claim as recorded in a body — the GitHub backend's only place to put it. */
export interface ClaimMarker {
  owner: string;
  at: string;
}

/** The claim marker as written into a body. */
export function claimMarker(owner: string, at: string): string {
  return `<!-- loop-claim: ${owner} @ ${at} -->`;
}

/** The plan marker as written into a body. */
export function planMarker(plan: string): string {
  return `<!-- loop-plan: ${plan} -->`;
}

/** Read a body's markers back. Every field is optional — a body may carry none. */
export function extractItemMarkers(body: string): {
  loop?: string;
  fingerprint?: string;
  primaryFile?: string;
  claim?: ClaimMarker;
  plan?: string;
} {
  const out: {
    loop?: string;
    fingerprint?: string;
    primaryFile?: string;
    claim?: ClaimMarker;
    plan?: string;
  } = {};
  const loop = body.match(LOOP_MARKER_PATTERN);
  if (loop !== null) out.loop = loop[1];
  const fingerprint = extractFingerprint(body);
  if (fingerprint !== null) out.fingerprint = fingerprint;
  const primaryFile = body.match(PRIMARY_FILE_MARKER_PATTERN);
  if (primaryFile !== null) out.primaryFile = primaryFile[1];
  const claim = body.match(CLAIM_MARKER_PATTERN);
  if (claim !== null) out.claim = { owner: claim[1], at: claim[2] };
  const plan = body.match(PLAN_MARKER_PATTERN);
  if (plan !== null) out.plan = plan[1];
  return out;
}

/** Add or replace a body's claim marker. */
export function withClaimMarker(body: string, owner: string, at: string): string {
  return `${withoutClaimMarker(body)}\n${claimMarker(owner, at)}\n`;
}

/** Remove a body's claim marker, if it has one. */
export function withoutClaimMarker(body: string): string {
  return body.replace(new RegExp(CLAIM_MARKER_PATTERN.source, 'g'), '').trimEnd();
}

/**
 * Add or replace a body's plan marker.
 *
 * SAME SHAPE AS THE CLAIM's, deliberately: strip then append, so a body can
 * never carry two plan markers. Two would mean an item pointing at two
 * pipelines, and whichever the regex found first would decide — the same
 * ambiguity `composeItemBody` refuses for the fingerprint.
 */
export function withPlanMarker(body: string, plan: string): string {
  return `${withoutPlanMarker(body)}\n${planMarker(plan)}\n`;
}

/** Remove a body's plan marker, if it has one. */
export function withoutPlanMarker(body: string): string {
  return body.replace(new RegExp(PLAN_MARKER_PATTERN.source, 'g'), '').trimEnd();
}

/**
 * Append the provenance marker to a body that carries none.
 *
 * DELIBERATELY NOT `composeItemBody`. That one composes a body this system
 * wrote: it strips, re-writes and owns every line. This one edits a body a
 * PERSON wrote, so it appends one comment and touches nothing else — the prose
 * comes back byte-for-byte, trailing whitespace aside. It is the only body edit
 * in the whole layer that is applied to something a loop did not file, and it is
 * reachable from exactly one verb (`adopt`).
 */
export function withLoopMarker(body: string, loop: string): string {
  const clean = body.replace(/\s+$/, '');
  return `${clean.length > 0 ? `${clean}\n\n` : ''}<!-- loop: ${loop} -->\n`;
}

// ── provenance: is this item mine, or someone else's? ────
//
// A consumer met a hand-filed issue, created a repo label and rewrote the
// issue's body so the item would fit its schema, and then worked it. Every
// datum needed to refuse that was already on disk: `file()` writes
// `<!-- loop: <name> -->` into every body it composes. Nothing read it.
//
// So this is a READ of the marker that already exists — no new store, no new
// field, no change to the fingerprint. An item's body says who filed it; a body
// that says nothing was filed by a person.

/**
 * Which loop filed an item, as its BODY says — '' when no loop did.
 *
 * The BODY, not `QueueItem.loop`. They agree for everything either backend
 * filed (GitHub derives the field FROM this marker; the ledger writes both from
 * one draft), and where they can disagree — a hand-edited ledger line, a field
 * a future backend synthesizes — the marker is the one a person can see and a
 * person wrote. Provenance has to be answerable from the item alone.
 */
export function filedByLoop(item: QueueItem): string {
  return extractItemMarkers(item.body).loop ?? '';
}

/** How a person adopts an item, named in every refusal that turns one down. */
export function adoptHint(item: QueueItem, loop: string | undefined): string {
  return `a person adopts it with \`planflow-ai loop adopt --loop ${loop ?? '<name>'} --id ${item.id} --detail "<why>"\` — no beat may`;
}

/**
 * Why a loop verb may not touch `item`, or null when a loop filed it.
 *
 * THE RULE THE INCIDENT NEEDED. A loop may read anything; it may WRITE only to
 * items a loop filed. Relabelling, rewriting a body, closing, approving,
 * claiming — every one of them is a change to something a person wrote and
 * still owns, and reshaping someone's item so it fits a schema is a worse
 * outcome than skipping it entirely.
 *
 * The refusal NAMES THE ITEM AND THE WAY OUT. A refusal that only objects
 * teaches a run to try something else; this one says what happened, why, and
 * the one act — a person's — that changes the answer.
 */
export function humanWorkBlocker(
  item: QueueItem,
  verb: string,
  loop?: string,
): string | null {
  if (filedByLoop(item).length > 0) return null;
  return `item ${item.id} carries no loop marker — it was filed by a person, and \`${verb}\` would change someone else's item; ${adoptHint(item, loop)}`;
}

/**
 * Why `loop` may not work `item`, or null when `loop` filed it.
 *
 * Two different failures, and they are not the same refusal: a HUMAN's item may
 * become a loop's by an explicit act of adoption, and ANOTHER LOOP's item never
 * does — re-pointing an item one loop already filed is the same rewriting this
 * rule exists to stop, so that message offers no way out because there is none.
 */
export function provenanceBlocker(
  item: QueueItem,
  verb: string,
  loop?: string,
): string | null {
  const human = humanWorkBlocker(item, verb, loop);
  if (human !== null) return human;
  const owner = filedByLoop(item);
  if (loop !== undefined && owner !== loop) {
    return `item ${item.id} was filed by loop '${owner}', not '${loop}' — a loop works only its own items`;
  }
  return null;
}

/** Whether `loop` filed `item` and may therefore work it. */
export function isOwnWork(item: QueueItem, loop?: string): boolean {
  return provenanceBlocker(item, 'claim', loop) === null;
}

/** Whether `item` is a person's — the one thing a loop may not write to. */
export function isPersonsItem(item: QueueItem): boolean {
  return filedByLoop(item).length === 0;
}

/**
 * Why `loop` may not WORK `item` under `engine`, or null when it may.
 *
 * THE RULE THAT WAS WRONG, AND IS NOW ONE LINE. Provenance answers "whose item
 * is this", and that is the right question for a MUTATION and the wrong one for
 * a consumer: a loop whose job is draining a queue does not get to care who put
 * the work in it. Refusing on provenance made `fix` — pointed at a repo full of
 * hand-filed issues — report `0 claimable` and skip forever.
 *
 * So a `consumer` is not gated here at all. A `producer` keeps the old rule,
 * which costs it nothing (it files and never claims) and keeps the refusal alive
 * for anything that reaches this path without saying which engine it is: absence
 * means the caller did not say, and the strict answer is the safe default.
 *
 * ONE DEFINITION, TWO CALLERS — the backend's verbs and `loop merge`'s
 * pre-flight check both come here rather than each deciding (allowed-pattern #14).
 */
export function engineWorkBlocker(
  engine: LoopEngine | undefined,
  item: QueueItem,
  verb: string,
  loop?: string,
): string | null {
  if (engine === 'consumer') return null;
  return provenanceBlocker(item, verb, loop);
}

/** How a person makes a handled item workable again, named in the refusal. */
export function reworkHint(item: QueueItem, loop: string | undefined): string {
  return `a person works it again with \`planflow-ai loop rework --loop ${loop ?? '<name>'} --id ${item.id} --detail "<why>"\``;
}

// ── eligibility: ONE predicate, both backends ────────────

/**
 * Why an item cannot be claimed, or null when it can.
 *
 * Reasons are ordered from most to least fundamental, and every one is a
 * complete sentence a run log or a CLI refusal can print verbatim — a skipped
 * item must always be able to say why it was skipped.
 *
 * A claim by the SAME owner is re-entrant, mirroring the loop lock: a run that
 * re-enters the gate after a checkpoint must not be locked out of the item it
 * is already working.
 */
export function claimBlocker(item: QueueItem, owner?: string, loop?: string): string | null {
  if (item.state !== 'open') {
    return `item ${item.id} is closed`;
  }
  // A HANDLED ITEM IS STILL OPEN, and that is the whole problem this answers: a
  // person's issue is closed by GitHub when the pull request merges, so between
  // the fix and the merge it looks exactly like untouched work. Without this the
  // next run claims it again and re-does the job — the same "nothing happens"
  // failure the provenance rule caused, wearing a different costume.
  if (item.handled !== undefined) {
    const detail = item.handled.detail.length > 0 ? ` — ${item.handled.detail}` : '';
    return `item ${item.id} was already handled by this loop at ${item.handled.at}${detail}; ${reworkHint(item, loop)}`;
  }
  if (!item.approved) {
    return `item ${item.id} is awaiting approval (${APPROVAL_LABEL})`;
  }
  if (item.labels.includes(PARKED_LABEL)) {
    return `item ${item.id} is parked (${PARKED_LABEL})`;
  }
  if (item.claimedBy !== undefined && item.claimedBy !== owner) {
    // A DERIVED CLAIMANT NEEDS THE LONGER SENTENCE. `run-<ts>-<n>` is
    // self-evidently another run; `@<login>` is the reader's OWN GitHub account
    // seen from a second machine or a second session, and "already claimed by
    // '@you'" reads like a bug unless it says where the claim lives and how to
    // let go of it.
    if (isForeignClaimant(item.claimedBy)) {
      return `item ${item.id} is held by '${item.claimedBy}' on the queue (${CLAIMED_LABEL} + assignee) — another run has it; release it with \`planflow-ai loop unclaim --loop ${loop ?? '<name>'} --id ${item.id}\``;
    }
    return `item ${item.id} is already claimed by '${item.claimedBy}'`;
  }
  return null;
}

/** Whether an item may be claimed right now by `owner`. */
export function isClaimable(item: QueueItem, owner?: string, loop?: string): boolean {
  return claimBlocker(item, owner, loop) === null;
}

/**
 * The open items `owner` is still holding.
 *
 * ONE definition of "this run has not let go", used by both surfaces that care:
 * the run record's honest-ending check and anything reporting a stuck queue. A
 * closed item is never held — closing IS the release.
 */
export function heldClaims(items: readonly QueueItem[], owner: string): QueueItem[] {
  return items.filter((item) => item.state === 'open' && item.claimedBy === owner);
}

/** An open claim whose holder has not touched it since well before now. */
export interface AbandonedClaim {
  id: string;
  /** Who holds it — the run that is, on the evidence, not coming back. */
  owner: string;
  claimedAt: string;
  /** How long the claim has gone untouched, in milliseconds. */
  ageMs: number;
}

/**
 * Open claims older than `ttlMs` — the item a run took and never ended.
 *
 * A REPORT, never an action. Nothing here unclaims anything: the whole failure
 * this answers is that a stuck item is INVISIBLE, and silently reassigning it
 * would replace one invisible state with another. The threshold is the loop's
 * own lock TTL, because past it the holding run's lock has expired — the loop
 * has already concluded that run is gone, and this says which item went with
 * it.
 *
 * A claim with no readable timestamp is NOT reported: the age is the whole
 * claim being made, and a report that cries wolf on an unparseable field is a
 * report people learn to skip. Ordered oldest first — the most abandoned item
 * is the one worth looking at.
 */
export function abandonedClaims(
  items: readonly QueueItem[],
  ttlMs: number,
  now: number,
): AbandonedClaim[] {
  const out: AbandonedClaim[] = [];
  for (const item of items) {
    if (item.state !== 'open' || item.claimedBy === undefined || item.claimedAt === undefined) {
      continue;
    }
    const claimedAt = Date.parse(item.claimedAt);
    if (Number.isNaN(claimedAt)) continue;
    const ageMs = now - claimedAt;
    if (ageMs <= ttlMs) continue;
    out.push({ id: item.id, owner: item.claimedBy, claimedAt: item.claimedAt, ageMs });
  }
  return out.sort((a, b) => {
    if (a.ageMs !== b.ageMs) return b.ageMs - a.ageMs;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

/**
 * Deterministic claim order: oldest first, ties broken by id.
 *
 * Oldest-first on purpose — a queue that hands back its newest item starves its
 * backlog, and the oldest item is the one whose finding has had the longest
 * chance to become wrong.
 */
export function claimOrder(items: readonly QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

/** The first claimable item in claim order, or null when none is. */
export function firstClaimable(items: readonly QueueItem[], owner?: string): QueueItem | null {
  return claimOrder(items).find((item) => isClaimable(item, owner)) ?? null;
}

// ── the cap ──────────────────────────────────────────────

/**
 * Whether filing is refused by the open-item cap, and why.
 *
 * The cap counts a LOOP's own open items, not the queue's. Two producers
 * sharing a ledger must not starve each other, and a consumer's backlog is not
 * evidence that the producer should stop looking.
 */
export function capRefusal(openCount: number, maxOpenIssues: number): string | null {
  if (openCount < maxOpenIssues) return null;
  return `open-item cap reached — ${openCount} open, max ${maxOpenIssues}`;
}

// ── evidence (the close gate) ────────────────────────────

/**
 * Whether one evidence record is well-formed, or why it is not.
 *
 * Exported because the merge gate (`push-guard.ts`) raises the same bar by one
 * notch and must not carry a second definition of "a well-formed evidence
 * record" — one shape, one validator (allowed-pattern #14).
 */
export function evidenceCommandProblem(entry: unknown, index: number): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return `evidence entry #${index + 1} is not a {command, exitCode} record`;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.command !== 'string' || record.command.trim().length === 0) {
    return `evidence entry #${index + 1} has no 'command'`;
  }
  if (typeof record.exitCode !== 'number' || !Number.isInteger(record.exitCode)) {
    return `evidence for '${record.command}' has no captured integer 'exitCode'`;
  }
  return null;
}

/**
 * Validate a close's evidence against its reason. Returns null when the close
 * may proceed, otherwise the one-line reason it may not.
 *
 * `done` — at least one command record, every one of them exited 0. Recording a
 * failing command and calling the work done is exactly the claim this gate
 * exists to reject; if a run legitimately failed and was then fixed, the
 * evidence is the passing re-run, not the history.
 *
 * `wontfix` / `duplicate` — no commands are required, because no command can
 * prove a decision NOT to do something. What IS required is a written reason:
 * these closes are permanent memory (a wontfix is "never file this again"), and
 * an unexplained one is indistinguishable from a loop giving up. They are also
 * the one path that must never be used to claim a fix, which is why `done` is
 * the only reason whose meaning is "it works now".
 */
export function validateCloseEvidence(
  reason: QueueCloseReason,
  evidence: CloseEvidence | undefined,
  detail?: string,
): string | null {
  const commands = evidence?.commands;
  if (commands !== undefined) {
    if (!Array.isArray(commands)) {
      return "evidence 'commands' must be an array of {command, exitCode} records";
    }
    for (let index = 0; index < commands.length; index += 1) {
      const problem = evidenceCommandProblem(commands[index], index);
      if (problem !== null) return problem;
    }
  }

  if (reason === 'done') {
    if (commands === undefined || commands.length === 0) {
      return "a 'done' close requires machine-checkable evidence — at least one {command, exitCode} record, never prose alone";
    }
    const failed = commands.find((entry) => entry.exitCode !== 0);
    if (failed !== undefined) {
      return `evidence command '${failed.command}' exited ${failed.exitCode} — a 'done' close requires every recorded command to have exited 0`;
    }
    return null;
  }

  if (detail === undefined || detail.trim().length === 0) {
    return `a '${reason}' close requires a written reason — it is permanent memory, and an unexplained one reads as a loop giving up`;
  }
  return null;
}

// ── the backend contract ─────────────────────────────────

/** What a caller supplies to file a finding. The fingerprint is NOT one of them. */
export interface FileItemInput {
  /** The loop filing it. */
  loop: string;
  title: string;
  /** The prose body. Markers are appended by the backend, never by the caller. */
  body: string;
  /** The file the finding is primarily about, when it has one. */
  primaryFile?: string;
  /** Extra labels beyond the reserved ones (e.g. the directive's queue label). */
  labels?: string[];
  /**
   * The area this loop is pointed at right now (`topic:` in the directive).
   * Merged into the labels below rather than passed as one, so no caller can
   * file under a topic that skipped validation.
   */
  topic?: string;
  /** Whether the item starts behind the approval gate. */
  needsApproval?: boolean;
  /** The directive's open-item cap — enforced here, never by a prompt. */
  maxOpenIssues: number;
}

/**
 * The outcome of a file attempt.
 *
 * `duplicate` is an ORDINARY outcome, not an error: a producer re-finding a
 * known problem is the system working. `refused` is the cap (and malformed
 * input), which the CLI layer turns into one `loop refused:` line and exit 1.
 */
export type FileItemResult =
  | { status: 'filed'; item: QueueItem }
  | { status: 'duplicate'; item: QueueItem }
  | { status: 'refused'; reason: string };

/** What a caller supplies to claim work. */
export interface ClaimInput {
  /** Who is claiming — a run/run id, recorded on the item. */
  owner: string;
  /** Restrict to one loop's items. Absent claims from the whole queue. */
  loop?: string;
  /** Claim this specific item. Absent claims the oldest eligible one. */
  id?: string;
  /**
   * Items this run has already passed over — hand back the next one instead.
   *
   * THE QUEUE HEAD IS PERMANENT WITHOUT THIS. Claim order is `createdAt`
   * ascending, so the oldest claimable item is served to every sweeping claim
   * and releasing it puts it straight back at the front. A run that legitimately
   * cannot work that item — it needs the pipeline, and another run holds the
   * machinery — had nothing to ask for except the same item again, so its only
   * readable option was to stop. Two concurrent runs did exactly that with 27
   * other items claimable behind the one they could not take.
   *
   * Passing over is not judgment about the ITEM: it stays claimable, keeps its
   * place at the head, and the next run gets served it first. It is this run
   * saying "not me, not now", and it lasts only as long as the call.
   */
  skip?: readonly string[];
}

/**
 * The outcome of a claim attempt. `empty` is a quiet queue, not a failure, and
 * `lost` is another run getting there first — also not a failure.
 *
 * `lost` is its own status rather than a `refused`: a refusal means this run may
 * not work the item, and the answer is to stop. Losing a race means the item is
 * fine and somebody else has it, and the answer is to take the next one. A
 * caller that could not tell them apart would halt a run over a rival's success.
 */
export type ClaimResult =
  | { status: 'claimed'; item: QueueItem }
  | { status: 'lost'; reason: string; item: QueueItem }
  | { status: 'empty'; reason: string }
  | { status: 'refused'; reason: string };

/** What a caller supplies to close an item. */
export interface CloseInput {
  id: string;
  reason: QueueCloseReason;
  /** Who is closing. When the item is claimed, only its claimant may close it. */
  owner?: string;
  /** The loop closing it — checked against the item's provenance. */
  loop?: string;
  /** Written reason — required for `wontfix` and `duplicate`. */
  detail?: string;
  /** Captured commands and exit codes — required for `done`. */
  evidence?: CloseEvidence;
}

/**
 * The outcome of a close attempt.
 *
 * `handled` is what a close of a PERSON'S item comes back as, and the different
 * word is the whole point: nothing was written on their issue except dropping
 * the `in-progress` label, the issue is still open, and GitHub closes it when the
 * pull request carrying `Closes #<n>` merges. Reporting that as `closed` would
 * be the loop claiming an act it deliberately did not perform.
 */
export type CloseResult =
  | { status: 'closed'; item: QueueItem }
  | { status: 'handled'; item: QueueItem; note: string }
  | { status: 'refused'; reason: string };

/**
 * The line a `handled` outcome carries — what was written, what was not, and who
 * closes the issue.
 */
export function handledCloseNote(item: QueueItem): string {
  return `item ${item.id} was filed by a person — nothing was written on it beyond removing the '${CLAIMED_LABEL}' label, and it stays open until the pull request carrying \`Closes #${item.id}\` merges`;
}

/**
 * What the handled record says happened, in one line: the close reason, plus
 * whatever the caller wrote or captured. A record that only said "handled" would
 * make the refusal it later produces unreadable.
 */
export function handledDetail(input: Pick<CloseInput, 'reason' | 'detail' | 'evidence'>): string {
  const written = input.detail?.trim() ?? '';
  if (written.length > 0) return `${input.reason} — ${written}`;
  const summary = input.evidence?.summary?.trim() ?? '';
  return summary.length > 0 ? `${input.reason} — ${summary}` : input.reason;
}

/** The line a merge recorded against a person's item carries. */
export function handledMergeNote(item: QueueItem): string {
  return `item ${item.id} was filed by a person — the merge was recorded locally, not on the item, and the issue closes when the pull request carrying \`Closes #${item.id}\` merges`;
}

/**
 * What a caller supplies to record a merge on the item it landed.
 *
 * The merge itself happens at the git seam — this is only the RECORD of it, and
 * it is deliberately not a close: landing the branch and settling the item are
 * two decisions, and folding them into one would make "why is this closed"
 * answerable only by "something merged".
 */
export interface MergeRecordInput {
  id: string;
  /** The loop that merged. Provenance is checked against it. */
  loop?: string;
  /** The run that merged, when the caller has one. */
  owner?: string;
  /** The head branch that landed. */
  branch: string;
  /** The pull request that carried it, as the caller resolved it. */
  pr?: { number: string; url: string };
  /** The captured evidence the merge was gated on — stored verbatim. */
  evidence: CloseEvidence;
}

/**
 * The outcome of recording a merge.
 *
 * `note` is present only when the record went LOCAL rather than onto the item —
 * a person's issue takes no merge comment, so the caller is told plainly where
 * the record went and what closes the issue.
 */
export type MergeRecordResult =
  | { status: 'recorded'; item: QueueItem; note?: string }
  | { status: 'refused'; reason: string };

/**
 * One line naming what landed, shared by both backends so a merge reads the
 * same whether the item lives in a repo or a ledger.
 */
export function mergeSummary(input: MergeRecordInput): string {
  const pr = input.pr === undefined ? '' : ` via PR #${input.pr.number} (${input.pr.url})`;
  return `merged '${input.branch}'${pr}`;
}

/**
 * What a caller supplies to record which plan a run is advancing on an item.
 *
 * A RUN'S ACT, unlike `adopt` and `rework`: the run entering a pipeline stage is
 * exactly the thing that knows the plan's name, and it already holds the item.
 * `owner` is checked against the claim for the same reason `close` checks it —
 * a run that lost the item must not redirect the pipeline the run that took it
 * is advancing.
 */
export interface PlanRecordInput {
  id: string;
  /**
   * The plan being advanced. Absent or empty CLEARS the record — one verb for
   * both directions, mirroring `setClaim(id, null)`, so "which plan" has exactly
   * one writer whichever way it is being changed.
   */
  plan?: string;
  /** The loop recording it — checked against the item's provenance. */
  loop?: string;
  /** The run recording it. When the item is claimed, only its claimant may. */
  owner?: string;
}

/**
 * The outcome of recording a plan. `plan` is what the item now carries — '' when
 * the record was cleared.
 */
export type PlanRecordResult =
  | { status: 'recorded'; item: QueueItem; plan: string }
  | { status: 'refused'; reason: string };

/** The outcome of an approve attempt. Repeating one is success, not an error. */
export type ApproveResult =
  | { status: 'approved'; item: QueueItem; alreadyApproved: boolean }
  | { status: 'refused'; reason: string };

/** The outcome of an unclaim. Unclaiming what nobody holds is success. */
export type UnclaimResult =
  | {
      status: 'unclaimed';
      item: QueueItem;
      wasClaimed: boolean;
      /**
       * The released claim belonged to another run whose lock had already
       * expired. Surfaced so the caller can SAY it took something over — a
       * release that reads like an ordinary one is how a stuck queue stayed
       * invisible in the first place.
       */
      tookOverAbandoned?: boolean;
    }
  | { status: 'refused'; reason: string };

/**
 * What a person supplies to adopt an item into a loop.
 *
 * There is no `owner` and no run id: adoption is not something a run does, so
 * the record it leaves is the marker on the item and the line the CLI writes to
 * the run log — both attributable to whoever ran the command.
 */
export interface AdoptInput {
  id: string;
  /** The loop taking it on. */
  loop: string;
  /** Why. Required by the CLI — an adoption nobody explained is a rubber stamp. */
  detail?: string;
}

/** The outcome of an adopt attempt. */
export type AdoptResult =
  | { status: 'adopted'; item: QueueItem }
  | { status: 'refused'; reason: string };

/**
 * What a person supplies to make a handled item workable again.
 *
 * A PERSON'S ACT, like `adopt`, and for the same reason: the handled record is
 * what stops a loop re-doing work it already did, so a run able to clear its own
 * record would be a run able to talk itself back into an infinite loop. The CLI
 * refuses this verb while a run holds the loop.
 */
export interface ReworkInput {
  id: string;
  /** The loop that will work it again. */
  loop: string;
  /** Why — required by the CLI: "the fix did not hold" is the whole record. */
  detail?: string;
}

/** The outcome of a rework attempt. */
export type ReworkResult =
  | { status: 'reworked'; item: QueueItem }
  | { status: 'refused'; reason: string };

/** Which items a read is about. */
export interface QueueQuery {
  /** `all` reads open AND closed — closed items are the queue's memory. */
  state?: QueueItemState | 'all';
  /** Restrict to one loop. */
  loop?: string;
  /** Narrow to one fingerprint — backends may push this down into a search. */
  fingerprint?: string;
}

/**
 * ONE REPORT, ONE ROUND TRIP PER DISTINCT READ.
 *
 * A report verb (`loop status`, `loop list`) walks every loop in the project and
 * opens a backend per row, and two loops that name the same `repo:` are two
 * backends asking one remote the identical question. `loop status` on this very
 * repo did that four times for two loops; a project with three loops on one repo
 * did it six. None of those calls could tell each other apart, and every one of
 * them was a network round trip with a 30s ceiling.
 *
 * SO THE FETCH IS MEMOIZED, NOT THE ANSWER. What is remembered is the raw
 * response text keyed by the exact request that produced it — so a caller that
 * asks a DIFFERENT question still asks the remote, and every caller parses the
 * response into its own objects rather than sharing (and possibly aliasing) one
 * decoded array. Identical request in, byte-identical response out: no field a
 * verb derives can change because a sibling row asked first.
 *
 * AND IT IS A SNAPSHOT, WHICH IS THE POINT, NOT THE SIDE EFFECT. `runStatus`
 * already reads the loop state ONCE and the instruction store ONCE for the whole
 * report, for a stated reason: "a second open between two rows could report a
 * count that changed underneath the first". The queue was the third thing read
 * per row and the only one still re-read. With the session it is read once too,
 * so two rows on one repo can no longer describe two different moments — the
 * report is a snapshot of an instant that actually existed.
 *
 * SUCCESSES ONLY. A failed fetch is deliberately NOT remembered: rows fail soft
 * one at a time (`statusRow`, `listRow`), and a remembered failure would let one
 * loop's transient `gh` hiccup blank every sibling loop that shares its repo —
 * turning the one fail-soft guarantee this feature has into a shared fate.
 *
 * SCOPED BY CONSTRUCTION. A session is created by the verb that owns the report
 * and dies with it. There is no process-wide cache and no invalidation rule to
 * get wrong, because the only paths that take a session are read-only ones — a
 * verb that WRITES to the queue simply never makes one, and so cannot read a
 * value its own write has already invalidated.
 */
export class QueueReadSession {
  private readonly responses = new Map<string, string>();
  private fetched = 0;

  /**
   * The remembered response for `key`, or `fetch()`'s, remembered.
   *
   * `key` must identify the request completely — for a remote backend that is
   * the argv, repo included, so two repos can never collide in one session.
   */
  read(key: string, fetch: () => string): string {
    const memo = this.responses.get(key);
    if (memo !== undefined) return memo;
    const response = fetch();
    this.fetched += 1;
    this.responses.set(key, response);
    return response;
  }

  /**
   * How many fetches actually reached the store. The reduction this session
   * exists for is only provable if it is countable, so tests assert on it.
   */
  get fetches(): number {
    return this.fetched;
  }
}

/** The counts a run reports and the cap is checked against. */
export interface QueueCounts {
  open: number;
  closed: number;
  claimed: number;
  awaitingApproval: number;
  parked: number;
  /** Open items that could be claimed right now. */
  claimable: number;
}

/** The verbs. Every caller in the system depends on this and nothing else. */
export interface LoopQueueBackend {
  /** Which backend this is — for reporting, never for branching in a caller. */
  readonly kind: LoopQueueKind;
  /**
   * Every item matching a query — the READ half every reporting surface needs
   * (`loop next`'s known fingerprints, `loop status`, the panel). Read-only, so
   * it routes around no invariant: nothing here files, claims or closes.
   */
  list(query?: QueueQuery): QueueItem[];
  /**
   * One item by id, scoped the way `list` would scope it — one backend read,
   * never a page scan, so an item older than a list page is still found (#1636).
   */
  byId(id: string, loop?: string): QueueItem | null;
  /** The item carrying this fingerprint, open OR closed, else null. */
  exists(fingerprint: string): QueueItem | null;
  /** File a finding, subject to dedup and the cap. */
  file(input: FileItemInput): FileItemResult;
  /** Claim work, subject to the eligibility AND provenance rules. */
  claim(input: ClaimInput): ClaimResult;
  /** Take a person's item into a loop. Never reachable from `claim`. */
  adopt(input: AdoptInput): AdoptResult;
  /** Clear the handled record on a person's item. Never reachable from a run. */
  rework(input: ReworkInput): ReworkResult;
  /** Record (or clear) which plan's pipeline a run is advancing on an item. */
  recordPlan(input: PlanRecordInput): PlanRecordResult;
  /** Close an item, subject to the evidence gate. */
  close(input: CloseInput): CloseResult;
  /** Record on the item that its branch landed, with the evidence that landed it. */
  recordMerge(input: MergeRecordInput): MergeRecordResult;
  /** Clear the approval gate on one item. */
  approve(id: string, owner?: string): ApproveResult;
  /** Release a claim, returning the item to the queue. */
  unclaim(id: string, owner?: string, loop?: string, ttlMs?: number): UnclaimResult;
  /** Count items, optionally scoped to one loop. */
  count(query?: QueueQuery): QueueCounts;
}

/** What a backend needs to materialize a new item. */
export interface ItemDraft {
  loop: string;
  title: string;
  /** The composed body, markers already written. */
  body: string;
  fingerprint: string;
  primaryFile?: string;
  labels: string[];
  approved: boolean;
  /**
   * The validated topic, when the loop has one. It is ALREADY in `labels`; it
   * is named separately only so a backend that has to make a label exist knows
   * which of them it may create (GitHub) — every other backend ignores it.
   */
  topic?: string;
}

/**
 * The shared half of every backend.
 *
 * A backend supplies eight primitives; this class supplies every verb, and
 * with them every invariant. The split is deliberate and is the whole reason
 * the class exists: nothing a backend author writes can skip the cap, the
 * dedup check, the eligibility rules or the evidence gate, because a backend
 * never implements the verbs that enforce them.
 */
export abstract class LoopQueueBackendBase implements LoopQueueBackend {
  abstract readonly kind: LoopQueueKind;

  /**
   * Which engine is asking. Threaded from the DIRECTIVE by `openQueue`, never
   * inferred from a loop's name: a backend that guessed "this one sounds like a
   * consumer" would be one rename away from handing a producer the whole queue.
   *
   * Absent means the caller did not say, and the strict rule applies — see
   * `engineWorkBlocker`.
   */
  protected readonly engine: LoopEngine | undefined;

  /** What this loop knows about items it did not file (`foreign-items.ts`). */
  protected readonly local: ForeignItemState;

  /**
   * @param clock injected so filed/claimed/closed timestamps are provable
   *   without sleeping — the Phase 1 convention.
   * @param engine the directive's engine, when the caller has one.
   * @param local the local record for items no loop filed. A backend built
   *   without one gets an in-process store: correct for a single call, and every
   *   CLI path supplies the file-backed one.
   */
  constructor(
    protected readonly clock: () => number = Date.now,
    engine?: LoopEngine,
    local?: ForeignItemState,
  ) {
    this.engine = engine;
    this.local = local ?? createMemoryForeignItemState();
  }

  /** Current time as the ISO string every item field stores. */
  protected nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  // ── primitives a backend supplies ──

  /**
   * Every item matching a query. `state` defaults to `all`: a backend that
   * quietly returned only open items would make dedup forget every wontfix,
   * which is the one thing the queue must never forget.
   */
  protected abstract listItems(query: QueueQuery): QueueItem[];

  /**
   * ONE item by id, or null when the queue genuinely has no such item.
   *
   * A separate primitive from `listItems`, and not an optimization detail: a
   * list read is a PAGE (GitHub serves the newest `limit`), so answering "does
   * item N exist" from it says "no" for any item older than the page — a verb
   * pointed at an old item refused it while `gh issue view` found it fine
   * (#1636). Null means "asked, and it is not there"; a queue that cannot be
   * ASKED must throw instead, for the same reason `listItems` must — unreachable
   * and empty are opposite facts.
   */
  protected abstract fetchItem(id: string): QueueItem | null;

  /** Materialize a new item. Called only after dedup and the cap have passed. */
  protected abstract createItem(draft: ItemDraft): QueueItem;

  /** Set or clear an item's claim. `owner` null unclaims. */
  protected abstract setClaim(id: string, owner: string | null): QueueItem;

  /**
   * Set or clear the plan recorded on an item. `plan` null clears it.
   *
   * NEVER CALLED FOR A PERSON'S ITEM. The shared layer diverts that case into a
   * local record before it gets here, for the same reason it diverts the claim:
   * the only write a loop may make on someone else's issue is the `in-progress`
   * label, and a body marker is prose.
   */
  protected abstract setPlan(id: string, plan: string | null): QueueItem;

  /** Close an item, recording the reason and the evidence. */
  protected abstract setClosed(
    id: string,
    reason: QueueCloseReason,
    detail: string | undefined,
    evidence: CloseEvidence | undefined,
  ): QueueItem;

  /**
   * Clear an item's approval gate, recording who cleared it where the backend
   * has somewhere to put that (the ledger does; GitHub attributes the label
   * removal to the `gh` actor itself).
   */
  protected abstract setApproved(id: string, owner?: string): QueueItem;

  /**
   * Write the adopted body — the ONE body write in the whole layer that lands
   * on an item a loop did not file.
   *
   * Named for what it is rather than a general `setBody`, deliberately. A
   * backend that exposed "write any body" would make body rewriting an ordinary
   * capability, and the incident this phase answers was exactly a body rewritten
   * because it was possible to. There is no other primitive that writes prose,
   * so the only way to a person's item is through `adopt`.
   *
   * It adds NO LABEL and creates no repo configuration: the item is taken on as
   * it stands, and a loop that needed a repo to be reconfigured before it could
   * work an item is a loop that should have skipped the item.
   */
  protected abstract setAdopted(id: string, loop: string, body: string): QueueItem;

  /**
   * Write the merge record — a note on the item saying which branch landed and
   * on what evidence.
   *
   * ADDS NOTHING TO THE ITEM'S STATE. It does not close, label, unclaim or
   * reopen: a merged branch and a settled item are two different facts, and a
   * primitive that quietly did both would make `close`'s evidence gate skippable
   * by merging instead.
   */
  protected abstract setMerged(id: string, input: MergeRecordInput): QueueItem;

  // ── the read path (ONE place, so no verb sees a different queue) ──

  /**
   * The query a backend is actually asked, given who is asking.
   *
   * `loop` means "filed by this loop", which is the right slice for a PRODUCER
   * (its cap, its dedup, its findings) and the wrong one for a CONSUMER: a
   * consumer's queue is the queue. Keeping the filter for both is the second
   * half of the shipped defect — `fix` asked for `{loop: 'fix'}`, the backend
   * answered with the items `fix` had filed (none, it never files), and every
   * surface reported an empty backlog on a repo full of work.
   *
   * `file()`'s cap deliberately does NOT come through here: it counts one loop's
   * own open items by definition, so it reads `listItems` directly.
   */
  protected scopeQuery(query: QueueQuery): QueueQuery {
    if (this.engine !== 'consumer' || query.loop === undefined) return query;
    const widened: QueueQuery = { ...query };
    delete widened.loop;
    return widened;
  }

  /**
   * Overlay what this loop knows LOCALLY about an item it did not file.
   *
   * Only a person's item is touched, and only with facts that have nowhere
   * remote to live: who is working it (the body is off limits), which plan's
   * pipeline they are advancing (likewise a body marker), and whether this loop
   * already handled it (the issue stays open until the merge closes it).
   * Materializing them HERE rather than in each backend is what makes
   * `claimBlocker` and `heldClaims` one predicate over both stores — and what
   * lets a reader of `item.plan` ignore whose item it is.
   */
  protected withLocalState(
    item: QueueItem,
    // A caller holding many items passes ONE snapshot for all of them (#1637);
    // a single-item caller lets the default take its own, one read per verb.
    snapshot: ReadonlyMap<string, ForeignItemRecord> = this.local.snapshot(),
  ): QueueItem {
    if (!isPersonsItem(item)) return item;
    const record = snapshot.get(foreignKey(this.kind, item.id));
    if (record === undefined) return item;
    const overlaid: QueueItem = { ...item };
    if (record.claim !== undefined) {
      overlaid.claimedBy = record.claim.owner;
      overlaid.claimedAt = record.claim.at;
    }
    if (record.plan !== undefined) overlaid.plan = record.plan.name;
    if (record.handled !== undefined) overlaid.handled = record.handled;
    return overlaid;
  }

  /** Every item a verb sees: the backend's answer, scoped and overlaid. */
  protected readItems(query: QueueQuery): QueueItem[] {
    const items = this.listItems(this.scopeQuery(query));
    // ONE snapshot for the whole query — the read-once contract the interface
    // promises (#1637). Taken lazily on the first person-filed item, so a queue
    // of only loop-filed items keeps costing zero snapshot reads; with N
    // person-filed items the old per-item default cost N full file reads+folds
    // per list/count/claim sweep, against an append-only file that only grows.
    let snapshot: ReadonlyMap<string, ForeignItemRecord> | undefined;
    return items.map((item) => {
      if (!isPersonsItem(item)) return item;
      snapshot ??= this.local.snapshot();
      return this.withLocalState(item, snapshot);
    });
  }

  /** Append one local event about a person's item. */
  protected recordLocal(
    id: string,
    loop: string,
    event: ForeignItemEventName,
    extra: { owner?: string; detail?: string; plan?: string } = {},
  ): void {
    this.local.append({
      ts: this.nowIso(),
      backend: this.kind,
      id,
      loop,
      event,
      ...(extra.owner === undefined ? {} : { owner: extra.owner }),
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
      ...(extra.plan === undefined ? {} : { plan: extra.plan }),
    });
  }

  // ── the verbs ──

  /** One item by id, or null — one backend read, never a page scan (#1636). */
  protected findById(id: string): QueueItem | null {
    const item = this.fetchItem(id);
    return item === null ? null : this.withLocalState(item);
  }

  /**
   * The public one-item read, scoped the way `list` would have scoped it.
   *
   * `loop` narrows exactly as `scopeQuery` narrows a list — a producer sees only
   * its own items, a consumer's queue is the queue — so the command layer's
   * "read one item" sites cannot re-derive that rule differently (allowed-pattern
   * #14). They used to be `list({state:'all'}).find(...)`, which paid a full page
   * read per verb and could not see past the newest page at all (#1636).
   */
  byId(id: string, loop?: string): QueueItem | null {
    const item = this.findById(id);
    if (item === null) return null;
    const scoped = this.scopeQuery(loop === undefined ? {} : { loop });
    return scoped.loop !== undefined && item.loop !== scoped.loop ? null : item;
  }

  list(query: QueueQuery = {}): QueueItem[] {
    return this.readItems(query);
  }

  exists(fingerprint: string): QueueItem | null {
    // The backend may narrow with `fingerprint` (GitHub pushes it into a
    // search), but the ANSWER is always the exact marker check — a fuzzy search
    // narrows the candidates and never decides.
    const candidates = this.readItems({ state: 'all', fingerprint });
    return candidates.find((item) => bodyHasFingerprint(item.body, fingerprint)) ?? null;
  }

  file(input: FileItemInput): FileItemResult {
    if (input.loop.trim().length === 0) {
      return { status: 'refused', reason: 'a filed item requires a loop' };
    }
    if (input.title.trim().length === 0) {
      return { status: 'refused', reason: 'a filed item requires a title' };
    }
    if (!Number.isInteger(input.maxOpenIssues) || input.maxOpenIssues <= 0) {
      return {
        status: 'refused',
        reason: `malformed cap '${String(input.maxOpenIssues)}' — expected a positive integer`,
      };
    }
    // The directive parser validates a topic when it reads one, but the rule
    // lives HERE too rather than only there — a programmatic caller building a
    // `FileItemInput` by hand must not be able to reach a backend's label
    // creation with a topic no grammar ever looked at (allowed-pattern #14).
    const topic = input.topic?.trim() ?? '';
    const topicIssue = topicProblem(topic);
    if (topicIssue !== null) {
      return { status: 'refused', reason: topicIssue };
    }

    const fingerprintInput =
      input.primaryFile === undefined
        ? { loop: input.loop, title: input.title }
        : { loop: input.loop, title: input.title, primaryFile: input.primaryFile };
    const fingerprint = loopFingerprint(fingerprintInput);

    // DEDUP BEFORE THE CAP, deliberately. At the cap, a re-found known problem
    // must report `duplicate`; reporting `cap reached` would tell the producer
    // to stop looking for something it had already filed.
    const known = this.exists(fingerprint);
    if (known !== null) {
      return { status: 'duplicate', item: known };
    }

    // `listItems` DIRECTLY, not `count`: the cap counts one loop's OWN open
    // items by definition, and `count` widens the scope for a consumer. Reading
    // through it would let a consumer that files be capped by everyone's backlog.
    const open = this.listItems({ state: 'open', loop: input.loop }).length;
    const refusal = capRefusal(open, input.maxOpenIssues);
    if (refusal !== null) {
      return { status: 'refused', reason: refusal };
    }

    const needsApproval = input.needsApproval === true;
    const labels = [...(input.labels ?? [])];
    // The topic rides the labels the caller already supplies — one array, one
    // merge, both backends. It goes on AFTER the provenance label (`label:`,
    // which says WHICH loop filed it) and before the approval gate, so the two
    // never displace each other: an item carries both or either.
    if (topic.length > 0 && !labels.includes(topic)) {
      labels.push(topic);
    }
    if (needsApproval && !labels.includes(APPROVAL_LABEL)) {
      labels.push(APPROVAL_LABEL);
    }
    const markers: ItemMarkers =
      input.primaryFile === undefined || input.primaryFile.length === 0
        ? { loop: input.loop, fingerprint }
        : { loop: input.loop, fingerprint, primaryFile: input.primaryFile };

    const draft: ItemDraft = {
      loop: input.loop,
      title: input.title,
      body: composeItemBody(input.body, markers),
      fingerprint,
      labels,
      approved: !needsApproval,
    };
    if (input.primaryFile !== undefined && input.primaryFile.length > 0) {
      draft.primaryFile = input.primaryFile;
    }
    if (topic.length > 0) {
      draft.topic = topic;
    }
    return { status: 'filed', item: this.createItem(draft) };
  }

  claim(input: ClaimInput): ClaimResult {
    if (input.owner.trim().length === 0) {
      return { status: 'refused', reason: 'a claim requires an owner' };
    }

    if (input.id !== undefined) {
      const item = this.findById(input.id);
      if (item === null) {
        return { status: 'refused', reason: `no item '${input.id}' in the queue` };
      }
      // PROVENANCE BEFORE ELIGIBILITY, for a loop that is still gated by it: "is
      // this mine at all" is the more fundamental question, and telling a run
      // that someone else's item is awaiting approval invites it to clear the
      // gate and come back. A consumer is not gated here at all.
      const foreign = engineWorkBlocker(this.engine, item, 'claim', input.loop);
      if (foreign !== null) {
        return { status: 'refused', reason: foreign };
      }
      const blocker = claimBlocker(item, input.owner, input.loop);
      if (blocker !== null) {
        return { status: 'refused', reason: blocker };
      }
      const named = this.applyClaim(item, input.loop, input.owner);
      if (!this.claimHeld(named, input.owner)) {
        return {
          status: 'lost',
          reason: `item ${named.id} was taken by someone else while it was being claimed`,
          item: named,
        };
      }
      return { status: 'claimed', item: named };
    }

    const query: QueueQuery = input.loop === undefined ? { state: 'open' } : { state: 'open', loop: input.loop };
    // An item this loop may not work is PASSED OVER here rather than refused:
    // sweeping the queue is not being pointed at one item, and stopping the whole
    // run because someone else filed something is not a refusal anyone asked
    // for. The filter lives here rather than in a backend — a backend is never
    // the thing trusted to apply this rule (allowed-pattern #14).
    const workable = this
      .readItems(query)
      .filter((item) => engineWorkBlocker(this.engine, item, 'claim', input.loop) === null);
    // Passed-over items drop out of THIS call only. Nothing is written, so they
    // stay exactly as claimable as they were and the next run is served them
    // first — the run is stepping around one item, not judging it.
    const passedOver = new Set(input.skip ?? []);
    const offered = passedOver.size === 0 ? workable : workable.filter((item) => !passedOver.has(item.id));
    const next = firstClaimable(offered, input.owner);
    if (next === null) {
      const scope =
        this.engine === 'consumer' || input.loop === undefined ? 'the queue' : `loop '${input.loop}'`;
      // NAME WHAT WAS STEPPED AROUND. "nothing claimable" while the run is
      // holding a list of items it just passed over reads as an empty queue,
      // and an empty queue is a run's cue to stop — the exact wrong conclusion
      // when the only thing left is work this run chose to leave.
      const past =
        passedOver.size === 0
          ? ''
          : ` past the ${String(passedOver.size)} item${passedOver.size === 1 ? '' : 's'} this run passed over (${[...passedOver].join(', ')}) — they are still claimable, and the next run is served them first`;
      return { status: 'empty', reason: `nothing claimable in ${scope}${past}` };
    }
    const claimed = this.applyClaim(next, input.loop, input.owner);
    // A CLAIM THAT DID NOT SURVIVE IS NOT A CLAIM. Five engineers share this
    // list, so two runs can reach the same item between reading it and writing
    // to it. Reporting `lost` rather than `claimed` lets the caller take the
    // NEXT task instead of doing work somebody else is already doing — the
    // duplicate-work failure this whole surface exists to prevent.
    if (!this.claimHeld(claimed, input.owner)) {
      return {
        status: 'lost',
        reason: `item ${claimed.id} was taken by someone else while it was being claimed`,
        item: claimed,
      };
    }
    return { status: 'claimed', item: claimed };
  }

  /**
   * Whether a written claim came back held by this owner.
   *
   * Overridable, because "held" is backend-specific: a GitHub item can say so
   * with a marker, an assignee or a label; the ledger simply records the owner.
   * The default trusts the recorded owner, which is what a single-writer backend
   * can rely on.
   */
  protected claimHeld(item: QueueItem, owner: string): boolean {
    return item.claimedBy === undefined || item.claimedBy === owner;
  }

  /**
   * Take a claim, writing it wherever it can live.
   *
   * On a loop's own item the backend records it (a body marker, a ledger event).
   * On a PERSON'S item the backend writes only the `in-progress` label, so the
   * claimant goes into local state — and the returned item is re-overlaid, or the
   * caller would get back an item that looks unclaimed a millisecond after
   * claiming it.
   */
  private applyClaim(item: QueueItem, loop: string | undefined, owner: string): QueueItem {
    if (isPersonsItem(item)) {
      this.recordLocal(item.id, loop ?? '', 'claimed', { owner });
    }
    return this.withLocalState(this.setClaim(item.id, owner));
  }

  /**
   * `recordPlan` — say which plan's pipeline this item's run is advancing.
   *
   * THE HANDOFF THE NEXT RUN READS. A consumer run remembers nothing between
   * runs, so "where am I" has to be a function of what is on disk — and the only
   * thing that knew which pipeline was in flight was `flow/STATE.md`, a file a
   * prompt had to remember to write and five skills were instructed to delete
   * (#1599). The run already holds the item and the item is already the record
   * both runs read, so the association goes there. Nothing about the plan is
   * derived, guessed or scanned for: it is recorded, or it is absent.
   *
   * WRITTEN ON ENTERING A STAGE, CLEARED WHEN THE ITEM IS SETTLED — and settled
   * means CLOSED (or, for a person's item, handled), never merely unclaimed. An
   * item released back to the queue mid-pipeline still has a pipeline, and
   * clearing the record there would reintroduce exactly the invisible handoff
   * this exists to remove.
   */
  recordPlan(input: PlanRecordInput): PlanRecordResult {
    const plan = input.plan?.trim() ?? '';
    const problem = planNameProblem(plan);
    if (problem !== null) {
      return { status: 'refused', reason: problem };
    }
    const item = this.findById(input.id);
    if (item === null) {
      return { status: 'refused', reason: `no item '${input.id}' in the queue` };
    }
    if (item.state !== 'open') {
      return {
        status: 'refused',
        reason: `item ${item.id} is closed — a settled item carries no pipeline`,
      };
    }
    const foreign = engineWorkBlocker(this.engine, item, 'plan', input.loop);
    if (foreign !== null) {
      return { status: 'refused', reason: foreign };
    }
    if (
      item.claimedBy !== undefined &&
      input.owner !== undefined &&
      item.claimedBy !== input.owner
    ) {
      // Mirrors `close` and `unclaim`: a run that lost the item must not
      // redirect the pipeline of the run that took it over.
      return {
        status: 'refused',
        reason: `item ${item.id} is claimed by '${item.claimedBy}' — '${input.owner}' cannot record its plan`,
      };
    }
    return {
      status: 'recorded',
      item: this.applyPlan(item, input.loop, plan.length === 0 ? null : plan),
      plan,
    };
  }

  /**
   * Write the plan wherever it can live — the same two shapes `applyClaim` has,
   * for the same reason. A loop's own item takes the body marker; a person's
   * item takes nothing remote at all, so the record goes to local state and the
   * returned item is re-overlaid from it.
   */
  private applyPlan(item: QueueItem, loop: string | undefined, plan: string | null): QueueItem {
    if (isPersonsItem(item)) {
      this.recordLocal(item.id, loop ?? '', 'planned', {
        ...(plan === null ? {} : { plan }),
      });
      return this.withLocalState(item);
    }
    return this.withLocalState(this.setPlan(item.id, plan));
  }

  /**
   * `adopt` — take an item a person filed into a loop, once.
   *
   * A DISTINCT ACT, not a mode of claiming. There is no flag on `claim` that
   * reaches this, and no argument a run can pass to `claim` that ends here:
   * the two are different verbs with different callers, and the CLI refuses
   * this one outright while a run holds the loop. That separation is the whole
   * point — if adopting a foreign item were one flag away from claiming it,
   * runs would learn the flag and the rule would stop meaning anything.
   *
   * WRITES THE MARKER ONCE. An item that already belongs to a loop is refused
   * rather than re-pointed: the marker records who filed the item, and a
   * provenance record that can be overwritten records nothing. Nothing else is
   * written — no label, no fingerprint, no reshaped body. The person's prose is
   * exactly as they left it.
   */
  adopt(input: AdoptInput): AdoptResult {
    const loop = input.loop.trim();
    if (loop.length === 0) {
      return { status: 'refused', reason: 'an adoption requires a loop' };
    }
    const item = this.findById(input.id);
    if (item === null) {
      return { status: 'refused', reason: `no item '${input.id}' in the queue` };
    }
    if (item.state !== 'open') {
      return {
        status: 'refused',
        reason: `item ${item.id} is closed — adopting a settled item would reopen someone else's decision`,
      };
    }
    const owner = filedByLoop(item);
    if (owner.length > 0) {
      return {
        status: 'refused',
        reason:
          owner === loop
            ? `item ${item.id} already belongs to loop '${loop}' — it has nothing to adopt`
            : `item ${item.id} was filed by loop '${owner}' — adoption writes the marker once, and re-pointing it would rewrite the record of who filed it`,
      };
    }
    return { status: 'adopted', item: this.setAdopted(item.id, loop, withLoopMarker(item.body, loop)) };
  }

  /**
   * `rework` — clear the handled record, so an item this loop finished with can
   * be worked again.
   *
   * THE RELEASE VALVE THE HANDLED RECORD NEEDS. A record that can never be
   * cleared turns "the fix did not hold" into "this issue is dead to the loop
   * forever". It writes NOTHING remote — the record it clears was never on the
   * item — and, like `adopt`, it is a person's act the CLI refuses while a run
   * holds the loop: a run able to clear its own handled record is a run able to
   * argue itself back into re-doing the same work every hour.
   */
  rework(input: ReworkInput): ReworkResult {
    const loop = input.loop.trim();
    if (loop.length === 0) {
      return { status: 'refused', reason: 'a rework requires a loop' };
    }
    const item = this.findById(input.id);
    if (item === null) {
      return { status: 'refused', reason: `no item '${input.id}' in the queue` };
    }
    if (item.handled === undefined) {
      return {
        status: 'refused',
        reason: `item ${item.id} carries no handled record — there is nothing to release`,
      };
    }
    this.recordLocal(item.id, loop, 'reworked', {
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    });
    // The fold has already dropped every fact; this is the same item without the
    // overlay that is no longer there. The plan goes with them: working an item
    // again starts from nothing known, pipeline included.
    const cleared: QueueItem = { ...item };
    delete cleared.handled;
    delete cleared.claimedBy;
    delete cleared.claimedAt;
    delete cleared.plan;
    return { status: 'reworked', item: cleared };
  }

  close(input: CloseInput): CloseResult {
    const item = this.findById(input.id);
    if (item === null) {
      return { status: 'refused', reason: `no item '${input.id}' in the queue` };
    }
    if (item.state === 'closed') {
      return { status: 'refused', reason: `item ${item.id} is already closed` };
    }
    const foreign = engineWorkBlocker(this.engine, item, 'close', input.loop);
    if (foreign !== null) {
      return { status: 'refused', reason: foreign };
    }
    if (
      item.claimedBy !== undefined &&
      input.owner !== undefined &&
      item.claimedBy !== input.owner
    ) {
      // Mirrors `releaseLoopLock`: a late finisher must not close the item that
      // was taken over from it.
      return {
        status: 'refused',
        reason: `item ${item.id} is claimed by '${item.claimedBy}' — '${input.owner}' cannot close it`,
      };
    }
    const problem = validateCloseEvidence(input.reason, input.evidence, input.detail);
    if (problem !== null) {
      return { status: 'refused', reason: problem };
    }
    // A PERSON'S ITEM IS NEVER CLOSED BY A LOOP. The evidence gate above still
    // ran — finishing with someone's issue on prose alone is refused exactly as
    // it always was — but what happens next is a handled record and the removal
    // of the claim label, not `gh issue close` and not a comment. The issue is
    // closed by GitHub when the pull request carrying `Closes #<n>` merges,
    // which is the mechanism that drains the backlog without a robot ever
    // resolving somebody's report for them.
    if (isPersonsItem(item)) {
      const detail = handledDetail(input);
      this.recordLocal(item.id, input.loop ?? '', 'handled', { detail });
      const released = item.claimedBy === undefined ? item : this.setClaim(item.id, null);
      const settled = this.withLocalState(released);
      return { status: 'handled', item: settled, note: handledCloseNote(settled) };
    }
    // SETTLING CLEARS THE HANDOFF. The plan marker means "a run is advancing
    // this pipeline"; once the item is closed that is no longer true, and a
    // marker left behind would offer the next run a pipeline nobody is working.
    // The person's-item branch above needs no equivalent write — the `handled`
    // record it just appended clears the plan in the fold (`foreign-items.ts`).
    if (item.plan !== undefined && item.plan.length > 0) {
      this.setPlan(item.id, null);
    }
    return {
      status: 'closed',
      item: this.setClosed(item.id, input.reason, input.detail, input.evidence),
    };
  }

  /**
   * `recordMerge` — write on the item that its branch landed.
   *
   * THE STORE'S OWN HALF OF THE MERGE. Whether the merge was ALLOWED is decided
   * before any of this, at the git seam, by the gate that owns branch ownership
   * and the evidence bar (`push-guard.ts`); what the store enforces is the rule
   * it has always owned — a loop writes only to items a loop filed, and never to
   * another loop's. Writing a merge note onto a person's issue is a mutation of
   * someone else's work like any other, and it would claim their report was
   * landed by a robot.
   *
   * The evidence travels VERBATIM into the record. A landed change whose proof
   * lives only in a run's transcript is a change nobody can audit six weeks
   * later, which is the whole reason the merge was gated on captured exit codes
   * rather than a summary.
   */
  recordMerge(input: MergeRecordInput): MergeRecordResult {
    const item = this.findById(input.id);
    if (item === null) {
      return { status: 'refused', reason: `no item '${input.id}' in the queue` };
    }
    const foreign = engineWorkBlocker(this.engine, item, 'merge', input.loop);
    if (foreign !== null) {
      return { status: 'refused', reason: foreign };
    }
    // A PERSON'S ITEM TAKES NO COMMENT. The merge is real and the record has to
    // exist, so it goes where everything else this loop knows about someone
    // else's item goes — and it doubles as the handled record, because a landed
    // fix is precisely the state that must not be claimed and re-fixed while the
    // issue waits for GitHub to close it.
    if (isPersonsItem(item)) {
      this.recordLocal(item.id, input.loop ?? '', 'handled', { detail: mergeSummary(input) });
      const settled = this.withLocalState(item);
      return { status: 'recorded', item: settled, note: handledMergeNote(settled) };
    }
    return { status: 'recorded', item: this.setMerged(item.id, input) };
  }

  approve(id: string, owner?: string): ApproveResult {
    const item = this.findById(id);
    if (item === null) {
      return { status: 'refused', reason: `no item '${id}' in the queue` };
    }
    if (item.state === 'closed') {
      return { status: 'refused', reason: `item ${item.id} is closed — nothing to approve` };
    }
    // Approving is a LABEL REMOVAL on GitHub. On a person's item that is the
    // relabelling the incident performed, by another name.
    const human = humanWorkBlocker(item, 'approve');
    if (human !== null) {
      return { status: 'refused', reason: human };
    }
    if (item.approved) {
      // Idempotent on purpose: a panel button and a CLI call may both fire, and
      // the second must not read as a failure.
      return { status: 'approved', item, alreadyApproved: true };
    }
    return { status: 'approved', item: this.setApproved(item.id, owner), alreadyApproved: false };
  }

  /**
   * Release a claim, so the item goes back to the queue for another run.
   *
   * This is what a stalled pipeline's abandonment does with the item it could
   * not advance: it stays FILED (the finding is still real) but stops being
   * held by a run that is not coming back.
   *
   * Ownership is checked the same way `close` checks it and for the same
   * reason: a late finisher must not unclaim the run that took over from it.
   * Unclaiming an item nobody holds is idempotent success — a coordinator
   * cleaning up after a crash should not have to know whether the crash got as
   * far as claiming.
   *
   * `ttlMs` is the loop's lock TTL, and it bounds how long that protection
   * lasts. Past it the holding run's lock has ALREADY expired — the loop has
   * concluded that run is gone, which is the same threshold `abandonedClaims`
   * reports on — so refusing there protects nobody and strands the item
   * forever: with no live holder to release it and no other verb that can, a
   * loop whose every open item is abandoned reports `proceed`, claims `empty`,
   * and does nothing for the rest of time. Releasing an expired claim is still
   * an explicit act (a caller named the id); what stays forbidden is doing it
   * SILENTLY, which is why nothing reclaims on the read path and why the
   * result says the takeover happened.
   *
   * Omitting `ttlMs` keeps the old absolute rule, so a caller with no notion of
   * a TTL cannot accidentally acquire the override.
   */
  unclaim(id: string, owner?: string, loop?: string, ttlMs?: number): UnclaimResult {
    const item = this.findById(id);
    if (item === null) {
      return { status: 'refused', reason: `no item '${id}' in the queue` };
    }
    if (item.claimedBy === undefined) {
      // Idempotent success comes BEFORE the work gate on purpose: an item nobody
      // holds needs no write at all, so answering "nobody holds it" is both true
      // and free. Nothing is touched either way.
      return { status: 'unclaimed', item, wasClaimed: false };
    }
    const foreign = engineWorkBlocker(this.engine, item, 'unclaim', loop);
    if (foreign !== null) {
      return { status: 'refused', reason: foreign };
    }
    let tookOverAbandoned = false;
    if (owner !== undefined && item.claimedBy !== owner) {
      if (!this.claimIsAbandoned(item, ttlMs)) {
        return {
          status: 'refused',
          reason: `item ${item.id} is claimed by '${item.claimedBy}' — '${owner}' cannot unclaim it`,
        };
      }
      tookOverAbandoned = true;
    }
    // Releasing a person's item drops the label and the local claim, and nothing
    // else — the same one write claiming it made, undone.
    if (isPersonsItem(item)) {
      this.recordLocal(item.id, loop ?? '', 'released');
    }
    return {
      status: 'unclaimed',
      item: this.withLocalState(this.setClaim(item.id, null)),
      wasClaimed: true,
      tookOverAbandoned,
    };
  }

  /**
   * Whether another run's claim has gone untouched past the loop's lock TTL.
   *
   * The SAME conservative reading `abandonedClaims` uses, and deliberately so —
   * one definition of "not coming back", or the report and the recovery
   * disagree about which items are stuck. A claim with no readable timestamp is
   * never abandoned: the age is the whole claim being made, and the safe answer
   * when it cannot be made is to keep protecting the holder.
   */
  private claimIsAbandoned(item: QueueItem, ttlMs: number | undefined): boolean {
    if (ttlMs === undefined || item.claimedAt === undefined) return false;
    const claimedAt = Date.parse(item.claimedAt);
    if (Number.isNaN(claimedAt)) return false;
    return this.clock() - claimedAt > ttlMs;
  }

  count(query: QueueQuery = {}): QueueCounts {
    // THROUGH THE SHARED READ PATH, so `loop status` counts the queue a consumer
    // can actually work — hand-filed items included, handled ones excluded. The
    // old count read one loop's own slice and reported `0 claimable` on a repo
    // full of claimable issues, which is how a dead loop looked healthy.
    const scope: QueueQuery = { ...query, state: 'all' };
    return countItems(this.readItems(scope));
  }
}

/**
 * The count fold, over items a caller already holds. `count()` is this fold fed
 * its own read — but a verb that has ALREADY listed the queue must fold the
 * items it holds instead of calling `count()`, which repeats the identical
 * remote read (#1635: the gate paid two `gh issue list` round trips per pass,
 * and `loop status` paid two per loop). One read is also one snapshot: counts
 * and the item list can never disagree about a queue that changed between them.
 */
export function countItems(items: readonly QueueItem[]): QueueCounts {
  const counts: QueueCounts = {
    open: 0,
    closed: 0,
    claimed: 0,
    awaitingApproval: 0,
    parked: 0,
    claimable: 0,
  };
  for (const item of items) {
    if (item.state === 'closed') {
      counts.closed += 1;
      continue;
    }
    counts.open += 1;
    if (item.claimedBy !== undefined) counts.claimed += 1;
    if (!item.approved) counts.awaitingApproval += 1;
    if (item.labels.includes(PARKED_LABEL)) counts.parked += 1;
    if (isClaimable(item)) counts.claimable += 1;
  }
  return counts;
}

/**
 * Scope a prefetched page the way `list({loop})` would scope it — the
 * item-level mirror of `scopeQuery`, exported so a surface that SHARES one
 * page across loops (`loop status`, #1648) applies the same rule instead of
 * re-deriving it (allowed-pattern #14): a producer sees only its own items,
 * a consumer's queue is the queue.
 */
export function scopeItemsToLoop(
  items: readonly QueueItem[],
  engine: LoopEngine | undefined,
  loop: string,
): QueueItem[] {
  if (engine === 'consumer' || loop.length === 0) return [...items];
  return items.filter((item) => item.loop === loop);
}

/**
 * One queue page per distinct location per INVOCATION (#1648).
 *
 * `loop status` renders one row per loop, and loops that share a `repo:` used
 * to each pay the identical `gh issue list` round trip — three byte-identical
 * remote reads per invocation on a two-loop repo, ~1.3s apiece. The cache is
 * invocation-scoped on purpose: a page shared across surfaces WITHIN one
 * command cannot go stale in a way the old shape didn't already accept
 * (each row read the queue at a slightly different moment; one shared read is
 * strictly more consistent), and nothing outlives the process.
 */
export class StatusPageCache {
  readonly #pages = new Map<string, QueueItem[]>();

  /** The page for `key`, fetching it at most once however many rows ask. */
  read(key: string, fetch: () => QueueItem[]): QueueItem[] {
    const cached = this.#pages.get(key);
    if (cached !== undefined) return cached;
    const page = fetch();
    this.#pages.set(key, page);
    return page;
  }
}

/** The caller-surfaceable form of a refusal: `loop refused: <reason>`. */
export function formatQueueRefusal(reason: string): string {
  return `loop refused: ${reason}`;
}
