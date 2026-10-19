/**
 * Real-git integration for the ledger's shared-root resolution
 * (#loop-ledger-shared-root).
 *
 * The unit tests feed `mainRootFromGitdirFile` the `.git` shapes by hand; this
 * one proves those shapes are what a REAL `git worktree add` actually writes, so
 * a `loop file` from a real linked worktree resolves its store back to the main
 * checkout. It is the only test in this suite that shells out, and the reason
 * the resolver reads `.git` from disk (never a subprocess) is exactly so the
 * production path needs no such shelling — this only VERIFIES the on-disk shape.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { canonicalStoreRoot, clearStoreRootCache } = await import('./store-root.js');

/** Canonicalized for comparison — collapses Windows casing and 8.3 short names. */
const real = (path: string): string => realpathSync.native(path);

describe('the ledger store root, resolved against a real git worktree', () => {
  let root = '';
  let mainDir = '';
  let worktreeDir = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pf-ledger-'));
    mainDir = join(root, 'main');
    worktreeDir = join(root, 'linked');

    execFileSync('git', ['init', '-b', 'main', mainDir], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainDir, stdio: 'ignore' });
    writeFileSync(join(mainDir, 'README.md'), '# temp\n');
    execFileSync('git', ['add', '-A'], { cwd: mainDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: mainDir, stdio: 'ignore' });
    // A linked worktree — exactly what a thread/loop checkout is.
    execFileSync('git', ['worktree', 'add', '--detach', worktreeDir], { cwd: mainDir, stdio: 'ignore' });
    clearStoreRootCache();
  });

  afterAll(() => {
    if (root.length > 0) rmSync(root, { recursive: true, force: true });
  });

  it('resolves a real linked worktree back to the MAIN checkout', () => {
    // The whole fix: a run whose cwd is the linked worktree must write its
    // ledger under the main checkout, the one the board reads.
    expect(real(canonicalStoreRoot(worktreeDir))).toBe(real(mainDir));
  });

  it('resolves the main checkout to itself (single-worktree behaviour is unchanged)', () => {
    expect(real(canonicalStoreRoot(mainDir))).toBe(real(mainDir));
  });
});
