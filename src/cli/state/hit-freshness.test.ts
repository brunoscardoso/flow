/**
 * Tests for the hit-freshness contract — per-kind resolution against real
 * temp fixtures: symbol/code hits re-hash their source file (with the
 * file-stamps mtime/size pre-filter), module hits read learning-state, and
 * anchor-less note kinds resolve to unknown.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createFreshnessResolver } from './hit-freshness.js';
import { layeredBrainSearch } from './brain-search-core.js';
import type { LayeredHit } from './brain-search-core.js';

describe('hit-freshness', () => {
  let repoRoot: string;
  let flowDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'hit-freshness-test-'));
    flowDir = join(repoRoot, 'flow');
    mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // ── fixture helpers ──────────────────────────────────────

  function sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  function writeRepoFile(relPath: string, content: string): string {
    const absolutePath = join(repoRoot, relPath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
    return sha256(content);
  }

  function hit(overrides: Partial<LayeredHit>): LayeredHit {
    return {
      id: 'abcd1234',
      kind: 'note',
      file: 'CLAUDE.md',
      content: 'x',
      score: 0.5,
      layers: ['hybrid'],
      ...overrides,
    };
  }

  function resolver() {
    return createFreshnessResolver({ repoRoot, flowDir });
  }

  // ── symbol + code hits (hash contract) ───────────────────

  describe('symbol and code hits', () => {
    it('fresh when the recorded hash matches the file on disk', () => {
      const hash = writeRepoFile('src/x.ts', 'export const a = 1\n');

      const freshness = resolver()(
        hit({ kind: 'symbol', file: 'src/x.ts', codeFile: 'src/x.ts', fileHash: hash }),
      );

      expect(freshness).toBe('fresh');
    });

    it('stale when the file content changed since indexing', () => {
      const hash = writeRepoFile('src/x.ts', 'export const a = 1\n');
      writeRepoFile('src/x.ts', 'export const a = 2\n');

      const freshness = resolver()(
        hit({ kind: 'code', file: 'flow/brain/code/src.md', heading: 'src/x.ts', codeFile: 'src/x.ts', fileHash: hash }),
      );

      expect(freshness).toBe('stale');
    });

    it('stale when the file no longer exists', () => {
      const freshness = resolver()(
        hit({ kind: 'symbol', file: 'src/gone.ts', codeFile: 'src/gone.ts', fileHash: 'f'.repeat(64) }),
      );

      expect(freshness).toBe('stale');
    });

    it('unknown when the hit carries no recorded hash', () => {
      writeRepoFile('src/x.ts', 'export const a = 1\n');

      const freshness = resolver()(
        hit({ kind: 'code', file: 'flow/brain/code/src.md', codeFile: 'src/x.ts' }),
      );

      expect(freshness).toBe('unknown');
    });

    it('fresh via the stamps pre-filter without falling through to a hash mismatch', () => {
      const hash = writeRepoFile('src/x.ts', 'export const a = 1\n');
      const stat = statSync(join(repoRoot, 'src/x.ts'));
      writeFileSync(
        join(flowDir, 'brain', '.structure', 'file-stamps.json'),
        JSON.stringify({
          derivedAt: '2026-07-28T00:00:00.000Z',
          stamps: [{ path: 'src/x.ts', contentHash: hash, mtimeMs: stat.mtimeMs, size: stat.size }],
        }),
        'utf-8',
      );

      const freshness = resolver()(
        hit({ kind: 'symbol', file: 'src/x.ts', codeFile: 'src/x.ts', fileHash: hash }),
      );

      expect(freshness).toBe('fresh');
    });

    it('a stamp with mismatching hints falls through to the content hash (hints never the truth)', () => {
      const hash = writeRepoFile('src/x.ts', 'export const a = 1\n');
      writeFileSync(
        join(flowDir, 'brain', '.structure', 'file-stamps.json'),
        JSON.stringify({
          derivedAt: '2026-07-28T00:00:00.000Z',
          stamps: [{ path: 'src/x.ts', contentHash: hash, mtimeMs: 1, size: 1 }],
        }),
        'utf-8',
      );

      const freshness = resolver()(
        hit({ kind: 'symbol', file: 'src/x.ts', codeFile: 'src/x.ts', fileHash: hash }),
      );

      expect(freshness).toBe('fresh'); // content hash confirms despite stale hints
    });

    it('a stamp recording a DIFFERENT hash than the hit never short-circuits to fresh', () => {
      writeRepoFile('src/x.ts', 'export const a = 2\n');
      const indexedHash = sha256('export const a = 1\n');
      const stat = statSync(join(repoRoot, 'src/x.ts'));
      writeFileSync(
        join(flowDir, 'brain', '.structure', 'file-stamps.json'),
        JSON.stringify({
          derivedAt: '2026-07-28T00:00:00.000Z',
          stamps: [{ path: 'src/x.ts', contentHash: sha256('export const a = 2\n'), mtimeMs: stat.mtimeMs, size: stat.size }],
        }),
        'utf-8',
      );

      const freshness = resolver()(
        hit({ kind: 'symbol', file: 'src/x.ts', codeFile: 'src/x.ts', fileHash: indexedHash }),
      );

      expect(freshness).toBe('stale');
    });
  });

  // ── module hits (learning state) ─────────────────────────

  describe('module hits', () => {
    function writeLearningState(lines: object[]): void {
      writeFileSync(
        join(flowDir, 'brain', '.structure', 'learning-state.jsonl'),
        lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
        'utf-8',
      );
    }

    it('learned → fresh, matching the module path through its slug', () => {
      writeLearningState([{ module: 'src/cli/state', status: 'learned', notedAt: '2026-07-28T00:00:00Z' }]);

      const freshness = resolver()(hit({ kind: 'module', file: 'flow/brain/modules/src-cli-state.md' }));

      expect(freshness).toBe('fresh');
    });

    it('stale → stale', () => {
      writeLearningState([{ module: 'app', status: 'stale', notedAt: '2026-07-28T00:00:00Z' }]);

      expect(resolver()(hit({ kind: 'module', file: 'flow/brain/modules/app.md' }))).toBe('stale');
    });

    it('latest record per module wins', () => {
      writeLearningState([
        { module: 'app', status: 'stale', notedAt: '2026-07-01T00:00:00Z' },
        { module: 'app', status: 'learned', notedAt: '2026-07-28T00:00:00Z' },
      ]);

      expect(resolver()(hit({ kind: 'module', file: 'flow/brain/modules/app.md' }))).toBe('fresh');
    });

    it('queued/learning or absent → unknown; corrupt lines are skipped', () => {
      writeLearningState([{ module: 'app', status: 'queued', notedAt: '2026-07-28T00:00:00Z' }]);
      expect(resolver()(hit({ kind: 'module', file: 'flow/brain/modules/app.md' }))).toBe('unknown');
      expect(resolver()(hit({ kind: 'module', file: 'flow/brain/modules/other.md' }))).toBe('unknown');

      writeFileSync(
        join(flowDir, 'brain', '.structure', 'learning-state.jsonl'),
        'not json\n{"module":"app","status":"learned","notedAt":"2026-07-28T00:00:00Z"}\n',
        'utf-8',
      );
      expect(resolver()(hit({ kind: 'module', file: 'flow/brain/modules/app.md' }))).toBe('fresh');
    });

    it('missing learning-state file → unknown', () => {
      expect(resolver()(hit({ kind: 'module', file: 'flow/brain/modules/app.md' }))).toBe('unknown');
    });
  });

  // ── anchor-less kinds ────────────────────────────────────

  describe('note-family hits', () => {
    it.each(['decision', 'error', 'feature', 'resource', 'rule', 'plan', 'discovery', 'note'] as const)(
      '%s hits resolve to unknown (no machine-checkable anchors)',
      (kind) => {
        expect(resolver()(hit({ kind, file: `flow/brain/${kind}s/x.md` }))).toBe('unknown');
      },
    );
  });
});

// ── The ONE resolution path, now fed by file-derived hits ───────────────────
//
// `hit-freshness.ts` calls itself "the ONE resolution path" (allowed-pattern
// #14), and the index's removal is precisely when a second one gets invented:
// the file engine has the source file open, so re-deriving freshness there
// would look like an optimization and would be a second answer to a question
// that must have one. These lock that it did not happen — the resolver is
// unchanged, and hits produced WITHOUT any index resolve through it.

describe('the ONE freshness path survives the index', () => {
  let repoRoot: string;
  let flowDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'hit-freshness-files-'));
    flowDir = join(repoRoot, 'flow');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function seed(relPath: string, content: string): void {
    const full = join(repoRoot, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  /** A code card exactly as the derive writes one, for a real source file. */
  function seedCard(sourceRel: string, sourceText: string, recordedHash: string): void {
    seed(sourceRel, sourceText);
    seed(
      'flow/brain/code/src.md',
      [
        '---',
        'type: code',
        '---',
        '',
        `## ${sourceRel}`,
        '',
        'Thread scope decisions for the project.',
        '',
        'symbols:',
        '- ThreadScopeManager (class) — line 54',
        '',
        `hash: ${recordedHash}`,
      ].join('\n'),
    );
  }

  async function codeHit(): Promise<LayeredHit | undefined> {
    const hits = await layeredBrainSearch({
      brain: null,
      projectRoot: repoRoot,
      flowDir,
      query: 'thread scope decisions project',
      scope: 'all',
      limit: 10,
    });
    return hits.find((entry) => entry.kind === 'code');
  }

  it('resolves a FILE-derived code hit as fresh, with no index anywhere', async () => {
    const source = 'export class ThreadScopeManager {}\n';
    seedCard('src/tsm.ts', source, createHash('sha256').update(source).digest('hex'));

    const hit = await codeHit();

    expect(hit?.codeFile).toBe('src/tsm.ts');
    expect(createFreshnessResolver({ repoRoot, flowDir })(hit as LayeredHit)).toBe('fresh');
  });

  it('resolves the same hit as STALE once the code drifts', async () => {
    const indexed = 'export class ThreadScopeManager {}\n';
    seedCard('src/tsm.ts', indexed, createHash('sha256').update(indexed).digest('hex'));
    // The card still records the old hash; the file moved on.
    seed('src/tsm.ts', 'export class ThreadScopeManager { renamed() {} }\n');

    const hit = await codeHit();

    expect(createFreshnessResolver({ repoRoot, flowDir })(hit as LayeredHit)).toBe('stale');
  });

  it('is the SOLE path — the file engine resolves no freshness of its own', () => {
    const engineSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'brain-file-search.ts'),
      'utf-8',
    );

    // The file engine may not decide freshness, mention the verdicts, or read
    // either evidence store. Its job is to find chunks; judging them is here.
    expect(engineSource).not.toContain('hit-freshness');
    expect(engineSource).not.toMatch(/'fresh'|"fresh"/);
    expect(engineSource).not.toMatch(/'stale'|"stale"/);
    expect(engineSource).not.toContain('learning-state');
    expect(engineSource).not.toContain('file-stamps');
  });

  it('resolves through the SAME evidence stores as before — nothing was re-pointed', () => {
    const resolverSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'hit-freshness.ts'),
      'utf-8',
    );

    expect(resolverSource).toContain('file-stamps.js');
    expect(resolverSource).toContain('learning-state.jsonl');
    expect(resolverSource).toContain('hashRepoFile');
    // It never touched the index, which is exactly why the freshness guarantee
    // outlives it.
    expect(resolverSource).not.toContain('.brain.sqlite');
    expect(resolverSource).not.toContain('planflow-brain');
  });
});
