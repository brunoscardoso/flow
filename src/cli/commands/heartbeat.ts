/**
 * Heartbeat CLI command
 *
 * Manages the heartbeat daemon: start, stop, status.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import * as log from '../utils/logger.js';
import { backgroundWorkDisabled } from '../utils/background-work.js';
import { isDaemonEvent } from '../daemon/log-line.js';
import {
  checkVersionDrift,
  readInstalledVersion,
  removeVersionSidecar,
  versionLabel,
} from '../daemon/version-sidecar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Wait after spawning before reading the pid file the daemon writes. */
const DAEMON_BOOT_WAIT_MS = 500;

/** How long to wait for a stopped daemon's PID to actually clear. */
const PID_CLEAR_TIMEOUT_MS = 5_000;

/** Poll interval while waiting for the PID to clear. */
const PID_CLEAR_POLL_MS = 100;

/** Bounded number of polls — a daemon that will not die degrades to a notice. */
const PID_CLEAR_MAX_POLLS = Math.ceil(PID_CLEAR_TIMEOUT_MS / PID_CLEAR_POLL_MS);

function getPidPath(target: string): string {
  return join(target, 'flow', '.heartbeat.pid');
}

function getDaemonPath(): string {
  return join(__dirname, '..', 'daemon', 'heartbeat-daemon.js');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(target: string): number | null {
  const pidPath = getPidPath(target);
  if (!existsSync(pidPath)) return null;

  try {
    const pidStr = readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * Remove the pid file AND the version sidecar that annotates it.
 *
 * Single code path (allowed-pattern #14): the sidecar is cleaned wherever the
 * pid is cleaned, so a stale sidecar can never describe a daemon that is gone.
 */
function cleanStalePid(target: string): void {
  const pidPath = getPidPath(target);
  if (existsSync(pidPath)) {
    try {
      unlinkSync(pidPath);
    } catch {
      // ignore
    }
  }
  removeVersionSidecar(target);
}

/**
 * Injectable seams for `startHeartbeatIfNeeded`.
 *
 * Tests supply fakes so no real process is ever signalled or spawned and no
 * test ever sleeps (per-repo pattern — see graphify-rails).
 */
export interface HeartbeatStartDeps {
  /** Version of the CLI that is asking (defaults to the installed package). */
  installedVersion: () => string;
  /** Whether a PID is alive. */
  isRunning: (pid: number) => boolean;
  /** Signal the daemon to stop; must throw when the signal cannot be sent. */
  stopDaemon: (pid: number) => void;
  /** Spawn a detached daemon for a target; must throw when the spawn fails. */
  spawnDaemon: (target: string) => void;
  /** Await a delay (injected so tests never sleep). */
  wait: (ms: number) => Promise<void>;
}

function spawnDaemonDetached(target: string): void {
  const child = spawn(process.execPath, [getDaemonPath(), target], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

const DEFAULT_START_DEPS: HeartbeatStartDeps = {
  installedVersion: readInstalledVersion,
  isRunning: isProcessRunning,
  stopDaemon: (pid: number) => {
    process.kill(pid, 'SIGTERM');
  },
  spawnDaemon: spawnDaemonDetached,
  wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Poll until the stopped daemon's PID is really gone.
 * Bounded — never race a spawn against a dying process, never hang init.
 */
async function waitForPidToClear(
  pid: number,
  deps: HeartbeatStartDeps
): Promise<boolean> {
  for (let poll = 0; poll < PID_CLEAR_MAX_POLLS; poll++) {
    if (!deps.isRunning(pid)) return true;
    await deps.wait(PID_CLEAR_POLL_MS);
  }
  return !deps.isRunning(pid);
}

/**
 * Stop a drifted daemon and start one running the installed code.
 *
 * Fail-soft at every step: a daemon that refuses to die, or a spawn that
 * fails, degrades to a one-line notice — a daemon that will not restart must
 * never fail the install.
 */
async function restartDriftedDaemon(
  target: string,
  pid: number,
  running: string | null,
  installed: string,
  deps: HeartbeatStartDeps
): Promise<void> {
  const from = versionLabel(running);

  try {
    deps.stopDaemon(pid);
  } catch (err) {
    log.warn(
      `Heartbeat daemon: restart skipped — could not stop PID ${pid} (${(err as Error).message}); still running version ${from}.`
    );
    return;
  }

  const cleared = await waitForPidToClear(pid, deps);
  if (!cleared) {
    log.warn(
      `Heartbeat daemon: restart skipped — PID ${pid} did not exit within ${PID_CLEAR_TIMEOUT_MS}ms; still running version ${from}.`
    );
    return;
  }

  cleanStalePid(target);

  try {
    deps.spawnDaemon(target);
  } catch (err) {
    log.warn(
      `Heartbeat daemon: restart failed — could not start version ${installed} (${(err as Error).message}); no daemon is running.`
    );
    return;
  }

  await deps.wait(DAEMON_BOOT_WAIT_MS);

  const newPid = readPid(target);
  if (!newPid) {
    log.warn(
      `Heartbeat daemon: restart failed — version ${installed} did not write a PID; check flow/.heartbeat.log.`
    );
    return;
  }

  log.success(
    `Heartbeat daemon restarted — version ${from} → ${installed} (PID: ${newPid})`
  );
}

/**
 * Starts the heartbeat daemon if heartbeat.md exists and daemon is not already running.
 * Called automatically during `plan-flow init`.
 *
 * A daemon that is already running is left completely alone UNLESS its version
 * sidecar disagrees with the installed CLI — an upgraded CLI would otherwise
 * leave the OLD daemon running OLD code indefinitely (the incident this
 * exists for). Only an exact version match counts as current; a missing or
 * unreadable sidecar reads as drifted, which migrates pre-sidecar daemons with
 * exactly one restart.
 *
 * Never throws: init runs this on every project open, and no heartbeat problem
 * may fail an install.
 */
export async function startHeartbeatIfNeeded(
  target: string,
  overrides: Partial<HeartbeatStartDeps> = {}
): Promise<void> {
  // A DETACHED DAEMON OUTLIVES THE TEST THAT STARTED IT (#1848). Under jest
  // this is the auto-start path reached by `runInit`, and the daemon it leaves
  // behind keeps writing into a temp directory the suite is deleting — eight of
  // them from `init.test.ts` alone, which is what made a different test fail on
  // every full run.
  //
  // ONLY WHEN NOTHING WAS INJECTED. A caller that supplied its own
  // `spawnDaemon` is testing this function on purpose and has already replaced
  // the dangerous part; the guard is for callers that did not think about it.
  if (overrides.spawnDaemon === undefined && backgroundWorkDisabled()) return;

  const deps: HeartbeatStartDeps = { ...DEFAULT_START_DEPS, ...overrides };

  try {
    const heartbeatPath = join(target, 'flow', 'heartbeat.md');
    if (!existsSync(heartbeatPath)) return;

    const existingPid = readPid(target);
    if (existingPid && deps.isRunning(existingPid)) {
      const installed = deps.installedVersion();
      const { drifted, running } = checkVersionDrift(target, installed);

      if (!drifted) {
        log.info(
          `Heartbeat daemon already running (PID: ${existingPid}, version ${installed})`
        );
        return;
      }

      await restartDriftedDaemon(target, existingPid, running, installed, deps);
      return;
    }

    if (existingPid) cleanStalePid(target);

    try {
      deps.spawnDaemon(target);
    } catch (err) {
      log.warn(
        `Heartbeat daemon: could not start (${(err as Error).message}).`
      );
      return;
    }

    await deps.wait(DAEMON_BOOT_WAIT_MS);

    const pid = readPid(target);
    if (pid) {
      log.success(`Heartbeat daemon started in background (PID: ${pid})`);
    }
  } catch (err) {
    // Sanctioned fail-soft: every heartbeat problem degrades to a notice.
    log.warn(`Heartbeat daemon: skipped (${(err as Error).message}).`);
  }
}

/** The actions the switch below really handles — named once, so the refusal
 *  cannot drift from the cases. */
const HEARTBEAT_ACTIONS = ['start', 'stop', 'status'] as const;

export async function runHeartbeat(
  action: string,
  options: { target: string }
): Promise<void> {
  const target = options.target;
  const heartbeatPath = join(target, 'flow', 'heartbeat.md');

  switch (action) {
    case 'start': {
      // Check if already running
      const existingPid = readPid(target);
      if (existingPid && isProcessRunning(existingPid)) {
        log.info(`Heartbeat daemon is already running (PID: ${existingPid})`);
        return;
      }

      // Clean stale PID if exists
      if (existingPid) {
        cleanStalePid(target);
      }

      // Check heartbeat.md exists
      if (!existsSync(heartbeatPath)) {
        log.warn('No flow/heartbeat.md found. Create it first with /heartbeat -add');
        return;
      }

      // Spawn detached daemon
      spawnDaemonDetached(target);

      // Brief wait for PID file to be written
      await new Promise((resolve) => setTimeout(resolve, DAEMON_BOOT_WAIT_MS));

      const pid = readPid(target);
      if (pid) {
        log.success(`Heartbeat daemon started (PID: ${pid})`);
      } else {
        log.warn('Daemon may have failed to start — check flow/.heartbeat.log');
      }
      break;
    }

    case 'stop': {
      const pid = readPid(target);
      if (!pid) {
        log.info('Heartbeat daemon is not running');
        return;
      }

      if (!isProcessRunning(pid)) {
        cleanStalePid(target);
        log.info('Heartbeat daemon was not running (cleaned stale PID)');
        return;
      }

      try {
        process.kill(pid, 'SIGTERM');
        log.success(`Heartbeat daemon stopped (PID: ${pid})`);
      } catch (err) {
        log.warn(`Failed to stop daemon: ${(err as Error).message}`);
      }

      // Clean PID file (daemon should do this, but just in case)
      cleanStalePid(target);
      break;
    }

    case 'status': {
      const pid = readPid(target);

      if (!pid) {
        log.info('Heartbeat daemon: stopped');
        return;
      }

      if (isProcessRunning(pid)) {
        log.info(`Heartbeat daemon: running (PID: ${pid})`);

        // Show last few log entries
        const logPath = join(target, 'flow', '.heartbeat.log');
        if (existsSync(logPath)) {
          const logContent = readFileSync(logPath, 'utf-8');
          // EVENTS, not lines. The reader came for the last five things the
          // DAEMON did; a log written before #1803 still holds continuation
          // lines from multi-line agent messages, and showing the middle of an
          // agent's markdown table answers a question nobody asked.
          const lines = logContent.trim().split('\n').filter(isDaemonEvent);
          const recent = lines.slice(-5);
          console.log('\nRecent log:');
          for (const line of recent) {
            console.log(`  ${line}`);
          }
        }
      } else {
        cleanStalePid(target);
        log.info('Heartbeat daemon: stopped (cleaned stale PID)');
      }
      break;
    }

    default:
      // THE FAMILY'S CONTRACT: `<cmd> refused: <reason>` and exit 1 (#1831).
      //
      // This was `log.warn` and a fall-through, which exited 0 — the only verb
      // family in the CLI that answered an unknown action with success. The
      // action people actually type is `restart`, which does not exist here and
      // is exactly what this project's own guidance keeps asking for ("restart
      // the daemon before claiming a daemon fix is live"), so
      // `heartbeat restart && echo refreshed` printed `refreshed` with the
      // daemon untouched and still running the old `dist/`.
      //
      // A warning is also the wrong SHAPE: the CLI's E2E tests grep the
      // combined transcript for `refused:`, so a warn line is invisible to the
      // check that would have caught this.
      log.error(
        `heartbeat refused: unknown action '${action}' — expected ${HEARTBEAT_ACTIONS.join('|')}`,
      );
      process.exitCode = 1;
  }
}
