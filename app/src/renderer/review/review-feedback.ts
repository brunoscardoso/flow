// User-facing feedback for Review actions (#73). The commit buttons used to fail
// silently (console.error only). These pure builders turn an outcome into a
// toast; the panel/coordinator dispatch it via the `flow:notify` event →
// NotificationCenter.

export interface ReviewToast {
  title: string
  body: string
  level: 'info' | 'error'
}

/** Readable text from an unknown thrown value. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const text = String(error)
  return text === '[object Object]' ? 'Unknown error' : text
}

/** Approve↔stage sync failed (#857) → the ✓ was rolled back to real state. */
export function approveSyncFailedToast(error: unknown): ReviewToast {
  return {
    title: "Couldn't sync approval to staging",
    body: `${errorText(error)} — approval follows the staging area, so the file's state was re-read.`,
    level: 'error',
  }
}

/** A failed commit → toast carrying the underlying git error. */
export function commitFailedToast(error: unknown): ReviewToast {
  return {
    title: 'Commit failed',
    body: `${errorText(error)} — your approved files were not committed.`,
    level: 'error',
  }
}

/** A failed reject (revert) → toast carrying the underlying git error (#103). */
export function rejectFailedToast(error: unknown): ReviewToast {
  return {
    title: 'Reject failed',
    body: `${errorText(error)} — the file was left unchanged.`,
    level: 'error',
  }
}

/** A failed diff open → toast so the file click isn't a silent dead end
 *  (#659, mirroring the git panel's #192 fileDiffFailedToast). */
export function diffFailedToast(filePath: string, error: unknown): ReviewToast {
  return {
    title: 'Diff failed',
    body: `${filePath}: ${errorText(error)}`,
    level: 'error',
  }
}

/** An approve/commit was blocked by unresolved merge conflicts (#986) — the
 *  actionable half of the refusal: point at the conflict-resolution flow. */
export function conflictBlockedToast(count: number): ReviewToast {
  const files = `${count} file${count === 1 ? '' : 's'}`
  return {
    title: 'Unresolved merge conflict',
    body:
      `${files} still contain${count === 1 ? 's' : ''} conflict markers — approving would tell ` +
      'git the conflict is resolved and let the raw markers be committed. Resolve ' +
      `${count === 1 ? 'it' : 'them'} first: open the file to use the inline conflict resolver, ` +
      'or use Source Control → Changes → Merge Changes.',
    level: 'error',
  }
}

/**
 * A successful "Commit phase" (#1433) — the flow's primary action confirms
 * itself the way the sibling Changes box does (#1144), with the hash the work
 * landed as. Without it, a landed commit and a destroyed changeset produced
 * the identical and only signal: the group's rows vanished.
 */
export function commitSucceededToast(groupLabel: string, hash: string): ReviewToast {
  return { title: 'Committed', body: `${groupLabel} · ${hash}`, level: 'info' }
}

/**
 * A completed "Discard all" (#1433) — the destructive exit names what it
 * destroyed, so it is never indistinguishable from the constructive one.
 */
export function discardSucceededToast(count: number, groupLabel: string): ReviewToast {
  return {
    title: 'Discarded',
    body: `${count} change${count === 1 ? '' : 's'} in ${groupLabel} reverted to HEAD.`,
    level: 'info',
  }
}

/** Some files couldn't be reverted during a "Discard all" (#124). */
export function discardFailedToast(failedCount: number): ReviewToast {
  return {
    title: 'Discard incomplete',
    body: `${failedCount} file(s) could not be reverted and were left unchanged.`,
    level: 'error',
  }
}

/**
 * The listing itself failed (#1333). Every other failure in this panel raises
 * a toast — commit (#73), diff open (#659), reject (#103), discard, the
 * approve↔stage sync — except the one that produces the list, which ended in
 * a bare `console.warn`.
 *
 * So a rejected `review:list` left the PREVIOUS listing on screen, fully
 * actionable: ✓ approve, ✕ reject, Discard all, Approve all — every control
 * pointed at a repo state git can no longer confirm. And ⟳, the user's one
 * manual way to ask "is this still accurate?", became a silent no-op with
 * identical pixels.
 */
export function reviewListFailedToast(error: unknown): ReviewToast {
  return {
    title: "Couldn't refresh the review",
    body: `${errorText(error)}. The list below may be out of date — don't trust it until it refreshes.`,
    level: 'error',
  }
}
