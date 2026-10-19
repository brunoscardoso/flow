// ThreadStore tests — run against the REAL better-sqlite3 driver (Electron
// ABI, via scripts/run-jest.mjs) with a fresh temp-dir database per test.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import Database from 'better-sqlite3'

import { boundedToolCalls } from '../ipc/index'
import { makeMarkerPersister } from '../flow/artifact-observer'
import { parseArtifactMarker } from '../../shared/artifact-marker'
import { checkoutOwnersFor } from '../worktree/worktree-cap'
import { openDatabase, type FlowDatabase } from './db'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations'
import {
  ThreadStore,
  THREAD_STORE_CHANGE_EVENT,
  type ThreadChangeEvent,
} from './thread-store'

const ROOT_A = '/tmp/project-a'
const ROOT_B = '/tmp/project-b'

/** ISO timestamps have millisecond resolution — force a strictly later one. */
async function tick(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('ThreadStore', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore
  let events: ThreadChangeEvent[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-thread-store-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
    events = []
    store.on(THREAD_STORE_CHANGE_EVENT, (event: ThreadChangeEvent) => events.push(event))
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ── CRUD ─────────────────────────────────────────────────────────────

  describe('a thread\u2019s OTHER projects can have checkouts too', () => {
    // THE BUG THIS EXISTS FOR. A thread carries several projects, and only the
    // one it started in could have a checkout \u2014 so the conversation was
    // isolated in one repository and writing straight into the others, with
    // nothing on screen saying so (user, 2026-09-17). Partial isolation is
    // worse than none, because it is the kind you trust.
    const attach = (id: string, root: string): void => {
      store.setThreadRoots(id, [root])
    }

    it('records a checkout against one attached project', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      attach(thread.id, ROOT_B)
      store.setThreadRootWorktree(thread.id, ROOT_B, {
        path: '/tmp/wt/b',
        branch: 'flow/b',
        base: 'main',
      })

      expect(store.getThreadRootWorktrees(thread.id)).toEqual([
        { rootPath: ROOT_B, worktreePath: '/tmp/wt/b', branch: 'flow/b', base: 'main' },
      ])
    })

    it('reports none for a thread whose projects work in their own trees', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      attach(thread.id, ROOT_B)
      expect(store.getThreadRootWorktrees(thread.id)).toEqual([])
    })

    it('clears a checkout without detaching the project', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      attach(thread.id, ROOT_B)
      store.setThreadRootWorktree(thread.id, ROOT_B, {
        path: '/tmp/wt/b',
        branch: null,
        base: null,
      })

      store.setThreadRootWorktree(thread.id, ROOT_B, null)

      expect(store.getThreadRootWorktrees(thread.id)).toEqual([])
      // Releasing a copy and removing a repository from the conversation are
      // different acts, and this must only ever be the first.
      expect(store.getThreadRoots(thread.id)).toContain(ROOT_B)
    })

    it('never invents an attachment for a project the thread does not carry', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.setThreadRootWorktree(thread.id, '/somewhere/else', {
        path: '/tmp/wt/x',
        branch: null,
        base: null,
      })
      expect(store.getThreadRoots(thread.id)).not.toContain('/somewhere/else')
      expect(store.getThreadRootWorktrees(thread.id)).toEqual([])
    })

    it('keeps the primary project\u2019s checkout where every reader already looks', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      attach(thread.id, ROOT_B)
      store.setThreadWorktree(thread.id, { path: '/tmp/wt/a', branch: 'flow/a', base: 'main' })
      store.setThreadRootWorktree(thread.id, ROOT_B, {
        path: '/tmp/wt/b',
        branch: 'flow/b',
        base: 'main',
      })

      // Two different projects, two records, neither describing the other.
      expect(store.getThread(thread.id)?.worktreePath).toBe('/tmp/wt/a')
      expect(store.getThreadRootWorktrees(thread.id).map((w) => w.rootPath)).toEqual([ROOT_B])
    })
  })

  describe('the board\u2019s mark is what makes a run automatic', () => {
    // THE LINK NOBODY ASSERTED. `board-loop.ts` calls `markAsLoopRun` before it
    // dispatches, and `thread-worktree.ts` gates automatic creation on
    // `automaticWorktree(thread)` \u2014 which reads `originLoop`. Both halves are
    // tested; that they MEET was not. If the board ever stopped marking, or the
    // gate ever read a different field, every autonomous run would silently
    // start working in the project\u2019s own tree.
    it('sets originLoop, which is the field the automatic gate reads', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      expect(store.getThread(thread.id)?.originLoop ?? null).toBeNull()

      store.markAsLoopRun(thread.id, 'board', 'Some card')

      expect(store.getThread(thread.id)?.originLoop).toBe('board')
    })

    it('leaves a conversation somebody opened unmarked', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      // The positive above proves the mark lands; this proves it is not the
      // default \u2014 which is the half that keeps people out of worktrees they
      // never asked for.
      expect(store.getThread(thread.id)?.originLoop ?? null).toBeNull()
    })
  })

  describe('a deletion names the checkout it just orphaned', () => {
    // READ BEFORE THE DELETE. After the row goes, nothing can say which
    // checkout belonged to it — so a listener that wants to free the files has
    // exactly this one chance to be told.
    it('carries the checkout when the thread had one', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.setThreadWorktree(thread.id, {
        path: '/tmp/project-a/.flow/wt',
        branch: 'flow/work',
        base: 'main',
      })
      events.length = 0

      store.deleteThread(thread.id)

      const deleted = events.filter((e) => e.entity === 'thread' && e.action === 'deleted')
      expect(deleted).toHaveLength(1)
      expect(deleted[0].abandoned).toEqual({
        projectRoot: ROOT_A,
        worktreePath: '/tmp/project-a/.flow/wt',
        branch: 'flow/work',
      })
    })

    it('omits it entirely when the thread had no checkout', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      events.length = 0

      store.deleteThread(thread.id)

      const deleted = events.filter((e) => e.entity === 'thread' && e.action === 'deleted')
      expect(deleted).toHaveLength(1)
      // Absent means "there was none", never "nobody asked".
      expect(deleted[0]).not.toHaveProperty('abandoned')
    })

    it('says nothing at all when no row actually went', () => {
      events.length = 0
      store.deleteThread('never-existed')
      expect(events).toEqual([])
    })

    it('carries a null branch for a detached checkout rather than dropping it', () => {
      const thread = store.createThread({ projectRoot: ROOT_B })
      store.setThreadWorktree(thread.id, { path: '/tmp/b/.flow/wt', branch: null, base: null })
      events.length = 0

      store.deleteThread(thread.id)

      expect(events.find((e) => e.action === 'deleted')?.abandoned).toEqual({
        projectRoot: ROOT_B,
        worktreePath: '/tmp/b/.flow/wt',
        branch: null,
      })
    })
  })

  describe('default model selection (#848/#885)', () => {
    const withPreference = (model: string | null, effort: string | null): ThreadStore => {
      const prefStore = new ThreadStore(db, () => false, () => ({ model, effort }))
      return prefStore
    }

    it('createThread starts from the preference when no model is given', () => {
      const prefStore = withPreference('opus', 'high')
      const thread = prefStore.createThread({ projectRoot: ROOT_A })
      expect(thread.model).toBe('opus')
      expect(thread.effort).toBe('high')
    })

    it('an explicit model wins over the preference', () => {
      const prefStore = withPreference('opus', 'high')
      const thread = prefStore.createThread({ projectRoot: ROOT_A, model: 'haiku', effort: 'low' })
      expect(thread.model).toBe('haiku')
      expect(thread.effort).toBe('low')
    })

    it('an auto preference carries no effort — routing owns the tier (#332)', () => {
      const prefStore = withPreference('auto', 'high')
      const thread = prefStore.createThread({ projectRoot: ROOT_A })
      expect(thread.model).toBe('auto')
      expect(thread.effort).toBeNull()
    })

    it('no preference → model/effort stay null (Auto)', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      expect(thread.model).toBeNull()
      expect(thread.effort).toBeNull()
    })

    it('importThread starts from the preference too (#885 — imports bypassed the handler-level check)', () => {
      const prefStore = withPreference('sonnet', 'medium')
      const thread = prefStore.importThread({
        projectRoot: ROOT_A,
        title: 'Imported',
        sdkSessionId: 'sess-1',
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
        importedAt: '2026-07-22T00:00:00.000Z',
        messages: [],
      })
      expect(thread.model).toBe('sonnet')
      expect(thread.effort).toBe('medium')
    })
  })

  describe('thread CRUD', () => {
    it('creates a thread with defaults and reads it back', () => {
      const created = store.createThread({ projectRoot: ROOT_A })

      expect(created.title).toBe('New thread')
      expect(created.status).toBe('idle')
      expect(created.sdkSessionId).toBeNull()
      expect(created.model).toBeNull()
      expect(created.effort).toBeNull()
      expect(created.createdAt).toBe(created.updatedAt)

      expect(store.getThread(created.id)).toEqual(created)
    })

    it('creates a thread with explicit title/model/effort', () => {
      const created = store.createThread({
        projectRoot: ROOT_A,
        title: 'Fix the parser',
        model: 'opus',
        effort: 'high',
      })
      expect(store.getThread(created.id)).toMatchObject({
        title: 'Fix the parser',
        model: 'opus',
        effort: 'high',
      })
    })

    it('returns null for an unknown thread', () => {
      expect(store.getThread('nope')).toBeNull()
    })

    it('lists threads newest-activity-first, filtered by project root', async () => {
      const first = store.createThread({ projectRoot: ROOT_A, title: 'first' })
      await tick()
      const second = store.createThread({ projectRoot: ROOT_A, title: 'second' })
      const other = store.createThread({ projectRoot: ROOT_B, title: 'other' })

      const inA = store.listThreads(ROOT_A)
      expect(inA.map((thread) => thread.id)).toEqual([second.id, first.id])

      const all = store.listThreads()
      expect(all).toHaveLength(3)
      expect(all.map((thread) => thread.id)).toContain(other.id)

      // Activity on the older thread bubbles it to the top.
      await tick()
      store.appendMessage(first.id, 'user', 'hello')
      expect(store.listThreads(ROOT_A)[0].id).toBe(first.id)
    })

    it('limit returns only the most-recent N; omitted/<=0 returns everything', async () => {
      const created: string[] = []
      for (let i = 0; i < 4; i++) {
        created.push(store.createThread({ projectRoot: ROOT_A, title: `t${i}` }).id)
        await tick()
      }
      const newestFirst = [...created].reverse()
      // Bounded: the two most-recent, in newest-first order.
      expect(store.listThreads(ROOT_A, { limit: 2 }).map((t) => t.id)).toEqual(
        newestFirst.slice(0, 2),
      )
      // Escape hatch (pattern #18): omitted or <=0 is the whole list.
      expect(store.listThreads(ROOT_A)).toHaveLength(4)
      expect(store.listThreads(ROOT_A, { limit: 0 })).toHaveLength(4)
    })

    it('updates patched fields only, and supports clearing model/effort with null', async () => {
      const created = store.createThread({
        projectRoot: ROOT_A,
        title: 'before',
        model: 'opus',
        effort: 'high',
      })
      await tick()

      const updated = store.updateThread(created.id, { title: 'after', status: 'working' })
      expect(updated).toMatchObject({
        title: 'after',
        status: 'working',
        model: 'opus',
        effort: 'high',
      })
      expect(updated.updatedAt > created.updatedAt).toBe(true)

      const cleared = store.updateThread(created.id, { model: null, effort: null })
      expect(cleared.model).toBeNull()
      expect(cleared.effort).toBeNull()
      expect(cleared.title).toBe('after')

      expect(store.getThread(created.id)).toEqual(cleared)
    })

    it('does NOT bump updated_at for metadata-only toggles (#164)', async () => {
      const created = store.createThread({ projectRoot: ROOT_A, title: 't' })
      await tick()

      // Pin: recency clock stays put, but pinnedAt is stamped.
      const pinned = store.updateThread(created.id, { pinned: true })
      expect(pinned.updatedAt).toBe(created.updatedAt)
      expect(pinned.pinnedAt).not.toBeNull()

      await tick()
      // Unpin: still no bump — the thread keeps its true chronological slot.
      const unpinned = store.updateThread(created.id, { pinned: false })
      expect(unpinned.updatedAt).toBe(created.updatedAt)
      expect(unpinned.pinnedAt).toBeNull()

      await tick()
      // Autonomous-mode toggle: no bump.
      expect(store.updateThread(created.id, { bypassPermissions: true }).updatedAt).toBe(
        created.updatedAt,
      )

      await tick()
      // A real activity change (status) DOES bump.
      expect(store.updateThread(created.id, { status: 'working' }).updatedAt > created.updatedAt).toBe(
        true,
      )
    })

    it('throws when updating an unknown thread', () => {
      expect(() => store.updateThread('missing', { title: 'x' })).toThrow(
        /unknown thread: missing/,
      )
    })

    it('deletes a thread', () => {
      const created = store.createThread({ projectRoot: ROOT_A })
      store.deleteThread(created.id)
      expect(store.getThread(created.id)).toBeNull()
    })

    it('nulls a project’s dangling active-thread pointer on delete (#411)', () => {
      const created = store.createThread({ projectRoot: ROOT_A })
      // Seed the project's active-thread pointer to this thread.
      db.prepare(
        'INSERT INTO workspace_state (project_root, active_thread_id, last_active_at) VALUES (?, ?, ?)',
      ).run(ROOT_A, created.id, Date.now())

      store.deleteThread(created.id)

      // The soft pointer must be cleared so a later switch into ROOT_A doesn't
      // select a ghost thread (which armed the review reject guard, #411).
      const row = db
        .prepare('SELECT active_thread_id FROM workspace_state WHERE project_root = ?')
        .get(ROOT_A) as { active_thread_id: string | null }
      expect(row.active_thread_id).toBeNull()
    })
  })

  // ── updated_at bump on message append ────────────────────────────────

  it('appendMessage bumps the thread updated_at', async () => {
    const thread = store.createThread({ projectRoot: ROOT_A })
    await tick()

    const message = store.appendMessage(thread.id, 'user', 'hello there')

    const after = store.getThread(thread.id)
    expect(after).not.toBeNull()
    expect(after!.updatedAt > thread.updatedAt).toBe(true)
    expect(after!.updatedAt).toBe(message.createdAt)
  })

  it('hasSystemMessage matches only an exact system row (#1056 marker dedupe)', () => {
    const thread = store.createThread({ projectRoot: ROOT_A })
    const marker = '[artifact] plan flow/plans/plan_foo_v1.md'

    expect(store.hasSystemMessage(thread.id, marker)).toBe(false)
    // Same content as a USER row must not count — the guard is system-only.
    store.appendMessage(thread.id, 'user', marker)
    expect(store.hasSystemMessage(thread.id, marker)).toBe(false)

    store.appendMessage(thread.id, 'system', marker)
    expect(store.hasSystemMessage(thread.id, marker)).toBe(true)
    // Scoped to the thread — a sibling thread stays clean.
    const other = store.createThread({ projectRoot: ROOT_A })
    expect(store.hasSystemMessage(other.id, marker)).toBe(false)
  })

  it('lists messages in chronological order', async () => {
    // Ordering is (created_at ASC, id ASC) — same-millisecond appends tie-break
    // on random UUID, so give each message a distinct timestamp.
    const thread = store.createThread({ projectRoot: ROOT_A })
    store.appendMessage(thread.id, 'user', 'one')
    await tick()
    store.appendMessage(thread.id, 'assistant', 'two')
    await tick()
    store.appendMessage(thread.id, 'system', 'three')

    const messages = store.listMessages(thread.id)
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'one'],
      ['assistant', 'two'],
      ['system', 'three'],
    ])
  })

  it('records the model that produced an assistant message and returns it (#129)', async () => {
    const thread = store.createThread({ projectRoot: ROOT_A })
    store.appendMessage(thread.id, 'user', 'hi') // no model
    await tick() // distinct timestamps so the order is deterministic
    const assistant = store.appendMessage(thread.id, 'assistant', 'hello', 'claude-opus-4-8')

    expect(assistant.model).toBe('claude-opus-4-8')
    const messages = store.listMessages(thread.id)
    expect(messages.map((m) => [m.role, m.model])).toEqual([
      ['user', null], // user rows carry no model
      ['assistant', 'claude-opus-4-8'],
    ])
  })

  it('defaults model to null when not supplied (backward compatible)', () => {
    const thread = store.createThread({ projectRoot: ROOT_A })
    const msg = store.appendMessage(thread.id, 'assistant', 'legacy reply')
    expect(msg.model).toBeNull()
    expect(store.listMessages(thread.id)[0].model).toBeNull()
  })

  // ── SDK session mapping ──────────────────────────────────────────────

  describe('latestWriterThreadFor (#1717)', () => {
    it('names the thread whose agent last wrote the doc, scoped to the root', () => {
      const writer = store.createThread({ projectRoot: ROOT_A })
      const reader = store.createThread({ projectRoot: ROOT_A })
      const otherProject = store.createThread({ projectRoot: ROOT_B })

      // A same-named doc written in ANOTHER project must never claim it.
      store.recordToolCall({
        threadId: otherProject.id,
        toolName: 'Write',
        inputJson: JSON.stringify({ file_path: '/b/flow/discovery/discovery_x_v1.md', content: '#' }),
      })
      store.recordToolCall({
        threadId: writer.id,
        toolName: 'Write',
        inputJson: JSON.stringify({ file_path: '/a/flow/discovery/discovery_x_v1.md', content: '#' }),
      })
      // Reads never make a writer.
      store.recordToolCall({
        threadId: reader.id,
        toolName: 'Read',
        inputJson: JSON.stringify({ file_path: '/a/flow/discovery/discovery_x_v1.md' }),
      })

      expect(store.latestWriterThreadFor(ROOT_A, 'flow/discovery/discovery_x_v1.md')).toBe(writer.id)
      expect(store.latestWriterThreadFor(ROOT_A, 'flow/plans/plan_never_v1.md')).toBeNull()
    })

    it('names a thread that wrote the doc into a project ATTACHED to it (live 2026-10-09)', () => {
      // The live report: a thread started in one project wrote its discovery
      // into a sibling it had attached; scoped to the primary root alone, the
      // doc had no writer and the card never appeared.
      const writer = store.createThread({ projectRoot: ROOT_A })
      store.addThreadRoot(writer.id, ROOT_B)
      const stranger = store.createThread({ projectRoot: '/tmp/project-c' })
      store.recordToolCall({
        threadId: writer.id,
        toolName: 'Write',
        inputJson: JSON.stringify({ file_path: '/tmp/project-b/flow/discovery/discovery_y_v1.md', content: '#' }),
      })

      expect(store.latestWriterThreadFor(ROOT_B, 'flow/discovery/discovery_y_v1.md')).toBe(writer.id)
      // A project the writer never attached still cannot claim it.
      expect(store.latestWriterThreadFor('/tmp/project-c', 'flow/discovery/discovery_y_v1.md')).toBeNull()
      expect(stranger.id).not.toBe(writer.id)
    })

    it('never credits an attached project’s doc to a write of the SAME-NAMED doc in the thread’s primary project', () => {
      // Flow docs share names across projects. The thread wrote ITS OWN
      // project's discovery (primary root A); a person hand-wrote a doc of the
      // same name in B, which the thread merely has attached. A relative-suffix
      // match would hand B's doc to this thread.
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.addThreadRoot(thread.id, ROOT_B)
      store.recordToolCall({
        threadId: thread.id,
        toolName: 'Write',
        inputJson: JSON.stringify({ file_path: '/tmp/project-a/flow/discovery/discovery_z_v1.md', content: '#' }),
      })
      expect(store.latestWriterThreadFor(ROOT_B, 'flow/discovery/discovery_z_v1.md')).toBeNull()
      // …and a RELATIVE write runs in the primary project, so it is A's too.
      store.recordToolCall({
        threadId: thread.id,
        toolName: 'Edit',
        inputJson: JSON.stringify({ file_path: 'flow/discovery/discovery_z_v1.md', old_string: 'a', new_string: 'b' }),
      })
      expect(store.latestWriterThreadFor(ROOT_B, 'flow/discovery/discovery_z_v1.md')).toBeNull()
      expect(store.latestWriterThreadFor(ROOT_A, 'flow/discovery/discovery_z_v1.md')).toBe(thread.id)
    })

    it('matches an attached project’s doc written through the link’s REAL path', () => {
      // `flow/` is a link: the agent may have written the physical path. The
      // caller resolves it and passes it on; the store matches either form.
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.addThreadRoot(thread.id, ROOT_B)
      const physical = '/tmp/plan-flow/workspaces/w/projects/b/discovery/discovery_q_v1.md'
      store.recordToolCall({
        threadId: thread.id,
        toolName: 'Write',
        inputJson: JSON.stringify({ file_path: physical, content: '#' }),
      })
      expect(store.latestWriterThreadFor(ROOT_B, 'flow/discovery/discovery_q_v1.md')).toBeNull()
      expect(store.latestWriterThreadFor(ROOT_B, 'flow/discovery/discovery_q_v1.md', [physical])).toBe(thread.id)
    })

    it('through the real marker sink: the attached-project doc lands in the writer thread with its root', () => {
      // The sink exactly as main/index.ts wires it, over a real store — the
      // user is reading another project when the doc appears.
      const writer = store.createThread({ projectRoot: ROOT_A })
      store.addThreadRoot(writer.id, ROOT_B)
      store.recordToolCall({
        threadId: writer.id,
        toolName: 'Write',
        inputJson: JSON.stringify({ file_path: '/tmp/project-b/flow/discovery/discovery_y_v1.md', content: '#' }),
      })
      const persist = makeMarkerPersister({
        activeThreadFor: () => null,
        owningThreadFor: (rootPath, path) => store.latestWriterThreadFor(rootPath, path),
        primaryRootOf: (threadId) => store.getThread(threadId)?.projectRoot ?? null,
        hasMarker: (threadId, content) => store.hasSystemMessage(threadId, content),
        append: (threadId, content) => {
          store.appendMessage(threadId, 'system', content)
        },
      })
      const event = {
        rootId: ROOT_B,
        kind: 'discovery' as const,
        path: 'flow/discovery/discovery_y_v1.md',
        name: 'discovery_y_v1.md',
        mtime: 1,
      }
      expect(persist(event)).toBe(writer.id)
      expect(makeMarkerPersister({
        activeThreadFor: () => null,
        owningThreadFor: (rootPath, path) => store.latestWriterThreadFor(rootPath, path),
        primaryRootOf: (threadId) => store.getThread(threadId)?.projectRoot ?? null,
        hasMarker: (threadId, content) => store.hasSystemMessage(threadId, content),
        append: (threadId, content) => {
          store.appendMessage(threadId, 'system', content)
        },
      })(event)).toBe(writer.id) // a relaunch re-observing it adds nothing

      const markers = store
        .listMessages(writer.id)
        .filter((message) => message.role === 'system')
        .map((message) => parseArtifactMarker(message.content))
      expect(markers).toEqual([{ kind: 'discovery', path: 'flow/discovery/discovery_y_v1.md', root: ROOT_B }])
    })
  })

  describe('checkout owners of a project (attached checkouts included)', () => {
    it('names the thread that RUNS in it and the thread that has it ATTACHED with a copy', () => {
      const runs = store.createThread({ projectRoot: ROOT_A })
      store.setThreadWorktree(runs.id, { path: '/tmp/a-threads/worktree/runs', branch: null, base: null })
      const attaches = store.createThread({ projectRoot: ROOT_B })
      store.addThreadRoot(attaches.id, ROOT_A)
      store.setThreadRootWorktree(attaches.id, ROOT_A, { path: '/tmp/a-threads/worktree/attached', branch: null, base: null })
      const attachedNoCopy = store.createThread({ projectRoot: ROOT_B })
      store.addThreadRoot(attachedNoCopy.id, ROOT_A)

      expect(store.listAttachedCheckouts(ROOT_A)).toEqual([
        { threadId: attaches.id, worktreePath: '/tmp/a-threads/worktree/attached' },
      ])
      const owners = checkoutOwnersFor(store, ROOT_A)
      expect(owners).toContainEqual({ id: runs.id, worktreePath: '/tmp/a-threads/worktree/runs' })
      expect(owners).toContainEqual({ id: attaches.id, worktreePath: '/tmp/a-threads/worktree/attached', attached: true })
    })
  })

  describe('SDK session mapping', () => {
    it('sets and resolves a session id', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.setSdkSessionId(thread.id, 'session-1')

      expect(store.getThread(thread.id)!.sdkSessionId).toBe('session-1')
      expect(store.getThreadBySdkSessionId('session-1')!.id).toBe(thread.id)
    })

    it('clears a session id with null', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.setSdkSessionId(thread.id, 'session-1')
      store.setSdkSessionId(thread.id, null)

      expect(store.getThread(thread.id)!.sdkSessionId).toBeNull()
      expect(store.getThreadBySdkSessionId('session-1')).toBeNull()
    })

    it('enforces session-id uniqueness across threads (null exempt)', () => {
      const one = store.createThread({ projectRoot: ROOT_A })
      const two = store.createThread({ projectRoot: ROOT_A })
      store.setSdkSessionId(one.id, 'session-1')

      expect(() => store.setSdkSessionId(two.id, 'session-1')).toThrow()

      // Multiple NULL session ids are allowed (partial unique index).
      store.setSdkSessionId(one.id, null)
      store.setSdkSessionId(two.id, null)
      expect(store.getThread(two.id)!.sdkSessionId).toBeNull()
    })

    it('throws when mapping a session for an unknown thread', () => {
      expect(() => store.setSdkSessionId('missing', 'session-9')).toThrow(
        /unknown thread: missing/,
      )
    })

    it('returns null for an unknown session id', () => {
      expect(store.getThreadBySdkSessionId('never-set')).toBeNull()
    })
  })

  // ── Search ───────────────────────────────────────────────────────────

  describe('searchThreads', () => {
    it('matches on title and on message content (case-insensitive)', () => {
      const byTitle = store.createThread({ projectRoot: ROOT_A, title: 'Refactor Parser' })
      const byContent = store.createThread({ projectRoot: ROOT_A, title: 'untitled' })
      store.appendMessage(byContent.id, 'user', 'please refactor the PARSER module')
      store.createThread({ projectRoot: ROOT_A, title: 'unrelated' })

      const found = store.searchThreads('parser')
      expect(found.map((thread) => thread.id).sort()).toEqual(
        [byTitle.id, byContent.id].sort(),
      )
    })

    it('deduplicates a thread matching in multiple messages', () => {
      const thread = store.createThread({ projectRoot: ROOT_A, title: 'untitled' })
      store.appendMessage(thread.id, 'user', 'needle one')
      store.appendMessage(thread.id, 'assistant', 'needle two')

      expect(store.searchThreads('needle')).toHaveLength(1)
    })

    it('treats LIKE wildcards % and _ as literals', () => {
      const percent = store.createThread({ projectRoot: ROOT_A, title: 'progress 100% done' })
      store.createThread({ projectRoot: ROOT_A, title: 'progress 100x done' })
      const underscore = store.createThread({ projectRoot: ROOT_A, title: 'snake_case_name' })
      store.createThread({ projectRoot: ROOT_A, title: 'snakeXcaseXname' })

      const percentHits = store.searchThreads('100%')
      expect(percentHits.map((thread) => thread.id)).toEqual([percent.id])

      const underscoreHits = store.searchThreads('snake_case')
      expect(underscoreHits.map((thread) => thread.id)).toEqual([underscore.id])
    })

    it('scopes search to a project root when given', () => {
      const inA = store.createThread({ projectRoot: ROOT_A, title: 'shared topic' })
      store.createThread({ projectRoot: ROOT_B, title: 'shared topic' })

      const found = store.searchThreads('shared topic', ROOT_A)
      expect(found.map((thread) => thread.id)).toEqual([inA.id])
    })
  })

  // ── FTS5 search index (PERF-4) ───────────────────────────────────────

  describe('FTS5 search (PERF-4)', () => {
    it('creates the FTS tables via migration v2 (better-sqlite3 ships FTS5)', () => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('threads_fts', 'messages_fts') ORDER BY name",
        )
        .all() as Array<{ name: string }>
      expect(tables.map((table) => table.name)).toEqual(['messages_fts', 'threads_fts'])
    })

    it('matches multi-token queries against message content (all tokens required)', () => {
      const hit = store.createThread({ projectRoot: ROOT_A, title: 'untitled' })
      store.appendMessage(hit.id, 'user', 'please refactor the PARSER module now')
      const miss = store.createThread({ projectRoot: ROOT_A, title: 'untitled' })
      store.appendMessage(miss.id, 'user', 'refactor something else entirely')

      expect(store.searchThreads('refactor parser').map((thread) => thread.id)).toEqual([hit.id])
      expect(store.searchThreads('refactor nothing')).toEqual([])
    })

    it('matches token prefixes', () => {
      const thread = store.createThread({ projectRoot: ROOT_A, title: 'untitled' })
      store.appendMessage(thread.id, 'user', 'investigating the tokenizer internals')

      expect(store.searchThreads('token').map((t) => t.id)).toEqual([thread.id])
      expect(store.searchThreads('internal').map((t) => t.id)).toEqual([thread.id])
    })

    it('stays in sync after message append and cascade delete', () => {
      const thread = store.createThread({ projectRoot: ROOT_A, title: 'untitled' })
      expect(store.searchThreads('xylophone')).toEqual([])

      store.appendMessage(thread.id, 'user', 'a xylophone solo')
      expect(store.searchThreads('xylophone').map((t) => t.id)).toEqual([thread.id])

      store.deleteThread(thread.id)
      expect(store.searchThreads('xylophone')).toEqual([])
      // The FTS shadow rows are gone too, not just the content rows.
      const orphaned = db
        .prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'xylophone'")
        .get() as { n: number }
      expect(orphaned.n).toBe(0)
    })

    it('stays in sync after a title update', () => {
      const thread = store.createThread({ projectRoot: ROOT_A, title: 'ancient title' })
      store.updateThread(thread.id, { title: 'modern heading' })

      expect(store.searchThreads('ancient')).toEqual([])
      expect(store.searchThreads('modern').map((t) => t.id)).toEqual([thread.id])
    })

    it('falls back to the LIKE scan for punctuation-only queries', () => {
      const thread = store.createThread({ projectRoot: ROOT_A, title: 'urgent!!! fix now' })
      store.createThread({ projectRoot: ROOT_A, title: 'calm and quiet' })

      expect(store.searchThreads('!!!').map((t) => t.id)).toEqual([thread.id])
    })

    it('returns every thread for an empty query (LIKE fallback, pre-v2 behavior)', () => {
      store.createThread({ projectRoot: ROOT_A, title: 'one' })
      store.createThread({ projectRoot: ROOT_B, title: 'two' })
      expect(store.searchThreads('')).toHaveLength(2)
    })
  })

  // ── Migration v1 → v2 ────────────────────────────────────────────────

  describe('migration from a v1 database (PERF-4)', () => {
    it('backfills the FTS index over pre-existing rows and bumps the version', () => {
      const fixturePath = join(tempDir, 'legacy.sqlite')

      // Build a REAL v1 database: v1 schema + schema_version=1 + data rows.
      const legacy = new Database(fixturePath)
      const v1 = MIGRATIONS.find((migration) => migration.version === 1)!
      legacy.exec(v1.up as string)
      legacy.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
      legacy.prepare('INSERT INTO schema_version (version) VALUES (1)').run()
      legacy
        .prepare(
          `INSERT INTO threads (id, workspace_root, title, status, created_at, updated_at)
           VALUES ('t1', ?, 'legacy searchable title', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(ROOT_A)
      legacy
        .prepare(
          `INSERT INTO messages (id, thread_id, role, content, created_at)
           VALUES ('m1', 't1', 'user', 'ancient banana content', '2026-01-01T00:00:00.000Z')`,
        )
        .run()
      legacy.close()

      // openDatabase migrates v1 → v2 and the 'rebuild' backfill indexes
      // the pre-existing rows.
      const migrated = openDatabase(fixturePath)
      try {
        const version = migrated.prepare('SELECT version FROM schema_version').get() as {
          version: number
        }
        expect(version.version).toBe(LATEST_SCHEMA_VERSION)

        const migratedStore = new ThreadStore(migrated)
        expect(migratedStore.searchThreads('banana').map((t) => t.id)).toEqual(['t1'])
        expect(migratedStore.searchThreads('legacy title').map((t) => t.id)).toEqual(['t1'])

        // Idempotent: re-running the v2 migration body on a migrated DB is
        // harmless (IF NOT EXISTS + 'rebuild' backfill).
        const v2 = MIGRATIONS.find((migration) => migration.version === 2)!
        expect(() => (v2.up as (db: FlowDatabase) => void)(migrated)).not.toThrow()
        expect(migratedStore.searchThreads('banana').map((t) => t.id)).toEqual(['t1'])
      } finally {
        migrated.close()
      }
    })
  })

  // ── Tool calls ───────────────────────────────────────────────────────

  describe('tool-call record lifecycle', () => {
    it('records pending, transitions to running, then completes with output', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const call = store.recordToolCall({
        threadId: thread.id,
        toolName: 'Bash',
        inputJson: '{"command":"ls"}',
      })

      expect(call.status).toBe('pending')
      expect(call.outputJson).toBeNull()
      expect(call.completedAt).toBeNull()
      expect(call.messageId).toBeNull()

      store.updateToolCall(call.id, { status: 'running' })
      expect(store.listToolCalls(thread.id)[0]).toMatchObject({
        status: 'running',
        inputJson: '{"command":"ls"}',
        outputJson: null,
      })

      const completedAt = new Date().toISOString()
      store.updateToolCall(call.id, {
        status: 'success',
        outputJson: '{"stdout":"file.txt"}',
        completedAt,
      })
      expect(store.listToolCalls(thread.id)[0]).toMatchObject({
        status: 'success',
        outputJson: '{"stdout":"file.txt"}',
        completedAt,
      })
    })

    it('links a tool call to a message when given', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const message = store.appendMessage(thread.id, 'assistant', 'running a tool')
      const call = store.recordToolCall({
        threadId: thread.id,
        messageId: message.id,
        toolName: 'Read',
      })
      expect(store.listToolCalls(thread.id)[0].messageId).toBe(message.id)
      expect(call.inputJson).toBeNull()
    })

    it('throws when updating an unknown tool call', () => {
      expect(() => store.updateToolCall('missing', { status: 'error' })).toThrow(
        /unknown tool call: missing/,
      )
    })
  })

  // ── Tool-call point/slim/count queries (perf batch) ──────────────────

  describe('tool-call point, slim, and count queries', () => {
    it('getToolCall point-reads one record and null for unknown/foreign ids', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const other = store.createThread({ projectRoot: ROOT_A })
      const call = store.recordToolCall({
        threadId: thread.id,
        toolName: 'Bash',
        inputJson: '{"command":"ls"}',
      })

      expect(store.getToolCall(thread.id, call.id)).toMatchObject({
        id: call.id,
        threadId: thread.id,
        toolName: 'Bash',
        status: 'pending',
      })
      expect(store.getToolCall(thread.id, 'missing')).toBeNull()
      // Scoped by thread — another thread cannot read this call.
      expect(store.getToolCall(other.id, call.id)).toBeNull()
    })

    it('countToolCalls counts per thread', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const other = store.createThread({ projectRoot: ROOT_A })
      expect(store.countToolCalls(thread.id)).toBe(0)
      store.recordToolCall({ threadId: thread.id, toolName: 'Bash' })
      store.recordToolCall({ threadId: thread.id, toolName: 'Read' })
      store.recordToolCall({ threadId: other.id, toolName: 'Grep' })
      expect(store.countToolCalls(thread.id)).toBe(2)
      expect(store.countToolCalls(other.id)).toBe(1)
    })

    it('listToolCallsSlim matches listToolCalls order and applies the SQL offset', async () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const first = store.recordToolCall({
        threadId: thread.id,
        toolName: 'Bash',
        inputJson: '{"command":"a"}',
      })
      await tick()
      const second = store.recordToolCall({ threadId: thread.id, toolName: 'Grep' })
      await tick()
      const third = store.recordToolCall({ threadId: thread.id, toolName: 'Read' })
      store.updateToolCall(second.id, { status: 'success', outputJson: '"out"' })

      const all = store.listToolCallsSlim(thread.id)
      expect(all.map((call) => call.id)).toEqual(
        store.listToolCalls(thread.id).map((call) => call.id),
      )
      expect(all[0]).toEqual({
        id: first.id,
        toolName: 'Bash',
        inputJson: '{"command":"a"}',
        outputJson: null,
        status: 'pending',
        startedAt: first.startedAt,
        completedAt: null,
      })
      expect(all[1]).toMatchObject({ id: second.id, status: 'success', outputJson: '"out"' })

      expect(store.listToolCallsSlim(thread.id, 2).map((call) => call.id)).toEqual([third.id])
      expect(store.listToolCallsSlim(thread.id, 3)).toEqual([])
    })

    it('listToolCallInputs projects name + input only, in order', async () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.recordToolCall({
        threadId: thread.id,
        toolName: 'Edit',
        inputJson: '{"file_path":"/a"}',
      })
      await tick()
      store.recordToolCall({ threadId: thread.id, toolName: 'Bash' })

      expect(store.listToolCallInputs(thread.id)).toEqual([
        { toolName: 'Edit', inputJson: '{"file_path":"/a"}' },
        { toolName: 'Bash', inputJson: null },
      ])
    })

    it('listToolCallPaths projects the touched file, never the input', async () => {
      // The capture runs on every successful turn and needs ONE field. Reading
      // the inputs whole measured 1.69 MB on a 600-call thread, because a
      // Write's input is the file it wrote.
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.recordToolCall({
        threadId: thread.id,
        toolName: 'Write',
        inputJson: JSON.stringify({ file_path: '/repo/a.ts', content: 'x'.repeat(10_000) }),
      })
      await tick()
      store.recordToolCall({
        threadId: thread.id,
        toolName: 'NotebookEdit',
        inputJson: JSON.stringify({ notebook_path: '/repo/nb.ipynb' }),
      })
      await tick()
      store.recordToolCall({ threadId: thread.id, toolName: 'Bash', inputJson: 'not json at all' })
      await tick()
      store.recordToolCall({ threadId: thread.id, toolName: 'Task' })

      expect(store.listToolCallPaths(thread.id)).toEqual([
        { toolName: 'Write', filePath: '/repo/a.ts' },
        { toolName: 'NotebookEdit', filePath: '/repo/nb.ipynb' },
        // Unparseable and absent inputs are not a failure — a capture is
        // best-effort, and SQLite raises on malformed JSON rather than
        // returning null, which is what json_valid is guarding.
        { toolName: 'Bash', filePath: null },
        { toolName: 'Task', filePath: null },
      ])
    })

    it('migration v20 creates the perf indexes', () => {
      const names = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
      expect(names).toContain('idx_tool_calls_thread_started')
      expect(names).toContain('idx_messages_thread_role')
    })
  })

  // ── Cascade delete ───────────────────────────────────────────────────

  it('deleting a thread cascades to its messages and tool calls', () => {
    const thread = store.createThread({ projectRoot: ROOT_A })
    const survivor = store.createThread({ projectRoot: ROOT_A })
    store.appendMessage(thread.id, 'user', 'to be deleted')
    store.recordToolCall({ threadId: thread.id, toolName: 'Bash' })
    store.appendMessage(survivor.id, 'user', 'kept')

    store.deleteThread(thread.id)

    expect(store.listMessages(thread.id)).toEqual([])
    expect(store.listToolCalls(thread.id)).toEqual([])
    // Raw counts, not just the store's own accessors.
    const rows = db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }
    expect(rows.n).toBe(1)
    expect(store.listMessages(survivor.id)).toHaveLength(1)
  })

  // ── Change events ────────────────────────────────────────────────────

  describe('change events', () => {
    it('emits for every mutation with the right entity/action/threadId', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.updateThread(thread.id, { status: 'working' })
      store.appendMessage(thread.id, 'user', 'hi')
      const call = store.recordToolCall({ threadId: thread.id, toolName: 'Bash' })
      store.updateToolCall(call.id, { status: 'success' })
      store.setSdkSessionId(thread.id, 'session-1')
      store.deleteThread(thread.id)

      expect(events).toEqual([
        { entity: 'thread', action: 'created', threadId: thread.id },
        { entity: 'thread', action: 'updated', threadId: thread.id },
        { entity: 'message', action: 'created', threadId: thread.id },
        { entity: 'tool_call', action: 'created', threadId: thread.id },
        { entity: 'tool_call', action: 'updated', threadId: thread.id },
        { entity: 'thread', action: 'updated', threadId: thread.id },
        { entity: 'thread', action: 'deleted', threadId: thread.id },
      ])
    })

    it('does not emit a delete event for a nonexistent thread', () => {
      store.deleteThread('missing')
      expect(events).toEqual([])
    })
  })

  describe('reconcileInterruptedWork', () => {
    it('resets stale working threads to idle and running tool calls to error', () => {
      const working = store.createThread({ projectRoot: ROOT_A, title: 'mid-turn' })
      store.updateThread(working.id, { status: 'working' })
      const blocked = store.createThread({ projectRoot: ROOT_A, title: 'blocked' })
      store.updateThread(blocked.id, { status: 'blocked' })
      const done = store.createThread({ projectRoot: ROOT_A, title: 'finished' })
      store.updateThread(done.id, { status: 'done' })
      const running = store.recordToolCall({
        threadId: working.id,
        toolName: 'Bash',
        inputJson: '{}',
      })
      store.updateToolCall(running.id, { status: 'running' })

      store.reconcileInterruptedWork()

      expect(store.getThread(working.id)?.status).toBe('idle')
      expect(store.getThread(blocked.id)?.status).toBe('idle')
      // A settled thread is untouched.
      expect(store.getThread(done.id)?.status).toBe('done')
      const tool = store.listToolCalls(working.id)[0]
      expect(tool.status).toBe('error')
    })

    it('is a no-op when nothing is in flight', () => {
      const idle = store.createThread({ projectRoot: ROOT_A, title: 'idle' })
      expect(() => store.reconcileInterruptedWork()).not.toThrow()
      expect(store.getThread(idle.id)?.status).toBe('idle')
    })

    it('preserves updated_at — a restart reset is not activity, so the sidebar order is stable (#262)', () => {
      const blocked = store.createThread({ projectRoot: ROOT_A, title: 'blocked long ago' })
      store.updateThread(blocked.id, { status: 'blocked' })
      const before = store.getThread(blocked.id)?.updatedAt

      store.reconcileInterruptedWork()

      const after = store.getThread(blocked.id)
      expect(after?.status).toBe('idle') // status reset…
      expect(after?.updatedAt).toBe(before) // …but the last-activity clock is untouched
    })
  })

  // ── Archiving (migration v5) ─────────────────────────────────────────
  describe('thread archiving', () => {
    it('a new thread is not archived', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      expect(thread.archivedAt).toBeNull()
    })

    it('archive sets archived_at; unarchive clears it, preserving other fields', () => {
      const thread = store.createThread({ projectRoot: ROOT_A, title: 'keep' })

      const archived = store.updateThread(thread.id, { archived: true })
      expect(archived.archivedAt).not.toBeNull()
      expect(archived.title).toBe('keep')
      expect(store.getThread(thread.id)?.archivedAt).not.toBeNull()

      const unarchived = store.updateThread(thread.id, { archived: false })
      expect(unarchived.archivedAt).toBeNull()
      expect(store.getThread(thread.id)?.archivedAt).toBeNull()
    })

    it('re-archiving keeps the original archived_at timestamp', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const first = store.updateThread(thread.id, { archived: true }).archivedAt
      const second = store.updateThread(thread.id, { archived: true, title: 'x' }).archivedAt
      expect(second).toBe(first)
    })

    it('listThreads excludes archived by default and includes them on request', () => {
      const active = store.createThread({ projectRoot: ROOT_A, title: 'active' })
      const gone = store.createThread({ projectRoot: ROOT_A, title: 'gone' })
      store.updateThread(gone.id, { archived: true })

      const activeOnly = store.listThreads(ROOT_A)
      expect(activeOnly.map((t) => t.id)).toEqual([active.id])

      const all = store.listThreads(ROOT_A, { includeArchived: true })
      expect(all.map((t) => t.id).sort()).toEqual([active.id, gone.id].sort())
    })

    it('an updateThread that does not touch `archived` leaves archived_at intact', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.updateThread(thread.id, { archived: true })
      const renamed = store.updateThread(thread.id, { title: 'renamed' })
      expect(renamed.archivedAt).not.toBeNull()
      expect(renamed.title).toBe('renamed')
    })

    it('createThread yields a non-imported, unpinned thread', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      expect(thread.importedAt).toBeNull()
      expect(thread.pinnedAt).toBeNull()
      expect(store.getThread(thread.id)?.importedAt).toBeNull()
      expect(store.getThread(thread.id)?.pinnedAt).toBeNull()
    })
  })

  // ── Skip-permissions (bypassPermissions) ───────────────────────────────

  describe('bypassPermissions', () => {
    it('defaults to false on a new thread', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      expect(thread.bypassPermissions).toBe(false)
      expect(store.getThread(thread.id)?.bypassPermissions).toBe(false)
    })

    it('setting it persists and round-trips through getThread', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const updated = store.updateThread(thread.id, { bypassPermissions: true })
      expect(updated.bypassPermissions).toBe(true)
      expect(store.getThread(thread.id)?.bypassPermissions).toBe(true)

      const cleared = store.updateThread(thread.id, { bypassPermissions: false })
      expect(cleared.bypassPermissions).toBe(false)
    })

    it('an update that does not touch it leaves bypassPermissions intact', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.updateThread(thread.id, { bypassPermissions: true })
      const renamed = store.updateThread(thread.id, { title: 'renamed' })
      expect(renamed.bypassPermissions).toBe(true)
    })
  })

  // ── Pinning ────────────────────────────────────────────────────────────

  describe('pin/unpin', () => {
    it('pinning sets pinned_at; unpinning clears it', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const pinned = store.updateThread(thread.id, { pinned: true })
      expect(pinned.pinnedAt).not.toBeNull()
      expect(store.getThread(thread.id)?.pinnedAt).toBe(pinned.pinnedAt)

      const unpinned = store.updateThread(thread.id, { pinned: false })
      expect(unpinned.pinnedAt).toBeNull()
    })

    it('an update that does not touch `pinned` leaves pinned_at intact', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const pinnedAt = store.updateThread(thread.id, { pinned: true }).pinnedAt
      const renamed = store.updateThread(thread.id, { title: 'renamed' })
      expect(renamed.pinnedAt).toBe(pinnedAt)
    })

    it('re-pinning an already-pinned thread keeps the original pinned_at', async () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const first = store.updateThread(thread.id, { pinned: true }).pinnedAt
      await tick()
      const second = store.updateThread(thread.id, { pinned: true }).pinnedAt
      expect(second).toBe(first)
    })
  })

  // ── Claude Code import (importThread) ──────────────────────────────────

  describe('importThread', () => {
    const CREATED = '2026-05-28T15:34:29.896Z'
    const UPDATED = '2026-05-28T15:40:00.000Z'
    const IMPORTED = '2026-07-11T00:00:00.000Z'

    function importFixture(sessionId: string) {
      return store.importThread({
        projectRoot: ROOT_A,
        title: 'Add bug-fixes sidebar category to docs',
        sdkSessionId: sessionId,
        createdAt: CREATED,
        updatedAt: UPDATED,
        importedAt: IMPORTED,
        messages: [
          { role: 'user', content: 'first prompt', createdAt: CREATED },
          { role: 'assistant', content: '⤷ Bash: ls', createdAt: '2026-05-28T15:35:00.000Z' },
          { role: 'user', content: 'second prompt', createdAt: UPDATED },
        ],
      })
    }

    it('inserts a thread + messages preserving original timestamps and imported_at', () => {
      const thread = importFixture('sess-1')
      expect(thread.importedAt).toBe(IMPORTED)
      expect(thread.sdkSessionId).toBe('sess-1')

      const reread = store.getThread(thread.id)
      expect(reread?.createdAt).toBe(CREATED)
      expect(reread?.updatedAt).toBe(UPDATED) // NOT bumped to now
      expect(reread?.importedAt).toBe(IMPORTED)

      const messages = store.listMessages(thread.id)
      expect(messages.map((m) => m.content)).toEqual([
        'first prompt',
        '⤷ Bash: ls',
        'second prompt',
      ])
      expect(messages[0]?.createdAt).toBe(CREATED)
      expect(messages[2]?.createdAt).toBe(UPDATED)
    })

    it('emits exactly one thread:created change for the whole import', () => {
      events = []
      importFixture('sess-2')
      const created = events.filter((e) => e.entity === 'thread' && e.action === 'created')
      expect(created).toHaveLength(1)
    })

    it('is deduped by getThreadBySdkSessionId (caller skips re-import)', () => {
      const first = importFixture('sess-3')
      const existing = store.getThreadBySdkSessionId('sess-3')
      expect(existing?.id).toBe(first.id)
      // Importing the same session id again would violate the UNIQUE index —
      // callers dedup first, which the presence lookup above enables.
      expect(() => importFixture('sess-3')).toThrow()
    })
  })

  // ── Migration v6 ───────────────────────────────────────────────────────

  describe('migration v6 (imported_at)', () => {
    it('is the latest schema version and adds the column additively', () => {
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(6)
      const columns = db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>
      expect(columns.map((c) => c.name)).toContain('imported_at')
      // A plain thread created after the migration reads as non-imported.
      const thread = store.createThread({ projectRoot: ROOT_A })
      expect(thread.importedAt).toBeNull()
    })
  })

  // ── plan_chat-cleanup Phase 1: the message that ended a turn ──
  describe('markTurnEnd — the turn-end mark (migration v36)', () => {
    it('adds ends_turn additively: NOT NULL, default 0', () => {
      const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{
        name: string
        notnull: number
        dflt_value: string | null
      }>
      expect(columns.find((column) => column.name === 'ends_turn')).toMatchObject({
        notnull: 1,
        dflt_value: '0',
      })
    })

    it('leaves endsTurn OUT of an unmarked message, so old payloads are unchanged', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const message = store.appendMessage(thread.id, 'assistant', 'a step', 'claude-opus-5')
      const [read] = store.listMessages(thread.id)
      expect(read?.id).toBe(message.id)
      expect(read).not.toHaveProperty('endsTurn')
    })

    it('marks an assistant message, reads it back as endsTurn: true, and emits one update', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const step = store.appendMessage(thread.id, 'assistant', 'a step')
      const answer = store.appendMessage(thread.id, 'assistant', 'the answer')
      events.length = 0

      expect(store.markTurnEnd(answer.id)).toBe(true)

      const read = store.listMessages(thread.id)
      expect(read.find((m) => m.id === answer.id)?.endsTurn).toBe(true)
      expect(read.find((m) => m.id === step.id)).not.toHaveProperty('endsTurn')
      // The bounded read carries the mark too.
      expect(store.listMessages(thread.id, { limit: 1 })[0]?.endsTurn).toBe(true)
      expect(events).toEqual([{ entity: 'message', action: 'updated', threadId: thread.id }])
    })

    it('is a no-op (false) for an unknown id, a user or system row, and a row already marked', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      const user = store.appendMessage(thread.id, 'user', 'a question')
      const system = store.appendMessage(thread.id, 'system', 'Interrupted by you')
      const answer = store.appendMessage(thread.id, 'assistant', 'the answer')
      // Positive first: the assistant row IS markable.
      expect(store.markTurnEnd(answer.id)).toBe(true)
      events.length = 0

      expect(store.markTurnEnd('no-such-message')).toBe(false)
      expect(store.markTurnEnd(user.id)).toBe(false)
      expect(store.markTurnEnd(system.id)).toBe(false)
      expect(store.markTurnEnd(answer.id)).toBe(false)

      const read = store.listMessages(thread.id)
      expect(read.find((m) => m.id === user.id)).not.toHaveProperty('endsTurn')
      expect(read.find((m) => m.id === system.id)).not.toHaveProperty('endsTurn')
      expect(events).toEqual([])
    })
  })

  // ── #48: new threads inherit the app-wide autonomy (bypassPermissions) default ──
  describe('autonomy bypass default', () => {
    it('defaults to false with no provider', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      expect(thread.bypassPermissions).toBe(false)
      expect(store.getThread(thread.id)?.bypassPermissions).toBe(false)
    })

    it('inherits the app-wide default when unspecified', () => {
      const autonomous = new ThreadStore(db, () => true)
      const thread = autonomous.createThread({ projectRoot: ROOT_A })
      expect(thread.bypassPermissions).toBe(true)
      expect(store.getThread(thread.id)?.bypassPermissions).toBe(true)
    })

    it('lets an explicit value win over the default', () => {
      const autonomous = new ThreadStore(db, () => true)
      const thread = autonomous.createThread({ projectRoot: ROOT_A, bypassPermissions: false })
      expect(thread.bypassPermissions).toBe(false)
    })
  })

  // ── #45: additional project roots (multi-project threads) ────────────────
  describe('listThreadWorktrees — what the address gate may open', () => {
    it('returns the ATTACHED projects’ checkouts too, not just the primary', () => {
      // ITS ONE CONSUMER IS THE ADDRESS GATE, so a checkout missing from this
      // list is a directory the renderer cannot list. It read `threads` alone —
      // the checkout of the project a conversation started in — while every
      // attached project's checkout lives in `thread_roots`, so the explorer
      // answered "Project folder not found" over a directory the app had just
      // made (user, 2026-09-17, pressing "Give it a copy too").
      const t = store.createThread({ projectRoot: ROOT_A })
      store.setThreadWorktree(t.id, { path: '/w/primary', branch: null, base: null })
      store.addThreadRoot(t.id, ROOT_B)
      store.setThreadRootWorktree(t.id, ROOT_B, {
        path: '/w/attached',
        branch: 'worktree/x',
        base: 'main',
      })

      const listed = store.listThreadWorktrees()
      // The positive first: the primary is there, as it always was…
      expect(listed).toContainEqual({ worktreePath: '/w/primary', projectRoot: ROOT_A })
      // …and so is the one that made the explorer throw.
      expect(listed).toContainEqual({ worktreePath: '/w/attached', projectRoot: ROOT_B })
    })

    it('never returns a root with no checkout of its own', () => {
      const t = store.createThread({ projectRoot: ROOT_A })
      store.addThreadRoot(t.id, ROOT_B)
      expect(store.listThreadWorktrees()).toEqual([])
    })
  })

  // A RENAME MOVES EVERY RECORD THAT HOLDS THE PATH, not only the ones it is
  // about. This rewrote `threads` and `thread_roots` and left `workspace_state`,
  // whose `open_files` column addresses the checkout by path — so the migration
  // moved 21 directories and left the editor's tabs pointing at folders that no
  // longer existed (user, 2026-09-18).
  describe('repointCheckout — the whole record follows the directory', () => {
    const FROM = '/repos/.orbit-core-threads/e2265b48-03e9-43e3-8f76-ff887a48615e'
    const TO = '/repos/.orbit-core-threads/worktree/data-contract-guard'

    it('moves the thread, the attached root AND the project’s open tabs', () => {
      const t = store.createThread({ projectRoot: ROOT_A })
      store.setThreadWorktree(t.id, { path: FROM, branch: null, base: null })
      store.addThreadRoot(t.id, ROOT_B)
      store.setThreadRootWorktree(t.id, ROOT_B, { path: FROM, branch: null, base: null })
      db
        .prepare(
          `INSERT INTO workspace_state (project_root, open_files, active_file, open_terminals,
             active_thread_id, last_active_at, dirty_buffers)
           VALUES (?, ?, NULL, '[]', NULL, '2026-09-18T00:00:00.000Z', ?)`,
        )
        .run(
          ROOT_A,
          JSON.stringify([{ rootPath: FROM, relPath: 'a.ts' }]),
          JSON.stringify({ [`${FROM}/a.ts`]: 'half a sentence' }),
        )

      store.repointCheckout(FROM, TO)

      expect(store.getThread(t.id)?.worktreePath).toBe(TO)
      expect(store.listThreadWorktrees().map((entry) => entry.worktreePath)).toEqual([TO, TO])
      const row = db
        .prepare('SELECT open_files, dirty_buffers FROM workspace_state WHERE project_root = ?')
        .get(ROOT_A) as { open_files: string; dirty_buffers: string }
      expect(JSON.parse(row.open_files)).toEqual([{ rootPath: TO, relPath: 'a.ts' }])
      // …and the unsaved text with it: a tab moved without its buffer comes
      // back CLEAN, which destroys what was typed (#955).
      expect(JSON.parse(row.dirty_buffers)).toEqual({ [`${TO}/a.ts`]: 'half a sentence' })
    })
  })

  describe('thread roots', () => {
    it('starts empty and adds/reads additional roots', () => {
      const t = store.createThread({ projectRoot: ROOT_A })
      expect(store.getThreadRoots(t.id)).toEqual([])
      store.addThreadRoot(t.id, ROOT_B)
      store.addThreadRoot(t.id, ROOT_B) // idempotent
      expect(store.getThreadRoots(t.id)).toEqual([ROOT_B])
    })

    it('setThreadRoots replaces, dedupes, and never stores the primary', () => {
      const t = store.createThread({ projectRoot: ROOT_A })
      store.setThreadRoots(t.id, [ROOT_B, ROOT_B, ROOT_A, '/tmp/project-c'])
      expect(store.getThreadRoots(t.id)).toEqual([ROOT_B, '/tmp/project-c']) // sorted, no primary
      store.setThreadRoots(t.id, [ROOT_B])
      expect(store.getThreadRoots(t.id)).toEqual([ROOT_B]) // replaced
    })

    it('cascades on thread delete', () => {
      const t = store.createThread({ projectRoot: ROOT_A })
      store.addThreadRoot(t.id, ROOT_B)
      store.deleteThread(t.id)
      expect(store.getThreadRoots(t.id)).toEqual([])
    })

    it('getThreadRootsBatch reads many threads in one query, matching getThreadRoots', () => {
      const withRoots = store.createThread({ projectRoot: ROOT_A })
      store.setThreadRoots(withRoots.id, ['/tmp/project-c', ROOT_B]) // stored sorted
      const bare = store.createThread({ projectRoot: ROOT_A })

      const batch = store.getThreadRootsBatch([withRoots.id, bare.id, 'unknown'])
      // Same sorted roots the per-thread reader returns.
      expect(batch.get(withRoots.id)).toEqual([ROOT_B, '/tmp/project-c'])
      expect(batch.get(withRoots.id)).toEqual(store.getThreadRoots(withRoots.id))
      // A thread (or unknown id) with no extra roots is ABSENT — callers default to [].
      expect(batch.has(bare.id)).toBe(false)
      expect(batch.has('unknown')).toBe(false)
      // Empty input is a no-op, not a query.
      expect(store.getThreadRootsBatch([]).size).toBe(0)
    })
  })

  // ── #1745: the remote binding a thread was given (migrations v26/v27) ────
  describe('remote binding mirror', () => {
    /** The four v26 columns plus the v27 freshness flag, as stored. */
    function rawBindingRow(threadId: string) {
      return db
        .prepare(
          `SELECT remote, remote_branch, pr_base, previously_pushed_as, base_may_be_behind
             FROM threads WHERE id = ?`,
        )
        .get(threadId) as {
        remote: string | null
        remote_branch: string | null
        pr_base: string | null
        previously_pushed_as: string | null
        base_may_be_behind: number | null
      }
    }

    it('migrations v26/v27 add all five columns to a real database', () => {
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(27)
      const columns = (
        db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>
      ).map((c) => c.name)
      expect(columns).toContain('remote') // v26
      expect(columns).toContain('remote_branch')
      expect(columns).toContain('pr_base')
      expect(columns).toContain('previously_pushed_as')
      expect(columns).toContain('base_may_be_behind') // v27

      // Additive: a thread created after the migrations starts unbound, and
      // nothing was cut, so nothing was cut from a stale base.
      const thread = store.createThread({ projectRoot: ROOT_A })
      expect(thread).toMatchObject({
        remote: null,
        remoteBranch: null,
        prBase: null,
        previouslyPushedAs: null,
        baseMayBeBehind: false,
      })
      expect(store.getThread(thread.id)).toEqual(thread)
    })

    it('writes the mirror and announces it as a thread update', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      events = []

      store.setThreadBinding(thread.id, {
        remote: 'origin',
        remoteBranch: 'thread/fix-parser',
        prBase: 'main',
        previouslyPushedAs: null,
      })

      expect(store.getThread(thread.id)).toMatchObject({
        remote: 'origin',
        remoteBranch: 'thread/fix-parser',
        prBase: 'main',
        previouslyPushedAs: null,
      })
      expect(events).toEqual([
        { entity: 'thread', action: 'updated', threadId: thread.id },
      ])
    })

    it('null unbinds the thread completely and announces that too', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.setThreadBinding(thread.id, {
        remote: 'origin',
        remoteBranch: 'thread/fix-parser',
        prBase: 'main',
        previouslyPushedAs: 'thread/old-name',
      })
      events = []

      store.setThreadBinding(thread.id, null)

      expect(rawBindingRow(thread.id)).toMatchObject({
        remote: null,
        remote_branch: null,
        pr_base: null,
        previously_pushed_as: null,
      })
      expect(events).toEqual([
        { entity: 'thread', action: 'updated', threadId: thread.id },
      ])
    })

    // The record of a rename is written once, by the rename; every later write
    // (retargeting a PR base, re-reading git's config) omits the field and must
    // leave it standing. Only an explicit null — "this thread was never pushed
    // under another name" — may erase it.
    it('keeps previouslyPushedAs when the field is omitted, clears it when null', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.setThreadBinding(thread.id, {
        remote: 'origin',
        remoteBranch: 'thread/new-name',
        prBase: 'main',
        previouslyPushedAs: 'thread/old-name',
      })

      // A later edit of the PR base says nothing about the rename.
      store.setThreadBinding(thread.id, {
        remote: 'origin',
        remoteBranch: 'thread/new-name',
        prBase: 'release/2.0',
      })
      expect(store.getThread(thread.id)).toMatchObject({
        prBase: 'release/2.0',
        previouslyPushedAs: 'thread/old-name',
      })

      store.setThreadBinding(thread.id, {
        remote: 'origin',
        remoteBranch: 'thread/new-name',
        prBase: 'release/2.0',
        previouslyPushedAs: null,
      })
      expect(store.getThread(thread.id)?.previouslyPushedAs).toBeNull()
    })

    // Clearing the checkout clears the binding: the local branch the mirror was
    // keyed on went with it, so a surviving mirror would report a remote target
    // for work that has nowhere left to push from. Nothing on the remote moves.
    it('clearing the worktree clears the binding and the freshness flag', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.setThreadWorktree(thread.id, {
        path: '/tmp/worktree-a',
        branch: 'thread/fix-parser',
        base: 'main',
        baseMayBeBehind: true,
      })
      store.setThreadBinding(thread.id, {
        remote: 'origin',
        remoteBranch: 'thread/fix-parser',
        prBase: 'main',
        previouslyPushedAs: 'thread/old-name',
      })
      expect(store.getThread(thread.id)?.baseMayBeBehind).toBe(true)

      store.setThreadWorktree(thread.id, null)

      expect(store.getThread(thread.id)).toMatchObject({
        worktreePath: null,
        worktreeBranch: null,
        worktreeBase: null,
        remote: null,
        remoteBranch: null,
        prBase: null,
        previouslyPushedAs: null,
        baseMayBeBehind: false,
      })
      expect(rawBindingRow(thread.id).base_may_be_behind).toBeNull()
    })

    // Only the caller that just cut a checkout knows whether its base was
    // refreshed first. A caller that merely renames a branch or retargets the
    // record omits the flag, and must not silently retract a warning still true.
    it('leaves baseMayBeBehind alone when a later setThreadWorktree omits it', () => {
      const thread = store.createThread({ projectRoot: ROOT_A })
      store.setThreadWorktree(thread.id, {
        path: '/tmp/worktree-a',
        branch: 'thread/fix-parser',
        base: 'main',
        baseMayBeBehind: true,
      })

      store.setThreadWorktree(thread.id, {
        path: '/tmp/worktree-a',
        branch: 'thread/renamed',
        base: 'main',
      })

      expect(store.getThread(thread.id)).toMatchObject({
        worktreeBranch: 'thread/renamed',
        baseMayBeBehind: true,
      })

      // …and an explicit false is still an answer: it clears the warning.
      store.setThreadWorktree(thread.id, {
        path: '/tmp/worktree-a',
        branch: 'thread/renamed',
        base: 'main',
        baseMayBeBehind: false,
      })
      expect(store.getThread(thread.id)?.baseMayBeBehind).toBe(false)
    })

    // Whatever an imported Claude Code session pushed, it pushed from the
    // user's own checkout with the user's own git config — inferring a binding
    // from a transcript would be a guess wearing a record's clothes.
    it('imports arrive unbound, with every new column null', () => {
      const thread = store.importThread({
        projectRoot: ROOT_A,
        title: 'Imported',
        sdkSessionId: 'sess-binding',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        importedAt: '2026-08-01T00:00:00.000Z',
        messages: [],
      })

      expect(thread).toMatchObject({
        remote: null,
        remoteBranch: null,
        prBase: null,
        previouslyPushedAs: null,
        baseMayBeBehind: false,
      })
      expect(rawBindingRow(thread.id)).toEqual({
        remote: null,
        remote_branch: null,
        pr_base: null,
        previously_pushed_as: null,
        base_may_be_behind: null,
      })
      expect(store.getThread(thread.id)).toEqual(thread)
    })
  })
})

describe('listMessages — bounded reads for a windowed view', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-msg-limit-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns the NEWEST n, still oldest-first', () => {
    // The pane mounts a window at the bottom of the transcript, so a bounded
    // read has to be the END of it — measured: one real thread is 1,260
    // messages and 2.74 MB, shipped whole to render 200 of them.
    const thread = store.createThread({ projectRoot: ROOT_A })
    for (let i = 0; i < 25; i += 1) {
      store.appendMessage(thread.id, 'user', `m${String(i)}`)
    }
    const all = store.listMessages(thread.id)
    expect(all).toHaveLength(25)
    const tail = store.listMessages(thread.id, { limit: 5 })
    expect(tail.map((m) => m.content)).toEqual(['m20', 'm21', 'm22', 'm23', 'm24'])
  })

  it('treats a missing or zero limit as "everything"', () => {
    const thread = store.createThread({ projectRoot: ROOT_A })
    store.appendMessage(thread.id, 'user', 'only')
    expect(store.listMessages(thread.id, {})).toHaveLength(1)
    expect(store.listMessages(thread.id, { limit: 0 })).toHaveLength(1)
  })

  it('counts what a bounded read cannot say', () => {
    const thread = store.createThread({ projectRoot: ROOT_A })
    for (let i = 0; i < 7; i += 1) {
      store.appendMessage(thread.id, 'user', String(i))
    }
    expect(store.countMessages(thread.id)).toBe(7)
    expect(store.countMessages('nope')).toBe(0)
  })
})
/**
 * The bound belongs in the QUERY.
 *
 * Measured on a 600-call thread (20% writes, 8 KB outputs): reading every row
 * to hand back the newest sixty materialized 6.51 MB in the main process for an
 * 815 KB answer — on every thread open and every turn's reconcile. The answer
 * must not change; only what it costs to produce.
 */
describe('listToolCalls with an output limit', () => {
  let dir: string
  let db: FlowDatabase
  let store: ThreadStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-toolcall-bound-'))
    db = openDatabase(join(dir, 'flow.sqlite'))
    store = new ThreadStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function seed(store: ThreadStore, threadId: string, count: number): string[] {
    const ids: string[] = []
    for (let i = 0; i < count; i += 1) {
      const call = store.recordToolCall({ threadId, toolName: 'Read', inputJson: '{"i":1}' })
      // One call in three never produced an output at all.
      if (i % 3 !== 0) {
        store.updateToolCall(call.id, { status: 'success', outputJson: `out-${String(i)}` })
      }
      ids.push(call.id)
    }
    return ids
  }

  it('keeps the newest outputs and marks the rest withheld', () => {
    const thread = store.createThread({ projectRoot: '/repo' })
    seed(store, thread.id, 10)
    const everything = store.listToolCalls(thread.id)
    const calls = store.listToolCalls(thread.id, { outputLimit: 3 })

    expect(calls).toHaveLength(10)
    // Oldest first, unchanged — the window the renderer mounts is the tail, so
    // the tail is what keeps its outputs, whole.
    expect(calls.slice(-3).map((c) => c.outputJson)).toEqual(
      everything.slice(-3).map((c) => c.outputJson),
    )
    expect(calls.slice(-3).every((c) => c.outputWithheld === undefined)).toBe(true)
    // …and nothing older kept one.
    expect(calls.slice(0, -3).every((c) => c.outputJson === null)).toBe(true)
  })

  it('never says withheld about a call that produced nothing', () => {
    // "Empty" and "not sent" are different facts, and a card that shows the
    // second as the first is the app lying about what it stored (pattern #18).
    const thread = store.createThread({ projectRoot: '/repo' })
    seed(store, thread.id, 9)
    const everything = store.listToolCalls(thread.id)
    const calls = store.listToolCalls(thread.id, { outputLimit: 2 })
    const producedNothing = new Set(
      everything.filter((c) => c.outputJson === null).map((c) => c.id),
    )
    const never = calls.filter((c) => producedNothing.has(c.id))
    expect(never.length).toBeGreaterThan(0)
    expect(never.every((c) => c.outputWithheld === undefined && c.outputJson === null)).toBe(true)
    const withheld = calls.filter((c) => c.outputWithheld === true)
    expect(withheld.length).toBeGreaterThan(0)
    expect(withheld.every((c) => c.outputJson === null)).toBe(true)
  })

  it('returns everything when no bound is asked for', () => {
    // Exporters, the import path and the transcript builder all need the lot.
    const thread = store.createThread({ projectRoot: '/repo' })
    seed(store, thread.id, 5)
    const all = store.listToolCalls(thread.id)
    expect(all.filter((c) => c.outputJson !== null)).toHaveLength(3)
    expect(all.some((c) => c.outputWithheld === true)).toBe(false)
    expect(store.listToolCalls(thread.id, { outputLimit: 0 })).toEqual(all)
  })

  it('reads only the window a caller says it will show', () => {
    // The pane mounts a couple of hundred entries; the rows for turns nobody is
    // looking at were shipped anyway — 1.19 MB of metadata on an 1,800-call
    // thread, on every open and every turn's reconcile.
    const thread = store.createThread({ projectRoot: '/repo' })
    seed(store, thread.id, 10)
    // Distinct timestamps: ten calls recorded in one millisecond all sit at the
    // same instant, and a time window over them is not a window at all.
    const ids = store.listToolCalls(thread.id).map((call) => call.id)
    ids.forEach((id, index) => {
      db.prepare('UPDATE tool_calls SET started_at = ? WHERE id = ?').run(
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        id,
      )
    })
    const all = store.listToolCalls(thread.id)
    const cutoff = all[6]?.startedAt
    expect(cutoff).toBeDefined()
    const windowed = store.listToolCalls(thread.id, { outputLimit: 2, since: cutoff })
    // Inclusive: a call starting in the same millisecond as the window's oldest
    // message is INSIDE the window, not just before it.
    expect(windowed.every((call) => call.startedAt >= (cutoff ?? ''))).toBe(true)
    expect(windowed.length).toBeLessThan(all.length)
    expect(windowed.length).toBeGreaterThan(0)
  })

  it('keeps the newest calls even when every one predates the mounted messages', () => {
    // An agent-heavy turn runs hundreds of calls between two messages, so the
    // oldest MESSAGE a feed mounts can be newer than every call worth showing.
    // Bounding on the message timestamp alone made those cards vanish.
    const thread = store.createThread({ projectRoot: '/repo' })
    seed(store, thread.id, 10)
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(store.listToolCalls(thread.id, { outputLimit: 2, since: future })).toHaveLength(0)
    const withFloor = store.listToolCalls(thread.id, {
      outputLimit: 2,
      since: future,
      atLeast: 4,
    })
    expect(withFloor).toHaveLength(4)
    // The floor is the NEWEST four, and they arrive oldest-first like every
    // other read — the feed's order must not depend on how it was bounded.
    const all = store.listToolCalls(thread.id)
    expect(withFloor.map((call) => call.id)).toEqual(all.slice(-4).map((call) => call.id))
  })

  it('still spans the thread when no window is named', () => {
    const thread = store.createThread({ projectRoot: '/repo' })
    seed(store, thread.id, 6)
    expect(store.listToolCalls(thread.id, { outputLimit: 2 })).toHaveLength(6)
  })

  it('agrees, row for row, with reading everything and trimming afterwards', () => {
    const thread = store.createThread({ projectRoot: '/repo' })
    seed(store, thread.id, 12)
    const viaQuery = store.listToolCalls(thread.id, { outputLimit: 4 })
    const viaMemory = boundedToolCalls(store.listToolCalls(thread.id), 4)
    expect(viaQuery).toEqual(viaMemory)
  })
})


describe('threadIdsReviewing (#1906 — who a repo\'s commit concerns)', () => {
  let dir: string
  let database: FlowDatabase
  let threads: ThreadStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-reviewing-'))
    database = openDatabase(join(dir, 'flow.sqlite'))
    threads = new ThreadStore(database)
  })

  afterEach(() => {
    database.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers with the threads whose review actually READS the given repo', () => {
    // The fan-out asked `threadIdsForWorktree` alone, which was the whole story
    // while every thread got a copy of the project. After the worktree gate
    // made copies loops-only, a commit in a project reached NO thread — so an
    // open Changes tab went on saying "Uncommitted" over work that had just
    // been committed.
    //
    // The key is the repo the review READS, and each thread reads exactly one:
    // its own checkout when it has one, the project otherwise.
    const owner = threads.createThread({ projectRoot: ROOT_A })
    threads.setThreadWorktree(owner.id, { path: '/w/owner', branch: null, base: null })
    const inProject = threads.createThread({ projectRoot: ROOT_A })
    const elsewhere = threads.createThread({ projectRoot: ROOT_B })

    expect(threads.threadIdsReviewing(ROOT_A)).toEqual([inProject.id])
    expect(threads.threadIdsReviewing('/w/owner')).toEqual([owner.id])
    expect(threads.threadIdsReviewing(ROOT_B)).toEqual([elsewhere.id])
  })

  it('does NOT claim a thread that has its own copy for its project\'s commits', () => {
    // Its review reads the checkout, so a commit in the project it was cut
    // from changes nothing it is showing.
    const owner = threads.createThread({ projectRoot: ROOT_A })
    threads.setThreadWorktree(owner.id, { path: '/w/owner', branch: null, base: null })
    expect(threads.threadIdsReviewing(ROOT_A)).toEqual([])
  })

  it('reads a released checkout as back in the project', () => {
    const thread = threads.createThread({ projectRoot: ROOT_A })
    threads.setThreadWorktree(thread.id, { path: '/w/x', branch: null, base: null })
    threads.setThreadWorktree(thread.id, null)
    expect(threads.threadIdsReviewing(ROOT_A)).toEqual([thread.id])
  })
})
