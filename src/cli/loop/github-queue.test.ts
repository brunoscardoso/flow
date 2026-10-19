/**
 * Tests for the GitHub queue backend.
 *
 * `node:child_process` is MOCKED (allowed-pattern #12) — never a PATH stub,
 * because child processes inherit the real environment under jest and a PATH
 * stub therefore depends on what happens to be installed on the machine. No
 * real `gh` is ever invoked and no network is touched.
 *
 * Behaviour is driven through `FakeGh`, a small in-memory repository that
 * answers the same argv the real tool does. That makes two things testable at
 * once: the exact command line this backend builds, and what the backend does
 * with what comes back. The default exec (the one that actually shells out) is
 * covered separately against the mocked module.
 *
 * The shared rules (cap, dedup, eligibility, evidence) belong to the base class
 * and are proven in `queue-backend.test.ts`; what is proven here is this
 * backend's own half — argv, the defensive JSON reader, and the open-AND-closed
 * search that makes a wontfix permanent.
 */

import { jest } from '@jest/globals';

const mockExecFileSync = jest.fn<(file: string, args: string[], options?: unknown) => string>();

jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

// Imported after the mock is installed.
const {
  GH_DEFAULT_LIMIT,
  GH_ISSUE_FIELDS,
  GH_TIMEOUT_MS,
  GithubQueueBackend,
  closeReasonFromGh,
  composeCloseNote,
  composeMergeNote,
  defaultGhExec,
  defaultGhLog,
  ghCloseReason,
  parseCreatedIssueNumber,
  parseGhIssue,
  parseGhIssues,
  readGhLabels,
} = await import('./github-queue.js');
const { ghFailureDetail, ghFailureKind } = await import('./github-queue.js');
const { APPROVAL_LABEL, CLAIMED_LABEL, PARKED_LABEL, composeItemBody, countItems } = await import('./queue-backend.js');
const { loopFingerprint } = await import('./fingerprint.js');
const { createMemoryForeignItemState } = await import('./foreign-items.js');

import type { GhExec } from './github-queue.js';
import type { CloseEvidence } from './queue-backend.js';

const T0 = Date.parse('2026-08-12T09:00:00.000Z');
const ME = 'loop-runner';
const REPO = 'dev/plan-flow';

const PASSING_EVIDENCE: CloseEvidence = {
  commands: [
    { command: 'npm run test -- src/queue.test.ts', exitCode: 0 },
    { command: 'npm run typecheck', exitCode: 0 },
  ],
  artifacts: ['flow/.evidence/run/queue.log'],
};

/** One issue as `gh --json` reports it. */
interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: Array<{ name: string }>;
  createdAt: string;
  url: string;
  stateReason: string | null;
  assignees: Array<{ login: string }>;
}

/**
 * An in-memory repository answering `gh` argv. Every call is recorded, so a
 * test can assert on the command line as well as on the outcome.
 */
class FakeGh {
  readonly issues: FakeIssue[] = [];
  readonly calls: string[][] = [];
  /** Hook a test uses to act as a RIVAL run, mutating the issue mid-write. */
  onEdit?: (issue: FakeIssue) => void;
  /** Make `gh label create` fail, as a transient GitHub 5xx does (#1586). */
  failLabelCreate = false;

  /** Comments posted on issues, in order — where a merge record lands. */
  readonly comments: Array<{ number: number; body: string }> = [];
  /** Labels that exist in the repo — `--add-label` fails on any other. */
  readonly labels = new Set([APPROVAL_LABEL, PARKED_LABEL, CLAIMED_LABEL, 'loop-queue']);
  private clock = T0;

  readonly exec: GhExec = (args) => {
    this.calls.push([...args]);
    return this.run([...args]);
  };

  /** Advance the fake repo's clock (issue creation timestamps). */
  tick(ms: number): void {
    this.clock += ms;
  }

  /** Every argv this fake has been handed, as joined strings. */
  commandLines(): string[] {
    return this.calls.map((call) => call.join(' '));
  }

  private flag(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  }

  private flagAll(args: string[], name: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === name) values.push(args[index + 1]);
    }
    return values;
  }

  private require(number: string): FakeIssue {
    const issue = this.issues.find((entry) => String(entry.number) === number);
    if (issue === undefined) {
      // The live tool's wording — what fetchItem's not-found mapping keys on.
      throw new Error(
        `GraphQL: Could not resolve to an issue or pull request with the number of ${number}. (repository.issue)`,
      );
    }
    return issue;
  }

  private run(args: string[]): string {
    if (args[0] !== 'issue' && args[0] !== 'label') throw new Error(`gh: unsupported command ${args[0]}`);
    if (this.flag(args, '--repo') !== REPO) throw new Error('gh: wrong --repo');

    if (args[0] === 'label') {
      // `gh label list --json name` — what the backend reads before it decides
      // which extra labels the repo can actually take (#1577).
      if (args[1] === 'list') {
        return JSON.stringify([...this.labels].map((name) => ({ name })));
      }
      // `gh label create <name> --force` — "create a new label, or update an
      // existing one", so the fake accepts both cases the same way.
      if (args[1] !== 'create') throw new Error(`gh: unsupported subcommand ${args[1]}`);
      if (this.failLabelCreate) throw new Error('HTTP 500 (https://api.github.com/repos/o/r/labels/x)');
      if (!args.includes('--force') && this.labels.has(args[2])) {
        throw new Error(`gh: label '${args[2]}' already exists`);
      }
      this.labels.add(args[2]);
      return '';
    }

    switch (args[1]) {
      case 'list': {
        const state = this.flag(args, '--state') ?? 'open';
        const search = this.flag(args, '--search');
        const term = search === undefined ? undefined : search.split(' ')[0];
        return JSON.stringify(
          this.issues.filter(
            (issue) =>
              (state === 'all' || issue.state.toLowerCase() === state) &&
              (term === undefined || issue.body.includes(term)),
          ),
        );
      }
      case 'view':
        return JSON.stringify(this.require(args[2]));
      case 'create': {
        const number = this.issues.length + 1;
        for (const label of this.flagAll(args, '--label')) {
          if (!this.labels.has(label)) throw new Error(`gh: could not add label: '${label}' not found`);
        }
        this.issues.push({
          number,
          title: this.flag(args, '--title') ?? '',
          body: this.flag(args, '--body') ?? '',
          state: 'OPEN',
          labels: this.flagAll(args, '--label').map((name) => ({ name })),
          createdAt: new Date(this.clock).toISOString(),
          url: `https://github.com/${REPO}/issues/${number}`,
          stateReason: null,
          assignees: [],
        });
        return `https://github.com/${REPO}/issues/${number}\n`;
      }
      case 'edit': {
        const issue = this.require(args[2]);
        const body = this.flag(args, '--body');
        if (body !== undefined) issue.body = body;
        for (const label of this.flagAll(args, '--add-label')) {
          if (!this.labels.has(label)) throw new Error(`gh: could not add label: '${label}' not found`);
          if (!issue.labels.some((entry) => entry.name === label)) issue.labels.push({ name: label });
        }
        for (const label of this.flagAll(args, '--remove-label')) {
          issue.labels = issue.labels.filter((entry) => entry.name !== label);
        }
        for (const who of this.flagAll(args, '--add-assignee')) {
          const login = who === '@me' ? ME : who;
          if (!issue.assignees.some((entry) => entry.login === login)) {
            issue.assignees.push({ login });
          }
        }
        for (const who of this.flagAll(args, '--remove-assignee')) {
          const login = who === '@me' ? ME : who;
          issue.assignees = issue.assignees.filter((entry) => entry.login !== login);
        }
        this.onEdit?.(issue);
        return '';
      }
      case 'close': {
        const issue = this.require(args[2]);
        issue.state = 'CLOSED';
        issue.stateReason = this.flag(args, '--reason') === 'completed' ? 'COMPLETED' : 'NOT_PLANNED';
        return '';
      }
      case 'comment': {
        const issue = this.require(args[2]);
        this.comments.push({ number: issue.number, body: this.flag(args, '--body') ?? '' });
        return `https://github.com/${REPO}/issues/${issue.number}#issuecomment-1\n`;
      }
      case 'reopen': {
        const issue = this.require(args[2]);
        issue.state = 'OPEN';
        issue.stateReason = null;
        return '';
      }
      default:
        throw new Error(`gh: unsupported subcommand ${args[1]}`);
    }
  }
}

