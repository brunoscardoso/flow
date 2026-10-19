// Task service — coordinates task creation across TaskStore + ThreadStore +
// IntegrationsManager, and supplies the decoupled AgentManager hooks that drive
// seeding and Kanban lane automation. Kept free of Electron/IPC so it unit-tests
// against fakes.

import type { ThreadStore } from '../store/thread-store'
import type {
  TaskStore,
  TaskRecord,
  TaskBriefStatus,
  TaskSource,
  UpdateTaskInput,
} from '../store/task-store'
import type { IntegrationsManager } from '../integrations/integrations-manager'
import type { IssueImage } from '../integrations/issue-images'
import { isAppDrivenTaskPatch } from '../../shared/task-activity'
import { briefOnActivation } from './brief-on-activation'
import { closeRemoteOnDone, type CloseRemoteOnDoneDeps } from './close-remote-on-done'
import {
  capDescription,
  parseIssueRef,
  issueCode,
  titleWithCode,
  unrecognizedRefHint,
  type IssueProvider,
  type IssueRef,
} from '../issue-ref'

/** One-shot text generator (wired to the SDK in production, faked in tests). */
export type BriefGenerator = (input: {
  projectRoot: string
  prompt: string
}) => Promise<string | null>

export interface TaskServiceDeps {
  taskStore: TaskStore
  threadStore: ThreadStore
  integrations: IntegrationsManager
}

/** Create a manual task (typed title, optional description) + its 1:1 thread. */
export function createManualTask(
  deps: Pick<TaskServiceDeps, 'taskStore' | 'threadStore'>,
  input: { projectRoot: string; title: string; description?: string; additionalRoots?: string[] },
): TaskRecord {
  const thread = deps.threadStore.createThread({
    projectRoot: input.projectRoot,
    title: input.title,
  })
  try {
    // Extra context folders chosen in the New Task modal seed the spawned thread's
    // additional roots, so the task's agent reads them from its first turn (#695).
    if (input.additionalRoots && input.additionalRoots.length > 0) {
      deps.threadStore.setThreadRoots(thread.id, input.additionalRoots)
    }
    return deps.taskStore.createTask({
      projectRoot: input.projectRoot,
      title: input.title,
      source: 'manual',
      description: input.description ?? null,
      threadId: thread.id,
    })
  } catch (error) {
    // Never leave a bare orphan thread behind if the task insert fails.
    deps.threadStore.deleteThread(thread.id)
    throw error
  }
}

/**
 * Guarantee the task has a live 1:1 thread, creating and linking a fresh one if
 * it doesn't, and return the task.
 *
 * A task and its chat are 1:1, but only the task side of that pair was honest
 * about it ("Delete task + thread"). Deleting the THREAD — reachable in two
 * ordinary gestures, because the sidebar deliberately drops the task layer while
 * searching and shows a task's thread as a plain chat row with the full ⋯ menu —
 * left the task alive with `thread_id` nulled by the FK. The card stayed on the
 * board, the detail modal still opened, and its primary (and only) action "Open
 * chat" became a total dead click, with no in-app way to attach a new thread.
 * This is that way out (#1061).
 *
 * Idempotent: a task whose thread is intact is returned untouched, so callers can
 * route every "open this task's chat" through here.
 */
export function ensureTaskThread(
  deps: Pick<TaskServiceDeps, 'taskStore' | 'threadStore'>,
  taskId: string,
): TaskRecord {
  const task = deps.taskStore.getTask(taskId)
  if (!task) throw new Error(`Task no longer exists: ${taskId}`)
  // Also covers a dangling id: the FK nulls the column, but a task whose thread
  // vanished by any other route must not be handed back as healthy.
  if (task.threadId && deps.threadStore.getThread(task.threadId)) return task
  const thread = deps.threadStore.createThread({
    projectRoot: task.projectRoot,
    title: task.title,
  })
  deps.taskStore.linkThread(task.id, thread.id)
  return deps.taskStore.getTask(taskId) ?? { ...task, threadId: thread.id }
}

/**
 * Mirror a thread's title onto the task that owns it, if any.
 *
 * A task and its 1:1 chat are ONE object with ONE name (#1447), so any change to
 * the thread's title has to reach the owning task or the board card, the detail
 * modal and the idle sidebar row all keep the old name. The manual-rename path
 * (`threads:update`) did this inline; the AUTO-title path did not — it writes the
 * thread store directly after the first clean turn, so a "from scratch" task
 * (created titleless, named from its opening message) got its thread named and
 * its card left reading "Untitled task" forever.
 *
 * This is that one mirror, shared by both writers (allowed-pattern #14). Guarded
 * on a real change so a title that merely restates the current one does not bump
 * the board's sort clock and yank the card up a lane (#1192). The task store's
 * `updateTask` rides out on `tasks:updated`, so every task surface re-renders.
 */
