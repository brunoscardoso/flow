/**
 * Cross-feature E2E integration tests for the blueprint system (the
 * "wired-or-absent" guardrail layer) — everything runs through the REAL
 * derive pipeline and CLI action, not unit seams:
 *
 * 1. Repo-shape matrix extension: a python-ish repo + a hand-written graphify
 *    NetworkX export + `engines.graphify: enabled` → dual-source derive with
 *    synthesized python module nodes obeying every spine invariant.
 * 2. Full-loop investigation lifecycle: derive → observe note → heat →
 *    context → strict-refuse → supersede → compact → derive again, with
 *    byte-level store-integrity assertions at each refusal/derive boundary.
 * 3. Staleness E2E through the real derive: fresh (no refresh), dirty-tree
 *    stale (refresh invoked), and refresh-failure (last-known-good notice
 *    while backbone + enrichment still apply).
 * 4. Pending gate E2E: `engines.graphify: pending` → exact persistent notice,
 *    native extractor set, zero subprocess attempts.
 * 5. Prose report E2E: synthesized python modules reach `## Modules`,
 *    byte-identical across a double derive.
 * 6. Rails → derive integration: a `pending` flowconfig written by the
 *    install rails is honored by the next derive.
 *
 * `node:child_process.execSync` is module-mocked (repo convention — see
 * graphify-enrich.test.ts) so `which graphify` / git staleness signals /
 * `graphify update .` are deterministic on any machine; this suite therefore
 * needs `node --experimental-vm-modules` (the `npm run test` default runner).
 * No real git or graphify is ever invoked.
 */

import { jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BlueprintGraph } from '../blueprint/types.js';
import type { BlueprintCommandOptions } from './blueprint.js';
import type { GraphifyRailsDeps } from './graphify-rails.js';

const mockExecSync = jest.fn<(command: string, options?: unknown) => string>();
const mockSpawn = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  execSync: mockExecSync,
  // corpus-index imports execFileSync (argv-array git lookup); a factory
  // missing the export is a module-link error under ESM jest.
  execFileSync: jest.fn(() => ''),
  spawn: mockSpawn,
}));

// Import after mocks are set up — everything below shares the mocked
// child_process, so the REAL derive pipeline runs with deterministic
// graphify/git subprocess behavior.
const { deriveBlueprint, runBlueprint } = await import('./blueprint.js');
const { ensureGraphify } = await import('./graphify-rails.js');
const { compactInvestigations, investigationFingerprint, readInvestigations } = await import(
  '../blueprint/investigation-store.js'
);
const { readGraph } = await import('../blueprint/store.js');

const RUN_ID = 'run-e2e';

// #901: the native derive path now runs the convention packs too.
const NATIVE_EXTRACTOR_SET = ['integrations', 'endpoints', 'datastores', 'modules', 'nextjs', 'graphql', 'fastapi'];
const DUAL_SOURCE_SET = ['graphify', 'integrations', 'endpoints', 'datastores', 'modules', 'nextjs', 'graphql', 'fastapi'];

