/**
 * `workspace set-remote` / `unset-remote` — in process, a REAL git, local bare
 * repositories standing in for the shared ones.
 *
 * Isolation (the workspace-sync suite's door): every Flow folder and bare
 * remote lives under one mkdtemp directory; git reads a private config whose
 * `insteadOf` maps https://git.example.test/ onto the sandbox's bare repos,
 * and only the `file` transport is allowed (FLOW_E2E=1 +
 * FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS=file). Every call names its own Flow folder.
 *
 * Every git call goes through a recording wrapper: the suite asserts that
 * connecting contacts nothing (no fetch, no push, no ls-remote) — the next
 * sync publishes — and that nothing is ever forced.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const model = await import('./workspace-model.js');
const syncModule = await import('./workspace-sync.js');
const remoteModule = await import('./workspace-remote.js');

const { WorkspaceRefusal, createWorkspace, joinWorkspace, defaultWorkspaceGit } = model;
const { syncWorkspace, SYNC_LOCK_GIT_PATH } = syncModule;
const { setWorkspaceRemote, unsetWorkspaceRemote } = remoteModule;

type Git = typeof defaultWorkspaceGit;

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;
const TEST_TIMEOUT_MS = 120_000;
const TEAM = 'https://git.example.test/team/ws.git';
const OTHER = 'https://git.example.test/team/other.git';
const NOW = new Date('2026-10-06T12:00:00Z');

const ENV_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'FLOW_E2E',
  'FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS',
  'PLAN_FLOW_HOME',
  'PLAN_FLOW_VAULT_DIR',
  'HOME',
] as const;

/** Commands that would reach a remote. */
const NETWORK_VERBS = ['fetch', 'push', 'ls-remote', 'clone', 'pull'];

