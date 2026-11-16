import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkPromotion,
  defaultBranchRef,
  documentItemId,
  hostForCheckout,
  parseGhPrList,
  projectCheckout,
  type DraftItem,
  type HostPrAnswer,
  type HostPrState,
} from './knowledge-landing.js';
import { hashFileContent } from '../blueprint/store.js';
import { readKnowledgeStatus } from '../state/knowledge-status-log.js';
import type { WorkspaceGit } from './workspace-model.js';

const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_OK ? describe : describe.skip;

const git: WorkspaceGit = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

describeWithGit('defaultBranchRef', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'pf-landing-ref-'));
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('prefers the remote’s recorded default branch over guessing main, and a Base branch setting over both', () => {
    const repo = join(sandbox, 'code');
    mkdirSync(repo);
    git(['init', '-q', '-b', 'main'], repo);
    git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], repo);
    git(['update-ref', 'refs/remotes/origin/develop', 'HEAD'], repo);
    git(['update-ref', 'refs/remotes/origin/release', 'HEAD'], repo);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'], repo);
    expect(defaultBranchRef(git, repo)).toBe('refs/remotes/origin/develop');
    expect(defaultBranchRef(git, repo, 'release')).toBe('refs/remotes/origin/release');
    // A setting naming no ref falls through to the ladder rather than answering null.
    expect(defaultBranchRef(git, repo, 'no-such')).toBe('refs/remotes/origin/develop');
  });
});

/**
 * Promotion against REAL repositories: a bare remote, a clone that does the
 * work, and the merges done the ways a host does them. The checker's only
 * view of "the remote" is what its own fetch brings back.
 */
