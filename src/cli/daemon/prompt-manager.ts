/**
 * Prompt Manager
 *
 * Manages .heartbeat-prompt.md files for human-in-the-loop interaction
 * when a heartbeat task exits with code 2 (needs input) and autopilot is OFF.
 */

import { writeFile, rename, readFile, mkdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

const PROMPT_FILENAME = '.heartbeat-prompt.md';
const ARCHIVE_DIR = 'archive/heartbeat-prompts';

/**
 * Build the prompt markdown content.
 */
function buildPromptContent(
  taskName: string,
  outputTail: string,
  errorTail: string,
): string {
  const timestamp = new Date().toISOString();

  return `# Heartbeat Prompt

**Task**: ${taskName}
**Time**: ${timestamp}
**Status**: Waiting for input

## Context

The task "${taskName}" exited with code 2, indicating it needs human input.

### Last Output
\`\`\`
${outputTail || '(no output)'}
\`\`\`

### Error Output
\`\`\`
${errorTail || '(no errors)'}
\`\`\`

## Action Required

Please review the output above and either:
1. Open a new Claude session to resolve the issue
2. Edit this file with your response and the daemon will resume
`;
}

/**
 * Atomically write a prompt file to flow/.heartbeat-prompt.md.
 * Uses write-to-temp + rename for crash safety.
 */
export async function writePrompt(
  taskName: string,
  outputTail: string,
  errorTail: string,
  flowDir: string,
): Promise<void> {
  const content = buildPromptContent(taskName, outputTail, errorTail);
  const promptPath = join(flowDir, PROMPT_FILENAME);
  const tempPath = promptPath + '.tmp';

  await writeFile(tempPath, content, 'utf-8');
  await rename(tempPath, promptPath);
}

/**
 * Read the current prompt file contents.
 * Returns null if no prompt file exists.
 */
export async function readPrompt(flowDir: string): Promise<string | null> {
  try {
    const promptPath = join(flowDir, PROMPT_FILENAME);
    return await readFile(promptPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check whether a prompt file exists.
 */
export async function hasPrompt(flowDir: string): Promise<boolean> {
  try {
    const promptPath = join(flowDir, PROMPT_FILENAME);
    await stat(promptPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Archive the current prompt file to flow/archive/heartbeat-prompts/.
 * Creates the archive directory if it does not exist.
 * Removes the active prompt file after archiving.
 */
export async function archivePrompt(
  taskName: string,
  flowDir: string,
): Promise<void> {
  const promptPath = join(flowDir, PROMPT_FILENAME);
  const archiveDir = join(flowDir, ARCHIVE_DIR);

  // Read current content before archiving
  let content: string;
  try {
    content = await readFile(promptPath, 'utf-8');
  } catch {
    // No prompt file to archive
    return;
  }

  // Ensure archive directory exists
  await mkdir(archiveDir, { recursive: true });

  // Generate archive filename: prompt_{task}_{timestamp}.md
  const sanitizedTask = taskName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveFilename = `prompt_${sanitizedTask}_${timestamp}.md`;
  const archivePath = join(archiveDir, archiveFilename);

  await writeFile(archivePath, content, 'utf-8');
  await unlink(promptPath);
}
