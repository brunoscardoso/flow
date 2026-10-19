/**
 * The Workspace model — in process, a REAL git, a throwaway sandbox.
 *
 * Isolation: every Flow folder, vault, code repo and bare remote lives under
 * one mkdtemp directory. Git reads a private config (GIT_CONFIG_GLOBAL, no
 * system config) whose `insteadOf` maps the test's https addresses onto local
 * bare repos, and only the `file` transport is allowed for this process
 * (FLOW_E2E=1 + FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS=file — the model's own
 * test door). Nothing here reaches a network, and the real ~/plan-flow is
 * never named: every call passes its own Flow folder.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const model = await import('./workspace-model.js');
const { FLOW_SUBDIRS, initShared } = await import('./shared.js');
const { remoteIdentity } = await import('./knowledge-migration.js');
const { getPackageRoot, resolveFlowFolder } = await import('../utils/files.js');

const {
  WorkspaceRefusal,
  createWorkspace,
  linkRepo,
  readWorkspace,
  scanWorkspaces,
  slugify,
  uniqueSlug,
  workspaceFileProblem,
  workspaceStatus,
  workspaceGitEnv,
  provisionWorkspaceLink,
  readLocalProjects,
} = model;

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

const ENV_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'FLOW_E2E',
  'FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS',
  'PLAN_FLOW_HOME',
  'PLAN_FLOW_VAULT_DIR',
  'HOME',
] as const;

/** Expect `fn` to throw a WorkspaceRefusal with `reason`; return it. */
function refusalOf(fn: () => unknown, reason: string): InstanceType<typeof WorkspaceRefusal> {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceRefusal);
    const refusal = error as InstanceType<typeof WorkspaceRefusal>;
    expect(refusal.reason).toBe(reason);
    expect(refusal.payload).toMatchObject({ refused: reason });
    return refusal;
  }
  throw new Error(`expected a ${reason} refusal, and nothing was refused`);
}

describe('resolveFlowFolder', () => {
  it('prefers PLAN_FLOW_HOME, then follows the vault override, then the home folder', () => {
    expect(resolveFlowFolder({ PLAN_FLOW_HOME: '/x/flow', PLAN_FLOW_VAULT_DIR: '/y/brain' })).toBe('/x/flow');
    expect(resolveFlowFolder({ PLAN_FLOW_VAULT_DIR: '/y/plan-flow/brain' })).toBe('/y/plan-flow');
    // A vault somewhere else is never spilled into its unrelated parent.
    expect(resolveFlowFolder({ PLAN_FLOW_VAULT_DIR: '/y/Obsidian' })).toBe('/y/Obsidian');
    expect(resolveFlowFolder({ PLAN_FLOW_HOME: '  ' })).toMatch(/[\\/]plan-flow$/);
    expect(resolveFlowFolder({})).toMatch(/[\\/]plan-flow$/);
  });
});

