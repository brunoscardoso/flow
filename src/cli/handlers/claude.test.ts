/**
 * Tests for Claude Code handler
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
import { jest } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock the prompts module to avoid interactive stdin in tests
jest.unstable_mockModule(resolve(__dirname, '../utils/prompts'), () => ({
  askLegacyFilesAction: jest.fn<() => Promise<string>>().mockResolvedValue('keep'),
  selectPlatforms: jest.fn<() => Promise<string[]>>().mockResolvedValue(['claude']),
}));

const { initClaude, isPlanFlowSourceRepo } = await import('./claude');
const { getPackageRoot } = await import('../utils/files');

function createTempDir(): string {
  const dir = join(tmpdir(), `plan-flow-claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * THE SOURCE OF THE TEMPLATE IS NOT A CONSUMER OF IT (#1951).
 *
 * Provisioning appended the managed block into plan-flow's own `CLAUDE.md`,
 * where the 546 lines above it already say the same things at greater length —
 * 14,472 bytes of duplication, re-read by every session and every sub-agent in
 * the repo. A hand edit could not hold it: deleting the block left no markers,
 * and no markers is exactly the branch that appends a fresh copy.
 */
describe('isPlanFlowSourceRepo', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  function write(rel: string, body: string): void {
    const full = join(tempDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf-8');
  }

  it('recognises the package by the same name getPackageRoot uses, plus the template it ships', () => {
    write('package.json', JSON.stringify({ name: 'planflow-ai' }));
    write('templates/shared/CLAUDE.md.template', '# managed');
    expect(isPlanFlowSourceRepo(tempDir)).toBe(true);
  });

  it('is false for a consuming project, which is every other project', () => {
    write('package.json', JSON.stringify({ name: 'some-app' }));
    expect(isPlanFlowSourceRepo(tempDir)).toBe(false);
  });

  it('is false for a project with no package.json at all', () => {
    expect(isPlanFlowSourceRepo(tempDir)).toBe(false);
  });

  it('is false for the installed package, which ships no templates/ directory', () => {
    // A `node_modules/planflow-ai` carries the name but is not a checkout, and
    // nothing provisions into it anyway — the claim being tested is "this is
    // where the block comes from", not "this is named planflow-ai".
    write('package.json', JSON.stringify({ name: 'planflow-ai' }));
    expect(isPlanFlowSourceRepo(tempDir)).toBe(false);
  });

  it('is false, not a crash, for an unreadable package.json', () => {
    write('package.json', '{ not json');
    write('templates/shared/CLAUDE.md.template', '# managed');
    expect(isPlanFlowSourceRepo(tempDir)).toBe(false);
  });
});

