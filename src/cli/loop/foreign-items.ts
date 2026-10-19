/**
 * What a loop knows about items it did not file — `flow/loops/foreign.jsonl`.
 *
 * WHY THIS FILE EXISTS. A consumer's job is draining a queue, so it works
 * whatever is in it — including the issues a person opened by hand. But a
 * person's issue is theirs: the only thing a loop may write on it is the
 * `in-progress` label (added on claim, removed on release). No body rewrite, no
 * invented fingerprint, no closing comment, no close. So the two facts a loop
 * would normally keep ON the item have nowhere remote to live:
 *
 *   1. WHO IS WORKING IT. Under GitHub the claim is a marker in the body, and
 *      the body is exactly what may not be touched. Without a record of the
 *      claimant, `claimBlocker` cannot tell a held item from a free one and the
 *      honest-ending rule (`heldClaims`) cannot see the item a run walked away
 *      from — a `success` record while still holding it would stop being refused.
 *   2. THAT THIS LOOP ALREADY HANDLED IT. The issue itself stays OPEN: GitHub
 *      closes it when the pull request carrying `Closes #<n>` merges, which can
 *      be minutes or days later. Between the fix and the merge the item is still
 *      open, still unclaimed and still perfectly claimable — so the next run
 *      re-claims it and re-fixes it, forever. "Nothing happens" in a new costume.
 *   3. WHICH PIPELINE IT IS BEING WORKED THROUGH. A loop's own item records the
 *      plan in a `loop-plan:` body marker beside the claim; a person's item, for
 *      the same reason as (1), cannot carry one. Without it a run that finished
 *      a stage leaves the next run unable to see the pipeline at all (#1599).
 *
 * All three are LOCAL, DERIVED state about someone else's record, which is why they
 * live beside `state.json` and `beats.jsonl` rather than in the queue: losing
 * this file costs a duplicated run, never a lost issue.
 *
 * APPEND-ONLY, FOLDED ON READ — the same shape as `ledger-queue.ts` and the
 * blueprint stores, and deliberately not a new invention. The fold is the ONE
 * place an event's meaning is decided (allowed-pattern #14): `handled` clears
 * the claim because handing the item off IS the release, and `reworked` clears
 * the handled record because a fix that did not hold must be workable again.
 *
 * KEYED BY BACKEND + ITEM ID. An id is only unique inside one queue — issue 12
 * in a repo and item 12 in a ledger are different things — and a key that
 * ignored the backend would have them share a record.
 *
 * NO LOCK, unlike the ledger. Nothing here derives a value from the file before
 * writing (the ledger's id sequence is why that store needs one), so a single
 * short `appendFileSync` is all a write is.
 *
 * FAIL-SOFT PER LINE, like its siblings: a corrupt line is skipped, never fatal.
 * A queue that reported every item unclaimed because one line was truncated
 * would be worse than a queue that forgot one claim.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonlLines } from '../blueprint/store.js';
import { LOOPS_DIRNAME } from './directive-parser.js';
import type { LoopQueueKind } from './types.js';

/** Filename of the store inside `<flowDir>/loops/`. */
export const FOREIGN_ITEMS_FILENAME = 'foreign.jsonl';

/** Absolute path of the store for a flow directory. */
export function foreignItemsPath(flowDir: string): string {
  return join(flowDir, LOOPS_DIRNAME, FOREIGN_ITEMS_FILENAME);
}

/**
 * The five events an item a loop did not file can go through.
 *
 * `handled` is the one that matters most: it is written when a loop finishes
 * with such an item — a `close` that wrote nothing on the issue, or a merge that
 * landed its fix — and it is what stops the next run from claiming the same
 * still-open issue and doing the work again.
 *
 * `planned` is the third thing with nowhere remote to live. A loop's own item
 * records which pipeline a run is advancing in a `loop-plan:` body marker; a
 * person's item may not be written to at all, so the association lands here
 * instead — the same split the claim already has, and for the same reason.
 */
export type ForeignItemEventName =
  | 'claimed'
  | 'released'
  | 'planned'
  | 'branched'
  | 'handled'
  | 'reworked';

