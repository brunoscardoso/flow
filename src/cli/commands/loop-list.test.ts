/**
 * Tests for `planflow-ai loop list` — the read verb over `LoopQueueBackend.list()`.
 *
 * `node:child_process` is MOCKED (allowed-pattern #12), never a PATH stub: a
 * child process inherits the REAL environment under jest, so a test that
 * arranged its `gh` by editing `process.env.PATH` would pass or fail on what
 * happens to be installed on the machine running it. That is also why these
 * tests live in their own file rather than in `loop.test.ts` — that suite
 * spawns the real CLI through `spawnSync`, and a module mock would take the
 * subprocess layer with it.
 *
 * The verb is asserted for what it must NOT do as much as for what it does:
 * an unreadable queue must come back as `items: null` with a reason, because
 * `[]` says "there is no work" and a queue that could not be reached has said
 * nothing at all.
 */

import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockExecFileSync = jest.fn<(file: string, args: string[], options?: unknown) => string>();

jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

// Imported after the mock is installed.
const { runLoop } = await import('./loop.js');
const { LedgerQueueBackend } = await import('../loop/ledger-queue.js');
const { GH_ISSUE_FIELDS, GH_DEFAULT_LIMIT } = await import('../loop/github-queue.js');

type LoopOptions = Parameters<typeof runLoop>[1];

/** A fixed clock, so every timestamp in an assertion is a constant. */
const NOW = Date.parse('2026-08-12T09:00:00.000Z');

const PRODUCER_DIRECTIVE = `---
loop: find
engine: producer
mission: Hunt for real bugs in the source tree
queue: ledger
topic: codemap
max_open_issues: 5
---
`;

const CONSUMER_DIRECTIVE = `---
loop: fix
engine: consumer
mission: Drain the queue one item at a time
queue: ledger
---
`;

const GITHUB_CONSUMER_DIRECTIVE = `---
loop: gh
engine: consumer
mission: Drain the open issue queue
queue: github
repo: owner/name
---
`;

const projects: string[] = [];

/** A throwaway project with the named directives already in place. */
function makeProject(directives: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'loop-list-'));
  projects.push(dir);
  mkdirSync(join(dir, 'flow', 'loops'), { recursive: true });
  for (const [name, content] of Object.entries(directives)) {
    writeFileSync(join(dir, 'flow', 'loops', `${name}.md`), content, 'utf-8');
  }
  return dir;
}

afterAll(() => {
  for (const dir of projects) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  mockExecFileSync.mockReset();
});

interface Invocation {
  stdout: string;
  /** stdout AND the logger, which is where a refusal lands (allowed-pattern #15). */
  combined: string;
  refusals: string[];
  exitCode: number;
  json: Record<string, unknown> | null;
}

type StdoutLike = { write: (chunk: unknown) => boolean };

/** Call a verb in-process, capturing stdout, the logger and the exit code. */
async function invoke(
  verb: string,
  options: Partial<LoopOptions> & { target: string },
): Promise<Invocation> {
  const chunks: string[] = [];
  const logged: string[] = [];
  const stdout = process.stdout as unknown as StdoutLike;
  const realWrite = stdout.write;
  const realLog = console.log;
  stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  console.log = (...args: unknown[]): void => {
    logged.push(args.map((arg) => String(arg)).join(' '));
  };

  const previousExit = process.exitCode;
  process.exitCode = 0;
  try {
    await runLoop(verb, { pull: false, ...options } as LoopOptions, { clock: () => NOW });
  } finally {
    stdout.write = realWrite;
    console.log = realLog;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = previousExit;

  const text = chunks.join('');
  let json: Record<string, unknown> | null = null;
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text.trim()) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return {
    stdout: text,
    combined: [text, ...logged].join('\n'),
    refusals: logged.filter((line) => line.includes('loop refused:')),
    exitCode,
    json,
  };
}

interface ListRow {
  loop: string;
  queueKind?: string;
  queueLocation?: string;
  items: Record<string, unknown>[] | null;
  directiveError?: string;
  queueError?: string;
}

/** The rows of a `loop list` result. */
function rows(result: Invocation): ListRow[] {
  return (result.json as unknown as { loops: ListRow[] }).loops;
}

/** File one finding into a ledger-backed loop. */
async function file(target: string, loop: string, title: string): Promise<void> {
  await invoke('file', { target, loop, title, body: 'because it is broken' });
}

