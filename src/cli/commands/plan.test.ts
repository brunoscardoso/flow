/**
 * Subprocess E2E for `planflow-ai plan compile` — spawns the REAL CLI entry
 * against temp fixture projects.
 *
 * Invocation note: the sibling provisioner E2E runs the built CLI
 * (`dist/cli/index.js`), but the build is end-only in this repo's workflow,
 * so this suite runs the entry through the local tsx binary
 * (`node node_modules/.bin/tsx src/cli/index.ts …`) — the same dev path as
 * the `dev:cli` npm script. The command surface under test is identical.
 *
 * Scenarios:
 *   (a) happy path — fixture plan in a temp --target dir → exit 0, report
 *       shows waves + routing lines, run-script artifact written
 *   (b) refusal — cyclic plan → exit 1, COMBINED stdout+stderr carries the
 *       `compile refused:` line (allowed-pattern #15: this CLI's error()
 *       routes through console.log), and NO artifact is written
 *   (c) overrides preservation — hand-edit the artifact's overrides block
 *       (one valid + one stale), recompile → valid applied, stale warned,
 *       both carried on the recompiled artifact
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');

const E2E_TIMEOUT_MS = 120_000;

const HAPPY_PLAN = `# Plan: My Feature

### Phase 1: Types
**Complexity**: 3/10
**Dependencies**: none

- [ ] Define types
  <verify>npx tsc --noEmit</verify>

### Phase 2: Implementation
**Complexity**: 7/10
**Dependencies**: Phase 1

- [ ] Implement feature
`;

const CYCLIC_PLAN = `# Plan: Cyclic

### Phase 1: A
**Complexity**: 3/10
**Dependencies**: Phase 2

- [ ] Task a

### Phase 2: B
**Complexity**: 3/10
**Dependencies**: Phase 1

- [ ] Task b
`;

interface CliRun {
  stdout: string;
  stderr: string;
  combined: string;
  status: number | null;
}

describe('plan compile E2E — real CLI subprocess against a temp fixture project', () => {
  let target: string;

  function runCompile(planArg: string): CliRun {
    const result = spawnSync(
      process.execPath,
      [TSX_BIN, CLI_ENTRY, 'plan', 'compile', planArg, '--target', target],
      { encoding: 'utf-8', timeout: E2E_TIMEOUT_MS },
    );
    if (result.error) {
      throw result.error;
    }
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return { stdout, stderr, combined: `${stdout}\n${stderr}`, status: result.status };
  }

  function writePlan(fileName: string, content: string): void {
    const plansDir = join(target, 'flow', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, fileName), content, 'utf-8');
  }

  function artifactPath(planName: string): string {
    return join(target, 'flow', 'plans', `${planName}.run.json`);
  }

  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), 'plan-compile-e2e-'));
  });

  afterEach(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it(
    '(a) compiles a fixture plan with default config: routing ON, tiered by complexity, artifact written',
    () => {
      writePlan('plan_my-feature_v1.md', HAPPY_PLAN);

      const run = runCompile('my-feature');

      expect(run.status).toBe(0);
      expect(run.stdout).toContain('Wave 1: Phase 1');
      expect(run.stdout).toContain('Wave 2: Phase 2');
      // No .flowconfig → model_routing defaults TRUE → tiering by complexity.
      // Flipped with the default itself: paying the most capable model for a
      // complexity-3 phase was the default nobody chose.
      expect(run.stdout).toContain('model routing: on');
      expect(run.stdout).toContain('Phase 1 (complexity 3) → haiku');
      expect(run.stdout).toContain('Phase 2 (complexity 7) → opus');
      expect(run.stdout).toContain(join('flow', 'plans', 'my-feature.run.json'));

      const artifactFile = artifactPath('my-feature');
      expect(existsSync(artifactFile)).toBe(true);
      const artifact = JSON.parse(readFileSync(artifactFile, 'utf-8'));
      expect(artifact.version).toBe(1);
      expect(artifact.plan).toBe('my-feature');
      expect(artifact.phases).toHaveLength(2);
      // Routing on by default (#1957): the artifact bakes a tier per phase.
      expect(artifact.routing.map((r: { phase: number; model: string }) => [r.phase, r.model])).toEqual([
        [1, 'haiku'],
        [2, 'opus'],
      ]);
      expect(artifact.phases.map((p: { model: string }) => p.model)).toEqual(['haiku', 'opus']);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '(a2) routes by complexity when flow/.flowconfig sets model_routing: true (#670)',
    () => {
      writePlan('plan_my-feature_v1.md', HAPPY_PLAN);
      writeFileSync(join(target, 'flow', '.flowconfig'), 'model_routing: true\n', 'utf-8');

      const run = runCompile('my-feature');

      expect(run.status).toBe(0);
      expect(run.stdout).toContain('model routing: on');
      expect(run.stdout).toContain('Phase 1 (complexity 3) → haiku');
      expect(run.stdout).toContain('Phase 2 (complexity 7) → opus');

      const artifact = JSON.parse(readFileSync(artifactPath('my-feature'), 'utf-8'));
      expect(artifact.routing.map((r: { model: string }) => r.model)).toEqual(['haiku', 'opus']);
      expect(artifact.phases.map((p: { model: string }) => p.model)).toEqual(['haiku', 'opus']);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '(b) refuses a cyclic plan: exit 1, combined output carries "compile refused:", no artifact',
    () => {
      writePlan('plan_cyclic_v1.md', CYCLIC_PLAN);

      const run = runCompile('cyclic');

      expect(run.status).toBe(1);
      // Allowed-pattern #15: this CLI's error() routes through console.log —
      // assert on the combined transcript, never stderr alone.
      expect(run.combined).toContain('compile refused:');
      expect(run.combined).toContain('dependency cycle');
      expect(existsSync(artifactPath('cyclic'))).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '(b2) a wrong-level plan is told SO — not that its phases do not exist (#1809)',
    () => {
      // The reported shape, verbatim: six visible `## Phase` headings, and the
      // tool reporting none. 51 headings in this repo's own archive are `##`,
      // and `/execute-plan` reads the compiled artifact as its orchestration
      // source of truth — so a heading level one `#` off does not degrade the
      // run, it stops the plan entering the pipeline at all.
      writePlan(
        'plan_wrong-level_v1.md',
        ['# Plan', '', '## Phase 1 — Setup', '', '**Complexity**: 3/10', '', '- [ ] a task', ''].join('\n'),
      );

      const run = runCompile('wrong-level');

      expect(run.status).toBe(1);
      expect(run.combined).toContain('compile refused:');
      // The fact that fixes it, on the line the author reads.
      expect(run.combined).toContain('### Phase <n>: <title>');
      expect(run.combined).toContain('exactly three hashes');
      expect(existsSync(artifactPath('wrong-level'))).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '(b3) a plan with nothing phase-like says that instead, in different words (#1809)',
    () => {
      // "Your headings are the wrong level" and "this file has no phases in it"
      // are different problems and must not read identically.
      writePlan('plan_no-phases_v1.md', '# Plan\n\nJust prose, no phases at all.\n');

      const run = runCompile('no-phases');

      expect(run.status).toBe(1);
      expect(run.combined).toContain('no `### Phase <n>: <title>` heading in the file');
      expect(run.combined).not.toContain('three hashes');
      expect(existsSync(artifactPath('no-phases'))).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '(b4) the same stated difficulty gets the same model, suffix or not (#1810)',
    () => {
      // Complexity picks the model, so `**Complexity**: 8` silently parsing as
      // 5 downgraded the phase — and the artifact, which /execute-plan reads as
      // its orchestration source of truth, carried the number nobody wrote.
      writePlan(
        'plan_cx_v1.md',
        [
          '# Plan: cx',
          '',
          '### Phase 1: Suffix present',
          '**Complexity**: 8/10',
          '',
          '- [ ] a',
          '',
          '### Phase 2: Suffix absent',
          '**Complexity**: 8',
          '',
          '- [ ] b',
          '',
        ].join('\n'),
      );

      const run = runCompile('cx');

      expect(run.status).toBe(0);
      const artifact = JSON.parse(readFileSync(artifactPath('cx'), 'utf-8'));
      const byPhase = artifact.phases.map((p: { complexity: number; model: string }) => [
        p.complexity,
        p.model,
      ]);
      expect(byPhase[0]).toEqual(byPhase[1]);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '(b5) an unreadable complexity is NOTED on the compile output, not silently 5 (#1810)',
    () => {
      // The half that made this invisible: a fallback 5 is indistinguishable
      // from an authored 5, and the compile exits 0 saying nothing.
      writePlan(
        'plan_cxbad_v1.md',
        ['# Plan', '', '### Phase 1: A', '**Complexity**: quite hard really', '', '- [ ] a', ''].join('\n'),
      );

      const run = runCompile('cxbad');

      expect(run.status).toBe(0); // still compiles — this is a note, not a refusal
      expect(run.combined).toContain('could not read a complexity');
      expect(run.combined).toContain('defaulted to 5');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '(c) preserves hand-edited overrides across a recompile: valid applied, stale warned, both carried',
    () => {
      writePlan('plan_my-feature_v1.md', HAPPY_PLAN);
      expect(runCompile('my-feature').status).toBe(0);

      // Hand-edit the artifact: one valid override (phase 1 → opus) and one
      // stale override (phase 9 does not exist).
      const artifactFile = artifactPath('my-feature');
      const artifact = JSON.parse(readFileSync(artifactFile, 'utf-8'));
      artifact.overrides = {
        phases: { '1': { model: 'opus' }, '9': { skip: true } },
      };
      writeFileSync(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');

      const recompile = runCompile('my-feature');

      expect(recompile.status).toBe(0);
      expect(recompile.stdout).toContain('Phase 1 (complexity 3) → opus [override]');
      expect(recompile.stdout).toContain(
        'warning: override for phase 9 is stale: no such phase',
      );

      const recompiled = JSON.parse(readFileSync(artifactFile, 'utf-8'));
      // Valid override applied to the compiled phase
      const phase1 = recompiled.phases.find((p: { number: number }) => p.number === 1);
      expect(phase1.model).toBe('opus');
      // Both overrides carried verbatim — stale entries diagnosed, never dropped
      expect(recompiled.overrides).toEqual({
        phases: { '1': { model: 'opus' }, '9': { skip: true } },
      });
      expect(recompiled.diagnostics).toEqual([
        {
          severity: 'stale-override',
          message: 'override for phase 9 is stale: no such phase',
        },
      ]);
    },
    E2E_TIMEOUT_MS,
  );

  describe('plan archive — the production caller of archiveRunScript (#1589)', () => {
    function runArchive(planArg: string): CliRun {
      const result = spawnSync(
        process.execPath,
        [TSX_BIN, CLI_ENTRY, 'plan', 'archive', planArg, '--target', target],
        { encoding: 'utf-8', timeout: E2E_TIMEOUT_MS },
      );
      if (result.error) {
        throw result.error;
      }
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      return { stdout, stderr, combined: `${stdout}\n${stderr}`, status: result.status };
    }

    function prevArtifactPath(planName: string): string {
      return join(target, 'flow', 'plans', `${planName}.run.prev.json`);
    }

    function archivedPath(fileName: string): string {
      return join(target, 'flow', 'archive', fileName);
    }

    it(
      '(d) moves BOTH the artifact and its rotated .prev into flow/archive/ — the orphan case',
      () => {
        writePlan('plan_my-feature_v1.md', HAPPY_PLAN);
        // Two compiles: the second rotates the first to .run.prev.json.
        expect(runCompile('my-feature').status).toBe(0);
        expect(runCompile('my-feature').status).toBe(0);
        expect(existsSync(prevArtifactPath('my-feature'))).toBe(true);

        const run = runArchive('my-feature');

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('archived:');
        expect(run.stdout).toContain(join('flow', 'archive', 'my-feature.run.json'));
        expect(run.stdout).toContain(join('flow', 'archive', 'my-feature.run.prev.json'));
        // Nothing left behind in the live plans directory
        expect(existsSync(artifactPath('my-feature'))).toBe(false);
        expect(existsSync(prevArtifactPath('my-feature'))).toBe(false);
        expect(existsSync(archivedPath('my-feature.run.json'))).toBe(true);
        expect(existsSync(archivedPath('my-feature.run.prev.json'))).toBe(true);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      '(e) archives by name after the plan doc has already moved, and is a silent no-op when nothing is there',
      () => {
        writePlan('plan_my-feature_v1.md', HAPPY_PLAN);
        expect(runCompile('my-feature').status).toBe(0);
        // The archive step moves the plan doc first — archiving must not
        // depend on it still being in flow/plans/.
        rmSync(join(target, 'flow', 'plans', 'plan_my-feature_v1.md'));

        const first = runArchive('my-feature');
        expect(first.status).toBe(0);
        expect(existsSync(archivedPath('my-feature.run.json'))).toBe(true);

        // Re-archiving an already-archived plan: exit 0, nothing claimed moved.
        const second = runArchive('my-feature');
        expect(second.status).toBe(0);
        expect(second.stdout).toContain('no run-script artifacts for my-feature');
        expect(second.stdout).not.toContain('archived:');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      '(f) refuses a missing flow/ directory: exit 1, combined output carries "archive refused:"',
      () => {
        const run = runArchive('my-feature');

        expect(run.status).toBe(1);
        // Allowed-pattern #15: assert on the combined transcript.
        expect(run.combined).toContain('archive refused:');
        expect(run.combined).toContain('no flow/ directory');
      },
      E2E_TIMEOUT_MS,
    );
  });
});