/** Every event name, for validation. */
export const FOREIGN_ITEM_EVENT_NAMES: readonly ForeignItemEventName[] = [
  'claimed',
  'released',
  'planned',
  'branched',
  'handled',
  'reworked',
];

/** One line of the store. */
export interface ForeignItemEvent {
  /** ISO timestamp of the event. */
  ts: string;
  /** Which queue the item lives in — ids are unique only inside one. */
  backend: LoopQueueKind;
  /** The item's id, as the backend spells it. */
  id: string;
  /** The loop that did this. Data, never part of the key. */
  loop: string;
  event: ForeignItemEventName;
  /** The run holding the claim (`claimed` only). */
  owner?: string;
  /**
   * The plan whose pipeline is being advanced (`planned` only). ABSENT OR EMPTY
   * CLEARS the record — one event in both directions, so "which plan" has one
   * writer however it changes.
   */
  plan?: string;
  /**
   * The remote branch this loop is using for the item (`branched` only).
   *
   * WHY IT LIVES HERE. Ownership of a loop's branch used to be READ FROM THE
   * BRANCH NAME — `loop/<name>.<id>` parses back to exactly one loop, which is
   * what `loop merge` checked. Once a consumer publishes on `feat/<ticket>`
   * (D3), the name carries no loop identity, so "which loop owns this branch for
   * this item" has nowhere to be read from — unless it was written down. This is
   * that record: local, derived, keyed by backend+id like the rest of the store,
   * and paired with the record's `loop` so a merge can refuse another loop's
   * (or a person's) branch without parsing a name (C-2, R-1). Absent or empty
   * clears it, the same one-writer-both-directions shape as `plan`.
   */
  branch?: string;
  /** Why — a written line for `handled` and `reworked`. */
  detail?: string;
}

/** The claim a loop holds on an item it did not file. */
export interface ForeignClaim {
  owner: string;
  at: string;
}

/** The pipeline a loop is advancing on an item it did not file. */
export interface ForeignPlan {
  name: string;
  at: string;
}

/** The record that a loop is finished with an item it did not file. */
export interface ForeignHandled {
  at: string;
  detail: string;
}

/** One item's folded state. */
export interface ForeignItemRecord {
  backend: LoopQueueKind;
  id: string;
  /** The loop that last acted on it. */
  loop: string;
  claim?: ForeignClaim;
  plan?: ForeignPlan;
  /** The remote branch this loop is using for the item, or undefined. */
  branch?: string;
  handled?: ForeignHandled;
}

