/**
 * The Workspaces hard migration (decision 2026-10-06, workspaces-hard-migration):
 * `workspace link --import`, `workspace migrate`, the always-there Default
 * Workspace, and the admin verbs (rename, move-project, delete, set-default).
 *
 * Isolation: one mkdtemp sandbox per test holds every Flow folder, vault, code
 * repo and remote. Git reads a private config (GIT_CONFIG_GLOBAL, no system
 * config); only the `file` transport is allowed. PLAN_FLOW_HOME and
 * PLAN_FLOW_VAULT_DIR point into the sandbox, and every call passes its own
 * Flow folder — the real ~/plan-flow is never named.
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
import { join, relative } from 'node:path';

const model = await import('./workspace-model.js');
const { initShared } = await import('./shared.js');
const migrate = await import('./workspace-migrate.js');
const admin = await import('./workspace-admin.js');

const { WorkspaceRefusal, createWorkspace, linkRepo, readWorkspace, readLocalProjects, provisionWorkspaceLink } = model;
const { migrateWorkspaces } = migrate;
const { renameWorkspace, moveProject, deleteWorkspace, setDefaultWorkspace, readDefaultWorkspace } = admin;

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

const ENV_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'FLOW_E2E',
  'FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS',
  'PLAN_FLOW_HOME',
  'PLAN_FLOW_VAULT_DIR',
  'PLANFLOW_WORKSPACES',
  'HOME',
  'COPILOT_HOME',
] as const;

const DAY = new Date(2026, 9, 6);

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

/** Every path under `root` with what it is: file content hash, link target, or dir. */
function treeHash(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) lines.push(`L ${rel} -> ${readlinkSync(full)}`);
      else if (stat.isDirectory()) {
        lines.push(`D ${rel}`);
        walk(full);
      } else lines.push(`F ${rel} ${createHash('sha256').update(readFileSync(full)).digest('hex')} ${stat.mtimeMs}`);
    }
  };
  walk(root);
  return lines.join('\n');
}

