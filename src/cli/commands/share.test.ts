/**
 * Tests for `planflow-ai share` — the CLI face of the knowledge-sharing switch.
 *
 * The switch itself (persist + regenerate + report) is covered in
 * src/cli/handlers/shared.test.ts; these pin the command's contract: it reports,
 * it refuses cleanly, and it never invents a mode.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';

const { runShare } = await import('./share');

function createTempDir(): string {
  const dir = join(tmpdir(), `plan-flow-share-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('runShare', () => {
  let tempDir: string;
  let output: string;

  beforeEach(() => {
    tempDir = createTempDir();
    output = '';
    // This CLI's logger routes error() through console.log, so the combined
    // transcript IS console.log (allowed-pattern #15).
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output += `${args.join(' ')}\n`;
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('with no mode, reports the current setting and marks an unanswered project as such', () => {
    runShare(undefined, { target: tempDir });

    expect(output).toContain('share: local');
    expect(output).toContain('unanswered');
    // A report writes nothing.
    expect(existsSync(join(tempDir, '.gitignore'))).toBe(false);
    expect(existsSync(join(tempDir, 'flow', '.flowconfig'))).toBe(false);
  });

  it('refuses an unknown mode with exit 1 and writes nothing', () => {
    runShare('public', { target: tempDir });

    expect(output).toContain('share refused: unknown mode "public"');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(tempDir, '.gitignore'))).toBe(false);
    expect(existsSync(join(tempDir, 'flow', '.flowconfig'))).toBe(false);
  });

  it('applies a switch, persists it, and reports the direction', () => {
    mkdirSync(join(tempDir, 'flow', 'brain', 'features'), { recursive: true });
    writeFileSync(join(tempDir, 'flow', 'brain', 'features', 'checkout.md'), '# Checkout\n', 'utf-8');

    runShare('shared', { target: tempDir });

    expect(output).toContain('share: local → shared');
    expect(output).toContain('now trackable');
    expect(output).toContain('flow/brain/features/checkout.md');
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(join(tempDir, 'flow', '.flowconfig'), 'utf-8')).toMatch(/^share: shared$/m);
    expect(readFileSync(join(tempDir, '.gitignore'), 'utf-8').split('\n')).not.toContain('/flow');
  });

  it('re-applying the same mode reports a no-op', () => {
    runShare('shared', { target: tempDir });
    output = '';

    runShare('shared', { target: tempDir });

    expect(output).toContain('already shared');
    expect(output).toContain('nothing to change');
  });

  it('re-applying the same mode still RESTORES a hand-edited block', () => {
    runShare('shared', { target: tempDir });
    writeFileSync(join(tempDir, '.gitignore'), '# >>> plan-flow\n/flow\n# <<< plan-flow\n', 'utf-8');
    output = '';

    runShare('shared', { target: tempDir });

    // The block is generated from the setting — re-running is the fix for a
    // hand edit, which is exactly why hand-editing it is never the fix.
    expect(output).toContain('already shared');
    expect(readFileSync(join(tempDir, '.gitignore'), 'utf-8')).toContain('flow/brain/.structure/graph.json');
  });

  it('says WHY a token-carrying .flowconfig stays ignored when switching to shared', () => {
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
    writeFileSync(
      join(tempDir, 'flow', '.flowconfig'),
      'autopilot: false\ntelegram_bot_token: 123456:ABC-DEF\n',
      'utf-8'
    );

    runShare('shared', { target: tempDir });

    expect(output).toContain('telegram_bot_token');
    expect(output).toContain('stays ignored');
    // The credential is out of git, and the mode still travels in the block.
    expect(readFileSync(join(tempDir, '.gitignore'), 'utf-8')).toContain('flow/.flowconfig');
    expect(readFileSync(join(tempDir, '.gitignore'), 'utf-8')).toContain('# Knowledge sharing: shared');
    // Reported on, never edited.
    expect(readFileSync(join(tempDir, 'flow', '.flowconfig'), 'utf-8')).toContain('telegram_bot_token: 123456:ABC-DEF');
  });
});
