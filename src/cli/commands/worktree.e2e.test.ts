/**
 * End-to-end tests for the binding verbs — the REAL CLI, a REAL git, and two
 * REAL bare remotes in a throwaway directory.
 *
 * WHY THIS LAYER EXISTS AT ALL. `worktree.test.ts` proves the argv a verb
 * builds; only a real repository can prove what that argv DOES — that a
 * refused push left both remotes untouched, that a bound push put the local
 * branch under a DIFFERENT name on the remote a person chose, that a rename
 * left the old branch standing, and that a deleted remote branch is refused
 * rather than silently recreated. Those are the four facts the whole feature is
 * about, and every one of them is a fact about a remote (allowed-pattern #7 —
 * reproduce the behaviour the way its caller reaches it).
 *
 * TWO REMOTES, ON PURPOSE. One remote cannot tell a wrong destination from a
 * right one: everything lands somewhere and looks fine. With `origin` and
 * `upstream` side by side, "it went to the remote nobody chose" is something
 * the fixture can actually observe.
 *
 * NOTHING HERE TOUCHES THIS REPOSITORY. The fixture is its own git repo under
 * `mkdtemp`, its worktree container is a sibling inside the same temp
 * directory, and the whole thing is removed by one `rmSync`. The stub `gh` is
 * an executable inside that same directory, reached only through a PATH this
 * file constructs and hands to the subprocess explicitly.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const E2E_TIMEOUT_MS = 120_000;

const THREAD = '7f3a9c21-4d5e-4b8a-9c0f-1e2d3a4b5c6d';
/** The local name — ours, generated from a title nobody chose. */
const LOCAL = 'thread/probe';
/** The name on the remote — the project's convention, chosen by a person. */
const REMOTE_BRANCH = 'feature/ACME-2204-error-endpoint';

/**
 * Whether this environment has a git to run at all.
 *
 * SKIPPED WITH A NAMED REASON rather than failed: a machine without git is not
 * a broken feature, and a suite that fails for the environment teaches the next
 * reader to ignore it.
 */
const GIT_AVAILABLE = ((): boolean => {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
  } catch {
    return false;
  }
})();

const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

interface CliRun {
  stdout: string;
  stderr: string;
  /** allowed-pattern #15: this CLI's logger routes error() through console.log. */
  combined: string;
  status: number | null;
  /** stdout parsed as JSON, or null when nothing parseable was printed. */
  json: Record<string, unknown> | null;
}

