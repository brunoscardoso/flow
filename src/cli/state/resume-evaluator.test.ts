/**
 * Tests for the resume evaluator (pure) and the rounds reader (fail-soft I/O).
 *
 * Covers: planHash lineage gating (success marks complete only under a
 * matched run lineage; legacy files with no planHash never enable resume),
 * partial/failure staying pending, skip phases reporting complete, and the
 * rounds reader skipping malformed lines in a real fixture file.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileRunScript } from './run-compiler.js';
import { evaluateResume } from './resume-evaluator.js';
import { readRoundsEntries, type RoundsEntry } from './rounds-reader.js';
import type { RunOverrides, RunScript } from './types.js';

const PLAN_CONTENT = `# Plan: Resume Test

### Phase 1: One
**Complexity**: 3/10
**Dependencies**: none

- [ ] Task one

### Phase 2: Two
**Complexity**: 5/10
**Dependencies**: Phase 1

- [ ] Task two

### Phase 3: Three
**Complexity**: 7/10
**Dependencies**: Phase 2

- [ ] Task three
`;

function compileFixture(overrides: RunOverrides = {}): RunScript {
  return compileRunScript(PLAN_CONTENT, 'resume-test', overrides);
}

describe('evaluateResume', () => {
  it('marks a success phase_result complete when its run lineage matches the planHash', () => {
    const script = compileFixture();
    const entries: RoundsEntry[] = [
      { type: 'run_intent', run_id: 'r1', planHash: script.planHash },
      { type: 'phase_result', run_id: 'r1', phase: 1, status: 'success' },
    ];

    expect(evaluateResume(script, entries)).toEqual([
      { phase: 1, state: 'complete' },
      { phase: 2, state: 'pending' },
      { phase: 3, state: 'pending' },
    ]);
  });

  it('anchors lineage via a phase_result carrying the planHash itself', () => {
    const script = compileFixture();
    const entries: RoundsEntry[] = [
      { type: 'phase_result', run_id: 'r1', phase: 1, status: 'success', planHash: script.planHash },
      { type: 'phase_result', run_id: 'r1', phase: 2, status: 'success' },
    ];

    expect(evaluateResume(script, entries)).toEqual([
      { phase: 1, state: 'complete' },
      { phase: 2, state: 'complete' },
      { phase: 3, state: 'pending' },
    ]);
  });

  it('leaves partial and failure phase_results pending', () => {
    const script = compileFixture();
    const entries: RoundsEntry[] = [
      { type: 'run_intent', run_id: 'r1', planHash: script.planHash },
      { type: 'phase_result', run_id: 'r1', phase: 1, status: 'success' },
      { type: 'phase_result', run_id: 'r1', phase: 2, status: 'partial' },
      { type: 'phase_result', run_id: 'r1', phase: 3, status: 'failure' },
    ];

    expect(evaluateResume(script, entries)).toEqual([
      { phase: 1, state: 'complete' },
      { phase: 2, state: 'pending' },
      { phase: 3, state: 'pending' },
    ]);
  });

  it('ignores success results from runs whose lineage does not match the planHash', () => {
    const script = compileFixture();
    const entries: RoundsEntry[] = [
      { type: 'run_intent', run_id: 'other', planHash: 'deadbeef' },
      { type: 'phase_result', run_id: 'other', phase: 1, status: 'success' },
      { type: 'phase_result', run_id: 'other', phase: 2, status: 'success' },
    ];

    expect(evaluateResume(script, entries)).toEqual([
      { phase: 1, state: 'pending' },
      { phase: 2, state: 'pending' },
      { phase: 3, state: 'pending' },
    ]);
  });

  it('reports all phases pending for legacy rounds files with no planHash anywhere', () => {
    const script = compileFixture();
    const entries: RoundsEntry[] = [
      { type: 'run_intent', run_id: 'legacy' },
      { type: 'phase_result', run_id: 'legacy', phase: 1, status: 'success' },
      { type: 'phase_result', run_id: 'legacy', phase: 2, status: 'success' },
      { type: 'phase_result', run_id: 'legacy', phase: 3, status: 'success' },
    ];

    expect(evaluateResume(script, entries)).toEqual([
      { phase: 1, state: 'pending' },
      { phase: 2, state: 'pending' },
      { phase: 3, state: 'pending' },
    ]);
  });

  it('reports skip phases complete even with no rounds entries', () => {
    const script = compileFixture({ phases: { '2': { skip: true } } });

    expect(evaluateResume(script, [])).toEqual([
      { phase: 1, state: 'pending' },
      { phase: 2, state: 'complete' },
      { phase: 3, state: 'pending' },
    ]);
  });
});

describe('readRoundsEntries', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'plan-flow-rounds-reader-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns [] when the rounds file is missing', () => {
    expect(readRoundsEntries(tempDir)).toEqual([]);
  });

  it('skips malformed lines and keeps the valid ones', () => {
    const lines = [
      JSON.stringify({ type: 'run_intent', run_id: 'r1', planHash: 'abc' }),
      'not json {{{',
      '',
      JSON.stringify({ type: 'phase_result', run_id: 'r1', phase: 1, status: 'success' }),
      '[1, 2, 3]',
    ].join('\n');
    writeFileSync(join(tempDir, '.rounds.jsonl'), `${lines}\n`, 'utf-8');

    const entries = readRoundsEntries(tempDir);
    expect(entries).toEqual([
      { type: 'run_intent', run_id: 'r1', planHash: 'abc' },
      { type: 'phase_result', run_id: 'r1', phase: 1, status: 'success' },
    ]);
  });
});
