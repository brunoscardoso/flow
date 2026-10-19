/**
 * Tests for the ledger queue backend.
 *
 * Real fs via mkdtemp, like the sibling store tests; the clock is injected, so
 * every timestamp is arithmetic and nothing sleeps.
 *
 * The shared rules (cap, dedup, eligibility, evidence) are proven once against
 * the base class in `queue-backend.test.ts` and are NOT re-proven here. What is
 * proven here is what this backend actually owns: append-only writes that are
 * never rewritten, the last-event-wins fold, id minting, and fail-soft parsing.
 * The one exception is a short end-to-end pass, because "the shared rules
 * reach a real backend" is itself a fact worth asserting.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  LEDGER_QUEUE_EVENT_NAMES,
  LEDGER_QUEUE_FILENAME,
  LedgerQueueBackend,
  appendLedgerQueueEvent,
  foldLedgerQueueEvents,
  ledgerQueuePath,
  parseLedgerQueueFile,
  readLedgerQueue,
} from './ledger-queue.js';
import type { LedgerQueueEvent } from './ledger-queue.js';
import { APPROVAL_LABEL, PARKED_LABEL } from './queue-backend.js';
import type { CloseEvidence } from './queue-backend.js';
import { loopFingerprint } from './fingerprint.js';

const T0 = Date.parse('2026-08-12T09:00:00.000Z');
const MINUTE = 60 * 1000;

const PASSING_EVIDENCE: CloseEvidence = {
  commands: [{ command: 'npm run test -- src/queue.test.ts', exitCode: 0 }],
  artifacts: ['flow/.evidence/run/queue.log'],
};

describe('ledger queue backend', () => {
  let tempDir: string;
  let flowDir: string;
  let filePath: string;
  let now: number;
  let backend: LedgerQueueBackend;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'plan-flow-loop-ledger-test-'));
    flowDir = join(tempDir, 'flow');
    filePath = ledgerQueuePath(flowDir);
    now = T0;
    backend = new LedgerQueueBackend(filePath, () => now, 'cli:loop test');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function file(overrides: Record<string, unknown> = {}) {
    return backend.file({
      loop: 'find',
      title: 'Unhandled rejection in queue.ts',
      body: 'It throws under load.',
      primaryFile: 'src/queue.ts',
      maxOpenIssues: 8,
      ...overrides,
    });
  }

  function fileOrThrow(overrides: Record<string, unknown> = {}) {
    const result = file(overrides);
    if (result.status !== 'filed') throw new Error(`expected filed, got ${result.status}`);
    return result.item;
  }

  /** Every raw line of the ledger, for append-only assertions. */
  function lines(): string[] {
    return existsSync(filePath)
      ? readFileSync(filePath, 'utf-8').split('\n').filter((line) => line.trim().length > 0)
      : [];
  }

  describe('paths and empty state', () => {
    it('lives at flow/loops/queue.jsonl', () => {
      expect(ledgerQueuePath(flowDir)).toBe(join(flowDir, 'loops', LEDGER_QUEUE_FILENAME));
    });

    it('reads a missing file as an empty queue', () => {
      expect(readLedgerQueue(filePath)).toEqual([]);
      expect(backend.count()).toEqual({
        open: 0,
        closed: 0,
        claimed: 0,
        awaitingApproval: 0,
        parked: 0,
        claimable: 0,
      });
      expect(backend.claim({ owner: 'beat-1' }).status).toBe('empty');
    });

    it('reports its own kind and path', () => {
      expect(backend.kind).toBe('ledger');
      expect(backend.path).toBe(filePath);
    });
  });

  describe('append-only writes', () => {
    it('creates the loops directory on first file', () => {
      fileOrThrow();
      expect(existsSync(filePath)).toBe(true);
      expect(lines()).toHaveLength(1);
    });

    it('never rewrites an existing line', () => {
      const item = fileOrThrow();
      const afterFile = lines();
      now += MINUTE;
      backend.claim({ owner: 'beat-1', id: item.id });
      now += MINUTE;
      backend.close({ id: item.id, owner: 'beat-1', reason: 'done', evidence: PASSING_EVIDENCE });

      const afterClose = lines();
      expect(afterClose).toHaveLength(3);
      // The original line is byte-identical and still first.
      expect(afterClose[0]).toBe(afterFile[0]);
      expect(afterClose.map((line) => JSON.parse(line).event)).toEqual(['filed', 'claimed', 'closed']);
    });

    it('stores the close evidence verbatim on the closing line', () => {
      const item = fileOrThrow();
      backend.close({ id: item.id, reason: 'done', evidence: PASSING_EVIDENCE, detail: 'fixed' });
      const closed = JSON.parse(lines()[1]) as LedgerQueueEvent;
      expect(closed.evidence).toEqual(PASSING_EVIDENCE);
      expect(closed.detail).toBe('fixed');
      expect(closed.provenance).toBe('cli:loop test');
    });

    it('mints sequential ids, and keeps minting past a closed item', () => {
      expect(fileOrThrow({ title: 'alpha' }).id).toBe('1');
      const beta = fileOrThrow({ title: 'beta' });
      expect(beta.id).toBe('2');
      backend.close({ id: beta.id, reason: 'wontfix', detail: 'by design' });
      expect(fileOrThrow({ title: 'gamma' }).id).toBe('3');
    });

    it('sees a ledger written by another process — state is the file, not memory', () => {
      const first = new LedgerQueueBackend(filePath, () => now);
      const second = new LedgerQueueBackend(filePath, () => now);
      first.file({ loop: 'find', title: 'alpha', body: '', maxOpenIssues: 8 });
      const fromSecond = second.file({ loop: 'find', title: 'beta', body: '', maxOpenIssues: 8 });
      if (fromSecond.status !== 'filed') throw new Error('expected filed');
      expect(fromSecond.item.id).toBe('2');
      expect(second.count().open).toBe(2);
      expect(first.count().open).toBe(2);
    });

    it('leaves no lock file behind', () => {
      fileOrThrow();
      expect(existsSync(join(flowDir, 'loops', 'queue.lock'))).toBe(false);
    });
  });

  describe('the fold', () => {
    it('records what was filed, with the markers the base layer composed', () => {
      const item = fileOrThrow();
      expect(item).toMatchObject({
        id: '1',
        loop: 'find',
        title: 'Unhandled rejection in queue.ts',
        primaryFile: 'src/queue.ts',
        state: 'open',
        approved: true,
        createdAt: new Date(T0).toISOString(),
      });
      expect(item.fingerprint).toBe(
        loopFingerprint({
          loop: 'find',
          title: 'Unhandled rejection in queue.ts',
          primaryFile: 'src/queue.ts',
        }),
      );
      expect(item.body).toContain(`<!-- loop-fp: ${item.fingerprint} -->`);
      expect(item.body).toContain('<!-- loop: find -->');
      expect(item.body).toContain('<!-- loop-file: src/queue.ts -->');
    });

    it('applies claim then unclaim, leaving no claim marker behind', () => {
      const item = fileOrThrow();
      now += MINUTE;
      backend.claim({ owner: 'beat-1', id: item.id });
      const claimed = readLedgerQueue(filePath)[0];
      expect(claimed.claimedBy).toBe('beat-1');
      expect(claimed.claimedAt).toBe(new Date(T0 + MINUTE).toISOString());
      expect(claimed.body).toContain('<!-- loop-claim: beat-1 @');

      now += MINUTE;
      const unclaimed = backend.unclaim(item.id);
      if (unclaimed.status !== 'unclaimed') throw new Error(unclaimed.reason);
      expect(unclaimed.item.claimedBy).toBeUndefined();
      expect(unclaimed.item.body).not.toContain('loop-claim');
      // …and it is claimable again, by anyone.
      expect(backend.claim({ owner: 'beat-2' }).status).toBe('claimed');
    });

    it('records the plan as an event AND a marker, and clears both again (#1599)', () => {
      const item = fileOrThrow();
      now += MINUTE;
      backend.claim({ owner: 'beat-1', id: item.id });
      now += MINUTE;
      const recorded = backend.recordPlan({
        id: item.id,
        loop: 'find',
        owner: 'beat-1',
        plan: 'state-md-handoff',
      });
      if (recorded.status !== 'recorded') throw new Error(recorded.reason);

      // the FIELD is what every reader uses; the MARKER is what survives this
      // item being copied out of the ledger into a repo
      const planned = readLedgerQueue(filePath)[0];
      expect(planned.plan).toBe('state-md-handoff');
      expect(planned.body).toContain('<!-- loop-plan: state-md-handoff -->');
      expect(planned.claimedBy).toBe('beat-1');

      now += MINUTE;
      const cleared = backend.recordPlan({ id: item.id, loop: 'find', owner: 'beat-1' });
      if (cleared.status !== 'recorded') throw new Error(cleared.reason);
      const after = readLedgerQueue(filePath)[0];
      expect(after.plan).toBeUndefined();
      expect(after.body).not.toContain('loop-plan');
      // append-only throughout: filed, claimed, planned, planned
      expect(lines()).toHaveLength(4);
    });

    it('flips the approval FIELD and drops the reserved label', () => {
      const item = fileOrThrow({ needsApproval: true, labels: ['loop-queue'] });
      expect(item.approved).toBe(false);
      expect(item.labels).toEqual(['loop-queue', APPROVAL_LABEL]);

      const approved = backend.approve(item.id, 'devuser');
      if (approved.status !== 'approved') throw new Error('expected approved');
      expect(approved.item.approved).toBe(true);
      expect(approved.item.labels).toEqual(['loop-queue']);
      // Who cleared the gate is on the record — an approval is a human override.
      expect(backend.events().find((event) => event.event === 'approved')?.owner).toBe('devuser');
    });

    it('replaces the label set on a labeled event, re-applying the approval gate', () => {
      const item = fileOrThrow();
      const parked = backend.setLabels(item.id, ['loop-queue', PARKED_LABEL]);
      expect(parked.labels).toEqual(['loop-queue', PARKED_LABEL]);
      expect(backend.claim({ owner: 'beat-1' }).status).toBe('empty');

      const regated = backend.setLabels(item.id, [APPROVAL_LABEL]);
      expect(regated.approved).toBe(false);
    });

    it('reopens a closed item — a fix that did not hold is workable again', () => {
      const item = fileOrThrow();
      backend.close({ id: item.id, reason: 'done', evidence: PASSING_EVIDENCE });
      expect(readLedgerQueue(filePath)[0].state).toBe('closed');

      const reopened = backend.reopen(item.id);
      expect(reopened.state).toBe('open');
      expect(reopened.closedAt).toBeUndefined();
      expect(reopened.closeReason).toBeUndefined();
      expect(backend.claim({ owner: 'beat-1' }).status).toBe('claimed');
    });

    it('takes the last event for an id, whatever order the lines arrived in', () => {
      const events: LedgerQueueEvent[] = [
        {
          ts: '2026-08-12T09:00:02.000Z',
          id: '1',
          event: 'closed',
          loop: 'find',
          reason: 'done',
          provenance: 'test',
        },
        {
          ts: '2026-08-12T09:00:00.000Z',
          id: '1',
          event: 'filed',
          loop: 'find',
          title: 'a leak',
          body: 'b',
          fingerprint: 'f',
          provenance: 'test',
        },
        {
          ts: '2026-08-12T09:00:01.000Z',
          id: '1',
          event: 'claimed',
          loop: 'find',
          owner: 'beat-1',
          provenance: 'test',
        },
      ];
      const folded = foldLedgerQueueEvents(events);
      expect(folded).toHaveLength(1);
      expect(folded[0]).toMatchObject({ state: 'closed', claimedBy: 'beat-1', title: 'a leak' });
    });

    it('drops an id that has no filed event — there is nothing to carry', () => {
      expect(
        foldLedgerQueueEvents([
          { ts: '2026-08-12T09:00:00.000Z', id: '9', event: 'claimed', loop: 'find', owner: 'x', provenance: 't' },
        ]),
      ).toEqual([]);
    });

    it('orders items oldest-first, ties broken numerically by id', () => {
      fileOrThrow({ title: 'alpha' });
      now += MINUTE;
      fileOrThrow({ title: 'beta' });
      now += MINUTE;
      fileOrThrow({ title: 'gamma' });
      expect(readLedgerQueue(filePath).map((item) => item.title)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('knows its event names', () => {
      expect(LEDGER_QUEUE_EVENT_NAMES).toEqual([
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
      ]);
    });
  });

  describe('fail-soft parsing', () => {
    it('skips and counts a corrupt line rather than reporting an empty queue', () => {
      fileOrThrow({ title: 'alpha' });
      appendFileSync(filePath, 'not json at all\n', 'utf-8');
      appendFileSync(filePath, '[1,2,3]\n', 'utf-8');
      appendFileSync(filePath, '{"id":"","event":"filed","loop":"find"}\n', 'utf-8');
      appendFileSync(filePath, '{"id":"7","event":"exploded","loop":"find"}\n', 'utf-8');
      now += MINUTE;
      fileOrThrow({ title: 'beta' });

      const parsed = parseLedgerQueueFile(filePath);
      expect(parsed.skipped).toBe(4);
      expect(parsed.events).toHaveLength(2);
      expect(readLedgerQueue(filePath).map((item) => item.title)).toEqual(['alpha', 'beta']);
    });

    it('reads an empty file as an empty queue', () => {
      mkdirSync(join(flowDir, 'loops'), { recursive: true });
      writeFileSync(filePath, '\n  \n', 'utf-8');
      expect(readLedgerQueue(filePath)).toEqual([]);
    });

    it('exposes the raw events for a log digest', () => {
      const item = fileOrThrow();
      backend.claim({ owner: 'beat-1', id: item.id });
      expect(backend.events().map((event) => event.event)).toEqual(['filed', 'claimed']);
    });

    it('appends a hand-built event without disturbing the fold', () => {
      const item = fileOrThrow();
      appendLedgerQueueEvent(filePath, {
        ts: new Date(T0 + MINUTE).toISOString(),
        id: item.id,
        event: 'labeled',
        loop: 'find',
        labels: [PARKED_LABEL],
        provenance: 'test',
      });
      expect(readLedgerQueue(filePath)[0].labels).toEqual([PARKED_LABEL]);
    });
  });

  describe('the shared rules reach this backend', () => {
    it('dedups, caps, gates the claim and refuses a prose-only close', () => {
      // dedup, including across a wontfix close (the permanent memory)
      const first = fileOrThrow({ title: 'Unhandled rejection in queue.ts (line 42)' });
      expect(
        file({ title: 'unhandled rejection in queue.ts, line 480!', primaryFile: './src/Queue.ts' }).status,
      ).toBe('duplicate');
      backend.close({ id: first.id, reason: 'wontfix', detail: 'by design' });
      expect(file({ title: 'Unhandled rejection in queue.ts (line 42)' }).status).toBe('duplicate');

      // cap
      const capped = new LedgerQueueBackend(join(tempDir, 'capped.jsonl'), () => now);
      expect(capped.file({ loop: 'find', title: 'alpha', body: '', maxOpenIssues: 1 }).status).toBe('filed');
      const refused = capped.file({ loop: 'find', title: 'beta', body: '', maxOpenIssues: 1 });
      expect(refused).toEqual({ status: 'refused', reason: 'open-item cap reached — 1 open, max 1' });

      // approval gate, then claim
      const gated = fileOrThrow({ title: 'needs a human', needsApproval: true });
      expect(backend.claim({ owner: 'beat-1' }).status).toBe('empty');
      backend.approve(gated.id);
      const claimed = backend.claim({ owner: 'beat-1' });
      if (claimed.status !== 'claimed') throw new Error('expected a claim');
      expect(claimed.item.id).toBe(gated.id);

      // the evidence gate
      const proseOnly = backend.close({
        id: gated.id,
        owner: 'beat-1',
        reason: 'done',
        detail: 'I fixed it, everything passes.',
      });
      expect(proseOnly.status).toBe('refused');
      if (proseOnly.status !== 'refused') return;
      expect(proseOnly.reason).toContain('machine-checkable evidence');
      expect(readLedgerQueue(filePath).find((item) => item.id === gated.id)?.state).toBe('open');

      expect(
        backend.close({ id: gated.id, owner: 'beat-1', reason: 'done', evidence: PASSING_EVIDENCE }).status,
      ).toBe('closed');
    });
  });
});

/**
 * Phase 3 — adoption is one appended event, like everything else in this store.
 *
 * The `filed` line a person wrote is never rewritten: the history still shows an
 * item arriving with no loop and being taken on later, by which loop and when.
 */
describe('adoption appends, and never rewrites the line a person wrote', () => {
  it('records an `adopted` event carrying the marker, leaving `filed` untouched', () => {
    const flowDir = mkdtempSync(join(tmpdir(), 'loop-ledger-adopt-'));
    const filePath = join(flowDir, 'loops', 'queue.jsonl');
    mkdirSync(join(flowDir, 'loops'), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify({
        ts: '2026-08-12T08:00:00.000Z',
        id: '1509',
        event: 'filed',
        loop: 'fix',
        title: 'Quick locations on the map is not working',
        body: 'Tapping a saved location does nothing on the second try.',
        provenance: 'human',
      })}\n`,
      'utf-8',
    );
    const backend = new LedgerQueueBackend(filePath, () => T0, 'test');

    expect(backend.claim({ owner: 'beat-1', loop: 'fix', id: '1509' }).status).toBe('refused');

    const adopted = backend.adopt({ id: '1509', loop: 'fix', detail: 'ours' });
    expect(adopted.status).toBe('adopted');

    const events = backend.events();
    expect(events.map((event) => event.event)).toEqual(['filed', 'adopted']);
    expect(events[0].body).toBe('Tapping a saved location does nothing on the second try.');
    expect(events[1].body).toContain('<!-- loop: fix -->');
    expect(backend.claim({ owner: 'beat-1', loop: 'fix', id: '1509' }).status).toBe('claimed');

    rmSync(flowDir, { recursive: true, force: true });
  });
});

/**
 * Phase 4 — a merge is one more appended line, and settles nothing.
 *
 * The store's whole job here is to keep the two facts apart: "the branch for
 * this item landed" and "this item is resolved". A merge that quietly closed
 * would make the close's evidence gate reachable by merging instead.
 */
describe('a merge is recorded on the item without settling it', () => {
  it('appends a `merged` event carrying the evidence, and leaves the item open', () => {
    const flowDir = mkdtempSync(join(tmpdir(), 'loop-ledger-merge-'));
    const filePath = join(flowDir, 'loops', 'queue.jsonl');
    const backend = new LedgerQueueBackend(filePath, () => T0, 'test');
    const filed = backend.file({
      loop: 'fix',
      title: 'Unhandled rejection in queue.ts',
      body: 'It throws under load.',
      maxOpenIssues: 8,
    });
    if (filed.status !== 'filed') throw new Error(`expected filed, got ${filed.status}`);

    const recorded = backend.recordMerge({
      id: filed.item.id,
      loop: 'fix',
      owner: 'beat-1',
      branch: `loop/fix/${filed.item.id}`,
      pr: { number: '7', url: 'https://github.com/o/r/pull/7' },
      evidence: PASSING_EVIDENCE,
    });

    expect(recorded.status).toBe('recorded');
    const events = backend.events();
    expect(events.map((event) => event.event)).toEqual(['filed', 'merged']);
    expect(events[1]).toMatchObject({
      loop: 'fix',
      owner: 'beat-1',
      detail: "merged 'loop/fix/1' via PR #7 (https://github.com/o/r/pull/7)",
      evidence: PASSING_EVIDENCE,
    });
    // the item is untouched: still open, still claimable, still closeable
    expect(readLedgerQueue(filePath)[0]).toMatchObject({ state: 'open' });

    rmSync(flowDir, { recursive: true, force: true });
  });

  it('refuses to write a merge onto an item no loop filed', () => {
    const flowDir = mkdtempSync(join(tmpdir(), 'loop-ledger-merge-human-'));
    const filePath = join(flowDir, 'loops', 'queue.jsonl');
    mkdirSync(join(flowDir, 'loops'), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify({
        ts: '2026-08-12T08:00:00.000Z',
        id: '1509',
        event: 'filed',
        loop: 'fix',
        title: 'Quick locations on the map is not working',
        body: 'Tapping a saved location does nothing on the second try.',
        provenance: 'human',
      })}\n`,
      'utf-8',
    );
    const backend = new LedgerQueueBackend(filePath, () => T0, 'test');

    const refused = backend.recordMerge({
      id: '1509',
      loop: 'fix',
      branch: 'loop/fix/1509',
      evidence: PASSING_EVIDENCE,
    });
    expect(refused).toMatchObject({ status: 'refused' });
    expect((refused as { reason: string }).reason).toContain('carries no loop marker');
    expect(backend.events().map((event) => event.event)).toEqual(['filed']);

    rmSync(flowDir, { recursive: true, force: true });
  });
});
