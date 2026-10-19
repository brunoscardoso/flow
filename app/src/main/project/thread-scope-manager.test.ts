// ThreadScopeManager tests — real ProjectContextManager + ThreadStore over a
// fresh temp-dir better-sqlite3 DB (Electron ABI — `node scripts/run-jest.mjs`),
// exercising every re-derivation trigger end-to-end. The project root list is
// a fake emitter (the real one watches the filesystem with chokidar).

import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ThreadScope } from '../../shared/ipc-contract'
import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore } from '../store/thread-store'
import { ProjectContextManager } from './project-context'
import type { ScopeProjectRoot } from './thread-scope'
import {
  ThreadScopeManager,
  THREAD_SCOPE_CHANGED_EVENT,
} from './thread-scope-manager'
import { PROJECT_LIST_CHANGED_EVENT } from './project-registry'

const ROOT_A = '/tmp/scope-project-a'
const ROOT_B = '/tmp/scope-project-b'
// A thread's worktree sits BESIDE its project, in the CLI's `.{repo}-threads`
// directory, and is never itself a registered project root.
const WORKTREE_A = '/tmp/.scope-project-a-threads/thread-slug'

class FakeProjectList extends EventEmitter {
  #roots: ScopeProjectRoot[] = []

  getRoots(): ScopeProjectRoot[] {
    return this.#roots
  }

  setRoots(roots: ScopeProjectRoot[]): void {
    this.#roots = roots
    this.emit(PROJECT_LIST_CHANGED_EVENT, this.#roots)
  }
}

describe('ThreadScopeManager', () => {
  let tempDir: string
  let db: FlowDatabase
  let projectContext: ProjectContextManager
  let threadStore: ThreadStore
  let projects: FakeProjectList
  let manager: ThreadScopeManager
  let emitted: ThreadScope[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-thread-scope-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    projectContext = new ProjectContextManager(db)
    threadStore = new ThreadStore(db)
    projects = new FakeProjectList()
    projects.setRoots([
      { id: 'id-a', rootPath: ROOT_A, available: true },
      { id: 'id-b', rootPath: ROOT_B, available: true },
    ])
    manager = new ThreadScopeManager({ projectContext, threadStore, projectRegistry: projects })
    emitted = []
    manager.on(THREAD_SCOPE_CHANGED_EVENT, (scope: ThreadScope) => emitted.push(scope))
  })

  afterEach(() => {
    manager.dispose()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('starts empty when no project is active', () => {
    manager.start()
    expect(manager.current()).toEqual({ threadId: null, roots: [] })
    expect(emitted).toHaveLength(0)
  })

  it('re-derives on active project change (single root, no active thread)', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)

    expect(emitted).toHaveLength(1)
    expect(manager.current()).toEqual({
      threadId: null,
      roots: [
        { rootId: 'id-a', rootPath: ROOT_A, name: 'scope-project-a', primary: true, available: true },
      ],
    })
  })

  it('re-derives on active thread change, including the thread extra roots', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    threadStore.setThreadRoots(thread.id, [ROOT_B])
    emitted = []

    projectContext.setActiveThread(ROOT_A, thread.id)

    expect(emitted).toHaveLength(1)
    expect(manager.current().threadId).toBe(thread.id)
    expect(manager.current().roots.map((entry) => entry.rootPath)).toEqual([ROOT_A, ROOT_B])
    expect(manager.current().roots[0].primary).toBe(true)
  })

