/**
 * Tests for must-review computation — every signal (graph deltas, god-node
 * degree, rounds risk/escalation/kept-verdict/failed-verification), severity
 * ranking with title tie-break, first-derive baseline behavior, and fail-soft
 * rounds parsing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeMustReview,
  parseRoundsFile,
  readRoundsRecords,
  type RoundsRecord,
} from './must-review.js';
import type { BlueprintGraph, BlueprintNode } from '../types.js';

describe('must-review', () => {
  // ── Helpers ──────────────────────────────────────────────

  function makeNode(overrides: Partial<BlueprintNode> & Pick<BlueprintNode, 'id' | 'kind'>): BlueprintNode {
    return {
      label: overrides.id,
      sourceFile: 'src/fixture.ts',
      ...overrides,
    };
  }

  function makeGraph(nodes: BlueprintNode[]): BlueprintGraph {
    return {
      version: 1,
      derivedAt: '2026-07-09T00:00:00.000Z',
      coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: [], graphifyEnriched: false },
      nodes,
      edges: [],
    };
  }

  const EMPTY_GRAPH = makeGraph([]);

  // ── Graph-delta signals ──────────────────────────────────

  describe('graph-delta signals', () => {
    it('should flag a new integration as crit', () => {
      const graph = makeGraph([makeNode({ id: 'integration:stripe', kind: 'integration', label: 'Stripe' })]);

      const items = computeMustReview({ graph, prevGraph: EMPTY_GRAPH, rounds: [] });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        rank: 1,
        severity: 'crit',
        title: 'New external integration: Stripe',
        nodeId: 'integration:stripe',
        source: 'graph-delta',
      });
    });

    it('should not flag an integration that existed in the previous derive', () => {
      const node = makeNode({ id: 'integration:stripe', kind: 'integration' });

      const items = computeMustReview({ graph: makeGraph([node]), prevGraph: makeGraph([node]), rounds: [] });

      expect(items).toEqual([]);
    });

    it('should flag a new datastore as high', () => {
      const graph = makeGraph([makeNode({ id: 'datastore:sqlite', kind: 'datastore', label: 'SQLite' })]);

      const items = computeMustReview({ graph, prevGraph: EMPTY_GRAPH, rounds: [] });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        severity: 'high',
        title: 'New data store: SQLite',
        nodeId: 'datastore:sqlite',
        source: 'graph-delta',
      });
    });

    it('should flag a datastore that gained tables as high, naming the gained tables', () => {
      const prev = makeGraph([
        makeNode({ id: 'datastore:sqlite', kind: 'datastore', label: 'SQLite', meta: { tables: ['users'] } }),
      ]);
      const graph = makeGraph([
        makeNode({
          id: 'datastore:sqlite',
          kind: 'datastore',
          label: 'SQLite',
          meta: { tables: ['orders', 'sessions', 'users'] },
        }),
      ]);

      const items = computeMustReview({ graph, prevGraph: prev, rounds: [] });

      expect(items).toHaveLength(1);
      expect(items[0].severity).toBe('high');
      expect(items[0].title).toBe('Data store gained tables: SQLite');
      expect(items[0].detail).toContain('orders, sessions');
    });

    it('should not flag a datastore whose tables are unchanged', () => {
      const node = makeNode({ id: 'datastore:sqlite', kind: 'datastore', meta: { tables: ['users'] } });

      const items = computeMustReview({ graph: makeGraph([node]), prevGraph: makeGraph([node]), rounds: [] });

      expect(items).toEqual([]);
    });

    it('should skip all delta signals on a first derive (null previous graph)', () => {
      const graph = makeGraph([
        makeNode({ id: 'integration:stripe', kind: 'integration' }),
        makeNode({ id: 'datastore:sqlite', kind: 'datastore' }),
        makeNode({ id: 'module:core', kind: 'module', meta: { degree: 60 } }),
      ]);

      const items = computeMustReview({ graph, prevGraph: null, rounds: [] });

      expect(items).toEqual([]);
    });
  });

  // God-node/degree signals were removed (Drift feature supersedes them —
  // degree is now a ranker, not a review row). Only graph-delta + rounds remain.

  // ── Rounds signals ───────────────────────────────────────

  describe('rounds signals', () => {
    it('should flag high risk as crit and medium risk as high; low risk is silent', () => {
      const rounds: RoundsRecord[] = [
        { type: 'risk', risk_level: 'high', risk_rationale: 'touches auth' },
        { type: 'risk', risk_level: 'medium', risk_rationale: 'schema change' },
        { type: 'risk', risk_level: 'low', risk_rationale: 'docs only' },
      ];

      const items = computeMustReview({ graph: EMPTY_GRAPH, prevGraph: null, rounds });

      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ severity: 'crit', title: 'Run risk assessed high', detail: 'touches auth' });
      expect(items[1]).toMatchObject({ severity: 'high', title: 'Run risk assessed medium', detail: 'schema change' });
    });

    it('should relay escalations verbatim (what + choice) as ask', () => {
      const rounds: RoundsRecord[] = [
        { type: 'escalation', what: 'Delete legacy table?', choice: 'kept the table' },
      ];

      const items = computeMustReview({ graph: EMPTY_GRAPH, prevGraph: null, rounds });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        severity: 'ask',
        title: 'Escalation: Delete legacy table?',
        detail: 'Delete legacy table? — choice: kept the table',
        source: 'rounds',
      });
    });

    it('should flag kept review verdicts as ask; other classifications are silent', () => {
      const rounds: RoundsRecord[] = [
        { type: 'review_verdict', classification: 'kept', finding_fingerprint: 'src/a.ts+Bug+correctness' },
        { type: 'review_verdict', classification: 'dismissed', finding_fingerprint: 'src/b.ts+Nit+style' },
      ];

      const items = computeMustReview({ graph: EMPTY_GRAPH, prevGraph: null, rounds });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        severity: 'ask',
        title: 'Kept review finding: src/a.ts+Bug+correctness',
      });
    });

    it('should flag failed-needs-decision verifications as ask; passing ones are silent', () => {
      const rounds: RoundsRecord[] = [
        { type: 'verification', status: 'failed-needs-decision', phase: 3, task: 2 },
        { type: 'verification', status: 'pass', phase: 3, task: 1 },
      ];

      const items = computeMustReview({ graph: EMPTY_GRAPH, prevGraph: null, rounds });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        severity: 'ask',
        title: 'Verification needs decision: phase 3 task 2',
      });
    });
  });

  // ── Ranking ──────────────────────────────────────────────

  describe('ranking', () => {
    it('should rank crit > high > ask with sequential ranks', () => {
      const graph = makeGraph([
        makeNode({ id: 'datastore:sqlite', kind: 'datastore', label: 'SQLite' }), // high
        makeNode({ id: 'integration:stripe', kind: 'integration', label: 'Stripe' }), // crit
      ]);
      const rounds: RoundsRecord[] = [{ type: 'escalation', what: 'Question?', choice: 'answer' }]; // ask

      const items = computeMustReview({ graph, prevGraph: EMPTY_GRAPH, rounds });

      expect(items.map((item) => item.severity)).toEqual(['crit', 'high', 'ask']);
      expect(items.map((item) => item.rank)).toEqual([1, 2, 3]);
    });

    it('should tie-break equal severities by codepoint title order', () => {
      const graph = makeGraph([
        makeNode({ id: 'integration:zebra', kind: 'integration', label: 'Zebra' }),
        makeNode({ id: 'integration:alpha', kind: 'integration', label: 'Alpha' }),
      ]);

      const items = computeMustReview({ graph, prevGraph: EMPTY_GRAPH, rounds: [] });

      expect(items.map((item) => item.title)).toEqual([
        'New external integration: Alpha',
        'New external integration: Zebra',
      ]);
    });

    it('should return an empty list when there is nothing to review', () => {
      expect(computeMustReview({ graph: EMPTY_GRAPH, prevGraph: null, rounds: [] })).toEqual([]);
    });
  });

  // ── Rounds parsing (fail-soft) ───────────────────────────

  describe('parseRoundsFile / readRoundsRecords', () => {
    let flowDir: string;

    beforeEach(() => {
      flowDir = mkdtempSync(join(tmpdir(), 'must-review-rounds-test-'));
    });

    afterEach(() => {
      rmSync(flowDir, { recursive: true, force: true });
    });

    it('should return an empty array for a missing file', () => {
      expect(parseRoundsFile(join(flowDir, 'nope.jsonl'))).toEqual([]);
      expect(readRoundsRecords(flowDir)).toEqual([]);
    });

    it('should skip malformed and non-object lines, keeping valid records', () => {
      const filePath = join(flowDir, '.rounds.jsonl');
      writeFileSync(
        filePath,
        ['not json at all', '[1,2,3]', '"just a string"', JSON.stringify({ type: 'risk', risk_level: 'low' }), ''].join(
          '\n',
        ),
        'utf-8',
      );

      const records = parseRoundsFile(filePath);

      expect(records).toEqual([{ type: 'risk', risk_level: 'low' }]);
      expect(readRoundsRecords(flowDir)).toEqual(records);
    });
  });
});
