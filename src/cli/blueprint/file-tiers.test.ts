/**
 * Tests for the trust-tier sidecar store (`file-tiers.ts`).
 *
 * Fixtures use a real temp directory tree (not mocked fs) so `computeFileTiers`
 * and `recordVerdict` exercise real SHA-256 hashing against real file content,
 * exactly like a derive run does — mirroring `file-stamps.test.ts`.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeFileTiers,
  readFileTiers,
  recordVerdict,
  tierTallies,
  verdictIsStale,
  writeFileTiers,
  rollupClaims,
  tierTalliesWithStaleness,
} from './file-tiers.js';
import type { FileTierEntry, FileTierStore, TierVerdict } from './file-tiers.js';
import { BLUEPRINT_DIRNAME } from './store.js';
import type { BlueprintGraph } from './types.js';

describe('file-tiers', () => {
  let repoRoot: string;
  let flowDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'file-tiers-test-'));
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

  function graphOf(): BlueprintGraph {
    return {
      version: 1,
      derivedAt: '2026-07-20T00:00:00.000Z',
      coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
      nodes: [],
      edges: [],
    };
  }

  /** A standard mixed-tier fixture tree: code, own, claim, other. */
  function writeFixtureTree(): void {
    writeFile('src/a.ts', 'code');
    writeFile('config.json', '{}');
    writeFile('flow/plans/plan_x_v1.md', 'own doc');
    writeFile('docs/readme.md', 'claim doc');
    writeFile('assets/logo.png', 'not really a png');
    writeFile('data.bin', 'blob');
  }

  const structureDir = (): string => join(flowDir, BLUEPRINT_DIRNAME);

  // ── computeFileTiers ─────────────────────────────────────

  it('classifies every walked file into its tier, sorted by path (deterministic order)', () => {
    writeFixtureTree();
    const store = computeFileTiers(repoRoot, graphOf(), null);

    expect(store.derivedAt).toBe('2026-07-20T00:00:00.000Z');
    expect(store.entries).toEqual([
      { path: 'assets/logo.png', tier: 'claim' },
      { path: 'config.json', tier: 'code' },
      { path: 'data.bin', tier: 'other' },
      { path: 'docs/readme.md', tier: 'claim' },
      { path: 'flow/plans/plan_x_v1.md', tier: 'own' },
      { path: 'src/a.ts', tier: 'code' },
    ]);
  });

  it('is byte-identical on a second run over unchanged fixtures', () => {
    writeFixtureTree();
    expect(JSON.stringify(computeFileTiers(repoRoot, graphOf(), null))).toBe(
      JSON.stringify(computeFileTiers(repoRoot, graphOf(), null)),
    );
  });

  // ── verdict merge-forward ────────────────────────────────

  function verdictFor(relPath: string): TierVerdict {
    return {
      verdict: 'corroborated',
      docHash: sha256Of(relPath),
      verifiedAgainst: [{ path: 'src/a.ts', contentHash: sha256Of('src/a.ts') }],
      ts: '2026-07-19T00:00:00.000Z',
    };
  }

  it('carries a previous verdict forward when the doc content is unchanged', () => {
    writeFixtureTree();
    const previous: FileTierStore = {
      derivedAt: '2026-07-19T00:00:00.000Z',
      entries: [{ path: 'docs/readme.md', tier: 'claim', verdict: verdictFor('docs/readme.md') }],
    };

    const store = computeFileTiers(repoRoot, graphOf(), previous);
    const entry = store.entries.find((candidate) => candidate.path === 'docs/readme.md');
    expect(entry?.verdict).toEqual(previous.entries[0].verdict);
  });

  it('drops a previous verdict when the doc was edited (a changed doc voids its verdict)', () => {
    writeFixtureTree();
    const previous: FileTierStore = {
      derivedAt: '2026-07-19T00:00:00.000Z',
      entries: [{ path: 'docs/readme.md', tier: 'claim', verdict: verdictFor('docs/readme.md') }],
    };

    writeFile('docs/readme.md', 'claim doc — edited');
    const store = computeFileTiers(repoRoot, graphOf(), previous);
    const entry = store.entries.find((candidate) => candidate.path === 'docs/readme.md');
    expect(entry?.tier).toBe('claim');
    expect(entry?.verdict).toBeUndefined();
  });

  // ── perf inputs: shared scan + stat pre-filter hints ─────

  it('accepts a pre-computed repo scan and classifies only files that scan lists', () => {
    writeFixtureTree();
    const store = computeFileTiers(repoRoot, graphOf(), null, {
      repoScan: { files: ['docs/readme.md', 'src/a.ts'], unreadableDirs: [] },
    });
    expect(store.entries.map((entry) => entry.path)).toEqual(['docs/readme.md', 'src/a.ts']);
  });

  it('a matching stat hint short-circuits the carried-verdict re-hash without a read', () => {
    writeFixtureTree();
    const FIXED_MTIME = new Date(1700000000000);
    const absPath = join(repoRoot, 'docs/readme.md');
    utimesSync(absPath, FIXED_MTIME, FIXED_MTIME);
    const stat = statSync(absPath);
    const verdict = verdictFor('docs/readme.md');
    const previous: FileTierStore = {
      derivedAt: '2026-07-19T00:00:00.000Z',
      entries: [{ path: 'docs/readme.md', tier: 'claim', verdict }],
    };

    // Poison the doc (same byte length), restore the mtime: a content read
    // would void the verdict; the stat short-circuit keeps it — proving the
    // stored hash was reused without reading.
    writeFileSync(absPath, 'claim eoc', 'utf-8');
    utimesSync(absPath, FIXED_MTIME, FIXED_MTIME);
    const stampHints = new Map([
      ['docs/readme.md', { contentHash: verdict.docHash, mtimeMs: stat.mtimeMs, size: stat.size }],
    ]);

    const withHints = computeFileTiers(repoRoot, graphOf(), previous, { stampHints });
    expect(withHints.entries.find((entry) => entry.path === 'docs/readme.md')?.verdict).toEqual(verdict);

    // Mismatching mtime hint → content is re-hashed (the truth) → verdict voided.
    const staleHints = new Map([
      ['docs/readme.md', { contentHash: verdict.docHash, mtimeMs: stat.mtimeMs + 1, size: stat.size }],
    ]);
    const withoutShortCircuit = computeFileTiers(repoRoot, graphOf(), previous, { stampHints: staleHints });
    expect(withoutShortCircuit.entries.find((entry) => entry.path === 'docs/readme.md')?.verdict).toBeUndefined();
  });

  // ── write / rotate / read round-trip ─────────────────────

  it('round-trips through writeFileTiers → readFileTiers', () => {
    writeFixtureTree();
    const store = computeFileTiers(repoRoot, graphOf(), null);
    writeFileTiers(flowDir, store);
    expect(readFileTiers(flowDir)).toEqual(store);
  });

  it('rotates an existing map to file-tiers.prev.json on the next write', () => {
    writeFixtureTree();
    const first = computeFileTiers(repoRoot, graphOf(), null);
    writeFileTiers(flowDir, first);

    writeFile('src/b.ts', 'more code');
    const second = computeFileTiers(repoRoot, graphOf(), null);
    writeFileTiers(flowDir, second);

    expect(readFileTiers(flowDir)).toEqual(second);
    const prev = JSON.parse(readFileSync(join(structureDir(), 'file-tiers.prev.json'), 'utf-8'));
    expect(prev).toEqual(first);
  });

  // ── fail-soft reads ──────────────────────────────────────

  it('returns null when no store file exists', () => {
    expect(readFileTiers(flowDir)).toBeNull();
  });

  it('returns null when the store file is empty', () => {
    mkdirSync(structureDir(), { recursive: true });
    writeFileSync(join(structureDir(), 'file-tiers.json'), '', 'utf-8');
    expect(readFileTiers(flowDir)).toBeNull();
  });

  it('returns null for a corrupt store file rather than throwing', () => {
    mkdirSync(structureDir(), { recursive: true });
    writeFileSync(join(structureDir(), 'file-tiers.json'), '{not valid json', 'utf-8');
    expect(readFileTiers(flowDir)).toBeNull();
  });

  it('drops shape-invalid entries and shape-invalid verdicts while keeping valid siblings', () => {
    mkdirSync(structureDir(), { recursive: true });
    writeFileSync(
      join(structureDir(), 'file-tiers.json'),
      JSON.stringify({
        derivedAt: '2026-07-20T00:00:00.000Z',
        entries: [
          { path: 'src/a.ts', tier: 'code' },
          { path: 'docs/x.md', tier: 'not-a-tier' }, // invalid tier → dropped
          { path: 42, tier: 'code' }, // invalid path → dropped
          null, // not an object → dropped
          // Invalid verdict (bad kind, missing hashes) → verdict dropped, entry kept
          { path: 'docs/readme.md', tier: 'claim', verdict: { verdict: 'maybe' } },
        ],
      }),
      'utf-8',
    );
    expect(readFileTiers(flowDir)).toEqual({
      derivedAt: '2026-07-20T00:00:00.000Z',
      entries: [
        { path: 'src/a.ts', tier: 'code' },
        { path: 'docs/readme.md', tier: 'claim' },
      ],
    });
  });

  // ── recordVerdict (the ONE verdict write path) ───────────

  it('records a verdict for a claim file: docHash, verifiedAgainst hashes, injected ts, evidence', () => {
    writeFixtureTree();
    writeFileTiers(flowDir, computeFileTiers(repoRoot, graphOf(), null));

    const result = recordVerdict(
      repoRoot,
      flowDir,
      {
        path: 'docs/readme.md',
        verdict: 'corroborated',
        against: ['src/a.ts', 'src/gone.ts'], // unhashable witness → skipped
        evidence: 'matches the exported API',
      },
      new Date('2026-07-20T12:00:00.000Z'),
    );

    expect(result).toEqual({ ok: true });
    const entry = readFileTiers(flowDir)?.entries.find(
      (candidate) => candidate.path === 'docs/readme.md',
    );
    expect(entry?.verdict).toEqual({
      verdict: 'corroborated',
      docHash: sha256Of('docs/readme.md'),
      verifiedAgainst: [{ path: 'src/a.ts', contentHash: sha256Of('src/a.ts') }],
      ts: '2026-07-20T12:00:00.000Z',
      evidence: 'matches the exported API',
      provenance: 'user',
    });
  });

  it('refuses a verdict on a non-claim entry (code) with a reason', () => {
    writeFixtureTree();
    writeFileTiers(flowDir, computeFileTiers(repoRoot, graphOf(), null));

    const result = recordVerdict(repoRoot, flowDir, {
      path: 'src/a.ts',
      verdict: 'corroborated',
      against: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not a claim file');
  });

  it('refuses a verdict on a path unknown to the store', () => {
    writeFixtureTree();
    writeFileTiers(flowDir, computeFileTiers(repoRoot, graphOf(), null));

    const result = recordVerdict(repoRoot, flowDir, {
      path: 'docs/never-derived.md',
      verdict: 'contradicted',
      against: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unknown file');
  });

  it('refuses a verdict when no tier store exists', () => {
    const result = recordVerdict(repoRoot, flowDir, {
      path: 'docs/readme.md',
      verdict: 'unverifiable',
      against: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no tier store');
  });

  // ── verdictIsStale ───────────────────────────────────────

  function recordedEntry(): FileTierEntry {
    writeFileTiers(flowDir, computeFileTiers(repoRoot, graphOf(), null));
    recordVerdict(repoRoot, flowDir, {
      path: 'docs/readme.md',
      verdict: 'corroborated',
      against: ['src/a.ts'],
    });
    const entry = readFileTiers(flowDir)?.entries.find(
      (candidate) => candidate.path === 'docs/readme.md',
    );
    if (entry === undefined) {
      throw new Error('fixture entry missing');
    }
    return entry;
  }

  it('is fresh when both the doc and its verified-against files are unchanged', () => {
    writeFixtureTree();
    const entry = recordedEntry();
    expect(verdictIsStale(repoRoot, entry)).toBe(false);
  });

  it('goes stale when the doc changed since adjudication', () => {
    writeFixtureTree();
    const entry = recordedEntry();
    writeFile('docs/readme.md', 'claim doc — edited');
    expect(verdictIsStale(repoRoot, entry)).toBe(true);
  });

  it('goes stale when a verified-against code file drifted', () => {
    writeFixtureTree();
    const entry = recordedEntry();
    writeFile('src/a.ts', 'code — changed');
    expect(verdictIsStale(repoRoot, entry)).toBe(true);
  });

  it('goes stale when a verified-against code file vanished', () => {
    writeFixtureTree();
    const entry = recordedEntry();
    rmSync(join(repoRoot, 'src/a.ts'));
    expect(verdictIsStale(repoRoot, entry)).toBe(true);
  });

  it('a verdict-less entry is never stale', () => {
    expect(verdictIsStale(repoRoot, { path: 'docs/readme.md', tier: 'claim' })).toBe(false);
  });

  // ── merge-forward across a full derive→verdict→derive cycle ──

  it('a recorded verdict survives a re-derive while the doc is unchanged, then voids on edit', () => {
    writeFixtureTree();
    writeFileTiers(flowDir, computeFileTiers(repoRoot, graphOf(), null));
    recordVerdict(repoRoot, flowDir, {
      path: 'docs/readme.md',
      verdict: 'contradicted',
      against: ['src/a.ts'],
    });

    // Re-derive: unchanged doc → verdict carried forward.
    const recomputed = computeFileTiers(repoRoot, graphOf(), readFileTiers(flowDir));
    writeFileTiers(flowDir, recomputed);
    expect(
      readFileTiers(flowDir)?.entries.find((candidate) => candidate.path === 'docs/readme.md')
        ?.verdict?.verdict,
    ).toBe('contradicted');

    // Edit + re-derive: changed doc → verdict voided.
    writeFile('docs/readme.md', 'claim doc — rewritten');
    writeFileTiers(flowDir, computeFileTiers(repoRoot, graphOf(), readFileTiers(flowDir)));
    expect(
      readFileTiers(flowDir)?.entries.find((candidate) => candidate.path === 'docs/readme.md')
        ?.verdict,
    ).toBeUndefined();
  });

  // ── tierTallies ──────────────────────────────────────────

  it('tallies tiers and verdict kinds (staleness deliberately excluded)', () => {
    writeFixtureTree();
    writeFileTiers(flowDir, computeFileTiers(repoRoot, graphOf(), null));
    recordVerdict(repoRoot, flowDir, {
      path: 'docs/readme.md',
      verdict: 'corroborated',
      against: ['src/a.ts'],
    });

    const store = readFileTiers(flowDir);
    expect(store).not.toBeNull();
    expect(tierTallies(store as FileTierStore)).toEqual({
      code: 2, // src/a.ts + config.json
      own: 1, // flow/plans/plan_x_v1.md
      claim: 2, // docs/readme.md + assets/logo.png
      other: 1, // data.bin
      verdicts: { corroborated: 1, contradicted: 0, unverifiable: 0 },
    });
  });
});

describe('per-claim verdicts (doc-verification Phase 1)', () => {
  it('rollupClaims: contradicted > unverifiable > corroborated', () => {
    const c = (outcome: 'corroborated' | 'contradicted' | 'unverifiable') => ({ claim: 'x', outcome, witnesses: [] });
    expect(rollupClaims([c('corroborated'), c('corroborated')])).toBe('corroborated');
    expect(rollupClaims([c('corroborated'), c('unverifiable')])).toBe('unverifiable');
    expect(rollupClaims([c('unverifiable'), c('contradicted')])).toBe('contradicted');
  });
});
