// Manual "New task" submit outcome (#299). The board modal used to call close()
// synchronously the instant the user clicked "Create task" — before tasks.create
// resolved. On a failed create the modal was already gone, so the typed title and
// (multi-line) description were discarded with only a transient toast, unlike the
// import path in the SAME modal, which keeps the modal open with an inline retryable
// error. This pure helper encodes the fix's invariant — dismiss ONLY on success,
// otherwise keep the modal open and surface an inline error so the input survives.
// DOM-free so it's unit-testable under the node jest env; kanban-board.ts renders it.

/** Readable message from an unknown create failure (avoids "[object Object]"). */
export function createErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const text = String(error)
  return text === '[object Object]' ? 'Unknown error' : text
}

export interface ManualSubmitPlan {
  /** Dismiss the modal — true ONLY on success; false keeps typed input alive. */
  close: boolean
  /** Inline error to render inside the modal, or null on success. */
  inlineError: string | null
}

/**
 * Whether a New task submit should proceed. Guards BOTH the re-entrant double-submit
 * (#311 — #299 kept the modal open during the in-flight create, so a second Enter
 * fired a duplicate tasks.create + thread; the button-only `disabled` guard missed
 * the Enter → doSubmit path) AND the empty required field. doSubmit gates on this so
 * every entry path — button click and Enter — is blocked identically.
 */
export function canSubmit(submitting: boolean, hasRequiredInput: boolean): boolean {
  return !submitting && hasRequiredInput
}

/** Decide what the modal does after a manual create attempt resolves. */
export function planManualSubmit(
  outcome: { ok: true } | { ok: false; error: unknown },
): ManualSubmitPlan {
  if (outcome.ok) return { close: true, inlineError: null }
  return { close: false, inlineError: createErrorMessage(outcome.error) }
}

export interface TaskToast {
  title: string
  body: string
}

/**
 * Toast for a failed auto-start send (#297). The "Start with" command is the task's
 * first message; when threads.sendMessage rejects the thread opens empty and the agent
 * never starts — previously swallowed to console, so the user just saw a dead thread.
 * Tell them it was dropped and that they can resend it in the now-open thread.
 */
export function startTaskFailedToast(error: unknown): TaskToast {
  return {
    title: 'Could not start task',
    body: `${createErrorMessage(error)} — the start command wasn't sent. Resend it in the thread.`,
  }
}

/** Toast when applying "Skip permission prompts" fails (#297) — the user's explicit
 *  choice was silently ignored (fail-safe, since prompts stay ON), so surface it. */
export function skipPermissionsFailedToast(error: unknown): TaskToast {
  return {
    title: "Couldn't skip permission prompts",
    body: `${createErrorMessage(error)} — you'll be asked to approve the agent's actions.`,
  }
}