function makeBackend(): {
  gh: FakeGh;
  backend: InstanceType<typeof GithubQueueBackend>;
  tick: (ms: number) => void;
  /** Every line the backend logged — a repo-configuration write is never silent. */
  logged: string[];
} {
  const gh = new FakeGh();
  const logged: string[] = [];
  let now = T0;
  const backend = new GithubQueueBackend({
    repo: REPO,
    exec: gh.exec,
    clock: () => now,
    log: (message) => logged.push(message),
  });
  return {
    gh,
    backend,
    logged,
    tick: (ms: number) => {
      now += ms;
      gh.tick(ms);
    },
  };
}

beforeEach(() => {
  mockExecFileSync.mockReset();
});

describe('the default exec (mocked child_process, never a PATH stub)', () => {
  it('shells out to gh with argv and no shell', () => {
    mockExecFileSync.mockReturnValue('[]');
    expect(defaultGhExec(['issue', 'list', '--repo', REPO])).toBe('[]');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['issue', 'list', '--repo', REPO],
      expect.objectContaining({ encoding: 'utf-8', timeout: GH_TIMEOUT_MS }),
    );
  });

  it('lets a gh failure propagate rather than swallowing it', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('gh: not authenticated');
    });
    expect(() => defaultGhExec(['issue', 'list'])).toThrow('not authenticated');
  });
});

describe('defensive JSON reading (allowed-pattern #11)', () => {
  const fingerprint = loopFingerprint({ loop: 'find', title: 'a leak', primaryFile: 'src/a.ts' });
  const body = composeItemBody('Prose.', { loop: 'find', fingerprint, primaryFile: 'src/a.ts' });

  it('reads the documented shape', () => {
    const item = parseGhIssue({
      number: 12,
      title: 'a leak',
      body,
      state: 'OPEN',
      labels: [{ name: 'loop-queue' }],
      createdAt: '2026-08-12T09:00:00.000Z',
      url: `https://github.com/${REPO}/issues/12`,
      stateReason: null,
      assignees: [],
    });
    expect(item).toMatchObject({
      id: '12',
      loop: 'find',
      fingerprint,
      primaryFile: 'src/a.ts',
      state: 'open',
      labels: ['loop-queue'],
      approved: true,
      url: `https://github.com/${REPO}/issues/12`,
    });
  });

  it('accepts the documented variants: lowercase state, bare-string labels, snake_case keys', () => {
    const item = parseGhIssue({
      number: 12,
      title: 'a leak',
      body,
      state: 'closed',
      labels: ['loop-queue', APPROVAL_LABEL],
      created_at: '2026-08-12T09:00:00.000Z',
      html_url: `https://github.com/${REPO}/issues/12`,
      state_reason: 'NOT_PLANNED',
    });
    expect(item).toMatchObject({
      state: 'closed',
      labels: ['loop-queue', APPROVAL_LABEL],
      approved: false,
      closeReason: 'wontfix',
      createdAt: '2026-08-12T09:00:00.000Z',
      url: `https://github.com/${REPO}/issues/12`,
    });
  });

  it('reads labels in either shape and ignores junk entries', () => {
    expect(readGhLabels([{ name: 'a' }, 'b', 42, null, { id: 1 }])).toEqual(['a', 'b']);
    expect(readGhLabels(undefined)).toEqual([]);
  });

  it('reads a hand-opened issue with no markers rather than crashing the read', () => {
    const item = parseGhIssue({ number: 3, title: 'human issue', body: 'no markers here', state: 'OPEN' });
    expect(item).toMatchObject({ id: '3', loop: '', fingerprint: '', labels: [], approved: true });
  });

  it('skips a record with no issue number rather than guessing at one', () => {
    expect(parseGhIssue({ title: 'no number' })).toBeNull();
    expect(parseGhIssue('nope')).toBeNull();
    expect(parseGhIssues(JSON.stringify([{ title: 'no number' }, { number: 4, title: 'ok' }]))).toHaveLength(1);
  });

  it('reads an empty response as an empty list, and throws on unparseable output', () => {
    expect(parseGhIssues('')).toEqual([]);
    expect(parseGhIssues('{}')).toEqual([]);
    expect(() => parseGhIssues('not json')).toThrow('unparseable JSON');
  });

  it('parses the created issue number out of the URL gh prints', () => {
    expect(parseCreatedIssueNumber(`https://github.com/${REPO}/issues/42\n`)).toBe('42');
    expect(parseCreatedIssueNumber('Creating issue\nhttps://github.com/o/n/issues/7')).toBe('7');
    expect(() => parseCreatedIssueNumber('something went wrong')).toThrow('no issue number');
  });

  it('maps this layer\'s three close reasons onto GitHub\'s two', () => {
    expect(ghCloseReason('done')).toBe('completed');
    expect(ghCloseReason('wontfix')).toBe('not planned');
    expect(ghCloseReason('duplicate')).toBe('not planned');
    expect(closeReasonFromGh('COMPLETED')).toBe('done');
    expect(closeReasonFromGh('NOT_PLANNED')).toBe('wontfix');
    expect(closeReasonFromGh(undefined)).toBeUndefined();
    expect(closeReasonFromGh('REOPENED')).toBeUndefined();
  });
});

