// TaskStore — persistence for the task list. A Task owns exactly one thread
// (1:1 via thread_id) and carries a source (manual / jira / github) + the
// external issue key/url + a Kanban lane. Mirrors ThreadStore: single writer,
// emits `change` events so the IPC layer can broadcast without polling.

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type { FlowDatabase } from './db'
import { withTransaction } from './db'
import type { IssueImage } from '../integrations/issue-images'

export type TaskSource = 'manual' | 'jira' | 'github' | 'azure'
/** Kanban lanes, in board order. `blocked` sits between doing and done: work
 *  that started and is now waiting on a human (a tripped loop breaker, or an
 *  item behind an approval gate) — not work that failed. `review` sits after it:
 *  work the agent finished and opened a pull request for, now waiting on a human
 *  to merge — see `prUrl`. */
export type TaskLane = 'todo' | 'doing' | 'blocked' | 'review' | 'done'
/** Lifecycle of a task's auto-generated technical brief. */
export type TaskBriefStatus = 'idle' | 'pending' | 'ready' | 'error'

export interface TaskRecord {
  id: string
  projectRoot: string
  title: string
  source: TaskSource
  /** External issue key (e.g. PRJ-123 / owner/repo#42), or null for manual. */
  externalKey: string | null
  externalUrl: string | null
  lane: TaskLane
  /** True when a clean agent turn suggested moving to Done (never auto-set). */
  suggestDone: boolean
  /** The 1:1 thread; null only transiently before linking. */
  threadId: string | null
  /**
   * PROVENANCE: the thread that PRODUCED this task, which is not the thread it
   * OWNS (`threadId`). A card mirrored from an agent's todo list carries the
   * conversation it came from here while owning no thread of its own; a card
   * created by hand owns a thread and has no origin. Null means "we do not
   * know" — a row written before this column existed, a task nobody's
   * conversation produced, or an origin thread that has since been deleted
   * (the FK sets it null; the task itself outlives the chat, FR-10).
   */
  originThreadId: string | null
  description: string | null
  /**
   * The pictures the ticket carried when it was imported — addresses, not
   * bytes; the bytes are fetched on demand by `integrations:imageData`.
   *
   * NULL MEANS NOBODY LOOKED — a manual task, or a row written before the
   * column existed. An empty array means the tracker was asked and had none.
   * Only the second is a ticket with no screenshots, and only it should ever
   * be reported as one.
   */
  images: IssueImage[] | null
  /**
   * Whether the board's loop may work this card.
   *
   * FALSE UNLESS SOMEBODY SAID OTHERWISE. A board is also a notebook — plenty
   * of cards exist to be remembered rather than done — so pressing play must
   * not start an agent on work nobody has offered it. The opt-in is the
   * deliberate act.
   */
  autoFix: boolean
  /**
   * The lane an agent-waiting card returns to when its question is answered, or
   * null when the agent did not move it.
   *
   * NULL IS THE HUMAN'S BLOCK. A card a person dragged to Blocked reads null
   * here, so the lane-sync restore never touches it; a card the agent moved to
   * Blocked (its thread went `needs-decision`) carries the lane it came from, and
   * that is where it slides back once answered. One column, two facts: the marker
   * ("the agent parked this") and the destination ("put it back here").
   */
  agentBlockedFrom: TaskLane | null
  /**
   * The pull request this card produced, or null when it has none.
   *
   * WRITTEN ONLY BY THE APP, when the board loop finishes a card's turn cleanly
   * and opens a PR (main-side; never patched from the renderer). A Review card
   * carries it so it can offer a link and a merge; every other card, and every
   * card whose turn could not open a PR, reads null.
   */
  prUrl: string | null
  /** PM-style technical brief for the engineer; null until generated. */
  brief: string | null
  briefStatus: TaskBriefStatus
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateTaskInput {
  projectRoot: string
  title: string
  source?: TaskSource
  externalKey?: string | null
  externalUrl?: string | null
  description?: string | null
  /** The ticket's pictures, when it came from a tracker that named any. */
  images?: readonly IssueImage[] | null
  /** Whether the board's loop may work it. Default false — see TaskRecord. */
  autoFix?: boolean
  threadId?: string | null
  /** The thread that produced this task (provenance) — see TaskRecord. */
  originThreadId?: string | null
}

export interface UpdateTaskInput {
  title?: string
  lane?: TaskLane
  /** true archives (sets archived_at=now), false unarchives. */
  archived?: boolean
  /** Set/clear the "suggest Done" hint (cleared once acted on). */
  suggestDone?: boolean
  /** Offer this card to the board's loop, or take it back. */
  autoFix?: boolean
  /**
   * Set the agent-block marker (the lane to restore to), or clear it with an
   * explicit `null`. OMITTED keeps the stored value; `null` clears it — so
   * `updateTask` distinguishes "leave it" from "the card is no longer
   * agent-blocked" (the `??` idiom the other fields use would swallow the clear).
   */
  agentBlockedFrom?: TaskLane | null
  /**
   * Set the pull request URL, or clear it with an explicit `null`. OMITTED keeps
   * the stored value; `null` clears it — same "leave it vs. take it away"
   * distinction `agentBlockedFrom` makes, so a `??` idiom cannot swallow a clear.
   */
  prUrl?: string | null
}

export interface TaskChangeEvent {
  entity: 'task'
  action: 'created' | 'updated' | 'deleted'
  taskId: string
}

/** Emitted for every task mutation. Payload: TaskChangeEvent. */
export const TASK_STORE_CHANGE_EVENT = 'change'

interface TaskRow {
  id: string
  project_root: string
  title: string
  source: string
  external_key: string | null
  external_url: string | null
  lane: string
  suggest_done: number
  thread_id: string | null
  /**
   * Optional on the ROW, not on the record: `SELECT *` against a database an
   * older build wrote returns no such key at all, and better-sqlite3 hands back
   * exactly the columns it found. Degrade at the read boundary (toTaskRecord)
   * rather than casting a value nobody looked at — the same lesson toTaskLane
   * records for `lane`.
   */
  origin_thread_id?: string | null
  description: string | null
  /** Optional on the ROW for the same reason `origin_thread_id` is. */
  images?: string | null
  auto_fix?: number | null
  /** Optional on the ROW for the same reason `origin_thread_id` is (added v30). */
  agent_blocked_from?: string | null
  /** Optional on the ROW for the same reason `origin_thread_id` is (added v31). */
  pr_url?: string | null
  brief: string | null
  brief_status: string
  archived_at: string | null
  created_at: string
  updated_at: string
}

export class TaskStore extends EventEmitter {
  constructor(private readonly db: FlowDatabase) {
    super()
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const now = new Date().toISOString()
    const task: TaskRecord = {
      id: randomUUID(),
      projectRoot: input.projectRoot,
      title: input.title,
      source: input.source ?? 'manual',
      externalKey: input.externalKey ?? null,
      externalUrl: input.externalUrl ?? null,
      lane: 'todo',
      suggestDone: false,
      threadId: input.threadId ?? null,
      originThreadId: input.originThreadId ?? null,
      description: input.description ?? null,
      images: input.images === undefined || input.images === null ? null : [...input.images],
      autoFix: input.autoFix === true,
      // A fresh card is never agent-blocked — it has no thread waiting on anyone.
      agentBlockedFrom: null,
      // A fresh card has produced no pull request yet.
      prUrl: null,
      brief: null,
      briefStatus: 'idle',
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_root, title, source, external_key, external_url, lane, suggest_done, thread_id, origin_thread_id, description, images, auto_fix, agent_blocked_from, pr_url, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.projectRoot,
        task.title,
        task.source,
        task.externalKey,
        task.externalUrl,
        task.lane,
        task.suggestDone ? 1 : 0,
        task.threadId,
        task.originThreadId,
        task.description,
        task.images === null ? null : JSON.stringify(task.images),
        task.autoFix ? 1 : 0,
        task.agentBlockedFrom,
        task.prUrl,
        task.archivedAt,
        task.createdAt,
        task.updatedAt,
      )
    this.emitChange({ entity: 'task', action: 'created', taskId: task.id })
    return task
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row ? toTaskRecord(row) : null
  }

