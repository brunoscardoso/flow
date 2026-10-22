/**
 * ONE reader of a thread's background activity, for every surface that draws it.
 *
 * There are two — the footer button that says how many there are, and the
 * popover that lists them — and, like the change review, each one subscribing to
 * the hot `threads:updated` stream and issuing its own `toolCalls:list` would
 * mean N round trips per agent turn for one answer, and two surfaces that can
 * disagree about what a thread ran. The subscriptions, the debounce and the
 * fetch live here once (allowed-pattern #14); the surfaces render what arrives.
 *
 * PERF (allowed-patterns #17/#18/#19, forbidden #14): a broadcast must name a
 * `tool_call` change on the ACTIVE thread, and at least one subscriber must be
 * ON SCREEN, before anything is fetched — a chat put away and a closed popover
 * together cost nothing. The list read is metadata only (`outputLimit: 0`): a
 * row's output is fetched when the reader opens its tab, never for the list.
 */
import type { SubtaskRecord, ThreadMessage, ToolCallRecord, Unsubscribe } from '../../shared/ipc-contract'
import {
  activityKind,
  activityRows,
  mergeActivityRows,
  taskActivityRows,
  type BackgroundActivityRow,
} from './background-activity-model'
import type { SourceMessage } from './background-work-model'

const REFRESH_DEBOUNCE_MS = 300
/**
 * The list needs names and statuses, never output blobs (allowed-pattern #18) —
 * and the model reads no output field at all. `1`, not `0`: the store treats a
 * non-positive `outputLimit` as NO limit and hands back every blob (`thread-
 * store.ts`: `limit <= 0` → the unbounded read), so `0` is the maximal payload,
 * not the minimal one. `1` withholds all but the single newest output, which the
 * list also ignores — the smallest read `toolCalls:list` can be asked for.
 */
const OUTPUT_LIMIT = 1
/**
 * The person's recent messages, read to name a subtask's source ("from …")
 * and to find where the current request starts. Bounded: the newest few
 * messages, re-read only when a message is created on the active thread while
 * a surface is on screen. Earlier ones stay known for the thread's lifetime.
 */
const MESSAGE_WINDOW = 20

export interface BackgroundActivitySnapshot {
  /** The conversation the activity belongs to, or null when none is open. */
  threadId: string | null
  /** Its background rows, oldest-first (the popover reverses for display). */
  rows: BackgroundActivityRow[]
  /** Its subtasks (plan_mid-run-subtasks), oldest first. */
  subtasks: SubtaskRecord[]
  /** The person's messages known so far — sources and the request boundary. */
  userMessages: SourceMessage[]
}

interface Subscriber {
  render: (snapshot: BackgroundActivitySnapshot) => void
  /** Is this surface on screen? A hidden one draws nothing and funds nothing,
   *  but is still handed every snapshot so it is correct the moment it returns. */
  onScreen: () => boolean
}

class BackgroundActivityStore {
  #threadId: string | null = null
  #rows: BackgroundActivityRow[] = []
  /** The RAW sub-agent spawn records behind #rows, from the store's own last
   *  list read — kept so a live-row click can resolve its task → spawn join
   *  from records already in hand instead of re-reading the whole thread's
   *  tool calls (allowed-pattern #18). Spawn records only (the resolution
   *  judges nothing else); null until the first read lands. */
  #spawnRecords: ToolCallRecord[] | null = null
  /** Rows from the LIVE background-tasks set (backgrounded sub-agents with no
   *  persisted tool call) — merged with #rows in the snapshot (#1931). */
  #taskRows: BackgroundActivityRow[] = []
  /** Every background sub-agent SEEN this thread, by task id — RETAINED after it
   *  drops off the live set (marked done) so the chip still lists it and you can
   *  revisit what it ran (#1931). Cleared on thread switch. */
  readonly #retained = new Map<string, BackgroundActivityRow>()
  /** The active thread's subtasks by ticket — loaded on read, then kept
   *  current by `subtask` events alone (no re-read per change). */
  readonly #subtasks = new Map<string, SubtaskRecord>()
  /** The active thread's person's messages seen so far, by id. */
  readonly #userMessages = new Map<string, SourceMessage>()
  #messageTimer: ReturnType<typeof setTimeout> | null = null
  /** The thread whose messages were read at least once. */
  #messagesReadFor: string | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #started = false
  readonly #subscribers = new Set<Subscriber>()
  readonly #unsubscribers: Unsubscribe[] = []

