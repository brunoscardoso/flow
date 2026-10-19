/**
 * Tests for team-knowledge-sharing Phase 3: convertToSeparate / convertToSame.
 * Git is a FAKE (records argv, throws on anything unexpected) so we assert the
 * exact git sequence AND the file effects, with a real temp filesystem.
 */

import { jest } from '@jest/globals';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash as hashOf } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.unstable_mockModule('../utils/prompts.js', () => ({
  askBusinessContext: jest.fn(),
  askLegacyFilesAction: jest.fn(),
  selectPlatforms: jest.fn(),
}));

const { convertToSeparate, convertToSame } = await import('./knowledge-migration.js');

const URL = 'git@github.com:team/brain.git';

function seedProject(root: string): void {
  mkdirSync(join(root, 'flow', 'brain', 'features'), { recursive: true });
  writeFileSync(join(root, 'flow', 'brain', 'features', 'chats.md'), '# chats\n');
  mkdirSync(join(root, '.claude', 'rules', 'core'), { recursive: true });
  writeFileSync(join(root, '.claude', 'rules', 'core', 'allowed-patterns.md'), '# allowed\n');
}

/** A fake git that records every argv. Never touches disk. */
function fakeGit(): { exec: (args: string[], cwd: string) => void; calls: string[][] } {
  const calls: string[][] = [];
  return { exec: (args) => { calls.push(args); }, calls };
}

describe('convertToSeparate (Phase 3)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pf-conv-'));
    seedProject(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('runs the expected git sequence and applies the file effects', () => {
    const git = fakeGit();
    const result = convertToSeparate(root, { url: URL }, ['claude'], git.exec);

    expect(result.ok).toBe(true);
    // git sequence, in order — BOTH flow/ and .claude/rules are untracked from
    // the parent (review F1: gitignore alone does not untrack a tracked path).
    expect(git.calls).toEqual([
      ['init', '-q', '-b', 'main'],
      ['remote', 'add', '--', 'origin', URL],
      ['rm', '-r', '--cached', '--ignore-unmatch', 'flow'],
      ['rm', '-r', '--cached', '--ignore-unmatch', '.claude/rules'],
      ['add', '-A'],
      ['commit', '-m', 'chore(plan-flow): initialize team brain repo'],
    ]);
    // Explicitly: the code repo must stop tracking rules after conversion.
    expect(git.calls).toContainEqual(['rm', '-r', '--cached', '--ignore-unmatch', '.claude/rules']);
    // brain .gitignore seeded inside flow/
    expect(existsSync(join(root, 'flow', '.gitignore'))).toBe(true);
    expect(readFileSync(join(root, 'flow', '.gitignore'), 'utf8')).toContain('brain/.raw/');
    // rules moved into the brain AND materialized back to .claude/rules
    expect(existsSync(join(root, 'flow', 'rules', 'core', 'allowed-patterns.md'))).toBe(true);
    expect(existsSync(join(root, '.claude', 'rules', 'core', 'allowed-patterns.md'))).toBe(true);
    // parent .gitignore records separate + the committed pointer
    const parentGi = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(parentGi).toContain('# Knowledge sharing: separate');
    expect(parentGi).toContain(`# Brain repo: ${URL}`);
    expect(parentGi).toContain('/flow');
    expect(parentGi).toContain('/.claude/rules');
  });

  it.each(['--upload-pack=touch /tmp/pwned', 'ext::sh -c touch% /tmp/pwned', 'http://github.com/team/brain.git'])(
    'refuses the pointer %j before running any git',
    (url) => {
      const git = fakeGit();
      const result = convertToSeparate(root, { url }, ['claude'], git.exec);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/^(invalid|insecure)-remote: /);
      expect(git.calls).toEqual([]);
      expect(existsSync(join(root, '.gitignore'))).toBe(false);
    }
  );

  it('refuses when flow/ is already a separate repo, running no git', () => {
    mkdirSync(join(root, 'flow', '.git'), { recursive: true });
    const git = fakeGit();
    const result = convertToSeparate(root, { url: URL }, ['claude'], git.exec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already a separate/);
    expect(git.calls).toEqual([]);
  });
});

describe('convertToSame (Phase 3, reverse)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pf-conv-'));
    seedProject(root);
    // Simulate a separate-mode project: flow/ is a nested repo with rules inside.
    mkdirSync(join(root, 'flow', '.git'), { recursive: true });
    mkdirSync(join(root, 'flow', 'rules', 'core'), { recursive: true });
    writeFileSync(join(root, 'flow', 'rules', 'core', 'allowed-patterns.md'), '# allowed\n');
    writeFileSync(join(root, 'flow', '.gitignore'), '# brain\n');
    rmSync(join(root, '.claude', 'rules'), { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('drops the nested repo, restores rules to the parent, rewrites the gitignore', () => {
    const result = convertToSame(root, ['claude'], 'shared');
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, 'flow', '.git'))).toBe(false);
    expect(existsSync(join(root, 'flow', '.gitignore'))).toBe(false);
    // rules back in the parent's .claude/rules, gone from the brain
    expect(existsSync(join(root, '.claude', 'rules', 'core', 'allowed-patterns.md'))).toBe(true);
    expect(existsSync(join(root, 'flow', 'rules'))).toBe(false);
    // parent .gitignore back to shared
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('# Knowledge sharing: shared');
  });

  it('refuses when flow/ is not a separate repo', () => {
    rmSync(join(root, 'flow', '.git'), { recursive: true, force: true });
    const result = convertToSame(root, ['claude'], 'shared');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a separate/);
  });
});

// ── Phase 2: enable / disable / status against a REAL git ─────────────────────
//
// Every fixture lives under one mkdtemp sandbox: the project, the vault
// (PLAN_FLOW_VAULT_DIR), a private git config (GIT_CONFIG_GLOBAL, no system
// config) and a bare repo standing in for GitHub on PUSH only (pushInsteadOf),
// so `get-url` still reports the github.com address the verbs validate.
// Nothing touches this repository, the real vault, or the developer's git config.

const writeFile = writeFileSync;

const {
  enableKnowledgeSync,
  disableKnowledgeSync,
  knowledgeStatus,
  adoptKnowledgeRepo,
  parseGitRemote,
  parseKnowledgeBranch,
  redactRemote,
  remoteIdentity,
  sameRemoteRepo,
  KnowledgeRefusal,
} = await import('./knowledge-migration.js');
const { getPackageRoot } = await import('../utils/files.js');
const { buildBrainRepoGitignore, buildGitignoreBlock, initShared, knowledgeRepoLocalEntries } = await import('./shared.js');

