import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultBranchRef, projectCheckout, tokenLanded } from './knowledge-landing.js';
import { runTrailer } from '../state/knowledge-status.js';
import type { WorkspaceGit } from './workspace-model.js';

const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_OK ? describe : describe.skip;

describeWithGit('tokenLanded against real git', () => {
  let sandbox: string;
  let repo: string;

  const git: WorkspaceGit = (args, cwd) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };

  const sh = (...args: string[]): string => git(args, repo);

  function commit(message: string, file = 'f.txt'): void {
    writeFileSync(join(repo, file), `${Math.random()}\n`);
    sh('add', '-A');
    sh('commit', '-q', '-m', message);
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'pf-landing-'));
    repo = join(sandbox, 'code');
    mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    sh('config', 'user.name', 'Test Person');
    sh('config', 'user.email', 'test@example.com');
    commit('chore: first');
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('finds a token on the default branch, and not one that never landed', () => {
    // POSITIVE FIRST: a token that IS there must be found, or the `false`
    // below would pass just as well against a grep that matches nothing (#28).
    commit(`feat(phase-1.task-1): orders — orders\n\n${runTrailer('run_landed')}`);
    expect(tokenLanded(git, repo, 'run_landed')).toBe(true);
    expect(tokenLanded(git, repo, 'run_elsewhere')).toBe(false);
  });

  it('does not find a token that is only on a feature branch — the pending case', () => {
    sh('checkout', '-q', '-b', 'feat/x');
    commit(`feat(phase-1.task-1): orders — orders\n\n${runTrailer('run_pending')}`);
    sh('checkout', '-q', 'main');
    expect(tokenLanded(git, repo, 'run_pending')).toBe(false);
  });

  it('still finds it after a SQUASH merge, which is the whole reason for a trailer', () => {
    // A squash mints a new commit, so the branch's sha is never an ancestor of
    // main. The body survives, so the token does.
    sh('checkout', '-q', '-b', 'feat/y');
    commit(`feat(phase-1.task-1): orders — orders\n\n${runTrailer('run_squashed')}`);
    const branchSha = sh('rev-parse', 'HEAD').trim();
    sh('checkout', '-q', 'main');
    sh('merge', '-q', '--squash', 'feat/y');
    sh('commit', '-q', '-m', `Merged PR 42: orders\n\n${runTrailer('run_squashed')}`);

    // The original commit is NOT on main (exit 1 — which is why this is read
    // off the status and not through `sh`, which throws on non-zero)…
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', branchSha, 'main'], { cwd: repo });
    expect(ancestor.status).not.toBe(0);
    // …and the token is, which is exactly the case a sha-based check fails.
    expect(tokenLanded(git, repo, 'run_squashed')).toBe(true);
  });

  it('matches the token literally, so it cannot be a pattern', () => {
    commit(`feat: something\n\n${runTrailer('run_abc')}`);
    expect(tokenLanded(git, repo, 'run_abc')).toBe(true);
    // A malformed token is unanswerable, never a grep.
    expect(tokenLanded(git, repo, 'run_*')).toBe(null);
    expect(tokenLanded(git, repo, '$(touch pwned)')).toBe(null);
  });

  it('answers null when the question cannot be asked, never false', () => {
    // These three are "the project is not here", not "it did not land" — and
    // the disposition shares on null, so a moved folder never silently stops
    // publishing.
    expect(tokenLanded(git, join(sandbox, 'does-not-exist'), 'run_x')).toBe(null);
    const notARepo = join(sandbox, 'plain');
    mkdirSync(notARepo, { recursive: true });
    expect(tokenLanded(git, notARepo, 'run_x')).toBe(null);
  });

  it('prefers the remote’s recorded default branch over guessing main', () => {
    // A shop whose trunk is `develop` would otherwise have every document
    // answered "not landed" for ever.
    sh('checkout', '-q', '-b', 'develop');
    commit(`feat: on develop\n\n${runTrailer('run_dev')}`);
    sh('update-ref', 'refs/remotes/origin/develop', 'HEAD');
    sh('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    sh('checkout', '-q', 'main');

    expect(defaultBranchRef(git, repo)).toBe('refs/remotes/origin/develop');
    expect(tokenLanded(git, repo, 'run_dev')).toBe(true);
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
