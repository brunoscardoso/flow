/**
 * ONE reader of a thread's change review, for every surface that draws it.
 *
 * There are two now — the strip above the composer that says how much changed,
 * and the Changes tab that lists it — and there will be more (the checkout
 * segment can carry the same number). Each one subscribing to the three hot
 * broadcasts and issuing its own `git:changeReview` call would mean N IPC round
 * trips per agent keystroke for one answer, and two surfaces that can disagree
 * about what the thread changed. The subscriptions, the debounce and the fetch
 * live here once (allowed-pattern #14); the surfaces render what arrives.
 *
 * PERF (allowed-patterns #17/#19, forbidden #14): both gates the card used to
 * apply are still applied, in the same order. A broadcast must concern the
 * ACTIVE thread, and at least one subscriber must be ON SCREEN, before anything
 * is fetched — a subscriber reports its own visibility, so a chat put away with
 * ⌘⌥C and a closed panel together cost nothing. The payload itself is
 * counts-only: diffs are fetched when a file is opened, never for the list
 * (allowed-pattern #18).
 */
import type { ThreadChangeReview, Unsubscribe } from '../../shared/ipc-contract'

const REFRESH_DEBOUNCE_MS = 300

export interface ChangeReviewSnapshot {
  /** The conversation the review belongs to, or null when none is open. */
  threadId: string | null
  /** What git says that thread changed, or null before the first answer. */
  review: ThreadChangeReview | null
}

interface Subscriber {
  /** Draw this snapshot. */
  render: (snapshot: ChangeReviewSnapshot) => void
  /** Is this surface on screen? A hidden one draws nothing and, alone, funds
   *  nothing — but it is still handed every snapshot, so it is already correct
   *  the moment it comes back. */
  onScreen: () => boolean
}

class ChangeReviewStore {
  #threadId: string | null = null
  #review: ThreadChangeReview | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #started = false
  readonly #subscribers = new Set<Subscriber>()
  readonly #unsubscribers: Unsubscribe[] = []

  /** Begin following the active thread. Idempotent — the first surface to
   *  subscribe starts it; later ones join the same stream. */
  start(): void {
    if (this.#started) return
    this.#started = true

    document.addEventListener('flow:active-thread', (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string | null }>).detail
      this.#setActiveThread(detail?.threadId ?? null)
    })

    const api = window.flow
    // Thread-scoped signal (main fans git:changed out per watching thread).
    this.#unsubscribers.push(
      api.git.onChangeReviewUpdated((event) => {
        if (event.threadId !== this.#threadId) return // gate 1: this thread
        this.#queueRefresh()
      }),
    )
    // THE live signal for a thread worktree. A thread's checkout is unwatched by
    // the git watcher (git/index.ts: "a thread's checkout gets no watcher
    // events"), so git:changed — and the fan-out above — rarely fire for it. The
    // EditTracker's pending-changes broadcast is what updates as the agent
    // edits, and it is already thread-stamped: the perfect gate.
    this.#unsubscribers.push(
      api.editor.onPendingChangesUpdated((changes) => {
        if (this.#threadId === null) return
        if (!changes.some((change) => change.threadId === this.#threadId)) return
        this.#queueRefresh()
      }),
    )
    // Belt-and-braces for a watched root (a thread editing a project root, or a
    // manual edit). Same two gates below.
    this.#unsubscribers.push(
      api.project.onFileChanged(() => {
        if (this.#threadId === null) return
        this.#queueRefresh()
      }),
    )
  }

  get snapshot(): ChangeReviewSnapshot {
    return { threadId: this.#threadId, review: this.#review }
  }

  subscribe(subscriber: Subscriber): Unsubscribe {
    this.start()
    this.#subscribers.add(subscriber)
    // Paint immediately from what is already known, so a surface opened
    // mid-session is never blank until the next broadcast.
    subscriber.render(this.snapshot)
    // …and if it is the first surface to be on screen since the last change,
    // ask git now rather than waiting for an edit that may never come.
    if (subscriber.onScreen()) void this.refresh()
    return () => {
      this.#subscribers.delete(subscriber)
    }
  }

  /** Re-read now, bypassing the debounce. Called after a keep/reject, where the
   *  change was made by this app and there is nothing to wait for. */
  async refresh(): Promise<void> {
    const threadId = this.#threadId
    if (threadId === null) return
    let review: ThreadChangeReview | null
    try {
      review = await window.flow.git.changeReview({ threadId })
    } catch (error) {
      console.error('flow: change review fetch failed', { threadId, error })
      return
    }
    // A late response for a thread the user already left must not paint.
    if (threadId !== this.#threadId) return
    this.#review = review
    this.#emit()
  }

  #setActiveThread(threadId: string | null): void {
    if (threadId === this.#threadId) return
    this.#threadId = threadId
    this.#review = null
    this.#emit()
    if (threadId !== null) void this.refresh()
  }

  #queueRefresh(): void {
    // gate 2: somebody can see it. A surface that is off screen re-reads on the
    // way back in (subscribe/onScreen above) rather than queueing work.
    if (![...this.#subscribers].some((subscriber) => subscriber.onScreen())) return
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.refresh()
    }, REFRESH_DEBOUNCE_MS)
  }

  #emit(): void {
    const snapshot = this.snapshot
    for (const subscriber of this.#subscribers) subscriber.render(snapshot)
  }
}

/** The app has one active thread, so it has one change review. */
export const changeReviewStore = new ChangeReviewStore()