export function syncTaskTitleFromThread(
  deps: Pick<TaskServiceDeps, 'taskStore'>,
  threadId: string,
  title: string,
): void {
  const owner = deps.taskStore.getTaskByThreadId(threadId)
  if (owner && owner.title !== title) {
    deps.taskStore.updateTask(owner.id, { title })
  }
}

/** The collaborators a task update's side effects need — each injected so the
 *  update path tests offline and stays free of Electron/IPC. */
export interface ApplyTaskUpdateDeps {
  taskStore: TaskStore
  threadStore: ThreadStore
  briefGenerator: BriefGenerator
  /** Wired to AppSettingsStore + IntegrationsManager + the flow:notification
   *  broadcast in production; a fake offline. */
  closeRemote: CloseRemoteOnDoneDeps
}

/**
 * Apply one patch to a task and fire the three side effects the board depends on.
 * THE ONE UPDATE PATH — the `tasks:update` IPC handler and the board tools both
 * call this, so a card moved from the chat agent triggers exactly what a card
 * dragged in the UI does (allowed-pattern #14). Extracted verbatim from the
 * handler; the collaborators it used inline are now injected.
 *
 * The three effects, and why each is fire-and-forget:
 *  - the 1:1 thread's title mirrors a rename, so the conversation header and the
 *    bare-thread row don't keep the stale name;
 *  - a card moving INTO an active lane without a brief gets one generated (the
 *    reaction itself decides whether anything fires);
 *  - a promoted tracker card moving INTO Done closes its remote ticket (#1885).
 * The lane move must return now and must never be blocked or reverted by a brief
 * or a network write.
 */
export function applyTaskUpdate(
  deps: ApplyTaskUpdateDeps,
  taskId: string,
  patch: UpdateTaskInput,
): TaskRecord {
  const { taskStore, threadStore, briefGenerator, closeRemote } = deps
  // Read the record BEFORE the write so the close reaction can tell a real
  // transition INTO done from a re-save of a card already there (#1885).
  const prev = taskStore.getTask(taskId)
  // #1192: an app-driven patch (e.g. a lone `suggestDone`) is not the user's
  // action — it must not bump the board's sort clock and yank the card up a lane.
  const record = taskStore.updateTask(taskId, patch, {
    activity: !isAppDrivenTaskPatch(patch),
  })
  // A task and its 1:1 thread are created with the SAME title — keep the thread
  // in sync on rename.
  if (patch.title !== undefined && record.threadId) {
    threadStore.updateThread(record.threadId, { title: patch.title })
  }
  void briefOnActivation(prev, record, {
    hasContent: taskHasBriefContent,
    generate: (id) => generateTaskBrief({ taskStore, briefGenerator }, id),
  })
  void closeRemoteOnDone(prev, record, closeRemote)
  return record
}

/**
 * The whole body of "record this external thing locally", shared by both entry
 * points: dedup by external key, create the 1:1 thread, insert the task, and on
 * failure clean up the orphan thread and recover a raced insert.
 *
 * THREE ENTRY POINTS, ONE IMPLEMENTATION (allowed-pattern #14). What differs
 * between `createTaskFromIssue`, `createTaskFromQueueItem` and
 * `createTaskFromAgentTodo` is WHERE the facts came from — one fetches them
 * from the tracker, one was handed them by the read the board already did, and
 * one read them out of an assistant's own todo list. Everything after that
 * point is the same set of invariants (one record per key per project, no
 * orphan thread, a race resolves to the record that won), and invariants that
 * live in three code paths drift.
 */