/** The queue as the backend itself answers it — the verb's only source of truth. */
function ledgerItems(target: string, loop: string, state: 'open' | 'closed' | 'all'): unknown {
  const backend = new LedgerQueueBackend(
    join(target, 'flow', 'loops', 'queue.jsonl'),
    () => NOW,
    'test',
    'producer',
  );
  // Round-tripped through JSON because that is what a caller receives: an
  // absent optional field is absent, not `undefined`.
  return JSON.parse(JSON.stringify(backend.list({ loop, state })));
}

describe('Task 1.2 — the ledger backend, surfaced verbatim', () => {
  it('emits exactly what the backend returned, field for field', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'the codemap points at a deleted file');

    const listed = await invoke('list', { target, loop: 'find' });
    expect(listed.exitCode).toBe(0);
    expect(listed.json).toMatchObject({ status: 'ok', state: 'open' });

    const [row] = rows(listed);
    expect(row).toMatchObject({ loop: 'find', queueKind: 'ledger' });
    // NOT a hand-built expectation: the assertion is that the verb added,
    // dropped and derived nothing between the backend and stdout.
    expect(row.items).toEqual(ledgerItems(target, 'find', 'open'));

    const [item] = row.items ?? [];
    expect(item).toMatchObject({
      title: 'the codemap points at a deleted file',
      state: 'open',
      approved: true,
      loop: 'find',
      // the directive's topic rides the labels the backend wrote
      labels: expect.arrayContaining(['codemap']),
    });
    expect(typeof item.fingerprint).toBe('string');
  });

  it('filters open from closed, and defaults to open', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'still broken');
    await file(target, 'find', 'fixed since');
    const closing = await invoke('list', { target, loop: 'find' });
    const closable = (rows(closing)[0].items ?? []).find((entry) => entry.title === 'fixed since');
    await invoke('close', {
      target,
      loop: 'find',
      id: String(closable?.id),
      reason: 'done',
      evidence: JSON.stringify({ commands: [{ command: 'npm run test', exitCode: 0 }] }),
    });

    const open = await invoke('list', { target, loop: 'find', state: 'open' });
    expect((rows(open)[0].items ?? []).map((entry) => entry.title)).toEqual(['still broken']);

    const closed = await invoke('list', { target, loop: 'find', state: 'closed' });
    expect(closed.json).toMatchObject({ state: 'closed' });
    expect((rows(closed)[0].items ?? []).map((entry) => entry.title)).toEqual(['fixed since']);

    const all = await invoke('list', { target, loop: 'find', state: 'all' });
    expect(rows(all)[0].items).toHaveLength(2);

    // No `--state` is the same read as `--state open`, and says so in the result.
    const defaulted = await invoke('list', { target, loop: 'find' });
    expect(defaulted.json).toMatchObject({ state: 'open' });
    expect(defaulted.stdout).toBe(open.stdout);
  });

  it('lists every loop with a directive when none is named', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE, fix: CONSUMER_DIRECTIVE });
    await file(target, 'find', 'a finding');

    const listed = await invoke('list', { target });
    expect(listed.exitCode).toBe(0);
    expect(rows(listed).map((row) => row.loop)).toEqual(['find', 'fix']);
    // The consumer's slice is the whole queue and the producer's is its own
    // filings — the backend's rule, reported rather than re-decided here.
    expect(rows(listed)[1].items).toHaveLength(1);
  });

  it('reports an unreadable directive as unreadable, never as an empty queue', async () => {
    const listed = await invoke('list', { target: makeProject(), loop: 'ghost' });
    expect(listed.exitCode).toBe(0);
    const [row] = rows(listed);
    expect(row.items).toBeNull();
    expect(row.directiveError).toContain("no directive for loop 'ghost'");
  });

  it('renders the same result for a person, without jq', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'the codemap points at a deleted file');

    const listed = await invoke('list', { target, loop: 'find', human: true });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('find [ledger flow/loops/queue.jsonl] 1 open item');
    expect(listed.stdout).toContain('the codemap points at a deleted file');
    expect(listed.stdout).toContain('· open ·');
    expect(listed.stdout.trim().startsWith('{')).toBe(false);
  });
});