describeWithGit('the Workspaces hard migration', () => {
  let sandbox: string;
  let flowA: string;
  let vault: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const deps = { now: () => DAY };

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  }

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

  function write(root: string, rel: string, content: string): void {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }

  /** A repo whose flow/ is the REAL vault link `initShared` makes, with knowledge in the vault. */
  async function vaultLinkedRepo(name: string, origin: string): Promise<{ repo: string; vaultFlow: string }> {
    const repo = makeRepo(name, origin);
    await initShared(repo, { force: false, nonInteractive: true }, ['claude']);
    const vaultFlow = join(vault, 'projects', name, 'flow');
    expect(readlinkSync(join(repo, 'flow'))).toBe(vaultFlow);
    return { repo, vaultFlow };
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-migrate-')));
    flowA = join(sandbox, 'flow-a');
    vault = join(sandbox, 'vault');
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
    process.env.HOME = join(sandbox, 'home');
    process.env.COPILOT_HOME = join(sandbox, 'home', '.copilot');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.FLOW_E2E = '1';
    process.env.FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS = 'file';
    process.env.PLAN_FLOW_HOME = flowA;
    process.env.PLAN_FLOW_VAULT_DIR = vault;
    delete process.env.PLANFLOW_WORKSPACES;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  // ─── link --import ────────────────────────────────────────────────────────

  describe('link --import', () => {
    beforeEach(() => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
    });

    it('copies a vault link\'s REAL content — through per-subdirectory links into the vault — and leaves the vault untouched', async () => {
      const { repo, vaultFlow } = await vaultLinkedRepo('web', 'https://github.com/acme/web');
      write(vaultFlow, 'plans/plan_checkout_v1.md', '# checkout\n');
      write(vaultFlow, 'brain/features/cart.md', '# cart\n');
      write(vaultFlow, '.flowconfig', 'share: local\n');
      write(vaultFlow, 'brain/.structure/annotations.jsonl', '{"a":1}\n');
      write(vaultFlow, 'brain/.structure/graph.json', '{"generated":true}\n');
      write(vaultFlow, 'brain/index.md', '# stale generated index\n');
      // A per-subdirectory link inside the vault project folder: followed.
      write(join(vault, 'projects', 'web'), 'notes-store/meeting.md', '# meeting\n');
      symlinkSync(join(vault, 'projects', 'web', 'notes-store'), join(vaultFlow, 'notes'));
      // A link out of the source tree: never followed, listed.
      write(sandbox, 'elsewhere/secret.md', 'secret\n');
      symlinkSync(join(sandbox, 'elsewhere'), join(vaultFlow, 'outside'));
      const vaultBefore = treeHash(vault);

      const result = linkRepo({ flowFolder: flowA, target: repo, import: true, deps });
      const folder = result.project.flowPath;
      expect(result.previous).toEqual({ kind: 'link', target: vaultFlow });
      expect(readlinkSync(join(repo, 'flow'))).toBe(folder);
      expect(result.imported).not.toBeNull();
      expect(result.imported?.skipped).toEqual(['outside']);
      expect(result.imported?.renamed).toEqual([]);
      expect(result.imported?.files).toBeGreaterThanOrEqual(5);
      expect(readFileSync(join(folder, 'plans', 'plan_checkout_v1.md'), 'utf-8')).toBe('# checkout\n');
      expect(readFileSync(join(folder, 'brain', 'features', 'cart.md'), 'utf-8')).toBe('# cart\n');
      expect(readFileSync(join(folder, 'notes', 'meeting.md'), 'utf-8')).toBe('# meeting\n');
      expect(lstatSync(join(folder, 'notes')).isDirectory()).toBe(true);
      // Personal files are copied (they stay local; the Workspace ignores them).
      expect(readFileSync(join(folder, '.flowconfig'), 'utf-8')).toBe('share: local\n');
      expect(readFileSync(join(folder, 'brain', '.structure', 'annotations.jsonl'), 'utf-8')).toBe('{"a":1}\n');
      // Generated files are not copied — they rebuild; the brain index is rebuilt here.
      expect(existsSync(join(folder, 'brain', '.structure', 'graph.json'))).toBe(false);
      expect(readFileSync(join(folder, 'brain', 'index.md'), 'utf-8')).not.toContain('stale generated index');
      expect(existsSync(join(folder, 'outside'))).toBe(false);
      expect(treeHash(vault)).toBe(vaultBefore);

      // Idempotent: linked already, nothing copied again.
      const again = linkRepo({ flowFolder: flowA, target: repo, import: true, deps });
      expect(again.link).toBe('unchanged');
      expect(again.imported).toEqual({ files: 0, skipped: [], renamed: [] });
    });

    it('copies a plain untracked flow/ — its per-subdirectory links into the vault included — and keeps the folder as a backup', () => {
      const repo = makeRepo('svc', 'https://github.com/acme/svc');
      write(repo, 'flow/plans/plan_a_v1.md', '# a\n');
      write(vault, 'projects/svc/discovery/discovery_x_v1.md', '# x\n');
      symlinkSync(join(vault, 'projects', 'svc', 'discovery'), join(repo, 'flow', 'discovery'));
      writeFileSync(join(repo, '.git', 'info', 'exclude'), '/flow\n');

      const result = linkRepo({ flowFolder: flowA, target: repo, import: true, deps });
      const keptAt = join(repo, 'flow.pre-workspace-20261006');
      expect(result.previous).toEqual({ kind: 'folder', keptAt });
      expect(result.imported).toMatchObject({ files: 2, skipped: [], renamed: [] });
      expect(readFileSync(join(result.project.flowPath, 'discovery', 'discovery_x_v1.md'), 'utf-8')).toBe('# x\n');
      expect(readFileSync(join(keptAt, 'plans', 'plan_a_v1.md'), 'utf-8')).toBe('# a\n');
      expect(lstatSync(join(keptAt, 'discovery')).isSymbolicLink()).toBe(true);
      expect(git(repo, 'status', '--porcelain')).toBe('');
    });

    it('copies a project\'s own knowledge repo without its .git and keeps the repo beside as a backup; without --import it still refuses', () => {
      const repo = makeRepo('lib', 'https://github.com/acme/lib');
      const flow = join(repo, 'flow');
      write(repo, 'flow/decisions.md', '# decided\n');
      git(flow, 'init', '-q', '-b', 'main');
      git(flow, 'add', '-A');
      git(flow, 'commit', '-q', '-m', 'knowledge');
      writeFileSync(join(repo, '.git', 'info', 'exclude'), '/flow\n');

      const refusal = refusalOf(() => linkRepo({ flowFolder: flowA, target: repo, deps }), 'keeps-own-knowledge-repo');
      expect(refusal.payload).toMatchObject({ needs: 'import' });
      expect(existsSync(join(flow, '.git'))).toBe(true);

      const result = linkRepo({ flowFolder: flowA, target: repo, import: true, deps });
      const keptAt = join(repo, 'flow.pre-workspace-20261006');
      expect(result.previous).toEqual({ kind: 'knowledge-repo', keptAt });
      expect(result.imported).toMatchObject({ files: 1 });
      expect(readFileSync(join(result.project.flowPath, 'decisions.md'), 'utf-8')).toBe('# decided\n');
      expect(existsSync(join(result.project.flowPath, '.git'))).toBe(false);
      expect(existsSync(join(keptAt, '.git', 'HEAD'))).toBe(true);
      expect(lstatSync(flow).isSymbolicLink()).toBe(true);
    });

    it('never overwrites: a clash keeps both — the next free _vN for versioned documents (the walkthrough follows), .imported otherwise', () => {
      const first = makeRepo('app-one', 'https://github.com/acme/app');
      const linked = linkRepo({ flowFolder: flowA, target: first, deps });
      const folder = linked.project.flowPath;
      write(folder, 'plans/plan_x_v1.md', 'theirs\n');
      write(folder, 'notes.md', 'theirs\n');
      write(folder, 'same.md', 'identical\n');
      write(folder, 'discovery/discovery_y_v1.md', 'theirs\n');
      write(folder, 'discovery/discovery_y_v1.walkthrough.html', '<p>theirs</p>\n');

      // A second checkout of the same project, with its own plain flow/.
      const second = makeRepo('app-two', 'https://github.com/acme/app');
      write(second, 'flow/plans/plan_x_v1.md', 'mine\n');
      write(second, 'flow/notes.md', 'mine\n');
      write(second, 'flow/same.md', 'identical\n');
      write(second, 'flow/discovery/discovery_y_v1.md', 'mine\n');
      write(second, 'flow/discovery/discovery_y_v1.walkthrough.html', '<p>mine</p>\n');

      const result = linkRepo({ flowFolder: flowA, target: second, import: true, deps });
      expect(result.project.flowPath).toBe(folder);
      expect([...(result.imported?.renamed ?? [])].sort((a, b) => a.from.localeCompare(b.from))).toEqual([
        { from: 'discovery/discovery_y_v1.md', to: 'discovery/discovery_y_v2.md' },
        { from: 'discovery/discovery_y_v1.walkthrough.html', to: 'discovery/discovery_y_v2.walkthrough.html' },
        { from: 'notes.md', to: 'notes.imported.md' },
        { from: 'plans/plan_x_v1.md', to: 'plans/plan_x_v2.md' },
      ]);
      expect(result.imported?.files).toBe(4);
      expect(readFileSync(join(folder, 'plans', 'plan_x_v1.md'), 'utf-8')).toBe('theirs\n');
      expect(readFileSync(join(folder, 'plans', 'plan_x_v2.md'), 'utf-8')).toBe('mine\n');
      expect(readFileSync(join(folder, 'notes.md'), 'utf-8')).toBe('theirs\n');
      expect(readFileSync(join(folder, 'notes.imported.md'), 'utf-8')).toBe('mine\n');
      expect(readFileSync(join(folder, 'discovery', 'discovery_y_v2.walkthrough.html'), 'utf-8')).toBe('<p>mine</p>\n');
      expect(existsSync(join(folder, 'same.imported.md'))).toBe(false);
    });
  });

  // ─── migrate ──────────────────────────────────────────────────────────────

  describe('migrate', () => {
    /** Five roots in the five shapes, plus two that cannot be migrated and one duplicate. */
    async function fleet(): Promise<{ vaulted: string; plain: string; committed: string; own: string; empty: string; roots: string[] }> {
      const { repo: vaulted, vaultFlow } = await vaultLinkedRepo('web', 'https://github.com/acme/web');
      write(vaultFlow, 'plans/plan_web_v1.md', '# web\n');
      const plain = makeRepo('svc', 'https://github.com/acme/svc');
      write(plain, 'flow/plans/plan_svc_v1.md', '# svc\n');
      writeFileSync(join(plain, '.git', 'info', 'exclude'), '/flow\n');
      const committed = makeRepo('mono', 'https://github.com/acme/mono');
      write(committed, 'flow/plans/plan_mono_v1.md', '# mono\n');
      git(committed, 'add', '-A');
      git(committed, 'commit', '-q', '-m', 'knowledge');
      const own = makeRepo('lib', 'https://github.com/acme/lib');
      write(own, 'flow/decisions.md', '# lib\n');
      git(join(own, 'flow'), 'init', '-q', '-b', 'main');
      writeFileSync(join(own, '.git', 'info', 'exclude'), '/flow\n');
      const empty = makeRepo('bare-bones');
      mkdirSync(join(sandbox, 'not-a-repo'), { recursive: true });
      symlinkSync(plain, join(sandbox, 'svc-alias'));
      return {
        vaulted,
        plain,
        committed,
        own,
        empty,
        roots: [vaulted, plain, committed, own, empty, join(sandbox, 'missing'), join(sandbox, 'not-a-repo'), join(sandbox, 'svc-alias')],
      };
    }

    it('creates the Default Workspace, migrates every root it can, holds a committed folder back, reports failures, and is idempotent', async () => {
      const { vaulted, plain, committed, own, empty, roots } = await fleet();
      const result = migrateWorkspaces({ flowFolder: flowA, roots, deps });

      expect(result).toMatchObject({
        action: 'migrate',
        dryRun: false,
        workspace: { name: 'Default', slug: 'default', path: join(flowA, 'workspaces', 'default'), created: true },
      });
      expect(readDefaultWorkspace(flowA)).toBe('default');
      expect(result.migrated.map((entry) => entry.root)).toEqual([vaulted, plain, own, empty]);
      const byRoot = Object.fromEntries(result.migrated.map((entry) => [entry.root, entry]));
      expect(byRoot[vaulted].previous).toMatchObject({ kind: 'link' });
      expect(byRoot[plain].previous).toMatchObject({ kind: 'folder' });
      expect(byRoot[own].previous).toMatchObject({ kind: 'knowledge-repo' });
      expect(byRoot[empty].previous).toEqual({ kind: 'none' });
      expect(readFileSync(join(byRoot[vaulted].project.flowPath, 'plans', 'plan_web_v1.md'), 'utf-8')).toBe('# web\n');
      expect(readFileSync(join(byRoot[plain].project.flowPath, 'plans', 'plan_svc_v1.md'), 'utf-8')).toBe('# svc\n');
      expect(readFileSync(join(byRoot[own].project.flowPath, 'decisions.md'), 'utf-8')).toBe('# lib\n');
      expect(byRoot[plain].imported).toMatchObject({ files: 1, skipped: [], renamed: [] });

      expect(result.pending).toEqual([
        {
          root: committed,
          reason: 'committed-folder',
          commit: { message: expect.stringMatching(/flow\.pre-workspace/), files: 1, from: 'flow', to: 'flow.pre-workspace' },
        },
      ]);
      expect(lstatSync(join(committed, 'flow')).isDirectory()).toBe(true);
      expect(result.failed.map((entry) => [entry.root, entry.reason])).toEqual([
        [join(sandbox, 'missing'), 'not-a-git-repo'],
        [join(sandbox, 'not-a-repo'), 'not-a-git-repo'],
      ]);
      expect(result.unchanged).toEqual([]);

      // Again: nothing is copied twice, nothing is created twice.
      const again = migrateWorkspaces({ flowFolder: flowA, roots, deps });
      expect(again.workspace).toMatchObject({ slug: 'default', created: false });
      expect(again.migrated).toEqual([]);
      expect(again.unchanged).toEqual([vaulted, plain, own, empty]);
      expect(again.pending.map((entry) => entry.root)).toEqual([committed]);
      expect(readWorkspace(flowA, 'default').file.projects).toHaveLength(4);

      // The app confirms the committed one with link --confirm-commit --import.
      const confirmed = linkRepo({ flowFolder: flowA, target: committed, workspace: 'default', confirmCommit: true, import: true, deps });
      expect(confirmed.codeRepo.commit).toMatchObject({ files: 1 });
      expect(confirmed.imported).toMatchObject({ files: 1 });
      expect(readFileSync(join(confirmed.project.flowPath, 'plans', 'plan_mono_v1.md'), 'utf-8')).toBe('# mono\n');
    });

    it('--dry-run writes nothing and says what would happen, root by root', async () => {
      const { vaulted, plain, committed, roots } = await fleet();
      const before = treeHash(sandbox);
      const result = migrateWorkspaces({ flowFolder: flowA, roots, dryRun: true, deps });
      expect(treeHash(sandbox)).toBe(before);
      expect(existsSync(flowA)).toBe(false);

      expect(result).toMatchObject({
        action: 'migrate',
        dryRun: true,
        would: 'create-workspace',
        workspace: { name: 'Default', slug: 'default', created: false },
        migrated: [],
      });
      const plan = Object.fromEntries(result.plan.map((entry) => [entry.root, entry]));
      expect(plan[vaulted]).toMatchObject({ would: 'link', project: { slug: 'web' } });
      expect(plan[vaulted].files).toBeGreaterThanOrEqual(1);
      expect(plan[plain]).toMatchObject({ would: 'link', files: 1 });
      expect(plan[committed]).toMatchObject({ would: 'pending', reason: 'committed-folder' });
      expect(plan[join(sandbox, 'missing')]).toMatchObject({ would: 'fail', reason: 'not-a-git-repo' });
      expect(result.pending.map((entry) => entry.root)).toEqual([committed]);
      expect(result.failed).toHaveLength(2);

      // After a real run, a dry run reports them unchanged.
      migrateWorkspaces({ flowFolder: flowA, roots: [plain], deps });
      const later = migrateWorkspaces({ flowFolder: flowA, roots: [plain], dryRun: true, deps });
      expect(later).toMatchObject({ would: 'use-workspace', unchanged: [plain] });
      expect(later.plan).toEqual([{ root: plain, would: 'unchanged' }]);
    });

    it('migrates into the recorded Default even when other Workspaces exist; --workspace overrides; an unknown one is refused', () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      createWorkspace({ flowFolder: flowA, name: 'Personal' });
      const one = makeRepo('one', 'https://github.com/acme/one');
      const first = migrateWorkspaces({ flowFolder: flowA, roots: [one], deps });
      expect(first.workspace).toMatchObject({ slug: 'default', created: true });

      const two = makeRepo('two', 'https://github.com/acme/two');
      const second = migrateWorkspaces({ flowFolder: flowA, roots: [two], deps });
      expect(second.workspace).toMatchObject({ slug: 'default', created: false });

      const three = makeRepo('three', 'https://github.com/acme/three');
      const third = migrateWorkspaces({ flowFolder: flowA, roots: [three], workspace: 'team', deps });
      expect(third.workspace).toMatchObject({ slug: 'team', created: false });
      expect(readWorkspace(flowA, 'team').file.projects.map((project) => project.slug)).toEqual(['three']);

      refusalOf(() => migrateWorkspaces({ flowFolder: flowA, roots: [three], workspace: 'nope', deps }), 'unknown-workspace');
    });

    it('takes --name for a Default it creates, and adopts an unrecorded Workspace whose folder is default', () => {
      const repo = makeRepo('one', 'https://github.com/acme/one');
      const named = migrateWorkspaces({ flowFolder: flowA, roots: [repo], name: 'Everything', deps });
      expect(named.workspace).toMatchObject({ name: 'Everything', slug: 'everything', created: true });

      const other = join(sandbox, 'flow-b');
      createWorkspace({ flowFolder: other, name: 'Default' });
      const adopted = migrateWorkspaces({ flowFolder: other, roots: [], deps });
      expect(adopted.workspace).toMatchObject({ slug: 'default', created: false });
      expect(readDefaultWorkspace(other)).toBe('default');
    });

    it('rejects a roots list that is not absolute paths', () => {
      refusalOf(() => migrateWorkspaces({ flowFolder: flowA, roots: ['relative/path'], deps }), 'invalid-roots');
    });
  });

  // ─── admin verbs ──────────────────────────────────────────────────────────

  describe('rename, set-default, move-project, delete', () => {
    it('renames the display name only — the folder stays — and refuses an empty or taken name', () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      createWorkspace({ flowFolder: flowA, name: 'Personal' });
      const renamed = renameWorkspace({ flowFolder: flowA, workspace: 'team', name: 'Acme Team' });
      expect(renamed).toMatchObject({ action: 'rename', previousName: 'Team', changed: true, workspace: { name: 'Acme Team', slug: 'team' } });
      expect(readWorkspace(flowA, 'team').file).toMatchObject({ name: 'Acme Team', slug: 'team' });
      expect(existsSync(join(flowA, 'workspaces', 'team'))).toBe(true);
      refusalOf(() => renameWorkspace({ flowFolder: flowA, workspace: 'team', name: '  ' }), 'invalid-name');
      refusalOf(() => renameWorkspace({ flowFolder: flowA, workspace: 'team', name: 'personal' }), 'duplicate-name');
      expect(renameWorkspace({ flowFolder: flowA, workspace: 'team', name: 'Acme Team' }).changed).toBe(false);
    });

    it('records the Default locally, never in the synced workspace.json', () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      createWorkspace({ flowFolder: flowA, name: 'Personal' });
      expect(readDefaultWorkspace(flowA)).toBeNull();
      const result = setDefaultWorkspace({ flowFolder: flowA, workspace: 'personal' });
      expect(result).toMatchObject({ action: 'set-default', previous: null, workspace: { slug: 'personal' } });
      expect(readDefaultWorkspace(flowA)).toBe('personal');
      expect(readFileSync(join(flowA, 'workspaces', 'personal', 'workspace.json'), 'utf-8')).not.toContain('default');
      expect(JSON.parse(readFileSync(join(flowA, 'settings', 'workspaces.local.json'), 'utf-8'))).toEqual({ default: 'personal' });
      const status = model.workspaceStatus({ flowFolder: flowA });
      expect('workspaces' in status && status.workspaces.map((entry) => [entry.slug, entry.default])).toEqual([
        ['personal', true],
        ['team', false],
      ]);
      refusalOf(() => setDefaultWorkspace({ flowFolder: flowA, workspace: 'nope' }), 'unknown-workspace');
    });

    it('moves a project — its folder, both workspace.json files, and every checkout link — never deleting content', () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      createWorkspace({ flowFolder: flowA, name: 'Other' });
      const repo = makeRepo('web', 'https://github.com/acme/web');
      const linked = linkRepo({ flowFolder: flowA, target: repo, workspace: 'team', deps });
      write(linked.project.flowPath, 'plans/plan_web_v1.md', '# web\n');
      // A project already called web in the target: the moved one takes a suffix.
      const clash = makeRepo('web-other', 'https://github.com/other/web');
      linkRepo({ flowFolder: flowA, target: clash, workspace: 'other', deps });

      const moved = moveProject({ flowFolder: flowA, project: 'web', to: 'other', deps });
      const target = join(flowA, 'workspaces', 'other', 'projects', 'web-2');
      expect(moved).toMatchObject({
        action: 'move-project',
        from: { slug: 'team' },
        to: { slug: 'other' },
        project: { id: 'github.com/acme/web', slug: 'web-2', flowPath: target, localPath: repo },
        movedFrom: linked.project.flowPath,
        movedTo: target,
        relinked: [{ project: 'github.com/acme/web', checkout: repo, link: target }],
      });
      expect(readFileSync(join(target, 'plans', 'plan_web_v1.md'), 'utf-8')).toBe('# web\n');
      expect(existsSync(linked.project.flowPath)).toBe(false);
      expect(readlinkSync(join(repo, 'flow'))).toBe(target);
      expect(readWorkspace(flowA, 'team').file.projects).toEqual([]);
      expect(readWorkspace(flowA, 'other').file.projects.map((project) => project.slug)).toEqual(['web', 'web-2']);
      expect(existsSync(join(target, 'brain', 'index.md'))).toBe(true);

      refusalOf(() => moveProject({ flowFolder: flowA, project: 'nope', to: 'team', deps }), 'unknown-project');
      refusalOf(() => moveProject({ flowFolder: flowA, project: 'web-2', to: 'other', deps }), 'same-workspace');
      refusalOf(() => moveProject({ flowFolder: flowA, project: 'web-2', to: 'nope', deps }), 'unknown-workspace');
    });

    it('refuses to move a project while a sync holds either Workspace', () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      createWorkspace({ flowFolder: flowA, name: 'Other' });
      const repo = makeRepo('web', 'https://github.com/acme/web');
      linkRepo({ flowFolder: flowA, target: repo, workspace: 'team', deps });
      writeFileSync(join(flowA, 'workspaces', 'other', '.git', 'plan-flow-sync.lock'), `${process.pid}\n`);
      refusalOf(() => moveProject({ flowFolder: flowA, project: 'web', to: 'other', deps }), 'sync-busy');
      expect(readWorkspace(flowA, 'team').file.projects).toHaveLength(1);
    });

    it('deletes a Workspace only with --confirm: projects move to the Default, the folder is kept as a backup, the remote untouched', () => {
      const repo = makeRepo('web', 'https://github.com/acme/web');
      migrateWorkspaces({ flowFolder: flowA, roots: [], deps });
      createWorkspace({ flowFolder: flowA, name: 'Team', remote: 'https://git.example.test/team/ws.git' });
      const linked = linkRepo({ flowFolder: flowA, target: repo, workspace: 'team', deps });
      write(linked.project.flowPath, 'plans/plan_web_v1.md', '# web\n');

      refusalOf(() => deleteWorkspace({ flowFolder: flowA, workspace: 'default', confirm: true, deps }), 'default-workspace');
      const ask = refusalOf(() => deleteWorkspace({ flowFolder: flowA, workspace: 'team', deps }), 'unconfirmed');
      expect(ask.payload).toMatchObject({ workspace: { slug: 'team' }, projects: [{ slug: 'web' }], into: { slug: 'default' } });
      expect(existsSync(join(flowA, 'workspaces', 'team'))).toBe(true);

      const deleted = deleteWorkspace({ flowFolder: flowA, workspace: 'team', confirm: true, deps });
      const backup = join(flowA, 'workspaces', '.deleted-team-20261006');
      expect(deleted).toMatchObject({
        action: 'delete',
        workspace: { slug: 'team', remote: 'https://git.example.test/team/ws.git' },
        into: { slug: 'default' },
        movedProjects: [{ slug: 'web' }],
        keptAt: backup,
        remoteUntouched: true,
      });
      expect(existsSync(join(flowA, 'workspaces', 'team'))).toBe(false);
      expect(existsSync(join(backup, 'workspace.json'))).toBe(true);
      const moved = join(flowA, 'workspaces', 'default', 'projects', 'web');
      expect(readFileSync(join(moved, 'plans', 'plan_web_v1.md'), 'utf-8')).toBe('# web\n');
      expect(readlinkSync(join(repo, 'flow'))).toBe(moved);
      expect(model.scanWorkspaces(flowA).workspaces.map((workspace) => workspace.slug)).toEqual(['default']);
    });
  });

  // ─── provisioning ─────────────────────────────────────────────────────────

  describe('provisioning', () => {
    it('ignores PLANFLOW_WORKSPACES=off — Workspaces are always on', () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const repo = makeRepo('backend', 'https://github.com/acme/backend');
      linkRepo({ flowFolder: flowA, target: repo });
      rmSync(join(repo, 'flow'));
      process.env.PLANFLOW_WORKSPACES = 'off';
      expect(provisionWorkspaceLink(repo, { flowFolder: flowA })).toMatchObject({ kind: 'linked' });
    });

    it('with workspaceManaged, leaves flow/ alone for a project in no Workspace — no vault link, no vault folder', async () => {
      const repo = makeRepo('solo', 'https://github.com/acme/solo');
      await initShared(repo, { force: false, nonInteractive: true, workspaceManaged: true }, ['claude']);
      expect(lstatSync(join(repo, 'flow'), { throwIfNoEntry: false })).toBeUndefined();
      expect(existsSync(join(vault, 'projects', 'solo'))).toBe(false);

      const plain = makeRepo('plain', 'https://github.com/acme/plain');
      write(plain, 'flow/plans/plan_p_v1.md', '# p\n');
      await initShared(plain, { force: false, nonInteractive: true, workspaceManaged: true }, ['claude']);
      expect(lstatSync(join(plain, 'flow')).isDirectory()).toBe(true);
      expect(readdirSync(join(plain, 'flow'))).toEqual(['plans']);
      expect(existsSync(join(vault, 'projects', 'plain'))).toBe(false);
    });

    it('with workspaceManaged, a Workspace project still provisions into its Workspace', async () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const repo = makeRepo('backend', 'https://github.com/acme/backend');
      const linked = linkRepo({ flowFolder: flowA, target: repo });
      await initShared(repo, { force: false, nonInteractive: true, workspaceManaged: true }, ['claude']);
      expect(readlinkSync(join(repo, 'flow'))).toBe(linked.project.flowPath);
      expect(existsSync(join(linked.project.flowPath, 'tasklist.md'))).toBe(true);
    });

    it('imports an own knowledge repo when provisioning links a recorded checkout', async () => {
      createWorkspace({ flowFolder: flowA, name: 'Team' });
      const repo = makeRepo('lib', 'https://github.com/acme/lib');
      const linked = linkRepo({ flowFolder: flowA, target: repo, deps });
      rmSync(join(repo, 'flow'));
      write(repo, 'flow/decisions.md', '# kept\n');
      git(join(repo, 'flow'), 'init', '-q', '-b', 'main');
      const outcome = provisionWorkspaceLink(repo, { flowFolder: flowA, deps });
      expect(outcome).toMatchObject({ kind: 'linked' });
      expect(readFileSync(join(linked.project.flowPath, 'decisions.md'), 'utf-8')).toBe('# kept\n');
      expect(readLocalProjects(flowA)[linked.project.id]).toBe(repo);
    });
  });
});
