/**
 * Tests for `planflow-ai worktree <verb>` — the thread-facing door onto the
 * worktree machinery.
 *
 * TWO LAYERS, EACH FOR WHAT ONLY IT CAN PROVE (the `loop.test.ts` shape):
 *
 *   (1) SUBPROCESS E2E against a REAL git repository in a throwaway temp
 *       directory. This is the only layer that can prove the verb is
 *       registered, that a refusal is ONE `worktree refused:` line on the
 *       COMBINED transcript (allowed-pattern #15 — this repo's logger routes
 *       error() through console.log), that the exit code is 1, and that a
 *       created worktree is a thing that exists on disk with the untracked set
 *       linked into it. E2E-first (allowed-pattern #7): the verb is exercised
 *       the way its caller will exercise it, not simulated.
 *
 *   (2) IN-PROCESS, calling `runWorktree` with an injected exec and an injected
 *       filesystem. This is the only layer that can prove the argv git is
 *       handed, and the refusals that must happen BEFORE anything is created.
 *
 * NOTHING HERE TOUCHES THIS REPOSITORY. The E2E fixture is its own git repo
 * under `mkdtemp`, and its worktree container is a sibling inside the same temp
 * directory, so the whole fixture is removed by one `rmSync`.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');
const { runWorktree } = await import('./worktree.js');
const { threadWorktreePath, threadWorktreeRoot, pruneThreadWorktree } = await import(
  '../loop/worktree.js'
);

type WorktreeOptions = Parameters<typeof runWorktree>[1];
type WorktreeRuntime = Parameters<typeof runWorktree>[2];
type WorktreeFs = import('../loop/worktree.js').WorktreeFs;

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const E2E_TIMEOUT_MS = 120_000;

/** A thread's slug is its uuid, which the owner grammar already accepts. */
const THREAD = '7f3a9c21-4d5e-4b8a-9c0f-1e2d3a4b5c6d';

/**
 * The branch from the reported failure, spelled the way the user's was: long,
 * remote-tracked, and carrying commits that had never left their machine.
 */
const FEATURE_BRANCH = 'ACME-2446-rework-the-session-cache-for-the-new-router';
const REPO = '/Users/dev/Projects/plan-flow';
const THREADS = '/Users/dev/Projects/.plan-flow-threads';

// ── in-process invocation ────────────────────────────────

interface Invocation {
  stdout: string;
  /** Everything the logger wrote (refusals included). */
  logged: string[];
  /** Just the `worktree refused:` lines. */
  refusals: string[];
  exitCode: number;
  /** stdout parsed as JSON, or null when nothing parseable was printed. */
  json: Record<string, unknown> | null;
}

/** An exec that always fails — the default, so no test can shell out by accident. */
const REFUSING_EXEC = (file: string): string => {
  throw new Error(`test exec: refusing to run '${file}'`);
};

type StdoutLike = { write: (chunk: unknown) => boolean };

/** Call a verb in-process, capturing stdout, the logger and the exit code. */
function invoke(
  verb: string,
  options: Partial<WorktreeOptions> = {},
  runtime: WorktreeRuntime = {},
): Invocation {
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
    runWorktree(verb, { target: REPO, json: true, ...options } as WorktreeOptions, {
      exec: REFUSING_EXEC,
      ...runtime,
    });
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
    logged,
    refusals: logged.filter((line) => line.includes('worktree refused:')),
    exitCode,
    json,
  };
}

/** A recording fake git, answering `worktree list` with the given porcelain. */
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

/** Canned answers for a healthy repo: a commit, a default branch, a clean tree. */
function healthyRepo(
  head = 'HEAD',
  opts: { noRepo?: boolean; unborn?: boolean } = {},
): (args: readonly string[]) => string | undefined {
  return (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
      if (opts.noRepo) throw new Error('fatal: not a git repository');
      return '.git';
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
      if (opts.unborn || opts.noRepo) throw new Error('fatal: Needed a single revision');
      return 'abc123';
    }
    if (args[0] === 'symbolic-ref') return 'origin/main';
    if (args[0] === 'status') return '';
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return head;
    if (args[0] === 'rev-parse') return 'abc123';
    return undefined;
  };
}

/** A filesystem where nothing exists and every link is recorded. */
function fakeFs(): { fs: WorktreeFs; made: string[] } {
  const made: string[] = [];
  return {
    made,
    fs: {
      readDir: () => [],
      exists: () => false,
      isDirectory: () => false,
      isSymlink: () => false,
      symlink: (_target, path) => {
        made.push(path);
      },
      unlink: () => undefined,
      removeDir: () => undefined,
    },
  };
}

/** Porcelain for a main checkout plus any extra worktrees. */
function porcelain(extra: { path: string; branch?: string }[] = []): string {
  const blocks = [`worktree ${REPO}\nHEAD abc123\nbranch refs/heads/main\n`];
  for (const entry of extra) {
    blocks.push(
      `worktree ${entry.path}\nHEAD def456\n${
        entry.branch === undefined ? 'detached' : `branch refs/heads/${entry.branch}`
      }\n`,
    );
  }
  return blocks.join('\n');
}