describe('the model\'s pure parts', () => {
  it('scaffolds exactly the flow/ layout provisioning uses', () => {
    expect([...model.WORKSPACE_PROJECT_SUBDIRS]).toEqual([...FLOW_SUBDIRS]);
  });

  it('slugifies names and suffixes collisions', () => {
    expect(slugify('Acme Team!')).toBe('acme-team');
    expect(slugify('Ação Café')).toBe('acao-cafe');
    expect(slugify('***')).toBe('');
    expect(uniqueSlug('app', new Set(['app', 'app-2']))).toBe('app-3');
    expect(uniqueSlug('web', new Set(['app']))).toBe('web');
  });

  it('validates workspace.json strictly, sentence by sentence', () => {
    const good = {
      name: 'Team',
      slug: 'team',
      projects: [{ id: 'github.com/acme/app', name: 'app', slug: 'app', remotes: ['git@github.com:acme/app.git'] }],
    };
    expect(workspaceFileProblem(good)).toBeNull();
    expect(workspaceFileProblem({ ...good, futureKey: 1 })).toBeNull();
    expect(workspaceFileProblem([])).toMatch(/not a JSON object/);
    expect(workspaceFileProblem({ ...good, name: '' })).toMatch(/name/);
    expect(workspaceFileProblem({ ...good, slug: 'Not A Slug' })).toMatch(/slug/);
    expect(workspaceFileProblem({ ...good, remote: 'http://example.com/a/b' })).toMatch(/remote/);
    expect(workspaceFileProblem({ ...good, projects: 'x' })).toMatch(/project list/);
    expect(workspaceFileProblem({ ...good, projects: [{ ...good.projects[0], remotes: ['--upload-pack=x'] }] })).toMatch(/remote/);
    expect(workspaceFileProblem({ ...good, projects: [good.projects[0], good.projects[0]] })).toMatch(/share the id/);
    expect(
      workspaceFileProblem({ ...good, projects: [good.projects[0], { ...good.projects[0], id: 'github.com/acme/other' }] })
    ).toMatch(/share the folder name/);
  });

  it('pins project ids to the shared address grammar: every accepted fixture has one identity per repository', () => {
    const fixtures = JSON.parse(
      readFileSync(join(getPackageRoot(), 'app', 'src', 'shared', 'git-remote-fixtures.json'), 'utf-8')
    ) as { accept: { url: string }[]; refuse: { url: string }[] };
    for (const entry of fixtures.accept) expect(remoteIdentity(entry.url)).not.toBeNull();
    for (const entry of fixtures.refuse) expect(remoteIdentity(entry.url)).toBeNull();
    expect(remoteIdentity('https://github.com/Acme/App.git')).toBe(remoteIdentity('git@github.com:acme/app'));
    expect(remoteIdentity('ssh://git@github.com/acme/app.git')).toBe('github.com/acme/app');
  });

  it('hardens every git child: https/ssh only, a ceiling, no traces, no GIT_DIR', () => {
    const env = workspaceGitEnv({ GIT_TRACE: '1', GIT_DIR: '/elsewhere', PATH: '/bin' }, '/a/b/repo', true);
    expect(env).toMatchObject({ GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_CEILING_DIRECTORIES: resolve('/a/b'), GIT_TERMINAL_PROMPT: '0' });
    expect(env.GIT_TRACE).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    // The test door opens only inside a hidden e2e run.
    expect(workspaceGitEnv({ FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS: 'file' }, '/a/r', false).GIT_ALLOW_PROTOCOL).toBe('https:ssh');
    expect(workspaceGitEnv({ FLOW_E2E: '1', FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS: 'file' }, '/a/r', false).GIT_ALLOW_PROTOCOL).toBe('file');
  });
});

