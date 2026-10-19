/**
 * Tests for `blueprint stale-check` — both the core re-hash computation
 * (`computeStaleCheckReport`) and the CLI command layer's human/JSON output
 * and exit codes (`runBlueprint('stale-check', ...)`).
 *
 * Fixtures use a real temp directory tree (not mocked fs) so `hashRepoFile`
 * exercises real SHA-256 hashing against real file content, exactly like
 * `blueprint observe` does when it stamps a note.
 */

import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendInvestigationNote, investigationFingerprint } from './investigation-store.js';
import { computeStaleCheckReport, computeStaleEdges, staleEdgeKeys } from './stale-check.js';
import { readFeatures, writeEdges } from './feature-store.js';
import { stampEdgeVias } from './file-stamps.js';
import { buildFeatureGraph } from './feature-graph.js';
import type { InvestigationEntry } from './types.js';
import { runBlueprint, type BlueprintCommandOptions } from '../commands/blueprint.js';

describe('blueprint stale-check', () => {
  let repoRoot: string;
  let flowDir: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'stale-check-test-'));
    flowDir = join(repoRoot, 'flow');
    originalExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // ── Fixture helpers ──────────────────────────────────────

  function writeFile(relPath: string, content: string): void {
    const absolutePath = join(repoRoot, relPath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
  }

  function sha256Of(relPath: string): string {
    return createHash('sha256').update(readFileSync(join(repoRoot, relPath))).digest('hex');
  }

  /**
   * Append a note whose hashStamps are computed from the CURRENT content of
   * each backing file. `stamps` pairs the stamp's `ref` (the anchor's own
   * `ref` — a file path for a `file` anchor, but a SYMBOL NAME for a
   * `symbol` anchor) with the repo-relative file path to hash, mirroring
   * exactly what `blueprint observe` records.
   */
  function appendNoteStampedAt(
    overrides: Partial<InvestigationEntry> & { anchors: InvestigationEntry['anchors'] },
    stamps: Array<{ ref: string; filePath: string }>,
  ): InvestigationEntry {
    const entry: InvestigationEntry = {
      ts: '2026-07-09T00:00:00.000Z',
      runId: 'run-1',
      text: 'note text',
      provenance: 'test',
      status: 'observed',
      hashStamps: stamps.map(({ ref, filePath }) => ({ ref, contentHash: sha256Of(filePath) })),
      ...overrides,
    };
    appendInvestigationNote(flowDir, entry);
    return entry;
  }

  /** Shorthand for the common case: one `file`-anchor stamp, ref === filePath. */
  function appendNote(
    overrides: Partial<InvestigationEntry> & { anchors: InvestigationEntry['anchors'] },
    filePaths: string[],
  ): InvestigationEntry {
    return appendNoteStampedAt(overrides, filePaths.map((filePath) => ({ ref: filePath, filePath })));
  }

  /** Run `blueprint stale-check` from inside the fixture repo, capturing both streams. */
  async function runStaleCheckAt(options: BlueprintCommandOptions): Promise<{ stdout: string; stderr: string }> {
    const originalCwd = process.cwd();
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const outSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        outChunks.push(String(chunk));
        return true;
      });
    const errSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        errChunks.push(String(chunk));
        return true;
      });
    process.chdir(repoRoot);
    try {
      await runBlueprint('stale-check', undefined, options);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      process.chdir(originalCwd);
    }
    return { stdout: outChunks.join(''), stderr: errChunks.join('') };
  }

  // ── core computation ─────────────────────────────────────

  describe('computeStaleCheckReport', () => {
    it('reports a note fresh when its stamped file is unchanged', () => {
      writeFile('src/api/index.ts', 'export const handler = () => 1;\n');
      appendNote(
        { anchors: [{ kind: 'file', ref: 'src/api/index.ts' }] },
        ['src/api/index.ts'],
      );

      const report = computeStaleCheckReport(flowDir, repoRoot);

      expect(report).toEqual({ checked: 1, fresh: 1, stale: [], staleEdges: [] });
    });

    it('reports a note stale with a changedFiles entry when the stamped file drifted', () => {
      writeFile('src/api/index.ts', 'export const handler = () => 1;\n');
      const entry = appendNote(
        { anchors: [{ kind: 'file', ref: 'src/api/index.ts' }] },
        ['src/api/index.ts'],
      );

      // Drift the file AFTER stamping
      writeFile('src/api/index.ts', 'export const handler = () => 2;\n');

      const report = computeStaleCheckReport(flowDir, repoRoot);

      expect(report.checked).toBe(1);
      expect(report.fresh).toBe(0);
      expect(report.stale).toEqual([
        {
          fingerprint: investigationFingerprint(entry),
          anchors: entry.anchors,
          changedFiles: ['src/api/index.ts'],
          missingFiles: [],
          totalStamps: 1,
        },
      ]);
    });

    it('reports a note stale with a missingFiles entry when the stamped file was deleted', () => {
      writeFile('src/api/index.ts', 'export const handler = () => 1;\n');
      appendNote(
        { anchors: [{ kind: 'file', ref: 'src/api/index.ts' }] },
        ['src/api/index.ts'],
      );
      unlinkSync(join(repoRoot, 'src/api/index.ts'));

      const report = computeStaleCheckReport(flowDir, repoRoot);

      expect(report.checked).toBe(1);
      expect(report.fresh).toBe(0);
      expect(report.stale).toHaveLength(1);
      expect(report.stale[0]).toMatchObject({
        changedFiles: [],
        missingFiles: ['src/api/index.ts'],
        totalStamps: 1,
      });
    });

    it('re-hashes the FILE a symbol anchor points at, not the symbol ref', () => {
      writeFile('src/lib/helper.ts', 'export function helper() { return 1; }\n');
      const entry = appendNoteStampedAt(
        { anchors: [{ kind: 'symbol', ref: 'helper', file: 'src/lib/helper.ts' }] },
        [{ ref: 'helper', filePath: 'src/lib/helper.ts' }], // hashStamp.ref is the SYMBOL name, mirroring observe's write
      );
      // Sanity: the stamp was computed from the file's content, keyed by symbol ref
      expect(entry.hashStamps[0]).toEqual({ ref: 'helper', contentHash: sha256Of('src/lib/helper.ts') });

      // Drift the backing file
      writeFile('src/lib/helper.ts', 'export function helper() { return 2; }\n');

      const report = computeStaleCheckReport(flowDir, repoRoot);
      expect(report.stale).toEqual([
        expect.objectContaining({ changedFiles: ['src/lib/helper.ts'], missingFiles: [] }),
      ]);
    });

    it('excludes a superseded note — only the active (fold-on-read) winner is checked', () => {
      writeFile('src/api/index.ts', 'export const handler = () => 1;\n');
      const original = appendNote(
        { anchors: [{ kind: 'file', ref: 'src/api/index.ts' }], ts: '2026-07-09T00:00:00.000Z' },
        ['src/api/index.ts'],
      );
      // Drift the file, then supersede the original note with a fresh stamp —
      // the superseded note must never surface as stale even though ITS OWN
      // stamp (against the pre-drift content) would no longer match either.
      writeFile('src/api/index.ts', 'export const handler = () => 2;\n');
      appendNote(
        {
          anchors: [{ kind: 'file', ref: 'src/api/index.ts' }],
          ts: '2026-07-09T01:00:00.000Z',
          supersedes: investigationFingerprint(original),
        },
        ['src/api/index.ts'],
      );

      const report = computeStaleCheckReport(flowDir, repoRoot);

      expect(report.checked).toBe(1);
      expect(report.fresh).toBe(1);
      expect(report.stale).toEqual([]);
    });

    it('filters to notes whose anchors resolve under --module, excluding others', () => {
      writeFile('src/api/index.ts', 'a');
      writeFile('src/lib/helper.ts', 'b');
      appendNote(
        { anchors: [{ kind: 'file', ref: 'src/api/index.ts' }], text: 'api note' },
        ['src/api/index.ts'],
      );
      appendNote(
        { anchors: [{ kind: 'file', ref: 'src/lib/helper.ts' }], text: 'lib note' },
        ['src/lib/helper.ts'],
      );
      // Drift BOTH files — only the filtered-in note should be reported
      writeFile('src/api/index.ts', 'a-changed');
      writeFile('src/lib/helper.ts', 'b-changed');

      const scoped = computeStaleCheckReport(flowDir, repoRoot, 'src/api');

      expect(scoped.checked).toBe(1);
      expect(scoped.stale).toHaveLength(1);
      expect(scoped.stale[0].anchors).toEqual([{ kind: 'file', ref: 'src/api/index.ts' }]);
    });

    it('matches a module anchor directly and a trailing-slash module path identically', () => {
      writeFile('src/cli/blueprint/store.ts', 'x');
      appendNote(
        { anchors: [{ kind: 'module', ref: 'src/cli' }, { kind: 'file', ref: 'src/cli/blueprint/store.ts' }] },
        ['src/cli/blueprint/store.ts'],
      );

      expect(computeStaleCheckReport(flowDir, repoRoot, 'src/cli').checked).toBe(1);
      expect(computeStaleCheckReport(flowDir, repoRoot, 'src/cli/').checked).toBe(1);
      expect(computeStaleCheckReport(flowDir, repoRoot, 'src/other').checked).toBe(0);
    });

    it('returns an empty report for an empty store (no notes appended)', () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'), '', 'utf-8');

      expect(computeStaleCheckReport(flowDir, repoRoot)).toEqual({ checked: 0, fresh: 0, stale: [], staleEdges: [] });
    });

    it('fails soft to a zero-checked report when the store file does not exist at all', () => {
      // Nothing under flowDir has been created — not even the directory.
      expect(computeStaleCheckReport(flowDir, repoRoot)).toEqual({ checked: 0, fresh: 0, stale: [], staleEdges: [] });
    });

    it('is deterministic — a second run over unchanged fixtures is byte-identical', () => {
      writeFile('src/api/index.ts', 'export const handler = () => 1;\n');
      appendNote(
        { anchors: [{ kind: 'file', ref: 'src/api/index.ts' }] },
        ['src/api/index.ts'],
      );
      writeFile('src/api/index.ts', 'export const handler = () => 2;\n');

      const first = computeStaleCheckReport(flowDir, repoRoot);
      const second = computeStaleCheckReport(flowDir, repoRoot);

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
  });

  // ── CLI command layer ────────────────────────────────────

  describe('runBlueprint stale-check', () => {
    it('prints "fresh: N notes" and nothing else when nothing is stale, exit 0', async () => {
      writeFile('src/api/index.ts', 'unchanged');
      appendNote(
        { anchors: [{ kind: 'file', ref: 'src/api/index.ts' }] },
        ['src/api/index.ts'],
      );

      const result = await runStaleCheckAt({});

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toBe('fresh: 1 notes\n');
      expect(result.stderr).toBe('');
    });

    it('prints a stale line with the module-anchor bracket, then the fresh summary, exit 0', async () => {
      writeFile('src/api/index.ts', 'v1');
      const entry = appendNote(
        {
          anchors: [{ kind: 'module', ref: 'src/api' }, { kind: 'file', ref: 'src/api/index.ts' }],
        },
        ['src/api/index.ts'],
      );
      writeFile('src/api/index.ts', 'v2');

      const result = await runStaleCheckAt({});
      const fingerprint = investigationFingerprint(entry);

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toBe(`stale: ${fingerprint} — 1 of 1 stamped files changed [module:src/api]\nfresh: 0 notes\n`);
      expect(result.stderr).toBe('');
    });

    it('emits the deterministic-key JSON report with --json', async () => {
      writeFile('src/api/index.ts', 'v1');
      const entry = appendNote(
        { anchors: [{ kind: 'file', ref: 'src/api/index.ts' }] },
        ['src/api/index.ts'],
      );
      writeFile('src/api/index.ts', 'v2');

      const result = await runStaleCheckAt({ json: true });

      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Object.keys(parsed)).toEqual(['checked', 'fresh', 'stale', 'staleEdges']);
      expect(parsed).toEqual({
        checked: 1,
        fresh: 0,
        stale: [
          {
            fingerprint: investigationFingerprint(entry),
            anchors: entry.anchors,
            changedFiles: ['src/api/index.ts'],
            missingFiles: [],
          },
        ],
        // A project with no feature edges reports none — an empty list, never
        // an absent key, so a reader can tell "checked, none stale" from "an
        // older bundle that did not look".
        staleEdges: [],
      });
      // Never carries the internal-only totalStamps field
      expect(parsed.stale[0]).not.toHaveProperty('totalStamps');
    });

    it('applies --module at the CLI layer too', async () => {
      writeFile('src/api/index.ts', 'a');
      writeFile('src/lib/helper.ts', 'b');
      appendNote(
        { anchors: [{ kind: 'file', ref: 'src/api/index.ts' }] },
        ['src/api/index.ts'],
      );
      appendNote(
        { anchors: [{ kind: 'file', ref: 'src/lib/helper.ts' }] },
        ['src/lib/helper.ts'],
      );

      const result = await runStaleCheckAt({ module: 'src/lib', json: true });

      expect(JSON.parse(result.stdout).checked).toBe(1);
    });

    it('refuses an empty --module with exit 1 and writes nothing to stdout', async () => {
      const result = await runStaleCheckAt({ module: '   ' });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe('stale-check refused: --module requires a non-empty path\n');
      expect(result.stdout).toBe('');
    });

    it('exits 0 even when stale notes are found — staleness is a report, not an error', async () => {
      writeFile('src/api/index.ts', 'v1');
      appendNote(
        { anchors: [{ kind: 'file', ref: 'src/api/index.ts' }] },
        ['src/api/index.ts'],
      );
      unlinkSync(join(repoRoot, 'src/api/index.ts'));

      const result = await runStaleCheckAt({});

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('stale:');
    });
  });
});

