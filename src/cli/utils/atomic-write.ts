/**
 * One atomic file write, for every store that must never be seen half-written.
 *
 * WRITE A UNIQUE TEMP SIBLING, THEN RENAME. That is the whole trick, and it was
 * already spelled three times — `loop/loop-state.ts`, `loop/directive-writer.ts`
 * and `loop/instructions.ts`, each carrying a comment saying it does what the
 * first one does. Three copies of an invariant is three places for it to drift
 * (allowed-pattern #14), and when the invariant turned out to be WRONG on a
 * whole platform it was wrong in all three.
 *
 * THE WINDOWS PART, which is why this file exists:
 *
 *   rename() over a path another process holds open fails with EPERM on
 *   Windows. On POSIX it succeeds — the old name is unlinked and the open
 *   handle keeps reading the old inode — so the bug is invisible on macOS and
 *   Linux and total on Windows.
 *
 * Reported live: with the Flow IDE running (it watches `flow/loops/state.json`),
 * every `loop pause|resume|point` refused with
 *
 *   loop refused: EPERM: operation not permitted, rename
 *   'state.json.tmp.45876.1' -> 'state.json'
 *
 * so a loop could not be turned on at all while the app that shows the switch
 * was open. Proven in isolation: the same rename fails with a reader's handle
 * open and succeeds the instant it closes.
 *
 * A reader's lock is TRANSIENT — it opens, reads, closes — so the fix is to
 * wait for it rather than to abandon atomicity. Retries are bounded and the
 * last failure is rethrown: a write that genuinely cannot land must still say
 * so, because a silently dropped state write is the failure this whole
 * write-then-rename dance exists to prevent.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Per-process counter, so two writes in one process never share a temp name. */
let tempCounter = 0;

/**
 * How long to keep trying the rename. Generous enough to outlast a watcher's
 * read (microseconds) and a virus scanner's peek (milliseconds), short enough
 * that a genuinely stuck write still reports promptly.
 */
const RETRY_DELAYS_MS = [0, 1, 2, 5, 10, 25, 50, 100, 200] as const;

/** Block for `ms` without a timer — this module is synchronous by contract. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Only these are worth retrying: a lock held by someone else, right now.
 * Anything else (no such directory, no permission to the directory at all) is
 * not going to improve by waiting, and retrying it would just delay the error.
 */
function isTransientLock(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * Write `content` to `filePath` atomically.
 *
 * On any failure the temp file is removed, so a crashed write leaves neither a
 * partial target nor a stray sibling.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  tempCounter += 1;
  const temp = `${filePath}.tmp.${String(process.pid)}.${String(tempCounter)}`;
  try {
    writeFileSync(temp, content, 'utf-8');
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        renameSync(temp, filePath);
        return;
      } catch (error) {
        const last = attempt === RETRY_DELAYS_MS.length - 1;
        if (last || !isTransientLock(error)) throw error;
        sleepSync(RETRY_DELAYS_MS[attempt + 1] ?? 0);
      }
    }
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Sanctioned fail-soft: the temp file was never created (or already gone)
    }
    throw error;
  }
}