describeWithGit(
  GIT_AVAILABLE
    ? 'worktree bind/push/pr E2E — real CLI, real git, two bare remotes'
    : 'worktree bind/push/pr E2E — skipped: git is not available in this environment',
  () => {
    let sandbox: string;
    let repo: string;
    let originBare: string;
    let upstreamBare: string;
    let ghArgvFile: string;
    let stubBin: string;

    /** Run git in a fixture directory. Fails loudly — a broken fixture is not a test result. */
    function git(cwd: string, ...args: string[]): string {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    }

    /** Every branch a bare remote is holding, as full ref names. */
    function refsOn(bare: string): string[] {
      return git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    /** The real CLI, in a subprocess, with the stub `gh` first on its PATH. */
    function run(...args: string[]): CliRun {
      const result = spawnSync(process.execPath, [TSX_BIN, CLI_ENTRY, 'worktree', ...args], {
        encoding: 'utf-8',
        timeout: E2E_TIMEOUT_MS,
        cwd: sandbox,
        env: {
          ...process.env,
          // The stub is reached ONLY through a PATH this file constructs and
          // hands over explicitly — never by editing the machine's own.
          PATH: `${stubBin}:${process.env.PATH ?? ''}`,
          GH_ARGV_FILE: ghArgvFile,
        },
      });
      if (result.error) throw result.error;
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      // THE ONLY JSON LINE, wherever it sits. git writes its own progress to
      // stdout ahead of the result object, and a refusal writes its `worktree
      // refused:` line to stdout too (allowed-pattern #15) — AFTER the payload.
      // Taking the last parseable object rather than the last line is what
      // makes the unbound refusal readable from here at all.
      let json: Record<string, unknown> | null = null;
      for (const line of stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const parsed: unknown = JSON.parse(line.trim());
          if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>;
        } catch {
          // Not the result line.
        }
      }
      return { stdout, stderr, combined: `${stdout}\n${stderr}`, status: result.status, json };
    }

    /** The argv the stub `gh` was handed on its last invocation. */
    function ghArgv(): string[] {
      if (!existsSync(ghArgvFile)) return [];
      // Every argument was written on its own line, so an argument containing
      // a space survives — which the title and the body both do.
      return readFileSync(ghArgvFile, 'utf-8').split('\n').slice(0, -1);
    }

    /** A thread worktree on LOCAL, created and named the way the app does it. */
    function makeWorktree(): string {
      const created = run('create', '--thread', THREAD, '--detach', '--no-fetch', '--json', '--target', repo);
      expect(created.status).toBe(0);
      const named = run('name', '--thread', THREAD, '--branch', LOCAL, '--json', '--target', repo);
      expect(named.status).toBe(0);
      return (created.json as { path: string }).path;
    }

    beforeEach(() => {
      // `realpathSync`, because macOS hands out `/var/folders/...` for a
      // directory git reports as `/private/var/folders/...`.
      sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'planflow-binding-')));
      repo = join(sandbox, 'repo');
      originBare = join(sandbox, 'origin.git');
      upstreamBare = join(sandbox, 'upstream.git');
      ghArgvFile = join(sandbox, 'gh-argv.txt');
      stubBin = join(sandbox, 'bin');

      mkdirSync(repo);
      git(repo, 'init', '--initial-branch=main');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');
      writeFileSync(join(repo, 'README.md'), '# fixture\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '-m', 'first');

      git(sandbox, 'init', '--bare', '--initial-branch=main', originBare);
      git(sandbox, 'init', '--bare', '--initial-branch=main', upstreamBare);
      git(repo, 'remote', 'add', 'origin', originBare);
      git(repo, 'remote', 'add', 'upstream', upstreamBare);
      git(repo, 'push', 'origin', 'main');
      git(repo, 'push', 'upstream', 'main');

      // A stub `gh` that records exactly what it was handed and prints what the
      // real one prints on success. Executable, and reachable only via PATH.
      mkdirSync(stubBin);
      const stub = join(stubBin, 'gh');
      writeFileSync(
        stub,
        [
          '#!/bin/sh',
          ': > "$GH_ARGV_FILE"',
          'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$GH_ARGV_FILE"; done',
          'echo "https://github.com/acme/widgets/pull/42"',
          '',
        ].join('\n'),
      );
      chmodSync(stub, 0o755);
    });

    afterEach(() => {
      rmSync(sandbox, { recursive: true, force: true });
    });

    it(
      'refuses an unbound push — with the answer on stdout, and nothing on either remote',
      () => {
        makeWorktree();

        const pushed = run(
          'push', '--thread', THREAD, '--thread-title', 'ACME-2204: Error endpoint', '--json', '--target', repo,
        );

        expect(pushed.status).toBe(1);
        // ONE refusal line, on the COMBINED transcript (allowed-pattern #15).
        expect(pushed.combined).toContain(
          `worktree refused: unbound — nobody has said where '${LOCAL}' publishes to`,
        );
        expect(pushed.combined.match(/worktree refused:/g)).toHaveLength(1);
        // …and the payload the deciding surface needs, in the same breath.
        expect(pushed.json).toMatchObject({
          refused: 'unbound',
          suggestion: 'ACME-2204-error-endpoint',
          source: 'ticket',
        });
        expect(pushed.json?.remotes).toEqual(['origin', 'upstream']);
        // The project's usual remote comes down pre-selected — a default a
        // person confirms, never one anything applies for them.
        expect(pushed.json?.remote).toBe('origin');

        // THE POINT OF THE REFUSAL: nothing left the machine.
        expect(refsOn(originBare)).toEqual(['refs/heads/main']);
        expect(refsOn(upstreamBare)).toEqual(['refs/heads/main']);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'defaults the ask to the remote the project says it publishes to',
      () => {
        // FR-6, end to end: the value in `.flowconfig` reaches the refusal
        // payload the deciding surface reads — and reaches it as an offer.
        mkdirSync(join(repo, 'flow'), { recursive: true });
        writeFileSync(join(repo, 'flow', '.flowconfig'), 'remote: upstream\n');
        makeWorktree();

        const pushed = run('push', '--thread', THREAD, '--json', '--target', repo);

        expect(pushed.status).toBe(1);
        expect(pushed.json).toMatchObject({ refused: 'unbound', remote: 'upstream' });
        // Offered and not applied: neither remote heard anything about it.
        expect(refsOn(originBare)).toEqual(['refs/heads/main']);
        expect(refsOn(upstreamBare)).toEqual(['refs/heads/main']);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'binds to a chosen remote and lands the local branch under the name a person chose',
      () => {
        const path = makeWorktree();

        const bound = run(
          'bind', '--thread', THREAD, '--remote', 'upstream', '--branch', REMOTE_BRANCH,
          '--pr-base', 'develop', '--json', '--target', repo,
        );
        expect(bound.status).toBe(0);
        expect(bound.json).toEqual({
          status: 'bound',
          thread: THREAD,
          branch: LOCAL,
          remote: 'upstream',
          remoteBranch: REMOTE_BRANCH,
          prBase: 'develop',
        });

        // GIT IS THE TRUTH: the binding is git's own upstream configuration, so
        // a person running plain `git push` from the worktree goes exactly
        // where the app would have sent them.
        expect(git(path, 'config', '--get', `branch.${LOCAL}.remote`).trim()).toBe('upstream');
        expect(git(path, 'config', '--get', `branch.${LOCAL}.merge`).trim()).toBe(
          `refs/heads/${REMOTE_BRANCH}`,
        );

        const pushed = run('push', '--thread', THREAD, '--json', '--target', repo);
        expect(pushed.status).toBe(0);
        expect(pushed.json).toMatchObject({
          status: 'pushed',
          remote: 'upstream',
          remoteBranch: REMOTE_BRANCH,
          pushed: true,
        });

        // THE BUG THIS FEATURE EXISTS TO STOP: the local name is NOT what
        // landed, and it landed on the remote that was chosen, not the default.
        expect(refsOn(upstreamBare)).toContain(`refs/heads/${REMOTE_BRANCH}`);
        expect(refsOn(upstreamBare)).not.toContain(`refs/heads/${LOCAL}`);
        expect(refsOn(originBare)).toEqual(['refs/heads/main']);

        // And the listing reports it, from git, without being asked twice.
        const listed = run('list', '--json', '--target', repo);
        expect((listed.json as { worktrees: Record<string, unknown>[] }).worktrees[0]).toMatchObject({
          thread: THREAD,
          branch: LOCAL,
          remote: 'upstream',
          remoteBranch: REMOTE_BRANCH,
          bound: true,
        });
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'leaves the old branch standing after a rename, and says so on the next push',
      () => {
        makeWorktree();
        run('bind', '--thread', THREAD, '--remote', 'upstream', '--branch', REMOTE_BRANCH, '--json', '--target', repo);
        run('push', '--thread', THREAD, '--json', '--target', repo);

        const renamed = 'feature/ACME-2204-renamed';
        const rebound = run(
          'bind', '--thread', THREAD, '--remote', 'upstream', '--branch', renamed, '--json', '--target', repo,
        );
        expect(rebound.status).toBe(0);
        expect(rebound.json).toMatchObject({
          remoteBranch: renamed,
          previouslyPushedAs: REMOTE_BRANCH,
        });

        const pushed = run('push', '--thread', THREAD, '--json', '--target', repo);
        expect(pushed.status).toBe(0);
        expect(pushed.json).toMatchObject({
          remoteBranch: renamed,
          previouslyPushedAs: REMOTE_BRANCH,
        });

        // RECORDED, NEVER REMOVED (FR-11): deleting a branch somebody may have
        // a pull request open against is not this verb's decision to make.
        expect(refsOn(upstreamBare).sort()).toEqual([
          `refs/heads/${REMOTE_BRANCH}`,
          `refs/heads/${renamed}`,
          'refs/heads/main',
        ].sort());
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'refuses a push whose remote branch was deleted after it published',
      () => {
        makeWorktree();
        run('bind', '--thread', THREAD, '--remote', 'upstream', '--branch', REMOTE_BRANCH, '--json', '--target', repo);
        expect(run('push', '--thread', THREAD, '--json', '--target', repo).status).toBe(0);

        // Somebody merged and tidied up. The worktree still points at a branch
        // that is no longer there.
        git(upstreamBare, 'update-ref', '-d', `refs/heads/${REMOTE_BRANCH}`);

        const again = run('push', '--thread', THREAD, '--json', '--target', repo);
        expect(again.status).toBe(1);
        expect(again.combined).toContain(
          `worktree refused: stale — '${REMOTE_BRANCH}' is no longer on upstream — it was published there before`,
        );
        // Refused, not silently recreated.
        expect(refsOn(upstreamBare)).toEqual(['refs/heads/main']);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'publishes the main checkout\'s own branch under --here',
      () => {
        git(repo, 'checkout', '-b', 'local-work');
        writeFileSync(join(repo, 'engine.ts'), 'work\n');
        git(repo, 'add', 'engine.ts');
        git(repo, 'commit', '-m', 'work on the checkout itself');

        const bound = run(
          'bind', '--here', '--remote', 'origin', '--branch', 'feature/from-here', '--json', '--target', repo,
        );
        expect(bound.status).toBe(0);
        // No thread owns a plain checkout.
        expect(bound.json).toMatchObject({ thread: null, branch: 'local-work' });

        const pushed = run('push', '--here', '--json', '--target', repo);
        expect(pushed.status).toBe(0);
        expect(pushed.json).toMatchObject({ thread: null, branch: 'local-work', pushed: true });
        expect(refsOn(originBare)).toContain('refs/heads/feature/from-here');
        expect(refsOn(originBare)).not.toContain('refs/heads/local-work');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'hands gh the exact argv, naming the repository only for the remote it cannot work out',
      () => {
        // The project's default base, read from `.flowconfig` rather than guessed.
        mkdirSync(join(repo, 'flow'));
        writeFileSync(join(repo, 'flow', '.flowconfig'), 'branch: develop\n');
        // A remote whose URL names a real forge repository. Nothing is pushed to
        // it here — `pr` never touches the network itself.
        git(repo, 'remote', 'set-url', 'upstream', 'git@github.com:acme/widgets.git');
        makeWorktree();

        run('bind', '--thread', THREAD, '--remote', 'upstream', '--branch', 'feature/widget', '--json', '--target', repo);
        const opened = run('pr', '--thread', THREAD, '--title', 'Add the widget', '--body', 'why', '--json', '--target', repo);

        expect(opened.status).toBe(0);
        expect(opened.json).toEqual({
          status: 'opened',
          thread: THREAD,
          remote: 'upstream',
          remoteBranch: 'feature/widget',
          base: 'develop',
          url: 'https://github.com/acme/widgets/pull/42',
        });
        // THE RISK THE PLAN NAMED: `gh` works its repository out from the
        // checkout's `origin`, so a thread bound to a fork or a mirror would
        // open its pull request against the WRONG repository while reporting
        // success. `--repo` is the only way to say which one.
        expect(ghArgv()).toEqual([
          'pr', 'create',
          '--head', 'feature/widget',
          '--base', 'develop',
          '--title', 'Add the widget',
          '--body', 'why',
          '--repo', 'acme/widgets',
        ]);

        // Bound to `origin` instead, the flag is absent — naming what `gh`
        // already knows would be noise.
        run('bind', '--thread', THREAD, '--remote', 'origin', '--branch', 'feature/widget', '--json', '--target', repo);
        const viaOrigin = run(
          'pr', '--thread', THREAD, '--title', 'Add the widget', '--body', 'why', '--base', 'release/2', '--json', '--target', repo,
        );
        expect(viaOrigin.status).toBe(0);
        expect(ghArgv()).toEqual([
          'pr', 'create',
          '--head', 'feature/widget',
          '--base', 'release/2',
          '--title', 'Add the widget',
          '--body', 'why',
        ]);
        expect(ghArgv()).not.toContain('--repo');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'refuses a pull request with no base and one with no title, and never reaches gh',
      () => {
        makeWorktree();
        run('bind', '--thread', THREAD, '--remote', 'origin', '--branch', 'feature/widget', '--json', '--target', repo);

        const noTitle = run('pr', '--thread', THREAD, '--base', 'main', '--json', '--target', repo);
        expect(noTitle.status).toBe(1);
        expect(noTitle.combined).toContain('worktree refused: pr requires --title <text>');

        // No `.flowconfig`, no `--base`, no `--pr-base`: `main` would be a guess,
        // and a guess here targets a branch nobody chose.
        const noBase = run('pr', '--thread', THREAD, '--title', 'Add the widget', '--json', '--target', repo);
        expect(noBase.status).toBe(1);
        expect(noBase.combined).toContain(
          'worktree refused: no base — nothing has said which branch this pull request opens against',
        );

        expect(ghArgv()).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'refuses a remote it cannot resolve to a repository, and a remote this checkout does not have',
      () => {
        git(repo, 'remote', 'set-url', 'upstream', join(sandbox, 'scratch', 'elsewhere'));
        makeWorktree();

        const unknown = run(
          'bind', '--thread', THREAD, '--remote', 'fork', '--branch', 'feature/widget', '--json', '--target', repo,
        );
        expect(unknown.status).toBe(1);
        expect(unknown.combined).toContain("worktree refused: this repository has no remote named 'fork'");

        run('bind', '--thread', THREAD, '--remote', 'upstream', '--branch', 'feature/widget', '--json', '--target', repo);
        // A base IS named here, so the refusal that lands is the one this test
        // is about rather than the missing-base one that would come first.
        const opened = run('pr', '--thread', THREAD, '--title', 'Add the widget', '--base', 'main', '--json', '--target', repo);

        expect(opened.status).toBe(1);
        // A sibling directory has three path segments exactly like
        // `github.com/owner/repo` does — and names no repository at all.
        expect(opened.combined).toContain("worktree refused: cannot tell which repository 'upstream' names");
        expect(ghArgv()).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    // ---------------------------------------------------------------------
    // NAMED CHECKOUTS — `worktree/<name>`, the way the app cuts them now.
    //
    // The folder is no longer the thread id, so every verb that found "this
    // thread's checkout" by comparing the folder to the id refused a checkout
    // that was right there. These run the verbs exactly as the app spawns them.
    // ---------------------------------------------------------------------

    const FOLDER = 'worktree/error-endpoint';

    /** A thread worktree in a NAMED folder, created and named as the app does. */
    function makeNamedWorktree(): string {
      const created = run(
        'create', '--thread', THREAD, '--worktree-name', FOLDER, '--detach', '--no-fetch', '--json', '--target', repo,
      );
      expect(created.status).toBe(0);
      const path = (created.json as { path: string }).path;
      expect(path.endsWith(`/${FOLDER}`)).toBe(true);
      const named = run(
        'name', '--thread', THREAD, '--worktree-name', FOLDER, '--branch', LOCAL, '--json', '--target', repo,
      );
      expect(named.status).toBe(0);
      return path;
    }

    /** Forget the checkout's own record of its thread — a checkout cut before it existed. */
    function forgetOwner(path: string): void {
      const gitDir = git(path, 'rev-parse', '--absolute-git-dir').trim();
      rmSync(join(gitDir, 'planflow-thread'), { force: true });
    }

    it(
      'binds, pushes and opens a pull request for a named checkout found by its thread id alone',
      () => {
        const path = makeNamedWorktree();

        // THE POSITIVE FIRST (allowed-pattern #28): the checkout exists and is
        // on the branch — so a refusal below would be the lookup, not the fixture.
        expect(git(path, 'branch', '--show-current').trim()).toBe(LOCAL);

        const listed = run('list', '--thread', THREAD, '--json', '--target', repo);
        expect(listed.status).toBe(0);
        expect((listed.json as { worktrees: Record<string, unknown>[] }).worktrees).toEqual([
          expect.objectContaining({ thread: FOLDER, owner: THREAD, path, branch: LOCAL }),
        ]);

        const bound = run(
          'bind', '--thread', THREAD, '--remote', 'upstream', '--branch', REMOTE_BRANCH, '--json', '--target', repo,
        );
        expect(bound.status).toBe(0);
        expect(bound.json).toMatchObject({ status: 'bound', thread: THREAD, branch: LOCAL });

        const pushed = run('push', '--thread', THREAD, '--json', '--target', repo);
        expect(pushed.status).toBe(0);
        expect(pushed.json).toMatchObject({ status: 'pushed', remote: 'upstream', remoteBranch: REMOTE_BRANCH });
        expect(refsOn(upstreamBare)).toContain(`refs/heads/${REMOTE_BRANCH}`);
        expect(refsOn(originBare)).toEqual(['refs/heads/main']);

        run('bind', '--thread', THREAD, '--remote', 'origin', '--branch', 'feature/widget', '--json', '--target', repo);
        const opened = run(
          'pr', '--thread', THREAD, '--title', 'Add the widget', '--body', 'why', '--base', 'main', '--json', '--target', repo,
        );
        expect(opened.status).toBe(0);
        expect(opened.json).toMatchObject({ status: 'opened', thread: THREAD, remoteBranch: 'feature/widget' });
        expect(ghArgv().slice(0, 4)).toEqual(['pr', 'create', '--head', 'feature/widget']);

        const promoted = run('promote', '--thread', THREAD, '--json', '--target', repo);
        expect(promoted.status).toBe(0);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'still refuses an unbound push from a named checkout — with its payload, and nothing on either remote',
      () => {
        makeNamedWorktree();

        const pushed = run(
          'push', '--thread', THREAD, '--thread-title', 'ACME-2204: Error endpoint', '--json', '--target', repo,
        );

        expect(pushed.status).toBe(1);
        expect(pushed.combined).toContain(
          `worktree refused: unbound — nobody has said where '${LOCAL}' publishes to`,
        );
        expect(pushed.combined).not.toContain('has no worktree');
        expect(pushed.json).toMatchObject({ refused: 'unbound', suggestion: 'ACME-2204-error-endpoint' });
        expect(refsOn(originBare)).toEqual(['refs/heads/main']);
        expect(refsOn(upstreamBare)).toEqual(['refs/heads/main']);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'finds a named checkout that predates its record when the caller names the folder, and records it',
      () => {
        const path = makeNamedWorktree();
        forgetOwner(path);

        // By id alone there is nothing left to go on — refused, and nothing pushed.
        const blind = run('push', '--thread', THREAD, '--json', '--target', repo);
        expect(blind.status).toBe(1);
        expect(blind.combined).toContain(`worktree refused: thread '${THREAD}' has no worktree`);
        expect(refsOn(upstreamBare)).toEqual(['refs/heads/main']);

        // Named, the way the app passes it from the thread's recorded path.
        const bound = run(
          'bind', '--thread', THREAD, '--worktree-name', FOLDER, '--remote', 'upstream', '--branch', REMOTE_BRANCH,
          '--json', '--target', repo,
        );
        expect(bound.status).toBe(0);
        const pushed = run('push', '--thread', THREAD, '--worktree-name', FOLDER, '--json', '--target', repo);
        expect(pushed.status).toBe(0);
        expect(refsOn(upstreamBare)).toContain(`refs/heads/${REMOTE_BRANCH}`);

        // A folder named wrongly is not a reason to guess another checkout.
        const wrong = run('push', '--thread', THREAD, '--worktree-name', 'worktree/elsewhere', '--json', '--target', repo);
        expect(wrong.status).toBe(1);
        expect(wrong.combined).toContain('has no worktree');

        // `name` writes the record on its way past — the id alone works again.
        run('name', '--thread', THREAD, '--worktree-name', FOLDER, '--branch', LOCAL, '--json', '--target', repo);
        expect(run('push', '--thread', THREAD, '--json', '--target', repo).status).toBe(0);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'refuses to prune by id when two checkouts claim the thread — payload names both, and both stay on disk',
      () => {
        const named = makeNamedWorktree();
        // A checkout cut before names, in the folder that IS the thread id, on another branch.
        const container = named.slice(0, named.length - FOLDER.length - 1);
        const legacy = join(container, THREAD);
        git(repo, 'worktree', 'add', '-q', '-b', 'thread/legacy', legacy);
        // The positive first: both checkouts exist and git lists them.
        expect(existsSync(named)).toBe(true);
        expect(existsSync(legacy)).toBe(true);

        const listed = run('list', '--thread', THREAD, '--json', '--target', repo);
        expect(listed.status).toBe(0);
        expect((listed.json as { worktrees: unknown[] }).worktrees).toHaveLength(2);

        const pruned = run('prune', '--thread', THREAD, '--json', '--target', repo);
        expect(pruned.status).toBe(1);
        expect(pruned.combined).toContain(`worktree refused: ambiguous-thread — 2 checkouts claim thread '${THREAD}'`);
        const payload = pruned.json as { refused: string; checkouts: Array<{ folder: string }> };
        expect(payload.refused).toBe('ambiguous-thread');
        expect(payload.checkouts.map((checkout) => checkout.folder).sort()).toEqual([FOLDER, THREAD].sort());
        expect(existsSync(named)).toBe(true);
        expect(existsSync(legacy)).toBe(true);

        // Two checkouts that both RECORD the thread are the same question.
        const ownerFile = join(git(legacy, 'rev-parse', '--absolute-git-dir').trim(), 'planflow-thread');
        writeFileSync(ownerFile, `${THREAD}\n`);
        expect(run('prune', '--thread', THREAD, '--json', '--target', repo).status).toBe(1);
        expect(existsSync(named)).toBe(true);
        expect(existsSync(legacy)).toBe(true);

        // Naming the folder settles it: that one is pruned, the other kept.
        const settled = run('prune', '--thread', THREAD, '--worktree-name', FOLDER, '--json', '--target', repo);
        expect(settled.status).toBe(0);
        expect(existsSync(named)).toBe(false);
        expect(existsSync(legacy)).toBe(true);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'prunes a named checkout asked for by its thread id, instead of answering absent',
      () => {
        const path = makeNamedWorktree();
        expect(existsSync(path)).toBe(true);

        const pruned = run('prune', '--thread', THREAD, '--json', '--target', repo);

        expect(pruned.status).toBe(0);
        expect(pruned.json).toMatchObject({ status: 'pruned', path });
        expect(existsSync(path)).toBe(false);
        // The branch outlives the checkout, as prune promises.
        expect(git(repo, 'branch', '--list', LOCAL).trim()).not.toBe('');
      },
      E2E_TIMEOUT_MS,
    );
  },
);
