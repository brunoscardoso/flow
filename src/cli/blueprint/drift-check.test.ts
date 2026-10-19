/**
 * Tests for the broadened drift detector (`drift-check.ts`).
 *
 * Fixtures use a real temp directory tree (not mocked fs) so both the baseline
 * write (`writeFileStamps`) and the re-hash pass (`computeDrift`) exercise real
 * SHA-256 hashing against real file content, exactly like a derive run does.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeDrift } from './drift-check.js';
import { advanceFileStamps, computeFileStamps, establishFileStampsIfMissing, writeFileStamps } from './file-stamps.js';
import { BLUEPRINT_DIRNAME } from './store.js';
import type { BlueprintGraph, BlueprintNode } from './types.js';

describe('computeDrift', () => {
  let repoRoot: string;
  let flowDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'drift-check-test-'));
    flowDir = join(repoRoot, 'flow');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // ── fixture helpers ──────────────────────────────────────

  function writeFile(relPath: string, content: string): void {
    const absolutePath = join(repoRoot, relPath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
  }

  function node(id: string, sourceFile: string, kind: BlueprintNode['kind'] = 'module'): BlueprintNode {
    return { id, kind, label: id, sourceFile };
  }

  function graphOf(nodes: BlueprintNode[]): BlueprintGraph {
    return {
      version: 1,
      derivedAt: '2026-07-20T00:00:00.000Z',
      coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
      nodes,
      edges: [],
    };
  }

  /** Stamp a baseline for `graph` at the current disk content. */
  function stampBaseline(graph: BlueprintGraph): void {
    writeFileStamps(flowDir, computeFileStamps(repoRoot, graph));
  }

  // ── cold index ───────────────────────────────────────────

  it('returns the cold-index report when no baseline exists', () => {
    writeFile('src/a.ts', 'a');
    const report = computeDrift(repoRoot, flowDir, graphOf([node('module:a', 'src/a.ts')]));
    expect(report).toEqual({ baselineAt: null, entries: [] });
  });

  it('returns the cold-index report when the baseline has zero stamps', () => {
    mkdirSync(join(flowDir, BLUEPRINT_DIRNAME), { recursive: true });
    writeFileSync(
      join(flowDir, BLUEPRINT_DIRNAME, 'file-stamps.json'),
      JSON.stringify({ derivedAt: '2026-07-20T00:00:00.000Z', stamps: [] }),
      'utf-8',
    );
    const report = computeDrift(repoRoot, flowDir, graphOf([node('module:a', 'src/a.ts')]));
    expect(report).toEqual({ baselineAt: null, entries: [] });
  });

  // ── detection ────────────────────────────────────────────

  it('reports no drift when nothing changed since the baseline', () => {
    writeFile('src/a.ts', 'a');
    const graph = graphOf([node('module:a', 'src/a.ts')]);
    stampBaseline(graph);

    const report = computeDrift(repoRoot, flowDir, graph);
    expect(report.baselineAt).toBe('2026-07-20T00:00:00.000Z');
    expect(report.entries).toEqual([]);
  });

  it('detects a changed file and maps it to its owning node', () => {
    writeFile('src/a.ts', 'a');
    const graph = graphOf([node('module:a', 'src/a.ts')]);
    stampBaseline(graph);

    writeFile('src/a.ts', 'a-changed');
    const report = computeDrift(repoRoot, flowDir, graph);
    expect(report.entries).toEqual([{ path: 'src/a.ts', kind: 'changed', nodeId: 'module:a' }]);
  });

  it('detects a missing file when a stamped file was deleted', () => {
    writeFile('src/a.ts', 'a');
    const graph = graphOf([node('module:a', 'src/a.ts')]);
    stampBaseline(graph);
    unlinkSync(join(repoRoot, 'src/a.ts'));

    // The node is gone from the current graph too — nodeId is unmapped.
    const report = computeDrift(repoRoot, flowDir, graphOf([]));
    expect(report.entries).toEqual([{ path: 'src/a.ts', kind: 'missing' }]);
  });

  it('detects an added file present as a current node sourceFile but absent from the baseline', () => {
    writeFile('src/a.ts', 'a');
    const baselineGraph = graphOf([node('module:a', 'src/a.ts')]);
    stampBaseline(baselineGraph);

    writeFile('src/b.ts', 'b');
    const report = computeDrift(
      repoRoot,
      flowDir,
      graphOf([node('module:a', 'src/a.ts'), node('module:b', 'src/b.ts')]),
    );
    expect(report.entries).toEqual([{ path: 'src/b.ts', kind: 'added', nodeId: 'module:b' }]);
  });

  it('collapses a move into a single renamed entry (missing + added with equal content)', () => {
    writeFile('src/old.ts', 'moved-content');
    const baselineGraph = graphOf([node('module:old', 'src/old.ts')]);
    stampBaseline(baselineGraph);

    // Move the file: old path gone, new path with identical content appears.
    unlinkSync(join(repoRoot, 'src/old.ts'));
    writeFile('src/new.ts', 'moved-content');
    const report = computeDrift(repoRoot, flowDir, graphOf([node('module:new', 'src/new.ts')]));

    expect(report.entries).toEqual([
      { path: 'src/new.ts', kind: 'renamed', nodeId: 'module:new', renamedFrom: 'src/old.ts' },
    ]);
  });

  it('does not collapse a rename when content also changed (reports missing + added)', () => {
    writeFile('src/old.ts', 'original');
    stampBaseline(graphOf([node('module:old', 'src/old.ts')]));

    unlinkSync(join(repoRoot, 'src/old.ts'));
    writeFile('src/new.ts', 'different'); // different content — not a pure move
    const report = computeDrift(repoRoot, flowDir, graphOf([node('module:new', 'src/new.ts')]));

    expect(report.entries).toEqual([
      { path: 'src/new.ts', kind: 'added', nodeId: 'module:new' },
      { path: 'src/old.ts', kind: 'missing' },
    ]);
  });

  // ── determinism ──────────────────────────────────────────

  it('sorts entries by path and is byte-identical across runs', () => {
    writeFile('src/z.ts', 'z');
    writeFile('src/a.ts', 'a');
    const graph = graphOf([node('module:z', 'src/z.ts'), node('module:a', 'src/a.ts')]);
    stampBaseline(graph);
    writeFile('src/z.ts', 'z2');
    writeFile('src/a.ts', 'a2');

    const first = computeDrift(repoRoot, flowDir, graph);
    const second = computeDrift(repoRoot, flowDir, graph);
    expect(first.entries.map((e) => e.path)).toEqual(['src/a.ts', 'src/z.ts']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  // ── fail-soft ────────────────────────────────────────────

  it('treats a source path that became a directory as missing, never throwing', () => {
    writeFile('src/a.ts', 'a');
    const graph = graphOf([node('module:a', 'src/a.ts')]);
    stampBaseline(graph);

    // Replace the file with a directory of the same name.
    unlinkSync(join(repoRoot, 'src/a.ts'));
    mkdirSync(join(repoRoot, 'src/a.ts'), { recursive: true });

    const report = computeDrift(repoRoot, flowDir, graph);
    expect(report.entries).toEqual([{ path: 'src/a.ts', kind: 'missing', nodeId: 'module:a' }]);
  });

  // ── establish → drift → ack lifecycle (the bug this fix closes) ──────────

  it('establish → edit → drift shows it → re-derive keeps it → ack clears it', () => {
    writeFile('src/a.ts', 'a');
    const graph = graphOf([node('module:a', 'src/a.ts')]);

    // 1. First derive establishes the baseline (nothing drifted yet).
    establishFileStampsIfMissing(repoRoot, flowDir, graph);
    expect(computeDrift(repoRoot, flowDir, graph).entries).toEqual([]);

    // 2. The file changes — drift-check surfaces it.
    writeFile('src/a.ts', 'a-changed');
    expect(computeDrift(repoRoot, flowDir, graph).entries).toEqual([
      { path: 'src/a.ts', kind: 'changed', nodeId: 'module:a' },
    ]);

    // 3. A re-derive (e.g. watcher refresh after a pull) must NOT clobber the
    //    baseline — the change stays visible (regression guard for the bug).
    establishFileStampsIfMissing(repoRoot, flowDir, graph);
    expect(computeDrift(repoRoot, flowDir, graph).entries).toEqual([
      { path: 'src/a.ts', kind: 'changed', nodeId: 'module:a' },
    ]);

    // 4. Acknowledging the file advances the baseline — drift clears.
    advanceFileStamps(repoRoot, flowDir, ['src/a.ts']);
    expect(computeDrift(repoRoot, flowDir, graph).entries).toEqual([]);
  });
});

describe('computeDrift stat pre-filter (perf — hash stays the truth)', () => {
  let repoRoot: string;
  let flowDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'drift-prefilter-test-'));
    flowDir = join(repoRoot, 'flow');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const write = (rel: string, content: string): void => {
    mkdirSync(join(repoRoot, rel, '..'), { recursive: true });
    writeFileSync(join(repoRoot, rel), content, 'utf-8');
  };
  const graph = (): BlueprintGraph => ({
    version: 1,
    derivedAt: '2026-07-20T00:00:00.000Z',
    coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
    nodes: [{ id: 'module:a', kind: 'module', label: 'a', sourceFile: 'src/a.ts' }],
    edges: [],
  });
  const stampsPath = (): string => join(flowDir, BLUEPRINT_DIRNAME, 'file-stamps.json');
  const readStore = (): { derivedAt: string; stamps: Array<Record<string, unknown>> } =>
    JSON.parse(readFileSync(stampsPath(), 'utf-8')) as never;

  it('records mtime+size hints on every computed stamp', () => {
    write('src/a.ts', 'a');
    writeFileStamps(flowDir, computeFileStamps(repoRoot, graph()));
    const [stamp] = readStore().stamps;
    expect(typeof stamp.mtimeMs).toBe('number');
    expect(stamp.size).toBe(1);
  });

  it('SHORT-CIRCUITS hashing when stat matches: a wrong stored hash with a matching stat is not reported', () => {
    // This proves the fast path is actually taken — if the file were hashed,
    // the corrupted stored hash would mismatch and report `changed`.
    write('src/a.ts', 'a');
    writeFileStamps(flowDir, computeFileStamps(repoRoot, graph()));
    const store = readStore();
    store.stamps[0].contentHash = 'deadbeef';
    writeFileSync(stampsPath(), JSON.stringify(store), 'utf-8');

    expect(computeDrift(repoRoot, flowDir, graph()).entries).toEqual([]);
  });

  it('falls through to the hash when the stat hints mismatch', () => {
    write('src/a.ts', 'a');
    writeFileStamps(flowDir, computeFileStamps(repoRoot, graph()));
    const store = readStore();
    store.stamps[0].contentHash = 'deadbeef';
    store.stamps[0].mtimeMs = 1; // stale hint → must re-hash → mismatch surfaces
    writeFileSync(stampsPath(), JSON.stringify(store), 'utf-8');

    expect(computeDrift(repoRoot, flowDir, graph()).entries).toEqual([
      { path: 'src/a.ts', kind: 'changed', nodeId: 'module:a' },
    ]);
  });

  it('legacy stamps without hints always re-hash (backward compatible)', () => {
    write('src/a.ts', 'a');
    writeFileStamps(flowDir, computeFileStamps(repoRoot, graph()));
    const store = readStore();
    delete store.stamps[0].mtimeMs;
    delete store.stamps[0].size;
    store.stamps[0].contentHash = 'deadbeef';
    writeFileSync(stampsPath(), JSON.stringify(store), 'utf-8');

    expect(computeDrift(repoRoot, flowDir, graph()).entries).toEqual([
      { path: 'src/a.ts', kind: 'changed', nodeId: 'module:a' },
    ]);
  });

  it('a real edit is still detected (size/mtime move with the content)', () => {
    write('src/a.ts', 'a');
    writeFileStamps(flowDir, computeFileStamps(repoRoot, graph()));
    write('src/a.ts', 'a changed');
    expect(computeDrift(repoRoot, flowDir, graph()).entries).toEqual([
      { path: 'src/a.ts', kind: 'changed', nodeId: 'module:a' },
    ]);
  });

  it('detects a file ADDED inside a module directory (#1674 — add scan matches the baseline universe)', () => {
    write('src/mod/a.ts', 'export const a = 1');
    const moduleGraph: BlueprintGraph = {
      ...graph(),
      nodes: [{ id: 'module:mod', kind: 'module', label: 'mod', sourceFile: 'src/mod' }],
    };
    writeFileStamps(flowDir, computeFileStamps(repoRoot, moduleGraph));
    write('src/mod/brand-new.ts', 'export const b = 1');

    expect(computeDrift(repoRoot, flowDir, moduleGraph).entries).toEqual([
      { path: 'src/mod/brand-new.ts', kind: 'added', nodeId: 'module:mod' },
    ]);
  });

  it('collapses a RENAME of a module-internal file instead of reporting a deletion (#1674)', () => {
    write('src/mod/a.ts', 'export const same = 1');
    const moduleGraph: BlueprintGraph = {
      ...graph(),
      nodes: [{ id: 'module:mod', kind: 'module', label: 'mod', sourceFile: 'src/mod' }],
    };
    writeFileStamps(flowDir, computeFileStamps(repoRoot, moduleGraph));
    unlinkSync(join(repoRoot, 'src/mod/a.ts'));
    write('src/mod/b.ts', 'export const same = 1');

    expect(computeDrift(repoRoot, flowDir, moduleGraph).entries).toEqual([
      { path: 'src/mod/b.ts', kind: 'renamed', nodeId: 'module:mod', renamedFrom: 'src/mod/a.ts' },
    ]);
  });

  it('advanceFileStamps refreshes the hints so an acked file takes the fast path again', () => {
    write('src/a.ts', 'a');
    writeFileStamps(flowDir, computeFileStamps(repoRoot, graph()));
    write('src/a.ts', 'a changed');
    advanceFileStamps(repoRoot, flowDir, ['src/a.ts']);
    const [stamp] = readStore().stamps;
    expect(stamp.size).toBe('a changed'.length);
    expect(computeDrift(repoRoot, flowDir, graph()).entries).toEqual([]);
  });
});
