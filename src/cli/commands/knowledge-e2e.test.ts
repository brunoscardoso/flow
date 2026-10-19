/**
 * `planflow-ai knowledge` × provisioning — the REAL BUILT CLI (`dist/cli/index.js`)
 * as a subprocess, a real git, an isolated vault.
 *
 * `knowledge.test.ts` drives the verb from source (tsx) and covers the vault
 * shape plus the refusals; `knowledge-migration-convert.test.ts` covers every
 * shape and the provisioning guard IN PROCESS. What neither does is put the
 * shipped artifact through the sequences the IDE really runs:
 *
 *   - `enable` / `adopt` refused as retired through the built bundle (the
 *     hard migration, decision 2026-10-06 — knowledge syncs through the
 *     Workspace), nothing written;
 *   - projects that already KEEP their own knowledge repo still exist on
 *     people's machines, so the provisioning guards stay pinned. Their repo is
 *     made in process through the handler (`enableKnowledgeSync`) — the verb
 *     that used to make it is retired;
 *   - R-1: a relaunch of provisioning (`init --claude --force --yes`, exactly
 *     what the IDE runs) leaves the nested knowledge repo untouched;
 *   - R-3: a fresh clone of the code repo, carrying the committed pointer,
 *     gets no vault link and no `flow/` from provisioning;
 *   - `disable --to keep`, then provisioning: the folder stays where it is;
 *   - a refusal through the bundle: the combined transcript AND nothing changed.
 *
 * Isolation: the project, the vault (PLAN_FLOW_VAULT_DIR), HOME, a private git
 * config and the background-work switch all live in an env this file builds
 * and hands to every child explicitly. Every child's cwd is the sandbox —
 * never this repository. Nothing here has a network remote: the knowledge
 * remote is a github.com URL the CLI only RECORDS (it never pushes), and
 * GIT_ALLOW_PROTOCOL=file refuses any transport that would reach it anyway.
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
const { buildGitignoreBlock } = await import('../handlers/shared.js');

const PACKAGE_ROOT = getPackageRoot();
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
const E2E_TIMEOUT_MS = 180_000;
const GITHUB_URL = 'https://github.com/team/knowledge';

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
  /** The LAST parseable JSON line on stdout — what the app reads. */
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

