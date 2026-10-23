/**
 * Integration tests for the blueprint CLI command — the full derive pipeline
 * (extract → graph v1 → must-review → write/rotate → relink → promote) against
 * a fixture mini-repo, plus `blueprint context` output shapes, the hard
 * context cap with its mandatory drill-down hint, and error paths.
 *
 * `runBlueprint` resolves the repo from `process.cwd()` and reports via
 * `process.stdout.write` / `process.exitCode`, so context tests chdir into the
 * fixture repo and capture stdout — both restored after every test.
 */

import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendHeatTick,
  appendInvestigationNote,
  investigationFingerprint,
  readInvestigations,
} from '../blueprint/investigation-store.js';
import { readEffectiveProposals } from '../blueprint/proposal-store.js';
import { readParts, writeFeature, writeParts } from '../blueprint/feature-store.js';
import { appendAnnotation, readAnnotations, readGraph } from '../blueprint/store.js';
import type { BlueprintCommandOptions } from './blueprint.js';
import type { BlueprintGraph, HeatCounter, InvestigationEntry } from '../blueprint/types.js';

// Availability (`which graphify`) and `graphify update` run via
// node:child_process.execSync — mocked (allowed-pattern #12) so derive tests are
// deterministic regardless of whether graphify is installed on the machine. The
// default leaves graphify UNAVAILABLE (execSync throws), so the derive runs
// native-only; tests that want enrichment override the mock.
const mockExecSync = jest.fn<(command: string, options?: unknown) => string>();
// spawn is used by the graphify background-build path (#535); mock it so no real
// build is launched and the never-initialized derive stays deterministic.
const mockSpawn = jest.fn(() => ({ on: () => undefined, unref: () => undefined }));
jest.unstable_mockModule('node:child_process', () => ({
  execSync: mockExecSync,
  // corpus-index imports execFileSync (argv-array git lookup); a factory
  // missing the export is a module-link error under ESM jest.
  execFileSync: jest.fn(() => ''),
  spawn: mockSpawn,
}));

const { deriveBlueprint, runBlueprint } = await import('./blueprint.js');

const RUN_ID = 'run-123';

