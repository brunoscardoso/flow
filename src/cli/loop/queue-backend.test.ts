/**
 * Tests for the shared backend layer — the contract both real backends inherit.
 *
 * Everything here is exercised through a tiny IN-MEMORY backend that implements
 * only the primitives. That is the point: if the cap, the dedup check, the
 * eligibility rules or the evidence gate can be proven against a backend that
 * knows nothing about them, then they live in the shared layer and no backend
 * can route around them (allowed-pattern #14). The ledger and GitHub suites
 * prove their own primitives, never these rules again.
 *
 * Clock is injected — every timestamp is arithmetic, nothing sleeps.
 */

import {
  APPROVAL_LABEL,
  CLAIM_MARKER_PATTERN,
  CLAIMED_LABEL,
  LoopQueueBackendBase,
  PARKED_LABEL,
  PLAN_MARKER_PATTERN,
  PLAN_NAME_MAX_LENGTH,
  QUEUE_CLOSE_REASONS,
  QueueReadSession,
  RESERVED_LABELS,
  TOPIC_MAX_LENGTH,
  abandonedClaims,
  capRefusal,
  claimBlocker,
  claimOrder,
  composeItemBody,
  extractItemMarkers,
  filedByLoop,
  firstClaimable,
  formatQueueRefusal,
  heldClaims,
  humanWorkBlocker,
  isClaimable,
  isOwnWork,
  isQueueCloseReason,
  planNameProblem,
  provenanceBlocker,
  scopeItemsToLoop,
  StatusPageCache,
  stripMarkers,
  withLoopMarker,
  topicProblem,
  validateCloseEvidence,
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
} from './queue-backend.js';
import { extractFingerprint, loopFingerprint } from './fingerprint.js';
import { createMemoryForeignItemState } from './foreign-items.js';
import type { LoopQueueKind } from './types.js';

const T0 = Date.parse('2026-08-12T09:00:00.000Z');

/**
 * The thinnest possible backend: the primitives over an array. It enforces
 * nothing — every rule these tests observe comes from the base class.
 */
class MemoryQueueBackend extends LoopQueueBackendBase {
  readonly kind: LoopQueueKind = 'ledger';
  readonly items: QueueItem[] = [];
  /** Every draft the base class handed down — the backend-facing contract. */
  readonly drafts: ItemDraft[] = [];
  /** Every WRITE primitive the base class reached, in order. */
  readonly calls: string[] = [];
  private sequence = 0;

  protected listItems(query: QueueQuery): QueueItem[] {
    const state = query.state ?? 'all';
    return this.items.filter(
      (item) =>
        (state === 'all' || item.state === state) &&
        (query.loop === undefined || item.loop === query.loop),
    );
  }

  protected fetchItem(id: string): QueueItem | null {
    return this.items.find((item) => item.id === id) ?? null;
  }

  protected createItem(draft: ItemDraft): QueueItem {
    this.drafts.push(draft);
    this.calls.push('createItem');
    this.sequence += 1;
    const item: QueueItem = {
      id: String(this.sequence),
      loop: draft.loop,
      title: draft.title,
      body: draft.body,
      fingerprint: draft.fingerprint,
      state: 'open',
      labels: [...draft.labels],
      approved: draft.approved,
      createdAt: this.nowIso(),
    };
    if (draft.primaryFile !== undefined) item.primaryFile = draft.primaryFile;
    this.items.push(item);
    return item;
  }

  private mutate(id: string, change: (item: QueueItem) => void): QueueItem {
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined) throw new Error(`no item ${id}`);
    change(item);
    return item;
  }

  protected setClaim(id: string, owner: string | null): QueueItem {
    this.calls.push('setClaim');
    return this.mutate(id, (item) => {
      if (owner === null) {
        delete item.claimedBy;
        delete item.claimedAt;
        return;
      }
      item.claimedBy = owner;
      item.claimedAt = this.nowIso();
    });
  }

  protected setPlan(id: string, plan: string | null): QueueItem {
    this.calls.push('setPlan');
    return this.mutate(id, (item) => {
      if (plan === null) {
        delete item.plan;
        item.body = `${withoutPlanMarker(item.body)}\n`;
        return;
      }
      item.plan = plan;
      item.body = withPlanMarker(item.body, plan);
    });
  }

  protected setClosed(
    id: string,
    reason: QueueCloseReason,
    detail: string | undefined,
    evidence: CloseEvidence | undefined,
  ): QueueItem {
    void detail;
    void evidence;
    this.calls.push('setClosed');
    return this.mutate(id, (item) => {
      item.state = 'closed';
      item.closeReason = reason;
      item.closedAt = this.nowIso();
    });
  }

  protected setApproved(id: string, owner?: string): QueueItem {
    void owner;
    this.calls.push('setApproved');
    return this.mutate(id, (item) => {
      item.approved = true;
      item.labels = item.labels.filter((label) => label !== APPROVAL_LABEL);
    });
  }

  protected setAdopted(id: string, loop: string, body: string): QueueItem {
    this.calls.push('setAdopted');
    return this.mutate(id, (item) => {
      item.body = body;
      item.loop = loop;
    });
  }

  /** Every merge recorded on an item, so the record can be read back. */
  readonly merges: MergeRecordInput[] = [];

  protected setMerged(id: string, input: MergeRecordInput): QueueItem {
    this.calls.push('setMerged');
    this.merges.push(input);
    // Deliberately changes nothing about the item — the base class must not be
    // relying on a merge to settle anything.
    return this.mutate(id, () => {});
  }
}

/** A backend plus the clock driving it, so tests can advance time. */
function makeBackend(): { backend: MemoryQueueBackend; tick: (ms: number) => void } {
  let now = T0;
  const backend = new MemoryQueueBackend(() => now);
  return { backend, tick: (ms: number) => { now += ms; } };
}

const CAP = 3;

function fileOne(
  backend: MemoryQueueBackend,
  overrides: Partial<Parameters<MemoryQueueBackend['file']>[0]> = {},
) {
  return backend.file({
    loop: 'find',
    title: 'Unhandled rejection in queue.ts',
    body: 'It throws under load.',
    primaryFile: 'src/queue.ts',
    maxOpenIssues: CAP,
    ...overrides,
  });
}

/** A close that satisfies the evidence gate. */
const PASSING_EVIDENCE: CloseEvidence = {
  commands: [{ command: 'npm run test -- src/queue.test.ts', exitCode: 0 }],
};

describe('body markers', () => {
  it('writes loop, fingerprint and primary-file markers into a composed body', () => {
    const fingerprint = loopFingerprint({ loop: 'find', title: 'a leak', primaryFile: 'src/a.ts' });
    const body = composeItemBody('Prose here.', { loop: 'find', fingerprint, primaryFile: 'src/a.ts' });
    expect(body).toContain('Prose here.');
    expect(extractItemMarkers(body)).toEqual({
      loop: 'find',
      fingerprint,
      primaryFile: 'src/a.ts',
    });
  });

  it('omits the primary-file marker when the finding names no file', () => {
    const fingerprint = loopFingerprint({ loop: 'find', title: 'dep unpinned' });
    const markers = extractItemMarkers(composeItemBody('Prose.', { loop: 'find', fingerprint }));
    expect(markers.primaryFile).toBeUndefined();
    expect(markers.fingerprint).toBe(fingerprint);
  });

  it('never leaves two fingerprints in one body', () => {
    const first = loopFingerprint({ loop: 'find', title: 'one', primaryFile: 'a.ts' });
    const second = loopFingerprint({ loop: 'find', title: 'two', primaryFile: 'b.ts' });
    const once = composeItemBody('Prose.', { loop: 'find', fingerprint: first });
    const twice = composeItemBody(once, { loop: 'find', fingerprint: second });
    expect(twice.match(/loop-fp:/g)).toHaveLength(1);
    expect(extractFingerprint(twice)).toBe(second);
  });

  it('round-trips a claim marker without disturbing the others', () => {
    const fingerprint = loopFingerprint({ loop: 'find', title: 'a leak', primaryFile: 'src/a.ts' });
    const body = composeItemBody('Prose.', { loop: 'find', fingerprint });
    const claimed = withClaimMarker(body, 'beat-7', '2026-08-12T09:00:00.000Z');
    expect(extractItemMarkers(claimed).claim).toEqual({ owner: 'beat-7', at: '2026-08-12T09:00:00.000Z' });
    expect(extractItemMarkers(claimed).fingerprint).toBe(fingerprint);
    expect(extractItemMarkers(withoutClaimMarker(claimed)).claim).toBeUndefined();
    expect(CLAIM_MARKER_PATTERN.test(withoutClaimMarker(claimed))).toBe(false);
  });

  it('round-trips a plan marker beside the claim, disturbing neither', () => {
    const fingerprint = loopFingerprint({ loop: 'fix', title: 'a leak', primaryFile: 'src/a.ts' });
    const body = withClaimMarker(
      composeItemBody('Prose.', { loop: 'fix', fingerprint }),
      'run-1',
      '2026-08-12T09:00:00.000Z',
    );
    const planned = withPlanMarker(body, 'state-md-handoff');

    expect(extractItemMarkers(planned)).toEqual({
      loop: 'fix',
      fingerprint,
      claim: { owner: 'run-1', at: '2026-08-12T09:00:00.000Z' },
      plan: 'state-md-handoff',
    });
    expect(extractItemMarkers(withoutPlanMarker(planned)).plan).toBeUndefined();
    // and the claim it sits beside is untouched by its removal
    expect(extractItemMarkers(withoutPlanMarker(planned)).claim?.owner).toBe('run-1');
    expect(PLAN_MARKER_PATTERN.test(withoutPlanMarker(planned))).toBe(false);
  });

  it('never leaves two plan markers — an item points at one pipeline', () => {
    const fingerprint = loopFingerprint({ loop: 'fix', title: 'a leak' });
    const once = withPlanMarker(composeItemBody('Prose.', { loop: 'fix', fingerprint }), 'first-plan');
    const twice = withPlanMarker(once, 'second-plan');
    expect(twice.match(/loop-plan:/g)).toHaveLength(1);
    expect(extractItemMarkers(twice).plan).toBe('second-plan');
  });

  it('reads a body written before the marker existed exactly as it always did', () => {
    const fingerprint = loopFingerprint({ loop: 'fix', title: 'a leak', primaryFile: 'src/a.ts' });
    const legacy = withClaimMarker(
      composeItemBody('Prose.', { loop: 'fix', fingerprint, primaryFile: 'src/a.ts' }),
      'run-1',
      '2026-08-12T09:00:00.000Z',
    );
    expect(extractItemMarkers(legacy)).toEqual({
      loop: 'fix',
      fingerprint,
      primaryFile: 'src/a.ts',
      claim: { owner: 'run-1', at: '2026-08-12T09:00:00.000Z' },
    });
  });

  it('strips every marker back to the prose', () => {
    const fingerprint = loopFingerprint({ loop: 'find', title: 'a leak', primaryFile: 'src/a.ts' });
    const body = withPlanMarker(
      withClaimMarker(
        composeItemBody('Prose.\n\nMore prose.', { loop: 'find', fingerprint, primaryFile: 'src/a.ts' }),
        'beat-1',
        '2026-08-12T09:00:00.000Z',
      ),
      'state-md-handoff',
    );
    expect(stripMarkers(body)).toBe('Prose.\n\nMore prose.');
  });
});

