/**
 * Tests for the promotion of anchored run records (`promoteRunRecords`) — the
 * Phase 3 mapping matrix: `run_intent` → decision (record-own run_id
 * provenance, graceful field omission), selective `phase_result` → claim
 * (only decision/deviation-bearing phases; silent non-candidates are never
 * skip-counted), backward-compatible mappings for plan_decision /
 * review_verdict / escalation / risk, idempotent re-runs, and malformed-line
 * skip counting.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promoteRunRecords } from './promote.js';
import { readAnnotations } from './store.js';
import type { Anchor } from './types.js';

const PASS_RUN_ID = 'promo-pass-001';
const ANCHORS: Anchor[] = [{ kind: 'file', ref: 'src/cli/promote.ts' }];

describe('promoteRunRecords', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'blueprint-promote-test-'));
    mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  function writeRounds(records: unknown[]): void {
    const lines = records.map((record) =>
      typeof record === 'string' ? record : JSON.stringify(record),
    );
    writeFileSync(join(flowDir, '.rounds.jsonl'), `${lines.join('\n')}\n`, 'utf-8');
  }

  // ── run_intent mapping ───────────────────────────────────

  describe('run_intent', () => {
    it('should promote a full anchored run_intent with exact text and record-own run_id provenance', () => {
      writeRounds([
        {
          ts: '2026-07-09T10:00:00Z',
          run_id: 'originating-run-42', // the run the intent BELONGS to
          type: 'run_intent',
          plan: 'plan_feature_v1',
          intent_goal: 'Ship the knowledge layer',
          originating_request: 'user asked for a living system map',
          anchors: ANCHORS,
        },
      ]);

      const result = promoteRunRecords(flowDir, PASS_RUN_ID);

      expect(result).toEqual({ promoted: 1, skipped: 0 });
      const annotations = readAnnotations(flowDir);
      expect(annotations).toEqual([
        {
          ts: '2026-07-09T10:00:00Z',
          runId: PASS_RUN_ID, // the promotion pass's run id
          type: 'decision',
          text: 'Run plan_feature_v1: Ship the knowledge layer — user asked for a living system map',
          anchors: ANCHORS,
          // Provenance carries the RECORD's run_id, not the pass's
          provenance: 'rounds:run_intent run:originating-run-42',
          status: 'active',
        },
      ]);
    });

    it.each([
      [
        'missing originating_request',
        { plan: 'plan_x', intent_goal: 'Goal only' },
        'Run plan_x: Goal only',
      ],
      [
        'missing intent_goal',
        { plan: 'plan_x', originating_request: 'Request only' },
        'Run plan_x: Request only',
      ],
      ['missing both detail fields', { plan: 'plan_x' }, 'Run plan_x'],
      [
        'missing plan',
        { intent_goal: 'Goal', originating_request: 'Req' },
        'Run: Goal — Req',
      ],
      ['all fields missing', {}, 'Run'],
    ])('should omit %s gracefully', (_label, fields, expectedText) => {
      writeRounds([
        { ts: '2026-07-09T10:00:00Z', run_id: 'r1', type: 'run_intent', ...fields, anchors: ANCHORS },
      ]);

      promoteRunRecords(flowDir, PASS_RUN_ID);

      expect(readAnnotations(flowDir)[0]).toMatchObject({ type: 'decision', text: expectedText });
    });

    it('should omit the run suffix from provenance when the record has no run_id', () => {
      writeRounds([
        { ts: '2026-07-09T10:00:00Z', type: 'run_intent', plan: 'plan_x', intent_goal: 'G', anchors: ANCHORS },
      ]);

      promoteRunRecords(flowDir, PASS_RUN_ID);

      expect(readAnnotations(flowDir)[0].provenance).toBe('rounds:run_intent');
    });
  });

  // ── phase_result mapping (selective) ─────────────────────

  describe('phase_result', () => {
    it('should promote an anchored phase_result WITH decisions as a claim with exact text', () => {
      writeRounds([
        {
          ts: '2026-07-09T11:00:00Z',
          run_id: PASS_RUN_ID,
          type: 'phase_result',
          phase: 2,
          plan: 'plan_feature_v1',
          summary: 'Implemented the validator',
          decisions: ['hard-error on violation', 'sorted error list'],
          deviations: ['skipped optional cache'],
          anchors: ANCHORS,
        },
      ]);

      const result = promoteRunRecords(flowDir, PASS_RUN_ID);

      expect(result).toEqual({ promoted: 1, skipped: 0 });
      expect(readAnnotations(flowDir)[0]).toMatchObject({
        type: 'claim',
        text: 'Phase 2 (plan_feature_v1): Implemented the validator — decisions: hard-error on violation, sorted error list; deviations: skipped optional cache',
        provenance: `rounds:phase_result run:${PASS_RUN_ID}`,
      });
    });

    it('should promote an anchored phase_result with deviations ONLY', () => {
      writeRounds([
        {
          ts: '2026-07-09T11:00:00Z',
          run_id: PASS_RUN_ID,
          type: 'phase_result',
          phase: 3,
          plan: 'plan_feature_v1',
          summary: 'Wired the CLI',
          deviations: ['used sync I/O'],
          anchors: ANCHORS,
        },
      ]);

      const result = promoteRunRecords(flowDir, PASS_RUN_ID);

      expect(result).toEqual({ promoted: 1, skipped: 0 });
      expect(readAnnotations(flowDir)[0]).toMatchObject({
        type: 'claim',
        text: 'Phase 3 (plan_feature_v1): Wired the CLI — deviations: used sync I/O',
      });
    });

    it('should NOT promote a decision-less anchored phase_result — and NOT skip-count it', () => {
      writeRounds([
        {
          ts: '2026-07-09T11:00:00Z',
          run_id: PASS_RUN_ID,
          type: 'phase_result',
          phase: 1,
          plan: 'plan_feature_v1',
          summary: 'Routine completion, nothing noteworthy',
          decisions: [],
          deviations: [],
          anchors: ANCHORS,
        },
      ]);

      const result = promoteRunRecords(flowDir, PASS_RUN_ID);

      // Silent non-candidate: neither promoted nor counted as skipped
      expect(result).toEqual({ promoted: 0, skipped: 0 });
      expect(readAnnotations(flowDir)).toEqual([]);
    });

    it('should NOT promote an anchorless phase_result even when it carries decisions', () => {
      writeRounds([
        {
          ts: '2026-07-09T11:00:00Z',
          run_id: PASS_RUN_ID,
          type: 'phase_result',
          phase: 4,
          plan: 'plan_feature_v1',
          summary: 'Decision-bearing but unanchored',
          decisions: ['important choice'],
        },
      ]);

      const result = promoteRunRecords(flowDir, PASS_RUN_ID);

      // Unanchored records are backward-compatible non-candidates, never skip-counted
      expect(result).toEqual({ promoted: 0, skipped: 0 });
      expect(readAnnotations(flowDir)).toEqual([]);
    });
  });

  // ── Backward-compatible mappings ─────────────────────────

  describe('backward-compatible record types', () => {
    it('should keep the plan_decision / review_verdict / escalation / risk mappings unchanged', () => {
      writeRounds([
        {
          ts: '2026-07-09T12:00:00Z',
          type: 'plan_decision',
          decision: 'Use append-only store',
          choice: 'jsonl',
          anchors: ANCHORS,
        },
        {
          ts: '2026-07-09T12:00:01Z',
          type: 'review_verdict',
          classification: 'kept',
          finding_fingerprint: 'file.ts+title+category',
          reason: 'real bug',
          anchors: ANCHORS,
        },
        {
          ts: '2026-07-09T12:00:02Z',
          type: 'review_verdict',
          classification: 'dismissed',
          finding_fingerprint: 'other.ts+t+c',
          reason: 'intended behavior',
          anchors: ANCHORS,
        },
        {
          ts: '2026-07-09T12:00:03Z',
          type: 'escalation',
          what: 'verify retries exhausted',
          choice: 'user accepted',
          anchors: ANCHORS,
        },
        {
          ts: '2026-07-09T12:00:04Z',
          type: 'risk',
          risk_level: 'medium',
          risk_rationale: 'touches the derive pipeline',
          anchors: ANCHORS,
        },
      ]);

      const result = promoteRunRecords(flowDir, PASS_RUN_ID);

      expect(result).toEqual({ promoted: 5, skipped: 0 });
      const annotations = readAnnotations(flowDir);
      expect(annotations.map((entry) => ({ type: entry.type, text: entry.text, provenance: entry.provenance }))).toEqual([
        {
          type: 'decision',
          text: 'Use append-only store: jsonl',
          provenance: `rounds:plan_decision run:${PASS_RUN_ID}`,
        },
        {
          type: 'rule', // kept verdicts become rules
          text: 'file.ts+title+category: real bug',
          provenance: `rounds:review_verdict run:${PASS_RUN_ID}`,
        },
        {
          type: 'claim', // non-kept verdicts stay claims
          text: 'other.ts+t+c: intended behavior',
          provenance: `rounds:review_verdict run:${PASS_RUN_ID}`,
        },
        {
          type: 'claim',
          text: 'verify retries exhausted: user accepted',
          provenance: `rounds:escalation run:${PASS_RUN_ID}`,
        },
        {
          type: 'claim',
          text: 'medium: touches the derive pipeline',
          provenance: `rounds:risk run:${PASS_RUN_ID}`,
        },
      ]);
    });

    it('should omit the run suffix from default provenance when the pass run id is null', () => {
      writeRounds([
        { ts: '2026-07-09T12:00:00Z', type: 'plan_decision', decision: 'D', choice: 'C', anchors: ANCHORS },
      ]);

      promoteRunRecords(flowDir, null);

      expect(readAnnotations(flowDir)[0]).toMatchObject({
        runId: null,
        provenance: 'rounds:plan_decision',
      });
    });
  });

  // ── Idempotency ──────────────────────────────────────────

  it('should dedup on re-run — the second pass promotes nothing and skip-counts duplicates', () => {
    writeRounds([
      {
        ts: '2026-07-09T13:00:00Z',
        run_id: 'r1',
        type: 'run_intent',
        plan: 'plan_x',
        intent_goal: 'G',
        anchors: ANCHORS,
      },
      { ts: '2026-07-09T13:00:01Z', type: 'plan_decision', decision: 'D', choice: 'C', anchors: ANCHORS },
    ]);

    const first = promoteRunRecords(flowDir, PASS_RUN_ID);
    const second = promoteRunRecords(flowDir, PASS_RUN_ID);

    expect(first).toEqual({ promoted: 2, skipped: 0 });
    expect(second).toEqual({ promoted: 0, skipped: 2 });
    expect(readAnnotations(flowDir)).toHaveLength(2);
  });

  // ── Malformed lines ──────────────────────────────────────

  it('should skip-count malformed lines while promoting valid siblings', () => {
    writeRounds([
      'this is not json at all',
      JSON.stringify({ ts: '2026-07-09T14:00:00Z', anchors: ANCHORS }), // no type field
      JSON.stringify(42), // parses, but not an object
      {
        ts: '2026-07-09T14:00:01Z',
        type: 'plan_decision',
        decision: 'Valid sibling',
        choice: 'survives',
        anchors: ANCHORS,
      },
    ]);

    const result = promoteRunRecords(flowDir, PASS_RUN_ID);

    expect(result).toEqual({ promoted: 1, skipped: 3 });
    expect(readAnnotations(flowDir)).toEqual([
      expect.objectContaining({ text: 'Valid sibling: survives' }),
    ]);
  });

  it('should treat records with an invalid anchors shape as non-candidates, not malformed', () => {
    writeRounds([
      // anchors present but structurally invalid (bad kind) → parseAnchors
      // rejects → unanchored non-candidate, backward compatible
      {
        ts: '2026-07-09T14:00:00Z',
        type: 'plan_decision',
        decision: 'D',
        choice: 'C',
        anchors: [{ kind: 'bogus', ref: 'x' }],
      },
      // anchors: [] is also a non-candidate (must be non-empty)
      { ts: '2026-07-09T14:00:01Z', type: 'plan_decision', decision: 'E', choice: 'F', anchors: [] },
    ]);

    const result = promoteRunRecords(flowDir, PASS_RUN_ID);

    expect(result).toEqual({ promoted: 0, skipped: 0 });
    expect(readAnnotations(flowDir)).toEqual([]);
  });

  it('should return zero counts when both source files are absent', () => {
    expect(promoteRunRecords(flowDir, PASS_RUN_ID)).toEqual({ promoted: 0, skipped: 0 });
  });

  // ── Wave-context promotion (pre-existing behavior guard) ─

  it('should promote anchored wave-context contract and decision entries with wave-context provenance', () => {
    const entries = [
      {
        agent: 'phase-2',
        type: 'contract',
        timestamp: '2026-07-09T15:00:00Z',
        data: { name: 'validateCanonicalGraph', signature: '(graph) => ValidationResult', anchors: ANCHORS },
      },
      {
        agent: 'phase-3',
        type: 'decision',
        timestamp: '2026-07-09T15:00:01Z',
        data: { choice: 'append-only jsonl', reason: 'never rewrite history', anchors: ANCHORS },
      },
      {
        agent: 'phase-3',
        type: 'progress',
        timestamp: '2026-07-09T15:00:02Z',
        data: { status: 'done', anchors: ANCHORS }, // progress is never promoted
      },
    ];
    writeFileSync(
      join(flowDir, '.wave-context.jsonl'),
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf-8',
    );

    const result = promoteRunRecords(flowDir, PASS_RUN_ID);

    expect(result).toEqual({ promoted: 2, skipped: 0 });
    expect(readAnnotations(flowDir)).toEqual([
      expect.objectContaining({
        type: 'claim',
        text: 'validateCanonicalGraph: (graph) => ValidationResult',
        provenance: `wave-context:contract run:${PASS_RUN_ID}`,
      }),
      expect.objectContaining({
        type: 'decision',
        text: 'append-only jsonl: never rewrite history',
        provenance: `wave-context:decision run:${PASS_RUN_ID}`,
      }),
    ]);
  });
});
