import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, linkRepo } from '../handlers/workspace-model.js';
import type { BlueprintGraph } from './types.js';
import { buildSurface, readSiblingSurfaces, readSurface, writeSurface, SURFACE_FILENAME } from './surface.js';

const graph = (): BlueprintGraph =>
  ({
    version: 1,
    derivedAt: '2026-07-24T12:00:00.000Z',
    coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['basic'], graphifyEnriched: false },
    nodes: [
      { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
      { id: 'endpoint:GET /api/tenants', kind: 'endpoint', label: 'GET /api/tenants', sourceFile: 'src/app/api/tenants/route.ts', meta: { method: 'GET', route: '/api/tenants', pathGroup: '/api/tenants' } },
      { id: 'endpoint:query getChats', kind: 'endpoint', label: 'query getChats', sourceFile: 'src/graphql/q.ts', meta: { operation: 'query', route: 'getChats', pathGroup: 'graphql' } },
    ],
    edges: [],
  }) as BlueprintGraph;

describe('buildSurface', () => {
  it('distills endpoints and GraphQL operations with repoPath riding along', () => {
    const surface = buildSurface(graph(), '/repos/orbit-core');
    expect(surface.project).toBe('orbit-core');
    expect(surface.repoPath).toBe('/repos/orbit-core');
    expect(surface.endpoints).toEqual([{ method: 'GET', path: '/api/tenants', pathGroup: '/api/tenants' }]);
    expect(surface.graphqlOperations).toEqual([{ operation: 'query', name: 'getChats' }]);
    expect(surface.derivedAt).toBe('2026-07-24T12:00:00.000Z');
    expect(surface.graphHash).toHaveLength(16);
  });

  it('is deterministic — same graph, same surface', () => {
    expect(buildSurface(graph(), '/r')).toEqual(buildSurface(graph(), '/r'));
  });
});

describe('write/read/siblings', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pf-surface-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function vaultProject(name: string, repoPath: string): void {
    const dir = join(base, 'projects', name, 'flow', 'brain', '.structure');
    mkdirSync(dir, { recursive: true });
    writeSurface(dir, buildSurface(graph(), repoPath));
  }

  it('round-trips through the structure dir', () => {
    const dir = join(base, 'projects', 'p', 'flow', 'brain', '.structure');
    mkdirSync(dir, { recursive: true });
    expect(writeSurface(dir, buildSurface(graph(), '/repos/p'))).toBeNull();
    const read = readSurface(join(dir, SURFACE_FILENAME));
    expect(read?.project).toBe('p');
  });

  it('lists siblings, excludes self, reports surface-less projects', () => {
    vaultProject('orbit-core', '/repos/orbit-core');
    vaultProject('orbit-app', '/repos/orbit-app');
    // a vault project that never published a surface
    mkdirSync(join(base, 'projects', 'storefront', 'flow'), { recursive: true });
    const { surfaces, skipped, source } = readSiblingSurfaces(base, '/repos/orbit-app', { workspace: null });
    expect(source).toBe('vault');
    expect(surfaces.map((s) => s.project)).toEqual(['orbit-core']);
    expect(skipped).toEqual(['storefront (no surface published — derive it once)']);
  });

  it('corrupt surface skips fail-soft', () => {
    const dir = join(base, 'projects', 'bad', 'flow', 'brain', '.structure');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SURFACE_FILENAME), '{broken');
    const { surfaces, skipped } = readSiblingSurfaces(base, '/elsewhere', { workspace: null });
    expect(surfaces).toEqual([]);
    expect(skipped[0]).toContain('bad');
  });
});

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

describeWithGit('siblings in a Workspace', () => {
  let sandbox: string;
  let flowFolder: string;
  let savedGitConfig: string | undefined;
  let savedNoSystem: string | undefined;

  function makeRepo(name: string, origin: string): string {
    const path = join(sandbox, 'code', name);
    mkdirSync(path, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', origin]]) {
      const result = spawnSync('git', args, { cwd: path, encoding: 'utf-8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    return path;
  }

  function publish(repo: string): void {
    const dir = join(repo, 'flow', 'brain', '.structure');
    mkdirSync(dir, { recursive: true });
    writeSurface(dir, buildSurface(graph(), repo));
  }

  beforeEach(() => {
    savedGitConfig = process.env.GIT_CONFIG_GLOBAL;
    savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-surface-ws-')));
    flowFolder = join(sandbox, 'plan-flow');
    writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test\n\temail = t@example.com\n');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });

  afterEach(() => {
    if (savedGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGitConfig;
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('reads the Workspace projects — not the vault — including one with no checkout here', () => {
    createWorkspace({ flowFolder, name: 'Team' });
    const app = makeRepo('orbit-app', 'https://github.com/acme/orbit-app.git');
    const core = makeRepo('orbit-core', 'https://github.com/acme/orbit-core.git');
    const away = makeRepo('orbit-jobs', 'https://github.com/acme/orbit-jobs.git');
    const silent = makeRepo('orbit-docs', 'https://github.com/acme/orbit-docs.git');
    for (const repo of [app, core, away, silent]) linkRepo({ flowFolder, target: repo });
    publish(app);
    publish(core);
    publish(away);
    // The jobs checkout is gone from this machine; its knowledge folder is not.
    rmSync(away, { recursive: true, force: true });

    // A vault project that is NOT in the Workspace must not be read.
    const vault = join(sandbox, 'vault');
    const outsider = join(vault, 'projects', 'outsider', 'flow', 'brain', '.structure');
    mkdirSync(outsider, { recursive: true });
    writeSurface(outsider, buildSurface(graph(), '/repos/outsider'));

    const { surfaces, skipped, source } = readSiblingSurfaces(vault, app, { flowFolder });
    expect(source).toBe('workspace');
    expect(surfaces.map((surface) => surface.project).sort()).toEqual(['orbit-core', 'orbit-jobs']);
    expect(skipped).toEqual(['orbit-docs (no surface published — derive it once)']);
  });

  it('falls back to the vault scan for a repo in no Workspace', () => {
    createWorkspace({ flowFolder, name: 'Team' });
    const loner = makeRepo('loner', 'https://github.com/acme/loner.git');
    const vault = join(sandbox, 'vault');
    const dir = join(vault, 'projects', 'orbit-core', 'flow', 'brain', '.structure');
    mkdirSync(dir, { recursive: true });
    writeSurface(dir, buildSurface(graph(), '/repos/orbit-core'));
    const { surfaces, source } = readSiblingSurfaces(vault, loner, { flowFolder });
    expect(source).toBe('vault');
    expect(surfaces.map((surface) => surface.project)).toEqual(['orbit-core']);
  });
});
