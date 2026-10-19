/**
 * Tests for the blueprint store — graph.json rotation, fail-soft reads,
 * append-only annotation stream with status-event folding, and fingerprint
 * stability.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  annotationFingerprint,
  appendAnnotation,
  appendStatusEvent,
  hashFileContent,
  hashRepoFile,
  hashRepoFileWithHint,
  readAnnotations,
  readGraph,
  statRepoFile,
  writeGraph,
} from './store.js';
import type { AnnotationEntry, BlueprintGraph } from './types.js';

describe('blueprint store', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'blueprint-store-test-'));
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  // ── Helpers ──────────────────────────────────────────────

  function makeGraph(derivedAt: string): BlueprintGraph {
    return {
      version: 1,
      derivedAt,
      coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
      nodes: [{ id: 'module:api', kind: 'module', label: 'api', sourceFile: 'src/api' }],
      edges: [],
    };
  }

  function makeAnnotation(overrides: Partial<AnnotationEntry> = {}): AnnotationEntry {
    return {
      ts: '2026-07-09T00:00:00.000Z',
      runId: 'run-1',
      type: 'decision',
      text: 'Use append-only storage',
      anchors: [{ kind: 'module', ref: 'api' }],
      provenance: 'test',
      status: 'active',
      ...overrides,
    };
  }

  const blueprintPath = (fileName: string): string => join(flowDir, 'brain', '.structure', fileName);

  // ── readGraph / writeGraph ───────────────────────────────

  describe('readGraph', () => {
    it('should return null when graph.json is missing', () => {
      expect(readGraph(flowDir)).toBeNull();
    });

    it('should return null for corrupt JSON', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(blueprintPath('graph.json'), 'not json {{{', 'utf-8');

      expect(readGraph(flowDir)).toBeNull();
    });

    it('should return null for shape-invalid JSON (missing nodes/edges arrays)', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(blueprintPath('graph.json'), JSON.stringify({ version: 1, nodes: 5 }), 'utf-8');

      expect(readGraph(flowDir)).toBeNull();
    });

    it('should return null for an empty file', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(blueprintPath('graph.json'), '   \n', 'utf-8');

      expect(readGraph(flowDir)).toBeNull();
    });

    it('should round-trip a graph written by writeGraph', () => {
      const graph = makeGraph('2026-07-09T00:00:00.000Z');
      writeGraph(flowDir, graph);

      expect(readGraph(flowDir)).toEqual(graph);
    });
  });

  describe('writeGraph rotation', () => {
    it('should rotate the existing graph to graph.prev.json on the second write', () => {
      const first = makeGraph('2026-07-09T00:00:00.000Z');
      const second = makeGraph('2026-07-09T01:00:00.000Z');

      writeGraph(flowDir, first);
      expect(existsSync(blueprintPath('graph.prev.json'))).toBe(false);

      writeGraph(flowDir, second);

      expect(readGraph(flowDir)).toEqual(second);
      const prev = JSON.parse(readFileSync(blueprintPath('graph.prev.json'), 'utf-8')) as BlueprintGraph;
      expect(prev).toEqual(first);
    });

    it('should clean up the lock and temp files after a write', () => {
      writeGraph(flowDir, makeGraph('2026-07-09T00:00:00.000Z'));
      writeGraph(flowDir, makeGraph('2026-07-09T01:00:00.000Z'));

      expect(existsSync(blueprintPath('graph.lock'))).toBe(false);
      expect(existsSync(blueprintPath('graph.json.tmp'))).toBe(false);
    });

    it('should reclaim a stale lock and complete the write', () => {
      const graph = makeGraph('2026-07-09T00:00:00.000Z');
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(blueprintPath('graph.lock'), '', 'utf-8');
      // Age the lock past the 30s staleness timeout (simulating a crashed derive)
      const staleEpochSeconds = (Date.now() - 60_000) / 1000;
      utimesSync(blueprintPath('graph.lock'), staleEpochSeconds, staleEpochSeconds);

      writeGraph(flowDir, graph);

      expect(readGraph(flowDir)).toEqual(graph);
      expect(existsSync(blueprintPath('graph.lock'))).toBe(false);
    });

    it('should fail soft with a one-line error when a fresh lock stays contended', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(blueprintPath('graph.lock'), '', 'utf-8');

      expect(() => writeGraph(flowDir, makeGraph('2026-07-09T00:00:00.000Z'))).toThrow(
        'blueprint graph is locked by another derive — retry shortly',
      );
      // The contended write left no graph and did not steal the fresh lock
      expect(readGraph(flowDir)).toBeNull();
      expect(existsSync(blueprintPath('graph.lock'))).toBe(true);
    });
  });

  // ── annotationFingerprint ────────────────────────────────

  describe('annotationFingerprint', () => {
    it('should be stable regardless of anchor order', () => {
      const a = annotationFingerprint({
        type: 'claim',
        text: 'shared claim',
        anchors: [
          { kind: 'module', ref: 'api' },
          { kind: 'file', ref: 'src/lib/helper.ts' },
        ],
      });
      const b = annotationFingerprint({
        type: 'claim',
        text: 'shared claim',
        anchors: [
          { kind: 'file', ref: 'src/lib/helper.ts' },
          { kind: 'module', ref: 'api' },
        ],
      });

      expect(a).toBe(b);
      expect(a).toBe('claim+shared claim+["api","src/lib/helper.ts"]');
    });

    it('should not collide a single comma-containing ref with a multi-anchor set', () => {
      const singleRefWithComma = annotationFingerprint({
        type: 'claim',
        text: 'shared claim',
        anchors: [{ kind: 'module', ref: 'api,src/lib/helper.ts' }],
      });
      const twoRefs = annotationFingerprint({
        type: 'claim',
        text: 'shared claim',
        anchors: [
          { kind: 'module', ref: 'api' },
          { kind: 'file', ref: 'src/lib/helper.ts' },
        ],
      });

      expect(singleRefWithComma).not.toBe(twoRefs);
    });

    it('should differ when type, text, or anchors differ', () => {
      const base = { type: 'claim' as const, text: 'a', anchors: [{ kind: 'module' as const, ref: 'x' }] };

      expect(annotationFingerprint(base)).not.toBe(annotationFingerprint({ ...base, type: 'rule' }));
      expect(annotationFingerprint(base)).not.toBe(annotationFingerprint({ ...base, text: 'b' }));
      expect(annotationFingerprint(base)).not.toBe(
        annotationFingerprint({ ...base, anchors: [{ kind: 'module', ref: 'y' }] }),
      );
    });
  });

  // ── appendAnnotation / readAnnotations ───────────────────

  describe('annotation stream', () => {
    it('should append and read back an annotation', () => {
      const entry = makeAnnotation();
      appendAnnotation(flowDir, entry);

      expect(readAnnotations(flowDir)).toEqual([entry]);
    });

    it('should return an empty array when no annotation file exists', () => {
      expect(readAnnotations(flowDir)).toEqual([]);
    });

    it('should fold status events into the effective status (last event wins)', () => {
      const entry = makeAnnotation();
      const fingerprint = annotationFingerprint(entry);
      appendAnnotation(flowDir, entry);

      appendStatusEvent(flowDir, {
        ts: '2026-07-09T01:00:00.000Z',
        targetFingerprint: fingerprint,
        status: 'stale',
        reason: 'anchors lost: api',
      });
      expect(readAnnotations(flowDir)[0].status).toBe('stale');

      appendStatusEvent(flowDir, {
        ts: '2026-07-09T02:00:00.000Z',
        targetFingerprint: fingerprint,
        status: 'active',
        reason: 'anchors resolved again',
      });
      expect(readAnnotations(flowDir)[0].status).toBe('active');
    });

    it('should not apply status events targeting a different fingerprint', () => {
      appendAnnotation(flowDir, makeAnnotation());
      appendStatusEvent(flowDir, {
        ts: '2026-07-09T01:00:00.000Z',
        targetFingerprint: 'some+other+fingerprint',
        status: 'stale',
        reason: 'unrelated',
      });

      expect(readAnnotations(flowDir)[0].status).toBe('active');
    });

    it('should apply parse defaults on minimal entries (anchors → [], status → active)', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      appendFileSync(
        blueprintPath('annotations.jsonl'),
        `${JSON.stringify({ type: 'claim', text: 'minimal entry' })}\n`,
        'utf-8',
      );

      const entries = readAnnotations(flowDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        ts: '',
        runId: null,
        type: 'claim',
        text: 'minimal entry',
        anchors: [],
        provenance: '',
        status: 'active',
      });
    });

    it('should drop only the malformed anchors and keep valid siblings', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      appendFileSync(
        blueprintPath('annotations.jsonl'),
        `${JSON.stringify({
          type: 'claim',
          text: 'mixed anchors',
          anchors: [
            { kind: 'module', ref: 'api' },
            null,
            'not-an-object',
            { kind: 'bogus-kind', ref: 'x' },
            { kind: 'symbol', ref: '' },
            { kind: 'symbol' },
            { kind: 'file', ref: 'src/lib/helper.ts', file: 42 },
            { kind: 'symbol', ref: 'helper', file: 'src/lib/helper.ts' },
          ],
        })}\n`,
        'utf-8',
      );

      const entries = readAnnotations(flowDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].anchors).toEqual([
        { kind: 'module', ref: 'api' },
        { kind: 'symbol', ref: 'helper', file: 'src/lib/helper.ts' },
      ]);
    });

    it('should keep an entry whose anchors are all malformed as a zero-anchor entry', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      appendFileSync(
        blueprintPath('annotations.jsonl'),
        `${JSON.stringify({
          type: 'claim',
          text: 'all anchors malformed',
          anchors: [null, { kind: 'nope', ref: 'x' }, { ref: 'missing-kind' }],
        })}\n`,
        'utf-8',
      );

      const entries = readAnnotations(flowDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].anchors).toEqual([]);
    });

    it('should skip corrupt and shape-invalid annotation lines', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      appendFileSync(blueprintPath('annotations.jsonl'), 'not json at all\n', 'utf-8');
      appendFileSync(blueprintPath('annotations.jsonl'), `${JSON.stringify({ type: 'claim' })}\n`, 'utf-8');
      appendAnnotation(flowDir, makeAnnotation({ text: 'the only valid one' }));

      const entries = readAnnotations(flowDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe('the only valid one');
    });
  });

  // ── hashFileContent / hashRepoFileWithHint ───────────────

  describe('hashFileContent', () => {
    it('produces the same digest hashRepoFile produces for the same bytes', () => {
      writeFileSync(join(flowDir, 'a.ts'), 'export const a = 1;\n', 'utf-8');
      const viaFile = hashRepoFile(flowDir, 'a.ts');
      expect(viaFile.status).toBe('ok');
      expect(hashFileContent('export const a = 1;\n')).toBe(
        viaFile.status === 'ok' ? viaFile.contentHash : '',
      );
    });
  });

  describe('hashRepoFileWithHint', () => {
    const FIXED_MTIME = new Date(1700000000000);

    it('reuses the hint hash without reading when mtime AND size match (stat short-circuit)', () => {
      const absPath = join(flowDir, 'a.ts');
      writeFileSync(absPath, 'export const a = 1;\n', 'utf-8');
      utimesSync(absPath, FIXED_MTIME, FIXED_MTIME);
      const stat = statRepoFile(flowDir, 'a.ts');
      expect(stat.status).toBe('ok');
      if (stat.status !== 'ok') return;

      // Poison: SAME byte length, different content, mtime restored — a
      // content read would see the new bytes; the short-circuit must return
      // the hint's stored hash instead (proving no read happened).
      writeFileSync(absPath, 'export const z = 9;\n', 'utf-8');
      utimesSync(absPath, FIXED_MTIME, FIXED_MTIME);
      const storedHash = hashFileContent('export const a = 1;\n');

      const result = hashRepoFileWithHint(flowDir, 'a.ts', {
        contentHash: storedHash,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
      expect(result).toEqual({ status: 'ok', contentHash: storedHash });
    });

    it('falls back to the full content hash on mtime mismatch (content stays the truth)', () => {
      const absPath = join(flowDir, 'a.ts');
      writeFileSync(absPath, 'export const z = 9;\n', 'utf-8');
      const stat = statRepoFile(flowDir, 'a.ts');
      if (stat.status !== 'ok') throw new Error('stat failed');

      const result = hashRepoFileWithHint(flowDir, 'a.ts', {
        contentHash: 'f'.repeat(64), // stale stored hash — must NOT be returned
        mtimeMs: stat.mtimeMs + 1,
        size: stat.size,
      });
      expect(result).toEqual({ status: 'ok', contentHash: hashFileContent('export const z = 9;\n') });
    });

    it('falls back to the full content hash on size mismatch and on a hint-less call', () => {
      const absPath = join(flowDir, 'a.ts');
      writeFileSync(absPath, 'export const z = 9;\n', 'utf-8');
      const stat = statRepoFile(flowDir, 'a.ts');
      if (stat.status !== 'ok') throw new Error('stat failed');
      const truth = hashFileContent('export const z = 9;\n');

      expect(
        hashRepoFileWithHint(flowDir, 'a.ts', {
          contentHash: 'f'.repeat(64),
          mtimeMs: stat.mtimeMs,
          size: stat.size + 1,
        }),
      ).toEqual({ status: 'ok', contentHash: truth });
      expect(hashRepoFileWithHint(flowDir, 'a.ts', undefined)).toEqual({ status: 'ok', contentHash: truth });
      // Hints without stat fields (legacy stamps) never short-circuit.
      expect(hashRepoFileWithHint(flowDir, 'a.ts', { contentHash: 'f'.repeat(64) })).toEqual({
        status: 'ok',
        contentHash: truth,
      });
    });

    it('reports missing/escapes exactly like hashRepoFile', () => {
      expect(hashRepoFileWithHint(flowDir, 'gone.ts', { contentHash: 'f'.repeat(64), mtimeMs: 1, size: 1 })).toEqual({
        status: 'missing',
      });
      expect(hashRepoFileWithHint(flowDir, '../escape.ts', { contentHash: 'f'.repeat(64), mtimeMs: 1, size: 1 })).toEqual({
        status: 'escapes',
      });
    });
  });
});