describe('initClaude', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('does not splice the managed section into plan-flow’s own repo', async () => {
    const own = '# Plan-Flow\n\nThe long form, written by hand.\n';
    writeFileSync(join(tempDir, 'CLAUDE.md'), own, 'utf-8');
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'planflow-ai' }), 'utf-8');
    mkdirSync(join(tempDir, 'templates', 'shared'), { recursive: true });
    writeFileSync(join(tempDir, 'templates', 'shared', 'CLAUDE.md.template'), '# managed', 'utf-8');

    await initClaude(tempDir, { force: false });

    // Byte for byte: the file is not ours to touch here.
    expect(readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8')).toBe(own);
    expect(readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8')).not.toContain('<!-- plan-flow-start -->');
  });

  it('does not re-add the section under --force either', async () => {
    // The branch a refresh takes. Without this, every provision undoes the
    // deletion that fixed the duplication in the first place.
    const own = '# Plan-Flow\n\nThe long form.\n';
    writeFileSync(join(tempDir, 'CLAUDE.md'), own, 'utf-8');
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'planflow-ai' }), 'utf-8');
    mkdirSync(join(tempDir, 'templates', 'shared'), { recursive: true });
    writeFileSync(join(tempDir, 'templates', 'shared', 'CLAUDE.md.template'), '# managed', 'utf-8');

    await initClaude(tempDir, { force: true });

    expect(readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8')).toBe(own);
  });

  it('still splices it into a consuming project — the common case is unchanged', async () => {
    const own = '# My App\n\nHouse rules.\n';
    writeFileSync(join(tempDir, 'CLAUDE.md'), own, 'utf-8');
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'my-app' }), 'utf-8');

    await initClaude(tempDir, { force: false });

    const after = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('<!-- plan-flow-start -->');
    expect(after).toContain('House rules.');
  });

  it('should copy commands to .claude/commands/', async () => {
    const result = await initClaude(tempDir, { force: false });

    const commandsDir = join(tempDir, '.claude', 'commands');
    expect(existsSync(commandsDir)).toBe(true);

    // Should have created some files
    expect(result.created.length).toBeGreaterThan(0);

    // Check that a known command file was copied
    const setupCmd = join(commandsDir, 'setup.md');
    expect(existsSync(setupCmd)).toBe(true);
  });

  it('should copy rules and resources preserving subdirectory structure', async () => {
    const result = await initClaude(tempDir, { force: false });

    const rulesDir = join(tempDir, '.claude', 'rules');
    expect(existsSync(rulesDir)).toBe(true);
    expect(existsSync(join(rulesDir, 'core'))).toBe(true);

    // Resources are in .claude/resources/ (v2 layout)
    const resourcesDir = join(tempDir, '.claude', 'resources');
    expect(existsSync(resourcesDir)).toBe(true);
    expect(existsSync(join(resourcesDir, 'patterns'))).toBe(true);
  });

  it('should create CLAUDE.md from template when none exists', async () => {
    await initClaude(tempDir, { force: false });

    const claudeMd = join(tempDir, 'CLAUDE.md');
    expect(existsSync(claudeMd)).toBe(true);

    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('<!-- plan-flow-start -->');
    expect(content).toContain('<!-- plan-flow-end -->');
    expect(content).toContain('Plan-Flow');
  });

  it('should append plan-flow section to existing CLAUDE.md without duplicating', async () => {
    const claudeMd = join(tempDir, 'CLAUDE.md');
    writeFileSync(claudeMd, '# My Project\n\nExisting content here.\n');

    await initClaude(tempDir, { force: false });

    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Existing content here.');
    expect(content).toContain('<!-- plan-flow-start -->');
    expect(content).toContain('<!-- plan-flow-end -->');
  });

  it('should not duplicate plan-flow section if already present', async () => {
    const claudeMd = join(tempDir, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      '# My Project\n\n<!-- plan-flow-start -->\nOld content\n<!-- plan-flow-end -->\n'
    );

    const result = await initClaude(tempDir, { force: false });

    const content = readFileSync(claudeMd, 'utf-8');
    // Should have skipped
    expect(result.skipped.some((f) => f.endsWith('CLAUDE.md'))).toBe(true);
    // Content should be unchanged
    expect(content).toContain('Old content');
  });

  it('should update plan-flow section with --force', async () => {
    const claudeMd = join(tempDir, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      '# My Project\n\n<!-- plan-flow-start -->\nOld content\n<!-- plan-flow-end -->\n'
    );

    const result = await initClaude(tempDir, { force: true });

    const content = readFileSync(claudeMd, 'utf-8');
    expect(result.updated.some((f) => f.endsWith('CLAUDE.md'))).toBe(true);
    // Should no longer contain old content (replaced with template)
    expect(content).not.toContain('Old content');
    expect(content).toContain('<!-- plan-flow-start -->');
    expect(content).toContain('<!-- plan-flow-end -->');
  });

  it('should skip existing command files without --force', async () => {
    // First install
    await initClaude(tempDir, { force: false });

    // Second install
    const result = await initClaude(tempDir, { force: false });

    // All files should be skipped
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.created).toHaveLength(0);
  });

  describe('hooks installation', () => {
    it('should copy all hook scripts to .claude/hooks/', async () => {
      await initClaude(tempDir, { force: false });

      const hooksDir = join(tempDir, '.claude', 'hooks');
      expect(existsSync(hooksDir)).toBe(true);
      expect(existsSync(join(hooksDir, 'cost-tracker.cjs'))).toBe(true);
      expect(existsSync(join(hooksDir, 'cost-display.cjs'))).toBe(true);
      expect(existsSync(join(hooksDir, 'suggest-compact.cjs'))).toBe(true);
      expect(existsSync(join(hooksDir, 'pre-compact-save.cjs'))).toBe(true);
      expect(existsSync(join(hooksDir, 'session-summary.cjs'))).toBe(true);
    });

    it('should register all hooks in .claude/settings.json', async () => {
      await initClaude(tempDir, { force: false });

      const settingsPath = join(tempDir, '.claude', 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();
      expect(settings.hooks.PreCompact).toBeDefined();
      expect(settings.hooks.SessionEnd).toBeDefined();

      // Verify Stop hooks: cost-tracker (async), cost-display (sync), suggest-compact (sync)
      // All wrapped with guard: test -f <script> && node <script> || true
      expect(settings.hooks.Stop.length).toBe(3);
      expect(settings.hooks.Stop[0].hooks[0].command).toContain('cost-tracker.cjs');
      expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/^test -f .+ && node .+ \|\| true$/);
      expect(settings.hooks.Stop[0].hooks[0].async).toBe(true);
      expect(settings.hooks.Stop[1].hooks[0].command).toContain('cost-display.cjs');
      expect(settings.hooks.Stop[1].hooks[0].command).toMatch(/^test -f .+ && node .+ \|\| true$/);
      expect(settings.hooks.Stop[2].hooks[0].command).toContain('suggest-compact.cjs');
      expect(settings.hooks.Stop[2].hooks[0].command).toMatch(/^test -f .+ && node .+ \|\| true$/);

      // Verify PreCompact hook
      expect(settings.hooks.PreCompact.length).toBe(1);
      expect(settings.hooks.PreCompact[0].hooks[0].command).toContain('pre-compact-save.cjs');
      expect(settings.hooks.PreCompact[0].hooks[0].command).toMatch(/^test -f .+ && node .+ \|\| true$/);

      // Verify SessionEnd hook
      expect(settings.hooks.SessionEnd.length).toBe(1);
      expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('session-summary.cjs');
      expect(settings.hooks.SessionEnd[0].hooks[0].command).toMatch(/^test -f .+ && node .+ \|\| true$/);
    });

    it('should preserve existing hooks in settings.json', async () => {
      mkdirSync(join(tempDir, '.claude'), { recursive: true });
      writeFileSync(
        join(tempDir, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            Stop: [{
              hooks: [{ type: 'command', command: 'my-custom-hook.sh' }],
            }],
          },
          otherSetting: true,
        }, null, 2),
        'utf-8'
      );

      await initClaude(tempDir, { force: false });

      const settings = JSON.parse(
        readFileSync(join(tempDir, '.claude', 'settings.json'), 'utf-8')
      );

      // Existing hook + cost-tracker + cost-display + suggest-compact = 4
      expect(settings.hooks.Stop.length).toBe(4);
      expect(settings.hooks.Stop[0].hooks[0].command).toBe('my-custom-hook.sh');
      expect(settings.hooks.Stop[1].hooks[0].command).toContain('cost-tracker.cjs');
      expect(settings.hooks.Stop[2].hooks[0].command).toContain('cost-display.cjs');
      expect(settings.hooks.Stop[3].hooks[0].command).toContain('suggest-compact.cjs');

      // Other settings preserved
      expect(settings.otherSetting).toBe(true);
    });

    it('should not duplicate hooks on repeated init', async () => {
      await initClaude(tempDir, { force: false });
      await initClaude(tempDir, { force: false });

      const settings = JSON.parse(
        readFileSync(join(tempDir, '.claude', 'settings.json'), 'utf-8')
      );

      // 3 Stop hooks, 1 PreCompact, 1 SessionEnd — no duplicates
      expect(settings.hooks.Stop.length).toBe(3);
      expect(settings.hooks.PreCompact.length).toBe(1);
      expect(settings.hooks.SessionEnd.length).toBe(1);
    });
  });
});
