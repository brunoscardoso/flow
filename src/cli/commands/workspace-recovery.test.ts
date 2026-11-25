/**
 * Getting a person OUT of a tangled Workspace setup (user report 2026-11-24),
 * through the REAL CLI. The teammate's own Default had been connected to the
 * team's repository by hand, so it could never sync ("a different history"),
 * joining refused ("this computer already has that Workspace"), the same
 * projects sat in two Workspaces, and deleting one refused ("already has this
 * project"). Each step below is one of those dead ends, now with a way out.
 *
 * `planflow-ai workspace sync` — the REAL CLI (from source, through tsx), a
 * REAL git, two "machines" in one throwaway sandbox. The layer the app's sync
 * engine and the heartbeat daemon reach: they spawn the verb and read the LAST
 * parseable JSON line on stdout.
 *
 * Isolation as in workspace.test.ts: each machine is its own Flow folder
 * (PLAN_FLOW_HOME), git reads a private config whose `insteadOf` maps
 * https://git.example.test/ onto a local bare repo, and only the `file`
 * transport is allowed (FLOW_E2E=1 + FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS=file).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const CLI_TIMEOUT_MS = 120_000;
const SUITE_TIMEOUT_MS = 240_000;
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

describeWithGit('workspace recovery — real CLI, real git, two machines', () => {
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

  function write(root: string, path: string, text: string): void {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-recovery-')));
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
      GIT_TERMINAL_PROMPT: '0',
      FLOW_E2E: '1',
      FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS: 'file',
      COPILOT_HOME: join(sandbox, 'copilot'),
      PLANFLOW_NO_BACKGROUND_WORK: '1',
    };
    git(join(sandbox, 'remotes', 'team'), 'init', '-q', '--bare', 'ws.git');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });


  function makeRepo(path: string, origin: string): string {
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    writeFileSync(join(path, 'app.ts'), 'export {}\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'init');
    git(path, 'remote', 'add', 'origin', origin);
    return path;
  }

  const projectsOf = (flowFolder: string, slug: string): string[] =>
    (JSON.parse(readFileSync(join(flowFolder, 'workspaces', slug, 'workspace.json'), 'utf-8')) as { projects: { slug: string }[] }).projects.map((p) => p.slug);

  it(
    'joins over a Workspace that only pointed at the team repository, and hands its projects to the team copy',
    () => {
      // ── The team: machine A shares a Workspace with one project in it ──────
      expect(workspace(machineA, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      const appA = makeRepo(join(sandbox, 'machine-a', 'code', 'app'), 'https://git.example.test/team/app.git');
      expect(workspace(machineA, 'link', '--target', appA, '--workspace', 'team', '--json').status).toBe(0);
      write(join(machineA, 'workspaces', 'team'), 'projects/app/brain/decisions/queue.md', '# Queue\n\nThe team says SQS.\n');
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'synced', pushed: true });

      // ── The teammate: their own Workspace has the same project … ──────────
      expect(workspace(machineB, 'create', '--name', 'My Mac', '--json').status).toBe(0);
      const appB = makeRepo(join(sandbox, 'machine-b', 'code', 'app'), 'https://git.example.test/team/app.git');
      expect(workspace(machineB, 'link', '--target', appB, '--workspace', 'my-mac', '--json').status).toBe(0);
      const mine = join(machineB, 'workspaces', 'my-mac');
      write(mine, 'projects/app/brain/decisions/queue.md', '# Queue\n\nMy older note.\n');
      write(mine, 'projects/app/discovery/discovery_mine_v1.md', '# Only mine\n');
      // … and was connected to the team's repository by hand.
      expect(workspace(machineB, 'set-remote', '--workspace', 'my-mac', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);

      // ── Joining is no longer refused "already has that Workspace" ─────────
      const joined = workspace(machineB, 'join', '--remote', WORKSPACE_REMOTE, '--json');
      expect(joined.combined).not.toContain('already-joined');
      expect(joined.status).toBe(0);
      expect(joined.json).toMatchObject({ action: 'join', workspace: { slug: 'team' }, disconnected: [{ slug: 'my-mac', remote: null }] });
      expect(git(mine, 'remote').trim()).toBe('');

      // The project moved over to the team's copy: one listing, the checkout
      // points there, the team's version won, and the teammate's own extra
      // discovery came along. Their copy is kept as a backup.
      expect(projectsOf(machineB, 'my-mac')).toEqual([]);
      expect(projectsOf(machineB, 'team')).toEqual(['app']);
      const teamApp = join(machineB, 'workspaces', 'team', 'projects', 'app');
      expect(realpathSync(join(appB, 'flow'))).toBe(realpathSync(teamApp));
      expect(readFileSync(join(teamApp, 'brain/decisions/queue.md'), 'utf-8')).toBe('# Queue\n\nThe team says SQS.\n');
      expect(readFileSync(join(teamApp, 'discovery/discovery_mine_v1.md'), 'utf-8')).toBe('# Only mine\n');
      const backups = readdirSync(join(machineB, 'workspaces')).filter((name) => name.startsWith('.removed-my-mac-app-'));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(machineB, 'workspaces', backups[0], 'brain/decisions/queue.md'), 'utf-8')).toBe('# Queue\n\nMy older note.\n');

      // And both Workspaces sync again.
      expect(workspace(machineB, 'sync', '--workspace', 'my-mac', '--json').json).toMatchObject({ state: 'local-only' });
      expect(workspace(machineB, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'synced' });

      // A real second join is still refused: that one truly is the same Workspace.
      expect(workspace(machineB, 'join', '--remote', WORKSPACE_REMOTE, '--json').combined).toContain('already-joined');
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'removes a project from a Workspace, refuses the only copy a checkout uses, and deletes over a duplicate',
    () => {
      expect(workspace(machineA, 'create', '--name', 'Home', '--json').status).toBe(0);
      expect(workspace(machineA, 'set-default', '--workspace', 'home', '--json').status).toBe(0);
      expect(workspace(machineA, 'create', '--name', 'Side', '--json').status).toBe(0);
      const app = makeRepo(join(sandbox, 'machine-a', 'code', 'app'), 'https://git.example.test/team/app.git');
      expect(workspace(machineA, 'link', '--target', app, '--workspace', 'side', '--json').status).toBe(0);
      const side = join(machineA, 'workspaces', 'side');
      const home = join(machineA, 'workspaces', 'home');

      // The only copy, and the checkout uses it: refused, nothing changed.
      const sole = workspace(machineA, 'remove-project', '--workspace', 'side', '--project', 'app', '--confirm', '--json');
      expect(sole.status).toBe(1);
      expect(sole.json).toMatchObject({ refused: 'sole-copy' });
      expect(projectsOf(machineA, 'side')).toEqual(['app']);

      // The same project listed in Home too (as a join or an old move left it).
      const homeFile = join(home, 'workspace.json');
      const homeJson = JSON.parse(readFileSync(homeFile, 'utf-8')) as { projects: unknown[] };
      const sideJson = JSON.parse(readFileSync(join(side, 'workspace.json'), 'utf-8')) as { projects: unknown[] };
      homeJson.projects = sideJson.projects;
      writeFileSync(homeFile, JSON.stringify(homeJson, null, 2));
      write(home, 'projects/app/brain/decisions/a.md', '# Home keeps this\n');
      write(side, 'projects/app/brain/decisions/a.md', '# Side differs\n');
      write(side, 'projects/app/plans/plan_side_v1.md', '# Only in Side\n');

      // Deleting Side no longer refuses: Home's copy stays and gains what only Side had.
      const asked = workspace(machineA, 'delete', '--workspace', 'side', '--json');
      expect(asked.json).toMatchObject({ refused: 'unconfirmed' });
      const deleted = workspace(machineA, 'delete', '--workspace', 'side', '--confirm', '--json');
      expect(deleted.combined).not.toContain('project-exists');
      expect(deleted.status).toBe(0);
      expect(deleted.json).toMatchObject({ action: 'delete', merged: [{ name: 'app' }] });
      expect(projectsOf(machineA, 'home')).toEqual(['app']);
      expect(readFileSync(join(home, 'projects/app/brain/decisions/a.md'), 'utf-8')).toBe('# Home keeps this\n');
      expect(readFileSync(join(home, 'projects/app/plans/plan_side_v1.md'), 'utf-8')).toBe('# Only in Side\n');
      expect(realpathSync(join(app, 'flow'))).toBe(realpathSync(join(home, 'projects', 'app')));
      expect(existsSync(side)).toBe(false);

      // A project with no checkout here can be removed; it asks first.
      expect(workspace(machineA, 'create', '--name', 'Extra', '--json').status).toBe(0);
      const extraFile = join(machineA, 'workspaces', 'extra', 'workspace.json');
      const extraJson = JSON.parse(readFileSync(extraFile, 'utf-8')) as { projects: unknown[] };
      extraJson.projects = [{ id: 'git.example.test/team/gone', name: 'gone', slug: 'gone', remotes: [] }];
      writeFileSync(extraFile, JSON.stringify(extraJson, null, 2));
      write(join(machineA, 'workspaces', 'extra'), 'projects/gone/brain/index.md', '# gone\n');
      const ask = workspace(machineA, 'remove-project', '--workspace', 'extra', '--project', 'gone', '--json');
      expect(ask.json).toMatchObject({ refused: 'unconfirmed', needs: 'confirm', keptIn: null, shared: false });
      const removed = workspace(machineA, 'remove-project', '--workspace', 'extra', '--project', 'gone', '--confirm', '--json');
      expect(removed.status).toBe(0);
      expect(projectsOf(machineA, 'extra')).toEqual([]);
      expect(existsSync(join(machineA, 'workspaces', 'extra', 'projects', 'gone'))).toBe(false);
      expect(readdirSync(join(machineA, 'workspaces')).some((name) => name.startsWith('.removed-extra-gone-'))).toBe(true);
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'each machine calls the shared Workspace by its own name, and both keep syncing',
    () => {
      expect(workspace(machineA, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      const appA = makeRepo(join(sandbox, 'machine-a', 'code', 'app'), 'https://git.example.test/team/app.git');
      expect(workspace(machineA, 'link', '--target', appA, '--workspace', 'team', '--json').status).toBe(0);
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'synced', pushed: true });
      expect(workspace(machineB, 'join', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);

      // A calls it A, B calls it B.
      expect(workspace(machineA, 'rename', '--workspace', 'team', '--name', 'A', '--json').json).toMatchObject({
        changed: true,
        workspace: { name: 'A', sharedName: 'Team' },
      });
      expect(workspace(machineB, 'rename', '--workspace', 'team', '--name', 'B', '--json').json).toMatchObject({
        workspace: { name: 'B', sharedName: 'Team' },
      });

      // Knowledge still flows both ways, and nothing stops for a person.
      write(join(machineA, 'workspaces', 'team'), 'projects/app/brain/decisions/queue.md', '# Queue\n\nSQS.\n');
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'synced' });
      expect(workspace(machineB, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'synced' });
      expect(readFileSync(join(machineB, 'workspaces', 'team', 'projects/app/brain/decisions/queue.md'), 'utf-8')).toBe('# Queue\n\nSQS.\n');
      expect(String(workspace(machineA, 'sync', '--workspace', 'team', '--json').json?.['state'])).toMatch(/^(synced|nothing-to-do)$/);

      // Each still sees its own name; the shared file never changed.
      const nameOn = (flowFolder: string): unknown =>
        (workspace(flowFolder, 'status', '--json').json as { workspaces: { slug: string; name: string }[] }).workspaces.find((w) => w.slug === 'team')?.name;
      expect(nameOn(machineA)).toBe('A');
      expect(nameOn(machineB)).toBe('B');
      for (const machine of [machineA, machineB]) {
        expect((JSON.parse(readFileSync(join(machine, 'workspaces', 'team', 'workspace.json'), 'utf-8')) as { name: string }).name).toBe('Team');
      }
      // Naming it the shared name again forgets the local one.
      expect(workspace(machineA, 'rename', '--workspace', 'team', '--name', 'Team', '--json').json).toMatchObject({ workspace: { name: 'Team' } });
      expect(readFileSync(join(machineA, 'settings', 'workspaces.local.json'), 'utf-8')).not.toContain('"A"');
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'combines two Workspaces set up on their own for the same projects, instead of refusing',
    () => {
      expect(workspace(machineA, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      const appA = makeRepo(join(sandbox, 'machine-a', 'code', 'app'), 'https://git.example.test/team/app.git');
      expect(workspace(machineA, 'link', '--target', appA, '--workspace', 'team', '--json').status).toBe(0);
      const team = join(machineA, 'workspaces', 'team');
      write(team, 'projects/app/brain/decisions/queue.md', '# Queue\n\nThe team says SQS.\n');
      write(team, 'projects/app/discovery/discovery_theirs_v1.md', '# Theirs\n');
      write(team, 'projects/app/brain/features/queue.md', '---\nname: Queue\nkind: core\n---\n\n# Queue\n\n- Messages go through SQS\n');
      write(team, 'projects/app/brain/.structure/basic-discovery.jsonl', '{"completedAt":"2026-11-20T10:00:00Z","learned":3,"failed":0}\n');
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'synced', pushed: true });
      // A chat working set the team's repository already holds (shared by an older Flow).
      const teamWorkingSet = 'projects/app/brain/features/aai-9-old-thread.md';
      write(team, teamWorkingSet, '---\nfeature: aai-9-old-thread\nthread_id: 0f0e\n---\n\n# AAI-9\n\nWorking set for "AAI-9" — 1 file(s): 1 edited, 0 read.\n');
      spawnSync('git', ['-C', team, 'add', '-f', '--', teamWorkingSet], { env });
      spawnSync('git', ['-C', team, '-c', 'user.email=a@example.test', '-c', 'user.name=A', 'commit', '-q', '-m', 'old working set'], { env });
      const teamBranch = spawnSync('git', ['-C', team, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', env }).stdout.trim();
      const pushedSet = spawnSync('git', ['-C', team, 'push', '-q', 'origin', `HEAD:refs/heads/${teamBranch}`], { encoding: 'utf8', env });
      expect(pushedSet.status).toBe(0);
      expect(spawnSync('git', ['-C', team, 'ls-tree', '--name-only', `origin/${teamBranch}`, '--', teamWorkingSet], { encoding: 'utf8', env }).stdout.trim()).toBe(teamWorkingSet);

      expect(workspace(machineB, 'create', '--name', 'My Mac', '--json').status).toBe(0);
      const appB = makeRepo(join(sandbox, 'machine-b', 'code', 'app'), 'https://git.example.test/team/app.git');
      expect(workspace(machineB, 'link', '--target', appB, '--workspace', 'my-mac', '--json').status).toBe(0);
      const mine = join(machineB, 'workspaces', 'my-mac');
      write(mine, 'projects/app/brain/decisions/queue.md', '# Queue\n\nI learned we use SQS with a DLQ.\n');
      write(mine, 'projects/app/discovery/discovery_mine_v1.md', '# Mine\n');
      write(mine, 'projects/app/brain/features/queue.md', '---\nname: Queue\nkind: core\n---\n\n# Queue\n\n- Failed messages go to a DLQ\n');
      write(mine, 'projects/app/brain/.structure/basic-discovery.jsonl', '{"completedAt":"2026-11-21T10:00:00Z","learned":2,"failed":0}\n');
      expect(workspace(machineB, 'set-remote', '--workspace', 'my-mac', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);

      const first = workspace(machineB, 'sync', '--workspace', 'my-mac', '--json');
      expect(first.combined).not.toContain('unrelated-history');
      expect(first.combined).not.toContain('no merge base');
      // The one note both wrote, differently, is the agent's to combine.
      expect(first.json).toMatchObject({ state: 'ask' });
      const asks = (first.json as { asks: { id: string; path: string; agentMergeable?: boolean }[] }).asks;
      expect(asks.map((ask) => ask.path).sort()).toEqual(['projects/app/brain/decisions/queue.md', 'projects/app/brain/features/queue.md']);
      expect(asks.every((ask) => ask.agentMergeable === true)).toBe(true);
      // Nothing else needs anyone: no review waiting (the generated README is the team's).
      expect((first.json as { reviews: unknown[] }).reviews).toEqual([]);

      // What the agent wrote is taken, and the combined Workspace is published.
      const combined = '# Queue\n\nThe team says SQS, with a DLQ for failures.\n';
      const agentText = join(sandbox, 'agent-merge.md');
      writeFileSync(agentText, combined);
      // The app answers every agent-mergeable item, one resolve each (intent-merge.ts).
      const feature = asks.find((ask) => ask.path.includes('/features/')) as { id: string; path: string };
      const decision = asks.find((ask) => ask.path.includes('/decisions/')) as { id: string; path: string };
      const featureText = join(sandbox, 'agent-feature.md');
      writeFileSync(featureText, '---\nname: Queue\nkind: core\n---\n\n# Queue\n\n- Messages go through SQS\n- Failed messages go to a DLQ\n');
      expect(
        workspace(machineB, 'sync', '--workspace', 'my-mac', `--resolve=${feature.path}`, `--id=${feature.id}`, `--take=file:${featureText}`, '--json').json,
      ).toMatchObject({ state: 'ask' });
      const settled = workspace(
        machineB, 'sync', '--workspace', 'my-mac', `--resolve=${decision.path}`, `--id=${decision.id}`, `--take=file:${agentText}`, '--json',
      );
      // Combining two Workspaces waits for a person (the positive: it IS merged here)…
      expect(settled.json).toMatchObject({ state: 'merged-local', awaitingReview: true, pushed: false });
      expect((settled.json as { mergedItems: { kind: string }[] }).mergedItems.map((item) => item.kind)).toContain('combine');
      expect(readFileSync(join(mine, 'projects/app/brain/decisions/queue.md'), 'utf-8')).toBe(combined);
      // …a later run does not share it on its own…
      expect(workspace(machineB, 'sync', '--workspace', 'my-mac', '--json').json).toMatchObject({ pushed: false });
      // …and the other computer's working set is not in the combined commit (kept on disk here, not tracked).
      const mergeSha = (settled.json as { merge: { sha: string } }).merge.sha;
      const inMerge = (path: string): string => spawnSync('git', ['-C', mine, 'ls-tree', '--name-only', mergeSha, '--', path], { encoding: 'utf8', env }).stdout.trim();
      expect(inMerge('projects/app/discovery/discovery_theirs_v1.md')).not.toBe('');
      expect(inMerge(teamWorkingSet)).toBe('');
      // A person agrees: now it is shared.
      expect(workspace(machineB, 'sync', '--workspace', 'my-mac', '--agreed', '--json').json).toMatchObject({ state: 'synced', pushed: true });
      expect(readFileSync(join(mine, 'projects/app/brain/decisions/queue.md'), 'utf-8')).toBe(combined);
      expect(readFileSync(join(mine, 'projects/app/discovery/discovery_theirs_v1.md'), 'utf-8')).toBe('# Theirs\n');
      expect(projectsOf(machineB, 'my-mac')).toEqual(['app']);
      // This machine still calls it My Mac; the team's file kept its name.
      expect((workspace(machineB, 'status', '--json').json as { workspaces: { slug: string; name: string }[] }).workspaces.find((w) => w.slug === 'my-mac')?.name).toBe('My Mac');

      // And machine A receives B's work on its next sync.
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'synced' });
      expect(readFileSync(join(team, 'projects/app/discovery/discovery_mine_v1.md'), 'utf-8')).toBe('# Mine\n');
      expect(readFileSync(join(team, 'projects/app/brain/decisions/queue.md'), 'utf-8')).toBe(combined);
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'still refuses a repository whose Workspace has no project in common',
    () => {
      expect(workspace(machineA, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      const appA = makeRepo(join(sandbox, 'machine-a', 'code', 'app'), 'https://git.example.test/team/app.git');
      expect(workspace(machineA, 'link', '--target', appA, '--workspace', 'team', '--json').status).toBe(0);
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'synced' });

      expect(workspace(machineB, 'create', '--name', 'Other', '--json').status).toBe(0);
      const other = makeRepo(join(sandbox, 'machine-b', 'code', 'other'), 'https://git.example.test/someone/other.git');
      expect(workspace(machineB, 'link', '--target', other, '--workspace', 'other', '--json').status).toBe(0);
      expect(workspace(machineB, 'set-remote', '--workspace', 'other', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      expect(workspace(machineB, 'sync', '--workspace', 'other', '--json').json).toMatchObject({ refused: 'unrelated-history', pushed: false });
      // Again, with the team's branch already fetched: the same plain answer, never git's.
      write(join(machineB, 'workspaces', 'other'), 'projects/other/brain/decisions/later.md', '# Later\n');
      const again = workspace(machineB, 'sync', '--workspace', 'other', '--json');
      expect(again.combined).not.toContain('no merge base');
      expect(again.json).toMatchObject({ refused: 'unrelated-history', pushed: false });
    },
    SUITE_TIMEOUT_MS
  );
});