function createExternalTask(
  deps: Pick<TaskServiceDeps, 'taskStore' | 'threadStore'>,
  input: {
    projectRoot: string
    source: TaskSource
    externalKey: string
    externalUrl: string | null
    /** Already carrying its code prefix — the callers decide what to call it. */
    title: string
    description: string | null
    /**
     * The pictures the ticket carried, when the caller read any.
     *
     * OMITTED IS NOT EMPTY, all the way down to the column: a manual task and a
     * ledger item never had a tracker to ask, and must not be recorded as
     * tickets that answered "no screenshots".
     */
    images?: readonly IssueImage[] | null
    /** Whether the board's loop may work it. Absent is false. */
    autoFix?: boolean
    /**
     * The thread that PRODUCED this record, when one did. Provenance, never
     * ownership — it is passed straight through to the column of the same name
     * and is not the thread the task owns.
     */
    originThreadId?: string | null
    /**
     * Whether to spawn the task's own 1:1 thread up front. Default true, which
     * is every imported issue: somebody is going to open that card and start
     * working, and the chat should be waiting for them.
     *
     * FALSE IS FOR RECORDS CREATED IN BULK BY SOMETHING OTHER THAN A PERSON.
     * A mirrored todo list arrives a dozen items at a time, several times a
     * turn, and giving each one a thread on creation would file a dozen empty
     * conversations into the sidebar for every list an assistant rewrote —
     * burying the user's real chats under scaffolding they never asked for.
     * Nothing is lost by waiting: `ensureTaskThread` already creates and links
     * a thread the first time a task without one is opened, so the card's chat
     * appears when somebody actually wants it, and `threadId` keeps meaning
     * exactly what it has always meant — the conversation this task owns.
     */
    ownThread?: boolean
    /**
     * Extra project folders the spawned thread may read (#1694).
     *
     * SEEDED AT CREATION, like the title: the import tabs let a person tick the
     * other repos this piece of work spans, and a thread that got them one turn
     * later would have already answered its first question without them. Ignored
     * when no thread is spawned — there is nothing to scope.
     */
    additionalRoots?: string[]
  },
): { task: TaskRecord; created: boolean } {
  // Dedup is per-project — the same issue may be tracked in another project.
  const existing = deps.taskStore.getTaskByExternalKey(
    input.projectRoot,
    input.source,
    input.externalKey,
  )
  if (existing) return { task: existing, created: false }

  const thread =
    input.ownThread === false
      ? null
      : deps.threadStore.createThread({
          projectRoot: input.projectRoot,
          title: input.title,
        })
  try {
    if (thread && input.additionalRoots && input.additionalRoots.length > 0) {
      deps.threadStore.setThreadRoots(thread.id, input.additionalRoots)
    }
    const task = deps.taskStore.createTask({
      projectRoot: input.projectRoot,
      title: input.title,
      source: input.source,
      externalKey: input.externalKey,
      externalUrl: input.externalUrl,
      // Capped HERE rather than at each caller: a queue item's body is stored
      // verbatim and can be as long as whoever filed it made it, and the cap is
      // the same DB-leanness rule the fetched path has always had.
      description: capDescription(input.description ?? '') || null,
      ...(input.images === undefined ? {} : { images: input.images }),
      ...(input.autoFix === undefined ? {} : { autoFix: input.autoFix }),
      threadId: thread?.id ?? null,
      originThreadId: input.originThreadId ?? null,
    })
    return { task, created: true }
  } catch (error) {
    // Clean up the orphan thread — if one was made. If a concurrent import
    // already inserted the same key (both passed the dedup check before either
    // wrote), return that one rather than surfacing a UNIQUE-constraint error.
    if (thread) deps.threadStore.deleteThread(thread.id)
    const raced = deps.taskStore.getTaskByExternalKey(
      input.projectRoot,
      input.source,
      input.externalKey,
    )
    if (raced) return { task: raced, created: false }
    throw error
  }
}

/**
 * Create a task from a pasted Jira/GitHub key or URL: fetch the issue (read-only),
 * dedup by external key, and create the task + its 1:1 thread with the issue
 * title+description stored as seed context. Returns whether it was newly created.
 */
export async function createTaskFromIssue(
  deps: TaskServiceDeps,
  input: { projectRoot: string; keyOrUrl: string; additionalRoots?: string[] },
): Promise<{ task: TaskRecord; created: boolean }> {
  const ref = parseIssueRef(input.keyOrUrl)
  if (!ref) {
    throw new Error(unrecognizedRefHint(input.keyOrUrl))
  }
  const issue = await deps.integrations.fetchIssue(ref)

  return createExternalTask(deps, {
    projectRoot: input.projectRoot,
    source: ref.provider,
    externalKey: issue.key,
    externalUrl: issue.url,
    // Prefix the task/thread title with the ticket code (e.g. "ACME-2109: …") so
    // it's scannable at a glance in the board and sidebar.
    title: titleWithCode(issueCode(ref), issue.title),
    description: issue.description || null,
    // THE SCREENSHOTS COME WITH THE TICKET. Their addresses are in the payload
    // that was just fetched and nowhere else afterwards, so a task that did not
    // record them here can never show them without going back to the tracker.
    ...(issue.images === undefined ? {} : { images: issue.images }),
    // The folders the import tabs ticked (#1694) — seeded through the ONE
    // creator, rather than by a second copy of the thread/race handling that
    // `createExternalTask` exists to own.
    ...(input.additionalRoots === undefined ? {} : { additionalRoots: input.additionalRoots }),
  })
}

/** The facts a queue item already carries, as the board read them. */
export interface QueueItemFacts {
  projectRoot: string
  /**
   * The key the BOARD joins records to items on — `queueItemExternalKey`'s
   * `<location>#<id>`. Passed in rather than rebuilt here, because a record
   * keyed on anything else is a record the board's join will never find.
   */
  externalKey?: string | null
  /** The item's backend-native id: a GitHub issue number, or a ledger seq id. */
  itemId?: string | null
  /** The link the backend published for the item, when it published one. */
  url?: string | null
  title: string
  /** The item's body, verbatim, markers included. */
  body?: string | null
  /**
   * The ticket's pictures, when the read that produced this item named any.
   *
   * The Remote column's read already holds them, so promoting an item keeps
   * the strip the card showed instead of losing it at the board's edge.
   */
  images?: readonly IssueImage[] | null
  /** Whether the board's loop may work the card this becomes. */
  autoFix?: boolean
  /** `github` | `ledger`, exactly as `loop list` reported it. */
  queueKind?: string | null
  /**
   * The other projects the task's chat reads besides `projectRoot` — the ones a
   * person ticked on a remote ticket. Seeded through the ONE creator
   * (`createExternalTask`), exactly as the import tabs seed theirs.
   */
  additionalRoots?: string[]
}

