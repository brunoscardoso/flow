/**
 * Tests for the native extractor pipeline (`runExtractors`) against a fixture
 * mini-repo — integrations (SDK dep + literal-host HTTP call + webhook mount),
 * endpoints (express route + commander commands), datastores (migrations dir
 * with CREATE TABLE + client dep), modules (cross-module import + attribution
 * edges), coverage counts, determinism, and unreadable-file tolerance.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSpineRoots, runExtractors } from './index.js';
import { walkRepo } from './scan.js';
import { validateCanonicalGraph } from '../validate.js';
import type { BlueprintGraph } from '../types.js';

describe('runExtractors', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'blueprint-extractors-test-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // ── Fixture mini-repo ────────────────────────────────────

  function writeFixture(root: string, relPath: string, content: string): void {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, '..'), { recursive: true });
    writeFileSync(absPath, content, 'utf-8');
  }

  function buildFixtureRepo(root: string): void {
    writeFixture(
      root,
      'package.json',
      JSON.stringify({
        name: 'fixture-app',
        dependencies: {
          stripe: '^12.0.0',
          'better-sqlite3': '^11.0.0',
          express: '^4.18.0',
          commander: '^11.0.0',
        },
      }),
    );

    writeFixture(
      root,
      'src/api/server.ts',
      [
        "import { helper } from '../lib/helper.js';",
        '',
        'const app = createApp();',
        '',
        "app.get('/users', (req, res) => {",
        '  res.json(helper());',
        '});',
        '',
        "app.post('/stripe/webhook', (req, res) => {",
        '  res.sendStatus(200);',
        '});',
        '',
        'export async function chargeCustomer(): Promise<void> {',
        "  await fetch('https://api.stripe.com/v1/charges');",
        "  await fetch('http://localhost:3000/health');",
        '}',
        '',
      ].join('\n'),
    );

    writeFixture(
      root,
      'src/lib/helper.ts',
      ["export function helper(): string {", "  return 'ok';", '}', ''].join('\n'),
    );

    writeFixture(
      root,
      'src/cli/main.ts',
      [
        "import { Command } from 'commander';",
        '',
        'const program = new Command();',
        "program.command('init [dir]');",
        "program.command('derive');",
        '',
      ].join('\n'),
    );

    writeFixture(
      root,
      'migrations/001_init.sql',
      ['CREATE TABLE users (id INTEGER PRIMARY KEY);', 'CREATE TABLE IF NOT EXISTS orders (id INTEGER);', ''].join(
        '\n',
      ),
    );
  }

  const EXPECTED_NODE_IDS = [
    'datastore:migrations:migrations',
    'datastore:sqlite',
    'endpoint:GET /users',
    'endpoint:POST /stripe/webhook',
    'endpoint:cli derive',
    'endpoint:cli init',
    'integration:api.stripe.com',
    'integration:stripe',
    'integration:webhook:/stripe/webhook',
    'module:src', // the spine root itself is a depth-1 module node
    'module:src/api',
    'module:src/cli',
    'module:src/lib',
  ];

  const EXPECTED_EDGES = [
    // The contains spine hangs every child dir off the depth-1 root `src`
    { source: 'module:src', target: 'module:src/api', relation: 'contains' },
    { source: 'module:src', target: 'module:src/cli', relation: 'contains' },
    { source: 'module:src', target: 'module:src/lib', relation: 'contains' },
    { source: 'module:src/api', target: 'endpoint:GET /users', relation: 'exposes' },
    { source: 'module:src/api', target: 'endpoint:POST /stripe/webhook', relation: 'exposes' },
    { source: 'module:src/api', target: 'integration:api.stripe.com', relation: 'uses' },
    { source: 'module:src/api', target: 'integration:webhook:/stripe/webhook', relation: 'uses' },
    { source: 'module:src/api', target: 'module:src/lib', relation: 'imports' },
    { source: 'module:src/cli', target: 'endpoint:cli derive', relation: 'exposes' },
    { source: 'module:src/cli', target: 'endpoint:cli init', relation: 'exposes' },
  ];

  // ── Nodes ────────────────────────────────────────────────

  it('should derive exactly the expected node ids and kinds from the fixture repo', () => {
    buildFixtureRepo(repoRoot);
    const result = runExtractors(repoRoot);

    expect([...result.nodes.map((node) => node.id)].sort()).toEqual([...EXPECTED_NODE_IDS].sort());

    const kindOf = new Map(result.nodes.map((node) => [node.id, node.kind]));
    expect(kindOf.get('integration:stripe')).toBe('integration');
    expect(kindOf.get('integration:api.stripe.com')).toBe('integration');
    expect(kindOf.get('integration:webhook:/stripe/webhook')).toBe('integration');
    expect(kindOf.get('endpoint:GET /users')).toBe('endpoint');
    expect(kindOf.get('endpoint:cli init')).toBe('endpoint');
    expect(kindOf.get('datastore:sqlite')).toBe('datastore');
    expect(kindOf.get('datastore:migrations:migrations')).toBe('datastore');
    expect(kindOf.get('module:src/api')).toBe('module');
  });

  it('should give module nodes path ids, basename labels, and depth/childDirs/fileCount meta', () => {
    buildFixtureRepo(repoRoot);
    const result = runExtractors(repoRoot);
    const byId = new Map(result.nodes.map((node) => [node.id, node]));

    // Root-as-depth-1 semantics: `module:src` IS the spine root (depth 1);
    // its child directories carry depth 2.
    expect(byId.get('module:src')).toMatchObject({
      label: 'src',
      sourceFile: 'src',
      meta: { depth: 1, childDirs: 3, fileCount: 0 },
    });
    expect(byId.get('module:src/api')).toMatchObject({
      label: 'api',
      sourceFile: 'src/api',
      meta: { depth: 2, childDirs: 0, fileCount: 1 },
    });
    expect(byId.get('module:src/api')?.meta?.rolledUp).toBeUndefined();
  });

  it('should exclude localhost HTTP calls from integrations', () => {
    buildFixtureRepo(repoRoot);
    const result = runExtractors(repoRoot);

    expect(result.nodes.some((node) => node.id.includes('localhost'))).toBe(false);
  });

  it('should attach node details: SDK label, HTTP-call source file, route meta, and tables', () => {
    buildFixtureRepo(repoRoot);
    const result = runExtractors(repoRoot);
    const byId = new Map(result.nodes.map((node) => [node.id, node]));

    expect(byId.get('integration:stripe')).toMatchObject({ label: 'Stripe', sourceFile: 'package.json' });
    expect(byId.get('integration:api.stripe.com')).toMatchObject({
      label: 'api.stripe.com',
      sourceFile: 'src/api/server.ts',
    });
    expect(byId.get('endpoint:GET /users')?.meta).toMatchObject({ method: 'GET', route: '/users' });
    expect(byId.get('endpoint:cli init')?.sourceFile).toBe('src/cli/main.ts');
    expect(byId.get('datastore:migrations:migrations')?.meta?.tables).toEqual(['orders', 'users']);
    expect(byId.get('datastore:sqlite')).toMatchObject({ sourceFile: 'package.json', meta: { client: 'better-sqlite3' } });
  });

  // ── Edges ────────────────────────────────────────────────

  it('should derive exactly the expected attribution and import edges', () => {
    buildFixtureRepo(repoRoot);
    const result = runExtractors(repoRoot);

    expect(result.edges).toHaveLength(EXPECTED_EDGES.length);
    expect(result.edges).toEqual(expect.arrayContaining(EXPECTED_EDGES));
  });

  // ── Folder tree (hierarchical module nodes) ──────────────

  describe('folder tree', () => {
    function buildNestedRepo(root: string): void {
      writeFixture(root, 'package.json', JSON.stringify({ name: 'nested-app' }));
      writeFixture(root, 'src/root.ts', 'export const loose = true;\n');
      writeFixture(root, 'src/app/index.ts', "import { x } from './sub/x.js';\nexport const app = x;\n");
      writeFixture(root, 'src/app/sub/x.ts', "app.get('/nested', handler);\nexport const x = 1;\n");
      writeFixture(root, 'src/app/sub/deep/y.ts', 'export const y = 2;\n');
      // Root-as-depth-1: `src` itself is depth 1, so these sit at chain
      // depths 5 and 6 — beyond MODULE_TREE_DEPTH_CAP, both roll into the
      // depth-4 ancestor `src/app/sub/deep`
      writeFixture(root, 'src/app/sub/deep/deeper/z.ts', 'export const z = 3;\n');
      writeFixture(root, 'src/app/sub/deep/deeper/beyond/w.ts', 'export const w = 4;\n');
    }

    it('should emit the folder tree: path ids, depths, file counts, and depth-cap rollup', () => {
      buildNestedRepo(repoRoot);
      const result = runExtractors(repoRoot);
      const modules = new Map(
        result.nodes.filter((node) => node.kind === 'module').map((node) => [node.id, node]),
      );

      // The cap is root + 3 directories: `deeper` (old depth-4 under the
      // pre-multi-root semantics) now rolls up one level shallower, into deep
      expect([...modules.keys()].sort()).toEqual([
        'module:src',
        'module:src/app',
        'module:src/app/sub',
        'module:src/app/sub/deep',
      ]);

      // The spine root is the depth-1 node; its loose file is its own fileCount
      expect(modules.get('module:src')).toMatchObject({
        label: 'src',
        sourceFile: 'src',
        meta: { depth: 1, childDirs: 1, fileCount: 1 },
      });
      expect(modules.get('module:src/app')).toMatchObject({
        label: 'app',
        sourceFile: 'src/app',
        meta: { depth: 2, childDirs: 1, fileCount: 1 },
      });
      expect(modules.get('module:src/app/sub')?.meta).toMatchObject({ depth: 3, childDirs: 1, fileCount: 1 });

      // Depth-4 node absorbs the deeper files: fileCount includes them, rolledUp set
      expect(modules.get('module:src/app/sub/deep')?.meta).toMatchObject({
        depth: 4,
        childDirs: 0,
        fileCount: 3,
        rolledUp: true,
      });
      expect(result.nodes.some((node) => node.id.includes('deeper'))).toBe(false);
      expect(result.nodes.some((node) => node.id.includes('beyond'))).toBe(false);

      // Non-rolled-up nodes carry no rolledUp flag
      expect(modules.get('module:src/app')?.meta?.rolledUp).toBeUndefined();
    });

    it('should emit the contains spine in parent → child direction', () => {
      buildNestedRepo(repoRoot);
      const result = runExtractors(repoRoot);
      const contains = result.edges.filter((edge) => edge.relation === 'contains');

      expect(contains).toEqual([
        { source: 'module:src', target: 'module:src/app', relation: 'contains' },
        { source: 'module:src/app', target: 'module:src/app/sub', relation: 'contains' },
        { source: 'module:src/app/sub', target: 'module:src/app/sub/deep', relation: 'contains' },
      ]);
    });

    it('should attribute exposes edges and imports to the DEEPEST containing folder node', () => {
      buildNestedRepo(repoRoot);
      const result = runExtractors(repoRoot);

      // The endpoint detected in src/app/sub/x.ts belongs to module:src/app/sub — not src/app
      expect(result.edges).toContainEqual({
        source: 'module:src/app/sub',
        target: 'endpoint:GET /nested',
        relation: 'exposes',
      });
      expect(
        result.edges.some((edge) => edge.source === 'module:src/app' && edge.relation === 'exposes'),
      ).toBe(false);

      // Import from src/app/index.ts into src/app/sub/x.ts links the deepest folders
      expect(result.edges).toContainEqual({
        source: 'module:src/app',
        target: 'module:src/app/sub',
        relation: 'imports',
      });
    });

    it('should be deterministic on the nested tree — two runs produce identical output', () => {
      buildNestedRepo(repoRoot);

      const first = runExtractors(repoRoot);
      const second = runExtractors(repoRoot);

      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });
  });

  // ── Pinned capability directories (feature-blueprint) ────
  //
  // A directory the repo NAMES after a capability must become a module node
  // even when the depth cap or the spine-root filter would drop it. Regression
  // guard for the real failure: on a Next.js product only 19% of feature
  // anchors resolved, because `src/app/app/(protected)/playbooks` is depth 5
  // and `e2e/tests/playbooks` is outside every source root. Both are named in
  // two planes, so both ARE capabilities — the map simply could not say so.

  describe('pinned capability directories', () => {
    /** A repo naming `playbooks` in three planes: page, api route, e2e suite. */
    function buildCapabilityRepo(root: string): void {
      writeFixture(root, 'package.json', JSON.stringify({ name: 'cap-app' }));
      // depth 5 under `src` — past MODULE_TREE_DEPTH_CAP
      writeFixture(root, 'src/app/app/(protected)/playbooks/page.tsx', 'export const P = 1;\n');
      // depth 5 as well, via the api plane
      writeFixture(root, 'src/app/api/external/playbooks/route.ts', 'export const R = 2;\n');
      // outside every spine root entirely
      writeFixture(root, 'e2e/tests/playbooks/create.spec.ts', 'export const S = 3;\n');
    }

    it('should keep a capability directory that sits BELOW the depth cap', () => {
      buildCapabilityRepo(repoRoot);
      const ids = new Set(runExtractors(repoRoot).nodes.map((node) => node.id));

      expect(ids.has('module:src/app/app/(protected)/playbooks')).toBe(true);
      expect(ids.has('module:src/app/api/external/playbooks')).toBe(true);
    });

    it('should keep a capability directory OUTSIDE every spine root, with its ancestors', () => {
      buildCapabilityRepo(repoRoot);
      const ids = new Set(runExtractors(repoRoot).nodes.map((node) => node.id));

      // The suite dir itself, plus the chain that makes `contains` connected.
      expect(ids.has('module:e2e/tests/playbooks')).toBe(true);
      expect(ids.has('module:e2e/tests')).toBe(true);
      expect(ids.has('module:e2e')).toBe(true);
    });

    it('should leave the contains spine connected through a pinned dir', () => {
      buildCapabilityRepo(repoRoot);
      const result = runExtractors(repoRoot);
      const contains = result.edges.filter((edge) => edge.relation === 'contains');

      // Every module except a depth-1 root must have exactly one parent edge,
      // or the board renders an orphan.
      const parented = new Set(contains.map((edge) => edge.target));
      const roots = result.nodes
        .filter((node) => node.kind === 'module' && node.meta?.depth === 1)
        .map((node) => node.id);
      for (const node of result.nodes.filter((n) => n.kind === 'module')) {
        if (roots.includes(node.id)) continue;
        expect(parented.has(node.id)).toBe(true);
      }
      expect(contains).toContainEqual({
        source: 'module:e2e/tests',
        target: 'module:e2e/tests/playbooks',
        relation: 'contains',
      });
    });

    it('should still cap an ordinary directory that no capability names', () => {
      buildCapabilityRepo(repoRoot);
      // Same depth as the pinned page dir, but named by nothing.
      writeFixture(repoRoot, 'src/app/app/(protected)/internals/util/deep.ts', 'export const D = 4;\n');
      const ids = new Set(runExtractors(repoRoot).nodes.map((node) => node.id));

      expect(ids.has('module:src/app/app/(protected)/internals')).toBe(false);
      expect(ids.has('module:src/app/app/(protected)')).toBe(true);
    });

    it('should report the pinned count in coverage notes', () => {
      buildCapabilityRepo(repoRoot);
      const notes = runExtractors(repoRoot).coverageNotes;

      expect(notes.some((note) => /capability dir\(s\) pinned past the depth cap/.test(note))).toBe(true);
    });

    it('should stay deterministic with pinned dirs — two runs are byte-identical', () => {
      buildCapabilityRepo(repoRoot);

      expect(JSON.stringify(runExtractors(repoRoot))).toBe(JSON.stringify(runExtractors(repoRoot)));
    });

    // THE SEAM TEST. Every other test here calls runExtractors directly, so a
    // whole suite went green while real derives died: pinned dirs emit depth-5
    // and depth-6 nodes, and the canonical validator's ceiling still mirrored
    // the default depth cap of 4. Contract violations are the one thing derive
    // fails HARD on, so the graph was written as nothing — 29 errors, no map.
    // Extractor output must be validated the way derive validates it.
    it('should produce a graph that satisfies the canonical contract', () => {
      buildCapabilityRepo(repoRoot);
      const result = runExtractors(repoRoot);
      const graph: BlueprintGraph = {
        version: 1,
        derivedAt: '2026-08-03T00:00:00.000Z',
        coverage: result.coverage,
        nodes: result.nodes,
        edges: result.edges,
      };

      const validation = validateCanonicalGraph(graph);
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
      // …and it really did exercise the deep case, or the test proves nothing.
      const depths = result.nodes
        .filter((node) => node.kind === 'module')
        .map((node) => Number(node.meta?.depth ?? 0));
      expect(Math.max(...depths)).toBeGreaterThan(4);
    });
  });

  // ── tsconfig path-alias imports ──────────────────────────

  describe('tsconfig path-alias imports', () => {
    function buildAliasedRepo(root: string): void {
      writeFixture(root, 'package.json', JSON.stringify({ name: 'aliased-app' }));
      writeFixture(
        root,
        'tsconfig.json',
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      );
      writeFixture(
        root,
        'src/api/server.ts',
        [
          "import { sendMail } from '@/lib/mailer';", // alias → module:src/lib
          "import { useState } from 'react';", // bare package → no edge
          "import { helper } from '../lib/helper.js';", // relative → module:src/lib (unchanged)
          'export const start = () => sendMail(helper(useState));',
        ].join('\n'),
      );
      writeFixture(root, 'src/lib/mailer.ts', 'export const sendMail = () => 1;\n');
      writeFixture(root, 'src/lib/helper.ts', 'export const helper = (x: unknown) => x;\n');
    }

    it('should emit a module→module imports edge for an aliased (@/…) import', () => {
      buildAliasedRepo(repoRoot);
      const result = runExtractors(repoRoot);

      expect(result.edges).toContainEqual({
        source: 'module:src/api',
        target: 'module:src/lib',
        relation: 'imports',
      });
    });

    it('should not emit an imports edge for a bare package import (react)', () => {
      buildAliasedRepo(repoRoot);
      const result = runExtractors(repoRoot);

      const importEdges = result.edges.filter((edge) => edge.relation === 'imports');
      // The only imports edge is src/api → src/lib; nothing resolves to a `react` module.
      expect(importEdges).toEqual([
        { source: 'module:src/api', target: 'module:src/lib', relation: 'imports' },
      ]);
      expect(result.nodes.some((node) => node.id.includes('react'))).toBe(false);
    });
  });

  // ── Spine-root discovery ─────────────────────────────────

  describe('discoverSpineRoots', () => {
    it('should expand string[] workspaces globs, preferring <match>/src when it has source files', () => {
      writeFixture(repoRoot, 'package.json', JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }));
      writeFixture(repoRoot, 'packages/a/src/index.ts', 'export const a = 1;\n');
      writeFixture(repoRoot, 'packages/b/src/index.ts', 'export const b = 2;\n');

      expect(discoverSpineRoots(repoRoot)).toEqual(['packages/a/src', 'packages/b/src']);
    });

    it('should accept the { packages: string[] } workspaces object form', () => {
      writeFixture(
        repoRoot,
        'package.json',
        JSON.stringify({ name: 'mono', workspaces: { packages: ['packages/*'] } }),
      );
      writeFixture(repoRoot, 'packages/a/src/index.ts', 'export const a = 1;\n');

      expect(discoverSpineRoots(repoRoot)).toEqual(['packages/a/src']);
    });

    it('should fall back to the workspace dir itself when it has no src subtree with source files', () => {
      writeFixture(repoRoot, 'package.json', JSON.stringify({ name: 'mono', workspaces: ['services/*'] }));
      writeFixture(repoRoot, 'services/a/src/index.ts', 'export const a = 1;\n'); // has src → prefer it
      writeFixture(repoRoot, 'services/b/main.ts', 'export const b = 2;\n'); // no src → dir itself

      expect(discoverSpineRoots(repoRoot)).toEqual(['services/a/src', 'services/b']);
    });

    it('should discover conventional roots (src, app/src, lib) without a package.json', () => {
      writeFixture(repoRoot, 'src/x.ts', 'export const x = 1;\n');
      writeFixture(repoRoot, 'app/src/y.ts', 'export const y = 2;\n');
      writeFixture(repoRoot, 'lib/z.ts', 'export const z = 3;\n');

      expect(discoverSpineRoots(repoRoot)).toEqual(['app/src', 'lib', 'src']);
    });

    it('should require source files in the candidate subtree and exclude ignored build outputs', () => {
      writeFixture(repoRoot, 'src/README.md', 'docs only — no source files\n');
      writeFixture(repoRoot, 'lib/z.ts', 'export const z = 3;\n');
      // dist/ is on the walk's ignore list — its .js files never count
      writeFixture(repoRoot, 'dist/bundle.js', 'module.exports = {};\n');

      expect(discoverSpineRoots(repoRoot)).toEqual(['lib']);
    });

    it('should drop candidates nested inside an already-selected root (outermost wins)', () => {
      writeFixture(repoRoot, 'package.json', JSON.stringify({ name: 'nested', workspaces: ['src', 'src/legacy'] }));
      writeFixture(repoRoot, 'src/x.ts', 'export const x = 1;\n');
      writeFixture(repoRoot, 'src/legacy/old.ts', 'export const old = true;\n');

      expect(discoverSpineRoots(repoRoot)).toEqual(['src']);
    });

    it('should fall back to repo-root directories with source files when nothing matches', () => {
      writeFixture(repoRoot, 'server/main.ts', 'export const main = 1;\n');
      writeFixture(repoRoot, 'tools/gen.mjs', 'export const gen = 2;\n');
      writeFixture(repoRoot, 'docs/readme.md', 'no source here\n');

      expect(discoverSpineRoots(repoRoot)).toEqual(['server', 'tools']);
    });

    it('should return no roots when the repo has no source files in any directory', () => {
      writeFixture(repoRoot, 'notes.md', 'just docs\n');
      writeFixture(repoRoot, 'loose.ts', 'export const loose = 1;\n'); // root-level file — not a dir

      expect(discoverSpineRoots(repoRoot)).toEqual([]);
    });

    it('should be deterministic and sorted across repeated calls', () => {
      writeFixture(repoRoot, 'package.json', JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }));
      writeFixture(repoRoot, 'packages/z/src/index.ts', 'export const z = 1;\n');
      writeFixture(repoRoot, 'packages/a/src/index.ts', 'export const a = 2;\n');
      writeFixture(repoRoot, 'src/x.ts', 'export const x = 3;\n');

      const first = discoverSpineRoots(repoRoot);
      const second = discoverSpineRoots(repoRoot);

      expect(first).toEqual(['packages/a/src', 'packages/z/src', 'src']);
      expect(first).toEqual([...first].sort());
      expect(second).toEqual(first);
    });
  });

  // ── Coverage ─────────────────────────────────────────────

  it('should report coverage counts and non-empty coverage notes', () => {
    buildFixtureRepo(repoRoot);
    const result = runExtractors(repoRoot);

    // Source files: server.ts, helper.ts, main.ts (package.json and .sql are not source files)
    expect(result.coverage).toEqual({
      filesScanned: 3,
      filesTotal: 3,
      extractorsRun: ['integrations', 'endpoints', 'datastores', 'modules', 'nextjs', 'graphql', 'fastapi'],
      graphifyEnriched: false,
    });

    expect(result.coverageNotes.length).toBeGreaterThan(0);
    expect(result.coverageNotes.some((note) => note.startsWith('scan: 3/3'))).toBe(true);
    expect(result.coverageNotes.some((note) => note.startsWith('integrations:'))).toBe(true);
    expect(result.coverageNotes.some((note) => note.startsWith('endpoints:'))).toBe(true);
    expect(result.coverageNotes.some((note) => note.startsWith('datastores:'))).toBe(true);
    expect(result.coverageNotes.some((note) => note.startsWith('modules:'))).toBe(true);
  });

  // ── Determinism ──────────────────────────────────────────

  it('should be deterministic — two runs produce deep-equal output', () => {
    buildFixtureRepo(repoRoot);

    const first = runExtractors(repoRoot);
    const second = runExtractors(repoRoot);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('should skip ignored directories (node_modules, dist, hidden)', () => {
    buildFixtureRepo(repoRoot);
    writeFixture(repoRoot, 'node_modules/evil/index.js', "app.get('/from-node-modules', handler);\n");
    writeFixture(repoRoot, 'dist/bundle.js', "app.get('/from-dist', handler);\n");
    writeFixture(repoRoot, '.hidden/sneaky.ts', "app.get('/from-hidden', handler);\n");

    const result = runExtractors(repoRoot);

    expect(result.nodes.some((node) => node.id.includes('from-node-modules'))).toBe(false);
    expect(result.nodes.some((node) => node.id.includes('from-dist'))).toBe(false);
    expect(result.nodes.some((node) => node.id.includes('from-hidden'))).toBe(false);
    expect(result.coverage.filesTotal).toBe(3);
  });

  // ── Unreadable-file tolerance ────────────────────────────

  it('should tolerate unreadable source files (counted, never thrown on)', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // Running as root — chmod 000 does not block reads, so the scenario
      // cannot be produced; skip rather than assert a vacuous truth.
      return;
    }

    writeFixture(repoRoot, 'src/app/readable.ts', 'export const ok = true;\n');
    writeFixture(repoRoot, 'src/app/unreadable.ts', 'export const hidden = true;\n');
    chmodSync(join(repoRoot, 'src/app/unreadable.ts'), 0o000);

    try {
      const result = runExtractors(repoRoot);

      expect(result.coverage.filesTotal).toBe(2);
      expect(result.coverage.filesScanned).toBe(1);
      expect(result.coverageNotes.some((note) => note.includes('unreadable'))).toBe(true);
    } finally {
      chmodSync(join(repoRoot, 'src/app/unreadable.ts'), 0o644);
    }
  });

  // ── Shared repo scan pass-through ────────────────────────

  describe('shared repo scan (single walk)', () => {
    it('produces identical output whether the scan is pre-computed or walked internally', () => {
      buildFixtureRepo(repoRoot);
      const scan = walkRepo(repoRoot);
      expect(JSON.stringify(runExtractors(repoRoot, scan))).toBe(JSON.stringify(runExtractors(repoRoot)));
    });

    it('threads the provided scan into every consumer — no extractor re-walks the repo', () => {
      buildFixtureRepo(repoRoot);
      const full = walkRepo(repoRoot);
      // Omit src/cli from the scan while its files stay on disk: any consumer
      // that re-walked (endpoints, modules, spine discovery, coverage counts)
      // would still see them; consumers of the shared scan cannot.
      const filtered = {
        files: full.files.filter((relPath) => !relPath.startsWith('src/cli/')),
        unreadableDirs: [],
      };

      const result = runExtractors(repoRoot, filtered);
      const nodeIds = result.nodes.map((node) => node.id);
      expect(nodeIds).not.toContain('endpoint:cli init'); // endpoints extractor
      expect(nodeIds).not.toContain('endpoint:cli derive');
      expect(nodeIds).not.toContain('module:src/cli'); // module spine
      expect(nodeIds).toContain('module:src/api'); // everything else intact
      expect(result.coverage.filesTotal).toBe(2); // coverage counting: server.ts + helper.ts only
    });
  });
});
