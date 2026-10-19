/**
 * Tests for prompt-manager — write, read, archive, hasPrompt, atomic write safety
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePrompt, readPrompt, hasPrompt, archivePrompt } from './prompt-manager.js';

describe('prompt-manager', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'prompt-manager-test-'));
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  describe('writePrompt', () => {
    it('should create a prompt file with task name and context', async () => {
      await writePrompt('research', 'last output line', 'some error', flowDir);

      const content = await readPrompt(flowDir);
      expect(content).not.toBeNull();
      expect(content).toContain('# Heartbeat Prompt');
      expect(content).toContain('**Task**: research');
      expect(content).toContain('last output line');
      expect(content).toContain('some error');
    });

    it('should handle empty output and error tails', async () => {
      await writePrompt('my-task', '', '', flowDir);

      const content = await readPrompt(flowDir);
      expect(content).toContain('(no output)');
      expect(content).toContain('(no errors)');
    });

    it('should use atomic write (no .tmp file left behind)', async () => {
      await writePrompt('task-a', 'output', 'error', flowDir);

      const tmpPath = join(flowDir, '.heartbeat-prompt.md.tmp');
      expect(existsSync(tmpPath)).toBe(false);

      // The actual file should exist
      expect(await hasPrompt(flowDir)).toBe(true);
    });

    it('should overwrite an existing prompt file', async () => {
      await writePrompt('task-old', 'old output', 'old error', flowDir);
      await writePrompt('task-new', 'new output', 'new error', flowDir);

      const content = await readPrompt(flowDir);
      expect(content).toContain('task-new');
      expect(content).not.toContain('task-old');
    });
  });

  describe('readPrompt', () => {
    it('should return null when no prompt file exists', async () => {
      const result = await readPrompt(flowDir);
      expect(result).toBeNull();
    });

    it('should return the prompt content when file exists', async () => {
      await writePrompt('my-task', 'output', 'errors', flowDir);

      const result = await readPrompt(flowDir);
      expect(result).not.toBeNull();
      expect(result).toContain('my-task');
    });
  });

  describe('hasPrompt', () => {
    it('should return false when no prompt file exists', async () => {
      expect(await hasPrompt(flowDir)).toBe(false);
    });

    it('should return true when a prompt file exists', async () => {
      await writePrompt('task', 'out', 'err', flowDir);
      expect(await hasPrompt(flowDir)).toBe(true);
    });
  });

  describe('archivePrompt', () => {
    it('should move the prompt to the archive directory', async () => {
      await writePrompt('research', 'output data', 'error data', flowDir);
      expect(await hasPrompt(flowDir)).toBe(true);

      await archivePrompt('research', flowDir);

      // Active prompt should be gone
      expect(await hasPrompt(flowDir)).toBe(false);

      // Archive directory should have a file
      const archiveDir = join(flowDir, 'archive', 'heartbeat-prompts');
      expect(existsSync(archiveDir)).toBe(true);

      const files = await readdir(archiveDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^prompt_research_/);
      expect(files[0]).toMatch(/\.md$/);
    });

    it('should do nothing if no prompt file exists', async () => {
      // Should not throw
      await archivePrompt('nonexistent', flowDir);
      expect(await hasPrompt(flowDir)).toBe(false);
    });

    it('should preserve prompt content in the archived file', async () => {
      await writePrompt('my-task', 'important output', 'critical error', flowDir);
      await archivePrompt('my-task', flowDir);

      const archiveDir = join(flowDir, 'archive', 'heartbeat-prompts');
      const files = await readdir(archiveDir);
      const { readFile } = await import('node:fs/promises');
      const archivedContent = await readFile(join(archiveDir, files[0]), 'utf-8');

      expect(archivedContent).toContain('my-task');
      expect(archivedContent).toContain('important output');
      expect(archivedContent).toContain('critical error');
    });

    it('should sanitize task name in archive filename', async () => {
      await writePrompt('my task/with:special.chars', 'out', 'err', flowDir);
      await archivePrompt('my task/with:special.chars', flowDir);

      const archiveDir = join(flowDir, 'archive', 'heartbeat-prompts');
      const files = await readdir(archiveDir);
      expect(files).toHaveLength(1);
      // Special chars should be replaced with underscores
      expect(files[0]).toMatch(/^prompt_my_task_with_special_chars_/);
    });
  });

  describe('full lifecycle', () => {
    it('should support write -> hasPrompt -> read -> archive -> hasPrompt(false)', async () => {
      // 1. Write
      await writePrompt('lifecycle-task', 'some output', 'some errors', flowDir);

      // 2. hasPrompt = true
      expect(await hasPrompt(flowDir)).toBe(true);

      // 3. Read
      const content = await readPrompt(flowDir);
      expect(content).toContain('lifecycle-task');

      // 4. Archive
      await archivePrompt('lifecycle-task', flowDir);

      // 5. hasPrompt = false
      expect(await hasPrompt(flowDir)).toBe(false);

      // 6. readPrompt = null
      expect(await readPrompt(flowDir)).toBeNull();
    });
  });
});
