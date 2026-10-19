/**
 * Tests for the investigation store — append+read roundtrip, supersede-chain
 * collapse, heat-tick aggregation, corrupt-line fail-soft, locked atomic
 * compaction (totals preserved, superseded dropped, idempotent), and
 * deterministic reads.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendHeatTick,
  appendInvestigationNote,
  compactInvestigations,
  COMPACT_MIN_BYTES,
  investigationFingerprint,
  maybeCompactInvestigations,
  normalizeInvestigationPaths,
  readInvestigations,
  wouldCreateSupersedeCycle,
} from './investigation-store.js';
import type { HeatTick, InvestigationEntry } from './types.js';

describe('investigation store', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'investigation-store-test-'));
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  // ── Helpers ──────────────────────────────────────────────

  function makeNote(overrides: Partial<InvestigationEntry> = {}): InvestigationEntry {
    return {
      ts: '2026-07-09T00:00:00.000Z',
      runId: 'run-1',
      anchors: [{ kind: 'file', ref: 'src/api/index.ts' }],
      text: 'Handler reads config lazily',
      provenance: 'observe-cli',
      status: 'observed',
      hashStamps: [{ ref: 'src/api/index.ts', contentHash: 'a'.repeat(64) }],
      ...overrides,
    };
  }

  function makeTick(overrides: Partial<HeatTick> = {}): HeatTick {
    return {
      ts: '2026-07-09T00:00:00.000Z',
      anchorRef: 'src/api/index.ts',
      visitor: 'agent',
      ...overrides,
    };
  }

  const storePath = (): string => join(flowDir, 'brain', '.structure', 'investigations.jsonl');

  const storeLineCount = (): number =>
    readFileSync(storePath(), 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0).length;

  // ── investigationFingerprint ─────────────────────────────

  describe('investigationFingerprint', () => {
    it('should combine text with the JSON array of sorted anchor refs', () => {
      const entry = makeNote({
        text: 'note',
        anchors: [
          { kind: 'file', ref: 'b.ts' },
          { kind: 'symbol', ref: 'a', file: 'a.ts' },
        ],
      });

      expect(investigationFingerprint(entry)).toBe('note+["a","b.ts"]');
    });

    it('should be stable regardless of anchor order', () => {
      const forward = makeNote({ anchors: [{ kind: 'file', ref: 'a.ts' }, { kind: 'file', ref: 'b.ts' }] });
      const reversed = makeNote({ anchors: [{ kind: 'file', ref: 'b.ts' }, { kind: 'file', ref: 'a.ts' }] });

      expect(investigationFingerprint(forward)).toBe(investigationFingerprint(reversed));
    });
  });

  // ── append + readInvestigations ──────────────────────────

  describe('readInvestigations', () => {
    it('should return empty notes and heat when the file is missing', () => {
      expect(readInvestigations(flowDir)).toEqual({ notes: [], heat: [] });
    });

    it('should round-trip an appended note and heat tick', () => {
      const note = makeNote({ ambiguous: true });
      appendInvestigationNote(flowDir, note);
      appendHeatTick(flowDir, makeTick({ visitor: 'human' }));

      const result = readInvestigations(flowDir);

      expect(result.notes).toEqual([note]);
      expect(result.heat).toEqual([
        {
          anchorRef: 'src/api/index.ts',
          humanVisits: 1,
          agentVisits: 0,
          lastVisited: '2026-07-09T00:00:00.000Z',
        },
      ]);
    });

    it('should collapse a supersede chain of 2 (latest wins)', () => {
      const original = makeNote({ text: 'first look' });
      const replacement = makeNote({
        ts: '2026-07-09T01:00:00.000Z',
        text: 'corrected look',
        supersedes: investigationFingerprint(original),
      });
      appendInvestigationNote(flowDir, original);
      appendInvestigationNote(flowDir, replacement);

      const { notes } = readInvestigations(flowDir);

      expect(notes).toEqual([replacement]);
    });

    it('should collapse a supersede chain of 3 (latest wins)', () => {
      const first = makeNote({ text: 'v1' });
      const second = makeNote({
        ts: '2026-07-09T01:00:00.000Z',
        text: 'v2',
        supersedes: investigationFingerprint(first),
      });
      const third = makeNote({
        ts: '2026-07-09T02:00:00.000Z',
        text: 'v3',
        supersedes: investigationFingerprint(second),
      });
      appendInvestigationNote(flowDir, first);
      appendInvestigationNote(flowDir, second);
      appendInvestigationNote(flowDir, third);

      const { notes } = readInvestigations(flowDir);

      expect(notes).toEqual([third]);
    });

    it('should aggregate heat ticks per anchor ref with human/agent counts separated and lastVisited max', () => {
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T02:00:00.000Z', visitor: 'human' }));
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T01:00:00.000Z', visitor: 'agent' }));
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T00:30:00.000Z', visitor: 'agent' }));
      appendHeatTick(flowDir, makeTick({ anchorRef: 'src/other.ts', ts: '2026-07-09T03:00:00.000Z', visitor: 'agent' }));

      const { heat } = readInvestigations(flowDir);

      expect(heat).toEqual([
        {
          anchorRef: 'src/api/index.ts',
          humanVisits: 1,
          agentVisits: 2,
          lastVisited: '2026-07-09T02:00:00.000Z',
        },
        {
          anchorRef: 'src/other.ts',
          humanVisits: 0,
          agentVisits: 1,
          lastVisited: '2026-07-09T03:00:00.000Z',
        },
      ]);
    });

    it('should skip corrupt lines and keep valid siblings', () => {
      const note = makeNote();
      appendInvestigationNote(flowDir, note);
      appendFileSync(storePath(), 'not json {{{\n', 'utf-8');
      appendFileSync(storePath(), `${JSON.stringify({ kind: 'note' })}\n`, 'utf-8'); // note without text
      appendFileSync(storePath(), `${JSON.stringify({ kind: 'heat', anchorRef: '' })}\n`, 'utf-8'); // heat without shape
      appendHeatTick(flowDir, makeTick());

      const result = readInvestigations(flowDir);

      expect(result.notes).toEqual([note]);
      expect(result.heat).toHaveLength(1);
    });

    it('should sort notes by ts then fingerprint deterministically', () => {
      const later = makeNote({ ts: '2026-07-09T02:00:00.000Z', text: 'z later' });
      const earlyB = makeNote({ ts: '2026-07-09T01:00:00.000Z', text: 'b early' });
      const earlyA = makeNote({ ts: '2026-07-09T01:00:00.000Z', text: 'a early' });
      appendInvestigationNote(flowDir, later);
      appendInvestigationNote(flowDir, earlyB);
      appendInvestigationNote(flowDir, earlyA);

      const { notes } = readInvestigations(flowDir);

      expect(notes).toEqual([earlyA, earlyB, later]);
    });

    // ── C1 regression: cycle-tolerant supersede fold ───────

    it('should keep the newest member of a 2-cycle instead of dropping both (restore-previous-note flow)', () => {
      const original = makeNote({ text: 'helper returns ok' });
      const correction = makeNote({
        ts: '2026-07-09T01:00:00.000Z',
        text: 'helper returns nope',
        supersedes: investigationFingerprint(original),
      });
      // Restoring the original text re-mints the SAME fingerprint — the
      // supersede pointer back to the correction closes a 2-cycle.
      const restored = makeNote({
        ts: '2026-07-09T02:00:00.000Z',
        text: 'helper returns ok',
        supersedes: investigationFingerprint(correction),
      });
      appendInvestigationNote(flowDir, original);
      appendInvestigationNote(flowDir, correction);
      appendInvestigationNote(flowDir, restored);

      const { notes } = readInvestigations(flowDir);

      expect(notes).toEqual([restored]);
    });

    it('should keep a self-referencing note instead of dropping it', () => {
      const selfRef = makeNote({ text: 'self-superseding note' });
      selfRef.supersedes = investigationFingerprint(selfRef);
      appendInvestigationNote(flowDir, selfRef);

      const { notes } = readInvestigations(flowDir);

      expect(notes).toEqual([selfRef]);
    });

    it('should keep only the newest member of a 3-cycle', () => {
      const first = makeNote({ text: 'a' });
      const second = makeNote({
        ts: '2026-07-09T01:00:00.000Z',
        text: 'b',
        supersedes: investigationFingerprint(first),
      });
      const third = makeNote({
        ts: '2026-07-09T02:00:00.000Z',
        text: 'c',
        supersedes: investigationFingerprint(second),
      });
      first.supersedes = investigationFingerprint(third);
      appendInvestigationNote(flowDir, first);
      appendInvestigationNote(flowDir, second);
      appendInvestigationNote(flowDir, third);

      const { notes } = readInvestigations(flowDir);

      expect(notes).toEqual([third]);
    });

    it('should still drop a cycle winner that is superseded from outside the cycle', () => {
      const first = makeNote({ text: 'a' });
      const second = makeNote({ ts: '2026-07-09T01:00:00.000Z', text: 'b', supersedes: investigationFingerprint(first) });
      first.supersedes = investigationFingerprint(second);
      // An independent later note supersedes the cycle's newest member — the
      // external supersession wins and nothing from the cycle survives.
      const external = makeNote({
        ts: '2026-07-09T02:00:00.000Z',
        text: 'external replacement',
        supersedes: investigationFingerprint(second),
      });
      appendInvestigationNote(flowDir, first);
      appendInvestigationNote(flowDir, second);
      appendInvestigationNote(flowDir, external);

      const { notes } = readInvestigations(flowDir);

      expect(notes).toEqual([external]);
    });

    it('should return identical results on a double read', () => {
      appendInvestigationNote(flowDir, makeNote());
      appendInvestigationNote(flowDir, makeNote({ ts: '2026-07-09T01:00:00.000Z', text: 'second' }));
      appendHeatTick(flowDir, makeTick({ visitor: 'human' }));
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T01:00:00.000Z' }));

      expect(readInvestigations(flowDir)).toEqual(readInvestigations(flowDir));
    });
  });

  // ── compactInvestigations ────────────────────────────────

  describe('compactInvestigations', () => {
    it('should return zeros and create no file when the store is missing', () => {
      const result = compactInvestigations(flowDir);

      expect(result).toEqual({ notesKept: 0, notesDropped: 0, heatLinesBefore: 0, heatLinesAfter: 0 });
      expect(existsSync(storePath())).toBe(false);
    });

    it('should drop superseded notes, keep non-superseded notes, and aggregate heat', () => {
      const original = makeNote({ text: 'first look' });
      const replacement = makeNote({
        ts: '2026-07-09T01:00:00.000Z',
        text: 'corrected look',
        supersedes: investigationFingerprint(original),
      });
      const independent = makeNote({ ts: '2026-07-09T02:00:00.000Z', text: 'independent finding' });
      appendInvestigationNote(flowDir, original);
      appendInvestigationNote(flowDir, replacement);
      appendInvestigationNote(flowDir, independent);
      appendHeatTick(flowDir, makeTick({ visitor: 'human' }));
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T01:00:00.000Z', visitor: 'agent' }));

      const result = compactInvestigations(flowDir);

      expect(result).toEqual({ notesKept: 2, notesDropped: 1, heatLinesBefore: 2, heatLinesAfter: 1 });
      expect(storeLineCount()).toBe(3); // 1 aggregated heat line + 2 kept notes
      const after = readInvestigations(flowDir);
      expect(after.notes).toEqual([replacement, independent]);
      expect(after.heat).toEqual([
        {
          anchorRef: 'src/api/index.ts',
          humanVisits: 1,
          agentVisits: 1,
          lastVisited: '2026-07-09T01:00:00.000Z',
        },
      ]);
    });

    it('should preserve total heat counts across compaction and further ticks', () => {
      appendHeatTick(flowDir, makeTick({ visitor: 'human' }));
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T01:00:00.000Z', visitor: 'agent' }));
      compactInvestigations(flowDir);
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T02:00:00.000Z', visitor: 'agent' }));

      const { heat } = readInvestigations(flowDir);

      expect(heat).toEqual([
        {
          anchorRef: 'src/api/index.ts',
          humanVisits: 1,
          agentVisits: 2,
          lastVisited: '2026-07-09T02:00:00.000Z',
        },
      ]);
    });

    it('should be idempotent — a second compact is a no-op', () => {
      const original = makeNote({ text: 'first look' });
      appendInvestigationNote(flowDir, original);
      appendInvestigationNote(
        flowDir,
        makeNote({ ts: '2026-07-09T01:00:00.000Z', text: 'corrected look', supersedes: investigationFingerprint(original) })
      );
      appendHeatTick(flowDir, makeTick({ visitor: 'human' }));
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T01:00:00.000Z' }));

      compactInvestigations(flowDir);
      const afterFirst = readFileSync(storePath(), 'utf-8');

      const secondResult = compactInvestigations(flowDir);
      const afterSecond = readFileSync(storePath(), 'utf-8');

      expect(afterSecond).toBe(afterFirst);
      expect(secondResult).toEqual({ notesKept: 1, notesDropped: 0, heatLinesBefore: 1, heatLinesAfter: 1 });
    });

    it('should clean up the lock and temp files after compaction', () => {
      appendInvestigationNote(flowDir, makeNote());

      compactInvestigations(flowDir);

      expect(existsSync(join(flowDir, 'brain', '.structure', 'investigations.lock'))).toBe(false);
      expect(existsSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl.tmp'))).toBe(false);
    });

    it('should drop corrupt lines during compaction while keeping valid ones', () => {
      appendInvestigationNote(flowDir, makeNote());
      appendFileSync(storePath(), 'garbage line\n', 'utf-8');
      appendHeatTick(flowDir, makeTick());

      const result = compactInvestigations(flowDir);

      expect(result.notesKept).toBe(1);
      expect(storeLineCount()).toBe(2); // 1 heat aggregate + 1 note; garbage gone
    });

    it('should throw a one-line error when the store lock is held', () => {
      appendInvestigationNote(flowDir, makeNote());
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      appendFileSync(join(flowDir, 'brain', '.structure', 'investigations.lock'), '', 'utf-8');

      expect(() => compactInvestigations(flowDir)).toThrow('investigation store is locked by another writer — retry shortly');
    });

    it('should physically keep the newest cycle member across compaction (C1 in the compaction path)', () => {
      const original = makeNote({ text: 'helper returns ok' });
      const correction = makeNote({
        ts: '2026-07-09T01:00:00.000Z',
        text: 'helper returns nope',
        supersedes: investigationFingerprint(original),
      });
      const restored = makeNote({
        ts: '2026-07-09T02:00:00.000Z',
        text: 'helper returns ok',
        supersedes: investigationFingerprint(correction),
      });
      appendInvestigationNote(flowDir, original);
      appendInvestigationNote(flowDir, correction);
      appendInvestigationNote(flowDir, restored);

      const result = compactInvestigations(flowDir);

      expect(result.notesKept).toBe(1);
      expect(result.notesDropped).toBe(2);
      expect(storeLineCount()).toBe(1);
      expect(readInvestigations(flowDir).notes).toEqual([restored]);
    });
  });

  // ── C2 regression: appends share the compaction lock ─────

  describe('append locking', () => {
    it('should refuse appends while the store lock is held, then land post-compaction appends in the new file', () => {
      appendInvestigationNote(flowDir, makeNote());
      const lockPath = join(flowDir, 'brain', '.structure', 'investigations.lock');
      // Simulate compaction's read→rename window: the lock is held by the
      // compacting writer, so no append may land on the soon-stale inode.
      writeFileSync(lockPath, '', 'utf-8');

      expect(() => appendInvestigationNote(flowDir, makeNote({ text: 'blocked note' }))).toThrow(
        'investigation store busy — retry',
      );
      expect(() => appendHeatTick(flowDir, makeTick())).toThrow('investigation store busy — retry');
      expect(storeLineCount()).toBe(1); // nothing landed during the window

      // Window closes: compaction finishes and releases the lock — the next
      // append lands in the NEW (renamed) file and survives reads.
      unlinkSync(lockPath);
      compactInvestigations(flowDir);
      appendInvestigationNote(flowDir, makeNote({ ts: '2026-07-09T01:00:00.000Z', text: 'after compaction' }));

      const { notes } = readInvestigations(flowDir);
      expect(notes.map((note) => note.text)).toEqual(['Handler reads config lazily', 'after compaction']);
    });
  });

  // ── C1 regression: write-time cycle refusal support ──────

  describe('wouldCreateSupersedeCycle', () => {
    it('should detect a direct self-reference without reading the store', () => {
      expect(wouldCreateSupersedeCycle(flowDir, 'fp-x', 'fp-x')).toBe(true);
    });

    it('should detect a cycle through an existing supersede chain', () => {
      const original = makeNote({ text: 'helper returns ok' });
      const correction = makeNote({
        ts: '2026-07-09T01:00:00.000Z',
        text: 'helper returns nope',
        supersedes: investigationFingerprint(original),
      });
      appendInvestigationNote(flowDir, original);
      appendInvestigationNote(flowDir, correction);

      // Re-writing the original text supersede-targeting the correction
      // walks correction → original == new fingerprint → cycle.
      expect(
        wouldCreateSupersedeCycle(flowDir, investigationFingerprint(original), investigationFingerprint(correction)),
      ).toBe(true);
    });

    it('should accept a linear (non-cyclic) supersede target', () => {
      const original = makeNote({ text: 'helper returns ok' });
      const correction = makeNote({
        ts: '2026-07-09T01:00:00.000Z',
        text: 'helper returns nope',
        supersedes: investigationFingerprint(original),
      });
      appendInvestigationNote(flowDir, original);
      appendInvestigationNote(flowDir, correction);

      expect(wouldCreateSupersedeCycle(flowDir, 'fp-of-a-brand-new-note', investigationFingerprint(correction))).toBe(
        false,
      );
    });

    it('should terminate on a pre-existing cycle that does not involve the new entry', () => {
      const first = makeNote({ text: 'a' });
      const second = makeNote({ ts: '2026-07-09T01:00:00.000Z', text: 'b', supersedes: investigationFingerprint(first) });
      first.supersedes = investigationFingerprint(second);
      appendInvestigationNote(flowDir, first);
      appendInvestigationNote(flowDir, second);

      expect(wouldCreateSupersedeCycle(flowDir, 'fp-unrelated', investigationFingerprint(first))).toBe(false);
    });
  });

  // ── C3 regression: threshold-triggered auto-compaction ───

  describe('maybeCompactInvestigations', () => {
    it('should return null when the store is missing', () => {
      expect(maybeCompactInvestigations(flowDir)).toBeNull();
      expect(existsSync(storePath())).toBe(false);
    });

    it('should return null and leave the file untouched below both thresholds', () => {
      appendInvestigationNote(flowDir, makeNote());
      appendInvestigationNote(flowDir, makeNote({ ts: '2026-07-09T01:00:00.000Z', text: 'second independent note' }));
      const before = readFileSync(storePath(), 'utf-8');

      expect(maybeCompactInvestigations(flowDir)).toBeNull();

      expect(readFileSync(storePath(), 'utf-8')).toBe(before);
    });

    it('should compact when the fold-dropped ratio reaches the threshold', () => {
      const original = makeNote({ text: 'first look' });
      appendInvestigationNote(flowDir, original);
      appendInvestigationNote(
        flowDir,
        makeNote({ ts: '2026-07-09T01:00:00.000Z', text: 'corrected look', supersedes: investigationFingerprint(original) }),
      );

      const result = maybeCompactInvestigations(flowDir);

      expect(result).toEqual({ notesKept: 1, notesDropped: 1, heatLinesBefore: 0, heatLinesAfter: 0 });
      expect(storeLineCount()).toBe(1);
    });

    it('should count aggregatable heat ticks toward the fold-dropped ratio', () => {
      appendHeatTick(flowDir, makeTick());
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T01:00:00.000Z' }));
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T02:00:00.000Z' }));
      appendHeatTick(flowDir, makeTick({ ts: '2026-07-09T03:00:00.000Z', visitor: 'human' }));

      const result = maybeCompactInvestigations(flowDir);

      // 4 ticks → 1 aggregate: 3 of 4 lines foldable (0.75 ≥ threshold)
      expect(result).toEqual({ notesKept: 0, notesDropped: 0, heatLinesBefore: 4, heatLinesAfter: 1 });
      expect(storeLineCount()).toBe(1);
    });

    it('should compact on file size alone even when nothing folds', () => {
      appendInvestigationNote(flowDir, makeNote({ text: 'x'.repeat(COMPACT_MIN_BYTES) }));

      const result = maybeCompactInvestigations(flowDir);

      expect(result).toEqual({ notesKept: 1, notesDropped: 0, heatLinesBefore: 0, heatLinesAfter: 0 });
    });
  });

  // ── app fold parity ──────────────────────────────────────
  //
  // SYNC NOTE: these fixture lines and their expected ACTIVE fingerprints are
  // DUPLICATED in app/src/main/blueprint/blueprint-observer.test.ts
  // ("CLI ↔ app investigation fold parity"). This store is the fold AUTHORITY;
  // the app mirror is a minimal supersede-drop (no cycle rescue / heat). The
  // fixture is cycle-free so both folds MUST yield the same active notes.
  // When either side changes, update both.
  describe('app fold parity', () => {
    const PARITY_LINES = [
      '{"kind":"note","ts":"2026-07-15T00:00:00.000Z","runId":"r","anchors":[{"kind":"file","ref":"src/a.ts"}],"text":"note A","provenance":"observe-cli","status":"observed","hashStamps":[]}',
      '{"kind":"note","ts":"2026-07-15T01:00:00.000Z","runId":"r","anchors":[{"kind":"file","ref":"src/b.ts"}],"text":"note B","provenance":"observe-cli","status":"observed","hashStamps":[]}',
      '{"kind":"note","ts":"2026-07-15T02:00:00.000Z","runId":"r","anchors":[{"kind":"file","ref":"src/c.ts"}],"text":"note C","provenance":"observe-cli","status":"observed","hashStamps":[],"supersedes":"note A+[\\"src/a.ts\\"]"}',
      'not json — skipped by both folds',
      '{"kind":"heat","ts":"2026-07-15T02:30:00.000Z","anchorRef":"src/a.ts","visitor":"agent"}',
      '{"kind":"note","ts":"2026-07-15T03:00:00.000Z","runId":"r","anchors":[{"kind":"module","ref":"mod/x"}],"text":"note D","provenance":"observe-cli","status":"observed","hashStamps":[]}',
    ];
    const EXPECTED_ACTIVE_FINGERPRINTS = [
      'note B+["src/b.ts"]',
      'note C+["src/c.ts"]',
      'note D+["mod/x"]',
    ];

    it('readInvestigations yields the same active notes the app mirror does', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(storePath(), `${PARITY_LINES.join('\n')}\n`, 'utf-8');
      const { notes } = readInvestigations(flowDir);
      expect(notes.map((note) => investigationFingerprint(note))).toEqual(EXPECTED_ACTIVE_FINGERPRINTS);
    });
  });

  // ── normalizeInvestigationPaths (migration, task 4.3) ────

  describe('normalizeInvestigationPaths', () => {
    const REPO = '/Users/dev/Projects/orbit-app';
    const VAULT_FLOW = '/Users/dev/plan-flow/brain/projects/orbit-app/flow';

    /** Write raw store lines exactly as given (no re-serialization). */
    function writeStore(lines: string[]): void {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(storePath(), `${lines.join('\n')}\n`, 'utf-8');
    }

    const portableLine = (n: number): string =>
      JSON.stringify({
        kind: 'note',
        ts: `2026-07-0${n}T00:00:00.000Z`,
        runId: null,
        anchors: [{ kind: 'file', ref: `src/mod${n}.ts` }],
        text: `portable ${n}`,
        provenance: 'observe-cli',
        status: 'observed',
        hashStamps: [],
      });

    it('rewrites an absolute anchor ref to repo-relative', () => {
      writeStore([
        JSON.stringify({
          kind: 'note',
          ts: '2026-07-09T00:00:00.000Z',
          runId: null,
          anchors: [{ kind: 'file', ref: `${REPO}/src/api/index.ts` }],
          text: 'leaks',
          provenance: 'observe-cli',
          status: 'observed',
          hashStamps: [{ ref: `${REPO}/src/api/index.ts`, contentHash: 'a'.repeat(64) }],
        }),
      ]);

      const result = normalizeInvestigationPaths(flowDir, [REPO]);

      expect(result).toEqual({ scanned: 1, rewritten: 1, unchanged: 0 });
      const { notes } = readInvestigations(flowDir);
      expect(notes[0].anchors[0].ref).toBe('src/api/index.ts');
      expect(notes[0].hashStamps[0].ref).toBe('src/api/index.ts');
    });

    it('leaves every already-portable line BYTE-IDENTICAL', () => {
      const portable = [portableLine(1), portableLine(2), portableLine(3)];
      const leaking = JSON.stringify({
        kind: 'note',
        ts: '2026-07-04T00:00:00.000Z',
        runId: null,
        anchors: [{ kind: 'file', ref: `${REPO}/src/leak.ts` }],
        text: 'leaks',
        provenance: 'observe-cli',
        status: 'observed',
        hashStamps: [],
      });
      writeStore([...portable, leaking]);

      const result = normalizeInvestigationPaths(flowDir, [REPO]);

      expect(result).toEqual({ scanned: 4, rewritten: 1, unchanged: 3 });
      const after = readFileSync(storePath(), 'utf-8').split('\n');
      expect(after.slice(0, 3)).toEqual(portable);
      expect(after[3]).toContain('"ref":"src/leak.ts"');
      expect(after[3]).not.toContain(REPO);
    });

    it('maps the OLD VAULT flow directory onto the repo-relative flow/ prefix', () => {
      writeStore([
        JSON.stringify({
          kind: 'note',
          ts: '2026-07-09T00:00:00.000Z',
          runId: null,
          anchors: [{ kind: 'file', ref: `${VAULT_FLOW}/plans/plan_x_v1.md` }],
          text: 'plan lives in the vault',
          provenance: 'observe-cli',
          status: 'observed',
          hashStamps: [],
        }),
      ]);

      normalizeInvestigationPaths(flowDir, [REPO, { prefix: VAULT_FLOW, replacement: 'flow' }]);

      const { notes } = readInvestigations(flowDir);
      expect(notes[0].anchors[0].ref).toBe('flow/plans/plan_x_v1.md');
    });

    it('strips the path inside prose without touching the surrounding words', () => {
      writeStore([
        JSON.stringify({
          kind: 'note',
          ts: '2026-07-09T00:00:00.000Z',
          runId: null,
          anchors: [],
          text: `The guard lives in ${REPO}/src/guard.ts and refuses early`,
          provenance: 'observe-cli',
          status: 'observed',
          hashStamps: [],
        }),
      ]);

      normalizeInvestigationPaths(flowDir, [REPO]);

      const { notes } = readInvestigations(flowDir);
      expect(notes[0].text).toBe('The guard lives in src/guard.ts and refuses early');
    });

    it('normalizes a heat line anchorRef too', () => {
      writeStore([
        JSON.stringify({ kind: 'heat', anchorRef: `${REPO}/src/hot.ts`, ts: '2026-07-09T00:00:00.000Z', visitor: 'agent' }),
      ]);

      const result = normalizeInvestigationPaths(flowDir, [REPO]);

      expect(result.rewritten).toBe(1);
      const { heat } = readInvestigations(flowDir);
      expect(heat[0].anchorRef).toBe('src/hot.ts');
    });

    it('never drops an entry — corrupt lines survive verbatim', () => {
      writeStore([
        'not json at all',
        JSON.stringify({
          kind: 'note',
          ts: '2026-07-09T00:00:00.000Z',
          runId: null,
          anchors: [{ kind: 'file', ref: `${REPO}/src/a.ts` }],
          text: 'leaks',
          provenance: 'observe-cli',
          status: 'observed',
          hashStamps: [],
        }),
      ]);

      const result = normalizeInvestigationPaths(flowDir, [REPO]);

      expect(result).toEqual({ scanned: 2, rewritten: 1, unchanged: 1 });
      expect(storeLineCount()).toBe(2);
      expect(readFileSync(storePath(), 'utf-8').split('\n')[0]).toBe('not json at all');
    });

    it('is a no-op (file untouched) when nothing leaks — and on a missing store', () => {
      writeStore([portableLine(1), portableLine(2)]);
      const before = readFileSync(storePath(), 'utf-8');

      const result = normalizeInvestigationPaths(flowDir, [REPO]);

      expect(result).toEqual({ scanned: 2, rewritten: 0, unchanged: 2 });
      expect(readFileSync(storePath(), 'utf-8')).toBe(before);

      const emptyDir = mkdtempSync(join(tmpdir(), 'investigation-empty-'));
      expect(normalizeInvestigationPaths(emptyDir, [REPO])).toEqual({ scanned: 0, rewritten: 0, unchanged: 0 });
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('is idempotent — a second pass rewrites nothing', () => {
      writeStore([
        JSON.stringify({
          kind: 'note',
          ts: '2026-07-09T00:00:00.000Z',
          runId: null,
          anchors: [{ kind: 'file', ref: `${REPO}/src/a.ts` }],
          text: 'leaks',
          provenance: 'observe-cli',
          status: 'observed',
          hashStamps: [],
        }),
      ]);

      normalizeInvestigationPaths(flowDir, [REPO]);
      const afterFirst = readFileSync(storePath(), 'utf-8');
      const second = normalizeInvestigationPaths(flowDir, [REPO]);

      expect(second.rewritten).toBe(0);
      expect(readFileSync(storePath(), 'utf-8')).toBe(afterFirst);
    });
  });


  // ── Read-time dedupe of union-merge twins (task 4.5) ─────

  describe('read-time dedupe (merge=union twins)', () => {
    function writeStore(lines: string[]): void {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(storePath(), `${lines.join('\n')}\n`, 'utf-8');
    }

    it('two teammates appending the SAME note read back as one', () => {
      const note = JSON.stringify({ kind: 'note', ...makeNote({ text: 'the same fact' }) });
      writeStore([note, note]);

      const { notes } = readInvestigations(flowDir);

      expect(notes).toHaveLength(1);
      expect(notes[0].text).toBe('the same fact');
      expect(storeLineCount()).toBe(2); // the FILE is untouched — dedupe is on read
    });

    it('dedupes regardless of key order (the same record, serialized differently)', () => {
      // The reordering must be a REORDERING. This fixture previously built `b`
      // with `JSON.stringify(obj, keys)` — the replacer-ARRAY form, which is a
      // recursive property allowlist and therefore emptied every nested object.
      // `b` was not the same record serialized differently; it was a record with
      // its anchors and hashStamps stripped. It only compared equal because
      // `noteIdentity` had the identical bug, so the test passed by cancellation
      // and the real dedupe went unverified.
      const entry = makeNote({ text: 'key order should not matter' });
      const record = { kind: 'note', ...entry } as Record<string, unknown>;
      const a = JSON.stringify(record);
      const b = JSON.stringify(
        Object.fromEntries(Object.entries(record).sort(([x], [y]) => (x < y ? -1 : 1))),
      );
      expect(a).not.toBe(b); // different key ORDER
      expect(JSON.parse(a)).toEqual(JSON.parse(b)); // same CONTENT, nesting intact
      writeStore([a, b]);

      expect(readInvestigations(flowDir).notes).toHaveLength(1);
    });

    it('keeps notes that DIFFER — a different timestamp is a different fact', () => {
      writeStore([
        JSON.stringify({ kind: 'note', ...makeNote({ text: 'same text', ts: '2026-07-09T00:00:00.000Z' }) }),
        JSON.stringify({ kind: 'note', ...makeNote({ text: 'same text', ts: '2026-07-10T00:00:00.000Z' }) }),
      ]);

      expect(readInvestigations(flowDir).notes).toHaveLength(2);
    });

    it('does NOT dedupe heat ticks — two identical ticks are two real visits', () => {
      const tick = JSON.stringify({ kind: 'heat', ...makeTick() });
      writeStore([tick, tick]);

      const { heat } = readInvestigations(flowDir);

      expect(heat).toHaveLength(1);
      expect(heat[0].agentVisits).toBe(2);
    });

    it('compaction physically removes the twin, keeping one copy', () => {
      const note = JSON.stringify({ kind: 'note', ...makeNote({ text: 'twinned' }) });
      writeStore([note, note]);

      compactInvestigations(flowDir);

      expect(storeLineCount()).toBe(1);
      expect(readInvestigations(flowDir).notes).toHaveLength(1);
    });
  });

});
