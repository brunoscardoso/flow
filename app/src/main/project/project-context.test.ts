// ProjectContextManager tests — real better-sqlite3 (Electron ABI), fresh
// temp-dir DB per test.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import {
  ProjectContextManager,
  ACTIVE_PROJECT_CHANGED_EVENT,
} from './project-context'
import type { ProjectContext } from '../../shared/ipc-contract'

const ROOT_A = '/tmp/project-a'
const ROOT_B = '/tmp/project-b'

describe('ProjectContextManager', () => {
  let tempDir: string
  let db: FlowDatabase
  let ctx: ProjectContextManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-project-ctx-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    ctx = new ProjectContextManager(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('starts with no active project', () => {
    expect(ctx.getActiveProject()).toBeNull()
    expect(ctx.activeRoot()).toBeNull()
  })

  it('setActiveProject creates a row, emits, and returns an empty context', () => {
    const events: ProjectContext[] = []
    ctx.on(ACTIVE_PROJECT_CHANGED_EVENT, (c: ProjectContext) => events.push(c))

    const result = ctx.setActiveProject(ROOT_A)

    expect(result).toEqual({
      rootPath: ROOT_A,
      openFiles: [],
      activeFile: null,
      activeThreadId: null,
      dirtyBuffers: {},
    })
    expect(ctx.activeRoot()).toBe(ROOT_A)
    expect(events).toHaveLength(1)
    expect(events[0].rootPath).toBe(ROOT_A)
  })

  it('persists and restores open files + active file + active thread', () => {
    ctx.setActiveProject(ROOT_A)
    ctx.saveOpenFiles(
      ROOT_A,
      [
        { rootPath: ROOT_A, relPath: 'src/a.ts' },
        { rootPath: ROOT_A, relPath: 'src/b.ts' },
      ],
      'src/b.ts',
      {},
    )
    ctx.setActiveThread(ROOT_A, 'thread-1')

    // Simulate switching away and back.
    ctx.setActiveProject(ROOT_B)
    const restored = ctx.setActiveProject(ROOT_A)

    expect(restored.openFiles.map((f) => f.relPath)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(restored.activeFile).toBe('src/b.ts')
    expect(restored.activeThreadId).toBe('thread-1')
  })

  it('round-trips unsaved buffer contents across a switch (#955)', () => {
    ctx.setActiveProject(ROOT_A)
    const unsaved = `${ROOT_A}/src/a.ts`
    ctx.saveOpenFiles(ROOT_A, [{ rootPath: ROOT_A, relPath: 'src/a.ts' }], 'src/a.ts', {
      [unsaved]: 'export const PRECIOUS = "unsaved"\n',
    })

    ctx.setActiveProject(ROOT_B)
    const restored = ctx.setActiveProject(ROOT_A)

    expect(restored.dirtyBuffers).toEqual({ [unsaved]: 'export const PRECIOUS = "unsaved"\n' })
    // The other project never inherits them.
    expect(ctx.setActiveProject(ROOT_B).dirtyBuffers).toEqual({})
  })

  it('tolerates malformed persisted dirty_buffers (falls back to {})', () => {
    ctx.setActiveProject(ROOT_A)
    db.prepare('UPDATE workspace_state SET dirty_buffers = ? WHERE project_root = ?').run(
      'not-json',
      ROOT_A,
    )
    expect(ctx.setActiveProject(ROOT_A).dirtyBuffers).toEqual({})
  })

  it('lastActiveProject returns the most recently activated root', async () => {
    ctx.setActiveProject(ROOT_A)
    await new Promise((r) => setTimeout(r, 10))
    ctx.setActiveProject(ROOT_B)
    expect(ctx.lastActiveProject()).toBe(ROOT_B)
    await new Promise((r) => setTimeout(r, 10))
    ctx.setActiveProject(ROOT_A)
    expect(ctx.lastActiveProject()).toBe(ROOT_A)
  })

  it('round-trips open terminals', () => {
    ctx.setActiveProject(ROOT_A)
    ctx.saveScopeTerminals(ROOT_A, null, [{ title: 'zsh', cwd: ROOT_A }])
    expect(ctx.loadScopeTerminals(ROOT_A, null)).toEqual([{ title: 'zsh', cwd: ROOT_A }])
  })

  it('forget clears persisted state and deactivates', () => {
    ctx.setActiveProject(ROOT_A)
    ctx.saveOpenFiles(ROOT_A, [{ rootPath: ROOT_A, relPath: 'x.ts' }], 'x.ts', {})
    ctx.forget(ROOT_A)
    expect(ctx.activeRoot()).toBeNull()
    expect(ctx.lastActiveProject()).toBeNull()
  })

  it('forget on the ACTIVE root broadcasts a null context so surfaces reset (#323)', () => {
    const events: (ProjectContext | null)[] = []
    ctx.setActiveProject(ROOT_A)
    ctx.on(ACTIVE_PROJECT_CHANGED_EVENT, (c: ProjectContext | null) => events.push(c))

    ctx.forget(ROOT_A) // removing the last/active project

    expect(events).toEqual([null]) // exactly one null broadcast
    expect(ctx.activeRoot()).toBeNull()
  })

  it('forget on a NON-active root does not broadcast (a sibling stays active)', () => {
    const events: (ProjectContext | null)[] = []
    ctx.setActiveProject(ROOT_A)
    ctx.setActiveProject(ROOT_B) // B is active; A is a background sibling
    ctx.on(ACTIVE_PROJECT_CHANGED_EVENT, (c: ProjectContext | null) => events.push(c))

    ctx.forget(ROOT_A) // remove the non-active sibling

    expect(events).toEqual([]) // no broadcast — B is still active
    expect(ctx.activeRoot()).toBe(ROOT_B)
  })
})

// #1080 — `last_active_at` is a *last-activated* stamp, but #ensureRow let any
// state-persisting call INSERT a row for an arbitrary path. Removing the active
// project raced exactly that: forget(A) deleted A's row, then the renderer's
// outgoing-tab persist re-created it ~50ms later with last_active_at = now,
// making the REMOVED project the newest row forever. Every later boot then
// resolved lastActiveProject() to a non-root and activated nothing.
describe('ProjectContextManager — state rows only for known roots (#1080)', () => {
  let tempDir: string
  let db: FlowDatabase
  let ctx: ProjectContextManager
  let knownRoots: Set<string>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-project-ctx-known-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    ctx = new ProjectContextManager(db)
    knownRoots = new Set([ROOT_A, ROOT_B])
    ctx.setKnownRootCheck((rootPath) => knownRoots.has(rootPath))
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  const stateRows = (): string[] =>
    (
      db
        .prepare('SELECT project_root FROM workspace_state ORDER BY last_active_at ASC')
        .all() as Array<{ project_root: string }>
    ).map((row) => row.project_root)

  it('the removed project cannot resurrect its row through a late tab persist', () => {
    ctx.setActiveProject(ROOT_A)
    ctx.setActiveProject(ROOT_B)
    // …the user removes A: it stops being a root, then its context is forgotten.
    knownRoots.delete(ROOT_A)
    ctx.forget(ROOT_A)
    expect(stateRows()).toEqual([ROOT_B])

    // The renderer's outgoing-project persist lands AFTER forget (the race).
    ctx.saveOpenFiles(ROOT_A, [{ rootPath: ROOT_A, relPath: 'x.ts' }], 'x.ts', {})
    ctx.saveScopeTerminals(ROOT_A, null, [{ title: 'zsh', cwd: ROOT_A }])
    ctx.setActiveThread(ROOT_A, 'thread-1')

    expect(stateRows()).toEqual([ROOT_B])
    // …so the next boot resolves the SURVIVOR, not the removed project.
    expect(ctx.lastActiveProject()).toBe(ROOT_B)
  })

  it('still persists state for a root that is still a root', () => {
    ctx.setActiveProject(ROOT_A)
    ctx.saveOpenFiles(ROOT_A, [{ rootPath: ROOT_A, relPath: 'keep.ts' }], 'keep.ts', {})
    expect(ctx.getActiveProject()?.openFiles).toEqual([{ rootPath: ROOT_A, relPath: 'keep.ts' }])
    ctx.saveScopeTerminals(ROOT_A, null, [{ title: 'zsh', cwd: ROOT_A }])
    expect(ctx.loadScopeTerminals(ROOT_A, null)).toEqual([{ title: 'zsh', cwd: ROOT_A }])
  })

  it('unwired (no predicate) behaves exactly as before — every path is accepted', () => {
    const open = new ProjectContextManager(db)
    open.saveScopeTerminals('/some/unknown/path', null, [{ title: 'zsh', cwd: '/some/unknown/path' }])
    expect(open.loadScopeTerminals('/some/unknown/path', null)).toHaveLength(1)
  })
})

// A CHECKOUT THAT MOVED LEAVES ITS TABS BEHIND, and every activation of the
// project restored them — one `Unknown root` throw per tab, on every switch,
// for the life of the row (user, 2026-09-18, after the rename moved 21
// directories). The address gate is the authority on what can be opened, so it
// is the authority on what comes back.
describe('tabs whose root can no longer be addressed', () => {
  let tempDir: string
  let db: ReturnType<typeof openDatabase>
  let ctx: ProjectContextManager
  let addressable: Set<string>

  const GONE = '/repos/.orbit-core-threads/e2265b48-03e9-43e3-8f76-ff887a48615e'
  const LIVE = '/repos/.orbit-core-threads/worktree/data-contract-guard'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-project-ctx-gone-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    ctx = new ProjectContextManager(db)
    addressable = new Set([ROOT_A, LIVE])
    ctx.setAddressableCheck((rootPath) => addressable.has(rootPath))
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('hands back only the tabs the renderer could actually open', () => {
    ctx.setActiveProject(ROOT_A)
    ctx.saveOpenFiles(
      ROOT_A,
      [
        { rootPath: ROOT_A, relPath: 'README.md' },
        { rootPath: LIVE, relPath: 'src/a.ts' },
        { rootPath: GONE, relPath: 'flow/discovery/d.md' },
      ],
      'README.md',
      {},
    )
    const context = ctx.getActiveProject()
    // THE POSITIVE FIRST: the openable tabs ARE returned, so an empty list
    // cannot make this pass (allowed-pattern #28).
    expect(context?.openFiles.map((tab) => tab.relPath)).toEqual(['README.md', 'src/a.ts'])
  })

  it('keeps an untitled scratch note, which has no root to lose (#1441)', () => {
    ctx.setActiveProject(ROOT_A)
    ctx.saveOpenFiles(
      ROOT_A,
      [{ rootPath: GONE, relPath: 'Untitled-3', untitled: true }],
      null,
      {},
    )
    expect(ctx.getActiveProject()?.openFiles).toHaveLength(1)
  })

  it('accepts everything while the gate is unwired — the old behaviour exactly', () => {
    ctx.setAddressableCheck(null)
    ctx.setActiveProject(ROOT_A)
    ctx.saveOpenFiles(ROOT_A, [{ rootPath: GONE, relPath: 'a.ts' }], 'a.ts', {})
    expect(ctx.getActiveProject()?.openFiles).toHaveLength(1)
  })
})