describeWithGit('checkPromotion against real git', () => {
  let sandbox: string;
  let bare: string;
  let code: string;
  let flowDir: string;

  const sh = (...args: string[]): string => git(args, code);
  const write = (path: string, text: string): void => writeFileSync(join(code, path), text);
  const commitAll = (message: string): string => {
    sh('add', '-A');
    sh('commit', '-q', '-m', message);
    return sh('rev-parse', 'HEAD').trim();
  };
  const tip = (): string => sh('rev-parse', 'refs/remotes/origin/main').trim();
  const committerDate = (commit: string): string => new Date(sh('show', '-s', '--format=%cI', commit).trim()).toISOString();
  const logLines = (): string[] => {
    const path = join(flowDir, 'brain', '.structure', 'knowledge-status.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter((line) => line !== '') : [];
  };

  /** Make a feature branch that changes orders.ts, push it, and return its draft. */
  function featureDraft(branch = 'feat/orders', text = 'export const retries = 2\n', push = true): DraftItem {
    sh('checkout', '-q', '-b', branch);
    write('orders.ts', text);
    const commit = commitAll(`feat: orders on ${branch}`);
    if (push) sh('push', '-q', '-u', 'origin', branch);
    sh('checkout', '-q', 'main');
    return {
      item: hashFileContent(`item:${branch}`).slice(0, 16),
      kind: 'learning',
      branch,
      commit,
      hashes: [{ path: 'orders.ts', contentHash: hashFileContent(text) }],
    };
  }

  const check = (drafts: DraftItem[], host: HostPrState | null = null) =>
    checkPromotion(git, code, drafts, host, { flowDir, baseBranch: null });

  const hostSaying = (answer: HostPrAnswer | null): HostPrState & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      prState(branch) {
        asked.push(branch);
        return answer;
      },
    };
  };

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-promote-')));
    bare = join(sandbox, 'remote.git');
    git(['init', '-q', '--bare', '-b', 'main', bare], sandbox);
    const seed = join(sandbox, 'seed');
    mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    git(['config', 'user.name', 'Test Person'], seed);
    git(['config', 'user.email', 'test@example.com'], seed);
    writeFileSync(join(seed, 'orders.ts'), 'export const retries = 1\n');
    writeFileSync(join(seed, 'other.ts'), 'export const other = 1\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'init'], seed);
    git(['push', '-q', bare, 'main'], seed);
    code = join(sandbox, 'code');
    git(['clone', '-q', bare, code], sandbox);
    sh('config', 'user.name', 'Test Person');
    sh('config', 'user.email', 'test@example.com');
    flowDir = join(sandbox, 'flow');
    mkdirSync(flowDir);
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('a NORMAL merge promotes by ancestry, at the default-branch commit and its time', () => {
    const draft = featureDraft();
    sh('merge', '-q', '--no-ff', '-m', 'Merge feat/orders', 'feat/orders');
    sh('push', '-q', 'origin', 'main');

    const [result] = check([draft]);
    expect(result).toMatchObject({ item: draft.item, outcome: 'solid', reason: 'ancestor', written: true });
    const line = JSON.parse(logLines()[0]);
    expect(line).toEqual({ item: draft.item, status: 'solid', branch: 'feat/orders', commit: tip(), reason: 'ancestor', ts: committerDate(tip()) });
    expect(readKnowledgeStatus(flowDir).get(draft.item)?.status).toBe('solid');
  });

  it('a SQUASH merge promotes by the files’ hashes, though the commit is never an ancestor', () => {
    const draft = featureDraft();
    sh('merge', '-q', '--squash', 'feat/orders');
    sh('commit', '-q', '-m', 'Orders (#42)');
    sh('push', '-q', 'origin', 'main');
    // The host deletes the branch after a squash; matching files still promote, never abandon.
    sh('push', '-q', 'origin', '--delete', 'feat/orders');
    sh('branch', '-q', '-D', 'feat/orders');

    expect(spawnSync('git', ['merge-base', '--is-ancestor', draft.commit as string, 'origin/main'], { cwd: code }).status).toBe(1);
    expect(check([draft])).toEqual([expect.objectContaining({ outcome: 'solid', reason: 'hashes-match', written: true })]);
  });

  it('a REBASE merge promotes by the files’ hashes', () => {
    const draft = featureDraft();
    write('other.ts', 'export const other = 2\n');
    commitAll('chore: main moves on');
    sh('checkout', '-q', '-b', 'rebased', 'feat/orders');
    sh('rebase', '-q', 'main');
    sh('checkout', '-q', 'main');
    sh('merge', '-q', '--ff-only', 'rebased');
    sh('push', '-q', 'origin', 'main');
    sh('push', '-q', 'origin', '--delete', 'feat/orders');
    sh('branch', '-q', '-D', 'feat/orders', 'rebased');

    expect(check([draft])).toEqual([expect.objectContaining({ outcome: 'solid', reason: 'hashes-match' })]);
  });

  it('merged, then changed on the default branch: solid AND stale (FR-5) — by ancestry or by the host', () => {
    const merged = featureDraft('feat/merged', 'export const retries = 2\n');
    const squashed = featureDraft('feat/squashed', 'export const retries = 3\n');
    sh('merge', '-q', '--no-ff', '-m', 'Merge feat/merged', 'feat/merged');
    // The squash conflicts with the merge on orders.ts (exit 1); resolve to the squashed text.
    spawnSync('git', ['merge', '-q', '--squash', 'feat/squashed'], { cwd: code });
    write('orders.ts', 'export const retries = 3\n');
    commitAll('Squashed (#43)');
    write('orders.ts', 'export const retries = 4\n');
    commitAll('fix: four retries');
    sh('push', '-q', 'origin', 'main');

    const host = hostSaying({ state: 'merged', at: '2026-11-16T10:00:00Z' });
    const results = check([merged, squashed], host);
    expect(results.map((result) => [result.outcome, result.reason])).toEqual([
      ['stale', 'ancestor'],
      ['stale', 'pr-merged'],
    ]);
    // The host is asked only where git could not answer.
    expect(host.asked).toEqual(['feat/squashed']);
    const folded = readKnowledgeStatus(flowDir);
    expect(folded.get(merged.item)).toMatchObject({ status: 'solid', stale: true });
    expect(folded.get(squashed.item)).toMatchObject({ status: 'solid', stale: true });
  });

  it('closed unmerged, or deleted with nothing left: abandoned — an open or unpushed branch is not', () => {
    const open = featureDraft('feat/open');
    const unpushed = featureDraft('feat/unpushed', 'export const retries = 5\n', false);
    const closed = featureDraft('feat/closed', 'export const retries = 6\n');
    const gone = featureDraft('feat/gone', 'export const retries = 7\n');
    sh('push', '-q', 'origin', '--delete', 'feat/gone');
    sh('branch', '-q', '-D', 'feat/gone');

    const host: HostPrState = {
      prState: (branch) =>
        branch === 'feat/closed'
          ? { state: 'closed', at: '2026-11-15T01:32:42Z' }
          : branch === 'feat/open'
            ? { state: 'open', at: null }
            : { state: 'none', at: null },
    };
    const results = check([open, unpushed, closed, gone], host);
    // POSITIVE FIRST (#28): the two abandoned ARE written…
    expect(results[2]).toMatchObject({ outcome: 'abandoned', reason: 'pr-closed', written: true });
    expect(results[3]).toMatchObject({ outcome: 'abandoned', reason: 'branch-gone', written: true });
    // …so the two unknowns below are the rule, not a checker that writes nothing.
    expect(results[0]).toMatchObject({ outcome: 'unknown', written: false });
    expect(results[1]).toMatchObject({ outcome: 'unknown', written: false });
    expect(logLines()).toHaveLength(2);

    // Without any host, a deleted branch still abandons; an unpushed one still does not.
    rmSync(join(flowDir, 'brain'), { recursive: true, force: true });
    expect(check([unpushed, gone]).map((result) => result.outcome)).toEqual(['unknown', 'abandoned']);
  });

  it('offline: a failed fetch writes NOTHING, though the same drafts promote once it works', () => {
    const draft = featureDraft();
    sh('merge', '-q', '--no-ff', '-m', 'Merge', 'feat/orders');
    sh('push', '-q', 'origin', 'main');
    sh('remote', 'set-url', 'origin', join(sandbox, 'gone.git'));

    expect(check([draft])).toEqual([expect.objectContaining({ outcome: 'unknown', reason: 'fetch-failed', written: false })]);
    expect(existsSync(join(flowDir, 'brain'))).toBe(false);

    // The positive control: the same draft, the remote back.
    sh('remote', 'set-url', 'origin', bare);
    expect(check([draft])).toEqual([expect.objectContaining({ outcome: 'solid', written: true })]);
  });

  it('never judges by hashes an item that has none, nor a file missing on the default branch', () => {
    const draft = featureDraft();
    const noHashes: DraftItem = { ...draft, item: 'a'.repeat(16), hashes: [] };
    const missing: DraftItem = { ...draft, item: 'b'.repeat(16), hashes: [{ path: 'nowhere.ts', contentHash: hashFileContent('') }] };
    expect(check([noHashes, missing]).map((result) => result.outcome)).toEqual(['unknown', 'unknown']);
    expect(logLines()).toEqual([]);
  });

  it('identical promotions on two machines write ONE line', () => {
    const draft = featureDraft();
    sh('merge', '-q', '--no-ff', '-m', 'Merge', 'feat/orders');
    sh('push', '-q', 'origin', 'main');
    check([draft]);
    check([draft]);
    expect(logLines()).toHaveLength(1);
  });
});