describe('the plan-name grammar (refused, never sanitized)', () => {
  it('accepts the names plans actually have', () => {
    for (const plan of ['state-md-handoff', 'changes_discovery_view', 'board.v2', 'a', '1599']) {
      expect(planNameProblem(plan)).toBeNull();
    }
  });

  it('treats an empty name as absence rather than a problem', () => {
    expect(planNameProblem('')).toBeNull();
  });

  it('refuses anything the marker or the filesystem could not carry', () => {
    // whitespace cannot round-trip through a `\S+` capture
    expect(planNameProblem('two words')).toContain('no spaces');
    // a plan name is one filename segment, never a path
    expect(planNameProblem('../etc/passwd')).toContain('no path separators');
    expect(planNameProblem('flow/plans/x')).toContain('no path separators');
    // and a leading separator reads as a flag to every CLI that sees it
    expect(planNameProblem('-plan')).toContain('starting with a letter or digit');
    expect(planNameProblem('x'.repeat(PLAN_NAME_MAX_LENGTH + 1))).toContain(
      `at most ${PLAN_NAME_MAX_LENGTH} characters`,
    );
  });
});

describe('eligibility (one predicate, shared by both backends)', () => {
  const base: QueueItem = {
    id: '1',
    loop: 'find',
    title: 't',
    body: 'b',
    fingerprint: 'f',
    state: 'open',
    labels: [],
    approved: true,
    createdAt: '2026-08-12T09:00:00.000Z',
  };

  it('claims an open, approved, unparked, unclaimed item', () => {
    expect(claimBlocker(base)).toBeNull();
    expect(isClaimable(base)).toBe(true);
  });

  it('skips a closed item', () => {
    expect(claimBlocker({ ...base, state: 'closed' })).toBe('item 1 is closed');
  });

  it('skips an item behind the approval gate', () => {
    expect(claimBlocker({ ...base, approved: false, labels: [APPROVAL_LABEL] })).toBe(
      `item 1 is awaiting approval (${APPROVAL_LABEL})`,
    );
  });

  it('skips a parked item', () => {
    expect(claimBlocker({ ...base, labels: [PARKED_LABEL] })).toBe(`item 1 is parked (${PARKED_LABEL})`);
  });

  it('skips an item already claimed by someone else', () => {
    expect(claimBlocker({ ...base, claimedBy: 'beat-1' }, 'beat-2')).toBe(
      "item 1 is already claimed by 'beat-1'",
    );
  });

  it('is re-entrant for the same owner, like the loop lock', () => {
    expect(claimBlocker({ ...base, claimedBy: 'beat-1' }, 'beat-1')).toBeNull();
  });

  it('reports the most fundamental blocker first', () => {
    const wedged = { ...base, state: 'closed' as const, approved: false, labels: [PARKED_LABEL], claimedBy: 'x' };
    expect(claimBlocker(wedged)).toBe('item 1 is closed');
  });

  it('claims oldest-first, breaking ties numerically by id', () => {
    const items: QueueItem[] = [
      { ...base, id: '10', createdAt: '2026-08-12T09:00:02.000Z' },
      { ...base, id: '2', createdAt: '2026-08-12T09:00:01.000Z' },
      { ...base, id: '9', createdAt: '2026-08-12T09:00:01.000Z' },
    ];
    expect(claimOrder(items).map((item) => item.id)).toEqual(['2', '9', '10']);
    expect(firstClaimable(items)?.id).toBe('2');
  });

  it('passes over blocked items rather than stopping at them', () => {
    const items: QueueItem[] = [
      { ...base, id: '1', approved: false, createdAt: '2026-08-12T09:00:00.000Z' },
      { ...base, id: '2', labels: [PARKED_LABEL], createdAt: '2026-08-12T09:00:01.000Z' },
      { ...base, id: '3', createdAt: '2026-08-12T09:00:02.000Z' },
    ];
    expect(firstClaimable(items)?.id).toBe('3');
  });
});

describe('the cap', () => {
  it('refuses at the cap, never below it', () => {
    expect(capRefusal(2, 3)).toBeNull();
    expect(capRefusal(3, 3)).toBe('open-item cap reached — 3 open, max 3');
    expect(capRefusal(9, 3)).toBe('open-item cap reached — 9 open, max 3');
  });
});

describe('the reserved vocabulary', () => {
  it('is exactly three words, and the claim label is the repo\'s own', () => {
    // `in-progress`, not `claimed`: a human applying the claim label by hand and
    // a loop claiming an item must be saying the same thing, or each can read
    // the other's item as free.
    expect(CLAIMED_LABEL).toBe('in-progress');
    expect(RESERVED_LABELS).toEqual([APPROVAL_LABEL, PARKED_LABEL, CLAIMED_LABEL]);
    expect(RESERVED_LABELS).toEqual(['needs-approval', 'not-now', 'in-progress']);
  });
});

describe('the topic grammar (one code path, parser and filing both call it)', () => {
  it('accepts label-shaped area names', () => {
    for (const topic of ['codemap', 'src/cli', 'board.v2', 'panel_model', 'e2e-1']) {
      expect(topicProblem(topic)).toBeNull();
    }
  });

  it('treats absence as fine — a loop with no topic is not a broken one', () => {
    expect(topicProblem('')).toBeNull();
  });

  it('rejects anything a repo or a reader would be surprised by, naming the value', () => {
    for (const topic of ['Codemap', '-lead', 'trail-', 'two words', 'semi;colon', '"quoted"']) {
      expect(topicProblem(topic)).toContain(`'${topic}'`);
    }
  });

  it('bounds the length', () => {
    expect(topicProblem('a'.repeat(TOPIC_MAX_LENGTH))).toBeNull();
    expect(topicProblem('a'.repeat(TOPIC_MAX_LENGTH + 1))).toContain(
      `expected at most ${TOPIC_MAX_LENGTH} characters`,
    );
  });

  it('refuses the reserved vocabulary — queue state is not an area', () => {
    for (const label of RESERVED_LABELS) {
      expect(topicProblem(label)).toBe(
        `reserved topic '${label}' — ${RESERVED_LABELS.join(', ')} are queue state, and a topic names an area`,
      );
    }
  });
});

describe('the evidence gate', () => {
  it("refuses a 'done' close carrying only prose", () => {
    expect(validateCloseEvidence('done', { commands: [], summary: 'I fixed it, tests pass.' })).toBe(
      "a 'done' close requires machine-checkable evidence — at least one {command, exitCode} record, never prose alone",
    );
    expect(validateCloseEvidence('done', undefined)).toContain('machine-checkable evidence');
  });

  it("accepts a 'done' close carrying a passing command", () => {
    expect(validateCloseEvidence('done', PASSING_EVIDENCE)).toBeNull();
  });

  it("refuses a 'done' close whose recorded command failed", () => {
    expect(
      validateCloseEvidence('done', { commands: [{ command: 'npm test', exitCode: 1 }] }),
    ).toBe(
      "evidence command 'npm test' exited 1 — a 'done' close requires every recorded command to have exited 0",
    );
  });

  it('refuses evidence with a missing or non-integer exit code', () => {
    expect(
      validateCloseEvidence('done', { commands: [{ command: 'npm test' } as never] }),
    ).toBe("evidence for 'npm test' has no captured integer 'exitCode'");
    expect(
      validateCloseEvidence('done', { commands: [{ command: 'npm test', exitCode: 0.5 }] }),
    ).toContain("no captured integer 'exitCode'");
  });

  it('refuses an evidence entry that is not a record', () => {
    expect(validateCloseEvidence('done', { commands: ['npm test' as never] })).toBe(
      'evidence entry #1 is not a {command, exitCode} record',
    );
    expect(validateCloseEvidence('done', { commands: [{ command: '  ', exitCode: 0 }] })).toBe(
      "evidence entry #1 has no 'command'",
    );
  });

  it("requires a written reason for 'wontfix' and 'duplicate', not exit codes", () => {
    expect(validateCloseEvidence('wontfix', undefined)).toContain('permanent memory');
    expect(validateCloseEvidence('wontfix', undefined, '   ')).toContain('permanent memory');
    expect(validateCloseEvidence('wontfix', undefined, 'By design — the API is deprecated.')).toBeNull();
    expect(validateCloseEvidence('duplicate', undefined, 'Same as #12.')).toBeNull();
  });

  it('knows its close reasons', () => {
    expect(QUEUE_CLOSE_REASONS).toEqual(['done', 'wontfix', 'duplicate']);
    expect(isQueueCloseReason('done')).toBe(true);
    expect(isQueueCloseReason('resolved')).toBe(false);
  });
});

