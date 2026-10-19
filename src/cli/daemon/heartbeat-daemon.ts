#!/usr/bin/env node
/**
 * Heartbeat Daemon
 *
 * A detached Node.js process that reads flow/heartbeat.md,
 * schedules tasks, and spawns Claude Code CLI to execute them.
 *
 * This file is the bootstrap only: it owns the PID file, the log file, the
 * heartbeat.md watcher and the real fs/spawn/timer dependencies. The
 * scheduling and execution logic lives in `task-runner.ts`, where it is
 * testable without spawning a real Claude Code process.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, watch, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseHeartbeatFile } from './heartbeat-parser.js';
import { notify } from './notification-router.js';
import { writePrompt } from './prompt-manager.js';
import { createTaskRunner, PROMPT_FILENAME } from './task-runner.js';
import { oneLogLine } from './log-line.js';
import {
  readInstalledVersion,
  removeVersionSidecar,
  writeVersionSidecar,
} from './version-sidecar.js';

const target = process.argv[2] || process.cwd();
const heartbeatPath = join(target, 'flow', 'heartbeat.md');
const pidPath = join(target, 'flow', '.heartbeat.pid');
const logPath = join(target, 'flow', '.heartbeat.log');

const flowDir = join(target, 'flow');

/**
 * Read the autopilot setting from flow/.flowconfig.
 * Returns true if autopilot is enabled, false otherwise.
 */
function readAutopilot(): boolean {
  try {
    const configPath = join(flowDir, '.flowconfig');
    if (!existsSync(configPath)) return false;
    const content = readFileSync(configPath, 'utf-8');
    const match = content.match(/^autopilot:\s*(true|false)/m);
    return match?.[1] === 'true';
  } catch {
    return false;
  }
}

/**
 * Append ONE physical line to `.heartbeat.log`.
 *
 * `oneLogLine` is applied here rather than trusted to callers (#1803): the log
 * is line-oriented, every reader counts lines, and a caller handing this a
 * multi-line agent message turned one event into a dozen lines with a timestamp
 * on only the first — which is how `truncateLog`'s 500-line window came to hold
 * 126 events, and how "Recent log" came to show the middle of a markdown table.
 */
function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${oneLogLine(message)}\n`;
  appendFileSync(logPath, line, 'utf-8');
  truncateLog();
}

/**
 * Keep the last 500 lines — which, now that one event is one line, is the ~500
 * events this always meant to keep.
 */
function truncateLog(): void {
  try {
    const stat = statSync(logPath);
    if (stat.size > 100_000) {
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');
      const kept = lines.slice(-500).join('\n');
      writeFileSync(logPath, kept, 'utf-8');
    }
  } catch {
    // ignore
  }
}

function disableOneShotTask(taskName: string): void {
  try {
    if (!existsSync(heartbeatPath)) return;
    const content = readFileSync(heartbeatPath, 'utf-8');
    // Find the task section and replace Enabled: true with Enabled: false
    const taskPattern = new RegExp(
      `(###\\s+${taskName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\*\\*Enabled\\*\\*:\\s*)true`,
      'i'
    );
    const updated = content.replace(taskPattern, '$1false');
    if (updated !== content) {
      writeFileSync(heartbeatPath, updated, 'utf-8');
      log(`One-shot task "${taskName}" disabled after execution`);
    }
  } catch (err) {
    log(`Failed to disable one-shot task "${taskName}": ${(err as Error).message}`);
  }
}

const runner = createTaskRunner({
  target,
  flowDir,
  spawn,
  log,
  notify,
  writePrompt,
  readAutopilot,
  promptFileExists: () => existsSync(join(flowDir, PROMPT_FILENAME)),
  disableOneShotTask,
});

function loadAndSchedule(): void {
  runner.clearTimers();

  if (!existsSync(heartbeatPath)) {
    log('No heartbeat.md found');
    return;
  }

  const content = readFileSync(heartbeatPath, 'utf-8');
  const tasks = parseHeartbeatFile(content);

  log(`Loaded ${tasks.length} task(s)`);

  for (const task of tasks) {
    runner.scheduleTask(task);
  }
}

function cleanup(): void {
  log('Daemon shutting down');
  runner.clearTimers();

  try {
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
  } catch {
    // ignore
  }

  // The version sidecar describes THIS daemon — it dies with the pid file.
  removeVersionSidecar(target);

  process.exit(0);
}

// --- Main ---

// Write PID file + the version sidecar that says which code this daemon runs
const daemonVersion = readInstalledVersion();
writeFileSync(pidPath, String(process.pid), 'utf-8');
writeVersionSidecar(target, daemonVersion);
log(`Daemon started (PID: ${process.pid}, version ${daemonVersion})`);

// Signal handlers
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Initial load
loadAndSchedule();

// Watch for file changes with debounce
let debounceTimer: NodeJS.Timeout | null = null;

try {
  watch(heartbeatPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      log('heartbeat.md changed — reloading');
      loadAndSchedule();
    }, 1000);
  });
} catch {
  log('Warning: could not watch heartbeat.md for changes');
}

// Keepalive: refresh PID file every 5 minutes so stale detection works
const KEEPALIVE_MS = 5 * 60 * 1000;
setInterval(() => {
  try {
    writeFileSync(pidPath, String(process.pid), 'utf-8');
  } catch {
    // ignore
  }
  // Keep the sidecar in lockstep with the pid file it annotates.
  writeVersionSidecar(target, daemonVersion);
}, KEEPALIVE_MS);

// Handle uncaught errors gracefully — log and continue
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${String(reason)}`);
});
