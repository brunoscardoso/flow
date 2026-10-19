/**
 * The GitHub queue backend — issues in a repo, reached through `gh`.
 *
 * WHY GITHUB AT ALL: because its CLOSED issues are searchable. A queue's most
 * valuable memory is not what is open, it is what was rejected — an item closed
 * as not-planned is a permanent "never file this again", and a producer that
 * cannot see it re-files the same idea every night until the human who rejected
 * it stops reading the queue. So every dedup search here runs over open AND
 * closed items, and that is not an optimization detail; it is the reason this
 * backend exists alongside the ledger.
 *
 * THE BODY IS THE RECORD. GitHub has no field for "which loop filed this", "what
 * is its fingerprint", "which file is it about", "who is working it" or "which
 * pipeline they are advancing", so all five live in HTML-comment markers in the
 * body (`queue-backend.ts` owns their grammar). They render as nothing, survive edits, and — the point — come back
 * in the SAME `gh issue list --json body` response as everything else, so
 * reading an item's full state costs one call rather than five.
 *
 * SEARCH NARROWS, THE MARKER DECIDES. GitHub's search is fuzzy, tokenized and
 * occasionally stale; it is used only to shrink the candidate set to something
 * worth fetching. The yes/no dedup answer is always the exact marker check in
 * the base class. Trusting the search itself would make dedup depend on an
 * index nobody controls.
 *
 * THE JSON SHAPE IS READ DEFENSIVELY (allowed-pattern #11). `gh` has emitted
 * `state` in both cases across versions, labels as objects and (in adjacent
 * APIs) as bare strings, and `stateReason` under two spellings. Every variant
 * documented or plausibly emitted is accepted; a record missing an issue number
 * is skipped rather than guessed at. What this module assumes about the live
 * tool is listed on `GH_ISSUE_FIELDS` so a later phase can check it against a
 * real `gh` in one read.
 *
 * `gh` IS INVOKED THROUGH AN INJECTED EXEC. Tests mock the child process, never
 * PATH (allowed-pattern #12), and a failure THROWS rather than failing soft: a
 * producer that cannot reach its queue must not file blind, and a consumer that
 * cannot read it must not conclude the queue is empty.
 */

import { execFileSync } from 'node:child_process';
import {
  APPROVAL_LABEL,
  CLAIMED_LABEL,
  LoopQueueBackendBase,
  RESERVED_LABELS,
  extractItemMarkers,
  foreignClaimant,
  isPersonsItem,
  topicProblem,
  withClaimMarker,
  withPlanMarker,
  withoutClaimMarker,
  withoutPlanMarker,
} from './queue-backend.js';
import type {
  CloseEvidence,
  ItemDraft,
  MergeRecordInput,
  QueueCloseReason,
  QueueItem,
  QueueQuery,
  QueueReadSession,
} from './queue-backend.js';
import type { ForeignItemState } from './foreign-items.js';
import type { LoopEngine, LoopQueueKind } from './types.js';

/** How long any single `gh` call may take. */
export const GH_TIMEOUT_MS = 30_000;

/** Default page size for issue reads. */
export const GH_DEFAULT_LIMIT = 100;

/**
 * The `--json` fields every read requests.
 *
 * This list IS the assumption about the live tool, written down in one place:
 * `number` (integer), `title`/`body` (strings, body may be null), `state`
 * (`OPEN`/`CLOSED`, case not relied on), `labels` and `assignees` (arrays of
 * `{name}` and `{login}`),
 * `createdAt` (ISO), `url`, `stateReason` (`COMPLETED`/`NOT_PLANNED`/null).
 */
export const GH_ISSUE_FIELDS =
  'number,title,body,state,labels,createdAt,url,stateReason,assignees';

/** Minimal exec surface: run `gh` with argv, return stdout, throw on failure. */
export type GhExec = (args: readonly string[]) => string;

/** The default exec — `execFileSync`, so no shell quoting can ever be wrong. */
export const defaultGhExec: GhExec = (args) =>
  execFileSync('gh', [...args], {
    encoding: 'utf-8',
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });

/**
 * Marker recording WHY an item was closed, appended to the closing comment.
 *
 * GitHub has two close reasons (`completed` / `not planned`) and this layer has
 * three, so `duplicate` and `wontfix` both land as `not planned`. The marker
 * keeps the distinction visible to a human reading the thread; it is
 * deliberately NOT read back, because the behaviour that depends on a close —
 * dedup treating the item as permanent memory — is identical for both.
 */
export const GH_CLOSE_MARKER_PATTERN = /<!--\s*loop-close:\s*(\S+)\s*-->/;

/** GitHub's own close reasons, and how this layer's three map onto its two. */
export function ghCloseReason(reason: QueueCloseReason): string {
  return reason === 'done' ? 'completed' : 'not planned';
}