describe('Task 2.2 — the verb, in process', () => {
  it('creates a detached checkout for a thread', () => {
    const git = fakeGit(porcelain(), healthyRepo());
    const result = invoke('create', { thread: THREAD, detach: true }, { exec: git.exec, fs: fakeFs().fs });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      status: 'created',
      thread: THREAD,
      path: `${THREADS}/${THREAD}`,
      branch: null,
    });
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'add', '--detach', `${THREADS}/${THREAD}`],
      cwd: REPO,
    });
  });

  it('refuses a non-git directory with one line, exit 1, and nothing created', () => {
    const git = fakeGit(porcelain(), healthyRepo('HEAD', { noRepo: true }));
    const result = invoke('create', { thread: THREAD, detach: true }, { exec: git.exec, fs: fakeFs().fs });

    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('is not a git repository');
    expect(result.stdout).toBe('');
    expect(git.calls.some((call) => call.args[1] === 'add')).toBe(false);
  });

  it('refuses an unborn branch the same way — there is no commit to start from', () => {
    const git = fakeGit(porcelain(), healthyRepo('HEAD', { unborn: true }));
    const result = invoke('create', { thread: THREAD, detach: true }, { exec: git.exec, fs: fakeFs().fs });

    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('no commits yet');
    expect(git.calls.some((call) => call.args[1] === 'add')).toBe(false);
  });

  it('refuses a verb it does not know, naming the ones it does', () => {
    const result = invoke('resurrect', { thread: THREAD });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('create|prune|list|name|promote');
  });

  it('refuses a create with no thread', () => {
    const result = invoke('create', {});
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('create requires --thread');
  });

  it('starts from the branch it was given, and never asks the repo for its trunk', () => {
    const git = fakeGit(porcelain(), healthyRepo('ACME-2446'));
    const result = invoke(
      'create',
      { thread: THREAD, detach: true, base: 'ACME-2446' },
      { exec: git.exec, fs: fakeFs().fs },
    );

    expect(result.exitCode).toBe(0);
    expect(git.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'add', '--detach', `${THREADS}/${THREAD}`, 'ACME-2446'],
      cwd: REPO,
    });
    // The trunk lookup is a LOOP's question. A thread never asks it unless the
    // person asked for the trunk by name.
    expect(git.calls.some((call) => call.args.includes('symbolic-ref'))).toBe(false);
    // And nothing is fast-forwarded to the remote: the local tip IS the answer.
    expect(git.calls.some((call) => call.args[0] === 'fetch')).toBe(false);
    expect(result.json).toMatchObject({ base: 'ACME-2446', baseMode: 'branch', onBase: false });
  });

  it('asks the repository for its trunk only when the trunk was asked for', () => {
    // `HEAD` here is the DETACHED worktree's answer, which is what the refresh
    // reads — the trunk start is the only one that refreshes at all.
    const git = fakeGit(porcelain(), healthyRepo());
    const result = invoke(
      'create',
      { thread: THREAD, detach: true, trunk: true },
      { exec: git.exec, fs: fakeFs().fs },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ base: 'main', baseMode: 'trunk' });
    // Today's behaviour, kept and reachable: the trunk start is the one that
    // brings the checkout up to `origin/<trunk>`.
    expect(git.calls.some((call) => call.args.includes('origin/main'))).toBe(true);
  });

  it('lists only the thread worktrees — the loops and the main checkout are not worktrees', () => {
    const git = fakeGit(
      porcelain([
        { path: `${THREADS}/${THREAD}` },
        { path: '/Users/dev/Projects/.plan-flow-loops/fix', branch: 'loop/fix' },
      ]),
    );
    const result = invoke('list', {}, { exec: git.exec });

    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({
      status: 'listed',
      root: THREADS,
      worktrees: [
        {
          thread: THREAD,
          path: `${THREADS}/${THREAD}`,
          branch: null,
          head: 'def456',
          locked: false,
          prunable: false,
          // A detached worktree has no branch to carry an upstream, so it is
          // unbound without git being asked (Task 2.5).
          remote: null,
          remoteBranch: null,
          bound: false,
        },
      ],
    });
  });

  it('renders the same object for a person when --json is absent', () => {
    const git = fakeGit(porcelain([{ path: `${THREADS}/${THREAD}`, branch: 'thread/x' }]));
    const result = invoke('list', { json: false }, { exec: git.exec });
    expect(result.stdout.trim()).toBe(`${THREADS}/${THREAD} [thread/x]`);
  });

  it('prunes the checkout and keeps the branch', () => {
    const git = fakeGit(porcelain([{ path: `${THREADS}/${THREAD}`, branch: 'thread/x' }]));
    const result = invoke('prune', { thread: THREAD }, { exec: git.exec });

    expect(result.json).toEqual({ status: 'pruned', thread: THREAD, path: `${THREADS}/${THREAD}` });
    expect(git.calls.some((call) => call.args.includes('-D'))).toBe(false);
  });

  /**
   * #1797 — `worktree remove --force` defeats git's own refusal to delete a
   * checkout with modified or untracked files. This verb passed it on EVERY
   * prune, inspected nothing first, and answered `{"status":"pruned"}` with exit
   * 0 whether the directory held an hour of somebody's work or nothing at all.
   *
   * The programmatic guard was already there and is not what was missing:
   * `confirmed` asks "did a person type this verb", and the CLI answers yes
   * because someone did. But a person who typed `worktree prune` consented to
   * REMOVING A WORKTREE, not to discarding two files they never committed.
   * Those are different sentences, and only the code knew they were the same
   * act — so there is now a second consent for the second sentence.
   */
  describe('a prune cannot silently take work that exists nowhere else (#1797)', () => {
    /** A checkout whose `git status --porcelain` answers with `dirt`. */
    function dirtyCheckout(dirt: string): ReturnType<typeof fakeGit> {
      return fakeGit(porcelain([{ path: `${THREADS}/${THREAD}`, branch: 'thread/x' }]), (args) =>
        args[0] === 'status' ? dirt : undefined,
      );
    }

    /** Every argv the run handed to git, flat. */
    function removed(git: ReturnType<typeof fakeGit>): boolean {
      return git.calls.some((call) => call.args.includes('remove'));
    }

    it('refuses a dirty checkout, names what is in the way, and deletes nothing', () => {
      const git = dirtyCheckout(' M a.txt\n?? important.txt\n');
      const result = invoke('prune', { thread: THREAD }, { exec: git.exec, fs: fakeFs().fs });

      expect(result.exitCode).toBe(1);
      expect(result.refusals.join('\n')).toContain('M a.txt, ?? important.txt');
      // A refusal that still deletes is the exact wrong-but-valid removal this
      // exists to stop (allowed-pattern #24) — so the argv is checked too.
      expect(removed(git)).toBe(false);
    });

    it('discards on a SECOND consent, and says what it took', () => {
      const git = dirtyCheckout(' M a.txt\n?? important.txt\n');
      const result = invoke(
        'prune',
        { thread: THREAD, discard: true },
        { exec: git.exec, fs: fakeFs().fs },
      );

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        status: 'pruned',
        discarded: ['M a.txt', '?? important.txt'],
      });
      expect(removed(git)).toBe(true);
    });

    it('a clean checkout prunes exactly as it always has — no new key', () => {
      // The shape downstream reads is unchanged when there was nothing to lose,
      // so `pruned` stops meaning two different things without anything having
      // to learn a third.
      const git = dirtyCheckout('');
      const result = invoke('prune', { thread: THREAD }, { exec: git.exec, fs: fakeFs().fs });

      expect(result.json).toEqual({ status: 'pruned', thread: THREAD, path: `${THREADS}/${THREAD}` });
      expect(result.json).not.toHaveProperty('discarded');
    });

    it('does not count the dependencies plan-flow linked in itself', () => {
      // EVERY thread worktree has the untracked set linked into it, and a
      // repository that does not gitignore `node_modules` reports each link as
      // `??`. Counting them would make this guard refuse every worktree that
      // has dependencies — which is all of them, and exactly how the refresh
      // guard failed before #1650. Deleting a link destroys nothing: the target
      // is in the main checkout and outlives the prune.
      const git = dirtyCheckout('?? node_modules/\n?? .env\n');
      const links = fakeFs();
      const result = invoke(
        'prune',
        { thread: THREAD },
        { exec: git.exec, fs: { ...links.fs, isSymlink: () => true } },
      );

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ status: 'pruned' });
      expect(result.json).not.toHaveProperty('discarded');
    });

    it('still blocks on a real file sitting beside the links', () => {
      // The symlink exemption is about what SURVIVES the delete, not about
      // untracked entries in general — one real file among the links is still
      // work that exists nowhere else.
      const git = dirtyCheckout('?? node_modules/\n?? important.txt\n');
      const result = invoke(
        'prune',
        { thread: THREAD },
        {
          exec: git.exec,
          fs: { ...fakeFs().fs, isSymlink: (path: string) => path.endsWith('node_modules') },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.refusals.join('\n')).toContain('?? important.txt');
      expect(result.refusals.join('\n')).not.toContain('node_modules');
      expect(removed(git)).toBe(false);
    });

    it('keeps the programmatic guard: a caller that says nothing still gets nothing', () => {
      // `confirmed` is the OTHER gate and it is untouched — the incident behind
      // forbidden-pattern #15 was a test calling a destructive function it
      // believed was inert, and that path must stay closed.
      expect(() =>
        pruneThreadWorktree({
          exec: fakeGit(porcelain()).exec,
          repoRoot: REPO,
          thread: THREAD,
          confirmed: false,
        }),
      ).toThrow('needs an explicit confirmation');
    });
  });
});

describe('Task 2.4 — naming, in process', () => {
  it('refuses to name a thread that has no worktree', () => {
    const git = fakeGit(porcelain());
    const result = invoke('name', { thread: THREAD, branch: 'thread/x' }, { exec: git.exec });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('has no worktree to name');
  });

  it('refuses a name with no branch', () => {
    const result = invoke('name', { thread: THREAD });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('name requires --branch');
  });

  it('names a detached worktree without refreshing it', () => {
    const git = fakeGit(porcelain([{ path: `${THREADS}/${THREAD}` }]), (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'HEAD';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('exit 1');
      return undefined;
    });
    const result = invoke('name', { thread: THREAD, branch: 'thread/fix-the-parser' }, { exec: git.exec });

    expect(result.json).toMatchObject({ status: 'named', branch: 'thread/fix-the-parser', thread: THREAD });
    // A rename is not a refresh: no fetch, no merge.
    expect(git.calls.some((call) => ['fetch', 'merge'].includes(call.args[0]))).toBe(false);
  });
});

describe('Task 2.5 — promotion, reachable as a verb', () => {
  it('refuses a thread with no worktree', () => {
    const git = fakeGit(porcelain());
    const result = invoke('promote', { thread: THREAD }, { exec: git.exec });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('no worktree whose dependencies');
  });

  it('reports a clean worktree and installs nothing', () => {
    const git = fakeGit(porcelain([{ path: `${THREADS}/${THREAD}` }]), (args) =>
      args[0] === 'status' ? '' : undefined,
    );
    const result = invoke('promote', { thread: THREAD }, { exec: git.exec });
    expect(result.json).toMatchObject({ status: 'clean', thread: THREAD, installed: null });
    expect(git.calls.every((call) => call.file === 'git')).toBe(true);
  });

  it('replaces the link and installs when a manifest changed', () => {
    const git = fakeGit(porcelain([{ path: `${THREADS}/${THREAD}` }]), (args) =>
      args[0] === 'status' ? ' M package.json\n M package-lock.json' : undefined,
    );
    const linked: WorktreeFs = { ...fakeFs().fs, isSymlink: () => true, unlink: () => undefined };
    const result = invoke('promote', { thread: THREAD }, { exec: git.exec, fs: linked });

    expect(result.json).toMatchObject({ status: 'installed', detached: true });
    expect(git.calls).toContainEqual({
      file: 'npm',
      args: ['install'],
      cwd: `${THREADS}/${THREAD}`,
    });
  });
});

// ── subprocess E2E against a real git repository ─────────

interface CliRun {
  stdout: string;
  stderr: string;
  combined: string;
  status: number | null;
}

