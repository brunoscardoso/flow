/**
 * The ledger queue backend — `flow/loops/queue.jsonl`.
 *
 * The queue for a project with no GitHub repo, no `gh` auth, or no wish to put
 * a robot's findings in front of humans yet. Same verbs, same refusals,
 * same item shape; the only thing that changes is where the bytes live.
 *
 * APPEND-ONLY, FOLDED ON READ — the fourth instance of the pattern
 * `proposal-store.ts` and `investigation-store.ts` already solved, and
 * deliberately not a fifth invention. Every line is one event; an item's
 * effective state is the LAST event for its id; the payload always comes from
 * its `filed` event. The file is never rewritten, so a crash can lose the tail
 * and nothing else, and the history of what a loop found and what happened to it
 * survives even when the item itself is long closed.
 *
 * WRITES TAKE ONE LOCK, reads never do — the same `acquireGraphLock` semantics
 * the sibling stores use (brief retry, stale reclaim), pointed at this store's
 * own lock file. Two runs filing at once is the ordinary case here, and the id
 * sequence is derived from the file inside the lock, so it cannot fork.
 *
 * FAIL-SOFT PER LINE, LIKE ITS SIBLINGS: a corrupt line is skipped and counted,
 * never fatal. That is the right trade for a queue — one unreadable line must
 * not make a producer believe the queue is empty and re-file everything.
 */

import { appendFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireGraphLock, readJsonlLines } from '../blueprint/store.js';
import { LOOPS_DIRNAME } from './directive-parser.js';
import {
  APPROVAL_LABEL,
  LoopQueueBackendBase,
  isPersonsItem,
  mergeSummary,
  withClaimMarker,
  withPlanMarker,
  withoutClaimMarker,
  withoutPlanMarker,
} from './queue-backend.js';
import type { ForeignItemState } from './foreign-items.js';
import type {
  CloseEvidence,
  ItemDraft,
  MergeRecordInput,
  QueueCloseReason,
  QueueItem,
  QueueQuery,
} from './queue-backend.js';
import { isQueueCloseReason } from './queue-backend.js';
import type { LoopEngine, LoopQueueKind } from './types.js';

/** Filename of the ledger inside `<flowDir>/loops/`. */
export const LEDGER_QUEUE_FILENAME = 'queue.jsonl';

/** Lock file shared by every ledger writer (ONE lock per store). */
const LEDGER_QUEUE_LOCK_FILENAME = 'queue.lock';

/** One-line notice thrown when an append cannot take the store lock. */
export const LEDGER_QUEUE_BUSY_NOTICE = 'loop queue ledger busy — retry';

/** Absolute path of the ledger for a flow directory. */
export function ledgerQueuePath(flowDir: string): string {
  return join(flowDir, LOOPS_DIRNAME, LEDGER_QUEUE_FILENAME);
}

/**
 * The ten events an item's life is made of.
 *
 * `reopened` exists because a close is not always final — a fix that did not
 * hold must be workable again, and rewriting the `closed` line to undo it would
 * break the one rule this store has.
 *
 * `merged` records that the branch for an item LANDED, with the evidence it
 * landed on. It changes no state — an item is not settled by its branch being
 * merged, and the two decisions stay separately auditable — so it exists purely
 * as history: without it, "closed as done" and "the fix is actually on main" are
 * the same line, and only one of them is true after a failed merge.
 *
 * `adopted` is the one line a person writes about someone else's item: it
 * carries the adopting loop and the body with the provenance marker appended.
 * An append rather than an edit to the `filed` line, for the same reason as
 * every other event — and so the history still shows the item arriving with no
 * loop and being taken on later, by whom, and when.
 *
 * `planned` records which plan's pipeline a run is advancing on the item, and
 * carries no plan when it is CLEARING that record. It is the ledger's half of
 * the `loop-plan:` marker — the association without which a run that finished a
 * stage left the next run unable to see the pipeline at all (#1599).
 */
export type LedgerQueueEventName =
  | 'filed'
  | 'claimed'
  | 'unclaimed'
  | 'planned'
  | 'approved'
  | 'labeled'
  | 'closed'
  | 'reopened'
  | 'merged'
  | 'adopted';