describe('file (dedup + cap, enforced by the shared layer)', () => {
  it('files a finding, embedding the marker the backend computed', () => {
    const { backend } = makeBackend();
    const result = fileOne(backend);
    expect(result.status).toBe('filed');
    if (result.status !== 'filed') return;
    expect(result.item.fingerprint).toBe(
      loopFingerprint({ loop: 'find', title: 'Unhandled rejection in queue.ts', primaryFile: 'src/queue.ts' }),
    );
    expect(result.item.body).toContain(`<!-- loop-fp: ${result.item.fingerprint} -->`);
    expect(result.item.createdAt).toBe(new Date(T0).toISOString());
    expect(result.item.approved).toBe(true);
  });

  it('reports a cosmetically-different re-report as a duplicate, not a new item', () => {
    const { backend } = makeBackend();
    fileOne(backend, { title: 'Unhandled rejection in queue.ts (line 42)' });
    const again = fileOne(backend, {
      title: 'unhandled rejection in queue.ts, line 480!',
      primaryFile: './src/Queue.ts',
      body: 'Different prose entirely.',
    });
    expect(again.status).toBe('duplicate');
    expect(backend.items).toHaveLength(1);
  });

  it('finds a CLOSED item as a duplicate — a wontfix is permanent memory', () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend);
    if (filed.status !== 'filed') throw new Error('expected filed');
    backend.close({ id: filed.item.id, reason: 'wontfix', detail: 'By design.' });
    const again = fileOne(backend);
    expect(again.status).toBe('duplicate');
    if (again.status !== 'duplicate') return;
    expect(again.item.state).toBe('closed');
    expect(backend.items).toHaveLength(1);
  });

  it('refuses to file at the open-item cap', () => {
    const { backend } = makeBackend();
    // Distinct WORDS, not distinct numbers — `finding 1` and `finding 2`
    // normalize to the same fingerprint, which is the digit rule working.
    for (const title of ['finding alpha', 'finding beta', 'finding gamma']) {
      expect(fileOne(backend, { title }).status).toBe('filed');
    }
    const refused = fileOne(backend, { title: 'one too many' });
    expect(refused).toEqual({ status: 'refused', reason: 'open-item cap reached — 3 open, max 3' });
    expect(backend.items).toHaveLength(CAP);
  });

  it('counts the cap per loop, so two producers do not starve each other', () => {
    const { backend } = makeBackend();
    for (const title of ['finding alpha', 'finding beta', 'finding gamma']) {
      expect(fileOne(backend, { title }).status).toBe('filed');
    }
    expect(fileOne(backend, { title: 'finding delta' }).status).toBe('refused');
    expect(fileOne(backend, { loop: 'improve', title: 'a different loop' }).status).toBe('filed');
  });

  it('frees cap room when an item is closed', () => {
    const { backend } = makeBackend();
    const first = fileOne(backend, { title: 'finding a' });
    fileOne(backend, { title: 'finding b' });
    fileOne(backend, { title: 'finding c' });
    expect(fileOne(backend, { title: 'finding d' }).status).toBe('refused');
    if (first.status !== 'filed') throw new Error('expected filed');
    backend.close({ id: first.item.id, reason: 'done', evidence: PASSING_EVIDENCE });
    expect(fileOne(backend, { title: 'finding d' }).status).toBe('filed');
  });

  it('reports a duplicate rather than the cap when both apply', () => {
    const { backend } = makeBackend();
    const first = fileOne(backend, { title: 'finding a' });
    fileOne(backend, { title: 'finding b' });
    fileOne(backend, { title: 'finding c' });
    if (first.status !== 'filed') throw new Error('expected filed');
    expect(fileOne(backend, { title: 'finding a' }).status).toBe('duplicate');
  });

  it('files behind the approval gate when the directive asks for it', () => {
    const { backend } = makeBackend();
    const result = fileOne(backend, { needsApproval: true, labels: ['loop-queue'] });
    if (result.status !== 'filed') throw new Error('expected filed');
    expect(result.item.approved).toBe(false);
    expect(result.item.labels).toEqual(['loop-queue', APPROVAL_LABEL]);
  });

  it('carries the topic onto the filed item, alongside the provenance label', () => {
    const { backend } = makeBackend();
    const result = fileOne(backend, { labels: ['loop-queue'], topic: 'codemap' });
    if (result.status !== 'filed') throw new Error('expected filed');
    // Provenance (`label:` — which machine filed it) and area (`topic:` — where
    // it was working) are different facts, and the item carries both.
    expect(result.item.labels).toEqual(['loop-queue', 'codemap']);
  });

  it('files under a topic with no provenance label, and vice versa', () => {
    const { backend } = makeBackend();
    const topicOnly = fileOne(backend, { title: 'alpha', topic: 'codemap' });
    const labelOnly = fileOne(backend, { title: 'beta', labels: ['loop-queue'] });
    if (topicOnly.status !== 'filed' || labelOnly.status !== 'filed') throw new Error('expected filed');
    expect(topicOnly.item.labels).toEqual(['codemap']);
    expect(labelOnly.item.labels).toEqual(['loop-queue']);
  });

  it('keeps the approval gate behind the topic rather than displacing it', () => {
    const { backend } = makeBackend();
    const result = fileOne(backend, { labels: ['loop-queue'], topic: 'codemap', needsApproval: true });
    if (result.status !== 'filed') throw new Error('expected filed');
    expect(result.item.labels).toEqual(['loop-queue', 'codemap', APPROVAL_LABEL]);
    expect(result.item.approved).toBe(false);
  });

  it('never labels an item twice when the topic is already among the labels', () => {
    const { backend } = makeBackend();
    const result = fileOne(backend, { labels: ['codemap'], topic: 'codemap' });
    if (result.status !== 'filed') throw new Error('expected filed');
    expect(result.item.labels).toEqual(['codemap']);
  });

  it('leaves an item with no topic exactly as it was before the field existed', () => {
    const { backend } = makeBackend();
    const result = fileOne(backend, { labels: ['loop-queue'] });
    if (result.status !== 'filed') throw new Error('expected filed');
    expect(result.item.labels).toEqual(['loop-queue']);
    expect(backend.drafts[0].topic).toBeUndefined();
  });

  it('names the topic on the draft so a backend can make the label exist', () => {
    const { backend } = makeBackend();
    fileOne(backend, { labels: ['loop-queue'], topic: 'codemap' });
    // Already in `labels` — named separately only for the backend that has to
    // create it, so no backend has to guess which label is the topic.
    expect(backend.drafts[0].topic).toBe('codemap');
    expect(backend.drafts[0].labels).toContain('codemap');
  });

  it('does not let the topic reach the fingerprint — re-pointing never re-files', () => {
    const { backend } = makeBackend();
    const first = fileOne(backend, { topic: 'codemap' });
    if (first.status !== 'filed') throw new Error('expected filed');
    const again = fileOne(backend, { topic: 'panel' });
    expect(again.status).toBe('duplicate');
    if (again.status !== 'duplicate') return;
    expect(again.item.id).toBe(first.item.id);
    // The old item keeps the topic it was filed under — a re-pointed loop does
    // not relabel its backlog.
    expect(again.item.labels).toEqual(['codemap']);
    expect(backend.items).toHaveLength(1);
  });

  it('refuses a topic the grammar rejects, filing nothing at all', () => {
    const { backend } = makeBackend();
    expect(fileOne(backend, { topic: 'Code Map' })).toEqual({
      status: 'refused',
      reason: topicProblem('Code Map'),
    });
    expect(fileOne(backend, { topic: 'a'.repeat(TOPIC_MAX_LENGTH + 1) }).status).toBe('refused');
    expect(fileOne(backend, { topic: CLAIMED_LABEL }).status).toBe('refused');
    expect(backend.items).toHaveLength(0);
  });

  it('refuses a bad topic BEFORE the dedup search, so nothing is written or read back', () => {
    const { backend } = makeBackend();
    fileOne(backend, { title: 'alpha' });
    const refused = fileOne(backend, { title: 'alpha', topic: '-bad' });
    expect(refused.status).toBe('refused');
    expect(backend.items).toHaveLength(1);
  });

  it('refuses malformed input rather than filing something unreadable', () => {
    const { backend } = makeBackend();
    expect(fileOne(backend, { title: '   ' })).toEqual({
      status: 'refused',
      reason: 'a filed item requires a title',
    });
    expect(fileOne(backend, { loop: '' }).status).toBe('refused');
    expect(fileOne(backend, { maxOpenIssues: 0 })).toEqual({
      status: 'refused',
      reason: "malformed cap '0' — expected a positive integer",
    });
    expect(backend.items).toHaveLength(0);
  });
});

describe('exists', () => {
  it('answers on the exact marker, never on a fuzzy candidate', () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend);
    if (filed.status !== 'filed') throw new Error('expected filed');
    expect(backend.exists(filed.item.fingerprint)?.id).toBe(filed.item.id);
    expect(backend.exists('0'.repeat(40))).toBeNull();
  });
});

