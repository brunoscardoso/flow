/**
 * PLAN CHANGE REVIEW — one open review of one plan. DOM-free; its IPC, its
 * storage and its send are injected, so a test drives it with fakes.
 *
 * The plan file is the record (plan `plan_change_review`): Accept and Reject
 * go to main's one writer AT ONCE, and the note comes back as written. A
 * write that fails leaves the note as it was, marked "not saved", so a half
 * reviewed plan never shows a decision the file does not hold. Comments are
 * context, kept as a per-plan draft until Send review sends ONE message into
 * the plan's thread and clears them.
 */
import type {
  PlanNoteReport,
  PlanNoteVerdict,
  PlanNotesAnswer,
  PlanSetNoteAnswer,
  PlanSetNoteRequest,
} from '../../shared/ipc-contract'
import {
  canRecordVerdict,
  canSend,
  composeReviewMessage,
  draftStorageKey,
  loadDrafts,
  nextStatus,
  notesToAcceptAll,
  noteWordsKey,
  saveDrafts,
  withComment,
  type DraftStorage,
} from './note-review-model'

/** What opened the review: the plan's card, with the thread it belongs to. */
export interface PlanReviewRequest {
  rootPath: string
  /** The plan's slug. */
  plan: string
  /** The plan's conversation — where Send review goes; null hides Send. */
  threadId: string | null
}

export interface PlanReviewDeps {
  notes(request: { rootPath: string; plan: string }): Promise<PlanNotesAnswer>
  setNote(request: PlanSetNoteRequest): Promise<PlanSetNoteAnswer>
  storage: DraftStorage | null
  /** Put a composed message into a thread, through the composer's own send. */
  sendPrompt(threadId: string, text: string): void
  /** The clock (ms) — injected so the own-write window is testable without sleeping. */
  now?: () => number
}

/**
 * How long after the session's own write lands a change to the plan file is
 * taken for that write's echo, not news: the watcher reports the file this
 * session just rewrote, and re-reading it would spawn the CLI to learn what
 * the write's own answer already said.
 */
export const OWN_WRITE_ECHO_MS = 2000

/** A note write in flight, or one that failed (with why). */
export type NoteSaveState = { state: 'saving' } | { state: 'failed'; detail: string }

export interface PlanReviewState {
  request: PlanReviewRequest
  /** True once the plan's notes were read (or the read failed). */
  loaded: boolean
  /** Why the notes could not be read — one sentence — or null. */
  error: string | null
  notes: PlanNoteReport[]
  /** The plan file (project-relative) — to match watcher events, never shown. */
  path: string | null
  drafts: Record<number, string>
  saves: Record<number, NoteSaveState>
  /** Send review was pressed, and nothing has changed since. */
  sent: boolean
  /** Accept all is writing its notes — pressing it again does nothing. */
  acceptingAll: boolean
}

/** The fields of a note a decision or a verdict writes — what a read must not take back. */
function withDecisionOf(note: PlanNoteReport, local: PlanNoteReport): PlanNoteReport {
  const { status, reason, verdict, verdictWhy } = local
  const merged: PlanNoteReport = { ...note, status }
  delete merged.reason
  delete merged.verdict
  delete merged.verdictWhy
  return {
    ...merged,
    ...(reason === undefined ? {} : { reason }),
    ...(verdict === undefined ? {} : { verdict }),
    ...(verdictWhy === undefined ? {} : { verdictWhy }),
  }
}

export class PlanReviewSession {
  readonly #deps: PlanReviewDeps
  readonly #onChange: () => void
  readonly #draftKey: string
  readonly #now: () => number
  #state: PlanReviewState
  #loadSeq = 0
  /**
   * EVERY write of this session runs on this one chain, one at a time — a
   * decision, a verdict, each note of Accept all. The plan file is rewritten
   * per write, so two writes in flight could each read the file before the
   * other landed and the second would put the first's note back. The CLI and
   * main serialize too; this session does not rely on them.
   */
  #chain: Promise<void> = Promise.resolve()
  #writesInFlight = 0
  /** Bumped whenever a write is pressed or lands — a read started before it is older than the screen. */
  #localVersion = 0
  /** Per note: the local version of its last decision — a read older than it keeps the decision on screen. */
  readonly #decidedAt = new Map<number, number>()
  #lastOwnWriteAt = Number.NEGATIVE_INFINITY