/** Every event name, for validation. */
export const LEDGER_QUEUE_EVENT_NAMES: readonly LedgerQueueEventName[] = [
  'filed',
  'claimed',
  'unclaimed',
  'planned',
  'approved',
  'labeled',
  'closed',
  'reopened',
  'merged',
  'adopted',
];

/**
 * One line of the ledger. Non-`filed` events re-carry `loop` so every line is
 * self-describing, but the fold always trusts the `filed` event's payload.
 */
export interface LedgerQueueEvent {
  /** ISO timestamp of the event. */
  ts: string;
  /** The item's id — the fold key. */
  id: string;
  /** The lifecycle event this line records. */
  event: LedgerQueueEventName;
  /** The loop the item belongs to. */
  loop: string;
  // `filed` payload
  title?: string;
  body?: string;
  fingerprint?: string;
  primaryFile?: string;
  /** Labels as of this event (`filed` and `labeled` carry the full set). */
  labels?: string[];
  /** Whether the item was filed behind the approval gate. */
  needsApproval?: boolean;
  // `claimed`
  owner?: string;
  /** `planned` — the plan being advanced. Absent CLEARS the record. */
  plan?: string;
  // `closed` — and `merged`, which carries the same two proof fields: a written
  // line naming what landed, and the captured commands it landed on.
  reason?: QueueCloseReason;
  detail?: string;
  evidence?: CloseEvidence;
  /** Where the event came from (e.g. `cli:loop file`) — never self-narration. */
  provenance: string;
}