describeWithGit('the Workspace model against real git', () => {
  let sandbox: string;
  let flowA: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  }

  /** A code repo with one commit, optionally an origin. */
  function makeRepo(name: string, origin?: string): string {
    const repo = join(sandbox, 'code', name);
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'app.ts'), 'export {}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    if (origin !== undefined) git(repo, 'remote', 'add', 'origin', origin);
    return repo;
  }

  const head = (repo: string): string => git(repo, 'rev-parse', 'HEAD').trim();

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-model-')));
    flowA = join(sandbox, 'flow-a');
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    writeFileSync(
      join(sandbox, 'gitconfig'),
      `[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[url "file://${sandbox}/remotes/"]\n\tinsteadOf = https://git.example.test/\n`
    );
    process.env.HOME = join(sandbox, 'home');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.FLOW_E2E = '1';
    process.env.FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS = 'file';
    process.env.PLAN_FLOW_HOME = flowA;
    process.env.PLAN_FLOW_VAULT_DIR = join(sandbox, 'vault');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  describe('create', () => {
    it('makes the folder, a local git repo and workspace.json — and suffixes a taken slug', () => {
      const first = createWorkspace({ flowFolder: flowA, name: 'Acme', remote: 'https://git.example.test/team/ws.git' });
      expect(first.workspace).toMatchObject({ name: 'Acme', slug: 'acme', remote: 'https://git.example.test/team/ws.git' });
      expect(existsSync(join(flowA, 'workspaces', 'acme', '.git'))).toBe(true);
      expect(readWorkspace(flowA, 'acme').file).toEqual({
        name: 'Acme',
        slug: 'acme',
        remote: 'https://git.example.test/team/ws.git',
        projects: [],
      });
      expect(git(join(flowA, 'workspaces', 'acme'), 'config', '--get', 'remote.origin.url').trim()).toBe(
        'https://git.example.test/team/ws.git'
      );

      const second = createWorkspace({ flowFolder: flowA, name: 'acme' });
      expect(second.workspace.slug).toBe('acme-2');
      expect(second.workspace.remote).toBeNull();
    });

    it('refuses a bad remote or name before making anything', () => {
      refusalOf(() => createWorkspace({ flowFolder: flowA, name: 'Team', remote: 'http://example.com/a/b' }), 'insecure-remote');
      refusalOf(() => createWorkspace({ flowFolder: flowA, name: 'Team', remote: '/tmp/local/path' }), 'invalid-remote');
      refusalOf(() => createWorkspace({ flowFolder: flowA, name: '!!!' }), 'invalid-name');
      expect(existsSync(join(flowA, 'workspaces', 'team'))).toBe(false);
    });
  });

  describe('link', () => {
    beforeEach(() => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
    });

    it('links a repo with no flow/, records it, scaffolds the folder and keeps flow out of git', () => {
      const repo = makeRepo('backend', 'git@github.com:acme/backend.git');
      const result = linkRepo({ flowFolder: flowA, target: repo });
      const folder = join(flowA, 'workspaces', 'team', 'projects', 'backend');
      expect(result).toMatchObject({
        link: 'created',
        previous: { kind: 'none' },
        projectAdded: true,
        project: { id: 'github.com/acme/backend', name: 'backend', slug: 'backend', localPath: repo, flowPath: folder },
        codeRepo: { ignored: 'info-exclude', commit: null },
      });
      expect(readlinkSync(join(repo, 'flow'))).toBe(folder);
      for (const subdir of FLOW_SUBDIRS) expect(existsSync(join(folder, subdir))).toBe(true);
      expect(readLocalProjects(flowA)).toEqual({ 'github.com/acme/backend': repo });
      expect(git(repo, 'status', '--porcelain')).toBe('');

      // Again: nothing changes.
      const again = linkRepo({ flowFolder: flowA, target: repo });
      expect(again).toMatchObject({ link: 'unchanged', projectAdded: false, previous: { kind: 'workspace-link' } });
      expect(readWorkspace(flowA, 'team').file.projects).toHaveLength(1);
    });

    it('replaces a vault link and leaves the vault copy exactly where it is', () => {
      const repo = makeRepo('web', 'https://github.com/acme/web.git');
      const vaultFlow = join(sandbox, 'vault', 'projects', 'web', 'flow');
      mkdirSync(join(vaultFlow, 'plans'), { recursive: true });
      writeFileSync(join(vaultFlow, 'plans', 'plan_x_v1.md'), '# old plan\n');
      symlinkSync(vaultFlow, join(repo, 'flow'), 'dir');

      const result = linkRepo({ flowFolder: flowA, target: repo });
      expect(result.previous).toEqual({ kind: 'link', target: vaultFlow });
      expect(readlinkSync(join(repo, 'flow'))).toBe(result.project.flowPath);
      expect(readFileSync(join(vaultFlow, 'plans', 'plan_x_v1.md'), 'utf-8')).toBe('# old plan\n');
      // Without --import nothing is brought in (the hard migration passes --import).
      expect(existsSync(join(result.project.flowPath, 'plans', 'plan_x_v1.md'))).toBe(false);
      expect(result.imported).toBeNull();
    });

    it('renames an untracked flow/ beside the repo, contents intact, and keeps it out of git', () => {
      const repo = makeRepo('svc', 'https://github.com/acme/svc');
      mkdirSync(join(repo, 'flow', 'brain'), { recursive: true });
      writeFileSync(join(repo, 'flow', 'brain', 'note.md'), '# note\n');
      writeFileSync(join(repo, '.git', 'info', 'exclude'), '/flow\n');

      const result = linkRepo({ flowFolder: flowA, target: repo, deps: { now: () => new Date(2026, 9, 6) } });
      const keptAt = join(repo, 'flow.pre-workspace-20261006');
      expect(result.previous).toEqual({ kind: 'folder', keptAt });
      expect(readFileSync(join(keptAt, 'brain', 'note.md'), 'utf-8')).toBe('# note\n');
      expect(lstatSync(join(repo, 'flow')).isSymbolicLink()).toBe(true);
      expect(git(repo, 'status', '--porcelain')).toBe('');
    });

    it('refuses a COMMITTED flow/ with the commit it would make — and changes nothing', () => {
      const repo = makeRepo('mono', 'https://github.com/acme/mono');
      mkdirSync(join(repo, 'flow', 'plans'), { recursive: true });
      writeFileSync(join(repo, 'flow', 'plans', 'a.md'), 'a\n');
      writeFileSync(join(repo, 'flow', 'ledger.md'), 'l\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'knowledge');
      const before = head(repo);
      const workspaceBefore = readFileSync(join(flowA, 'workspaces', 'team', 'workspace.json'), 'utf-8');

      const refusal = refusalOf(() => linkRepo({ flowFolder: flowA, target: repo }), 'committed-flow');
      expect(refusal.payload).toMatchObject({
        needs: 'confirm-commit',
        commit: { files: 2, from: 'flow', to: 'flow.pre-workspace' },
      });
      expect(String((refusal.payload.commit as { message: string }).message)).toMatch(/flow\.pre-workspace/);
      expect(head(repo)).toBe(before);
      expect(lstatSync(join(repo, 'flow')).isDirectory()).toBe(true);
      expect(readFileSync(join(flowA, 'workspaces', 'team', 'workspace.json'), 'utf-8')).toBe(workspaceBefore);
      expect(existsSync(join(flowA, 'projects.local.json'))).toBe(false);
    });

    it('commits only the rename while unrelated work stays uncommitted; refuses an uncommitted edit inside flow/', () => {
      const repo = makeRepo('mono', 'https://github.com/acme/mono');
      mkdirSync(join(repo, 'flow', 'plans'), { recursive: true });
      writeFileSync(join(repo, 'flow', 'plans', 'a.md'), 'a\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'knowledge');
      writeFileSync(join(repo, 'flow', 'scratch.md'), 'untracked, travels with the folder\n');
      const before = head(repo);

      // An uncommitted edit to a COMMITTED knowledge file would be swept into (or lost by) the rename.
      writeFileSync(join(repo, 'flow', 'plans', 'a.md'), 'a, edited\n');
      const dirty = refusalOf(() => linkRepo({ flowFolder: flowA, target: repo, confirmCommit: true }), 'dirty-code');
      expect(dirty.payload.files).toEqual(['flow/plans/a.md']);
      expect(head(repo)).toBe(before);
      expect(lstatSync(join(repo, 'flow')).isDirectory()).toBe(true);
      git(repo, 'checkout', '--', 'flow/plans/a.md');

      // Unrelated work in progress (the live storefront-mobile case: app.json / eas.json) does not block the move.
      writeFileSync(join(repo, 'app.ts'), 'export const dirty = 1\n');
      const result = linkRepo({ flowFolder: flowA, target: repo, confirmCommit: true });
      expect(result.codeRepo.commit).toMatchObject({ files: 1 });
      expect(git(repo, 'rev-list', '--count', `${before}..HEAD`).trim()).toBe('1');
      expect(git(repo, 'show', '--name-status', '--format=', 'HEAD').trim()).toMatch(/^R100\s+flow\/plans\/a\.md\s+flow\.pre-workspace\/plans\/a\.md$/);
      expect(readFileSync(join(repo, 'flow.pre-workspace', 'scratch.md'), 'utf-8')).toMatch(/untracked/);
      expect(lstatSync(join(repo, 'flow')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(repo, 'app.ts'), 'utf-8')).toBe('export const dirty = 1\n');
      expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(' M app.ts\n?? flow.pre-workspace/scratch.md\n');
    });

    it('refuses — never guesses "untracked" — when git cannot say whether flow/ is committed (review fix 14)', () => {
      const repo = makeRepo('mono', 'https://github.com/acme/mono');
      mkdirSync(join(repo, 'flow', 'plans'), { recursive: true });
      writeFileSync(join(repo, 'flow', 'plans', 'a.md'), 'a\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'knowledge');
      const failingLsFiles: typeof model.defaultWorkspaceGit = (args, cwd, options) => {
        if (args[0] === 'ls-files') throw new Error('fatal: index file corrupt');
        return model.defaultWorkspaceGit(args, cwd, options);
      };
      refusalOf(() => linkRepo({ flowFolder: flowA, target: repo, deps: { git: failingLsFiles, now: () => new Date() } }), 'failed');
      expect(lstatSync(join(repo, 'flow')).isDirectory()).toBe(true);
      expect(existsSync(join(repo, 'flow.pre-workspace-20261006'))).toBe(false);
    });

    it('commits the rename with a pathspec — only flow/ and its new name (review fix 14)', () => {
      const repo = makeRepo('mono', 'https://github.com/acme/mono');
      mkdirSync(join(repo, 'flow'), { recursive: true });
      writeFileSync(join(repo, 'flow', 'ledger.md'), 'l\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'knowledge');
      const calls: string[][] = [];
      const recording: typeof model.defaultWorkspaceGit = (args, cwd, options) => {
        calls.push([...args]);
        return model.defaultWorkspaceGit(args, cwd, options);
      };
      linkRepo({ flowFolder: flowA, target: repo, confirmCommit: true, deps: { git: recording, now: () => new Date() } });
      const commit = calls.find((args) => args.includes('commit'));
      expect(commit?.slice(-3)).toEqual(['--', 'flow', 'flow.pre-workspace']);
    });

    it('treats a COMMITTED flow symlink like a committed flow/: the go-ahead first (review fix 14)', () => {
      const repo = makeRepo('linked', 'https://github.com/acme/linked');
      const elsewhere = join(sandbox, 'some-vault', 'flow');
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, join(repo, 'flow'));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'track the link');
      const before = head(repo);
      refusalOf(() => linkRepo({ flowFolder: flowA, target: repo }), 'committed-flow');
      expect(readlinkSync(join(repo, 'flow'))).toBe(elsewhere);
      expect(head(repo)).toBe(before);
      const result = linkRepo({ flowFolder: flowA, target: repo, confirmCommit: true });
      expect(result.codeRepo.commit).toMatchObject({ files: 1 });
      expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    });

    it('takes a repo whose remote Flow cannot read as a local-only project, recording no address (review fix 14)', () => {
      const repo = makeRepo('secretive', 'https://bob:hunter2@github.com/acme/secretive.git');
      const result = linkRepo({ flowFolder: flowA, target: repo });
      expect(result.project).toMatchObject({ id: 'local:secretive', remotes: [] });
      expect(readFileSync(join(flowA, 'workspaces', 'team', 'workspace.json'), 'utf-8')).not.toContain('hunter2');
    });

    it('gives colliding project names a suffix and maps a fork onto an existing project', () => {
      const one = makeRepo('one', 'https://github.com/acme/app');
      const two = makeRepo('two', 'https://github.com/other/app');
      expect(linkRepo({ flowFolder: flowA, target: one }).project.slug).toBe('app');
      expect(linkRepo({ flowFolder: flowA, target: two }).project.slug).toBe('app-2');

      const fork = makeRepo('fork', 'https://github.com/me/app-fork');
      const mapped = linkRepo({ flowFolder: flowA, target: fork, project: 'app' });
      expect(mapped.project.id).toBe('github.com/acme/app');
      expect(mapped.project.remotes).toEqual(['https://github.com/acme/app', 'https://github.com/me/app-fork']);
      refusalOf(() => linkRepo({ flowFolder: flowA, target: makeRepo('x', 'https://github.com/me/x'), project: 'nope' }), 'unknown-project');
    });

    it('takes a repo with no remote as a local-only project, idempotently', () => {
      const repo = makeRepo('scratch');
      const first = linkRepo({ flowFolder: flowA, target: repo });
      expect(first.project).toMatchObject({ id: 'local:scratch', remotes: [] });
      const again = linkRepo({ flowFolder: flowA, target: repo });
      expect(again).toMatchObject({ link: 'unchanged', projectAdded: false });
      expect(readWorkspace(flowA, 'team').file.projects).toHaveLength(1);
    });

    it('re-linking an already-correct link touches nothing: same link inode/mtime, same projects.local.json (2026-10-09)', () => {
      const repo = makeRepo('steady', 'git@github.com:acme/steady.git');
      linkRepo({ flowFolder: flowA, target: repo, import: true });
      const link = lstatSync(join(repo, 'flow'));
      const local = lstatSync(join(flowA, 'projects.local.json'));
      const again = linkRepo({ flowFolder: flowA, target: repo, import: true });
      expect(again.link).toBe('unchanged');
      const linkAfter = lstatSync(join(repo, 'flow'));
      const localAfter = lstatSync(join(flowA, 'projects.local.json'));
      expect([linkAfter.ino, linkAfter.mtimeMs]).toEqual([link.ino, link.mtimeMs]);
      expect([localAfter.ino, localAfter.mtimeMs]).toEqual([local.ino, local.mtimeMs]);
    });

    it("never takes over a link into ANOTHER Flow folder's Workspace — refuses linked-elsewhere, link untouched (2026-10-09)", () => {
      const repo = makeRepo('shared', 'git@github.com:acme/shared.git');
      linkRepo({ flowFolder: flowA, target: repo });
      const before = lstatSync(join(repo, 'flow'));
      const target = readlinkSync(join(repo, 'flow'));
      // A throwaway Flow folder (a test's PLAN_FLOW_HOME) asked to link the same checkout.
      const flowB = join(sandbox, 'flow-b');
      createWorkspace({ flowFolder: flowB, name: 'Throwaway' });
      const refusal = refusalOf(() => linkRepo({ flowFolder: flowB, target: repo, import: true }), 'linked-elsewhere');
      expect(refusal.payload).toMatchObject({ linkedTo: { workspace: 'team', project: 'shared' } });
      expect(readlinkSync(join(repo, 'flow'))).toBe(target);
      expect(lstatSync(join(repo, 'flow')).ino).toBe(before.ino);
      expect(readLocalProjects(flowB)).toEqual({});
      expect(readWorkspace(flowB, 'throwaway').file.projects).toEqual([]);
    });

    it("heals a DANGLING link left by a deleted Flow folder: it is re-pointed here (2026-10-09)", () => {
      const repo = makeRepo('healed', 'git@github.com:acme/healed.git');
      symlinkSync(join(sandbox, 'gone', 'workspaces', 'default', 'projects', 'healed'), join(repo, 'flow'));
      const result = linkRepo({ flowFolder: flowA, target: repo });
      expect(result.link).toBe('created');
      expect(readlinkSync(join(repo, 'flow'))).toBe(join(flowA, 'workspaces', 'team', 'projects', 'healed'));
    });

    it('asks which Workspace when more than one could be meant, and refuses a folder that is not a repo', () => {
      createWorkspace({ flowFolder: flowA, name: 'Personal' });
      const repo = makeRepo('lib', 'https://github.com/acme/lib');
      const which = refusalOf(() => linkRepo({ flowFolder: flowA, target: repo }), 'which-workspace');
      expect(which.payload.workspaces).toEqual([
        { slug: 'personal', name: 'Personal' },
        { slug: 'team', name: 'Team' },
      ]);
      expect(existsSync(join(repo, 'flow'))).toBe(false);
      refusalOf(() => linkRepo({ flowFolder: flowA, target: join(repo, '..') }), 'not-a-git-repo');
    });

    it('refuses a malformed workspace.json with a sentence, touching nothing', () => {
      writeFileSync(join(flowA, 'workspaces', 'team', 'workspace.json'), '{"name": "Team", "slug": "team", "projects": [{"id": 1}]}');
      const repo = makeRepo('api', 'https://github.com/acme/api');
      const refusal = refusalOf(() => linkRepo({ flowFolder: flowA, target: repo, workspace: 'team' }), 'malformed-workspace');
      expect(refusal.sentence).toMatch(/project 1 has no usable id/);
      expect(existsSync(join(repo, 'flow'))).toBe(false);
      expect(scanWorkspaces(flowA).unreadable).toEqual([{ workspace: 'team', detail: refusal.sentence }]);
    });
  });

  describe('status', () => {
    it('lists Workspaces, and answers which Workspace + project a repo is, with its siblings', () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const backend = makeRepo('backend', 'https://github.com/acme/backend');
      const frontend = makeRepo('frontend', 'https://github.com/acme/frontend');
      linkRepo({ flowFolder: flowA, target: backend });
      linkRepo({ flowFolder: flowA, target: frontend });

      const list = workspaceStatus({ flowFolder: flowA });
      expect('workspaces' in list && list.workspaces.map((workspace) => workspace.projects.map((project) => project.slug))).toEqual([
        ['backend', 'frontend'],
      ]);

      const status = workspaceStatus({ flowFolder: flowA, target: backend });
      expect(status).toMatchObject({
        workspace: { slug: 'team' },
        project: { id: 'github.com/acme/backend', localPath: backend },
        linked: true,
        via: 'flow-link',
        siblings: [{ id: 'github.com/acme/frontend', name: 'frontend', slug: 'frontend', localPath: frontend }],
      });

      const outside = makeRepo('elsewhere', 'https://github.com/acme/elsewhere');
      expect(workspaceStatus({ flowFolder: flowA, target: outside })).toMatchObject({ workspace: null, project: null, siblings: [] });
    });
  });

  describe('describe', () => {
    it('sets a project description, keeps a person\'s with --if-empty, and refuses bad text or an unknown project', () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const backend = makeRepo('backend', 'https://github.com/acme/backend');
      linkRepo({ flowFolder: flowA, target: backend });

      const first = model.describeProject({ flowFolder: flowA, project: 'backend', text: '  The orders API.  ', ifEmpty: true });
      expect(first).toMatchObject({ action: 'describe', changed: true, project: { slug: 'backend', description: 'The orders API.' } });
      expect(readWorkspace(flowA, 'team').file.projects[0].description).toBe('The orders API.');

      // A machine's guess never overwrites what is there…
      const kept = model.describeProject({ flowFolder: flowA, project: 'github.com/acme/backend', text: 'Something else', ifEmpty: true });
      expect(kept.changed).toBe(false);
      expect(readWorkspace(flowA, 'team').file.projects[0].description).toBe('The orders API.');
      // …a person's edit does.
      expect(model.describeProject({ flowFolder: flowA, project: 'backend', text: 'Orders and payments.' }).changed).toBe(true);
      expect(readWorkspace(flowA, 'team').file.projects[0].description).toBe('Orders and payments.');

      refusalOf(() => model.describeProject({ flowFolder: flowA, project: 'backend', text: '   ' }), 'invalid-description');
      refusalOf(() => model.describeProject({ flowFolder: flowA, project: 'backend', text: 'a\u0000b' }), 'invalid-description');
      refusalOf(() => model.describeProject({ flowFolder: flowA, project: 'nope', text: 'x' }), 'unknown-project');
      expect(readWorkspace(flowA, 'team').file.projects[0].description).toBe('Orders and payments.');
    });
  });

  describe('provisioning (initShared)', () => {
    it('links a Workspace project into the Workspace — never the vault — and never re-links it', async () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const first = makeRepo('backend', 'https://github.com/acme/backend');
      linkRepo({ flowFolder: flowA, target: first });

      // This machine's recorded checkout, its link gone (a re-clone into the same folder, a reset).
      // Only a LOCAL record links on its own — a remote-only match is a suggestion (review fix 2).
      const second = first;
      rmSync(join(second, 'flow'));
      await initShared(second, { force: false, nonInteractive: true }, ['claude']);
      const folder = join(flowA, 'workspaces', 'team', 'projects', 'backend');
      expect(readlinkSync(join(second, 'flow'))).toBe(folder);
      expect(existsSync(join(sandbox, 'vault', 'projects', 'backend', 'flow'))).toBe(false);

      // Provisioning again leaves the Workspace link exactly as it is.
      await initShared(second, { force: true, nonInteractive: true }, ['claude']);
      expect(readlinkSync(join(second, 'flow'))).toBe(folder);
      expect(provisionWorkspaceLink(second, { flowFolder: flowA })).toEqual({ kind: 'workspace-link', folder });
    });

    it("never rewrites the Workspace's documents with this machine's folder name (no legacy scan)", async () => {
      // Found by workspace-e2e: provisioning a second checkout stamped
      // `**Project**: [[<local folder>]]` into every synced discovery and
      // minted legacy-scan feature notes — an edit to the team's knowledge
      // named after one machine's directory, repeated by every machine.
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const first = makeRepo('backend', 'https://github.com/acme/backend');
      linkRepo({ flowFolder: flowA, target: first });
      const folder = join(flowA, 'workspaces', 'team', 'projects', 'backend');
      const discovery = join(folder, 'discovery', 'discovery_orders_v1.md');
      writeFileSync(discovery, '# Orders discovery\n\nA teammate wrote this.\n');

      const second = first;
      rmSync(join(second, 'flow'));
      await initShared(second, { force: false, nonInteractive: true }, ['claude']);

      expect(readlinkSync(join(second, 'flow'))).toBe(folder);
      expect(readFileSync(discovery, 'utf-8')).toBe('# Orders discovery\n\nA teammate wrote this.\n');
      expect(existsSync(join(folder, 'brain', 'features', 'orders.md'))).toBe(false);
    });

    it('never relinks or merges a flow link into a Workspace project folder, even when the Flow folder resolves elsewhere (review fix 2)', async () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const repo = makeRepo('backend', 'https://github.com/acme/backend');
      linkRepo({ flowFolder: flowA, target: repo });
      const folder = join(flowA, 'workspaces', 'team', 'projects', 'backend');
      writeFileSync(join(folder, 'discovery', 'discovery_x_v1.md'), '# X\n');
      // This process resolves ANOTHER Flow folder (a moved home, an env from another tool).
      process.env.PLAN_FLOW_HOME = join(sandbox, 'flow-elsewhere');
      await initShared(repo, { force: true, nonInteractive: true }, ['claude']);
      expect(readlinkSync(join(repo, 'flow'))).toBe(folder);
      expect(existsSync(join(sandbox, 'vault', 'projects', 'backend', 'flow', 'discovery', 'discovery_x_v1.md'))).toBe(false);
    });

    it('links only on a local record; a remote-only match is a suggestion, never a link (review fix 2)', async () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const first = makeRepo('backend', 'https://github.com/acme/backend');
      linkRepo({ flowFolder: flowA, target: first });
      const clone = makeRepo('backend-clone', 'git@github.com:acme/backend.git');
      expect(provisionWorkspaceLink(clone, { flowFolder: flowA })).toMatchObject({
        kind: 'suggestion',
        workspace: 'team',
        project: 'github.com/acme/backend',
        sentence: expect.stringContaining('Team'),
      });
      expect(lstatSync(join(clone, 'flow'), { throwIfNoEntry: false })).toBeUndefined();
      // The recorded checkout re-links itself.
      rmSync(join(first, 'flow'));
      expect(provisionWorkspaceLink(first, { flowFolder: flowA })).toMatchObject({ kind: 'linked' });
      expect(readlinkSync(join(first, 'flow'))).toBe(join(flowA, 'workspaces', 'team', 'projects', 'backend'));
    });

    it('auto-links whatever PLANFLOW_WORKSPACES says — Workspaces are always on (hard migration, 2026-10-06)', async () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const repo = makeRepo('backend', 'https://github.com/acme/backend');
      linkRepo({ flowFolder: flowA, target: repo });
      rmSync(join(repo, 'flow'));
      const saved = process.env.PLANFLOW_WORKSPACES;
      process.env.PLANFLOW_WORKSPACES = 'off';
      try {
        expect(provisionWorkspaceLink(repo, { flowFolder: flowA })).toMatchObject({ kind: 'linked' });
        expect(provisionWorkspaceLink(repo, { flowFolder: flowA })).toMatchObject({ kind: 'workspace-link' });
      } finally {
        if (saved === undefined) delete process.env.PLANFLOW_WORKSPACES;
        else process.env.PLANFLOW_WORKSPACES = saved;
      }
    });

    it('leaves a project in no Workspace on the vault, as before', async () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const repo = makeRepo('solo', 'https://github.com/acme/solo');
      await initShared(repo, { force: false, nonInteractive: true }, ['claude']);
      expect(readlinkSync(join(repo, 'flow'))).toBe(join(sandbox, 'vault', 'projects', 'solo', 'flow'));
      expect(provisionWorkspaceLink(repo, { flowFolder: flowA })).toEqual({ kind: 'not-in-workspace' });
    });
  });
});
