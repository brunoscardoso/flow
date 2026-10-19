/**
 * The staleness notice (#1651): the running build says when it is behind the
 * source it lives beside — and stays silent everywhere silence is the honest
 * answer (npm installs, unstamped builds, unreachable git).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { cliStalenessWarning, detectCliStaleness, readBuildStamp } = await import('./cli-staleness.js');

const dirs: string[] = [];
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-stale-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function stampAt(root: string, stamp: unknown): void {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'build-info.json'), JSON.stringify(stamp), 'utf-8');
}

describe('the warning line — policy, pinned pure', () => {
  const stamp = { commit: 'abcdef1234567890', dirty: false, builtAt: '2026-08-17T00:00:00.000Z' };

  it('names the distance, the commit and the way out', () => {
    const line = cliStalenessWarning(stamp, 5);
    expect(line).toContain('5 commits behind origin/main');
    expect(line).toContain('abcdef12');
    expect(line).toContain('npm run build');
    expect(line).toContain('#1651');
  });

  it('is silent when current, when unstamped, and when the distance is unknowable', () => {
    expect(cliStalenessWarning(stamp, 0)).toBeNull();
    expect(cliStalenessWarning(stamp, null)).toBeNull();
    expect(cliStalenessWarning(null, 5)).toBeNull();
    expect(cliStalenessWarning({ ...stamp, commit: null }, 5)).toBeNull();
  });

  it('a current build cut from a DIRTY tree still says so', () => {
    const line = cliStalenessWarning({ ...stamp, dirty: true }, 0);
    expect(line).toContain('DIRTY tree');
  });
});

/**
 * #1796 — the remedy has to be one that would actually clear the notice.
 *
 * `behind` is measured from the STAMP, so it says the running build is old and
 * nothing about whether a rebuild could fix that. `npm run build` compiles the
 * WORKING TREE and stamps the commit the working tree is on, so it clears the
 * notice only when the working tree already contains origin/main. On a checkout
 * that does not, rebuilding produces a stamp behind by exactly the same count
 * and the notice returns unchanged on the very next command — reproduced live
 * here at 4 behind with local main 21 ahead, where the advised command left the
 * count at 4.
 *
 * That state is NORMAL in this project: the working agreement is to commit
 * locally and push on request, so "ahead of origin/main" is the resting state
 * and anything landing on GitHub makes it diverged rather than merely behind.
 */
describe('the remedy names a step that would actually work (#1796)', () => {
  const stamp = { commit: 'abcdef1234567890', dirty: false, builtAt: '2026-08-17T00:00:00.000Z' };

  it('keeps today\'s wording when the checkout already has the commits', () => {
    // Pulled but not rebuilt: the compile step really is the whole remedy.
    const line = cliStalenessWarning(stamp, 5, false, { ahead: 0, behind: 0 });
    expect(line).toContain('run `npm run build` in the checkout to pick up landed fixes');
    expect(line).not.toContain('diverged');
  });

  it('says pull FIRST when the checkout is behind too', () => {
    const line = cliStalenessWarning(stamp, 5, false, { ahead: 0, behind: 5 });
    expect(line).toContain('a rebuild alone changes nothing');
    expect(line).toContain('pull, then run `npm run build`');
  });

  it('names the divergence, and does not prescribe the pull that would fail', () => {
    // `pull --ff-only` is exactly what a diverged checkout refuses, and picking
    // rebase or merge for the reader is a guess about their repository.
    const line = cliStalenessWarning(stamp, 4, true, { ahead: 21, behind: 4 });
    expect(line).toContain('diverged (21 ahead, 4 behind)');
    expect(line).toContain('no rebuild can pick them up');
    expect(line).toContain('reconcile with origin/main first');
  });

  it('never advises a BARE rebuild for a checkout that lacks the commits', () => {
    // The regression itself: one instruction, offered for every state, that
    // provably leaves the reported count where it was in two of them.
    for (const checkout of [
      { ahead: 0, behind: 5 },
      { ahead: 21, behind: 4 },
    ]) {
      const line = cliStalenessWarning(stamp, 5, false, checkout) ?? '';
      expect({ checkout, misleading: line.includes('to pick up landed fixes') }).toEqual({
        checkout,
        misleading: false,
      });
    }
  });

  it('falls back to today\'s wording when git could not say where the checkout stands', () => {
    // Every path in this module fails soft; the shipped wording is the honest
    // thing to say when the second fact is missing.
    expect(cliStalenessWarning(stamp, 5, false, null)).toContain('npm run build');
    expect(cliStalenessWarning(stamp, 5)).toContain('npm run build');
  });
});

describe('the I/O edge — every failure is silence, never a crash', () => {
  it('warns through a real stamp when git says commits landed since', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.git'));
    stampAt(root, { commit: 'abcdef1234567890', dirty: false, builtAt: 'x' });

    const warning = detectCliStaleness(root, () => '3\n');
    expect(warning).toContain('3 commits behind origin/main');
  });

  it('asks git where the CHECKOUT stands, and threads the answer into the remedy (#1796)', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.git'));
    stampAt(root, { commit: 'abcdef1234567890', dirty: false, builtAt: 'x' });

    // A fake keyed by argv that THROWS on anything it was not asked about, so
    // the test pins the questions the code asked, not just the answers it got.
    const asked: string[][] = [];
    const warning = detectCliStaleness(root, (_file, args) => {
      asked.push([...args]);
      if (args.includes('--left-right')) return '21\t4\n';
      if (args.join(' ').includes('..origin/main')) return '4\n';
      throw new Error(`unexpected: git ${args.join(' ')}`);
    });

    expect(warning).toContain('diverged (21 ahead, 4 behind)');
    expect(asked).toContainEqual([
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...origin/main',
    ]);
  });

  it('a checkout git cannot place still warns, in the shipped wording (#1796)', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.git'));
    stampAt(root, { commit: 'abcdef1234567890', dirty: false, builtAt: 'x' });

    const warning = detectCliStaleness(root, (_file, args) => {
      if (args.includes('--left-right')) throw new Error('fatal: bad revision');
      return '3\n';
    });

    expect(warning).toContain('3 commits behind origin/main');
    expect(warning).toContain('npm run build');
  });

  it('an npm install (no .git at the package root) is silent', () => {
    const root = makeRoot();
    stampAt(root, { commit: 'abcdef1234567890', dirty: false, builtAt: 'x' });
    expect(
      detectCliStaleness(root, () => {
        throw new Error('never asked');
      }),
    ).toBeNull();
  });

  it('a pre-#1651 build (no stamp) and a git-less build (commit null) are silent', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.git'));
    expect(detectCliStaleness(root, () => '3\n')).toBeNull();
    stampAt(root, { commit: null, dirty: false, builtAt: 'x' });
    expect(detectCliStaleness(root, () => '3\n')).toBeNull();
  });

  it('git failing (unknown commit, no origin/main) is silence, not a guess', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.git'));
    stampAt(root, { commit: 'abcdef1234567890', dirty: false, builtAt: 'x' });
    expect(
      detectCliStaleness(root, () => {
        throw new Error('fatal: bad revision');
      }),
    ).toBeNull();
  });

  it('a malformed stamp reads as no stamp', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'build-info.json'), 'not json', 'utf-8');
    expect(readBuildStamp(root)).toBeNull();
    expect(detectCliStaleness(root, () => '3\n')).toBeNull();
  });
});