/** Raw parse of the ledger, before folding. */
export interface ParsedLedgerQueue {
  /** Valid events, in file order. */
  events: LedgerQueueEvent[];
  /** Count of malformed lines skipped (corrupt JSON or invalid shape). */
  skipped: number;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one raw record. Returns null when a REQUIRED field is missing. */
function parseLedgerRecord(record: Record<string, unknown>): LedgerQueueEvent | null {
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  if (!LEDGER_QUEUE_EVENT_NAMES.includes(record.event as LedgerQueueEventName)) return null;
  if (typeof record.loop !== 'string' || record.loop.length === 0) return null;

  const event: LedgerQueueEvent = {
    ts: typeof record.ts === 'string' ? record.ts : '',
    id: record.id,
    event: record.event as LedgerQueueEventName,
    loop: record.loop,
    provenance: typeof record.provenance === 'string' ? record.provenance : '',
  };
  if (typeof record.title === 'string') event.title = record.title;
  if (typeof record.body === 'string') event.body = record.body;
  if (typeof record.fingerprint === 'string') event.fingerprint = record.fingerprint;
  if (typeof record.primaryFile === 'string') event.primaryFile = record.primaryFile;
  if (Array.isArray(record.labels)) {
    event.labels = record.labels.filter((label): label is string => typeof label === 'string');
  }
  if (typeof record.needsApproval === 'boolean') event.needsApproval = record.needsApproval;
  if (typeof record.owner === 'string') event.owner = record.owner;
  if (typeof record.plan === 'string') event.plan = record.plan;
  if (typeof record.reason === 'string' && isQueueCloseReason(record.reason)) {
    event.reason = record.reason;
  }
  if (typeof record.detail === 'string') event.detail = record.detail;
  if (isRecordObject(record.evidence)) event.evidence = record.evidence as unknown as CloseEvidence;
  return event;
}

/**
 * Read and parse every line of a ledger file. A missing file yields empty
 * results — a project that has never filed is not a broken one.
 */
export function parseLedgerQueueFile(filePath: string): ParsedLedgerQueue {
  const events: LedgerQueueEvent[] = [];
  let skipped = 0;

  for (const line of readJsonlLines(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: a corrupt line costs itself, never the whole read
      skipped += 1;
      continue;
    }
    if (!isRecordObject(parsed)) {
      skipped += 1;
      continue;
    }
    const event = parseLedgerRecord(parsed);
    if (event === null) {
      skipped += 1;
      continue;
    }
    events.push(event);
  }

  return { events, skipped };
}

/**
 * Fold events into items: group by id, order by ts (ties by file order), take
 * the payload from the `filed` event and apply every later event in order.
 *
 * A group with no `filed` event is DROPPED — there is nothing to carry, and an
 * item conjured from a `claimed` line alone would have no title, no fingerprint
 * and no way to be deduped against.
 *
 * Result is sorted by createdAt then id, so two reads of one file always yield
 * the same order and the claim order below it is stable.
 */
export function foldLedgerQueueEvents(events: readonly LedgerQueueEvent[]): QueueItem[] {
  const groups = new Map<string, Array<{ event: LedgerQueueEvent; fileIndex: number }>>();
  for (let fileIndex = 0; fileIndex < events.length; fileIndex += 1) {
    const group = groups.get(events[fileIndex].id) ?? [];
    group.push({ event: events[fileIndex], fileIndex });
    groups.set(events[fileIndex].id, group);
  }

  const items: QueueItem[] = [];
  for (const [id, group] of groups) {
    const ordered = [...group].sort((a, b) => {
      if (a.event.ts !== b.event.ts) return a.event.ts.localeCompare(b.event.ts);
      return a.fileIndex - b.fileIndex;
    });
    const filed = ordered.find((entry) => entry.event.event === 'filed');
    if (filed === undefined) continue;

    const payload = filed.event;
    const item: QueueItem = {
      id,
      loop: payload.loop,
      title: payload.title ?? '',
      body: payload.body ?? '',
      fingerprint: payload.fingerprint ?? '',
      state: 'open',
      labels: [...(payload.labels ?? [])],
      approved: payload.needsApproval !== true,
      createdAt: payload.ts,
    };
    if (payload.primaryFile !== undefined) item.primaryFile = payload.primaryFile;

    for (const { event } of ordered) {
      switch (event.event) {
        case 'filed':
          break;
        case 'claimed':
          if (event.owner !== undefined) {
            item.claimedBy = event.owner;
            item.claimedAt = event.ts;
            item.body = withClaimMarker(item.body, event.owner, event.ts);
          }
          break;
        case 'unclaimed':
          delete item.claimedBy;
          delete item.claimedAt;
          item.body = `${withoutClaimMarker(item.body)}\n`;
          break;
        case 'planned':
          // FIELD AND MARKER TOGETHER, like the claim above: the field is what
          // every reader uses, and the marker is what survives an item being
          // copied out of this ledger into a repo. An event naming no plan is
          // the clear — one event in both directions (`recordPlan`).
          if (event.plan !== undefined && event.plan.length > 0) {
            item.plan = event.plan;
            item.body = withPlanMarker(item.body, event.plan);
          } else {
            delete item.plan;
            item.body = `${withoutPlanMarker(item.body)}\n`;
          }
          break;
        case 'approved':
          // The ledger's approval is a FIELD flip, where GitHub's is a label
          // removal. The reserved label is dropped too so a ledger item copied
          // into a repo does not arrive still wearing a gate it has cleared.
          item.approved = true;
          item.labels = item.labels.filter((label) => label !== APPROVAL_LABEL);
          break;
        case 'labeled':
          item.labels = [...(event.labels ?? [])];
          item.approved = item.approved && !item.labels.includes(APPROVAL_LABEL);
          break;
        case 'closed':
          item.state = 'closed';
          item.closedAt = event.ts;
          if (event.reason !== undefined) item.closeReason = event.reason;
          break;
        case 'reopened':
          item.state = 'open';
          delete item.closedAt;
          delete item.closeReason;
          break;
        case 'merged':
          // History only, on purpose (see the event list): a landed branch does
          // not settle the item, so nothing here touches its state. The record
          // lives on the line, where `events()` and a human reading the ledger
          // both find it next to the evidence it landed on.
          break;
        case 'adopted':
          // The body is the record of provenance, and the field follows it so
          // a scoped read (`list({loop})`) sees the item as the adopting loop's
          // from the next read on.
          if (event.body !== undefined) item.body = event.body;
          item.loop = event.loop;
          break;
      }
    }
    items.push(item);
  }

  return items.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

/**
 * Run `write` holding the store's single lock. Creates the directory when
 * absent; throws the one-line busy notice when the lock stays contended, in
 * which case nothing is written.
 */
function withLedgerLock<T>(filePath: string, write: () => T): T {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, LEDGER_QUEUE_LOCK_FILENAME);
  if (!acquireGraphLock(lockPath)) {
    throw new Error(LEDGER_QUEUE_BUSY_NOTICE);
  }
  try {
    return write();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Sanctioned fail-soft: lock already removed (reclaimed as stale) — nothing to clean up
    }
  }
}

