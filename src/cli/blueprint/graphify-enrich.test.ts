/**
 * Tests for graphify enrichment — engine gating, fail-soft fallback paths,
 * content-based staleness (dirty working tree OR commit newer than the
 * graph), last-known-good semantics on a failed stale refresh, the
 * never-initialized one-shot build, and the merge of a valid NetworkX export
 * (both `links` and `edges` key variants) into a copy of the native graph.
 *
 * No real graphify is ever invoked: `node:child_process.execSync` is mocked
 * (repo convention — see notification-router.test.ts) so `which graphify`
 * detection is deterministic on any machine. By default the mocked `git
 * status` and `git log` both throw, mirroring a fixture repo without `.git`
 * — staleness is undeterminable, so enrichment proceeds without invoking
 * `graphify update .` (the documented skip-staleness behavior, asserted
 * explicitly).
 */

import { jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BlueprintGraph } from './types.js';

const mockExecSync = jest.fn<(command: string, options?: unknown) => string>();
// Background code-graph build (#535) spawns DETACHED — mock it so no real graphify
// runs and the never-initialized path is observable. The fake child mirrors the
// bits spawnDetachedBuild touches: `.on('error', …)` and `.unref()`.
const mockSpawn = jest.fn<(command: string, args: string[], options?: unknown) => unknown>(() => ({
  on: () => undefined,
  unref: () => undefined,
}));

jest.unstable_mockModule('node:child_process', () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
  // `scan.ts` asks git which directories the repo ignores (#1588). The mock must
  // carry every export the module graph imports, or the suite fails to LINK —
  // it throws here, which is the fail-soft path (no gitignore data, hardcoded
  // list still in charge) and keeps these fixtures walking exactly as before.
  execFileSync: jest.fn(() => {
    throw new Error('no git in this fixture');
  }),
}));

// Import after mocks are set up
const { enrichWithGraphify, resolveNeverInitializedBuild } = await import('./graphify-enrich.js');
const { resolveAnchor } = await import('./anchors.js');