/**
 * Create the run record for a queue item the board ALREADY READ — no fetch.
 *
 * WHY THIS EXISTS AT ALL. FR-7 says a local run record is created when
 * execution starts, and Phase 6 delivered that through `createTaskFromIssue`,
 * which refetches the issue through the integrations manager. That refetch is a
 * second read of a thing already in hand, and it needs a provider token — so
 * the two cases FR-7 most cares about recorded nothing: a **ledger** queue (the
 * Flow-is-the-truth-source mode) has no tracker to fetch from at all and its
 * `<path>#<id>` key does not parse as an issue ref, and a **GitHub** queue on a
 * machine with no working `gh`/PAT claims fine and then fails the fetch. The
 * claim landed both times; only the record was missing.
 *
 * NOTHING HERE ASKS THE NETWORK A QUESTION. `parseIssueRef` is a regex over a
 * string, not a request, and it is consulted only to name the source of an item
 * whose queue kind said nothing. The deps are `taskStore + threadStore` only —
 * the absence of `integrations` from the signature is the no-refetch guarantee,
 * enforced by the type rather than by a comment.
 */
export function createTaskFromQueueItem(
  deps: Pick<TaskServiceDeps, 'taskStore' | 'threadStore'>,
  input: QueueItemFacts,
): { task: TaskRecord; created: boolean } {
  const url = trimmedOrNull(input.url)
  const ref = url === null ? null : parseIssueRef(url)
  // The board's join key first. A URL-derived key is the fallback for an item
  // whose queue named no location: `parseIssueRef`'s canonical `owner/repo#123`
  // when the link is a recognizable issue, else the link itself — which at
  // least joins through the model's by-URL index.
  const externalKey = trimmedOrNull(input.externalKey) ?? ref?.key ?? url
  if (externalKey === null) {
    throw new Error(
      'This item names no queue location and no link, so there is nothing to record the run under.',
    )
  }
  const title = trimmedOrNull(input.title) ?? externalKey
  const itemId = trimmedOrNull(input.itemId)
  return createExternalTask(deps, {
    projectRoot: input.projectRoot,
    source: sourceForQueueItem(input.queueKind, ref),
    externalKey,
    externalUrl: url,
    // Same shape as the fetched path's title: `#1533: <title>`. The item's id
    // IS the issue code for a GitHub queue (`issueCode` builds `#<number>` from
    // the same number), and reads the same way for a ledger's sequence id.
    title: itemId === null ? title : titleWithCode(`#${itemId}`, title),
    // The body VERBATIM, markers and all. Stripping the `loop:` / `loop-claim:`
    // lines would be a second reader of a record the backend already parsed
    // into the item's own fields — the drift the queue boundary exists to
    // prevent — and the seed is more useful with the item's real text than with
    // a tidied-up version of it.
    description: input.body ?? null,
    ...(input.images === undefined ? {} : { images: input.images }),
    ...(input.autoFix === undefined ? {} : { autoFix: input.autoFix }),
    ...(input.additionalRoots === undefined ? {} : { additionalRoots: input.additionalRoots }),
  })
}

/**
 * Where a task's chosen projects are remembered (app settings rows — no schema
 * change: the installed app refuses a profile past its schema version).
 *
 * `setExtra` is the card's "projects besides its own" row the board already
 * reads; `markChosen` records that a PERSON picked them, which is what tells
 * the first-prompt context gate not to guess again — a task whose person
 * ticked exactly one project has no extra row to show for it.
 */
export interface TaskProjectsRecord {
  setExtra(taskId: string, roots: readonly string[]): string[]
  markChosen(taskId: string): void
}

/** Record the projects a person chose for a task. The ONE writer of both rows. */
export function rememberChosenProjects(
  record: TaskProjectsRecord,
  taskId: string,
  additionalRoots: readonly string[],
): string[] {
  const stored = record.setExtra(taskId, additionalRoots)
  record.markChosen(taskId)
  return stored
}

/**
 * Whether a task's chat has started — its session exists or a message was
 * written. After that the chat's projects are the chat's own (its chips), and
 * the card no longer edits them.
 */
export function taskChatHasStarted(
  threadStore: Pick<ThreadStore, 'getThread' | 'countMessages'>,
  threadId: string | null,
): boolean {
  if (threadId === null) return false
  const thread = threadStore.getThread(threadId)
  if (thread === null) return false
  return thread.sdkSessionId !== null || threadStore.countMessages(threadId) > 0
}