describe('claim (eligibility, enforced by the shared layer)', () => {
  it('claims the oldest eligible item and records the owner', () => {
    const { backend, tick } = makeBackend();
    fileOne(backend, { title: 'first' });
    tick(60_000);
    fileOne(backend, { title: 'second' });
    const result = backend.claim({ owner: 'beat-1' });
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') return;
    expect(result.item.title).toBe('first');
    expect(result.item.claimedBy).toBe('beat-1');
    expect(result.item.claimedAt).toBe(new Date(T0 + 60_000).toISOString());
  });

  it('skips needs-approval, not-now and already-claimed items', () => {
    const { backend, tick } = makeBackend();
    fileOne(backend, { title: 'gated', needsApproval: true, maxOpenIssues: 10 });
    tick(1000);
    fileOne(backend, { title: 'parked', labels: [PARKED_LABEL], maxOpenIssues: 10 });
    tick(1000);
    const taken = fileOne(backend, { title: 'taken', maxOpenIssues: 10 });
    if (taken.status !== 'filed') throw new Error('expected filed');
    backend.claim({ owner: 'beat-1', id: taken.item.id });
    tick(1000);
    fileOne(backend, { title: 'free', maxOpenIssues: 10 });

    const result = backend.claim({ owner: 'beat-2' });
    if (result.status !== 'claimed') throw new Error('expected a claim');
    expect(result.item.title).toBe('free');
  });

  describe('passing over an item this run cannot work', () => {
    /** Three items, oldest first: the head plus two behind it. */
    function threeInOrder(): { backend: ReturnType<typeof makeBackend>['backend']; ids: string[] } {
      const { backend, tick } = makeBackend();
      const ids: string[] = [];
      for (const title of ['head', 'second', 'third']) {
        const filed = fileOne(backend, { title, maxOpenIssues: 10 });
        if (filed.status !== 'filed') throw new Error('expected filed');
        ids.push(filed.item.id);
        tick(60_000);
      }
      return { backend, ids };
    }

    it('serves the same head forever without it — the stall this fixes', () => {
      const { backend, ids } = threeInOrder();
      // Claim, give it back, claim again: the queue hands over the identical
      // item, which is why a run that could not work it had nothing to do but
      // stop while two dozen items sat behind it.
      expect((backend.claim({ owner: 'run-a' }) as { item: { id: string } }).item.id).toBe(ids[0]);
      backend.unclaim(ids[0], 'run-a');
      expect((backend.claim({ owner: 'run-a' }) as { item: { id: string } }).item.id).toBe(ids[0]);
    });

    it('hands over the next item when the head is passed over', () => {
      const { backend, ids } = threeInOrder();
      const result = backend.claim({ owner: 'run-a', skip: [ids[0]] });
      expect(result.status).toBe('claimed');
      if (result.status !== 'claimed') return;
      expect(result.item.id).toBe(ids[1]);
    });

    it('keeps stepping as a run passes over more than one', () => {
      const { backend, ids } = threeInOrder();
      const result = backend.claim({ owner: 'run-a', skip: [ids[0], ids[1]] });
      if (result.status !== 'claimed') throw new Error('expected a claim');
      expect(result.item.id).toBe(ids[2]);
    });

    it('leaves a passed-over item exactly as claimable as it was', () => {
      const { backend, ids } = threeInOrder();
      backend.claim({ owner: 'run-a', skip: [ids[0]] });

      // Nothing was written about the head: the NEXT run is still served it
      // first, because passing over is this run saying "not me", not a judgment
      // about the item.
      const other = backend.claim({ owner: 'run-b' });
      if (other.status !== 'claimed') throw new Error('expected a claim');
      expect(other.item.id).toBe(ids[0]);
    });

    it('says what it stepped around rather than reporting an empty queue', () => {
      const { backend, ids } = threeInOrder();
      const result = backend.claim({ owner: 'run-a', skip: ids });
      expect(result.status).toBe('empty');
      if (result.status !== 'empty') return;
      // "nothing claimable" alone is a run's cue to stop, and stopping is wrong
      // when the only thing left is work this run chose to leave behind.
      expect(result.reason).toContain('passed over');
      expect(result.reason).toContain('still claimable');
      for (const id of ids) expect(result.reason).toContain(id);
    });

    it('ignores an id that is not in the queue', () => {
      const { backend, ids } = threeInOrder();
      const result = backend.claim({ owner: 'run-a', skip: ['9999'] });
      if (result.status !== 'claimed') throw new Error('expected a claim');
      expect(result.item.id).toBe(ids[0]);
    });

    it('does not touch a claim aimed at one item by id', () => {
      const { backend, ids } = threeInOrder();
      // `--id` is a run naming what it wants; passing over is about the sweep.
      const result = backend.claim({ owner: 'run-a', id: ids[0], skip: [ids[0]] });
      if (result.status !== 'claimed') throw new Error('expected a claim');
      expect(result.item.id).toBe(ids[0]);
    });
  });

  it('reports an empty queue rather than failing — a quiet queue is not a fault', () => {
    const { backend } = makeBackend();
    fileOne(backend, { title: 'gated', needsApproval: true });
    expect(backend.claim({ owner: 'beat-1' })).toEqual({
      status: 'empty',
      reason: 'nothing claimable in the queue',
    });
  });

  it('scopes a claim to one loop when asked', () => {
    const { backend, tick } = makeBackend();
    fileOne(backend, { loop: 'find', title: 'find work' });
    tick(1000);
    fileOne(backend, { loop: 'improve', title: 'improve work' });
    const result = backend.claim({ owner: 'beat-1', loop: 'improve' });
    if (result.status !== 'claimed') throw new Error('expected a claim');
    expect(result.item.title).toBe('improve work');
    expect(backend.claim({ owner: 'beat-1', loop: 'fix' })).toEqual({
      status: 'empty',
      reason: "nothing claimable in loop 'fix'",
    });
  });

  it('refuses a targeted claim on a blocked item, naming the blocker', () => {
    const { backend } = makeBackend();
    const gated = fileOne(backend, { needsApproval: true });
    if (gated.status !== 'filed') throw new Error('expected filed');
    expect(backend.claim({ owner: 'beat-1', id: gated.item.id })).toEqual({
      status: 'refused',
      reason: `item ${gated.item.id} is awaiting approval (${APPROVAL_LABEL})`,
    });
    expect(backend.claim({ owner: 'beat-1', id: '404' })).toEqual({
      status: 'refused',
      reason: "no item '404' in the queue",
    });
  });

  it('refuses a claim without an owner', () => {
    const { backend } = makeBackend();
    fileOne(backend);
    expect(backend.claim({ owner: '  ' })).toEqual({
      status: 'refused',
      reason: 'a claim requires an owner',
    });
  });

  it('lets the same owner re-claim its own item after a checkpoint', () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend);
    if (filed.status !== 'filed') throw new Error('expected filed');
    backend.claim({ owner: 'beat-1', id: filed.item.id });
    expect(backend.claim({ owner: 'beat-1', id: filed.item.id }).status).toBe('claimed');
    expect(backend.claim({ owner: 'beat-2', id: filed.item.id }).status).toBe('refused');
  });
});

describe('close (the evidence gate, enforced by the shared layer)', () => {
  function filed() {
    const made = makeBackend();
    const result = fileOne(made.backend);
    if (result.status !== 'filed') throw new Error('expected filed');
    return { ...made, item: result.item };
  }

  it('closes with captured exit codes', () => {
    const { backend, item, tick } = filed();
    tick(5 * 60_000);
    const result = backend.close({ id: item.id, reason: 'done', evidence: PASSING_EVIDENCE });
    expect(result.status).toBe('closed');
    if (result.status !== 'closed') return;
    expect(result.item.state).toBe('closed');
    expect(result.item.closeReason).toBe('done');
    expect(result.item.closedAt).toBe(new Date(T0 + 5 * 60_000).toISOString());
  });

  it('refuses to close on prose alone — the property the whole feature rests on', () => {
    const { backend, item } = filed();
    const result = backend.close({
      id: item.id,
      reason: 'done',
      detail: 'Fixed it. Everything passes now.',
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('machine-checkable evidence');
    expect(backend.items[0].state).toBe('open');
  });

  it('refuses a second close', () => {
    const { backend, item } = filed();
    backend.close({ id: item.id, reason: 'done', evidence: PASSING_EVIDENCE });
    expect(backend.close({ id: item.id, reason: 'done', evidence: PASSING_EVIDENCE })).toEqual({
      status: 'refused',
      reason: `item ${item.id} is already closed`,
    });
  });

  it("refuses to close another owner's claimed item", () => {
    const { backend, item } = filed();
    backend.claim({ owner: 'beat-1', id: item.id });
    expect(backend.close({ id: item.id, owner: 'beat-2', reason: 'done', evidence: PASSING_EVIDENCE })).toEqual({
      status: 'refused',
      reason: `item ${item.id} is claimed by 'beat-1' — 'beat-2' cannot close it`,
    });
    expect(backend.close({ id: item.id, owner: 'beat-1', reason: 'done', evidence: PASSING_EVIDENCE }).status).toBe(
      'closed',
    );
  });

  it('refuses to close an item that does not exist', () => {
    const { backend } = filed();
    expect(backend.close({ id: '404', reason: 'done', evidence: PASSING_EVIDENCE })).toEqual({
      status: 'refused',
      reason: "no item '404' in the queue",
    });
  });
});

describe('approve (one call, whichever backend)', () => {
  it('clears the gate and makes the item claimable', () => {
    const { backend } = makeBackend();
    const gated = fileOne(backend, { needsApproval: true });
    if (gated.status !== 'filed') throw new Error('expected filed');
    expect(backend.claim({ owner: 'beat-1' }).status).toBe('empty');

    const approved = backend.approve(gated.item.id);
    expect(approved.status).toBe('approved');
    if (approved.status !== 'approved') return;
    expect(approved.alreadyApproved).toBe(false);
    expect(approved.item.approved).toBe(true);
    expect(approved.item.labels).not.toContain(APPROVAL_LABEL);
    expect(backend.claim({ owner: 'beat-1' }).status).toBe('claimed');
  });

  it('is idempotent — a second approve is success, not a failure', () => {
    const { backend } = makeBackend();
    const gated = fileOne(backend, { needsApproval: true });
    if (gated.status !== 'filed') throw new Error('expected filed');
    backend.approve(gated.item.id);
    const again = backend.approve(gated.item.id);
    expect(again.status).toBe('approved');
    if (again.status !== 'approved') return;
    expect(again.alreadyApproved).toBe(true);
  });

  it('refuses to approve a missing or closed item', () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend);
    if (filed.status !== 'filed') throw new Error('expected filed');
    expect(backend.approve('404')).toEqual({ status: 'refused', reason: "no item '404' in the queue" });
    backend.close({ id: filed.item.id, reason: 'done', evidence: PASSING_EVIDENCE });
    expect(backend.approve(filed.item.id)).toEqual({
      status: 'refused',
      reason: `item ${filed.item.id} is closed — nothing to approve`,
    });
  });
});

