// Per-(project, thread) tab sets — real better-sqlite3 (Electron ABI), fresh
// temp-dir DB per test. Run with `node scripts/run-jest.mjs <this file>`.

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { TabSet } from '../../shared/ipc-contract'
import { ProjectContextManager } from '../project/project-context'
import { migrate, openDatabase, type FlowDatabase } from './db'
import { MIGRATIONS } from './migrations'
import { TabSetStore } from './tab-set-store'
import { ThreadStore } from './thread-store'

const ROOT = '/tmp/project-a'
const OTHER = '/tmp/project-b'

function setWith(relPath: string, extra: Partial<TabSet> = {}): TabSet {
  return {
    openFiles: [{ rootPath: ROOT, relPath, active: true }],
    activeFile: relPath,
    dirtyBuffers: {},
    openViews: [],
    ...extra,
  }
}

describe('TabSetStore', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: TabSetStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-tab-sets-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new TabSetStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('round-trips a set per (project, thread), keeping each conversation apart', () => {
    const forA = setWith('a.ts', {
      dirtyBuffers: { [`${ROOT}/a.ts`]: 'typed' },
      openViews: [{ kind: 'feature-view', state: { slug: 'pay', path: 'flow/discovery/x.walkthrough.html' }, active: true }],
    })
    store.save(ROOT, 'thread-a', forA)
    store.save(ROOT, 'thread-b', setWith('b.ts'))

    expect(store.load(ROOT, 'thread-a')).toEqual(forA)
    expect(store.load(ROOT, 'thread-b')?.openFiles.map((ref) => ref.relPath)).toEqual(['b.ts'])
    // Nothing was saved for the project level or another project.
    expect(store.load(ROOT, null)).toBeNull()
    expect(store.load(OTHER, 'thread-a')).toBeNull()
  })

  it('keeps the project-level set (no thread) as its own row', () => {
    store.save(ROOT, null, setWith('project.ts'))
    store.save(ROOT, 'thread-a', setWith('thread.ts'))
    expect(store.load(ROOT, null)?.openFiles.map((ref) => ref.relPath)).toEqual(['project.ts'])
    expect(store.load(ROOT, 'thread-a')?.openFiles.map((ref) => ref.relPath)).toEqual(['thread.ts'])
  })

  it('replaces a set on save rather than appending to it', () => {
    store.save(ROOT, 'thread-a', setWith('first.ts'))
    store.save(ROOT, 'thread-a', setWith('second.ts'))
    expect(store.load(ROOT, 'thread-a')?.openFiles.map((ref) => ref.relPath)).toEqual(['second.ts'])
  })

  it('drops a thread’s sets in every project, and nothing else', () => {
    store.save(ROOT, 'thread-a', setWith('a.ts'))
    store.save(OTHER, 'thread-a', setWith('a2.ts'))
    store.save(ROOT, 'thread-b', setWith('b.ts'))
    store.save(ROOT, null, setWith('p.ts'))

    store.deleteThread('thread-a')

    expect(store.load(ROOT, 'thread-a')).toBeNull()
    expect(store.load(OTHER, 'thread-a')).toBeNull()
    expect(store.load(ROOT, 'thread-b')).not.toBeNull()
    expect(store.load(ROOT, null)).not.toBeNull()
  })

  it('drops every set of a removed project', () => {
    store.save(ROOT, 'thread-a', setWith('a.ts'))
    store.save(ROOT, null, setWith('p.ts'))
    store.save(OTHER, null, setWith('o.ts'))
    store.deleteRoot(ROOT)
    expect(store.load(ROOT, 'thread-a')).toBeNull()
    expect(store.load(ROOT, null)).toBeNull()
    expect(store.load(OTHER, null)).not.toBeNull()
  })

  it('moves tabs and buffers that address a renamed checkout', () => {
    const checkout = '/tmp/.project-a-threads/old'
    store.save(ROOT, 'thread-a', {
      openFiles: [{ rootPath: checkout, relPath: 'src/x.ts' }],
      activeFile: null,
      dirtyBuffers: { [`${checkout}/src/x.ts`]: 'typed' },
      openViews: [],
    })
    store.repoint(checkout, '/tmp/.project-a-threads/new')
    const moved = store.load(ROOT, 'thread-a')
    expect(moved?.openFiles[0]?.rootPath).toBe('/tmp/.project-a-threads/new')
    expect(moved?.dirtyBuffers).toEqual({ '/tmp/.project-a-threads/new/src/x.ts': 'typed' })
  })

  it('drops a thread’s set when the thread itself is deleted', () => {
    const threads = new ThreadStore(db)
    const thread = threads.createThread({ projectRoot: ROOT })
    const kept = threads.createThread({ projectRoot: ROOT })
    store.save(ROOT, thread.id, setWith('gone.ts'))
    store.save(ROOT, kept.id, setWith('kept.ts'))
    // Positive first (allowed-pattern #28): the set is there before the delete.
    expect(store.load(ROOT, thread.id)).not.toBeNull()

    threads.deleteThread(thread.id)

    expect(store.load(ROOT, thread.id)).toBeNull()
    expect(store.load(ROOT, kept.id)).not.toBeNull()
  })

  it('moves a deleted thread’s unsaved buffers into the project-level set', () => {
    const threads = new ThreadStore(db)
    const thread = threads.createThread({ projectRoot: ROOT })
    store.save(ROOT, null, setWith('readme.md', { dirtyBuffers: {} }))
    store.save(ROOT, thread.id, {
      openFiles: [
        { rootPath: ROOT, relPath: 'src/a.ts', active: true },
        { rootPath: ROOT, relPath: 'Untitled-1', untitled: true },
        { rootPath: ROOT, relPath: 'clean.ts' },
      ],
      activeFile: 'src/a.ts',
      dirtyBuffers: { [`${ROOT}/src/a.ts`]: 'typed, never saved', 'untitled:1': 'a note' },
      openViews: [],
    })
    // Positive first: the thread's set holds the unsaved text before the delete.
    expect(Object.keys(store.load(ROOT, thread.id)?.dirtyBuffers ?? {})).toHaveLength(2)

    threads.deleteThread(thread.id)

    expect(store.load(ROOT, thread.id)).toBeNull()
    const project = store.load(ROOT, null)
    expect(project?.dirtyBuffers).toEqual({
      [`${ROOT}/src/a.ts`]: 'typed, never saved',
      'untitled:1': 'a note',
    })
    expect(project?.openFiles.map((ref) => ref.relPath)).toEqual(['readme.md', 'src/a.ts', 'Untitled-1'])
    // The project's own active tab is left alone.
    expect(project?.activeFile).toBe('readme.md')
  })
})

