/**
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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

describeWithGit('workspace sync CLI — real CLI, real git, two machines', () => {
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
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-sync-cli-')));
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

  it(
    'syncs through the verb, asks on a decision collision, applies a --resolve, and lets go of a personal file',
    () => {
      const bare = join(sandbox, 'remotes', 'team', 'ws.git');
      const refs = (): string => git(bare, 'for-each-ref', '--format=%(refname) %(objectname)');

      expect(workspace(machineA, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      const wsA = join(machineA, 'workspaces', 'team');
      const decision = 'projects/backend/brain/decisions/queue.md';
      write(wsA, decision, '# Queue\n\nSQS.\n');

      const first = workspace(machineA, 'sync', '--workspace', 'team', '--json');
      expect(first.status).toBe(0);
      expect(first.json).toMatchObject({ action: 'sync', state: 'synced', pushed: true, committed: { files: 1 } });

      expect(workspace(machineB, 'join', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      const wsB = join(machineB, 'workspaces', 'team');
      expect(readFileSync(join(wsB, decision), 'utf-8')).toBe('# Queue\n\nSQS.\n');

      // --no-push: committed and merged, never published.
      write(wsA, decision, '# Queue\n\nSQS, FIFO.\n');
      const local = workspace(machineA, 'sync', '--workspace', 'team', '--no-push', '--json');
      expect(local.json).toMatchObject({ state: 'synced', pushed: false, ahead: 1 });
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ pushed: true, ahead: 0 });

      // The same decision changed on B: an ask (exit 0, a result), nothing pushed.
      write(wsB, decision, '# Queue\n\nKafka.\n');
      const before = refs();
      const asked = workspace(machineB, 'sync', '--workspace', 'team', '--json');
      expect(asked.status).toBe(0);
      expect(asked.json).toMatchObject({
        state: 'ask',
        pushed: false,
        asks: [{ kind: 'decision', path: decision, existing: '# Queue\n\nSQS, FIFO.\n', incoming: '# Queue\n\nKafka.\n' }],
      });
      expect(refs()).toBe(before);

      // --resolve without --take is refused before anything runs.
      const half = workspace(machineB, 'sync', '--workspace', 'team', '--resolve', decision, '--json');
      expect(half.status).toBe(1);
      expect(half.combined).toContain('workspace refused: sync --resolve <path> needs --take');

      // --id names the exact item (review fix 10): a stale one is refused, the shown one applies.
      const stale = workspace(machineB, 'sync', '--workspace', 'team', '--id', 'deadbeef0000', '--take', 'theirs', '--json');
      expect(stale.status).toBe(1);
      expect(stale.json).toMatchObject({ refused: 'stale-decision', id: 'deadbeef0000' });
      const askId = (asked.json as { asks: { id: string }[] }).asks[0].id;
      const resolved = workspace(machineB, 'sync', '--workspace', 'team', '--resolve', decision, '--id', askId, '--take', 'theirs', '--json');
      expect(resolved.status).toBe(0);
      expect(resolved.json).toMatchObject({ state: 'synced', pushed: true });
      expect(readFileSync(join(wsB, decision), 'utf-8')).toBe('# Queue\n\nSQS, FIFO.\n');

      // A personal file forced into the index: let go of (kept on disk), never sent (user, 2026-11-24).
      write(wsB, 'projects/backend/memory.md', 'mine\n');
      git(wsB, 'add', '-f', '--', 'projects/backend/memory.md');
      const synced = workspace(machineB, 'sync', '--workspace', 'team', '--json');
      expect(synced.status).toBe(0);
      expect(synced.combined).not.toContain('personal-files');
      expect(synced.json).toMatchObject({ action: 'sync', untracked: ['projects/backend/memory.md'] });
      expect(git(wsB, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('memory.md');
      expect(readFileSync(join(wsB, 'projects/backend/memory.md'), 'utf-8')).toBe('mine\n');

      // --all reports each Workspace the same way.
      git(wsB, 'add', '-f', '--', 'projects/backend/memory.md');
      const all = workspace(machineB, 'sync', '--all', '--json');
      expect(all.status).toBe(0);
      expect(JSON.stringify(all.json)).not.toContain('personal-files');
    },
    SUITE_TIMEOUT_MS
  );
  it(
    'a Workspace with no shared repository syncs over an old commit that held a personal file (user report 2026-11-24)',
    () => {
      expect(workspace(machineA, 'create', '--name', 'Solo', '--json').status).toBe(0);
      const ws = join(machineA, 'workspaces', 'solo');
      // Committed long ago, before the file was classified personal.
      write(ws, 'projects/backend/brain/.structure/qa.jsonl', '{"q":"old"}\n');
      git(ws, 'add', '-f', '--', 'projects/backend/brain/.structure/qa.jsonl');
      git(ws, 'commit', '-q', '-m', 'old');
      write(ws, 'projects/backend/plans/plan_new_v1.md', '# new\n');

      const synced = workspace(machineA, 'sync', '--workspace', 'solo', '--json');
      expect(synced.combined).not.toContain('personal-files');
      expect(synced.status).toBe(0);
      expect(synced.json).toMatchObject({ action: 'sync', state: 'local-only' });
      expect(git(ws, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('projects/backend/plans/plan_new_v1.md');
    },
    SUITE_TIMEOUT_MS
  );
  it(
    "ignores the Workspace-level qa.jsonl instead of refusing the sync over it (user report 2026-11-17)",
    () => {
      const bare = join(sandbox, 'remotes', 'team', 'ws.git');
      expect(workspace(machineA, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      const wsA = join(machineA, 'workspaces', 'team');
      // Ask the Blueprint at Workspace level writes the asker's own questions here.
      write(wsA, 'qa.jsonl', '{"q":"how do coworkers work?"}\n');
      write(wsA, 'projects/backend/brain/features/coworkers.md', '# Coworkers\n');

      const synced = workspace(machineA, 'sync', '--workspace', 'team', '--json');
      expect(synced.combined).not.toContain('personal-files');
      expect(synced.status).toBe(0);
      expect(synced.json).toMatchObject({ action: 'sync', state: 'synced', pushed: true });
      // The knowledge went out; the questions stayed on this machine.
      const published = git(bare, 'ls-tree', '-r', '--name-only', 'HEAD');
      expect(published).toContain('projects/backend/brain/features/coworkers.md');
      expect(published).not.toContain('qa.jsonl');
      expect(readFileSync(join(wsA, 'qa.jsonl'), 'utf-8')).toContain('coworkers');
    },
    SUITE_TIMEOUT_MS
  );
  it(
    'commits only with --commit-only (nothing fetched or pushed), and moves the Flow folder with move-flow-folder --to',
    () => {
      const bare = join(sandbox, 'remotes', 'team', 'ws.git');
      const refs = (): string => git(bare, 'for-each-ref', '--format=%(refname) %(objectname)');
      expect(workspace(machineA, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      const wsA = join(machineA, 'workspaces', 'team');
      write(wsA, 'projects/backend/plans/plan_a_v1.md', '# A\n');
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'synced', pushed: true });

      write(wsA, 'projects/backend/plans/plan_quit_v1.md', '# before closing\n');
      const before = refs();
      const quit = workspace(machineA, 'sync', '--workspace', 'team', '--commit-only', '--message=Flow: changes before closing', '--json');
      expect(quit.status).toBe(0);
      expect(quit.json).toMatchObject({ action: 'sync', mode: 'commit-only', state: 'committed', pushed: false, ahead: 1 });
      expect(refs()).toBe(before);
      const both = workspace(machineA, 'sync', '--workspace', 'team', '--commit-only', '--resolve', 'x.md', '--take', 'ours', '--json');
      expect(both.status).toBe(1);
      expect(both.combined).toContain('workspace refused: sync --commit-only commits and nothing else');

      const target = join(sandbox, 'moved', 'plan-flow');
      const unconfirmed = workspace(machineA, 'move-flow-folder', '--to', target, '--json');
      expect(unconfirmed.status).toBe(1);
      expect(unconfirmed.json).toMatchObject({ refused: 'move-not-persisted', needs: { env: 'PLAN_FLOW_HOME', value: target } });
      const moved = workspace(machineA, 'move-flow-folder', '--to', target, '--confirm', '--json');
      expect(moved.status).toBe(0);
      expect(moved.json).toMatchObject({ action: 'move-flow-folder', moved: ['workspaces'], needs: { env: 'PLAN_FLOW_HOME', value: target } });
      expect(workspace(target, 'sync', '--workspace', 'team', '--json').json).toMatchObject({ state: 'synced', pushed: true, ahead: 0 });

      const again = workspace(machineA, 'move-flow-folder', '--to', join(sandbox, 'again'), '--confirm', '--json');
      expect(again.status).toBe(1);
      expect(again.json).toMatchObject({ action: 'move-flow-folder', refused: 'nothing-to-move' });
      expect(again.combined).toContain('workspace refused: nothing-to-move');
    },
    SUITE_TIMEOUT_MS
  );
  it(
    'decides a batch with --decisions in one run, refuses a stale batch whole with nothing pushed, and holds and settles an item',
    () => {
      const bare = join(sandbox, 'remotes', 'team', 'ws.git');
      const refs = (): string => git(bare, 'for-each-ref', '--format=%(refname) %(objectname)');
      expect(workspace(machineA, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      const wsA = join(machineA, 'workspaces', 'team');
      const plans = ['projects/backend/plans/plan_x_v1.md', 'projects/backend/plans/plan_y_v1.md'];
      for (const plan of plans) write(wsA, plan, '# Base\n');
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').status).toBe(0);
      expect(workspace(machineB, 'join', '--remote', WORKSPACE_REMOTE, '--json').status).toBe(0);
      const wsB = join(machineB, 'workspaces', 'team');
      for (const plan of plans) write(wsA, plan, '# By A\n');
      expect(workspace(machineA, 'sync', '--workspace', 'team', '--json').status).toBe(0);
      for (const plan of plans) write(wsB, plan, '# By B\n');
      const shown = workspace(machineB, 'sync', '--workspace', 'team', '--json');
      expect(shown.json).toMatchObject({ state: 'review' });
      const reviews = (shown.json as { reviews: { id: string; path: string }[] }).reviews;
      const idOf = (path: string): string => reviews.find((review) => review.path === path)?.id as string;
      const file = (entries: unknown[]): string => {
        const path = join(sandbox, `decisions-${entries.length}-${Math.random().toString(16).slice(2)}.json`);
        writeFileSync(path, JSON.stringify({ decisions: entries }));
        return path;
      };

      // One stale id refuses the whole batch: a refusal line, its payload, and nothing published.
      const before = refs();
      const stale = workspace(
        machineB,
        'sync', '--workspace', 'team', '--json',
        '--decisions', file([{ id: idOf(plans[0]), take: 'ours' }, { id: 'deadbeef0000', take: 'theirs' }])
      );
      expect(stale.status).toBe(1);
      expect(stale.combined).toContain('workspace refused: stale-decision');
      expect(stale.json).toMatchObject({ refused: 'stale-decision', stale: ['deadbeef0000'] });
      expect(refs()).toBe(before);
      // --hold goes only with --decisions.
      const loneHold = workspace(machineB, 'sync', '--workspace', 'team', '--hold', idOf(plans[1]), '--json');
      expect(loneHold.status).toBe(1);
      expect(loneHold.combined).toContain('workspace refused: sync --hold <ids> goes with --decisions');
      expect(refs()).toBe(before);

      // A valid batch, one item held: one run, the held path published as the Workspace's version.
      const merged = workspace(
        machineB,
        'sync', '--workspace', 'team', '--json',
        '--decisions', file([{ id: idOf(plans[0]), take: 'ours' }, { id: idOf(plans[1]), take: 'file', content: '# Redo\n' }]),
        '--hold', idOf(plans[1])
      );
      expect(merged.status).toBe(0);
      expect(merged.json).toMatchObject({ state: 'synced', pushed: true, heldAside: [{ id: idOf(plans[1]), path: plans[1] }] });
      expect(git(bare, 'show', `refs/heads/main:${plans[0]}`)).toBe('# By B\n');
      expect(git(bare, 'show', `refs/heads/main:${plans[1]}`)).toBe('# By A\n');

      const settled = workspace(machineB, 'sync', '--workspace', 'team', '--settle-held', idOf(plans[1]), '--take', 'ours', '--json');
      expect(settled.status).toBe(0);
      expect(settled.json).toMatchObject({ state: 'synced', pushed: true, heldAside: [], settled: { path: plans[1], take: 'ours' } });
      expect(git(bare, 'show', `refs/heads/main:${plans[1]}`)).toBe('# Redo\n');
    },
    SUITE_TIMEOUT_MS
  );
});