describe('Task 6.0 — --here, the checkout that is not a thread worktree', () => {
  /** A checkout on FEATURE_BRANCH, bound to origin/release/chat, never pushed. */
  function boundHere(): (args: readonly string[]) => string | undefined {
    return (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return FEATURE_BRANCH;
      if (args[0] === 'config' && args[1] === '--get') {
        if (args[2] === `branch.${FEATURE_BRANCH}.remote`) return 'origin';
        if (args[2] === `branch.${FEATURE_BRANCH}.merge`) return 'refs/heads/release/chat';
        throw new Error('fatal: no such key');
      }
      if (args[0] === 'remote') return 'origin\n';
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        throw new Error('fatal: no such ref');
      }
      return undefined;
    };
  }

  it('refuses a push that names both a thread and this checkout', () => {
    const git = fakeGit(porcelain(), boundHere());
    const result = invoke('push', { thread: THREAD, here: true }, { exec: git.exec });

    expect(result.exitCode).toBe(1);
    expect(result.refusals.join('\n')).toContain('never both');
    expect(git.calls.some((call) => call.args[0] === 'push')).toBe(false);
  });

  it('refuses a push that names neither, and says both doors', () => {
    const git = fakeGit(porcelain(), boundHere());
    const result = invoke('push', {}, { exec: git.exec });

    expect(result.exitCode).toBe(1);
    expect(result.refusals.join('\n')).toContain('--here');
    expect(git.calls.some((call) => call.args[0] === 'push')).toBe(false);
  });

  it('pushes the checkout\'s own branch by refspec, with no thread on the result', () => {
    const git = fakeGit(porcelain(), boundHere());
    const result = invoke('push', { here: true }, { exec: git.exec });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      status: 'pushed',
      thread: null,
      branch: FEATURE_BRANCH,
      remote: 'origin',
      remoteBranch: 'release/chat',
      pushed: true,
    });
    const push = git.calls.find((call) => call.args[0] === 'push');
    expect(push?.args).toEqual(['push', 'origin', `${FEATURE_BRANCH}:release/chat`]);
    expect(push?.cwd).toBe(REPO);
  });

  describe('--pr-base on a --here bind (#1834)', () => {
    // `--pr-base` was accepted, echoed back in `bound: … onto <prBase>`, and
    // dropped: `writeBinding` deliberately writes only the two keys git owns,
    // and a plain checkout has no thread store to be the base's home. The next
    // `pr --here` then fell through to the project's `branch:` key and opened
    // against a base the person had explicitly not chosen — exit 0, reported as
    // success.

    it('refuses the flag rather than reporting it as recorded', () => {
      const git = fakeGit(porcelain(), boundHere());
      const result = invoke(
        'bind',
        { here: true, remote: 'origin', branch: 'release/chat', prBase: 'develop' },
        { exec: git.exec },
      );

      expect(result.exitCode).toBe(1);
      expect(result.refusals.join('\n')).toContain('--pr-base cannot be recorded by a --here bind');
    });

    it('writes NOTHING when it refuses', () => {
      // A loud refusal that binds anyway is the same wrong-but-quiet state.
      const git = fakeGit(porcelain(), boundHere());
      invoke(
        'bind',
        { here: true, remote: 'origin', branch: 'release/chat', prBase: 'develop' },
        { exec: git.exec },
      );

      expect(git.calls.filter((call) => call.args[0] === 'config')).toEqual([]);
    });

    it('still binds when the flag is absent', () => {
      // The refusal must be about the FLAG, not about --here.
      const git = fakeGit(porcelain(), boundHere());
      const result = invoke(
        'bind',
        { here: true, remote: 'origin', branch: 'release/chat' },
        { exec: git.exec },
      );

      expect(result.exitCode).toBe(0);
      expect(
        git.calls.some(
          (call) => call.args[0] === 'config' && call.args[1] === `branch.${FEATURE_BRANCH}.remote`,
        ),
      ).toBe(true);
    });

    it('refuses BEFORE it looks at the repository at all', () => {
      // Cheapest possible refusal, and the reason it writes nothing: the flag
      // is wrong regardless of what the checkout turns out to be.
      const git = fakeGit(porcelain(), boundHere());
      invoke(
        'bind',
        { here: true, remote: 'origin', branch: 'release/chat', prBase: 'develop' },
        { exec: git.exec },
      );

      expect(git.calls).toEqual([]);
    });
  });

  it('refuses a detached checkout with the reason a detached worktree gets', () => {
    const git = fakeGit(porcelain(), (args) =>
      args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? 'HEAD' : undefined,
    );
    const result = invoke('bind', { here: true, remote: 'origin', branch: 'release/chat' }, { exec: git.exec });

    expect(result.exitCode).toBe(1);
    expect(result.refusals.join('\n')).toContain('is not on a branch yet');
  });
});

