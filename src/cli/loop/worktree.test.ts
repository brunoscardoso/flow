/**
 * Tests for the per-loop worktree.
 *
 * GIT IS A FAKE EXEC — every test records the argv it was handed and answers
 * with canned `git worktree list --porcelain` text. Nothing here runs a real
 * git, creates a real worktree, or touches this repository (allowed-pattern
 * #12: mock the module boundary, never PATH).
 */

import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

const {
  DEFAULT_LINKED_ENTRIES,
  changedManifests,
  linkUntrackedSet,
  loopWorktreePath,
  nodeWorktreeFs,
  nameWorktreeBranch,
  parseWorktreeList,
  promoteDependencies,
  pruneThreadWorktree,
  pruneWorktree,
  resolveThreadWorktree,
  resolveWorktree,
  threadWorktreePath,
  threadWorktreeRoot,
  worktreeContainer,
} = await import('./worktree.js');
type WorktreeFs = import('./worktree.js').WorktreeFs;
const { loopBranch } = await import('./push-guard.js');

// PLATFORM-NATIVE, because the code under test builds paths with `path.join`.
// A '/'-joined expectation only matches on POSIX: on Windows the subject
// returns '\\Users\\dev\\…' and every assertion here failed on the separator
// alone (33 of them), hiding whether the LOGIC was right. `join` on a single
// argument normalises it, and `at()` builds every expectation the same way the
// subject does.
const REPO = join('/Users/dev/Projects/plan-flow');
const CONTAINER = join('/Users/dev/Projects/.plan-flow-loops');
/** An expected path, joined as the subject joins it. */
const at = (...parts: string[]): string => join(...parts);

/** A recording fake git. Answers `worktree list` with the given porcelain,
 *  and everything else via the optional `answer` (default: empty stdout). */
function fakeGit(
  porcelain = '',
  answer: (args: readonly string[]) => string | undefined = () => undefined,
): {
  exec: (file: string, args: readonly string[], cwd: string) => string;
  calls: { file: string; args: string[]; cwd: string }[];
} {
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  return {
    calls,
    exec: (file, args, cwd) => {
      calls.push({ file, args: [...args], cwd });
      if (args[0] === 'worktree' && args[1] === 'list') return porcelain;
      return answer(args) ?? '';
    },
  };
}

/**
 * Canned answers for the refresh steps (#1584): a clean tree on `head`, with
 * `origin/main` at `base` and HEAD at `at` — equal means already current.
 */
function refreshAnswers(
  head: string,
  base = 'abc123',
  at = 'abc123',
  opts: { dirty?: string; mergeFails?: boolean; fetchFails?: boolean } = {},
): (args: readonly string[]) => string | undefined {
  return (args) => {
    if (args[0] === 'status') return opts.dirty ?? '';
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return head;
    if (args[0] === 'fetch') {
      if (opts.fetchFails) throw new Error('fatal: could not resolve host: github.com');
      return '';
    }
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') return base;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return at;
    if (args[0] === 'merge') {
      if (opts.mergeFails) throw new Error('fatal: Not possible to fast-forward, aborting.');
      return '';
    }
    return undefined;
  };
}

/** Porcelain for a main checkout plus any extra worktrees. */
function porcelain(extra: { path: string; branch: string }[] = []): string {
  const blocks = [`worktree ${REPO}\nHEAD abc123\nbranch refs/heads/main\n`];
  for (const entry of extra) {
    blocks.push(`worktree ${entry.path}\nHEAD def456\nbranch refs/heads/${entry.branch}\n`);
  }
  return blocks.join('\n');
}

describe('Task 5.5 — parsing what git reports', () => {
  it('reads every worktree, its branch and its flags', () => {
    const entries = parseWorktreeList(
      [
        `worktree ${REPO}`,
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        `worktree ${at(CONTAINER, 'fix')}`,
        'HEAD def456',
        'branch refs/heads/loop/fix',
        'locked',
        '',
        `worktree ${at(CONTAINER, 'gone')}`,
        'HEAD 000000',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ path: REPO, branch: 'main', bare: false });
    expect(entries[1]).toMatchObject({ path: at(CONTAINER, 'fix'), branch: 'loop/fix', locked: true });
    expect(entries[2]).toMatchObject({ detached: true, prunable: true });
    expect(entries[2].branch).toBeUndefined();
  });

  it('parses a final entry with no trailing blank line', () => {
    const entries = parseWorktreeList(`worktree ${REPO}\nHEAD abc\nbranch refs/heads/main`);
    expect(entries).toHaveLength(1);
    expect(entries[0].branch).toBe('main');
  });

  it('ignores keys it does not know rather than refusing the listing', () => {
    const entries = parseWorktreeList(
      `worktree ${REPO}\nHEAD abc\nbranch refs/heads/main\nsomething-new whatever\n`,
    );
    expect(entries).toHaveLength(1);
  });

  it('an empty listing is no worktrees, not an error', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('Task 5.5 — where a loop lives', () => {
  it('puts every loop under one hidden sibling of the repo', () => {
    expect(loopWorktreePath(REPO, 'fix')).toBe(at(CONTAINER, 'fix'));
    expect(loopWorktreePath(REPO, 'find-bugs')).toBe(at(CONTAINER, 'find-bugs'));
  });

  it('the path is never inside the repo — a worktree must not pollute git status', () => {
    expect(loopWorktreePath(REPO, 'fix').startsWith(REPO + sep)).toBe(false);
  });

  it('refuses a name that is not a loop name, so no path can escape the container', () => {
    expect(() => loopWorktreePath(REPO, '../../etc')).toThrow('is not a loop name');
    expect(() => loopWorktreePath(REPO, 'Fix')).toThrow('is not a loop name');
    expect(() => loopWorktreePath(REPO, '')).toThrow('is not a loop name');
  });
});

describe('Task 5.5 — resolve, creating on first use', () => {
  it('creates the worktree on its own branch when it does not exist yet', () => {
    const git = fakeGit(porcelain(), refreshAnswers('loop/fix'));
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });

    expect(resolved).toEqual({
      status: 'created',
      loop: 'fix',
      slot: 1,
      path: at(CONTAINER, 'fix'),
      branch: 'loop/fix',
      created: true,
      refresh: { state: 'current', detail: '' },
    });
    expect(git.calls[1]).toEqual({
      file: 'git',
      args: ['worktree', 'add', '-B', 'loop/fix', at(CONTAINER, 'fix')],
      cwd: REPO,
    });
  });

  it('is born on a branch inside the push carve-out', () => {
    const git = fakeGit(porcelain());
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'improve' });
    expect(resolved.branch).toBe(loopBranch('improve'));
    expect(resolved.branch.startsWith('loop/')).toBe(true);
  });

  it('reuses an existing worktree across beats, fast-forwarding it to origin/main (#1584)', () => {
    const git = fakeGit(
      porcelain([{ path: at(CONTAINER, 'fix'), branch: 'loop/fix' }]),
      refreshAnswers('loop/fix', 'new111', 'old222'),
    );
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });

    expect(resolved).toMatchObject({
      status: 'ready',
      created: false,
      path: at(CONTAINER, 'fix'),
      refresh: { state: 'refreshed', detail: '' },
    });
    // The fast-forward ran IN the worktree — the whole point: the only pull in
    // a run used to touch the main checkout while this tree stayed pinned.
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['merge', '--ff-only', 'origin/main'],
      cwd: at(CONTAINER, 'fix'),
    });
  });

  it('reports an already-current worktree as current, without merging', () => {
    const git = fakeGit(
      porcelain([{ path: at(CONTAINER, 'fix'), branch: 'loop/fix' }]),
      refreshAnswers('loop/fix', 'same00', 'same00'),
    );
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });

    expect(resolved.refresh).toEqual({ state: 'current', detail: '' });
    expect(git.calls.some((call) => call.args[0] === 'merge')).toBe(false);
  });

  it('reports where it WOULD be, without creating, when creation is declined', () => {
    const git = fakeGit(porcelain());
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', create: false });

    expect(resolved).toMatchObject({ status: 'absent', created: false, path: at(CONTAINER, 'fix') });
    expect(git.calls).toHaveLength(1);
  });

  it('leaves a checkout someone moved to another branch exactly where it is', () => {
    const git = fakeGit(
      porcelain([{ path: at(CONTAINER, 'fix'), branch: 'loop/issue-1502' }]),
      refreshAnswers('loop/issue-1502'),
    );
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });
    expect(resolved.status).toBe('ready');
    expect(resolved.refresh).toMatchObject({ state: 'skipped-foreign-branch' });
    // nothing was re-pointed: no `worktree add`, no checkout, no merge — and it
    // was SAID, not silently reported fresh (#1584).
    const mutating = git.calls.filter((call) =>
      ['worktree', 'checkout', 'merge', 'fetch', 'reset'].includes(call.args[0]),
    );
    expect(mutating.filter((call) => call.args[1] !== 'list')).toEqual([]);
  });

  it('runs worktree admin from the MAIN checkout and refresh steps IN the worktree', () => {
    const git = fakeGit(porcelain(), refreshAnswers('loop/fix'));
    resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });
    for (const call of git.calls) {
      const expected = call.args[0] === 'worktree' ? REPO : at(CONTAINER, 'fix');
      expect(call.cwd).toBe(expected);
    }
  });

  it('two loops resolve to two different checkouts — the point of the whole thing', () => {
    expect(loopWorktreePath(REPO, 'fix')).not.toBe(loopWorktreePath(REPO, 'find'));
  });
});