/**
 * Change the projects of a task whose chat has not started (the card's
 * "Change"). `roots[0]` is where the chat runs; the rest are context.
 *
 * A DIFFERENT FIRST PROJECT MOVES THE TASK. A thread's project is fixed when it
 * is created, so the unstarted (empty) thread is replaced by a fresh one in the
 * new project — the same pairing `ensureTaskThread` makes — and the task's own
 * `project_root` follows. Refused when the chat has started, when nothing is
 * chosen, or when the new project already has a task for the same ticket.
 */
export function chooseTaskProjects(
  deps: Pick<TaskServiceDeps, 'taskStore' | 'threadStore'> & { projects: TaskProjectsRecord },
  input: { taskId: string; roots: readonly string[] },
): { task: TaskRecord; additionalRoots: string[] } {
  const roots = [...new Set(input.roots.map((root) => root.trim()).filter((root) => root.length > 0))]
  const first = roots[0]
  if (first === undefined) throw new Error('Choose at least one project for this task.')
  const existing = deps.taskStore.getTask(input.taskId)
  if (!existing) throw new Error('This task no longer exists.')
  if (taskChatHasStarted(deps.threadStore, existing.threadId)) {
    throw new Error("This task's chat has started, so its projects are changed from the chat now.")
  }
  const additional = roots.slice(1)
  let task = existing
  if (first !== existing.projectRoot) {
    if (existing.externalKey !== null) {
      const clash = deps.taskStore.getTaskByExternalKey(first, existing.source, existing.externalKey)
      if (clash && clash.id !== existing.id) {
        throw new Error('That project already has a task for this ticket.')
      }
    }
    const previousThread = existing.threadId
    const thread = deps.threadStore.createThread({ projectRoot: first, title: existing.title })
    try {
      // ONE TRANSACTION. Moved but not re-linked is a task in the new project
      // pointing at the old project's thread — and the catch below deletes the
      // only thread that would have matched it.
      deps.taskStore.inTransaction(() => {
        deps.taskStore.moveTask(existing.id, first)
        deps.taskStore.linkThread(existing.id, thread.id)
      })
    } catch (error) {
      deps.threadStore.deleteThread(thread.id)
      throw error
    }
    // The old thread never started — nothing in it to keep. UNLESS IT HAS A
    // CHECKOUT: an unstarted chat can still have had its copy of the project
    // cut, and files may have been edited there by hand. Deleting the thread
    // would hand that checkout to the backstop release with nobody looking, so
    // it stays — a plain conversation in its old project, whose files are
    // freed the deliberate way (the sidebar's delete says what goes).
    const previous = previousThread === null ? null : deps.threadStore.getThread(previousThread)
    if (previous !== null && previous.worktreePath === null) {
      deps.threadStore.deleteThread(previous.id)
    }
    task = deps.taskStore.getTask(existing.id) ?? existing
  }
  if (task.threadId !== null) deps.threadStore.setThreadRoots(task.threadId, additional)
  const stored = rememberChosenProjects(deps.projects, task.id, additional)
  return { task, additionalRoots: stored }
}

/**
 * Record one todo an assistant listed, as a card on the board.
 *
 * THE THIRD CALLER OF `createExternalTask`, and it wants the same four
 * invariants the other two want: one record per key per project, no orphan
 * thread, a race resolved to the record that won, and the description capped.
 * The dedup is doing more work here than anywhere else — an assistant resends
 * its ENTIRE list several times a turn, so the same key arrives again and again
 * and the check that returns the existing record is what stands between this
 * feature and a board that grows a duplicate card per rewrite.
 *
 * `externalKey` CARRIES THE TODO'S IDENTITY, which is what makes that dedup
 * possible: it is the assistant's own wording, normalized, scoped to the thread
 * that said it (see `mirrorExternalKey`). It reads as a hijack of a field named
 * for issue trackers and it is not — the field means "the stable handle this
 * record was created from, in the system it came from", the assistant's list is
 * that system, and normalized wording is the only handle that list offers.
 *
 * `source` STAYS `manual`, for the reason `sourceForQueueItem` sets out at
 * length: `TaskSource` names an external tracker, an assistant's todo list is
 * not one, and a new persisted vocabulary word costs every reader a mapping it
 * would only ever resolve back to "not from a tracker". It also keeps the key
 * INVISIBLE — every surface that renders `externalKey` guards on
 * `source !== 'manual'` first — so this internal handle never reaches a person's
 * screen, which it must not: it is machine bookkeeping and reads like it.
 *
 * Provenance goes to `originThreadId` and the task owns NO thread of its own
 * yet. Both are deliberate and both are explained where they are declared.
 */
export function createTaskFromAgentTodo(
  deps: Pick<TaskServiceDeps, 'taskStore' | 'threadStore'>,
  input: { projectRoot: string; originThreadId: string; key: string; title: string },
): { task: TaskRecord; created: boolean } {
  return createExternalTask(deps, {
    projectRoot: input.projectRoot,
    source: 'manual',
    externalKey: mirrorExternalKey(input.originThreadId, input.key),
    externalUrl: null,
    title: input.title,
    // NOTHING IN THE BODY. A todo is one line of wording and that line is
    // already the title; repeating it underneath would give every mirrored card
    // a description that says what the card says, and — because a description
    // is what makes a task eligible for a generated brief — would queue an LLM
    // call per todo to summarize a sentence.
    description: null,
    originThreadId: input.originThreadId,
    ownThread: false,
  })
}

