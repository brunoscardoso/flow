/**
 * Tests for the graphify backbone merge (`mergeGraphifyBackbone`) — availability
 * gating (#142), fail-soft fallback paths, directory-only rollup to native
 * modules, synthesized module conventions (validated against the canonical
 * contract), cross-module edge dedupe, depth-cap rollup, and determinism.
 *
 * Availability is `which graphify` via `node:child_process.execSync`, mocked
 * here (allowed-pattern #12) so it's deterministic on any machine. The default
 * mock leaves graphify AVAILABLE (execSync returns without throwing); the
 * unavailable path mocks it to throw. The graph itself is read from
 * `graphify-out/graph.json` — plain files in a temp repo.
 */

import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DUAL_SOURCE_EXTRACTORS, FROZEN_EXTRACTORS, validateCanonicalGraph } from './validate.js';
import type { BlueprintGraph, BlueprintNode } from './types.js';

const mockExecSync = jest.fn<(command: string, options?: unknown) => string>();
// spawn backs the graphify background-build path (#535); mock it alongside execSync
// so the shared child_process mock stays complete.
const mockSpawn = jest.fn(() => ({ on: () => undefined, unref: () => undefined }));
const mockExecFileSync = jest.fn<() => string>(() => {
  throw new Error('no git in this fixture');
});

/** Answer the gitignore query with these repo-relative directories. */
function gitIgnores(...dirs: string[]): void {
  mockExecFileSync.mockImplementation(() => dirs.map((dir) => `${dir}/`).join('\n'));
}
jest.unstable_mockModule('node:child_process', () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
  // `scan.ts` asks git which directories the repo ignores (#1588), and the
  // backbone asks the same question now (#1800). The mock must carry every
  // export the module graph imports, or the suite fails to LINK. It DEFAULTS to
  // throwing, which is the fail-soft path — no gitignore data, hardcoded list
  // still in charge — so every fixture below behaves exactly as it did before.
  execFileSync: mockExecFileSync,
}));

const { mergeGraphifyBackbone, isIgnoredSynthesisPath } = await import('./backbone.js');

