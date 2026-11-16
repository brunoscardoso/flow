/**
 * The merge rules that need no person (discovery `workspace_knowledge_draft_solid`,
 * FR-11, FR-12) — `inspectMerge` against a REAL git merge in progress, then
 * `applyResolutions` and `writeMergeLog`, the way `workspace sync` runs them.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { applyResolutions, inspectMerge, readMergeFacts, writeMergeLog } from './workspace-merge.js';
import { provenanceId, provenanceLine, type KnowledgeProvenance } from '../state/knowledge-provenance.js';
import { knowledgeItemId, knowledgeStatusLine, readKnowledgeStatus, type KnowledgeStatusEntry } from '../state/knowledge-status-log.js';
import type { WorkspaceGit } from './workspace-model.js';

const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_OK ? describe : describe.skip;

const git: WorkspaceGit = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

const FEATURE = 'projects/backend/brain/features/orders.md';
const STATUS = 'projects/backend/brain/.structure/knowledge-status.jsonl';
const PROVENANCE = 'projects/backend/brain/.structure/knowledge-provenance.jsonl';
const TEXT = 'Orders retry twice.';

const recA: KnowledgeProvenance = { branch: 'feat/a', commit: '1'.repeat(40), onDefault: false, hashes: [] };
const recB: KnowledgeProvenance = { branch: 'feat/b', commit: '2'.repeat(40), onDefault: false, hashes: [] };
const A = provenanceId(recA);
const B = provenanceId(recB);
const itemOf = (learnedAt: string): string => knowledgeItemId({ kind: 'learning', scope: 'orders', text: TEXT, learnedAt });

const line = (learnedAt: string | null, text = TEXT, date = '2026-11-16'): string =>
  `- ${text} ${learnedAt === null ? '' : `<!-- learnedAt: ${learnedAt} --> `}<!-- learned: code ${date} -->`;

function feature(prose: string, learned: string[]): string {
  return [
    '---',
    'id: feature:backend::orders',
    'name: Orders',
    'kind: core',
    'anchors: [file:src/orders.ts]',
    'relates: []',
    '---',
    '# Orders',
    '',
    prose,
    '',
    '## Learned',
    '',
    ...learned,
    '',
  ].join('\n');
}

const solidLine = (item: string, commit: string, ts: string): string =>
  knowledgeStatusLine({ item, status: 'solid', branch: null, commit, reason: 'ancestor', ts } satisfies KnowledgeStatusEntry);

describeWithGit('inspectMerge — the draft/solid rules against a real merge', () => {
  let repo: string;

  function write(files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  }
  function commit(message: string): string {
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', message], repo);
    return git(['rev-parse', 'HEAD'], repo).trim();
  }

  /** base on main → theirs on a branch → ours on main → `git merge --no-ff --no-commit theirs`. */
  function mergeOf(base: Record<string, string>, ours: Record<string, string>, theirs: Record<string, string>) {
    write(base);
    commit('base');
    git(['checkout', '-q', '-b', 'theirs'], repo);
    write(theirs);
    const theirsSha = commit('theirs');
    git(['checkout', '-q', 'main'], repo);
    write(ours);
    const oursSha = commit('ours');
    spawnSync('git', ['-c', 'merge.conflictStyle=merge', 'merge', '--no-ff', '--no-commit', '-q', 'theirs'], { cwd: repo });
    const facts = readMergeFacts(git, repo, oursSha, theirsSha);
    return { facts, inspection: inspectMerge(facts) };
  }

  const stores = (statusLines: string[]): Record<string, string> => ({
    [PROVENANCE]: `${provenanceLine(recA)}\n${provenanceLine(recB)}\n`,
    [STATUS]: statusLines.length === 0 ? '' : `${statusLines.join('\n')}\n`,
  });

  /** The learning sentence both sides re-learned at a different commit, over a line both removed. */
  const conflicting = (statusLines: string[]) =>
    mergeOf(
      { [FEATURE]: feature('Human prose.', [line(null, 'Orders retry once.', '2026-11-01')]), ...stores(statusLines) },
      { [FEATURE]: feature('Human prose.', [line(A)]) },
      { [FEATURE]: feature('Human prose.', [line(B)]) }
    );

  const read = (path: string): string => readFileSync(join(repo, path), 'utf-8');

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pf-merge-rules-')));
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.name', 'Test Person'], repo);
    git(['config', 'user.email', 'test@example.com'], repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('draft vs draft: both kept, written, recorded — no ask', () => {
    const { facts, inspection } = conflicting([]);
    expect(facts.conflicted.has(FEATURE)).toBe(true); // git could not merge it
    expect(inspection.asks).toEqual([]);
    expect(inspection.resolutions).toContainEqual(expect.objectContaining({ kind: 'feature-rules', path: FEATURE, rule: 'union', dropped: 0, stale: [] }));

    const done = applyResolutions(facts, inspection.resolutions);
    expect(done).toContainEqual({ kind: 'feature-rules', path: FEATURE, rule: 'union', dropped: 0, stale: 0 });
    const text = read(FEATURE);
    expect(text).toContain(`learnedAt: ${A}`);
    expect(text).toContain(`learnedAt: ${B}`);
    expect(text).not.toContain('retry once');
    expect(text).not.toContain('<<<<<<<');
    expect(text.startsWith(feature('Human prose.', []).split('## Learned')[0])).toBe(true);
    expect(git(['ls-files', '--unmerged'], repo).trim()).toBe('');

    const log = writeMergeLog(facts, done, { now: new Date('2026-11-16T12:00:00Z'), remoteRef: 'origin/main' });
    expect(log).not.toBeNull();
    expect(read(log as string)).toContain('every learning of both kept');
  });

  it('draft vs solid: both kept', () => {
    const { facts, inspection } = conflicting([solidLine(itemOf(A), 'd'.repeat(40), '2026-11-10T00:00:00.000Z')]);
    expect(inspection.asks).toEqual([]);
    applyResolutions(facts, inspection.resolutions);
    expect(read(FEATURE)).toContain(`learnedAt: ${A}`);
    expect(read(FEATURE)).toContain(`learnedAt: ${B}`);
  });

  it('solid vs solid: the one proved by the newer default-branch commit wins', () => {
    const { facts, inspection } = conflicting([
      solidLine(itemOf(A), 'd'.repeat(40), '2026-11-10T00:00:00.000Z'),
      solidLine(itemOf(B), 'e'.repeat(40), '2026-11-12T00:00:00.000Z'),
    ]);
    expect(inspection.asks).toEqual([]);
    const done = applyResolutions(facts, inspection.resolutions);
    // POSITIVE FIRST: the newer is there…
    expect(read(FEATURE)).toContain(`learnedAt: ${B}`);
    // …and the older is gone.
    expect(read(FEATURE)).not.toContain(`learnedAt: ${A}`);
    expect(done).toContainEqual({ kind: 'feature-rules', path: FEATURE, rule: 'newer-wins', dropped: 1, stale: 0 });
    const log = writeMergeLog(facts, done, { now: new Date('2026-11-16T12:00:00Z'), remoteRef: 'origin/main' });
    expect(read(log as string)).toContain('the one learned from the newer commit was kept');
  });

  it('solid vs solid on the SAME commit: both kept, both marked stale through the one writer', () => {
    const shared = 'd'.repeat(40);
    const { facts, inspection } = conflicting([
      solidLine(itemOf(A), shared, '2026-11-10T00:00:00.000Z'),
      solidLine(itemOf(B), shared, '2026-11-10T00:00:00.000Z'),
    ]);
    expect(inspection.asks).toEqual([]);
    const done = applyResolutions(facts, inspection.resolutions);
    expect(done).toContainEqual({ kind: 'feature-rules', path: FEATURE, rule: 'kept-both-stale', dropped: 0, stale: 2 });
    expect(read(FEATURE)).toContain(`learnedAt: ${A}`);
    expect(read(FEATURE)).toContain(`learnedAt: ${B}`);
    const folded = readKnowledgeStatus(join(repo, 'projects', 'backend'));
    expect(folded.get(itemOf(A))).toMatchObject({ status: 'solid', stale: true });
    expect(folded.get(itemOf(B))).toMatchObject({ status: 'solid', stale: true });
    expect(folded.get(itemOf(A))?.entry.reason).toBe('merge-same-commit');
    // Staged with the merge, so the stale lines travel with it.
    expect(git(['diff', '--cached', '--name-only'], repo)).toContain(STATUS);
  });

  it('prose changed in the same place on both sides: still an ask, not agent-mergeable', () => {
    const { inspection } = mergeOf(
      { [FEATURE]: feature('Human prose.', [line(null)]), ...stores([]) },
      { [FEATURE]: feature('Prose by ours.', [line(null)]) },
      { [FEATURE]: feature('Prose by theirs.', [line(null)]) }
    );
    expect(inspection.resolutions.filter((resolution) => resolution.kind === 'feature-rules')).toEqual([]);
    expect(inspection.asks).toEqual([expect.objectContaining({ kind: 'same-feature', path: FEATURE, topic: 'backend/orders' })]);
    expect(inspection.asks[0].agentMergeable).toBeUndefined();
  });

  it('a decision changed on both sides stays an ask, flagged agent-mergeable with its base; a conflicting plan review too', () => {
    const decision = 'projects/backend/brain/decisions/queue.md';
    const plan = 'projects/backend/plans/plan_queue_v1.md';
    const { inspection } = mergeOf(
      { [decision]: '# Queue\n\nSQS.\n', [plan]: '# Plan\n\nOne.\n' },
      { [decision]: '# Queue\n\nKafka.\n', [plan]: '# Plan\n\nOurs.\n' },
      { [decision]: '# Queue\n\nSQS, FIFO.\n', [plan]: '# Plan\n\nTheirs.\n' }
    );
    expect(inspection.asks).toEqual([
      expect.objectContaining({
        kind: 'decision',
        path: decision,
        agentMergeable: true,
        base: '# Queue\n\nSQS.\n',
        existing: '# Queue\n\nSQS, FIFO.\n',
        incoming: '# Queue\n\nKafka.\n',
      }),
    ]);
    expect(inspection.reviews).toEqual([expect.objectContaining({ kind: 'conflict', path: plan, agentMergeable: true, base: '# Plan\n\nOne.\n' })]);
  });

  it('a clean merge of a feature edited on both sides is accepted with no rewrite', () => {
    const { facts, inspection } = mergeOf(
      { [FEATURE]: feature('Top.\n\nmiddle\n\nBottom.', [line(null)]) },
      { [FEATURE]: feature('Top, ours.\n\nmiddle\n\nBottom.', [line(null)]) },
      { [FEATURE]: feature('Top.\n\nmiddle\n\nBottom, theirs.', [line(null)]) }
    );
    expect(inspection.asks).toEqual([]);
    expect(inspection.resolutions).toEqual([{ kind: 'feature-rules', path: FEATURE, content: null, rule: 'clean', dropped: 0, stale: [] }]);
    applyResolutions(facts, inspection.resolutions);
    expect(read(FEATURE)).toBe(feature('Top, ours.\n\nmiddle\n\nBottom, theirs.', [line(null)]));
    expect(existsSync(join(repo, STATUS))).toBe(false);
  });
});