describe('argv', () => {
  it('files an issue with the composed body and its labels', () => {
    const { gh, backend } = makeBackend();
    const result = backend.file({
      loop: 'find',
      title: 'Unhandled rejection in queue.ts',
      body: 'It throws under load.',
      primaryFile: 'src/queue.ts',
      labels: ['loop-queue'],
      maxOpenIssues: 8,
    });
    if (result.status !== 'filed') throw new Error(`expected filed, got ${result.status}`);

    const create = gh.calls.find((call) => call[1] === 'create');
    expect(create).toBeDefined();
    expect(create).toEqual([
      'issue',
      'create',
      '--repo',
      REPO,
      '--title',
      'Unhandled rejection in queue.ts',
      '--body',
      expect.stringContaining(`<!-- loop-fp: ${result.item.fingerprint} -->`),
      '--label',
      'loop-queue',
    ]);
    expect(result.item.id).toBe('1');
    expect(result.item.url).toBe(`https://github.com/${REPO}/issues/1`);
  });

  it('searches open AND closed items by the bare hash, requesting the documented fields', () => {
    const { gh, backend } = makeBackend();
    backend.exists('a'.repeat(40));
    expect(gh.calls[0]).toEqual([
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      'all',
      '--limit',
      String(GH_DEFAULT_LIMIT),
      '--json',
      GH_ISSUE_FIELDS,
      '--search',
      `${'a'.repeat(40)} in:body`,
    ]);
  });

  it('adds the approval label when the directive gates the item', () => {
    const { gh, backend } = makeBackend();
    backend.file({ loop: 'find', title: 'gated', body: '', needsApproval: true, maxOpenIssues: 8 });
    const create = gh.calls.find((call) => call[1] === 'create');
    expect(create).toContain(APPROVAL_LABEL);
  });

  /**
   * FIVE ENGINEERS SHARE ONE LIST — the case this whole surface exists for.
   *
   * Two runs on two machines read the same open item and both write a claim to
   * it. The write is not atomic and nothing here can make it so; what must not
   * happen is BOTH runs proceeding to fix the same issue. So the claim is
   * re-read after writing, and the run that does not hold it is told it lost —
   * which is a different answer from "refused", because the correct next move
   * is the next task rather than a stop.
   */
  it('reports LOST when another run took the item between the read and the write', () => {
    const { gh, backend } = makeBackend();
    backend.file({ loop: 'find', title: 'a leak', body: '', maxOpenIssues: 8 });

    // The rival: it wins the race, so the re-read comes back holding someone
    // else. Simulated at the seam a real rival would act on — the issue itself.
    gh.onEdit = (issue) => {
      issue.body = issue.body.replace(/<!-- loop-claim: [^>]*-->/, '<!-- loop-claim: rival-run @ 2026-08-12T09:00:30.000Z -->');
    };

    const result = backend.claim({ owner: 'beat-7' });
    expect(result.status).toBe('lost');
    if (result.status !== 'lost') throw new Error('expected a lost claim');
    expect(result.reason).toContain('taken by someone else');
  });

  it('a lost claim is not a refusal — the run is meant to take the next task', () => {
    // The distinction is the whole point: `refused` means this run may not work
    // the item and should stop; `lost` means the item is fine and somebody else
    // has it. Collapsing them would halt a run over a rival's success, and
    // repeatedly, would trip the breaker on nothing.
    const { gh, backend } = makeBackend();
    backend.file({ loop: 'find', title: 'a leak', body: '', maxOpenIssues: 8 });
    gh.onEdit = (issue) => {
      issue.body = issue.body.replace(/<!-- loop-claim: [^>]*-->/, '<!-- loop-claim: rival-run @ 2026-08-12T09:00:30.000Z -->');
    };
    expect(backend.claim({ owner: 'beat-7' }).status).not.toBe('refused');
  });

  it('claims by writing the marker, the label AND the assignee a person actually sees', () => {
    const { gh, backend, tick } = makeBackend();
    backend.file({ loop: 'find', title: 'a leak', body: '', maxOpenIssues: 8 });
    tick(60_000);
    const claimed = backend.claim({ owner: 'beat-7' });
    if (claimed.status !== 'claimed') throw new Error('expected a claim');

    const edit = gh.calls.find((call) => call[1] === 'edit');
    expect(edit).toEqual([
      'issue',
      'edit',
      '1',
      '--repo',
      REPO,
      '--body',
      expect.stringContaining('<!-- loop-claim: beat-7 @ 2026-08-12T09:01:00.000Z -->'),
      '--add-label',
      CLAIMED_LABEL,
      // The assignee is the half a PERSON reads. A label shows on the issue
      // page; the assignee shows in every list, filter and notification the
      // other four engineers already use.
      '--add-assignee',
      '@me',
    ]);
    expect(claimed.item.claimedBy).toBe('beat-7');
    expect(claimed.item.claimedAt).toBe('2026-08-12T09:01:00.000Z');
    expect(claimed.item.labels).toContain(CLAIMED_LABEL);
  });

  it('unclaims by removing the marker and the label', () => {
    const { gh, backend } = makeBackend();
    backend.file({ loop: 'find', title: 'a leak', body: '', maxOpenIssues: 8 });
    backend.claim({ owner: 'beat-7' });
    const unclaimed = backend.unclaim('1');
    if (unclaimed.status !== 'unclaimed') throw new Error(unclaimed.reason);
    expect(unclaimed.wasClaimed).toBe(true);
    expect(unclaimed.item.claimedBy).toBeUndefined();
    expect(unclaimed.item.labels).not.toContain(CLAIMED_LABEL);
    expect(gh.commandLines().some((line) => line.includes(`--remove-label ${CLAIMED_LABEL}`))).toBe(true);
  });

  it('records the plan as ONE body edit beside the claim, and clears it again (#1599)', () => {
    const { gh, backend } = makeBackend();
    backend.file({ loop: 'find', title: 'a leak', body: '', maxOpenIssues: 8 });
    backend.claim({ owner: 'beat-7' });
    const before = gh.calls.length;

    const recorded = backend.recordPlan({
      id: '1',
      loop: 'find',
      owner: 'beat-7',
      plan: 'state-md-handoff',
    });
    if (recorded.status !== 'recorded') throw new Error(recorded.reason);
    expect(recorded.item.plan).toBe('state-md-handoff');
    expect(recorded.item.body).toContain('<!-- loop-plan: state-md-handoff -->');
    // still claimed, still labelled — entering a stage is a note between two
    // runs, not a decision about the item
    expect(recorded.item.claimedBy).toBe('beat-7');
    expect(recorded.item.labels).toContain(CLAIMED_LABEL);

    const writes = gh.calls.slice(before).filter((call) => call[1] === 'edit');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([
      'issue',
      'edit',
      '1',
      '--repo',
      REPO,
      '--body',
      expect.stringContaining('<!-- loop-plan: state-md-handoff -->'),
    ]);

    const cleared = backend.recordPlan({ id: '1', loop: 'find', owner: 'beat-7' });
    if (cleared.status !== 'recorded') throw new Error(cleared.reason);
    expect(cleared.item.plan).toBeUndefined();
    expect(cleared.item.body).not.toContain('loop-plan');
    expect(cleared.item.claimedBy).toBe('beat-7');
  });

  it('approves by REMOVING the label — the same call the ledger answers with a field flip', () => {
    const { gh, backend } = makeBackend();
    const filed = backend.file({
      loop: 'find',
      title: 'gated',
      body: '',
      needsApproval: true,
      maxOpenIssues: 8,
    });
    if (filed.status !== 'filed') throw new Error('expected filed');
    expect(backend.claim({ owner: 'beat-1' }).status).toBe('empty');

    const approved = backend.approve('1');
    if (approved.status !== 'approved') throw new Error('expected approved');
    expect(approved.item.approved).toBe(true);
    expect(gh.calls).toContainEqual(['issue', 'edit', '1', '--repo', REPO, '--remove-label', APPROVAL_LABEL]);
    expect(backend.claim({ owner: 'beat-1' }).status).toBe('claimed');
  });

  it('closes with the mapped reason and posts the evidence as the closing comment', () => {
    const { backend, gh } = makeBackend();
    backend.file({ loop: 'find', title: 'a leak', body: '', maxOpenIssues: 8 });
    const closed = backend.close({ id: '1', reason: 'done', detail: 'fixed', evidence: PASSING_EVIDENCE });
    expect(closed.status).toBe('closed');
    if (closed.status !== 'closed') return;
    expect(closed.item.state).toBe('closed');
    expect(closed.item.closeReason).toBe('done');

    const close = gh.calls.find((call) => call[1] === 'close');
    expect(close?.slice(0, 7)).toEqual(['issue', 'close', '1', '--repo', REPO, '--reason', 'completed']);
    const comment = close?.[8] ?? '';
    expect(comment).toContain('**Closed: done** — fixed');
    expect(comment).toContain('- `npm run test -- src/queue.test.ts` → exit 0');
    expect(comment).toContain('- `npm run typecheck` → exit 0');
    expect(comment).toContain('flow/.evidence/run/queue.log');
    expect(comment).toContain('<!-- loop-close: done -->');
  });

  it('reopens a closed item', () => {
    const { backend, gh } = makeBackend();
    backend.file({ loop: 'find', title: 'a leak', body: '', maxOpenIssues: 8 });
    backend.close({ id: '1', reason: 'done', evidence: PASSING_EVIDENCE });
    expect(backend.reopen('1').state).toBe('open');
    expect(gh.calls).toContainEqual(['issue', 'reopen', '1', '--repo', REPO]);
  });
});

