/**
 * Tests for the brain CLI command.
 *
 * The surface is two verbs — `search` (the project knowledge front door) and
 * `migrate`. The index maintenance verbs (`ingest`, `rebuild`, `stats`,
 * `sync`) went with the `.brain.sqlite` index, and this asserts they are gone
 * rather than silently doing nothing: a script still calling `brain rebuild`
 * must be TOLD, not ignored.
 */

import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBrain } from './brain.js';

describe('brain CLI', () => {
  let projectRoot: string;
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let logSpy: ReturnType<typeof jest.spyOn>;

  function seed(relPath: string, content: string): void {
    const full = join(projectRoot, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'plan-flow-brain-test-'));
    seed(
      'flow/brain/decisions/dark-mode.md',
      '# Decisions\n\n## Dark mode toggle\n\nThe dark mode toggle is stored per project.\n',
    );
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function printed(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
  }

  describe('search', () => {
    it('exits with error when no query provided', async () => {
      await expect(runBrain('search', [], { target: projectRoot })).rejects.toThrow(
        'process.exit called',
      );
    });

    it('answers from the project markdown with the joined query args', async () => {
      await runBrain('search', ['dark', 'mode', 'toggle'], { target: projectRoot });

      const output = printed();
      expect(output).toContain('flow/brain/decisions/dark-mode.md');
      expect(output).toContain('Dark mode toggle');
      // The drill hint is the contract's last line, always.
      expect(output.trimEnd().split('\n').pop()).toMatch(
        /^drill: planflow-ai brain search "dark mode toggle" --full [0-9a-f]{8}$/,
      );
    });

    it('respects --limit', async () => {
      for (let n = 0; n < 6; n += 1) {
        seed(`flow/brain/decisions/mode-${n}.md`, `# M${n}\n\n## Mode ${n}\n\ndark mode toggle\n`);
      }

      await runBrain('search', ['dark mode toggle'], { target: projectRoot, limit: 2 });

      const numbered = printed().split('\n').filter((line) => /^\d+\. /.test(line));
      expect(numbered).toHaveLength(2);
    });
  });

  describe('retired index verbs', () => {
    it.each(['ingest', 'rebuild', 'stats', 'sync'])(
      '"%s" is refused by name, not silently ignored',
      async (action) => {
        await expect(runBrain(action, [], { target: projectRoot })).rejects.toThrow(
          'process.exit called',
        );
      },
    );
  });

  describe('unknown action', () => {
    it('exits with error for unknown action', async () => {
      await expect(runBrain('foobar', [], { target: projectRoot })).rejects.toThrow(
        'process.exit called',
      );
    });
  });
});