describe('#7 — the container is the repository\'s, not whatever worktree the caller was in', () => {
  // A run's `--target` defaults to `process.cwd()`, and a run's cwd IS its own
  // worktree — a thread's, or a sibling loop slot's. `repoRoot` here stands in
  // for that: a real checkout of the SAME repository, just not the main one.
  const CALLER = join('/Users/dev/Projects/.plan-flow-threads/71bcaa64-721b-45d5-bf5c-d68dfee9459d');

  it('builds the container next to the real repo, not next to the caller\'s own checkout', () => {
    const git = fakeGit(
      porcelain([{ path: CALLER, branch: 'thread/71bcaa64-721b-45d5-bf5c-d68dfee9459d' }]),
      refreshAnswers('loop/fix'),
    );
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: CALLER, loop: 'fix' });

    expect(resolved.path).toBe(at(CONTAINER, 'fix'));
    expect(resolved.path.startsWith(CALLER)).toBe(false);
    // The worktree is created FROM the real repo, not from the caller's cwd —
    // this is the call that used to hard-fail a second caller (#7).
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'add', '-B', 'loop/fix', at(CONTAINER, 'fix')],
      cwd: REPO,
    });
  });

  it('two callers of the same loop, invoked from two different worktrees, resolve to the SAME checkout', () => {
    const callerA = join('/Users/dev/Projects/.plan-flow-threads/thread-a');
    const callerB = join('/Users/dev/Projects/.plan-flow-threads/thread-b');
    const gitA = fakeGit(porcelain([{ path: callerA, branch: 'thread/a' }]), refreshAnswers('loop/fix'));
    const gitB = fakeGit(porcelain([{ path: callerB, branch: 'thread/b' }]), refreshAnswers('loop/fix'));

    const resolvedA = resolveWorktree({ exec: gitA.exec, repoRoot: callerA, loop: 'fix' });
    const resolvedB = resolveWorktree({ exec: gitB.exec, repoRoot: callerB, loop: 'fix' });

    // Before #7: callerA built `.thread-a-loops/fix` and callerB built
    // `.thread-b-loops/fix` — two containers for one loop, and the second
    // `git worktree add -B loop/fix` would have hard-failed against the first
    // (the branch is already checked out there). Now both agree.
    expect(resolvedA.path).toBe(resolvedB.path);
    expect(resolvedA.path).toBe(at(CONTAINER, 'fix'));
  });

  it('prunes the checkout at the repo\'s container, not one next to the caller', () => {
    const git = fakeGit(
      porcelain([
        { path: CALLER, branch: 'thread/71bcaa64-721b-45d5-bf5c-d68dfee9459d' },
        { path: at(CONTAINER, 'fix'), branch: 'loop/fix' },
      ]),
    );
    const pruned = pruneWorktree({ exec: git.exec, repoRoot: CALLER, loop: 'fix' });

    expect(pruned.path).toBe(at(CONTAINER, 'fix'));
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'remove', '--force', at(CONTAINER, 'fix')],
      cwd: REPO,
    });
  });
});

describe('run slots — a second beat of one loop gets a checkout of its own', () => {
  it('leaves slot 1 exactly where it has always been', () => {
    expect(loopWorktreePath(REPO, 'fix', 1)).toBe(loopWorktreePath(REPO, 'fix'));
    expect(loopWorktreePath(REPO, 'fix')).toBe(at(CONTAINER, 'fix'));
  });

  it('gives every other slot a checkout of its own', () => {
    expect(loopWorktreePath(REPO, 'fix', 2)).toBe(at(CONTAINER, 'fix.2'));
    expect(loopWorktreePath(REPO, 'fix', 2)).not.toBe(loopWorktreePath(REPO, 'fix', 3));
  });

  it('cannot be confused with a loop whose name ends in a number', () => {
    // `.` rather than `-` is what makes this true: slot 2 of `fix` and a loop
    // genuinely called `fix-2` would otherwise be the same directory, and two
    // beats sharing a checkout is the whole failure this file exists to prevent.
    expect(loopWorktreePath(REPO, 'fix', 2)).not.toBe(loopWorktreePath(REPO, 'fix-2'));
  });

  it('creates a second slot DETACHED, because a branch lives in one worktree', () => {
    const git = fakeGit(
      porcelain([{ path: at(CONTAINER, 'fix'), branch: 'loop/fix' }]),
      refreshAnswers('HEAD'),
    );
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', slot: 2 });

    expect(resolved.status).toBe('created');
    expect(resolved.slot).toBe(2);
    // No base branch to report, and none attempted: `git worktree add -B
    // loop/fix` here would fail outright — slot 1 already has that branch
    // checked out.
    expect(resolved.branch).toBeNull();
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'add', '--detach', at(CONTAINER, 'fix.2')],
      cwd: REPO,
    });
    expect(git.calls.some((call) => call.args.includes('-B'))).toBe(false);
  });

  it('reuses a slot checkout across beats, re-detaching it onto origin/main', () => {
    const git = fakeGit(
      porcelain([{ path: at(CONTAINER, 'fix.2'), head: 'abc123' } as never]),
      refreshAnswers('HEAD', 'new111', 'old222'),
    );
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', slot: 2 });

    expect(resolved.status).toBe('ready');
    expect(resolved.created).toBe(false);
    // A detached slot has no branch to fast-forward — it re-detaches instead.
    expect(resolved.refresh).toEqual({ state: 'refreshed', detail: '' });
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['checkout', '--detach', 'origin/main'],
      cwd: at(CONTAINER, 'fix.2'),
    });
  });

  it('prunes one slot without touching the other', () => {
    const git = fakeGit(
      porcelain([
        { path: at(CONTAINER, 'fix'), branch: 'loop/fix' },
        { path: at(CONTAINER, 'fix.2'), head: 'abc123' },
      ]),
    );
    const pruned = pruneWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', slot: 2 });

    expect(pruned.status).toBe('pruned');
    expect(pruned.path).toBe(at(CONTAINER, 'fix.2'));
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'remove', '--force', at(CONTAINER, 'fix.2')],
      cwd: REPO,
    });
    // slot 1's checkout is never named in any argv this call produced
    expect(git.calls.some((call) => call.args.includes(at(CONTAINER, 'fix')))).toBe(false);
  });

  it('refuses a slot that is not one', () => {
    const git = fakeGit(porcelain([]));
    expect(() => resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', slot: 0 })).toThrow(
      'is not a run slot',
    );
    expect(() => loopWorktreePath(REPO, 'fix', 1.5)).toThrow('is not a run slot');
  });
});