describe('blueprint E2E integration', () => {
  let repoRoot: string;
  let flowDir: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'blueprint-e2e-test-'));
    flowDir = join(repoRoot, 'flow');
    mkdirSync(flowDir, { recursive: true });
    originalExitCode = process.exitCode;
    // A successful `derive` never touches process.exitCode, so a non-zero
    // value leaked by an earlier suite in the same worker would fail this
    // suite's exit-code assertions — start every test from a clean slate.
    process.exitCode = undefined;
    mockExecSync.mockReset();
    mockSpawn.mockReset();
    // Default: no git repo, no graphify — every subprocess probe fails.
    mockExecSync.mockImplementation((command: string) => {
      throw new Error(`command failed: ${command}`);
    });
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // ── Fixture helpers ──────────────────────────────────────

  function writeFixture(relPath: string, content: string): void {
    mkdirSync(join(repoRoot, relPath, '..'), { recursive: true });
    writeFileSync(join(repoRoot, relPath), content, 'utf-8');
  }

  /** Minimal TS repo: spine root `src` with `api` and `lib` children. */
  function buildTsRepo(): void {
    writeFixture(
      'src/api/server.ts',
      [
        "import { helper } from '../lib/helper.js';",
        '',
        "app.get('/users', (req, res) => res.json(helper()));",
        '',
      ].join('\n'),
    );
    writeFixture('src/lib/helper.ts', "export function helper(): string {\n  return 'ok';\n}\n");
  }

  /** Python-ish repo: no TS/JS sources at all — native extractors find nothing. */
  function buildPythonRepo(): void {
    writeFixture('src/main.py', "print('hello')\n");
    writeFixture('backend/app/views.py', 'def list_users():\n    return []\n');
    writeFixture('backend/app/models.py', 'class User:\n    pass\n');
  }

  /** Hand-written graphify NetworkX node_link export with python source files. */
  function writePythonGraphifyExport(): void {
    writeFixture(
      'graphify-out/graph.json',
      JSON.stringify({
        nodes: [
          { id: 'backend/app/models.py::User', source_file: 'backend/app/models.py', community: 2 },
          { id: 'backend/app/views.py::list_users', source_file: 'backend/app/views.py', community: 1 },
          { id: 'src/main.py::main', source_file: 'src/main.py', community: 1 },
        ],
        links: [
          {
            source: 'backend/app/views.py::list_users',
            target: 'backend/app/models.py::User',
            relation: 'calls',
          },
          {
            source: 'src/main.py::main',
            target: 'backend/app/views.py::list_users',
            relation: 'calls',
          },
        ],
      }),
    );
  }

  /** Graphify export whose source files live in the TS fixture repo. */
  function writeTsGraphifyExport(): void {
    writeFixture(
      'graphify-out/graph.json',
      JSON.stringify({
        nodes: [
          { id: 'src/api/server.ts::handler', source_file: 'src/api/server.ts', community: 1 },
          { id: 'src/lib/helper.ts::helper', source_file: 'src/lib/helper.ts', community: 2 },
        ],
        links: [
          { source: 'src/api/server.ts::handler', target: 'src/lib/helper.ts::helper', relation: 'calls' },
        ],
      }),
    );
  }

  /**
   * Mock exec environment: graphify installed + configurable git signals and
   * `graphify update .` behavior (mirrors graphify-enrich.test.ts).
   */
  function mockGraphifyEnvironment(options: {
    /** `git status --porcelain` stdout; undefined → command throws (no git). */
    status?: string;
    /** `git log -1 --format=%ct` epoch; undefined → command throws (no git). */
    lastCommitEpoch?: number;
    /** `graphify update .` behavior; default is to throw. */
    update?: 'succeed' | 'fail';
  }): void {
    mockExecSync.mockImplementation((command: string) => {
      if (command === 'which graphify') {
        return '/stub/bin/graphify\n';
      }
      if (command === 'git status --porcelain') {
        if (options.status === undefined) {
          throw new Error('not a git repo');
        }
        return options.status;
      }
      if (command === 'git log -1 --format=%ct') {
        if (options.lastCommitEpoch === undefined) {
          throw new Error('not a git repo');
        }
        return `${options.lastCommitEpoch}\n`;
      }
      if (command === 'graphify update .') {
        if (options.update === 'succeed') {
          return '';
        }
        throw new Error('graphify exploded');
      }
      throw new Error(`command failed: ${command}`);
    });
  }

  /** Run any `runBlueprint` action from inside the fixture repo, capturing both streams. */
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

  function stripDerivedAt(graph: BlueprintGraph): Omit<BlueprintGraph, 'derivedAt'> {
    const { derivedAt: _derivedAt, ...rest } = graph;
    return rest;
  }

  function investigationsFilePath(): string {
    return join(flowDir, 'brain', '.structure', 'investigations.jsonl');
  }

  // ── 1. Repo-shape matrix extension: python repo via graphify backbone ──

  describe('python repo through the dual-source derive (repo-shape matrix extension)', () => {
    beforeEach(() => {
      buildPythonRepo();
      writePythonGraphifyExport();
      writeFixture('flow/.flowconfig', 'engines.graphify: enabled\n');
      // Graphify installed; no git repo → staleness undeterminable → no refresh
      mockGraphifyEnvironment({});
    });

    it('should synthesize python module nodes with valid spine invariants and the dual-source extractor set', () => {
      const lines = deriveBlueprint(repoRoot, RUN_ID);

      // The headline multi-language win: the native folder spine is now
      // language-agnostic (#536), so `src` (a .py dir) becomes a native module
      // node; the graphify backbone synthesizes the remaining dirs it alone
      // saw (backend, backend/app) — 2 synthesized, deduped against native.
      expect(lines).toContain(
        'backbone: graphify modules merged (2 synthesized module(s), 1 cross-module edge(s))',
      );
      expect(lines).toContain('validation: ok');

      const graph = readGraph(flowDir) as BlueprintGraph;
      expect(graph.coverage.extractorsRun).toEqual(DUAL_SOURCE_SET);
      // Native TS/JS scan saw zero source files (filesScanned counts the
      // TS/JS chunk pass, not the language-agnostic module spine) — SDK/route
      // structure is graphify's alone.
      expect(graph.coverage).toMatchObject({ filesScanned: 0, filesTotal: 0 });

      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      expect(byId.get('module:backend')).toMatchObject({
        kind: 'module',
        label: 'backend',
        sourceFile: 'backend',
        meta: expect.objectContaining({ depth: 1, backbone: true }),
      });
      expect(byId.get('module:backend/app')).toMatchObject({
        kind: 'module',
        label: 'app',
        sourceFile: 'backend/app',
        meta: expect.objectContaining({ depth: 2, fileCount: 2 }),
      });
      expect(byId.get('module:src')).toMatchObject({
        kind: 'module',
        label: 'src',
        sourceFile: 'src',
        meta: expect.objectContaining({ depth: 1, fileCount: 1 }),
      });

      // Spine invariants: parent → child `contains` with depth = parent + 1,
      // and the cross-module python call becomes a blueprint edge
      expect(graph.edges).toContainEqual({
        source: 'module:backend',
        target: 'module:backend/app',
        relation: 'contains',
      });
      expect(graph.edges).toContainEqual({
        source: 'module:src',
        target: 'module:backend/app',
        relation: 'calls',
      });

      // Staleness undeterminable (no git) → the refresh path never runs
      expect(mockExecSync).not.toHaveBeenCalledWith('graphify update .', expect.anything());
    });

    it('should stay deterministic across a double derive (graphs equal minus derivedAt)', () => {
      deriveBlueprint(repoRoot, RUN_ID);
      const first = readGraph(flowDir) as BlueprintGraph;

      const secondLines = deriveBlueprint(repoRoot, RUN_ID);
      const second = readGraph(flowDir) as BlueprintGraph;

      expect(secondLines).toContain('validation: ok');
      expect(stripDerivedAt(second)).toEqual(stripDerivedAt(first));
    });

    // ── 5. Prose report E2E on the synthesized python structure ──

    it('should carry the synthesized python modules into a byte-stable prose report', () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const reportPath = join(flowDir, 'brain', 'blueprint-report.md');
      expect(existsSync(reportPath)).toBe(true);
      const first = readFileSync(reportPath, 'utf-8');

      // The synthesized python module reaches the ## Modules section
      const modulesSection = first.split('\n## ')[1];
      expect(modulesSection.startsWith('Modules')).toBe(true);
      expect(modulesSection).toContain('- **app** — `backend/app`');
      expect(modulesSection).toContain('- **backend** — `backend`');
      expect(modulesSection).toContain('- **src** — `src`');
      expect(first).toContain('extractors: graphify, integrations, endpoints, datastores, modules');

      deriveBlueprint(repoRoot, RUN_ID);
      const second = readFileSync(reportPath, 'utf-8');
      expect(second).toBe(first);
    });
  });

  // ── 2. Full-loop investigation lifecycle E2E ─────────────

  describe('full-loop investigation lifecycle', () => {
    const MODULE_ANCHOR = 'module:src/lib';
    const MODULE_REF = 'src/lib';

    beforeEach(() => {
      buildTsRepo();
      // No flowconfig — graphify silent, zero subprocess involvement
    });

    it('should run derive → note → heat → context → refuse → supersede → compact → derive with store integrity', async () => {
      // Step 1: derive the graph the anchors resolve against
      const derive = await runBlueprintAt('derive', undefined, { runId: RUN_ID });
      expect(derive.stdout).toContain('validation: ok');
      expect(process.exitCode ?? 0).toBe(0);

      // Step 2: observed note on a module anchor
      const note = await runBlueprintAt('observe', undefined, {
        note: 'helper module is pure and side-effect free',
        anchor: [MODULE_ANCHOR],
        runId: RUN_ID,
      });
      expect(process.exitCode ?? 0).toBe(0);
      const firstFingerprint = investigationFingerprint({
        text: 'helper module is pure and side-effect free',
        anchors: [{ kind: 'module', ref: MODULE_REF }],
      });
      expect(note.stdout).toBe(`observed: note ${firstFingerprint} (observed) on 1 anchor(s)\n`);

      // Step 3: human heat tick on the same anchor
      const heat = await runBlueprintAt('observe', undefined, {
        anchor: [MODULE_ANCHOR],
        visit: 'human',
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(heat.stdout).toBe('observed: heat +1 anchor(s)\n');

      // Step 4: context surfaces the investigation section (note + heat)
      const context = await runBlueprintAt('context', 'module:src/lib');
      expect(process.exitCode ?? 0).toBe(0);
      const parsed = JSON.parse(context.stdout) as {
        investigation: {
          notes: Array<{ text: string; status: string }>;
          heat: Array<{ anchorRef: string; humanVisits: number; agentVisits: number }>;
        };
      };
      expect(parsed.investigation.notes).toEqual([
        expect.objectContaining({
          text: 'helper module is pure and side-effect free',
          status: 'observed',
        }),
      ]);
      expect(parsed.investigation.heat).toEqual([
        expect.objectContaining({ anchorRef: MODULE_REF, humanVisits: 1, agentVisits: 1 }),
      ]);

      // Step 5: a second conflicting note is refused — exit 1, and the store
      // file is unchanged byte-for-byte by the refused attempt
      const storeBefore = readFileSync(investigationsFilePath(), 'utf-8');
      const refused = await runBlueprintAt('observe', undefined, {
        note: 'helper module secretly mutates global state',
        anchor: [MODULE_ANCHOR],
      });
      expect(process.exitCode).toBe(1);
      expect(refused.stderr).toBe(
        `observe refused: anchor '${MODULE_REF}' already carries 1 active note(s) — pass --status corroborates, or --supersedes <fingerprint> --reason "<why>" (existing fingerprints: ${firstFingerprint})\n`,
      );
      expect(readFileSync(investigationsFilePath(), 'utf-8')).toBe(storeBefore);
      process.exitCode = 0;

      // Step 6: supersede with a reason is accepted
      const superseding = await runBlueprintAt('observe', undefined, {
        note: 'helper module now caches results',
        anchor: [MODULE_ANCHOR],
        supersedes: firstFingerprint,
        reason: 'caching added',
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(superseding.stdout).toContain('(observed) on 1 anchor(s)');

      // Step 7: context now shows ONLY the superseding note (fold-on-read)
      const afterSupersede = await runBlueprintAt('context', 'module:src/lib');
      const folded = JSON.parse(afterSupersede.stdout) as {
        investigation: { notes: Array<{ text: string; supersedes?: string }> };
      };
      expect(folded.investigation.notes).toEqual([
        expect.objectContaining({
          text: 'helper module now caches results [supersedes: caching added]',
          supersedes: firstFingerprint,
        }),
      ]);

      // Step 8: compaction preserves the folded view exactly — note totals
      // and aggregated heat counts survive the rewrite
      const beforeCompact = readInvestigations(flowDir);
      const compaction = compactInvestigations(flowDir);
      expect(compaction).toMatchObject({ notesKept: 1, notesDropped: 1, heatLinesAfter: 1 });
      // 3 raw ticks: note write (agent), heat (human), superseding write (agent)
      expect(compaction.heatLinesBefore).toBe(3);
      expect(readInvestigations(flowDir)).toEqual(beforeCompact);
      expect(beforeCompact.heat).toEqual([
        expect.objectContaining({ anchorRef: MODULE_REF, humanVisits: 1, agentVisits: 2 }),
      ]);

      // Step 9: derive again — the store sits below derive's compaction
      // thresholds (already compacted: nothing foldable), so derive's
      // maintenance step leaves investigations.jsonl byte-identical
      const compactedBytes = readFileSync(investigationsFilePath(), 'utf-8');
      const reDerive = await runBlueprintAt('derive', undefined, { runId: RUN_ID });
      expect(reDerive.stdout).toContain('validation: ok');
      expect(readFileSync(investigationsFilePath(), 'utf-8')).toBe(compactedBytes);

      // …and the surviving note is still surfaced through context
      const finalContext = await runBlueprintAt('context', 'module:src/lib');
      const finalParsed = JSON.parse(finalContext.stdout) as {
        investigation: { notes: Array<{ text: string }> };
      };
      expect(finalParsed.investigation.notes).toHaveLength(1);
      expect(finalParsed.investigation.notes[0].text).toBe(
        'helper module now caches results [supersedes: caching added]',
      );
    });
  });

  // ── 3. Staleness E2E through the real derive pipeline ───

  describe('graphify staleness through deriveBlueprint', () => {
    beforeEach(() => {
      buildTsRepo();
      writeTsGraphifyExport();
      writeFixture('flow/.flowconfig', 'engines.graphify: enabled\n');
    });

    /** An epoch one day in the past — older than the just-written graph file. */
    const pastEpoch = (): number => Math.floor(Date.now() / 1000) - 86_400;

    it('should not invoke a refresh on a clean tree with a graph newer than the last commit', () => {
      mockGraphifyEnvironment({ status: '', lastCommitEpoch: pastEpoch() });

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(mockExecSync).not.toHaveBeenCalledWith('graphify update .', expect.anything());
      expect(lines).toContain('validation: ok');
      expect(lines.some((line) => line.startsWith('graphify refresh failed'))).toBe(false);
      const graph = readGraph(flowDir) as BlueprintGraph;
      expect(graph.coverage.graphifyEnriched).toBe(true);
      expect(graph.coverage.extractorsRun).toEqual(DUAL_SOURCE_SET);
    });

    it('should invoke the incremental refresh when the working tree has dirty source files', () => {
      mockGraphifyEnvironment({
        status: ' M src/lib/helper.ts\n',
        lastCommitEpoch: pastEpoch(),
        update: 'succeed',
      });

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(mockExecSync).toHaveBeenCalledWith('graphify update .', expect.anything());
      expect(lines).toContain('validation: ok');
      expect(lines.some((line) => line.startsWith('graphify refresh failed'))).toBe(false);
      expect((readGraph(flowDir) as BlueprintGraph).coverage.graphifyEnriched).toBe(true);
    });

    it('should surface the last-known-good notice on a failed refresh while backbone and enrichment still apply', () => {
      mockGraphifyEnvironment({
        status: ' M src/lib/helper.ts\n',
        lastCommitEpoch: pastEpoch(),
        update: 'fail',
      });

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(mockExecSync).toHaveBeenCalledWith('graphify update .', expect.anything());
      // The loud last-known-good notice is present…
      expect(lines[0]).toMatch(
        /^graphify refresh failed \(.+\) — using last-known-good graph from \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      // …AND the derive still succeeds with BOTH graphify layers applied
      expect(lines.some((line) => line.startsWith('backbone: graphify modules merged'))).toBe(true);
      expect(lines).toContain('validation: ok');
      const graph = readGraph(flowDir) as BlueprintGraph;
      expect(graph.coverage.extractorsRun).toEqual(DUAL_SOURCE_SET);
      expect(graph.coverage.graphifyEnriched).toBe(true);
      expect(graph.edges).toContainEqual({
        source: 'module:src/api',
        target: 'module:src/lib',
        relation: 'calls',
      });
    });
  });

  // ── 4. Always-on: legacy pending is ignored, availability gates (#142) ──

  describe('always-on derive gating through the CLI derive action', () => {
    it('ignores a legacy pending value and runs native-only via availability when graphify is unavailable', async () => {
      buildTsRepo();
      writeTsGraphifyExport(); // present, but graphify is unavailable → ignored
      writeFixture('flow/.flowconfig', 'engines.graphify: pending\n');

      const result = await runBlueprintAt('derive', undefined, { runId: RUN_ID });

      expect(process.exitCode ?? 0).toBe(0);
      const lines = result.stdout.split('\n');
      // No pending notice anymore — availability drives the native-only notice.
      expect(lines.some((line) => line.includes('pending install'))).toBe(false);
      expect(lines.some((line) => line.includes('graphify unavailable'))).toBe(true);
      expect(lines).toContain('validation: ok');
      expect(lines.some((line) => line.startsWith('backbone:'))).toBe(false);

      const graph = readGraph(flowDir) as BlueprintGraph;
      expect(graph.coverage.extractorsRun).toEqual(NATIVE_EXTRACTOR_SET);
      expect(graph.coverage.graphifyEnriched).toBe(false);
    });
  });

  // ── 6. Rails → derive integration ────────────────────────

  describe('install rails feeding the derive gate', () => {
    it('is pending when no package manager, and the next derive still gates on availability (#142)', async () => {
      buildTsRepo();

      // Rails: no graphify, no uv, no pipx → pending, and NOTHING recorded.
      const railsExec: GraphifyRailsDeps['exec'] = (command: string) => {
        throw new Error(`which: no ${command}`);
      };
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      let outcome: string;
      try {
        outcome = (await ensureGraphify(repoRoot, { exec: railsExec })).outcome;
      } finally {
        logSpy.mockRestore();
      }
      expect(outcome).toBe('pending');
      // The rails write no flowconfig key at all now (#1808). This assertion
      // used to read `engines.graphify: pending` back out, which quietly made
      // the write look like the thing the derive gate below consults — and it
      // never was. The state is in the outcome; the file is the user's.
      expect(existsSync(join(flowDir, '.flowconfig'))).toBe(false);

      // The next derive gates on availability (unavailable by default here)
      // → native-only, no pending notice. That is the subject of this test, and
      // it is unchanged.
      const lines = deriveBlueprint(repoRoot, RUN_ID);
      expect(lines.some((line) => line.includes('pending install'))).toBe(false);
      expect((readGraph(flowDir) as BlueprintGraph).coverage.extractorsRun).toEqual(
        NATIVE_EXTRACTOR_SET,
      );
    });
  });

  // ── 7. Story walkthrough end-to-end through the CLI narrate/render verbs ──

  describe('story walkthrough lifecycle (narrate → render → clear)', () => {
    const CLEAN_PLAN = 'story-clean';
    const BAD_PLAN = 'story-bad';
    const CLEAN_DOC = 'flow/plans/plan_story-clean_v1.md';
    const BAD_DOC = 'flow/plans/plan_story-bad_v1.md';

    function storyFilePath(): string {
      return join(flowDir, 'brain', '.structure', 'story.json');
    }

    function storyHtmlPath(): string {
      return join(flowDir, 'brain', '.structure', 'story.html');
    }

    /**
     * A clean story whose every anchor/flow id resolves: two real derived
     * module nodes (`module:src/api`, `module:src/lib`), plus two ghosts
     * proposed below (`module:src/cache`, `endpoint:POST /cache`). Anchor
     * kinds `module` and `endpoint` are the only kinds that resolve against
     * ghosts (see `proposalMatchesAnchor`).
     */
    const CLEAN_STORY = [
      '# Plan: story clean',
      '',
      '## Story',
      '',
      '### Step: API entrypoint',
      '- kicker: Overview',
      '- anchors: module:src/api',
      '- flow: module:src/api, module:src/lib',
      '- phases: 1',
      '- decisions: route users through the helper',
      '',
      'The API layer greets users via the helper module.',
      '',
      '### Step: Planned cache layer',
      '- anchors: module:src/cache, endpoint:POST /cache',
      '- phases: 2',
      '- questions: what eviction policy?',
      '',
      'A new caching layer — still a ghost until built.',
      '',
    ].join('\n');

    /**
     * A story whose second step anchors (and flows through) a module that
     * neither derives nor was proposed — the draft-worthy bad anchor. Draft
     * mode compiles it (draft step); strict mode refuses.
     */
    const BAD_STORY = [
      '# Plan: story bad',
      '',
      '## Story',
      '',
      '### Step: Working step',
      '- anchors: module:src/lib',
      '- phases: 1',
      '',
      'A fully resolvable step.',
      '',
      '### Step: Broken step',
      '- anchors: module:src/ghosttown',
      '- flow: module:src/ghosttown',
      '- phases: 2',
      '',
      'Anchors a module that is neither derived nor proposed.',
      '',
    ].join('\n');

    it('compiles draft/strict, stays deterministic, renders, then clears', async () => {
      // Step 1: derive the graph the story anchors resolve against
      buildTsRepo();
      const derive = await runBlueprintAt('derive', undefined, { runId: RUN_ID });
      expect(derive.stdout).toContain('validation: ok');
      expect(process.exitCode ?? 0).toBe(0);

      // Sanity: the two real anchor targets are genuinely on the map
      const graphNodeIds = new Set((readGraph(flowDir) as BlueprintGraph).nodes.map((n) => n.id));
      expect(graphNodeIds.has('module:src/api')).toBe(true);
      expect(graphNodeIds.has('module:src/lib')).toBe(true);
      expect(graphNodeIds.has('module:src/cache')).toBe(false);

      // Step 2: propose two ghosts the clean story anchors against
      const ghostModule = await runBlueprintAt('propose', undefined, {
        plan: CLEAN_PLAN,
        node: 'module:src/cache',
        kind: 'module',
        label: 'Cache module',
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(ghostModule.stdout).toBe(
        `proposal recorded: module:src/cache (${CLEAN_PLAN})\nproposals: 1 recorded\n`,
      );
      const ghostEndpoint = await runBlueprintAt('propose', undefined, {
        plan: CLEAN_PLAN,
        node: 'endpoint:POST /cache',
        kind: 'endpoint',
        label: 'Cache write endpoint',
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(ghostEndpoint.stdout).toBe(
        `proposal recorded: endpoint:POST /cache (${CLEAN_PLAN})\nproposals: 2 recorded\n`,
      );

      writeFixture(CLEAN_DOC, CLEAN_STORY);
      writeFixture(BAD_DOC, BAD_STORY);

      // Step 3: DRAFT narrate on the bad-anchor doc — compiles WITH a draft
      // step (the unresolved anchor is tolerated), story.json is written,
      // and the draft count is surfaced in the summary line.
      const draft = await runBlueprintAt('narrate', undefined, { from: BAD_DOC, draft: true });
      expect(process.exitCode ?? 0).toBe(0);
      expect(draft.stdout).toBe(`narrate: ${BAD_PLAN} — 2 steps compiled (1 draft)\n`);
      // A STORY WITH NO STEPS IS REFUSED, and the story already compiled stays
      // (2026-10-08: an empty narrate replaced a thread's story).
      const EMPTY_DOC = 'flow/discovery/discovery_empty_story_v1.md';
      writeFixture(EMPTY_DOC, '# Discovery\n\n## Story\n\nOnly prose, no step headings.\n');
      const empty = await runBlueprintAt('narrate', undefined, { from: EMPTY_DOC, draft: true });
      expect(process.exitCode).toBe(1);
      expect(`${empty.stdout}\n${empty.stderr}`).toContain('narrate refused:');
      expect(`${empty.stdout}\n${empty.stderr}`).toContain('has no story steps');
      expect((JSON.parse(readFileSync(storyFilePath(), 'utf-8')) as { plan: string }).plan).toBe(BAD_PLAN);
      process.exitCode = 0;
      const draftStory = JSON.parse(readFileSync(storyFilePath(), 'utf-8')) as {
        plan: string;
        mode: string;
        steps: Array<{ id: string; title: string; draft: boolean; unresolvedAnchors: string[] }>;
      };
      expect(draftStory.plan).toBe(BAD_PLAN);
      expect(draftStory.mode).toBe('draft');
      expect(draftStory.steps).toHaveLength(2);
      expect(draftStory.steps[0]).toMatchObject({ draft: false, unresolvedAnchors: [] });
      expect(draftStory.steps[1]).toMatchObject({
        title: 'Broken step',
        draft: true,
        unresolvedAnchors: ['module:src/ghosttown'],
      });

      // Step 4: STRICT narrate on the SAME bad doc refuses — exit 1, ALL
      // violations listed on stderr (sorted), and the on-disk story.json is
      // left byte-for-byte unchanged by the refused attempt.
      const storeBeforeRefusal = readFileSync(storyFilePath(), 'utf-8');
      const strictBad = await runBlueprintAt('narrate', undefined, { from: BAD_DOC, strict: true });
      expect(process.exitCode).toBe(1);
      expect(strictBad.stderr).toBe(
        'narrate refused: unknown flow id module:src/ghosttown (step "Broken step")\n' +
          'unresolved anchor module:src/ghosttown (step "Broken step")\n',
      );
      expect(readFileSync(storyFilePath(), 'utf-8')).toBe(storeBeforeRefusal);
      process.exitCode = 0;

      // Step 5: STRICT narrate on the clean doc succeeds (mode inferred from
      // the flow/plans path — no flag), overwriting story.json with a
      // fully-resolved, zero-draft story.
      const clean = await runBlueprintAt('narrate', undefined, { from: CLEAN_DOC });
      expect(process.exitCode ?? 0).toBe(0);
      // The outcome line still LEADS. It is now followed by advisory warnings:
      // this fixture is a PLAN doc (strict) authored before the change brief,
      // so it carries neither `unchanged:` nor `fails:`. Both warn and neither
      // refuses — that is the settled v1 behaviour, and the warnings are
      // printed rather than buried in story.json (they were silent before).
      const cleanLines = clean.stdout.trimEnd().split('\n');
      expect(cleanLines[0]).toBe(`narrate: ${CLEAN_PLAN} — 2 steps compiled`);
      expect(cleanLines.slice(1)).toEqual([
        'narrate warning: no `unchanged:` in any step — the change brief will render without its negative-space band (what explicitly does NOT change)',
        'narrate warning: no `fails:` in any step — the change brief will render without its failure-modes slot (how this breaks, user-side)',
      ]);
      const cleanBytes = readFileSync(storyFilePath(), 'utf-8');
      const cleanStory = JSON.parse(cleanBytes) as {
        plan: string;
        mode: string;
        warnings: string[];
        steps: Array<{
          id: string;
          title: string;
          anchors: Array<{ kind: string; ref: string }>;
          flow: string[];
          phases: number[];
          decisions: string[];
          questions: string[];
          unresolvedAnchors: string[];
          draft: boolean;
        }>;
      };
      // Full story.json shape assertions
      expect(cleanStory.plan).toBe(CLEAN_PLAN);
      expect(cleanStory.mode).toBe('strict');
      // Advisory only — the two authored change-brief slots are absent from
      // this pre-change-brief fixture. Warnings never affect the compiled
      // steps, and determinism is asserted separately below.
      expect(cleanStory.warnings).toEqual([
        'no `unchanged:` in any step — the change brief will render without its negative-space band (what explicitly does NOT change)',
        'no `fails:` in any step — the change brief will render without its failure-modes slot (how this breaks, user-side)',
      ]);
      expect(cleanStory.steps).toHaveLength(2);
      expect(cleanStory.steps[0]).toMatchObject({
        id: 'api-entrypoint',
        title: 'API entrypoint',
        anchors: [{ kind: 'module', ref: 'src/api' }],
        flow: ['module:src/api', 'module:src/lib'],
        phases: [1],
        decisions: ['route users through the helper'],
        unresolvedAnchors: [],
        draft: false,
      });
      expect(cleanStory.steps[1]).toMatchObject({
        id: 'planned-cache-layer',
        title: 'Planned cache layer',
        anchors: [
          { kind: 'module', ref: 'src/cache' },
          { kind: 'endpoint', ref: 'POST /cache' },
        ],
        phases: [2],
        questions: ['what eviction policy?'],
        unresolvedAnchors: [],
        draft: false,
      });

      // Step 6: DETERMINISM — a second identical narrate yields byte-identical
      // story.json (no timestamps/clock in the serialization).
      const cleanAgain = await runBlueprintAt('narrate', undefined, { from: CLEAN_DOC });
      expect(process.exitCode ?? 0).toBe(0);
      expect(cleanAgain.stdout).toBe(clean.stdout);
      expect(readFileSync(storyFilePath(), 'utf-8')).toBe(cleanBytes);

      // Step 7: the story walkthrough is RETIRED — the change brief replaced
      // it. `render` still produces the title sheet; it no longer produces a
      // story.html, and nothing recreates one.
      expect(existsSync(storyHtmlPath())).toBe(false);
      const render = await runBlueprintAt('render', undefined, {});
      expect(process.exitCode ?? 0).toBe(0);
      expect(render.stdout).not.toContain('story.html');
      expect(existsSync(storyHtmlPath())).toBe(false);

      // The compiled story SURVIVES the retirement — the grammar is the data
      // model and the brief reads it. Only the HTML renderer went away.
      const brief = await runBlueprintAt('brief', undefined, { plan: CLEAN_PLAN });
      expect(process.exitCode ?? 0).toBe(0);
      expect(brief.stdout).toContain(`brief: ${CLEAN_PLAN}`);
      expect(brief.stdout).toContain('anchors resolved');

      // Step 8: clear the story for its plan — the file is removed…
      const clear = await runBlueprintAt('narrate', undefined, { clear: true, plan: CLEAN_PLAN });
      expect(process.exitCode ?? 0).toBe(0);
      expect(clear.stdout).toBe(`narrate: cleared story for ${CLEAN_PLAN}\n`);
      expect(existsSync(storyFilePath())).toBe(false);

      // …and a second clear is a no-op that says so (no story to remove).
      const clearAgain = await runBlueprintAt('narrate', undefined, {
        clear: true,
        plan: CLEAN_PLAN,
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(clearAgain.stdout).toBe(`narrate: no story for ${CLEAN_PLAN}\n`);
    });
  });

  // ── The document-scoped brief fallback (#1914) ───────────
  //
  // The discovery-view door presses `brief --plan <slug>` on a specific doc.
  // Almost no doc has a compiled story or a drawn feature, so the brief used to
  // refuse with "no compiled story" — the board turned that into a bare band,
  // and the door landed on an empty room. It now falls back to a feature view
  // of the DOCUMENT itself: title + lead prose as identity, so the door always
  // opens onto something. Only an unresolvable slug is a true refusal.

  describe('doc-scoped brief fallback (no compiled story)', () => {
    it('emits a document identity brief for a discovery doc that was never narrated', async () => {
      writeFixture(
        'flow/discovery/discovery_widget-panel_v1.md',
        ['# Discovery: Widget panel', '', 'A dockable panel that lists widgets.', '', '## Requirements', '', '- must dock', ''].join('\n'),
      );

      const brief = await runBlueprintAt('brief', undefined, { plan: 'widget-panel', json: true });
      expect(process.exitCode ?? 0).toBe(0);
      // NEVER the old dead end.
      expect(brief.stdout).not.toContain('no compiled story');

      const payload = JSON.parse(brief.stdout.trim().split('\n').pop() as string);
      // A feature-view identity, sourced from the doc: H1 as the name, the lead
      // paragraph as the prose (stopped before the first `##` section).
      expect(payload.identity.name).toBe('Discovery: Widget panel');
      expect(payload.identity.prose).toContain('A dockable panel that lists widgets.');
      expect(payload.identity.prose).not.toContain('must dock'); // below the first section heading
      // Anatomy, not delta — there is no before/after without a story.
      expect(payload.mode).toBe('anatomy');
    });

    it('skips the metadata block and takes the first real paragraph as the summary', async () => {
      // The exact shape `/discovery-plan` writes: an H1, a bold metadata block,
      // a `---` rule, then the first section. The summary must be the Problem
      // Statement paragraph, never the `**Feature slug**: …` boilerplate.
      writeFixture(
        'flow/discovery/discovery_status-surface_v1.md',
        [
          '# Discovery: Status surface',
          '',
          '**Feature slug**: `status-surface`',
          '**Version**: v1',
          '**Author**: discovery-plan',
          '',
          '---',
          '',
          '## Problem Statement',
          '',
          'The board gives *no* sign of what an agent is doing.',
          '',
          'A second paragraph that must not be included.',
          '',
        ].join('\n'),
      );

      const brief = await runBlueprintAt('brief', undefined, { plan: 'status-surface', json: true });
      expect(process.exitCode ?? 0).toBe(0);
      const payload = JSON.parse(brief.stdout.trim().split('\n').pop() as string);
      expect(payload.identity.prose).toBe('The board gives no sign of what an agent is doing.');
      expect(payload.identity.prose).not.toContain('Feature slug');
      expect(payload.identity.prose).not.toContain('second paragraph');
    });

    it('prefers the plan doc over a discovery of the same slug', async () => {
      writeFixture('flow/discovery/discovery_shared-name_v1.md', '# Discovery: shared\n\nDiscovery lead.\n');
      writeFixture('flow/plans/plan_shared-name_v1.md', '# Plan: shared\n\nPlan lead.\n');

      const brief = await runBlueprintAt('brief', undefined, { plan: 'shared-name', json: true });
      expect(process.exitCode ?? 0).toBe(0);
      const payload = JSON.parse(brief.stdout.trim().split('\n').pop() as string);
      expect(payload.identity.name).toBe('Plan: shared');
    });

    it('describes the document VERSION --path names, not the newest under the slug', async () => {
      writeFixture('flow/discovery/discovery_versions_v1.md', '# Discovery: first take\n\nFirst lead.\n');
      writeFixture('flow/discovery/discovery_versions_v2.md', '# Discovery: second take\n\nSecond lead.\n');

      // Positive first (allowed-pattern #28): with no --path the newest wins.
      const newest = await runBlueprintAt('brief', undefined, { plan: 'versions', json: true });
      expect(JSON.parse(newest.stdout.trim().split('\n').pop() as string).identity.name).toBe('Discovery: second take');

      const pinned = await runBlueprintAt('brief', undefined, {
        plan: 'versions',
        path: 'flow/discovery/discovery_versions_v1.md',
        json: true,
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(JSON.parse(pinned.stdout.trim().split('\n').pop() as string).identity.name).toBe('Discovery: first take');
    });

    it('refuses a --path that is not a document of the slug', async () => {
      writeFixture('flow/discovery/discovery_versions_v1.md', '# Discovery: first take\n\nFirst lead.\n');
      writeFixture('flow/discovery/discovery_other_v1.md', '# Discovery: other\n\nOther.\n');
      const brief = await runBlueprintAt('brief', undefined, {
        plan: 'versions',
        path: 'flow/discovery/discovery_other_v1.md',
        json: true,
      });
      expect(`${brief.stdout}\n${brief.stderr}`).toContain("is not a document of 'versions'");
      expect(process.exitCode).toBe(1);
    });

    // ── One brief per document VERSION (review of f6ef9977) ──
    //
    // Every regenerated discovery keeps its own card, and each card's door must
    // describe ITS version. These pin the four ways a pinned brief used to leak
    // another version's content into it.

    /** A discovery version whose `## Story` has one step titled `step`. */
    function versionDoc(title: string, step: string): string {
      return ['# ' + title, '', title + ' lead.', '', '## Story', '', '### Step: ' + step, '', 'Body.', ''].join('\n');
    }

    /** The last JSON line of a brief run. */
    function briefPayload(out: { stdout: string }): Record<string, any> {
      return JSON.parse(out.stdout.trim().split('\n').pop() as string);
    }

    it("never shows an older version's story on the newest version it was not compiled from", async () => {
      writeFixture('flow/discovery/discovery_widget_v7.md', versionDoc('Discovery: v7', 'Seven'));
      await runBlueprintAt('narrate', undefined, { from: 'flow/discovery/discovery_widget_v7.md' });
      expect(process.exitCode ?? 0).toBe(0);

      // Positive first (#28): pinned to the doc it was compiled from, the story speaks.
      const seven = await runBlueprintAt('brief', undefined, {
        plan: 'widget',
        path: 'flow/discovery/discovery_widget_v7.md',
        json: true,
      });
      expect(briefPayload(seven).steps.map((step: { title: string }) => step.title)).toEqual(['Seven']);

      // v8 written, never narrated: its door describes v8, not v7's story.
      writeFixture('flow/discovery/discovery_widget_v8.md', versionDoc('Discovery: v8', 'Eight'));
      const eight = await runBlueprintAt('brief', undefined, {
        plan: 'widget',
        path: 'flow/discovery/discovery_widget_v8.md',
        json: true,
      });
      expect(process.exitCode ?? 0).toBe(0);
      const payload = briefPayload(eight);
      expect(payload.steps).toEqual([]);
      expect(payload.identity.name).toBe('Discovery: v8');
    });

    it('matches a story compiled from a ./-prefixed path to the pinned version', async () => {
      writeFixture('flow/discovery/discovery_dotted_v1.md', versionDoc('Discovery: dotted', 'Dotted'));
      await runBlueprintAt('narrate', undefined, { from: './flow/discovery/discovery_dotted_v1.md', draft: true, plan: 'dotted' });
      expect(process.exitCode ?? 0).toBe(0);
      // A newer version exists, so only the normalised path match can admit the story.
      writeFixture('flow/discovery/discovery_dotted_v2.md', versionDoc('Discovery: dotted 2', 'Two'));

      const pinned = await runBlueprintAt('brief', undefined, {
        plan: 'dotted',
        path: 'flow/discovery/discovery_dotted_v1.md',
        json: true,
      });
      expect(briefPayload(pinned).steps.map((step: { title: string }) => step.title)).toEqual(['Dotted']);
    });

    it('echoes the document it described as docPath, so a caller can tell a pin was honoured', async () => {
      writeFixture('flow/discovery/discovery_echo_v1.md', '# Discovery: one\n\nOne.\n');
      writeFixture('flow/discovery/discovery_echo_v2.md', '# Discovery: two\n\nTwo.\n');

      const newest = await runBlueprintAt('brief', undefined, { plan: 'echo', json: true });
      expect(briefPayload(newest).docPath).toBe('flow/discovery/discovery_echo_v2.md');

      const pinned = await runBlueprintAt('brief', undefined, {
        plan: 'echo',
        path: 'flow/discovery/discovery_echo_v1.md',
        json: true,
      });
      expect(briefPayload(pinned).docPath).toBe('flow/discovery/discovery_echo_v1.md');

      // The story branch echoes too.
      writeFixture('flow/discovery/discovery_echo_v2.md', versionDoc('Discovery: two', 'Two'));
      await runBlueprintAt('narrate', undefined, { from: 'flow/discovery/discovery_echo_v2.md' });
      const story = await runBlueprintAt('brief', undefined, {
        plan: 'echo',
        path: 'flow/discovery/discovery_echo_v2.md',
        json: true,
      });
      expect(briefPayload(story).steps).toHaveLength(1);
      expect(briefPayload(story).docPath).toBe('flow/discovery/discovery_echo_v2.md');
    });

    it('opens an unversioned document by its path', async () => {
      writeFixture('flow/discovery/discovery_plainname.md', '# Discovery: plain\n\nPlain lead.\n');
      const brief = await runBlueprintAt('brief', undefined, {
        plan: 'plainname',
        path: 'flow/discovery/discovery_plainname.md',
        json: true,
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(briefPayload(brief).identity.name).toBe('Discovery: plain');
    });

    it('still refuses an unversioned path that escapes the flow dirs or names another slug', async () => {
      writeFixture('flow/discovery/discovery_plainname.md', '# Discovery: plain\n\nPlain.\n');
      const other = await runBlueprintAt('brief', undefined, {
        plan: 'otherslug',
        path: 'flow/discovery/discovery_plainname.md',
        json: true,
      });
      expect(`${other.stdout}\n${other.stderr}`).toContain("is not a document of 'otherslug'");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      const escape = await runBlueprintAt('brief', undefined, {
        plan: 'plainname',
        path: 'flow/discovery/../discovery/discovery_plainname.md',
        json: true,
      });
      expect(`${escape.stdout}\n${escape.stderr}`).toContain('is not a document of');
      expect(process.exitCode).toBe(1);
    });

    it("draws an older version's own ghosts, not the ones proposed for a later version", async () => {
      writeFixture('flow/discovery/discovery_ghosts_v7.md', '# Discovery: v7\n\nSeven.\n');
      // v7 was written an hour ago; everything below is proposed after it.
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(join(repoRoot, 'flow/discovery/discovery_ghosts_v7.md'), anHourAgo, anHourAgo);
      writeFixture('flow/discovery/discovery_ghosts_v8.md', '# Discovery: v8\n\nEight.\n');
      // Recorded under v7's exact name: v7's own, whenever it was recorded.
      await runBlueprintAt('propose', undefined, { plan: 'discovery_ghosts_v7', node: 'module:src/seven', kind: 'module', label: 'Seven' });
      // Recorded under v8's exact name: never v7's.
      await runBlueprintAt('propose', undefined, { plan: 'discovery_ghosts_v8', node: 'module:src/eight', kind: 'module', label: 'Eight' });
      // The documented convention (`plan_<slug>_v1`), recorded after v7 was written.
      await runBlueprintAt('propose', undefined, { plan: 'plan_ghosts_v1', node: 'module:src/later', kind: 'module', label: 'Later' });
      expect(process.exitCode ?? 0).toBe(0);

      const labels = (out: { stdout: string }): string[] =>
        briefPayload(out).nodes.map((node: { label: string }) => node.label).sort();

      // Positive first: the newest version draws its own and every unattributed
      // ghost — but not one recorded under v7's exact name.
      const eight = await runBlueprintAt('brief', undefined, {
        plan: 'ghosts',
        path: 'flow/discovery/discovery_ghosts_v8.md',
        json: true,
      });
      expect(labels(eight)).toEqual(['Eight', 'Later']);

      const seven = await runBlueprintAt('brief', undefined, {
        plan: 'ghosts',
        path: 'flow/discovery/discovery_ghosts_v7.md',
        json: true,
      });
      expect(labels(seven)).toEqual(['Seven']);
    });

    it('keeps an unattributed ghost on an older version when it was proposed before that version was written', async () => {
      writeFixture('flow/discovery/discovery_legacy_v1.md', '# Discovery: v1\n\nOne.\n');
      writeFixture('flow/discovery/discovery_legacy_v2.md', '# Discovery: v2\n\nTwo.\n');
      await runBlueprintAt('propose', undefined, { plan: 'legacy', node: 'module:src/old', kind: 'module', label: 'Old' });
      // v1 written after the proposal: the ghost was part of the picture it describes.
      const later = new Date(Date.now() + 60 * 60 * 1000);
      utimesSync(join(repoRoot, 'flow/discovery/discovery_legacy_v1.md'), later, later);
      const one = await runBlueprintAt('brief', undefined, {
        plan: 'legacy',
        path: 'flow/discovery/discovery_legacy_v1.md',
        json: true,
      });
      expect(briefPayload(one).nodes.map((node: { label: string }) => node.label)).toEqual(['Old']);
    });

    it('falls back to the slug when the doc has no H1 heading', async () => {
      writeFixture('flow/discovery/discovery_headless_v1.md', 'Just body text, no heading.\n');
      const brief = await runBlueprintAt('brief', undefined, { plan: 'headless', json: true });
      expect(process.exitCode ?? 0).toBe(0);
      const payload = JSON.parse(brief.stdout.trim().split('\n').pop() as string);
      expect(payload.identity.name).toBe('headless');
    });

    it("carries the doc's declared wiring even when story.json belongs to another doc", async () => {
      // A discovery predicting parts that do not exist yet: the code map has no
      // edge for them, so the Story's flow_after is the only account of how they
      // connect. Before, the doc brief used an EMPTY story and returned no wires.
      writeFixture(
        'flow/discovery/discovery_wired_v1.md',
        [
          '# Discovery: Wired',
          '',
          'Lead.',
          '',
          '## Story',
          '',
          '### Step: The shape',
          '- flow_after: feature:wired/memory-store -reads->, integration:assistant-memory',
          '',
        ].join('\n'),
      );
      await runBlueprintAt('propose', undefined, { plan: 'wired', node: 'feature:wired/memory-store', kind: 'part', label: 'Memory store' });
      await runBlueprintAt('propose', undefined, { plan: 'wired', node: 'integration:assistant-memory', kind: 'integration', label: 'Assistant memory' });

      const brief = await runBlueprintAt('brief', undefined, { plan: 'wired', json: true });
      expect(process.exitCode ?? 0).toBe(0);
      const payload = JSON.parse(brief.stdout.trim().split('\n').pop() as string);
      expect(payload.wires).toEqual([
        {
          from: 'feature:wired/memory-store',
          to: 'integration:assistant-memory',
          delta: 'added',
          labelBefore: '',
          labelAfter: 'reads',
          drawnToday: false,
        },
      ]);
      // Flows only: the Story's anchors must not add file nodes to the view.
      expect(payload.anchors).toEqual([]);
      // A flow names nodes by id; the card title must stay the proposal's label.
      expect(payload.nodes.map((node: { label: string }) => node.label).sort()).toEqual([
        'Assistant memory',
        'Memory store',
      ]);
    });

    it('still refuses a slug that resolves to no doc on disk', async () => {
      const brief = await runBlueprintAt('brief', undefined, { plan: 'nothing-here', json: true });
      expect(process.exitCode).toBe(1);
      expect(`${brief.stdout}\n${brief.stderr}`).toContain("no doc for 'nothing-here'");
    });
  });

  // ── First-run feature bootstrap ──────────────────────────
  //
  // The board's level 1 is FEATURES. `init` bootstraps them, but IDE-managed
  // projects never call init — they are provisioned and derived — so a newly
  // added project opened on an empty board telling the user to go run a CLI
  // verb. Derive is the path every entry point shares.

  describe('first-run feature bootstrap', () => {
    /** A repo naming two capabilities in two planes each. */
    function seedCapabilityRepo(): void {
      writeFixture('package.json', JSON.stringify({ name: 'fresh-proj' }));
      writeFixture('src/app/app/(protected)/billing/page.tsx', 'export const P = 1;\n');
      writeFixture('src/app/api/billing/route.ts', 'export const R = 1;\n');
      writeFixture('e2e/tests/billing/pay.spec.ts', 'export const S = 1;\n');
      writeFixture('src/app/app/(protected)/reports/page.tsx', 'export const P = 2;\n');
      writeFixture('src/app/api/reports/route.ts', 'export const R = 2;\n');
      writeFixture('e2e/tests/reports/list.spec.ts', 'export const S = 2;\n');
    }

    const featuresDir = (): string => join(flowDir, 'brain', 'features');

    it('adopts capability features on a first derive, and reports the count', () => {
      seedCapabilityRepo();

      const lines = deriveBlueprint(repoRoot, null);

      expect(lines.some((line) => /^Features: 2 capability feature\(s\)/.test(line))).toBe(true);
      expect(existsSync(join(featuresDir(), 'billing.md'))).toBe(true);
      expect(existsSync(join(featuresDir(), 'reports.md'))).toBe(true);
      // It must NOT land in the fixed-order summary tail that callers read
      // positionally — it sits above `validation: ok`.
      expect(lines.indexOf(lines.find((l) => l.startsWith('Features:')) as string)).toBeLessThan(
        lines.indexOf('validation: ok'),
      );
      expect(lines[lines.length - 1]).toBe('prose report: flow/brain/blueprint-report.md');
    });

    it('does NOT re-bootstrap on a second derive', () => {
      seedCapabilityRepo();
      deriveBlueprint(repoRoot, null);

      const lines = deriveBlueprint(repoRoot, null);

      expect(lines.some((line) => line.startsWith('Features:'))).toBe(false);
    });

    it('never resurrects a feature the user deleted', () => {
      seedCapabilityRepo();
      deriveBlueprint(repoRoot, null);
      rmSync(join(featuresDir(), 'billing.md'));

      deriveBlueprint(repoRoot, null);

      // Adoption happens once. A non-empty store is never re-seeded, so a
      // deliberate deletion stands — these files are precious, not derived.
      expect(existsSync(join(featuresDir(), 'billing.md'))).toBe(false);
      expect(existsSync(join(featuresDir(), 'reports.md'))).toBe(true);
    });

    it('a SECOND bootstrap after derive reports an empty board — why init must relay, not re-run', async () => {
      seedCapabilityRepo();

      const lines = deriveBlueprint(repoRoot, null);
      expect(lines.some((line) => /^Features: 2 capability feature\(s\)/.test(line))).toBe(true);

      // This is the trap init fell into. Derive is SYNCHRONOUS, so by the time
      // a caller bootstraps "afterwards" the store is already seeded: every
      // slug is taken, the pass adopts nothing, and describeBootstrap renders
      // that as the exact opposite of what just happened.
      const { bootstrapFeatures, describeBootstrap } = await import(
        '../blueprint/feature-bootstrap.js'
      );
      const { readGraph, BLUEPRINT_DIRNAME } = await import('../blueprint/store.js');
      const second = bootstrapFeatures(
        repoRoot,
        flowDir,
        join(flowDir, BLUEPRINT_DIRNAME),
        readGraph(flowDir),
      );

      expect(second.cores).toBe(0);
      expect(second.adopted).toBe(0);
      expect(describeBootstrap(second)).toContain('the feature board starts empty');
      // …while the board is demonstrably NOT empty. Any caller that reports on
      // its own second bootstrap is lying to the user.
      expect(existsSync(join(featuresDir(), 'billing.md'))).toBe(true);
      expect(existsSync(join(featuresDir(), 'reports.md'))).toBe(true);
    });

    it('stays silent and writes nothing when a repo names no capability', () => {
      writeFixture('package.json', JSON.stringify({ name: 'plain' }));
      writeFixture('src/lib/helper.ts', 'export const x = 1;\n');

      const lines = deriveBlueprint(repoRoot, null);

      // Nothing was skipped — there was nothing to find. A line here would sit
      // in front of every plain repo's first derive forever, and it would push
      // the documented fixed-order summary tail out by one.
      expect(lines.some((line) => line.startsWith('Features:'))).toBe(false);
      expect(existsSync(join(featuresDir(), 'lib.md'))).toBe(false);
    });
  });

});