/** Read GitHub's `stateReason` back into this layer's vocabulary. */
export function closeReasonFromGh(stateReason: string | undefined): QueueCloseReason | undefined {
  if (stateReason === undefined) return undefined;
  const normalized = stateReason.toUpperCase();
  if (normalized === 'COMPLETED') return 'done';
  if (normalized === 'NOT_PLANNED' || normalized === 'NOT PLANNED') return 'wontfix';
  return undefined;
}

// ── defensive JSON reading ───────────────────────────────

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a field under any of several spellings — versions differ, we do not. */
function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Label names, accepting BOTH shapes seen in the wild: `[{name: "bug"}]` (what
 * `gh issue list --json labels` documents) and `["bug"]` (what several adjacent
 * API surfaces emit). A reader that accepted only one would silently see every
 * item as unlabelled — which reads as "nothing is gated, nothing is parked".
 */
export function readGhLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      labels.push(entry);
      continue;
    }
    if (isRecordObject(entry) && typeof entry.name === 'string') {
      labels.push(entry.name);
    }
  }
  return labels;
}

/**
 * `assignees` → logins. Same shape-tolerance as `readGhLabels`, and for the same
 * reason: a field the live tool renders differently must never make an item
 * unreadable, so an unparseable entry is skipped rather than thrown on.
 */
export function readGhAssignees(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const logins: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      logins.push(entry);
      continue;
    }
    if (isRecordObject(entry) && typeof entry.login === 'string') {
      logins.push(entry.login);
    }
  }
  return logins;
}

/**
 * One `gh` issue record → a `QueueItem`, or null when it carries no usable
 * issue number. Everything else defaults: an issue a human opened by hand has
 * no markers, and must still be readable as a (loop-less) queue item rather
 * than crashing the read.
 */
export function parseGhIssue(raw: unknown): QueueItem | null {
  if (!isRecordObject(raw)) return null;
  const id = asString(pick(raw, 'number', 'id'));
  if (id === undefined || id.length === 0) return null;

  const body = asString(pick(raw, 'body')) ?? '';
  const markers = extractItemMarkers(body);
  const labels = readGhLabels(pick(raw, 'labels'));
  const assignees = readGhAssignees(pick(raw, 'assignees'));
  const state = (asString(pick(raw, 'state')) ?? 'open').toLowerCase() === 'closed' ? 'closed' : 'open';

  const item: QueueItem = {
    id,
    loop: markers.loop ?? '',
    title: asString(pick(raw, 'title')) ?? '',
    body,
    fingerprint: markers.fingerprint ?? '',
    state,
    labels,
    // The approval GATE is a label here, where the ledger uses a field. Both
    // materialize the same `approved` boolean, so eligibility stays one
    // predicate in the shared layer.
    approved: !labels.includes(APPROVAL_LABEL),
    ...(assignees.length === 0 ? {} : { assignees }),
    createdAt: asString(pick(raw, 'createdAt', 'created_at')) ?? '',
  };
  if (markers.primaryFile !== undefined) item.primaryFile = markers.primaryFile;
  // The pipeline this item's run is advancing, when a run recorded one. Read
  // here so no consumer re-parses the body — and absent on every item filed
  // before the marker existed, which reads exactly as it always did.
  if (markers.plan !== undefined) item.plan = markers.plan;
  if (markers.claim !== undefined) {
    item.claimedBy = markers.claim.owner;
    item.claimedAt = markers.claim.at;
  } else if (labels.includes(CLAIMED_LABEL) && assignees.length > 0) {
    // THE CLAIM ON A PERSON'S ISSUE, READ BACK.
    //
    // A loop-filed item carries its claimant in a body marker, which lives on
    // GitHub and is therefore visible to every machine. A PERSON'S item cannot:
    // a loop may not write their prose, so `setClaim` records the claimant in
    // machine-local state (`foreign.jsonl`) and writes only the label and the
    // assignee remotely.
    //
    // That left the guard half-built. The label and the assignee were WRITTEN
    // for exactly this case — the comment in `setClaim` says "two agents on two
    // machines could both label the same issue and both start fixing it" — but
    // nothing ever READ them, so `claimedBy` came back undefined on the second
    // machine and `claimBlocker` waved it through. Both machines claimed the
    // same issue and did the same work.
    //
    // So the remote pair IS a claim: label plus assignee, both required. Either
    // one alone is ambiguous — a person triaging with `in-progress`, or an
    // assignee left over from a release that removed only the label.
    //
    // The claimant is derived from the assignee and marked `@` so it can never
    // be mistaken for a run owner (`run-<ts>-<n>`). On the machine that truly
    // holds the item, `withLocalState` overlays the real owner a moment later,
    // which is what keeps a claim re-entrant for the run that took it; every
    // other machine sees a foreign name and is blocked by the same one predicate
    // that already blocks every other kind of held item.
    //
    // A HUMAN'S OWN CLAIM READS THE SAME WAY, and should: someone who assigned
    // themselves and marked it in-progress is working it, and a loop taking it
    // out from under them is the exact collision this prevents.
    item.claimedBy = foreignClaimant(assignees[0]);
    // NO `claimedAt`. A derived claim carries no start time — GitHub's
    // `updatedAt` moves on every comment, so using it would let a stale-claim
    // sweep on one machine abandon a claim another machine took seconds ago.
    // Without a timestamp the sweep skips it (`staleClaims`), so the failure
    // mode is a claim that outlives a dead machine rather than one stolen from a
    // live one. `loop unclaim --loop <name> --id <id>` releases it by hand.
  }
  const url = asString(pick(raw, 'url', 'html_url'));
  if (url !== undefined) item.url = url;
  if (state === 'closed') {
    const closeReason = closeReasonFromGh(asString(pick(raw, 'stateReason', 'state_reason')));
    if (closeReason !== undefined) item.closeReason = closeReason;
    const closedAt = asString(pick(raw, 'closedAt', 'closed_at'));
    if (closedAt !== undefined) item.closedAt = closedAt;
  }
  return item;
}

