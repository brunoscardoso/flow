/**
 * Subprocess E2E for `planflow-ai guard classify` — spawns the REAL CLI entry
 * (via tsx, matching plan.test.ts) and asserts the decision contract.
 *
 * Scenarios:
 *   (a) `--action` JSON for each kind → decision JSON on stdout, exit 0
 *   (b) stdin fallback (no `--action`) → same decision, exit 0
 *   (c) malformed / unknown-kind action → COMBINED stdout+stderr carries
 *       `guard refused:` (allowed-pattern #15 — this CLI routes error() through
 *       console.log), exit 1
 *   (d) determinism — the same action yields a byte-identical decision line
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const E2E_TIMEOUT_MS = 120_000;

interface CliRun {
  stdout: string;
  stderr: string;
  combined: string;
  status: number | null;
}

function run(args: string[], input?: string): CliRun {
  const result = spawnSync(process.execPath, [TSX_BIN, CLI_ENTRY, 'guard', 'classify', ...args], {
    encoding: 'utf-8',
    timeout: E2E_TIMEOUT_MS,
    input: input ?? '',
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, combined: `${stdout}\n${stderr}`, status: result.status };
}

describe('guard classify E2E — real CLI subprocess', () => {
  it(
    '(a) --action for each kind → decision JSON on stdout, exit 0',
    () => {
      const cases: Array<[string, string]> = [
        ['{"kind":"push","remote":"origin","branch":"feat/x"}', 'ask'],
        ['{"kind":"commit"}', 'allow'],
        ['{"kind":"delete","path":"/etc/x","insideWorktree":false}', 'ask'],
        ['{"kind":"bash","command":"jest --watch"}', 'consult'],
      ];
      for (const [action, verdict] of cases) {
        const result = run(['--action', action]);
        expect(result.status).toBe(0);
        const decision = JSON.parse(result.stdout.trim());
        expect(decision.verdict).toBe(verdict);
        expect(typeof decision.category).toBe('string');
        expect(typeof decision.reason).toBe('string');
      }
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '(b) stdin fallback → same decision, exit 0',
    () => {
      const result = run([], '{"kind":"push"}');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim()).verdict).toBe('ask');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '(c) malformed / unknown-kind → "guard refused:" on the combined transcript, exit 1',
    () => {
      const malformed = run(['--action', '{not json']);
      expect(malformed.status).toBe(1);
      expect(malformed.combined).toContain('guard refused:');

      const unknown = run(['--action', '{"kind":"nuke"}']);
      expect(unknown.status).toBe(1);
      expect(unknown.combined).toContain('guard refused:');

      const empty = run([], '');
      expect(empty.status).toBe(1);
      expect(empty.combined).toContain('guard refused:');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '(d) determinism — same action, byte-identical decision line',
    () => {
      const action = '{"kind":"bash","command":"git push origin main"}';
      expect(run(['--action', action]).stdout).toBe(run(['--action', action]).stdout);
    },
    E2E_TIMEOUT_MS,
  );
});
