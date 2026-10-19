/**
 * `planflow-ai knowledge` — the REAL CLI, a REAL git, in a throwaway sandbox.
 *
 * This is the layer the app reaches: it spawns the verb and reads the LAST
 * parseable JSON line on stdout. So every refusal here asserts three things
 * (allowed-patterns #15 and #24): the `knowledge refused:` line on the combined
 * transcript, the payload as the last JSON line, and that NOTHING happened —
 * no `.git`, the symlink intact, the code repo's HEAD and tree unchanged.
 *
 * Isolation: the project, the vault (PLAN_FLOW_VAULT_DIR), a private git config
 * (GIT_CONFIG_GLOBAL, no system config) and Copilot's home all live under one
 * mkdtemp directory, handed to the child through an env this file builds. The
 * child's cwd is that sandbox — never this repository.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');
const { buildBrainRepoGitignore, buildGitignoreBlock } = await import('../handlers/shared.js');

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const E2E_TIMEOUT_MS = 120_000;
const GITHUB_URL = 'https://github.com/team/knowledge';
/** Mapped onto a local bare repo by `insteadOf`; nothing here reaches a network. */
const AZURE_URL = 'https://dev.azure.com/acme/Orbit/_git/knowledge';

const GIT_AVAILABLE = ((): boolean => {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
  } catch {
    return false;
  }
})();

const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

interface CliRun {
  /** allowed-pattern #15: this CLI's logger routes error() through console.log. */
  combined: string;
  status: number | null;
  /** The LAST parseable JSON line on stdout — exactly what the app reads. */
  json: Record<string, unknown> | null;
}

function lastJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
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
      else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

