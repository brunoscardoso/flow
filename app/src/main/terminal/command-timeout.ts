// Hard-timeout escalation for an agent Bash command (#272). runCommand used to
// send a single SIGHUP on timeout and settle ONLY from the PTY's onExit — so a
// command that ignores the signal (traps HUP, or is stuck) never exited, onExit
// never fired, and the Bash tool call (hence the agent turn) hung forever,
// defeating the timeout. This arms a two-stage escalation with a guaranteed
// settle: soft-kill at the timeout, then force-kill AND settle after a grace
// window so the caller can never hang. onExit must call cancel(). Pure (drives
// the global timers) so it unit-tests with fake timers + spy callbacks.

export interface CommandTimeout {
  /** Cancel the timeout — call from the PTY's onExit when the command finishes. */
  cancel(): void
}

export function armCommandTimeout(opts: {
  /** Time before the command is considered timed out. */
  timeoutMs: number
  /** Grace after the soft-kill before force-killing + settling. */
  graceMs: number
  /** First, graceful termination (e.g. SIGHUP, group). */
  softKill: () => void
  /** Escalated, unignorable termination (e.g. SIGKILL, group). */
  forceKill: () => void
  /** Resolve the pending result so the call can never hang. */
  settle: () => void
}): CommandTimeout {
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  const timer = setTimeout(() => {
    opts.softKill()
    graceTimer = setTimeout(() => {
      graceTimer = null
      opts.forceKill()
      opts.settle()
    }, opts.graceMs)
  }, opts.timeoutMs)

  return {
    cancel() {
      clearTimeout(timer)
      if (graceTimer !== null) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
    },
  }
}