describe('blueprint command', () => {
  let repoRoot: string;
  let flowDir: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'blueprint-command-test-'));
    flowDir = join(repoRoot, 'flow');
    originalExitCode = process.exitCode;
    buildFixtureRepo(repoRoot);
    // Default: graphify unavailable → derive runs native-only + deterministic.
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((command: string) => {
      throw new Error(`command failed: ${command}`);
    });
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // ── Fixture mini-repo ────────────────────────────────────

  function writeFixture(root: string, relPath: string, content: string): void {
    mkdirSync(join(root, relPath, '..'), { recursive: true });
    writeFileSync(join(root, relPath), content, 'utf-8');
  }

  function buildFixtureRepo(root: string): void {
    writeFixture(
      root,
      'package.json',
      JSON.stringify({
        name: 'fixture-app',
        dependencies: { stripe: '^12.0.0', commander: '^11.0.0' },
      }),
    );
    writeFixture(
      root,
      'src/api/server.ts',
      [
        "import { helper } from '../lib/helper.js';",
        '',
        'const app = createApp();',
        "app.get('/users', (req, res) => res.json(helper()));",
        '',
        'export async function chargeCustomer(): Promise<void> {',
        "  await fetch('https://api.stripe.com/v1/charges');",
        '}',
        '',
      ].join('\n'),
    );
    writeFixture(root, 'src/lib/helper.ts', "export function helper(): string {\n  return 'ok';\n}\n");
    writeFixture(root, 'src/api/handlers/users.ts', 'export const usersHandler = (): number => 42;\n');
    writeFixture(
      root,
      'src/cli/main.ts',
      ["import { Command } from 'commander';", '', 'const program = new Command();', "program.command('init [dir]');", ''].join(
        '\n',
      ),
    );

    mkdirSync(join(root, 'flow'), { recursive: true });
    const anchoredDecision = {
      ts: '2026-07-09T00:00:00Z',
      run_id: RUN_ID,
      type: 'plan_decision',
      decision: 'Use append-only store',
      choice: 'jsonl',
      anchors: [{ kind: 'module', ref: 'api' }],
    };
    const unanchoredRecord = { ts: '2026-07-09T00:00:01Z', run_id: RUN_ID, type: 'phase_result', phase: 1 };
    writeFixture(
      root,
      'flow/.rounds.jsonl',
      `${JSON.stringify(anchoredDecision)}\n${JSON.stringify(unanchoredRecord)}\n`,
    );
  }

  /** Run `runBlueprint` from inside the fixture repo, capturing stdout. */
  async function runBlueprintAt(
    root: string,
    action: string,
    target?: string,
    options: { runId?: string } = {},
  ): Promise<string> {
    const originalCwd = process.cwd();
    const chunks: string[] = [];
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        chunks.push(String(chunk));
        return true;
      });
    process.chdir(root);
    try {
      await runBlueprint(action, target, options);
    } finally {
      spy.mockRestore();
      process.chdir(originalCwd);
    }
    return chunks.join('');
  }

  /** Run `blueprint observe` from inside the fixture repo, capturing BOTH streams. */
  async function runObserveAt(
    root: string,
    options: BlueprintCommandOptions,
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
    process.chdir(root);
    try {
      await runBlueprint('observe', undefined, options);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      process.chdir(originalCwd);
    }
    return { stdout: outChunks.join(''), stderr: errChunks.join('') };
  }

  /** Run any blueprint action from inside the fixture repo, capturing BOTH streams. */
  async function runActionAt(
    root: string,
    action: string,
    options: BlueprintCommandOptions,
    target?: string,
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
    process.chdir(root);
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

  // ── derive ───────────────────────────────────────────────

  describe('deriveBlueprint', () => {
    it('should produce graph.json and report lines in fixed order', () => {
      const lines = deriveBlueprint(repoRoot, RUN_ID);

      // Coverage notes first (no graphify notice — engine not enabled)...
      expect(lines.some((line) => line.startsWith('integrations:'))).toBe(true);
      expect(lines.some((line) => line.startsWith('modules:'))).toBe(true);

      // ...then the five summary lines, in order, at the tail
      const tail = lines.slice(-5);
      expect(tail[0]).toMatch(/^graph: \d+ node\(s\), \d+ edge\(s\) → flow\/brain\/\.structure\/graph\.json$/);
      expect(tail[1]).toBe('must-review: 0 item(s)');
      expect(tail[2]).toBe('relink: 0 staled, 0 recovered');
      expect(tail[3]).toBe('promotion: 1 promoted, 0 skipped');
      expect(tail[4]).toBe('prose report: flow/brain/blueprint-report.md');

      const graph = readGraph(flowDir);
      expect(graph).not.toBeNull();
      expect(graph?.version).toBe(1);
      const nodeIds = graph?.nodes.map((node) => node.id) ?? [];
      expect(nodeIds).toEqual(
        expect.arrayContaining([
          'integration:stripe',
          'integration:api.stripe.com',
          'endpoint:GET /users',
          'endpoint:cli init',
          'module:src/api',
          'module:src/api/handlers',
          'module:src/cli',
          'module:src/lib',
        ]),
      );

      // The folder spine: nested folder nodes hang off their parent via `contains`
      expect(graph?.edges).toContainEqual({
        source: 'module:src/api',
        target: 'module:src/api/handlers',
        relation: 'contains',
      });
    });

    it('should promote the anchored plan_decision with rounds provenance', () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const annotations = readAnnotations(flowDir);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]).toEqual({
        ts: '2026-07-09T00:00:00Z',
        runId: RUN_ID,
        type: 'decision',
        text: 'Use append-only store: jsonl',
        anchors: [{ kind: 'module', ref: 'api' }],
        provenance: `rounds:plan_decision run:${RUN_ID}`,
        status: 'active',
      });
    });

    it('should rotate the previous graph and stay deterministic across derives', () => {
      deriveBlueprint(repoRoot, RUN_ID);
      const first = readGraph(flowDir) as BlueprintGraph;

      const secondLines = deriveBlueprint(repoRoot, RUN_ID);
      const second = readGraph(flowDir) as BlueprintGraph;

      // Rotation: graph.prev.json holds the first derive verbatim
      const prev = JSON.parse(
        readFileSync(join(flowDir, 'brain', '.structure', 'graph.prev.json'), 'utf-8'),
      ) as BlueprintGraph;
      expect(prev).toEqual(first);

      // Determinism: graphs are equal minus the derive timestamp
      expect(stripDerivedAt(second)).toEqual(stripDerivedAt(first));

      // Idempotent promotion: the plan_decision is now a duplicate
      expect(secondLines[secondLines.length - 2]).toBe('promotion: 0 promoted, 1 skipped');
      // Relink: the promoted annotation's LEGACY module anchor (ref 'api',
      // written against the old basename ids) still resolves via the
      // label bridge against the path-based node module:src/api
      expect(secondLines[secondLines.length - 3]).toBe('relink: 0 staled, 0 recovered');
    });

    it('should stamp the derive root into the graph', () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const graph = readGraph(flowDir) as BlueprintGraph;
      expect(graph.root).toBe(repoRoot);
    });

    it('should refuse a zero-scan derive over a non-empty graph, writing nothing', () => {
      deriveBlueprint(repoRoot, RUN_ID);
      const first = readGraph(flowDir) as BlueprintGraph;
      expect(first.nodes.length).toBeGreaterThan(0);

      // The wrong-root signature: the scan finds no candidate files at all.
      rmSync(join(repoRoot, 'src'), { recursive: true, force: true });
      rmSync(join(repoRoot, 'package.json'), { force: true });

      expect(() => deriveBlueprint(repoRoot, RUN_ID)).toThrow(/^derive refused: scanned 0 candidate files/);

      // Nothing written: the previous graph survives verbatim.
      expect(readGraph(flowDir)).toEqual(first);
    });

    it('should name the previous graph root in the refusal when it differs', () => {
      deriveBlueprint(repoRoot, RUN_ID);
      const graphPath = join(flowDir, 'brain', '.structure', 'graph.json');
      const stored = JSON.parse(readFileSync(graphPath, 'utf-8')) as BlueprintGraph;
      stored.root = '/somewhere/else/repo';
      writeFileSync(graphPath, JSON.stringify(stored), 'utf-8');

      rmSync(join(repoRoot, 'src'), { recursive: true, force: true });
      rmSync(join(repoRoot, 'package.json'), { force: true });

      expect(() => deriveBlueprint(repoRoot, RUN_ID)).toThrow('it was derived from /somewhere/else/repo');
    });

    it('should overwrite on a zero-scan derive when --force is passed', () => {
      deriveBlueprint(repoRoot, RUN_ID);
      rmSync(join(repoRoot, 'src'), { recursive: true, force: true });
      rmSync(join(repoRoot, 'package.json'), { force: true });

      deriveBlueprint(repoRoot, RUN_ID, { force: true });

      const graph = readGraph(flowDir) as BlueprintGraph;
      expect(graph.nodes).toEqual([]);
      expect(graph.coverage.filesTotal).toBe(0);
    });

    it('should allow a first derive of a repo with no candidate files', () => {
      rmSync(join(repoRoot, 'src'), { recursive: true, force: true });
      rmSync(join(repoRoot, 'package.json'), { force: true });

      expect(() => deriveBlueprint(repoRoot, RUN_ID)).not.toThrow();
      const graph = readGraph(flowDir) as BlueprintGraph;
      expect(graph.nodes).toEqual([]);
    });

    it('should merge the graphify backbone into a dual-source graph when enabled with a graph present', () => {
      // graphify available (#142): `which graphify` succeeds; git detection still
      // throws so staleness is undeterminable and the present export is used as-is.
      mockExecSync.mockImplementation((command: string) => {
        if (command === 'which graphify') return '/stub/bin/graphify\n';
        throw new Error(`command failed: ${command}`);
      });
      writeFixture(repoRoot, 'flow/.flowconfig', 'engines.graphify: enabled\n');
      writeFixture(
        repoRoot,
        'graphify-out/graph.json',
        JSON.stringify({
          nodes: [
            { id: 'src/api/server.ts::chargeCustomer', source_file: 'src/api/server.ts' },
            { id: 'backend/app/views.py::list_users', source_file: 'backend/app/views.py' },
          ],
          links: [
            {
              source: 'src/api/server.ts::chargeCustomer',
              target: 'backend/app/views.py::list_users',
              relation: 'calls',
            },
          ],
        }),
      );

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(lines).toContain('backbone: graphify modules merged (2 synthesized module(s), 1 cross-module edge(s))');
      expect(lines).toContain('validation: ok');

      const graph = readGraph(flowDir) as BlueprintGraph;
      expect(graph.coverage.extractorsRun).toEqual([
        'graphify',
        'integrations',
        'endpoints',
        'datastores',
        'modules',
        'nextjs',
        'graphql',
        'fastapi',
      ]);
      // Synthesized modules for the python directories the native extractors missed
      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      expect(byId.get('module:backend')).toMatchObject({ kind: 'module', meta: expect.objectContaining({ depth: 1 }) });
      expect(byId.get('module:backend/app')).toMatchObject({ kind: 'module', meta: expect.objectContaining({ depth: 2 }) });
      // Cross-module edge from the covered TS file's module to the synthesized one
      expect(graph.edges).toContainEqual({
        source: 'module:src/api',
        target: 'module:backend/app',
        relation: 'calls',
      });
    });

    it('ignores a legacy `pending` config and gates on availability — native-only when unavailable (#142)', () => {
      // A legacy engines.graphify: pending value no longer produces a "pending
      // install" notice; the availability gate (unavailable by default here)
      // drives native-only with the standard "graphify unavailable" notice.
      writeFixture(repoRoot, 'flow/.flowconfig', 'engines.graphify: pending\n');

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(lines.some((line) => line.includes('pending install'))).toBe(false);
      expect(lines.some((line) => line.includes('graphify unavailable'))).toBe(true);
      expect(lines.some((line) => line.startsWith('backbone:'))).toBe(false);
      expect(lines).toContain('validation: ok');

      const graph = readGraph(flowDir) as BlueprintGraph;
      expect(graph.coverage.extractorsRun).not.toContain('graphify');
      expect(graph.coverage.graphifyEnriched).toBe(false);
    });

    it('should write the prose report to flow/brain/blueprint-report.md', () => {
      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(lines[lines.length - 1]).toBe('prose report: flow/brain/blueprint-report.md');
      const report = readFileSync(join(flowDir, 'brain', 'blueprint-report.md'), 'utf-8');
      expect(report.startsWith('# Blueprint Report\n')).toBe(true);
      for (const heading of ['## Modules', '## Integrations', '## Datastores', '## Endpoints', '## Structure']) {
        expect(report).toContain(`\n${heading}\n`);
      }
      // Derived content from the fixture repo reaches the prose bridge
      expect(report).toContain('- **Stripe** — `package.json`');
      // Pure function of the graph minus derivedAt — no wall-clock timestamp
      const graph = readGraph(flowDir) as BlueprintGraph;
      expect(report).not.toContain(graph.derivedAt);
    });

    it('should rewrite a byte-identical prose report on a double derive', () => {
      deriveBlueprint(repoRoot, RUN_ID);
      const reportPath = join(flowDir, 'brain', 'blueprint-report.md');
      const first = readFileSync(reportPath, 'utf-8');

      deriveBlueprint(repoRoot, RUN_ID);
      const second = readFileSync(reportPath, 'utf-8');

      expect(second).toBe(first);
    });

    it('should auto-compact the investigation store when the fold-dropped ratio crosses the threshold (C3 wiring)', () => {
      // Fixture store crossing COMPACT_DROPPED_RATIO: 1 of 2 notes superseded
      const original: InvestigationEntry = {
        ts: '2026-07-09T00:00:00.000Z',
        runId: RUN_ID,
        anchors: [{ kind: 'file', ref: 'src/lib/helper.ts' }],
        text: 'first look',
        provenance: 'test',
        status: 'observed',
        hashStamps: [],
      };
      appendInvestigationNote(flowDir, original);
      appendInvestigationNote(flowDir, {
        ...original,
        ts: '2026-07-09T01:00:00.000Z',
        text: 'corrected look',
        supersedes: investigationFingerprint(original),
      });

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(lines).toContain('compaction: 1 folded');
      // The store was physically rewritten by the real derive call
      const raw = readFileSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'), 'utf-8');
      expect(raw.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(1);
      expect(readInvestigations(flowDir).notes.map((note) => note.text)).toEqual(['corrected look']);
    });

    it('should omit the compaction line when the store is below both thresholds', () => {
      appendInvestigationNote(flowDir, {
        ts: '2026-07-09T00:00:00.000Z',
        runId: RUN_ID,
        anchors: [{ kind: 'file', ref: 'src/lib/helper.ts' }],
        text: 'lone note',
        provenance: 'test',
        status: 'observed',
        hashStamps: [],
      });

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(lines.some((line) => line.startsWith('compaction:'))).toBe(false);
      // Store untouched — still one raw line
      const raw = readFileSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'), 'utf-8');
      expect(raw.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(1);
    });

    it('should throw when no flow/ directory exists', () => {
      const bareRepo = mkdtempSync(join(tmpdir(), 'blueprint-noflow-test-'));
      try {
        expect(() => deriveBlueprint(bareRepo, null)).toThrow(/No flow\/ directory found/);
      } finally {
        rmSync(bareRepo, { recursive: true, force: true });
      }
    });

    it('should report the missing-flow error and exit 1 via the CLI action', async () => {
      const bareRepo = mkdtempSync(join(tmpdir(), 'blueprint-noflow-cli-test-'));
      try {
        const output = await runBlueprintAt(bareRepo, 'derive');

        expect(output).toContain('No flow/ directory found');
        expect(process.exitCode).toBe(1);
      } finally {
        rmSync(bareRepo, { recursive: true, force: true });
      }
    });
  });

  // ── context ──────────────────────────────────────────────

  describe('blueprint context', () => {
    it('should emit the node, edges, and annotations for an exact id match', async () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const output = await runBlueprintAt(repoRoot, 'context', 'module:src/api');

      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(output) as {
        node: { id: string; kind: string };
        note?: string;
        edges: Array<{ source: string; target: string; relation: string; neighborLabel: string }>;
        annotations: Array<{ text: string }>;
      };
      expect(parsed.node).toMatchObject({ id: 'module:src/api', kind: 'module' });
      expect(parsed.note).toBeUndefined();
      expect(parsed.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'module:src/api', target: 'module:src/lib', relation: 'imports' }),
          expect.objectContaining({ source: 'module:src/api', target: 'endpoint:GET /users', relation: 'exposes' }),
          expect.objectContaining({ source: 'module:src/api', target: 'module:src/api/handlers', relation: 'contains' }),
        ]),
      );
      // The legacy module anchor (ref 'api') attaches via the label bridge
      expect(parsed.annotations).toEqual([expect.objectContaining({ text: 'Use append-only store: jsonl' })]);
    });

    it('names the cross-project links on the node from the Workspace, read from this project\'s side', async () => {
      const savedHome = process.env.PLAN_FLOW_HOME;
      const flowFolder = mkdtempSync(join(tmpdir(), 'blueprint-context-ws-'));
      try {
        process.env.PLAN_FLOW_HOME = flowFolder;
        const workspaceDir = join(flowFolder, 'workspaces', 'team');
        mkdirSync(join(workspaceDir, 'projects', 'app'), { recursive: true });
        writeFileSync(
          join(workspaceDir, 'workspace.json'),
          JSON.stringify({
            name: 'Team',
            slug: 'team',
            projects: [
              { id: 'local:app', name: 'app', slug: 'app', remotes: [] },
              { id: 'local:web', name: 'web', slug: 'web', remotes: [] },
            ],
          }),
        );
        writeFileSync(join(flowFolder, 'projects.local.json'), JSON.stringify({ projects: { 'local:app': repoRoot } }));
        writeFileSync(
          join(workspaceDir, 'links.jsonl'),
          [
            { ts: '2026-10-06T00:00:00.000Z', author: 'Test', kind: 'consumes', from: 'web/file:src/Users.tsx', to: 'app/endpoint:GET /users', note: 'the users page' },
            { ts: '2026-10-06T00:00:00.000Z', author: 'Test', kind: 'calls', from: 'web/file:src/Other.tsx', to: 'app/endpoint:GET /other' },
          ].map((line) => JSON.stringify(line)).join('\n') + '\n',
        );
        deriveBlueprint(repoRoot, RUN_ID);

        const output = await runBlueprintAt(repoRoot, 'context', 'endpoint:GET /users');

        expect(process.exitCode).toBe(0);
        const parsed = JSON.parse(output) as { workspaceLinks?: unknown[] };
        expect(parsed.workspaceLinks).toEqual([
          { kind: 'exposes', own: 'endpoint:GET /users', other: 'web/file:src/Users.tsx', note: 'the users page', author: 'Test', ts: '2026-10-06T00:00:00.000Z' },
        ]);
      } finally {
        if (savedHome === undefined) delete process.env.PLAN_FLOW_HOME;
        else process.env.PLAN_FLOW_HOME = savedHome;
        rmSync(flowFolder, { recursive: true, force: true });
      }
    });

    it('should emit context for a nested folder node id', async () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const output = await runBlueprintAt(repoRoot, 'context', 'module:src/api/handlers');

      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(output) as {
        node: { id: string; kind: string; meta?: { depth?: number } };
        edges: Array<{ source: string; target: string; relation: string }>;
      };
      expect(parsed.node).toMatchObject({ id: 'module:src/api/handlers', kind: 'module' });
      // Root-as-depth-1 semantics: src=1 → src/api=2 → src/api/handlers=3
      expect(parsed.node.meta?.depth).toBe(3);
      expect(parsed.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'module:src/api', target: 'module:src/api/handlers', relation: 'contains' }),
        ]),
      );
    });

    it('should include annotations whose file anchors are contained in the module directory', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      appendAnnotation(flowDir, {
        ts: '2026-07-09T02:00:00Z',
        runId: RUN_ID,
        type: 'claim',
        text: 'file anchored under module:cli',
        anchors: [{ kind: 'file', ref: 'src/cli/main.ts' }],
        provenance: 'test',
        status: 'active',
      });
      appendAnnotation(flowDir, {
        ts: '2026-07-09T02:00:01Z',
        runId: RUN_ID,
        type: 'claim',
        text: 'symbol scoped to a file under module:cli',
        anchors: [{ kind: 'symbol', ref: 'runCli', file: 'src/cli/main.ts' }],
        provenance: 'test',
        status: 'active',
      });

      const output = await runBlueprintAt(repoRoot, 'context', 'module:src/cli');

      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(output) as { annotations: Array<{ text: string }> };
      expect(parsed.annotations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'file anchored under module:cli' }),
          expect.objectContaining({ text: 'symbol scoped to a file under module:cli' }),
        ]),
      );
    });

    it('should resolve a case-insensitive substring match, noting other matches', async () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const unique = await runBlueprintAt(repoRoot, 'context', 'API.STRIPE');
      expect((JSON.parse(unique) as { node: { id: string } }).node.id).toBe('integration:api.stripe.com');

      const ambiguous = await runBlueprintAt(repoRoot, 'context', 'module:');
      const parsed = JSON.parse(ambiguous) as { node: { id: string }; note?: string };
      // First match in stable node order — the spine-root node sorts first
      expect(parsed.node.id).toBe('module:src');
      expect(parsed.note).toContain('module:src/api');
      expect(parsed.note).toContain('module:src/api/handlers');
      expect(parsed.note).toContain('module:src/cli');
      expect(parsed.note).toContain('module:src/lib');
    });

    it('should cap graphifyIds in the context node view with an explicit overflow count', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      // Simulate graphify enrichment: a symbol-dense node with many anchor ids
      const graphPath = join(flowDir, 'brain', '.structure', 'graph.json');
      const graph = JSON.parse(readFileSync(graphPath, 'utf-8')) as BlueprintGraph;
      const target = graph.nodes.find((node) => node.id === 'module:src/api');
      if (target === undefined) {
        throw new Error('fixture node missing');
      }
      target.meta = {
        ...target.meta,
        graphifyIds: Array.from({ length: 100 }, (_, index) => `src/api/server.ts::sym-${String(index).padStart(3, '0')}`),
      };
      writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf-8');

      const output = await runBlueprintAt(repoRoot, 'context', 'module:src/api');

      expect(process.exitCode).toBe(0);
      const [jsonPart] = output.split('\n… and ');
      const parsed = JSON.parse(jsonPart) as {
        node: { meta?: { graphifyIds?: string[]; graphifyIdsMore?: number } };
        annotations?: Array<{ text: string }>;
      };
      // Display cap with explicit overflow — never a silent cut
      expect(parsed.node.meta?.graphifyIds).toHaveLength(8);
      expect(parsed.node.meta?.graphifyIdsMore).toBe(92);
      // The capped node leaves room for the annotations section
      expect(parsed.annotations).toEqual([expect.objectContaining({ text: 'Use append-only store: jsonl' })]);
    });

    it('should enforce the char cap by dropping items (edges before annotations) with the mandatory hint', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      for (let index = 0; index < 30; index += 1) {
        appendAnnotation(flowDir, {
          ts: '2026-07-09T01:00:00Z',
          runId: RUN_ID,
          type: 'claim',
          text: `synthetic oversized annotation ${index} ${'x'.repeat(200)}`,
          anchors: [{ kind: 'module', ref: 'api' }],
          provenance: 'test',
          status: 'active',
        });
      }

      const output = await runBlueprintAt(repoRoot, 'context', 'module:src/api');

      expect(process.exitCode).toBe(0);
      // Hard cap: body + hint never exceed 4500 chars (output adds one newline)
      expect(output.length).toBeLessThanOrEqual(4501);
      expect(output).toContain('more — run `planflow-ai blueprint context <other-node>`');

      // The JSON part before the hint stays parseable; items are dropped from
      // the end of the priority order — ALL edges fall away before any
      // annotation, and as many annotations as fit are kept
      const [jsonPart] = output.split('\n… and ');
      const parsed = JSON.parse(jsonPart) as {
        node: { id: string };
        annotations?: Array<{ text: string }>;
        edges?: unknown;
      };
      expect(parsed.node.id).toBe('module:src/api');
      expect(parsed.edges).toBeUndefined();
      expect(Array.isArray(parsed.annotations)).toBe(true);
      expect(parsed.annotations?.length).toBeGreaterThan(0);
      expect(parsed.annotations?.length).toBeLessThan(31); // 30 synthetic + 1 promoted
    });

    it('should exit 1 with a one-liner when no graph has been derived', async () => {
      const output = await runBlueprintAt(repoRoot, 'context', 'module:src/api');

      expect(output).toBe('no blueprint — run `planflow-ai blueprint derive` first\n');
      expect(process.exitCode).toBe(1);
    });

    it('should exit 1 with a one-liner when no node matches', async () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const output = await runBlueprintAt(repoRoot, 'context', 'does-not-exist-anywhere');

      expect(output).toContain("no node matching 'does-not-exist-anywhere'");
      expect(process.exitCode).toBe(1);
    });

    it('should exit 1 with usage when the target is missing', async () => {
      const output = await runBlueprintAt(repoRoot, 'context', undefined);

      expect(output).toBe('Usage: planflow-ai blueprint context <node>\n');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── observe ──────────────────────────────────────────────

  // ── notes (the supersede query) ──────────────────────────

  describe('blueprint notes', () => {
    // Why this verb exists: `observe` refuses a plain write onto an anchor that
    // already carries an active note, and the app resolved the required
    // fingerprint by scanning a snapshot projection capped at 100. orbit-app
    // has 362 active notes and the blocking one sat at index 356, so nothing
    // resolved and every re-learn failed. The store answers it here instead.

    it('reports no active note on a clean anchor, and does not treat that as an error', async () => {
      const result = await runActionAt(repoRoot, 'notes', { anchor: 'module:src/api' });

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toBe("notes: no active note on 'src/api'\n");
      expect(result.stderr).toBe('');
    });

    it('returns the active note with the fingerprint observe demands', async () => {
      deriveBlueprint(repoRoot, RUN_ID); // a note needs its anchor to resolve
      await runObserveAt(repoRoot, { note: 'first note', anchor: ['module:src/api'] });

      const json = await runActionAt(repoRoot, 'notes', { anchor: 'module:src/api', json: true });
      const payload = JSON.parse(json.stdout) as {
        anchor: string;
        notes: Array<{ fingerprint: string; text: string; anchorRefs: string[] }>;
      };

      expect(process.exitCode).toBe(0);
      expect(payload.anchor).toBe('module:src/api');
      expect(payload.notes).toHaveLength(1);
      expect(payload.notes[0].text).toBe('first note');
      expect(payload.notes[0].anchorRefs).toEqual(['src/api']);
      // The fingerprint must be the one observe compares against — proven by
      // feeding it straight back as a supersede pointer below.
      expect(payload.notes[0].fingerprint).toContain('first note');
    });

    it('returns a fingerprint observe ACCEPTS as a supersede pointer (the whole point)', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      await runObserveAt(repoRoot, { note: 'original', anchor: ['module:src/api'] });
      const json = await runActionAt(repoRoot, 'notes', { anchor: 'module:src/api', json: true });
      const { fingerprint } = (JSON.parse(json.stdout) as { notes: Array<{ fingerprint: string }> })
        .notes[0];

      const superseded = await runObserveAt(repoRoot, {
        note: 'replacement',
        anchor: ['module:src/api'],
        status: 'supersedes',
        supersedes: fingerprint,
        reason: 're-learned src/api',
      });

      expect(process.exitCode).toBe(0);
      expect(superseded.stderr).toBe('');
      // And the anchor now carries exactly one active note again — the new one.
      const after = await runActionAt(repoRoot, 'notes', { anchor: 'module:src/api', json: true });
      const payload = JSON.parse(after.stdout) as { notes: Array<{ text: string }> };
      expect(payload.notes).toHaveLength(1);
      expect(payload.notes[0].text).toContain('replacement');
    });

    it('finds a note regardless of how many others exist — no display cap in the path', async () => {
      // Seeded directly: the claim under test is that the verb reads the WHOLE
      // store. orbit-app's blocking note sat at index 356 behind a cap of
      // 100, so a needle placed past any plausible cap is exactly the case.
      const structureDir = join(flowDir, 'brain', '.structure');
      mkdirSync(structureDir, { recursive: true });
      const lines: string[] = [];
      for (let index = 0; index < 200; index += 1) {
        lines.push(
          JSON.stringify({
            kind: 'note',
            ts: `2026-08-03T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
            anchors: [{ kind: 'module', ref: `src/f${index}` }],
            text: `filler ${index}`,
            provenance: 'seed',
            status: 'observed',
          }),
        );
      }
      lines.push(
        JSON.stringify({
          kind: 'note',
          ts: '2026-08-03T01:00:00.000Z',
          anchors: [{ kind: 'module', ref: 'src/needle' }],
          text: 'the needle',
          provenance: 'seed',
          status: 'observed',
        }),
      );
      writeFileSync(join(structureDir, 'investigations.jsonl'), `${lines.join('\n')}\n`, 'utf-8');

      const json = await runActionAt(repoRoot, 'notes', { anchor: 'module:src/needle', json: true });
      const payload = JSON.parse(json.stdout) as { notes: Array<{ text: string }> };

      expect(process.exitCode).toBe(0);
      expect(payload.notes).toHaveLength(1);
      expect(payload.notes[0].text).toBe('the needle');
    });

    it('refuses without exactly one anchor, writing nothing', async () => {
      const missing = await runActionAt(repoRoot, 'notes', {});
      expect(process.exitCode).toBe(1);
      expect(missing.stderr).toBe('notes refused: exactly one --anchor <kind:ref> is required\n');
    });

    it('refuses an anchor that is not <kind:ref>', async () => {
      const bad = await runActionAt(repoRoot, 'notes', { anchor: 'nope' });
      expect(process.exitCode).toBe(1);
      expect(bad.stderr).toContain("notes refused: invalid anchor 'nope'");
    });
  });

  // ── brief: what a document TOUCHES ───────────────────────

  describe('blueprint brief touches', () => {
    let flowFolder: string;
    let webRoot: string;
    let savedHome: string | undefined;

    function featureNode(slug: string, name: string, anchors: string[]) {
      return { id: `feature:${slug}`, slug, name, kind: 'core' as const, anchors, relates: [], lastFullRead: null, patchCount: 0, body: `# ${name}\n`, extra: {} };
    }

    beforeEach(() => {
      savedHome = process.env.PLAN_FLOW_HOME;
      flowFolder = mkdtempSync(join(tmpdir(), 'blueprint-brief-ws-'));
      webRoot = mkdtempSync(join(tmpdir(), 'blueprint-brief-web-'));
      process.env.PLAN_FLOW_HOME = flowFolder;
      const workspaceDir = join(flowFolder, 'workspaces', 'team');
      mkdirSync(join(workspaceDir, 'projects', 'app'), { recursive: true });
      writeFileSync(
        join(workspaceDir, 'workspace.json'),
        JSON.stringify({
          name: 'Team',
          slug: 'team',
          projects: [
            { id: 'local:app', name: 'app', slug: 'app', remotes: [] },
            { id: 'local:web', name: 'web', slug: 'web', remotes: [] },
          ],
        }),
      );
      writeFileSync(
        join(flowFolder, 'projects.local.json'),
        JSON.stringify({ projects: { 'local:app': repoRoot, 'local:web': webRoot } }),
      );
      writeFixture(webRoot, 'src/components/artifacts/Viewer.tsx', 'export const Viewer = 1;\n');
      writeFeature(join(workspaceDir, 'projects', 'web'), featureNode('artifacts', 'Artifacts', ['src/app/artifacts']));
      writeFeature(flowDir, featureNode('api', 'API', ['src/api']));
      writeParts(flowDir, 'api', [{ name: 'Handlers', summary: 'route handlers', anchors: ['src/api/handlers'], learnings: [] }]);
      deriveBlueprint(repoRoot, RUN_ID);
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env.PLAN_FLOW_HOME;
      else process.env.PLAN_FLOW_HOME = savedHome;
      rmSync(flowFolder, { recursive: true, force: true });
      rmSync(webRoot, { recursive: true, force: true });
    });

    const DOC = [
      '# Discovery: Refresh',
      '',
      'Make refresh honest.',
      '',
      '## Story',
      '',
      '### Step: The viewer',
      '- anchors: web/src/components/artifacts/Viewer.tsx, web/src/nowhere/Gone.tsx',
      '',
      '### Step: The API',
      '- anchors: src/api/handlers/users.ts',
      '',
    ].join('\n');

    function lastJson(stdout: string): Record<string, unknown> {
      return JSON.parse(stdout.trim().split('\n').pop() as string) as Record<string, unknown>;
    }

    it('a never-narrated doc reports the sibling feature (name-matched folder) and this project feature + part', async () => {
      writeFixture(repoRoot, 'flow/discovery/discovery_refresh_v1.md', DOC);
      const out = await runActionAt(repoRoot, 'brief', { plan: 'refresh', json: true });
      expect(process.exitCode ?? 0).toBe(0);
      const payload = lastJson(out.stdout);
      expect(payload.touches).toEqual([
        { project: null, root: realpathSync(repoRoot), featureId: 'feature:api', featureName: 'API', parts: [{ id: 'feature:api/handlers', name: 'Handlers' }], anchors: 1, specific: 1 },
        // Read from the Workspace's knowledge folder, the store namespaces the id.
        { project: 'web', root: webRoot, featureId: 'feature:web::artifacts', featureName: 'Artifacts', parts: [], anchors: 1, specific: 1 },
      ]);
      // Everything the brief always said is still there.
      expect(payload.mode).toBe('anatomy');
      expect((payload.identity as { name: string }).name).toBe('Discovery: Refresh');
    });

    it('a narrated doc stops counting a sibling file as unresolved, and only that one', async () => {
      writeFixture(repoRoot, 'flow/discovery/discovery_refresh_v1.md', DOC);
      await runActionAt(repoRoot, 'narrate', { from: 'flow/discovery/discovery_refresh_v1.md', draft: true });
      const out = await runActionAt(repoRoot, 'brief', {
        plan: 'refresh',
        path: 'flow/discovery/discovery_refresh_v1.md',
        json: true,
      });
      expect(process.exitCode ?? 0).toBe(0);
      const payload = lastJson(out.stdout);
      expect(payload.anchors).toEqual([
        { ref: 'file:web/src/components/artifacts/Viewer.tsx', resolved: true, project: 'web' },
        { ref: 'file:web/src/nowhere/Gone.tsx', resolved: false },
        { ref: 'file:src/api/handlers/users.ts', resolved: true },
      ]);
      expect((payload.touches as Array<{ featureName: string }>).map((touch) => touch.featureName)).toEqual(['API', 'Artifacts']);
    });
  });

  // ── features view (the generated feature picture) ───────

  describe('--feature resolves both id forms (review fix 1)', () => {
    function seedNamespaced(): void {
      mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
      writeFileSync(
        join(flowDir, 'brain', 'features', 'chats.md'),
        '---\nid: feature:backend::chats\nname: Chats\nkind: core\nanchors: []\nrelates: []\n---\n# Chats\n',
        'utf-8',
      );
    }

    for (const ref of ['feature:chats', 'backend/chats', 'feature:backend::chats', 'chats']) {
      it(`parts, view, relations, learned, heal, brief and feature-map find the note from '${ref}'`, async () => {
        seedNamespaced();
        const outputs = [
          await runActionAt(repoRoot, 'features', { feature: ref }, 'parts'),
          await runActionAt(repoRoot, 'features', { feature: ref }, 'view'),
          await runActionAt(repoRoot, 'features', { feature: ref }, 'relations'),
          await runActionAt(repoRoot, 'features', { feature: ref, entry: 'x' }, 'learned'),
          await runActionAt(repoRoot, 'features', { feature: ref }, 'heal'),
          await runActionAt(repoRoot, 'brief', { feature: ref }),
          await runActionAt(repoRoot, 'feature-map', { feature: ref }),
        ];
        for (const output of outputs) {
          expect(`${output.stdout}\n${output.stderr}`).not.toMatch(/no feature/);
        }
      });
    }

    it('an ordinary part id never resolves to a same-named feature', async () => {
      mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
      writeFileSync(join(flowDir, 'brain', 'features', 'sse.md'), '---\nid: feature:sse\nname: SSE\nkind: core\n---\n# SSE\n', 'utf-8');
      const result = await runActionAt(repoRoot, 'features', { feature: 'feature:chats/sse' }, 'parts');
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/no feature/);
    });
  });

  describe('blueprint features parts --write — learnedRole (feature-type-icons FR-4/FR-5)', () => {
    function seedFeature(): void {
      mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
      writeFileSync(
        join(flowDir, 'brain', 'features', 'chats.md'),
        '---\nid: feature:chats\nname: Chats\nkind: core\n---\n# Chats\n',
        'utf-8',
      );
    }

    it('writes the learnedRole a part carries', async () => {
      seedFeature();
      const write = JSON.stringify([{ name: 'SSE stream', summary: 's', anchors: ['src/sse.ts'], learnedRole: 'api' }]);
      const out = await runActionAt(repoRoot, 'features', { feature: 'chats', write }, 'parts');
      expect(`${out.stdout}\n${out.stderr}`).toContain('1 part(s) written');
      expect(readParts(flowDir, 'chats')[0]).toMatchObject({ name: 'SSE stream', learnedRole: 'api' });
    });

    it('refuses a learnedRole off the list and writes nothing', async () => {
      seedFeature();
      const write = JSON.stringify([{ name: 'SSE stream', summary: 's', anchors: ['src/sse.ts'], learnedRole: 'frontend' }]);
      const out = await runActionAt(repoRoot, 'features', { feature: 'chats', write }, 'parts');
      expect(`${out.stdout}\n${out.stderr}`).toContain("learnedRole 'frontend'");
      expect(readParts(flowDir, 'chats')).toEqual([]);
    });

    it('never reads a person-owned role from a machine write', async () => {
      seedFeature();
      const write = JSON.stringify([{ name: 'SSE stream', summary: 's', anchors: ['src/sse.ts'], role: 'ui' }]);
      await runActionAt(repoRoot, 'features', { feature: 'chats', write }, 'parts');
      expect(readParts(flowDir, 'chats')[0]?.role).toBeUndefined();
    });
  });

  describe('blueprint features view', () => {
    function seedFeature(): void {
      mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
      writeFileSync(
        join(flowDir, 'brain', 'features', 'chats.md'),
        '---\nid: feature:chats\nname: Chats\nkind: core\n---\n# Chats\n',
        'utf-8',
      );
    }
    const viewJson = (patch: string): string =>
      `{"provenance":"plan:x","generatedAt":"2026-08-04","meta":{"title":"Chat persistence"},"brief":{},"views":{"root":{"title":"Chat persistence","nodes":[{"id":"browser","kind":"project","title":"Browser · Chat UI","delta":"stable"}],"edges":[]${patch}}}}`;

    it('reports no view before one is generated', async () => {
      seedFeature();
      const result = await runActionAt(repoRoot, 'features', { feature: 'chats' }, 'view');
      expect(result.stdout).toContain('no generated view');
    });

    it('writes a valid view and reads it back', async () => {
      seedFeature();
      const written = await runActionAt(repoRoot, 'features', {
        feature: 'chats',
        write: viewJson(''),
      }, 'view');
      expect(process.exitCode).toBe(0);
      expect(written.stdout).toContain('view written');

      const read = await runActionAt(repoRoot, 'features', { feature: 'chats' }, 'view');
      expect(read.stdout).toContain('1 component(s)');
    });

    it('stamps the feature onto the STORED artifact, so a generator cannot mint an orphan (#1587)', async () => {
      seedFeature();
      // `viewJson` deliberately names no feature — that is what a generator
      // hands over, because the feature is already on the command line. The
      // CLI stamps it from the resolved feature, and the assertion that
      // matters is about the FILE: this repo's own store held an artifact with
      // no `feature` key, which every later `features graph` read back as
      // `0/1 valid · 1 orphaned` with nothing able to reach or repair it.
      await runActionAt(repoRoot, 'features', { feature: 'chats', write: viewJson('') }, 'view');
      expect(process.exitCode).toBe(0);

      const stored = JSON.parse(
        readFileSync(join(flowDir, 'brain', '.structure', 'feature-views', 'chats.json'), 'utf-8'),
      ) as { feature?: string };
      expect(stored.feature).toBe('chats');
    });

    it('refuses a connection from a component that is not there, writing nothing', async () => {
      seedFeature();
      const bad = await runActionAt(repoRoot, 'features', {
        feature: 'chats',
        write:
          '{"provenance":"p","generatedAt":"x","meta":{"title":"t"},"brief":{},"views":{"root":{"title":"t","nodes":[{"id":"a","kind":"module","title":"A","delta":"stable"}],"edges":[{"from":"ghost","to":"a","label":"x","delta":"kept"}]}}}',
      }, 'view');
      expect(process.exitCode).toBe(1);
      expect(`${bad.stdout}\n${bad.stderr}`).toContain('features refused:');
    });

    it('refuses without --feature', async () => {
      seedFeature();
      const bad = await runActionAt(repoRoot, 'features', { write: viewJson('') }, 'view');
      expect(process.exitCode).toBe(1);
      expect(`${bad.stdout}\n${bad.stderr}`).toContain('--feature');
    });
  });

  // ── features heal (re-anchor drifted excerpts on demand, #1435) ─────

  describe('blueprint features heal', () => {
    function seedFeature(): void {
      mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
      writeFileSync(
        join(flowDir, 'brain', 'features', 'chats.md'),
        '---\nid: feature:chats\nname: Chats\nkind: core\n---\n# Chats\n',
        'utf-8',
      );
    }

    /** Store an artifact citing `notes.ts:1-2`, and the file it cites. */
    function seedShiftedArtifact(): string {
      // The cited text sits at lines 3..4 now — a pure shift, healable.
      writeFileSync(join(repoRoot, 'notes.ts'), '// added\n// added\nconst tee = 1;\nconst z = 2;\n', 'utf-8');
      const viewsDir = join(flowDir, 'brain', '.structure', 'feature-views');
      mkdirSync(viewsDir, { recursive: true });
      const artifactPath = join(viewsDir, 'chats.json');
      writeFileSync(
        artifactPath,
        JSON.stringify({
          feature: 'chats',
          provenance: 'plan:x',
          generatedAt: '2026-08-04',
          meta: { title: 'Chat persistence' },
          brief: {},
          views: {
            root: {
              title: 'Chat persistence',
              nodes: [
                {
                  id: 'tee',
                  kind: 'function',
                  title: 'The tee',
                  delta: 'modify',
                  code: { file: 'notes.ts', from: 1, to: 2, note: 'why', text: 'const tee = 1;\nconst z = 2;' },
                },
              ],
              edges: [],
            },
          },
        }),
        'utf-8',
      );
      return artifactPath;
    }

    it("refuses an unknown ref: features refused: no feature '...'", async () => {
      seedFeature();
      const result = await runActionAt(repoRoot, 'features', { feature: 'nope' }, 'heal');
      expect(process.exitCode).toBe(1);
      // The logger routes error() through console.log — assert on BOTH streams
      // combined (allowed-pattern #15), never stderr alone.
      expect(`${result.stdout}\n${result.stderr}`).toContain("features refused: no feature 'nope'");
    });

    it('reports nothing to heal when no artifacts are stored — a report, not a refusal', async () => {
      seedFeature();
      const result = await runActionAt(repoRoot, 'features', {}, 'heal');
      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('heal: nothing to heal');
    });

    it('heals one feature by ref and phrases the counts', async () => {
      seedFeature();
      const artifactPath = seedShiftedArtifact();
      const result = await runActionAt(repoRoot, 'features', { feature: 'chats' }, 'heal');
      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('heal: Chats — healed 1 · gone 0');
      // And the address really moved — the verb phrases, healFeatureView acts.
      const healed = JSON.parse(readFileSync(artifactPath, 'utf-8')) as {
        views: { root: { nodes: Array<{ code?: { from: number; to: number } }> } };
      };
      expect(healed.views.root.nodes[0].code?.from).toBe(3);
      expect(healed.views.root.nodes[0].code?.to).toBe(4);
    });

    it('sweeps every stored artifact when no ref is given, with a summary line', async () => {
      seedFeature();
      seedShiftedArtifact();
      const result = await runActionAt(repoRoot, 'features', {}, 'heal');
      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('heal: chats — healed 1 · gone 0');
      expect(result.stdout).toContain('heal: 1 view(s) — healed 1 · gone 0');
    });
  });

  describe('blueprint features domains', () => {
    function writeFeatureFile(slug: string, extraFrontmatter: string, anchors: string[]): void {
      mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
      writeFileSync(
        join(flowDir, 'brain', 'features', `${slug}.md`),
        `---\nid: feature:${slug}\nname: ${slug}\nkind: core\n${extraFrontmatter}` +
          `anchors: [${anchors.join(', ')}]\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\n# ${slug}\n`,
        'utf-8',
      );
    }

    it('refuses cleanly when the graph is missing, writing nothing', async () => {
      writeFeatureFile('cli-tool', '', ['module:src/cli']);
      const result = await runActionAt(repoRoot, 'features', {}, 'domains');
      expect(process.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('features domains refused:');
      const raw = readFileSync(join(flowDir, 'brain', 'features', 'cli-tool.md'), 'utf-8');
      expect(raw).not.toContain('domain:');
    });

    // Feature files are written BEFORE `deriveBlueprint` in every test below:
    // derive auto-bootstraps features from surfaces on an EMPTY store
    // (first-run adoption), and writing our own fixture first means the store
    // is already non-empty when derive runs, so bootstrap skips and the
    // fixture's own feature count stays exact.

    it('seeds domain from the dominant module path of resolved anchors', async () => {
      writeFeatureFile('cli-tool', '', ['module:src/cli']);
      deriveBlueprint(repoRoot, RUN_ID);
      const result = await runActionAt(repoRoot, 'features', {}, 'domains');
      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('set domain on 1 of 1');
      const after = readFileSync(join(flowDir, 'brain', 'features', 'cli-tool.md'), 'utf-8');
      expect(after).toContain('domain: CLI');
    });

    it('never overwrites an existing domain, and reports the skip', async () => {
      writeFeatureFile('cli-tool', 'domain: Custom\n', ['module:src/cli']);
      deriveBlueprint(repoRoot, RUN_ID);
      const result = await runActionAt(repoRoot, 'features', {}, 'domains');
      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('set domain on 0 of 1');
      expect(result.stdout).toContain('1 already set');
      const after = readFileSync(join(flowDir, 'brain', 'features', 'cli-tool.md'), 'utf-8');
      expect(after).toContain('domain: Custom');
    });

    it('skips a feature with no resolvable module anchor, reporting why', async () => {
      writeFeatureFile('no-module', '', ['datastore:pg']);
      deriveBlueprint(repoRoot, RUN_ID);
      const result = await runActionAt(repoRoot, 'features', {}, 'domains');
      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('set domain on 0 of 1');
      expect(result.stdout).toContain('skipped (no resolvable module anchor)');
    });

    it('is idempotent — a second run sets nothing', async () => {
      writeFeatureFile('cli-tool', '', ['module:src/cli']);
      deriveBlueprint(repoRoot, RUN_ID);
      await runActionAt(repoRoot, 'features', {}, 'domains');
      const second = await runActionAt(repoRoot, 'features', {}, 'domains');
      expect(second.stdout).toContain('set domain on 0 of 1');
    });
  });

  describe('blueprint observe', () => {
    const HELPER_ANCHOR = 'file:src/lib/helper.ts';
    const HELPER_REF = 'src/lib/helper.ts';

    function sha256Of(root: string, relPath: string): string {
      return createHash('sha256').update(readFileSync(join(root, relPath))).digest('hex');
    }

    // ── heat-only mode ─────────────────────────────────────

    it('should append heat ticks per anchor and aggregate on read, without a graph', async () => {
      // No derive — heat is ALWAYS accepted, even before a graph exists
      const human = await runObserveAt(repoRoot, {
        anchor: [HELPER_ANCHOR, 'module:src/api'],
        visit: 'human',
      });
      expect(process.exitCode).toBe(0);
      expect(human.stdout).toBe('observed: heat +2 anchor(s)\n');
      expect(human.stderr).toBe('');

      // Default visitor is agent
      const agent = await runObserveAt(repoRoot, { anchor: [HELPER_ANCHOR] });
      expect(process.exitCode).toBe(0);
      expect(agent.stdout).toBe('observed: heat +1 anchor(s)\n');

      const { heat, notes } = readInvestigations(flowDir);
      expect(notes).toEqual([]);
      expect(heat).toEqual([
        expect.objectContaining({ anchorRef: 'src/api', humanVisits: 1, agentVisits: 0 }),
        expect.objectContaining({ anchorRef: HELPER_REF, humanVisits: 1, agentVisits: 1 }),
      ]);
    });

    it('should refuse heat-only observation without anchors or with an invalid visitor', async () => {
      const missing = await runObserveAt(repoRoot, {});
      expect(process.exitCode).toBe(1);
      expect(missing.stderr).toBe('observe refused: heat observation requires at least one --anchor <kind:ref>\n');

      const badVisitor = await runObserveAt(repoRoot, { anchor: [HELPER_ANCHOR], visit: 'robot' });
      expect(process.exitCode).toBe(1);
      expect(badVisitor.stderr).toBe("observe refused: invalid --visit 'robot' — expected agent|human\n");

      expect(existsSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'))).toBe(false);
    });

    // ── note mode: clean-anchor writes ─────────────────────

    it('should write an observed note with a hash stamp and heat tick on a clean anchor', async () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const result = await runObserveAt(repoRoot, {
        note: 'helper returns ok',
        anchor: [HELPER_ANCHOR],
        runId: RUN_ID,
      });

      expect(process.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      const fingerprint = investigationFingerprint({
        text: 'helper returns ok',
        anchors: [{ kind: 'file', ref: HELPER_REF }],
      });
      expect(result.stdout).toBe(`observed: note ${fingerprint} (observed) on 1 anchor(s)\n`);

      const { notes, heat } = readInvestigations(flowDir);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        text: 'helper returns ok',
        status: 'observed',
        runId: RUN_ID,
        provenance: 'blueprint observe',
        anchors: [{ kind: 'file', ref: HELPER_REF }],
        hashStamps: [{ ref: HELPER_REF, contentHash: sha256Of(repoRoot, HELPER_REF) }],
      });
      // Note writes also record one agent heat tick per anchor
      expect(heat).toEqual([
        expect.objectContaining({ anchorRef: HELPER_REF, humanVisits: 0, agentVisits: 1 }),
      ]);
    });

    // ── note mode: validation refusals ─────────────────────

    it('should refuse a malformed anchor before touching the store', async () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const result = await runObserveAt(repoRoot, { note: 'x', anchor: ['bogus:thing'] });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "observe refused: invalid anchor 'bogus:thing' — expected <kind>:<ref> with kind in symbol|file|table|endpoint|module\n",
      );
      expect(existsSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'))).toBe(false);
    });

    it('should refuse an unresolvable anchor with a derive suggestion and write nothing', async () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const result = await runObserveAt(repoRoot, {
        note: 'claim about a ghost module',
        anchor: ['file:nope/missing.ts'],
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "observe refused: anchor 'file:nope/missing.ts' does not resolve against the blueprint graph — run `planflow-ai blueprint derive`\n",
      );
      expect(existsSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'))).toBe(false);
    });

    it('context project:<name> emits the consumed contract slice (federation)', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      const structureDir = join(repoRoot, 'flow', 'brain', '.structure');
      writeFileSync(
        join(structureDir, 'cross-links.jsonl'),
        [
          JSON.stringify({ ts: 't', status: 'confirmed', provider: 'orbit-core', endpoint: 'GET /api/v1/x', confidence: 'high', files: ['src/a.ts'], surfaceDerivedAt: 'v' }),
          JSON.stringify({ ts: 't', status: 'proposed', provider: 'orbit-core', endpoint: 'query GetTenants', confidence: 'medium', files: [], surfaceDerivedAt: 'v' }),
        ].join('\n') + '\n',
      );
      const result = await runActionAt(repoRoot, 'context', {} as BlueprintCommandOptions & { target?: string });
      void result;
      const direct = await (async () => {
        const originalCwd = process.cwd();
        const chunks: string[] = [];
        const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
          chunks.push(String(chunk));
          return true;
        });
        process.chdir(repoRoot);
        try {
          await runBlueprint('context', 'project:orbit-core', {});
        } finally {
          spy.mockRestore();
          process.chdir(originalCwd);
        }
        return chunks.join('');
      })();
      expect(direct).toContain('# Consumed surface: orbit-core');
      expect(direct).toContain('GET /api/v1/x — called from src/a.ts');
      expect(direct).toContain('Proposed (unconfirmed — treat as hints, not facts): 1');
    });

    it('--lenient-anchors drops unresolvable extras loudly and writes the note (2026-07-24)', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      const result = await runObserveAt(repoRoot, {
        note: 'learned the module',
        anchor: ['module:src', 'symbol:LoginForm'],
        lenientAnchors: true,
      });
      expect(result.stdout).toContain('dropped 1 unresolvable anchor(s): symbol:LoginForm');
      expect(result.stdout).toContain('observed: note');
      const store = readFileSync(join(repoRoot, 'flow/brain/.structure/investigations.jsonl'), 'utf-8');
      expect(store).toContain('learned the module');
      expect(store).not.toContain('LoginForm');
    });

    it('--lenient-anchors drops an anchor whose file cannot be hash-stamped (dir/deleted)', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      // 'src' resolves (module rollup) but is a DIRECTORY — unstampable.
      const result = await runObserveAt(repoRoot, {
        note: 'learned with a dir anchor',
        anchor: ['module:src', 'file:src'],
        lenientAnchors: true,
      });
      expect(result.stdout).toContain('dropped 1 unstampable anchor(s): file:src');
      expect(result.stdout).toContain('observed: note');
      const store = readFileSync(join(repoRoot, 'flow/brain/.structure/investigations.jsonl'), 'utf-8');
      expect(store).toContain('learned with a dir anchor');
    });

    it('--lenient-anchors still refuses when NO anchor resolves', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      await runObserveAt(repoRoot, {
        note: 'nope',
        anchor: ['symbol:Ghost'],
        lenientAnchors: true,
      }).then((result) => {
        expect(process.exitCode).toBe(1);
        expect(result.stderr).toContain("identity anchor 'symbol:Ghost' does not resolve");
      });
    });

    it('--lenient-anchors refuses when the IDENTITY anchor is unresolvable, extras or not', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      // An orphan note (identity dropped, decoration kept) can never be found
      // to supersede — the module would be unlearnable forever (2026-07-30).
      const result = await runObserveAt(repoRoot, {
        note: 'learned an endpoint',
        anchor: ['module:endpoint:GET /api/x', HELPER_ANCHOR],
        lenientAnchors: true,
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "identity anchor 'module:endpoint:GET /api/x' does not resolve",
      );
      expect(existsSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'))).toBe(false);
    });

    it('should refuse before any anchor check when no graph has been derived', async () => {
      const result = await runObserveAt(repoRoot, { note: 'x', anchor: [HELPER_ANCHOR] });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe(
        'observe refused: no blueprint graph — run `planflow-ai blueprint derive` first\n',
      );
    });

    it('should refuse when a file-kind anchor resolves but the file is missing on disk', async () => {
      deriveBlueprint(repoRoot, RUN_ID);

      // Resolves via module:src/lib directory containment, yet absent on disk
      const result = await runObserveAt(repoRoot, {
        note: 'note on a vanished file',
        anchor: ['file:src/lib/ghost.ts'],
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "observe refused: file 'src/lib/ghost.ts' is missing — cannot hash-stamp anchor 'src/lib/ghost.ts'\n",
      );
      expect(existsSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'))).toBe(false);
    });

    // ── contradiction rule (BOUND DECISION: strict refuse) ─

    it('should refuse a second note on an anchor carrying an active note, listing fingerprints', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      await runObserveAt(repoRoot, { note: 'helper returns ok', anchor: [HELPER_ANCHOR] });

      const result = await runObserveAt(repoRoot, {
        note: 'helper actually returns nope',
        anchor: [HELPER_ANCHOR],
      });

      expect(process.exitCode).toBe(1);
      const firstFingerprint = investigationFingerprint({
        text: 'helper returns ok',
        anchors: [{ kind: 'file', ref: HELPER_REF }],
      });
      expect(result.stderr).toBe(
        `observe refused: anchor '${HELPER_REF}' already carries 1 active note(s) — pass --status corroborates, or --supersedes <fingerprint> --reason "<why>" (existing fingerprints: ${firstFingerprint})\n`,
      );
      // Nothing written by the refused attempt
      expect(readInvestigations(flowDir).notes).toHaveLength(1);
    });

    it('--conflict-scope primary lets a note through when only a DECORATIVE anchor overlaps', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      // A parent module's learn note anchors a file that also belongs to a
      // child module — under the default scope the child's FIRST learn was
      // refused as a contradiction (live orbit-app failure 2026-07-30).
      await runObserveAt(repoRoot, {
        note: 'parent module',
        anchor: ['module:src', HELPER_ANCHOR],
        lenientAnchors: true,
      });

      const result = await runObserveAt(repoRoot, {
        note: 'child module',
        anchor: ['module:src/lib', HELPER_ANCHOR],
        lenientAnchors: true,
        conflictScope: 'primary',
      });

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('(observed)');
      expect(readInvestigations(flowDir).notes).toHaveLength(2);
    });

    it('--conflict-scope primary still refuses a second note on the SAME identity anchor', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      await runObserveAt(repoRoot, {
        note: 'module as first learned',
        anchor: ['module:src/lib'],
        conflictScope: 'primary',
      });

      const result = await runObserveAt(repoRoot, {
        note: 'module re-learned',
        anchor: ['module:src/lib'],
        conflictScope: 'primary',
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toContain("already carries 1 active note(s)");
      expect(readInvestigations(flowDir).notes).toHaveLength(1);
    });

    it('should refuse an invalid --conflict-scope and write nothing', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      const result = await runObserveAt(repoRoot, {
        note: 'x',
        anchor: [HELPER_ANCHOR],
        conflictScope: 'sideways',
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "observe refused: invalid --conflict-scope 'sideways' — expected any|primary\n",
      );
      expect(existsSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'))).toBe(false);
    });

    it('should accept a supersede of an ACTIVE note that shares no anchor with the entry', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      // Healing path for pre-fix orphan notes: the fresh note is anchored to
      // the module identity the orphan never carried, so the two share no ref.
      await runObserveAt(repoRoot, { note: 'orphan note', anchor: [HELPER_ANCHOR] });
      const orphanFingerprint = investigationFingerprint({
        text: 'orphan note',
        anchors: [{ kind: 'file', ref: HELPER_REF }],
      });
      await runObserveAt(repoRoot, { note: 'unrelated note', anchor: ['module:src/lib'] });

      const result = await runObserveAt(repoRoot, {
        note: 'module re-learned properly',
        anchor: ['module:src/lib'],
        supersedes: orphanFingerprint,
        reason: 're-learned src/lib',
      });

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('(observed)');
      const active = readInvestigations(flowDir).notes;
      expect(active.map((note) => note.text)).not.toContain('orphan note');
    });

    it('should accept a corroborating note as status corroborated with no supersedes', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      await runObserveAt(repoRoot, { note: 'helper returns ok', anchor: [HELPER_ANCHOR] });

      const result = await runObserveAt(repoRoot, {
        note: 'confirmed: helper returns ok on re-read',
        anchor: [HELPER_ANCHOR],
        status: 'corroborates',
      });

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('(corroborated) on 1 anchor(s)');
      const { notes } = readInvestigations(flowDir);
      expect(notes).toHaveLength(2);
      const corroborating = notes.find((note) => note.status === 'corroborated') as InvestigationEntry;
      expect(corroborating.text).toBe('confirmed: helper returns ok on re-read');
      expect(corroborating.supersedes).toBeUndefined();
    });

    it('should accept supersedes+reason and fold-on-read to only the superseding note', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      await runObserveAt(repoRoot, { note: 'helper returns ok', anchor: [HELPER_ANCHOR] });
      const firstFingerprint = investigationFingerprint({
        text: 'helper returns ok',
        anchors: [{ kind: 'file', ref: HELPER_REF }],
      });

      const result = await runObserveAt(repoRoot, {
        note: 'helper now returns a status object',
        anchor: [HELPER_ANCHOR],
        supersedes: firstFingerprint,
        reason: 'return type changed',
      });

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('(observed) on 1 anchor(s)');
      const { notes } = readInvestigations(flowDir);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        text: 'helper now returns a status object [supersedes: return type changed]',
        status: 'observed',
        supersedes: firstFingerprint,
      });
    });

    it('should refuse --supersedes without --reason and write nothing', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      await runObserveAt(repoRoot, { note: 'helper returns ok', anchor: [HELPER_ANCHOR] });
      const firstFingerprint = investigationFingerprint({
        text: 'helper returns ok',
        anchors: [{ kind: 'file', ref: HELPER_REF }],
      });

      const result = await runObserveAt(repoRoot, {
        note: 'helper now returns a status object',
        anchor: [HELPER_ANCHOR],
        supersedes: firstFingerprint,
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe('observe refused: --supersedes requires --reason "<why>"\n');
      expect(readInvestigations(flowDir).notes).toHaveLength(1);
    });

    it('should refuse a supersede that closes a self-cycle (write-time cycle refusal)', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      // Seed a note whose text already carries the supersede-suffix shape, so
      // a later supersede write can re-mint the exact same fingerprint.
      await runObserveAt(repoRoot, { note: 'helper returns ok [supersedes: restore]', anchor: [HELPER_ANCHOR] });
      const seededFingerprint = investigationFingerprint({
        text: 'helper returns ok [supersedes: restore]',
        anchors: [{ kind: 'file', ref: HELPER_REF }],
      });

      const result = await runObserveAt(repoRoot, {
        note: 'helper returns ok',
        anchor: [HELPER_ANCHOR],
        supersedes: seededFingerprint,
        reason: 'restore',
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toContain('would create a supersede cycle');
      expect(readInvestigations(flowDir).notes).toHaveLength(1);
    });

    it('should refuse a supersede that closes a 2-cycle through the chain (restore-previous-note flow)', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      await runObserveAt(repoRoot, { note: 'v1 [supersedes: restore]', anchor: [HELPER_ANCHOR] });
      const originalFingerprint = investigationFingerprint({
        text: 'v1 [supersedes: restore]',
        anchors: [{ kind: 'file', ref: HELPER_REF }],
      });
      await runObserveAt(repoRoot, {
        note: 'v2',
        anchor: [HELPER_ANCHOR],
        supersedes: originalFingerprint,
        reason: 'r',
      });
      const correctionFingerprint = investigationFingerprint({
        text: 'v2 [supersedes: r]',
        anchors: [{ kind: 'file', ref: HELPER_REF }],
      });

      // Restoring v1 while superseding v2 would close v1 → v2 → v1.
      const result = await runObserveAt(repoRoot, {
        note: 'v1',
        anchor: [HELPER_ANCHOR],
        supersedes: correctionFingerprint,
        reason: 'restore',
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toContain('would create a supersede cycle');
      // The fold still shows the correction — nothing was written
      expect(readInvestigations(flowDir).notes.map((note) => note.text)).toEqual(['v2 [supersedes: r]']);
    });

    it('should refuse with the busy notice when the investigation store is locked (C2)', async () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(join(flowDir, 'brain', '.structure', 'investigations.lock'), '', 'utf-8');

      const result = await runObserveAt(repoRoot, { anchor: [HELPER_ANCHOR] });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe('observe refused: investigation store busy — retry\n');
      expect(existsSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'))).toBe(false);
    });

    it('should refuse a supersede pointer that matches none of the conflicting notes', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      await runObserveAt(repoRoot, { note: 'helper returns ok', anchor: [HELPER_ANCHOR] });

      const result = await runObserveAt(repoRoot, {
        note: 'helper now returns a status object',
        anchor: [HELPER_ANCHOR],
        supersedes: 'no-such-fingerprint',
        reason: 'stale',
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "observe refused: --supersedes 'no-such-fingerprint' does not match any active note on these anchors",
      );
      expect(readInvestigations(flowDir).notes).toHaveLength(1);
    });

    it('should refuse hash-stamping a symbol anchor whose file field escapes the repo root (W1)', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      // Plant a symbol on a graph node so the anchor resolves BY SYMBOL NAME
      // alone — the `file` field is then attacker-controlled and unvalidated
      const graphPath = join(flowDir, 'brain', '.structure', 'graph.json');
      const graph = JSON.parse(readFileSync(graphPath, 'utf-8')) as BlueprintGraph;
      const target = graph.nodes.find((node) => node.id === 'module:src/lib');
      if (target === undefined) {
        throw new Error('fixture node missing');
      }
      target.symbol = 'plantedSymbol';
      writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf-8');
      // A real file OUTSIDE the repo root — pre-fix, observe would read and
      // hash it (hash-oracle exposure)
      const outsidePath = join(repoRoot, '..', `outside-${basename(repoRoot)}.txt`);
      writeFileSync(outsidePath, 'secret outside the repo', 'utf-8');

      try {
        const result = await runObserveAt(repoRoot, {
          json: JSON.stringify({
            text: 'traversal attempt',
            anchors: [{ kind: 'symbol', ref: 'plantedSymbol', file: `../${basename(outsidePath)}` }],
          }),
        });

        expect(process.exitCode).toBe(1);
        expect(result.stderr).toContain('escapes the repository root — refusing to hash-stamp');
        expect(existsSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'))).toBe(false);
      } finally {
        rmSync(outsidePath, { force: true });
      }
    });

    // ── --json path (same pipeline, no bypass) ─────────────

    it('should accept a --json entry equivalently to flags', async () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const result = await runObserveAt(repoRoot, {
        json: JSON.stringify({
          text: 'cli main wires commander',
          anchors: [{ kind: 'file', ref: 'src/cli/main.ts' }],
          runId: RUN_ID,
          ambiguous: true,
        }),
      });

      expect(process.exitCode).toBe(0);
      const fingerprint = investigationFingerprint({
        text: 'cli main wires commander',
        anchors: [{ kind: 'file', ref: 'src/cli/main.ts' }],
      });
      expect(result.stdout).toBe(`observed: note ${fingerprint} (observed) on 1 anchor(s)\n`);
      const { notes } = readInvestigations(flowDir);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        text: 'cli main wires commander',
        status: 'observed',
        runId: RUN_ID,
        ambiguous: true,
        hashStamps: [{ ref: 'src/cli/main.ts', contentHash: sha256Of(repoRoot, 'src/cli/main.ts') }],
      });
    });

    it('should run --json entries through the same validation pipeline (no bypass)', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      await runObserveAt(repoRoot, { note: 'helper returns ok', anchor: [HELPER_ANCHOR] });

      // Same contradiction refusal as the flag path
      const conflicted = await runObserveAt(repoRoot, {
        json: JSON.stringify({
          text: 'helper actually returns nope',
          anchors: [{ kind: 'file', ref: HELPER_REF }],
        }),
      });
      expect(process.exitCode).toBe(1);
      expect(conflicted.stderr).toContain(`anchor '${HELPER_REF}' already carries 1 active note(s)`);

      // Same anchor-resolution refusal as the flag path
      const unresolvable = await runObserveAt(repoRoot, {
        json: JSON.stringify({
          text: 'ghost claim',
          anchors: [{ kind: 'file', ref: 'nope/missing.ts' }],
        }),
      });
      expect(process.exitCode).toBe(1);
      expect(unresolvable.stderr).toContain("anchor 'file:nope/missing.ts' does not resolve");

      expect(readInvestigations(flowDir).notes).toHaveLength(1);
    });

    // ── context surfacing ──────────────────────────────────

    it('should surface the investigation section in context with the note cap and heat', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      for (let index = 0; index < 7; index += 1) {
        appendInvestigationNote(flowDir, {
          ts: `2026-07-09T00:00:0${index}Z`,
          runId: RUN_ID,
          anchors: [{ kind: 'file', ref: HELPER_REF }],
          text: `investigation note ${index}`,
          provenance: 'test',
          status: 'observed',
          hashStamps: [],
        });
      }
      appendHeatTick(flowDir, { ts: '2026-07-09T01:00:00Z', anchorRef: HELPER_REF, visitor: 'human' });
      appendHeatTick(flowDir, { ts: '2026-07-09T01:00:01Z', anchorRef: HELPER_REF, visitor: 'agent' });

      const output = await runBlueprintAt(repoRoot, 'context', 'module:src/lib');

      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(output) as {
        investigation: {
          notes: Array<{ text: string }>;
          notesMore?: number;
          heat: HeatCounter[];
        };
      };
      // Capped at the 5 MOST RECENT notes with an explicit overflow count
      expect(parsed.investigation.notes.map((note) => note.text)).toEqual([
        'investigation note 2',
        'investigation note 3',
        'investigation note 4',
        'investigation note 5',
        'investigation note 6',
      ]);
      expect(parsed.investigation.notesMore).toBe(2);
      expect(parsed.investigation.heat).toEqual([
        { anchorRef: HELPER_REF, humanVisits: 1, agentVisits: 1, lastVisited: '2026-07-09T01:00:01Z' },
      ]);
    });

    it('should omit the investigation section when the node has no notes or heat', async () => {
      deriveBlueprint(repoRoot, RUN_ID);

      const output = await runBlueprintAt(repoRoot, 'context', 'module:src/lib');

      expect(process.exitCode).toBe(0);
      expect(JSON.parse(output)).not.toHaveProperty('investigation');
    });
  });

  // ── render ───────────────────────────────────────────────

  describe('blueprint render', () => {
    it('should render without throwing when the annotations file has corrupt anchors', async () => {
      deriveBlueprint(repoRoot, RUN_ID);
      // Corrupt anchor shapes that previously reached the template unguarded:
      // non-object elements and objects missing/invalid `ref`
      writeFileSync(
        join(flowDir, 'brain', '.structure', 'annotations.jsonl'),
        [
          JSON.stringify({
            type: 'claim',
            text: 'entry with corrupt anchors',
            // The surviving anchor must reference a depth-1 module — the
            // title sheet renders claims only for VISIBLE (depth-1) nodes,
            // and under root-as-depth-1 semantics that is `module:src`
            anchors: [null, 42, { kind: 'module' }, { kind: 'bogus', ref: 'x' }, { kind: 'module', ref: 'src' }],
          }),
          'not json at all',
          JSON.stringify({ type: 'decision', text: 'fully corrupt anchors', anchors: [{ ref: null }] }),
        ].join('\n') + '\n',
        'utf-8',
      );

      const output = await runBlueprintAt(repoRoot, 'render');

      expect(process.exitCode).toBe(0);
      expect(output).toContain('blueprint.html');
      const html = readFileSync(join(flowDir, 'brain', '.structure', 'blueprint.html'), 'utf-8');
      // The surviving valid anchor renders; malformed siblings were dropped
      expect(html).toContain('entry with corrupt anchors');
    });

    it('should exit 1 with a one-liner when no graph has been derived', async () => {
      const output = await runBlueprintAt(repoRoot, 'render');

      expect(output).toBe('no blueprint — run `planflow-ai blueprint derive` first\n');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── propose ──────────────────────────────────────────────

  describe('blueprint propose', () => {
    const proposalsPath = (): string => join(flowDir, 'brain', '.structure', 'proposals.jsonl');

    /** Record one valid proposal (defaults target a node the fixture will NOT derive). */
    async function propose(
      overrides: Partial<BlueprintCommandOptions> = {},
    ): Promise<{ stdout: string; stderr: string }> {
      return runActionAt(repoRoot, 'propose', {
        plan: 'plan_p',
        node: 'integration:sentry',
        kind: 'integration',
        label: 'Sentry SDK',
        ...overrides,
      });
    }

    // ── record mode: silent-record semantics ───────────────

    it('should silently record a proposal with no graph and no board (terminal fallback)', async () => {
      // No derive has run — silent record must not require or create a graph.
      const result = await propose({ detail: 'error tracking', phase: '3', anchor: ['file:src/api/server.ts'] });

      expect(process.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      // The accounting line follows EVERY successful write — a caller reads
      // back the plan's resulting store state instead of inferring it.
      expect(result.stdout).toBe('proposal recorded: integration:sentry (plan_p)\nproposals: 1 recorded\n');
      expect(existsSync(join(flowDir, 'brain', '.structure', 'graph.json'))).toBe(false);

      const [proposal] = readEffectiveProposals(flowDir);
      expect(proposal).toMatchObject({
        fingerprint: 'plan_p+integration:sentry',
        state: 'proposed',
        kind: 'integration',
        label: 'Sentry SDK',
        detail: 'error tracking',
        phase: 3,
        anchors: [{ kind: 'file', ref: 'src/api/server.ts' }],
        provenance: 'cli:propose',
      });
    });

    // ── record mode: refusal paths (one line, nothing written) ──

    it.each([
      [{ plan: '' }, 'propose refused: a proposal requires --plan <plan>\n'],
      [{ node: '' }, 'propose refused: a proposal requires --node <predicted-id>\n'],
      [{ kind: undefined }, "propose refused: invalid --kind '' — expected integration|endpoint|datastore|module|part\n"],
      [{ kind: 'bogus' }, "propose refused: invalid --kind 'bogus' — expected integration|endpoint|datastore|module|part\n"],
      [{ label: '' }, 'propose refused: a proposal requires --label <text>\n'],
      [{ phase: 'three' }, "propose refused: invalid --phase 'three' — expected a positive integer\n"],
      [
        { anchor: ['bogus:thing'] },
        "propose refused: invalid anchor 'bogus:thing' — expected <kind>:<ref> with kind in symbol|file|table|endpoint|module\n",
      ],
    ] as Array<[Partial<BlueprintCommandOptions>, string]>)(
      'should refuse %j with the exact one-liner and write nothing',
      async (overrides, expectedStderr) => {
        const result = await propose(overrides);

        expect(process.exitCode).toBe(1);
        expect(result.stderr).toBe(expectedStderr);
        expect(result.stdout).toBe('');
        expect(existsSync(proposalsPath())).toBe(false);
      },
    );

    it.each([
      ['integration', 'integration:has space'],
      ['integration', 'integration:webhook:no-leading-slash'],
      ['endpoint', 'endpoint:get /users'],
      ['endpoint', 'endpoint:cli two words'],
      ['datastore', 'datastore:has space'],
      ['module', 'module:/absolute/path'],
      ['module', 'integration:sentry'], // kind/prefix disagreement
    ])('should refuse a %s proposal whose id breaks the grammar (%s)', async (kind, node) => {
      const result = await propose({ kind, node });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `propose refused: predicted id '${node}' does not match the ${kind} id grammar — expected ${
          kind === 'integration'
            ? 'integration:<name> or integration:webhook:</path>'
            : kind === 'endpoint'
              ? 'endpoint:<METHOD> </path> or endpoint:cli <command>'
              : kind === 'datastore'
                ? 'datastore:<name>'
                : 'module:<repo-relative-dir>'
        } (e.g. ${
          ({
            integration: 'integration:stripe',
            endpoint: 'endpoint:POST /api/apps/rebuild',
            datastore: 'datastore:postgres',
            module: 'module:src/scheduler',
          } as Record<string, string>)[kind]
        })\n`,
      );
      expect(existsSync(proposalsPath())).toBe(false);
    });

    it('should refuse the append with the busy notice while the proposal store is locked', async () => {
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(join(flowDir, 'brain', '.structure', 'proposals.lock'), '', 'utf-8');

      const result = await propose();

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe('propose refused: proposal store busy — retry\n');
      expect(existsSync(proposalsPath())).toBe(false);
    });

    // ── decide mode ────────────────────────────────────────

    it('should append a decision against an existing proposal and fold to the decided state', async () => {
      await propose();

      const result = await runActionAt(repoRoot, 'propose', {
        decide: 'accepted',
        plan: 'plan_p',
        node: 'integration:sentry',
      });

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toBe('proposal integration:sentry: accepted\nproposals: 1 recorded\n');
      const [proposal] = readEffectiveProposals(flowDir, 'plan_p');
      expect(proposal.state).toBe('accepted');
      expect(proposal.decidedAt).toBeDefined();
      // The decision line re-carries the payload (self-describing store lines).
      const lastLine = readFileSync(proposalsPath(), 'utf-8').trim().split('\n').pop() as string;
      expect(JSON.parse(lastLine)).toMatchObject({
        event: 'accepted',
        label: 'Sentry SDK',
        provenance: 'cli:propose',
      });
    });

    it('should refuse deciding a proposal that was never recorded', async () => {
      const result = await runActionAt(repoRoot, 'propose', {
        decide: 'rejected',
        plan: 'plan_p',
        node: 'integration:sentry',
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe("propose refused: no proposal 'integration:sentry' recorded for plan 'plan_p'\n");
      expect(existsSync(proposalsPath())).toBe(false);
    });

    it('should refuse a second decision on an already-decided proposal', async () => {
      await propose();
      await runActionAt(repoRoot, 'propose', { decide: 'accepted', plan: 'plan_p', node: 'integration:sentry' });

      const result = await runActionAt(repoRoot, 'propose', {
        decide: 'rejected',
        plan: 'plan_p',
        node: 'integration:sentry',
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe("propose refused: proposal 'integration:sentry' is already decided (accepted)\n");
      expect(readEffectiveProposals(flowDir, 'plan_p')[0].state).toBe('accepted');
    });

    it('should refuse deciding a terminal (confirmed) proposal', async () => {
      // Propose a node the fixture DOES derive, then let derive confirm it.
      await propose({ node: 'integration:stripe', label: 'Stripe SDK' });
      deriveBlueprint(repoRoot, RUN_ID);
      expect(readEffectiveProposals(flowDir, 'plan_p')[0].state).toBe('confirmed');

      const result = await runActionAt(repoRoot, 'propose', {
        decide: 'accepted',
        plan: 'plan_p',
        node: 'integration:stripe',
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe("propose refused: proposal 'integration:stripe' is already terminal (confirmed)\n");
    });

    it('should refuse deciding a swept (stale) proposal with a re-propose hint', async () => {
      await propose();
      await runActionAt(repoRoot, 'sweep', { plan: 'plan_p' });
      expect(readEffectiveProposals(flowDir, 'plan_p')[0].state).toBe('stale');

      const result = await runActionAt(repoRoot, 'propose', {
        decide: 'accepted',
        plan: 'plan_p',
        node: 'integration:sentry',
      });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "propose refused: proposal 'integration:sentry' is stale — re-propose it before deciding\n",
      );
    });

    it.each([
      [{ decide: 'maybe' }, "propose refused: invalid --decide 'maybe' — expected accepted|rejected\n"],
      [{ decide: 'accepted', node: 'integration:sentry' }, 'propose refused: --decide requires --plan <plan>\n'],
      [{ decide: 'accepted', plan: 'plan_p' }, 'propose refused: --decide requires --node <predicted-id>\n'],
    ] as Array<[Partial<BlueprintCommandOptions>, string]>)(
      'should refuse malformed decide input %j',
      async (options, expectedStderr) => {
        const result = await runActionAt(repoRoot, 'propose', options);

        expect(process.exitCode).toBe(1);
        expect(result.stderr).toBe(expectedStderr);
        expect(existsSync(proposalsPath())).toBe(false);
      },
    );
  });

  // ── derive confirm pass (ghost → real) ───────────────────

  describe('derive confirm pass', () => {
    async function propose(node: string, kind: string, label: string, plan = 'plan_p'): Promise<void> {
      await runActionAt(repoRoot, 'propose', { plan, node, kind, label });
      expect(process.exitCode).toBe(0);
    }

    it('should confirm a proposed ghost whose exact predicted id is derived, with report line placement', async () => {
      // The fixture repo derives integration:stripe — the ghost dissolves.
      await propose('integration:stripe', 'integration', 'Stripe SDK');

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      // Conditional line sits after promotion/compaction, before the prose report.
      const tail = lines.slice(-3);
      expect(tail[0]).toBe('promotion: 1 promoted, 0 skipped');
      expect(tail[1]).toBe('proposals: 1 confirmed');
      expect(tail[2]).toBe('prose report: flow/brain/blueprint-report.md');

      const [proposal] = readEffectiveProposals(flowDir, 'plan_p');
      expect(proposal.state).toBe('confirmed');
      expect(proposal.confirmedAt).toBeDefined();
      // The confirm event carries derive provenance in the raw store.
      const lastLine = readFileSync(join(flowDir, 'brain', '.structure', 'proposals.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .pop() as string;
      expect(JSON.parse(lastLine)).toMatchObject({ event: 'confirmed', provenance: 'derive:confirm' });
    });

    /**
     * Seed one feature whose `## Parts` yields the part node
     * `feature:chats/sse-events-endpoint` — the id a part proposal predicts.
     */
    function seedFeatureWithPart(): void {
      mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
      writeFileSync(
        join(flowDir, 'brain', 'features', 'chats.md'),
        '---\nid: feature:chats\nname: Chats\nkind: core\n---\n# Chats\n\n## Parts\n\n### SSE events endpoint\nStreams tokens to the browser.\nanchors: src/routes/chat/sse.ts\n',
        'utf-8',
      );
    }

    it('REGRESSION: should confirm a PART against the feature graph — graph.json never holds one', async () => {
      // Checked against graph.json (the only source before per-kind confirm),
      // this proposal could not match anything, would stay unconfirmed forever
      // and would silently stale on the next sweep — a step that never runs
      // while the derive line above it keeps reporting a healthy run.
      seedFeatureWithPart();
      await propose('feature:chats/sse-events-endpoint', 'part', 'SSE events endpoint');

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(lines).toContain('proposals: 1 confirmed');
      const [proposal] = readEffectiveProposals(flowDir, 'plan_p');
      expect(proposal.kind).toBe('part');
      expect(proposal.state).toBe('confirmed');
      expect(proposal.confirmedAt).toBeDefined();
    });

    it('should leave a part proposal naming no real part proposed', async () => {
      seedFeatureWithPart();
      await propose('feature:chats/never-built', 'part', 'Never built');

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(lines.some((line) => line.startsWith('proposals:'))).toBe(false);
      expect(readEffectiveProposals(flowDir, 'plan_p')[0].state).toBe('proposed');
    });

    it('should leave a never-derived proposal proposed and omit the report line', async () => {
      await propose('integration:sentry', 'integration', 'Sentry SDK');

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(lines.some((line) => line.startsWith('proposals:'))).toBe(false);
      expect(readEffectiveProposals(flowDir, 'plan_p')[0].state).toBe('proposed');
    });

    it('should confirm an ACCEPTED proposal when its predicted node is derived', async () => {
      await propose('endpoint:GET /users', 'endpoint', 'Users endpoint');
      await runActionAt(repoRoot, 'propose', { decide: 'accepted', plan: 'plan_p', node: 'endpoint:GET /users' });

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(lines).toContain('proposals: 1 confirmed');
      const [proposal] = readEffectiveProposals(flowDir, 'plan_p');
      expect(proposal.state).toBe('confirmed');
      expect(proposal.decidedAt).toBeDefined();
      expect(proposal.confirmedAt).toBeDefined();
    });

    it('should be idempotent — a second derive confirms nothing and appends nothing', async () => {
      await propose('integration:stripe', 'integration', 'Stripe SDK');
      deriveBlueprint(repoRoot, RUN_ID);
      const storeAfterFirst = readFileSync(join(flowDir, 'brain', '.structure', 'proposals.jsonl'), 'utf-8');

      const secondLines = deriveBlueprint(repoRoot, RUN_ID);

      expect(secondLines.some((line) => line.startsWith('proposals:'))).toBe(false);
      expect(readFileSync(join(flowDir, 'brain', '.structure', 'proposals.jsonl'), 'utf-8')).toBe(storeAfterFirst);
    });

    it('should confirm matching proposals across ALL plans in one pass', async () => {
      await propose('integration:stripe', 'integration', 'Stripe SDK', 'plan_a');
      await propose('endpoint:cli init', 'endpoint', 'Init command', 'plan_b');
      await propose('integration:sentry', 'integration', 'Sentry SDK', 'plan_b'); // never derived

      const lines = deriveBlueprint(repoRoot, RUN_ID);

      expect(lines).toContain('proposals: 2 confirmed');
      expect(readEffectiveProposals(flowDir, 'plan_a')[0].state).toBe('confirmed');
      const planB = new Map(
        readEffectiveProposals(flowDir, 'plan_b').map((proposal) => [proposal.predictedNodeId, proposal.state]),
      );
      expect(planB.get('endpoint:cli init')).toBe('confirmed');
      expect(planB.get('integration:sentry')).toBe('proposed');
    });
  });

  // ── sweep ────────────────────────────────────────────────

  describe('blueprint sweep', () => {
    async function propose(node: string, kind: string, label: string, plan = 'plan_p'): Promise<void> {
      await runActionAt(repoRoot, 'propose', { plan, node, kind, label });
      expect(process.exitCode).toBe(0);
    }

    it('should refuse without --plan and write nothing', async () => {
      const result = await runActionAt(repoRoot, 'sweep', {});

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toBe(
        'sweep refused: sweep requires --plan <plan>, or --expired to sweep sources that are gone\n',
      );
      expect(existsSync(join(flowDir, 'brain', '.structure', 'proposals.jsonl'))).toBe(false);
    });

    it('should refuse --expired combined with --plan — the two scopes are not composable', async () => {
      const result = await runActionAt(repoRoot, 'sweep', { plan: 'plan_p', expired: true });

      expect(process.exitCode).toBe(1);
      expect(result.stderr).toContain('--expired sweeps every plan');
    });

    it('should stale only the proposals whose source is gone, and report the count', async () => {
      mkdirSync(join(flowDir, 'discovery'), { recursive: true });
      writeFileSync(join(flowDir, 'discovery', 'discovery_live_v1.md'), '# live\n', 'utf-8');
      await propose('integration:sentry', 'integration', 'Sentry SDK', 'discovery_live_v1');
      await propose('integration:stripe', 'integration', 'Stripe SDK', 'discovery_gone_v1');

      const result = await runActionAt(repoRoot, 'sweep', { expired: true });

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toContain('proposals: 1 staled (source gone)');

      // Idempotent, and nothing was deleted.
      const second = await runActionAt(repoRoot, 'sweep', { expired: true });
      expect(second.stdout).toContain('proposals: 0 staled (source gone)');
      const lines = readFileSync(join(flowDir, 'brain', '.structure', 'proposals.jsonl'), 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(3);
    });

    it('should stale proposed+accepted, clear rejected, and report exact counts', async () => {
      await propose('integration:sentry', 'integration', 'Sentry SDK'); // stays proposed
      await propose('datastore:cache', 'datastore', 'Cache'); // → accepted
      await runActionAt(repoRoot, 'propose', { decide: 'accepted', plan: 'plan_p', node: 'datastore:cache' });
      await propose('module:src/ghost', 'module', 'Ghost module'); // → rejected
      await runActionAt(repoRoot, 'propose', { decide: 'rejected', plan: 'plan_p', node: 'module:src/ghost' });

      const result = await runActionAt(repoRoot, 'sweep', { plan: 'plan_p' });

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toBe('sweep plan_p: 2 staled, 1 cleared\n');
      const states = new Map(
        readEffectiveProposals(flowDir, 'plan_p').map((proposal) => [proposal.predictedNodeId, proposal.state]),
      );
      expect(states.get('integration:sentry')).toBe('stale');
      expect(states.get('datastore:cache')).toBe('stale');
      expect(states.get('module:src/ghost')).toBe('cleared');
      // Sweep events carry sweep provenance in the raw store.
      const lastLine = readFileSync(join(flowDir, 'brain', '.structure', 'proposals.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .pop() as string;
      expect(JSON.parse(lastLine)).toMatchObject({ provenance: 'cli:sweep' });
    });

    it('should be idempotent — a double sweep reports 0 staled, 0 cleared and appends nothing', async () => {
      await propose('integration:sentry', 'integration', 'Sentry SDK');
      await runActionAt(repoRoot, 'sweep', { plan: 'plan_p' });
      const storeAfterFirst = readFileSync(join(flowDir, 'brain', '.structure', 'proposals.jsonl'), 'utf-8');

      const result = await runActionAt(repoRoot, 'sweep', { plan: 'plan_p' });

      expect(process.exitCode).toBe(0);
      expect(result.stdout).toBe('sweep plan_p: 0 staled, 0 cleared\n');
      expect(readFileSync(join(flowDir, 'brain', '.structure', 'proposals.jsonl'), 'utf-8')).toBe(storeAfterFirst);
    });

    it('should not touch terminal proposals or other plans', async () => {
      // Confirmed proposal in the swept plan — untouched.
      await propose('integration:stripe', 'integration', 'Stripe SDK');
      deriveBlueprint(repoRoot, RUN_ID);
      // Undecided proposal in ANOTHER plan — out of scope.
      await propose('integration:sentry', 'integration', 'Sentry SDK', 'plan_other');

      const result = await runActionAt(repoRoot, 'sweep', { plan: 'plan_p' });

      expect(result.stdout).toBe('sweep plan_p: 0 staled, 0 cleared\n');
      expect(readEffectiveProposals(flowDir, 'plan_p')[0].state).toBe('confirmed');
      expect(readEffectiveProposals(flowDir, 'plan_other')[0].state).toBe('proposed');
    });
  });

  // ── unknown action ───────────────────────────────────────

  it('should exit 1 on an unknown action', async () => {
    const output = await runBlueprintAt(repoRoot, 'bogus');

    expect(output).toContain('Unknown blueprint action: "bogus"');
    expect(process.exitCode).toBe(1);
  });

  // ── Repo-shape fixture matrix ────────────────────────────
  //
  // Five repo shapes, each asserting: derive passes the canonical validation
  // gate, spine-root discovery lands where expected, and a double derive is
  // deterministic (graphs equal minus derivedAt).

  describe('repo-shape matrix', () => {
    /** Build a fresh temp repo (with flow/), derive twice, and return everything. */
    function deriveShape(build: (root: string) => void): {
      root: string;
      lines: string[];
      first: BlueprintGraph;
      second: BlueprintGraph;
      cleanup: () => void;
    } {
      const root = mkdtempSync(join(tmpdir(), 'blueprint-shape-test-'));
      mkdirSync(join(root, 'flow'), { recursive: true });
      build(root);
      const lines = deriveBlueprint(root, null);
      const first = readGraph(join(root, 'flow')) as BlueprintGraph;
      deriveBlueprint(root, null);
      const second = readGraph(join(root, 'flow')) as BlueprintGraph;
      return { root, lines, first, second, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    }

    function expectValidAndDeterministic(shape: ReturnType<typeof deriveShape>): void {
      expect(shape.lines).toContain('validation: ok');
      expect(stripDerivedAt(shape.second)).toEqual(stripDerivedAt(shape.first));
    }

    it('(a) flat repo with no src/: repo-root dirs with source files become fallback roots', () => {
      const shape = deriveShape((root) => {
        writeFixture(root, 'index.ts', 'export const loose = 1;\n'); // root-level file — never a root
        writeFixture(root, 'server/main.ts', "app.get('/flat', handler);\nexport const main = 1;\n");
      });
      try {
        expectValidAndDeterministic(shape);
        expect(shape.lines).toContain('scan: spine roots: server');
        const moduleIds = shape.first.nodes.filter((node) => node.kind === 'module').map((node) => node.id);
        expect(moduleIds).toEqual(['module:server']);
        expect(shape.first.nodes.find((node) => node.id === 'module:server')?.meta?.depth).toBe(1);
      } finally {
        shape.cleanup();
      }
    });

    it('(b) monorepo via workspaces: each packages/*/src is its own depth-1 root', () => {
      const shape = deriveShape((root) => {
        writeFixture(root, 'package.json', JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }));
        writeFixture(root, 'packages/a/src/index.ts', "import { b } from '../../b/src/index.js';\nexport const a = b;\n");
        writeFixture(root, 'packages/b/src/index.ts', 'export const b = 2;\n');
      });
      try {
        expectValidAndDeterministic(shape);
        expect(shape.lines).toContain('scan: spine roots: packages/a/src, packages/b/src');
        const depthOf = new Map(
          shape.first.nodes.filter((node) => node.kind === 'module').map((node) => [node.id, node.meta?.depth]),
        );
        expect(depthOf.get('module:packages/a/src')).toBe(1);
        expect(depthOf.get('module:packages/b/src')).toBe(1);
      } finally {
        shape.cleanup();
      }
    });

    it('(c) secondary root app/src beside src/: both are depth-1 roots', () => {
      const shape = deriveShape((root) => {
        writeFixture(root, 'src/cli/main.ts', 'export const cli = 1;\n');
        writeFixture(root, 'app/src/renderer/view.ts', 'export const view = 2;\n');
      });
      try {
        expectValidAndDeterministic(shape);
        expect(shape.lines).toContain('scan: spine roots: app/src, src');
        const depthOf = new Map(
          shape.first.nodes.filter((node) => node.kind === 'module').map((node) => [node.id, node.meta?.depth]),
        );
        expect(depthOf.get('module:src')).toBe(1);
        expect(depthOf.get('module:app/src')).toBe(1);
        expect(depthOf.get('module:src/cli')).toBe(2);
        expect(depthOf.get('module:app/src/renderer')).toBe(2);
      } finally {
        shape.cleanup();
      }
    });

    it('(d) python-ish repo (.py only): folder spine is language-agnostic (#536)', () => {
      // #536: folder STRUCTURE is language-agnostic — a Python repo gets its
      // conventional `src` spine + module node(s) natively, even without graphify.
      // (Language-specific integration/endpoint extraction stays TS/JS.)
      const shape = deriveShape((root) => {
        writeFixture(root, 'src/main.py', "print('hello')\n");
        writeFixture(root, 'scripts/tool.py', "print('tool')\n");
      });
      try {
        expectValidAndDeterministic(shape);
        expect(shape.lines).toContain('scan: spine roots: src');
        const moduleIds = shape.first.nodes
          .filter((node) => node.kind === 'module')
          .map((node) => node.id);
        expect(moduleIds).toContain('module:src');
      } finally {
        shape.cleanup();
      }
    });

    it('(e) empty repo: derive succeeds with an empty, valid, deterministic graph', () => {
      const shape = deriveShape(() => {
        // Nothing but flow/ — the emptiest legal derive target
      });
      try {
        expectValidAndDeterministic(shape);
        expect(shape.lines).toContain('scan: spine roots: none');
        expect(shape.first.nodes).toEqual([]);
        expect(shape.first.edges).toEqual([]);
        expect(shape.lines).toContain('graph: 0 node(s), 0 edge(s) → flow/brain/.structure/graph.json');
      } finally {
        shape.cleanup();
      }
    });
  });
})
