/**
 * An advisory inter-process file lock — the mutual-exclusion mechanism behind
 * the loop state store (#1662) and the per-checkout pull (#1663), extracted so
 * one code path carries the invariant (allowed-pattern #14).
 *
 * Acquisition is an exclusive-create (`wx`) of the lock file — the one
 * filesystem primitive that cannot race. Re-entrant within a process, per
 * path; a lock older than `staleMs` is taken over, so a crashed holder cannot
 * wedge every later verb; waiting past `waitMs` throws `FileLockTimeoutError`
 * rather than proceeding unguarded, and the caller decides whether that is
 * fatal (a state mutation) or fail-soft (a pull).
 *
 * IT GUARDS ONE MACHINE AGAINST ITSELF, AND NOTHING MORE — the same trust
 * boundary as the state store it was written for: the paths it locks are
 * per-machine, so nothing here is visible to another engineer's checkout.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** How long a holder may plausibly live before its lock is presumed dead. */
export interface FileLockLimits {
  /** A lock file older than this belongs to a dead process and is reclaimed. */
  staleMs: number;
  /** How long an acquire waits on a live holder before refusing. */
  waitMs: number;
  /** Pause between acquire attempts. */
  retryMs: number;
}

/** The refusal a caller can tell apart from a real I/O failure. */
export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, waitMs: number) {
    super(
      `${lockPath}: held by another process for over ${String(waitMs / 1000)}s — if its process is gone, delete the file`,
    );
    this.name = 'FileLockTimeoutError';
  }
}

/** Lock paths THIS process holds — Node is single-threaded, so a set suffices. */
const heldLockPaths = new Set<string>();

/** Synchronous sleep — the verbs are synchronous, so the wait must be too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` holding the advisory lock at `lockPath`. */
export function withFileLock<T>(lockPath: string, limits: FileLockLimits, fn: () => T): T {
  if (heldLockPaths.has(lockPath)) {
    return fn();
  }
  mkdirSync(dirname(lockPath), { recursive: true });
  // Unique per ACQUISITION, not `process.pid` — the async twin's two callers
  // share a process, and a pid is also reused after a process exits. Kept in
  // step with `app/src/main/store/file-lock.ts` on the on-disk protocol, which
  // is the only thing the two copies share (#1825).
  const token = randomUUID();
  const deadline = Date.now() + limits.waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ageMs: number;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // the holder released between our attempts — try again now
      }
      if (ageMs > limits.staleMs) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Sanctioned fail-soft: another waiter took the stale lock over first
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(lockPath, limits.waitMs);
      }
      sleepSync(limits.retryMs);
    }
  }
  heldLockPaths.add(lockPath);
  try {
    return fn();
  } finally {
    heldLockPaths.delete(lockPath);
    releaseIfOwned(lockPath, token);
  }
}

/**
 * Remove the lock file only if it is still the one this holder wrote.
 *
 * The release used to be an unconditional `unlinkSync`. A holder that outlives
 * `staleMs` gets taken over, and by the time its `finally` runs the path holds
 * the TAKEOVER holder's lock — which the unconditional unlink then deleted,
 * ending mutual exclusion while that holder was still working (#1825). Here the
 * hazard is strictly cross-process, since a synchronous `fn` cannot interleave
 * within one process, but a CLI verb outrunning `staleMs` is ordinary.
 *
 * Read-compare-delete is not atomic; the remaining window is the microseconds
 * between the read and the unlink, against a release that previously freed
 * another holder's lock every single time it was taken over.
 */
function releaseIfOwned(lockPath: string, token: string): void {
  let onDisk: string;
  try {
    onDisk = readFileSync(lockPath, 'utf-8');
  } catch {
    return; // already gone — a takeover reclaimed it; nothing of ours to remove
  }
  if (onDisk !== token) {
    // NOT OURS: this hold was reclaimed mid-flight, so the work just done ran
    // unguarded. Left on disk for its real owner, and said out loud.
    // console.warn, NOT the CLI logger: `log.warn` prints to stdout, which is
    // the stream loop verbs put their JSON result on and their callers parse.
    // A release-time diagnostic must not land in the middle of that. Same call
    // as the async twin makes, which keeps the two copies reading alike.
    console.warn(
      `[FileLock] ${lockPath} was taken over while still held — the work just completed ran unguarded`,
    );
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Sanctioned fail-soft: reclaimed between the read and here
  }
}