describe('count', () => {
  it('reports open, closed, claimed, gated, parked and claimable', () => {
    const { backend, tick } = makeBackend();
    fileOne(backend, { title: 'gated', needsApproval: true, maxOpenIssues: 10 });
    tick(1000);
    fileOne(backend, { title: 'parked', labels: [PARKED_LABEL], maxOpenIssues: 10 });
    tick(1000);
    const claimed = fileOne(backend, { title: 'claimed', maxOpenIssues: 10 });
    if (claimed.status !== 'filed') throw new Error('expected filed');
    backend.claim({ owner: 'beat-1', id: claimed.item.id });
    tick(1000);
    const done = fileOne(backend, { title: 'done', maxOpenIssues: 10 });
    if (done.status !== 'filed') throw new Error('expected filed');
    backend.close({ id: done.item.id, reason: 'done', evidence: PASSING_EVIDENCE });
    tick(1000);
    fileOne(backend, { title: 'free', maxOpenIssues: 10 });

    expect(backend.count()).toEqual({
      open: 4,
      closed: 1,
      claimed: 1,
      awaitingApproval: 1,
      parked: 1,
      claimable: 1,
    });
  });

  it('scopes counts to one loop', () => {
    const { backend } = makeBackend();
    fileOne(backend, { loop: 'find', title: 'a' });
    fileOne(backend, { loop: 'improve', title: 'b' });
    expect(backend.count({ loop: 'find' }).open).toBe(1);
    expect(backend.count({ loop: 'improve' }).open).toBe(1);
    expect(backend.count().open).toBe(2);
  });
});

describe('refusal transport', () => {
  it('formats one line the CLI can print verbatim', () => {
    expect(formatQueueRefusal('open-item cap reached — 8 open, max 8')).toBe(
      'loop refused: open-item cap reached — 8 open, max 8',
    );
  });
});

/**
 * The two claim predicates Phase 3 reads: what a beat is still holding, and what
 * nobody is coming back for. Pure, so the age rules are provable without a clock
 * and without sleeping.
 */
describe('claims a beat is still holding, and claims nobody is coming back for', () => {
  const TTL_MS = 30 * 60 * 1000;
  const claimed = (over: Partial<QueueItem>): QueueItem => ({
    id: '1',
    loop: 'fix',
    title: 't',
    body: 'b',
    fingerprint: 'f',
    state: 'open',
    labels: [],
    approved: true,
    createdAt: new Date(T0).toISOString(),
    claimedBy: 'beat-1',
    claimedAt: new Date(T0).toISOString(),
    ...over,
  });

  it('holds only OPEN items, and only this owner’s — closing IS the release', () => {
    const items = [
      claimed({}),
      claimed({ id: '2', state: 'closed' }),
      claimed({ id: '3', claimedBy: 'beat-2' }),
      claimed({ id: '4', claimedBy: undefined, claimedAt: undefined }),
    ];
    expect(heldClaims(items, 'beat-1').map((item) => item.id)).toEqual(['1']);
    expect(heldClaims(items, 'beat-2').map((item) => item.id)).toEqual(['3']);
  });

  it('reports a claim past the TTL, and not one exactly at it', () => {
    const items = [claimed({})];
    expect(abandonedClaims(items, TTL_MS, T0 + TTL_MS)).toEqual([]);
    expect(abandonedClaims(items, TTL_MS, T0 + TTL_MS + 1)).toEqual([
      { id: '1', owner: 'beat-1', claimedAt: new Date(T0).toISOString(), ageMs: TTL_MS + 1 },
    ]);
  });

  it('never cries wolf: an unreadable or missing claim timestamp is not a finding', () => {
    const items = [
      claimed({ id: '1', claimedAt: 'the other day' }),
      claimed({ id: '2', claimedAt: undefined }),
    ];
    expect(abandonedClaims(items, TTL_MS, T0 + 10 * TTL_MS)).toEqual([]);
  });

  it('orders oldest first — the most abandoned item is the one worth chasing', () => {
    const items = [
      claimed({ id: '2', claimedAt: new Date(T0 - TTL_MS).toISOString() }),
      claimed({ id: '10', claimedAt: new Date(T0 - 5 * TTL_MS).toISOString() }),
      claimed({ id: '3', claimedAt: new Date(T0 - TTL_MS).toISOString() }),
    ];
    expect(abandonedClaims(items, TTL_MS, T0 + TTL_MS).map((claim) => claim.id)).toEqual([
      '10',
      '2',
      '3',
    ]);
  });
});

/**
 * Phase 3 — provenance, and the rule that a loop writes only to its own items.
 *
 * THE INCIDENT. A consumer beat met a hand-filed issue, created a label in the
 * user's repo and appended the markers `file()` would have written, so the item
 * would fit its schema — and then worked it. Every fact needed to refuse that
 * was already on disk: `file()` writes `<!-- loop: <name> -->` into every body
 * it composes, and nothing read it.
 *
 * These tests are all against the memory backend, which knows nothing about any
 * of this. That is the point (allowed-pattern #14): if a backend that enforces
 * nothing still cannot be made to claim, close, approve or unclaim a person's
 * item, the rule lives in the shared layer and no backend can route around it.
 */

/** An item a person filed: real prose, none of the markers `file()` writes. */
function handFiled(backend: MemoryQueueBackend, overrides: Partial<QueueItem> = {}): QueueItem {
  const item: QueueItem = {
    id: '1509',
    loop: '',
    title: 'Quick locations on the map is not working',
    body: 'Tapping a saved location does nothing on the second try.',
    fingerprint: '',
    state: 'open',
    labels: [],
    approved: true,
    createdAt: '2026-08-12T08:00:00.000Z',
    ...overrides,
  };
  backend.items.push(item);
  return item;
}

describe('Task 3.1 — provenance, read from the marker that already exists', () => {
  it('reads back the loop that filed an item', () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend, { loop: 'find' });
    if (filed.status !== 'filed') throw new Error('expected filed');
    expect(filedByLoop(filed.item)).toBe('find');
    expect(isOwnWork(filed.item, 'find')).toBe(true);
  });

  it("answers '' for an item nobody's loop filed — a hand-filed item is a person's", () => {
    const { backend } = makeBackend();
    expect(filedByLoop(handFiled(backend))).toBe('');
  });

  it('reads the BODY, not the field — provenance is answerable from the item alone', () => {
    const { backend } = makeBackend();
    // A field claiming one loop over a body that carries another marker: the
    // marker is what a person can see, and what a person wrote.
    const item = handFiled(backend, { loop: 'fix', body: 'prose\n\n<!-- loop: find -->\n' });
    expect(filedByLoop(item)).toBe('find');
    expect(isOwnWork(item, 'fix')).toBe(false);
  });

  it('needs no new store and does not touch the fingerprint', () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend);
    if (filed.status !== 'filed') throw new Error('expected filed');
    const before = filed.item.fingerprint;
    expect(filedByLoop(filed.item)).toBe('find');
    expect(backend.exists(before)?.id).toBe(filed.item.id);
  });

  it("names the item AND the way out — a refusal that only objects teaches nothing", () => {
    const { backend } = makeBackend();
    const blocker = provenanceBlocker(handFiled(backend), 'claim', 'fix');
    expect(blocker).toContain('item 1509');
    expect(blocker).toContain('filed by a person');
    expect(blocker).toContain('planflow-ai loop adopt --loop fix --id 1509');
    expect(blocker).toContain('no beat may');
  });

  it("offers no way out for ANOTHER loop's item — there is none", () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend, { loop: 'find' });
    if (filed.status !== 'filed') throw new Error('expected filed');
    const blocker = provenanceBlocker(filed.item, 'claim', 'fix');
    expect(blocker).toContain(`item ${filed.item.id} was filed by loop 'find', not 'fix'`);
    expect(blocker).not.toContain('adopt');
  });

  it('judges only what it was asked to judge — no loop named, no ownership question', () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend, { loop: 'find' });
    if (filed.status !== 'filed') throw new Error('expected filed');
    expect(provenanceBlocker(filed.item, 'claim')).toBeNull();
    // but a person's item is refused whether or not a loop was named
    expect(provenanceBlocker(handFiled(backend), 'claim')).toContain('carries no loop marker');
  });
});