/** Every entry under `dir`, by content hash (links by target). */
function snapshotTree(dir: string, skip: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const rel = `${prefix}${entry}`;
      if (skip.some((path) => rel === path || rel.startsWith(`${path}/`))) continue;
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

describeWithGit('knowledge × provisioning E2E — the real built CLI', () => {
  let sandbox: string;
  let root: string;
  let vault: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`knowledge-e2e requires the built CLI at ${CLI_PATH} — run \`npm run build\` first`);
    }
  });

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-knowledge-e2e-')));
    root = join(sandbox, 'proj');
    vault = join(sandbox, 'vault');
    mkdirSync(root, { recursive: true });
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    writeFileSync(
      join(sandbox, 'gitconfig'),
      '[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n'
    );
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(sandbox, 'home'),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      GIT_CONFIG_GLOBAL: join(sandbox, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_TERMINAL_PROMPT: '0',
      PLAN_FLOW_VAULT_DIR: vault,
      COPILOT_HOME: join(sandbox, 'copilot'),
      PLANFLOW_NO_BACKGROUND_WORK: '1',
    };
  });

  afterEach(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
    } catch (error) {
      console.warn(`[knowledge-e2e] cleanup left ${sandbox}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  }

  function cli(args: string[]): CliRun {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf-8',
      timeout: E2E_TIMEOUT_MS,
      cwd: sandbox,
      env,
    });
    if (result.error) throw result.error;
    const stdout = result.stdout ?? '';
    return { combined: `${stdout}\n${result.stderr ?? ''}`, status: result.status, json: lastJson(stdout) };
  }

  const knowledge = (target: string, ...args: string[]): CliRun => cli(['knowledge', ...args, '--target', target]);
  const provision = (target: string): CliRun => cli(['init', '--claude', '--force', '--yes', '--target', target]);
  const head = (cwd: string): string => git(cwd, 'rev-parse', 'HEAD').trim();
  const vaultFlowOf = (name: string): string => join(vault, 'projects', name, 'flow');
  const vaultNoteOf = (name: string): string => join(vault, 'projects', name, `${name}.md`);

  function seedFlow(flow: string): void {
    mkdirSync(join(flow, 'brain', 'features'), { recursive: true });
    writeFileSync(join(flow, 'brain', 'features', 'chats.md'), '# Chats\n');
    writeFileSync(join(flow, 'ledger.md'), '# Ledger\n');
  }

  /** A code repo with knowledge in `shape`; vault shape links into the isolated vault. */
  function makeProject(shape: 'vault' | 'shared' | 'local'): void {
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'app.ts'), 'export {}\n');
    writeFileSync(join(root, '.gitignore'), buildGitignoreBlock(['claude'], shape === 'shared' ? 'shared' : 'local') + '\n');
    if (shape === 'vault') {
      seedFlow(vaultFlowOf('proj'));
      symlinkSync(vaultFlowOf('proj'), join(root, 'flow'), 'dir');
    } else {
      seedFlow(join(root, 'flow'));
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  }

  /** What the knowledge repo is: its commit, its tracked content, its status. */
  function knowledgeRepoState(flow: string): { head: string; tracked: string; changes: string; remote: string } {
    return {
      head: head(flow),
      tracked: git(flow, 'ls-files', '-s'),
      // Tracked changes only — see DERIVED_UNTRACKED below for the untracked side.
      changes: git(flow, 'status', '--porcelain', '--untracked-files=no'),
      remote: git(flow, 'remote', '-v'),
    };
  }

  /**
   * The untracked files provisioning may leave in the knowledge repo. KNOWN GAP
   * (reported, not fixed here — it changes what syncs): init's derive writes
   * `brain/blueprint-report.md`, a regenerated report the knowledge repo's own
   * ignore file does not list, so the next turn's commit would sync it. Every
   * other untracked file is a provisioning write into the nested repo — a failure.
   */
  /** Ignored, regenerated layers a derive may rewrite — not knowledge. */
  // Rebuilt by every provision and ignored by the knowledge repo, so their
  // bytes may change — the git-side checks below prove none of them is synced.
  const REBUILT_LAYERS = [
    '.git',
    'brain/.structure',
    'brain/.derived',
    'brain/code',
    'brain/.raw',
    'brain/blueprint-report.md',
  ];
  // Empty since the blueprint report joined the knowledge repo's local list: any
  // untracked (i.e. not ignored) file left by a provision is a leak this reports.
  const DERIVED_UNTRACKED = new Set<string>();
  const untracked = (flow: string): string[] =>
    git(flow, 'ls-files', '--others', '--exclude-standard').split('\n').filter((line) => line !== '');

  /** A project that kept its own knowledge repo, made through the handler with this file's env. */
  async function enableInProcess(target: string, remote: string): Promise<void> {
    const { enableKnowledgeSync } = await import('../handlers/knowledge-migration.js');
    const keys = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ALLOW_PROTOCOL', 'GIT_TERMINAL_PROMPT', 'PLAN_FLOW_VAULT_DIR', 'COPILOT_HOME'];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) process.env[key] = env[key];
    try {
      enableKnowledgeSync(target, { remote });
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  it.each(['vault', 'shared', 'local'] as const)(
    'R-1 from %s: relaunching provisioning twice leaves the nested knowledge repo untouched',
    async (shape) => {
      makeProject(shape);
      await enableInProcess(root, GITHUB_URL);
      const flow = join(root, 'flow');
      const inode = lstatSync(flow).ino;
      const repoBefore = knowledgeRepoState(flow);
      // Tracked knowledge, byte for byte (derived/ignored layers may be rebuilt).
      expect(untracked(flow)).toEqual([]);
      const trackedBefore = snapshotTree(flow, [...REBUILT_LAYERS, ...DERIVED_UNTRACKED]);
      const vaultFlowBefore = existsSync(vaultFlowOf('proj')) ? snapshotTree(vaultFlowOf('proj')) : null;

      const first = provision(root);
      const second = provision(root);

      // Positive first (allowed-pattern #28): provisioning really ran, both times.
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(existsSync(vaultNoteOf('proj'))).toBe(true);
      expect(existsSync(join(root, '.claude', 'commands'))).toBe(true);
      expect(second.combined).toContain("flow/ is this project's knowledge repo");

      expect(lstatSync(flow).isSymbolicLink()).toBe(false);
      expect(lstatSync(flow).ino).toBe(inode);
      expect(knowledgeRepoState(flow)).toEqual(repoBefore);
      expect(untracked(flow).filter((path) => !DERIVED_UNTRACKED.has(path))).toEqual([]);
      expect(snapshotTree(flow, [...REBUILT_LAYERS, ...DERIVED_UNTRACKED])).toEqual(
        trackedBefore
      );
      // The vault was neither re-pointed nor re-seeded.
      if (vaultFlowBefore === null) {
        expect(existsSync(vaultFlowOf('proj'))).toBe(false);
      } else {
        expect(lstatSync(vaultFlowOf('proj')).isSymbolicLink()).toBe(false);
        expect(snapshotTree(vaultFlowOf('proj'))).toEqual(vaultFlowBefore);
      }
      expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toContain(`# Brain repo: ${GITHUB_URL} main`);
      expect(knowledge(root, 'status', '--json').json).toMatchObject({ shape: 'separate', remote: GITHUB_URL });
    },
    E2E_TIMEOUT_MS
  );

  it(
    'R-3: a fresh clone carrying the committed pointer gets no flow/ and no vault link from provisioning',
    async () => {
      makeProject('shared');
      await enableInProcess(root, GITHUB_URL);
      const clone = join(sandbox, 'other-machine');
      git(sandbox, 'clone', '-q', root, clone);
      // The clone has the pointer and no knowledge yet.
      expect(readFileSync(join(clone, '.gitignore'), 'utf-8')).toContain(`# Brain repo: ${GITHUB_URL} main`);
      expect(existsSync(join(clone, 'flow'))).toBe(false);

      const out = provision(clone);

      expect(out.status).toBe(0);
      expect(existsSync(vaultNoteOf('other-machine'))).toBe(true);
      expect(existsSync(join(clone, '.claude', 'commands'))).toBe(true);
      expect(out.combined).toContain('it will be cloned into place, not created');

      expect(existsSync(join(clone, 'flow'))).toBe(false);
      expect(() => lstatSync(join(clone, 'flow'))).toThrow();
      expect(existsSync(vaultFlowOf('other-machine'))).toBe(false);
      expect(() => lstatSync(vaultFlowOf('other-machine'))).toThrow();
      // The pointer survived provisioning, so the clone is still pending.
      expect(readFileSync(join(clone, '.gitignore'), 'utf-8')).toContain(`# Brain repo: ${GITHUB_URL} main`);
      expect(knowledge(clone, 'status', '--json').json).toMatchObject({ shape: 'none', pointer: { url: GITHUB_URL } });
    },
    E2E_TIMEOUT_MS
  );

  it(
    'disable --to keep, then provisioning: the folder and its history stay where they are',
    async () => {
      makeProject('vault');
      await enableInProcess(root, GITHUB_URL);
      const flow = join(root, 'flow');

      const off = knowledge(root, 'disable', '--to', 'keep', '--accept-unpushed', '--json');
      expect(off.status).toBe(0);
      expect(off.json).toMatchObject({ action: 'disable', to: 'keep', shape: 'local', previousRemote: GITHUB_URL });
      const inode = lstatSync(flow).ino;
      const flowHead = head(flow);
      const trackedBefore = git(flow, 'ls-files', '-s');
      const vaultBefore = snapshotTree(vaultFlowOf('proj'));

      const out = provision(root);

      expect(out.status).toBe(0);
      expect(existsSync(vaultNoteOf('proj'))).toBe(true);
      expect(lstatSync(flow).isSymbolicLink()).toBe(false);
      expect(lstatSync(flow).ino).toBe(inode);
      expect(head(flow)).toBe(flowHead);
      expect(git(flow, 'ls-files', '-s')).toBe(trackedBefore);
      expect(git(flow, 'remote').trim()).toBe('');
      // The vault still holds its pre-enable copy — not moved into, not re-linked.
      expect(lstatSync(vaultFlowOf('proj')).isSymbolicLink()).toBe(false);
      expect(snapshotTree(vaultFlowOf('proj'))).toEqual(vaultBefore);
      expect(existsSync(join(vaultFlowOf('proj'), '.git'))).toBe(false);
      expect(knowledge(root, 'status', '--json').json).toMatchObject({ shape: 'local', hasRepo: true, pointer: null });
    },
    E2E_TIMEOUT_MS
  );

  it(
    'enable and adopt are retired through the bundle: transcript, payload, and nothing written',
    () => {
      makeProject('shared');
      const headBefore = head(root);
      const treeBefore = snapshotTree(root, ['.git']);
      const indexBefore = git(root, 'ls-files', '-s');

      for (const verb of ['enable', 'adopt'] as const) {
        const out = verb === 'enable' ? knowledge(root, 'enable', '--remote', GITHUB_URL, '--json') : knowledge(root, 'adopt', '--json');
        expect(out.status).toBe(1);
        expect(out.combined).toContain('knowledge refused: retired —');
        expect(out.json).toMatchObject({ action: verb, refused: 'retired', retired: true });
      }
      expect(head(root)).toBe(headBefore);
      expect(git(root, 'ls-files', '-s')).toBe(indexBefore);
      expect(snapshotTree(root, ['.git'])).toEqual(treeBefore);
      expect(existsSync(join(root, 'flow', '.git'))).toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith('.flow-staging-'))).toEqual([]);
      expect(knowledge(root, 'status', '--json').json).toMatchObject({ shape: 'shared', retired: true });
    },
    E2E_TIMEOUT_MS
  );

  it(
    'disable refuses an unknown destination through the bundle and changes nothing',
    async () => {
      makeProject('local');
      await enableInProcess(root, GITHUB_URL);
      const flow = join(root, 'flow');
      const before = snapshotTree(root, ['.git', 'flow/.git']);
      const flowHead = head(flow);

      const out = knowledge(root, 'disable', '--to', 'elsewhere', '--json');

      expect(out.status).toBe(1);
      expect(out.combined).toContain('knowledge refused: invalid-destination —');
      expect(out.json).toMatchObject({ action: 'disable', refused: 'invalid-destination' });
      expect(snapshotTree(root, ['.git', 'flow/.git'])).toEqual(before);
      expect(head(flow)).toBe(flowHead);
      expect(git(flow, 'remote', 'get-url', 'origin').trim()).toBe(GITHUB_URL);
    },
    E2E_TIMEOUT_MS
  );
});