describe('#1584 — a resolve says how fresh the tree really is, and never discards work', () => {
  const READY = porcelain([{ path: at(CONTAINER, 'fix'), branch: 'loop/fix' }]);

  it('a dirty tree is left untouched, and the notice NAMES what blocked it', () => {
    const git = fakeGit(READY, refreshAnswers('loop/fix', 'a', 'b', { dirty: ' M src/x.ts' }));
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });

    expect(resolved.refresh).toMatchObject({ state: 'skipped-dirty' });
    expect(resolved.refresh?.detail).toContain('M src/x.ts');
    expect(git.calls.some((call) => ['fetch', 'merge', 'checkout'].includes(call.args[0]))).toBe(
      false,
    );
  });

  it('asks git for TRACKED dirt only — untracked artifacts never block a refresh (#1650)', () => {
    // The live instance: a slot sat four days behind main because two
    // node_modules symlinks read as `??` dirt forever. The predicate now
    // passes --untracked-files=no, so git itself excludes them — the fake
    // returning '' for status models exactly that answer.
    const git = fakeGit(READY, refreshAnswers('loop/fix', 'new111', 'old222'));
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });

    const status = git.calls.find((call) => call.args[0] === 'status');
    expect(status?.args).toContain('--untracked-files=no');
    expect(resolved.refresh).toMatchObject({ state: 'refreshed' });
  });

  it('a branch with its own commits is diverged, not reset — freshness never wins over work', () => {
    const git = fakeGit(READY, refreshAnswers('loop/fix', 'new111', 'old222', { mergeFails: true }));
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });

    expect(resolved.refresh).toMatchObject({ state: 'diverged' });
    expect(git.calls.some((call) => call.args[0] === 'reset')).toBe(false);
  });

  it('an unreachable remote fails soft — the tree is untouched and the state is honest', () => {
    const git = fakeGit(READY, refreshAnswers('loop/fix', 'a', 'b', { fetchFails: true }));
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });

    expect(resolved.refresh).toMatchObject({ state: 'failed' });
    expect(resolved.refresh?.detail).toContain('could not resolve host');
    expect(git.calls.some((call) => ['merge', 'checkout'].includes(call.args[0]))).toBe(false);
  });

  it('#1625 — reuses the shared ref instead of re-negotiating, and still ff-merges', () => {
    // The worktree is LINKED: `origin/main` here is the ref the gate's pull just
    // updated in the main checkout, so fetching it again is a round trip to
    // learn what the ref store already knows (~1s local, 2.7s reported).
    const git = fakeGit(READY, refreshAnswers('loop/fix', 'new111', 'old222'));
    const resolved = resolveWorktree({
      exec: git.exec,
      repoRoot: REPO,
      loop: 'fix',
      fetch: false,
    });

    // The network step is gone — and the LOCAL step that makes the checkout
    // current is not, which is the whole point: #1584's guarantee is kept.
    expect(git.calls.some((call) => call.args[0] === 'fetch')).toBe(false);
    expect(resolved.refresh).toMatchObject({ state: 'refreshed' });
    expect(git.calls.some((call) => call.args[0] === 'merge')).toBe(true);
  });

  it('#1625 — fetches by default, so only an explicit opt-out ever skips it', () => {
    const git = fakeGit(READY, refreshAnswers('loop/fix', 'new111', 'old222'));
    resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });
    expect(git.calls.some((call) => call.args[0] === 'fetch')).toBe(true);
  });

  it('an absent worktree reports no freshness — there is no tree to be fresh', () => {
    const git = fakeGit(porcelain());
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', create: false });
    expect(resolved.refresh).toBeUndefined();
  });

  it('refreshes to the base branch it was asked for, not a hardcoded main', () => {
    const answers = (args: readonly string[]): string | undefined => {
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'loop/fix';
      if (args[0] === 'rev-parse' && args[1] === 'origin/trunk') return 'new111';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'old222';
      return undefined;
    };
    const git = fakeGit(READY, answers);
    const resolved = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', base: 'trunk' });

    expect(resolved.refresh).toEqual({ state: 'refreshed', detail: '' });
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['merge', '--ff-only', 'origin/trunk'],
      cwd: at(CONTAINER, 'fix'),
    });
  });
});

describe('Task 5.5 — prune on demand', () => {
  it('removes the checkout and cleans git\'s record', () => {
    const git = fakeGit(porcelain([{ path: at(CONTAINER, 'fix'), branch: 'loop/fix' }]));
    const pruned = pruneWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });

    expect(pruned).toEqual({
      status: 'pruned',
      loop: 'fix',
      slot: 1,
      path: at(CONTAINER, 'fix'),
      branch: 'loop/fix',
    });
    expect(git.calls[1].args).toEqual(['worktree', 'remove', '--force', at(CONTAINER, 'fix')]);
    expect(git.calls[2].args).toEqual(['worktree', 'prune']);
  });

  it('never deletes the branch — pruning reclaims a checkout, not the work', () => {
    const git = fakeGit(porcelain([{ path: at(CONTAINER, 'fix'), branch: 'loop/fix' }]));
    pruneWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });
    const deletes = git.calls.filter((call) => call.args.includes('branch') || call.args.includes('-D'));
    expect(deletes).toEqual([]);
  });

  it('pruning what is already gone still clears a stale record, and is not an error', () => {
    const git = fakeGit(porcelain());
    const pruned = pruneWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });
    expect(pruned.status).toBe('absent');
    expect(git.calls[1].args).toEqual(['worktree', 'prune']);
    expect(git.calls.some((call) => call.args.includes('remove'))).toBe(false);
  });
});