/**
 * Record one task an assistant created through the ID-ADDRESSED protocol.
 *
 * THE FOURTH CALLER OF `createExternalTask`, AND IT FORKS NOTHING. It wants the
 * same invariants the other three want — one record per key per project, no
 * orphan thread, a race resolved to the record that won, the description capped —
 * and the only things it decides for itself are the key it files under and the
 * fact that it brings a description at all. A second creation path written
 * because this protocol is "different" would be a second place for those four
 * invariants to drift (allowed-pattern #14).
 *
 * IT CARRIES A DESCRIPTION AND ITS SIBLING DOES NOT, and that is a difference in
 * the payloads rather than a difference of opinion. A todo is one line of wording
 * and that line is already the title, so repeating it underneath says nothing.
 * This protocol sends a subject AND a separate account of what needs doing —
 * genuinely different text, written by the assistant for a reader — and dropping
 * it would throw away the most useful thing on the card.
 *
 * Everything else matches the todo mirror exactly, for the reasons set out there
 * at length: `source` stays `manual` (an assistant's task list is not a tracker,
 * and `manual` is what keeps this internal key off every screen), provenance goes
 * to `originThreadId`, and the card owns no thread until somebody opens it.
 */
export function createTaskFromAgentTask(
  deps: Pick<TaskServiceDeps, 'taskStore' | 'threadStore'>,
  input: {
    projectRoot: string
    originThreadId: string
    taskId: string
    title: string
    description?: string | null
  },
): { task: TaskRecord; created: boolean } {
  return createExternalTask(deps, {
    projectRoot: input.projectRoot,
    source: 'manual',
    externalKey: mirrorTaskExternalKey(input.originThreadId, input.taskId),
    externalUrl: null,
    title: input.title,
    description: input.description ?? null,
    originThreadId: input.originThreadId,
    ownThread: false,
  })
}

/**
 * The key a mirrored card is stored under: the todo's identity, scoped to the
 * thread that listed it.
 *
 * SCOPED, BECAUSE THE IDENTITY IS ONLY UNIQUE WITHIN ONE CONVERSATION. Two
 * threads in one project can each have an assistant listing "run the tests", and
 * they are two pieces of work — the dedup key must not fold them into one card
 * whose lane flips as whichever thread reported last.
 *
 * The pairing is also what makes the trip back possible: `mirrorKeyForCard`
 * reads the todo's identity out of a stored card by removing the thread it
 * belongs to, so the reconcile matches on the key the card was ACTUALLY
 * mirrored under rather than re-deriving one from a title a person may since
 * have edited. Both directions live here, next to each other, so a change to
 * the separator cannot be made to one and forgotten in the other.
 */
export function mirrorExternalKey(threadId: string, key: string): string {
  return `${threadId}#${key}`
}

/**
 * The marker that separates the two mirrors' keys — and why a collision between
 * them is STRUCTURALLY impossible rather than merely unlikely.
 *
 * There are two assistant task protocols and each has its own mirror: one keyed
 * on a todo's normalized wording, one keyed on the id the assistant is handed.
 * Both file their cards under the same thread prefix, so without something
 * between them a todo whose wording happened to equal an id would land on the
 * other mirror's card and the two would fight over its lane.
 *
 * UPPERCASE IS THE GUARANTEE, AND IT IS ENFORCED BY A FUNCTION, NOT BY LUCK. A
 * todo's key is `todoKey`'s output, and `todoKey` lowercases everything it is
 * given — so no key it can ever produce, for any wording anybody could write,
 * contains an uppercase letter. A marker that does cannot be reached from that
 * side at all. The other direction is closed the same way: both readers below
 * check for the marker and hand back null for a key that belongs to the other,
 * so neither mirror can be handed the other's card even by a caller trying to.
 */
const TASK_MIRROR_MARKER = 'TASK#'

/**
 * The key a card mirrored from the ID-ADDRESSED protocol is stored under: the
 * assistant's own task id, marked as belonging to that protocol and scoped to the
 * thread that issued it.
 *
 * THREAD-SCOPED FOR A HARDER REASON THAN THE TODO KEYS ARE. A todo's wording is
 * at least distinctive; these ids are small integers that RESTART AT 1 IN EVERY
 * CONVERSATION — the recorded traffic this was built against has two threads that
 * each number their tasks 1 upward. Unscoped, one project's second conversation
 * would take over the first one's cards wholesale.
 */
export function mirrorTaskExternalKey(threadId: string, taskId: string): string {
  return `${threadId}#${TASK_MIRROR_MARKER}${taskId}`
}

