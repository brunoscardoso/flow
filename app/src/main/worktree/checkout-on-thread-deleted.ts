// A DELETED CONVERSATION'S CHECKOUT, RELEASED — from the one place every
// delete door passes through.
//
// WHAT IS WRONG TODAY. `threads:delete` deliberately does not release: the
// sidebar's own flow does it, gated by `threadDeleteNotice`, which is what
// writes the sentence a person reads about what they are about to lose. That
// reasoning is sound and this module does not disturb it — but it covers ONE
// door. Four others delete threads and release nothing:
//
//   - a task's delete cascades to its thread (`task-service.ts`)
//   - a task cleanup deletes the thread it owned (`task-service.ts`)
//   - removing a project deletes every thread in it (`remove-project.ts`)
//   - `tasks:*` handlers that clear a thread (`ipc/index.ts`)
//
// Every one of those leaves a checkout on disk that nothing in Flow will
// mention again — the `abandoned` state the Storage page exists to surface. The
// files are not lost, but nobody asked for them to be kept either.
//
// WHY THE CHANGE EVENT AND NOT THE HANDLERS. Patching five call sites is five
// chances to miss the sixth. `ThreadStore.deleteThread` emits exactly one
// `thread`/`deleted` event per row that really went, and it now carries the
// checkout it just orphaned — read before the DELETE, because afterwards there
// is nothing left to read. `thread-gone.ts` takes the same boundary for the
// same reason; this is the disk's half of it.
//
// THIS IS NOT ONE RULE IN TWO LAYERS (allowed-pattern #14). The rule — MAY this
// be released? — lives in `prune`, and both the sidebar and this module ask it
// there. What the notice owns is what the interactive path SAYS; what this owns
// is that the question gets asked at all when no person is present to read a
// sentence.
//
// NOTHING HERE MAY DESTROY UNLANDED WORK. `allowUnlanded` is never passed and
// there is no argument that could introduce it (forbidden-pattern #15). A
// checkout holding uncommitted files or unmerged commits is REFUSED by prune,
// stays exactly where it is, and shows up on the Storage page as a row somebody
// can free deliberately. A backstop that ran while nobody was looking and threw
// work away would be worse than the orphan it replaces.

import { THREAD_STORE_CHANGE_EVENT, type ThreadChangeEvent } from '../store/thread-store'

/** What a release answers. Structural, so a refusal cannot be mistaken for a success. */
export interface CheckoutReleaseResult {
  status: string
  detail?: string
}

/** The one thing that removes a directory — `ThreadMerge.prune`, narrowed. */
export interface CheckoutRelease {
  (
    threadId: string,
    options: {
      confirmed: true
      abandoned: { projectRoot: string; worktreePath: string; branch: string | null }
    },
  ): Promise<CheckoutReleaseResult>
}

/** The slice of the store this needs: its change events, and nothing else. */
export interface ThreadDeletionSource {
  on(event: string, listener: (event: ThreadChangeEvent) => void): unknown
  off(event: string, listener: (event: ThreadChangeEvent) => void): unknown
}

export interface CheckoutOnThreadDeletedDeps {
  release: CheckoutRelease
  /** Injected so a test can watch without a console. */
  onOutcome?: (outcome: { threadId: string; status: string; detail?: string }) => void
}

/**
 * Whether this event is a deletion that orphaned a checkout.
 *
 * BOTH HALVES, AND THE ORDER DOES NOT MATTER — but the narrowing does: every
 * other change event in this store shares the shape, and acting on a thread
 * `updated` would release a checkout out from under a live conversation.
 */
export function orphanedByDeletion(
  event: ThreadChangeEvent,
): { projectRoot: string; worktreePath: string; branch: string | null } | null {
  if (event.entity !== 'thread') return null
  if (event.action !== 'deleted') return null
  return event.abandoned ?? null
}

/**
 * Start releasing checkouts whose conversation was deleted.
 *
 * Returns the unsubscribe, so a test — and a shutdown — can stop listening
 * rather than leaving a listener bound to a store that outlives it.
 */
export function releaseCheckoutOnThreadDeleted(
  store: ThreadDeletionSource,
  deps: CheckoutOnThreadDeletedDeps,
): () => void {
  const listener = (event: ThreadChangeEvent): void => {
    const abandoned = orphanedByDeletion(event)
    if (abandoned === null) return
    void (async () => {
      try {
        // `confirmed: true` IS THE DELETION. A person deleted the conversation;
        // this is that same say-so reaching the files it left behind. It is
        // written here and nowhere else in this flow (forbidden-pattern #15).
        const result = await deps.release(event.threadId, { confirmed: true, abandoned })
        deps.onOutcome?.({ threadId: event.threadId, status: result.status, detail: result.detail })
      } catch (error) {
        // A FAILED RELEASE IS AN ORPHAN, WHICH IS THE STATE WE WERE ALREADY IN.
        // It must never take the app down or interrupt the delete that caused
        // it — the conversation is already gone and the files are still there.
        console.error('flow: releasing a deleted thread’s checkout failed', error)
        deps.onOutcome?.({ threadId: event.threadId, status: 'failed' })
      }
    })()
  }
  store.on(THREAD_STORE_CHANGE_EVENT, listener)
  return () => {
    store.off(THREAD_STORE_CHANGE_EVENT, listener)
  }
}
