/**
 * An advisory inter-process file lock for the MAIN process — the async twin of
 * the CLI's `src/cli/loop/file-lock.ts`.
 *
 * WHY A SECOND COPY RATHER THAN AN IMPORT: the app never imports CLI source
 * (separate tsconfigs, separate bundles — the CLI ships to the app as a built
 * binary, not as modules), and the CLI's version is synchronous, which the
 * main process must never be (allowed-pattern #19: a blocking main process
 * stalls every window). What the two share is the thing that actually matters:
 * the FILE ON DISK. Same lock-file path shape (`<target>.lock`), same
 * exclusive-create acquisition, same stale-takeover rule — so a CLI verb and
 * the app rewriting the same vault store interlock even though neither can see
 * the other's code.
 *
 * Acquisition is an exclusive-create (`wx`) of the lock file — the one
 * filesystem primitive that cannot race. A lock older than `staleMs` is taken
 * over, so a crashed holder cannot wedge every later write; waiting past
 * `waitMs` rejects with `FileLockTimeoutError` rather than proceeding
 * unguarded, and the caller decides whether that is fatal or fail-soft.
 *
 * RE-ENTRANCY IS NOT A `Set`. The CLI tracks its own held locks in a module
 * -level `Set<string>` and that is sound there, because a synchronous `fn`
 * cannot be interleaved with anything. Copying that here would be the exact
 * lost-update bug the lock exists to stop: writer A awaits inside `fn`, writer
 * B — unrelated, concurrent — finds the path in the set, concludes it already
 * holds the lock, and rewrites the file underneath A. So held locks live in an
 * `AsyncLocalStorage` store instead: only a call made from INSIDE a holder's
 * own async context is re-entrant. Everyone else waits.
 *
 * IT GUARDS ONE MACHINE AGAINST ITSELF, AND NOTHING MORE — the paths it locks
 * are per-machine, so nothing here is visible to another engineer's checkout.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import { dirname } from 'node:path'

/** How long a holder may plausibly live before its lock is presumed dead. */
export interface FileLockLimits {
  /** A lock file older than this belongs to a dead process and is reclaimed. */
  staleMs: number
  /** How long an acquire waits on a live holder before refusing. */
  waitMs: number
  /** Pause between acquire attempts. */
  retryMs: number
}

/** The refusal a caller can tell apart from a real I/O failure. */
export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, waitMs: number) {
    super(
      `${lockPath}: held by another process for over ${String(waitMs / 1000)}s — if its process is gone, delete the file`,
    )
    this.name = 'FileLockTimeoutError'
  }
}

/**
 * Lock paths held by the CURRENT async context. A per-context store rather
 * than a module-level set, so a concurrent caller never mistakes another
 * writer's hold for its own (see the module header).
 */
const heldLockPaths = new AsyncLocalStorage<ReadonlySet<string>>()

/** Async sleep — the main process must never block waiting on a lock. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Take the lock file, waiting out a live holder and reclaiming a dead one.
 *
 * Returns the token written into the file, which is what makes release
 * ownership-scoped (#1825). It is a UUID and NOT `process.pid`: both real call
 * sites — the learning-state store and brain compaction — run in the main
 * process, so two concurrent holders have the same pid and a pid could not tell
 * them apart. Being unique per ACQUISITION also survives pid reuse.
 */
async function acquire(lockPath: string, limits: FileLockLimits): Promise<string> {
  await fsPromises.mkdir(dirname(lockPath), { recursive: true })
  const token = randomUUID()
  const deadline = Date.now() + limits.waitMs
  for (;;) {
    try {
      const handle = await fsPromises.open(lockPath, 'wx')
      try {
        await handle.write(token)
      } finally {
        await handle.close()
      }
      return token
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let ageMs: number
      try {
        ageMs = Date.now() - (await fsPromises.stat(lockPath)).mtimeMs
      } catch {
        continue // the holder released between our attempts — try again now
      }
      if (ageMs > limits.staleMs) {
        // Sanctioned fail-soft on failure: another waiter took the stale lock
        // over first, which is exactly as good as taking it over ourselves.
        await fsPromises.rm(lockPath, { force: true }).catch(() => undefined)
        continue
      }
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(lockPath, limits.waitMs)
      }
      await sleep(limits.retryMs)
    }
  }
}

/**
 * Remove the lock file only if it is still the one this holder wrote.
 *
 * The release used to be an unconditional `rm`. The comment justifying it was
 * half right — a stale takeover may indeed have removed THIS holder's file —
 * but by then the path usually holds the TAKEOVER holder's lock, and deleting
 * that one ends mutual exclusion: the next waiter acquires while the takeover
 * holder is still inside `fn`. The trigger is not a crash, it is a live holder
 * outliving `staleMs`, which a laptop suspend guarantees for every holder at
 * once (staleness is wall-clock mtime age).
 *
 * Read-compare-delete is not atomic, and cannot be on a POSIX filesystem
 * without `renameat2`-style primitives. The window between the read and the
 * unlink is microseconds and requires a takeover landing exactly inside it —
 * against a release that previously freed another holder's lock EVERY time it
 * was taken over, which is the case that actually happens.
 */
async function releaseIfOwned(lockPath: string, token: string): Promise<void> {
  let onDisk: string
  try {
    onDisk = await fsPromises.readFile(lockPath, 'utf-8')
  } catch {
    return // already gone — a takeover reclaimed it; nothing of ours to remove
  }
  if (onDisk !== token) {
    // NOT OURS. Someone reclaimed this lock while we were still working, so
    // the work just done was not actually guarded. Say so: a silent
    // unguarded write is the other half of the same hazard, and the operator
    // reading a corrupted store deserves the line that explains it.
    console.warn(
      `[FileLock] ${lockPath} was taken over while still held — the work just ` +
        `completed ran unguarded. Raise staleMs for this caller if it legitimately runs long.`,
    )
    return
  }
  // Sanctioned fail-soft: a takeover between the read and here is the one
  // remaining race, and removing a lock we no longer own is what this avoids.
  await fsPromises.rm(lockPath, { force: true }).catch(() => undefined)
}

/** Run `fn` holding the advisory lock at `lockPath`. */
export async function withFileLock<T>(
  lockPath: string,
  limits: FileLockLimits,
  fn: () => T | Promise<T>,
): Promise<T> {
  const held = heldLockPaths.getStore()
  if (held?.has(lockPath) === true) {
    return await fn()
  }
  const token = await acquire(lockPath, limits)
  const nowHeld = new Set(held ?? [])
  nowHeld.add(lockPath)
  try {
    return await heldLockPaths.run(nowHeld, async () => await fn())
  } finally {
    await releaseIfOwned(lockPath, token)
  }
}
