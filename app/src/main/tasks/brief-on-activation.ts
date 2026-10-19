// brief-on-activation — when a task ENTERS an active lane (Todo or Doing) and has
// no technical brief yet, generate one so it is ready before the agent works on
// it, because the brief helps whoever (or whatever) picks the card up understand
// the task.
//
// The reaction lives here, store/IPC/SDK-free and dependency-injected, for the
// same reason close-remote-on-done.ts does: it unit-tests without a database,
// Electron or the model, and it keeps the "when does a lane move trigger a brief?"
// rule in ONE code path (allowed-pattern #14) rather than in the TWO writers that
// can move a card into Todo/Doing — the `tasks:update` IPC handler (a drag on the
// board, a loop claim moving a run record) and `makeOnTurnStart` (the agent's
// first turn auto-advancing Todo → Doing, which is the ONLY hook the board loop's
// own path ever reaches — it never touches `tasks:update`).
//
// FAIL-SOFT BY CONTRACT: the brief is a side effect of the lane move, never a gate
// on it. Both callers fire this and ignore the returned promise; generation is the
// same fire-and-forget the import path has always used, and it never throws.

import type { TaskRecord } from '../store/task-store'

/** The slice of the world the reaction needs — each injected so it tests offline. */
export interface BriefOnActivationDeps {
  /** Whether the task has enough substance to summarize (taskHasBriefContent). */
  hasContent(task: TaskRecord): boolean
  /** Kick off generation (generateTaskBrief, bound to the store + generator). */
  generate(taskId: string): Promise<unknown>
}

/**
 * Generate a technical brief iff a task just moved INTO an active lane and has
 * none yet.
 *
 * Returns the in-flight promise so a test can await it; the callers ignore it
 * (fire-and-forget). Returns null — and does NOTHING — for every case that must
 * not generate a brief:
 *  - the card did not land in Todo or Doing (`record.lane` is blocked/done)
 *  - the lane did not CHANGE into this active one — a rename / autoFix /
 *    suggestDone re-save of a card already sitting there must not re-fire
 *  - a brief already exists, is in flight, or previously produced/errored
 *    (`briefStatus !== 'idle'`) — this is the guard that makes a second move a
 *    no-op, so a Todo → Doing hop never regenerates what the Todo entry made
 *  - there is nothing to summarize (a bare, title-only card)
 *
 * The `briefStatus === 'idle'` guard is what "(if it doesn't have one)" means: a
 * card whose brief is ready, pending or errored is left exactly as it is.
 */
export function briefOnActivation(
  prev: TaskRecord | null,
  record: TaskRecord,
  deps: BriefOnActivationDeps,
): Promise<void> | null {
  if (record.lane !== 'todo' && record.lane !== 'doing') return null
  if (prev !== null && prev.lane === record.lane) return null
  if (record.briefStatus !== 'idle') return null
  if (!deps.hasContent(record)) return null
  return deps
    .generate(record.id)
    .then(() => undefined)
    .catch(() => undefined)
}
