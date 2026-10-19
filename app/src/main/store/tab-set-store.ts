/**
 * TAB SETS — the editor tabs of one conversation, persisted per (project, thread).
 *
 * Each thread separates the work: a file, an unsaved buffer, a feature view or
 * the blueprint opened while reading one conversation belongs to THAT
 * conversation, and comes back when it is selected again — across restarts.
 * While no thread is selected the project has its own, project-level set
 * (`thread_id = ''` in the table, `null` everywhere else).
 *
 * The same row holds the user shells opened in that conversation (v35), so
 * a thread's terminals come back — and are dropped — with its tabs.
 *
 * EVERY READ AND WRITE OF `thread_tab_state` GOES THROUGH THIS FILE
 * (allowed-pattern #14): the project context's load/save, the thread delete
 * path that drops a conversation's set, the project removal that drops all of
 * a root's sets, and the checkout rename that moves their paths.
 */

import type {
  OpenFileRef,
  OpenViewRef,
  SavedTerminalRef,
  TabSet,
} from '../../shared/ipc-contract'
import { withTransaction, type FlowDatabase } from './db'
import { rescueOrphanedBuffers } from './orphaned-buffers'
import { repointedTabs } from './repoint-tabs'

/** The table's key for the project-level set. */
const PROJECT_LEVEL_KEY = ''

interface TabSetRow {
  root_path: string
  thread_id: string
  open_files: string
  active_file: string | null
  dirty_buffers: string
  open_views: string
}

/** The empty set — what a conversation nobody saved tabs for holds. */
export function emptyTabSet(): TabSet {
  return { openFiles: [], activeFile: null, dirtyBuffers: {}, openViews: [] }
}

function threadKey(threadId: string | null): string {
  return threadId ?? PROJECT_LEVEL_KEY
}

export class TabSetStore {
  constructor(private readonly db: FlowDatabase) {}

  /** The saved set for (root, thread), or null when none was ever saved. */
  load(rootPath: string, threadId: string | null): TabSet | null {
    const row = this.db
      .prepare('SELECT * FROM thread_tab_state WHERE root_path = ? AND thread_id = ?')
      .get(rootPath, threadKey(threadId)) as TabSetRow | undefined
    if (row === undefined) return null
    return {
      openFiles: parseArray<OpenFileRef>(row.open_files),
      activeFile: row.active_file,
      dirtyBuffers: parseStringRecord(row.dirty_buffers),
      openViews: parseArray<OpenViewRef>(row.open_views).filter(isViewRef),
    }
  }

  /** Replace the saved set for (root, thread). */
  save(rootPath: string, threadId: string | null, set: TabSet): void {
    this.db
      .prepare(
        `INSERT INTO thread_tab_state
           (root_path, thread_id, open_files, active_file, dirty_buffers, open_views, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_path, thread_id) DO UPDATE SET
           open_files = excluded.open_files,
           active_file = excluded.active_file,
           dirty_buffers = excluded.dirty_buffers,
           open_views = excluded.open_views,
           updated_at = excluded.updated_at`,
      )
      .run(
        rootPath,
        threadKey(threadId),
        JSON.stringify(set.openFiles),
        set.activeFile,
        JSON.stringify(set.dirtyBuffers),
        JSON.stringify(set.openViews),
        new Date().toISOString(),
      )
  }

  /**
   * The shells (root, thread) had open, for re-spawning after a restart (v35).
   * Empty when none were ever saved. Stored beside the tabs, but written by
   * its own statement so a tab save never clobbers the shells or vice versa.
   */
  loadTerminals(rootPath: string, threadId: string | null): SavedTerminalRef[] {
    const row = this.db
      .prepare('SELECT open_terminals FROM thread_tab_state WHERE root_path = ? AND thread_id = ?')
      .get(rootPath, threadKey(threadId)) as { open_terminals: string } | undefined
    if (row === undefined) return []
    return parseArray<unknown>(row.open_terminals).filter(isTerminalRef)
  }

  /** Replace the shells saved for (root, thread); the tabs are left as they are. */
  saveTerminals(rootPath: string, threadId: string | null, terminals: SavedTerminalRef[]): void {
    this.db
      .prepare(
        `INSERT INTO thread_tab_state (root_path, thread_id, open_terminals, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(root_path, thread_id) DO UPDATE SET
           open_terminals = excluded.open_terminals,
           updated_at = excluded.updated_at`,
      )
      .run(
        rootPath,
        threadKey(threadId),
        JSON.stringify(terminals.map(({ title, cwd }) => ({ title, cwd }))),
        new Date().toISOString(),
      )
  }