describe('Task 1.3 — the refusal contract', () => {
  it('refuses a malformed --state with ONE line on the combined transcript, exit 1', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const refused = await invoke('list', { target, loop: 'find', state: 'pending' });

    expect(refused.exitCode).toBe(1);
    expect(refused.refusals).toHaveLength(1);
    expect(refused.refusals[0]).toContain("malformed --state 'pending' — expected open|closed|all");
    expect(refused.refusals[0].match(/loop refused:/g)).toHaveLength(1);
    // the refusal is the ONLY output — no partial result was written
    expect(refused.stdout).toBe('');
    expect(refused.combined).not.toContain('"status":"ok"');
  });
});

// ── the github backend (mocked `gh`, never a PATH stub) ──

/** One issue as `gh --json` reports it. */
function ghIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: 'the board cannot render a Todo column',
    body: 'because no verb exposes the queue',
    state: 'OPEN',
    labels: [{ name: 'loop-fix' }],
    createdAt: '2026-08-11T09:00:00.000Z',
    url: 'https://github.com/owner/name/issues/12',
    stateReason: null,
    assignees: [],
    ...over,
  };
}

describe('Task 1.5 — the github backend', () => {
  it('asks `gh` for the named slice and surfaces the issues it answered with', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([ghIssue()]));
    const target = makeProject({ gh: GITHUB_CONSUMER_DIRECTIVE });

    const listed = await invoke('list', { target, loop: 'gh' });
    expect(listed.exitCode).toBe(0);

    const [file, args] = mockExecFileSync.mock.calls[0];
    expect(file).toBe('gh');
    expect(args).toEqual([
      'issue',
      'list',
      '--repo',
      'owner/name',
      '--state',
      'open',
      '--limit',
      String(GH_DEFAULT_LIMIT),
      '--json',
      GH_ISSUE_FIELDS,
    ]);

    const [row] = rows(listed);
    expect(row).toMatchObject({ loop: 'gh', queueKind: 'github', queueLocation: 'owner/name' });
    expect(row.items).toEqual([
      expect.objectContaining({
        id: '12',
        title: 'the board cannot render a Todo column',
        state: 'open',
        approved: true,
        labels: ['loop-fix'],
        url: 'https://github.com/owner/name/issues/12',
      }),
    ]);
  });

  it('passes `--state closed` through to the queue it is reading', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([ghIssue({ state: 'CLOSED', stateReason: 'COMPLETED' })]));
    const target = makeProject({ gh: GITHUB_CONSUMER_DIRECTIVE });

    const listed = await invoke('list', { target, loop: 'gh', state: 'closed' });
    expect(mockExecFileSync.mock.calls[0][1]).toContain('closed');
    expect(rows(listed)[0].items).toEqual([expect.objectContaining({ state: 'closed' })]);
  });

  /**
   * THE FAILURE THE WHOLE VERB EXISTS TO AVOID (NFR-1). A board that read `[]`
   * off an unreachable queue would tell an engineer there is nothing to do.
   */
  it('reports an unreachable queue as unreadable — items null, never []', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('could not resolve host: api.github.com');
    });
    const target = makeProject({ gh: GITHUB_CONSUMER_DIRECTIVE });

    const listed = await invoke('list', { target, loop: 'gh' });
    expect(listed.exitCode).toBe(0);
    const [row] = rows(listed);
    expect(row.items).toBeNull();
    expect(row.items).not.toEqual([]);
    expect(row.queueError).toContain('could not resolve host');
    // the location survives the failure — "unreadable" is only actionable with one
    expect(row.queueLocation).toBe('owner/name');

    const human = await invoke('list', { target, loop: 'gh', human: true });
    expect(human.stdout).toContain('queue unreadable — gh issue list failed');
  });

  it('one loop that cannot be read does not blank out another that can', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('gh: not authenticated');
    });
    const target = makeProject({ gh: GITHUB_CONSUMER_DIRECTIVE, find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'a ledger finding');

    const listed = await invoke('list', { target });
    const byLoop = new Map(rows(listed).map((row) => [row.loop, row]));
    expect(byLoop.get('gh')?.items).toBeNull();
    expect(byLoop.get('find')?.items).toHaveLength(1);
  });
});

/**
 * The GitHub half of Task 2.3 — the ledger half lives in `loop.test.ts`.
 *
 * It is HERE because a status row for a GitHub queue reaches `gh`, and the
 * mock above is the only way to arrange that without depending on whatever
 * happens to be installed and authenticated on the machine running the suite.
 */