  /** Dedup handle: an already-imported issue in THIS project (per-project key). */
  getTaskByExternalKey(
    projectRoot: string,
    source: TaskSource,
    externalKey: string,
  ): TaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE project_root = ? AND source = ? AND external_key = ?')
      .get(projectRoot, source, externalKey) as TaskRow | undefined
    return row ? toTaskRecord(row) : null
  }

  /** List a project's tasks, newest activity first. Archived excluded by default. */
  listTasks(projectRoot: string, options: { includeArchived?: boolean } = {}): TaskRecord[] {
    const where = options.includeArchived
      ? 'WHERE project_root = ?'
      : 'WHERE project_root = ? AND archived_at IS NULL'
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC, id ASC`)
      .all(projectRoot) as TaskRow[]
    return rows.map(toTaskRecord)
  }

  /**
   * Apply a patch. `options.activity` (default true) decides whether this counts
   * as ACTIVITY — i.e. whether it bumps `updated_at`, which every lane on the
   * board sorts by (#1192).
   *
   * The app mutates tasks by itself, with no user involvement: a turn starting
   * moves a task to `doing`, a clean turn sets `suggestDone`. Bumping the clock
   * for those yanked the card to the top of its lane and shifted every card
   * below it down a row — while the user was looking at it, and while these
   * cards carry a one-click WRITE (the "Done?" chip, #1102). A click already
   * committed to marked the wrong task Done.
   *
   * This is #164's carve-out on its twin surface: ThreadStore.updateThread
   * ("only real activity bumps it — metadata-only toggles must NOT, or
   * unpinning an old thread yanks it to the top"). It is an explicit flag
   * rather than a field-shape rule because the SAME fields are legitimately
   * user-driven — a drag sets `lane`, the Done? chip sets both — so only the
   * caller knows whose action it was.
   */
  updateTask(
    id: string,
    patch: UpdateTaskInput,
    options: { activity?: boolean } = {},
  ): TaskRecord {
    const existing = this.getTask(id)
    if (!existing) {
      throw new Error(`[TaskStore] Cannot update unknown task: ${id}`)
    }
    const now = new Date().toISOString()
    const updatedAt = options.activity === false ? existing.updatedAt : now
    const archivedAt =
      patch.archived === undefined
        ? existing.archivedAt
        : patch.archived
          ? (existing.archivedAt ?? now)
          : null
    const updated: TaskRecord = {
      ...existing,
      title: patch.title ?? existing.title,
      lane: patch.lane ?? existing.lane,
      suggestDone: patch.suggestDone ?? existing.suggestDone,
      autoFix: patch.autoFix ?? existing.autoFix,
      // Explicit-null clears, omitted keeps — a plain `??` would swallow the
      // clear (`null ?? existing` = existing) and leave a restored card still
      // marked agent-blocked.
      agentBlockedFrom: 'agentBlockedFrom' in patch ? patch.agentBlockedFrom ?? null : existing.agentBlockedFrom,
      // Same explicit-null-clears / omitted-keeps rule as agentBlockedFrom: a
      // plain `??` would swallow the clear a card leaving Review makes.
      prUrl: 'prUrl' in patch ? patch.prUrl ?? null : existing.prUrl,
      archivedAt,
      updatedAt,
    }
    this.db
      .prepare(
        'UPDATE tasks SET title = ?, lane = ?, suggest_done = ?, auto_fix = ?, agent_blocked_from = ?, pr_url = ?, archived_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        updated.title,
        updated.lane,
        updated.suggestDone ? 1 : 0,
        updated.autoFix ? 1 : 0,
        updated.agentBlockedFrom,
        updated.prUrl,
        updated.archivedAt,
        updated.updatedAt,
        id,
      )
    this.emitChange({ entity: 'task', action: 'updated', taskId: id })
    return updated
  }

  /**
   * Set the task's technical-brief status (and text when provided). Main-process
   * only — the brief is generated asynchronously, never patched from the renderer.
   * Does not bump updated_at so it never reorders the board.
   */
  setBrief(id: string, status: TaskBriefStatus, brief?: string | null): TaskRecord {
    const existing = this.getTask(id)
    if (!existing) {
      throw new Error(`[TaskStore] Cannot set brief for unknown task: ${id}`)
    }
    const nextBrief = brief === undefined ? existing.brief : brief
    this.db
      .prepare('UPDATE tasks SET brief = ?, brief_status = ? WHERE id = ?')
      .run(nextBrief, status, id)
    this.emitChange({ entity: 'task', action: 'updated', taskId: id })
    return { ...existing, brief: nextBrief, briefStatus: status }
  }

  /**
   * Reconcile brief generation left in flight by a previous run. `brief_status`
   * is written 'pending' up front and only flips to ready/error when the
   * in-process LLM call resolves — so a quit, crash or force-quit during it
   * leaves 'pending' in SQLite with nothing left to drive it. A freshly started
   * process cannot have a generation in flight, so any 'pending' row at startup
   * is by definition stale: reset it to 'idle', which puts the detail modal back
   * on "No brief yet." + Generate instead of "Generating a technical brief…"
   * forever with no control at all (#1026). Mirrors ThreadStore's
   * `reconcileInterruptedWork`; runs once at startup, before any window loads.
   *
   * Like that sibling, a restart cleanup is NOT activity — `setBrief` never
   * touches updated_at, and neither does this, so a swept task doesn't jump to
   * the top of the board on every relaunch.
   *
   * Returns how many rows were swept (0 on the common clean boot).
   */
  reconcileInterruptedBriefs(): number {
    const result = this.db
      .prepare("UPDATE tasks SET brief_status = 'idle' WHERE brief_status = 'pending'")
      .run()
    return result.changes
  }

  /**
   * Restore any card an agent parked in Blocked but never got to un-park, because
   * the app quit while its thread was waiting on the user (`needs-decision`).
   *
   * The thread half of this is already swept — ThreadStore.reconcileInterruptedWork
   * resets a persisted `needs-decision`/`working`/`blocked` thread to `idle` at
   * boot — but that leaves the CARD sitting in Blocked with nothing left to answer
   * it back out. This is the lane half of the same sweep: every row with
   * `agent_blocked_from` set returns to that lane and clears the marker. A
   * HUMAN-parked card reads NULL here and is untouched.
   *
   * Like its brief-status sibling, a restart cleanup is NOT activity — updated_at
   * is left alone, so a swept card doesn't jump to the top of its lane on every
   * relaunch. Runs once at startup, before any window loads. Returns rows swept.
   */
  reconcileAgentBlocks(): number {
    const result = this.db
      .prepare(
        'UPDATE tasks SET lane = agent_blocked_from, agent_blocked_from = NULL WHERE agent_blocked_from IS NOT NULL',
      )
      .run()
    return result.changes
  }

  /**
   * Backfill: a "from scratch" task is created titleless and named from its
   * opening message by the thread auto-titler, which only ever wrote the thread.
   * Before that mirror existed (#1447 covered only manual renames), every such
   * card was left reading "Untitled task" while its chat had a real name. The
   * per-turn mirror heals new cards on their next clean turn; this heals the ones
   * already piled up, once, at startup — copy the thread's title onto its owning
   * task wherever the card is blank and the chat is not.
   *
   * NOT activity: `updated_at` is untouched, so cleaning up the backlog does not
   * reorder every board lane (the same carve-out `updateTask`/`clearThread` make).
   * Returns the number of cards healed.
   */
  reconcileUntitledTaskCards(): number {
    const result = this.db
      .prepare(
        `UPDATE tasks
           SET title = (SELECT th.title FROM threads th WHERE th.id = tasks.thread_id)
         WHERE thread_id IS NOT NULL
           AND TRIM(title) = ''
           AND thread_id IN (SELECT id FROM threads WHERE TRIM(title) <> '')`,
      )
      .run()
    return result.changes
  }

  /**
   * Run several writes of this store as one — all land or none do. For a
   * caller whose writes only make sense together (a task moved to another
   * project AND re-linked to that project's thread): a failure between them
   * would leave a task in one project pointing at a thread of another.
   */
  inTransaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn)
  }

  /**
   * Move a task to another project — only for a task whose chat has not
   * started (`chooseTaskProjects` checks that and replaces the thread). Not
   * activity: updated_at is untouched, so the card keeps its place in the lane.
   */
  moveTask(taskId: string, projectRoot: string): void {
    const result = this.db.prepare('UPDATE tasks SET project_root = ? WHERE id = ?').run(projectRoot, taskId)
    if (result.changes === 0) {
      throw new Error(`[TaskStore] Cannot move unknown task: ${taskId}`)
    }
    this.emitChange({ entity: 'task', action: 'updated', taskId })
  }

  /** Bind the task's 1:1 thread (used right after creation). */
  linkThread(taskId: string, threadId: string): void {
    const result = this.db
      .prepare('UPDATE tasks SET thread_id = ?, updated_at = ? WHERE id = ?')
      .run(threadId, new Date().toISOString(), taskId)
    if (result.changes === 0) {
      throw new Error(`[TaskStore] Cannot link thread for unknown task: ${taskId}`)
    }
    this.emitChange({ entity: 'task', action: 'updated', taskId })
  }

  /**
   * Unlink the task that owns `threadId`, because that thread is about to be
   * deleted. The FK (`ON DELETE SET NULL`) already nulls the column, but it does
   * so SILENTLY — no task change event — so every task surface kept serving a
   * cached task pointing at a dead thread until something else happened to
   * refresh it, and "Open chat" dispatched an open for a thread that no longer
   * existed (#1061). Doing it here makes the unlink evented.
   *
   * Not activity (mirrors setBrief): updated_at is untouched, so a thread
   * deleted elsewhere doesn't reorder the board.
   *
   * Returns the affected task id, or null when no task owned the thread.
   */
  clearThread(threadId: string): string | null {
    const task = this.getTaskByThreadId(threadId)
    if (!task) return null
    this.db.prepare('UPDATE tasks SET thread_id = NULL WHERE id = ?').run(task.id)
    this.emitChange({ entity: 'task', action: 'updated', taskId: task.id })
    return task.id
  }

  /** Find the task that owns a given thread (for lane automation on turns). */
  getTaskByThreadId(threadId: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE thread_id = ?').get(threadId) as
      | TaskRow
      | undefined
    return row ? toTaskRecord(row) : null
  }

  /**
   * Delete a task. Returns the linked threadId (if any) so the caller can
   * delete the thread through ThreadStore (keeping thread deletion + its
   * cascade + change events authoritative there).
   */
  deleteTask(id: string): { threadId: string | null } {
    const existing = this.getTask(id)
    if (!existing) return { threadId: null }
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    this.emitChange({ entity: 'task', action: 'deleted', taskId: id })
    return { threadId: existing.threadId }
  }

  private emitChange(event: TaskChangeEvent): void {
    this.emit(TASK_STORE_CHANGE_EVENT, event)
  }
}

/** Every lane this build knows — the runtime half of the TaskLane union. */
const KNOWN_LANES = new Set<string>(['todo', 'doing', 'blocked', 'review', 'done'] satisfies TaskLane[])

/**
 * Read a persisted lane, falling back to Todo for anything this build doesn't
 * know. The column is plain TEXT and (since v22) carries no CHECK, so the row
 * a NEWER build writes — a fifth lane it has and this one doesn't — reaches
 * this reader intact. The old `row.lane as TaskLane` cast asserted a value it
 * had never looked at: the unknown lane flowed straight through to the board,
 * matched no column, and the card simply vanished from every lane while still
 * counting as a task. Degrade to the leftmost lane instead — visible, movable,
 * and never a throw on a value that is legal in the database.
 */
function toTaskLane(lane: string): TaskLane {
  return KNOWN_LANES.has(lane) ? (lane as TaskLane) : 'todo'
}

/**
 * Read the agent-block restore target. NULL/absent → not agent-blocked; a value
 * is trusted only when it names a lane this build knows — an unrecognized
 * restore target (a newer build's fifth lane) degrades to "not agent-blocked"
 * rather than pointing a restore at a column that does not exist.
 */
function readAgentBlockedFrom(raw: string | null | undefined): TaskLane | null {
  return typeof raw === 'string' && KNOWN_LANES.has(raw) ? (raw as TaskLane) : null
}

/**
 * The stored images column, as a list — or null.
 *
 * FAIL-SOFT TO NULL, NEVER TO EMPTY. A column that will not parse is a row
 * this build cannot read, which is "nobody looked" and not "no screenshots";
 * degrading it to `[]` would tell a reader the ticket had none. Same reason
 * `toTaskLane` degrades rather than throwing: one unreadable row must not take
 * the whole board down with it.
 */
function parseImages(raw: string | null | undefined): IssueImage[] | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed
      .filter((entry): entry is IssueImage => {
        if (typeof entry !== 'object' || entry === null) return false
        const record = entry as Record<string, unknown>
        return typeof record['url'] === 'string' && typeof record['name'] === 'string'
      })
      .map((entry) => ({ url: entry.url, name: entry.name }))
  } catch {
    return null
  }
}

function toTaskRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    title: row.title,
    source: row.source as TaskSource,
    externalKey: row.external_key,
    externalUrl: row.external_url,
    lane: toTaskLane(row.lane),
    suggestDone: row.suggest_done !== 0,
    threadId: row.thread_id,
    // Absent (older row) and NULL (origin unknown / origin thread deleted) are
    // one answer to the reader: we do not know. Never a crash, never a guess.
    originThreadId: row.origin_thread_id ?? null,
    description: row.description,
    images: parseImages(row.images),
    // Absent (a row an older build wrote) and 0 are one answer: nobody has
    // offered this card to the loop.
    autoFix: (row.auto_fix ?? 0) !== 0,
    // Absent (older row) and NULL are one answer: the agent did not park this
    // card. A stored value is only trusted when it names a lane this build knows
    // (same fail-soft as `toTaskLane`) — a restore target that matches no column
    // would be worse than none.
    agentBlockedFrom: readAgentBlockedFrom(row.agent_blocked_from),
    // Absent (a row an older build wrote) and NULL are one answer: this card has
    // no pull request.
    prUrl: row.pr_url ?? null,
    brief: row.brief,
    briefStatus: (row.brief_status as TaskBriefStatus | null) ?? 'idle',
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