describe('#1742 — the checkout is bound to its owner, and live edits are never reassigned', () => {
  const FIX = at(CONTAINER, 'fix');

  /** refreshAnswers plus a stored owner stamp and optional dirt. */
  function stampedAnswers(
    lastOwner: string | null,
    opts: { dirty?: string } = {},
  ): (args: readonly string[]) => string | undefined {
    const base = refreshAnswers('loop/fix', 'abc123', 'abc123', opts);
    return (args) => {
      if (args[0] === 'config' && args[1] === '--worktree' && args.length === 3) {
        if (lastOwner === null) throw new Error('exit 1'); // unset key
        return lastOwner;
      }
      if (args[0] === 'config') return '';
      return base(args);
    };
  }

  it('hands the same owner its own checkout back, dirty or not', () => {
    const git = fakeGit(
      porcelain([{ path: FIX, branch: 'loop/fix' }]),
      stampedAnswers('run-A', { dirty: ' M app/src/renderer/loops/loops-screen.ts' }),
    );
    const result = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', owner: 'run-A' });
    expect(result.status).toBe('ready');
    expect(result.refresh?.state).toBe('skipped-dirty');
  });

  it('refuses to hand a sibling a checkout still carrying uncommitted work', () => {
    const git = fakeGit(
      porcelain([{ path: FIX, branch: 'loop/fix' }]),
      stampedAnswers('run-A', { dirty: ' M app/src/renderer/loops/loops-screen.ts' }),
    );
    expect(() =>
      resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', owner: 'run-B' }),
    ).toThrow(/run 'run-A'.*uncommitted work.*loops-screen\.ts/s);
    // And nothing touched the tree: no checkout, no merge, no reset.
    const verbs = git.calls.map((call) => call.args[0]);
    expect(verbs).not.toContain('merge');
    expect(verbs).not.toContain('reset');
  });

  it('reassigns a CLEAN checkout to a new owner and re-stamps it', () => {
    const git = fakeGit(porcelain([{ path: FIX, branch: 'loop/fix' }]), stampedAnswers('run-A'));
    const result = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', owner: 'run-B' });
    expect(result.status).toBe('ready');
    const stamp = git.calls.find(
      (call) => call.args[0] === 'config' && call.args.includes('planflow.loopOwner') && call.args.length === 4,
    );
    expect(stamp?.args[3]).toBe('run-B');
    expect(stamp?.cwd).toBe(FIX);
  });

  it('stamps a freshly created worktree with the owner that asked for it', () => {
    const git = fakeGit(porcelain(), refreshAnswers('loop/fix'));
    const result = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', owner: 'run-A' });
    expect(result.status).toBe('created');
    const stamp = git.calls.find(
      (call) => call.args[0] === 'config' && call.args.includes('planflow.loopOwner') && call.args.length === 4,
    );
    expect(stamp?.args[3]).toBe('run-A');
  });

  it('an ownerless resolve neither reads nor writes the stamp — a person keeps the old behaviour', () => {
    const git = fakeGit(porcelain([{ path: FIX, branch: 'loop/fix' }]), refreshAnswers('loop/fix'));
    const result = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix' });
    expect(result.status).toBe('ready');
    expect(git.calls.some((call) => call.args[0] === 'config')).toBe(false);
  });

  it('a stamp git cannot store degrades soft — the resolve still answers', () => {
    const answers = stampedAnswers(null);
    const git = fakeGit(porcelain([{ path: FIX, branch: 'loop/fix' }]), (args) => {
      if (args[0] === 'config') throw new Error('unknown option --worktree'); // ancient git
      return answers(args);
    });
    const result = resolveWorktree({ exec: git.exec, repoRoot: REPO, loop: 'fix', owner: 'run-A' });
    expect(result.status).toBe('ready');
  });
});

// ── threads (Phase 2) ────────────────────────────────────

const THREADS = join('/Users/dev/Projects/.plan-flow-threads');
/** A thread's slug is its uuid, which the loop grammar already accepts. */
const THREAD = '7f3a9c21-4d5e-4b8a-9c0f-1e2d3a4b5c6d';

/** A fake filesystem: a set of paths that exist, and a record of what was made. */
function fakeFs(
  present: Record<string, 'dir' | 'file' | 'link'> = {},
): {
  fs: WorktreeFs;
  made: { target: string; path: string; type: string }[];
  removed: string[];
  copied: { source: string; target: string }[];
  /** File bodies the fake filesystem should report, by absolute path. */
  contents: Record<string, string>;
} {
  const made: { target: string; path: string; type: string }[] = [];
  const removed: string[] = [];
  const copied: { source: string; target: string }[] = [];
  const contents: Record<string, string> = {};
  const entries = { ...present };
  return {
    made,
    removed,
    copied,
    contents,
    fs: {
      readDir: (path) =>
        Object.keys(entries)
          .filter((key) => key.startsWith(path + sep) && !key.slice(path.length + 1).includes('/'))
          .map((key) => key.slice(path.length + 1)),
      exists: (path) => entries[path] !== undefined,
      isDirectory: (path) => entries[path] === 'dir',
      isSymlink: (path) => entries[path] === 'link',
      symlink: (target, path, type) => {
        made.push({ target, path, type });
        entries[path] = type === 'dir' ? 'dir' : 'file';
      },
      unlink: (path) => {
        removed.push(path);
        delete entries[path];
      },
      removeDir: (path) => {
        removed.push(path);
        for (const key of Object.keys(entries)) {
          if (key === path || key.startsWith(path + sep)) delete entries[key];
        }
      },
      copyFile: (source, target) => {
        copied.push({ source, target });
        entries[target] = 'file';
      },
      readFile: (path) => contents[path] ?? null,
    },
  };
}

/** The two probes `requireCommittedRepo` runs, plus the refresh's answers. */
function threadAnswers(
  head = 'HEAD',
  opts: { noRepo?: boolean; unborn?: boolean } = {},
): (args: readonly string[]) => string | undefined {
  const refresh = refreshAnswers(head);
  return (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
      if (opts.noRepo) throw new Error('fatal: not a git repository (or any of the parent directories)');
      return '.git';
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
      if (opts.unborn || opts.noRepo) throw new Error("fatal: Needed a single revision");
      return 'abc123';
    }
    return refresh(args);
  };
}

describe('Task 2.1 — one lifecycle, two kinds of owner', () => {
  it('puts a thread beside the loops, in its own container', () => {
    expect(threadWorktreeRoot(REPO)).toBe(THREADS);
    expect(threadWorktreePath(REPO, THREAD)).toBe(at(THREADS, THREAD));
  });

  it('a loop and a thread of the same name are never the same directory', () => {
    expect(worktreeContainer(REPO, 'loop')).not.toBe(worktreeContainer(REPO, 'thread'));
    expect(loopWorktreePath(REPO, 'fix')).not.toBe(threadWorktreePath(REPO, 'fix'));
  });

  it('the loop paths are exactly what they were — threads changed nothing', () => {
    expect(loopWorktreePath(REPO, 'fix')).toBe(at(CONTAINER, 'fix'));
    expect(loopWorktreePath(REPO, 'fix', 2)).toBe(at(CONTAINER, 'fix.2'));
  });

  it('refuses a thread name that could escape the container', () => {
    expect(() => threadWorktreePath(REPO, '../../etc')).toThrow('is not a thread name');
    expect(() => threadWorktreePath(REPO, '')).toThrow('is not a thread name');
  });
});

