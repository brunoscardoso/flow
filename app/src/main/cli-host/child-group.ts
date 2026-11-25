// A child the CLI host runs, together with everything IT starts.
//
// WHY (user report 2026-11-24): a `workspace sync` that ran too long was
// SIGKILLed, but only the CLI process died — the git it had started kept
// running. And when the person quit Flow mid-sync, nothing killed the CLI at
// all: it kept running without the app, holding the Workspace's sync lock, and
// every later launch was refused "this Workspace is already being synced".
//
// So each child starts as the leader of its own process group, and stopping it
// signals the GROUP: the CLI and every git, credential helper or shell under it
// go together. The host keeps every live child here and stops them all when it
// is told to exit or loses its parent.

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'

/** Spawn a child as the leader of a new process group (POSIX), so it can be stopped with everything under it. */
export function spawnInGroup(execPath: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  return spawn(execPath, [...args], { ...options, detached: process.platform !== 'win32' })
}

/** Stop a child and every process it started. Safe to call twice, and on a child that is gone. */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // The group is gone already, or was never made: fall back to the child itself.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Already gone.
  }
}

/** Every child the host is running, so all of them can be stopped at once. */
export class ChildGroups {
  readonly #live = new Set<ChildProcess>()

  track(child: ChildProcess): void {
    this.#live.add(child)
    const forget = (): void => {
      this.#live.delete(child)
    }
    child.once('exit', forget)
    child.once('error', forget)
  }

  get size(): number {
    return this.#live.size
  }

  /** Stop every live child and what it started. */
  killAll(signal: NodeJS.Signals = 'SIGKILL'): void {
    for (const child of this.#live) killGroup(child, signal)
    this.#live.clear()
  }
}