describeWithGit('workspace set-remote / unset-remote against real git', () => {
  let sandbox: string;
  let flowA: string;
  let wsA: string;
  let calls: string[][];
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  const recordingGit: Git = (args, cwd, options) => {
    calls.push([...args]);
    return defaultWorkspaceGit(args, cwd, options);
  };
  const deps = { git: recordingGit, now: () => NOW };

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  }

  function bare(name: string): string {
    const dir = join(sandbox, 'remotes', 'team');
    git(dir, 'init', '-q', '--bare', `${name}.git`);
    return join(dir, `${name}.git`);
  }

  const refsOf = (repo: string): string => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
  const fileOf = (workspace: string): Record<string, unknown> => JSON.parse(readFileSync(join(workspace, 'workspace.json'), 'utf-8'));
  const originOf = (repo: string): string | null => {
    const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: repo, encoding: 'utf-8', env: process.env });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const networkCalls = (): string[][] => calls.filter((args) => args.some((arg) => NETWORK_VERBS.includes(arg)));

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

  function write(workspace: string, path: string, text: string): void {
    const full = join(workspace, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }

  function sync(flowFolder: string): ReturnType<typeof syncWorkspace> {
    return syncWorkspace({ flowFolder, push: true, workspace: 'team', deps });
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    calls = [];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-remote-')));
    flowA = join(sandbox, 'flow-a');
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    mkdirSync(join(sandbox, 'remotes', 'team'), { recursive: true });
    writeFileSync(
      join(sandbox, 'gitconfig'),
      `[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[url "file://${sandbox}/remotes/"]\n\tinsteadOf = https://git.example.test/\n`
    );
    process.env.HOME = join(sandbox, 'home');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.FLOW_E2E = '1';
    process.env.FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS = 'file';
    process.env.PLAN_FLOW_HOME = join(sandbox, 'unused-home');
    process.env.PLAN_FLOW_VAULT_DIR = join(sandbox, 'vault');
    // A LOCAL-ONLY Workspace — what every Default starts as.
    createWorkspace({ flowFolder: flowA, name: 'Team' });
    wsA = join(flowA, 'workspaces', 'team');
    write(wsA, 'projects/backend/discovery/discovery_orders_v1.md', '# Orders\n');
    expect(sync(flowA)).toMatchObject({ state: 'local-only' });
    calls = [];
  });

  afterEach(() => {
    for (const args of calls) {
      expect(args).not.toContain('rebase');
      if (args.includes('push')) {
        expect(args.some((arg) => arg === '--force' || arg === '-f' || arg.startsWith('--force-with-lease') || arg.startsWith('+'))).toBe(false);
      }
    }
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it(
    'connects a local-only Workspace without contacting the remote; the next sync publishes it',
    () => {
      const team = bare('ws');
      const result = setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: `  ${TEAM} `, deps });
      expect(result).toMatchObject({
        action: 'set-remote',
        remote: TEAM,
        previous: null,
        changed: true,
        pushed: false,
        workspace: { slug: 'team', remote: TEAM },
      });
      expect(originOf(wsA)).toBe(TEAM);
      expect(fileOf(wsA)['remote']).toBe(TEAM);
      // The verb itself reached nothing: the bare repository is still empty.
      expect(networkCalls()).toEqual([]);
      expect(refsOf(team)).toBe('');
      // The `--` stands before the positional address.
      expect(calls).toContainEqual(['remote', 'add', '--', 'origin', TEAM]);

      const published = sync(flowA);
      expect(published).toMatchObject({ state: 'synced', pushed: true, remote: TEAM });
      expect(git(team, 'rev-parse', 'main').trim()).toBe(git(wsA, 'rev-parse', 'HEAD').trim());
      expect(git(team, 'ls-tree', '-r', '--name-only', 'main')).toContain('projects/backend/discovery/discovery_orders_v1.md');

      // Asking again for the same address changes nothing.
      expect(setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: TEAM, deps })).toMatchObject({ changed: false });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses an address the shared grammar does not accept, and writes nothing',
    () => {
      for (const [address, reason] of [
        ['https://user:secret@github.com/acme/ws.git', 'credentials-in-url'],
        ['http://github.com/acme/ws.git', 'insecure-remote'],
        ['--upload-pack=touch /tmp/x', 'invalid-remote'],
        ['file:///tmp/ws.git', 'invalid-remote'],
      ] as const) {
        const refusal = refusalOf(() => setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: address, deps }), reason);
        expect(refusal.sentence).not.toContain('secret');
      }
      expect(originOf(wsA)).toBeNull();
      expect(fileOf(wsA)['remote']).toBeUndefined();
      // Refused before a single git call.
      expect(calls).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses to replace a different shared repository unless asked, then replaces it and forgets the old history',
    () => {
      const team = bare('ws');
      const other = bare('other');
      setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: TEAM, deps });
      sync(flowA);
      expect(git(wsA, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin')).toContain('refs/remotes/origin/main');
      const teamRefs = refsOf(team);
      calls = [];

      const refusal = refusalOf(() => setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: OTHER, deps }), 'remote-exists');
      expect(refusal.payload).toMatchObject({ workspace: 'team', current: TEAM, wanted: OTHER, needs: 'replace' });
      expect(originOf(wsA)).toBe(TEAM);
      expect(fileOf(wsA)['remote']).toBe(TEAM);
      expect(calls.filter((args) => args[0] === 'remote' && args[1] !== undefined && args[1] !== '-v')).toEqual([]);

      const replaced = setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: OTHER, replace: true, deps });
      expect(replaced).toMatchObject({ changed: true, previous: TEAM, remote: OTHER });
      expect(originOf(wsA)).toBe(OTHER);
      expect(fileOf(wsA)['remote']).toBe(OTHER);
      // The old repository's tracking refs went with it: the new one is never judged against them.
      expect(git(wsA, 'for-each-ref', '--format=%(refname)', 'refs/remotes').trim()).toBe('');
      expect(networkCalls()).toEqual([]);

      // The next sync publishes everything there — and the old repository was never touched.
      expect(sync(flowA)).toMatchObject({ state: 'synced', pushed: true, remote: OTHER });
      expect(git(other, 'rev-parse', 'main').trim()).toBe(git(wsA, 'rev-parse', 'HEAD').trim());
      expect(refsOf(team)).toBe(teamRefs);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'disconnects: everything stays here, the shared repository is untouched, and sync is local-only again',
    () => {
      const team = bare('ws');
      setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: TEAM, deps });
      sync(flowA);
      const teamRefs = refsOf(team);
      const head = git(wsA, 'rev-parse', 'HEAD').trim();
      calls = [];

      const result = unsetWorkspaceRemote({ flowFolder: flowA, workspace: 'team', deps });
      expect(result).toMatchObject({ action: 'unset-remote', previous: TEAM, changed: true, remoteUntouched: true, workspace: { remote: null } });
      expect(originOf(wsA)).toBeNull();
      expect(fileOf(wsA)['remote']).toBeUndefined();
      expect(git(wsA, 'rev-parse', 'HEAD').trim()).toBe(head);
      expect(networkCalls()).toEqual([]);

      write(wsA, 'projects/backend/plans/plan_orders_v1.md', '# Plan\n');
      expect(sync(flowA)).toMatchObject({ state: 'local-only', pushed: false });
      expect(refsOf(team)).toBe(teamRefs);

      expect(unsetWorkspaceRemote({ flowFolder: flowA, workspace: 'team', deps })).toMatchObject({ changed: false, previous: null });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "reconnecting to a repository that already holds this Workspace's history merges what a teammate added",
    () => {
      const team = bare('ws');
      setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: TEAM, deps });
      sync(flowA);
      // A teammate joins and adds a plan meanwhile.
      const flowB = join(sandbox, 'flow-b');
      joinWorkspace({ flowFolder: flowB, remote: TEAM, deps });
      const wsB = join(flowB, 'workspaces', 'team');
      write(wsB, 'projects/backend/plans/plan_team_v1.md', '# From B\n');
      expect(syncWorkspace({ flowFolder: flowB, push: true, workspace: 'team', deps })).toMatchObject({ pushed: true });
      // This machine disconnects, writes something, and connects again.
      unsetWorkspaceRemote({ flowFolder: flowA, workspace: 'team', deps });
      write(wsA, 'projects/backend/brain/features/orders.md', '# Orders feature\n');
      expect(sync(flowA)).toMatchObject({ state: 'local-only' });

      setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: TEAM, deps });
      const merged = sync(flowA);
      expect(merged).toMatchObject({ state: 'synced', pushed: true });
      expect(merged.pulled).toBeGreaterThan(0);
      expect(readFileSync(join(wsA, 'projects/backend/plans/plan_team_v1.md'), 'utf-8')).toBe('# From B\n');
      expect(git(team, 'ls-tree', '-r', '--name-only', 'main')).toContain('projects/backend/brain/features/orders.md');
    },
    TEST_TIMEOUT_MS
  );

  it(
    "refuses unrelated-history when the repository holds a different Workspace's history — nothing merged, nothing pushed",
    () => {
      const other = bare('other');
      // Somebody else's Workspace already lives there.
      const flowC = join(sandbox, 'flow-c');
      createWorkspace({ flowFolder: flowC, name: 'Team', remote: OTHER, deps });
      write(join(flowC, 'workspaces', 'team'), 'projects/web/discovery/discovery_web_v1.md', '# Web\n');
      expect(syncWorkspace({ flowFolder: flowC, push: true, workspace: 'team', deps })).toMatchObject({ pushed: true });
      const otherRefs = refsOf(other);
      const head = git(wsA, 'rev-parse', 'HEAD').trim();

      setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: OTHER, deps });
      calls = [];
      const refusal = refusalOf(() => sync(flowA), 'unrelated-history');
      expect(refusal.payload).toMatchObject({ pushed: false });
      expect(refusal.sentence).toContain('nothing in common');
      expect(refsOf(other)).toBe(otherRefs);
      // Only this machine's own commit (the recorded address) was made — no merge.
      expect(git(wsA, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').slice(1)).toEqual([head]);
      expect(calls.some((args) => args.includes('push'))).toBe(false);
      expect(calls.some((args) => args.includes('merge') && !args.includes('merge-base'))).toBe(false);
      // Disconnecting gets the Workspace back to a clean local-only state.
      unsetWorkspaceRemote({ flowFolder: flowA, workspace: 'team', deps });
      expect(sync(flowA)).toMatchObject({ state: 'local-only' });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses a repository that is not a Workspace with a sentence about the REPOSITORY, not this computer',
    () => {
      // Exactly what a freshly created Azure DevOps / GitHub repository looks
      // like: one commit holding a README, and no workspace.json. A person
      // pastes that address into Join because it is where the Workspace is
      // GOING to live — which is the honest mistake this refusal must answer.
      // `insteadOf` maps this address onto the bare repo bare() just made, the
      // same way every other remote in this file is spelled.
      const SCAFFOLDED = 'https://git.example.test/team/scaffolded.git';
      const scaffolded = bare('scaffolded');
      const seed = join(sandbox, 'seed');
      git(sandbox, 'clone', '-q', scaffolded, seed);
      writeFileSync(join(seed, 'README.md'), '# a workspace\n');
      git(seed, 'add', 'README.md');
      git(seed, 'commit', '-q', '-m', 'Add README');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');

      const flowD = join(sandbox, 'flow-d');
      const refusal = refusalOf(
        () => joinWorkspace({ flowFolder: flowD, remote: SCAFFOLDED, deps }),
        'not-a-workspace-repo'
      );

      // THE BUG THIS PINS. The reason used to be 'malformed-workspace', which
      // the app renders as "A Workspace on this computer can't be read." — so
      // the reader was sent to inspect their own machine, where nothing was
      // wrong. The sentence itself is pinned app-side, in workspace-refusals;
      // what belongs here is that joining a non-Workspace repository refuses
      // under a reason of its OWN, about the repository it was given.
      expect(refusal.reason).not.toBe('malformed-workspace');
      expect(refusal.payload).toMatchObject({ remote: SCAFFOLDED });
      expect(refusal.message).toContain('that repository is not a Flow Workspace');

      // Nothing of this person's was left behind by the attempt.
      expect(() => readFileSync(join(flowD, 'workspaces', 'scaffolded', 'workspace.json'), 'utf-8')).toThrow();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses while the Workspace is being synced, and writes nothing',
    () => {
      bare('ws');
      writeFileSync(join(wsA, '.git', SYNC_LOCK_GIT_PATH), `${process.pid}\n`);
      const refusal = refusalOf(() => setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: TEAM, deps }), 'sync-busy');
      expect(refusal.payload).toMatchObject({ workspaces: ['team'] });
      expect(originOf(wsA)).toBeNull();
      expect(fileOf(wsA)['remote']).toBeUndefined();
      rmSync(join(wsA, '.git', SYNC_LOCK_GIT_PATH));

      setWorkspaceRemote({ flowFolder: flowA, workspace: 'team', remote: TEAM, deps });
      writeFileSync(join(wsA, '.git', SYNC_LOCK_GIT_PATH), `${process.pid}\n`);
      refusalOf(() => unsetWorkspaceRemote({ flowFolder: flowA, workspace: 'team', deps }), 'sync-busy');
      expect(originOf(wsA)).toBe(TEAM);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses an unknown Workspace with the ones that exist',
    () => {
      const refusal = refusalOf(() => setWorkspaceRemote({ flowFolder: flowA, workspace: 'nope', remote: TEAM, deps }), 'unknown-workspace');
      expect(refusal.payload).toMatchObject({ workspaces: [{ slug: 'team', name: 'Team' }] });
    },
    TEST_TIMEOUT_MS
  );
});