/**
 * The assistant's task id a mirrored card was stored under, or null if this card
 * is not one of that thread's id-addressed cards.
 *
 * The exact mirror of `mirrorTaskExternalKey`, kept next to it so a change to the
 * marker cannot be made to one and forgotten in the other, and returning null —
 * never a guess — for a manual card, an imported issue, another thread's card, or
 * a card belonging to the todo-list mirror.
 */
export function mirrorTaskIdForCard(threadId: string, externalKey: string | null): string | null {
  if (externalKey === null) return null
  const prefix = `${threadId}#${TASK_MIRROR_MARKER}`
  if (!externalKey.startsWith(prefix)) return null
  const taskId = externalKey.slice(prefix.length)
  return taskId.length > 0 ? taskId : null
}

/**
 * The todo identity a mirrored card was stored under, or null if this card is
 * not one of that thread's mirrored cards.
 *
 * Returns null rather than guessing for anything that does not carry the exact
 * prefix — a manually created card, an imported issue, or a card mirrored from a
 * DIFFERENT thread — so a caller cannot accidentally treat somebody's own task
 * as a stale todo. Only the first separator is consumed: a todo's wording may
 * contain one, and the remainder is its key verbatim.
 *
 * AND IT REFUSES THE OTHER MIRROR'S CARDS. A card filed by the id-addressed
 * protocol carries this same thread prefix, so the marker is checked here too:
 * the whole-list mirror would otherwise be handed cards it can never match and
 * would report every one of them as a todo the assistant had stopped naming.
 */
export function mirrorKeyForCard(threadId: string, externalKey: string | null): string | null {
  if (externalKey === null) return null
  const prefix = `${threadId}#`
  if (!externalKey.startsWith(prefix)) return null
  const key = externalKey.slice(prefix.length)
  if (key.length === 0) return null
  return key.startsWith(TASK_MIRROR_MARKER) ? null : key
}

/**
 * Which `TaskSource` a queue item's record carries.
 *
 * A LEDGER ITEM IS SOURCED `manual`, AND THAT IS NOT A COMPROMISE. `TaskSource`
 * names the store a record came FROM, and the ledger is not a tracker Flow
 * imported from — it is Flow's own list, kept in the project. `manual` is the
 * one value that means "no external tracker", which is exactly the ledger's
 * case, and the board already agrees: `originForItem` reads a ledger item's
 * chip as `you` and `originForTask` reads a `manual` record's chip as `you`, so
 * a ledger card keeps ONE chip whether the item is still on the list or only
 * the record survives it.
 *
 * WIDENING `TaskSource` WITH A `ledger` MEMBER WAS THE ALTERNATIVE, AND IT IS
 * NOT NEEDED. The persistence side would take it — migration v9 rebuilt `tasks`
 * without the `source` CHECK precisely so a new provider needs no migration —
 * but the value is persisted forever, `BoardOrigin` has no `ledger` chip to map
 * it to, and `originForTask`'s exhaustive switch is a board-model decision this
 * change is not entitled to reopen. A new persisted vocabulary word that every
 * reader would have to map back onto `you` is a cost with no answer to buy.
 *
 * COLLISION IS IMPOSSIBLE ANYWAY, and not because the strings differ: dedup is
 * `(projectRoot, source, externalKey)`, so a ledger record and a GitHub record
 * are two rows even on the same key string. The key shapes also differ in
 * practice (`owner/repo#123` vs `flow/loops/queue.jsonl#7`), but the source
 * column is the guarantee, not the coincidence.
 */