/** The fold key: a backend and an id, because an id alone is not unique. */
export function foreignKey(backend: LoopQueueKind, id: string): string {
  return `${backend}#${id}`;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one raw record. Returns null when a REQUIRED field is missing. */
export function parseForeignItemEvent(raw: unknown): ForeignItemEvent | null {
  if (!isRecordObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (raw.backend !== 'github' && raw.backend !== 'ledger') return null;
  if (!FOREIGN_ITEM_EVENT_NAMES.includes(raw.event as ForeignItemEventName)) return null;

  const event: ForeignItemEvent = {
    ts: typeof raw.ts === 'string' ? raw.ts : '',
    backend: raw.backend,
    id: raw.id,
    loop: typeof raw.loop === 'string' ? raw.loop : '',
    event: raw.event as ForeignItemEventName,
  };
  if (typeof raw.owner === 'string') event.owner = raw.owner;
  if (typeof raw.plan === 'string') event.plan = raw.plan;
  if (typeof raw.branch === 'string') event.branch = raw.branch;
  if (typeof raw.detail === 'string') event.detail = raw.detail;
  return event;
}

/**
 * Fold events into records — the ONE place an event's meaning is decided.
 *
 * Applied in file order, which is also time order for an append-only store, so
 * the last word wins. Several of the transitions are cross-cutting and are the
 * reason this is a fold rather than a handful of setters:
 *
 *   - `handled` CLEARS THE CLAIM AND THE PLAN. Finishing with an item is a
 *     release; a record that showed an item both handled and still held would
 *     make the honest-ending rule refuse a run that ended correctly, and a plan
 *     left behind would offer the next run a pipeline nobody is working.
 *   - `reworked` CLEARS EVERYTHING. Working it again starts from nothing known.
 *   - `planned` SETS OR CLEARS, on whether it names a plan — the same event in
 *     both directions, so no second event can disagree about which plan is live.
 *
 * `released` deliberately leaves the plan alone: an item handed back to the
 * queue mid-pipeline still has a pipeline, and that is precisely the handoff the
 * next run needs to see.
 */
export function foldForeignItemEvents(
  events: readonly ForeignItemEvent[],
): Map<string, ForeignItemRecord> {
  const records = new Map<string, ForeignItemRecord>();
  for (const event of events) {
    const key = foreignKey(event.backend, event.id);
    const record: ForeignItemRecord = records.get(key) ?? {
      backend: event.backend,
      id: event.id,
      loop: event.loop,
    };
    record.loop = event.loop;
    switch (event.event) {
      case 'claimed':
        if (event.owner !== undefined && event.owner.length > 0) {
          record.claim = { owner: event.owner, at: event.ts };
        }
        break;
      case 'released':
        delete record.claim;
        break;
      case 'planned':
        if (event.plan !== undefined && event.plan.length > 0) {
          record.plan = { name: event.plan, at: event.ts };
        } else {
          delete record.plan;
        }
        break;
      case 'branched':
        // Sets or clears, the same both-directions shape as `planned`, so which
        // branch a loop owns for an item has one writer however it changes.
        if (event.branch !== undefined && event.branch.length > 0) {
          record.branch = event.branch;
        } else {
          delete record.branch;
        }
        break;
      case 'handled':
        delete record.claim;
        delete record.plan;
        // The branch is done with the item — like the plan, it does not outlive
        // being handled.
        delete record.branch;
        record.handled = { at: event.ts, detail: event.detail ?? '' };
        break;
      case 'reworked':
        delete record.claim;
        delete record.plan;
        delete record.branch;
        delete record.handled;
        break;
    }
    records.set(key, record);
  }
  return records;
}

/** Read and parse every line. A missing file yields nothing — not an error. */
export function readForeignItemEvents(filePath: string): ForeignItemEvent[] {
  const events: ForeignItemEvent[] = [];
  for (const line of readJsonlLines(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: a corrupt line costs itself, never the whole read
      continue;
    }
    const event = parseForeignItemEvent(parsed);
    if (event !== null) events.push(event);
  }
  return events;
}

/**
 * The surface the queue layer depends on: read the whole fold once, append one
 * event. Two methods on purpose — every rule about what an event MEANS lives in
 * the fold above, so a second implementation (the in-memory one below, a future
 * app-side one) cannot carry a different opinion.
 */
export interface ForeignItemState {
  /** Every record, folded. Read once per query rather than per item. */
  snapshot(): ReadonlyMap<string, ForeignItemRecord>;
  /** Append one event. */
  append(event: ForeignItemEvent): void;
}

/** The file-backed store — what every CLI path uses. */
export class ForeignItemStore implements ForeignItemState {
  constructor(private readonly filePath: string) {}

  /** Where this store lives — for reporting and for tests. */
  get path(): string {
    return this.filePath;
  }

  snapshot(): ReadonlyMap<string, ForeignItemRecord> {
    return foldForeignItemEvents(readForeignItemEvents(this.filePath));
  }

  append(event: ForeignItemEvent): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
  }
}

/**
 * An in-process store, for a backend constructed without one and for tests.
 *
 * It folds through the SAME function the file-backed one does, so a test that
 * proves a transition here has proven it everywhere.
 */
export function createMemoryForeignItemState(): ForeignItemState & {
  /** Every event appended, in order — so a test can read the writes back. */
  events: ForeignItemEvent[];
} {
  const events: ForeignItemEvent[] = [];
  return {
    events,
    snapshot: () => foldForeignItemEvents(events),
    append: (event) => {
      events.push(event);
    },
  };
}