describe("Task 3.2 — claim refuses an item the loop did not file", () => {
  it('refuses a targeted claim on a hand-filed item, naming it and how to adopt it', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend);
    const result = backend.claim({ owner: 'beat-1', loop: 'fix', id: human.id });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('item 1509 carries no loop marker');
    expect(result.reason).toContain('planflow-ai loop adopt --loop fix --id 1509');
    // and NOTHING was written: no claim, no label, no body change
    expect(backend.calls).toEqual([]);
    expect(backend.items[0]).toEqual(human);
  });

  it("refuses a targeted claim on another loop's item", () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend, { loop: 'find' });
    if (filed.status !== 'filed') throw new Error('expected filed');
    const result = backend.claim({ owner: 'beat-1', loop: 'fix', id: filed.item.id });
    expect(result).toEqual({
      status: 'refused',
      reason: `item ${filed.item.id} was filed by loop 'find', not 'fix' — a loop works only its own items`,
    });
  });

  it('asks "is it mine" BEFORE "is it claimable" — otherwise the beat clears the gate and returns', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend, { approved: false, labels: [APPROVAL_LABEL] });
    const result = backend.claim({ owner: 'beat-1', loop: 'fix', id: human.id });
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toContain('carries no loop marker');
    expect(result.reason).not.toContain('awaiting approval');
  });

  it('PASSES OVER a person\'s item when sweeping, rather than ending the beat', () => {
    const { backend, tick } = makeBackend();
    handFiled(backend);
    tick(1000);
    fileOne(backend, { loop: 'fix', title: 'the loop\'s own work' });

    const result = backend.claim({ owner: 'beat-1', loop: 'fix' });
    if (result.status !== 'claimed') throw new Error('expected a claim');
    expect(result.item.title).toBe("the loop's own work");
    expect(backend.items[0].claimedBy).toBeUndefined();
  });

  it('reports an empty queue when every open item belongs to someone else', () => {
    const { backend } = makeBackend();
    handFiled(backend);
    expect(backend.claim({ owner: 'beat-1', loop: 'fix' })).toEqual({
      status: 'empty',
      reason: "nothing claimable in loop 'fix'",
    });
    expect(backend.calls).toEqual([]);
  });
});

describe('Task 3.4 — no loop verb mutates what a person created', () => {
  it('refuses to close a hand-filed item, writing nothing', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend);
    const result = backend.close({ id: human.id, reason: 'done', evidence: PASSING_EVIDENCE });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('item 1509 carries no loop marker');
    expect(result.reason).toContain('`close` would change someone else\'s item');
    expect(backend.calls).toEqual([]);
    expect(backend.items[0].state).toBe('open');
  });

  it('refuses to approve one — an approval is the relabelling, by another name', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend, { approved: false, labels: [APPROVAL_LABEL] });
    const result = backend.approve(human.id);

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('`approve` would change someone else\'s item');
    expect(backend.calls).toEqual([]);
    expect(backend.items[0].labels).toEqual([APPROVAL_LABEL]);
  });

  it('refuses to unclaim one whose claim it never legitimately made', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend, { claimedBy: 'beat-1', claimedAt: '2026-08-12T08:30:00.000Z' });
    const result = backend.unclaim(human.id);

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('`unclaim` would change someone else\'s item');
    expect(backend.calls).toEqual([]);
  });

  it('still answers "nobody holds it" for an unclaimed one — a read, not a write', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend);
    expect(backend.unclaim(human.id)).toEqual({ status: 'unclaimed', item: human, wasClaimed: false });
    expect(backend.calls).toEqual([]);
  });

  it('reads a person\'s item freely — the rule is about writing, not looking', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend);
    expect(backend.list({ state: 'all' })).toContainEqual(human);
    expect(humanWorkBlocker(human, 'read')).not.toBeNull();
  });

  it('creates repo configuration for NOTHING but an item this loop is filing itself', () => {
    // The topic is what a backend may make exist (GitHub's one `gh label
    // create`), and the ONLY carrier of it is the draft handed to `createItem`.
    // No other primitive is given a topic or a label at all, so there is no
    // path by which a verb acting on someone else's item can reconfigure a repo.
    const { backend } = makeBackend();
    const human = handFiled(backend);
    backend.claim({ owner: 'beat-1', loop: 'fix', id: human.id });
    backend.close({ id: human.id, reason: 'wontfix', detail: 'not ours' });
    backend.approve(human.id);
    backend.adopt({ id: human.id, loop: 'fix' });

    expect(backend.drafts).toEqual([]);
    expect(backend.calls).toEqual(['setAdopted']);
    expect(backend.items[0].labels).toEqual([]);
  });
});

describe('Task 3.3 — adoption is a distinct act that writes the marker once', () => {
  it('writes the provenance marker and nothing else, leaving the prose as it was', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend);
    const result = backend.adopt({ id: human.id, loop: 'fix', detail: 'ours after all' });

    expect(result.status).toBe('adopted');
    if (result.status !== 'adopted') return;
    expect(result.item.body).toContain('Tapping a saved location does nothing on the second try.');
    expect(stripMarkers(result.item.body)).toBe('Tapping a saved location does nothing on the second try.');
    expect(extractItemMarkers(result.item.body)).toEqual({ loop: 'fix' });
    // no fingerprint invented, no label applied, no title touched
    expect(result.item.labels).toEqual([]);
    expect(result.item.title).toBe('Quick locations on the map is not working');
  });

  it('makes the item claimable by the loop that adopted it, and only then', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend);
    expect(backend.claim({ owner: 'beat-1', loop: 'fix', id: human.id }).status).toBe('refused');

    backend.adopt({ id: human.id, loop: 'fix' });
    expect(backend.claim({ owner: 'beat-1', loop: 'fix', id: human.id }).status).toBe('claimed');
  });

  it('is not a mode of claiming — no claim input reaches it', () => {
    // The proof by exhaustion of the surface: `ClaimInput` is owner/loop/id, and
    // there is no value of any of them that adopts. A beat calling `claim` on a
    // person's item gets a refusal whatever it passes.
    const { backend } = makeBackend();
    const human = handFiled(backend);
    for (const input of [
      { owner: 'beat-1', loop: 'fix', id: human.id },
      { owner: 'beat-1', id: human.id },
      { owner: human.id, loop: 'fix', id: human.id },
    ]) {
      expect(backend.claim(input).status).toBe('refused');
    }
    expect(filedByLoop(backend.items[0])).toBe('');
    expect(backend.calls).toEqual([]);
  });

  it('refuses a second adoption — the marker records who filed it, and records nothing if it can be overwritten', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend);
    backend.adopt({ id: human.id, loop: 'fix' });

    expect(backend.adopt({ id: human.id, loop: 'fix' })).toEqual({
      status: 'refused',
      reason: "item 1509 already belongs to loop 'fix' — it has nothing to adopt",
    });
    expect(backend.adopt({ id: human.id, loop: 'improve' })).toEqual({
      status: 'refused',
      reason:
        "item 1509 was filed by loop 'fix' — adoption writes the marker once, and re-pointing it would rewrite the record of who filed it",
    });
  });

  it("refuses to re-point another loop's filed item", () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend, { loop: 'find' });
    if (filed.status !== 'filed') throw new Error('expected filed');
    const result = backend.adopt({ id: filed.item.id, loop: 'fix' });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain("was filed by loop 'find'");
  });

  it('refuses a closed item and a missing one, and an adoption with no loop', () => {
    const { backend } = makeBackend();
    const human = handFiled(backend, { state: 'closed' });
    expect(backend.adopt({ id: human.id, loop: 'fix' })).toEqual({
      status: 'refused',
      reason: "item 1509 is closed — adopting a settled item would reopen someone else's decision",
    });
    expect(backend.adopt({ id: '404', loop: 'fix' })).toEqual({
      status: 'refused',
      reason: "no item '404' in the queue",
    });
    expect(backend.adopt({ id: human.id, loop: '  ' })).toEqual({
      status: 'refused',
      reason: 'an adoption requires a loop',
    });
  });

  it('appends the marker to a body, and to an empty one', () => {
    expect(withLoopMarker('Some prose.\n\n', 'fix')).toBe('Some prose.\n\n<!-- loop: fix -->\n');
    expect(withLoopMarker('', 'fix')).toBe('<!-- loop: fix -->\n');
  });
});

/**
 * THE DEFECT THIS SUITE EXISTS FOR — a consumer may work any item.
 *
 * Provenance was made to gate consumer WORK as well as consumer WRITES, and the
 * result was a `fix` loop that could not see one hand-filed issue: `0 claimable`
 * on a repo full of them, `claim` answering `empty` every beat, a loop whose
 * entire purpose is draining that backlog sitting inert.
 *
 * Every test here runs against the same memory backend the suite above uses, so
 * what is being proven is that the rule moved in the SHARED layer and not in one
 * store (allowed-pattern #14). The write rule is proven alongside it, because the
 * two are only ever one edit apart: a consumer that may work a person's item must
 * still not rewrite it.
 */