describe('Task 2.2 — a thread resolves its own checkout', () => {
  it('creates it detached, because the thread has no title yet', () => {
    const git = fakeGit(porcelain(), threadAnswers());
    const fake = fakeFs({ [at(REPO, 'node_modules')]: 'dir' });
    const resolved = resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      detach: true,
      fs: fake.fs,
    });

    expect(resolved).toMatchObject({
      status: 'created',
      thread: THREAD,
      path: at(THREADS, THREAD),
      branch: null,
      created: true,
    });
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'add', '--detach', at(THREADS, THREAD)],
      cwd: REPO,
    });
  });

  it('a caller that already knows the name gets the branch attached instead', () => {
    const git = fakeGit(porcelain(), threadAnswers('thread/fix-the-parser'));
    const resolved = resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      branch: 'thread/fix-the-parser',
      fs: fakeFs().fs,
    });
    expect(resolved.branch).toBe('thread/fix-the-parser');
    expect(git.calls.some((call) => call.args.includes('--detach'))).toBe(false);
  });

  it('derives the branch from the folder without wearing the prefix twice', () => {
    // A checkout lives at `worktree/<name>`, so the folder's NAME already
    // carries the prefix. Handing it whole to `threadBranch` made
    // `worktree/worktree/<name>` — a branch nested a level deeper than anything
    // that could have made it, on the one path where somebody names the folder
    // and leaves the branch to be derived.
    const git = fakeGit(porcelain(), threadAnswers('worktree/export-pipeline'));
    const resolved = resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      worktreeName: 'worktree/export-pipeline',
      fs: fakeFs().fs,
    });
    // The positive first: the folder IS the name, not the thread's id.
    expect(resolved.path).toBe(at(THREADS, 'worktree/export-pipeline'));
    expect(resolved.branch).toBe('worktree/export-pipeline');
  });

  it('still prefixes a folder name that does not carry one', () => {
    const git = fakeGit(porcelain(), threadAnswers('worktree/export-pipeline'));
    const resolved = resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      worktreeName: 'export-pipeline',
      fs: fakeFs().fs,
    });
    expect(resolved.branch).toBe('worktree/export-pipeline');
  });

  it('refuses a non-git directory with nothing created', () => {
    const git = fakeGit(porcelain(), threadAnswers('HEAD', { noRepo: true }));
    expect(() =>
      resolveThreadWorktree({ exec: git.exec, repoRoot: REPO, thread: THREAD, detach: true, fs: fakeFs().fs }),
    ).toThrow('is not a git repository');
    expect(git.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(false);
  });

  it('refuses a non-git directory even when `worktree list` itself cannot run there (#7)', () => {
    // `fakeGit` above always answers `worktree list` with canned porcelain, so
    // it cannot exercise this: on a REAL non-git directory, `git worktree list`
    // fails exactly like every other git command does. Canonicalizing the repo
    // root must not run — and therefore must not surface git's raw error —
    // before `requireCommittedRepo` gets to give its own, readable one. This
    // is the exact shape of a real regression: a real `create --target <a
    // plain, non-git directory>` started failing with git's own message once
    // the canonicalizing `worktree list` ran ahead of this refusal.
    const calls: string[][] = [];
    const exec: GitExec = (_file, args) => {
      calls.push([...args]);
      throw new Error('fatal: not a git repository (or any of the parent directories): .git');
    };
    expect(() =>
      resolveThreadWorktree({ exec, repoRoot: REPO, thread: THREAD, detach: true, fs: fakeFs().fs }),
    ).toThrow('is not a git repository');
    expect(calls.some((args) => args[0] === 'worktree')).toBe(false);
  });

  it('refuses an unborn branch — a worktree starts at a commit', () => {
    const git = fakeGit(porcelain(), threadAnswers('HEAD', { unborn: true }));
    expect(() =>
      resolveThreadWorktree({ exec: git.exec, repoRoot: REPO, thread: THREAD, detach: true, fs: fakeFs().fs }),
    ).toThrow('no commits yet');
    expect(git.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(false);
  });

  it('reuses an existing checkout rather than re-creating it', () => {
    const git = fakeGit(
      `worktree ${REPO}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${at(THREADS, THREAD)}\nHEAD def456\ndetached\n`,
      threadAnswers(),
    );
    const resolved = resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      detach: true,
      fs: fakeFs().fs,
    });
    expect(resolved.status).toBe('ready');
    expect(resolved.created).toBe(false);
    expect(git.calls.some((call) => call.args[1] === 'add')).toBe(false);
  });

  // #1901 — git keeps listing a worktree whose directory was emptied to a bare
  // `.claude/` shell (no `.git`) and flags it `prunable`. Reusing it as `ready`
  // handed the session a path that is not a git repository, so every `git
  // status` failed with "not a git repository" and the thread wedged.
  const DEAD_SHELL =
    `worktree ${REPO}\nHEAD abc123\nbranch refs/heads/main\n\n` +
    `worktree ${at(THREADS, THREAD)}\nHEAD def456\ndetached\n` +
    `prunable gitdir file points to non-existent location\n`;

  it('rebuilds a dead prunable shell instead of reusing it (#1901)', () => {
    const git = fakeGit(DEAD_SHELL, threadAnswers());
    // The shell is on disk (only `.claude/`, no `.git` of its own).
    const fake = fakeFs({ [at(THREADS, THREAD)]: 'dir' });
    const resolved = resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      detach: true,
      fs: fake.fs,
    });

    // Not reused — actually rebuilt.
    expect(resolved.status).toBe('created');
    expect(resolved.created).toBe(true);

    const verbs = git.calls.filter((call) => call.args[0] === 'worktree').map((call) => call.args);
    const prunedAt = verbs.findIndex((args) => args[1] === 'prune');
    const addedAt = verbs.findIndex((args) => args[1] === 'add');
    // The stale record is dropped, the shell is removed, and the checkout is
    // rebuilt — in that order.
    expect(prunedAt).toBeGreaterThanOrEqual(0);
    expect(fake.removed).toContain(at(THREADS, THREAD));
    expect(addedAt).toBeGreaterThan(prunedAt);
    expect(verbs[addedAt]).toEqual(['worktree', 'add', '--detach', at(THREADS, THREAD)]);
  });

  it('never deletes a directory that still holds a real `.git` (#1901)', () => {
    const git = fakeGit(DEAD_SHELL, threadAnswers());
    // A directory git failed to list correctly but which IS a real checkout —
    // its `.git` present — must never be removed by the dead-shell cleanup.
    const fake = fakeFs({
      [at(THREADS, THREAD)]: 'dir',
      [at(THREADS, THREAD, '.git')]: 'file',
    });
    resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      detach: true,
      fs: fake.fs,
    });
    expect(fake.removed).not.toContain(at(THREADS, THREAD));
  });

  it('a read-only probe reports a dead shell as absent without touching it (#1901)', () => {
    const git = fakeGit(DEAD_SHELL, threadAnswers());
    const fake = fakeFs({ [at(THREADS, THREAD)]: 'dir' });
    const resolved = resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      detach: true,
      create: false,
      fs: fake.fs,
    });
    expect(resolved.status).toBe('absent');
    expect(fake.removed).toEqual([]);
    expect(git.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'prune')).toBe(
      false,
    );
    expect(git.calls.some((call) => call.args[1] === 'add')).toBe(false);
  });

  it('reports where it would be without creating anything', () => {
    const git = fakeGit(porcelain(), threadAnswers());
    const resolved = resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      detach: true,
      create: false,
      fs: fakeFs().fs,
    });
    expect(resolved).toEqual({
      status: 'absent',
      thread: THREAD,
      path: at(THREADS, THREAD),
      branch: null,
      base: null,
      baseMode: 'here',
      onBase: false,
      created: false,
    });
    expect(git.calls.some((call) => call.args[1] === 'add')).toBe(false);
  });

  it('prune needs a person to have asked — nothing is removed without one (#15)', () => {
    const git = fakeGit(porcelain([{ path: at(THREADS, THREAD), branch: 'thread/x' }]));
    expect(() =>
      pruneThreadWorktree({ exec: git.exec, repoRoot: REPO, thread: THREAD, confirmed: false }),
    ).toThrow('needs an explicit confirmation');
    expect(git.calls).toEqual([]);
  });

  describe('the possessive reads as one (#1837)', () => {
    // Three refusals built a possessive by appending `'s` to an
    // already-quoted value, so the sentence carried two apostrophes in a row:
    // "thread 'demo-thread''s worktree". Two of the three are the refusals
    // that stand in front of losing work that exists nowhere else — the ones
    // most likely to be read carefully, quoted into an escalation, or pasted
    // into a heartbeat prompt.

    it('the consent refusal names the thread once, with one apostrophe', () => {
      const git = fakeGit(porcelain([{ path: at(THREADS, THREAD), branch: 'thread/x' }]));
      let message = '';
      try {
        pruneThreadWorktree({ exec: git.exec, repoRoot: REPO, thread: THREAD, confirmed: false });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain(`thread '${THREAD}'s worktree`);
      expect(message).not.toContain("''");
    });

    it('no refusal in this module doubles an apostrophe', () => {
      // A SOURCE SCAN, because the other two call sites need a dirty worktree
      // and a live sibling run to reach, and the defect is a typo in a template
      // literal — visible without running anything. Behaviour is asserted above
      // for the one that is reachable; this is what stops the pattern coming
      // back in a fourth string nobody has written yet.
      const source = readFileSync(join(HERE, 'worktree.ts'), 'utf-8');
      const doubled = source.split('\n').filter((line) => line.includes("''s"));

      expect(doubled).toEqual([]);
    });
  });

  it('prunes the checkout and keeps the branch when it was asked for', () => {
    const git = fakeGit(porcelain([{ path: at(THREADS, THREAD), branch: 'thread/x' }]));
    const pruned = pruneThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      confirmed: true,
    });
    expect(pruned).toEqual({ status: 'pruned', thread: THREAD, path: at(THREADS, THREAD) });
    expect(git.calls.some((call) => call.args.includes('-D'))).toBe(false);
  });

  it('prunes past a COPIED file the main checkout still has, unedited', () => {
    // The untracked set copies `.env*` rather than linking it, so every
    // worktree now carries a real untracked file. Counted as losable it would
    // degrade this guard into "never prune a worktree that has configuration"
    // — which is every worktree, the same failure #1650 fixed for the refresh
    // guard. Caught by the CLI E2E, not by a unit: the units all used symlinks.
    const fake = fakeFs({ [at(THREADS, THREAD, '.env')]: 'file', [at(REPO, '.env')]: 'file' });
    fake.contents[at(THREADS, THREAD, '.env')] = 'SECRET=1\n';
    fake.contents[at(REPO, '.env')] = 'SECRET=1\n';
    const git = fakeGit(porcelain([{ path: at(THREADS, THREAD), branch: 'thread/x' }]), (args) =>
      args[0] === 'status' ? '?? .env\n' : undefined,
    );
    expect(
      pruneThreadWorktree({
        exec: git.exec,
        repoRoot: REPO,
        thread: THREAD,
        confirmed: true,
        fs: fake.fs,
      }),
    ).toMatchObject({ status: 'pruned' });
  });

  it('refuses when that copy has been EDITED — the edit exists only here', () => {
    // The whole reason `.env` is copied: an agent told to add a key edits this
    // file and not the user's. That edit is losable, and deleting it silently
    // is exactly what the guard exists to stop.
    const fake = fakeFs({ [at(THREADS, THREAD, '.env')]: 'file', [at(REPO, '.env')]: 'file' });
    fake.contents[at(THREADS, THREAD, '.env')] = 'SECRET=2\n'
    fake.contents[at(REPO, '.env')] = 'SECRET=1\n'
    const git = fakeGit(porcelain([{ path: at(THREADS, THREAD), branch: 'thread/x' }]), (args) =>
      args[0] === 'status' ? '?? .env\n' : undefined,
    );
    expect(() =>
      pruneThreadWorktree({
        exec: git.exec,
        repoRoot: REPO,
        thread: THREAD,
        confirmed: true,
        fs: fake.fs,
      }),
    ).toThrow(/uncommitted work.*\.env/s);
  });

  // ── Phase 7, task 7.4: the disk goes, the record stays ──────────────────

  it('removes the checkout with exactly two writes, and neither is about a branch', () => {
    const git = fakeGit(porcelain([{ path: at(THREADS, THREAD), branch: 'thread/x' }]));
    pruneThreadWorktree({ exec: git.exec, repoRoot: REPO, thread: THREAD, confirmed: true });
    const writes = git.calls
      .filter((call) => call.args[1] !== 'list')
      // LOOKING IS NOT DOING. The prune reads the checkout's status before it
      // overrides git's refusal to delete a dirty one (#1797); this test is
      // about what it CHANGES, so a read belongs outside the list rather than
      // inside it — and the branch assertion below covers every call either way.
      .filter((call) => call.args[0] !== 'status')
      .map((call) => call.args);
    expect(writes).toEqual([
      ['worktree', 'remove', '--force', at(THREADS, THREAD)],
      ['worktree', 'prune'],
    ]);
    // The branch is the record of what the thread did (discovery OQ 7). Nothing
    // here deletes one, and no later change may quietly add a call that does.
    expect(git.calls.some((call) => call.args[0] === 'branch')).toBe(false);
  });

  it('clears a dead record without claiming it removed anything', () => {
    // git holds a record for a directory that is no longer there — exactly the
    // state `prunable: true` reports and the cap sweep runs into.
    const git = fakeGit(porcelain());
    const pruned = pruneThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      confirmed: true,
    });
    expect(pruned.status).toBe('absent');
    expect(git.calls.some((call) => call.args[1] === 'remove')).toBe(false);
  });

  it('removes only the named thread’s checkout', () => {
    const other = 'aaaaaaaa-1111-2222-3333-444444444444';
    const git = fakeGit(
      porcelain([
        { path: at(THREADS, THREAD), branch: 'thread/x' },
        { path: at(THREADS, other), branch: 'thread/y' },
      ]),
    );
    pruneThreadWorktree({ exec: git.exec, repoRoot: REPO, thread: THREAD, confirmed: true });
    expect(git.calls.some((call) => call.args.includes(at(THREADS, other)))).toBe(false);
  });
});