/**
 * The one rule this backend bends. The vocabulary stays a setup precondition;
 * the directive's `topic:` — the user's own word, invented when they re-point a
 * loop — is created rather than made into a trip to GitHub's label settings.
 */
describe('the topic label (the one exception to labels-are-preconditions)', () => {
  /** A repo that has the vocabulary but has never heard of this topic. */
  function withMissingTopicLabel() {
    const made = makeBackend();
    expect(made.gh.labels.has('codemap')).toBe(false);
    return made;
  }

  it('creates a missing topic label with one --force call, and logs it', () => {
    const { gh, backend, logged } = withMissingTopicLabel();
    const filed = backend.file({
      loop: 'find',
      title: 'a leak',
      body: '',
      labels: ['loop-queue'],
      topic: 'codemap',
      maxOpenIssues: 8,
    });
    if (filed.status !== 'filed') throw new Error(`expected filed, got ${filed.status}`);

    expect(gh.calls.filter((call) => call[0] === 'label' && call[1] === 'create')).toEqual([
      ['label', 'create', 'codemap', '--repo', REPO, '--force'],
    ]);
    expect(logged).toEqual([`loop: ensured topic label 'codemap' in ${REPO}`]);
    // Provenance and area both land on the item.
    expect(filed.item.labels).toEqual(['loop-queue', 'codemap']);
  });

  it('creates the label BEFORE the issue, since gh issue create fails on a missing one', () => {
    const { gh, backend } = withMissingTopicLabel();
    backend.file({ loop: 'find', title: 'a leak', body: '', topic: 'codemap', maxOpenIssues: 8 });
    const lines = gh.commandLines();
    const create = lines.findIndex((line) => line.startsWith('label create'));
    const issue = lines.findIndex((line) => line.startsWith('issue create'));
    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(issue);
  });

  it('fires once per beat, not once per filed item', () => {
    const { gh, backend, logged } = withMissingTopicLabel();
    for (const title of ['a leak', 'a second leak', 'a third leak']) {
      expect(backend.file({ loop: 'find', title, body: '', topic: 'codemap', maxOpenIssues: 8 }).status).toBe(
        'filed',
      );
    }
    expect(gh.calls.filter((call) => call[0] === 'label' && call[1] === 'create')).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });

  it('does NOT rewrite a label the repo already has (#1586)', () => {
    // This used to write unconditionally — "no read-before-write" by design —
    // and the memo guarding it is per instance, while every `loop file` is a
    // fresh process. So each filing re-created a label that had existed since
    // the first item, putting a remote write on the critical path for nothing.
    const { gh, backend } = makeBackend();
    gh.labels.add('codemap');
    backend.file({ loop: 'find', title: 'a leak', body: '', topic: 'codemap', maxOpenIssues: 8 });
    expect(gh.calls.filter((call) => call[0] === 'label' && call[1] === 'create')).toHaveLength(0);
  });

  it('files the finding even when the label write fails — the item is the work (#1586)', () => {
    // Observed live: a 500 on `gh label create backlog` — a label the repo had
    // all along — refused the whole `loop file`, and a fully composed body was
    // lost. A transient failure on idempotent housekeeping must not destroy
    // work; `gh issue create` still carries the topic, and GitHub creates a
    // missing label on use.
    const { gh, backend, logged } = withMissingTopicLabel();
    gh.failLabelCreate = true;
    const result = backend.file({ loop: 'find', title: 'a leak', body: 'the whole finding', topic: 'codemap', maxOpenIssues: 8 });
    expect(result.status).toBe('filed');
    expect(logged.some((line) => line.includes('could not ensure topic label'))).toBe(true);
  });

  it('never creates a reserved label — those stay setup preconditions', () => {
    const { gh, backend } = withMissingTopicLabel();
    const gated = backend.file({
      loop: 'find',
      title: 'gated',
      body: '',
      topic: 'codemap',
      needsApproval: true,
      maxOpenIssues: 8,
    });
    if (gated.status !== 'filed') throw new Error('expected filed');
    expect(gh.calls.filter((call) => call[0] === 'label' && call[1] === 'create').map((call) => call[2])).toEqual(['codemap']);
    // And a directive that tried to make one its topic never reaches gh at all.
    expect(
      backend.file({ loop: 'find', title: 'sneaky', body: '', topic: APPROVAL_LABEL, maxOpenIssues: 8 }).status,
    ).toBe('refused');
    expect(gh.calls.filter((call) => call[0] === 'label' && call[1] === 'create')).toHaveLength(1);
  });

  it('touches no label configuration at all when the loop has no topic', () => {
    const { gh, backend, logged } = makeBackend();
    backend.file({ loop: 'find', title: 'a leak', body: '', labels: ['loop-queue'], maxOpenIssues: 8 });
    expect(gh.calls.some((call) => call[0] === 'label' && call[1] === 'create')).toBe(false);
    expect(logged).toEqual([]);
  });

  it('ensures each topic once when a loop is re-pointed mid-beat', () => {
    const { gh, backend } = withMissingTopicLabel();
    backend.file({ loop: 'find', title: 'a leak', body: '', topic: 'codemap', maxOpenIssues: 8 });
    backend.file({ loop: 'find', title: 'another leak', body: '', topic: 'panel', maxOpenIssues: 8 });
    expect(gh.calls.filter((call) => call[0] === 'label' && call[1] === 'create').map((call) => call[2])).toEqual(['codemap', 'panel']);
  });

  it('re-points without re-filing — the same finding under a new topic is a duplicate', () => {
    const { gh, backend } = withMissingTopicLabel();
    const first = backend.file({
      loop: 'find',
      title: 'Unhandled rejection in queue.ts',
      body: '',
      primaryFile: 'src/queue.ts',
      topic: 'codemap',
      maxOpenIssues: 8,
    });
    if (first.status !== 'filed') throw new Error('expected filed');
    const again = backend.file({
      loop: 'find',
      title: 'Unhandled rejection in queue.ts',
      body: '',
      primaryFile: 'src/queue.ts',
      topic: 'panel',
      maxOpenIssues: 8,
    });
    expect(again.status).toBe('duplicate');
    // No second issue, and the old item keeps the topic it was filed under.
    expect(gh.calls.filter((call) => call[1] === 'create' && call[0] === 'issue')).toHaveLength(1);
    if (again.status !== 'duplicate') return;
    expect(again.item.labels).toEqual(['codemap']);
  });

  it('logs to stderr by default, so a beat\'s JSON on stdout stays parseable', () => {
    const written: string[] = [];
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      defaultGhLog('loop: ensured topic label');
    } finally {
      spy.mockRestore();
    }
    expect(written).toEqual(['loop: ensured topic label\n']);
  });
});