describe('Task 2.3 — a GitHub loop names its repo, reachable or not', () => {
  interface StatusRow {
    loop: string;
    queueKind?: string;
    queueLocation?: string;
    queue: unknown;
    queueError?: string;
  }

  function statusRows(result: Invocation): Map<string, StatusRow> {
    const rows = (result.json as unknown as { loops: StatusRow[] }).loops;
    return new Map(rows.map((row) => [row.loop, row]));
  }

  it('reports kind and location for a reachable repo queue', async () => {
    mockExecFileSync.mockReturnValue('[]');
    const target = makeProject({ gh: GITHUB_CONSUMER_DIRECTIVE, find: PRODUCER_DIRECTIVE });

    const rows = statusRows(await invoke('status', { target }));
    expect(rows.get('gh')).toMatchObject({ queueKind: 'github', queueLocation: 'owner/name' });
    expect(rows.get('find')?.queueKind).toBe('ledger');
  });

  it('still names the repo when `gh` cannot answer — a location a reader can act on', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('gh: not authenticated');
    });
    const target = makeProject({ gh: GITHUB_CONSUMER_DIRECTIVE });

    const rows = statusRows(await invoke('status', { target }));
    expect(rows.get('gh')?.queueLocation).toBe('owner/name');
    expect(rows.get('gh')?.queueKind).toBe('github');
    // Unreadable, never empty — the counts stay null and say why.
    expect(rows.get('gh')?.queue).toBeNull();
    expect(String(rows.get('gh')?.queueError)).toContain('not authenticated');
  });
});

/**
 * M1 — one round trip per distinct read, however many rows want it.
 *
 * A report walks every loop in the project and opens a backend per row, so two
 * loops that name the same `repo:` used to phone GitHub twice for the same page:
 * `loop status` made FOUR calls to report on two loops (an `all` page and an
 * `open` page each), `loop list` made two, and the board runs both on every open,
 * project switch, Retry and claim. Measured against this repo's own two
 * directives before the session existed: status 4, list 2.
 *
 * These tests count the `gh issue list` invocations, because a saving nobody
 * counts is a saving nobody can keep. They also assert the numbers did not move
 * — the reduction is only worth having if the report is byte-for-byte the report
 * it was, which is why the memo remembers the RESPONSE and not any answer
 * derived from it.
 */
