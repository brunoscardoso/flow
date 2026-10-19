/**
 * Progressive-learning pipeline E2E (Phase 11) — the deterministic,
 * no-LLM proof that the CLI half a learn pass drives works end-to-end:
 *
 *   derive → observe (learn note, hash-stamped FILE anchor) → stale-check
 *   fresh → drift a source file → stale-check flags the note → re-learn
 *   supersede → old note gone, superseding note fresh.
 *
 * This mirrors what `app`'s `runLearnPass` executor does AFTER its caged
 * session returns: it writes the module brain doc, then an anchored
 * investigation note via `blueprint observe`, carrying the module anchor plus
 * the key source-file anchor so `blueprint stale-check` can detect drift. The
 * caged *session* itself (the live LLM step) is proven separately by a
 * one-off script run — this suite is the CI-robust half: the note text is
 * canned (a "mocked session"), every CLI write is REAL, no subprocess and no
 * live model are ever invoked.
 *
 * `node:child_process.execSync` is module-mocked (repo convention — see
 * blueprint-e2e.test.ts) so the REAL derive runs with deterministic
 * graphify/git behaviour on any machine; this suite therefore needs the
 * `node --experimental-vm-modules` runner (`npm run test`).
 */

import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BlueprintCommandOptions } from './blueprint.js';

const mockExecSync = jest.fn<(command: string, options?: unknown) => string>();
const mockSpawn = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  execSync: mockExecSync,
  // corpus-index imports execFileSync (argv-array git lookup); a factory
  // missing the export is a module-link error under ESM jest.
  execFileSync: jest.fn(() => ''),
  spawn: mockSpawn,
}));

// Import AFTER the mock so the REAL pipeline shares the mocked child_process.
const { runBlueprint } = await import('./blueprint.js');
const { computeStaleCheckReport } = await import('../blueprint/stale-check.js');
const { investigationFingerprint, readInvestigations } = await import(
  '../blueprint/investigation-store.js'
);

const RUN_ID = 'run-learn-e2e';
const MODULE_REF = 'src/calc';
const MODULE_ANCHOR = `module:${MODULE_REF}`;
const FILE_REF = 'src/calc/operations.ts';
const FILE_ANCHOR = `file:${FILE_REF}`;

/** The learn note text as `buildObserveArgs` composes it: summary + doc link. */
const NOTE_SUMMARY = 'calc is a tiny arithmetic engine: pure add/subtract primitives plus a stateful Calculator.';
const DOC_REL = 'flow/brain/modules/src-calc.md';
const NOTE_TEXT = `${NOTE_SUMMARY}\n\nDoc: ${DOC_REL}`;