/** Parse a `gh --json` array. A non-array response yields nothing, never a throw. */
export function parseGhIssues(stdout: string): QueueItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim().length === 0 ? '[]' : stdout);
  } catch {
    throw new Error(`gh returned unparseable JSON: ${stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) return [];
  const items: QueueItem[] = [];
  for (const raw of parsed) {
    const item = parseGhIssue(raw);
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * The issue number `gh issue create` just made.
 *
 * `gh` prints the new issue's URL on stdout, so the number is its last path
 * segment. Parsed rather than assumed, and a URL that yields no number throws:
 * an item filed whose id we cannot learn is an item nothing can ever claim.
 */
export function parseCreatedIssueNumber(stdout: string): string {
  const match = stdout.trim().match(/\/issues\/(\d+)\s*$/m) ?? stdout.trim().match(/(\d+)\s*$/);
  if (match === null) {
    throw new Error(`gh issue create returned no issue number: ${stdout.trim().slice(0, 200)}`);
  }
  return match[1];
}

/**
 * Render the closing note posted with the close.
 *
 * Human-readable on purpose — a person auditing what a loop did overnight reads
 * the issue timeline, not a JSON store — with every command's captured exit
 * code shown verbatim, because that is the whole claim the close rests on.
 */
export function composeCloseNote(
  reason: QueueCloseReason,
  detail: string | undefined,
  evidence: CloseEvidence | undefined,
): string {
  const lines: string[] = [`**Closed: ${reason}**${detail === undefined ? '' : ` — ${detail}`}`];
  appendEvidenceLines(lines, evidence);
  lines.push('', `<!-- loop-close: ${reason} -->`);
  return lines.join('\n');
}

/**
 * The evidence a note renders under its headline: every command with the exit
 * code it really returned, then artifacts, then any prose.
 *
 * Shared by the close note and the merge note so the two read identically —
 * they rest on the same captured records, and a reader comparing "what was this
 * closed on" with "what was this landed on" should not have to translate.
 */
function appendEvidenceLines(lines: string[], evidence: CloseEvidence | undefined): void {
  const commands = evidence?.commands ?? [];
  if (commands.length > 0) {
    lines.push('', 'Evidence:');
    for (const entry of commands) {
      lines.push(`- \`${entry.command}\` → exit ${entry.exitCode}`);
    }
  }
  const artifacts = evidence?.artifacts ?? [];
  if (artifacts.length > 0) {
    lines.push('', 'Artifacts:');
    for (const artifact of artifacts) lines.push(`- ${artifact}`);
  }
  if (evidence?.summary !== undefined && evidence.summary.trim().length > 0) {
    lines.push('', evidence.summary.trim());
  }
}

/**
 * Marker recording that an item's branch LANDED, appended to the merge comment.
 *
 * A separate marker from `loop-close:` because they are separate facts: an item
 * can be merged and still open (a follow-up is pending), or closed and never
 * merged (`wontfix`). One marker for both would erase exactly the distinction a
 * person auditing an unattended night needs.
 */
export const GH_MERGE_MARKER_PATTERN = /<!--\s*loop-merge:\s*(\S+)\s*-->/;

/**
 * Render the comment posted on the item when its branch lands.
 *
 * The evidence is shown verbatim, for the same reason `composeCloseNote` shows
 * it: the merge rested on those exit codes, and a person reading the issue
 * timeline is the audience the record exists for.
 */
export function composeMergeNote(input: MergeRecordInput): string {
  const lines: string[] = [`**Merged: \`${input.branch}\`**`];
  if (input.pr !== undefined) {
    lines.push('', `Pull request: ${input.pr.url}`);
  }
  appendEvidenceLines(lines, input.evidence);
  lines.push('', `<!-- loop-merge: ${input.branch} -->`);
  return lines.join('\n');
}