const GITHUB_URL = 'https://github.com/team/knowledge';
const ENV_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_ALLOW_PROTOCOL',
  'GIT_TERMINAL_PROMPT',
  'PLAN_FLOW_VAULT_DIR',
  'COPILOT_HOME',
] as const;
/** Other hosts' addresses, mapped onto the local bare repos by `insteadOf` — never the network. */
const AZURE_URL = 'https://dev.azure.com/acme/Orbit/_git/knowledge';
const AZURE_SSH_URL = 'git@ssh.dev.azure.com:v3/acme/Orbit/knowledge';
const GITLAB_URL = 'git@gitlab.com:acme/platform/knowledge';
const PENDING_URL = 'https://gitlab.com/acme/platform/knowledge';

/** git in a fixture. `env` is explicit: jest's sandboxed `process.env` is NOT
 *  what a child inherits by default, and the fixture's private config lives there. */
function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}

/** Every file under `dir` (links recorded, never followed) → content hash. */
function snapshotTree(dir: string, skip: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const rel = `${prefix}${entry}`;
      if (skip.includes(rel)) continue;
      const full = join(current, entry);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) out[rel] = `link:${readlinkSync(full)}`;
      else if (info.isDirectory()) walk(full, `${rel}/`);
      else out[rel] = hashOf('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

const WORKING_SET = '---\nthread_id: 7f3a\n---\nWorking set for a thread\n';

/** The knowledge a real project carries — precious, derived and personal. */
function seedKnowledge(flow: string): void {
  const write = (rel: string, body: string): void => {
    mkdirSync(join(flow, rel, '..'), { recursive: true });
    writeFile(join(flow, rel), body);
  };
  write('brain/features/chats.md', '# Chats\n');
  write('brain/features/thread-7f3a.md', WORKING_SET);
  write('brain/.structure/annotations.jsonl', '{"a":1}\n{"a":2}\n');
  write('brain/.structure/feature-candidates.jsonl', '{"c":1}\n');
  write('brain/.structure/graph.json', '{}\n');
  write('brain/.structure/surface.json', '{}\n');
  write('brain/.structure/outbound.json', '{}\n');
  write('brain/.structure/brain-usage.json', '{}\n');
  write('brain/.structure/invariant-verdicts.json', '{}\n');
  write('brain/.structure/feature-views/chats.json', '{}\n');
  write('plans/plan_x_v1.md', '# Plan\n');
  write('ledger.md', '# Ledger\n');
  write('STATE.md', '# State\n');
  write('.scratchpad.md', 'scratch\n');
  write('.flowconfig', 'share: local\n');
}

type StartShape = 'vault' | 'shared' | 'local' | 'none';

interface Fixture {
  sandbox: string;
  root: string;
  vault: string;
  vaultFlow: string;
  bare: string;
}

function makeSandbox(): Fixture {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-knowledge-')));
  const root = join(sandbox, 'proj');
  const vault = join(sandbox, 'vault');
  const bare = join(sandbox, 'remotes');
  mkdirSync(root, { recursive: true });
  mkdirSync(bare, { recursive: true });
  writeFile(
    join(sandbox, 'gitconfig'),
    `[user]\n\tname = Test Person\n\temail = test@example.com\n[url "${bare}/"]\n\tpushInsteadOf = https://github.com/team/\n` +
      `\tinsteadOf = https://dev.azure.com/acme/Orbit/_git/\n\tinsteadOf = git@ssh.dev.azure.com:v3/acme/Orbit/\n` +
      `\tinsteadOf = git@gitlab.com:acme/platform/\n\tinsteadOf = https://gitlab.com/acme/platform/\n`
  );
  process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  // Only local paths may be reached: an address the mapping misses fails, it never dials out.
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.PLAN_FLOW_VAULT_DIR = vault;
  process.env.COPILOT_HOME = join(sandbox, 'copilot');
  sh(bare, 'init', '-q', '--bare', '-b', 'main', 'knowledge');
  return { sandbox, root, vault, vaultFlow: join(vault, 'projects', 'proj', 'flow'), bare };
}

function makeProject(fx: Fixture, shape: StartShape): void {
  const { root } = fx;
  sh(root, 'init', '-q', '-b', 'main');
  writeFile(join(root, 'app.ts'), 'export {}\n');
  mkdirSync(join(root, '.claude', 'rules', 'core'), { recursive: true });
  writeFile(join(root, '.claude', 'rules', 'core', 'allowed-patterns.md'), '# allowed\n');
  const mode = shape === 'shared' ? 'shared' : 'local';
  writeFile(join(root, '.gitignore'), buildGitignoreBlock(['claude'], mode) + '\n');
  if (shape === 'vault') {
    seedKnowledge(fx.vaultFlow);
    symlinkSync(fx.vaultFlow, join(root, 'flow'), 'dir');
  } else if (shape === 'local' || shape === 'shared') {
    seedKnowledge(join(root, 'flow'));
    if (shape === 'shared') writeFile(join(root, 'flow', '.flowconfig'), 'share: shared\n');
  }
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'init');
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function refusalOf(fn: () => unknown): InstanceType<typeof KnowledgeRefusal> {
  try {
    fn();
  } catch (error) {
    if (error instanceof KnowledgeRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const head = (cwd: string): string => sh(cwd, 'rev-parse', 'HEAD').trim();
const porcelain = (cwd: string): string => sh(cwd, 'status', '--porcelain');
const committedFiles = (cwd: string): string[] => sh(cwd, 'ls-files').split('\n').filter((line) => line.length > 0);

interface RemoteFixtures {
  accept: { url: string; host: string; provider: string }[];
  refuse: { url: string; reason: string }[];
  branches: { accept: string[]; refuse: string[] };
  identities: { cases: { url: string; identity: string }[] };
}

/** THE list both parsers answer to — read from the repo, never copied here. */
const FIXTURES = JSON.parse(
  readFileSync(join(getPackageRoot(), 'app', 'src', 'shared', 'git-remote-fixtures.json'), 'utf-8')
) as RemoteFixtures;

describe('parseGitRemote — parity with the shared fixture list (any git host)', () => {
  it('the list is the one the app reads, and it is not empty', () => {
    expect(FIXTURES.accept.length).toBeGreaterThan(10);
    expect(FIXTURES.refuse.length).toBeGreaterThan(10);
  });

  it.each(FIXTURES.accept.map((entry) => [entry.url, entry] as const))('accepts %s', (url, entry) => {
    expect(parseGitRemote(url)).toEqual({ ok: true, url, host: entry.host, provider: entry.provider });
  });

  it.each(FIXTURES.refuse.map((entry) => [entry.url, entry.reason] as const))('refuses %j as %s', (url, reason) => {
    const verdict = parseGitRemote(url);
    expect(verdict).toMatchObject({ ok: false, reason });
    // The detail is for a person — it never repeats the address, which may hold a secret.
    if (!verdict.ok && url.length > 0) expect(verdict.detail).not.toContain(url);
  });

  it.each(FIXTURES.branches.accept)('accepts the branch %j', (branch) => {
    expect(parseKnowledgeBranch(branch)).toEqual({ ok: true, branch });
  });

  it('has identity cases (an empty list would pass vacuously)', () => {
    expect(FIXTURES.identities.cases.length).toBeGreaterThan(10);
  });

  // The project id a Workspace gives a repository — the app's port must agree.
  it.each(FIXTURES.identities.cases.map((entry) => [entry.url, entry.identity] as const))('names %s as %s', (url, identity) => {
    expect(remoteIdentity(url)).toBe(identity);
  });

  it.each(FIXTURES.branches.refuse)('refuses the branch %j', (branch) => {
    expect(parseKnowledgeBranch(branch)).toMatchObject({ ok: false, reason: 'invalid-branch' });
  });

  it.each([
    'https://user:pass@github.com/team/knowledge',
    'https://ghp_abc123@github.com/team/knowledge.git',
    'ghp_abc123@github.com:team/knowledge.git',
    'https://github.com/team/knowledge?access_token=abc',
  ])('refuses %s as credentials-in-url, and redacts it', (url) => {
    expect(parseGitRemote(url)).toMatchObject({ ok: false, reason: 'credentials-in-url' });
    expect(redactRemote(url)).not.toMatch(/pass|ghp_abc123|=abc/);
  });

  it('treats the transports of one repository as the same repository', () => {
    expect(sameRemoteRepo('https://github.com/Team/Knowledge.git', 'git@github.com:team/knowledge.git')).toBe(true);
    expect(sameRemoteRepo(GITHUB_URL, 'https://github.com/team/other')).toBe(false);
    expect(
      sameRemoteRepo('https://acme@dev.azure.com/acme/Orbit/_git/orbit-app-flow', 'git@ssh.dev.azure.com:v3/acme/Orbit/orbit-app-flow')
    ).toBe(true);
    expect(
      sameRemoteRepo('https://acme.visualstudio.com/Orbit/_git/orbit-app-flow', 'https://dev.azure.com/acme/Orbit/_git/orbit-app-flow')
    ).toBe(true);
    expect(
      sameRemoteRepo('https://git.acme.internal:8443/knowledge/flow.git', 'ssh://git@git.acme.internal:2222/knowledge/flow.git')
    ).toBe(true);
    expect(sameRemoteRepo('https://gitlab.com/acme/flow.git', 'https://github.com/acme/flow.git')).toBe(false);
  });
});

describe('knowledge sync — status, enable, disable (real git)', () => {
  let fx: Fixture;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    fx = makeSandbox();
  });
  afterEach(() => {
    restoreEnv(saved);
    rmSync(fx.sandbox, { recursive: true, force: true });
  });

  describe('status for every shape', () => {
    it.each(['vault', 'shared', 'local', 'none'] as const)('reports %s', (shape) => {
      makeProject(fx, shape);
      const status = knowledgeStatus(fx.root);
      expect(status).toMatchObject({ shape, remote: null, pointer: null, hasRepo: false, unpushed: null, conflicted: [] });
      expect(status.vaultPath).toBe(shape === 'vault' ? fx.vaultFlow : null);
    });

    it('reports separate, with the remote, the pointer and every commit unpushed', () => {
      makeProject(fx, 'local');
      enableKnowledgeSync(fx.root, { remote: GITHUB_URL });
      writeFile(join(fx.root, 'app.ts'), 'export const x = 1\n');
      expect(knowledgeStatus(fx.root)).toMatchObject({
        shape: 'separate',
        remote: GITHUB_URL,
        pointer: { url: GITHUB_URL, branch: 'main' },
        hasRepo: true,
        unpushed: 1,
        hasUpstream: false,
        branch: 'main',
        conflicted: [],
        dirtyCode: ['.gitignore', 'app.ts'],
      });
    });
  });

  describe('enable from each starting shape', () => {
    function expectKnowledgeRepo(): void {
      const flow = join(fx.root, 'flow');
      expect(lstatSync(flow).isDirectory()).toBe(true);
      expect(existsSync(join(flow, '.git'))).toBe(true);
      expect(sh(flow, 'remote', 'get-url', 'origin').trim()).toBe(GITHUB_URL);
      expect(sh(flow, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
      expect(sh(flow, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Test Person <test@example.com>');
      // Not pushed: the stand-in remote has no branches at all.
      expect(sh(join(fx.bare, 'knowledge'), 'for-each-ref', 'refs/heads/')).toBe('');
      const gi = readFileSync(join(fx.root, '.gitignore'), 'utf-8');
      expect(gi).toContain('# Knowledge sharing: separate');
      expect(gi).toContain(`# Brain repo: ${GITHUB_URL} main`);
      expect(readFileSync(join(flow, '.flowconfig'), 'utf-8')).toMatch(/^share: separate$/m);
    }

    it('vault: copies, verifies, swaps the link for the repo, and leaves the vault folder as the backup', () => {
      makeProject(fx, 'vault');
      const vaultBefore = snapshotTree(fx.vaultFlow);
      const headBefore = head(fx.root);

      const result = enableKnowledgeSync(fx.root, { remote: GITHUB_URL });

      expect(result).toMatchObject({ status: 'enabled', from: 'vault', vaultBackup: fx.vaultFlow, pushed: false });
      expect(result.codeRepo).toMatchObject({ committed: false, changed: ['.gitignore'] });
      expect(result.codeRepo.rulesStillTracked).toEqual(['.claude/rules/core/allowed-patterns.md']);
      expect(result.verified?.files).toBeGreaterThan(0);
      expectKnowledgeRepo();
      expect(snapshotTree(fx.vaultFlow)).toEqual(vaultBefore);
      expect(head(fx.root)).toBe(headBefore);
      // No staging left behind, and none would show in the code repo's status.
      expect(readdirSync(fx.root).filter((name) => name.startsWith('.flow-staging-'))).toEqual([]);
      expect(porcelain(fx.root)).toBe(' M .gitignore\n');
    });

    it('shared: untracks flow/ and the rules in ONE code-repo commit, reported in the payload', () => {
      makeProject(fx, 'shared');
      const headBefore = head(fx.root);

      const result = enableKnowledgeSync(fx.root, { remote: GITHUB_URL });

      expectKnowledgeRepo();
      expect(sh(fx.root, 'rev-parse', 'HEAD~1').trim()).toBe(headBefore);
      expect(result.codeRepo.committed).toBe(true);
      expect(result.codeRepo.commit).toEqual({
        sha: head(fx.root),
        message: "chore(plan-flow): keep this project's knowledge in its own repo",
        files: result.codeRepo.commit?.files,
      });
      expect(result.codeRepo.commit?.files).toBeGreaterThan(1);
      expect(committedFiles(fx.root).filter((path) => path.startsWith('flow/') || path.startsWith('.claude/rules'))).toEqual([]);
      expect(porcelain(fx.root)).toBe('');
      // The rules now travel with the knowledge, and stay where the SDK loads them.
      expect(existsSync(join(fx.root, 'flow', 'rules', 'core', 'allowed-patterns.md'))).toBe(true);
      expect(existsSync(join(fx.root, '.claude', 'rules', 'core', 'allowed-patterns.md'))).toBe(true);
    });

    it('local: makes the repo in place', () => {
      makeProject(fx, 'local');
      const inode = lstatSync(join(fx.root, 'flow')).ino;
      const result = enableKnowledgeSync(fx.root, { remote: GITHUB_URL, branch: 'main' });
      expect(result.from).toBe('local');
      expect(lstatSync(join(fx.root, 'flow')).ino).toBe(inode);
      expectKnowledgeRepo();
    });

    it('none: scaffolds flow/ and makes the repo', () => {
      makeProject(fx, 'none');
      const result = enableKnowledgeSync(fx.root, { remote: 'git@github.com:team/knowledge.git' });
      expect(result.from).toBe('none');
      expect(existsSync(join(fx.root, 'flow', 'plans', '.gitkeep'))).toBe(true);
      expect(sh(join(fx.root, 'flow'), 'ls-files')).toContain('plans/.gitkeep');
    });

    it('commits knowledge and append-only stores; keeps derived files and per-thread working sets local', () => {
      makeProject(fx, 'local');
      const result = enableKnowledgeSync(fx.root, { remote: GITHUB_URL });
      const tracked = committedFiles(join(fx.root, 'flow'));

      for (const kept of [
        'brain/features/chats.md',
        'brain/.structure/annotations.jsonl',
        'brain/.structure/feature-candidates.jsonl',
        'plans/plan_x_v1.md',
        'ledger.md',
        'rules/core/allowed-patterns.md',
        '.gitignore',
        '.gitattributes',
      ]) {
        expect(tracked).toContain(kept);
      }
      for (const local of [
        'brain/features/thread-7f3a.md',
        'brain/features/.gitignore',
        'brain/.structure/graph.json',
        'brain/.structure/surface.json',
        'brain/.structure/outbound.json',
        'brain/.structure/brain-usage.json',
        'brain/.structure/invariant-verdicts.json',
        'brain/.structure/feature-views/chats.json',
        'STATE.md',
        '.scratchpad.md',
        '.flowconfig',
      ]) {
        expect(tracked).not.toContain(local);
      }
      expect(result.workingSetsIgnored).toEqual(['thread-7f3a.md']);
      expect(readFileSync(join(fx.root, 'flow', '.gitattributes'), 'utf-8')).toContain('*.jsonl merge=union');
      expect(knowledgeRepoLocalEntries()).not.toContain('brain/.structure/feature-candidates.jsonl');
    });

    it('is idempotent: the same remote is a no-op success, a different one refuses with the current remote', () => {
      makeProject(fx, 'local');
      enableKnowledgeSync(fx.root, { remote: GITHUB_URL });
      const flowHead = head(join(fx.root, 'flow'));
      const before = snapshotTree(fx.root, ['.git', 'flow/.git']);

      const again = enableKnowledgeSync(fx.root, { remote: 'git@github.com:team/knowledge.git' });
      expect(again).toMatchObject({ status: 'unchanged', remote: GITHUB_URL, knowledgeCommit: null });
      expect(head(join(fx.root, 'flow'))).toBe(flowHead);
      expect(snapshotTree(fx.root, ['.git', 'flow/.git'])).toEqual(before);

      const refusal = refusalOf(() => enableKnowledgeSync(fx.root, { remote: 'https://github.com/team/other' }));
      expect(refusal.reason).toBe('already-enabled');
      expect(refusal.payload).toMatchObject({ refused: 'already-enabled', remote: GITHUB_URL });
      expect(snapshotTree(fx.root, ['.git', 'flow/.git'])).toEqual(before);
    });

    it('refuses without a git identity — and leaves no .git behind', () => {
      makeProject(fx, 'local');
      writeFile(join(fx.sandbox, 'gitconfig'), '');
      const before = snapshotTree(fx.root, ['.git']);

      const refusal = refusalOf(() => enableKnowledgeSync(fx.root, { remote: GITHUB_URL }));

      expect(refusal.reason).toBe('no-git-identity');
      expect(refusal.payload).toMatchObject({ missing: ['user.name', 'user.email'], restored: true, step: 'identity' });
      expect(existsSync(join(fx.root, 'flow', '.git'))).toBe(false);
      expect(snapshotTree(fx.root, ['.git'])).toEqual(before);
    });
  });

  describe('a failure at any step leaves the original shape intact', () => {
    const STEPS: Record<StartShape, string[]> = {
      vault: ['prepare', 'init', 'identity', 'remote', 'files', 'commit', 'swap', 'code-ignore'],
      none: ['prepare', 'init', 'identity', 'remote', 'files', 'commit', 'code-ignore'],
      local: ['prepare', 'init', 'identity', 'remote', 'files', 'commit', 'code-ignore'],
      shared: ['prepare', 'init', 'identity', 'remote', 'files', 'commit', 'code-ignore', 'code-untrack', 'code-commit'],
    };
    const cases = (Object.keys(STEPS) as StartShape[]).flatMap((shape) =>
      STEPS[shape].map((step) => [shape, step] as const)
    );

    it.each(cases)('%s, failing at %s', (shape, failAt) => {
      makeProject(fx, shape);
      const headBefore = head(fx.root);
      const statusBefore = porcelain(fx.root);
      const treeBefore = snapshotTree(fx.root, ['.git']);
      const vaultBefore = shape === 'vault' ? snapshotTree(fx.vaultFlow) : null;
      const reached: string[] = [];

      const refusal = refusalOf(() =>
        enableKnowledgeSync(fx.root, {
          remote: GITHUB_URL,
          deps: {
            checkpoint: (step) => {
              reached.push(step);
              if (step === failAt) throw new Error(`injected failure at ${step}`);
            },
          },
        })
      );

      // Positive first (allowed-pattern #28): the run really got to that step.
      expect(reached[reached.length - 1]).toBe(failAt);
      expect(refusal.reason).toBe('failed');
      expect(refusal.payload).toMatchObject({ step: failAt, restored: true, restoreProblems: [] });
      expect(head(fx.root)).toBe(headBefore);
      expect(porcelain(fx.root)).toBe(statusBefore);
      expect(snapshotTree(fx.root, ['.git'])).toEqual(treeBefore);
      expect(knowledgeStatus(fx.root).shape).toBe(shape);
      if (vaultBefore !== null) {
        expect(lstatSync(join(fx.root, 'flow')).isSymbolicLink()).toBe(true);
        expect(snapshotTree(fx.vaultFlow)).toEqual(vaultBefore);
      }
    });

    it('shared, with git itself failing the code-repo commit', () => {
      makeProject(fx, 'shared');
      const headBefore = head(fx.root);
      const treeBefore = snapshotTree(fx.root, ['.git']);
      let refusedCommit = false;

      const refusal = refusalOf(() =>
        enableKnowledgeSync(fx.root, {
          remote: GITHUB_URL,
          deps: {
            git: (args, cwd) => {
              if (cwd === fx.root && args.includes('commit')) {
                refusedCommit = true;
                throw new Error('pre-commit hook said no');
              }
              return sh(cwd, ...args);
            },
          },
        })
      );

      expect(refusedCommit).toBe(true);
      expect(refusal.payload).toMatchObject({ step: 'code-commit', restored: true });
      expect(head(fx.root)).toBe(headBefore);
      expect(porcelain(fx.root)).toBe('');
      expect(snapshotTree(fx.root, ['.git'])).toEqual(treeBefore);
    });
  });

  describe('refusals before anything changes', () => {
    it('dirty-code on a shared project names the files and changes nothing', () => {
      makeProject(fx, 'shared');
      writeFile(join(fx.root, 'app.ts'), 'export const dirty = true\n');
      const before = snapshotTree(fx.root, ['.git']);
      const headBefore = head(fx.root);

      const refusal = refusalOf(() => enableKnowledgeSync(fx.root, { remote: GITHUB_URL }));

      expect(refusal.payload).toMatchObject({ refused: 'dirty-code', dirtyCode: ['app.ts'] });
      expect(existsSync(join(fx.root, 'flow', '.git'))).toBe(false);
      expect(head(fx.root)).toBe(headBefore);
      expect(snapshotTree(fx.root, ['.git'])).toEqual(before);
    });

    it('clone-pending when the committed block already names a knowledge repo', () => {
      makeProject(fx, 'local');
      writeFile(join(fx.root, '.gitignore'), buildGitignoreBlock(['claude'], 'separate', { url: GITHUB_URL }) + '\n');
      const refusal = refusalOf(() => enableKnowledgeSync(fx.root, { remote: GITHUB_URL }));
      expect(refusal.payload).toMatchObject({ refused: 'clone-pending', pointer: { url: GITHUB_URL } });
      expect(existsSync(join(fx.root, 'flow', '.git'))).toBe(false);
    });
  });

  describe('provisioning after enable (Phase 1 guard, end to end)', () => {
    it.each(['vault', 'local'] as const)('from %s: initShared leaves flow/ and flow/.git exactly as they are', async (shape) => {
      makeProject(fx, shape);
      enableKnowledgeSync(fx.root, { remote: GITHUB_URL });
      const flow = join(fx.root, 'flow');
      const before = snapshotTree(flow);
      const inode = lstatSync(flow).ino;

      await initShared(fx.root, { force: false, nonInteractive: true }, ['claude']);
      await initShared(fx.root, { force: false, nonInteractive: true }, ['claude']);

      // Positive first: provisioning ran (it registered the project in the vault).
      expect(existsSync(join(fx.vault, 'projects', 'proj', 'proj.md'))).toBe(true);
      expect(lstatSync(flow).isSymbolicLink()).toBe(false);
      expect(lstatSync(flow).ino).toBe(inode);
      expect(snapshotTree(flow)).toEqual(before);
      // …and it kept the pointer, because the local setting agrees with the block.
      expect(readFileSync(join(fx.root, '.gitignore'), 'utf-8')).toContain(`# Brain repo: ${GITHUB_URL} main`);
      expect(knowledgeStatus(fx.root).shape).toBe('separate');
    });
  });

  describe('disable', () => {
    function enabledProject(shape: StartShape = 'local'): string {
      makeProject(fx, shape);
      enableKnowledgeSync(fx.root, { remote: GITHUB_URL });
      return join(fx.root, 'flow');
    }

    it('refuses unpushed (no upstream counts every commit) and changes nothing', () => {
      const flow = enabledProject();
      const before = snapshotTree(fx.root, ['.git']);

      const refusal = refusalOf(() => disableKnowledgeSync(fx.root, { to: 'vault', confirmed: true }));

      expect(refusal.payload).toMatchObject({ refused: 'unpushed', unpushed: 1, hasUpstream: false, remote: GITHUB_URL });
      expect(snapshotTree(fx.root, ['.git'])).toEqual(before);
      expect(existsSync(join(flow, '.git'))).toBe(true);
      expect(existsSync(fx.vaultFlow)).toBe(false);
    });

    it('goes ahead once pushed, with no flag', () => {
      const flow = enabledProject();
      sh(flow, 'push', '-q', '-u', 'origin', 'main');
      expect(knowledgeStatus(fx.root)).toMatchObject({ unpushed: 0, hasUpstream: true });

      const result = disableKnowledgeSync(fx.root, { to: 'keep' });
      expect(result).toMatchObject({ to: 'keep', shape: 'local', unpushed: 0 });
    });

    it('keep: drops the remote and the pointer, keeps flow/ and its .git', () => {
      const flow = enabledProject();
      const flowHead = head(flow);

      const result = disableKnowledgeSync(fx.root, { to: 'keep', acceptUnpushed: true });

      expect(result).toMatchObject({ to: 'keep', shape: 'local', previousRemote: GITHUB_URL, knowledgeRepoKeptAt: join(flow, '.git') });
      expect(head(flow)).toBe(flowHead);
      expect(sh(flow, 'remote').trim()).toBe('');
      expect(readFileSync(join(fx.root, '.gitignore'), 'utf-8')).toContain('# Knowledge sharing: local');
      expect(readFileSync(join(fx.root, '.gitignore'), 'utf-8')).not.toContain('# Brain repo:');
      expect(knowledgeStatus(fx.root)).toMatchObject({ shape: 'local', hasRepo: true, pointer: null });
    });

    it('vault: needs an explicit confirmation from the caller', () => {
      const flow = enabledProject();
      const refusal = refusalOf(() => disableKnowledgeSync(fx.root, { to: 'vault', acceptUnpushed: true }));
      expect(refusal.reason).toBe('unconfirmed');
      expect(existsSync(join(flow, '.git'))).toBe(true);
    });

    it('vault: copies flow/ in, keeps the history beside it, moves the old copy aside, links flow/', () => {
      const flow = enabledProject('vault');
      writeFile(join(flow, 'plans', 'plan_new_v1.md'), '# New since enable\n');
      sh(flow, 'add', '-A');
      sh(flow, 'commit', '-q', '-m', 'more knowledge');
      const flowHead = head(flow);
      const content = snapshotTree(flow, ['.git']);
      const oldVaultCopy = snapshotTree(fx.vaultFlow);

      const result = disableKnowledgeSync(fx.root, {
        to: 'vault',
        acceptUnpushed: true,
        confirmed: true,
        deps: { now: () => new Date('2026-10-02T12:00:00Z') },
      });

      expect(result).toMatchObject({ to: 'vault', shape: 'vault', unpushed: 2, vaultPath: fx.vaultFlow, leftover: null });
      expect(lstatSync(flow).isSymbolicLink()).toBe(true);
      expect(realpathSync(flow)).toBe(fx.vaultFlow);
      // The working tree arrived intact (share setting flipped back to local).
      const arrived = snapshotTree(fx.vaultFlow);
      expect({ ...arrived, '.flowconfig': '' }).toEqual({ ...content, '.flowconfig': '' });
      expect(readFileSync(join(fx.vaultFlow, '.flowconfig'), 'utf-8')).toMatch(/^share: local$/m);
      // The old vault copy was moved aside, never deleted.
      expect(result.vaultBackup).toBe(join(fx.vault, 'projects', 'proj', 'flow.backup-2026-10-02T12-00-00Z'));
      expect(snapshotTree(result.vaultBackup as string)).toEqual(oldVaultCopy);
      // The history — including the unpushed commits — is kept and readable.
      expect(result.knowledgeRepoKeptAt).toBe(join(fx.vault, 'projects', 'proj', 'knowledge-repo-2026-10-02T12-00-00Z.git'));
      expect(sh(fx.sandbox, `--git-dir=${result.knowledgeRepoKeptAt}`, 'rev-parse', 'HEAD').trim()).toBe(flowHead);
      expect(readdirSync(fx.root).filter((name) => name.startsWith('.flow-'))).toEqual([]);
      expect(knowledgeStatus(fx.root).shape).toBe('vault');
    });

    it('vault: a failure at the link step puts flow/ and the vault back', () => {
      const flow = enabledProject('vault');
      const before = snapshotTree(flow);
      const oldVaultCopy = snapshotTree(fx.vaultFlow);

      const refusal = refusalOf(() =>
        disableKnowledgeSync(fx.root, {
          to: 'vault',
          acceptUnpushed: true,
          confirmed: true,
          deps: {
            checkpoint: (step) => {
              if (step === 'code-ignore') throw new Error('injected');
            },
          },
        })
      );

      expect(refusal.payload).toMatchObject({ step: 'code-ignore', restored: true });
      expect(lstatSync(flow).isDirectory()).toBe(true);
      expect(snapshotTree(flow)).toEqual(before);
      expect(snapshotTree(fx.vaultFlow)).toEqual(oldVaultCopy);
      expect(readdirSync(join(fx.vault, 'projects', 'proj')).sort()).toEqual(['flow']);
    });

    it('shared: folds flow/ back into the code repo in one commit, keeping the history', () => {
      const flow = enabledProject();
      sh(fx.root, 'add', '.gitignore');
      sh(fx.root, 'commit', '-q', '-m', 'turn sync on');
      const headBefore = head(fx.root);

      const result = disableKnowledgeSync(fx.root, { to: 'shared', acceptUnpushed: true, confirmed: true });

      expect(result.shape).toBe('shared');
      expect(result.codeRepo.committed).toBe(true);
      expect(result.codeRepo.commit?.message).toBe("chore(plan-flow): track this project's knowledge with the code again");
      expect(sh(fx.root, 'rev-parse', 'HEAD~1').trim()).toBe(headBefore);
      expect(existsSync(join(flow, '.git'))).toBe(false);
      expect(existsSync(join(result.knowledgeRepoKeptAt, 'HEAD'))).toBe(true);
      const tracked = committedFiles(fx.root);
      expect(tracked).toContain('flow/brain/features/chats.md');
      expect(tracked).toContain('flow/brain/.structure/annotations.jsonl');
      expect(tracked).not.toContain('flow/brain/features/thread-7f3a.md');
      expect(tracked).not.toContain('flow/brain/.structure/graph.json');
      expect(tracked).toContain('.claude/rules/core/allowed-patterns.md');
      expect(porcelain(fx.root)).toBe('');
      expect(knowledgeStatus(fx.root).shape).toBe('shared');
    });

    it('shared: refuses a dirty code tree and changes nothing', () => {
      const flow = enabledProject();
      const before = snapshotTree(fx.root, ['.git']);
      const refusal = refusalOf(() => disableKnowledgeSync(fx.root, { to: 'shared', acceptUnpushed: true, confirmed: true }));
      expect(refusal.payload).toMatchObject({ refused: 'dirty-code', dirtyCode: ['.gitignore'] });
      expect(existsSync(join(flow, '.git'))).toBe(true);
      expect(snapshotTree(fx.root, ['.git'])).toEqual(before);
    });

    it('refuses not-enabled and an unknown destination', () => {
      makeProject(fx, 'local');
      expect(refusalOf(() => disableKnowledgeSync(fx.root, { to: 'keep' })).reason).toBe('not-enabled');
      expect(refusalOf(() => disableKnowledgeSync(fx.root, { to: 'elsewhere' })).payload).toMatchObject({
        refused: 'invalid-destination',
        allowed: ['keep', 'vault', 'shared'],
      });
    });
  });
  describe('any git host (enable never dials out; the push goes to a local bare repo)', () => {
    it.each([
      ['Azure DevOps', AZURE_URL, AZURE_SSH_URL],
      ['GitLab', GITLAB_URL, 'https://gitlab.com/acme/platform/knowledge.git'],
    ])('%s: enables, records the address as typed, and its push lands in the mapped bare repo', (_host, url, otherTransport) => {
      makeProject(fx, 'vault');
      const flow = join(fx.root, 'flow');

      const result = enableKnowledgeSync(fx.root, { remote: url });

      expect(result).toMatchObject({ status: 'enabled', from: 'vault', remote: url, branch: 'main', pushed: false });
      expect(sh(flow, 'config', '--get', 'remote.origin.url').trim()).toBe(url);
      expect(readFileSync(join(fx.root, '.gitignore'), 'utf-8')).toContain(`# Brain repo: ${url} main`);
      const bareRepo = join(fx.bare, 'knowledge');
      expect(sh(bareRepo, 'for-each-ref', 'refs/heads/')).toBe('');

      sh(flow, 'push', '-q', '-u', 'origin', 'main');

      expect(sh(bareRepo, 'rev-parse', 'refs/heads/main').trim()).toBe(head(flow));
      // The stored address, not git's rewrite of it, is what status reports.
      expect(knowledgeStatus(fx.root)).toMatchObject({ shape: 'separate', remote: url, unpushed: 0, hasUpstream: true });
      expect(enableKnowledgeSync(fx.root, { remote: otherTransport })).toMatchObject({ status: 'unchanged', remote: url });
    });

    it('refuses an option-shaped address before git ever runs, and nothing happens', () => {
      makeProject(fx, 'local');
      const marker = join(fx.sandbox, 'pwned');
      const calls: string[][] = [];
      const before = snapshotTree(fx.root, ['.git']);

      const refusal = refusalOf(() =>
        enableKnowledgeSync(fx.root, {
          remote: `--upload-pack=touch ${marker}`,
          deps: {
            git: (args, cwd) => {
              calls.push(args);
              return sh(cwd, ...args);
            },
          },
        })
      );

      expect(refusal.reason).toBe('invalid-remote');
      expect(refusal.payload).toMatchObject({ refused: 'invalid-remote', remote: `--upload-pack=touch ${marker}` });
      expect(calls).toEqual([]);
      expect(existsSync(join(fx.root, 'flow', '.git'))).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(snapshotTree(fx.root, ['.git'])).toEqual(before);
    });

    it('refuses an option-shaped branch', () => {
      makeProject(fx, 'local');
      const refusal = refusalOf(() => enableKnowledgeSync(fx.root, { remote: GITHUB_URL, branch: '--upload-pack=x' }));
      expect(refusal.payload).toMatchObject({ refused: 'invalid-branch', branch: '--upload-pack=x' });
      expect(existsSync(join(fx.root, 'flow', '.git'))).toBe(false);
    });
  });

  describe('leftovers from an interrupted run', () => {
    function leaveLeftovers(): string[] {
      const staging = join(fx.root, '.flow-staging-dead');
      mkdirSync(join(staging, 'brain'), { recursive: true });
      writeFile(join(staging, 'ledger.md'), '# a stale copy\n');
      mkdirSync(join(fx.root, '.flow-retired-beef'), { recursive: true });
      writeFile(join(fx.root, '.flow-retired-beef', 'ledger.md'), '# another stale copy\n');
      return ['.flow-retired-beef', '.flow-staging-dead'];
    }

    it('status names them; enable refuses with them in the payload and changes nothing', () => {
      makeProject(fx, 'local');
      const names = leaveLeftovers();
      expect(knowledgeStatus(fx.root).leftovers).toEqual(names);
      const before = snapshotTree(fx.root, ['.git']);
      const headBefore = head(fx.root);

      const refusal = refusalOf(() => enableKnowledgeSync(fx.root, { remote: GITHUB_URL }));

      expect(refusal.reason).toBe('leftovers');
      expect(refusal.payload).toMatchObject({ refused: 'leftovers', leftovers: names });
      expect(existsSync(join(fx.root, 'flow', '.git'))).toBe(false);
      expect(head(fx.root)).toBe(headBefore);
      expect(snapshotTree(fx.root, ['.git'])).toEqual(before);
    });

    it('--clean-leftovers deletes them and goes ahead; flow/ — never the copies — becomes the knowledge', () => {
      makeProject(fx, 'local');
      const names = leaveLeftovers();
      const flow = join(fx.root, 'flow');
      const knowledgeBefore = snapshotTree(flow);

      const result = enableKnowledgeSync(fx.root, { remote: GITHUB_URL, cleanLeftovers: true });

      // Positive first: the switch really happened.
      expect(result).toMatchObject({ status: 'enabled', from: 'local', leftoversCleaned: names });
      expect(existsSync(join(flow, '.git'))).toBe(true);
      for (const name of names) expect(existsSync(join(fx.root, name))).toBe(false);
      expect(knowledgeStatus(fx.root).leftovers).toEqual([]);
      // Every file flow/ held is still there, byte for byte — the stale copies were not used.
      const after = snapshotTree(flow);
      for (const [rel, hash] of Object.entries(knowledgeBefore)) {
        if (rel === '.flowconfig') continue; // flipped to `separate` by design
        expect(after[rel]).toBe(hash);
      }
      expect(sh(flow, 'show', 'HEAD:ledger.md')).toBe('# Ledger\n');
    });
  });

  describe('adopt — a machine still linked to the vault takes up the knowledge repo', () => {
    const REMOTE_KNOWLEDGE: Record<string, string> = {
      'ledger.md': '# Ledger\n',
      'brain/features/chats.md': '# Chats\n',
    };

    /** Machine A turned sync on and pushed: the bare repo holds the knowledge. */
    function seedRemoteKnowledge(): string {
      const work = join(fx.sandbox, 'machine-a');
      mkdirSync(work, { recursive: true });
      sh(work, 'init', '-q', '-b', 'main');
      for (const [rel, body] of Object.entries(REMOTE_KNOWLEDGE)) {
        mkdirSync(join(work, rel, '..'), { recursive: true });
        writeFile(join(work, rel), body);
      }
      writeFile(join(work, '.gitignore'), buildBrainRepoGitignore() + '\n');
      sh(work, 'add', '-A');
      sh(work, 'commit', '-q', '-m', 'knowledge from machine A');
      sh(work, 'push', '-q', join(fx.bare, 'knowledge'), 'main');
      return head(work);
    }

    /** Machine B: the committed pointer, and flow/ still a link into its vault. */
    function makePendingProject(vaultFiles: Record<string, string>, url = PENDING_URL): void {
      sh(fx.root, 'init', '-q', '-b', 'main');
      writeFile(join(fx.root, 'app.ts'), 'export {}\n');
      writeFile(join(fx.root, '.gitignore'), buildGitignoreBlock(['claude'], 'separate', { url, branch: 'main' }) + '\n');
      for (const [rel, body] of Object.entries(vaultFiles)) {
        mkdirSync(join(fx.vaultFlow, rel, '..'), { recursive: true });
        writeFile(join(fx.vaultFlow, rel), body);
      }
      symlinkSync(fx.vaultFlow, join(fx.root, 'flow'), 'dir');
      sh(fx.root, 'add', '-A');
      sh(fx.root, 'commit', '-q', '-m', 'init');
    }

    const flowOf = (): string => join(fx.root, 'flow');
    const stagingLeft = (): string[] => readdirSync(fx.root).filter((name) => name.startsWith('.flow-'));

    it('status reports vault-pending, and provisioning leaves the link and the pointer alone', async () => {
      seedRemoteKnowledge();
      makePendingProject({ ...REMOTE_KNOWLEDGE, '.flowconfig': 'share: local\n' });
      const ignoreBefore = readFileSync(join(fx.root, '.gitignore'), 'utf-8');

      expect(knowledgeStatus(fx.root)).toMatchObject({
        shape: 'vault-pending',
        pointer: { url: PENDING_URL, branch: 'main' },
        vaultPath: fx.vaultFlow,
        hasRepo: false,
      });

      await initShared(fx.root, { force: false, nonInteractive: true }, ['claude']);

      // Positive first: provisioning ran.
      expect(existsSync(join(fx.vault, 'projects', 'proj', 'proj.md'))).toBe(true);
      expect(lstatSync(flowOf()).isSymbolicLink()).toBe(true);
      expect(readlinkSync(flowOf())).toBe(fx.vaultFlow);
      // The vault's `share: local` did not regenerate the block without the pointer.
      expect(readFileSync(join(fx.root, '.gitignore'), 'utf-8')).toBe(ignoreBefore);
      expect(readFileSync(join(fx.vaultFlow, '.flowconfig'), 'utf-8')).toBe('share: local\n');
      expect(knowledgeStatus(fx.root).shape).toBe('vault-pending');
    });

    it('clean: backs the vault up, clones with `--` before the address, swaps the link — no commit, no push', () => {
      const remoteHead = seedRemoteKnowledge();
      makePendingProject(REMOTE_KNOWLEDGE);
      const vaultBefore = snapshotTree(fx.vaultFlow);
      const codeHead = head(fx.root);
      const calls: string[][] = [];

      const result = adoptKnowledgeRepo(fx.root, {
        deps: {
          now: () => new Date('2026-10-03T08:00:00Z'),
          git: (args, cwd) => {
            calls.push(args);
            return sh(cwd, ...args);
          },
        },
      });

      expect(result).toMatchObject({
        action: 'adopt',
        status: 'adopted',
        shape: 'separate',
        remote: PENDING_URL,
        branch: 'main',
        head: remoteHead,
        vaultPath: fx.vaultFlow,
        vaultBackup: join(fx.vault, 'projects', 'proj', 'flow.before-adopt-2026-10-03T08-00-00Z'),
        copiedFromVault: [],
        keptBeside: [],
        committed: false,
        pushed: false,
      });
      const clone = calls.find((args) => args[0] === 'clone');
      expect(clone?.slice(0, 6)).toEqual(['clone', '-q', '--branch', 'main', '--', PENDING_URL]);
      expect(lstatSync(flowOf()).isDirectory()).toBe(true);
      expect(sh(flowOf(), 'config', '--get', 'remote.origin.url').trim()).toBe(PENDING_URL);
      expect(head(flowOf())).toBe(remoteHead);
      expect(sh(flowOf(), 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(flowOf(), '.flowconfig'), 'utf-8')).toMatch(/^share: separate$/m);
      // The vault is untouched, and its verified backup is kept.
      expect(snapshotTree(fx.vaultFlow)).toEqual(vaultBefore);
      expect(snapshotTree(result.vaultBackup)).toEqual(vaultBefore);
      // Nothing committed in the code repo, nothing pushed, nothing left over.
      expect(head(fx.root)).toBe(codeHead);
      expect(porcelain(fx.root)).toBe('');
      expect(sh(join(fx.bare, 'knowledge'), 'rev-parse', 'refs/heads/main').trim()).toBe(remoteHead);
      expect(stagingLeft()).toEqual([]);
      expect(knowledgeStatus(fx.root).shape).toBe('separate');
    });

    it('copies the files only this machine had, for the sync to commit', () => {
      seedRemoteKnowledge();
      makePendingProject({ ...REMOTE_KNOWLEDGE, 'plans/plan_b_v1.md': '# Plan only on B\n', '.flowconfig': 'share: local\n' });

      const result = adoptKnowledgeRepo(fx.root);

      expect(result.copiedFromVault).toEqual(['.flowconfig', 'plans/plan_b_v1.md']);
      expect(result.keptBeside).toEqual([]);
      expect(readFileSync(join(flowOf(), 'plans', 'plan_b_v1.md'), 'utf-8')).toBe('# Plan only on B\n');
      expect(sh(flowOf(), 'status', '--porcelain')).toBe('?? plans/\n');
      // The vault's `share: local` was overridden, or the next provision would drop the pointer.
      expect(readFileSync(join(flowOf(), '.flowconfig'), 'utf-8')).toMatch(/^share: separate$/m);
    });

    it('a file both have with different content: the clone keeps its version, the vault version sits beside it', () => {
      seedRemoteKnowledge();
      makePendingProject({ ...REMOTE_KNOWLEDGE, 'ledger.md': '# Ledger as B wrote it\n' });

      const result = adoptKnowledgeRepo(fx.root);

      expect(result.keptBeside).toEqual([{ path: 'ledger.md', besidePath: 'ledger.from-vault.md' }]);
      expect(result.copiedFromVault).toEqual([]);
      expect(readFileSync(join(flowOf(), 'ledger.md'), 'utf-8')).toBe('# Ledger\n');
      expect(readFileSync(join(flowOf(), 'ledger.from-vault.md'), 'utf-8')).toBe('# Ledger as B wrote it\n');
      expect(readFileSync(join(fx.vaultFlow, 'ledger.md'), 'utf-8')).toBe('# Ledger as B wrote it\n');
    });

    it('a failed clone puts everything back: the link, the vault, no backup, no staging', () => {
      seedRemoteKnowledge();
      makePendingProject(REMOTE_KNOWLEDGE, 'https://gitlab.com/acme/platform/missing');
      const vaultBefore = snapshotTree(fx.vaultFlow);
      const treeBefore = snapshotTree(fx.root, ['.git']);
      const linkBefore = readlinkSync(flowOf());

      const refusal = refusalOf(() => adoptKnowledgeRepo(fx.root));

      expect(refusal.reason).toBe('clone-failed');
      expect(refusal.payload).toMatchObject({ refused: 'clone-failed', step: 'clone', restored: true, restoreProblems: [] });
      expect(lstatSync(flowOf()).isSymbolicLink()).toBe(true);
      expect(readlinkSync(flowOf())).toBe(linkBefore);
      expect(snapshotTree(fx.vaultFlow)).toEqual(vaultBefore);
      expect(readdirSync(join(fx.vault, 'projects', 'proj'))).toEqual(['flow']);
      expect(stagingLeft()).toEqual([]);
      expect(snapshotTree(fx.root, ['.git'])).toEqual(treeBefore);
      expect(knowledgeStatus(fx.root).shape).toBe('vault-pending');
    });

    it('refuses an option-shaped committed pointer without running a clone', () => {
      makePendingProject(REMOTE_KNOWLEDGE, '--upload-pack=touch');
      const calls: string[][] = [];
      const treeBefore = snapshotTree(fx.root, ['.git']);

      const refusal = refusalOf(() =>
        adoptKnowledgeRepo(fx.root, {
          deps: {
            git: (args, cwd) => {
              calls.push(args);
              return sh(cwd, ...args);
            },
          },
        })
      );

      expect(refusal.reason).toBe('invalid-remote');
      expect(calls.filter((args) => args.includes('clone'))).toEqual([]);
      expect(lstatSync(flowOf()).isSymbolicLink()).toBe(true);
      expect(snapshotTree(fx.root, ['.git'])).toEqual(treeBefore);
      expect(readdirSync(join(fx.vault, 'projects', 'proj'))).toEqual(['flow']);
    });

    it('refuses when there is nothing to adopt', () => {
      makeProject(fx, 'vault');
      expect(refusalOf(() => adoptKnowledgeRepo(fx.root)).payload).toMatchObject({ refused: 'nothing-to-adopt', shape: 'vault' });
    });
  });
});
