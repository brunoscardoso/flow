/**
 * Threads collapse/hide model (#1219) — "add a way to collapse and hide the
 * threads, same as we have on source control. both options, only list of
 * threads or the chat thread and list".
 *
 * WHAT THE CHEVRON COST, AND WHY IT IS GONE. The first cut gave the sidebar's
 * toolbar two controls: a caret that put the LIST away on its own, and a `—`
 * that put the list AND the chat away. The caret's state — a list of
 * conversations collapsed into nothing, from a chevron sitting inside that
 * list — had exactly one way out: the same chevron, in a strip the user had
 * just emptied. The user's words: "don't make sense minimize this like that."
 *
 * So the caret is removed and `list-collapsed` with it, rather than left as a
 * state nothing can reach. Two states remain, and each names its own way back:
 *
 *   expanded    list + chat
 *   all-hidden  neither     ("the chat thread and list")
 *
 * WHERE THE REMAINING CONTROL LIVES. On the CHAT, top-right — it hides the
 * chat, so it belongs on the thing it acts on rather than in the list's
 * toolbar. Which means it hides ITSELF along with the chat: it has one label,
 * it is never the way back, and the way back is `restoreHint`, rendered by the
 * sidebar, which survives because the sidebar does.
 *
 * Pure and DOM-free: the sidebar renders what this decides, and the shell acts
 * on the chat half. Every state names its own way back — no dead ends.
 *
 * THE WAY IN IS GONE. The chat's floating `—` was the only control that ever
 * put both away, and it was removed on the user's report; the hide title and
 * the toggle went with it, since a label nothing renders and a transition
 * nothing calls are just a description of a feature that no longer exists.
 * What is left is the READ side — the persisted mode, its migration, and the
 * restore hint — because the choice outlives the control that made it, and a
 * window someone already put away must still be able to come back.
 */

export type ThreadsCollapseMode = 'expanded' | 'all-hidden'

export const THREADS_COLLAPSE_KEY = 'flow.threads.collapse'

/** What a mode renders. */
export interface ThreadsCollapseView {
  /** The thread list (rows, search results, empty hint). */
  listVisible: boolean
  /** The conversation panel. */
  chatVisible: boolean
  /** Shown in place of the list when everything is put away, so the state is
   *  never a blank panel the user has to guess their way out of. */
  restoreHint: string | null
}

const VIEWS: Record<ThreadsCollapseMode, ThreadsCollapseView> = {
  expanded: {
    listVisible: true,
    chatVisible: true,
    restoreHint: null,
  },
  'all-hidden': {
    listVisible: false,
    chatVisible: false,
    restoreHint: 'Threads and chat hidden',
  },
}

export function threadsCollapseView(mode: ThreadsCollapseMode): ThreadsCollapseView {
  return VIEWS[mode]
}

/**
 * Read a persisted mode, defaulting to `expanded` for anything unrecognised —
 * a corrupt value must never boot the user into a hidden panel.
 *
 * THIS IS ALSO THE MIGRATION. `list-collapsed` was persisted by every build
 * that had the chevron, and it is now unrecognised: whoever quit the app with
 * their thread list collapsed comes back to it expanded, rather than to a
 * state whose only control has been taken away.
 */
export function parseCollapseMode(raw: string | null): ThreadsCollapseMode {
  return raw === 'all-hidden' ? 'all-hidden' : 'expanded'
}