describe('#7 — a thread\'s checkout is built from the repo, not from whatever worktree resolved it', () => {
  // Mirrors the loop coverage above: `repoRoot` here is a REAL checkout of the
  // same repository — a sibling thread's or loop's own worktree — never the
  // main one.
  const CALLER = join('/Users/dev/Projects/.plan-flow-threads/71bcaa64-721b-45d5-bf5c-d68dfee9459d');

  it('creates the checkout next to the real repo, not next to the caller\'s own worktree', () => {
    const git = fakeGit(
      porcelain([{ path: CALLER, branch: 'thread/71bcaa64-721b-45d5-bf5c-d68dfee9459d' }]),
      threadAnswers(),
    );
    const resolved = resolveThreadWorktree({
      exec: git.exec,
      repoRoot: CALLER,
      thread: THREAD,
      detach: true,
      fs: fakeFs().fs,
    });

    expect(resolved.path).toBe(at(THREADS, THREAD));
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'add', '--detach', at(THREADS, THREAD)],
      cwd: REPO,
    });
  });

  it('prunes the checkout at the repo\'s container, not one next to the caller', () => {
    const git = fakeGit(
      porcelain([
        { path: CALLER, branch: 'thread/71bcaa64-721b-45d5-bf5c-d68dfee9459d' },
        { path: at(THREADS, THREAD), branch: 'thread/x' },
      ]),
    );
    const pruned = pruneThreadWorktree({ exec: git.exec, repoRoot: CALLER, thread: THREAD, confirmed: true });

    expect(pruned.path).toBe(at(THREADS, THREAD));
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'remove', '--force', at(THREADS, THREAD)],
      cwd: REPO,
    });
  });

  it('still refuses an unconfirmed prune before touching git — canonicalizing is not an excuse to look first', () => {
    const git = fakeGit(porcelain([{ path: CALLER, branch: 'thread/71bcaa64-721b-45d5-bf5c-d68dfee9459d' }]));
    expect(() =>
      pruneThreadWorktree({ exec: git.exec, repoRoot: CALLER, thread: THREAD, confirmed: false }),
    ).toThrow('needs an explicit confirmation');
    expect(git.calls).toEqual([]);
  });
});

