/**
 * What a person is told after asking a thread to work on a branch of its own.
 *
 * Existing threads are NEVER moved on their own (a brainstorm rejection): an
 * old thread's next reply would land somewhere it did not land before, without
 * anybody asking for it. So there is an action, and an action owes an answer —
 * including, and especially, when it did nothing.
 *
 * IT ANSWERS IN BRANCHES NOW (worktree-ui-removal Phase 5, task 5.6). The
 * sentences used to name the directory Flow makes behind the branch, in the
 * two words this change took out of the product — which is Flow's own
 * bookkeeping, and not something anybody asked for. A person asked for their
 * work to go somewhere of its own; the branch IS that, and it is the only part
 * of it they will ever see again. The outcomes and their statuses are unchanged.
 *
 * Every outcome says the same two things in its own words: what happened, and
 * what that means for the thread's next reply. Nothing here names a command, a
 * path or a config key (forbidden-pattern #12) — "turned off for this project"
 * points at the settings panel a person can open, not at the key it writes.
 *
 * Pure and DOM-free: thread-sidebar.ts renders whatever this returns.
 */

import type { ThreadWorktreeResult } from '../../shared/ipc-contract'

export interface WorktreeActionNotice {
  title: string
  body: string
  level: 'info' | 'error'
}

const UNTITLED = 'This thread'

function name(threadTitle: string | null): string {
  const title = threadTitle?.trim() ?? ''
  return title === '' ? UNTITLED : `“${title}”`
}

/** The toast for a `threads:prepareWorktree` outcome. */
export function worktreeActionNotice(
  result: ThreadWorktreeResult,
  threadTitle: string | null,
): WorktreeActionNotice {
  const subject = name(threadTitle)
  switch (result.status) {
    case 'created': {
      const carried = result.detail === undefined ? '' : ` ${result.detail}`
      return {
        title: 'On its own branch',
        body: `${subject} works on a branch of its own now. Its next reply happens there, and your own files stay as they are.${carried}`,
        level: 'info',
      }
    }
    case 'ready':
      return {
        title: 'Already has one',
        body: `${subject} is already working on a branch of its own.`,
        level: 'info',
      }
    case 'busy':
      return {
        title: 'Not while it is working',
        body:
          result.detail ??
          'This thread is working right now. Give it a branch of its own once the current turn has finished.',
        level: 'info',
      }
    case 'disabled':
      return {
        title: 'Turned off for this project',
        body: 'This project keeps every thread in your own files. You can change that in Flow settings.',
        level: 'info',
      }
    case 'refused':
      return {
        title: 'Not this one',
        body:
          result.detail ??
          'Flow couldn’t give this thread a branch of its own. It will work directly in the project’s files, the way every thread did before.',
        level: 'info',
      }
    case 'needs-choice':
    case 'unavailable':
    default:
      return {
        title: 'Nothing changed',
        body: `Flow couldn’t give ${subject} a branch of its own. It keeps working in the project’s files.`,
        level: 'error',
      }
  }
}

/**
 * Whether the "give it its own branch" action belongs in a thread's menu.
 *
 * Offered for a thread that has none — a thread already on a branch of its own
 * has nothing to gain from an action that would tell it so.
 *
 * THIS IS THE NORMAL PATH NOW, not a rescue. It was written when every thread
 * got a checkout on its first message, so the only threads it could apply to
 * were ones that predated the feature or sat in a project with it turned off.
 * Since the gate (`automaticWorktree`), a conversation runs in the project
 * until somebody asks — and, now that the status footer's segment is gone,
 * this row menu is the whole of the asking for a thread that already exists.
 * The condition did not need to change; what it MEANS did.
 */
export function canOfferWorktree(thread: { worktreePath: string | null }): boolean {
  return thread.worktreePath === null
}