/** A one-line record of something this backend did to the repo itself. */
/**
 * WHY a `gh` call failed, as a sentence — never the invocation that failed.
 *
 * `execFileSync`'s Error.message is `Command failed: gh issue list --repo
 * owner/name --state open --limit 100 --json number,title,body,…`, and that
 * string travelled verbatim into `queueError`, onto the tasks board, and in
 * front of a reader who cannot run it (forbidden-pattern #12). Reported live:
 * a board showing the whole `gh issue list --json …` line to someone who had
 * never configured GitHub at all.
 *
 * The ENOENT case was already answered with a sentence; these are its missing
 * siblings. Classifying HERE rather than at the board is what makes every
 * consumer — board, `loop list` JSON, logs, the heartbeat — say the same thing
 * (allowed-pattern #14), and what lets a caller offer the right remedy: only
 * `signed-out` has a sign-in to offer.
 *
 * `gh` writes its diagnosis to stderr, which execFileSync hangs off the error;
 * the message is the fallback for when it did not.
 */
export function ghFailureDetail(error: unknown): string {
  const err = error as (NodeJS.ErrnoException & { stderr?: unknown }) | null;
  if (err?.code === 'ENOENT') return 'the gh CLI is not installed or not on PATH';

  const stderr = typeof err?.stderr === 'string' ? err.stderr : String(err?.stderr ?? '');
  const message = typeof err?.message === 'string' ? err.message : '';

  // WHAT GH SAID WINS — its diagnosis goes to stderr, and `Command failed: …`
  // is execFileSync's wrapper around it, not gh's opinion of anything. Dropping
  // only the wrapper keeps the promise the older test states in its name
  // ("surfaces what gh actually said") while removing the part no reader can use.
  const said = stderr.trim().length > 0
    ? stderr.trim()
    : message.replace(/^Command failed:.*$/m, '').trim();
  const firstLine = said.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  return firstLine ?? 'unknown failure';
}

/**
 * WHICH failure it was, for callers that can offer a remedy.
 *
 * Separate from the prose on purpose: a sentence is for reading and this is for
 * DECIDING, and the one thing a board needs to know is whether it may offer a
 * sign-in. Deriving it here rather than re-matching gh's prose in the renderer
 * keeps the judgement in one code path (allowed-pattern #14) — and prose that a
 * UI pattern-matches is prose that cannot be reworded.
 */
export type GhFailureKind =
  | 'not-installed'
  | 'signed-out'
  | 'bad-credentials'
  | 'unreachable'
  | 'rate-limited'
  | 'unknown';

/** A queue failure that knows which kind it was. */
export interface GhFailure extends Error {
  ghKind?: GhFailureKind;
}

/** The kind a thrown queue failure carries, or 'unknown'. */
export function ghKindOf(error: unknown): GhFailureKind {
  const kind = (error as GhFailure | null)?.ghKind;
  return kind ?? 'unknown';
}

export function ghFailureKind(error: unknown): GhFailureKind {
  const err = error as (NodeJS.ErrnoException & { stderr?: unknown }) | null;
  if (err?.code === 'ENOENT') return 'not-installed';
  const stderr = typeof err?.stderr === 'string' ? err.stderr : String(err?.stderr ?? '');
  const said = `${stderr}\n${typeof err?.message === 'string' ? err.message : ''}`;
  // ORDER MATTERS. gh appends "Try authenticating with: gh auth login" to a 401
  // as well, so the sign-in pattern below matches a REJECTED credential too —
  // measured against the live CLI with a deliberately invalid GH_TOKEN. The
  // remedy is the same reconnect either way, but the sentences are not
  // interchangeable: "you are not signed in" is wrong, and confusing, when what
  // happened is that the token you gave was refused.
  if (/HTTP 401|bad credentials/i.test(said)) return 'bad-credentials';
  if (/gh auth login|not logged in|no authentication token|authentication required/i.test(said)) {
    return 'signed-out';
  }
  if (/could not resolve to a repository|HTTP 404/i.test(said)) return 'unreachable';
  if (/rate limit/i.test(said)) return 'rate-limited';
  return 'unknown';
}

export type GhLog = (message: string) => void;

/**
 * The default log sink: ONE line on stderr.
 *
 * stderr rather than stdout on purpose — a verb's success output is a single
 * JSON line on stdout that a run parses, and a log line printed there would
 * turn a note into a parse error. Notice, not silence: creating a label is a
 * write to someone's repo configuration, and it must be visible in the
 * transcript without being part of the machine contract.
 */
export const defaultGhLog: GhLog = (message) => {
  process.stderr.write(`${message}\n`);
};

