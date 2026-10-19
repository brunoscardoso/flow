import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureBaselineFresh,
  readSimulationBaseline,
  writeSimulationBaseline,
} from './simulation-baseline.js';
import type { TouchedSet } from './types.js';

const sets: TouchedSet[] = [
  { phase: 1, touched: [{ nodeId: 'module:a', kind: 'modify', anchor: { kind: 'module', ref: 'a' } }] },
];

describe('simulation-baseline store', () => {
  let flowDir: string;
  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'sim-baseline-'));
  });
  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  it('writes and reads back a baseline by planHash', () => {
    writeSimulationBaseline(flowDir, 'p', 'hash1', sets, '2026-07-20T00:00:00.000Z');
    const read = readSimulationBaseline(flowDir, 'hash1');
    expect(read?.plan).toBe('p');
    expect(read?.touchedSets).toEqual(sets);
  });

  it('returns null for an unknown hash', () => {
    writeSimulationBaseline(flowDir, 'p', 'hash1', sets, '2026-07-20T00:00:00.000Z');
    expect(readSimulationBaseline(flowDir, 'other')).toBeNull();
  });

  it('latest-wins: a regenerated baseline supersedes the old (append-only)', () => {
    const older: TouchedSet[] = [{ phase: 1, touched: [] }];
    writeSimulationBaseline(flowDir, 'p', 'hash1', older, '2026-07-20T00:00:00.000Z');
    writeSimulationBaseline(flowDir, 'p', 'hash1', sets, '2026-07-20T00:01:00.000Z');
    expect(readSimulationBaseline(flowDir, 'hash1')?.touchedSets).toEqual(sets);
    // both entries remain on disk (versioning-by-accretion)
    const lines = readFileSync(join(flowDir, '.rounds.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('coexists with unrelated rounds entries', () => {
    writeFileSync(join(flowDir, '.rounds.jsonl'), `${JSON.stringify({ type: 'phase_result', phase: 1 })}\n`, 'utf-8');
    writeSimulationBaseline(flowDir, 'p', 'hash1', sets, '2026-07-20T00:00:00.000Z');
    expect(readSimulationBaseline(flowDir, 'hash1')?.touchedSets).toEqual(sets);
  });
});

describe('ensureBaselineFresh', () => {
  let flowDir: string;
  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'sim-fresh-'));
  });
  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  it('regenerates when no baseline exists for the current hash', () => {
    let recomputed = 0;
    const result = ensureBaselineFresh(flowDir, 'p', 'hash1', () => { recomputed++; return sets; }, '2026-07-20T00:00:00.000Z');
    expect(result.regenerated).toBe(true);
    expect(recomputed).toBe(1);
    expect(readSimulationBaseline(flowDir, 'hash1')?.touchedSets).toEqual(sets);
  });

  it('is a no-op when the current hash already has a baseline', () => {
    writeSimulationBaseline(flowDir, 'p', 'hash1', sets, '2026-07-20T00:00:00.000Z');
    let recomputed = 0;
    const result = ensureBaselineFresh(flowDir, 'p', 'hash1', () => { recomputed++; return sets; }, '2026-07-20T00:01:00.000Z');
    expect(result.regenerated).toBe(false);
    expect(recomputed).toBe(0);
  });

  it('regenerates when the hash drifts (plan edited)', () => {
    writeSimulationBaseline(flowDir, 'p', 'oldhash', sets, '2026-07-20T00:00:00.000Z');
    const result = ensureBaselineFresh(flowDir, 'p', 'newhash', () => sets, '2026-07-20T00:01:00.000Z');
    expect(result.regenerated).toBe(true);
    expect(readSimulationBaseline(flowDir, 'newhash')).not.toBeNull();
    // old baseline still readable by its own hash (history preserved)
    expect(readSimulationBaseline(flowDir, 'oldhash')).not.toBeNull();
  });
});