describe('ProjectContextManager tab sets', () => {
  let tempDir: string
  let db: FlowDatabase
  let ctx: ProjectContextManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-tab-sets-ctx-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    ctx = new ProjectContextManager(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('answers the empty set for a conversation nobody saved tabs for', () => {
    expect(ctx.loadTabSet(ROOT, 'thread-a')).toEqual({
      openFiles: [],
      activeFile: null,
      dirtyBuffers: {},
      openViews: [],
    })
  })

  it('the project context reads the PROJECT-LEVEL set, not a thread’s', () => {
    ctx.setActiveProject(ROOT)
    ctx.saveTabSet(ROOT, null, setWith('project.ts'))
    ctx.saveTabSet(ROOT, 'thread-a', setWith('thread.ts'))
    expect(ctx.getActiveProject()?.openFiles.map((ref) => ref.relPath)).toEqual(['project.ts'])
  })

  it('saveOpenFiles writes the project-level set and keeps its views', () => {
    const view = { kind: 'blueprint', state: { doc: null } }
    ctx.saveTabSet(ROOT, null, setWith('old.ts', { openViews: [view] }))
    ctx.saveOpenFiles(ROOT, [{ rootPath: ROOT, relPath: 'new.ts' }], 'new.ts', {})
    const set = ctx.loadTabSet(ROOT, null)
    expect(set.openFiles.map((ref) => ref.relPath)).toEqual(['new.ts'])
    expect(set.openViews).toEqual([view])
  })

  it('refuses to write a set for a thread that no longer exists', () => {
    const known = new Set(['thread-a'])
    ctx.setKnownThreadCheck((id) => known.has(id))
    ctx.saveTabSet(ROOT, 'thread-a', setWith('a.ts'))
    ctx.saveTabSet(ROOT, 'deleted', setWith('ghost.ts'))
    // Positive first: the known thread's write landed.
    expect(ctx.loadTabSet(ROOT, 'thread-a').openFiles).toHaveLength(1)
    expect(ctx.loadTabSet(ROOT, 'deleted').openFiles).toEqual([])
  })

  it('a refused late save of a deleted thread still keeps its unsaved text, in the project set', () => {
    ctx.setKnownThreadCheck(() => false)
    ctx.saveTabSet(ROOT, 'deleted', setWith('a.ts', { dirtyBuffers: { [`${ROOT}/a.ts`]: 'typed after the delete' } }))
    expect(ctx.loadTabSet(ROOT, 'deleted').openFiles).toEqual([])
    expect(ctx.loadTabSet(ROOT, null).dirtyBuffers).toEqual({ [`${ROOT}/a.ts`]: 'typed after the delete' })
  })

  it('refuses to write a set for a path that is no longer a project', () => {
    ctx.setKnownRootCheck((root) => root === ROOT)
    ctx.saveTabSet(ROOT, 'thread-a', setWith('a.ts'))
    ctx.saveTabSet(OTHER, 'thread-a', setWith('o.ts'))
    expect(ctx.loadTabSet(ROOT, 'thread-a').openFiles).toHaveLength(1)
    expect(ctx.loadTabSet(OTHER, 'thread-a').openFiles).toEqual([])
  })

  it('hands out only tabs whose root can still be opened', () => {
    ctx.setAddressableCheck((root) => root === ROOT)
    ctx.saveTabSet(ROOT, 'thread-a', {
      openFiles: [
        { rootPath: ROOT, relPath: 'ok.ts' },
        { rootPath: '/gone', relPath: 'lost.ts' },
        { rootPath: '/gone', relPath: 'Untitled-1', untitled: true },
      ],
      activeFile: null,
      dirtyBuffers: {},
      openViews: [],
    })
    expect(ctx.loadTabSet(ROOT, 'thread-a').openFiles.map((ref) => ref.relPath)).toEqual([
      'ok.ts',
      'Untitled-1',
    ])
  })

  it('forgetting a project drops all of its sets', () => {
    ctx.saveTabSet(ROOT, 'thread-a', setWith('a.ts'))
    ctx.saveTabSet(ROOT, null, setWith('p.ts'))
    ctx.forget(ROOT)
    expect(ctx.loadTabSet(ROOT, 'thread-a').openFiles).toEqual([])
    expect(ctx.loadTabSet(ROOT, null).openFiles).toEqual([])
  })
})

describe('migration v34 — saved tabs become the project-level set', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-tab-sets-mig-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('copies every project’s tabs into its project-level row, threads start empty, and is idempotent', () => {
    const dbPath = join(tempDir, 'flow.sqlite')
    const before = new Database(dbPath)
    migrate(before, MIGRATIONS.filter((migration) => migration.version <= 33))
    const openFiles = JSON.stringify([{ rootPath: ROOT, relPath: 'src/a.ts', active: true }])
    const dirty = JSON.stringify({ [`${ROOT}/src/a.ts`]: 'typed' })
    before
      .prepare(
        `INSERT INTO workspace_state (project_root, open_files, active_file, active_thread_id, last_active_at, dirty_buffers)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ROOT, openFiles, 'src/a.ts', 'thread-a', '2026-09-30T00:00:00.000Z', dirty)
    before
      .prepare('INSERT INTO workspace_state (project_root, last_active_at) VALUES (?, ?)')
      .run(OTHER, '2026-09-29T00:00:00.000Z')
    before.close()

    const db = openDatabase(dbPath)
    try {
      const store = new TabSetStore(db)
      expect(store.load(ROOT, null)).toEqual({
        openFiles: [{ rootPath: ROOT, relPath: 'src/a.ts', active: true }],
        activeFile: 'src/a.ts',
        dirtyBuffers: { [`${ROOT}/src/a.ts`]: 'typed' },
        openViews: [],
      })
      // A project with no saved tabs still gets an (empty) project-level row.
      expect(store.load(OTHER, null)?.openFiles).toEqual([])
      // The thread that was active starts with nothing of its own.
      expect(store.load(ROOT, 'thread-a')).toBeNull()

      // Re-running the migration's SQL over a row the user has since changed
      // leaves the user's row alone.
      store.save(ROOT, null, setWith('changed.ts'))
      const v34 = MIGRATIONS.find((migration) => migration.version === 34)
      if (v34 === undefined || typeof v34.up !== 'string') throw new Error('v34 missing')
      db.exec(v34.up)
      expect(store.load(ROOT, null)?.openFiles.map((ref) => ref.relPath)).toEqual(['changed.ts'])
    } finally {
      db.close()
    }
  })
})