/** Append one event — the ONLY writer of the ledger, under the store's lock. */
export function appendLedgerQueueEvent(filePath: string, event: LedgerQueueEvent): void {
  withLedgerLock(filePath, () => {
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
  });
}

/**
 * Append an event whose content depends on what is ALREADY in the store, with
 * the read and the write inside one lock window.
 *
 * This exists for exactly one reason: the ledger's ids are a sequence derived
 * from the file, and deriving them outside the lock lets two runs filing at
 * once mint the same id. `build` receives the freshly folded items and returns
 * the event to append.
 */
export function appendLedgerQueueEventFor(
  filePath: string,
  build: (items: QueueItem[]) => LedgerQueueEvent,
): LedgerQueueEvent {
  return withLedgerLock(filePath, () => {
    // Read INSIDE the lock — that is the whole point of this function.
    const event = build(readLedgerQueue(filePath));
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
    return event;
  });
}

/** Read the ledger's effective items. Never locks — reads are always safe. */
export function readLedgerQueue(filePath: string): QueueItem[] {
  return foldLedgerQueueEvents(parseLedgerQueueFile(filePath).events);
}

/**
 * The ledger backend. Supplies the seven primitives and nothing else — the cap,
 * dedup, eligibility, provenance and evidence rules all come from `LoopQueueBackendBase`.
 */
export class LedgerQueueBackend extends LoopQueueBackendBase {
  readonly kind: LoopQueueKind = 'ledger';

  /**
   * @param filePath absolute path of the ledger file. Resolved by the caller
   *   from the directive's `path`, so this class never guesses at a layout.
   * @param engine the directive's engine — decides what this loop may WORK.
   * @param local the local record for items no loop filed (`foreign-items.ts`).
   */
  constructor(
    private readonly filePath: string,
    clock: () => number = Date.now,
    private readonly provenance = 'cli:loop',
    engine?: LoopEngine,
    local?: ForeignItemState,
  ) {
    super(clock, engine, local);
  }

  /** Where this backend's ledger lives — for reporting and for tests. */
  get path(): string {
    return this.filePath;
  }

  /** Every event in the store, in file order. Exposed for `loop log`. */
  events(): LedgerQueueEvent[] {
    return parseLedgerQueueFile(this.filePath).events;
  }

  protected listItems(query: QueueQuery): QueueItem[] {
    const state = query.state ?? 'all';
    return readLedgerQueue(this.filePath).filter(
      (item) =>
        (state === 'all' || item.state === state) &&
        (query.loop === undefined || item.loop === query.loop),
    );
  }

  /** One item by id (#1636). The ledger is a local fold — no page to fall off. */
  protected fetchItem(id: string): QueueItem | null {
    return readLedgerQueue(this.filePath).find((item) => item.id === id) ?? null;
  }

  /** Read one item, refusing loudly — the base class only calls this on ids it read. */
  private require(id: string): QueueItem {
    const item = readLedgerQueue(this.filePath).find((entry) => entry.id === id);
    if (item === undefined) {
      throw new Error(`${this.filePath}: no item '${id}' in the ledger`);
    }
    return item;
  }

  private append(event: Omit<LedgerQueueEvent, 'ts' | 'provenance'>): void {
    appendLedgerQueueEvent(this.filePath, {
      ...event,
      ts: this.nowIso(),
      provenance: this.provenance,
    });
  }

  /** Next id: one past the highest numeric id currently in the file. */
  private nextId(items: readonly QueueItem[]): string {
    const highest = items.reduce((max, item) => {
      const numeric = Number.parseInt(item.id, 10);
      return Number.isNaN(numeric) ? max : Math.max(max, numeric);
    }, 0);
    return String(highest + 1);
  }

  protected createItem(draft: ItemDraft): QueueItem {
    // Id and append share ONE lock window — deriving the sequence outside it
    // lets two runs filing into one ledger mint the same id.
    const filed = appendLedgerQueueEventFor(this.filePath, (items) => {
      const event: LedgerQueueEvent = {
        ts: this.nowIso(),
        id: this.nextId(items),
        event: 'filed',
        loop: draft.loop,
        title: draft.title,
        body: draft.body,
        fingerprint: draft.fingerprint,
        labels: [...draft.labels],
        needsApproval: !draft.approved,
        provenance: this.provenance,
      };
      if (draft.primaryFile !== undefined) event.primaryFile = draft.primaryFile;
      return event;
    });
    return this.require(filed.id);
  }

