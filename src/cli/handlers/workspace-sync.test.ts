/**
 * `workspace sync` — in process, a REAL git, two "machines" (two Flow folders)
 * sharing one local bare repository.
 *
 * Isolation (the workspace-model suite's door): every Flow folder, code repo
 * and bare remote lives under one mkdtemp directory; git reads a private
 * config whose `insteadOf` maps https://git.example.test/ onto the sandbox's
 * bare repos, and only the `file` transport is allowed (FLOW_E2E=1 +
 * FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS=file). Every call names its own Flow
 * folder — the handler has no default one — so the real ~/plan-flow is never
 * reached.
 *
 * Every git call goes through a recording wrapper, so the suite can assert the
 * one thing a sync must never do: force anything.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const model = await import('./workspace-model.js');
const syncModule = await import('./workspace-sync.js');
const merge = await import('./workspace-merge.js');
const moveModule = await import('./workspace-move.js');

const { WorkspaceRefusal, createWorkspace, joinWorkspace, linkRepo, defaultWorkspaceGit } = model;
const { syncWorkspace, syncAllWorkspaces, classifyRemoteFailure, LOCK_TIMEOUT_MS } = syncModule;
const { moveFlowFolder } = moveModule;
const { unionLines, mergeWorkspaceFile } = merge;

type Git = typeof defaultWorkspaceGit;
type SyncOptions = Parameters<typeof syncWorkspace>[0];

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;
const TEST_TIMEOUT_MS = 120_000;
const REMOTE = 'https://git.example.test/team/ws.git';
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

describe('workspace-merge pure parts', () => {
  it('unites append-only lines, de-duplicated, ours first', () => {
    expect(unionLines('a\nb\n', 'b\nc\n')).toBe('a\nb\nc\n');
    expect(unionLines(null, 'x\n')).toBe('x\n');
    expect(unionLines('', '')).toBe('');
  });

  it('merges workspace.json project by project, and refuses a project changed differently on both sides', () => {
    const project = (id: string, slug: string, description?: string) => ({
      id,
      name: slug,
      slug,
      remotes: [],
      ...(description === undefined ? {} : { description }),
    });
    const base = { name: 'Team', slug: 'team', projects: [project('local:a', 'a')] };
    const ours = { ...base, projects: [project('local:a', 'a'), project('local:b', 'b')] };
    const theirs = { ...base, projects: [project('local:a', 'a', 'the API'), project('local:c', 'c')] };
    const merged = JSON.parse(mergeWorkspaceFile(JSON.stringify(base), JSON.stringify(ours), JSON.stringify(theirs)) as string);
    expect(merged.projects.map((entry: { slug: string }) => entry.slug)).toEqual(['a', 'c', 'b']);
    expect(merged.projects[0].description).toBe('the API');

    const oursAgain = { ...base, projects: [project('local:a', 'a', 'mine')] };
    expect(mergeWorkspaceFile(JSON.stringify(base), JSON.stringify(oursAgain), JSON.stringify(theirs))).toBeNull();
    // Two different projects given the same folder name would not validate.
    const slugClash = { ...base, projects: [project('local:a', 'a'), project('local:z', 'c')] };
    expect(mergeWorkspaceFile(JSON.stringify(base), JSON.stringify(slugClash), JSON.stringify(theirs))).toBeNull();
  });
});

describe('classifyRemoteFailure', () => {
  it.each([
    ["remote: Repository not found. fatal: repository 'https://github.com/acme/ws.git/' not found", 'no-access'],
    ["remote: Invalid username or password. fatal: Authentication failed for 'https://github.com/acme/ws.git/'", 'no-access'],
    ["fatal: unable to access 'https://github.com/acme/ws.git/': The requested URL returned error: 403", 'no-access'],
    ['remote: Permission to acme/ws.git denied to bob.', 'no-access'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'no-access'],
    ['git@github.com: Permission denied (publickey). fatal: Could not read from remote repository. Please make sure you have the correct access rights and the repository exists.', 'no-access'],
    // The same ssh boilerplate after a DNS failure is NOT an access problem.
    ['ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known fatal: Could not read from remote repository. Please make sure you have the correct access rights and the repository exists.', 'offline'],
    ["fatal: unable to access 'https://github.com/acme/ws.git/': Could not resolve host: github.com", 'offline'],
    ['ssh: connect to host github.com port 22: Operation timed out', 'offline'],
    ['spawnSync git ETIMEDOUT', 'offline'],
  ])('%s → %s', (detail, expected) => {
    expect(classifyRemoteFailure(detail)).toBe(expected);
  });
});

describe('replaceStaleLock (review fix 14)', () => {
  it('clears only the lock that was judged stale — a lock taken meanwhile is put back', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pf-stale-lock-')));
    try {
      const lock = join(dir, 'plan-flow-sync.lock');
      writeFileSync(lock, '999999\n');
      expect(syncModule.replaceStaleLock(lock, '999999\n')).toBe(true);
      expect(existsSync(lock)).toBe(false);
      // Judged stale as one body, but another run took the lock before the takeover.
      writeFileSync(lock, `${process.pid}\nfresh\n`);
      expect(syncModule.replaceStaleLock(lock, '999999\n')).toBe(false);
      expect(readFileSync(lock, 'utf-8')).toBe(`${process.pid}\nfresh\n`);
      expect(readdirSync(dir)).toEqual(['plan-flow-sync.lock']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeWithGit('workspace sync against real git, two machines', () => {
  let sandbox: string;
  let flowA: string;
  let flowB: string;
  let wsA: string;
  let wsB: string;
  let bare: string;
  let calls: string[][];
  let beforePush: ((cwd: string) => void) | null;
  /** Answer a git call with this error instead of running it (a remote that refuses). */
  let failWith: ((args: readonly string[]) => Error | null) | null;
  /** Run the call, then die: this and every later call fails, as if the process were killed. */
  let crashAfter: ((args: readonly string[]) => boolean) | null;
  let dead: boolean;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  const recordingGit: Git = (args, cwd, options) => {
    calls.push([...args]);
    if (dead) throw new Error('simulated crash: the sync process is gone');
    const injected = failWith?.(args) ?? null;
    if (injected !== null) throw injected;
    if (args.includes('push') && beforePush !== null) beforePush(cwd);
    let out = '';
    try {
      out = defaultWorkspaceGit(args, cwd, options);
    } finally {
      if (crashAfter?.(args) === true) dead = true;
    }
    if (dead) throw new Error('simulated crash: the sync process is gone');
    return out;
  };

  let currentCwd = '';
  const cwdTrackingGit: Git = (args, cwd, options) => {
    currentCwd = realpathSync(cwd);
    return recordingGit(args, cwd, options);
  };

  /** A git failure as execFileSync reports one. */
  const gitFailure = (stderr: string): Error => Object.assign(new Error('Command failed: git'), { stderr, status: 128 });

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  }

  const remoteRefs = (): string => git(bare, 'for-each-ref', '--format=%(refname) %(objectname)');
  const head = (repo: string): string => git(repo, 'rev-parse', 'HEAD').trim();

  function write(workspace: string, path: string, text: string): void {
    const full = join(workspace, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }

  const read = (workspace: string, path: string): string => readFileSync(join(workspace, path), 'utf-8');

  function sync(flowFolder: string, extra: Partial<SyncOptions> = {}): ReturnType<typeof syncWorkspace> {
    return syncWorkspace({ flowFolder, push: true, workspace: 'team', deps: { git: recordingGit, now: () => NOW }, ...extra });
  }

  function makeRepo(name: string, origin: string): string {
    const repo = join(sandbox, 'code', name);
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'app.ts'), 'export {}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    return repo;
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-sync-')));
    flowA = join(sandbox, 'flow-a');
    flowB = join(sandbox, 'flow-b');
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
    calls = [];
    beforePush = null;
    failWith = null;
    crashAfter = null;
    dead = false;

    // Machine A creates the Workspace and adds a project; the first sync publishes it.
    bare = join(sandbox, 'remotes', 'team', 'ws.git');
    git(join(sandbox, 'remotes', 'team'), 'init', '-q', '--bare', 'ws.git');
    createWorkspace({ flowFolder: flowA, name: 'Team', remote: REMOTE });
    wsA = join(flowA, 'workspaces', 'team');
    linkRepo({ flowFolder: flowA, target: makeRepo('backend', 'git@github.com:acme/backend.git'), workspace: 'team' });
    const first = sync(flowA);
    expect(first).toMatchObject({ state: 'synced', pushed: true, remote: REMOTE });
    // Machine B joins it.
    joinWorkspace({ flowFolder: flowB, remote: REMOTE });
    wsB = join(flowB, 'workspaces', 'team');
    calls = [];
  });

  afterEach(() => {
    // Never a force, never a rebase — across every git call the test made the sync do.
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
    'holds a draft and an unlanded document out of the push, and publishes each the moment it is ready',
    () => {
      const code = join(sandbox, 'code', 'backend');
      const doc = 'projects/backend/discovery/discovery_orders_v1.md';
      const remoteHas = (): string => git(bare, 'ls-tree', '-r', '--name-only', 'main');

      // POSITIVE CONTROL. An ordinary unstamped document still publishes, so a
      // missing path below is evidence of the gate and not of a broken sync (#28).
      write(wsA, 'projects/backend/discovery/discovery_plain_v1.md', '# Plain\n');
      expect(sync(flowA)).toMatchObject({ pushed: true });
      expect(remoteHas()).toContain('discovery_plain_v1.md');

      // 1. A DRAFT never leaves the machine, whatever its work did.
      write(wsA, doc, '---\nstatus: draft\n---\n# Orders\n\nStill thinking.\n');
      const drafted = sync(flowA);
      expect(drafted.held).toEqual([{ path: doc, project: 'backend', why: 'draft' }]);
      expect(remoteHas()).not.toContain('discovery_orders_v1.md');
      // Held, not lost: the file is untouched on disk.
      expect(read(wsA, doc)).toContain('Still thinking.');

      // 2. Finished, but its work has not reached the default branch yet.
      write(wsA, doc, '---\nlanded_by: run_orders\n---\n# Orders\n\nWhat it does.\n');
      const pending = sync(flowA);
      expect(pending.held).toEqual([{ path: doc, project: 'backend', why: 'pending' }]);
      expect(remoteHas()).not.toContain('discovery_orders_v1.md');

      // 3. The work lands on the code repo's default branch, carrying the token.
      writeFileSync(join(code, 'orders.ts'), 'export const orders = 1\n');
      git(code, 'add', '-A');
      git(code, 'commit', '-q', '-m', 'feat(phase-1.task-1): orders — orders\n\nFlow-Run: run_orders');
      const landed = sync(flowA);
      expect(landed.held).toEqual([]);
      expect(remoteHas()).toContain('discovery_orders_v1.md');
      expect(git(bare, 'show', `main:${doc}`)).toContain('What it does.');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'join links only checkouts recorded for the project; a remote-only match is returned as a candidate (review fix 2)',
    () => {
      const flowC = join(sandbox, 'flow-c');
      const apiC = makeRepo('api-c', 'https://github.com/acme/backend');
      mkdirSync(flowC, { recursive: true });
      // This machine knows the checkout — but under another id (a local-only project, another Workspace).
      writeFileSync(join(flowC, 'projects.local.json'), JSON.stringify({ projects: { 'local:api': apiC } }));
      const joined = joinWorkspace({ flowFolder: flowC, remote: REMOTE });
      expect(joined.linked).toEqual([]);
      expect(joined.candidates).toEqual([expect.objectContaining({ id: 'github.com/acme/backend', slug: 'backend', localPath: apiC })]);
      expect(joined.noLocalCheckout).toEqual([]);
      expect(lstatSync(join(apiC, 'flow'), { throwIfNoEntry: false })).toBeUndefined();
      // The clone never checks out a symlink, now or on any later checkout (review fix 4).
      expect(git(join(flowC, 'workspaces', 'team'), 'config', '--get', 'core.symlinks').trim()).toBe('false');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'syncs a Flow folder reached through a symlink (macOS /var → /private/var, a linked home)',
    () => {
      // The suite's sandbox is realpath'd, which hid this: git reports the REAL
      // top level, so comparing it with the unresolved path refused every sync.
      const linked = join(sandbox, 'linked-flow');
      symlinkSync(flowA, linked);
      write(wsA, 'projects/backend/discovery/discovery_link_v1.md', '# Through a link\n');
      expect(sync(linked)).toMatchObject({ state: 'synced', pushed: true });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'syncs both ways, rebuilds the generated brain index after a pull, and reports nothing-to-do when there is nothing',
    () => {
      write(wsA, 'projects/backend/discovery/discovery_orders_v1.md', '# Orders\n');
      const fromA = sync(flowA);
      expect(fromA).toMatchObject({ action: 'sync', state: 'synced', pushed: true, pulled: 0, ahead: 0 });
      expect(fromA.committed).toMatchObject({ message: 'knowledge: sync Team', files: 1 });
      expect(git(bare, 'log', '--format=%an', '-1', 'main').trim()).toBe('Test Person');

      const intoB = sync(flowB);
      expect(intoB).toMatchObject({ state: 'synced', pulled: 1, pushed: false, committed: null });
      expect(read(wsB, 'projects/backend/discovery/discovery_orders_v1.md')).toBe('# Orders\n');
      expect(intoB.indexes.rebuilt).toEqual(['backend']);
      expect(existsSync(join(wsB, 'projects/backend/brain/index.md'))).toBe(true);
      expect(git(wsB, 'ls-files', '--', 'projects/backend/brain/index.md').trim()).toBe(''); // generated: never committed

      write(wsB, 'projects/backend/plans/plan_orders_v1.md', '# Plan\n');
      expect(sync(flowB, { message: 'plan the orders' })).toMatchObject({ state: 'synced', pushed: true, committed: { message: 'plan the orders' } });
      expect(sync(flowA)).toMatchObject({ state: 'synced', pulled: 1 });
      expect(read(wsA, 'projects/backend/plans/plan_orders_v1.md')).toBe('# Plan\n');
      expect(sync(flowA)).toMatchObject({ state: 'nothing-to-do', committed: null, pulled: 0, pushed: false });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'keeps both sides of an append-only store (links.jsonl), and records the union in merges/',
    () => {
      write(wsA, 'links.jsonl', '{"n":0}\n');
      sync(flowA);
      sync(flowB);
      write(wsA, 'links.jsonl', '{"n":0}\n{"n":"a"}\n');
      write(wsB, 'links.jsonl', '{"n":0}\n{"n":"b"}\n');
      sync(flowA);

      const result = sync(flowB);
      expect(result.state).toBe('synced');
      expect(result.pushed).toBe(true);
      expect(result.resolutions).toEqual([{ kind: 'union', path: 'links.jsonl', attribute: true, lines: 3 }]);
      expect(read(wsB, 'links.jsonl').trim().split('\n').sort()).toEqual(['{"n":"a"}', '{"n":"b"}', '{"n":0}'].sort());
      expect(result.merge?.log).toMatch(/^merges\/2026-10-06-[0-9a-f]{8}\.md$/);
      const log = read(wsB, result.merge?.log as string);
      expect(log).toContain('links.jsonl');
      expect(log).toContain('{"n":"a"}');
      expect(log).toContain('{"n":"b"}');

      expect(sync(flowA)).toMatchObject({ state: 'synced', pulled: 2 });
      expect(read(wsA, 'links.jsonl').trim().split('\n')).toHaveLength(3);
      expect(existsSync(join(wsA, result.merge?.log as string))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'unites an append-only store by hand when merge=union did not take',
    () => {
      write(wsA, 'projects/backend/brain/.structure/annotations.jsonl', '{"a":0}\n');
      sync(flowA);
      sync(flowB);
      // This clone's own attributes switch the union driver off for jsonl.
      writeFileSync(join(wsB, '.git', 'info', 'attributes'), '*.jsonl -merge\n');
      write(wsA, 'projects/backend/brain/.structure/annotations.jsonl', '{"a":0}\n{"a":1}\n');
      sync(flowA);
      write(wsB, 'projects/backend/brain/.structure/annotations.jsonl', '{"a":0}\n{"a":2}\n');
      const result = sync(flowB);
      expect(result).toMatchObject({ state: 'synced', pushed: true });
      expect(result.resolutions).toEqual([
        { kind: 'union', path: 'projects/backend/brain/.structure/annotations.jsonl', attribute: false, lines: 3 },
      ]);
      expect(read(wsB, 'projects/backend/brain/.structure/annotations.jsonl')).toBe('{"a":0}\n{"a":2}\n{"a":1}\n');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'renumbers the same new discovery created on both sides, moves its feature view and updates references to it',
    () => {
      write(wsA, 'projects/backend/discovery/discovery_x_v1.md', '# X — from A\n');
      sync(flowA);
      write(wsB, 'projects/backend/discovery/discovery_x_v1.md', '# X — from B\nSee discovery_x_v1.walkthrough.html\n');
      write(wsB, 'projects/backend/discovery/discovery_x_v1.walkthrough.html', '<title>discovery_x_v1</title>\n');
      write(wsB, 'projects/backend/plans/plan_x_v1.md', '**Discovery**: `flow/discovery/discovery_x_v1.md` (not discovery_x_v10)\n');

      const result = sync(flowB);
      expect(result.state).toBe('synced');
      expect(result.pushed).toBe(true);
      expect(result.resolutions).toEqual([
        {
          kind: 'renumber',
          path: 'projects/backend/discovery/discovery_x_v1.md',
          renamedTo: 'projects/backend/discovery/discovery_x_v2.md',
          walkthrough: {
            from: 'projects/backend/discovery/discovery_x_v1.walkthrough.html',
            to: 'projects/backend/discovery/discovery_x_v2.walkthrough.html',
          },
          referencesUpdated: ['projects/backend/plans/plan_x_v1.md'],
          referencesNotUpdated: [],
        },
      ]);
      expect(read(wsB, 'projects/backend/discovery/discovery_x_v1.md')).toBe('# X — from A\n');
      expect(read(wsB, 'projects/backend/discovery/discovery_x_v2.md')).toBe('# X — from B\nSee discovery_x_v2.walkthrough.html\n');
      expect(existsSync(join(wsB, 'projects/backend/discovery/discovery_x_v1.walkthrough.html'))).toBe(false);
      expect(read(wsB, 'projects/backend/discovery/discovery_x_v2.walkthrough.html')).toBe('<title>discovery_x_v2</title>\n');
      expect(read(wsB, 'projects/backend/plans/plan_x_v1.md')).toBe('**Discovery**: `flow/discovery/discovery_x_v2.md` (not discovery_x_v10)\n');

      const log = read(wsB, result.merge?.log as string);
      expect(log).toContain('# X — from A');
      expect(log).toContain('# X — from B');
      expect(sync(flowA)).toMatchObject({ state: 'synced' });
      expect(read(wsA, 'projects/backend/discovery/discovery_x_v2.md')).toContain('from B');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'asks — never merges — when a decision changed on both sides: tree restored, nothing pushed; then applies the decision',
    () => {
      const decision = 'projects/backend/brain/decisions/use-postgres.md';
      write(wsA, decision, '# Use Postgres\n\nBecause.\n');
      sync(flowA);
      sync(flowB);
      write(wsA, decision, '# Use Postgres\n\nBecause of JSONB.\n');
      sync(flowA);
      write(wsB, decision, '# Use Postgres\n\nBecause of the team.\n');
      write(wsB, 'projects/backend/plans/plan_db_v1.md', '# DB\n');
      const refsBefore = remoteRefs();

      const asked = sync(flowB);
      expect(asked.state).toBe('ask');
      expect(asked.pushed).toBe(false);
      expect(asked.committed).not.toBeNull();
      expect(asked.asks).toHaveLength(1);
      expect(asked.asks[0]).toMatchObject({
        kind: 'decision',
        topic: 'backend/decisions/use-postgres',
        path: decision,
        existingPath: decision,
        existing: '# Use Postgres\n\nBecause of JSONB.\n',
        incoming: '# Use Postgres\n\nBecause of the team.\n',
        options: ['ours', 'theirs', 'file'],
      });
      // Restored: on the local commit, no merge in progress, nothing changed, nothing published.
      expect(head(wsB)).toBe(asked.committed?.sha);
      expect(existsSync(join(wsB, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(git(wsB, 'status', '--porcelain', '--untracked-files=no').trim()).toBe('');
      expect(read(wsB, decision)).toBe('# Use Postgres\n\nBecause of the team.\n');
      expect(remoteRefs()).toBe(refsBefore);

      // Asked again: the same question, the same id — still nothing pushed.
      const again = sync(flowB);
      expect(again).toMatchObject({ state: 'ask', committed: null });
      expect(again.asks[0].id).toBe(asked.asks[0].id);
      expect(remoteRefs()).toBe(refsBefore);

      // A take the item does not accept is refused, and leaves everything as it was.
      refusalOf(() => sync(flowB, { resolve: { path: decision, take: 'merged' } }), 'invalid-resolution');
      refusalOf(() => sync(flowB, { resolve: { path: 'projects/backend/plans/plan_db_v1.md', take: 'ours' } }), 'nothing-to-resolve');
      expect(head(wsB)).toBe(asked.committed?.sha);
      expect(remoteRefs()).toBe(refsBefore);

      // The person writes the merged text; the decision completes the merge.
      const draft = join(sandbox, 'draft.md');
      writeFileSync(draft, '# Use Postgres\n\nBecause of JSONB and the team.\n');
      const resolved = sync(flowB, { resolve: { path: decision, take: `file:${draft}` } });
      expect(resolved).toMatchObject({ state: 'synced', pushed: true, asks: [], decided: [asked.asks[0].id] });
      expect(resolved.resolutions).toEqual([{ kind: 'decision', path: decision, take: 'file', item: asked.asks[0].id }]);
      expect(read(wsB, decision)).toBe('# Use Postgres\n\nBecause of JSONB and the team.\n');
      expect(read(wsB, resolved.merge?.log as string)).toContain('Decided by a person');
      expect(existsSync(join(wsB, '.git', 'plan-flow-sync-decisions.json'))).toBe(false);

      expect(sync(flowA)).toMatchObject({ state: 'synced' });
      expect(read(wsA, decision)).toBe('# Use Postgres\n\nBecause of JSONB and the team.\n');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'asks when the same feature is edited on both sides — even when git could merge it — and takes the clean merge on request',
    () => {
      const feature = 'projects/backend/brain/features/auth.md';
      const note = (summary: string, tail: string): string =>
        `---\nid: feature:backend::auth\nname: Auth\nkind: core\nanchors: [file:src/auth.ts]\n---\n\n# Auth\n\n${summary}\n\nmiddle\n\n${tail}\n`;
      write(wsA, feature, note('Signs people in.', 'End.'));
      sync(flowA);
      sync(flowB);
      write(wsA, feature, note('Signs people in with SSO.', 'End.'));
      sync(flowA);
      write(wsB, feature, note('Signs people in.', 'End, with tokens.'));
      const refsBefore = remoteRefs();

      const asked = sync(flowB);
      expect(asked.state).toBe('ask');
      expect(asked.asks).toHaveLength(1);
      expect(asked.asks[0]).toMatchObject({ kind: 'same-feature', topic: 'backend/auth', path: feature, options: ['ours', 'theirs', 'merged', 'file'] });
      expect(asked.asks[0].merged).toContain('with SSO');
      expect(asked.asks[0].merged).toContain('with tokens');
      expect(remoteRefs()).toBe(refsBefore);

      const resolved = sync(flowB, { resolve: { path: feature, take: 'merged' } });
      expect(resolved).toMatchObject({ state: 'synced', pushed: true });
      expect(read(wsB, feature)).toBe(note('Signs people in with SSO.', 'End, with tokens.'));
    },
    TEST_TIMEOUT_MS
  );

  it(
    'asks when two different features newly claim the same anchor',
    () => {
      const featureNote = (id: string, anchors: string): string => `---\nid: ${id}\nname: ${id}\nkind: core\nanchors: [${anchors}]\n---\n\n# ${id}\n`;
      write(wsA, 'projects/backend/brain/features/orders.md', featureNote('feature:backend::orders', 'endpoint:POST /api/orders'));
      sync(flowA);
      write(wsB, 'projects/backend/brain/features/checkout.md', featureNote('feature:backend::checkout', 'endpoint:POST /api/orders'));
      const asked = sync(flowB);
      expect(asked.state).toBe('ask');
      expect(asked.asks).toEqual([
        expect.objectContaining({
          kind: 'overlapping-anchors',
          path: 'projects/backend/brain/features/checkout.md',
          existingPath: 'projects/backend/brain/features/orders.md',
          anchors: ['endpoint:POST /api/orders'],
        }),
      ]);
      // Keeping both is "ours" — this machine's file stays as it is.
      expect(sync(flowB, { resolve: { path: 'projects/backend/brain/features/checkout.md', take: 'ours' } })).toMatchObject({ state: 'synced', pushed: true });
      expect(existsSync(join(wsB, 'projects/backend/brain/features/orders.md'))).toBe(true);
      expect(existsSync(join(wsB, 'projects/backend/brain/features/checkout.md'))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'asks when one side edits a discovery the other side superseded with a new version',
    () => {
      write(wsA, 'projects/backend/discovery/discovery_y_v1.md', '# Y\n');
      sync(flowA);
      sync(flowB);
      write(wsA, 'projects/backend/discovery/discovery_y_v2.md', '# Y, again\n');
      sync(flowA);
      write(wsB, 'projects/backend/discovery/discovery_y_v1.md', '# Y\n\nMore detail.\n');
      const asked = sync(flowB);
      expect(asked.state).toBe('ask');
      expect(asked.asks).toEqual([
        expect.objectContaining({
          kind: 'same-discovery',
          topic: 'backend/discovery y',
          path: 'projects/backend/discovery/discovery_y_v1.md',
          existingPath: 'projects/backend/discovery/discovery_y_v2.md',
          existing: '# Y, again\n',
          incoming: '# Y\n\nMore detail.\n',
        }),
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'hands back both versions of a conflicting authored edit for review, and resolves it to ours',
    () => {
      const plan = 'projects/backend/plans/plan_z_v1.md';
      write(wsA, plan, '# Z\n\nStep one.\n');
      sync(flowA);
      sync(flowB);
      write(wsA, plan, '# Z\n\nStep one, by A.\n');
      sync(flowA);
      write(wsB, plan, '# Z\n\nStep one, by B.\n');
      const refsBefore = remoteRefs();

      const reviewed = sync(flowB);
      expect(reviewed.state).toBe('review');
      expect(reviewed.asks).toEqual([]);
      expect(reviewed.reviews).toEqual([
        expect.objectContaining({
          kind: 'conflict',
          path: plan,
          base: '# Z\n\nStep one.\n',
          existing: '# Z\n\nStep one, by A.\n',
          incoming: '# Z\n\nStep one, by B.\n',
          options: ['ours', 'theirs', 'file'],
        }),
      ]);
      expect(reviewed.reviews[0].conflicted).toContain('<<<<<<<');
      expect(read(wsB, plan)).toBe('# Z\n\nStep one, by B.\n');
      expect(remoteRefs()).toBe(refsBefore);

      const resolved = sync(flowB, { resolve: { path: join(wsB, plan), take: 'ours' } });
      expect(resolved).toMatchObject({ state: 'synced', pushed: true });
      expect(read(wsB, plan)).toBe('# Z\n\nStep one, by B.\n');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses a personal file — staged by force or committed by hand — and commits and pushes nothing',
    () => {
      const refsBefore = remoteRefs();
      const before = head(wsA);
      write(wsA, 'projects/backend/tasklist.md', '- [ ] my own todo\n');
      write(wsA, 'projects/backend/plans/plan_ok_v1.md', '# fine\n');
      git(wsA, 'add', '-f', '--', 'projects/backend/tasklist.md');

      const refusal = refusalOf(() => sync(flowA), 'personal-files');
      expect(refusal.payload).toMatchObject({ paths: ['projects/backend/tasklist.md'], committed: false, pushed: false });
      expect(head(wsA)).toBe(before);
      expect(git(wsA, 'diff', '--cached', '--name-only').trim()).toBe('');
      expect(remoteRefs()).toBe(refsBefore);

      // Committed by hand behind Flow's back: the outgoing check still refuses before anything is pushed.
      git(wsA, 'add', '-f', '--', 'projects/backend/tasklist.md');
      git(wsA, 'commit', '-q', '-m', 'oops');
      refusalOf(() => sync(flowA), 'personal-files');
      expect(remoteRefs()).toBe(refsBefore);
      expect(calls.some((args) => args.includes('push'))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'keeps the commit and says offline when the remote cannot be reached, then publishes once it can',
    () => {
      renameSync(bare, `${bare}.away`);
      write(wsA, 'projects/backend/plans/plan_offline_v1.md', '# written on a plane\n');
      const result = sync(flowA);
      expect(result.state).toBe('offline');
      expect(result.pushed).toBe(false);
      expect(result.committed).not.toBeNull();
      expect(result.ahead).toBe(1);
      expect(result.detail).toMatch(/kept on this machine/);

      renameSync(`${bare}.away`, bare);
      expect(sync(flowA)).toMatchObject({ state: 'synced', pushed: true, committed: null, ahead: 0 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'merges once more when the push is rejected because the remote moved, and reports behind when it keeps moving',
    () => {
      let moves = 0;
      const moveRemote = (): void => {
        moves += 1;
        const hold = beforePush;
        beforePush = null;
        write(wsA, `projects/backend/plans/plan_race_${moves}_v1.md`, `# race ${moves}\n`);
        syncWorkspace({ flowFolder: flowA, push: true, workspace: 'team', deps: { now: () => NOW } });
        beforePush = hold;
      };

      write(wsB, 'projects/backend/plans/plan_b_v1.md', '# B\n');
      let first = true;
      beforePush = () => {
        if (first) {
          first = false;
          moveRemote();
        }
      };
      const retried = sync(flowB);
      expect(retried).toMatchObject({ state: 'synced', pushed: true, pulled: 1 });
      expect(calls.filter((args) => args.includes('push'))).toHaveLength(2);

      write(wsB, 'projects/backend/plans/plan_b2_v1.md', '# B2\n');
      beforePush = () => moveRemote();
      const behind = sync(flowB);
      expect(behind.state).toBe('behind');
      expect(behind.pushed).toBe(false);
      expect(behind.ahead).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'syncs a Workspace with no remote locally, skips no project that kept its own knowledge repo, and syncs everything with --all',
    () => {
      createWorkspace({ flowFolder: flowA, name: 'Solo' });
      const solo = join(flowA, 'workspaces', 'solo');
      write(solo, 'notes.md', '# solo\n');
      const local = syncWorkspace({ flowFolder: flowA, push: true, workspace: 'solo', deps: { git: recordingGit, now: () => NOW } });
      expect(local).toMatchObject({ state: 'local-only', remote: null, pushed: false, committed: { files: 1 } });

      // A checkout that keeps its knowledge in its own repository is no longer
      // skipped (hard migration, 2026-10-06): it is migrated with --import.
      const checkout = join(sandbox, 'code', 'backend');
      unlinkSync(join(checkout, 'flow'));
      mkdirSync(join(checkout, 'flow', '.git'), { recursive: true });
      expect(sync(flowA).skipped).toEqual([]);
      rmSync(join(checkout, 'flow'), { recursive: true, force: true });
      symlinkSync(join(wsA, 'projects', 'backend'), join(checkout, 'flow'));

      write(wsA, 'projects/backend/plans/plan_all_v1.md', '# all\n');
      const all = syncAllWorkspaces({ flowFolder: flowA, push: true, deps: { git: recordingGit, now: () => NOW } });
      expect(all.all).toBe(true);
      expect(all.results.map((entry) => ('state' in entry ? `${entry.workspace.slug}:${entry.state}` : 'refused'))).toEqual([
        'solo:local-only',
        'team:synced',
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses to run over a merge someone left half-done, and refuses an unknown Workspace',
    () => {
      writeFileSync(join(wsA, '.git', 'MERGE_HEAD'), `${head(wsA)}\n`);
      refusalOf(() => sync(flowA), 'merge-in-progress');
      rmSync(join(wsA, '.git', 'MERGE_HEAD'));
      refusalOf(() => sync(flowA, { workspace: 'nope' }), 'unknown-workspace');
    },
    TEST_TIMEOUT_MS
  );
  // ── Access refused vs offline ──

  it(
    'says no-access — not offline — when the remote refuses the fetch, keeps the commit, and pushes nothing',
    () => {
      const refsBefore = remoteRefs();
      failWith = (args) =>
        args.includes('fetch') ? gitFailure("remote: Repository not found.\nfatal: repository 'https://git.example.test/team/ws.git/' not found\n") : null;
      write(wsA, 'projects/backend/plans/plan_denied_v1.md', '# denied\n');
      const result = sync(flowA);
      expect(result).toMatchObject({ state: 'no-access', pushed: false, ahead: 1 });
      expect(result.committed).not.toBeNull();
      expect(result.detail).toMatch(/refused this machine's access/);
      expect(calls.some((args) => args.includes('push'))).toBe(false);
      expect(remoteRefs()).toBe(refsBefore);

      // Access back: the same commit is published.
      failWith = null;
      expect(sync(flowA)).toMatchObject({ state: 'synced', pushed: true, ahead: 0 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'says no-access when the fetch works but the push is refused (read-only access) — and does not retry it as a moved remote',
    () => {
      const refsBefore = remoteRefs();
      failWith = (args) =>
        args.includes('push')
          ? gitFailure("remote: Permission to team/ws.git denied to bob.\nfatal: unable to access 'https://git.example.test/team/ws.git/': The requested URL returned error: 403\n")
          : null;
      write(wsA, 'projects/backend/plans/plan_readonly_v1.md', '# read only\n');
      const result = sync(flowA);
      expect(result).toMatchObject({ state: 'no-access', pushed: false, ahead: 1 });
      expect(calls.filter((args) => args.includes('push'))).toHaveLength(1);
      expect(remoteRefs()).toBe(refsBefore);
    },
    TEST_TIMEOUT_MS
  );

  // ── Commit only ──

  it(
    'commits and does nothing else with commitOnly — no fetch, no merge, no push — then a full sync exchanges it',
    () => {
      // The remote has news this machine has not fetched: a commit-only run must not bring it in.
      write(wsB, 'projects/backend/plans/plan_from_b_v1.md', '# from B\n');
      sync(flowB);
      calls = [];
      const refsBefore = remoteRefs();
      write(wsA, 'projects/backend/plans/plan_quit_v1.md', '# before closing\n');

      const committed = sync(flowA, { commitOnly: true, message: 'changes before closing' });
      // POSITIVE FIRST: the commit happened.
      expect(committed).toMatchObject({ mode: 'commit-only', state: 'committed', pushed: false, pulled: 0, ahead: 1 });
      expect(committed.committed).toMatchObject({ message: 'changes before closing', files: 1 });
      expect(git(wsA, 'log', '-1', '--format=%s').trim()).toBe('changes before closing');
      // …and nothing touched the network or merged.
      expect(calls.filter((args) => args.includes('fetch') || args.includes('push') || args.includes('merge'))).toEqual([]);
      expect(remoteRefs()).toBe(refsBefore);
      expect(existsSync(join(wsA, 'projects/backend/plans/plan_from_b_v1.md'))).toBe(false);

      expect(sync(flowA, { commitOnly: true })).toMatchObject({ state: 'nothing-to-do', committed: null });
      // A decision needs the merge it answers.
      refusalOf(() => sync(flowA, { commitOnly: true, resolve: { path: 'projects/backend/plans/plan_quit_v1.md', take: 'ours' } }), 'invalid-resolution');
      // The guard still runs: a personal file refuses a commit-only run too.
      write(wsA, 'projects/backend/tasklist.md', 'mine\n');
      git(wsA, 'add', '-f', '--', 'projects/backend/tasklist.md');
      refusalOf(() => sync(flowA, { commitOnly: true }), 'personal-files');
      git(wsA, 'reset', '-q');

      const full = sync(flowA);
      expect(full).toMatchObject({ mode: 'full', state: 'synced', pushed: true, pulled: 1, ahead: 0 });
      expect(read(wsA, 'projects/backend/plans/plan_from_b_v1.md')).toBe('# from B\n');
    },
    TEST_TIMEOUT_MS
  );

  // ── A sync that died mid-merge ──

  const MERGE_STARTS = (args: readonly string[]): boolean => args.includes('merge') && args.includes('--no-commit');
  const DEAD_PID = spawnSync('true').pid as number;

  /** B's sync dies right after `git merge --no-commit`, leaving its lock behind. */
  function crashMidMerge(): string {
    crashAfter = MERGE_STARTS;
    expect(() => sync(flowB)).toThrow(/simulated crash/);
    crashAfter = null;
    dead = false;
    expect(existsSync(join(wsB, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(existsSync(join(wsB, '.git', 'plan-flow-sync-merge.json'))).toBe(true);
    // A killed process never runs its `finally`: put the lock back the way it would be.
    writeFileSync(join(wsB, '.git', 'plan-flow-sync.lock'), `${DEAD_PID}\n`);
    // What the dying run attempted is not what the recovery does.
    calls = [];
    return head(wsB);
  }

  it(
    "undoes a conflicted merge its own sync left half-done, keeps every edit made before and after it, and clears the dead run's lock",
    () => {
      const plan = 'projects/backend/plans/plan_z_v1.md';
      write(wsA, plan, '# Z\n\nStep one.\n');
      // In a folder, not at the project's knowledge root: an unrecognised root
      // file is `personal` now (forbidden-pattern #24), so a fixture there would
      // be testing the closed-root rule instead of the merge recovery.
      write(wsA, 'projects/backend/resources/notes.md', 'base\n');
      sync(flowA);
      sync(flowB);
      write(wsA, plan, '# Z\n\nStep one, by A.\n');
      sync(flowA);
      write(wsB, plan, '# Z\n\nStep one, by B.\n');
      const refsBefore = remoteRefs();

      const localCommit = crashMidMerge();
      expect(read(wsB, plan)).toContain('<<<<<<<');
      // After the crash, an agent writes on: a new note, and an edit to a file the merge did not touch.
      write(wsB, 'projects/backend/plans/plan_after_v1.md', '# after the crash\n');
      write(wsB, 'projects/backend/resources/notes.md', 'base, edited after the crash\n');

      const recovered = sync(flowB);
      expect(recovered.recovered).toEqual({ lock: 'owner-gone', merge: true });
      // The conflict is still a conflict: asked about again, nothing pushed.
      expect(recovered.state).toBe('review');
      expect(recovered.reviews.map((review) => review.path)).toEqual([plan]);
      expect(remoteRefs()).toBe(refsBefore);
      // Nothing lost: B's pre-merge edit is in its commit, the after-crash edits are committed on top.
      expect(git(wsB, 'show', `${localCommit}:${plan}`)).toBe('# Z\n\nStep one, by B.\n');
      expect(git(wsB, 'rev-parse', 'HEAD~1').trim()).toBe(localCommit);
      expect(recovered.committed).toMatchObject({ files: 2 });
      expect(read(wsB, plan)).toBe('# Z\n\nStep one, by B.\n');
      expect(read(wsB, 'projects/backend/resources/notes.md')).toBe('base, edited after the crash\n');
      expect(read(wsB, 'projects/backend/plans/plan_after_v1.md')).toBe('# after the crash\n');
      expect(existsSync(join(wsB, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(existsSync(join(wsB, '.git', 'plan-flow-sync-merge.json'))).toBe(false);
      expect(existsSync(join(wsB, '.git', 'plan-flow-sync.lock'))).toBe(false);
      // Never a hard reset in recovery.
      expect(calls.some((args) => args.includes('--hard'))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'undoes a clean merge left half-done and finishes the sync — merged and published',
    () => {
      write(wsA, 'projects/backend/plans/plan_a_v1.md', '# A\n');
      sync(flowA);
      write(wsB, 'projects/backend/plans/plan_b_v1.md', '# B\n');
      crashMidMerge();
      const finished = sync(flowB);
      expect(finished).toMatchObject({ state: 'synced', pushed: true, pulled: 1, recovered: { lock: 'owner-gone', merge: true } });
      expect(read(wsB, 'projects/backend/plans/plan_a_v1.md')).toBe('# A\n');
      expect(git(bare, 'show', 'main:projects/backend/plans/plan_b_v1.md')).toBe('# B\n');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'will not undo a half-done merge whose conflict was resolved by hand, or whose merged-in files were edited since — the tree stays as it is',
    () => {
      const plan = 'projects/backend/plans/plan_z_v1.md';
      write(wsA, plan, '# Z\n\nStep one.\n');
      sync(flowA);
      sync(flowB);
      write(wsA, plan, '# Z\n\nStep one, by A.\n');
      write(wsA, 'projects/backend/plans/plan_new_v1.md', '# new from A\n');
      sync(flowA);
      write(wsB, plan, '# Z\n\nStep one, by B.\n');
      crashMidMerge();

      // Someone resolved the conflict by hand.
      write(wsB, plan, '# Z\n\nStep one, by A and B.\n');
      const handEdited = refusalOf(() => sync(flowB), 'merge-in-progress');
      expect(handEdited.payload).toMatchObject({ leftBy: 'flow', handEdited: [plan] });
      expect(read(wsB, plan)).toBe('# Z\n\nStep one, by A and B.\n');
      expect(existsSync(join(wsB, '.git', 'MERGE_HEAD'))).toBe(true);

      // Put the conflict back; now edit a file the merge brought in — git refuses the abort, so does Flow.
      git(wsB, 'checkout', '--merge', '--', plan);
      expect(read(wsB, plan)).toContain('<<<<<<<');
      write(wsB, 'projects/backend/plans/plan_new_v1.md', '# new from A, edited on B\n');
      const touched = refusalOf(() => sync(flowB), 'merge-in-progress');
      expect(touched.payload).toMatchObject({ leftBy: 'flow' });
      expect(read(wsB, 'projects/backend/plans/plan_new_v1.md')).toBe('# new from A, edited on B\n');
      expect(existsSync(join(wsB, '.git', 'MERGE_HEAD'))).toBe(true);
      expect(calls.some((args) => args.includes('--hard'))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'clears a lock only when its run is gone: a live owner holds it, an unknown one holds it until the sync timeout',
    () => {
      const lock = join(wsA, '.git', 'plan-flow-sync.lock');
      // The lock's age is read against the real clock here (its mtime is real).
      const syncNow = () => syncWorkspace({ flowFolder: flowA, push: true, workspace: 'team', deps: { git: recordingGit } });
      const backdate = (ms: number): void => {
        const at = new Date(Date.now() - ms);
        utimesSync(lock, at, at);
      };
      // A live process (this one's parent) holding it, fresh: busy.
      writeFileSync(lock, `${process.ppid}\n`);
      refusalOf(syncNow, 'sync-busy');
      // …unless it is older than any sync could run: the pid was reused.
      backdate(16 * 60_000);
      expect(syncNow().recovered.lock).toBe('expired');
      // No readable owner, younger than the timeout: busy.
      writeFileSync(lock, 'garbage\n');
      backdate(LOCK_TIMEOUT_MS - 60_000);
      refusalOf(syncNow, 'sync-busy');
      // …older than it: cleared.
      backdate(LOCK_TIMEOUT_MS + 60_000);
      expect(syncNow().recovered).toEqual({ lock: 'expired', merge: false });
      expect(existsSync(lock)).toBe(false);
      // A recorded owner that is gone: cleared at once.
      writeFileSync(lock, `${DEAD_PID}\n`);
      expect(sync(flowA).recovered.lock).toBe('owner-gone');
    },
    TEST_TIMEOUT_MS
  );

  // ── Team rules after a pull ──

  it(
    "mirrors a project's team rules into its checkout after a pull — never over rules the code repo commits, never through a link",
    () => {
      const checkout = join(sandbox, 'code', 'backend');
      write(wsB, 'projects/backend/rules/team.md', '# Team rule\n');
      sync(flowB);

      const pulled = sync(flowA);
      expect(pulled).toMatchObject({ state: 'synced', pulled: 1 });
      expect(pulled.rules).toEqual({ copied: ['backend'], skipped: [], failed: [] });
      expect(readFileSync(join(checkout, '.claude', 'rules', 'team.md'), 'utf-8')).toBe('# Team rule\n');

      // A rule deleted in the Workspace disappears from the checkout too (a mirror).
      rmSync(join(wsB, 'projects/backend/rules/team.md'));
      write(wsB, 'projects/backend/rules/other.md', '# Other\n');
      sync(flowB);
      expect(sync(flowA).rules.copied).toEqual(['backend']);
      expect(readdirSync(join(checkout, '.claude', 'rules'))).toEqual(['other.md']);

      // Nothing pulled → nothing copied.
      expect(sync(flowA).rules).toEqual({ copied: [], skipped: [], failed: [] });

      // The code repo commits its own .claude/rules: skipped, its files untouched.
      write(checkout, '.claude/rules/core/allowed-patterns.md', '# ours\n');
      git(checkout, 'add', '-f', '--', '.claude/rules/core/allowed-patterns.md');
      git(checkout, 'commit', '-q', '-m', 'rules');
      write(wsB, 'projects/backend/rules/other.md', '# Other, again\n');
      sync(flowB);
      expect(sync(flowA).rules).toEqual({ copied: [], skipped: [{ project: 'backend', reason: 'rules-tracked-in-code-repo' }], failed: [] });
      expect(readFileSync(join(checkout, '.claude/rules/core/allowed-patterns.md'), 'utf-8')).toBe('# ours\n');
      git(checkout, 'rm', '-q', '-r', '--cached', '--', '.claude/rules');
      git(checkout, 'commit', '-q', '-m', 'untrack');
      rmSync(join(checkout, '.claude'), { recursive: true, force: true });

      // A `rules` that is a link is never copied from.
      const outside = join(sandbox, 'outside-rules');
      write(outside, 'secret.md', 'not a rule\n');
      rmSync(join(wsA, 'projects/backend/rules'), { recursive: true, force: true });
      symlinkSync(outside, join(wsA, 'projects/backend/rules'));
      expect(model.realOrResolved(join(wsA, 'projects/backend/rules'))).toBe(realpathSync(outside));
      write(wsB, 'projects/backend/plans/plan_poke_v1.md', '# poke\n');
      sync(flowB);
      // The pull brings B's rules/ back as a real folder only if git can write it; either way no secret is copied.
      const afterLink = sync(flowA);
      expect(afterLink.pulled).toBeGreaterThan(0);
      expect(afterLink.rules.copied).toEqual([]);
      expect(existsSync(join(checkout, '.claude', 'rules', 'secret.md'))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  // ── Review fixes: incoming safety, every outgoing commit, tracked personal files ──

  /** Publish a commit to the bare remote straight from a plain clone — no Flow, no guard. */
  function rawPush(name: string, mutate: (dir: string) => void, options: { amend?: boolean } = {}): string {
    const dir = join(sandbox, `raw-${name}`);
    git(sandbox, 'clone', '-q', bare, dir);
    mutate(dir);
    git(dir, 'add', '-A', '-f');
    git(dir, 'commit', '-q', ...(options.amend === true ? ['--amend', '--no-edit'] : ['-m', `raw ${name}`]));
    git(dir, 'push', '-q', ...(options.amend === true ? ['--force'] : []), 'origin', 'HEAD:main');
    return head(dir);
  }

  it.each([
    ['a personal file under another spelling', (dir: string) => write(dir, 'projects/backend/TaskList.md', '- [ ] theirs\n'), 'projects/backend/TaskList.md'],
    ['a symlink', (dir: string) => symlinkSync('/etc/hosts', join(dir, 'projects', 'backend', 'hosts.md')), 'projects/backend/hosts.md'],
    [
      'a .gitattributes change outside the generated block',
      (dir: string) => writeFileSync(join(dir, '.gitattributes'), `${readFileSync(join(dir, '.gitattributes'), 'utf-8')}*.md merge=union\n`),
      '.gitattributes',
    ],
    ['a nested .gitignore', (dir: string) => write(dir, 'projects/backend/.gitignore', '*.md\n'), 'projects/backend/.gitignore'],
  ])(
    'refuses an incoming change that carries %s — nothing merged, nothing pushed (review fix 4)',
    (_label, mutate, path) => {
      rawPush('unsafe', mutate);
      const before = head(wsB);
      write(wsB, 'projects/backend/plans/plan_mine_v1.md', '# mine\n');
      const refsBefore = remoteRefs();
      const refusal = refusalOf(() => sync(flowB), 'incoming-unsafe');
      expect(refusal.payload).toMatchObject({ paths: [expect.objectContaining({ path })], pushed: false });
      expect(git(wsB, 'rev-parse', 'HEAD~1').trim()).toBe(before); // the local commit stays, nothing merged on top
      if (path === '.gitattributes') expect(read(wsB, path)).not.toContain('*.md merge=union');
      else expect(existsSync(join(wsB, path))).toBe(false);
      expect(remoteRefs()).toBe(refsBefore);
      expect(calls.some((args) => args.includes('push'))).toBe(false);
      // Every merge/checkout git ran wrote no symlink.
      for (const args of calls.filter((entry) => entry.includes('merge') && !entry.includes('merge-base'))) {
        expect(args).toEqual(expect.arrayContaining(['-c', 'core.symlinks=false']));
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    'lets an incoming change to the generated block of .gitignore through (review fix 4)',
    () => {
      rawPush('block', (dir) => {
        const text = readFileSync(join(dir, '.gitignore'), 'utf-8');
        writeFileSync(join(dir, '.gitignore'), text.replace('# Generated files are rebuilt', '# Generated files (newer Flow) are rebuilt'));
        write(dir, 'projects/backend/plans/plan_theirs_v1.md', '# theirs\n');
      });
      expect(sync(flowB)).toMatchObject({ state: 'synced', pulled: 1 });
      expect(read(wsB, 'projects/backend/plans/plan_theirs_v1.md')).toBe('# theirs\n');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'checks every outgoing commit for personal files, not just the net change (review fix 5)',
    () => {
      const refsBefore = remoteRefs();
      write(wsA, 'projects/backend/memory.md', 'my memory\n');
      git(wsA, 'add', '-f', '--', 'projects/backend/memory.md');
      git(wsA, 'commit', '-q', '-m', 'oops');
      git(wsA, 'rm', '-q', '--cached', '--', 'projects/backend/memory.md');
      git(wsA, 'commit', '-q', '-m', 'undo oops');
      const refusal = refusalOf(() => sync(flowA), 'personal-files');
      expect(refusal.payload).toMatchObject({ paths: ['projects/backend/memory.md'] });
      expect(remoteRefs()).toBe(refsBefore);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'stops tracking personal and generated files the Workspace already holds, and publishes that (review fix 6)',
    () => {
      // Pushed long ago, before these were classified (a plain git push, no guard).
      write(wsA, 'projects/backend/memory.md', 'old memory\n');
      write(wsA, 'projects/backend/brain/index.md', '# old index\n');
      git(wsA, 'add', '-f', '--', 'projects/backend/memory.md', 'projects/backend/brain/index.md');
      git(wsA, 'commit', '-q', '-m', 'legacy');
      git(wsA, 'push', '-q', 'origin', 'HEAD:main');
      git(wsA, 'fetch', '-q', 'origin');
      write(wsA, 'projects/backend/memory.md', 'my memory, changed\n');

      const result = sync(flowA);
      expect(result).toMatchObject({ state: 'synced', pushed: true });
      const tree = git(bare, 'ls-tree', '-r', '--name-only', 'main');
      expect(tree).not.toContain('projects/backend/memory.md');
      expect(tree).not.toContain('projects/backend/brain/index.md');
      // Still on this machine, as it was.
      expect(read(wsA, 'projects/backend/memory.md')).toBe('my memory, changed\n');
      expect(git(wsA, 'ls-files', '--', 'projects/backend/memory.md').trim()).toBe('');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'publishes an archived rounds record only as its summary, keeping the full one on this machine (review fix 7)',
    () => {
      const line = JSON.stringify({ type: 'phase_result', summary: 'done\n```\nconst secret = 1;\n```', reason: 'const leaked = 2;' });
      write(wsA, 'projects/backend/archive/rounds_plan_x_v1.jsonl', `${line}\n`);
      expect(sync(flowA)).toMatchObject({ state: 'synced', pushed: true });
      const published = git(bare, 'show', 'main:projects/backend/archive/rounds_plan_x_v1.jsonl');
      expect(published).not.toContain('secret');
      expect(published).not.toContain('leaked');
      expect(read(wsA, 'projects/backend/.evidence/rounds/rounds_plan_x_v1.jsonl')).toBe(`${line}\n`);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'unites an append-only store against its base: a line removed on one side stays removed (review fix 8)',
    () => {
      const store = 'projects/backend/brain/.structure/annotations.jsonl';
      write(wsA, store, '{"a":0}\n{"a":"gone"}\n');
      sync(flowA);
      sync(flowB);
      writeFileSync(join(wsB, '.git', 'info', 'attributes'), '*.jsonl -merge\n');
      write(wsA, store, '{"a":0}\n{"a":"gone"}\n{"a":1}\n');
      sync(flowA);
      write(wsB, store, '{"a":0}\n{"a":2}\n');
      const result = sync(flowB);
      expect(result).toMatchObject({ state: 'synced', pushed: true });
      expect(read(wsB, store).trim().split('\n').sort()).toEqual(['{"a":0}', '{"a":1}', '{"a":2}']);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'renumbers two collisions at once and rewrites every cross-reference among them (review fix 9)',
    () => {
      write(wsA, 'projects/backend/discovery/discovery_x_v1.md', '# X — A\n');
      write(wsA, 'projects/backend/brainstorms/brainstorm_y_v1.md', '# Y — A\n');
      sync(flowA);
      write(wsB, 'projects/backend/discovery/discovery_x_v1.md', '# X — B\nFrom brainstorm_y_v1.\n');
      write(wsB, 'projects/backend/brainstorms/brainstorm_y_v1.md', '# Y — B\nLeads to discovery_x_v1.\n');
      write(wsB, 'projects/backend/plans/plan_q_v1.md', 'discovery_x_v1 and brainstorm_y_v1\n');
      const result = sync(flowB);
      expect(result).toMatchObject({ state: 'synced', pushed: true });
      expect(read(wsB, 'projects/backend/discovery/discovery_x_v2.md')).toBe('# X — B\nFrom brainstorm_y_v2.\n');
      expect(read(wsB, 'projects/backend/brainstorms/brainstorm_y_v2.md')).toBe('# Y — B\nLeads to discovery_x_v2.\n');
      expect(read(wsB, 'projects/backend/plans/plan_q_v1.md')).toBe('discovery_x_v2 and brainstorm_y_v2\n');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'decides by item id, and refuses a stale id once the content it was about has changed (review fix 10)',
    () => {
      const decision = 'projects/backend/brain/decisions/db.md';
      write(wsA, decision, '# DB\n\nBase.\n');
      sync(flowA);
      sync(flowB);
      write(wsA, decision, '# DB\n\nA.\n');
      sync(flowA);
      write(wsB, decision, '# DB\n\nB.\n');
      const asked = sync(flowB);
      expect(asked.state).toBe('ask');
      const id = asked.asks[0].id;

      refusalOf(() => sync(flowB, { resolve: { id: 'deadbeef0000', take: 'theirs' } }), 'stale-decision');
      refusalOf(() => sync(flowB, { resolve: { path: decision, id: 'deadbeef0000', take: 'theirs' } }), 'stale-decision');

      // The Workspace's side changes again: the id the card holds is stale.
      write(wsA, decision, '# DB\n\nA, revised.\n');
      sync(flowA);
      const fetched = sync(flowB);
      expect(fetched.asks[0].id).not.toBe(id);
      const stale = refusalOf(() => sync(flowB, { resolve: { path: decision, id, take: 'theirs' } }), 'stale-decision');
      expect(stale.payload).toMatchObject({ path: decision, id, current: fetched.asks[0].id });
      expect(read(wsB, decision)).toBe('# DB\n\nB.\n');

      const resolved = sync(flowB, { resolve: { id: fetched.asks[0].id, take: 'theirs' } });
      expect(resolved).toMatchObject({ state: 'synced', pushed: true, decided: [fetched.asks[0].id] });
      expect(read(wsB, decision)).toBe('# DB\n\nA, revised.\n');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'never hard-resets a tree someone edited while the merge was being undone (review fix 11)',
    () => {
      const decision = 'projects/backend/brain/decisions/cache.md';
      write(wsA, decision, '# Cache\n');
      write(wsB, 'projects/backend/resources/notes.md', 'base\n');
      sync(flowB);
      sync(flowA);
      write(wsA, decision, '# Cache\n\nA.\n');
      sync(flowA);
      sync(flowB);
      write(wsA, decision, '# Cache\n\nA again.\n');
      sync(flowA);
      write(wsB, decision, '# Cache\n\nB.\n');
      failWith = (args) => {
        if (args.includes('merge') && args.includes('--abort')) write(wsB, 'projects/backend/resources/notes.md', 'edited during the sync\n');
        return null;
      };
      const asked = sync(flowB);
      expect(asked.state).toBe('ask');
      expect(read(wsB, 'projects/backend/resources/notes.md')).toBe('edited during the sync\n');
      expect(calls.some((args) => args.includes('--hard'))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses when the remote history was rewritten — nothing merged, nothing pushed, and it stays refused (review fix 12)',
    () => {
      write(wsA, 'projects/backend/plans/plan_r_v1.md', '# R\n');
      sync(flowA);
      sync(flowB);
      rawPush('rewrite', (dir) => write(dir, 'projects/backend/plans/plan_r_v1.md', '# R, rewritten\n'), { amend: true });
      write(wsB, 'projects/backend/plans/plan_b_v1.md', '# B\n');
      const before = head(wsB);
      const tracking = git(wsB, 'rev-parse', 'refs/remotes/origin/main').trim();
      const refsBefore = remoteRefs();
      const refusal = refusalOf(() => sync(flowB), 'remote-rewritten');
      expect(refusal.sentence).toMatch(/rewritten/);
      expect(git(wsB, 'rev-parse', 'HEAD~1').trim()).toBe(before);
      expect(read(wsB, 'projects/backend/plans/plan_r_v1.md')).toBe('# R\n');
      expect(git(wsB, 'rev-parse', 'refs/remotes/origin/main').trim()).toBe(tracking);
      expect(remoteRefs()).toBe(refsBefore);
      refusalOf(() => sync(flowB), 'remote-rewritten');
    },
    TEST_TIMEOUT_MS
  );

  it(
    "mirrors team rules beside a person's own rules, removes only what Flow copied, and never writes through a link (review fix 13)",
    () => {
      const checkout = join(sandbox, 'code', 'backend');
      write(checkout, '.claude/rules/mine.md', '# my own rule\n');
      write(wsB, 'projects/backend/rules/team.md', '# Team rule\n');
      sync(flowB);
      expect(sync(flowA).rules.copied).toEqual(['backend']);
      expect(read(checkout, '.claude/rules/team.md')).toBe('# Team rule\n');
      expect(read(checkout, '.claude/rules/mine.md')).toBe('# my own rule\n');

      rmSync(join(wsB, 'projects/backend/rules/team.md'));
      write(wsB, 'projects/backend/rules/next.md', '# Next\n');
      sync(flowB);
      sync(flowA);
      expect(readdirSync(join(checkout, '.claude', 'rules')).sort()).toEqual(['mine.md', 'next.md']);

      // A symlink in the source is not copied — and never published (it stays on this machine).
      symlinkSync('/etc/hosts', join(wsA, 'projects/backend/rules/hosts.md'));
      write(wsB, 'projects/backend/rules/third.md', '# Third\n');
      sync(flowB);
      expect(sync(flowA).untracked).toEqual(['projects/backend/rules/hosts.md']);
      expect(existsSync(join(checkout, '.claude', 'rules', 'hosts.md'))).toBe(false);
      expect(read(checkout, '.claude/rules/third.md')).toBe('# Third\n');
      expect(git(bare, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('hosts.md');
      rmSync(join(wsA, 'projects/backend/rules/hosts.md'));

      // `.claude/rules` is a link: refused, nothing written through it.
      const elsewhere = join(sandbox, 'elsewhere-rules');
      mkdirSync(elsewhere, { recursive: true });
      rmSync(join(checkout, '.claude', 'rules'), { recursive: true, force: true });
      symlinkSync(elsewhere, join(checkout, '.claude', 'rules'));
      write(wsB, 'projects/backend/rules/fourth.md', '# Fourth\n');
      sync(flowB);
      expect(sync(flowA).rules.skipped).toEqual([{ project: 'backend', reason: 'rules-folder-is-a-link' }]);
      expect(readdirSync(elsewhere)).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'reports a push the remote rejected (a hook, a protected branch) as no-access, and does not retry it (review fix 14)',
    () => {
      failWith = (args) =>
        args.includes('push')
          ? gitFailure(' ! [remote rejected] HEAD -> main (pre-receive hook declined)\nerror: failed to push some refs to \'https://git.example.test/team/ws.git\'\n')
          : null;
      write(wsA, 'projects/backend/plans/plan_hook_v1.md', '# hook\n');
      const result = sync(flowA);
      expect(result).toMatchObject({ state: 'no-access', pushed: false });
      expect(calls.filter((args) => args.includes('push'))).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'sync --all carries on past a Workspace that fails outright (review fix 14)',
    () => {
      createWorkspace({ flowFolder: flowA, name: 'Alpha' });
      const alpha = join(flowA, 'workspaces', 'alpha');
      write(alpha, 'notes.md', '# alpha\n');
      write(wsA, 'projects/backend/plans/plan_all_v1.md', '# all\n');
      failWith = (args) => (args[0] === 'add' && currentCwd === realpathSync(alpha) ? new Error('disk full') : null);
      const all = syncAllWorkspaces({ flowFolder: flowA, push: true, deps: { git: cwdTrackingGit, now: () => NOW } });
      expect(all.results).toEqual([
        expect.objectContaining({ workspace: { slug: 'alpha' }, refused: 'failed', detail: expect.stringContaining('disk full') }),
        expect.objectContaining({ workspace: expect.objectContaining({ slug: 'team' }), state: 'synced' }),
      ]);
    },
    TEST_TIMEOUT_MS
  );

  // ── Moving the Flow folder ──

  it(
    'refuses to move without an explicit go-ahead, because nothing persists the new location (review fix 3)',
    () => {
      const target = join(sandbox, 'moved-unconfirmed');
      const refusal = refusalOf(() => moveFlowFolder({ flowFolder: flowA, to: target }), 'move-not-persisted');
      expect(refusal.payload).toMatchObject({ needs: { env: 'PLAN_FLOW_HOME', value: target }, flag: 'confirm' });
      expect(refusal.sentence).toMatch(/PLAN_FLOW_HOME/);
      expect(existsSync(join(flowA, 'workspaces', 'team', 'workspace.json'))).toBe(true);
      expect(existsSync(target)).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses a move into the Flow folder reached through a symlinked ancestor (review fix 14)',
    () => {
      const alias = join(sandbox, 'alias-of-a');
      symlinkSync(flowA, alias);
      refusalOf(() => moveFlowFolder({ flowFolder: flowA, to: join(alias, 'new', 'home'), confirm: true }), 'target-inside');
      expect(existsSync(join(flowA, 'workspaces', 'team', 'workspace.json'))).toBe(true);
      expect(existsSync(join(flowA, 'new'))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "moves the Workspaces to another folder, re-points every checkout's flow link, leaves the vault, and refuses before moving anything",
    () => {
      const checkout = join(sandbox, 'code', 'backend');
      write(flowA, 'brain/projects/x/notes.md', 'the vault stays\n');
      write(join(sandbox, 'occupied'), 'something.txt', 'x\n');

      // Refusals first — and nothing moved by any of them.
      expect(() => moveFlowFolder({ flowFolder: flowA, to: join(sandbox, 'occupied'), confirm: true })).toThrow(/already has something/);
      expect(() => moveFlowFolder({ flowFolder: flowA, to: join(flowA, 'inner'), confirm: true })).toThrow(/into itself/);
      expect(() => moveFlowFolder({ flowFolder: flowA, to: flowA, confirm: true })).toThrow(/already where/);
      writeFileSync(join(wsA, '.git', 'plan-flow-sync.lock'), `${process.ppid}\n`);
      expect(() => moveFlowFolder({ flowFolder: flowA, to: join(sandbox, 'moved'), confirm: true })).toThrow(/being synced/);
      rmSync(join(wsA, '.git', 'plan-flow-sync.lock'));
      expect(existsSync(join(flowA, 'workspaces', 'team', 'workspace.json'))).toBe(true);
      expect(existsSync(join(sandbox, 'moved'))).toBe(false);

      // A second checkout whose flow is a plain folder: left as it is.
      const other = join(sandbox, 'code', 'other');
      mkdirSync(join(other, 'flow'), { recursive: true });
      const localMap = JSON.parse(readFileSync(join(flowA, 'projects.local.json'), 'utf-8')) as { projects: Record<string, string> };
      writeFileSync(join(flowA, 'projects.local.json'), JSON.stringify({ projects: { ...localMap.projects, 'local:other': other } }));

      const target = join(sandbox, 'elsewhere', 'flow-home');
      const moved = moveFlowFolder({ flowFolder: flowA, to: target, confirm: true });
      expect(moved).toMatchObject({
        action: 'move-flow-folder',
        moved: ['workspaces', 'projects.local.json'],
        relinked: [{ project: 'github.com/acme/backend', checkout, link: join(target, 'workspaces', 'team', 'projects', 'backend') }],
        untouched: [{ project: 'local:other', checkout: other, reason: 'not-a-link' }],
        failed: [],
        needs: { env: 'PLAN_FLOW_HOME', value: target },
      });
      expect(moved.left).toContain('brain');
      expect(read(flowA, 'brain/projects/x/notes.md')).toBe('the vault stays\n');
      expect(existsSync(join(flowA, 'workspaces'))).toBe(false);
      expect(lstatSync(join(checkout, 'flow')).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(checkout, 'flow'))).toBe(join(target, 'workspaces', 'team', 'projects', 'backend'));
      expect(lstatSync(join(other, 'flow')).isDirectory()).toBe(true);

      // The moved Workspace still syncs from its new home, through the re-pointed link.
      write(checkout, 'flow/plans/plan_moved_v1.md', '# after the move\n');
      expect(syncWorkspace({ flowFolder: target, push: true, workspace: 'team', deps: { git: recordingGit, now: () => NOW } })).toMatchObject({
        state: 'synced',
        pushed: true,
      });
      expect(git(bare, 'show', 'main:projects/backend/plans/plan_moved_v1.md')).toBe('# after the move\n');
      // Nothing left to move from the old folder.
      expect(() => moveFlowFolder({ flowFolder: flowA, to: join(sandbox, 'again'), confirm: true })).toThrow(/no Workspaces/);
    },
    TEST_TIMEOUT_MS
  );
});