describe('mergeGraphifyBackbone', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'backbone-test-'));
    // Default: graphify available (which graphify returns without throwing).
    mockExecSync.mockReset();
    // …and no git, which is the fail-soft path every fixture but the #1800 ones
    // relies on.
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no git in this fixture');
    });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // ── Helpers ──────────────────────────────────────────────

  function writeFlowConfig(content: string): void {
    mkdirSync(join(repoRoot, 'flow'), { recursive: true });
    writeFileSync(join(repoRoot, 'flow', '.flowconfig'), content, 'utf-8');
  }

  function writeGraphifyExport(content: string): void {
    mkdirSync(join(repoRoot, 'graphify-out'), { recursive: true });
    writeFileSync(join(repoRoot, 'graphify-out', 'graph.json'), content, 'utf-8');
  }

  /** A module node following every native convention. */
  function moduleNode(dir: string, depth: number): BlueprintNode {
    return {
      id: `module:${dir}`,
      kind: 'module',
      label: dir.includes('/') ? dir.slice(dir.lastIndexOf('/') + 1) : dir,
      sourceFile: dir,
      meta: { depth, childDirs: 0, fileCount: 1 },
    };
  }

  /** A canonical-valid native graph: `src` spine with one child module. */
  function makeNativeGraph(): BlueprintGraph {
    return {
      version: 1,
      derivedAt: '2026-07-09T00:00:00.000Z',
      coverage: {
        filesScanned: 2,
        filesTotal: 2,
        extractorsRun: [...FROZEN_EXTRACTORS],
        graphifyEnriched: false,
      },
      nodes: [moduleNode('src', 1), moduleNode('src/cli', 2)],
      edges: [{ source: 'module:src', target: 'module:src/cli', relation: 'contains' }],
    };
  }

  /** Graphify export: TS files covered by native modules + uncovered python. */
  function makeDualLanguageExport(): string {
    return JSON.stringify({
      nodes: [
        { id: 'src/cli/main.ts::run', source_file: 'src/cli/main.ts' },
        { id: 'backend/app/api/views.py::list_users', source_file: 'backend/app/api/views.py' },
        { id: 'backend/app/models.py::User', source_file: 'backend/app/models.py' },
      ],
      links: [
        {
          source: 'src/cli/main.ts::run',
          target: 'backend/app/api/views.py::list_users',
          relation: 'calls',
        },
        {
          source: 'backend/app/api/views.py::list_users',
          target: 'backend/app/models.py::User',
          relation: 'imports',
        },
      ],
    });
  }

  // ── Availability gating (#142) ───────────────────────────

  it('is a silent no-op when graphify is not on PATH (native-only)', () => {
    // Availability, not config, gates now: `which graphify` throws → unavailable
    // → silent no-op (enrichment owns the single "not installed" notice).
    mockExecSync.mockImplementation((command: string) => {
      throw new Error(`command failed: ${command}`);
    });
    const input = makeNativeGraph();

    const result = mergeGraphifyBackbone(input, repoRoot);

    expect(result).toEqual({
      graph: input,
      notice: null,
      merged: false,
      synthesizedModuleCount: 0,
      ignoredSynthesisFileCount: 0,
      crossModuleEdgeCount: 0,
    });
    expect(result.graph).toBe(input);
  });

  it('merges despite a legacy `declined` config when graphify is available (always-on)', () => {
    // Config value is ignored — graphify available + a graph present → merge.
    writeFlowConfig('engines.graphify: declined\n');
    writeGraphifyExport(makeDualLanguageExport());
    const input = makeNativeGraph();

    const result = mergeGraphifyBackbone(input, repoRoot);

    expect(result.merged).toBe(true);
  });

  // ── Fail-soft notice paths ───────────────────────────────

  it('should fall back with a notice when graphify-out/graph.json is missing', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    const input = makeNativeGraph();

    const result = mergeGraphifyBackbone(input, repoRoot);

    expect(result.graph).toBe(input);
    expect(result.merged).toBe(false);
    expect(result.notice).toBe(
      'graphify backbone unavailable (no graph at graphify-out/graph.json) — continuing with native structure.',
    );
    // Fail-soft leaves the native extractor set untouched
    expect(result.graph.coverage.extractorsRun).toEqual([...FROZEN_EXTRACTORS]);
  });

  it('should fall back with a notice when the graph file is unparsable JSON', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport('this is { not json');
    const input = makeNativeGraph();

    const result = mergeGraphifyBackbone(input, repoRoot);

    expect(result.graph).toBe(input);
    expect(result.merged).toBe(false);
    expect(result.notice).toBe(
      'graphify backbone unavailable (unparsable graph at graphify-out/graph.json) — continuing with native structure.',
    );
  });

  it('should fall back with a notice when the graph file is not a node/edge graph', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(JSON.stringify({ nodes: 'not-an-array' }));
    const input = makeNativeGraph();

    const result = mergeGraphifyBackbone(input, repoRoot);

    expect(result.graph).toBe(input);
    expect(result.notice).toContain('unparsable graph');
  });

  // ── Backbone merge ───────────────────────────────────────

  it('should synthesize module nodes for uncovered directories following all module conventions', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeDualLanguageExport());
    const input = makeNativeGraph();

    const result = mergeGraphifyBackbone(input, repoRoot);

    expect(result.notice).toBeNull();
    expect(result.merged).toBe(true);
    expect(result.synthesizedModuleCount).toBe(3);

    const byId = new Map(result.graph.nodes.map((node) => [node.id, node]));
    // Synthesized depth-1 root outside every native spine root
    expect(byId.get('module:backend')).toMatchObject({
      kind: 'module',
      label: 'backend',
      sourceFile: 'backend',
      meta: { depth: 1, childDirs: 1, fileCount: 0, backbone: true },
    });
    expect(byId.get('module:backend/app')).toMatchObject({
      label: 'app',
      sourceFile: 'backend/app',
      meta: { depth: 2, childDirs: 1, fileCount: 1 },
    });
    expect(byId.get('module:backend/app/api')).toMatchObject({
      label: 'api',
      sourceFile: 'backend/app/api',
      meta: { depth: 3, childDirs: 0, fileCount: 1 },
    });

    // Contains chain: child.depth = parent.depth + 1 all the way down
    expect(result.graph.edges).toContainEqual({
      source: 'module:backend',
      target: 'module:backend/app',
      relation: 'contains',
    });
    expect(result.graph.edges).toContainEqual({
      source: 'module:backend/app',
      target: 'module:backend/app/api',
      relation: 'contains',
    });

    // Directory-only rollup: NO file-level nodes, ever
    for (const node of result.graph.nodes) {
      expect(node.kind === 'module' ? node.sourceFile.includes('.') : false).toBe(false);
    }
  });

  it('should produce a merged graph that passes the canonical validator with the dual-source set', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeDualLanguageExport());

    const result = mergeGraphifyBackbone(makeNativeGraph(), repoRoot);

    expect(result.graph.coverage.extractorsRun).toEqual([...DUAL_SOURCE_EXTRACTORS]);
    expect(validateCanonicalGraph(result.graph)).toEqual({ ok: true, errors: [] });
  });

  it('should roll covered files up to the deepest native module and add cross-module edges', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeDualLanguageExport());

    const result = mergeGraphifyBackbone(makeNativeGraph(), repoRoot);

    // src/cli/main.ts is covered by module:src/cli (deepest) — no synthesis
    // under src, and the cross-module calls edge attaches there
    expect(result.graph.nodes.find((node) => node.id === 'module:src/cli/main.ts')).toBeUndefined();
    expect(result.graph.edges).toContainEqual({
      source: 'module:src/cli',
      target: 'module:backend/app/api',
      relation: 'calls',
    });
    // Cross-module imports between the two synthesized python modules
    expect(result.graph.edges).toContainEqual({
      source: 'module:backend/app/api',
      target: 'module:backend/app',
      relation: 'imports',
    });
    expect(result.crossModuleEdgeCount).toBe(2);
  });

  it('should dedupe cross-module edges against each other and the existing edge set', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(
      JSON.stringify({
        nodes: [
          { id: 'src/a.ts::one', source_file: 'src/a.ts' },
          { id: 'src/a.ts::two', source_file: 'src/a.ts' },
          { id: 'src/cli/b.ts::three', source_file: 'src/cli/b.ts' },
        ],
        links: [
          // Two graphify edges collapsing onto the SAME module pair/relation
          { source: 'src/a.ts::one', target: 'src/cli/b.ts::three', relation: 'imports' },
          { source: 'src/a.ts::two', target: 'src/cli/b.ts::three', relation: 'imports' },
          // Duplicates an edge the native graph already has
          { source: 'src/a.ts::one', target: 'src/cli/b.ts::three', relation: 'calls' },
        ],
      }),
    );
    const input = makeNativeGraph();
    input.edges.push({ source: 'module:src', target: 'module:src/cli', relation: 'calls' });

    const result = mergeGraphifyBackbone(input, repoRoot);

    const importEdges = result.graph.edges.filter(
      (edge) => edge.source === 'module:src' && edge.target === 'module:src/cli' && edge.relation === 'imports',
    );
    const callEdges = result.graph.edges.filter(
      (edge) => edge.source === 'module:src' && edge.target === 'module:src/cli' && edge.relation === 'calls',
    );
    expect(importEdges).toHaveLength(1);
    expect(callEdges).toHaveLength(1);
    expect(result.crossModuleEdgeCount).toBe(1); // only the new imports edge
    expect(result.synthesizedModuleCount).toBe(0);
  });

  it('should cap synthesized chains at depth 4 and roll deeper files up with rolledUp', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(
      JSON.stringify({
        nodes: [{ id: 'deep/a/b/c/d/e/f.py::x', source_file: 'deep/a/b/c/d/e/f.py' }],
        links: [],
      }),
    );

    const result = mergeGraphifyBackbone(makeNativeGraph(), repoRoot);

    const byId = new Map(result.graph.nodes.map((node) => [node.id, node]));
    expect(result.synthesizedModuleCount).toBe(4);
    expect(byId.get('module:deep')?.meta?.depth).toBe(1);
    expect(byId.get('module:deep/a/b/c')?.meta).toMatchObject({ depth: 4, fileCount: 1, rolledUp: true });
    expect(byId.get('module:deep/a/b/c/d')).toBeUndefined();
    expect(validateCanonicalGraph(result.graph)).toEqual({ ok: true, errors: [] });
  });

  it('should skip repo-root files (no containing directory to synthesize)', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(
      JSON.stringify({
        nodes: [{ id: 'setup.py::main', source_file: 'setup.py' }],
        links: [],
      }),
    );

    const result = mergeGraphifyBackbone(makeNativeGraph(), repoRoot);

    expect(result.merged).toBe(true);
    expect(result.synthesizedModuleCount).toBe(0);
    expect(validateCanonicalGraph(result.graph)).toEqual({ ok: true, errors: [] });
  });

  // ── Determinism and purity ───────────────────────────────

  it('should be deterministic — the same inputs twice yield byte-identical graphs', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeDualLanguageExport());

    const first = mergeGraphifyBackbone(makeNativeGraph(), repoRoot);
    const second = mergeGraphifyBackbone(makeNativeGraph(), repoRoot);

    expect(JSON.stringify(second.graph)).toBe(JSON.stringify(first.graph));
  });

  it('should never mutate the input graph', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeDualLanguageExport());
    const input = makeNativeGraph();
    const snapshot = JSON.stringify(input);

    mergeGraphifyBackbone(input, repoRoot);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('the backbone respects the repo\'s own .gitignore (#1800)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'backbone-ignore-'));
    mockExecSync.mockReset();
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no git in this fixture');
    });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeExport(files: string[]): void {
    mkdirSync(join(repoRoot, 'graphify-out'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'graphify-out', 'graph.json'),
      JSON.stringify({
        nodes: files.map((file) => ({ id: `${file}::thing`, source_file: file })),
        links: [],
      }),
      'utf-8',
    );
  }

  function emptyNativeGraph(): BlueprintGraph {
    return {
      version: 1,
      derivedAt: '2026-08-26T00:00:00.000Z',
      coverage: {
        filesScanned: 0,
        filesTotal: 0,
        extractorsRun: [...FROZEN_EXTRACTORS],
        graphifyEnriched: false,
      },
      nodes: [],
      edges: [],
    };
  }

  function moduleIds(graph: BlueprintGraph): string[] {
    return graph.nodes.filter((node) => node.kind === 'module').map((node) => node.id);
  }

  it('synthesizes no module for a directory git ignores', () => {
    // THE LIVE INSTANCE. `app/resources/cli` is written by
    // `build-cli-bundle.mjs`, is gitignored, and has zero tracked files — a copy
    // of `src/`. It arrived as three module nodes carrying `backbone: true`,
    // the highest-degree one at 5,545 edges, so blast-radius signals were
    // computed partly against a shadow codebase and `blueprint coverage` had a
    // floor no feature could honestly lift.
    gitIgnores('app/resources');
    writeExport(['app/resources/cli/index.js', 'app/resources/cli/templates/x.md']);

    const result = mergeGraphifyBackbone(emptyNativeGraph(), repoRoot);

    expect(result.merged).toBe(true);
    expect(moduleIds(result.graph)).toEqual([]);
    expect(result.synthesizedModuleCount).toBe(0);
  });

  it('still synthesizes the modules git says nothing about', () => {
    // The filter has to be a filter, not an off switch: the backbone's whole
    // job is covering directories the native extractors did not reach.
    gitIgnores('app/resources');
    writeExport(['app/resources/cli/index.js', 'backend/app/models.py']);

    const result = mergeGraphifyBackbone(emptyNativeGraph(), repoRoot);

    expect(moduleIds(result.graph)).toEqual(['module:backend', 'module:backend/app']);
  });

  it('asks the SAME question the native walk asks — one filter, two sources', () => {
    // #1588 taught the native walk to ask git instead of guessing from a
    // seven-name hardcoded list. The backbone proposes modules too and was not
    // asking, so directories the native side deliberately skipped came back in
    // through the other source. `git ls-files --others --ignored --directory`
    // is the one query; both callers read it.
    gitIgnores('app/dist', 'graphify-out', 'app/resources');
    writeExport(['app/dist/main.js', 'graphify-out/x.js', 'app/resources/cli/y.js', 'src/real.ts']);

    const result = mergeGraphifyBackbone(emptyNativeGraph(), repoRoot);

    expect(moduleIds(result.graph)).toEqual(['module:src']);
    expect(result.ignoredSynthesisFileCount).toBe(3);
  });

  it('keeps the fail-soft rule: no git leaves the hardcoded list in charge', () => {
    // The default mock throws. A blueprint derive must degrade to a coarser
    // map, never refuse to draw one — so an unanswerable gitignore query is the
    // status quo, not an empty graph.
    writeExport(['app/resources/cli/index.js']);

    const result = mergeGraphifyBackbone(emptyNativeGraph(), repoRoot);

    expect(result.merged).toBe(true);
    // The whole chain, exactly as before this change — including the node the
    // #1800 fix removes when git CAN answer.
    expect(moduleIds(result.graph)).toEqual([
      'module:app',
      'module:app/resources',
      'module:app/resources/cli',
    ]);
  });
});

describe('isIgnoredSynthesisPath (#901)', () => {
  it('ignores test/mock/fixture paths via the shared vocabulary', () => {
    expect(isIgnoredSynthesisPath('__mocks__/@apollo/client.ts')).toBe(true);
    expect(isIgnoredSynthesisPath('e2e/checkout.spec.ts')).toBe(true);
    expect(isIgnoredSynthesisPath('src/lib/redis.server.test.ts')).toBe(true);
  });

  it('ignores dot-dirs and static-asset dirs anywhere in the chain', () => {
    expect(isIgnoredSynthesisPath('.github/agents/review.md')).toBe(true);
    expect(isIgnoredSynthesisPath('.cursor/commands/x.ts')).toBe(true);
    expect(isIgnoredSynthesisPath('public/logo.svg')).toBe(true);
    expect(isIgnoredSynthesisPath('web/static/site.css')).toBe(true);
  });

  it('keeps real source paths', () => {
    expect(isIgnoredSynthesisPath('src/app/api/route.ts')).toBe(false);
    expect(isIgnoredSynthesisPath('office-addin/index.ts')).toBe(false);
    expect(isIgnoredSynthesisPath('prisma/schema.prisma')).toBe(false);
  });
});