/** Construction options. */
export interface GithubQueueOptions {
  /** `owner/name` — validated by the directive parser before it reaches here. */
  repo: string;
  /** Injected `gh` runner. Tests supply a fake; production uses `defaultGhExec`. */
  exec?: GhExec;
  /** Injected clock, for parity with the other backends. */
  clock?: () => number;
  /** Page size for issue reads. */
  limit?: number;
  /** Where the topic-label notice goes. Injected so tests read it back. */
  log?: GhLog;
  /** The directive's engine — decides what this loop may WORK, never what it may write. */
  engine?: LoopEngine;
  /** Local record for items no loop filed (`foreign-items.ts`). */
  local?: ForeignItemState;
  /**
   * A read memo shared with the other backends of ONE read-only report
   * (`QueueReadSession`). Absent means every read phones GitHub, which is what
   * every writing verb wants and gets by saying nothing.
   */
  session?: QueueReadSession;
}

/**
 * The GitHub backend. Supplies the seven primitives and nothing else — the cap,
 * dedup, eligibility, provenance and evidence rules all come from `LoopQueueBackendBase`.
 *
 * LABELS ARE A SETUP PRECONDITION, WITH EXACTLY ONE EXCEPTION. Both halves of
 * that sentence are load-bearing, so both live here:
 *
 *   THE RULE — `gh issue edit --add-label` fails on a label the repo does not
 *   have, and this class does NOT paper over that for the vocabulary.
 *   `needs-approval`, `not-now`, `in-progress` and the directive's own queue
 *   label (`label:`, provenance) are words this SYSTEM chose; a repo missing one
 *   is a setup problem its owner should see and fix once, not something a loop
 *   silently invents at 3am. Creating them on the fly would be this backend
 *   quietly reconfiguring someone's repo, and the failure it hides — a queue
 *   whose gate label does not exist — is exactly the failure worth surfacing.
 *
 *   THE EXCEPTION — the directive's `topic:`, and only it, IS created here, via
 *   one `gh label create --force` (documented by the live tool as "create a new
 *   label, or update an existing one", so no create-then-tolerate-failure path).
 *   A topic is the opposite kind of word: it is the user's own, invented at the
 *   moment they re-point a loop at an area, and a topic that costs a trip to
 *   GitHub's label settings is a topic nobody sets. It is validated against the
 *   shared grammar before it gets here (`topicProblem`, which also refuses the
 *   reserved vocabulary), the call fires once per backend instance rather than
 *   once per filed item, and it is LOGGED — a write to repo configuration is
 *   never silent.
 *
 *   NEITHER HALF IS RELAXED FOR SOMEONE ELSE'S ISSUE. A loop working an issue a
 *   person opened writes exactly one thing on it: `--add-label in-progress` on
 *   claim and `--remove-label in-progress` on release. That label belongs to the
 *   vocabulary above, so it is still a setup precondition and still never created
 *   here; the topic exception stays reachable only from `createItem`, on an item
 *   this loop is filing itself.
 */
export class GithubQueueBackend extends LoopQueueBackendBase {
  readonly kind: LoopQueueKind = 'github';
  private readonly repo: string;
  private readonly exec: GhExec;
  private readonly limit: number;
  private readonly log: GhLog;
  /**
   * The report's shared read memo, when this backend belongs to one. Only issue
   * READS consult it; every write goes straight to `gh`.
   */
  private readonly session: QueueReadSession | undefined;
  /**
   * Topics this instance has already ensured. A run constructs one backend, so
   * this bounds label creation to one call per topic per run however many
   * findings are filed under it.
   */
  private readonly ensuredTopics = new Set<string>();
  /** Repo labels, read lazily once. `null` until the first read. */
  private knownLabels: Set<string> | null = null;

  constructor(options: GithubQueueOptions) {
    super(options.clock ?? Date.now, options.engine, options.local);
    this.repo = options.repo;
    this.exec = options.exec ?? defaultGhExec;
    this.limit = options.limit ?? GH_DEFAULT_LIMIT;
    this.log = options.log ?? defaultGhLog;
    this.session = options.session;
  }

  /**
   * Run one `gh` command. Failures THROW with the command that failed and what
   * `gh` said — a queue that cannot be reached must never look like an empty
   * one (see the module header).
   */
  private gh(args: readonly string[]): string {
    try {
      return this.exec(args);
    } catch (error) {
      const failure: GhFailure = new Error(
        `gh ${args.slice(0, 2).join(' ')} failed for ${this.repo}: ${ghFailureDetail(error)}`,
      );
      // CARRIED, not re-derived. The wrapper loses `code` and `stderr` — the
      // only two things the kind can be read from — so a caller downstream
      // could never classify this again, and would be reduced to matching the
      // prose it was handed.
      failure.ghKind = ghFailureKind(error);
      throw failure;
    }
  }