  /**
   * Take or release a claim.
   *
   * A PERSON'S ITEM GETS NO EVENT. Such an item can only reach a ledger by hand,
   * carries no loop, and every event line requires one — but the deeper reason is
   * the same rule GitHub obeys: what a loop knows about someone else's item lives
   * in local state, not written onto the record they wrote (`foreign-items.ts`,
   * appended by the shared layer). There is nothing here that is this store's to
   * change, so it changes nothing.
   */
  protected setClaim(id: string, owner: string | null): QueueItem {
    const item = this.require(id);
    if (isPersonsItem(item)) {
      return item;
    }
    if (owner === null) {
      this.append({ id, event: 'unclaimed', loop: item.loop });
    } else {
      this.append({ id, event: 'claimed', loop: item.loop, owner });
    }
    return this.require(id);
  }

  /**
   * Record or clear which plan's pipeline a run is advancing on this item.
   *
   * A PERSON'S ITEM GETS NO EVENT, exactly as `setClaim` gives it none, and for
   * the same reason — what a loop knows about someone else's record lives in
   * local state (`foreign-items.ts`), which the shared layer writes before this
   * is ever reached.
   */
  protected setPlan(id: string, plan: string | null): QueueItem {
    const item = this.require(id);
    if (isPersonsItem(item)) {
      return item;
    }
    this.append({
      id,
      event: 'planned',
      loop: item.loop,
      ...(plan === null ? {} : { plan }),
    });
    return this.require(id);
  }

  protected setClosed(
    id: string,
    reason: QueueCloseReason,
    detail: string | undefined,
    evidence: CloseEvidence | undefined,
  ): QueueItem {
    const item = this.require(id);
    const event: Omit<LedgerQueueEvent, 'ts' | 'provenance'> = {
      id,
      event: 'closed',
      loop: item.loop,
      reason,
    };
    if (detail !== undefined) event.detail = detail;
    // The evidence is stored VERBATIM on the closing line. It is the audit trail
    // for a decision made unattended: without it, "closed as done" is exactly
    // the worker's own summary that forbidden-pattern #7 says not to trust.
    if (evidence !== undefined) event.evidence = evidence;
    this.append(event);
    return this.require(id);
  }

  protected setApproved(id: string, owner?: string): QueueItem {
    const item = this.require(id);
    // Who cleared the gate is recorded: an approval is the one moment a human
    // overrides the loop, and an audit trail that cannot say who did it is not
    // an audit trail.
    const event: Omit<LedgerQueueEvent, 'ts' | 'provenance'> = { id, event: 'approved', loop: item.loop };
    if (owner !== undefined) event.owner = owner;
    this.append(event);
    return this.require(id);
  }

  /**
   * Record an adoption — the body with the marker appended, under the loop
   * taking the item on. No label is written: adoption changes who the item
   * belongs to and nothing about how it is filed.
   */
  protected setAdopted(id: string, loop: string, body: string): QueueItem {
    this.append({ id, event: 'adopted', loop, body });
    return this.require(id);
  }

  /**
   * Record a merge — one line carrying what landed and the evidence it landed
   * on, verbatim. Nothing about the item changes: closing it is a separate act
   * with a separate gate.
   */
  protected setMerged(id: string, input: MergeRecordInput): QueueItem {
    const item = this.require(id);
    const event: Omit<LedgerQueueEvent, 'ts' | 'provenance'> = {
      id,
      event: 'merged',
      loop: item.loop,
      detail: mergeSummary(input),
      evidence: input.evidence,
    };
    if (input.owner !== undefined) event.owner = input.owner;
    this.append(event);
    return this.require(id);
  }

  /** Replace an item's labels (e.g. parking it). Append-only, like everything else. */
  setLabels(id: string, labels: readonly string[]): QueueItem {
    const item = this.require(id);
    this.append({ id, event: 'labeled', loop: item.loop, labels: [...labels] });
    return this.require(id);
  }

  /** Reopen a closed item — a fix that did not hold is workable again. */
  reopen(id: string): QueueItem {
    const item = this.require(id);
    this.append({ id, event: 'reopened', loop: item.loop });
    return this.require(id);
  }
}
