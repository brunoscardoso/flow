// Background work must not out-compete the window.
//
// MEASURED, on a real machine with four big repos open: re-hashing one root's
// stamped files costs ~7 s of pure CPU (3,600 files in orbit-app, 2,559 in
// orbit-core), and Flow runs that work in bundled-CLI children — several at
// once when a save touches several modules. The main process is then simply not
// scheduled, and its own stall detector reported the result:
//
//   [main] blocked for 27012ms
//   [ipc] blueprint:read handled in 46412ms
//
// Nothing there was a slow handler. Everything was starved.
//
// So every child Flow spawns for DERIVED work gets a nice value: it still runs,
// it still finishes, and it loses every contest against the process drawing the
// user's screen. Agent runtimes are deliberately excluded — the person is
// watching those.

import { constants, setPriority } from 'os'

/**
 * Nice `pid` down to background. Fail-soft on every platform and permission
 * error: a priority we could not set is a slower app, never a broken one.
 */
export function runInBackground(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    setPriority(pid, constants.priority?.PRIORITY_BELOW_NORMAL ?? 10)
  } catch {
    // Windows without permission, a child that already exited, a platform
    // without priorities — none of which is worth a user-visible byte.
  }
}
