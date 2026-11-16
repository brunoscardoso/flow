/**
 * `workspace promote` — a REAL Workspace, a REAL code repository with a bare
 * remote, the drafts written the way the writers write them, and the verb run
 * in process. Isolation follows the workspace-model suites: every folder under
 * one mkdtemp directory, a private git config, the `file` transport allowed
 * only under FLOW_E2E.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const model = await import('./workspace-model.js');
const { promoteWorkspace, collectDraftItems } = await import('./workspace-promote.js');
const { runWorkspace } = await import('../commands/workspace.js');
const { recordProvenance } = await import('../state/knowledge-provenance.js');
const { knowledgeItemId, readKnowledgeStatus } = await import('../state/knowledge-status-log.js');
const { documentItemId } = await import('./knowledge-landing.js');
const { hashFileContent } = await import('../blueprint/store.js');

const { createWorkspace, linkRepo, projectFolder, defaultWorkspaceGit } = model;

const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_OK ? describe : describe.skip;
const TEST_TIMEOUT_MS = 120_000;

const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'FLOW_E2E', 'FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS', 'PLAN_FLOW_HOME', 'PLAN_FLOW_VAULT_DIR', 'HOME'] as const;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

describeWithGit('workspace promote against a real Workspace and code repository', () => {
  let sandbox: string;
  let flowFolder: string;
  let code: string;
  let bare: string;
  let flowDir: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  /** A branch changing orders.ts, pushed; returns its commit. */
  function branch(name: string, text: string): string {
    git(code, 'checkout', '-q', '-b', name);
    writeFileSync(join(code, 'orders.ts'), text);
    git(code, 'add', 'orders.ts');
    git(code, 'commit', '-q', '-m', `feat: ${name}`);
    git(code, 'push', '-q', '-u', 'origin', name);
    const sha = git(code, 'rev-parse', 'HEAD').trim();
    git(code, 'checkout', '-q', 'main');
    return sha;
  }

  function writeIn(path: string, text: string): void {
    const full = join(flowDir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-promote-')));
    mkdirSync(join(sandbox, 'home'));
    writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
    process.env.HOME = join(sandbox, 'home');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.FLOW_E2E = '1';
    process.env.FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS = 'file';
    process.env.PLAN_FLOW_HOME = join(sandbox, 'unused-home');
    process.env.PLAN_FLOW_VAULT_DIR = join(sandbox, 'vault');

    bare = join(sandbox, 'remote.git');
    git(sandbox, 'init', '-q', '--bare', '-b', 'main', bare);
    const seed = join(sandbox, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    writeFileSync(join(seed, 'orders.ts'), 'export const retries = 1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'init');
    git(seed, 'push', '-q', bare, 'main');
    code = join(sandbox, 'code', 'backend');
    mkdirSync(join(sandbox, 'code'));
    git(join(sandbox, 'code'), 'clone', '-q', bare, 'backend');

    flowFolder = join(sandbox, 'flow');
    createWorkspace({ flowFolder, name: 'Team' });
    // The project is identified by its remote; the checkout then fetches from the bare one.
    git(code, 'remote', 'set-url', 'origin', 'git@github.com:acme/backend.git');
    linkRepo({ flowFolder, target: code, workspace: 'team' });
    git(code, 'remote', 'set-url', 'origin', bare);
    flowDir = projectFolder(flowFolder, 'team', 'backend');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it(
    'promotes a merged learning and document, archives an abandoned plan, and is a no-op the second time',
    () => {
      const merged = branch('feat/orders', 'export const retries = 2\n');
      const dead = branch('feat/dead', 'export const retries = 9\n');

      // A learning stamped on feat/orders, the way the writer stamps it.
      const learnedAt = recordProvenance(flowDir, {
        branch: 'feat/orders',
        commit: merged,
        onDefault: false,
        hashes: [{ path: 'orders.ts', contentHash: hashFileContent('export const retries = 2\n') }],
      });
      writeIn(
        'brain/features/orders.md',
        `---\nid: feature:backend::orders\nname: Orders\nkind: core\nanchors: [file:orders.ts]\nrelates: []\n---\n# Orders\n\nTakes orders.\n\n## Learned\n\n- Orders retry twice. <!-- learnedAt: ${learnedAt} --> <!-- learned: code 2026-11-16 -->\n`
      );
      writeIn('discovery/discovery_orders_v1.md', `---\nbranch: feat/orders\ncommit: ${merged}\n---\n# Orders\n`);
      writeIn('plans/plan_dead_v1.md', `---\nbranch: feat/dead\ncommit: ${dead}\n---\n# Dead\n`);
      writeIn('plans/plan_plain_v1.md', '# Unstamped, so solid already\n');

      const learningItem = knowledgeItemId({ kind: 'learning', scope: 'orders', text: 'Orders retry twice.', learnedAt });
      expect(collectDraftItems(flowDir).map((draft) => draft.item).sort()).toEqual(
        [learningItem, documentItemId('discovery_orders_v1.md', merged), documentItemId('plan_dead_v1.md', dead)].sort()
      );

      // feat/orders merges normally; feat/dead is deleted unmerged.
      git(code, 'merge', '-q', '--no-ff', '-m', 'Merge feat/orders', 'feat/orders');
      git(code, 'push', '-q', 'origin', 'main');
      git(code, 'push', '-q', 'origin', '--delete', 'feat/dead');
      git(code, 'branch', '-q', '-D', 'feat/dead');

      const result = promoteWorkspace({ flowFolder, workspace: 'team', deps: { git: defaultWorkspaceGit, host: () => null } });
      expect(result).toMatchObject({ action: 'promote', workspace: { slug: 'team' } });
      expect(result.projects).toEqual([
        {
          project: 'backend',
          state: 'checked',
          counts: { checked: 3, solid: 2, stale: 0, abandoned: 1, unknown: 0 },
          archived: ['archive/plan_dead_v1.md'],
          archiveFailed: [],
        },
      ]);
      expect(result.totals).toEqual({ checked: 3, solid: 2, stale: 0, abandoned: 1, unknown: 0 });

      // POSITIVE FIRST: the status lines are there, and the plan is in the archive…
      const folded = readKnowledgeStatus(flowDir);
      expect(folded.get(learningItem)?.status).toBe('solid');
      expect(folded.get(documentItemId('plan_dead_v1.md', dead))?.status).toBe('abandoned');
      expect(existsSync(join(flowDir, 'archive', 'plan_dead_v1.md'))).toBe(true);
      // …and gone from plans/, while the solid documents stayed where they were.
      expect(existsSync(join(flowDir, 'plans', 'plan_dead_v1.md'))).toBe(false);
      expect(existsSync(join(flowDir, 'plans', 'plan_plain_v1.md'))).toBe(true);
      expect(readFileSync(join(flowDir, 'discovery', 'discovery_orders_v1.md'), 'utf-8')).toContain(merged);

      // Nothing is a draft any more: the second run checks nothing.
      const again = promoteWorkspace({ flowFolder, workspace: 'team', deps: { git: defaultWorkspaceGit, host: () => null } });
      expect(again.totals).toEqual({ checked: 0, solid: 0, stale: 0, abandoned: 0, unknown: 0 });
    },
    TEST_TIMEOUT_MS
  );

  it('reports a project with no checkout on this machine, and checks nothing for it', () => {
    rmSync(code, { recursive: true, force: true });
    const result = promoteWorkspace({ flowFolder, workspace: 'team', deps: { host: () => null } });
    expect(result.projects).toEqual([expect.objectContaining({ project: 'backend', state: 'no-checkout' })]);
  });

  it('refuses by the family contract: a JSON payload line, then one refused line, exit 1', () => {
    const plain = join(sandbox, 'not-in-a-workspace');
    mkdirSync(plain);
    const out: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.join(' '));
    });
    const previous = process.exitCode;
    try {
      runWorkspace('promote', { target: plain, json: true }, { flowFolder });
      runWorkspace('promote', { workspace: 'nope', json: true }, { flowFolder });
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      log.mockRestore();
      process.exitCode = previous;
    }
    const transcript = out.join('\n');
    expect(JSON.parse(out[0])).toMatchObject({ action: 'promote', refused: 'no-workspace' });
    expect(transcript).toContain('workspace refused: no-workspace');
    expect(transcript).toContain('workspace refused: unknown-workspace');
  });
});
