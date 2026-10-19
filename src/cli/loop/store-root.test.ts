/**
 * Tests for the ledger's shared-root resolver (#loop-ledger-shared-root).
 *
 * The `.git`-file PARSING is pure and covered here against the shapes git can
 * write; the on-disk stat/read behaviour is exercised against a real repo in
 * `canonical-store-root.realgit.test.ts`.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { canonicalStoreRoot, clearStoreRootCache, mainRootFromGitdirFile } = await import('./store-root.js');

describe('mainRootFromGitdirFile — a linked worktree names its main checkout', () => {
  it('reads the main root from a real `git worktree add` gitdir line', () => {
    const content = 'gitdir: /Users/dev/Projects/plan-flow/.git/worktrees/71bcaa64\n';
    expect(mainRootFromGitdirFile(content, '/anywhere')).toBe(resolve('/Users/dev/Projects/plan-flow'));
  });

  it('handles the backslash paths git writes on Windows', () => {
    const content = 'gitdir: C:\\Users\\dev\\Projects\\plan-flow\\.git\\worktrees\\wt\n';
    // Separator-agnostic: the segment before `/.git/worktrees/` is the root.
    expect(mainRootFromGitdirFile(content, 'C:\\anywhere')).toBe(resolve('C:/Users/dev/Projects/plan-flow'));
  });

  it('resolves a relative gitdir against the worktree, not the cwd', () => {
    const content = 'gitdir: ../../main/.git/worktrees/wt\n';
    expect(mainRootFromGitdirFile(content, '/a/b/linked')).toBe(resolve('/a/b/linked/../../main'));
  });

  it('returns null for a `.git` file that is not a worktree link (separate git dir)', () => {
    expect(mainRootFromGitdirFile('gitdir: /somewhere/else/.git\n', '/x')).toBeNull();
  });

  it('returns null for content with no gitdir line at all', () => {
    expect(mainRootFromGitdirFile('not a git pointer', '/x')).toBeNull();
  });
});

describe('canonicalStoreRoot — resolving a checkout to its shared root on disk', () => {
  const made: string[] = [];
  beforeEach(() => clearStoreRootCache());
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  /** A throwaway root with `.git` shaped as asked. */
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'store-root-'));
    made.push(dir);
    return dir;
  }

  it('a directory `.git` is a main worktree — it IS the root', () => {
    const dir = scratch();
    mkdirSync(join(dir, '.git'));
    expect(canonicalStoreRoot(dir)).toBe(dir);
  });

  it('a file `.git` (linked worktree) resolves to the named main checkout', () => {
    const dir = scratch();
    const main = scratch();
    writeFileSync(join(dir, '.git'), `gitdir: ${main.replace(/\\/g, '/')}/.git/worktrees/wt\n`);
    expect(canonicalStoreRoot(dir)).toBe(resolve(main));
  });

  it('fails soft to the given target when there is no `.git` at all', () => {
    const dir = scratch();
    expect(canonicalStoreRoot(dir)).toBe(dir);
  });

  it('never shells out — a target with no git on PATH still resolves', () => {
    // The resolver reads the filesystem only; this simply documents that a plain
    // directory (no repo, no git) returns itself rather than throwing.
    const dir = scratch();
    expect(canonicalStoreRoot(dir)).toBe(dir);
  });
});