// ── resolveNeverInitializedBuild: the pure background-build state machine (#535) ──
describe('resolveNeverInitializedBuild (#535)', () => {
  const NOW = 1_000_000_000_000;
  function makeDeps(markerState: 'fresh' | 'stale' | 'absent', launchOk = true) {
    return {
      launch: jest.fn(() => launchOk),
      markerState: jest.fn(() => markerState),
      writeMarker: jest.fn(),
      clearMarker: jest.fn(),
    };
  }

  it('launches a build and marks it when no marker exists yet', () => {
    const deps = makeDeps('absent');
    expect(resolveNeverInitializedBuild('/repo', NOW, deps)).toBe('building');
    expect(deps.launch).toHaveBeenCalledWith('/repo');
    expect(deps.writeMarker).toHaveBeenCalledWith('/repo');
    expect(deps.clearMarker).not.toHaveBeenCalled();
  });

  it('does NOT re-launch while a fresh marker is present (build in flight)', () => {
    const deps = makeDeps('fresh');
    expect(resolveNeverInitializedBuild('/repo', NOW, deps)).toBe('building');
    expect(deps.launch).not.toHaveBeenCalled();
    expect(deps.writeMarker).not.toHaveBeenCalled();
  });

  it('reports failed and clears a stale marker so a retry can relaunch', () => {
    const deps = makeDeps('stale');
    expect(resolveNeverInitializedBuild('/repo', NOW, deps)).toBe('failed');
    expect(deps.clearMarker).toHaveBeenCalledWith('/repo');
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('still reports building even when the launch fails to spawn (marker not written)', () => {
    const deps = makeDeps('absent', false);
    expect(resolveNeverInitializedBuild('/repo', NOW, deps)).toBe('building');
    expect(deps.writeMarker).not.toHaveBeenCalled();
  });
});

describe('enrichWithGraphify', () => {
  let repoRoot: string;

  // OPTED BACK IN to fire-and-forget work (#1848). The jest setup turns it off
  // for every test, because a detached `graphify update` outlives the test and
  // writes into a temp directory the suite is deleting. THIS suite mocks
  // `node:child_process` wholesale (`mockSpawn` above), so no real process can
  // escape it — and launching that spawn is precisely what it asserts.
  const noBackground = process.env.PLANFLOW_NO_BACKGROUND_WORK;
  beforeAll(() => {
    delete process.env.PLANFLOW_NO_BACKGROUND_WORK;
  });
  afterAll(() => {
    if (noBackground !== undefined) process.env.PLANFLOW_NO_BACKGROUND_WORK = noBackground;
  });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'graphify-enrich-test-'));
    mockExecSync.mockReset();
    mockSpawn.mockClear();
    mockSpawn.mockImplementation(() => ({ on: () => undefined, unref: () => undefined }));
    // Default: tool installed, no git repo (staleness undeterminable → skipped)
    mockExecSync.mockImplementation((command: string) => {
      if (command === 'which graphify') {
        return '/stub/bin/graphify\n';
      }
      throw new Error(`command failed: ${command}`);
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

  function makeNativeGraph(): BlueprintGraph {
    return {
      version: 1,
      derivedAt: '2026-07-09T00:00:00.000Z',
      coverage: { filesScanned: 3, filesTotal: 3, extractorsRun: ['modules'], graphifyEnriched: false },
      nodes: [
        { id: 'module:core', kind: 'module', label: 'core', sourceFile: 'src/core' },
        { id: 'module:util', kind: 'module', label: 'util', sourceFile: 'src/util' },
        { id: 'integration:stripe', kind: 'integration', label: 'Stripe', sourceFile: 'src/core/a.ts' },
      ],
      edges: [{ source: 'module:core', target: 'integration:stripe', relation: 'uses' }],
    };
  }

  /** NetworkX-style export; edges land under `edgesKey` (links | edges). */
  function makeGraphifyExport(edgesKey: 'links' | 'edges'): string {
    return JSON.stringify({
      nodes: [
        { id: 'src/core/a.ts::alpha', source_file: 'src/core/a.ts', community: 1 },
        { id: 'src/core/a.ts::beta', source_file: 'src/core/a.ts', community: 2 },
        { id: 'src/util/b.ts::gamma', source_file: 'src/util/b.ts', community_id: 2 },
      ],
      [edgesKey]: [
        { source: 'src/core/a.ts::alpha', target: 'src/util/b.ts::gamma', relation: 'calls' },
        { source: 'src/core/a.ts::alpha', target: 'src/core/a.ts::beta', relation: 'imports' },
      ],
    });
  }

  function assertEnriched(result: ReturnType<typeof enrichWithGraphify>, input: BlueprintGraph): void {
    expect(result.notice).toBeNull();
    expect(result.graph).not.toBe(input);
    expect(result.graph.coverage.graphifyEnriched).toBe(true);

    const byId = new Map(result.graph.nodes.map((node) => [node.id, node]));

    // Degrees: edge1 touches core+util, edge2 touches core only (counted once)
    expect(byId.get('module:core')?.meta?.degree).toBe(2);
    expect(byId.get('module:util')?.meta?.degree).toBe(1);

    // Communities: core spans {1, 2} → joined string; util has one → native type
    expect(byId.get('module:core')?.meta?.community).toBe('1,2');
    expect(byId.get('module:util')?.meta?.community).toBe(2);

    // Anchor hints attach where node.sourceFile matches a graphify source_file
    expect(byId.get('integration:stripe')?.meta?.graphifyIds).toEqual([
      'src/core/a.ts::alpha',
      'src/core/a.ts::beta',
    ]);

    // Cross-module calls edge appended; same-module imports edge is not
    expect(result.graph.edges).toContainEqual({ source: 'module:core', target: 'module:util', relation: 'calls' });
    expect(result.graph.edges).toHaveLength(2);
  }

  // ── Always-on: config is ignored, availability gates (#142) ──

  it('enriches despite a legacy `declined` config when graphify is available', () => {
    // Always-on: the engines.graphify value no longer gates — the binary being
    // on PATH (mocked `which graphify` → success) plus an existing graph do.
    writeFlowConfig('engines.graphify: declined\n');
    writeGraphifyExport(makeGraphifyExport('links'));
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    expect(result.notice).toBeNull();
    expect(result.graph.coverage.graphifyEnriched).toBe(true);
  });

  // ── Fail-soft notice paths ───────────────────────────────

  it('should fall back with a notice when the tool is not installed', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    mockExecSync.mockImplementation((command: string) => {
      throw new Error(`command failed: ${command}`);
    });
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    expect(result.graph).toBe(input);
    expect(result.notice).toBe(
      'graphify unavailable (tool not installed — install with `uv tool install graphifyy`) — continuing with native structure.',
    );
  });

  it('should launch a BACKGROUND build when never-initialized and report building (#535)', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    // No graphify-out/graph.json yet — the first build runs for minutes on large
    // repos, so it goes to the background (detached spawn), NOT an inline execSync.
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    // Background build was launched via spawn, never a blocking `graphify update .`
    expect(mockSpawn).toHaveBeenCalledWith('graphify', ['update', '.'], expect.anything());
    expect(mockExecSync).not.toHaveBeenCalledWith('graphify update .', expect.anything());
    expect(result.graph).toBe(input);
    expect(result.build).toBe('building');
    expect(result.notice).toBe(
      'graphify: building code graph in the background — structure will fill in shortly.',
    );
    // A marker is written so the NEXT derive doesn't spawn a second build.
    expect(existsSync(join(repoRoot, 'graphify-out', '.pf-building'))).toBe(true);
  });

  it('should NOT spawn a second build while a fresh marker exists, and still report building (#535)', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    // Simulate an in-flight build: marker present and fresh, graph still absent.
    mkdirSync(join(repoRoot, 'graphify-out'), { recursive: true });
    writeFileSync(join(repoRoot, 'graphify-out', '.pf-building'), new Date().toISOString());
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result.build).toBe('building');
  });

  it('should clear the marker and report the graph once a background build lands (#535)', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    // Marker from a prior build + the graph it produced now present.
    mkdirSync(join(repoRoot, 'graphify-out'), { recursive: true });
    writeFileSync(join(repoRoot, 'graphify-out', '.pf-building'), new Date().toISOString());
    writeGraphifyExport(makeGraphifyExport('links'));
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    assertEnriched(result, input);
    expect(result.build).toBeUndefined();
    // The marker is cleaned up now that a graph exists.
    expect(existsSync(join(repoRoot, 'graphify-out', '.pf-building'))).toBe(false);
  });

  it('should fall back with a notice when the graph file is unparsable JSON', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport('this is { not json');
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    expect(result.graph).toBe(input);
    expect(result.notice).toBe(
      'graphify unavailable (unparsable graph at graphify-out/graph.json) — continuing with native structure.',
    );
  });

  it('should fall back with a notice when the graph file is not a node/edge graph', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(JSON.stringify({ nodes: 'not-an-array' }));
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    expect(result.graph).toBe(input);
    expect(result.notice).toContain('unparsable graph');
  });

  // ── Successful enrichment ────────────────────────────────

  it('should merge degree/community/graphifyIds and cross-module edges (links key variant)', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeGraphifyExport('links'));
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    assertEnriched(result, input);
    // Staleness was undeterminable (git log threw) — no refresh invoked
    expect(mockExecSync).not.toHaveBeenCalledWith('graphify update .', expect.anything());
  });

  it('should accept the older `edges` key variant', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeGraphifyExport('edges'));
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    assertEnriched(result, input);
  });

  it('should aggregate degree/community up the folder hierarchy and attach ids/edges to the deepest node', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(
      JSON.stringify({
        nodes: [
          { id: 'src/core/a.ts::alpha', source_file: 'src/core/a.ts', community: 1 },
          { id: 'src/core/sub/s.ts::sigma', source_file: 'src/core/sub/s.ts', community: 2 },
        ],
        links: [
          { source: 'src/core/a.ts::alpha', target: 'src/core/sub/s.ts::sigma', relation: 'calls' },
        ],
      }),
    );
    const input: BlueprintGraph = {
      version: 1,
      derivedAt: '2026-07-09T00:00:00.000Z',
      coverage: { filesScanned: 2, filesTotal: 2, extractorsRun: ['modules'], graphifyEnriched: false },
      nodes: [
        {
          id: 'module:src/core',
          kind: 'module',
          label: 'core',
          sourceFile: 'src/core',
          meta: { depth: 1, childDirs: 1, fileCount: 1 },
        },
        {
          id: 'module:src/core/sub',
          kind: 'module',
          label: 'sub',
          sourceFile: 'src/core/sub',
          meta: { depth: 2, childDirs: 0, fileCount: 1 },
        },
      ],
      edges: [{ source: 'module:src/core', target: 'module:src/core/sub', relation: 'contains' }],
    };

    const result = enrichWithGraphify(repoRoot, input);

    expect(result.notice).toBeNull();
    const byId = new Map(result.graph.nodes.map((node) => [node.id, node]));

    // Deepest node gets its own metrics
    expect(byId.get('module:src/core/sub')?.meta?.degree).toBe(1);
    expect(byId.get('module:src/core/sub')?.meta?.community).toBe(2);
    expect(byId.get('module:src/core/sub')?.meta?.graphifyIds).toEqual(['src/core/sub/s.ts::sigma']);

    // Parent aggregates its subtree: the edge touches a file under src/core,
    // and both communities live in its subtree — a real aggregate, not faked
    expect(byId.get('module:src/core')?.meta?.degree).toBe(1);
    expect(byId.get('module:src/core')?.meta?.community).toBe('1,2');
    // graphifyIds attach to the DEEPEST containing node only
    expect(byId.get('module:src/core')?.meta?.graphifyIds).toEqual(['src/core/a.ts::alpha']);

    // Cross-module edge links the deepest containing folder nodes
    expect(result.graph.edges).toContainEqual({
      source: 'module:src/core',
      target: 'module:src/core/sub',
      relation: 'calls',
    });
  });

  it('should store the FULL sorted graphify id set (no anchor-hint cap)', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    // Seven symbols in one file — more than the old 5-id cap
    const symbolNames = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
    writeGraphifyExport(
      JSON.stringify({
        nodes: symbolNames.map((name) => ({
          id: `src/core/a.ts::${name}`,
          source_file: 'src/core/a.ts',
          community: 1,
        })),
        links: [],
      }),
    );

    const result = enrichWithGraphify(repoRoot, makeNativeGraph());

    const stripe = result.graph.nodes.find((node) => node.id === 'integration:stripe');
    expect(stripe?.meta?.graphifyIds).toEqual(
      symbolNames.map((name) => `src/core/a.ts::${name}`).sort(),
    );

    // A symbol anchor beyond the old cap of 5 resolves against the enriched
    // graph — sorted order puts zeta last, well past the removed cap
    expect(resolveAnchor({ kind: 'symbol', ref: 'src/core/a.ts::zeta' }, result.graph)).toBe(true);
    expect(resolveAnchor({ kind: 'symbol', ref: 'src/core/a.ts::gamma' }, result.graph)).toBe(true);
  });

  it('should never mutate the input graph', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeGraphifyExport('links'));
    const input = makeNativeGraph();
    const snapshot = JSON.stringify(input);

    enrichWithGraphify(repoRoot, input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  // ── Content-based staleness + last-known-good ────────────

  /** Mock exec: tool installed + configurable git signals + refresh behavior. */
  function mockGitEnvironment(options: {
    /** `git status --porcelain` stdout; undefined → the command throws. */
    status?: string;
    /** `git log -1 --format=%ct` epoch; undefined → the command throws. */
    lastCommitEpoch?: number;
    /** `graphify update .` behavior; default is to throw. */
    update?: 'succeed' | 'fail';
  }): void {
    mockExecSync.mockImplementation((command: string) => {
      if (command === 'which graphify') {
        return '/stub/bin/graphify\n';
      }
      if (command === 'git status --porcelain') {
        if (options.status === undefined) {
          throw new Error('not a git repo');
        }
        return options.status;
      }
      if (command === 'git log -1 --format=%ct') {
        if (options.lastCommitEpoch === undefined) {
          throw new Error('not a git repo');
        }
        return `${options.lastCommitEpoch}\n`;
      }
      if (command === 'graphify update .') {
        if (options.update === 'succeed') {
          return '';
        }
        throw new Error('graphify exploded');
      }
      throw new Error(`command failed: ${command}`);
    });
  }

  /** An epoch one day before/after now — around the just-written graph mtime. */
  const DAY_S = 86_400;
  const pastEpoch = (): number => Math.floor(Date.now() / 1000) - DAY_S;
  const futureEpoch = (): number => Math.floor(Date.now() / 1000) + DAY_S;

  it('should treat uncommitted SOURCE-file changes as stale and refresh (dirty tree)', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeGraphifyExport('links'));
    // Commit is OLDER than the graph — only the working tree says stale
    mockGitEnvironment({ status: ' M src/core/a.ts\n', lastCommitEpoch: pastEpoch(), update: 'succeed' });
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    expect(mockExecSync).toHaveBeenCalledWith('graphify update .', expect.anything());
    assertEnriched(result, input);
  });

  it('should NOT treat non-source dirty files (docs, json) as stale', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeGraphifyExport('links'));
    mockGitEnvironment({
      status: '?? notes.md\n M graphify-out/graph.json\nR  old.md -> new.md\n',
      lastCommitEpoch: pastEpoch(),
    });
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    expect(mockExecSync).not.toHaveBeenCalledWith('graphify update .', expect.anything());
    assertEnriched(result, input);
  });

  it('should be fresh with a clean tree and a graph newer than the last commit', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeGraphifyExport('links'));
    mockGitEnvironment({ status: '', lastCommitEpoch: pastEpoch() });
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    expect(mockExecSync).not.toHaveBeenCalledWith('graphify update .', expect.anything());
    assertEnriched(result, input);
  });

  it('should keep the committed-changes signal: clean tree + commit newer than the graph → refresh', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeGraphifyExport('links'));
    mockGitEnvironment({ status: '', lastCommitEpoch: futureEpoch(), update: 'succeed' });
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    expect(mockExecSync).toHaveBeenCalledWith('graphify update .', expect.anything());
    assertEnriched(result, input);
  });

  it('should use the last-known-good graph with a loud notice when the stale refresh fails', () => {
    writeFlowConfig('engines.graphify: enabled\n');
    writeGraphifyExport(makeGraphifyExport('links'));
    mockGitEnvironment({ status: ' M src/core/a.ts\n', lastCommitEpoch: futureEpoch(), update: 'fail' });
    const input = makeNativeGraph();

    const result = enrichWithGraphify(repoRoot, input);

    expect(mockExecSync).toHaveBeenCalledWith('graphify update .', expect.anything());
    // Failed refresh means STALE, not ABSENT: enrichment is STILL applied…
    expect(result.graph).not.toBe(input);
    expect(result.graph.coverage.graphifyEnriched).toBe(true);
    expect(result.graph.edges).toContainEqual({ source: 'module:core', target: 'module:util', relation: 'calls' });
    // …with the one-line reason + the graph file's ISO mtime in the notice
    expect(result.notice).toMatch(
      /^graphify refresh failed \(.+\) — using last-known-good graph from \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});