  /**
   * Drop every set a conversation saved, in any project (thread deleted) —
   * after moving its unsaved buffers into each project's own set, so deleting
   * a conversation never silently deletes text nobody saved.
   */
  deleteThread(threadId: string): void {
    if (threadId === PROJECT_LEVEL_KEY) return
    withTransaction(this.db, () => {
      const roots = this.db
        .prepare('SELECT root_path FROM thread_tab_state WHERE thread_id = ?')
        .all(threadId) as Array<{ root_path: string }>
      for (const { root_path: rootPath } of roots) {
        const set = this.load(rootPath, threadId)
        if (set !== null) this.rescueBuffers(rootPath, set)
      }
      this.db.prepare('DELETE FROM thread_tab_state WHERE thread_id = ?').run(threadId)
    })
  }

  /**
   * Move a set's unsaved buffers into the project-level set of `rootPath`
   * (`orphaned-buffers.ts` decides how) — for a conversation that is gone.
   */
  rescueBuffers(rootPath: string, orphan: TabSet): void {
    const target = this.load(rootPath, null) ?? emptyTabSet()
    const merged = rescueOrphanedBuffers(rootPath, target, orphan)
    if (merged !== null) this.save(rootPath, null, merged)
  }

  /** Drop every set saved in a project (project removed). */
  deleteRoot(rootPath: string): void {
    this.db.prepare('DELETE FROM thread_tab_state WHERE root_path = ?').run(rootPath)
  }

  /**
   * Move every saved tab that addresses a checkout onto its new path (the
   * checkout was renamed). Same pure rewrite the legacy project rows use; a row
   * that does not mention the checkout is left untouched.
   */
  repoint(fromPath: string, toPath: string): void {
    const rows = this.db
      .prepare('SELECT root_path, thread_id, open_files, dirty_buffers FROM thread_tab_state')
      .all() as Array<Pick<TabSetRow, 'root_path' | 'thread_id' | 'open_files' | 'dirty_buffers'>>
    const update = this.db.prepare(
      'UPDATE thread_tab_state SET open_files = ?, dirty_buffers = ? WHERE root_path = ? AND thread_id = ?',
    )
    for (const row of rows) {
      const moved = repointedTabs(row.open_files, row.dirty_buffers, fromPath, toPath)
      if (moved === null) continue
      update.run(moved.openFiles, moved.dirtyBuffers, row.root_path, row.thread_id)
    }
    // A shell saved in the checkout re-spawns in its new home, not in a
    // directory that no longer exists.
    const shellRows = this.db
      .prepare('SELECT root_path, thread_id, open_terminals FROM thread_tab_state')
      .all() as Array<{ root_path: string; thread_id: string; open_terminals: string }>
    const updateShells = this.db.prepare(
      'UPDATE thread_tab_state SET open_terminals = ? WHERE root_path = ? AND thread_id = ?',
    )
    for (const row of shellRows) {
      const refs = parseArray<unknown>(row.open_terminals).filter(isTerminalRef)
      const moved = refs.map((ref) => ({ ...ref, cwd: repointedPath(ref.cwd, fromPath, toPath) }))
      if (moved.every((ref, index) => ref.cwd === refs[index]?.cwd)) continue
      updateShells.run(JSON.stringify(moved), row.root_path, row.thread_id)
    }
  }
}

function parseArray<T>(json: string): T[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? (value as T[]) : []
  } catch (error) {
    console.warn('[TabSetStore] unreadable JSON array column — treated as empty', error)
    return []
  }
}

function parseStringRecord(json: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(json)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const result: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') result[key] = entry
    }
    return result
  } catch (error) {
    console.warn('[TabSetStore] unreadable dirty-buffer column — treated as empty', error)
    return {}
  }
}

/** `path` moved from under `fromPath` to under `toPath`; unrelated paths unchanged. */
function repointedPath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath
  return path.startsWith(`${fromPath}/`) ? `${toPath}${path.slice(fromPath.length)}` : path
}

function isTerminalRef(value: unknown): value is SavedTerminalRef {
  if (value === null || typeof value !== 'object') return false
  const ref = value as { title?: unknown; cwd?: unknown }
  return typeof ref.title === 'string' && typeof ref.cwd === 'string' && ref.cwd.length > 0
}

function isViewRef(value: unknown): value is OpenViewRef {
  if (value === null || typeof value !== 'object') return false
  const ref = value as { kind?: unknown; state?: unknown }
  return (
    typeof ref.kind === 'string' &&
    ref.kind.length > 0 &&
    ref.state !== null &&
    typeof ref.state === 'object' &&
    !Array.isArray(ref.state)
  )
}