// ── Stale EDGES: a relationship whose mechanism moved ──────────────────────
//
// An edge says how two capabilities connect. When the file its `via` names is
// rewritten, that sentence has to be re-verified — and nothing errors when it
// happens, so unless the same pass that reports stale notes also reports stale
// edges, a confident, shared, wrong statement about the system lives forever.

describe('stale edges', () => {
  let repoRoot: string;
  let flowDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'stale-edge-test-'));
    flowDir = join(repoRoot, 'flow');
    mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeSource(relPath: string, content: string): void {
    const absolutePath = join(repoRoot, relPath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
  }

  /** Seed a feature whose `relates` is written by the store's own writer. */
  function seedFeature(slug: string, name: string): void {
    writeFileSync(
      join(flowDir, 'brain', 'features', `${slug}.md`),
      `---\nid: feature:${slug}\nname: ${name}\nkind: core\nanchors: []\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\n# ${name}\n`,
      'utf-8',
    );
  }

  function recordEdge(): void {
    writeEdges(
      flowDir,
      'playbooks',
      stampEdgeVias(repoRoot, [
        {
          target: 'feature:skills',
          via: 'src/playbooks/binder.ts',
          note: 'a playbook step names a skill by slug; the binder resolves it at authoring time',
        },
      ]),
    );
  }

  it('reports nothing while the mechanism is unchanged', () => {
    writeSource('src/playbooks/binder.ts', 'export const resolve = () => 1\n');
    seedFeature('playbooks', 'Playbooks');
    seedFeature('skills', 'Skills');
    recordEdge();
    expect(computeStaleEdges(flowDir, repoRoot)).toEqual([]);
  });

  it('reports the edge STALE once its mechanism changes, carrying the note to verify', () => {
    writeSource('src/playbooks/binder.ts', 'export const resolve = () => 1\n');
    seedFeature('playbooks', 'Playbooks');
    seedFeature('skills', 'Skills');
    recordEdge();

    writeSource('src/playbooks/binder.ts', 'export const resolve = () => 2 // the seam moved\n');
    const stale = computeStaleEdges(flowDir, repoRoot);
    expect(stale).toEqual([
      {
        feature: 'feature:playbooks',
        slug: 'playbooks',
        target: 'feature:skills',
        via: 'src/playbooks/binder.ts',
        note: 'a playbook step names a skill by slug; the binder resolves it at authoring time',
        state: 'stale',
      },
    ]);
  });

  it('says MISSING, not stale, when the mechanism file is gone', () => {
    writeSource('src/playbooks/binder.ts', 'x\n');
    seedFeature('playbooks', 'Playbooks');
    seedFeature('skills', 'Skills');
    recordEdge();
    unlinkSync(join(repoRoot, 'src/playbooks/binder.ts'));
    expect(computeStaleEdges(flowDir, repoRoot)[0].state).toBe('missing');
  });

  it('never reports an unstamped edge — it never claimed to be fresh', () => {
    seedFeature('playbooks', 'Playbooks');
    seedFeature('skills', 'Skills');
    writeEdges(flowDir, 'playbooks', [
      { target: 'feature:skills', via: 'the manifest handshake', note: 'a named seam' },
    ]);
    expect(computeStaleEdges(flowDir, repoRoot)).toEqual([]);
  });

  it('rides the SAME report as stale notes — one verb, one meaning of stale', () => {
    writeSource('src/playbooks/binder.ts', 'x\n');
    seedFeature('playbooks', 'Playbooks');
    seedFeature('skills', 'Skills');
    recordEdge();
    writeSource('src/playbooks/binder.ts', 'changed\n');

    const report = computeStaleCheckReport(flowDir, repoRoot);
    expect(report.staleEdges.map((edge) => edge.target)).toEqual(['feature:skills']);
    // …and the note half is untouched by it.
    expect(report.stale).toEqual([]);
  });

  it('scopes to a module the same way notes do', () => {
    writeSource('src/playbooks/binder.ts', 'x\n');
    seedFeature('playbooks', 'Playbooks');
    seedFeature('skills', 'Skills');
    recordEdge();
    writeSource('src/playbooks/binder.ts', 'changed\n');

    expect(computeStaleEdges(flowDir, repoRoot, 'src/playbooks')).toHaveLength(1);
    expect(computeStaleEdges(flowDir, repoRoot, 'src/chat')).toEqual([]);
  });

  it('marks the edge stale WHEREVER it is read — including on the board graph', () => {
    writeSource('src/playbooks/binder.ts', 'x\n');
    seedFeature('playbooks', 'Playbooks');
    seedFeature('skills', 'Skills');
    recordEdge();
    writeSource('src/playbooks/binder.ts', 'changed\n');

    const features = readFeatures(flowDir);
    const keys = staleEdgeKeys(computeStaleEdges(flowDir, repoRoot, undefined, features));
    const graph = buildFeatureGraph(features, new Map(), new Set(), new Set(), new Map(), keys);
    // `via`/`note` stay out of the graph (Phase 1's rule — they are for a
    // reader of the feature). The VERDICT does not: an edge whose mechanism
    // moved must not be drawn as a verified fact.
    expect(graph.edges).toEqual([
      { from: 'feature:playbooks', to: 'feature:skills', stale: true },
    ]);
    const fresh = buildFeatureGraph(features, new Map(), new Set(), new Set(), new Map());
    expect(fresh.edges).toEqual([{ from: 'feature:playbooks', to: 'feature:skills' }]);
  });
});
