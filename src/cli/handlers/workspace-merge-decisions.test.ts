/**
 * The shared merge-decisions record — the one writer, the order-free fold and
 * the reasons read back. A REAL git, a throwaway sandbox under one mkdtemp
 * directory; nothing reaches a network or a real Workspace.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { WorkspaceRefusal, createWorkspace, linkRepo } = await import('./workspace-model.js');
const { MERGE_DECISIONS_FILENAME, foldMergeDecisions, listMergeDecisions, mergeDecisionId, readMergeDecisions, reasonsFor, recordMergeDecision } =
  await import('./workspace-merge-decisions.js');

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;
const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PLAN_FLOW_HOME', 'PLAN_FLOW_VAULT_DIR', 'HOME'] as const;

function refusalOf(fn: () => unknown, reason: string): InstanceType<typeof WorkspaceRefusal> {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceRefusal);
    const refusal = error as InstanceType<typeof WorkspaceRefusal>;
    expect(refusal.reason).toBe(reason);
    return refusal;
  }
  throw new Error(`expected a ${reason} refusal, and nothing was refused`);
}

describe('foldMergeDecisions', () => {
  const decision = (id: string, ts: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'decision', id, kind: 'conflict', project: 'backend', path: 'a.md', take: 'ours', summary: 's', reason: '', outcome: 'agreed', author: null, ts, ...extra });
  const removal = (id: string): string => JSON.stringify({ type: 'removed', id, author: null, ts: '2026-01-03T00:00:00.000Z' });

  it('drops a removed entry whatever the line order', () => {
    const lines = [decision('aa', '2026-01-01T00:00:00.000Z'), decision('bb', '2026-01-02T00:00:00.000Z'), removal('aa')];
    for (const order of [lines, [...lines].reverse(), [lines[2] as string, lines[0] as string, lines[1] as string]]) {
      const folded = foldMergeDecisions(order);
      expect(folded.entries.map((entry) => entry.id)).toEqual(['bb']);
      expect(folded.removed.has('aa')).toBe(true);
    }
  });

  it('dedupes by id, keeps the earlier line, and counts what it cannot read', () => {
    const folded = foldMergeDecisions([
      decision('aa', '2026-01-05T00:00:00.000Z', { author: 'late' }),
      decision('aa', '2026-01-01T00:00:00.000Z', { author: 'early' }),
      'not json',
      JSON.stringify({ type: 'decision', id: 'cc', kind: 'nonsense' }),
    ]);
    expect(folded.entries).toHaveLength(1);
    expect(folded.entries[0]?.author).toBe('early');
    expect(folded.unreadable).toBe(2);
  });

  it('mints an id from the words, never the time or the author', () => {
    const words = { kind: 'conflict', project: 'backend', path: 'a.md', take: 'ours', summary: 's', reason: 'r', outcome: 'agreed' };
    expect(mergeDecisionId(words)).toBe(mergeDecisionId({ ...words }));
    expect(mergeDecisionId(words)).toMatch(/^[0-9a-f]{16}$/);
    expect(mergeDecisionId({ ...words, reason: 'other' })).not.toBe(mergeDecisionId(words));
  });
});

describe('reasonsFor', () => {
  it('returns live entries with a reason for that kind and project, newest first', () => {
    const make = (id: string, project: string, kind: string, reason: string, ts: string) => ({
      type: 'decision' as const,
      id,
      kind: kind as 'conflict',
      project,
      path: 'p',
      take: 'ours' as const,
      summary: 's',
      reason,
      outcome: 'disagreed' as const,
      author: null,
      ts,
    });
    const entries = [
      make('1', 'backend', 'conflict', 'old reason', '2026-01-01T00:00:00.000Z'),
      make('2', 'backend', 'conflict', 'new reason', '2026-02-01T00:00:00.000Z'),
      make('3', 'backend', 'conflict', '', '2026-03-01T00:00:00.000Z'),
      make('4', 'frontend', 'conflict', 'other project', '2026-03-01T00:00:00.000Z'),
      make('5', 'backend', 'add-add', 'other kind', '2026-03-01T00:00:00.000Z'),
    ];
    expect(reasonsFor(entries, { kind: 'conflict', project: 'backend' }).map((entry) => entry.id)).toEqual(['2', '1']);
    expect(reasonsFor(entries, { kind: 'conflict', project: 'nowhere' })).toEqual([]);
  });
});

describeWithGit('workspace merge-decision', () => {
  let sandbox: string;
  let flowFolder: string;
  let backend: string;
  let frontend: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  function makeRepo(name: string, origin: string): string {
    const path = join(sandbox, 'code', name);
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    writeFileSync(join(path, 'app.ts'), 'export {}\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'init');
    git(path, 'remote', 'add', 'origin', origin);
    return path;
  }

  const ctx = (ts?: string): { flowFolder: string; target: string; ts?: string } => ({ flowFolder, target: backend, ...(ts === undefined ? {} : { ts }) });
  const file = (): string => join(flowFolder, 'workspaces', 'team', MERGE_DECISIONS_FILENAME);
  const lines = (): string[] => (existsSync(file()) ? readFileSync(file(), 'utf-8').split('\n').filter((line) => line !== '') : []);
  const base = { kind: 'conflict', project: 'backend', path: 'projects/backend/plans/a.md', take: 'theirs', summary: 'took the Workspace text', outcome: 'agreed' };

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-merge-decisions-')));
    flowFolder = join(sandbox, 'plan-flow');
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
    process.env.HOME = join(sandbox, 'home');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.PLAN_FLOW_HOME = flowFolder;
    process.env.PLAN_FLOW_VAULT_DIR = join(sandbox, 'vault');
    createWorkspace({ flowFolder, name: 'Team' });
    backend = makeRepo('backend', 'git@github.com:acme/backend.git');
    frontend = makeRepo('frontend', 'https://github.com/acme/frontend.git');
    linkRepo({ flowFolder, target: backend });
    linkRepo({ flowFolder, target: frontend });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('records a decision with author and time, and lists it', () => {
    const result = recordMergeDecision({ ...ctx('2026-10-06T12:00:00.000Z'), action: 'record', ...base, reason: 'the shared text is newer' });
    expect(result).toMatchObject({ op: 'record', recorded: true, decision: { author: 'Test Person', ts: '2026-10-06T12:00:00.000Z', take: 'theirs', outcome: 'agreed' } });
    expect(lines()).toHaveLength(1);
    const listed = listMergeDecisions({ flowFolder, target: backend });
    expect(listed.decisions.map((entry) => entry.id)).toEqual([result.id]);
    expect(listMergeDecisions({ flowFolder, target: backend, project: 'frontend' }).decisions).toEqual([]);
  });

  it('is idempotent: the same words record once, even with another time', () => {
    const first = recordMergeDecision({ ...ctx('2026-10-06T12:00:00.000Z'), action: 'record', ...base, reason: 'why' });
    const again = recordMergeDecision({ ...ctx('2026-10-07T12:00:00.000Z'), action: 'record', ...base, reason: 'why' });
    expect(again).toMatchObject({ recorded: false, id: first.id });
    expect(lines()).toHaveLength(1);
  });

  it('converges: two machines writing the same decision fold to one entry', () => {
    const first = recordMergeDecision({ ...ctx('2026-10-06T12:00:00.000Z'), action: 'record', ...base, reason: 'why' });
    // The other machine's line: same words, its own author and time.
    const other = JSON.parse(lines()[0] as string) as Record<string, unknown>;
    appendFileSync(file(), `${JSON.stringify({ ...other, author: 'Someone Else', ts: '2026-10-08T00:00:00.000Z' })}\n`);
    const read = readMergeDecisions(join(flowFolder, 'workspaces', 'team'));
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toMatchObject({ id: first.id, author: 'Test Person' });
  });

  it('removes a decision, wins over line order, and refuses an unknown id', () => {
    const { id } = recordMergeDecision({ ...ctx('2026-10-06T12:00:00.000Z'), action: 'record', ...base, reason: 'why' });
    const removed = recordMergeDecision({ ...ctx('2026-10-07T12:00:00.000Z'), action: 'remove', id, reason: 'changed my mind' });
    expect(removed).toMatchObject({ op: 'remove', recorded: true });
    expect(listMergeDecisions({ flowFolder, target: backend }).decisions).toEqual([]);
    // Removal line first, decision line second: still removed.
    const [decisionLine, removalLine] = lines() as [string, string];
    writeFileSync(file(), `${removalLine}\n${decisionLine}\n`);
    expect(listMergeDecisions({ flowFolder, target: backend }).decisions).toEqual([]);
    // Removing twice appends nothing; recording the same words does not bring it back.
    expect(recordMergeDecision({ ...ctx(), action: 'remove', id })).toMatchObject({ recorded: false });
    expect(recordMergeDecision({ ...ctx(), action: 'record', ...base, reason: 'why' })).toMatchObject({ recorded: false, removed: true });
    expect(lines()).toHaveLength(2);
  });

  it('refuses with the vocabulary, and writes nothing', () => {
    const kind = refusalOf(() => recordMergeDecision({ ...ctx(), action: 'record', ...base, kind: 'weird' }), 'invalid-decision-kind');
    expect(kind.payload.valid).toContain('add-add');
    const take = refusalOf(() => recordMergeDecision({ ...ctx(), action: 'record', ...base, take: 'neither' }), 'invalid-decision-take');
    expect(take.payload.valid).toEqual(['ours', 'theirs', 'merged', 'file', 'both']);
    refusalOf(() => recordMergeDecision({ ...ctx(), action: 'record', ...base, outcome: 'maybe' }), 'invalid-decision-outcome');
    const project = refusalOf(() => recordMergeDecision({ ...ctx(), action: 'record', ...base, project: 'billing' }), 'unknown-project');
    expect(project.payload.projects).toEqual(['backend', 'frontend']);
    refusalOf(() => recordMergeDecision({ ...ctx(), action: 'record', ...base, summary: '  ' }), 'invalid-decision');
    refusalOf(() => recordMergeDecision({ ...ctx(), action: 'remove', id: 'deadbeefdeadbeef' }), 'unknown-decision');
    expect(existsSync(file())).toBe(false);
  });

  it('answers by slug alone, from a folder in no Workspace (how the app asks), and refuses an unknown slug', () => {
    const outside = join(sandbox, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    const cwd = process.cwd();
    process.chdir(outside);
    try {
      const recorded = recordMergeDecision({ flowFolder, workspace: 'team', ts: '2026-10-06T12:00:00.000Z', action: 'record', ...base, project: 'frontend', reason: 'why' });
      expect(recorded).toMatchObject({ recorded: true, decision: { author: 'Test Person', project: 'frontend' } });
      expect(lines()).toHaveLength(1);
      expect(listMergeDecisions({ flowFolder, workspace: 'team' }).decisions.map((entry) => entry.id)).toEqual([recorded.id]);
      // Without the slug, the same folder is in no Workspace.
      refusalOf(() => listMergeDecisions({ flowFolder }), 'no-workspace');
      expect(() => listMergeDecisions({ flowFolder, workspace: 'nowhere' })).toThrow(WorkspaceRefusal);
      expect(lines()).toHaveLength(1);
    } finally {
      process.chdir(cwd);
    }
  });

  it('reads reasons back for one kind and project', () => {
    recordMergeDecision({ ...ctx('2026-10-06T12:00:00.000Z'), action: 'record', ...base, outcome: 'disagreed', reason: 'keep both headings' });
    recordMergeDecision({ ...ctx('2026-10-07T12:00:00.000Z'), action: 'record', ...base, path: 'x.md', reason: '' });
    recordMergeDecision({ ...ctx('2026-10-08T12:00:00.000Z'), action: 'record', ...base, project: 'frontend', reason: 'other project' });
    const { entries } = readMergeDecisions(join(flowFolder, 'workspaces', 'team'));
    expect(reasonsFor(entries, { kind: 'conflict', project: 'backend' }).map((entry) => entry.reason)).toEqual(['keep both headings']);
  });
});