describe('M1 — the shared read session', () => {
  const GH_SECOND_ON_SAME_REPO = `---
loop: gh2
engine: producer
mission: File findings into the same repo the consumer drains
queue: github
repo: owner/name
topic: backlog
max_open_issues: 5
---
`;

  const GH_OTHER_REPO = `---
loop: elsewhere
engine: consumer
mission: Drain a different repo entirely
queue: github
repo: owner/other
---
`;

  /** Every `gh issue list` the run made, as argv. Writes and views are not counted. */
  function issueListCalls(): string[][] {
    return mockExecFileSync.mock.calls
      .filter(([file, args]) => file === 'gh' && args[0] === 'issue' && args[1] === 'list')
      .map(([, args]) => args);
  }

  /** The `--state` of each list call, in order — the slice is what a call IS. */
  function slices(): string[] {
    return issueListCalls().map((args) => args[args.indexOf('--state') + 1]);
  }

  it('`loop status` reads each slice once for the whole report, not once per row', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([ghIssue()]));
    const target = makeProject({
      gh: GITHUB_CONSUMER_DIRECTIVE,
      gh2: GH_SECOND_ON_SAME_REPO,
    });

    const report = await invoke('status', { target });
    expect(report.exitCode).toBe(0);

    // TWO rows, ONE call — was four, then two. The `all` page answers both rows'
    // counts AND their gated ids, because the loop an item belongs to is decided
    // after parsing and never reaches `gh`, and #1648 derives the open slice
    // from that same page rather than fetching it again.
    //
    // THE TRADE #1648 MAKES, recorded here because this is where it is visible:
    // `gh issue list` is bounded (`--limit`), so the `all` page is the newest N
    // whatever their state. On a repo with more open issues than that limit, an
    // open item older than the window is absent from the page and therefore from
    // the counts. Fewer calls, at the cost of an answer that is exact only while
    // the backlog fits in one page.
    expect(issueListCalls()).toHaveLength(1);
    expect(slices()).toEqual(['all']);

    const both = (report.json as unknown as { loops: { loop: string }[] }).loops;
    expect(both.map((row) => row.loop).sort()).toEqual(['gh', 'gh2']);
  });

  it('reports exactly the numbers it reported when each row read for itself', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([ghIssue()]));
    const alone = makeProject({ gh: GITHUB_CONSUMER_DIRECTIVE });
    const soloRows = statusByLoop(await invoke('status', { target: alone }));

    mockExecFileSync.mockClear();
    const shared = makeProject({ gh: GITHUB_CONSUMER_DIRECTIVE, gh2: GH_SECOND_ON_SAME_REPO });
    const sharedRows = statusByLoop(await invoke('status', { target: shared }));

    // THE WHOLE POINT: a row that shared its read is the row it was. Not a
    // subset of its fields — the queue block, the gated ids and the stuck claims
    // are the three things a shared read could plausibly have moved.
    expect(sharedRows.get('gh')?.queue).toEqual(soloRows.get('gh')?.queue);
    expect(sharedRows.get('gh')?.awaitingApprovalIds).toEqual(
      soloRows.get('gh')?.awaitingApprovalIds,
    );
    expect(sharedRows.get('gh')?.abandonedClaims).toEqual(soloRows.get('gh')?.abandonedClaims);
  });

  it('`loop list` collapses every row of one repo into a single read', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([ghIssue()]));
    const target = makeProject({
      gh: GITHUB_CONSUMER_DIRECTIVE,
      gh2: GH_SECOND_ON_SAME_REPO,
    });

    const listed = await invoke('list', { target });
    expect(listed.exitCode).toBe(0);
    // Every row asks for the same `--state`, so N rows are N identical requests.
    expect(issueListCalls()).toHaveLength(1);
    expect(rows(listed)).toHaveLength(2);
  });

  it('does not collapse two different repos into one answer', async () => {
    mockExecFileSync.mockImplementation((_file, args) => {
      const repo = args[args.indexOf('--repo') + 1];
      return JSON.stringify([ghIssue({ number: repo === 'owner/name' ? 12 : 99 })]);
    });
    const target = makeProject({ gh: GITHUB_CONSUMER_DIRECTIVE, elsewhere: GH_OTHER_REPO });

    const listed = await invoke('list', { target });
    // Different argv, different question, no sharing — the key is the request.
    expect(issueListCalls()).toHaveLength(2);
    const byLoop = new Map(rows(listed).map((row) => [row.loop, row]));
    expect((byLoop.get('gh')?.items ?? [])[0]).toMatchObject({ id: '12' });
    expect((byLoop.get('elsewhere')?.items ?? [])[0]).toMatchObject({ id: '99' });
  });

  /**
   * A FAILURE IS NEVER REMEMBERED, and this is the test that keeps it that way.
   * Rows fail soft one at a time; a memoized failure would let one loop's
   * transient `gh` hiccup blank every sibling that shares its repo, converting
   * the single fail-soft guarantee this feature has into a shared fate.
   */
  it('lets a row retry a read the previous row could not make', async () => {
    let calls = 0;
    mockExecFileSync.mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error('gh: server error');
      return JSON.stringify([ghIssue()]);
    });
    const target = makeProject({ gh: GITHUB_CONSUMER_DIRECTIVE, gh2: GH_SECOND_ON_SAME_REPO });

    const byLoop = new Map(rows(await invoke('list', { target })).map((row) => [row.loop, row]));
    const failed = [...byLoop.values()].filter((row) => row.items === null);
    const read = [...byLoop.values()].filter((row) => row.items !== null);
    expect(failed).toHaveLength(1);
    expect(String(failed[0].queueError)).toContain('server error');
    expect(read).toHaveLength(1);
  });

  it('a writing verb reads the store itself, session or no session', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([ghIssue()]));
    const target = makeProject({ gh2: GH_SECOND_ON_SAME_REPO });

    // `file` dedups against the queue before it writes, then writes. Sharing a
    // read with anything would be sharing it with a caller whose own write may
    // already have changed the answer, so no writing verb is handed a session.
    await invoke('file', { target, loop: 'gh2', title: 'a finding', body: 'reproduced' });
    const before = issueListCalls().length;
    await invoke('file', { target, loop: 'gh2', title: 'another finding', body: 'reproduced' });
    expect(issueListCalls().length).toBeGreaterThan(before);
  });
});

interface SharedStatusRow {
  loop: string;
  queue: unknown;
  awaitingApprovalIds?: string[];
  abandonedClaims?: unknown[];
}

/** The rows of a `loop status` result, by loop name. */
function statusByLoop(result: Invocation): Map<string, SharedStatusRow> {
  const loops = (result.json as unknown as { loops: SharedStatusRow[] }).loops;
  return new Map(loops.map((row) => [row.loop, row]));
}