describe("plan-flow's own .claude assets reach a worktree (2026-09-30)", () => {
  // A Copilot thread in a worktree stopped with "walkthrough-template.html is
  // absent from this worktree": .claude/commands and .claude/resources are
  // provisioned and gitignored, so git never put them there.
  const made: string[] = [];
  const tmp = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pf-wt-claude-')));
    made.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  const project = (): string => {
    const repo = tmp();
    for (const sub of ['commands', 'resources/patterns', 'hooks', 'rules']) mkdirSync(join(repo, '.claude', sub), { recursive: true });
    writeFileSync(join(repo, '.claude', 'resources', 'patterns', 'walkthrough-template.html'), '<html></html>');
    return repo;
  };

  it('links the owned folders into a worktree that tracks .claude/rules, keeping its own tree', () => {
    const repo = project();
    const worktree = tmp();
    mkdirSync(join(worktree, '.claude', 'rules'), { recursive: true });
    const links = linkUntrackedSet({ repoRoot: repo, worktreePath: worktree, fs: nodeWorktreeFs });
    expect(links).toEqual(expect.arrayContaining([
      { entry: '.claude', status: 'present' },
      { entry: '.claude/commands', status: 'linked' },
      { entry: '.claude/resources', status: 'linked' },
      { entry: '.claude/hooks', status: 'linked' },
    ]));
    // The worktree's own tracked rules are untouched — a real directory, not a link.
    expect(lstatSync(join(worktree, '.claude')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(worktree, '.claude', 'resources', 'patterns', 'walkthrough-template.html'))).toBe(true);
  });

  it('links the whole .claude into a worktree that has none', () => {
    const repo = project();
    const worktree = tmp();
    const links = linkUntrackedSet({ repoRoot: repo, worktreePath: worktree, fs: nodeWorktreeFs });
    expect(links).toEqual(expect.arrayContaining([
      { entry: '.claude', status: 'linked' },
      { entry: '.claude/resources', status: 'present' },
    ]));
    expect(existsSync(join(worktree, '.claude', 'resources', 'patterns', 'walkthrough-template.html'))).toBe(true);
  });
});

describe('Task 2.3 — the untracked set a worktree cannot inherit', () => {
  it('links the dependencies and the vault, and COPIES the secrets', () => {
    const fake = fakeFs({
      [at(REPO, 'node_modules')]: 'dir',
      [at(REPO, '.env')]: 'file',
      [at(REPO, '.env.local')]: 'file',
      [at(REPO, 'flow')]: 'link',
    });
    const links = linkUntrackedSet({ repoRoot: REPO, worktreePath: at(THREADS, THREAD), fs: fake.fs });

    // `.env*` COPIED, the rest linked. Linked, `<worktree>/.env` and the user's
    // own `.env` are ONE file — and containment cannot catch the write, because
    // every check in `path-containment.ts` is lexical and the path IS lexically
    // inside the worktree.
    expect(links).toEqual([
      { entry: 'node_modules', status: 'linked' },
      { entry: '.env', status: 'copied' },
      { entry: '.env.local', status: 'copied' },
      { entry: 'flow', status: 'linked' },
      { entry: '.claude', status: 'missing' },
      { entry: '.claude/commands', status: 'missing' },
      { entry: '.claude/resources', status: 'missing' },
      { entry: '.claude/hooks', status: 'missing' },
    ]);
    expect(fake.copied).toEqual([
      { source: at(REPO, '.env'), target: at(THREADS, THREAD, '.env') },
      { source: at(REPO, '.env.local'), target: at(THREADS, THREAD, '.env.local') },
    ]);
    expect(fake.made).toContainEqual({
      target: at(REPO, 'node_modules'),
      path: at(THREADS, THREAD, 'node_modules'),
      type: 'dir',
    });
  });

  it('never installs, and never copies a DIRECTORY', () => {
    // The half of "linked, never copied" that still stands in full: the cost
    // that rule was about is a directory, and no mode can ask for one to be
    // copied — `copy` falls back to a link for anything that is not a file.
    const fake = fakeFs({ [at(REPO, 'node_modules')]: 'dir', [at(REPO, '.env')]: 'dir' });
    linkUntrackedSet({ repoRoot: REPO, worktreePath: at(THREADS, THREAD), fs: fake.fs });
    expect(fake.made).toHaveLength(2);
    expect(fake.copied).toEqual([]);
    expect(fake.removed).toEqual([]);
  });

  it('a missing source is skipped silently — most repos have no .env', () => {
    const fake = fakeFs({ [at(REPO, 'node_modules')]: 'dir' });
    const links = linkUntrackedSet({ repoRoot: REPO, worktreePath: at(THREADS, THREAD), fs: fake.fs });
    expect(links).toEqual([
      { entry: 'node_modules', status: 'linked' },
      { entry: 'flow', status: 'missing' },
      { entry: '.claude', status: 'missing' },
      { entry: '.claude/commands', status: 'missing' },
      { entry: '.claude/resources', status: 'missing' },
      { entry: '.claude/hooks', status: 'missing' },
    ]);
  });

  it('an existing target is never overwritten — a real node_modules survives', () => {
    const fake = fakeFs({
      [at(REPO, 'node_modules')]: 'dir',
      [at(THREADS, THREAD, 'node_modules')]: 'dir',
    });
    const links = linkUntrackedSet({ repoRoot: REPO, worktreePath: at(THREADS, THREAD), fs: fake.fs });
    expect(links[0]).toEqual({ entry: 'node_modules', status: 'present' });
    expect(fake.made).toEqual([]);
    expect(fake.removed).toEqual([]);
  });

  it('takes configured caches on top of the built-in set', () => {
    const fake = fakeFs({ [at(REPO, '.turbo')]: 'dir' });
    const links = linkUntrackedSet({
      repoRoot: REPO,
      worktreePath: at(THREADS, THREAD),
      entries: [...DEFAULT_LINKED_ENTRIES, { entry: '.turbo', mode: 'link' as const }],
      fs: fake.fs,
    });
    expect(links).toContainEqual({ entry: '.turbo', status: 'linked' });
  });

  it('a resolve links as part of creating the checkout', () => {
    const git = fakeGit(porcelain(), threadAnswers());
    const fake = fakeFs({ [at(REPO, 'node_modules')]: 'dir', [at(REPO, 'flow')]: 'link' });
    const resolved = resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: THREAD,
      detach: true,
      fs: fake.fs,
    });
    expect(resolved.links).toContainEqual({ entry: 'flow', status: 'linked' });
  });
});

describe('Task 2.4 — naming a detached checkout after the fact', () => {
  const PATH = at(THREADS, THREAD);

  /** Detached HEAD, with `taken` the branches that already exist. */
  function nameAnswers(taken: readonly string[], head = 'HEAD'): (args: readonly string[]) => string | undefined {
    return (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return head;
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--quiet') {
        const branch = args[3].replace('refs/heads/', '');
        if (taken.includes(branch)) return 'abc123';
        throw new Error('exit 1');
      }
      return undefined;
    };
  }

  it('creates the branch at the commit the worktree is already on', () => {
    const git = fakeGit('', nameAnswers([]));
    const named = nameWorktreeBranch({
      exec: git.exec,
      repoRoot: REPO,
      path: PATH,
      branch: 'thread/fix-the-parser',
    });
    expect(named).toEqual({ status: 'named', branch: 'thread/fix-the-parser', path: PATH });
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['checkout', '-b', 'thread/fix-the-parser'],
      cwd: PATH,
    });
  });

  it('dedupes with -2 rather than losing to a name collision', () => {
    const git = fakeGit('', nameAnswers(['thread/fix-the-parser']));
    const named = nameWorktreeBranch({
      exec: git.exec,
      repoRoot: REPO,
      path: PATH,
      branch: 'thread/fix-the-parser',
    });
    expect(named.branch).toBe('thread/fix-the-parser-2');
    expect(named.requested).toBe('thread/fix-the-parser');
  });

  it('keeps counting past the second collision', () => {
    const git = fakeGit('', nameAnswers(['thread/x', 'thread/x-2', 'thread/x-3']));
    expect(
      nameWorktreeBranch({ exec: git.exec, repoRoot: REPO, path: PATH, branch: 'thread/x' }).branch,
    ).toBe('thread/x-4');
  });

  it('never moves a branch that already exists — `-b`, not `-B`', () => {
    const git = fakeGit('', nameAnswers(['thread/x']));
    nameWorktreeBranch({ exec: git.exec, repoRoot: REPO, path: PATH, branch: 'thread/x' });
    expect(git.calls.some((call) => call.args.includes('-B'))).toBe(false);
  });

  it('is idempotent — a checkout already on a branch is left alone', () => {
    const git = fakeGit('', nameAnswers([], 'thread/already-named'));
    const named = nameWorktreeBranch({
      exec: git.exec,
      repoRoot: REPO,
      path: PATH,
      branch: 'thread/something-else',
    });
    expect(named).toEqual({ status: 'unchanged', branch: 'thread/already-named', path: PATH });
    expect(git.calls.some((call) => call.args[0] === 'checkout')).toBe(false);
  });

  it('refuses a name git would refuse, before git has to', () => {
    const git = fakeGit('', nameAnswers([]));
    expect(() =>
      nameWorktreeBranch({ exec: git.exec, repoRoot: REPO, path: PATH, branch: 'thread/../../etc' }),
    ).toThrow('is not a branch name');
    expect(git.calls).toEqual([]);
  });
});