  /** Begin following the active thread. Idempotent — the first subscriber starts
   *  it; later ones join the same stream. */
  start(): void {
    if (this.#started) return
    this.#started = true

    document.addEventListener('flow:active-thread', (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string | null }>).detail
      this.#setActiveThread(detail?.threadId ?? null)
    })

    const api = window.flow
    // The durable signal: a Task/Bash tool call was created or changed status.
    // Gated to tool_call changes on the active thread — a `threads:updated` batch
    // arrives every 50ms while an agent streams, and most of it draws nothing
    // here (allowed-pattern #17).
    this.#unsubscribers.push(
      api.threads.onUpdated((events) => {
        const threadId = this.#threadId
        if (threadId === null) return
        let toolCalls = false
        let messages = false
        let subtasks = false
        for (const event of events) {
          if (event.threadId !== threadId) continue
          if (event.entity === 'tool_call') toolCalls = true
          else if (event.entity === 'message' && event.action === 'created') messages = true
          else if (event.entity === 'subtask' && event.subtask !== undefined) {
            // The row rides the event: applied as it is, no read.
            this.#subtasks.set(event.subtask.ticket, event.subtask)
            subtasks = true
          }
        }
        if (subtasks) this.#emit()
        if (toolCalls) this.#queueRefresh()
        if (messages) this.#queueMessages()
      }),
    )
    // The prompt signal: a sub-agent or shell announced itself to the runtime,
    // which can precede its tool_call row landing. A changed set for the active
    // thread re-reads, so the list fills the moment work starts.
    this.#unsubscribers.push(
      api.threads.onStream((event) => {
        if (event.kind !== 'background-tasks') return
        if (event.threadId !== this.#threadId) return
        // The live set IS the backgrounded sub-agents — surface them directly so
        // one with no persisted tool call still shows (#1931), then re-read the
        // persisted rows in case one changed.
        this.#applyTasks(taskActivityRows(event.tasks, event.threadId))
        this.#emit()
        this.#queueRefresh()
      }),
    )
  }

  get snapshot(): BackgroundActivitySnapshot {
    return {
      threadId: this.#threadId,
      rows: mergeActivityRows(this.#rows, this.#taskRows),
      subtasks: [...this.#subtasks.values()],
      userMessages: [...this.#userMessages.values()],
    }
  }

  subscribe(subscriber: Subscriber): Unsubscribe {
    this.start()
    this.#subscribers.add(subscriber)
    // Paint from what is already known, so a surface opened mid-session is never
    // blank until the next broadcast…
    subscriber.render(this.snapshot)
    // …and read now if it is the first on-screen subscriber since the last change.
    if (subscriber.onScreen()) void this.refresh()
    return () => {
      this.#subscribers.delete(subscriber)
    }
  }

  /** Re-read now, bypassing the debounce. */
  async refresh(): Promise<void> {
    const threadId = this.#threadId
    if (threadId === null) return
    let records: ToolCallRecord[]
    let subtasks: SubtaskRecord[] | null
    try {
      const [calls, rows] = await Promise.all([
        window.flow.toolCalls.list({ threadId, outputLimit: OUTPUT_LIMIT }),
        this.#readSubtasks(threadId),
        // Messages once per thread; after that, message events keep them.
        this.#messagesReadFor === threadId ? Promise.resolve() : this.#readMessages(threadId),
      ])
      records = calls
      subtasks = rows
    } catch (error) {
      console.error('flow: background activity fetch failed', { threadId, error })
      return
    }
    // A late response for a thread the user already left must not paint.
    if (threadId !== this.#threadId) return
    if (subtasks !== null) {
      this.#subtasks.clear()
      for (const record of subtasks) this.#subtasks.set(record.ticket, record)
    }
    this.#rows = activityRows(records)
    this.#spawnRecords = records.filter((record) => activityKind(record.toolName) === 'subagent')
    this.#emit()
  }

  /**
   * The active thread's sub-agent spawn records from the last list read, or
   * null when the store has none to offer (another thread, or no read yet).
   * This is what a live-row click resolves against (subagent-open.ts): the
   * store re-reads on every tool_call change while a subscriber is on screen,
   * so these are at most one debounce window behind — and a miss only ever
   * degrades to the live-progress fallback, never to the wrong chat.
   */
  spawnRecords(threadId: string): ToolCallRecord[] | null {
    if (threadId !== this.#threadId) return null
    return this.#spawnRecords
  }

  /** A thread's subtasks, or null when this build has no subtasks or the
   *  read failed — the rows already known are then kept. */
  async #readSubtasks(threadId: string): Promise<SubtaskRecord[] | null> {
    const api = window.flow.subtasks
    if (api === undefined) return null
    try {
      return await api.list({ threadId })
    } catch (error) {
      console.warn('flow: subtask read failed', { threadId, error })
      return null
    }
  }

  /** Fold the newest person's messages into the known set. Never throws. */
  async #readMessages(threadId: string): Promise<void> {
    let messages: ThreadMessage[]
    try {
      messages = await window.flow.messages.list({ threadId, limit: MESSAGE_WINDOW })
    } catch (error) {
      console.warn('flow: message read for background work failed', { threadId, error })
      return
    }
    if (threadId !== this.#threadId) return
    this.#messagesReadFor = threadId
    for (const message of messages) {
      if (message.role !== 'user') continue
      this.#userMessages.set(message.id, { id: message.id, content: message.content, createdAt: message.createdAt })
    }
  }

  #queueMessages(): void {
    if (![...this.#subscribers].some((subscriber) => subscriber.onScreen())) return
    if (this.#messageTimer !== null) clearTimeout(this.#messageTimer)
    this.#messageTimer = setTimeout(() => {
      this.#messageTimer = null
      const threadId = this.#threadId
      if (threadId === null) return
      void this.#readMessages(threadId).then(() => {
        if (threadId === this.#threadId) this.#emit()
      })
    }, REFRESH_DEBOUNCE_MS)
  }

  #setActiveThread(threadId: string | null): void {
    if (threadId === this.#threadId) return
    this.#threadId = threadId
    this.#rows = []
    this.#spawnRecords = null
    this.#taskRows = []
    this.#retained.clear()
    this.#subtasks.clear()
    this.#userMessages.clear()
    this.#messagesReadFor = null
    this.#emit()
    if (threadId !== null) {
      void this.refresh()
      // Seed the live set for a thread opened mid-run — the stream only carries
      // CHANGES, so a thread with agents already running would otherwise show
      // none until the next change (#1931, mirrors the sidebar's mount read).
      void this.#seedTasks(threadId)
    }
  }

  async #seedTasks(threadId: string): Promise<void> {
    const fn = window.flow.threads.backgroundTasks
    if (fn === undefined) return
    const byThread = await fn({}).catch(() => undefined)
    if (byThread === undefined || threadId !== this.#threadId) return
    this.#applyTasks(taskActivityRows(byThread[threadId] ?? [], threadId))
    this.#emit()
  }

  /**
   * Fold the live set into the retained set: a task present is RUNNING; a task
   * previously seen but now absent FINISHED — kept, marked done, so it still
   * lists after the stream ends (#1931). `#taskRows` is the retained set.
   */
  #applyTasks(liveRows: readonly BackgroundActivityRow[]): void {
    const liveIds = new Set(liveRows.map((row) => row.id))
    for (const row of liveRows) this.#retained.set(row.id, row)
    for (const [id, row] of this.#retained) {
      if (!liveIds.has(id) && row.running) {
        this.#retained.set(id, { ...row, status: 'success', running: false })
      }
    }
    this.#taskRows = [...this.#retained.values()]
  }

  #queueRefresh(): void {
    // Somebody can see it, or nothing is worth fetching — an off-screen surface
    // re-reads on the way back in (subscribe/onScreen), it does not queue work.
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

/** The app has one active thread, so it has one background-activity list. */
export const backgroundActivityStore = new BackgroundActivityStore()