describe('worktree E2E — real CLI subprocess, real git, throwaway repo', () => {
  let sandbox: string;
  let repo: string;

  /** Run git in a fixture directory. Fails loudly — a broken fixture is not a test result. */
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  function run(...args: string[]): CliRun {
    const result = spawnSync(process.execPath, [TSX_BIN, CLI_ENTRY, 'worktree', ...args], {
      encoding: 'utf-8',
      timeout: E2E_TIMEOUT_MS,
      // The fixture, never this repo — and `--target` says so explicitly too.
      cwd: sandbox,
    });
    if (result.error) throw result.error;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return { stdout, stderr, combined: `${stdout}\n${stderr}`, status: result.status };
  }

  beforeEach(() => {
    // `realpathSync`, because macOS hands out `/var/folders/...` for a
    // directory git will report as `/private/var/folders/...` — the mismatch the
    // command canonicalizes away, and which the fixture must not reintroduce.
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'planflow-worktree-')));
    repo = join(sandbox, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '--initial-branch=main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'first');
    // The untracked set: a dependency directory and a secret, neither tracked.
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'marker.txt'), 'from the main checkout\n');
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it(
    "starts from the branch the main checkout is on — unpushed commits and all",
    () => {
      // THE REPORTED FAILURE, REBUILT. A person on a feature branch with two
      // commits they had not pushed opened a thread to help with it. The
      // worktree was cut from the repository's TRUNK, so the agent could see
      // neither their branch nor those two commits, and spent the session
      // reconstructing the work from `origin/*` — which is the only place the
      // old default could look.
      //
      // A REMOTE IS PART OF THE FIXTURE, not decoration: without one the old
      // trunk default failed to resolve `origin/main` and fell back to leaving
      // the tree where it was, so a remoteless repo cannot tell the two
      // behaviours apart.
      const origin = join(sandbox, 'origin.git');
      git(sandbox, 'init', '--bare', '--initial-branch=main', origin);
      git(repo, 'remote', 'add', 'origin', origin);
      git(repo, 'push', '-u', 'origin', 'main');

      git(repo, 'checkout', '-b', FEATURE_BRANCH);
      writeFileSync(join(repo, 'engine.ts'), 'pushed\n');
      git(repo, 'add', 'engine.ts');
      git(repo, 'commit', '-m', 'pushed work');
      git(repo, 'push', '-u', 'origin', FEATURE_BRANCH);

      // The two commits that exist ONLY on this computer.
      writeFileSync(join(repo, 'engine.ts'), 'pushed\nlocal one\n');
      git(repo, 'commit', '-am', 'local commit one');
      writeFileSync(join(repo, 'engine.ts'), 'pushed\nlocal one\nlocal two\n');
      git(repo, 'commit', '-am', 'local commit two');
      const tip = git(repo, 'rev-parse', 'HEAD').trim();

      const created = run('create', '--thread', THREAD, '--detach', '--no-fetch', '--json', '--target', repo);
      expect(created.status).toBe(0);
      const result = JSON.parse(created.stdout.trim()) as {
        path: string;
        base: string | null;
        baseMode: string;
        onBase: boolean;
      };

      // Where the work belongs is the branch the person was on, recorded so a
      // landing puts it back there rather than on the trunk.
      expect(result.base).toBe(FEATURE_BRANCH);
      expect(result.baseMode).toBe('here');
      expect(result.onBase).toBe(false);

      // And the checkout is AT that branch's tip — both unpushed commits with it.
      const path = result.path;
      expect(git(path, 'rev-parse', 'HEAD').trim()).toBe(tip);
      expect(readFileSync(join(path, 'engine.ts'), 'utf-8')).toBe('pushed\nlocal one\nlocal two\n');
      expect(git(path, 'log', '--format=%s', '-3')).toContain('local commit two');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "still cuts from the up-to-date trunk when the trunk is what was asked for",
    () => {
      const origin = join(sandbox, 'origin.git');
      git(sandbox, 'init', '--bare', '--initial-branch=main', origin);
      git(repo, 'remote', 'add', 'origin', origin);
      git(repo, 'push', '-u', 'origin', 'main');
      const trunkTip = git(repo, 'rev-parse', 'HEAD').trim();

      git(repo, 'checkout', '-b', FEATURE_BRANCH);
      writeFileSync(join(repo, 'engine.ts'), 'only on the branch\n');
      git(repo, 'add', 'engine.ts');
      git(repo, 'commit', '-m', 'branch work');

      const created = run(
        'create', '--thread', THREAD, '--detach', '--trunk', '--no-fetch', '--json', '--target', repo,
      );
      expect(created.status).toBe(0);
      const result = JSON.parse(created.stdout.trim()) as { path: string; base: string | null };

      expect(result.base).toBe('main');
      expect(git(result.path, 'rev-parse', 'HEAD').trim()).toBe(trunkTip);
      expect(existsSync(join(result.path, 'engine.ts'))).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'takes a branch nothing else has open, so its commits land on it directly',
    () => {
      git(repo, 'branch', FEATURE_BRANCH);
      const branchTip = git(repo, 'rev-parse', FEATURE_BRANCH).trim();

      const created = run(
        'create', '--thread', THREAD, '--checkout', FEATURE_BRANCH, '--no-fetch', '--json', '--target', repo,
      );
      expect(created.status).toBe(0);
      const result = JSON.parse(created.stdout.trim()) as {
        path: string;
        branch: string | null;
        base: string | null;
        onBase: boolean;
      };

      // The worktree IS on that branch: branch and base are the same name,
      // which is the whole signal that there is nothing to merge back.
      expect(result.branch).toBe(FEATURE_BRANCH);
      expect(result.base).toBe(FEATURE_BRANCH);
      expect(result.onBase).toBe(true);
      expect(git(result.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(FEATURE_BRANCH);
      // Taken as it stands — the branch tip did not move to make room for it.
      expect(git(repo, 'rev-parse', FEATURE_BRANCH).trim()).toBe(branchTip);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'brings down a branch that exists only on the remote, and works on it',
    () => {
      const origin = join(sandbox, 'origin.git');
      git(sandbox, 'init', '--bare', '--initial-branch=main', origin);
      git(repo, 'remote', 'add', 'origin', origin);
      git(repo, 'push', '-u', 'origin', 'main');
      git(repo, 'checkout', '-b', FEATURE_BRANCH);
      writeFileSync(join(repo, 'engine.ts'), 'from the remote\n');
      git(repo, 'add', 'engine.ts');
      git(repo, 'commit', '-m', 'remote work');
      git(repo, 'push', '-u', 'origin', FEATURE_BRANCH);
      // Nobody has it locally any more — it exists on the remote and nowhere else.
      git(repo, 'checkout', 'main');
      git(repo, 'branch', '-D', FEATURE_BRANCH);

      const created = run(
        'create', '--thread', THREAD, '--checkout', FEATURE_BRANCH, '--no-fetch', '--json', '--target', repo,
      );
      expect(created.status).toBe(0);
      const result = JSON.parse(created.stdout.trim()) as {
        path: string;
        branch: string | null;
        base: string | null;
        onBase: boolean;
      };

      expect(result).toMatchObject({ branch: FEATURE_BRANCH, base: FEATURE_BRANCH, onBase: true });
      expect(git(result.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(FEATURE_BRANCH);
      expect(readFileSync(join(result.path, 'engine.ts'), 'utf-8')).toBe('from the remote\n');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'refuses to take a branch the project itself has open, and says what does work',
    () => {
      // The user's own case: they are ON the branch, so git cannot hand it to a
      // second checkout. Refused BEFORE anything is created, in one line.
      git(repo, 'checkout', '-b', FEATURE_BRANCH);
      const result = run(
        'create', '--thread', THREAD, '--checkout', FEATURE_BRANCH, '--no-fetch', '--json', '--target', repo,
      );

      expect(result.status).toBe(1);
      expect(result.combined).toContain('worktree refused:');
      expect(result.combined).toContain('already open in another checkout');
      expect(result.combined).toContain('start a new branch from its tip');
      expect(existsSync(threadWorktreePath(repo, THREAD))).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'reports the branches a worktree could start from, and which are spoken for',
    () => {
      git(repo, 'branch', FEATURE_BRANCH);
      git(repo, 'checkout', '-b', 'other-work');

      const listed = run('branches', '--json', '--target', repo);
      expect(listed.status).toBe(0);
      const result = JSON.parse(listed.stdout.trim()) as {
        current: string | null;
        branches: { name: string; current: boolean; heldBy: string | null; canCheckOut: boolean }[];
      };

      expect(result.current).toBe('other-work');
      // The branch the project has open is reported as spoken for, from git's
      // own listing — never guessed from a path.
      const here = result.branches.find((branch) => branch.name === 'other-work');
      expect(here).toMatchObject({ current: true, canCheckOut: false });
      expect(here?.heldBy).toBe(repo);
      // And one nothing holds can be taken outright.
      expect(result.branches.find((branch) => branch.name === FEATURE_BRANCH)).toMatchObject({
        current: false,
        heldBy: null,
        canCheckOut: true,
      });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'says nothing on stderr when it succeeds, in a repo with no remote (#1798)',
    () => {
      // THE ORDINARY CASE, NOT AN EDGE. Several verbs probe git for facts that
      // are legitimately absent — `origin/HEAD` here, a remote-tracking ref that
      // was never pushed — catch the failure and carry on correctly. The child
      // inherited this process's stderr, so git had printed `fatal:` three times
      // before the catch ran, and a `--json` caller following this repo's own
      // convention of reading the COMBINED transcript (allowed-patterns #15,
      // #24) saw them beside a successful result.
      //
      // The fixture has no remote, which is every fresh `git init` project — a
      // new user's first one.
      expect(run('create', '--thread', THREAD, '--detach', '--no-fetch', '--json', '--target', repo).status).toBe(0);
      const listed = run('branches', '--json', '--target', repo);

      expect(listed.status).toBe(0);
      expect(listed.stderr).toBe('');
      // …and the result itself is untouched: quiet is not the same as empty.
      expect(JSON.parse(listed.stdout.trim())).toMatchObject({ status: 'listed' });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'creates a worktree on disk with the untracked set linked in, then names, lists and prunes it',
    () => {
      const created = run('create', '--thread', THREAD, '--detach', '--no-fetch', '--json', '--target', repo);
      expect(created.status).toBe(0);
      const path = threadWorktreePath(repo, THREAD);
      expect(JSON.parse(created.stdout.trim())).toMatchObject({
        status: 'created',
        thread: THREAD,
        path,
        branch: null,
      });

      // It is a real checkout — tracked files present, and beside the repo.
      expect(existsSync(join(path, 'README.md'))).toBe(true);
      expect(path.startsWith(`${repo}/`)).toBe(false);
      expect(threadWorktreeRoot(repo)).toBe(join(sandbox, '.repo-threads'));

      // The untracked set: dependencies LINKED, secrets COPIED.
      expect(lstatSync(join(path, 'node_modules')).isSymbolicLink()).toBe(true);
      // `.env` is the worktree's OWN file now. Linked, an agent told to add a
      // key edited the user's real `.env` — and containment could not catch it,
      // because every check in the app is lexical and the path IS lexically
      // inside the worktree. The content still arrives, which is the half that
      // had to keep working.
      expect(lstatSync(join(path, '.env')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1\n');
      writeFileSync(join(path, '.env'), 'SECRET=2\n');
      expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('SECRET=1\n');
      writeFileSync(join(path, '.env'), 'SECRET=1\n');

      // Naming it after the fact gives it the branch its title earned.
      const named = run('name', '--thread', THREAD, '--branch', 'thread/fix-the-parser', '--json', '--target', repo);
      expect(named.status).toBe(0);
      expect(JSON.parse(named.stdout.trim())).toMatchObject({
        status: 'named',
        branch: 'thread/fix-the-parser',
      });
      expect(git(repo, 'branch', '--list', 'thread/fix-the-parser')).toContain('thread/fix-the-parser');

      // …and naming again is a no-op, because the app calls it after every turn.
      const again = run('name', '--thread', THREAD, '--branch', 'thread/something-else', '--json', '--target', repo);
      expect(JSON.parse(again.stdout.trim())).toMatchObject({
        status: 'unchanged',
        branch: 'thread/fix-the-parser',
      });

      const listed = run('list', '--json', '--target', repo);
      expect(JSON.parse(listed.stdout.trim())).toMatchObject({
        status: 'listed',
        worktrees: [{ thread: THREAD, path, branch: 'thread/fix-the-parser' }],
      });

      // Pruning reclaims the checkout and KEEPS the branch — the record survives.
      const pruned = run('prune', '--thread', THREAD, '--json', '--target', repo);
      expect(pruned.status).toBe(0);
      expect(JSON.parse(pruned.stdout.trim())).toMatchObject({ status: 'pruned', path });
      expect(existsSync(path)).toBe(false);
      expect(git(repo, 'branch', '--list', 'thread/fix-the-parser')).toContain('thread/fix-the-parser');
      // And the main checkout still has its own dependencies — the link died, not the target.
      expect(existsSync(join(repo, 'node_modules', 'marker.txt'))).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'refuses a non-git directory: one line on the combined transcript, exit 1, nothing created',
    () => {
      const plain = join(sandbox, 'plain');
      mkdirSync(plain);
      const result = run('create', '--thread', THREAD, '--detach', '--json', '--target', plain);

      expect(result.status).toBe(1);
      // allowed-pattern #15: this CLI's logger routes error() through console.log.
      expect(result.combined).toContain('worktree refused:');
      expect(result.combined).toContain('is not a git repository');
      expect(result.combined.match(/worktree refused:/g)).toHaveLength(1);
      expect(existsSync(threadWorktreePath(plain, THREAD))).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'refuses a repository with no commits — an unborn branch has nothing to branch from',
    () => {
      const unborn = join(sandbox, 'unborn');
      mkdirSync(unborn);
      git(unborn, 'init', '--initial-branch=main');
      const result = run('create', '--thread', THREAD, '--detach', '--json', '--target', unborn);

      expect(result.status).toBe(1);
      expect(result.combined).toContain('worktree refused:');
      expect(result.combined).toContain('no commits yet');
      expect(existsSync(threadWorktreePath(unborn, THREAD))).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'refuses a thread name that could escape its container',
    () => {
      const result = run('create', '--thread', '../../etc', '--detach', '--json', '--target', repo);
      expect(result.status).toBe(1);
      expect(result.combined).toContain('is not a thread name');
    },
    E2E_TIMEOUT_MS,
  );
});

// ── bind, push and pr: the binding verbs, in process ─────

/**
 * The three verbs that decide where a worktree publishes.
 *
 * WHAT THESE ARE FOR. Every refusal below is a push that did NOT happen — the
 * wrong-but-valid push is the bug this feature exists to remove, and a refusal
 * is only a refusal if nothing left the machine. So most of these assert twice:
 * once on the transcript (allowed-pattern #15 — the logger routes error()
 * through console.log, so the line arrives on the COMBINED output) and once on
 * the recorded argv, that no `push` and no `gh` call was ever made.
 *
 * The fake git is a lookup over the argv, so a verb that got the right answer
 * by asking the wrong question fails here rather than in a repository.
 */
describe('Task 7.2 — bind, push and pr, in process', () => {
  /** The branch a named thread's worktree is standing on. */
  const LOCAL = 'thread/fix-the-parser';
  const WORKTREE = `${THREADS}/${THREAD}`;

  /** What a fake repository knows about itself. */
  interface RepoShape {
    /** The upstream git currently holds for LOCAL, or none. */
    binding?: { remote: string; remoteBranch: string } | null;
    remotes?: string[];
    /** `<remote>/<branch>` pairs that resolve as remote-tracking refs here. */
    tracking?: string[];
    /** `<remote>/<branch>` pairs `ls-remote` reports as really being there. */
    onRemote?: string[];
    /** Remote name → configured URL. A remote absent here has no readable URL. */
    urls?: Record<string, string>;
    /** What `branch.<local>.planflowPreviousPush` records. */
    previousPush?: string | null;
    /** What `gh` prints. */
    gh?: string;
    /** The branch `--here` would find. */
    head?: string;
    /** `git config --get-regexp ^branch\..*\.merge$`, for the learned rung. */
    merges?: string;
    user?: string;
  }

  /** Canned git answers for a repository of that shape. */
  function repo(shape: RepoShape = {}): (args: readonly string[]) => string | undefined {
    const remotes = shape.remotes ?? ['origin'];
    const tracking = new Set(shape.tracking ?? []);
    const onRemote = new Set(shape.onRemote ?? []);
    return (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        const url = shape.urls?.[args[2] ?? ''];
        if (url === undefined) throw new Error('fatal: no such remote');
        return url;
      }
      if (args[0] === 'remote') return `${remotes.join('\n')}\n`;
      if (args[0] === 'config' && args[1] === '--get') {
        const key = args[2] ?? '';
        if (key === `branch.${LOCAL}.remote`) {
          if (!shape.binding) throw new Error('fatal: no such key');
          return `${shape.binding.remote}\n`;
        }
        if (key === `branch.${LOCAL}.merge`) {
          if (!shape.binding) throw new Error('fatal: no such key');
          return `refs/heads/${shape.binding.remoteBranch}\n`;
        }
        if (key === `branch.${LOCAL}.planflowPreviousPush`) {
          if (shape.previousPush == null) throw new Error('fatal: no such key');
          return `${shape.previousPush}\n`;
        }
        throw new Error('fatal: no such key');
      }
      if (args[0] === 'config' && args[1] === '--get-regexp') return shape.merges ?? '';
      if (args[0] === 'config' && args[1] === 'user.name') return shape.user ?? '';
      // Writes and `--unset` both answer with nothing, as git does.
      if (args[0] === 'config') return '';
      if (args[0] === 'for-each-ref') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return shape.head ?? 'HEAD';
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        const ref = (args[3] ?? '').replace('refs/remotes/', '');
        if (!tracking.has(ref)) throw new Error('fatal: no such ref');
        return 'abc123';
      }
      if (args[0] === 'ls-remote') {
        const remote = args[2] ?? '';
        const ref = args[3] ?? '';
        const branch = ref.replace('refs/heads/', '');
        return onRemote.has(`${remote}/${branch}`) ? `abc123\t${ref}\n` : '';
      }
      if (args[0] === 'push') return '';
      if (args[0] === 'pr' && args[1] === 'create') return shape.gh ?? '';
      return undefined;
    };
  }

  /** A repo whose thread worktree exists and is on LOCAL. */
  function named(shape: RepoShape = {}): ReturnType<typeof fakeGit> {
    return fakeGit(porcelain([{ path: WORKTREE, branch: LOCAL }]), repo(shape));
  }

  /** Every argv the run handed to any tool, as flat strings. */
  function ran(git: ReturnType<typeof fakeGit>): string[] {
    return git.calls.map((call) => `${call.file} ${call.args.join(' ')}`);
  }

  /** Whether anything left the machine — a refusal must leave this false. */
  function published(git: ReturnType<typeof fakeGit>): boolean {
    return ran(git).some((line) => line.startsWith('git push') || line.startsWith('gh '));
  }

  // ── bind ───────────────────────────────────────────────

  it('binds by writing git\'s own two upstream keys, and answers with what it wrote', () => {
    const git = named();
    const result = invoke(
      'bind',
      { thread: THREAD, remote: 'origin', branch: 'feature/ACME-1-parser', prBase: 'develop' },
      { exec: git.exec },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({
      status: 'bound',
      thread: THREAD,
      branch: LOCAL,
      remote: 'origin',
      remoteBranch: 'feature/ACME-1-parser',
      prBase: 'develop',
    });
    expect(ran(git)).toContain(`git config branch.${LOCAL}.remote origin`);
    expect(ran(git)).toContain(`git config branch.${LOCAL}.merge refs/heads/feature/ACME-1-parser`);
    // `prBase` has no home in git — the store is its home, and bind only echoes it.
    expect(ran(git).join('\n')).not.toContain('develop');
    expect(published(git)).toBe(false);
  });

  it('refuses a bind with no remote, and one with no branch — never defaulting either', () => {
    // A `bind` that defaulted its remote, or took the local name when
    // `--branch` was omitted, would be the guess this feature removes wearing
    // a verb's clothes (forbidden-pattern #15).
    const noRemote = named();
    const first = invoke('bind', { thread: THREAD, branch: 'feature/x' }, { exec: noRemote.exec });
    expect(first.exitCode).toBe(1);
    expect(first.refusals.join('\n')).toContain('bind requires --remote <name>');

    const noBranch = named();
    const second = invoke('bind', { thread: THREAD, remote: 'origin' }, { exec: noBranch.exec });
    expect(second.exitCode).toBe(1);
    expect(second.refusals.join('\n')).toContain('bind requires --branch <ref>');

    for (const git of [noRemote, noBranch]) {
      expect(ran(git).some((line) => line.includes('config branch.'))).toBe(false);
    }
  });

  it('refuses a remote this repository does not have, BEFORE anything is written', () => {
    // git accepts `branch.<x>.remote = typo` without complaint and only fails
    // at the push, by which time the binding is on disk and looks decided.
    const git = named({ remotes: ['origin', 'upstream'] });
    const result = invoke(
      'bind',
      { thread: THREAD, remote: 'fork', branch: 'feature/x' },
      { exec: git.exec },
    );

    expect(result.exitCode).toBe(1);
    expect(result.refusals.join('\n')).toContain("this repository has no remote named 'fork'");
    expect(ran(git).some((line) => line.includes('config branch.'))).toBe(false);
  });

  it('validates a typed branch name rather than sanitizing it', () => {
    const git = named();
    const result = invoke(
      'bind',
      { thread: THREAD, remote: 'origin', branch: 'bad..name' },
      { exec: git.exec },
    );

    expect(result.exitCode).toBe(1);
    expect(result.refusals.join('\n')).toContain("'bad..name' is not a branch name");
    expect(ran(git).some((line) => line.includes('config branch.'))).toBe(false);
  });

  it('records a rename away from a published name, and reports it', () => {
    // FR-11: the old branch is left on the remote and SAID SO — recorded in
    // git's own config, so a later reader can still find it.
    const git = named({
      binding: { remote: 'origin', remoteBranch: 'feature/old' },
      tracking: ['origin/feature/old'],
    });
    const result = invoke(
      'bind',
      { thread: THREAD, remote: 'origin', branch: 'feature/new' },
      { exec: git.exec },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      status: 'bound',
      remoteBranch: 'feature/new',
      previouslyPushedAs: 'feature/old',
    });
    expect(ran(git)).toContain(`git config branch.${LOCAL}.planflowPreviousPush feature/old`);
    // Recorded, NEVER removed — nothing deletes the branch somebody may have a
    // pull request open against.
    expect(ran(git).some((line) => line.includes('push --delete'))).toBe(false);
  });

  it('does not record a rename away from a name that was never published', () => {
    const git = named({ binding: { remote: 'origin', remoteBranch: 'feature/old' } });
    const result = invoke(
      'bind',
      { thread: THREAD, remote: 'origin', branch: 'feature/new' },
      { exec: git.exec },
    );

    expect(result.json).not.toHaveProperty('previouslyPushedAs');
    expect(ran(git).some((line) => line.includes('planflowPreviousPush feature/old'))).toBe(false);
  });

  // ── the unbound refusal ────────────────────────────────

  it('refuses an unbound push and hands back everything the decision needs', () => {
    const git = named({ remotes: ['origin', 'upstream'] });
    const result = invoke(
      'push',
      { thread: THREAD, threadTitle: 'ACME-2204: Error endpoint', base: 'develop' },
      { exec: git.exec },
    );

    expect(result.exitCode).toBe(1);
    // The refusal LINE is prose for a person…
    expect(result.refusals.join('\n')).toContain(
      `worktree refused: unbound — nobody has said where '${LOCAL}' publishes to`,
    );
    // …and the PAYLOAD is the answer, on stdout, for the surface asking.
    expect(result.json).toEqual({
      refused: 'unbound',
      suggestion: 'ACME-2204-error-endpoint',
      source: 'ticket',
      // The project's usual remote, pre-selected for the ask and applied by
      // nobody — the person still says yes to it.
      remote: 'origin',
      remotes: ['origin', 'upstream'],
      base: 'develop',
    });
    expect(published(git)).toBe(false);
  });

  it('offers the project\'s usual remote as the default, alongside every other one', () => {
    // FR-6: the default reaches the ask pre-selected. With two remotes the
    // choice is still real — both are listed and neither is chosen here.
    const git = named({ remotes: ['origin', 'upstream'] });
    const result = invoke('push', { thread: THREAD }, { exec: git.exec });

    expect(result.json).toMatchObject({ remote: 'origin', remotes: ['origin', 'upstream'] });
    // Offered, not applied: nothing was written and nothing was pushed.
    expect(ran(git).some((line) => line.includes('config branch.'))).toBe(false);
    expect(published(git)).toBe(false);
  });

  it('offers no default when the configured remote is not one this repository has', () => {
    // A pre-selected remote that does not exist is a wrong answer already
    // filled in — and `bind` would refuse it a moment later anyway.
    const git = named({ remotes: ['upstream', 'fork'] });
    const result = invoke('push', { thread: THREAD }, { exec: git.exec });

    expect(result.json).toMatchObject({ remote: null, remotes: ['upstream', 'fork'] });
    expect(published(git)).toBe(false);
  });

  it('carries the payload on stdout even WITHOUT --json — both callers parse the stream', () => {
    const git = named();
    const result = invoke('push', { thread: THREAD, json: false }, { exec: git.exec });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ refused: 'unbound', source: 'local' });
    expect(published(git)).toBe(false);
  });

  it('reports a null base in the payload when nothing has said which one', () => {
    const git = named();
    const result = invoke('push', { thread: THREAD }, { exec: git.exec });

    expect(result.json).toMatchObject({ refused: 'unbound', base: null, suggestion: LOCAL });
    expect(published(git)).toBe(false);
  });

  it('refuses an unbound pr the same way, and never reaches gh', () => {
    const git = named();
    const result = invoke('pr', { thread: THREAD, title: 'Fix the parser' }, { exec: git.exec });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ refused: 'unbound' });
    expect(published(git)).toBe(false);
  });

  // ── push ───────────────────────────────────────────────

  it('pushes the bound refspec, spelled out on both sides', () => {
    const git = named({ binding: { remote: 'origin', remoteBranch: 'feature/x' } });
    const result = invoke('push', { thread: THREAD }, { exec: git.exec });

    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({
      status: 'pushed',
      thread: THREAD,
      branch: LOCAL,
      remote: 'origin',
      remoteBranch: 'feature/x',
      pushed: true,
    });
    const push = git.calls.find((call) => call.args[0] === 'push');
    expect(push?.args).toEqual(['push', 'origin', `${LOCAL}:feature/x`]);
    expect(push?.cwd).toBe(WORKTREE);
  });

  /**
   * git's real transcript for a non-fast-forward rejection, as `execFileSync`
   * hands it over: an argv on the first line, then eight lines of git — three
   * of them `hint:` lines telling a terminal user to run something else.
   */
  const REJECTED_PUSH = [
    'Command failed: git push origin feat/widget:feature/x',
    'To /tmp/remote.git',
    ' ! [rejected]        feat/widget -> feature/x (fetch first)',
    "error: failed to push some refs to '/tmp/remote.git'",
    'hint: Updates were rejected because the remote contains work that you do not',
    'hint: have locally. This is usually caused by another repository pushing to',
    "hint: the same ref. If you want to integrate the remote changes, use",
    "hint: 'git pull' before pushing again.",
    "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
  ].join('\n')

  /** A bound repo whose `git push` fails with the given transcript. */
  function pushFails(transcript: string): ReturnType<typeof fakeGit> {
    const answer = repo({ binding: { remote: 'origin', remoteBranch: 'feature/x' } })
    return fakeGit(porcelain([{ path: WORKTREE, branch: LOCAL }]), (args) => {
      if (args[0] === 'push') throw new Error(transcript)
      return answer(args)
    })
  }

  it('refuses a rejected push in ONE line, whatever git wrote (#1792)', () => {
    // The family contract says one `worktree refused:` line and the module
    // header says it twice, but `toRefusalLine` only PREFIXED the message — so
    // every refusal wrapping a subprocess printed as many lines as that
    // subprocess did. Ten, here.
    const git = pushFails(REJECTED_PUSH)
    const result = invoke('push', { thread: THREAD }, { exec: git.exec })

    expect(result.exitCode).toBe(1)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0]?.split('\n')).toHaveLength(1)
  })

  it('says the rejection MEANT something — not an argv, not a transcript (#1792)', () => {
    // The reason a reader saw ended at `Command failed: git push origin …`,
    // which is an invocation rather than a cause; collapsed generically it is
    // indistinguishable from a network outage, which is what the IDE's landing
    // flow was reduced to reporting.
    const git = pushFails(REJECTED_PUSH)
    const result = invoke('push', { thread: THREAD }, { exec: git.exec })

    expect(result.refusals[0]).toContain('origin/feature/x has work this branch does not')
    expect(result.refusals[0]).not.toContain('Command failed')
  })

  it('puts no terminal command in the reason a surface may relay (#1792)', () => {
    // Both halves of forbidden-pattern #12 lived in that reason: the `git push`
    // argv, and git's own hint to "use 'git pull' before pushing again". The
    // transcript is still on the inherited stderr, once, where git put it.
    const git = pushFails(REJECTED_PUSH)
    const line = invoke('push', { thread: THREAD }, { exec: git.exec }).refusals.join('\n')

    expect(line).not.toMatch(/git (?:push|pull)/)
    expect(line).not.toContain('hint:')
  })

  it('keeps git\'s diagnosis when the failure is not a rejection (#1792)', () => {
    // A reason is not a transcript, but it is not a shrug either — whatever git
    // said went wrong is the one thing worth carrying out.
    const git = pushFails(
      [
        'Command failed: git push origin feat/widget:feature/x',
        "fatal: '/tmp/remote.git' does not appear to be a git repository",
        'fatal: Could not read from remote repository.',
      ].join('\n'),
    )
    const result = invoke('push', { thread: THREAD }, { exec: git.exec })

    expect(result.exitCode).toBe(1)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0]).toContain('could not push to origin/feature/x')
    expect(result.refusals[0]).toContain('Could not read from remote repository')
    expect(result.refusals[0]).not.toContain('Command failed')
  })

  it('does not refuse a FIRST push as stale — there is nothing on the remote yet', () => {
    const git = named({ binding: { remote: 'origin', remoteBranch: 'feature/x' } });
    const result = invoke('push', { thread: THREAD }, { exec: git.exec });

    expect(result.exitCode).toBe(0);
    // …and it did not even ask the remote, because nothing said it had published.
    expect(ran(git).some((line) => line.includes('ls-remote'))).toBe(false);
  });

  it('refuses a push whose remote this repository no longer has, and pushes nothing', () => {
    const git = named({
      binding: { remote: 'upstream', remoteBranch: 'feature/x' },
      remotes: ['origin'],
    });
    const result = invoke('push', { thread: THREAD }, { exec: git.exec });

    expect(result.exitCode).toBe(1);
    expect(result.refusals.join('\n')).toContain('stale —');
    expect(result.refusals.join('\n')).toContain("a remote named 'upstream'");
    expect(published(git)).toBe(false);
  });

  it('refuses a push whose remote branch was deleted after it published, and pushes nothing', () => {
    const git = named({
      binding: { remote: 'origin', remoteBranch: 'feature/x' },
      // It published before — the tracking ref is local proof of that…
      tracking: ['origin/feature/x'],
      // …and the remote no longer has it.
      onRemote: [],
    });
    const result = invoke('push', { thread: THREAD }, { exec: git.exec });

    expect(result.exitCode).toBe(1);
    expect(result.refusals.join('\n')).toContain(
      "stale — 'feature/x' is no longer on origin — it was published there before",
    );
    expect(published(git)).toBe(false);
  });

  it('pushes again happily when the branch is still on the remote', () => {
    const git = named({
      binding: { remote: 'origin', remoteBranch: 'feature/x' },
      tracking: ['origin/feature/x'],
      onRemote: ['origin/feature/x'],
    });
    expect(invoke('push', { thread: THREAD }, { exec: git.exec }).exitCode).toBe(0);
  });

  it('reports the name still sitting on the remote after a rename', () => {
    const git = named({
      binding: { remote: 'origin', remoteBranch: 'feature/new' },
      previousPush: 'feature/old',
      tracking: ['origin/feature/old'],
      onRemote: ['origin/feature/new'],
    });
    const result = invoke('push', { thread: THREAD }, { exec: git.exec });

    expect(result.json).toMatchObject({ status: 'pushed', previouslyPushedAs: 'feature/old' });
  });

  it('drops the rename note once the old branch is gone — a pointer at nothing is noise', () => {
    const git = named({
      binding: { remote: 'origin', remoteBranch: 'feature/new' },
      previousPush: 'feature/old',
      tracking: [],
    });
    expect(invoke('push', { thread: THREAD }, { exec: git.exec }).json).not.toHaveProperty(
      'previouslyPushedAs',
    );
  });

  it('refuses a thread with no worktree, and one whose worktree has no branch', () => {
    const none = fakeGit(porcelain(), repo());
    const first = invoke('push', { thread: THREAD }, { exec: none.exec });
    expect(first.exitCode).toBe(1);
    expect(first.refusals.join('\n')).toContain(`thread '${THREAD}' has no worktree`);

    // A detached worktree is refused with its OWN reason, not as "unbound":
    // an upstream is configuration on a branch, so there is nowhere to write
    // the answer the unbound question would ask for.
    const detached = fakeGit(porcelain([{ path: WORKTREE }]), repo());
    const second = invoke('push', { thread: THREAD }, { exec: detached.exec });
    expect(second.exitCode).toBe(1);
    expect(second.refusals.join('\n')).toContain(
      `thread '${THREAD}' is not on a branch yet — a worktree publishes from a branch`,
    );
    expect(second.json).toBeNull();

    for (const git of [none, detached]) expect(published(git)).toBe(false);
  });

  it('refuses every binding verb that names both doors, or neither', () => {
    for (const verb of ['bind', 'push', 'pr'] as const) {
      const both = named();
      const first = invoke(
        verb,
        { thread: THREAD, here: true, remote: 'origin', branch: 'feature/x', title: 't' },
        { exec: both.exec },
      );
      expect(first.exitCode).toBe(1);
      expect(first.refusals.join('\n')).toContain(
        `${verb} takes either --thread <slug> or --here, never both`,
      );

      const neither = named();
      const second = invoke(
        verb,
        { remote: 'origin', branch: 'feature/x', title: 't' },
        { exec: neither.exec },
      );
      expect(second.exitCode).toBe(1);
      expect(second.refusals.join('\n')).toContain(`${verb} requires --thread <slug> or --here`);

      for (const git of [both, neither]) expect(published(git)).toBe(false);
    }
  });

  // ── pr ─────────────────────────────────────────────────

  /** A repo whose `gh` fails the way GitHub really answers an empty PR. */
  function ghFails(stderr: string): ReturnType<typeof fakeGit> {
    const answer = repo({ binding: { remote: 'origin', remoteBranch: 'feature/x' } });
    // `gh`'s argv starts `pr create …`; git's never does. The fake's responder
    // only sees the args, so that is the tell.
    return fakeGit(porcelain([{ path: WORKTREE, branch: LOCAL }]), (args) => {
      if (args[0] === 'pr') throw new Error(`Command failed: gh ${args.join(' ')}\n${stderr}`);
      return answer(args);
    });
  }

  /** The five-section body the auto-PR path really sends. */
  const ROUNDS_BODY = [
    '## Intent',
    'Ship the user-auth feature.',
    '## What Changed',
    'Phase 1 added the session store, phase 2 the login route, phase 3 the guards.',
    '## Risk Assessment',
    'low — additive.',
    '## Testing',
    '3596 tests pass.',
    '## Pipeline',
    'File conflicts: 0 · Contract conflicts: 0',
  ].join('\n');

  const GH_EMPTY_PR =
    'pull request create failed: GraphQL: No commits between main and feature/x (createPullRequest)';

  describe('a failed pr says what gh said, not what the CLI ran (#1836)', () => {
    // `runPush` has had this since #1792; `runPr` did not, so its failure fell
    // to the generic formatter and the reason was the whole `gh pr create …`
    // invocation — forbidden-pattern #12, one verb over.

    it('keeps gh’s diagnosis', () => {
      const git = ghFails(GH_EMPTY_PR);
      const result = invoke('pr', { thread: THREAD, title: 'probe', base: 'main' }, { exec: git.exec });

      expect(result.exitCode).toBe(1);
      expect(result.refusals[0]).toContain('could not open a pull request on origin/feature/x');
      expect(result.refusals[0]).toContain('No commits between main and feature/x');
    });

    it('drops the invocation', () => {
      const git = ghFails(GH_EMPTY_PR);
      const result = invoke('pr', { thread: THREAD, title: 'probe', base: 'main' }, { exec: git.exec });

      expect(result.refusals[0]).not.toContain('Command failed');
      expect(result.refusals[0]).not.toContain('gh pr create');
      expect(result.refusals[0]).not.toContain('--head');
    });

    it('does not print the PR BODY back at the user — the half that made this worse', () => {
      // The body is part of the invocation, so the 200-character reason budget
      // was spent on the user's own PR description and gh's diagnosis was
      // truncated off the end entirely.
      const git = ghFails(GH_EMPTY_PR);
      const result = invoke(
        'pr',
        { thread: THREAD, title: 'feat: user-auth', body: ROUNDS_BODY, base: 'main' },
        { exec: git.exec },
      );

      expect(result.refusals[0]).not.toContain('## Intent');
      expect(result.refusals[0]).not.toContain('session store');
      // …and gh's words survive, which is what the body was crowding out.
      expect(result.refusals[0]).toContain('No commits between main and feature/x');
    });

    it('reads the same whether the body is empty or the real one', () => {
      // The reason is about the failure, so the body must not change it at all.
      const withBody = invoke(
        'pr',
        { thread: THREAD, title: 'feat: user-auth', body: ROUNDS_BODY, base: 'main' },
        { exec: ghFails(GH_EMPTY_PR).exec },
      );
      const without = invoke(
        'pr',
        { thread: THREAD, title: 'feat: user-auth', base: 'main' },
        { exec: ghFails(GH_EMPTY_PR).exec },
      );

      expect(withBody.refusals[0]).toBe(without.refusals[0]);
    });

    it('still names the destination when gh says nothing recognisable', () => {
      const git = ghFails('something went sideways');
      const result = invoke('pr', { thread: THREAD, title: 'probe', base: 'main' }, { exec: git.exec });

      expect(result.refusals[0]).toContain('could not open a pull request on origin/feature/x');
      expect(result.refusals[0]).not.toContain('Command failed');
    });

    it('refuses in ONE line, whatever gh wrote', () => {
      const git = ghFails(`${GH_EMPTY_PR}\nTry this instead\nOr this`);
      const result = invoke('pr', { thread: THREAD, title: 'probe', base: 'main' }, { exec: git.exec });

      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]?.split('\n')).toHaveLength(1);
    });
  });

  it('opens a pull request from the bound branch onto the named base', () => {
    const git = named({
      binding: { remote: 'origin', remoteBranch: 'feature/x' },
      gh: 'Creating pull request…\nhttps://github.com/acme/widgets/pull/42\n',
    });
    const result = invoke(
      'pr',
      { thread: THREAD, title: 'Fix the parser', body: 'why', base: 'develop' },
      { exec: git.exec },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({
      status: 'opened',
      thread: THREAD,
      remote: 'origin',
      remoteBranch: 'feature/x',
      base: 'develop',
      url: 'https://github.com/acme/widgets/pull/42',
    });
    const gh = git.calls.find((call) => call.file === 'gh');
    expect(gh?.args).toEqual([
      'pr',
      'create',
      '--head',
      'feature/x',
      '--base',
      'develop',
      '--title',
      'Fix the parser',
      '--body',
      'why',
    ]);
    // `origin` is what `gh` works out for itself — naming it would be noise.
    expect(gh?.args).not.toContain('--repo');
  });

  it('names the repository explicitly for anything but origin', () => {
    // The plan's risk table: `gh` reads the checkout's `origin`, so a thread
    // bound to a fork would open its pull request against the WRONG repository
    // while reporting success.
    const git = named({
      binding: { remote: 'upstream', remoteBranch: 'feature/x' },
      remotes: ['origin', 'upstream'],
      urls: { upstream: 'git@github.com:acme/widgets.git' },
    });
    const result = invoke(
      'pr',
      { thread: THREAD, title: 'Fix the parser', base: 'main' },
      { exec: git.exec },
    );

    expect(result.exitCode).toBe(0);
    const gh = git.calls.find((call) => call.file === 'gh');
    expect(gh?.args.slice(-2)).toEqual(['--repo', 'acme/widgets']);
  });

  it('refuses when it cannot tell which repository a remote names, and never reaches gh', () => {
    const git = named({
      binding: { remote: 'upstream', remoteBranch: 'feature/x' },
      remotes: ['origin', 'upstream'],
      // A sibling directory on this machine: three path segments, exactly like
      // `github.com/owner/repo`, and naming no repository at all.
      urls: { upstream: '/tmp/scratch/elsewhere' },
    });
    const result = invoke(
      'pr',
      { thread: THREAD, title: 'Fix the parser', base: 'main' },
      { exec: git.exec },
    );

    expect(result.exitCode).toBe(1);
    expect(result.refusals.join('\n')).toContain("cannot tell which repository 'upstream' names");
    expect(published(git)).toBe(false);
  });

  it('refuses a pr with no title', () => {
    const git = named({ binding: { remote: 'origin', remoteBranch: 'feature/x' } });
    const result = invoke('pr', { thread: THREAD, base: 'main' }, { exec: git.exec });

    expect(result.exitCode).toBe(1);
    expect(result.refusals.join('\n')).toContain('pr requires --title <text>');
    expect(published(git)).toBe(false);
  });

  it('refuses a pr when NOTHING has said which base — `main` is a guess', () => {
    const git = named({ binding: { remote: 'origin', remoteBranch: 'feature/x' } });
    const result = invoke('pr', { thread: THREAD, title: 'Fix the parser' }, { exec: git.exec });

    expect(result.exitCode).toBe(1);
    expect(result.refusals.join('\n')).toContain(
      'no base — nothing has said which branch this pull request opens against',
    );
    expect(published(git)).toBe(false);
  });

  it('takes --base over --pr-base, and --pr-base over nothing', () => {
    const both = named({ binding: { remote: 'origin', remoteBranch: 'feature/x' } });
    invoke('pr', { thread: THREAD, title: 't', base: 'hotfix', prBase: 'develop' }, { exec: both.exec });
    expect(both.calls.find((call) => call.file === 'gh')?.args).toContain('hotfix');

    const recorded = named({ binding: { remote: 'origin', remoteBranch: 'feature/x' } });
    const result = invoke('pr', { thread: THREAD, title: 't', prBase: 'develop' }, { exec: recorded.exec });
    expect(result.json).toMatchObject({ base: 'develop' });
  });

  it('reports a null url when gh printed no URL, rather than inventing one', () => {
    const git = named({
      binding: { remote: 'origin', remoteBranch: 'feature/x' },
      gh: 'a pull request for branch "feature/x" already exists\n',
    });
    expect(
      invoke('pr', { thread: THREAD, title: 't', base: 'main' }, { exec: git.exec }).json,
    ).toMatchObject({ status: 'opened', url: null });
  });

  // ── list ───────────────────────────────────────────────

  it('reports each worktree\'s binding on list --json — one read answers the panel', () => {
    const OTHER = 'b1c2d3e4-0000-4000-8000-000000000000';
    const DETACHED = 'c1d2e3f4-0000-4000-8000-000000000000';
    const git = fakeGit(
      porcelain([
        { path: WORKTREE, branch: LOCAL },
        { path: `${THREADS}/${OTHER}`, branch: 'thread/unbound' },
        { path: `${THREADS}/${DETACHED}` },
      ]),
      (args) => {
        if (args[0] === 'config' && args[1] === '--get') {
          if (args[2] === `branch.${LOCAL}.remote`) return 'origin\n';
          if (args[2] === `branch.${LOCAL}.merge`) return 'refs/heads/feature/x\n';
          throw new Error('fatal: no such key');
        }
        return undefined;
      },
    );
    const result = invoke('list', {}, { exec: git.exec });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      status: 'listed',
      worktrees: [
        {
          thread: THREAD,
          branch: LOCAL,
          remote: 'origin',
          remoteBranch: 'feature/x',
          bound: true,
        },
        { thread: OTHER, branch: 'thread/unbound', remote: null, remoteBranch: null, bound: false },
        // A detached worktree has no branch to carry an upstream, so it is
        // unbound without being asked.
        { thread: DETACHED, branch: null, remote: null, remoteBranch: null, bound: false },
      ],
    });
    expect(ran(git).some((line) => line.includes('branch.null.remote'))).toBe(false);
  });

  it('renders a binding in the human line too, and says nothing when there is none', () => {
    const bound = fakeGit(porcelain([{ path: WORKTREE, branch: LOCAL }]), (args) => {
      if (args[0] === 'config' && args[1] === '--get') {
        if (args[2] === `branch.${LOCAL}.remote`) return 'origin\n';
        if (args[2] === `branch.${LOCAL}.merge`) return 'refs/heads/feature/x\n';
        throw new Error('fatal: no such key');
      }
      return undefined;
    });
    expect(invoke('list', { json: false }, { exec: bound.exec }).stdout).toContain(
      '→ origin/feature/x',
    );

    const unbound = fakeGit(porcelain([{ path: WORKTREE, branch: LOCAL }]), repo());
    expect(invoke('list', { json: false }, { exec: unbound.exec }).stdout).not.toContain('→');
  });
});

describe('Task 7.2 — the remote and pattern the app resolved, handed in as suggestions', () => {
  // `--default-remote` / `--branch-pattern` exist because THE FILE IS NOT THE
  // ONLY LAYER ANY MORE: the app resolves a project's settings over the
  // person's app-wide defaults, and this process reads one file and knows
  // nothing about who is running it. Both are SUGGESTION INPUTS — they reach
  // the unbound refusal and nothing else; neither binds anything.

  const LOCAL = 'thread/fix-the-parser';
  let project: string;
  let worktree: string;

  /** A project whose own file says `remote: fromfile` and has a pattern too. */
  function seedProject(config: string[] = ['remote: fromfile', 'remote_branch_pattern: file/{local}']): void {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'plan-flow-worktree-flags-')));
    mkdirSync(join(project, 'flow'), { recursive: true });
    writeFileSync(join(project, 'flow', '.flowconfig'), config.join('\n') + '\n');
    worktree = threadWorktreePath(project, THREAD);
  }

  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  /** This project's worktree list: the checkout itself plus the thread's. */
  function listing(): string {
    return [
      `worktree ${project}\nHEAD abc123\nbranch refs/heads/main\n`,
      `worktree ${worktree}\nHEAD def456\nbranch refs/heads/${LOCAL}\n`,
    ].join('\n');
  }

  /** An unbound repository holding every remote named here. */
  function unboundRepo(remotes: string[]): ReturnType<typeof fakeGit> {
    return fakeGit(listing(), (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') throw new Error('fatal: no such remote');
      if (args[0] === 'remote') return `${remotes.join('\n')}\n`;
      if (args[0] === 'config') {
        if (args[1] === '--get') throw new Error('fatal: no such key');
        return '';
      }
      if (args[0] === 'for-each-ref') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'HEAD';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('fatal: no such ref');
      if (args[0] === 'ls-remote') return '';
      if (args[0] === 'status') return '';
      return undefined;
    });
  }

  it('offers the file’s remote when the caller hands in none — today’s behaviour', () => {
    seedProject();
    const git = unboundRepo(['fromfile', 'typed']);
    const result = invoke('push', { target: project, thread: THREAD }, { exec: git.exec });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ refused: 'unbound', remote: 'fromfile' });
  });

  it('offers the handed-in remote AHEAD of the file’s', () => {
    // A default set only in the person's app-wide settings is invisible to this
    // process; without this flag it could never reach the ask.
    seedProject();
    const git = unboundRepo(['fromfile', 'typed']);
    const result = invoke(
      'push',
      { target: project, thread: THREAD, defaultRemote: 'typed' },
      { exec: git.exec },
    );
    expect(result.json).toMatchObject({ remote: 'typed', remotes: ['fromfile', 'typed'] });
  });

  it('still offers nothing when the handed-in remote is not one this repository has', () => {
    // Pre-selecting a remote that does not exist is a wrong answer already
    // filled in — and `bind` would refuse it a moment later anyway.
    seedProject();
    const git = unboundRepo(['fromfile']);
    const result = invoke(
      'push',
      { target: project, thread: THREAD, defaultRemote: 'typed' },
      { exec: git.exec },
    );
    expect(result.json).toMatchObject({ remote: null, remotes: ['fromfile'] });
  });

  it('suggests with the handed-in pattern ahead of the file’s', () => {
    seedProject();
    const git = unboundRepo(['fromfile']);
    expect(
      invoke('push', { target: project, thread: THREAD }, { exec: git.exec }).json,
    ).toMatchObject({ suggestion: `file/${LOCAL}`, source: 'pattern' });
    expect(
      invoke(
        'push',
        { target: project, thread: THREAD, branchPattern: 'typed/{local}' },
        { exec: git.exec },
      ).json,
    ).toMatchObject({ suggestion: `typed/${LOCAL}`, source: 'pattern' });
  });

  it('reaches the pr refusal by the same path', () => {
    seedProject();
    const git = unboundRepo(['fromfile', 'typed']);
    const result = invoke(
      'pr',
      { target: project, thread: THREAD, title: 'Fix the parser', defaultRemote: 'typed' },
      { exec: git.exec },
    );
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ refused: 'unbound', remote: 'typed' });
    expect(git.calls.some((call) => call.file === 'gh')).toBe(false);
  });

  it('refuses a handed-in remote name git could not hold, and publishes nothing', () => {
    seedProject();
    const git = unboundRepo(['fromfile']);
    const result = invoke(
      'push',
      { target: project, thread: THREAD, defaultRemote: 'my remote' },
      { exec: git.exec },
    );
    expect(result.exitCode).toBe(1);
    // Allowed-pattern #15: the combined transcript, because error() is console.log.
    expect([result.stdout, ...result.logged].join('\n')).toContain(
      "'my remote' is not the name of a remote",
    );
    expect(git.calls.some((call) => `${call.file} ${call.args[0]}` === 'git push')).toBe(false);
  });

  it('refuses a handed-in pattern with a placeholder nothing can fill', () => {
    seedProject();
    const git = unboundRepo(['fromfile']);
    const result = invoke(
      'push',
      { target: project, thread: THREAD, branchPattern: 'feature/{sprint}' },
      { exec: git.exec },
    );
    expect(result.exitCode).toBe(1);
    const transcript = [result.stdout, ...result.logged].join('\n');
    expect(transcript).toContain("a branch name pattern cannot fill '{sprint}'");
    expect(transcript).toContain('{ticket}, {slug}, {local}, {user}');
  });

  it('refuses a typed value even for a worktree that is already bound', () => {
    // Validated where it was TYPED (allowed-pattern #22): a refusal that only
    // happened for unbound worktrees would depend on state the caller cannot
    // see.
    seedProject();
    const bound = fakeGit(listing(), (args) => {
      if (args[0] === 'config' && args[1] === '--get') {
        if (args[2] === `branch.${LOCAL}.remote`) return 'fromfile\n';
        if (args[2] === `branch.${LOCAL}.merge`) return 'refs/heads/feature/x\n';
        throw new Error('fatal: no such key');
      }
      if (args[0] === 'remote') return 'fromfile\n';
      if (args[0] === 'status') return '';
      return undefined;
    });
    const result = invoke(
      'push',
      { target: project, thread: THREAD, defaultRemote: 'my remote' },
      { exec: bound.exec },
    );
    expect(result.exitCode).toBe(1);
    expect(bound.calls.some((call) => `${call.file} ${call.args[0]}` === 'git push')).toBe(false);
  });

  it('does NOT refuse the file’s own bad values — they degrade, as they always have', () => {
    // `.flowconfig` is hand-editable and its bad values already degrade: an
    // unfillable pattern falls to the next rung. Turning that into a refusal
    // would break projects that work today.
    seedProject(['remote: fromfile', 'remote_branch_pattern: feature/{sprint}']);
    const git = unboundRepo(['fromfile']);
    const result = invoke('push', { target: project, thread: THREAD }, { exec: git.exec });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ refused: 'unbound' });
    expect(result.json?.source).not.toBe('pattern');
  });
});