describeWithGit(
  GIT_AVAILABLE
    ? 'knowledge CLI E2E — real CLI, real git, isolated vault'
    : 'knowledge CLI E2E — skipped: git is not available in this environment',
  () => {
    let sandbox: string;
    let root: string;
    let vaultFlow: string;
    let bare: string;
    let env: NodeJS.ProcessEnv;

    function git(cwd: string, ...args: string[]): string {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      return result.stdout;
    }

    function run(...args: string[]): CliRun {
      return cli('knowledge', ...args);
    }

    function cli(command: string, ...args: string[]): CliRun {
      const result = spawnSync(process.execPath, [TSX_BIN, CLI_ENTRY, command, ...args, '--target', root], {
        encoding: 'utf-8',
        timeout: E2E_TIMEOUT_MS,
        cwd: sandbox,
        env,
      });
      if (result.error) throw result.error;
      const stdout = result.stdout ?? '';
      return { combined: `${stdout}\n${result.stderr ?? ''}`, status: result.status, json: lastJson(stdout) };
    }

    function seedFlow(flow: string): void {
      mkdirSync(join(flow, 'brain', 'features'), { recursive: true });
      writeFileSync(join(flow, 'brain', 'features', 'chats.md'), '# Chats\n');
      writeFileSync(join(flow, 'ledger.md'), '# Ledger\n');
    }

    function makeProject(shape: 'vault' | 'shared'): void {
      git(root, 'init', '-q', '-b', 'main');
      writeFileSync(join(root, 'app.ts'), 'export {}\n');
      writeFileSync(join(root, '.gitignore'), buildGitignoreBlock(['claude'], shape === 'shared' ? 'shared' : 'local') + '\n');
      if (shape === 'vault') {
        seedFlow(vaultFlow);
        symlinkSync(vaultFlow, join(root, 'flow'), 'dir');
      } else {
        seedFlow(join(root, 'flow'));
      }
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'init');
    }

    const head = (cwd: string): string => git(cwd, 'rev-parse', 'HEAD').trim();

    beforeEach(() => {
      sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-knowledge-cli-')));
      root = join(sandbox, 'proj');
      const vault = join(sandbox, 'vault');
      vaultFlow = join(vault, 'projects', 'proj', 'flow');
      mkdirSync(root, { recursive: true });
      bare = join(sandbox, 'remotes');
      mkdirSync(bare, { recursive: true });
      writeFileSync(
        join(sandbox, 'gitconfig'),
        `[user]\n\tname = Test Person\n\temail = test@example.com\n[url "${bare}/"]\n\tinsteadOf = https://dev.azure.com/acme/Orbit/_git/\n`
      );
      env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(sandbox, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        // Only local paths: an address the mapping misses fails here, it never dials out.
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_TERMINAL_PROMPT: '0',
        PLAN_FLOW_VAULT_DIR: vault,
        COPILOT_HOME: join(sandbox, 'copilot'),
      };
    });

    afterEach(() => {
      rmSync(sandbox, { recursive: true, force: true });
    });

    /** What a refusal must leave exactly as it was. */
    function frozen(): () => void {
      const headBefore = head(root);
      const tree = snapshotTree(root, ['.git']);
      const wasLink = lstatSync(join(root, 'flow')).isSymbolicLink();
      const vaultTree = existsSync(vaultFlow) ? snapshotTree(vaultFlow) : null;
      return () => {
        expect(head(root)).toBe(headBefore);
        expect(snapshotTree(root, ['.git'])).toEqual(tree);
        expect(lstatSync(join(root, 'flow')).isSymbolicLink()).toBe(wasLink);
        if (vaultTree !== null) expect(snapshotTree(vaultFlow)).toEqual(vaultTree);
        if (!wasLink) return;
        expect(existsSync(join(vaultFlow, '.git'))).toBe(false);
      };
    }

    /**
     * A project that kept its own knowledge repo — made through the HANDLER,
     * in process: the CLI verb that used to make it is retired. The env the
     * CLI children get is applied for the call and put back.
     */
    async function enableInProcess(remote: string): Promise<void> {
      const { enableKnowledgeSync } = await import('../handlers/knowledge-migration.js');
      const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ALLOW_PROTOCOL', 'GIT_TERMINAL_PROMPT', 'PLAN_FLOW_VAULT_DIR', 'COPILOT_HOME'];
      const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      for (const key of keys) process.env[key] = env[key];
      try {
        enableKnowledgeSync(root, { remote });
      } finally {
        for (const key of keys) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    }

    it(
      'enable and adopt are retired: the refusal line, the retired payload, and nothing changed',
      () => {
        makeProject('vault');
        const unchanged = frozen();

        const enable = run('enable', '--remote', GITHUB_URL, '--json');
        expect(enable.status).toBe(1);
        expect(enable.combined).toContain('knowledge refused: retired — knowledge now syncs through the Workspace');
        expect(enable.json).toMatchObject({ action: 'enable', refused: 'retired', retired: true, replacement: 'workspace' });
        expect(existsSync(join(root, 'flow', '.git'))).toBe(false);
        expect(existsSync(join(vaultFlow, '.git'))).toBe(false);
        unchanged();

        const adopt = run('adopt', '--json');
        expect(adopt.status).toBe(1);
        expect(adopt.json).toMatchObject({ action: 'adopt', refused: 'retired', retired: true });
        unchanged();
      },
      E2E_TIMEOUT_MS
    );

    it(
      'status still says where the knowledge is, and that per-project sync is retired',
      () => {
        makeProject('vault');
        expect(run('status', '--json').json).toMatchObject({ shape: 'vault', retired: true, hasRepo: false });
        const human = run('status');
        expect(human.status).toBe(0);
        expect(human.combined).toContain('knowledge: vault');
        expect(human.combined).toContain('per-project sync is retired');

        const unknown = run('frobnicate');
        expect(unknown.status).toBe(1);
        expect(unknown.combined).toContain("knowledge refused: unknown action 'frobnicate'");
      },
      E2E_TIMEOUT_MS
    );

    it(
      'share and /flow share= refuse to leave an old knowledge repo: the committed block and the pointer stay',
      async () => {
        makeProject('local');
        await enableInProcess(GITHUB_URL);
        git(root, 'add', '.gitignore');
        git(root, 'commit', '-q', '-m', 'turn sync on');
        const ignoreBefore = readFileSync(join(root, '.gitignore'), 'utf-8');
        const configBefore = readFileSync(join(root, 'flow', '.flowconfig'), 'utf-8');
        // Positive first: the pointer IS there to lose.
        expect(ignoreBefore).toContain(`# Brain repo: ${GITHUB_URL} main`);

        const share = cli('share', 'shared');
        expect(share.status).toBe(1);
        expect(share.combined).toContain('share refused: knowledge-repo —');

        const flow = cli('flow', 'set', 'share=local');
        expect(flow.status).toBe(1);
        expect(flow.combined).toContain('flow refused: knowledge-repo —');

        expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe(ignoreBefore);
        expect(readFileSync(join(root, 'flow', '.flowconfig'), 'utf-8')).toBe(configBefore);
        expect(git(root, 'status', '--porcelain')).toBe('');
        expect(run('status', '--json').json).toMatchObject({ shape: 'separate', pointer: { url: GITHUB_URL }, retired: true });
      },
      E2E_TIMEOUT_MS
    );

    it(
      'disable still unhooks an old knowledge repo: refuses unpushed work, then goes ahead with --accept-unpushed',
      async () => {
        makeProject('vault');
        await enableInProcess(GITHUB_URL);
        // Positive first: the repo disable has to unhook IS there.
        expect(existsSync(join(root, 'flow', '.git'))).toBe(true);
        const unchanged = frozen();

        const refused = run('disable', '--to', 'vault', '--json');
        expect(refused.status).toBe(1);
        expect(refused.combined).toContain('knowledge refused: unpushed —');
        expect(refused.json).toMatchObject({ action: 'disable', refused: 'unpushed', unpushed: 1, hasUpstream: false });
        expect(existsSync(join(root, 'flow', '.git'))).toBe(true);
        unchanged();

        const done = run('disable', '--to', 'vault', '--accept-unpushed', '--json');
        expect(done.status).toBe(0);
        expect(done.json).toMatchObject({ action: 'disable', to: 'vault', shape: 'vault', unpushed: 1 });
        expect(lstatSync(join(root, 'flow')).isSymbolicLink()).toBe(true);
        expect(existsSync(join(String(done.json?.knowledgeRepoKeptAt), 'HEAD'))).toBe(true);
      },
      E2E_TIMEOUT_MS
    );
  }
);
