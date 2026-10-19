#!/usr/bin/env node
'use strict';

/**
 * Pre-Compact State Saver — PreCompact Hook
 *
 * Fires before Claude Code compacts the conversation (auto or manual).
 * Saves session state to ~/.claude/metrics/precompact-{session_id}.md
 * so the LLM can reference it after compaction to resume work.
 *
 * Captures:
 *   - Active tasklist items (from flow/tasklist.md)
 *   - Files modified in this session (from transcript tool_use entries)
 *   - Active plan reference (if in /execute-plan)
 *   - Trigger type (auto/manual) and custom instructions
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const METRICS_DIR = path.join(os.homedir(), '.claude', 'metrics');
const MAX_TRANSCRIPT_LINES = 500;

function extractTasklistItems(cwd) {
  const tasklistPath = path.join(cwd, 'flow', 'tasklist.md');
  if (!fs.existsSync(tasklistPath)) return [];

  try {
    const content = fs.readFileSync(tasklistPath, 'utf-8');
    const lines = content.split('\n');
    const items = [];
    let inProgress = false;

    for (const line of lines) {
      if (line.startsWith('## In Progress')) {
        inProgress = true;
        continue;
      }
      if (line.startsWith('## ') && inProgress) {
        break;
      }
      if (inProgress && line.trim().startsWith('- [')) {
        items.push(line.trim());
      }
    }

    return items;
  } catch {
    return [];
  }
}

function extractModifiedFiles(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');
    const files = new Set();

    // Scan last N lines for performance
    const startIdx = Math.max(0, lines.length - MAX_TRANSCRIPT_LINES);

    for (let i = startIdx; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message && entry.message.content) {
          const blocks = Array.isArray(entry.message.content)
            ? entry.message.content
            : [entry.message.content];

          for (const block of blocks) {
            if (block.type === 'tool_use') {
              const name = block.name || '';
              const input = block.input || {};

              // Write/Edit tools have file_path
              if ((name === 'Write' || name === 'Edit') && input.file_path) {
                files.add(input.file_path);
              }
              // Bash tool might create files but we can't reliably detect that
            }
          }
        }
      } catch { /* skip */ }
    }

    return Array.from(files);
  } catch {
    return [];
  }
}

function findActivePlan(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    // Look for plan file references in the transcript
    const planMatch = content.match(/flow\/plans\/plan_[a-z0-9_]+_v\d+\.md/);
    return planMatch ? planMatch[0] : null;
  } catch {
    return null;
  }
}

async function main() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString());

    const sessionId = input.session_id || 'unknown';
    const transcriptPath = input.transcript_path;
    const trigger = input.trigger || 'unknown';
    const customInstructions = input.custom_instructions || '';
    const cwd = input.cwd || process.cwd();

    // Gather state
    const tasklistItems = extractTasklistItems(cwd);
    const modifiedFiles = extractModifiedFiles(transcriptPath);
    const activePlan = findActivePlan(transcriptPath);

    // Build state document
    const lines = [
      '# Pre-Compact State',
      '',
      `**Session**: ${sessionId}`,
      `**Timestamp**: ${new Date().toISOString()}`,
      `**Trigger**: ${trigger}`,
      `**Project**: ${path.basename(cwd)}`,
    ];

    if (customInstructions) {
      lines.push(`**Custom Instructions**: ${customInstructions}`);
    }

    lines.push('');

    if (activePlan) {
      lines.push('## Active Plan');
      lines.push('');
      lines.push(`Currently executing: \`${activePlan}\``);
      lines.push('');
    }

    if (tasklistItems.length > 0) {
      lines.push('## In-Progress Tasks');
      lines.push('');
      for (const item of tasklistItems) {
        lines.push(item);
      }
      lines.push('');
    }

    if (modifiedFiles.length > 0) {
      lines.push('## Files Modified This Session');
      lines.push('');
      for (const file of modifiedFiles) {
        lines.push(`- \`${file}\``);
      }
      lines.push('');
    }

    if (tasklistItems.length === 0 && modifiedFiles.length === 0 && !activePlan) {
      lines.push('_No significant state to preserve._');
      lines.push('');
    }

    // Write state file
    fs.mkdirSync(METRICS_DIR, { recursive: true });
    const statePath = path.join(METRICS_DIR, `precompact-${sessionId}.md`);
    fs.writeFileSync(statePath, lines.join('\n'), 'utf-8');

    process.stderr.write(`\x1b[2m⟐ Session state saved before compaction → ${statePath}\x1b[0m\n`);
  } catch {
    // Never fail
  }

  process.exit(0);
}

main();
