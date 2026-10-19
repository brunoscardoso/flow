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
    'syncs through the verb, asks on a decision collision, applies a --resolve, and refuses a personal file',
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

      // A personal file forced into the index: refused, payload first, nothing committed or pushed.
      write(wsB, 'projects/backend/memory.md', 'mine\n');
      git(wsB, 'add', '-f', '--', 'projects/backend/memory.md');
      const headBefore = git(wsB, 'rev-parse', 'HEAD');
      const pushedBefore = refs();
      const refused = workspace(machineB, 'sync', '--workspace', 'team', '--json');
      expect(refused.status).toBe(1);
      expect(refused.combined).toContain('workspace refused: personal-files');
      expect(refused.json).toMatchObject({ action: 'sync', refused: 'personal-files', paths: ['projects/backend/memory.md'] });
      expect(git(wsB, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(refs()).toBe(pushedBefore);

      // The refusal unstaged it again (the ignore file keeps it out of `add -A`).
      expect(git(wsB, 'diff', '--cached', '--name-only').trim()).toBe('');

      // --all reports each Workspace; the refusal is carried, not fatal.
      git(wsB, 'add', '-f', '--', 'projects/backend/memory.md');
      const all = workspace(machineB, 'sync', '--all', '--json');
      expect(all.status).toBe(0);
      expect(all.json).toMatchObject({ action: 'sync', all: true, results: [{ workspace: { slug: 'team' }, refused: 'personal-files' }] });
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
});
