/**
 * Tests for init command
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll } from '@jest/globals';
import { jest } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock prompts to avoid interactive stdin in tests
const askShareModeMock = jest.fn<() => Promise<'local' | 'shared'>>().mockResolvedValue('local');

jest.unstable_mockModule(resolve(__dirname, '../utils/prompts'), () => ({
  askLegacyFilesAction: jest.fn<() => Promise<string>>().mockResolvedValue('keep'),
  selectPlatforms: jest.fn<() => Promise<string[]>>().mockResolvedValue(['claude']),
  askShareMode: askShareModeMock,
  askBusinessContext: jest.fn<() => Promise<{ whatItDoes: string; targetAudience: string; problemItSolves: string }>>().mockResolvedValue({
    whatItDoes: 'Test project',
    targetAudience: 'Developers',
    problemItSolves: 'Testing',
  }),
}));

// Mock graphify rails so init tests never invoke real package managers (uv/pipx)
jest.unstable_mockModule(resolve(__dirname, './graphify-rails'), () => ({
  ensureGraphify: jest.fn<() => Promise<{ outcome: string; notice: string }>>().mockResolvedValue({
    outcome: 'pending',
    notice: 'Graphify: mocked in tests',
  }),
}));

// Mock the PATH rails so init tests never run a real `npm link` and never
// write to the real ~/.local/bin. The rails' own behavior is covered in
// path-rails.test.ts; what matters here is that init reports their outcome.
interface PathRailsResult {
  outcome: string;
  notice: string;
  pathLine: string | null;
  shimPath: string | null;
}
const ensurePlanflowOnPathMock = jest
  .fn<() => Promise<PathRailsResult>>()
  .mockResolvedValue({
    outcome: 'already-resolves',
    notice: 'CLI: mocked in tests',
    pathLine: null,
    shimPath: null,
  });

jest.unstable_mockModule(resolve(__dirname, './path-rails'), () => ({
  ensurePlanflowOnPath: ensurePlanflowOnPathMock,
}));

const { runInit, featureReportLine, resolveShareAnswer, settleInitBackgroundWork } =
  await import('./init');

function createTempDir(): string {
  const dir = join(tmpdir(), `plan-flow-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  // RETRIES, because `force` does not help against a live writer. `init` kicks
  // off a fire-and-forget derive, and that child keeps writing into the fixture
  // after the test has finished — so `rmSync` walks a directory that refills
  // underneath it and throws `ENOTEMPTY`. It surfaced as a flake that failed a
  // DIFFERENT test name on each run, which is what a teardown race looks like
  // from the outside.
  rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}

// Redirect vault to temp dir to avoid polluting real vault
let initTestVaultDir: string;

beforeAll(() => {
  initTestVaultDir = join(tmpdir(), `plan-flow-vault-initcmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(initTestVaultDir, { recursive: true });
  process.env.PLAN_FLOW_VAULT_DIR = initTestVaultDir;
});

afterAll(() => {
  rmSync(initTestVaultDir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  delete process.env.PLAN_FLOW_VAULT_DIR;
});

// Suppress console output during tests — captured so the printed transcript
// (which is what the user actually sees) can be asserted on.
let logged: string[] = [];

function transcript(): string {
  return logged.join('\n');
}

beforeEach(() => {
  logged = [];
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  // `runInit` detaches a blueprint derive on purpose, so it can still be running
  // when a test ends. Left alone, its log line lands in the NEXT test's
  // transcript and its `graphify-out/` write races the temp-dir cleanup — which
  // is why this suite used to fail on a different test every run. Settling it
  // here is the whole fix; nothing in production waits for it.
  await settleInitBackgroundWork();
  jest.restoreAllMocks();
});

describe('runInit', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    // Create a project indicator so validation passes cleanly
    writeFileSync(join(tempDir, 'package.json'), '{}');
  });

  afterEach(async () => {
    // BEFORE the rmSync, not after: jest runs inner teardown first, so settling
    // in the outer hook would still let the detached derive write
    // `graphify-out/` into a directory this line is removing.
    await settleInitBackgroundWork();
    cleanup(tempDir);
  });

  it('should install Claude Code files with --claude flag', async () => {
    await runInit({ claude: true, target: tempDir });

    expect(existsSync(join(tempDir, '.claude', 'commands'))).toBe(true);
    expect(existsSync(join(tempDir, '.claude', 'rules'))).toBe(true);
    expect(existsSync(join(tempDir, 'CLAUDE.md'))).toBe(true);
    // Shared resources should also be installed
    expect(existsSync(join(tempDir, 'flow'))).toBe(true);
    // Graphify rails must be the mocked module — the real one would have
    // recorded an engines.graphify entry in flow/.flowconfig
    const flowconfigPath = join(tempDir, 'flow', '.flowconfig');
    if (existsSync(flowconfigPath)) {
      expect(readFileSync(flowconfigPath, 'utf-8')).not.toContain('engines.graphify');
    }
  });

  it('--all installs the claude-only set (multi-IDE support removed)', async () => {
    await runInit({ all: true, target: tempDir });

    expect(existsSync(join(tempDir, '.claude', 'commands'))).toBe(true);
    expect(existsSync(join(tempDir, 'CLAUDE.md'))).toBe(true);
    // No other-IDE artifacts, ever.
    expect(existsSync(join(tempDir, '.cursor'))).toBe(false);
    expect(existsSync(join(tempDir, 'skills'))).toBe(false);
    expect(existsSync(join(tempDir, '.agents'))).toBe(false);
    expect(existsSync(join(tempDir, 'AGENTS.md'))).toBe(false);
    // Shared
    expect(existsSync(join(tempDir, 'flow'))).toBe(true);
  });

  it('should respect --force flag for overwriting', async () => {
    // First install
    await runInit({ all: true, target: tempDir });
    // Second install with force
    await runInit({ all: true, target: tempDir, force: true });

    // Should still have everything
    expect(existsSync(join(tempDir, '.claude', 'commands'))).toBe(true);
  });

  // ── Knowledge sharing (share=local|shared) ──────────────────────────────
  // The question exists so the .gitignore generator has an input. Default is
  // local: answering "shared" commits this project's brain, which publishes
  // work, so it is never inferred — only answered, and only once.
  describe('share question', () => {
    beforeEach(() => {
      askShareModeMock.mockClear();
      askShareModeMock.mockResolvedValue('local');
    });

    it('persists the answer to flow/.flowconfig beside the other keys', async () => {
      await runInit({ all: true, target: tempDir });

      const config = readFileSync(join(tempDir, 'flow', '.flowconfig'), 'utf-8');
      expect(config).toMatch(/^share: local$/m);
    });

    it('persists "shared" when that is what the user answered', async () => {
      askShareModeMock.mockResolvedValue('shared');

      await runInit({ all: true, target: tempDir });

      const config = readFileSync(join(tempDir, 'flow', '.flowconfig'), 'utf-8');
      expect(config).toMatch(/^share: shared$/m);
    });

    it('never asks in non-interactive mode, and lands on local', async () => {
      await runInit({ all: true, target: tempDir, yes: true });

      expect(askShareModeMock).not.toHaveBeenCalled();
      const config = readFileSync(join(tempDir, 'flow', '.flowconfig'), 'utf-8');
      expect(config).toMatch(/^share: local$/m);
    });

    it('asks once — a project that already answered is never re-asked', async () => {
      askShareModeMock.mockResolvedValue('shared');
      await runInit({ all: true, target: tempDir });
      expect(askShareModeMock).toHaveBeenCalledTimes(1);

      await runInit({ all: true, target: tempDir });

      expect(askShareModeMock).toHaveBeenCalledTimes(1);
      const config = readFileSync(join(tempDir, 'flow', '.flowconfig'), 'utf-8');
      expect(config).toMatch(/^share: shared$/m);
      // Exactly one canonical line for the key, so writer and parser agree.
      expect(config.match(/^share:/gm)?.length).toBe(1);
    });

    it('resolveShareAnswer: an existing answer wins over asking', async () => {
      await runInit({ all: true, target: tempDir, yes: true });
      askShareModeMock.mockClear();

      expect(await resolveShareAnswer(tempDir, false)).toBe('local');
      expect(askShareModeMock).not.toHaveBeenCalled();
    });

    it('resolveShareAnswer: unanswered + non-interactive expresses NO opinion', async () => {
      // undefined (not "local") so the handler keeps whatever the project has —
      // a headless provision must never overwrite the user's setting.
      expect(await resolveShareAnswer(tempDir, true)).toBeUndefined();
      expect(askShareModeMock).not.toHaveBeenCalled();
    });
  });

  // ── PATH rails (Task 2.5) ───────────────────────────────────────────────
  // `planflow-ai` must resolve by name after init, because the beat prompts
  // call it by name. init owns the wiring; the ladder itself is path-rails'.
  describe('planflow-ai PATH rails', () => {
    beforeEach(() => {
      ensurePlanflowOnPathMock.mockClear();
      ensurePlanflowOnPathMock.mockResolvedValue({
        outcome: 'already-resolves',
        notice: 'CLI: `planflow-ai` already resolves (/usr/local/bin/planflow-ai).',
        pathLine: null,
        shimPath: null,
      });
    });

    it('runs the rails once and reports the outcome in the summary', async () => {
      await runInit({ all: true, target: tempDir });

      expect(ensurePlanflowOnPathMock).toHaveBeenCalledTimes(1);
      expect(transcript()).toContain('CLI: `planflow-ai` already resolves');
    });

    it('prints the export line as a next step when the shim needs one', async () => {
      ensurePlanflowOnPathMock.mockResolvedValue({
        outcome: 'shim-written',
        notice: 'CLI: wrote `planflow-ai` shim to /home/x/.local/bin/planflow-ai.',
        pathLine: 'export PATH="/home/x/.local/bin:$PATH"',
        shimPath: '/home/x/.local/bin/planflow-ai',
      });

      await runInit({ all: true, target: tempDir });

      const out = transcript();
      expect(out).toContain('export PATH="/home/x/.local/bin:$PATH"');
      expect(out).toContain('Add this line to your shell profile');
      // Printed as an instruction — the installer never edits a profile itself.
      expect(out).toContain('Next Steps');
    });

    it('says nothing about PATH when nothing is needed', async () => {
      await runInit({ all: true, target: tempDir });

      expect(transcript()).not.toContain('export PATH=');
    });

    it('degrades to a notice and still finishes when the rails throw', async () => {
      ensurePlanflowOnPathMock.mockRejectedValue(new Error('which exploded'));

      // The install must complete: a binary that cannot be placed is a notice,
      // never a failed provision.
      await expect(runInit({ all: true, target: tempDir })).resolves.toBeUndefined();

      expect(transcript()).toContain('CLI: PATH setup skipped: which exploded');
      expect(existsSync(join(tempDir, '.claude', 'commands'))).toBe(true);
      expect(existsSync(join(tempDir, 'flow'))).toBe(true);
    });
  });

  // ── seeded loop directives (Task 3.4) ───────────────────────────────────
  // A provisioned project used to have no `loops/` at all, so `/beat fix`
  // answered `no directive for loop 'fix'`. The seeded files are reported the
  // same way every other provisioned asset is — per-file lines, counted in the
  // summary — rather than as a special notice nobody would connect to a file.
  describe('loop directives', () => {
    it('reports each seeded directive in the install transcript and the summary', async () => {
      await runInit({ all: true, target: tempDir });

      const out = transcript();
      for (const name of ['find', 'fix']) {
        expect(existsSync(join(tempDir, 'loops', `${name}.md`))).toBe(true);
        expect(out).toContain(`Created loops/${name}.md`);
      }
      expect(out).toContain('paused directive(s)');
      expect(out).toMatch(/Done! \d+ created/);
    });

    it('says the directory was left alone on a re-provision, and creates nothing', async () => {
      await runInit({ all: true, target: tempDir });
      logged = [];

      await runInit({ all: true, target: tempDir });

      const out = transcript();
      expect(out).toContain('loops/ already has directives');
      expect(out).not.toContain('Created loops/');
    });
  });

  // The feature line init prints is DERIVE'S, relayed verbatim. init used to
  // bootstrap a second time and report on that instead; because derive is
  // synchronous it had already seeded the store, so the second pass adopted
  // nothing and announced "the feature board starts empty" on exactly the repos
  // where derive had just populated it.
  describe('featureReportLine (init relays derive, it never re-bootstraps)', () => {
    it('relays derive’s feature line verbatim', () => {
      const lines = [
        'coverage note: modules 12/12',
        'Features: 2 capability feature(s)',
        'validation: ok',
        'prose report: flow/brain/blueprint-report.md',
      ];

      expect(featureReportLine(lines)).toBe('Features: 2 capability feature(s)');
    });

    it('relays the fail-soft skip line too, whatever its case', () => {
      expect(featureReportLine(['features: bootstrap skipped (store busy)'])).toBe(
        'features: bootstrap skipped (store busy)',
      );
    });

    it('says NOTHING when derive adopted nothing — never "the board is empty"', () => {
      // Derive omits the line for a repo that names no capability. Silence is
      // the correct relay: the old code turned this same state into a claim
      // about the board that was false whenever derive had seeded it.
      const lines = ['validation: ok', 'prose report: flow/brain/blueprint-report.md'];

      expect(featureReportLine(lines)).toBeNull();
    });
  });
});