  it('re-derives on thread_roots mutations of the ACTIVE thread', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    projectContext.setActiveThread(ROOT_A, thread.id)
    emitted = []

    threadStore.addThreadRoot(thread.id, ROOT_B)

    expect(emitted).toHaveLength(1)
    expect(manager.current().roots.map((entry) => entry.rootPath)).toEqual([ROOT_A, ROOT_B])
  })

  it('does NOT emit for a thread_roots change that leaves the scope unchanged', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const active = threadStore.createThread({ projectRoot: ROOT_A })
    projectContext.setActiveThread(ROOT_A, active.id)
    const other = threadStore.createThread({ projectRoot: ROOT_B })
    emitted = []

    threadStore.addThreadRoot(other.id, ROOT_A) // not the active thread

    expect(emitted).toHaveLength(0)
  })

  it('re-derives on root availability refresh (rootsChanged)', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    emitted = []

    projects.setRoots([{ id: 'id-a', rootPath: ROOT_A, available: false }])

    expect(emitted).toHaveLength(1)
    expect(manager.current().roots[0].available).toBe(false)
  })

  it('flags a thread root with no project record as rootId "" / unavailable', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    threadStore.addThreadRoot(thread.id, '/tmp/not-a-project-root')
    projectContext.setActiveThread(ROOT_A, thread.id)

    const entry = manager.current().roots[1]
    expect(entry.rootId).toBe('')
    expect(entry.available).toBe(false)
  })

  it('falls back to the single project root when the active thread is deleted', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    threadStore.addThreadRoot(thread.id, ROOT_B)
    projectContext.setActiveThread(ROOT_A, thread.id)
    emitted = []

    threadStore.deleteThread(thread.id)

    expect(emitted).toHaveLength(1)
    expect(manager.current()).toEqual({
      threadId: null,
      roots: [
        { rootId: 'id-a', rootPath: ROOT_A, name: 'scope-project-a', primary: true, available: true },
      ],
    })
  })

  // ── The thread's own checkout (thread worktrees) ──────────────────────────

  it("reports the thread's worktree as its primary root, not the project tree", () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    threadStore.setThreadWorktree(thread.id, { path: WORKTREE_A, branch: null, base: 'main' })
    projectContext.setActiveThread(ROOT_A, thread.id)

    const primary = manager.current().roots[0]
    expect(primary.rootPath).toBe(WORKTREE_A)
    expect(primary.primary).toBe(true)
    // Unavailable here would send the terminal's spawnRootFor to a sibling repo.
    expect(primary.available).toBe(true)
    // The worktree is a checkout OF the project — same accent, same identity.
    expect(primary.rootId).toBe('id-a')
    expect(manager.current().roots.map((entry) => entry.rootPath)).not.toContain(ROOT_A)
  })

  it('names a checkout by its PROJECT — the branch is on the panel above the tree', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    threadStore.setThreadWorktree(thread.id, {
      path: WORKTREE_A,
      branch: 'ACME-3575-ai-design-system-enforcement',
      base: 'main',
    })
    projectContext.setActiveThread(ROOT_A, thread.id)

    // FOUR ANSWERS CAME FIRST, and the last two were right in their moment. The
    // path's last segment is the thread id, so the header read a raw UUID;
    // shortening it to `orbit-app (b3fe4467)` only made the meaningless part
    // smaller ("what is this reference?"); the BRANCH in parentheses was the
    // first that meant something, and it was the only place a reader could see
    // they were isolated. Then the worktree panel moved directly above this
    // tree and said it — switch, state and branch — so the suffix went back to
    // explaining something the screen already draws, while eating the width the
    // project's own name needs (user, 2026-09-17: "we don't need it anymore
    // because the worktree is here on the same screen").
    const primary = manager.current().roots[0]
    expect(primary.name).toBe('scope-project-a')
    // Still a copy — said as a FACT, which is what the panel and the tree read.
    expect(primary.threadCopy).toBe(true)
    // Never a path, and never a thread id.
    expect(primary.name).not.toContain('/')
    expect(primary.name).not.toContain('thread-slug')
    expect(primary.name).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
  })

  it('says nothing extra when the checkout has no branch yet', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    // Cut detached and named later from the title — so there is no name, and a
    // parenthesis full of nothing is worse than none at all.
    threadStore.setThreadWorktree(thread.id, { path: WORKTREE_A, branch: null, base: 'main' })
    projectContext.setActiveThread(ROOT_A, thread.id)

    expect(manager.current().roots[0].name).toBe('scope-project-a')
  })

  it('leaves an ordinary project root named by its folder', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    expect(manager.current().roots[0].name).toBe('scope-project-a')
  })

  it('keeps the project root for a thread with no worktree (chat-only, unchanged)', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    projectContext.setActiveThread(ROOT_A, thread.id)

    expect(manager.current().roots).toEqual([
      { rootId: 'id-a', rootPath: ROOT_A, name: 'scope-project-a', primary: true, available: true },
    ])
  })

  it("inherits the project's unavailability — a worktree beside a vanished project is gone too", () => {
    manager.start()
    projects.setRoots([
      { id: 'id-a', rootPath: ROOT_A, available: false },
      { id: 'id-b', rootPath: ROOT_B, available: true },
    ])
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    threadStore.setThreadWorktree(thread.id, { path: WORKTREE_A, branch: 'thread/x', base: 'main' })
    projectContext.setActiveThread(ROOT_A, thread.id)

    expect(manager.current().roots[0]).toMatchObject({
      rootPath: WORKTREE_A,
      available: false,
    })
  })

  // THE DEFECT PHASE 8 FOUND, and the shape of the test that hid it: this used
  // to call `manager.refresh()` by hand between the write and the assertion, so
  // it proved the DERIVATION could see a worktree while saying nothing about
  // whether anything ever asked it to look. Nothing did — `setThreadWorktree`
  // emits `thread updated`, and the manager only re-derived on `deleted` — so
  // for six phases the editor, terminal and git panel kept reporting the
  // project's shared tree after a thread cut its own checkout.
  it('re-derives when a worktree is recorded on the ACTIVE thread — with nothing prompting it', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    projectContext.setActiveThread(ROOT_A, thread.id)
    emitted = []

    threadStore.setThreadWorktree(thread.id, { path: WORKTREE_A, branch: null, base: 'main' })

    expect(manager.current().roots[0].rootPath).toBe(WORKTREE_A)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].roots[0].rootPath).toBe(WORKTREE_A)
  })

  it('follows the checkout back to the project when the worktree is cleared', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    projectContext.setActiveThread(ROOT_A, thread.id)
    threadStore.setThreadWorktree(thread.id, { path: WORKTREE_A, branch: null, base: 'main' })
    emitted = []

    // What pruning leaves behind (Phase 7's release/merge path).
    threadStore.setThreadWorktree(thread.id, null)

    expect(manager.current().roots[0].rootPath).toBe(ROOT_A)
    expect(emitted).toHaveLength(1)
  })

  it('ignores an update to a thread the scope does not depend on', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const active = threadStore.createThread({ projectRoot: ROOT_A })
    const other = threadStore.createThread({ projectRoot: ROOT_B })
    projectContext.setActiveThread(ROOT_A, active.id)
    emitted = []

    // Another thread cutting its own checkout changes nothing about this scope,
    // and must not cost it a re-derivation (allowed-pattern #17).
    threadStore.setThreadWorktree(other.id, { path: WORKTREE_A, branch: null, base: 'main' })

    expect(manager.current().roots[0].rootPath).toBe(ROOT_A)
    expect(emitted).toHaveLength(0)
  })

  it('stays silent for an update that leaves the derived scope identical', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    const thread = threadStore.createThread({ projectRoot: ROOT_A })
    projectContext.setActiveThread(ROOT_A, thread.id)
    emitted = []

    // A status transition — the hot case. `thread updated` fires; the scope is
    // unchanged, so nothing is broadcast.
    threadStore.updateThread(thread.id, { status: 'working' })

    expect(emitted).toHaveLength(0)
  })

  it('stops re-deriving after dispose', () => {
    manager.start()
    projectContext.setActiveProject(ROOT_A)
    manager.dispose()
    emitted = []

    projectContext.setActiveProject(ROOT_B)

    expect(emitted).toHaveLength(0)
  })
})