  constructor(request: PlanReviewRequest, deps: PlanReviewDeps, onChange: () => void) {
    this.#deps = deps
    this.#onChange = onChange
    this.#now = deps.now ?? (() => Date.now())
    this.#draftKey = draftStorageKey(request.rootPath, request.plan)
    this.#state = {
      request,
      loaded: false,
      error: null,
      notes: [],
      path: null,
      drafts: loadDrafts(deps.storage, this.#draftKey),
      saves: {},
      sent: false,
      acceptingAll: false,
    }
  }

  get state(): PlanReviewState {
    return this.#state
  }

  #set(patch: Partial<PlanReviewState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#onChange()
  }

  /**
   * Read (or re-read) the plan's notes. A newer read wins over an older one
   * still in flight, and a read never takes back a decision made after it
   * started (or still being saved): the screen keeps the newer local state.
   */
  async load(): Promise<void> {
    this.#loadSeq += 1
    const seq = this.#loadSeq
    const startedAt = this.#localVersion
    const { rootPath, plan } = this.#state.request
    let answer: PlanNotesAnswer
    try {
      answer = await this.#deps.notes({ rootPath, plan })
    } catch (error) {
      console.error('flow: reading the plan notes failed', { plan, error })
      answer = { ok: false, reason: null, detail: "Flow couldn't read this plan's notes." }
    }
    if (seq !== this.#loadSeq) return
    if (!answer.ok) {
      this.#set({ loaded: true, error: answer.detail })
      return
    }
    const notes = answer.notes.map((note) => {
      const newer = this.#state.saves[note.n]?.state === 'saving' || (this.#decidedAt.get(note.n) ?? -1) > startedAt
      if (!newer) return note
      const shown = this.#state.notes.find((entry) => entry.n === note.n)
      return shown === undefined ? note : withDecisionOf(note, shown)
    })
    // The agent revised the notes after a sent review: there is a new review to make.
    const revised = this.#state.loaded && noteWordsKey(this.#state.notes) !== noteWordsKey(notes)
    this.#set({ loaded: true, error: null, notes, path: answer.path, sent: this.#state.sent && !revised })
  }

  /** Whether a watcher event is about this review's plan file. */
  isPlanFile(rootId: string, path: string): boolean {
    return rootId === this.#state.request.rootPath && this.#state.path !== null && path === this.#state.path
  }

  /**
   * Whether a change to the plan file is worth a re-read: not while this
   * session's own writes are in flight, nor within `OWN_WRITE_ECHO_MS` of the
   * last one landing — that change is the write's echo, and its answer
   * already put the note on screen. An agent's revision arrives later, as its
   * own change.
   */
  get wantsReloadOnFileChange(): boolean {
    if (this.#writesInFlight > 0) return false
    return this.#now() - this.#lastOwnWriteAt >= OWN_WRITE_ECHO_MS
  }

  /** Run one write on the session's one chain; resolves when THAT write has landed. */
  #enqueue(write: () => Promise<void>): Promise<void> {
    this.#writesInFlight += 1
    const run = this.#chain.then(write).finally(() => {
      this.#writesInFlight -= 1
      this.#lastOwnWriteAt = this.#now()
    })
    this.#chain = run.catch(() => undefined)
    return run
  }

  #touch(n: number): void {
    this.#localVersion += 1
    this.#decidedAt.set(n, this.#localVersion)
  }

  /**
   * Accept or Reject a note — pressing the decision it already holds takes
   * it back to not reviewed. Shown at once, written in turn; on failure the
   * note keeps its old decision and is marked "not saved".
   */
  decide(n: number, pressed: 'accepted' | 'rejected', reason?: string): Promise<void> {
    const note = this.#state.notes.find((entry) => entry.n === n)
    if (note === undefined || this.#state.saves[n]?.state === 'saving') return Promise.resolve()
    const status = nextStatus(note.status, pressed)
    const trimmed = reason?.trim() ?? ''
    const previous = note
    this.#touch(n)
    this.#set({
      notes: this.#state.notes.map((entry) => (entry.n === n ? { ...entry, status } : entry)),
      saves: { ...this.#state.saves, [n]: { state: 'saving' } },
      sent: false,
    })
    const { rootPath, plan } = this.#state.request
    return this.#enqueue(async () => {
      let answer: PlanSetNoteAnswer
      try {
        answer = await this.#deps.setNote({
          rootPath,
          plan,
          note: n,
          status,
          ...(status === 'rejected' && trimmed !== '' ? { reason: trimmed } : {}),
        })
      } catch (error) {
        console.error('flow: saving a note decision failed', { plan, n, error })
        answer = { ok: false, reason: null, detail: "Flow couldn't write this decision to the plan." }
      }
      this.#settle(n, answer, previous)
    })
  }

  /**
   * Accept all: every note not reviewed yet is accepted, one write at a time
   * on the same chain as a single Accept. A rejected or accepted note is never
   * touched; a write that fails marks only its own note "not saved". Pressing
   * it again while it runs does nothing.
   */
  async acceptAll(): Promise<void> {
    if (this.#state.acceptingAll) return
    this.#set({ acceptingAll: true })
    try {
      const saving = new Set(
        Object.entries(this.#state.saves)
          .filter(([, save]) => save.state === 'saving')
          .map(([n]) => Number(n)),
      )
      for (const n of notesToAcceptAll(this.#state.notes, saving)) {
        // Re-checked per note: the person may have decided it while the others were written.
        const note = this.#state.notes.find((entry) => entry.n === n)
        if (note === undefined || note.status !== 'proposed' || this.#state.saves[n]?.state === 'saving') continue
        await this.decide(n, 'accepted')
      }
    } finally {
      this.#set({ acceptingAll: false })
    }
  }

  /** Record a verdict in Verify (the person overriding execution's). A rejected note has none. */
  setVerdict(n: number, verdict: PlanNoteVerdict, why: string): Promise<void> {
    const note = this.#state.notes.find((entry) => entry.n === n)
    const sentence = why.trim()
    if (note === undefined || !canRecordVerdict(note) || sentence === '' || this.#state.saves[n]?.state === 'saving') return Promise.resolve()
    const previous = note
    this.#touch(n)
    this.#set({
      notes: this.#state.notes.map((entry) => (entry.n === n ? { ...entry, verdict, verdictWhy: sentence } : entry)),
      saves: { ...this.#state.saves, [n]: { state: 'saving' } },
    })
    const { rootPath, plan } = this.#state.request
    return this.#enqueue(async () => {
      let answer: PlanSetNoteAnswer
      try {
        answer = await this.#deps.setNote({ rootPath, plan, note: n, verdict, why: sentence })
      } catch (error) {
        console.error('flow: saving a note verdict failed', { plan, n, error })
        answer = { ok: false, reason: null, detail: "Flow couldn't write this verdict to the plan." }
      }
      this.#settle(n, answer, previous)
    })
  }

  #settle(n: number, answer: PlanSetNoteAnswer, previous: PlanNoteReport): void {
    this.#touch(n)
    const saves = { ...this.#state.saves }
    if (answer.ok) {
      delete saves[n]
      this.#set({ notes: this.#state.notes.map((entry) => (entry.n === n ? answer.note : entry)), saves })
      return
    }
    saves[n] = { state: 'failed', detail: answer.detail }
    // Only the decision goes back: words a re-read brought in meanwhile stay.
    this.#set({ notes: this.#state.notes.map((entry) => (entry.n === n ? withDecisionOf(entry, previous) : entry)), saves })
  }

  /** Add a comment to the review's context (replacing the note's earlier one); empty removes it. */
  comment(n: number, text: string): void {
    const drafts = withComment(this.#state.drafts, n, text)
    saveDrafts(this.#deps.storage, this.#draftKey, drafts)
    this.#set({ drafts, sent: false })
  }

  get canSend(): boolean {
    return this.#state.request.threadId !== null && canSend(this.#state.notes, this.#state.saves)
  }

  /** Send review to the agent: one message, then the comments are cleared. False when it cannot be sent. */
  send(): boolean {
    const { threadId, plan } = this.#state.request
    if (threadId === null || !canSend(this.#state.notes, this.#state.saves)) return false
    this.#deps.sendPrompt(threadId, composeReviewMessage(plan, this.#state.notes, this.#state.drafts))
    saveDrafts(this.#deps.storage, this.#draftKey, {})
    this.#set({ drafts: {}, sent: true })
    return true
  }
}
