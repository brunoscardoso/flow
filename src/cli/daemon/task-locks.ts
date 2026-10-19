/**
 * Per-task run locks for the heartbeat daemon.
 *
 * The daemon used to gate every task behind one global `taskRunning` boolean,
 * so a long-running task silently swallowed every other task's turn. This map
 * makes the lock per task name: independent tasks beat concurrently, and only
 * a second beat of the SAME task is refused.
 *
 * The invariant ("a task holds at most one lock, and only the holder can be
 * refused") lives here in one code path rather than being restated at each
 * call site (allowed-pattern #14).
 *
 * THIS IS NOT LOOP MACHINERY, despite arriving alongside it. It keys on a
 * heartbeat task's NAME and knows nothing about loops, slots or run state — the
 * loop's own locks lived in the loop state store, not here. It survived the
 * removal of the daemon's loop path on purpose: it is the fix for a silent-drop
 * bug that every heartbeat user has, loops or no loops. Deleting it would put
 * that bug back.
 */

export interface TaskLocks {
  /**
   * Try to take the lock for `taskName`.
   * Returns true when the caller now holds it, false when it was already held.
   */
  acquire(taskName: string): boolean;
  /** Release the lock for `taskName`. Releasing an unheld lock is a no-op. */
  release(taskName: string): void;
  /** Whether `taskName` currently holds its lock. */
  isRunning(taskName: string): boolean;
  /** Names of every task currently holding its lock, in acquisition order. */
  running(): string[];
  /** How many tasks currently hold a lock. */
  size(): number;
  /** Release every lock (daemon shutdown / reload). */
  releaseAll(): void;
}

export function createTaskLocks(): TaskLocks {
  const held = new Set<string>();

  return {
    acquire(taskName: string): boolean {
      if (held.has(taskName)) return false;
      held.add(taskName);
      return true;
    },
    release(taskName: string): void {
      held.delete(taskName);
    },
    isRunning(taskName: string): boolean {
      return held.has(taskName);
    },
    running(): string[] {
      return [...held];
    },
    size(): number {
      return held.size;
    },
    releaseAll(): void {
      held.clear();
    },
  };
}