describe('closed items are the memory', () => {
  it('finds a wontfix-closed item as a duplicate — never file this again', () => {
    const { backend } = makeBackend();
    const filed = backend.file({
      loop: 'find',
      title: 'Rewrite the parser in Rust',
      body: 'It would be faster.',
      primaryFile: 'src/parser.ts',
      maxOpenIssues: 8,
    });
    if (filed.status !== 'filed') throw new Error('expected filed');
    backend.close({ id: filed.item.id, reason: 'wontfix', detail: 'Not this year.' });

    const again = backend.file({
      loop: 'find',
      title: 'rewrite the parser in rust!',
      body: 'It would be faster.',
      primaryFile: './src/Parser.ts',
      maxOpenIssues: 8,
    });
    expect(again.status).toBe('duplicate');
    if (again.status !== 'duplicate') return;
    expect(again.item.state).toBe('closed');
  });

  it('does not count closed items against the open cap', () => {
    const { backend } = makeBackend();
    const filed = backend.file({ loop: 'find', title: 'alpha', body: '', maxOpenIssues: 1 });
    if (filed.status !== 'filed') throw new Error('expected filed');
    expect(backend.file({ loop: 'find', title: 'beta', body: '', maxOpenIssues: 1 }).status).toBe('refused');
    backend.close({ id: filed.item.id, reason: 'wontfix', detail: 'no' });
    expect(backend.file({ loop: 'find', title: 'beta', body: '', maxOpenIssues: 1 }).status).toBe('filed');
  });

  it('scopes reads to one loop using the body marker GitHub has no field for', () => {
    const { backend } = makeBackend();
    backend.file({ loop: 'find', title: 'alpha', body: '', maxOpenIssues: 8 });
    backend.file({ loop: 'improve', title: 'beta', body: '', maxOpenIssues: 8 });
    expect(backend.count({ loop: 'find' }).open).toBe(1);
    expect(backend.count({ loop: 'improve' }).open).toBe(1);
    expect(backend.count().open).toBe(2);
  });
});

