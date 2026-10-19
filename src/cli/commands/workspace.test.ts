/**
 * `planflow-ai workspace` — the REAL CLI (from source, through tsx), a REAL
 * git, two "machines" in one throwaway sandbox.
 *
 * This is the layer the app and the skills reach: they spawn the verb and read
 * the LAST parseable JSON line on stdout. Every refusal here asserts the
 * `workspace refused:` line on the combined transcript (allowed-pattern #15),
 * the payload as the last JSON line (#21), and that NOTHING happened (#24).
 *
 * Isolation: each machine is its own Flow folder (PLAN_FLOW_HOME) and vault,
 * git reads a private config whose `insteadOf` maps https://git.example.test/
 * onto local bare repos, and only the `file` transport is allowed
 * (FLOW_E2E=1 + FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS=file). The child's cwd is the
 * sandbox — never this repository — and the real ~/plan-flow is never named.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const CLI_TIMEOUT_MS = 120_000;
const SUITE_TIMEOUT_MS = 180_000;
const WORKSPACE_REMOTE = 'https://git.example.test/team/ws.git';

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

interface CliRun {
  combined: string;
  status: number | null;
  json: Record<string, unknown> | null;
}

function lastJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // not JSON — keep scanning upwards
    }
  }
  return null;
}

describeWithGit('workspace CLI — real CLI, real git, two machines', () => {
  let sandbox: string;
  let env: NodeJS.ProcessEnv;
  let machineA: string;
  let machineB: string;

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  }

  function workspace(flowFolder: string, ...args: string[]): CliRun {
    const result = spawnSync(process.execPath, [TSX_BIN, CLI_ENTRY, 'workspace', ...args], {
      encoding: 'utf-8',
      timeout: CLI_TIMEOUT_MS,
      cwd: sandbox,
      env: { ...env, PLAN_FLOW_HOME: flowFolder, PLAN_FLOW_VAULT_DIR: join(flowFolder, 'brain') },
    });
    if (result.error) throw result.error;
    const stdout = result.stdout ?? '';
    return { combined: `${stdout}\n${result.stderr ?? ''}`, status: result.status, json: lastJson(stdout) };
  }

  function makeRepo(path: string, origin: string): string {
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    writeFileSync(join(path, 'app.ts'), 'export {}\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'init');
    git(path, 'remote', 'add', 'origin', origin);
    return path;
  }

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-cli-')));
    machineA = join(sandbox, 'machine-a', 'plan-flow');
    machineB = join(sandbox, 'machine-b', 'plan-flow');
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    mkdirSync(join(sandbox, 'remotes', 'team'), { recursive: true });
    writeFileSync(
      join(sandbox, 'gitconfig'),
      `[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[url "file://${sandbox}/remotes/"]\n\tinsteadOf = https://git.example.test/\n`
    );
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(sandbox, 'home'),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      GIT_CONFIG_GLOBAL: join(sandbox, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_TERMINAL_PROMPT: '0',
      FLOW_E2E: '1',
      FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS: 'file',
      COPILOT_HOME: join(sandbox, 'copilot'),
      PLANFLOW_NO_BACKGROUND_WORK: '1',
    };
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it(
    'create → link → status, then join from a second machine links by project id',
    () => {
      // ── Machine A ──
      const created = workspace(machineA, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE, '--json');
      expect(created.status).toBe(0);
      expect(created.json).toMatchObject({ action: 'create', workspace: { name: 'Team', slug: 'team', remote: WORKSPACE_REMOTE } });

      const backendA = makeRepo(join(sandbox, 'machine-a', 'code', 'backend'), 'git@github.com:acme/backend.git');
      const frontendA = makeRepo(join(sandbox, 'machine-a', 'code', 'frontend'), 'https://github.com/acme/frontend.git');
      expect(workspace(machineA, 'link', '--target', backendA, '--json').json).toMatchObject({ action: 'link', link: 'created' });
      expect(workspace(machineA, 'link', '--target', frontendA, '--json').status).toBe(0);

      const status = workspace(machineA, 'status', '--target', backendA, '--json');
      expect(status.status).toBe(0);
      expect(status.json).toMatchObject({
        action: 'status',
        workspace: { slug: 'team', name: 'Team' },
        project: { id: 'github.com/acme/backend', slug: 'backend', localPath: backendA },
        linked: true,
        siblings: [
          {
            id: 'github.com/acme/frontend',
            name: 'frontend',
            slug: 'frontend',
            localPath: frontendA,
            flowPath: join(machineA, 'workspaces', 'team', 'projects', 'frontend'),
          },
        ],
      });
      const listing = workspace(machineA, 'status', '--json');
      expect(listing.json).toMatchObject({ workspaces: [{ slug: 'team', projects: [{ slug: 'backend' }, { slug: 'frontend' }] }] });

      // Some knowledge, committed and published by hand (sync is a later phase).
      const wsA = join(machineA, 'workspaces', 'team');
      writeFileSync(join(wsA, 'projects', 'backend', 'brain', 'features', 'orders.md'), '# Orders\n');
      git(join(sandbox, 'remotes', 'team'), 'init', '-q', '--bare', 'ws.git');
      git(wsA, 'add', '-A');
      git(wsA, 'commit', '-q', '-m', 'workspace');
      git(wsA, 'push', '-q', 'origin', 'main');

      // ── Machine B: only the backend is checked out here ──
      const backendB = makeRepo(join(sandbox, 'machine-b', 'code', 'api'), 'https://github.com/acme/backend');
      mkdirSync(machineB, { recursive: true });
      writeFileSync(join(machineB, 'projects.local.json'), JSON.stringify({ projects: { 'github.com/acme/backend': backendB } }));

      const joined = workspace(machineB, 'join', '--remote', WORKSPACE_REMOTE, '--json');
      expect(joined.status).toBe(0);
      expect(joined.json).toMatchObject({
        action: 'join',
        workspace: { name: 'Team', slug: 'team' },
        linked: [{ id: 'github.com/acme/backend', localPath: backendB }],
        noLocalCheckout: [{ id: 'github.com/acme/frontend', localPath: null }],
        needsReview: [],
      });
      const folderB = join(machineB, 'workspaces', 'team', 'projects', 'backend');
      expect(readlinkSync(join(backendB, 'flow'))).toBe(folderB);
      expect(readFileSync(join(backendB, 'flow', 'brain', 'features', 'orders.md'), 'utf-8')).toBe('# Orders\n');

      // Joining the same Workspace twice is refused, with the one already here.
      const again = workspace(machineB, 'join', '--remote', 'git@git.example.test:team/ws.git', '--json');
      expect(again.status).toBe(1);
      expect(again.combined).toContain('workspace refused: already-joined');
      expect(again.json).toMatchObject({ action: 'join', refused: 'already-joined', workspace: { slug: 'team' } });
      expect(existsSync(join(machineB, 'workspaces', 'team-2'))).toBe(false);
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'a repo in no Workspace is not an error',
    () => {
      workspace(machineA, 'create', '--name', 'Team', '--json');
      const repo = makeRepo(join(sandbox, 'code', 'loner'), 'https://github.com/acme/loner');
      const status = workspace(machineA, 'status', '--target', repo, '--json');
      expect(status.status).toBe(0);
      expect(status.json).toMatchObject({ workspace: null, project: null, siblings: [] });
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'refuses a committed flow/ with the commit it would make, and changes nothing',
    () => {
      workspace(machineA, 'create', '--name', 'Team', '--json');
      const repo = makeRepo(join(sandbox, 'code', 'mono'), 'https://github.com/acme/mono');
      mkdirSync(join(repo, 'flow', 'plans'), { recursive: true });
      writeFileSync(join(repo, 'flow', 'plans', 'a.md'), 'a\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'knowledge');
      const head = git(repo, 'rev-parse', 'HEAD');
      const before = readFileSync(join(machineA, 'workspaces', 'team', 'workspace.json'), 'utf-8');

      const refused = workspace(machineA, 'link', '--target', repo, '--json');
      expect(refused.status).toBe(1);
      expect(refused.combined).toContain('workspace refused: committed-flow');
      expect(refused.json).toMatchObject({
        action: 'link',
        refused: 'committed-flow',
        needs: 'confirm-commit',
        commit: { files: 1, from: 'flow', to: 'flow.pre-workspace' },
      });
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(lstatSync(join(repo, 'flow')).isDirectory()).toBe(true);
      expect(readFileSync(join(machineA, 'workspaces', 'team', 'workspace.json'), 'utf-8')).toBe(before);
      expect(existsSync(join(machineA, 'projects.local.json'))).toBe(false);

      const confirmed = workspace(machineA, 'link', '--target', repo, '--confirm-commit', '--json');
      expect(confirmed.status).toBe(0);
      expect(confirmed.json).toMatchObject({ codeRepo: { commit: { files: 1 } }, previous: { kind: 'committed-folder' } });
      expect(git(repo, 'log', '--format=%s', '-1')).toMatch(/flow\.pre-workspace/);
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'refuses a bad address, a malformed workspace.json and a missing flag — and makes nothing',
    () => {
      const insecure = workspace(machineA, 'join', '--remote', 'http://git.example.test/team/ws.git', '--json');
      expect(insecure.status).toBe(1);
      expect(insecure.combined).toContain('workspace refused: insecure-remote');
      expect(insecure.json).toMatchObject({ action: 'join', refused: 'insecure-remote' });
      expect(existsSync(join(machineA, 'workspaces'))).toBe(false);

      const missing = workspace(machineA, 'create', '--json');
      expect(missing.status).toBe(1);
      expect(missing.combined).toContain('workspace refused: create needs --name');

      workspace(machineA, 'create', '--name', 'Team', '--json');
      writeFileSync(join(machineA, 'workspaces', 'team', 'workspace.json'), '{"name": "Team"}');
      const repo = makeRepo(join(sandbox, 'code', 'api'), 'https://github.com/acme/api');
      const malformed = workspace(machineA, 'link', '--target', repo, '--workspace', 'team', '--json');
      expect(malformed.status).toBe(1);
      expect(malformed.combined).toContain('workspace refused: malformed-workspace');
      expect(malformed.json).toMatchObject({ refused: 'malformed-workspace', workspace: 'team' });
      expect(existsSync(join(repo, 'flow'))).toBe(false);
      expect(workspace(machineA, 'status', '--json').json).toMatchObject({ workspaces: [], unreadable: [{ workspace: 'team' }] });
    },
    SUITE_TIMEOUT_MS
  );
  it(
    'link-knowledge records a cross-project link once, links reads it, an unknown project is refused with the valid slugs',
    () => {
      workspace(machineA, 'create', '--name', 'Team', '--json');
      const backend = makeRepo(join(sandbox, 'code', 'backend'), 'git@github.com:acme/backend.git');
      const frontend = makeRepo(join(sandbox, 'code', 'frontend'), 'https://github.com/acme/frontend.git');
      workspace(machineA, 'link', '--target', backend, '--json');
      workspace(machineA, 'link', '--target', frontend, '--json');
      const args = [
        'link-knowledge',
        '--target', frontend,
        '--from', 'backend/endpoint:POST /api/orders',
        '--to', 'frontend/file:src/screens/Orders.tsx',
        '--kind', 'exposes',
        '--note', 'the checkout screen posts the cart',
        '--json',
      ];

      const first = workspace(machineA, ...args);
      expect(first.status).toBe(0);
      expect(first.json).toMatchObject({
        action: 'link-knowledge',
        recorded: true,
        link: { author: 'Test Person', kind: 'exposes', from: 'backend/endpoint:POST /api/orders', to: 'frontend/file:src/screens/Orders.tsx' },
      });
      expect(workspace(machineA, ...args).json).toMatchObject({ recorded: false });
      const linksFile = join(machineA, 'workspaces', 'team', 'links.jsonl');
      expect(readFileSync(linksFile, 'utf-8').trim().split('\n')).toHaveLength(1);

      const listed = workspace(machineA, 'links', '--target', backend, '--project', 'frontend', '--json');
      expect(listed.status).toBe(0);
      expect(listed.json).toMatchObject({ action: 'links', project: 'frontend', links: [{ note: 'the checkout screen posts the cart' }] });

      const refused = workspace(machineA, 'link-knowledge', '--target', frontend, '--from', 'billing/invoices', '--to', 'frontend/checkout', '--kind', 'calls', '--json');
      expect(refused.status).toBe(1);
      expect(refused.combined).toContain('workspace refused: unknown-project');
      expect(refused.json).toMatchObject({ action: 'link-knowledge', refused: 'unknown-project', projects: ['backend', 'frontend'] });
      expect(readFileSync(linksFile, 'utf-8').trim().split('\n')).toHaveLength(1);
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'set-remote connects a local-only Workspace without contacting it; unset-remote disconnects; a second address needs --replace',
    () => {
      const wsA = join(machineA, 'workspaces', 'team');
      const origin = (): string | null => {
        const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: wsA, encoding: 'utf-8', env });
        return result.status === 0 ? result.stdout.trim() : null;
      };
      expect(workspace(machineA, 'create', '--name', 'Team', '--json').status).toBe(0);
      git(join(sandbox, 'remotes', 'team'), 'init', '-q', '--bare', 'ws.git');
      const bare = join(sandbox, 'remotes', 'team', 'ws.git');

      // An address with credentials in it is refused — and never echoed.
      const leaky = workspace(machineA, 'set-remote', '--workspace', 'team', '--remote', 'https://bob:hunter2@github.com/acme/ws.git', '--json');
      expect(leaky.status).toBe(1);
      expect(leaky.combined).toContain('workspace refused: credentials-in-url');
      expect(leaky.combined).not.toContain('hunter2');
      expect(origin()).toBeNull();

      const connected = workspace(machineA, 'set-remote', '--workspace', 'team', '--remote', WORKSPACE_REMOTE, '--json');
      expect(connected.status).toBe(0);
      expect(connected.json).toMatchObject({ action: 'set-remote', remote: WORKSPACE_REMOTE, changed: true, pushed: false, workspace: { remote: WORKSPACE_REMOTE } });
      expect(origin()).toBe(WORKSPACE_REMOTE);
      // Nothing left the machine: the shared repository is still empty.
      expect(git(bare, 'for-each-ref').trim()).toBe('');

      // Another address while one is set: refused, with what the asker needs, and nothing changed.
      const other = 'https://git.example.test/team/other.git';
      const refused = workspace(machineA, 'set-remote', '--workspace', 'team', '--remote', other, '--json');
      expect(refused.status).toBe(1);
      expect(refused.combined).toContain('workspace refused: remote-exists');
      expect(refused.json).toMatchObject({ action: 'set-remote', refused: 'remote-exists', current: WORKSPACE_REMOTE, wanted: other, needs: 'replace' });
      expect(origin()).toBe(WORKSPACE_REMOTE);
      expect(git(bare, 'for-each-ref').trim()).toBe('');

      // The next sync publishes.
      const synced = workspace(machineA, 'sync', '--workspace', 'team', '--json');
      expect(synced.status).toBe(0);
      expect(synced.json).toMatchObject({ state: 'synced', pushed: true });
      expect(git(bare, 'rev-parse', 'main').trim()).toBe(git(wsA, 'rev-parse', 'HEAD').trim());

      const disconnected = workspace(machineA, 'unset-remote', '--workspace', 'team', '--json');
      expect(disconnected.status).toBe(0);
      expect(disconnected.json).toMatchObject({ action: 'unset-remote', previous: WORKSPACE_REMOTE, changed: true, remoteUntouched: true });
      expect(origin()).toBeNull();
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'local-only' });

      const missing = workspace(machineA, 'set-remote', '--workspace', 'team');
      expect(missing.status).toBe(1);
      expect(missing.combined).toContain('workspace refused: set-remote needs --remote');
    },
    SUITE_TIMEOUT_MS
  );
});