describe('Task 2.5 — dependencies stop being the main checkout\'s', () => {
  const PATH = at(THREADS, THREAD);

  /** `git status --porcelain` for a worktree with the given lines. */
  function statusOf(...lines: string[]): (args: readonly string[]) => string | undefined {
    return (args) => (args[0] === 'status' ? lines.join('\n') : undefined);
  }

  it('sees every manifest kind, anywhere in the tree', () => {
    const git = fakeGit(
      '',
      statusOf(' M package.json', '?? app/package-lock.json', ' M src/app.ts', ' M Cargo.toml'),
    );
    expect(changedManifests(git.exec, PATH)).toEqual([
      'Cargo.toml',
      'app/package-lock.json',
      'package.json',
    ]);
  });

  it('reads a rename by the name that is now on disk', () => {
    const git = fakeGit('', statusOf('R  old.txt -> package.json'));
    expect(changedManifests(git.exec, PATH)).toEqual(['package.json']);
  });

  it('a clean worktree promotes nothing and installs nothing', () => {
    const git = fakeGit('', statusOf());
    const fake = fakeFs({ [at(PATH, 'node_modules')]: 'link' });
    const promoted = promoteDependencies({ exec: git.exec, path: PATH, fs: fake.fs });

    expect(promoted).toEqual({
      status: 'clean',
      manifests: [],
      installed: null,
      detached: false,
      detail: '',
    });
    expect(fake.removed).toEqual([]);
    expect(git.calls.every((call) => call.file === 'git')).toBe(true);
  });

  it('replaces the symlink BEFORE installing — an install through it writes into the user\'s checkout', () => {
    const git = fakeGit('', statusOf(' M package.json', ' M package-lock.json'));
    const fake = fakeFs({ [at(PATH, 'node_modules')]: 'link' });
    const promoted = promoteDependencies({ exec: git.exec, path: PATH, fs: fake.fs });

    expect(promoted.status).toBe('installed');
    expect(promoted.detached).toBe(true);
    expect(fake.removed).toEqual([at(PATH, 'node_modules')]);
    expect(git.calls).toContainEqual({ file: 'npm', args: ['install'], cwd: PATH });
  });

  it('picks the installer the lockfile names', () => {
    const pnpm = fakeGit('', statusOf(' M pnpm-lock.yaml'));
    expect(promoteDependencies({ exec: pnpm.exec, path: PATH, fs: fakeFs().fs }).installed).toEqual([
      'pnpm',
      'install',
    ]);
    const yarn = fakeGit('', statusOf(' M yarn.lock'));
    expect(promoteDependencies({ exec: yarn.exec, path: PATH, fs: fakeFs().fs }).installed).toEqual([
      'yarn',
      'install',
    ]);
  });

  it('a real node_modules is left alone — a previous promotion\'s work is not undone', () => {
    const git = fakeGit('', statusOf(' M package.json'));
    const fake = fakeFs({ [at(PATH, 'node_modules')]: 'dir' });
    const promoted = promoteDependencies({ exec: git.exec, path: PATH, fs: fake.fs });
    expect(promoted.detached).toBe(false);
    expect(fake.removed).toEqual([]);
  });

  it('another ecosystem\'s manifest is reported, never installed on a guess', () => {
    const git = fakeGit('', statusOf(' M requirements.txt'));
    const fake = fakeFs({ [at(PATH, 'node_modules')]: 'link' });
    const promoted = promoteDependencies({ exec: git.exec, path: PATH, fs: fake.fs });

    expect(promoted.status).toBe('manual');
    expect(promoted.manifests).toEqual(['requirements.txt']);
    expect(promoted.detail).toContain('requirements.txt');
    expect(fake.removed).toEqual([]);
    expect(git.calls.every((call) => call.file === 'git')).toBe(true);
  });
});

// ── The folder's name is not the thread's id ────────────────────────────────
//
// A worktree is a directory and a branch is a ref, and this file minted both
// from the thread's slug — so a person's shell prompt read
// `e2265b48-03e9-43e3-8f76-ff887a48615e` and an attached project's Source
// Control read `worktree/e2265b48-…` (user, 2026-09-17: "we should have two dif
// things, one is branch, and another is worktree").
describe('threadWorktreePath — the folder is named, not identified', () => {
  it('puts the checkout where the NAME says', () => {
    expect(threadWorktreePath('/repos/orbit-app', 'e2265b48-03e9', 'data-contract-guard')).toBe(
      '/repos/.orbit-app-threads/data-contract-guard',
    );
  });

  it('reproduces the old path exactly when nobody names it', () => {
    // Every caller written before this meant the slug, and the byte-for-byte
    // sameness is what lets them keep working through the change.
    const id = 'e2265b48-03e9-43e3-8f76-ff887a48615e';
    expect(threadWorktreePath('/repos/orbit-app', id)).toBe(
      `/repos/.orbit-app-threads/${id}`,
    );
    expect(threadWorktreePath('/repos/orbit-app', id, '   ')).toBe(
      `/repos/.orbit-app-threads/${id}`,
    );
  });

  it('refuses a name that could steer the path out of its container', () => {
    // The grammar check IS the traversal check. A checkout is named
    // `worktree/<name>` now, so ONE nested level is legal — and every segment
    // is still held to the same rule, which is what keeps the guard as strong
    // as it was in its single-segment shape.
    for (const bad of ['../escape', 'a/b/c', 'UPPER', '.hidden', 'a//b', '/a', 'a/', '../a']) {
      expect(() => threadWorktreePath('/repos/orbit-app', 'abc', bad)).toThrow();
    }
    expect(threadWorktreePath('/repos/orbit-app', 'abc', 'worktree/parser')).toBe(
      '/repos/.orbit-app-threads/worktree/parser',
    );
  });
});

describe('the branch a cut lands on is never a thread id', () => {
  const uuid = 'e2265b48-03e9-43e3-8f76-ff887a48615e';

  it('names the branch after the WORKTREE, not the thread', () => {
    // THE REGRESSION THAT STARTED THE WORK. An attached project's checkout was
    // created with no branch and no detach, so it fell back to
    // `threadBranch(thread)` and landed on `worktree/<uuid>` — a thread id in a
    // person's Source Control panel, for a decision nobody made.
    const git = fakeGit(porcelain(), threadAnswers());
    resolveThreadWorktree({
      exec: git.exec,
      repoRoot: REPO,
      thread: uuid,
      worktreeName: 'data-contract-guard',
      fs: fakeFs().fs,
    });
    const argv = git.calls.map((call) => call.args.join(' ')).join(' | ');
    expect(argv).toContain('worktree/data-contract-guard');
    expect(argv).not.toContain(uuid);
  });

  it('still falls back to the thread when nobody named anything', () => {
    // The old behaviour, byte for byte, for every caller written before this.
    const git = fakeGit(porcelain(), threadAnswers());
    resolveThreadWorktree({ exec: git.exec, repoRoot: REPO, thread: THREAD, fs: fakeFs().fs });
    const argv = git.calls.map((call) => call.args.join(' ')).join(' | ');
    expect(argv).toContain(`worktree/${THREAD}`);
  });
});
