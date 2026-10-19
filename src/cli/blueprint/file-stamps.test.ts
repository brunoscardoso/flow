/**
 * Tests for the full-graph drift baseline store (`file-stamps.ts`).
 *
 * Fixtures use a real temp directory tree (not mocked fs) so `computeFileStamps`
 * exercises real SHA-256 hashing against real file content, exactly like a
 * derive run does.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  advanceFileStamps,
  baselineExists,
  computeFileStamps,
  edgeFreshness,
  edgeViaFile,
  establishFileStampsIfMissing,
  readFileStamps,
  stampEdgeVia,
  stampEdgeVias,
  writeFileStamps,
} from './file-stamps.js';
import { BLUEPRINT_DIRNAME } from './store.js';
import type { BlueprintGraph, BlueprintNode } from './types.js';

describe('file-stamps', () => {
  let repoRoot: string;
  let flowDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'file-stamps-test-'));
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

  function sha256Of(relPath: string): string {
    return createHash('sha256').update(readFileSync(join(repoRoot, relPath))).digest('hex');
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

  const structureDir = (): string => join(flowDir, BLUEPRINT_DIRNAME);

  // ── computeFileStamps ────────────────────────────────────

  it('stamps every node source file, sorted by path (deterministic order)', () => {
    writeFile('src/z.ts', 'z');
    writeFile('src/a.ts', 'a');
    writeFile('src/m.ts', 'm');
    const store = computeFileStamps(
      repoRoot,
      graphOf([node('module:z', 'src/z.ts'), node('module:a', 'src/a.ts'), node('module:m', 'src/m.ts')]),
    );

    expect(store.stamps.map((s) => s.path)).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
    expect(store.stamps).toMatchObject([
      { path: 'src/a.ts', contentHash: sha256Of('src/a.ts') },
      { path: 'src/m.ts', contentHash: sha256Of('src/m.ts') },
      { path: 'src/z.ts', contentHash: sha256Of('src/z.ts') },
    ]);
    expect(store.derivedAt).toBe('2026-07-20T00:00:00.000Z');
  });

  it('is byte-identical on a second run over unchanged fixtures', () => {
    writeFile('src/a.ts', 'a');
    const g = graphOf([node('module:a', 'src/a.ts')]);
    expect(JSON.stringify(computeFileStamps(repoRoot, g))).toBe(JSON.stringify(computeFileStamps(repoRoot, g)));
  });

  it('stamps direct-file nodes; an empty dir and a missing file contribute nothing', () => {
    writeFile('src/real.ts', 'real');
    mkdirSync(join(repoRoot, 'src/dir'), { recursive: true }); // empty dir → no children
    const store = computeFileStamps(
      repoRoot,
      graphOf([
        node('module:real', 'src/real.ts'),
        node('module:dir', 'src/dir'), // directory sourceFile → walked (empty → nothing)
        node('module:gone', 'src/gone.ts'), // missing file → walked as prefix, no children
        node('module:empty', ''), // empty sourceFile → skipped
      ]),
    );
    expect(store.stamps).toMatchObject([{ path: 'src/real.ts', contentHash: sha256Of('src/real.ts') }]);
  });

  it('stamps CODE files inside a module-directory node (recursive), skipping non-code + ignored dirs', () => {
    writeFile('src/mod/a.ts', 'a');
    writeFile('src/mod/sub/b.tsx', 'b');
    writeFile('src/mod/readme.md', 'not code'); // non-code → skipped
    writeFile('src/mod/node_modules/dep.ts', 'ignored'); // artifact dir → skipped by walkRepo
    const store = computeFileStamps(repoRoot, graphOf([node('module:mod', 'src/mod')]));
    expect(store.stamps.map((s) => s.path)).toEqual(['src/mod/a.ts', 'src/mod/sub/b.tsx']);
    expect(store.stamps).toMatchObject([
      { path: 'src/mod/a.ts', contentHash: sha256Of('src/mod/a.ts') },
      { path: 'src/mod/sub/b.tsx', contentHash: sha256Of('src/mod/sub/b.tsx') },
    ]);
  });

  it('stamps a direct-file node once even when it also lives under a module-dir node', () => {
    writeFile('src/mod/a.ts', 'a');
    const store = computeFileStamps(
      repoRoot,
      graphOf([node('module:mod', 'src/mod'), node('datastore:a', 'src/mod/a.ts', 'datastore')]),
    );
    expect(store.stamps).toHaveLength(1);
    expect(store.stamps[0].path).toBe('src/mod/a.ts');
  });

  it('hashes a shared source path once even across multiple nodes', () => {
    writeFile('src/shared.ts', 'shared');
    const store = computeFileStamps(
      repoRoot,
      graphOf([node('a', 'src/shared.ts', 'endpoint'), node('b', 'src/shared.ts', 'integration')]),
    );
    expect(store.stamps).toHaveLength(1);
    expect(store.stamps[0].path).toBe('src/shared.ts');
  });

  it('returns empty stamps for an empty graph', () => {
    const store = computeFileStamps(repoRoot, graphOf([]));
    expect(store.stamps).toMatchObject([]);
    expect(store.derivedAt).toBe('2026-07-20T00:00:00.000Z');
  });

  // ── write / rotate / read round-trip ─────────────────────

  it('round-trips through writeFileStamps → readFileStamps', () => {
    writeFile('src/a.ts', 'a');
    const store = computeFileStamps(repoRoot, graphOf([node('module:a', 'src/a.ts')]));
    writeFileStamps(flowDir, store);
    expect(readFileStamps(flowDir)).toEqual(store);
  });

  it('rotates an existing baseline to file-stamps.prev.json on the next write', () => {
    writeFile('src/a.ts', 'a');
    const first = computeFileStamps(repoRoot, graphOf([node('module:a', 'src/a.ts')]));
    writeFileStamps(flowDir, first);

    writeFile('src/a.ts', 'a-changed');
    const second = computeFileStamps(repoRoot, graphOf([node('module:a', 'src/a.ts')]));
    writeFileStamps(flowDir, second);

    expect(readFileStamps(flowDir)).toEqual(second);
    const prev = JSON.parse(readFileSync(join(structureDir(), 'file-stamps.prev.json'), 'utf-8'));
    expect(prev).toEqual(first);
  });

  // ── fail-soft reads ──────────────────────────────────────

  it('returns null when no baseline file exists', () => {
    expect(readFileStamps(flowDir)).toBeNull();
  });

  it('returns null when the baseline file is empty', () => {
    mkdirSync(structureDir(), { recursive: true });
    writeFileSync(join(structureDir(), 'file-stamps.json'), '', 'utf-8');
    expect(readFileStamps(flowDir)).toBeNull();
  });

  it('returns null for a corrupt baseline file rather than throwing', () => {
    mkdirSync(structureDir(), { recursive: true });
    writeFileSync(join(structureDir(), 'file-stamps.json'), '{not valid json', 'utf-8');
    expect(readFileStamps(flowDir)).toBeNull();
  });

  it('drops shape-invalid stamps while keeping valid siblings', () => {
    mkdirSync(structureDir(), { recursive: true });
    writeFileSync(
      join(structureDir(), 'file-stamps.json'),
      JSON.stringify({
        derivedAt: '2026-07-20T00:00:00.000Z',
        stamps: [{ path: 'src/a.ts', contentHash: 'abc' }, { path: 42 }, null, { contentHash: 'x' }],
      }),
      'utf-8',
    );
    expect(readFileStamps(flowDir)).toEqual({
      derivedAt: '2026-07-20T00:00:00.000Z',
      stamps: [{ path: 'src/a.ts', contentHash: 'abc' }],
    });
  });

  // ── establish-once (the derive hook — baseline is stable, not clobbered) ──

  it('baselineExists reflects whether a baseline file is present', () => {
    writeFile('src/a.ts', 'a');
    expect(baselineExists(flowDir)).toBe(false);
    writeFileStamps(flowDir, computeFileStamps(repoRoot, graphOf([node('module:a', 'src/a.ts')])));
    expect(baselineExists(flowDir)).toBe(true);
  });

  it('establishFileStampsIfMissing writes the baseline only when none exists (returns true)', () => {
    writeFile('src/a.ts', 'a');
    const graph = graphOf([node('module:a', 'src/a.ts')]);
    expect(establishFileStampsIfMissing(repoRoot, flowDir, graph)).toBe(true);
    expect(readFileStamps(flowDir)).toEqual(computeFileStamps(repoRoot, graph));
  });

  it('establishFileStampsIfMissing does NOT clobber a drifted baseline (returns false)', () => {
    writeFile('src/a.ts', 'a');
    const graph = graphOf([node('module:a', 'src/a.ts')]);
    establishFileStampsIfMissing(repoRoot, flowDir, graph);
    const baseline = readFileStamps(flowDir);

    // File drifts, then a re-derive fires again — the baseline must stay put so
    // drift-check still sees the change (the core bug this fix closes).
    writeFile('src/a.ts', 'a-changed');
    expect(establishFileStampsIfMissing(repoRoot, flowDir, graph)).toBe(false);
    expect(readFileStamps(flowDir)).toEqual(baseline);
  });

  // ── advance (mark specific files reviewed) ───────────────

  it('advanceFileStamps re-stamps a changed path so it clears from the baseline', () => {
    writeFile('src/a.ts', 'a');
    const graph = graphOf([node('module:a', 'src/a.ts')]);
    establishFileStampsIfMissing(repoRoot, flowDir, graph);

    writeFile('src/a.ts', 'a-changed');
    advanceFileStamps(repoRoot, flowDir, ['src/a.ts']);
    // The baseline now carries the CURRENT content hash — no longer drifted.
    expect(readFileStamps(flowDir)?.stamps).toMatchObject([
      { path: 'src/a.ts', contentHash: sha256Of('src/a.ts') },
    ]);
  });

  it('advanceFileStamps upserts a path absent from the baseline', () => {
    writeFile('src/a.ts', 'a');
    establishFileStampsIfMissing(repoRoot, flowDir, graphOf([node('module:a', 'src/a.ts')]));

    writeFile('src/b.ts', 'b');
    advanceFileStamps(repoRoot, flowDir, ['src/b.ts']);
    expect(readFileStamps(flowDir)?.stamps).toMatchObject([
      { path: 'src/a.ts', contentHash: sha256Of('src/a.ts') },
      { path: 'src/b.ts', contentHash: sha256Of('src/b.ts') },
    ]);
  });

  it('advanceFileStamps drops the stamp for a now-missing path', () => {
    writeFile('src/a.ts', 'a');
    writeFile('src/b.ts', 'b');
    establishFileStampsIfMissing(
      repoRoot,
      flowDir,
      graphOf([node('module:a', 'src/a.ts'), node('module:b', 'src/b.ts')]),
    );

    rmSync(join(repoRoot, 'src/b.ts'));
    advanceFileStamps(repoRoot, flowDir, ['src/b.ts']);
    expect(readFileStamps(flowDir)?.stamps).toMatchObject([
      { path: 'src/a.ts', contentHash: sha256Of('src/a.ts') },
    ]);
  });

  it('advanceFileStamps preserves the baseline derivedAt (stable last-seen reference)', () => {
    writeFile('src/a.ts', 'a');
    establishFileStampsIfMissing(repoRoot, flowDir, graphOf([node('module:a', 'src/a.ts')]));
    const before = readFileStamps(flowDir)?.derivedAt;

    writeFile('src/a.ts', 'a-changed');
    advanceFileStamps(repoRoot, flowDir, ['src/a.ts']);
    expect(readFileStamps(flowDir)?.derivedAt).toBe(before);
  });

  it('advanceFileStamps is a no-op on empty paths or a missing baseline', () => {
    writeFile('src/a.ts', 'a');
    establishFileStampsIfMissing(repoRoot, flowDir, graphOf([node('module:a', 'src/a.ts')]));
    const baseline = readFileStamps(flowDir);
    advanceFileStamps(repoRoot, flowDir, []);
    expect(readFileStamps(flowDir)).toEqual(baseline);

    // No baseline yet → nothing to advance, and no baseline created.
    rmSync(structureDir(), { recursive: true, force: true });
    advanceFileStamps(repoRoot, flowDir, ['src/a.ts']);
    expect(readFileStamps(flowDir)).toBeNull();
  });

  // ── reset (mark everything reviewed) ─────────────────────

  it('writeFileStamps still performs a full reset to the current tree', () => {
    writeFile('src/a.ts', 'a');
    const graph = graphOf([node('module:a', 'src/a.ts')]);
    establishFileStampsIfMissing(repoRoot, flowDir, graph);

    writeFile('src/a.ts', 'a-changed');
    writeFileStamps(flowDir, computeFileStamps(repoRoot, graph));
    expect(readFileStamps(flowDir)?.stamps).toMatchObject([
      { path: 'src/a.ts', contentHash: sha256Of('src/a.ts') },
    ]);
  });

  // ── stat pre-filter (previous stamps as hints) ───────────

  describe('stat pre-filter via previous stamps', () => {
    const FIXED_MTIME = new Date(1700000000000);

    it('reuses a prior stamp hash without reading when mtime+size still match', () => {
      writeFile('src/a.ts', 'export const a = 1;\n');
      utimesSync(join(repoRoot, 'src/a.ts'), FIXED_MTIME, FIXED_MTIME);
      const graph = graphOf([node('module:src', 'src')]);
      const previous = computeFileStamps(repoRoot, graph);
      const priorHash = previous.stamps[0].contentHash;

      // Poison: SAME byte length, mtime restored — a content re-hash would
      // produce a new digest; the stat short-circuit must reuse the stored
      // one (proving the file was never read).
      writeFile('src/a.ts', 'export const z = 9;\n');
      utimesSync(join(repoRoot, 'src/a.ts'), FIXED_MTIME, FIXED_MTIME);

      const withHints = computeFileStamps(repoRoot, graph, { previous });
      expect(withHints.stamps).toMatchObject([{ path: 'src/a.ts', contentHash: priorHash }]);

      // Without hints, content is re-hashed — the truth differs.
      const withoutHints = computeFileStamps(repoRoot, graph);
      expect(withoutHints.stamps[0].contentHash).toBe(sha256Of('src/a.ts'));
      expect(withoutHints.stamps[0].contentHash).not.toBe(priorHash);
    });

    it('re-hashes content on mtime mismatch — the hint never overrides the truth', () => {
      writeFile('src/a.ts', 'export const a = 1;\n');
      const graph = graphOf([node('module:src', 'src')]);
      const previous = computeFileStamps(repoRoot, graph);

      writeFile('src/a.ts', 'export const z = 9;\n'); // same size, fresh mtime
      utimesSync(join(repoRoot, 'src/a.ts'), FIXED_MTIME, FIXED_MTIME); // differs from stamp's recorded mtime

      const store = computeFileStamps(repoRoot, graph, { previous });
      expect(store.stamps).toMatchObject([{ path: 'src/a.ts', contentHash: sha256Of('src/a.ts') }]);
      expect(store.stamps[0].contentHash).not.toBe(previous.stamps[0].contentHash);
    });

    it('accepts a pre-computed repo scan and stamps only files that scan lists', () => {
      writeFile('src/a.ts', 'a');
      writeFile('src/b.ts', 'b');
      const graph = graphOf([node('module:src', 'src')]);

      const store = computeFileStamps(repoRoot, graph, {
        repoScan: { files: ['src/a.ts'], unreadableDirs: [] },
      });
      expect(store.stamps.map((stamp) => stamp.path)).toEqual(['src/a.ts']);
    });
  });
});

// ── An edge's mechanism is stamped like everything else ────────────────────
//
// A feature edge's `via` names the file through which two capabilities
// connect. That file is what can make the edge's note wrong — the binder is
// rewritten and a confident, shared sentence about how two features connect
// quietly becomes false, with nothing erroring. So it is hash-stamped with the
// SAME helper every other stamp here uses, and re-checked the same way.

describe('edge stamps', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'edge-stamps-test-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const absolutePath = join(repoRoot, relPath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
  }

  describe('edgeViaFile', () => {
    it('reads the file out of every shape a via is written in', () => {
      expect(edgeViaFile('src/a/binder.ts')).toBe('src/a/binder.ts');
      expect(edgeViaFile('`src/a/binder.ts`')).toBe('src/a/binder.ts');
      expect(edgeViaFile('file:src/a/binder.ts')).toBe('src/a/binder.ts');
      expect(edgeViaFile('src/a/binder.ts#resolveSlug')).toBe('src/a/binder.ts');
      expect(edgeViaFile('src/a/binder.ts:42')).toBe('src/a/binder.ts');
    });

    it('names no file for a symbol, a seam or a directory', () => {
      // These are real, useful mechanisms — they just cannot be hashed, so the
      // edge stays unstamped rather than being stamped against a guess.
      expect(edgeViaFile('playbook_manifest_binder')).toBeNull();
      expect(edgeViaFile('the manifest handshake')).toBeNull();
      expect(edgeViaFile('src/playbooks')).toBeNull();
      expect(edgeViaFile(undefined)).toBeNull();
      expect(edgeViaFile('')).toBeNull();
    });

    it('never resolves a path that escapes the repo', () => {
      expect(edgeViaFile('../../etc/passwd.txt')).toBeNull();
      expect(edgeViaFile('/etc/passwd.txt')).toBeNull();
    });
  });

  describe('stampEdgeVia', () => {
    it('stamps the file a via names, with the same hash the baseline uses', () => {
      write('src/a/binder.ts', 'export const resolve = () => 1\n');
      const stamped = stampEdgeVia(repoRoot, {
        target: 'feature:skills',
        via: 'src/a/binder.ts#resolve',
      });
      const expected = createHash('sha256')
        .update(readFileSync(join(repoRoot, 'src/a/binder.ts')))
        .digest('hex');
      expect(stamped.viaHash).toBe(expected);
    });

    it('leaves an unfile-able mechanism unstamped rather than guessing', () => {
      expect(stampEdgeVia(repoRoot, { target: 'feature:skills', via: 'the manifest handshake' }).viaHash)
        .toBeUndefined();
      expect(stampEdgeVia(repoRoot, { target: 'feature:skills' }).viaHash).toBeUndefined();
    });

    it('DROPS a stamp it can no longer back — a dead hash reads as forever-stale', () => {
      const orphan = stampEdgeVia(repoRoot, {
        target: 'feature:skills',
        via: 'src/gone.ts',
        viaHash: 'deadbeef',
      });
      expect(orphan.viaHash).toBeUndefined();
    });

    it('stamps a batch in order, dropping nothing', () => {
      write('src/a.ts', 'a\n');
      const stamped = stampEdgeVias(repoRoot, [
        { target: 'feature:x', via: 'src/a.ts' },
        { target: 'feature:y', via: 'a named seam' },
      ]);
      expect(stamped.map((edge) => edge.target)).toEqual(['feature:x', 'feature:y']);
      expect(stamped[0].viaHash).toEqual(expect.any(String));
      expect(stamped[1].viaHash).toBeUndefined();
    });
  });

  describe('edgeFreshness', () => {
    it('is fresh while the mechanism is unchanged, and stale the moment it changes', () => {
      write('src/a/binder.ts', 'export const resolve = () => 1\n');
      const edge = stampEdgeVia(repoRoot, { target: 'feature:skills', via: 'src/a/binder.ts' });
      expect(edgeFreshness(repoRoot, edge)).toBe('fresh');

      write('src/a/binder.ts', 'export const resolve = () => 2 // the seam moved\n');
      expect(edgeFreshness(repoRoot, edge)).toBe('stale');
    });

    it('reports a deleted mechanism as missing, not merely stale', () => {
      write('src/a/binder.ts', 'x\n');
      const edge = stampEdgeVia(repoRoot, { target: 'feature:skills', via: 'src/a/binder.ts' });
      rmSync(join(repoRoot, 'src/a/binder.ts'));
      expect(edgeFreshness(repoRoot, edge)).toBe('missing');
    });

    it('never calls an unstamped edge fresh — it makes no claim at all', () => {
      write('src/a/binder.ts', 'x\n');
      expect(edgeFreshness(repoRoot, { target: 'feature:skills', via: 'src/a/binder.ts' } as never)).toBe(
        'unstamped',
      );
      expect(edgeFreshness(repoRoot, { via: 'a named seam', viaHash: 'abc' })).toBe('unstamped');
    });
  });
});
