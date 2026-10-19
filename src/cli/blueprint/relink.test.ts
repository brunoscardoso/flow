/**
 * Tests for the annotation relink pass — stale-flagging of unresolvable
 * anchors, recovery when anchors resolve again, zero-anchor immunity,
 * idempotence, and append-only semantics (annotations.jsonl is never
 * rewritten; transitions land in status-events.jsonl).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { relinkAnnotations } from './relink.js';
import { appendAnnotation, readAnnotations } from './store.js';
import type { Anchor, AnnotationEntry, BlueprintGraph } from './types.js';

describe('relinkAnnotations', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'blueprint-relink-test-'));
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  // ── Helpers ──────────────────────────────────────────────

  function makeGraph(moduleNames: string[]): BlueprintGraph {
    return {
      version: 1,
      derivedAt: '2026-07-09T00:00:00.000Z',
      coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
      nodes: moduleNames.map((name) => ({
        id: `module:${name}`,
        kind: 'module' as const,
        label: name,
        sourceFile: `src/${name}`,
      })),
      edges: [],
    };
  }

  function makeAnnotation(text: string, anchors: Anchor[]): AnnotationEntry {
    return {
      ts: '2026-07-09T00:00:00.000Z',
      runId: 'run-1',
      type: 'decision',
      text,
      anchors,
      provenance: 'test',
      status: 'active',
    };
  }

  function readRawLines(fileName: string): string[] {
    const filePath = join(flowDir, 'brain', '.structure', fileName);
    if (!existsSync(filePath)) {
      return [];
    }
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
  }

  // ── Stale-flagging ───────────────────────────────────────

  it('should stale an active annotation whose anchors all fail to resolve', () => {
    appendAnnotation(flowDir, makeAnnotation('anchored to ghost', [{ kind: 'module', ref: 'ghost' }]));

    const result = relinkAnnotations(flowDir, makeGraph(['api']));

    expect(result).toEqual({ staled: 1, recovered: 0 });
    expect(readAnnotations(flowDir)[0].status).toBe('stale');
  });

  it('should list the unresolved anchor refs in the stale event reason', () => {
    appendAnnotation(
      flowDir,
      makeAnnotation('two lost anchors', [
        { kind: 'module', ref: 'ghost' },
        { kind: 'file', ref: 'src/gone.ts' },
      ]),
    );

    relinkAnnotations(flowDir, makeGraph(['api']));

    const events = readRawLines('status-events.jsonl').map((line) => JSON.parse(line) as { reason: string });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('anchors lost: ghost, src/gone.ts');
  });

  it('should not stale an active annotation when at least one anchor resolves', () => {
    appendAnnotation(
      flowDir,
      makeAnnotation('partially resolved', [
        { kind: 'module', ref: 'api' },
        { kind: 'module', ref: 'ghost' },
      ]),
    );

    const result = relinkAnnotations(flowDir, makeGraph(['api']));

    expect(result).toEqual({ staled: 0, recovered: 0 });
    expect(readAnnotations(flowDir)[0].status).toBe('active');
  });

  it('should never stale a zero-anchor annotation', () => {
    appendAnnotation(flowDir, makeAnnotation('free-floating note', []));

    const result = relinkAnnotations(flowDir, makeGraph([]));

    expect(result).toEqual({ staled: 0, recovered: 0 });
    expect(readAnnotations(flowDir)[0].status).toBe('active');
  });

  // ── File-anchor containment (fileMatchesNode) ────────────

  it('should resolve a file anchor contained in a module directory', () => {
    appendAnnotation(
      flowDir,
      makeAnnotation('file under module dir', [{ kind: 'file', ref: 'src/cli/blueprint/store.ts' }]),
    );

    const result = relinkAnnotations(flowDir, makeGraph(['cli'])); // sourceFile 'src/cli'

    expect(result).toEqual({ staled: 0, recovered: 0 });
    expect(readAnnotations(flowDir)[0].status).toBe('active');
  });

  it('should stale a file anchor not contained in any module directory', () => {
    appendAnnotation(
      flowDir,
      makeAnnotation('file outside modules', [{ kind: 'file', ref: 'src/cli/blueprint/store.ts' }]),
    );

    const result = relinkAnnotations(flowDir, makeGraph(['test'])); // sourceFile 'src/test'

    expect(result).toEqual({ staled: 1, recovered: 0 });
  });

  it('should not match a module whose directory merely shares a path prefix', () => {
    appendAnnotation(
      flowDir,
      makeAnnotation('prefix trap', [{ kind: 'file', ref: 'src/cli/blueprint/store.ts' }]),
    );

    const result = relinkAnnotations(flowDir, makeGraph(['cl'])); // sourceFile 'src/cl'

    expect(result).toEqual({ staled: 1, recovered: 0 });
  });

  it('should resolve a symbol anchor via containment of its file scope', () => {
    appendAnnotation(
      flowDir,
      makeAnnotation('symbol scoped to a contained file', [
        { kind: 'symbol', ref: 'writeGraph', file: 'src/cli/blueprint/store.ts' },
      ]),
    );

    const result = relinkAnnotations(flowDir, makeGraph(['cli']));

    expect(result).toEqual({ staled: 0, recovered: 0 });
  });

  it('should require exact sourceFile equality for non-module nodes', () => {
    const graph = makeGraph([]);
    graph.nodes.push({
      id: 'integration:stripe',
      kind: 'integration',
      label: 'stripe',
      sourceFile: 'src/cli/blueprint',
    });
    appendAnnotation(
      flowDir,
      makeAnnotation('no containment for non-modules', [
        { kind: 'file', ref: 'src/cli/blueprint/store.ts' },
      ]),
    );

    const result = relinkAnnotations(flowDir, graph);

    expect(result).toEqual({ staled: 1, recovered: 0 });
  });

  it('should keep endpoint anchors on id matching only — no file containment', () => {
    appendAnnotation(
      flowDir,
      makeAnnotation('endpoint anchored to a path', [{ kind: 'endpoint', ref: 'src/cli/main.ts' }]),
    );

    const result = relinkAnnotations(flowDir, makeGraph(['cli']));

    expect(result).toEqual({ staled: 1, recovered: 0 });
  });

  // ── Legacy module-anchor resolution bridge ───────────────

  describe('legacy module-anchor bridge (path-based module ids)', () => {
    /** A graph in the new hierarchical shape: path-based id, basename label. */
    function makePathGraph(): BlueprintGraph {
      return {
        version: 1,
        derivedAt: '2026-07-09T00:00:00.000Z',
        coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
        nodes: [
          {
            id: 'module:src/cli',
            kind: 'module',
            label: 'cli',
            sourceFile: 'src/cli',
            meta: { depth: 1, childDirs: 1, fileCount: 2 },
          },
          {
            id: 'module:src/cli/blueprint',
            kind: 'module',
            label: 'blueprint',
            sourceFile: 'src/cli/blueprint',
            meta: { depth: 2, childDirs: 0, fileCount: 3 },
          },
        ],
        edges: [{ source: 'module:src/cli', target: 'module:src/cli/blueprint', relation: 'contains' }],
      };
    }

    it('should resolve a legacy basename module anchor via the node label', () => {
      appendAnnotation(flowDir, makeAnnotation('legacy basename anchor', [{ kind: 'module', ref: 'cli' }]));

      const result = relinkAnnotations(flowDir, makePathGraph());

      expect(result).toEqual({ staled: 0, recovered: 0 });
      expect(readAnnotations(flowDir)[0].status).toBe('active');
    });

    it('should resolve a path-based module anchor via the node id', () => {
      appendAnnotation(
        flowDir,
        makeAnnotation('path anchor', [{ kind: 'module', ref: 'src/cli/blueprint' }]),
      );

      const result = relinkAnnotations(flowDir, makePathGraph());

      expect(result).toEqual({ staled: 0, recovered: 0 });
    });

    it('should still stale a module anchor matching neither id, label, nor sourceFile', () => {
      appendAnnotation(flowDir, makeAnnotation('ghost module', [{ kind: 'module', ref: 'ghost' }]));

      const result = relinkAnnotations(flowDir, makePathGraph());

      expect(result).toEqual({ staled: 1, recovered: 0 });
    });

    it('should resolve file anchors under a nested folder node by containment', () => {
      appendAnnotation(
        flowDir,
        makeAnnotation('file under nested folder', [
          { kind: 'file', ref: 'src/cli/blueprint/store.ts' },
        ]),
      );

      const result = relinkAnnotations(flowDir, makePathGraph());

      expect(result).toEqual({ staled: 0, recovered: 0 });
    });
  });

  // ── Recovery ─────────────────────────────────────────────

  it('should recover a stale annotation when all anchors resolve again', () => {
    appendAnnotation(flowDir, makeAnnotation('comes back', [{ kind: 'module', ref: 'ghost' }]));

    const staleRun = relinkAnnotations(flowDir, makeGraph(['api']));
    expect(staleRun).toEqual({ staled: 1, recovered: 0 });

    const recoverRun = relinkAnnotations(flowDir, makeGraph(['api', 'ghost']));

    expect(recoverRun).toEqual({ staled: 0, recovered: 1 });
    expect(readAnnotations(flowDir)[0].status).toBe('active');
  });

  it('should not recover a stale annotation while any anchor is still unresolved', () => {
    appendAnnotation(
      flowDir,
      makeAnnotation('half recovered', [
        { kind: 'module', ref: 'api' },
        { kind: 'module', ref: 'ghost' },
      ]),
    );

    relinkAnnotations(flowDir, makeGraph([])); // both lost → staled
    const result = relinkAnnotations(flowDir, makeGraph(['api'])); // one still lost

    expect(result).toEqual({ staled: 0, recovered: 0 });
    expect(readAnnotations(flowDir)[0].status).toBe('stale');
  });

  // ── Idempotence ──────────────────────────────────────────

  it('should be idempotent — the second run against the same graph applies no transitions', () => {
    appendAnnotation(flowDir, makeAnnotation('anchored to ghost', [{ kind: 'module', ref: 'ghost' }]));
    appendAnnotation(flowDir, makeAnnotation('anchored to api', [{ kind: 'module', ref: 'api' }]));
    const graph = makeGraph(['api']);

    const first = relinkAnnotations(flowDir, graph);
    const second = relinkAnnotations(flowDir, graph);

    expect(first).toEqual({ staled: 1, recovered: 0 });
    expect(second).toEqual({ staled: 0, recovered: 0 });
  });

  // ── Append-only semantics ────────────────────────────────

  it('should never rewrite annotations.jsonl — transitions grow status-events.jsonl only', () => {
    appendAnnotation(flowDir, makeAnnotation('anchored to ghost', [{ kind: 'module', ref: 'ghost' }]));
    const annotationsBefore = readFileSync(join(flowDir, 'brain', '.structure', 'annotations.jsonl'), 'utf-8');
    expect(readRawLines('status-events.jsonl')).toHaveLength(0);

    relinkAnnotations(flowDir, makeGraph([])); // stale
    relinkAnnotations(flowDir, makeGraph(['ghost'])); // recover

    const annotationsAfter = readFileSync(join(flowDir, 'brain', '.structure', 'annotations.jsonl'), 'utf-8');
    expect(annotationsAfter).toBe(annotationsBefore);
    expect(readRawLines('status-events.jsonl')).toHaveLength(2);
  });
});