  protected listItems(query: QueueQuery): QueueItem[] {
    const state = query.state ?? 'all';
    const args = [
      'issue',
      'list',
      '--repo',
      this.repo,
      '--state',
      state,
      '--limit',
      String(this.limit),
      '--json',
      GH_ISSUE_FIELDS,
    ];
    // The search is a NARROWING device only — the exact marker check in the
    // base class is what decides. Searching the bare hash rather than the whole
    // marker keeps GitHub's tokenizer out of the question.
    if (query.fingerprint !== undefined && query.fingerprint.length > 0) {
      args.push('--search', `${query.fingerprint} in:body`);
    }
    const items = parseGhIssues(this.listIssues(args));
    return query.loop === undefined ? items : items.filter((item) => item.loop === query.loop);
  }

  /**
   * The one place an issue LIST reaches the network — through the report's memo
   * when there is one.
   *
   * The key is the argv itself, `--repo` and `--state` and `--search` included,
   * so nothing about the request is left out of what identifies it: two loops on
   * one repo asking for the same slice share the round trip, and the same two
   * asking for different slices (or different repos) do not. The loop filter is
   * applied by the CALLER above, after parsing — it never reaches `gh`, so it
   * must never be part of the key either, and that is exactly why two rows can
   * share one response at all.
   *
   * The parts are joined on a NUL rather than a space: `--search 'a b'` is ONE
   * argument containing a space, and a space-joined key could not tell it from
   * two arguments spelled `a` and `b`. A NUL cannot occur inside an argv, so
   * no two different requests can spell the same key.
   */
  private listIssues(args: readonly string[]): string {
    if (this.session === undefined) return this.gh(args);
    return this.session.read(args.join('\u0000'), () => this.gh(args));
  }

  /**
   * One item by id — `gh issue view`, never a page scan (#1636).
   *
   * NULL ONLY FOR "NO SUCH ISSUE". `gh` says that in one recognizable way
   * (GraphQL's "Could not resolve to an issue or pull request"); anything else —
   * no network, no auth, no `gh` at all — still throws, because an unreachable
   * queue must never read as an item that does not exist (module header).
   */
  protected fetchItem(id: string): QueueItem | null {
    try {
      return this.fetch(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/could not resolve to an issue/i.test(message)) return null;
      throw error;
    }
  }

