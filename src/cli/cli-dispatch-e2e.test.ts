/**
 * Live E2E for the CLI's top-level dispatch — the REAL built binary
 * (`dist/cli/index.js`) as a subprocess.
 *
 * `init` is registered `{ isDefault: true }`, which is right for the documented
 * bare invocation (`npx plan-flow` opens the interactive install) but which
 * commander applies to ANY argv it cannot match. So a mistyped verb ran a full
 * install in whatever directory the user was standing in — 103 files, a
 * rewritten `.gitignore`, an entry in the GLOBAL Obsidian vault and a detached
 * heartbeat daemon, two of which survive `rm -rf` on the directory — and exited
 * 0, so every scripted caller read it as success (#1830).
 *
 * That is the SECOND incident from this fall-through; the first is recorded in
 * `index.ts` beside the `parse` call, where a wrong argv mode made "every verb
 * stop matching" and "the interactive default (init) run instead".
 *
 * WHAT THESE TESTS ACTUALLY CHECK. A refusal that still installs is exactly the
 * wrong-but-quiet install this guard exists to stop, so every refusal case
 * asserts the transcript AND the absence of the side effect (allowed-pattern
 * #24): exit 1, one `refused:` line, and NOT ONE FILE written.
 *
 * NOTHING HERE PROVISIONS. Every case is a refusal, so no test needs the
 * install path — which is deliberate, because a passing init writes to the
 * user's real `~/plan-flow` vault and leaves a background daemon behind. The
 * positive shapes (bare, flags-only, explicit `init`) are covered by the
 * init suites that already own that setup and teardown; here they would be a
 * test that litters a developer's machine to prove a negative.
 *
 * Assertions read stdout+stderr COMBINED — this CLI's logger routes `error()`
 * through `console.log` (allowed-pattern #15).
 */

import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The shipped entry point, not the source. */
const CLI = resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');

interface Run {
  status: number | null;
  /** stdout+stderr, because `error()` goes to stdout here. */
  out: string;
}

/**
 * Run the built CLI inside the sandbox.
 *
 * An explicit `cwd` inside the temp dir, always — a bare invocation of this CLI
 * provisions whatever directory it is standing in, and cwd drifting into this
 * repository is a lesson already paid for once.
 */
function runCli(sandbox: string, args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: sandbox,
    encoding: 'utf-8',
    input: '',
    env: { ...process.env },
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

describe('an unrecognized verb refuses and writes nothing (#1830)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'plan-flow-dispatch-e2e-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: sandbox });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** Everything in the sandbox except git's own directory. */
  function entries(): string[] {
    return readdirSync(sandbox).filter((name) => name !== '.git');
  }

  it.each([
    ['a word that names nothing', ['not-a-real-command']],
    ['a typo of a real verb', ['bluprint', 'derive']],
    // How this was actually found: a caller passed one quoted string where the
    // shell would normally have word-split into two arguments.
    ['a quoted argument the shell did not split', ['blueprint gate-check']],
  ])('%s: exit 1, one refusal line, nothing written', (_label, args) => {
    const run = runCli(sandbox, args);

    expect(run.status).toBe(1);
    expect(run.out).toContain('plan-flow refused: unknown command');
    // THE HALF THAT MATTERS. A loud refusal that installs anyway is the bug.
    expect(entries()).toEqual([]);
    expect(run.out).not.toContain('Plan-Flow Setup');
    expect(run.out).not.toContain('Heartbeat daemon started');
  });

  it('names the argument it did not recognize, so the typo is visible', () => {
    const run = runCli(sandbox, ['bluprint', 'derive']);
    expect(run.out).toContain("unknown command 'bluprint'");
  });

  it('a KNOWN verb keeps its own refusal contract', () => {
    // The guard must not intercept a verb that exists and refuses for its own
    // reasons — that refusal is the verb's to word.
    const run = runCli(sandbox, ['blueprint', 'gate-check']);

    expect(run.status).toBe(1);
    expect(run.out).toContain('gate-check refused:');
    expect(run.out).not.toContain('unknown command');
    expect(entries()).toEqual([]);
  });

  it('--version and --help still answer, and install nothing', () => {
    // A leading `-` is never a verb, so the guard must not see these at all.
    const version = runCli(sandbox, ['--version']);
    expect(version.status).toBe(0);
    expect(version.out).toMatch(/\d+\.\d+\.\d+/);

    const help = runCli(sandbox, ['--help']);
    expect(help.status).toBe(0);
    expect(help.out).toContain('init');

    expect(entries()).toEqual([]);
  });

  it('does not mistake an OPTION VALUE for a verb', () => {
    // The first cut of this guard scanned for the first non-flag argument,
    // which reads `--target /some/path` as the verb `/some/path` and refuses a
    // legitimate flags-only install. `init` takes no positional arguments, so
    // only argv[2] can be a verb — this pins that.
    const run = runCli(sandbox, ['--target', sandbox, '--help']);
    expect(run.out).not.toContain('unknown command');
  });
});