describe('progressive-learning pipeline E2E (derive → observe → stale-check → supersede)', () => {
  let repoRoot: string;
  let flowDir: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'learn-e2e-test-'));
    flowDir = join(repoRoot, 'flow');
    mkdirSync(flowDir, { recursive: true });
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    mockExecSync.mockReset();
    mockSpawn.mockReset();
    // No git repo, no graphify — every subprocess probe fails deterministically.
    mockExecSync.mockImplementation((command: string) => {
      throw new Error(`command failed: ${command}`);
    });
    buildCalcModule();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('learns a module, detects drift on its stamped file, and supersedes on re-learn', async () => {
    // Step 1 — derive: the graph the learn anchors resolve against.
    const derive = await runBlueprintAt('derive', undefined, { runId: RUN_ID });
    expect(derive.stdout).toContain('validation: ok');
    expect(process.exitCode ?? 0).toBe(0);

    // Step 2 — the learn note: module anchor + the key source-file anchor.
    // The file anchor is what observe hash-stamps, so stale-check can later
    // re-hash it and notice drift.
    const observe = await runBlueprintAt('observe', undefined, {
      note: NOTE_TEXT,
      anchor: [MODULE_ANCHOR, FILE_ANCHOR],
      runId: RUN_ID,
    });
    expect(process.exitCode ?? 0).toBe(0);
    const learnFingerprint = investigationFingerprint({
      text: NOTE_TEXT,
      anchors: [
        { kind: 'module', ref: MODULE_REF },
        { kind: 'file', ref: FILE_REF },
      ],
    });
    expect(observe.stdout).toBe(`observed: note ${learnFingerprint} (observed) on 2 anchor(s)\n`);

    // The note landed in the store, hash-stamped on the file anchor.
    const stored = readInvestigations(flowDir).notes;
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe(NOTE_TEXT);
    expect(stored[0].hashStamps.map((s) => s.ref)).toEqual([FILE_REF]);

    // Step 3 — stale-check BEFORE any drift: the learn note is fresh.
    const fresh = computeStaleCheckReport(flowDir, repoRoot, MODULE_REF);
    expect(fresh).toEqual({ checked: 1, fresh: 1, stale: [], staleEdges: [] });

    // Step 4 — drift the stamped source file (a real content change).
    writeFixture(
      FILE_REF,
      [
        'export function add(a: number, b: number): number {',
        '  return a + b',
        '}',
        'export function subtract(a: number, b: number): number {',
        '  return a - b',
        '}',
        '// NEW: multiply changes the file content → the stamp must drift.',
        'export function multiply(a: number, b: number): number {',
        '  return a * b',
        '}',
        '',
      ].join('\n'),
    );

    // Step 5 — stale-check AFTER drift: the note is flagged, naming the file.
    const drifted = computeStaleCheckReport(flowDir, repoRoot, MODULE_REF);
    expect(drifted.checked).toBe(1);
    expect(drifted.fresh).toBe(0);
    expect(drifted.stale).toHaveLength(1);
    expect(drifted.stale[0].fingerprint).toBe(learnFingerprint);
    expect(drifted.stale[0].changedFiles).toEqual([FILE_REF]);
    expect(drifted.stale[0].missingFiles).toEqual([]);

    // The CLI surface reports the same drift (JSON mode).
    const cliStale = await runBlueprintAt('stale-check', undefined, {
      module: MODULE_REF,
      json: true,
    });
    const cliReport = JSON.parse(cliStale.stdout) as {
      checked: number;
      fresh: number;
      stale: Array<{ fingerprint: string; changedFiles: string[] }>;
    };
    expect(cliReport.stale).toHaveLength(1);
    expect(cliReport.stale[0].fingerprint).toBe(learnFingerprint);
    expect(cliReport.stale[0].changedFiles).toEqual([FILE_REF]);

    // Step 6 — re-learn: a fresh note supersedes the drifted one. Its hash
    // stamp is taken against the NEW file content, so it is born fresh.
    const reSummary = 'calc now also exposes multiply alongside add/subtract; Calculator unchanged.';
    const reNoteText = `${reSummary}\n\nDoc: ${DOC_REL}`;
    const superseding = await runBlueprintAt('observe', undefined, {
      note: reNoteText,
      anchor: [MODULE_ANCHOR, FILE_ANCHOR],
      supersedes: learnFingerprint,
      reason: 'source drifted — multiply added',
      runId: RUN_ID,
    });
    expect(process.exitCode ?? 0).toBe(0);
    expect(superseding.stdout).toContain('(observed) on 2 anchor(s)');

    // Step 7 — fold-on-read drops the superseded note; only the fresh one
    // remains, and stale-check is clean again.
    const activeAfter = readInvestigations(flowDir).notes;
    expect(activeAfter).toHaveLength(1);
    expect(activeAfter[0].text).toContain(reSummary);
    expect(activeAfter[0].supersedes).toBe(learnFingerprint);

    const afterReLearn = computeStaleCheckReport(flowDir, repoRoot, MODULE_REF);
    expect(afterReLearn).toEqual({ checked: 1, fresh: 1, stale: [], staleEdges: [] });
  });

  it('flags a learn note whose stamped source file was deleted', async () => {
    await runBlueprintAt('derive', undefined, { runId: RUN_ID });
    await runBlueprintAt('observe', undefined, {
      note: NOTE_TEXT,
      anchor: [MODULE_ANCHOR, FILE_ANCHOR],
      runId: RUN_ID,
    });

    rmSync(join(repoRoot, FILE_REF));

    const report = computeStaleCheckReport(flowDir, repoRoot, MODULE_REF);
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0].missingFiles).toEqual([FILE_REF]);
    expect(report.stale[0].changedFiles).toEqual([]);
  });

  // ── Fixture helpers ──────────────────────────────────────

  function writeFixture(relPath: string, content: string): void {
    mkdirSync(join(repoRoot, relPath, '..'), { recursive: true });
    writeFileSync(join(repoRoot, relPath), content, 'utf-8');
  }

  /** The fixture module a learn pass documents: spine root `src`, module `calc`. */
  function buildCalcModule(): void {
    writeFixture(
      'src/calc/index.ts',
      ["export { add, subtract } from './operations.js';", "export { Calculator } from './calculator.js';", ''].join('\n'),
    );
    writeFixture(
      FILE_REF,
      [
        'export function add(a: number, b: number): number {',
        '  return a + b',
        '}',
        'export function subtract(a: number, b: number): number {',
        '  return a - b',
        '}',
        '',
      ].join('\n'),
    );
    writeFixture(
      'src/calc/calculator.ts',
      [
        "import { add, subtract } from './operations.js';",
        'export class Calculator {',
        '  private total = 0;',
        '  plus(n: number): this { this.total = add(this.total, n); return this; }',
        '  minus(n: number): this { this.total = subtract(this.total, n); return this; }',
        '  value(): number { return this.total; }',
        '}',
        '',
      ].join('\n'),
    );
  }

  async function runBlueprintAt(
    action: string,
    target?: string,
    options: BlueprintCommandOptions = {},
  ): Promise<{ stdout: string; stderr: string }> {
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
      await runBlueprint(action, target, options);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      process.chdir(originalCwd);
    }
    return { stdout: outChunks.join(''), stderr: errChunks.join('') };
  }

  it('accepts a symbol:<file>#<name> anchor by resolving through the file fallback', async () => {
    await runBlueprintAt('derive', undefined, { runId: RUN_ID });
    expect(process.exitCode ?? 0).toBe(0);

    // Live-E2E finding regression: before the parseAnchorFlag fix this exact
    // shape sank the whole note (ref "src/calc/operations.ts#add" resolved
    // against nothing; observe's all-or-nothing rule refused the write).
    await runBlueprintAt('observe', undefined, {
      note: 'src/calc exposes add — learned via caged session',
      anchor: ['module:src/calc', 'symbol:src/calc/operations.ts#add'],
      runId: RUN_ID,
    });
    expect(process.exitCode ?? 0).toBe(0);

    const lines = readFileSync(
      join(flowDir, 'brain', '.structure', 'investigations.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const note = lines.find(
      (entry) => entry.kind === 'note' && String(entry.text).includes('caged session')
    );
    expect(note).toBeDefined();
    const symbolAnchor = note.anchors.find((a: { kind: string }) => a.kind === 'symbol');
    // Split form: ref = bare symbol name, file = path (which is what gets
    // hash-stamped, so stale-check keeps working for symbol anchors too).
    expect(symbolAnchor).toMatchObject({
      kind: 'symbol',
      ref: 'add',
      file: 'src/calc/operations.ts',
    });
    // The stamp keys on the anchor ref ('add') but its content hash comes
    // from anchor.file — the split form keeps stale-check working.
    expect(
      note.hashStamps.some(
        (stamp: { ref: string; contentHash: string }) =>
          stamp.ref === 'add' && stamp.contentHash.length === 64
      )
    ).toBe(true);
  });
});