  /** Read one issue by number. */
  private fetch(id: string): QueueItem {
    const stdout = this.gh(['issue', 'view', id, '--repo', this.repo, '--json', GH_ISSUE_FIELDS]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`gh issue view ${id} returned unparseable JSON`);
    }
    const item = parseGhIssue(parsed);
    if (item === null) {
      throw new Error(`gh issue view ${id} returned no readable issue`);
    }
    return item;
  }

  /**
   * Make the topic label exist, once per topic per instance.
   *
   * The refusals here are belt-and-braces over the shared grammar, and both are
   * silent no-ops rather than throws because they can only be reached by a
   * caller that bypassed `file()`: a RESERVED label is never created (it stays a
   * precondition — see the class docstring), and an ungrammatical topic never
   * reaches `gh` at all. A topic that got this far through the normal path has
   * already been validated twice.
   *
   * `--force` is one call: the live tool documents it as "create a new label, or
   * update an existing one", so there is no create-then-tolerate-failure path
   * and no read-before-write. No colour is passed — GitHub picks its default
   * rather than this backend imposing a scheme on a repo that has one.
   */
  private ensureTopicLabel(topic: string): void {
    if (topic.length === 0 || this.ensuredTopics.has(topic)) return;
    if (RESERVED_LABELS.includes(topic) || topicProblem(topic) !== null) return;
    // ALREADY THERE ⇒ NOTHING TO WRITE (#1586). The memo is per INSTANCE, and
    // every `planflow-ai loop file` is a fresh process, so it never survived a
    // filing: each one re-created a label that had existed since the first item.
    // `repoLabels()` is the read this write never had; `null` means "could not
    // ask", which falls through to the write exactly as before.
    if (this.repoLabels()?.has(topic) === true) {
      this.ensuredTopics.add(topic);
      return;
    }
    // FAIL SOFT (#1586). A label is housekeeping; the finding is the work. A
    // transient 500 on this idempotent write used to abort `createItem` and take
    // a fully composed body with it — observed live, and the identical command a
    // minute later succeeded, which proved the label was there all along. The
    // ordering above `gh issue create` stays (a filed item must not lose its
    // topic); only the consequence of failing changes, from "lose the item" to
    // "file it and say the label could not be ensured". `gh issue create` still
    // applies the topic, and GitHub creates a missing label on use.
    try {
      this.gh(['label', 'create', topic, '--repo', this.repo, '--force']);
      this.ensuredTopics.add(topic);
      this.log(`loop: ensured topic label '${topic}' in ${this.repo}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`loop: could not ensure topic label '${topic}' in ${this.repo} — filing anyway (${detail})`);
    }
  }

  /**
   * Labels the repo actually has, read once per instance — or `null` when the
   * repo could not be asked.
   *
   * NULL MEANS "UNKNOWN", AND UNKNOWN PASSES EVERYTHING THROUGH. This exists to
   * stop a filing being lost, so it must not become a new way to lose one: an
   * unreadable label list is an environment problem, and answering it by
   * stripping the loop's own provenance label would break scoping and dedup for
   * every item filed while `gh` was unhappy. The status quo — hand the labels to
   * `gh` and let it decide — is the safe answer to a question we could not ask.
   */
  private repoLabels(): Set<string> | null {
    if (this.knownLabels !== null) return this.knownLabels;
    let names: string[] | null = null;
    try {
      const parsed: unknown = JSON.parse(
        this.gh(['label', 'list', '--repo', this.repo, '--limit', '200', '--json', 'name']),
      );
      if (Array.isArray(parsed)) {
        names = parsed
          .map((entry) =>
            typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string'
              ? (entry as { name: string }).name
              : '',
          )
          .filter((name) => name.length > 0);
      }
    } catch {
      names = null;
    }
    if (names === null) return null;
    this.knownLabels = new Set(names);
    return this.knownLabels;
  }

  protected createItem(draft: ItemDraft): QueueItem {
    // BEFORE the create, because `gh issue create --label` fails on a label the
    // repo does not have — and a filed item that lost its topic to a failed
    // create is exactly the silent gap this ordering removes.
    if (draft.topic !== undefined) {
      this.ensureTopicLabel(draft.topic);
    }

    // ONE UNKNOWN TAG USED TO COST THE WHOLE FINDING. `gh issue create` fails
    // outright on a label the repo does not have, so a directive that tells a
    // run to tag work with a feature name — which is what this one does — threw
    // away a carefully written body every time the feature had no matching
    // label (#1577). The topic is CREATED because it is the one piece of repo
    // configuration a loop is allowed to write; everything else is dropped with
    // a warning instead, because inventing labels from `--labels` is exactly the
    // sprawl that narrowness exists to prevent, and losing the body is worse
    // than losing the tag.
    const known = this.repoLabels();
    const ensured = known === null ? null : new Set([...this.ensuredTopics, ...known]);
    const usable = ensured === null ? draft.labels : draft.labels.filter((label) => ensured.has(label));
    const dropped = ensured === null ? [] : draft.labels.filter((label) => !ensured.has(label));
    if (dropped.length > 0) {
      this.log(
        `loop: ${this.repo} has no label ${dropped.map((label) => `'${label}'`).join(', ')} — filed without ${dropped.length === 1 ? 'it' : 'them'}`,
      );
    }

    const args = ['issue', 'create', '--repo', this.repo, '--title', draft.title, '--body', draft.body];
    for (const label of usable) {
      args.push('--label', label);
    }
    return this.fetch(parseCreatedIssueNumber(this.gh(args)));
  }

  /**
   * Take or release a claim.
   *
   * TWO SHAPES, ONE VERB, decided by whose item it is:
   *
   *   - AN ITEM A LOOP FILED — the body carries the claim marker (GitHub has no
   *     field for it) and the label goes on beside it.
   *   - A PERSON'S ITEM — the label, and NOTHING ELSE. No `--body`, so the prose
   *     comes back byte-for-byte however many runs claim and release it. This is
   *     the one write a loop is allowed to make on someone else's issue, and the
   *     claimant it cannot store here lives in local state instead (the shared
   *     layer records it; see `foreign-items.ts`).
   */
  protected setClaim(id: string, owner: string | null): QueueItem {
    const current = this.fetch(id);
    const args = ['issue', 'edit', id, '--repo', this.repo];
    if (!isPersonsItem(current)) {
      args.push(
        '--body',
        owner === null
          ? `${withoutClaimMarker(current.body)}\n`
          : withClaimMarker(current.body, owner, this.nowIso()),
      );
    }
    args.push(owner === null ? '--remove-label' : '--add-label', CLAIMED_LABEL);
    // THE ASSIGNEE IS THE HALF A PERSON ACTUALLY SEES. The label has always been
    // written here, but a label only shows on the issue page; the assignee is
    // what appears in every list, filter and notification the other four
    // engineers already look at. It is also the only shared record of WHO holds
    // a person's issue — a loop may not write prose there, so the claimant used
    // to live in machine-local state and was invisible to everyone else.
    args.push(owner === null ? '--remove-assignee' : '--add-assignee', '@me');
    this.gh(args);

    // CONFIRM, DO NOT ASSUME. The write used to be fire-and-forget: two agents
    // on two machines could both label the same issue and both start fixing it,
    // which is the duplicate work the shared list has to prevent. Re-reading is
    // not atomic — nothing here can be — but it turns a silent double-claim into
    // a losing claim that the caller can act on.
    return this.fetch(id);
  }

  /**
   * Record or clear the plan whose pipeline a run is advancing on this item.
   *
   * ONE BODY EDIT, AND NOTHING ELSE. No label, no comment, no state change: the
   * marker is a note between two runs of the same loop, and giving it a visible
   * side effect would make entering a pipeline stage look like a decision about
   * the item. `withPlanMarker` strips before it appends, so re-recording the
   * same or a different plan never leaves two.
   *
   * The person's-item guard is belt-and-braces over the shared layer, which
   * diverts that case into local state before this is reached — the body of an
   * issue a person wrote is exactly what a loop may not touch.
   */
  protected setPlan(id: string, plan: string | null): QueueItem {
    const current = this.fetch(id);
    if (isPersonsItem(current)) return current;
    this.gh([
      'issue',
      'edit',
      id,
      '--repo',
      this.repo,
      '--body',
      plan === null ? `${withoutPlanMarker(current.body)}\n` : withPlanMarker(current.body, plan),
    ]);
    return this.fetch(id);
  }

  /**
   * Whether this claim survived — the item still reads as held by this owner.
   *
   * ONE COMPARISON, because the parse now resolves every shape of claim into
   * `claimedBy` before this is reached: a loop-filed item from its marker, a
   * person's item from the label-and-assignee pair, and either of them overlaid
   * with local state on the machine that actually holds it. So "is it still
   * mine" is just a name check, and an item that came back holding somebody else
   * — including the `@<login>` of a claim this machine has no record of taking —
   * fails it.
   *
   * An UNDEFINED claimant means the remote write did not land: no marker, and no
   * label-plus-assignee pair to derive one from. That is not a held claim
   * either, and calling it one is how a fire-and-forget write turned into two
   * machines fixing the same issue.
   */
  protected claimHeld(item: QueueItem, owner: string): boolean {
    return item.claimedBy === owner;
  }

  /**
   * Close an item and post the closing note.
   *
   * NEVER REACHED FOR A PERSON'S ITEM. The shared layer diverts that case into a
   * local handled record before it gets here, because closing someone's issue and
   * commenting on it are both writes a loop may not make — GitHub closes the
   * issue itself when the pull request carrying `Closes #<n>` merges.
   */
  protected setClosed(
    id: string,
    reason: QueueCloseReason,
    detail: string | undefined,
    evidence: CloseEvidence | undefined,
  ): QueueItem {
    this.gh([
      'issue',
      'close',
      id,
      '--repo',
      this.repo,
      '--reason',
      ghCloseReason(reason),
      '--comment',
      composeCloseNote(reason, detail, evidence),
    ]);
    return this.fetch(id);
  }

  protected setApproved(id: string, owner?: string): QueueItem {
    // `owner` is deliberately unused: GitHub already attributes the label
    // removal to whoever `gh` is authenticated as, and writing a second,
    // possibly-disagreeing name into the body would be a worse record than none.
    void owner;
    this.gh(['issue', 'edit', id, '--repo', this.repo, '--remove-label', APPROVAL_LABEL]);
    return this.fetch(id);
  }

  /**
   * Write the adopted body — one `gh issue edit --body`, and nothing else.
   *
   * NO LABEL IS ADDED AND NONE IS CREATED. The incident this rule answers made
   * a label exist so a hand-filed issue would fit the loop's schema; adoption
   * deliberately reconfigures nothing. The `--force` label creation above stays
   * exactly where it was — reachable only from `createItem`, only for the
   * directive's own topic, only on an item this loop is filing itself.
   */
  protected setAdopted(id: string, loop: string, body: string): QueueItem {
    // `loop` is already inside `body` (the shared layer composed the marker);
    // it is in the signature so a backend with a real provenance field can use
    // one, and this backend has none — the body IS the record.
    void loop;
    this.gh(['issue', 'edit', id, '--repo', this.repo, '--body', body]);
    return this.fetch(id);
  }

  /**
   * Record a merge — one comment on the issue, and nothing else.
   *
   * NOT A CLOSE AND NOT A LABEL. `gh issue comment` is the whole write: the
   * item's state, its labels and its claim are exactly as they were, because a
   * landed branch is a fact about the code and closing is a decision about the
   * report. Keeping them apart is what lets a person read the timeline and see
   * both, in order, with the evidence each rested on.
   *
   * NEVER REACHED FOR A PERSON'S ITEM, for the reason `setClosed` gives: a
   * comment is a write, and the shared layer records that merge locally instead.
   */
  protected setMerged(id: string, input: MergeRecordInput): QueueItem {
    this.gh(['issue', 'comment', id, '--repo', this.repo, '--body', composeMergeNote(input)]);
    return this.fetch(id);
  }

  /** Reopen a closed item — a fix that did not hold is workable again. */
  reopen(id: string): QueueItem {
    this.gh(['issue', 'reopen', id, '--repo', this.repo]);
    return this.fetch(id);
  }
}
