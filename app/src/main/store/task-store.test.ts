// TaskStore tests — real better-sqlite3 (Electron ABI, via run-jest.mjs) with a
// fresh temp DB per test. Covers migration v8, CRUD, lane, link, dedup, delete.

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from './db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations'
import { ThreadStore } from './thread-store'
import {
  TaskStore,
  TASK_STORE_CHANGE_EVENT,
  type TaskChangeEvent,
} from './task-store'

const ROOT = '/tmp/project-a'

/**
 * Build a database that stops at `version` — what an OLDER build of the app
 * left on disk — and let the caller write rows into it as that build would.
 * Replays db.ts's own apply loop (array order, `<= currentVersion` skip) so the
 * fixture is the real ladder truncated, not a hand-written schema that can
 * drift from it. The file is left closed, ready for `openDatabase` to upgrade.
 */
function seedDatabaseAtVersion(
  path: string,
  version: number,
  seed: (db: FlowDatabase) => void,
): void {
  const db = new Database(path) as FlowDatabase
  try {
    db.pragma('foreign_keys = ON')
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);')
    for (const migration of MIGRATIONS) {
      if (migration.version > version) break
      if (typeof migration.up === 'function') migration.up(db)
      else db.exec(migration.up)
    }
    db.prepare('DELETE FROM schema_version').run()
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version)
    seed(db)
  } finally {
    db.close()
  }
}