function sourceForQueueItem(kind: string | null | undefined, ref: IssueRef | null): TaskSource {
  const normalized = (kind ?? '').trim().toLowerCase()
  if (normalized === 'github') return 'github'
  if (normalized === 'ledger') return 'manual'
  // A kind nobody reported: the link may still name a tracker, and matching
  // what `createTaskFromIssue` would have stored keeps one record per issue
  // across both entry points. Nothing is guessed — an unrecognizable link
  // yields `manual`, the source that claims no tracker.
  return ref?.provider ?? 'manual'
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// ── Technical brief (PM-style, engineer-focused summary) ─────────────────────

/** True when a task has enough substance to summarize into a brief. */
export function taskHasBriefContent(task: TaskRecord): boolean {
  return Boolean((task.description && task.description.trim()) || task.externalKey)
}

/**
 * Generate the task's technical brief and persist it. Sets `pending` up front so
 * the UI can show progress, then `ready` (with text) or `error`.
 *
 * NEVER throws — it runs fire-and-forget after an import, so any failure past
 * this boundary would be an unhandled main-process rejection (#114). Returns
 * null when the task no longer exists (e.g. deleted during the multi-second LLM
 * call) or when a brief write fails; every `setBrief` is guarded so the error
 * handler can't itself throw.
 */
export async function generateTaskBrief(
  deps: { taskStore: TaskStore; briefGenerator: BriefGenerator },
  taskId: string,
): Promise<TaskRecord | null> {
  const task = deps.taskStore.getTask(taskId)
  if (!task) return null
  if (!taskHasBriefContent(task)) return safeSetBrief(deps.taskStore, taskId, 'idle')

  if (!safeSetBrief(deps.taskStore, taskId, 'pending')) return null
  try {
    const text = await deps.briefGenerator({
      projectRoot: task.projectRoot,
      prompt: buildBriefPrompt(task),
    })
    const brief = (text ?? '').trim()
    return safeSetBrief(deps.taskStore, taskId, brief ? 'ready' : 'error', brief || null)
  } catch (error) {
    console.error(`[task-service] Brief generation failed for ${taskId}:`, error)
    return safeSetBrief(deps.taskStore, taskId, 'error')
  }
}

/**
 * `setBrief` that swallows a deleted-task or DB failure (e.g. SQLITE_BUSY),
 * returning null instead of throwing — so `generateTaskBrief`'s "never throws"
 * contract holds even when the terminal write races a delete (#114).
 */
function safeSetBrief(
  taskStore: TaskStore,
  taskId: string,
  status: TaskBriefStatus,
  brief?: string | null,
): TaskRecord | null {
  try {
    return taskStore.setBrief(taskId, status, brief)
  } catch (error) {
    console.warn(`[task-service] setBrief('${status}') skipped for ${taskId}:`, error)
    return null
  }
}

/** Build the summarization prompt from a task's issue/PR context. */
export function buildBriefPrompt(task: TaskRecord): string {
  const isPr = task.source === 'azure' && /pullrequest|\/pr\//i.test(task.externalUrl ?? '')
  const kind = isPr ? 'pull request' : task.source === 'manual' ? 'task' : 'issue'
  const lines = [
    `Title: ${task.title}`,
    `Source: ${sourceLabel(task.source)}${task.externalKey ? ` (${task.externalKey})` : ''}`,
  ]
  if (task.externalUrl) lines.push(`Link: ${task.externalUrl}`)
  lines.push('', 'Description:', task.description?.trim() || '(no description provided)')
  return (
    'You are a technical program manager writing a short brief for the engineer ' +
    `who will pick up this ${kind}. Read it and write a concise, technical brief.\n\n` +
    'Rules:\n' +
    '- Focus on technical substance the engineer needs — not fluff or restating the title.\n' +
    '- Use 3 to 6 short bullet points (start each line with "- ").\n' +
    '- Cover: what it is, the key components/areas involved, and what to pay attention to.\n' +
    (isPr ? '- Since this is a PR, summarize what it changes and the review focus areas.\n' : '') +
    '- Keep it under ~150 words. No heading, no preamble, no closing remarks.\n\n' +
    `<${kind}>\n${lines.join('\n')}\n</${kind}>`
  )
}

// ── AgentManager hook factories (decoupled lane + seed automation) ───────────

/** Seed the agent's first turn with the task's issue context, if any. */
export function makeSeedProvider(taskStore: TaskStore): (threadId: string) => string | null {
  return (threadId) => {
    const task = taskStore.getTaskByThreadId(threadId)
    if (!task || !task.description) return null
    const label = task.externalKey ? `${sourceLabel(task.source)} ${task.externalKey}` : task.title
    return `You're working on ${label}: ${task.title}\n\n${task.description}`
  }
}

/**
 * On the first agent turn, nudge a Todo task to Doing (never touches Doing/Done).
 *
 * `onActivated` is called with the (prev, next) records right after the card
 * enters Doing, so a caller can react to the activation — in production, generate
 * the task's technical brief if it has none yet (see `briefOnActivation`). This
 * is the ONLY hook the board loop's own path reaches: the loop starts the agent,
 * which fires this, and the Todo → Doing move never passes through `tasks:update`.
 * The nudge itself is unchanged when no callback is supplied.
 */
export function makeOnTurnStart(
  taskStore: TaskStore,
  onActivated?: (prev: TaskRecord, next: TaskRecord) => void,
): (threadId: string) => void {
  return (threadId) => {
    const task = taskStore.getTaskByThreadId(threadId)
    if (task && task.lane === 'todo') {
      // #1192: not the user's action — must not re-sort the board under them.
      const next = taskStore.updateTask(task.id, { lane: 'doing' }, { activity: false })
      onActivated?.(task, next)
    }
  }
}

/** On a clean turn, flag "suggest Done" — never auto-sets Done (a human call). */
export function makeOnTurnComplete(
  taskStore: TaskStore,
): (threadId: string, success: boolean) => void {
  return (threadId, success) => {
    if (!success) return
    const task = taskStore.getTaskByThreadId(threadId)
    if (task && task.lane !== 'done' && !task.suggestDone) {
      // #1192: same — a background turn finishing must not yank this card to
      // the top of its lane while the user is reaching for another one.
      taskStore.updateTask(task.id, { suggestDone: true }, { activity: false })
    }
  }
}

function sourceLabel(source: IssueProvider | 'manual'): string {
  return source === 'jira'
    ? 'Jira'
    : source === 'github'
      ? 'GitHub issue'
      : source === 'azure'
        ? 'Azure work item'
        : 'task'
}