describe('failures throw — an unreachable queue is never an empty one', () => {
  it('names the missing gh CLI', () => {
    const backend = new GithubQueueBackend({
      repo: REPO,
      exec: () => {
        const error = new Error('spawnSync gh ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });
    expect(() => backend.count()).toThrow('the gh CLI is not installed or not on PATH');
  });

  it('surfaces what gh actually said, naming the repo', () => {
    const backend = new GithubQueueBackend({
      repo: REPO,
      exec: () => {
        throw new Error('gh: authentication required');
      },
    });
    expect(() => backend.count()).toThrow(`gh issue list failed for ${REPO}: gh: authentication required`);
  });

  it('still never invents a label the repo does not have', () => {
    const { gh, backend } = makeBackend();
    backend.file({ loop: 'find', title: 'a leak', body: '', labels: ['nonexistent'], maxOpenIssues: 8 });
    // The one write a loop makes to repo configuration is the topic. An extra
    // tag is never created — that narrowness is the whole rule.
    expect(gh.calls.some((call) => call[0] === 'label' && call[1] === 'create' && call[2] === 'nonexistent')).toBe(
      false,
    );
    expect(gh.labels.has('nonexistent')).toBe(false);
  });
});

describe('one item by id is one issue view, never a page scan (#1636)', () => {
  it('byId reads through gh issue view and never lists', () => {
    // The regression: findById used to answer from `gh issue list --limit 100`,
    // so an item older than the newest page read as "no item in the queue" while
    // `gh issue view` found it fine. An exec that REFUSES list proves the read
    // path has no page dependency at all.
    const gh = new FakeGh();
    gh.issues.push({
      number: 30,
      title: 'an old one, far past any list page',
      body: '<!-- loop: fix -->\n<!-- loop-fingerprint: f30 -->',
      state: 'CLOSED',
      labels: [],
      createdAt: new Date(T0).toISOString(),
      url: `https://github.com/${REPO}/issues/30`,
      stateReason: 'COMPLETED',
      assignees: [],
    });
    const backend = new GithubQueueBackend({
      repo: REPO,
      exec: (args) => {
        if (args[1] === 'list') throw new Error('page scan — the read byId exists to avoid');
        return gh.exec(args);
      },
    });

    const item = backend.byId('30');
    expect(item?.id).toBe('30');
    expect(item?.state).toBe('closed');
    expect(gh.commandLines().some((line) => line.startsWith('issue view 30'))).toBe(true);
  });

  it('maps the live tool\'s "could not resolve" to null — the item is truly absent', () => {
    const { backend } = makeBackend();
    expect(backend.byId('9999')).toBeNull();
  });

  it('still throws on any other failure — unreachable is never missing', () => {
    const backend = new GithubQueueBackend({
      repo: REPO,
      exec: () => {
        throw new Error('connect ETIMEDOUT api.github.com');
      },
    });
    expect(() => backend.byId('30')).toThrow('ETIMEDOUT');
  });
});

describe('an unknown tag costs the tag, never the finding', () => {
  it('files anyway, drops the tag, and says which one', () => {
    // THE OLD BEHAVIOUR WAS PINNED BY A TEST, which is how it survived: filing
    // with a label the repo lacks threw `not found`, exit 1, and the body — the
    // whole point of the verb — was gone (#1577). The find directive tells runs
    // to tag work with a feature name from flow/brain/features/, and those are
    // markdown files, not GitHub labels, so this fired constantly.
    const { gh, backend, logged } = makeBackend();
    const result = backend.file({
      loop: 'find',
      title: 'a leak',
      body: 'a long, carefully written body',
      labels: ['agent-loops'],
      maxOpenIssues: 8,
    });

    expect(result.status).toBe('filed');
    if (result.status !== 'filed') return;
    expect(result.item.body).toContain('a long, carefully written body');
    expect(result.item.labels).not.toContain('agent-loops');
    expect(logged.join('\n')).toContain("has no label 'agent-loops'");
    // and the label never reached gh, so the create could not fail on it
    const create = gh.calls.find((call) => call[0] === 'issue' && call[1] === 'create');
    expect(create?.includes('agent-loops')).toBe(false);
  });

  it('keeps the labels the repo does have, beside the dropped one', () => {
    const { gh, backend } = makeBackend();
    gh.labels.add('bug');
    const result = backend.file({
      loop: 'find',
      title: 'a leak',
      body: 'body',
      labels: ['bug', 'agent-loops'],
      maxOpenIssues: 8,
    });
    if (result.status !== 'filed') throw new Error('expected filed');
    expect(result.item.labels).toContain('bug');
    expect(result.item.labels).not.toContain('agent-loops');
  });

  it('passes everything through when the repo cannot be asked', () => {
    // An unreadable label list is an environment problem. Answering it by
    // stripping the loop's own provenance label would break scoping and dedup
    // for every item filed while gh was unhappy, so unknown means pass through
    // and let gh decide — exactly what happened before this existed.
    const gh = new FakeGh();
    gh.labels.add('bug');
    const inner = gh.exec;
    const backend = new GithubQueueBackend({
      repo: REPO,
      exec: (args) => {
        if (args[0] === 'label' && args[1] === 'list') throw new Error('gh: rate limited');
        return inner(args);
      },
      clock: () => T0,
      log: () => {},
      local: createMemoryForeignItemState(),
    });
    const result = backend.file({ loop: 'find', title: 'a leak', body: 'body', labels: ['bug'], maxOpenIssues: 8 });
    if (result.status !== 'filed') throw new Error('expected filed');
    expect(result.item.labels).toContain('bug');
  });
});

describe('composeCloseNote', () => {
  it('renders a note with no evidence for a wontfix', () => {
    expect(composeCloseNote('wontfix', 'By design.', undefined)).toBe(
      '**Closed: wontfix** — By design.\n\n<!-- loop-close: wontfix -->',
    );
  });

  it('includes a summary when one is supplied, below the exit codes', () => {
    const note = composeCloseNote('done', undefined, {
      commands: [{ command: 'npm test', exitCode: 0 }],
      summary: 'Regression test added.',
    });
    expect(note.indexOf('exit 0')).toBeLessThan(note.indexOf('Regression test added.'));
    expect(note).toContain('**Closed: done**');
  });
});

/**
 * Phase 3 — the ending the whole loop exists for.
 *
 * A consumer that fixes a GitHub issue and does not close it leaves the item
 * open, claimed by a beat that is never coming back, while its own report says
 * success (forbidden-pattern #7). The CLI refuses that record; what is proven
 * HERE is the other half — that when a beat does reach `loop close --reason
 * done`, the issue really is closed on GitHub, as `completed`, carrying the
 * evidence the close rests on. No real `gh` runs: argv goes to `FakeGh`.
 */
describe('Task 3.4 — a `done` close really closes the GitHub issue', () => {
  it('closes a claimed item as completed, with the captured evidence in the comment', () => {
    const { backend, gh, tick } = makeBackend();
    const filed = backend.file({ loop: 'fix', title: 'a real bug', body: 'because', maxOpenIssues: 8 });
    if (filed.status !== 'filed') throw new Error('expected filed');
    tick(60_000);
    const claimed = backend.claim({ owner: 'beat-1', loop: 'fix' });
    if (claimed.status !== 'claimed') throw new Error('expected claimed');
    expect(claimed.item.labels).toContain(CLAIMED_LABEL);

    const closed = backend.close({
      id: claimed.item.id,
      reason: 'done',
      owner: 'beat-1',
      detail: 'fixed in loop/fix/1',
      evidence: PASSING_EVIDENCE,
    });
    if (closed.status !== 'closed') throw new Error(closed.reason);

    // the real call, exactly as `gh` receives it
    const close = gh.calls.find((call) => call[0] === 'issue' && call[1] === 'close');
    expect(close?.slice(0, 7)).toEqual([
      'issue',
      'close',
      claimed.item.id,
      '--repo',
      REPO,
      '--reason',
      'completed',
    ]);
    expect(close?.[7]).toBe('--comment');
    const comment = close?.[8] ?? '';
    for (const entry of PASSING_EVIDENCE.commands) {
      expect(comment).toContain(`- \`${entry.command}\` → exit ${entry.exitCode}`);
    }
    expect(comment).toContain('**Closed: done** — fixed in loop/fix/1');

    // and the issue really ended closed-as-completed in the repo
    const issue = gh.issues.find((entry) => String(entry.number) === claimed.item.id);
    expect(issue?.state).toBe('CLOSED');
    expect(issue?.stateReason).toBe('COMPLETED');
    expect(closed.item.state).toBe('closed');
    expect(closed.item.closeReason).toBe('done');

    // the cap gets its slot back — a closed item is memory, not a ghost
    expect(backend.count({ loop: 'fix' })).toMatchObject({ open: 0, closed: 1, claimed: 0 });
  });

  it('a `done` close without captured evidence never reaches gh at all', () => {
    const { backend, gh } = makeBackend();
    backend.file({ loop: 'fix', title: 'a real bug', body: '', maxOpenIssues: 8 });
    const before = gh.calls.length;

    const refused = backend.close({ id: '1', reason: 'done', evidence: { commands: [] } });
    expect(refused.status).toBe('refused');
    if (refused.status !== 'refused') return;
    expect(refused.reason).toContain('machine-checkable evidence');

    // nothing was written to the repo — the issue is still open and workable
    expect(gh.calls.slice(before).some((call) => call[1] === 'close')).toBe(false);
    expect(gh.issues[0].state).toBe('OPEN');
  });
});

/**
 * Phase 3 — a person's issue is not this backend's to reshape.
 *
 * The incident happened HERE, in the two calls this class can make to someone's
 * repository: `gh label create` and `gh issue edit`. The shared layer refuses
 * every write verb on an item no loop filed, and the one write that is allowed —
 * adoption, which only a person can reach — must be a single body edit with no
 * label attached and no label invented.
 */
describe('a hand-opened issue: refused, and adopted without touching the repo config', () => {
  /** An issue a person opened: no markers, and a label this loop never chose. */
  function handOpened(gh: FakeGh): void {
    gh.labels.add('bug');
    gh.issues.push({
      number: 1509,
      title: 'Quick locations on the map is not working',
      body: 'Tapping a saved location does nothing on the second try.',
      state: 'OPEN',
      labels: [{ name: 'bug' }],
      createdAt: '2026-08-12T08:00:00.000Z',
      url: `https://github.com/${REPO}/issues/1509`,
      stateReason: null,
      assignees: [],
    });
  }

  it('refuses to claim it and issues no write at all', () => {
    const { gh, backend } = makeBackend();
    handOpened(gh);

    const result = backend.claim({ owner: 'beat-1', loop: 'fix', id: '1509' });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('item 1509 carries no loop marker');

    // reads only: nothing edited, nothing labelled, no label invented
    expect(gh.commandLines().every((line) => line.startsWith('issue list') || line.startsWith('issue view')))
      .toBe(true);
    expect(gh.issues[0].labels).toEqual([{ name: 'bug' }]);
  });

  it('adopts with ONE body edit — no label added, and none created', () => {
    const { gh, backend, logged } = makeBackend();
    handOpened(gh);

    const adopted = backend.adopt({ id: '1509', loop: 'fix' });
    expect(adopted.status).toBe('adopted');
    if (adopted.status !== 'adopted') return;

    const edits = gh.calls.filter((call) => call[0] === 'issue' && call[1] === 'edit');
    expect(edits).toHaveLength(1);
    expect(edits[0]).not.toContain('--add-label');
    expect(edits[0]).not.toContain('--remove-label');
    expect(gh.calls.some((call) => call[0] === 'label' && call[1] === 'create')).toBe(false);
    expect(logged).toEqual([]);

    // the person's prose survives, with one marker appended
    expect(gh.issues[0].body).toContain('Tapping a saved location does nothing on the second try.');
    expect(gh.issues[0].body.match(/<!-- loop: /g)).toHaveLength(1);
    expect(gh.issues[0].labels).toEqual([{ name: 'bug' }]);
    expect(gh.issues[0].title).toBe('Quick locations on the map is not working');
  });

  it('is claimable by that loop only once it has been adopted', () => {
    const { gh, backend } = makeBackend();
    handOpened(gh);
    backend.adopt({ id: '1509', loop: 'fix' });
    expect(backend.claim({ owner: 'beat-1', loop: 'fix', id: '1509' }).status).toBe('claimed');
    expect(gh.issues[0].labels.map((label) => label.name)).toEqual(['bug', CLAIMED_LABEL]);
  });
});

/**
 * Phase 4 — the merge record on a GitHub item is a comment, and only a comment.
 *
 * The issue's state, labels and claim are untouched: a landed branch is a fact
 * about the code, and closing is a decision about the report. A primitive that
 * did both would make the close's evidence gate reachable by merging instead.
 */
describe('a merge is recorded as one comment on the issue', () => {
  it('posts the evidence verbatim and changes nothing else about the item', () => {
    const { gh, backend } = makeBackend();
    const filed = backend.file({
      loop: 'fix',
      title: 'Unhandled rejection in queue.ts',
      body: 'It throws under load.',
      maxOpenIssues: 8,
    });
    if (filed.status !== 'filed') throw new Error(`expected filed, got ${filed.status}`);
    const before = JSON.stringify(gh.issues);

    const recorded = backend.recordMerge({
      id: filed.item.id,
      loop: 'fix',
      owner: 'beat-1',
      branch: `loop/fix/${filed.item.id}`,
      pr: { number: '7', url: `https://github.com/${REPO}/pull/7` },
      evidence: PASSING_EVIDENCE,
    });

    expect(recorded.status).toBe('recorded');
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].body).toContain('**Merged: `loop/fix/1`**');
    expect(gh.comments[0].body).toContain('`npm run typecheck` → exit 0');
    expect(gh.comments[0].body).toContain(`https://github.com/${REPO}/pull/7`);
    expect(gh.comments[0].body).toContain('<!-- loop-merge: loop/fix/1 -->');
    // no close, no label, no body rewrite — the issue is exactly as it was
    expect(JSON.stringify(gh.issues)).toBe(before);
    expect(gh.commandLines().some((line) => line.startsWith('issue close'))).toBe(false);
  });

  it('renders the note the same way the close note renders its evidence', () => {
    const note = composeMergeNote({
      id: '1',
      branch: 'loop/fix/1',
      evidence: { commands: [{ command: 'npm run build', exitCode: 0 }], summary: 'landed' },
    });
    expect(note.indexOf('exit 0')).toBeLessThan(note.indexOf('landed'));
    expect(note.startsWith('**Merged: `loop/fix/1`**')).toBe(true);
    // an unmerged-by-PR record still reads cleanly
    expect(note).not.toContain('Pull request:');
  });
});

/**
 * A consumer working someone's issue — the label, and NOTHING else.
 *
 * This is the pair to the suite above. That one proves a producer still refuses;
 * this one proves the loop whose job is draining the backlog can actually do it,
 * and that doing it costs the user's issue exactly one label.
 *
 * The whole reason it is checked HERE and not only in the shared layer is that
 * this class is where the two calls that can reach someone's repository live
 * (`gh issue edit` and `gh label create`). What is asserted is the argv.
 */
describe('a consumer works a hand-opened issue, writing only the claim label', () => {
  function makeConsumer(): {
    gh: FakeGh;
    backend: InstanceType<typeof GithubQueueBackend>;
    local: ReturnType<typeof createMemoryForeignItemState>;
    logged: string[];
  } {
    const gh = new FakeGh();
    const logged: string[] = [];
    const local = createMemoryForeignItemState();
    gh.labels.add('bug');
    gh.issues.push({
      number: 1509,
      title: 'Quick locations on the map is not working',
      body: 'Tapping a saved location does nothing on the second try.',
      state: 'OPEN',
      labels: [{ name: 'bug' }],
      createdAt: '2026-08-12T08:00:00.000Z',
      url: `https://github.com/${REPO}/issues/1509`,
      stateReason: null,
      assignees: [],
    });
    const backend = new GithubQueueBackend({
      repo: REPO,
      exec: gh.exec,
      clock: () => T0,
      log: (message) => logged.push(message),
      engine: 'consumer',
      local,
    });
    return { gh, backend, local, logged };
  }

  it('claims it with one `--add-label` and NO `--body`', () => {
    const { gh, backend } = makeConsumer();
    const result = backend.claim({ owner: 'beat-1', loop: 'fix', id: '1509' });

    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') return;
    expect(result.item.claimedBy).toBe('beat-1');

    const edits = gh.calls.filter((call) => call[0] === 'issue' && call[1] === 'edit');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('--add-label');
    expect(edits[0]).toContain(CLAIMED_LABEL);
    // the body is never sent, so the person's prose cannot be rewritten
    expect(edits[0]).not.toContain('--body');
    expect(gh.issues[0].body).toBe('Tapping a saved location does nothing on the second try.');
    expect(gh.issues[0].labels).toEqual([{ name: 'bug' }, { name: CLAIMED_LABEL }]);
    // and no label was invented on the way
    expect(gh.calls.some((call) => call[0] === 'label' && call[1] === 'create')).toBe(false);
  });

  it('closes NOTHING and comments NOTHING — the label comes off, the record goes local', () => {
    const { gh, backend, local } = makeConsumer();
    backend.claim({ owner: 'beat-1', loop: 'fix', id: '1509' });
    const result = backend.close({
      id: '1509',
      loop: 'fix',
      owner: 'beat-1',
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });

    expect(result.status).toBe('handled');
    if (result.status !== 'handled') return;
    expect(result.note).toContain('Closes #1509');

    expect(gh.commandLines().some((line) => line.startsWith('issue close'))).toBe(false);
    expect(gh.comments).toEqual([]);
    expect(gh.issues[0].state).toBe('OPEN');
    expect(gh.issues[0].labels).toEqual([{ name: 'bug' }]);
    expect(gh.issues[0].body).toBe('Tapping a saved location does nothing on the second try.');
    expect(local.events.map((event) => event.event)).toEqual(['claimed', 'handled']);
  });

  it('records a merge locally rather than commenting on the issue', () => {
    const { gh, backend, local } = makeConsumer();
    const recorded = backend.recordMerge({
      id: '1509',
      loop: 'fix',
      branch: 'loop/fix/1509',
      pr: { number: '7', url: `https://github.com/${REPO}/pull/7` },
      evidence: PASSING_EVIDENCE,
    });

    expect(recorded.status).toBe('recorded');
    expect(gh.comments).toEqual([]);
    expect(local.events.map((event) => event.event)).toEqual(['handled']);
  });

  it('does not hand the same issue to the next beat', () => {
    const { backend } = makeConsumer();
    expect(backend.count({ loop: 'fix' })).toMatchObject({ open: 1, claimable: 1 });
    backend.close({ id: '1509', loop: 'fix', reason: 'done', evidence: PASSING_EVIDENCE });
    expect(backend.count({ loop: 'fix' })).toMatchObject({ open: 1, claimable: 0 });
    expect(backend.claim({ owner: 'beat-2', loop: 'fix' }).status).toBe('empty');
  });
});

describe("a person's issue claimed on one machine is held everywhere", () => {
  /**
   * TWO MACHINES, ONE REPO. A machine is modelled by its own backend over its
   * own local state — `foreign.jsonl` is machine-local, which is exactly the
   * asymmetry that made this fail — while `FakeGh` is the shared GitHub both of
   * them read and write. Nothing else about them differs, including the account:
   * one person running two checkouts is the real case, and `@me` resolves to the
   * same login on both.
   */
  function makeFleet(): {
    gh: FakeGh;
    machineA: InstanceType<typeof GithubQueueBackend>;
    machineB: InstanceType<typeof GithubQueueBackend>;
  } {
    const gh = new FakeGh();
    gh.labels.add('bug');
    gh.issues.push({
      number: 1509,
      title: 'Quick locations on the map is not working',
      body: 'Tapping a saved location does nothing on the second try.',
      state: 'OPEN',
      labels: [{ name: 'bug' }],
      createdAt: '2026-08-12T08:00:00.000Z',
      url: `https://github.com/${REPO}/issues/1509`,
      stateReason: null,
      assignees: [],
    });
    const machine = (): InstanceType<typeof GithubQueueBackend> =>
      new GithubQueueBackend({
        repo: REPO,
        exec: gh.exec,
        clock: () => T0,
        log: () => {},
        engine: 'consumer',
        local: createMemoryForeignItemState(),
      });
    return { gh, machineA: machine(), machineB: machine() };
  }

  it('refuses the second machine the issue the first is working', () => {
    const { machineA, machineB } = makeFleet();

    expect(machineA.claim({ owner: 'beat-a', loop: 'fix', id: '1509' }).status).toBe('claimed');

    // Machine B has no local record of that claim and never will — the claimant
    // lives in A's `foreign.jsonl`. What it CAN see is the label and the
    // assignee A wrote, and that pair is the claim.
    const second = machineB.claim({ owner: 'beat-b', loop: 'fix', id: '1509' });
    expect(second.status).toBe('refused');
    if (second.status !== 'refused') return;
    expect(second.reason).toContain(CLAIMED_LABEL);
    expect(second.reason).toContain('loop unclaim --loop fix --id 1509');
  });

  it('leaves the second machine nothing to sweep up rather than a duplicate', () => {
    const { machineA, machineB } = makeFleet();
    machineA.claim({ owner: 'beat-a', loop: 'fix', id: '1509' });

    // The sweeping form is the one a beat actually runs, and it must come back
    // empty rather than handing over work already underway.
    expect(machineB.claim({ owner: 'beat-b', loop: 'fix' }).status).toBe('empty');
    expect(machineB.count({ loop: 'fix' })).toMatchObject({ open: 1, claimable: 0, claimed: 1 });
  });

  it('still lets the holding machine re-enter its own claim', () => {
    const { machineA } = makeFleet();
    machineA.claim({ owner: 'beat-a', loop: 'fix', id: '1509' });

    // The overlay puts the real owner back on the item, so a beat resuming after
    // a checkpoint is not locked out of the item it is already working.
    const again = machineA.claim({ owner: 'beat-a', loop: 'fix', id: '1509' });
    expect(again.status).toBe('claimed');
    if (again.status !== 'claimed') return;
    expect(again.item.claimedBy).toBe('beat-a');
  });

  it('hands the issue back when the holding machine releases it', () => {
    const { machineA, machineB } = makeFleet();
    machineA.claim({ owner: 'beat-a', loop: 'fix', id: '1509' });
    machineA.unclaim('1509', 'beat-a', 'fix');

    expect(machineB.claim({ owner: 'beat-b', loop: 'fix', id: '1509' }).status).toBe('claimed');
  });

  it('lets a person release a claim whose machine is gone', () => {
    const { machineA, machineB } = makeFleet();
    machineA.claim({ owner: 'beat-a', loop: 'fix', id: '1509' });

    // Machine A is off. `unclaim` WITHOUT an owner is the by-hand escape the
    // refusal names — the reason a derived claim carries no start time and so
    // never expires on its own is that no automatic sweep should be able to do
    // this on a guess.
    expect(machineB.unclaim('1509', undefined, 'fix').status).toBe('unclaimed');
    expect(machineB.claim({ owner: 'beat-b', loop: 'fix', id: '1509' }).status).toBe('claimed');
  });

  it("treats a person's own in-progress issue as theirs", () => {
    const { gh, machineA } = makeFleet();
    gh.issues[0].labels.push({ name: CLAIMED_LABEL });
    gh.issues[0].assignees.push({ login: 'someone-else' });

    // Nobody's loop wrote this — a person assigned themselves and marked it
    // in-progress. The pair means the same thing whoever wrote it.
    const result = machineA.claim({ owner: 'beat-a', loop: 'fix', id: '1509' });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('@someone-else');
  });

  it('needs BOTH halves — neither the label nor the assignee alone is a claim', () => {
    const labelOnly = makeFleet();
    labelOnly.gh.issues[0].labels.push({ name: CLAIMED_LABEL });
    expect(labelOnly.machineA.claim({ owner: 'beat-a', loop: 'fix', id: '1509' }).status).toBe(
      'claimed',
    );

    // An assignee with no label is ordinary triage — somebody was asked to look,
    // not somebody who is mid-fix.
    const assigneeOnly = makeFleet();
    assigneeOnly.gh.issues[0].assignees.push({ login: 'someone-else' });
    expect(assigneeOnly.machineA.claim({ owner: 'beat-a', loop: 'fix', id: '1509' }).status).toBe(
      'claimed',
    );
  });
});

describe('one remote read answers both list and counts (#1635)', () => {
  it('countItems over a single list() read reports what count() reports, at half the cost', () => {
    const { gh, backend } = makeBackend();
    backend.file({ loop: 'find', title: 'alpha', body: '', maxOpenIssues: 8 });
    backend.file({ loop: 'find', title: 'beta', body: '', maxOpenIssues: 8 });
    const claimed = backend.claim({ owner: 'beat-a', loop: 'find' });
    if (claimed.status !== 'claimed') throw new Error('expected claimed');
    backend.close({ id: claimed.item.id, reason: 'wontfix', detail: 'no' });

    gh.calls.length = 0;
    const items = backend.list({ state: 'all', loop: 'find' });
    const listReads = gh.calls.filter((argv) => argv[0] === 'issue' && argv[1] === 'list').length;
    // The contract the call sites lean on: the fold is free — folding counts
    // from an already-held list must never go back to the remote.
    expect(listReads).toBe(1);
    const folded = countItems(items);

    gh.calls.length = 0;
    const counted = backend.count({ loop: 'find' });
    const countReads = gh.calls.filter((argv) => argv[0] === 'issue' && argv[1] === 'list').length;
    expect(countReads).toBe(1); // count() pays its own read — which is why a
    // verb that already listed folds instead of calling it (#1635).
    expect(folded).toEqual(counted);
  });
});

describe('the foreign-item snapshot is read once per query, as its contract says (#1637)', () => {
  it('a list over N person-filed issues takes ONE snapshot, not N', () => {
    const gh = new FakeGh();
    gh.labels.add('bug');
    for (const number of [2001, 2002, 2003]) {
      gh.issues.push({
        number,
        title: `hand-filed ${number}`,
        body: 'A person wrote this — no loop markers.',
        state: 'OPEN',
        labels: [{ name: 'bug' }],
        createdAt: '2026-08-12T08:00:00.000Z',
        url: `https://github.com/${REPO}/issues/${number}`,
        stateReason: null,
        assignees: [],
      });
    }
    const inner = createMemoryForeignItemState();
    let snapshots = 0;
    const backend = new GithubQueueBackend({
      repo: REPO,
      exec: gh.exec,
      local: {
        snapshot: () => {
          snapshots += 1;
          return inner.snapshot();
        },
        append: (event) => inner.append(event),
      },
    });

    backend.list({ state: 'all' });
    expect(snapshots).toBe(1);

    // And a queue of only loop-filed items keeps the zero-read fast path.
    snapshots = 0;
    gh.issues.length = 0;
    backend.file({ loop: 'find', title: 'filed', body: '', maxOpenIssues: 8 });
    snapshots = 0;
    backend.list({ state: 'all' });
    expect(snapshots).toBe(0);
  });
});

describe('a gh failure says WHY, and never the invocation', () => {
  // execFileSync's message is the whole command line, and it travelled verbatim
  // into queueError and onto the tasks board — in front of a reader who cannot
  // run it (forbidden-pattern #12) and who had never configured GitHub at all.
  const signedOut = Object.assign(
    new Error('Command failed: gh issue list --repo owner/name --state open --json number,title'),
    { stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' },
  );

  it('keeps what gh said and drops execFileSync\'s wrapper', () => {
    const detail = ghFailureDetail(signedOut);
    expect(detail).toBe('To get started with GitHub CLI, please run:  gh auth login');
    expect(detail).not.toContain('Command failed');
    expect(detail).not.toContain('--json');
  });

  it('names the KIND separately, so a caller can offer the remedy', () => {
    expect(ghFailureKind(signedOut)).toBe('signed-out');
  });

  it('still answers ENOENT with the sentence it always did', () => {
    const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    expect(ghFailureDetail(missing)).toBe('the gh CLI is not installed or not on PATH');
    expect(ghFailureKind(missing)).toBe('not-installed');
  });

  it('tells an unreachable repo apart from a sign-in — only one has a remedy', () => {
    const gone = Object.assign(new Error('Command failed: gh issue list'), {
      stderr: 'GraphQL: Could not resolve to a Repository with the name.',
    });
    expect(ghFailureKind(gone)).toBe('unreachable');
  });
});