async function tick(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('TaskStore', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: TaskStore
  let threads: ThreadStore
  let events: TaskChangeEvent[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-task-store-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new TaskStore(db)
    threads = new ThreadStore(db)
    events = []
    store.on(TASK_STORE_CHANGE_EVENT, (e: TaskChangeEvent) => events.push(e))
  })
  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('migration v8 is latest and creates the tasks table', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(8)
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['id', 'project_root', 'title', 'source', 'external_key', 'lane', 'thread_id']),
    )
  })

  it('migration v9 dropped the source CHECK — a new provider (azure) inserts fine', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(9)
    const task = store.createTask({
      projectRoot: ROOT,
      title: 'Work item',
      source: 'azure',
      externalKey: 'org/proj#12345',
    })
    expect(task.source).toBe('azure')
    expect(store.getTaskByExternalKey(ROOT, 'azure', 'org/proj#12345')?.id).toBe(task.id)
  })

  it('creates a manual task with defaults', () => {
    const task = store.createTask({ projectRoot: ROOT, title: 'Do a thing' })
    expect(task.source).toBe('manual')
    expect(task.lane).toBe('todo')
    expect(task.suggestDone).toBe(false)
    expect(task.externalKey).toBeNull()
    expect(task.brief).toBeNull()
    expect(task.briefStatus).toBe('idle')
    expect(store.getTask(task.id)?.title).toBe('Do a thing')
    expect(events.filter((e) => e.action === 'created')).toHaveLength(1)
  })

  it('setBrief persists status + text and round-trips through getTask', () => {
    const task = store.createTask({ projectRoot: ROOT, title: 't' })
    expect(store.setBrief(task.id, 'pending').briefStatus).toBe('pending')
    const ready = store.setBrief(task.id, 'ready', '- a\n- b')
    expect(ready.briefStatus).toBe('ready')
    expect(ready.brief).toBe('- a\n- b')
    expect(store.getTask(task.id)?.brief).toBe('- a\n- b')
    // Passing status without text preserves the existing brief.
    expect(store.setBrief(task.id, 'error').brief).toBe('- a\n- b')
  })

  // #1061 — the FK nulls thread_id on a thread delete, but silently. An evented
  // unlink is what stops task surfaces serving a cached, dead thread id.
  describe('clearThread (#1061)', () => {
    it('unlinks the owning task and emits a task change', () => {
      const thread = threads.createThread({ projectRoot: ROOT, title: 't' })
      const task = store.createTask({ projectRoot: ROOT, title: 't', threadId: thread.id })
      events.length = 0

      expect(store.clearThread(thread.id)).toBe(task.id)

      expect(store.getTask(task.id)?.threadId).toBeNull()
      expect(events).toEqual([{ entity: 'task', action: 'updated', taskId: task.id }])
    })

    it('is a silent no-op for a bare thread no task owns', () => {
      const thread = threads.createThread({ projectRoot: ROOT, title: 'bare' })
      events.length = 0

      expect(store.clearThread(thread.id)).toBeNull()
      expect(events).toEqual([])
    })

    it('does not reorder the board', () => {
      const thread = threads.createThread({ projectRoot: ROOT, title: 't' })
      const task = store.createTask({ projectRoot: ROOT, title: 't', threadId: thread.id })
      const before = store.getTask(task.id)?.updatedAt

      store.clearThread(thread.id)

      expect(store.getTask(task.id)?.updatedAt).toBe(before)
    })
  })

  // #1026 — a generation interrupted by a quit/crash leaves `pending` in SQLite
  // with nothing left to drive it, and the detail modal's pending branch offers
  // no control at all. A fresh process can't have one in flight, so every
  // `pending` row at startup is stale.
  describe('reconcileInterruptedBriefs (#1026)', () => {
    it('sweeps a stale pending brief back to idle, and reports the count', () => {
      const stuck = store.createTask({ projectRoot: ROOT, title: 'interrupted' })
      store.setBrief(stuck.id, 'pending')

      expect(store.reconcileInterruptedBriefs()).toBe(1)
      expect(store.getTask(stuck.id)?.briefStatus).toBe('idle')
    })

    it('leaves ready / error / idle briefs (and their text) alone', () => {
      const ready = store.createTask({ projectRoot: ROOT, title: 'ready' })
      store.setBrief(ready.id, 'ready', '- generated')
      const failed = store.createTask({ projectRoot: ROOT, title: 'failed' })
      store.setBrief(failed.id, 'error')
      const untouched = store.createTask({ projectRoot: ROOT, title: 'untouched' })

      expect(store.reconcileInterruptedBriefs()).toBe(0)
      expect(store.getTask(ready.id)?.briefStatus).toBe('ready')
      expect(store.getTask(ready.id)?.brief).toBe('- generated')
      expect(store.getTask(failed.id)?.briefStatus).toBe('error')
      expect(store.getTask(untouched.id)?.briefStatus).toBe('idle')
    })

    it('does not reorder the board — a restart cleanup is not activity', () => {
      const stuck = store.createTask({ projectRoot: ROOT, title: 'interrupted' })
      store.setBrief(stuck.id, 'pending')
      const before = store.getTask(stuck.id)?.updatedAt

      store.reconcileInterruptedBriefs()

      expect(store.getTask(stuck.id)?.updatedAt).toBe(before)
    })
  })

  // thread-agent-status — a card an agent parks in Blocked (its thread went
  // needs-decision) remembers the lane to return to, in one nullable column that
  // is ALSO the "the agent moved this" marker. NULL is the human's block.
  describe('agentBlockedFrom (thread-agent-status)', () => {
    it('migration v30 added the column', () => {
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(30)
      const cols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
      expect(cols.map((c) => c.name)).toContain('agent_blocked_from')
    })

    it('a fresh card is not agent-blocked', () => {
      const task = store.createTask({ projectRoot: ROOT, title: 't' })
      expect(task.agentBlockedFrom).toBeNull()
      expect(store.getTask(task.id)?.agentBlockedFrom).toBeNull()
    })

    it('sets the marker and round-trips it through getTask', () => {
      const task = store.createTask({ projectRoot: ROOT, title: 't' })
      const blocked = store.updateTask(task.id, { lane: 'blocked', agentBlockedFrom: 'doing' })
      expect(blocked.lane).toBe('blocked')
      expect(blocked.agentBlockedFrom).toBe('doing')
      expect(store.getTask(task.id)?.agentBlockedFrom).toBe('doing')
    })

    it('an explicit null clears the marker; omitting it keeps the stored value', () => {
      const task = store.createTask({ projectRoot: ROOT, title: 't' })
      store.updateTask(task.id, { lane: 'blocked', agentBlockedFrom: 'todo' })
      // Omitted — a title-only patch must not wipe the marker.
      store.updateTask(task.id, { title: 'renamed' })
      expect(store.getTask(task.id)?.agentBlockedFrom).toBe('todo')
      // Explicit null clears it (the restore path).
      const restored = store.updateTask(task.id, { lane: 'todo', agentBlockedFrom: null })
      expect(restored.agentBlockedFrom).toBeNull()
      expect(store.getTask(task.id)?.agentBlockedFrom).toBeNull()
    })

    describe('reconcileAgentBlocks', () => {
      it('restores an agent-parked card to its remembered lane and clears the marker', () => {
        const task = store.createTask({ projectRoot: ROOT, title: 'stranded' })
        store.updateTask(task.id, { lane: 'blocked', agentBlockedFrom: 'doing' })

        expect(store.reconcileAgentBlocks()).toBe(1)
        const after = store.getTask(task.id)
        expect(after?.lane).toBe('doing')
        expect(after?.agentBlockedFrom).toBeNull()
      })

      it('leaves a human-parked Blocked card (null marker) exactly where it is', () => {
        const task = store.createTask({ projectRoot: ROOT, title: 'parked by a person' })
        store.updateTask(task.id, { lane: 'blocked' })

        expect(store.reconcileAgentBlocks()).toBe(0)
        expect(store.getTask(task.id)?.lane).toBe('blocked')
      })

      it('does not reorder the board — a restart cleanup is not activity', () => {
        const task = store.createTask({ projectRoot: ROOT, title: 'stranded' })
        store.updateTask(task.id, { lane: 'blocked', agentBlockedFrom: 'doing' }, { activity: false })
        const before = store.getTask(task.id)?.updatedAt

        store.reconcileAgentBlocks()

        expect(store.getTask(task.id)?.updatedAt).toBe(before)
      })
    })
  })

  // The backlog of "Untitled task" cards from before the thread→task title
  // mirror existed: the chat got a name, the card never did.
  describe('reconcileUntitledTaskCards', () => {
    it('copies a named thread’s title onto its blank card, and reports the count', () => {
      const thread = threads.createThread({ projectRoot: ROOT, title: 'Group repeated tool calls' })
      const card = store.createTask({ projectRoot: ROOT, title: '', threadId: thread.id })

      expect(store.reconcileUntitledTaskCards()).toBe(1)
      expect(store.getTask(card.id)?.title).toBe('Group repeated tool calls')
    })

    it('leaves a card that already has a title alone', () => {
      const thread = threads.createThread({ projectRoot: ROOT, title: 'Chat name' })
      const card = store.createTask({ projectRoot: ROOT, title: 'Typed name', threadId: thread.id })

      expect(store.reconcileUntitledTaskCards()).toBe(0)
      expect(store.getTask(card.id)?.title).toBe('Typed name')
    })

    it('leaves a blank card whose thread is also unnamed — nothing to copy', () => {
      const thread = threads.createThread({ projectRoot: ROOT, title: '' })
      const card = store.createTask({ projectRoot: ROOT, title: '', threadId: thread.id })

      expect(store.reconcileUntitledTaskCards()).toBe(0)
      expect(store.getTask(card.id)?.title).toBe('')
    })

    it('does not reorder the board — a restart cleanup is not activity', () => {
      const thread = threads.createThread({ projectRoot: ROOT, title: 'A real name' })
      const card = store.createTask({ projectRoot: ROOT, title: '', threadId: thread.id })
      const before = store.getTask(card.id)?.updatedAt

      store.reconcileUntitledTaskCards()

      expect(store.getTask(card.id)?.updatedAt).toBe(before)
    })
  })

  describe('lanes', () => {
    it('round-trips every lane the board renders, blocked included', () => {
      // The persisted half of the fourth lane. v8 pinned a CHECK to the three
      // lanes of the day and v9 kept it, so this write raised SQLITE_CONSTRAINT
      // and the Blocked column silently refused every card dropped on it — the
      // failure the board reports as "Couldn't move this task".
      const task = store.createTask({ projectRoot: ROOT, title: 't' })
      for (const lane of ['todo', 'doing', 'blocked', 'done'] as const) {
        expect(store.updateTask(task.id, { lane }).lane).toBe(lane)
        expect(store.getTask(task.id)?.lane).toBe(lane) // re-read, not the write's echo
      }
    })

    it('migration v22 dropped the lane CHECK — the column takes any lane', () => {
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(22)
      const task = store.createTask({ projectRoot: ROOT, title: 't' })
      expect(() =>
        db.prepare('UPDATE tasks SET lane = ? WHERE id = ?').run('blocked', task.id),
      ).not.toThrow()
    })

    it('reads a lane it has never heard of as Todo instead of vanishing the card', () => {
      // What a NEWER build writes: the column is plain TEXT with no CHECK, so a
      // fifth lane persists fine and this build still has to render the row. The
      // old `row.lane as TaskLane` cast passed the unknown value straight to the
      // board, where it matched no column — the task existed, counted, and was
      // on screen nowhere. Todo is the honest fallback: leftmost, visible, movable.
      const task = store.createTask({ projectRoot: ROOT, title: 'from the future' })
      db.prepare('UPDATE tasks SET lane = ? WHERE id = ?').run('parked', task.id)

      expect(store.getTask(task.id)?.lane).toBe('todo')
      // …through every reader, not just getTask.
      expect(store.listTasks(ROOT).find((t) => t.id === task.id)?.lane).toBe('todo')
    })

    it('never throws on a lane it cannot recognise, however malformed', () => {
      const task = store.createTask({ projectRoot: ROOT, title: 't' })
      db.prepare('UPDATE tasks SET lane = ? WHERE id = ?').run('', task.id)
      expect(() => store.getTask(task.id)).not.toThrow()
      expect(store.getTask(task.id)?.lane).toBe('todo')
    })
  })

  it('updates lane / suggestDone / archived independently', () => {
    const task = store.createTask({ projectRoot: ROOT, title: 't' })
    expect(store.updateTask(task.id, { lane: 'doing' }).lane).toBe('doing')
    expect(store.updateTask(task.id, { suggestDone: true }).suggestDone).toBe(true)
    const archived = store.updateTask(task.id, { archived: true })
    expect(archived.archivedAt).not.toBeNull()
    // A lane update must not clear the archive flag.
    expect(store.updateTask(task.id, { lane: 'done' }).archivedAt).not.toBeNull()
  })

  it('carries the pull request URL through create / set / clear', () => {
    const task = store.createTask({ projectRoot: ROOT, title: 't' })
    // A fresh card has none.
    expect(task.prUrl).toBeNull()
    // Set it (as the board loop does when it moves a card to Review)…
    const set = store.updateTask(task.id, { lane: 'review', prUrl: 'https://github.com/o/r/pull/7' })
    expect(set.lane).toBe('review')
    expect(set.prUrl).toBe('https://github.com/o/r/pull/7')
    // …an omitted prUrl keeps the stored value (a plain lane move must not lose it)…
    expect(store.updateTask(task.id, { lane: 'done' }).prUrl).toBe('https://github.com/o/r/pull/7')
    // …and an explicit null clears it, the way agentBlockedFrom does.
    expect(store.updateTask(task.id, { prUrl: null }).prUrl).toBeNull()
  })

  it('round-trips the review lane rather than degrading it to todo', () => {
    // 'review' is a KNOWN_LANE, so it survives the read boundary; an UNKNOWN
    // lane degrades to 'todo' (toTaskLane), which is the guard this proves is
    // not catching a real lane.
    const task = store.createTask({ projectRoot: ROOT, title: 't' })
    expect(store.updateTask(task.id, { lane: 'review' }).lane).toBe('review')
    expect(store.getTask(task.id)?.lane).toBe('review')
  })

  describe('activity clock (#1192)', () => {
    it('bumps updated_at for a user action, so the board still surfaces it', async () => {
      const task = store.createTask({ projectRoot: ROOT, title: 't' })
      const before = store.getTask(task.id)?.updatedAt
      await tick()

      store.updateTask(task.id, { lane: 'doing' })

      expect(store.getTask(task.id)?.updatedAt).not.toBe(before)
    })

    it('does NOT bump it for an app-driven update — the board must not re-sort', async () => {
      // What makeOnTurnStart / makeOnTurnComplete do when an agent turn starts
      // or finishes in a BACKGROUND thread. Bumping here yanked the card to the
      // top of its lane under a hand already moving toward another card's
      // one-click "Done?" chip (#1102) — and marked the wrong task Done.
      const task = store.createTask({ projectRoot: ROOT, title: 't' })
      const before = store.getTask(task.id)?.updatedAt
      await tick()

      store.updateTask(task.id, { lane: 'doing' }, { activity: false })
      store.updateTask(task.id, { suggestDone: true }, { activity: false })

      expect(store.getTask(task.id)?.updatedAt).toBe(before)
      // …and the patch itself still applied.
      expect(store.getTask(task.id)?.lane).toBe('doing')
      expect(store.getTask(task.id)?.suggestDone).toBe(true)
    })

    it('keeps lane ORDER stable across a background turn', async () => {
      // The reported shape: three cards in Doing, oldest → newest.
      const first = store.createTask({ projectRoot: ROOT, title: 'Delete the prod bucket' })
      await tick()
      const second = store.createTask({ projectRoot: ROOT, title: 'Rename a label' })
      await tick()
      const third = store.createTask({ projectRoot: ROOT, title: 'Bump a version' })
      const order = (): string[] =>
        store.listTasks(ROOT).map((task) => task.title)
      const before = order()

      await tick()
      store.updateTask(first.id, { suggestDone: true }, { activity: false })

      expect(order()).toEqual(before)
      expect(second.id).not.toBe(third.id) // fixture sanity
    })
  })

  it('links a thread and finds the task by that thread', () => {
    const task = store.createTask({ projectRoot: ROOT, title: 't' })
    const thread = threads.createThread({ projectRoot: ROOT, title: 't' })
    store.linkThread(task.id, thread.id)
    expect(store.getTask(task.id)?.threadId).toBe(thread.id)
    expect(store.getTaskByThreadId(thread.id)?.id).toBe(task.id)
  })

  it('dedups an imported issue per project (project_root, source, external_key)', () => {
    store.createTask({ projectRoot: ROOT, title: 'Issue', source: 'github', externalKey: 'o/r#1' })
    expect(store.getTaskByExternalKey(ROOT, 'github', 'o/r#1')).not.toBeNull()
    // Same key in the SAME project is rejected by the unique index...
    expect(() =>
      store.createTask({ projectRoot: ROOT, title: 'dup', source: 'github', externalKey: 'o/r#1' }),
    ).toThrow()
    // ...but the SAME key in a DIFFERENT project is allowed (and not found by
    // the per-project dedup lookup).
    expect(store.getTaskByExternalKey('/tmp/project-b', 'github', 'o/r#1')).toBeNull()
    expect(() =>
      store.createTask({
        projectRoot: '/tmp/project-b',
        title: 'other project',
        source: 'github',
        externalKey: 'o/r#1',
      }),
    ).not.toThrow()
  })

  it('excludes archived from the default list; includeArchived returns all', () => {
    const a = store.createTask({ projectRoot: ROOT, title: 'active' })
    const g = store.createTask({ projectRoot: ROOT, title: 'gone' })
    store.updateTask(g.id, { archived: true })
    expect(store.listTasks(ROOT).map((t) => t.id)).toEqual([a.id])
    expect(store.listTasks(ROOT, { includeArchived: true }).map((t) => t.id).sort()).toEqual(
      [a.id, g.id].sort(),
    )
  })

  it('deleteTask returns the linked threadId for the caller to cascade', () => {
    const task = store.createTask({ projectRoot: ROOT, title: 't' })
    const thread = threads.createThread({ projectRoot: ROOT, title: 't' })
    store.linkThread(task.id, thread.id)
    const { threadId } = store.deleteTask(task.id)
    expect(threadId).toBe(thread.id)
    expect(store.getTask(task.id)).toBeNull()
    expect(events.some((e) => e.action === 'deleted')).toBe(true)
  })

  // Provenance (thread-tasklist Phase 1) — WHICH CONVERSATION PRODUCED this
  // card, which is a different question from the thread the card OWNS. Both are
  // thread ids on the same row, and conflating them is the failure the two
  // fields exist to prevent: ten cards mirrored from one conversation would all
  // reopen it, and "the task's own thread" would stop existing.
  describe('originThreadId (provenance, distinct from threadId)', () => {
    it('round-trips through every reader, alongside a DIFFERENT owned thread', () => {
      const origin = threads.createThread({ projectRoot: ROOT, title: 'the conversation' })
      const owned = threads.createThread({ projectRoot: ROOT, title: "the card's own chat" })
      const task = store.createTask({
        projectRoot: ROOT,
        title: 'mirrored todo',
        threadId: owned.id,
        originThreadId: origin.id,
      })

      expect(task.originThreadId).toBe(origin.id)
      // Re-read, not the write's echo — and the two ids must stay apart.
      const read = store.getTask(task.id)
      expect(read?.originThreadId).toBe(origin.id)
      expect(read?.threadId).toBe(owned.id)
      expect(store.listTasks(ROOT).find((t) => t.id === task.id)?.originThreadId).toBe(origin.id)
      expect(store.getTaskByThreadId(owned.id)?.originThreadId).toBe(origin.id)
    })

    it('defaults to null — a task nobody’s conversation produced has no origin', () => {
      const task = store.createTask({ projectRoot: ROOT, title: 'typed by hand' })
      expect(task.originThreadId).toBeNull()
      expect(store.getTask(task.id)?.originThreadId).toBeNull()
    })

    it('is not written by the thread the task owns — linkThread leaves origin alone', () => {
      const thread = threads.createThread({ projectRoot: ROOT, title: 't' })
      const task = store.createTask({ projectRoot: ROOT, title: 't' })

      store.linkThread(task.id, thread.id)

      expect(store.getTask(task.id)?.threadId).toBe(thread.id)
      expect(store.getTask(task.id)?.originThreadId).toBeNull()
    })

    // FR-10 — the card outlives the conversation. A cascade here would delete a
    // person's work the moment they tidied up a chat; NO ACTION would instead
    // make deleting a chat start failing. SET NULL keeps the row and drops only
    // the pointer, so nothing is left resolving a thread that is gone (#1061).
    it('survives the deletion of the thread that produced it, with the link cleared', () => {
      const origin = threads.createThread({ projectRoot: ROOT, title: 'to be deleted' })
      const own = threads.createThread({ projectRoot: ROOT, title: 'kept' })
      const task = store.createTask({
        projectRoot: ROOT,
        title: 'work that must not vanish',
        threadId: own.id,
        originThreadId: origin.id,
      })

      threads.deleteThread(origin.id)

      const survivor = store.getTask(task.id)
      expect(survivor).not.toBeNull()
      expect(survivor?.title).toBe('work that must not vanish')
      expect(survivor?.originThreadId).toBeNull() // pointer gone, never dangling
      expect(survivor?.threadId).toBe(own.id) // the OWNED thread is untouched
      expect(store.listTasks(ROOT).map((t) => t.id)).toContain(task.id)
    })

    it('does not cascade even when origin and owned thread are the same thread', () => {
      const thread = threads.createThread({ projectRoot: ROOT, title: 'both roles' })
      const task = store.createTask({
        projectRoot: ROOT,
        title: 'self-originated',
        threadId: thread.id,
        originThreadId: thread.id,
      })

      threads.deleteThread(thread.id)

      expect(store.getTask(task.id)?.title).toBe('self-originated')
      expect(store.getTask(task.id)?.originThreadId).toBeNull()
      expect(store.getTask(task.id)?.threadId).toBeNull()
    })

    it('reads a row written before the column existed as "we do not know"', () => {
      // The real upgrade path, not a stub: build a database at the version
      // shipped BEFORE this column, write a task into it the way that build
      // did, then open it with today's code and read the row back. Absent must
      // mean unknown — never a crash, never a guessed origin.
      const legacyPath = join(tempDir, 'legacy.sqlite')
      const previousVersion = LATEST_SCHEMA_VERSION - 1
      seedDatabaseAtVersion(legacyPath, previousVersion, (legacy) => {
        legacy
          .prepare(
            `INSERT INTO tasks (id, project_root, title, source, lane, suggest_done, created_at, updated_at)
             VALUES (?, ?, ?, 'manual', 'todo', 0, ?, ?)`,
          )
          .run('legacy-task', ROOT, 'written by an older build', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      })

      const upgraded = openDatabase(legacyPath)
      try {
        const legacyStore = new TaskStore(upgraded)
        const record = legacyStore.getTask('legacy-task')
        expect(record?.title).toBe('written by an older build')
        expect(record?.originThreadId).toBeNull()
        expect(legacyStore.listTasks(ROOT)[0]?.originThreadId).toBeNull()
        // …and the upgrade actually added the column rather than passing vacuously.
        const cols = upgraded.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
        expect(cols.map((c) => c.name)).toContain('origin_thread_id')
      } finally {
        upgraded.close()
      }
    })

    it('takes any thread id — no CHECK was reintroduced on tasks', () => {
      // v9 and v22 each had to REBUILD this table to drop a CHECK that silently
      // refused a legal write. Nothing here adds one back.
      const sql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
          .get() as { sql: string }
      ).sql
      expect(sql).not.toMatch(/CHECK/i)
      expect(sql).toMatch(/origin_thread_id/)
    })
  })

  it('orders by updated_at desc', async () => {
    const a = store.createTask({ projectRoot: ROOT, title: 'a' })
    await tick()
    const b = store.createTask({ projectRoot: ROOT, title: 'b' })
    await tick()
    store.updateTask(a.id, { lane: 'doing' }) // a becomes most-recent
    expect(store.listTasks(ROOT).map((t) => t.id)).toEqual([a.id, b.id])
  })
})