describe('the code host', () => {
  it('reads gh’s live `pr list --json state,mergedAt,closedAt` shape', () => {
    // Shapes captured from gh 2.x against a real repository.
    expect(parseGhPrList('[{"closedAt":"2026-10-14T19:58:40Z","headRefName":"x","mergedAt":"2026-10-14T19:58:40Z","state":"MERGED"}]')).toEqual({
      state: 'merged',
      at: '2026-10-14T19:58:40Z',
    });
    expect(parseGhPrList('[{"closedAt":"2026-11-15T01:32:42Z","mergedAt":null,"state":"CLOSED"}]')).toEqual({
      state: 'closed',
      at: '2026-11-15T01:32:42Z',
    });
    expect(parseGhPrList('[{"closedAt":null,"mergedAt":null,"state":"OPEN"},{"closedAt":"2026-11-15T01:32:42Z","mergedAt":null,"state":"CLOSED"}]')).toEqual({
      state: 'open',
      at: null,
    });
    expect(parseGhPrList('[]')).toEqual({ state: 'none', at: null });
    expect(parseGhPrList('not json')).toBeNull();
    expect(parseGhPrList('{"state":"MERGED"}')).toBeNull();
  });

  it('asks gh only for a GitHub remote, and treats a failed call as no answer', () => {
    const remoteOf = (url: string): WorkspaceGit => (args) => {
      if (args[0] === 'config') return `${url}\n`;
      throw new Error('unexpected');
    };
    const calls: string[][] = [];
    const runner = (command: string, args: string[]): string | null => {
      calls.push([command, ...args]);
      return args.includes('feat/fails') ? null : '[]';
    };
    expect(hostForCheckout(remoteOf('https://dev.azure.com/acme/P/_git/r'), '/x', runner)).toBeNull();
    const host = hostForCheckout(remoteOf('git@github.com:acme/backend.git'), '/x', runner);
    expect(host?.prState('feat/ok')).toEqual({ state: 'none', at: null });
    expect(host?.prState('feat/fails')).toBeNull();
    expect(calls[0]).toEqual(['gh', 'pr', 'list', '--head', 'feat/ok', '--state', 'all', '--json', 'state,mergedAt,closedAt', '--limit', '30']);
  });

  it('gives a document an id by its file name and commit, so archiving keeps it', () => {
    const commit = 'c'.repeat(40);
    expect(documentItemId('plan_x_v1.md', commit)).toMatch(/^[0-9a-f]{16}$/);
    expect(documentItemId('plan_x_v1.md', commit)).toBe(documentItemId('plan_x_v1.md', commit));
    expect(documentItemId('plan_x_v1.md', commit)).not.toBe(documentItemId('plan_x_v2.md', commit));
  });
});

describe('projectCheckout', () => {
  const projects = [
    { slug: 'orders-api', id: 'host/org/orders-api' },
    { slug: 'orders', id: 'host/org/orders' },
  ];
  const local = { 'host/org/orders-api': '/Users/x/Projects/orders-api' };

  it('joins the Workspace’s slug to this computer’s path through the project id', () => {
    expect(projectCheckout(local, projects, 'orders-api')).toBe('/Users/x/Projects/orders-api');
  });

  it('is null for a project this computer does not have, or does not know', () => {
    expect(projectCheckout(local, projects, 'orders')).toBe(null);
    expect(projectCheckout(local, projects, 'nothing-like-it')).toBe(null);
    expect(projectCheckout({ 'host/org/orders-api': '' }, projects, 'orders-api')).toBe(null);
  });
});