describe('a consumer works the queue; only its writes are still narrowed', () => {
  function makeConsumer(): {
    backend: MemoryQueueBackend;
    local: ReturnType<typeof createMemoryForeignItemState>;
    tick: (ms: number) => void;
  } {
    let now = T0;
    const local = createMemoryForeignItemState();
    const backend = new MemoryQueueBackend(() => now, 'consumer', local);
    return { backend, local, tick: (ms: number) => { now += ms; } };
  }

  it('claims a hand-filed item by id — the exact call that used to refuse', () => {
    const { backend } = makeConsumer();
    const human = handFiled(backend);
    const result = backend.claim({ owner: 'beat-1', loop: 'fix', id: human.id });

    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') return;
    expect(result.item.claimedBy).toBe('beat-1');
  });

  it('counts it claimable — the number `loop status` was lying about', () => {
    const { backend } = makeConsumer();
    handFiled(backend);
    expect(backend.count({ loop: 'fix' })).toMatchObject({ open: 1, claimable: 1 });
  });

  it('sweeps a queue of nothing but hand-filed items, oldest first', () => {
    const { backend } = makeConsumer();
    handFiled(backend, { id: '1510', createdAt: '2026-08-12T08:30:00.000Z' });
    handFiled(backend, { id: '1509', createdAt: '2026-08-12T08:00:00.000Z' });

    const result = backend.claim({ owner: 'beat-1', loop: 'fix' });
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') return;
    expect(result.item.id).toBe('1509');
  });

  it("works another loop's item too — a queue is a queue", () => {
    const { backend } = makeConsumer();
    const filed = fileOne(backend, { loop: 'find' });
    if (filed.status !== 'filed') throw new Error('expected filed');
    expect(backend.claim({ owner: 'beat-1', loop: 'fix', id: filed.item.id }).status).toBe('claimed');
  });

  it('records the claim LOCALLY, because the body is not the loop\'s to write', () => {
    const { backend, local } = makeConsumer();
    const human = handFiled(backend);
    backend.claim({ owner: 'beat-1', loop: 'fix', id: human.id });

    expect(local.events).toMatchObject([
      { backend: 'ledger', id: '1509', loop: 'fix', event: 'claimed', owner: 'beat-1' },
    ]);
    // and it reads back on the item, so eligibility and the honest-ending rule
    // both see a claim that lives nowhere on the item itself
    expect(backend.list({ state: 'open' })[0].claimedBy).toBe('beat-1');
    expect(heldClaims(backend.list({ state: 'open' }), 'beat-1')).toHaveLength(1);
  });

  it('CLOSES NOTHING on a person\'s item — a handled record, and the claim released', () => {
    const { backend, local } = makeConsumer();
    const human = handFiled(backend);
    backend.claim({ owner: 'beat-1', loop: 'fix', id: human.id });
    const result = backend.close({
      id: human.id,
      loop: 'fix',
      owner: 'beat-1',
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });

    expect(result.status).toBe('handled');
    if (result.status !== 'handled') return;
    expect(result.note).toContain('Closes #1509');
    // the store was never asked to close anything
    expect(backend.calls).not.toContain('setClosed');
    expect(backend.items[0].state).toBe('open');
    expect(local.events.map((event) => event.event)).toEqual(['claimed', 'handled']);
  });

  it('still refuses a `done` close on prose alone — the evidence gate is untouched', () => {
    const { backend } = makeConsumer();
    const human = handFiled(backend);
    const result = backend.close({
      id: human.id,
      loop: 'fix',
      reason: 'done',
      evidence: { commands: [], summary: 'it all works' },
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('never prose alone');
  });

  it('will not claim a handled item again — the loop stops re-doing its own work', () => {
    const { backend } = makeConsumer();
    const human = handFiled(backend);
    backend.close({ id: human.id, loop: 'fix', reason: 'done', evidence: PASSING_EVIDENCE });

    expect(backend.count({ loop: 'fix' })).toMatchObject({ open: 1, claimable: 0 });
    expect(backend.claim({ owner: 'beat-2', loop: 'fix' })).toEqual({
      status: 'empty',
      reason: 'nothing claimable in the queue',
    });
    const targeted = backend.claim({ owner: 'beat-2', loop: 'fix', id: human.id });
    if (targeted.status !== 'refused') throw new Error('expected a refusal');
    expect(targeted.reason).toContain('already handled by this loop');
    expect(targeted.reason).toContain('planflow-ai loop rework --loop fix --id 1509');
  });

  it('is workable again after `rework`, and refuses a rework of what was never handled', () => {
    const { backend } = makeConsumer();
    const human = handFiled(backend);
    backend.close({ id: human.id, loop: 'fix', reason: 'done', evidence: PASSING_EVIDENCE });

    const reworked = backend.rework({ id: human.id, loop: 'fix', detail: 'it came back' });
    expect(reworked.status).toBe('reworked');
    expect(backend.claim({ owner: 'beat-2', loop: 'fix', id: human.id }).status).toBe('claimed');

    const filed = fileOne(backend, { loop: 'fix' });
    if (filed.status !== 'filed') throw new Error('expected filed');
    expect(backend.rework({ id: filed.item.id, loop: 'fix' })).toEqual({
      status: 'refused',
      reason: `item ${filed.item.id} carries no handled record — there is nothing to release`,
    });
  });

  it('records a merge locally rather than on a person\'s item', () => {
    const { backend, local } = makeConsumer();
    const human = handFiled(backend);
    const result = backend.recordMerge({
      id: human.id,
      loop: 'fix',
      branch: 'loop/fix/1509',
      evidence: PASSING_EVIDENCE,
    });

    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') return;
    expect(result.note).toContain('Closes #1509');
    expect(backend.calls).not.toContain('setMerged');
    expect(backend.merges).toEqual([]);
    expect(local.events.map((event) => event.event)).toEqual(['handled']);
  });

  it('releases the claim on a person\'s item without touching anything else', () => {
    const { backend, local } = makeConsumer();
    const human = handFiled(backend);
    backend.claim({ owner: 'beat-1', loop: 'fix', id: human.id });

    const released = backend.unclaim(human.id, 'beat-1', 'fix');
    expect(released.status).toBe('unclaimed');
    if (released.status !== 'unclaimed') return;
    expect(released.wasClaimed).toBe(true);
    expect(released.item.claimedBy).toBeUndefined();
    expect(local.events.map((event) => event.event)).toEqual(['claimed', 'released']);
  });

  it('STILL refuses to approve one, and to reshape one — the write rule is intact', () => {
    const { backend } = makeConsumer();
    const human = handFiled(backend, { approved: false, labels: [APPROVAL_LABEL] });

    const approved = backend.approve(human.id);
    expect(approved.status).toBe('refused');
    if (approved.status !== 'refused') return;
    expect(approved.reason).toContain("`approve` would change someone else's item");
    // and no draft ever reached the backend, so no repo configuration is created
    expect(backend.drafts).toEqual([]);
  });

  it('leaves the CAP scoped to one loop\'s own items, however wide the queue got', () => {
    const { backend } = makeConsumer();
    for (const id of ['9001', '9002', '9003', '9004']) handFiled(backend, { id });
    // four items in the queue, cap 3 — but none of them are `find`'s, so filing
    // is not capped by somebody else's backlog
    expect(fileOne(backend, { loop: 'find' }).status).toBe('filed');
  });
});

/**
 * THE HANDOFF THE NEXT RUN READS (#1599).
 *
 * A consumer run finished a pipeline stage and left the next run unable to see
 * the pipeline at all: the only record of which plan was in flight was
 * `flow/STATE.md`, a file a prompt had to remember to write and five skills were
 * instructed to delete. The claim is what both runs already read, so the plan
 * name goes there — and, exactly like the claim, in a body marker for a loop's
 * own item and in local state for a person's.
 *
 * Everything below runs against the memory backend, so what it proves is that
 * the rule is in the SHARED layer and not in one store (allowed-pattern #14).
 */
describe('the plan a run is advancing, recorded on the claim (#1599)', () => {
  function makeConsumer(): {
    backend: MemoryQueueBackend;
    local: ReturnType<typeof createMemoryForeignItemState>;
  } {
    const local = createMemoryForeignItemState();
    return { backend: new MemoryQueueBackend(() => T0, 'consumer', local), local };
  }

  /** A loop's own item, claimed by `run-1` — the ordinary case. */
  function claimedOwnItem(backend: MemoryQueueBackend): QueueItem {
    const filed = fileOne(backend, { loop: 'fix' });
    if (filed.status !== 'filed') throw new Error('expected filed');
    const claimed = backend.claim({ owner: 'run-1', loop: 'fix', id: filed.item.id });
    if (claimed.status !== 'claimed') throw new Error('expected claimed');
    return claimed.item;
  }

  it('writes the marker on the item, and exposes it without re-parsing the body', () => {
    const { backend } = makeConsumer();
    const item = claimedOwnItem(backend);

    const result = backend.recordPlan({
      id: item.id,
      loop: 'fix',
      owner: 'run-1',
      plan: 'state-md-handoff',
    });

    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') return;
    expect(result.plan).toBe('state-md-handoff');
    expect(result.item.plan).toBe('state-md-handoff');
    expect(extractItemMarkers(result.item.body).plan).toBe('state-md-handoff');
    // and it reads back off the queue, which is the whole point: the NEXT run
    // learns the pipeline from the item, not from a file
    expect(backend.list({ state: 'open' })[0].plan).toBe('state-md-handoff');
  });

  it('re-recording replaces rather than accumulates', () => {
    const { backend } = makeConsumer();
    const item = claimedOwnItem(backend);
    backend.recordPlan({ id: item.id, loop: 'fix', plan: 'first-plan' });
    backend.recordPlan({ id: item.id, loop: 'fix', plan: 'second-plan' });

    const read = backend.list({ state: 'open' })[0];
    expect(read.plan).toBe('second-plan');
    expect(read.body.match(/loop-plan:/g)).toHaveLength(1);
  });

  it('clears the record when asked with no plan — one verb, both directions', () => {
    const { backend } = makeConsumer();
    const item = claimedOwnItem(backend);
    backend.recordPlan({ id: item.id, loop: 'fix', plan: 'state-md-handoff' });

    const cleared = backend.recordPlan({ id: item.id, loop: 'fix' });
    expect(cleared.status).toBe('recorded');
    if (cleared.status !== 'recorded') return;
    expect(cleared.plan).toBe('');
    expect(cleared.item.plan).toBeUndefined();
    expect(backend.list({ state: 'open' })[0].body).not.toContain('loop-plan:');
  });

  it('SURVIVES AN UNCLAIM — an item handed back mid-pipeline still has a pipeline', () => {
    const { backend } = makeConsumer();
    const item = claimedOwnItem(backend);
    backend.recordPlan({ id: item.id, loop: 'fix', plan: 'state-md-handoff' });

    backend.unclaim(item.id, 'run-1', 'fix');
    expect(backend.list({ state: 'open' })[0].plan).toBe('state-md-handoff');
  });

  it('is CLEARED when the item is settled — a closed item carries no pipeline', () => {
    const { backend } = makeConsumer();
    const item = claimedOwnItem(backend);
    backend.recordPlan({ id: item.id, loop: 'fix', owner: 'run-1', plan: 'state-md-handoff' });

    const closed = backend.close({
      id: item.id,
      loop: 'fix',
      owner: 'run-1',
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });
    expect(closed.status).toBe('closed');
    if (closed.status !== 'closed') return;
    expect(closed.item.plan).toBeUndefined();
    expect(closed.item.body).not.toContain('loop-plan:');
    // cleared BEFORE the close, through the same primitive that wrote it
    expect(backend.calls.slice(-2)).toEqual(['setPlan', 'setClosed']);
  });

  it('refuses to record one on a settled item', () => {
    const { backend } = makeConsumer();
    const item = claimedOwnItem(backend);
    backend.close({ id: item.id, loop: 'fix', owner: 'run-1', reason: 'done', evidence: PASSING_EVIDENCE });

    const result = backend.recordPlan({ id: item.id, loop: 'fix', plan: 'state-md-handoff' });
    expect(result).toEqual({
      status: 'refused',
      reason: `item ${item.id} is closed — a settled item carries no pipeline`,
    });
  });

  it('refuses a run that no longer holds the item — it cannot redirect the pipeline', () => {
    const { backend } = makeConsumer();
    const item = claimedOwnItem(backend);

    const result = backend.recordPlan({
      id: item.id,
      loop: 'fix',
      owner: 'run-2',
      plan: 'someone-elses-plan',
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain("is claimed by 'run-1' — 'run-2' cannot record its plan");
  });

  it('refuses a malformed plan name rather than sanitizing it', () => {
    const { backend } = makeConsumer();
    const item = claimedOwnItem(backend);
    const result = backend.recordPlan({ id: item.id, loop: 'fix', plan: '../etc/passwd' });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('no path separators');
    // nothing was written on the way to the refusal
    expect(backend.calls).not.toContain('setPlan');
  });

  it('refuses an item that is not in the queue', () => {
    const { backend } = makeConsumer();
    expect(backend.recordPlan({ id: '404', loop: 'fix', plan: 'x' })).toEqual({
      status: 'refused',
      reason: "no item '404' in the queue",
    });
  });

  it("WRITES NOTHING ON A PERSON'S ITEM — the record goes to local state", () => {
    const { backend, local } = makeConsumer();
    const human = handFiled(backend);
    backend.claim({ owner: 'run-1', loop: 'fix', id: human.id });

    const result = backend.recordPlan({
      id: human.id,
      loop: 'fix',
      owner: 'run-1',
      plan: 'state-md-handoff',
    });

    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') return;
    // the prose is exactly as the person left it, and no primitive was reached
    expect(backend.calls).not.toContain('setPlan');
    expect(backend.items[0].body).toBe('Tapping a saved location does nothing on the second try.');
    expect(local.events.map((event) => event.event)).toEqual(['claimed', 'planned']);
    expect(local.events[1]).toMatchObject({ backend: 'ledger', id: '1509', plan: 'state-md-handoff' });
    // and it still reads back on the item, so one field answers for both kinds
    expect(result.item.plan).toBe('state-md-handoff');
    expect(backend.list({ state: 'open' })[0].plan).toBe('state-md-handoff');
  });

  it("clears a person's item record when the loop is finished with it", () => {
    const { backend, local } = makeConsumer();
    const human = handFiled(backend);
    backend.claim({ owner: 'run-1', loop: 'fix', id: human.id });
    backend.recordPlan({ id: human.id, loop: 'fix', owner: 'run-1', plan: 'state-md-handoff' });

    const handled = backend.close({
      id: human.id,
      loop: 'fix',
      owner: 'run-1',
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });
    expect(handled.status).toBe('handled');
    if (handled.status !== 'handled') return;
    // the `handled` record clears it in the fold — no second write
    expect(handled.item.plan).toBeUndefined();
    expect(local.events.map((event) => event.event)).toEqual(['claimed', 'planned', 'handled']);
  });

  it('a producer is still gated by provenance — it may not plan another loop\'s item', () => {
    const { backend } = makeBackend();
    const filed = fileOne(backend, { loop: 'find' });
    if (filed.status !== 'filed') throw new Error('expected filed');

    const result = backend.recordPlan({ id: filed.item.id, loop: 'fix', plan: 'state-md-handoff' });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain("was filed by loop 'find', not 'fix'");
  });

  it('reads an item filed before the marker existed as carrying no plan', () => {
    const { backend } = makeConsumer();
    const item = claimedOwnItem(backend);
    expect(item.plan).toBeUndefined();
    expect(backend.list({ state: 'open' })[0].plan).toBeUndefined();
    expect(handFiled(backend, { id: '2000' }).plan).toBeUndefined();
  });
});

/**
 * M1 — the read memo a report hands to the several backends it opens.
 *
 * It is deliberately the dumbest thing that could work: a key, a response, and
 * no opinion about either. Everything that makes it SAFE is a property of what
 * it refuses to do — it never derives an answer, never remembers a failure, and
 * never outlives the report that made it — so those are what is asserted here.
 */
describe('QueueReadSession', () => {
  it('fetches once for one key and hands the same response to every later reader', () => {
    const session = new QueueReadSession();
    let fetches = 0;
    const fetch = (): string => {
      fetches += 1;
      return `page-${String(fetches)}`;
    };

    expect(session.read('a', fetch)).toBe('page-1');
    expect(session.read('a', fetch)).toBe('page-1');
    expect(session.read('a', fetch)).toBe('page-1');
    // The SECOND reader got the first reader's page, not a second page — which
    // is what makes two rows of one report describe one moment.
    expect(fetches).toBe(1);
    expect(session.fetches).toBe(1);
  });

  it('treats a different key as a different question', () => {
    const session = new QueueReadSession();
    expect(session.read('open', () => 'o')).toBe('o');
    expect(session.read('all', () => 'a')).toBe('a');
    expect(session.fetches).toBe(2);
  });

  it('never remembers a failure — the next reader gets its own attempt', () => {
    const session = new QueueReadSession();
    let attempts = 0;
    const flaky = (): string => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return 'page';
    };

    expect(() => session.read('k', flaky)).toThrow('transient');
    // A remembered failure would make one row's hiccup every sibling row's, and
    // the per-row fail-soft guarantee is the one this feature cannot lose.
    expect(session.read('k', flaky)).toBe('page');
    expect(session.fetches).toBe(1);
  });
});

describe('byId — one read, scoped exactly as list would scope it (#1636)', () => {
  it('finds an item without a list read, and scopes by loop for a producer', () => {
    const backend = new MemoryQueueBackend(() => T0, 'producer');
    const filed = fileOne(backend, { loop: 'find' });
    if (filed.status !== 'filed') throw new Error('expected filed');

    expect(backend.byId(filed.item.id)?.id).toBe(filed.item.id);
    expect(backend.byId(filed.item.id, 'find')?.id).toBe(filed.item.id);
    // A producer asking under another loop's name is answered "not yours to see"
    // — the same narrowing scopeQuery applies to every list read.
    expect(backend.byId(filed.item.id, 'fix')).toBeNull();
    expect(backend.byId('9999')).toBeNull();
  });

  it("a consumer's queue is the queue — the loop narrows nothing", () => {
    const backend = new MemoryQueueBackend(() => T0, 'consumer');
    const filed = fileOne(backend, { loop: 'find' });
    if (filed.status !== 'filed') throw new Error('expected filed');

    expect(backend.byId(filed.item.id, 'fix')?.id).toBe(filed.item.id);
  });
});

describe('one page per invocation — status rows share their queue read (#1648)', () => {
  it('fetches at most once per key, however many rows ask', () => {
    const cache = new StatusPageCache();
    let fetches = 0;
    const fetch = (): QueueItem[] => {
      fetches += 1;
      return [];
    };
    cache.read('github:owner/name', fetch);
    cache.read('github:owner/name', fetch);
    cache.read('github:owner/name', fetch);
    expect(fetches).toBe(1);
    // A different queue is a different page — locations never bleed together.
    cache.read('ledger:flow/loops/queue.jsonl', fetch);
    expect(fetches).toBe(2);
  });

  it('scopeItemsToLoop answers exactly as list({loop}) does, both engines', () => {
    for (const engine of ['producer', 'consumer'] as const) {
      const backend = new MemoryQueueBackend(() => T0, engine);
      const mine = fileOne(backend, { loop: 'find', title: 'mine' });
      const theirs = fileOne(backend, { loop: 'fix', title: 'theirs' });
      if (mine.status !== 'filed' || theirs.status !== 'filed') throw new Error('expected filed');

      const page = backend.list({ state: 'all' });
      const scoped = scopeItemsToLoop(page, engine, 'find');
      const direct = backend.list({ loop: 'find', state: 'all' });
      expect(scoped.map((item) => item.id).sort()).toEqual(direct.map((item) => item.id).sort());
    }
  });
});
