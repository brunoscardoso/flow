// ProjectRegistry — multi-root project state for a Flow window.
//
// Owns the list of project roots, persists the window↔roots mapping in the
// SQLite `workspaces` table (via ProjectRegistryDao), watches each root with
// chokidar, and serves lazy directory listings to the renderer.
//
// Events:
//   'roots-changed'  → RegisteredProject[]            (root added/removed/restored)
//   'files-changed'  → ProjectFilesChangedEvent (debounced batch per root)

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { promises as fsPromises, statSync } from 'fs'
import { join, resolve, relative, isAbsolute, basename, sep } from 'path'
import { watch, type FSWatcher } from 'chokidar'

import type { FlowDatabase } from '../store/db'
import { PROJECTS_TABLE } from '../store/storage-names'
import { realPathStaysInsideRoot } from './paths'
import {
  createAddressableRoots,
  type AddressableRoots,
  type ThreadWorktree,
} from './addressable-roots'
import { partitionByAvailability } from './root-availability'
import type {
  BasicDiscoveryAnswer,
  ProvisioningState,
  RegisteredProject,
} from '../../shared/ipc-contract'

/** Quiet window before a batch of file events is flushed to listeners. */
const FILE_EVENT_DEBOUNCE_MS = 150
/** How often live availability is re-evaluated while the app runs (#1118).
 *  A statSync per root, on the main process — and each stat can cost real
 *  milliseconds on network/bridged filesystems (WSL2 /mnt paths), so the pace
 *  must match the poll's role (#1785). Every live signal is event-driven and
 *  immediate: watcher error/unlinkDir fire scheduleAvailabilityRecheck, and the
 *  roots + setActiveProject IPC handlers refresh inline. This poll ONLY covers
 *  a watcher dying silently — a rare, low-urgency event — so it runs at
 *  backstop pace: an unmount is still noticed within 30 s, without stat'ing
 *  every root ~34k times a day. */
const AVAILABILITY_POLL_MS = 30_000
/** Debounce for watcher-triggered availability refreshes — an `rm -rf` fires a
 *  burst of unlink/unlinkDir before the root itself goes, and only the settled
 *  state matters. */
const AVAILABILITY_RECHECK_DEBOUNCE_MS = 400
/** How long a project's slash-command list stays good — one palette session's
 *  worth, matching the listAllFiles walk-cache. The `.claude/commands` set is
 *  provisioned and changes rarely mid-session, so a few seconds' staleness is
 *  invisible; a change still appears on the next walk after the TTL. */
const COMMANDS_CACHE_TTL_MS = 5_000
/** Directories never worth watching or listing — huge and noisy. Applied to
 *  directories only, so a FILE named e.g. `out` still shows up. */
const IGNORED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'dist', 'out'])
/** Files never worth listing, regardless of directory. */
const IGNORED_FILE_NAMES = new Set(['.DS_Store'])
/** Chokidar ignore patterns: IGNORED_DIRECTORY_NAMES plus heavy build/vendor
 *  trees never worth watching (perf — chokidar must not even traverse them),
 *  and `.brain.sqlite*` files (the RETIRED brain index. Nothing writes one any
 *  more, but a project provisioned before the retirement still has it plus its
 *  WAL/-shm siblings sitting at its root, and a watcher that noticed them would
 *  fire on every touch. Kept as legacy tolerance, like the gitignore entry). Watch-only: these extra directories still
 *  appear in listings — hiding them from the tree is a separate decision. */
export const WATCH_IGNORED =
  /(^|[/\\])(node_modules|\.git|dist|out|\.blueprint|graphify-out|build|target|\.venv|venv|\.next|coverage|vendor|__pycache__|\.turbo|\.gradle)([/\\]|$)|(^|[/\\])\.brain\.sqlite[^/\\]*$|\.DS_Store$/

export type FileChangeType = 'created' | 'changed' | 'deleted'

/** A registered project — one root the app has added. Defined ONCE, in the
 *  shared contract; re-exported here for main-side importers. */
export type { RegisteredProject }

export interface FileChange {
  type: FileChangeType
  /** Absolute path of the changed file/directory. */
  path: string
}

export interface ProjectFilesChangedEvent {
  rootPath: string
  changes: FileChange[]
}

export interface DirectoryEntry {
  name: string
  /** Absolute path. */
  path: string
  type: 'file' | 'directory'
}

/** A slash command discovered under `<root>/.claude/commands/*.md`. */
export interface SlashCommand {
  name: string
  description: string
}

export const PROJECT_LIST_CHANGED_EVENT = 'roots-changed'
export const PROJECT_FILES_CHANGED_EVENT = 'files-changed'

interface ProjectRow {
  id: string
  window_id: string
  root_path: string
  position: number
  added_at: string
  provisioned_at: string | null
  provisioned_version: string | null
  basic_discovery_answer: string | null
  accent_color: string | null
}

/** Accent overrides come from the curated renderer palette, but main validates
 *  shape only (a hex color) — layering: the palette is a renderer concern. */
const ACCENT_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

/** Thin DAO over the projects table (physically `workspaces` — storage-names.ts). */
export class ProjectRegistryDao {
  constructor(private readonly db: FlowDatabase) {}

  listRoots(windowId: string): RegisteredProject[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${PROJECTS_TABLE} WHERE window_id = ? ORDER BY position ASC, added_at ASC`)
      .all(windowId) as ProjectRow[]
    return rows.map(toRegisteredProject)
  }

  addRoot(windowId: string, rootPath: string): RegisteredProject {
    const existing = this.db
      .prepare(`SELECT * FROM ${PROJECTS_TABLE} WHERE window_id = ? AND root_path = ?`)
      .get(windowId, rootPath) as ProjectRow | undefined
    if (existing) return toRegisteredProject(existing)

    const maxPosition = this.db
      .prepare(`SELECT COALESCE(MAX(position), -1) AS max_position FROM ${PROJECTS_TABLE} WHERE window_id = ?`)
      .get(windowId) as { max_position: number }
    const root: RegisteredProject = {
      id: randomUUID(),
      windowId,
      rootPath,
      position: maxPosition.max_position + 1,
      addedAt: new Date().toISOString(),
    }
    this.db
      .prepare(
        `INSERT INTO ${PROJECTS_TABLE} (id, window_id, root_path, position, added_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(root.id, root.windowId, root.rootPath, root.position, root.addedAt)
    return root
  }

  removeRoot(windowId: string, rootPath: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM ${PROJECTS_TABLE} WHERE window_id = ? AND root_path = ?`)
      .run(windowId, rootPath)
    return result.changes > 0
  }

  /** Rewrite positions to match `orderedPaths` (index = new position). Paths
   *  not belonging to this window are ignored by the WHERE clause. */
  reorderRoots(windowId: string, orderedPaths: string[]): void {
    const update = this.db.prepare(
      `UPDATE ${PROJECTS_TABLE} SET position = ? WHERE window_id = ? AND root_path = ?`,
    )
    orderedPaths.forEach((rootPath, index) => {
      update.run(index, windowId, rootPath)
    })
  }

  /**
   * Stamp a root as auto-provisioned (ide-auto-provisioning). The single
   * write path for `provisioned_at`/`provisioned_version` — every caller
   * (CLI, agent, UI) routes through this method rather than issuing its own
   * UPDATE, so the two columns always change together (#14, one code path).
   */
  stampProvisioned(rootId: string, version: string, at: string): void {
    this.db
      .prepare(`UPDATE ${PROJECTS_TABLE} SET provisioned_at = ?, provisioned_version = ? WHERE id = ?`)
      .run(at, version, rootId)
  }

  /**
   * Record this root's answer to the basic-discovery onboarding ask (#513
   * phase 2). The single write path for `basic_discovery_answer` — a persisted
   * answer permanently ends the auto-ask for the root (it re-fires only via the
   * explicit Settings action, which routes back through here with 'yes').
   */
  setBasicDiscoveryAnswer(rootId: string, answer: BasicDiscoveryAnswer): void {
    this.db
      .prepare(`UPDATE ${PROJECTS_TABLE} SET basic_discovery_answer = ? WHERE id = ?`)
      .run(answer, rootId)
  }

  /**
   * Set (or clear, with null = "Auto") a root's user accent override. The
   * single write path for the projects table's `accent_color` (#14, one code path).
   */
  setAccentColor(rootId: string, color: string | null): void {
    this.db.prepare(`UPDATE ${PROJECTS_TABLE} SET accent_color = ? WHERE id = ?`).run(color, rootId)
  }
}

export class ProjectRegistry extends EventEmitter {
  private readonly dao: ProjectRegistryDao
  private roots: RegisteredProject[] = []
  /** Persisted roots whose directory wasn't reachable at restore (#263). Kept so
   *  the sidebar can show them greyed-out; not watched, not operated on. */
  private unavailableRoots: RegisteredProject[] = []
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly pendingChanges = new Map<string, FileChange[]>()
  private readonly flushTimers = new Map<string, NodeJS.Timeout>()
  /** Short-TTL cache for listCommands per root — a readdir + a readFile per
   *  skill file, run on every ⌘P open and every fresh `/`-picker session. The
   *  sibling of the listAllFiles walk-cache (files.ts), same rationale: the
   *  command set is allowed to be a few seconds stale (mirrors #1666/#1696). */
  private readonly commandsCache = new Map<
    string,
    { at: number; dirMtimeMs: number; commands: SlashCommand[] }
  >()
  /** Periodic live-availability poll (#1118); null until restore() starts it. */
  private availabilityTimer: NodeJS.Timeout | null = null
  /** Debounce handle for watcher-triggered availability re-checks (#1118). */
  private availabilityRecheck: NodeJS.Timeout | null = null
  private disposed = false
  /** Exemption predicate for the flow/ batch filter (see flushChanges): true
   *  when `path` is a currently-open editor/LSP document that still needs
   *  external-reload + didChange sync events. Wired by the LSP layer. */
  private openDocumentFilter: ((path: string) => boolean) | null = null
  /** The address gate for the two root-taking listings below (see
   *  addressable-roots.ts). Starts registered-roots-only — the rule that held
   *  before a thread could own a checkout — and is widened only once a caller
   *  hands over a real thread-worktree source via {@link setThreadWorktrees}. */
  private addressableRoots: AddressableRoots = createAddressableRoots({
    registeredRoots: () => this.roots,
  })

  constructor(
    db: FlowDatabase,
    private readonly windowId: string = 'main',
    /** Reachability predicate for the availability partition — fs stat in prod,
     *  injectable so the live-refresh behavior (#1118) unit-tests without
     *  touching the filesystem. */
    private readonly isReachable: (rootPath: string) => boolean = isDirectory,
  ) {
    super()
    this.dao = new ProjectRegistryDao(db)
  }

  /** Load persisted roots for this window and start watching each. A root whose
   *  directory isn't currently reachable is SKIPPED for this session but kept in
   *  persistence, so it reappears once its location is available again. */
  restore(): RegisteredProject[] {
    const persisted = this.dao.listRoots(this.windowId)
    // A failed stat covers a genuinely-deleted folder AND a merely transient one —
    // an unmounted external/network drive, or a launch-before-mount login race.
    // NEVER prune persistence here (#258). Available roots are watched + operated
    // on; unavailable ones are kept and flagged so the sidebar shows them greyed-out
    // instead of silently dropping them (#263).
    const { available, unavailable } = partitionByAvailability(persisted, this.isReachable)
    this.roots = available
    this.unavailableRoots = unavailable
    for (const root of this.roots) {
      this.startWatching(root.rootPath)
    }
    for (const root of this.unavailableRoots) {
      console.warn(`[Project] Skipping currently-unavailable root: ${root.rootPath}`)
    }
    this.startAvailabilityPoll()
    this.emit(PROJECT_LIST_CHANGED_EVENT, this.getRoots())
    return this.getRoots()
  }

  /**
   * Re-evaluate every known root's availability RIGHT NOW and move roots between
   * the available/unavailable lists accordingly (#1118).
   *
   * Before this, `partitionByAvailability` ran exactly once — at `restore()` —
   * and `getRoots()` then stamped every live root `available: true`
   * unconditionally, so a folder that was renamed, moved, deleted or unmounted
   * *while Flow ran* was never noticed: the sidebar kept rendering it healthy and
   * every consumer of the flag (#263 greying, #974's switcher guard, #975's boot
   * fallback) read a value that was stale by construction. The reverse transition
   * matters just as much — a re-mounted drive recovers without a relaunch, which
   * is the case #258/#263 shipped the flag for.
   *
   * Transitions start/stop the root's watcher so `this.roots` stays exactly "the
   * roots we watch and operate on", and emit rootsChanged so every surface
   * re-renders. Returns whether anything changed (no change = no event).
   */
  refreshAvailability(): boolean {
    if (this.disposed) return false
    // Partition the UNION in persisted order so a returning root regains its
    // slot instead of being appended wherever it was noticed.
    const union = [...this.roots, ...this.unavailableRoots].sort(
      (a, b) => a.position - b.position || a.addedAt.localeCompare(b.addedAt),
    )
    const { available, unavailable } = partitionByAvailability(union, this.isReachable)
    const wasAvailable = new Set(this.roots.map((root) => root.rootPath))
    const nowAvailable = new Set(available.map((root) => root.rootPath))
    const gone = [...wasAvailable].filter((rootPath) => !nowAvailable.has(rootPath))
    const returned = [...nowAvailable].filter((rootPath) => !wasAvailable.has(rootPath))
    if (gone.length === 0 && returned.length === 0) return false

    this.roots = available
    this.unavailableRoots = unavailable
    for (const rootPath of gone) {
      console.warn(`[Project] Root became unavailable: ${rootPath}`)
      this.stopWatching(rootPath)
    }
    for (const rootPath of returned) {
      console.warn(`[Project] Root became available again: ${rootPath}`)
      this.startWatching(rootPath)
    }
    this.emit(PROJECT_LIST_CHANGED_EVENT, this.getRoots())
    return true
  }

  /** Start the periodic availability backstop (idempotent). Unref'd so it never
   *  holds the process open. */
  private startAvailabilityPoll(): void {
    if (this.availabilityTimer !== null || this.disposed) return
    const timer = setInterval(() => this.refreshAvailability(), AVAILABILITY_POLL_MS)
    timer.unref?.()
    this.availabilityTimer = timer
  }

  /** Coalesce watcher-driven re-checks — an `rm -rf` fires a burst of events. */
  private scheduleAvailabilityRecheck(): void {
    if (this.disposed || this.availabilityRecheck !== null) return
    const timer = setTimeout(() => {
      this.availabilityRecheck = null
      this.refreshAvailability()
    }, AVAILABILITY_RECHECK_DEBOUNCE_MS)
    timer.unref?.()
    this.availabilityRecheck = timer
  }

  getRoots(): RegisteredProject[] {
    // Available roots first (stamped available), then the greyed-out unavailable
    // ones so the sidebar can render both, distinctly (#263).
    return [
      ...this.roots.map((root) => ({ ...root, available: true })),
      ...this.unavailableRoots,
    ]
  }

  /**
   * Widen the address gate to include every thread's own checkout (Phase 3.5).
   *
   * A thread's git worktree is a checkout OF a project and is deliberately never
   * registered as a project root — checkouts do not belong in the user's
   * project list. But `thread-scope-manager` reports it as the thread's primary
   * root, so the file tree addresses it, and an ungated tree throws
   * "Unknown root" the moment a thread owns one.
   *
   * Late-bound rather than a constructor argument because the thread store is
   * built after this manager. Until it is called nothing is widened, which is
   * the behaviour that shipped before thread worktrees existed.
   */
  setThreadWorktrees(threadWorktrees: () => readonly ThreadWorktree[]): void {
    this.addressableRoots = createAddressableRoots({
      registeredRoots: () => this.roots,
      threadWorktrees,
    })
  }

  addRoot(rootPath: string): RegisteredProject {
    const absolutePath = resolve(rootPath)
    if (!isDirectory(absolutePath)) {
      throw new Error(`[Project] Not a directory: ${absolutePath}`)
    }
    const existing = this.roots.find((root) => root.rootPath === absolutePath)
    if (existing) return existing

    // A root previously partitioned as unavailable whose folder is back (the
    // isDirectory check above just passed) must MOVE lists, not be added twice —
    // otherwise getRoots() would list it as both available and unavailable.
    this.unavailableRoots = this.unavailableRoots.filter(
      (root) => root.rootPath !== absolutePath,
    )
    const root = this.dao.addRoot(this.windowId, absolutePath)
    this.roots.push(root)
    this.startWatching(absolutePath)
    this.emit(PROJECT_LIST_CHANGED_EVENT, this.getRoots())
    return root
  }

  removeRoot(rootPath: string): void {
    const absolutePath = resolve(rootPath)
    const index = this.roots.findIndex((root) => root.rootPath === absolutePath)
    // An UNAVAILABLE root is removable too — "remove this project I can't reach
    // any more" is the main thing a user does with a greyed row (#263), and it
    // used to be a silent no-op because only `this.roots` was searched.
    const unavailableIndex = this.unavailableRoots.findIndex(
      (root) => root.rootPath === absolutePath,
    )
    if (index === -1 && unavailableIndex === -1) return

    if (index !== -1) this.roots.splice(index, 1)
    if (unavailableIndex !== -1) this.unavailableRoots.splice(unavailableIndex, 1)
    this.dao.removeRoot(this.windowId, absolutePath)
    this.stopWatching(absolutePath)
    this.emit(PROJECT_LIST_CHANGED_EVENT, this.getRoots())
  }

  /**
   * Reorder roots to match `orderedPaths`. Only currently-known roots are
   * honored; any known root omitted from the list keeps its relative order at
   * the end (so a partial/stale list can never drop a project). Persists the
   * new positions and emits rootsChanged.
   */
  reorderRoots(orderedPaths: string[]): RegisteredProject[] {
    const requested = orderedPaths.map((rootPath) => resolve(rootPath))
    const byPath = new Map(this.roots.map((root) => [root.rootPath, root]))
    const ordered: string[] = []
    const seen = new Set<string>()
    for (const rootPath of requested) {
      if (byPath.has(rootPath) && !seen.has(rootPath)) {
        ordered.push(rootPath)
        seen.add(rootPath)
      }
    }
    // Append any known root the caller didn't mention, preserving current order.
    for (const root of this.roots) {
      if (!seen.has(root.rootPath)) ordered.push(root.rootPath)
    }

    this.dao.reorderRoots(this.windowId, ordered)
    this.roots = ordered.map((rootPath, index) => ({
      ...(byPath.get(rootPath) as RegisteredProject),
      position: index,
    }))
    this.emit(PROJECT_LIST_CHANGED_EVENT, this.getRoots())
    return this.getRoots()
  }

  /**
   * Stamp `rootId` as auto-provisioned at `version`/`at` (ide-auto-provisioning).
   * Persists via `ProjectRegistryDao.stampProvisioned` (the single write path) and
   * mirrors the change onto the in-memory root before emitting rootsChanged.
   * Returns the updated root, or null if `rootId` isn't a currently-known
   * (available) root.
   */
  stampProvisioned(rootId: string, version: string, at: string): RegisteredProject | null {
    const index = this.roots.findIndex((root) => root.id === rootId)
    if (index === -1) return null

    this.dao.stampProvisioned(rootId, version, at)
    this.roots[index] = { ...this.roots[index], provisionedAt: at, provisionedVersion: version }
    this.emit(PROJECT_LIST_CHANGED_EVENT, this.getRoots())
    return this.roots[index]
  }

  /**
   * Mirror a Provisioner readiness transition onto `rootId` and emit
   * rootsChanged (#513, progressive-learning phase 1). In-memory only — no
   * persistence, no DAO write; `provisioningState` is recomputed from scratch
   * on every restore (see `restore()`'s caller in main/index.ts, which seeds it
   * via `Provisioner.initialStateFor`). Returns null if `rootId` isn't a
   * currently-known (available) root — mirrors `stampProvisioned`'s shape.
   */
  setProvisioningState(rootId: string, state: ProvisioningState): RegisteredProject | null {
    const index = this.roots.findIndex((root) => root.id === rootId)
    if (index === -1) return null
    // The same state again is no change: every emit here reaches every
    // roots-changed listener (the learn resume, the LSP, the renderer).
    if (this.roots[index].provisioningState === state) return this.roots[index]

    this.roots[index] = { ...this.roots[index], provisioningState: state }
    this.emit(PROJECT_LIST_CHANGED_EVENT, this.getRoots())
    return this.roots[index]
  }

  /**
   * Record this root's answer to the basic-discovery onboarding ask (#513
   * phase 2). Persists via `ProjectRegistryDao.setBasicDiscoveryAnswer` (the single
   * write path), mirrors the answer onto the in-memory root, and emits
   * rootsChanged. Returns the updated root, or null if `rootId` isn't a
   * currently-known (available) root — mirrors `stampProvisioned`'s shape.
   */
  recordBasicDiscoveryAnswer(
    rootId: string,
    answer: BasicDiscoveryAnswer,
  ): RegisteredProject | null {
    const index = this.roots.findIndex((root) => root.id === rootId)
    if (index === -1) return null

    this.dao.setBasicDiscoveryAnswer(rootId, answer)
    this.roots[index] = { ...this.roots[index], basicDiscoveryAnswer: answer }
    this.emit(PROJECT_LIST_CHANGED_EVENT, this.getRoots())
    return this.roots[index]
  }

  /**
   * Set (or clear, with `color: null` = "Auto") the user accent override for
   * the root at `rootPath`. Persists via `ProjectRegistryDao.setAccentColor` (the
   * single write path), mirrors the change onto the in-memory root, and emits
   * rootsChanged — which also re-derives the thread scope, so every accent
   * consumer (tree sections, git groups, terminal tabs, editor tabs, sidebar
   * headers) updates live. Returns the updated root, or null if `rootPath`
   * isn't a currently-known (available) root — mirrors `stampProvisioned`.
   */
  setRootAccent(rootPath: string, color: string | null): RegisteredProject | null {
    if (color !== null && !ACCENT_COLOR_PATTERN.test(color)) {
      throw new Error(`[Project] Invalid accent color: ${color}`)
    }
    const absolutePath = resolve(rootPath)
    const index = this.roots.findIndex((root) => root.rootPath === absolutePath)
    if (index === -1) return null

    const root = this.roots[index]
    this.dao.setAccentColor(root.id, color)
    const next: RegisteredProject = { ...root }
    if (color === null) delete next.accentColor
    else next.accentColor = color
    this.roots[index] = next
    this.emit(PROJECT_LIST_CHANGED_EVENT, this.getRoots())
    return this.roots[index]
  }

  /**
   * Lazy directory listing: one level of `relativePath` under `rootPath`.
   * Directories first, then files, both alphabetical. Rejects paths that
   * escape the root (renderer input is untrusted).
   */
  async listDirectory(rootPath: string, relativePath = ''): Promise<DirectoryEntry[]> {
    const absoluteRoot = resolve(rootPath)
    if (!this.addressableRoots.isAddressable(absoluteRoot)) {
      throw new Error(`[Project] Unknown root: ${rootPath}`)
    }
    const targetPath = resolve(join(absoluteRoot, relativePath))
    const relativeToRoot = relative(absoluteRoot, targetPath)
    if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
      throw new Error(`[Project] Path escapes the project folder: ${relativePath}`)
    }
    // Physical layer: a symlink inside the root must not resolve outside it —
    // except the untracked set a thread's worktree has linked in from its own
    // main checkout, which points outside by design (see ownerCheckoutFor).
    const ownerCheckout = this.addressableRoots.ownerCheckoutFor(absoluteRoot)
    if (!(await realPathStaysInsideRoot(absoluteRoot, targetPath, ownerCheckout))) {
      throw new Error(`[Project] Path escapes the project folder: ${relativePath}`)
    }

    const dirents = await fsPromises.readdir(targetPath, { withFileTypes: true })
    const classified = await Promise.all(
      dirents.map(async (dirent): Promise<DirectoryEntry | null> => {
        if (IGNORED_FILE_NAMES.has(dirent.name)) return null
        let type: 'file' | 'directory'
        if (dirent.isDirectory()) {
          type = 'directory'
        } else if (dirent.isFile()) {
          type = 'file'
        } else if (dirent.isSymbolicLink()) {
          // A symlink dirent is neither isFile nor isDirectory — classify it by
          // its TARGET so symlinked files/dirs appear in the tree, including the
          // project's own `flow/` vault link (#158). A broken link is skipped;
          // an escaping link still shows but stays un-expandable via the
          // realPathStaysInsideRoot guard above on the next listing.
          try {
            const stats = await fsPromises.stat(join(targetPath, dirent.name)) // follows the link
            type = stats.isDirectory() ? 'directory' : 'file'
          } catch {
            return null // broken / unresolvable symlink
          }
        } else {
          return null // fifo / socket / device — not browsable
        }
        if (type === 'directory' && IGNORED_DIRECTORY_NAMES.has(dirent.name)) return null
        return { name: dirent.name, path: join(targetPath, dirent.name), type }
      }),
    )
    const entries = classified.filter((entry): entry is DirectoryEntry => entry !== null)
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return entries
  }

  /**
   * List the slash commands (skills) available in a project — the markdown
   * files under `<root>/.claude/commands/*.md`. Each command's name is the
   * file basename; its description is the frontmatter `description:` value.
   * Returns an empty list (never throws) when the directory is absent, so a
   * project without skills simply shows no suggestions.
   */
  async listCommands(rootPath: string): Promise<SlashCommand[]> {
    const absoluteRoot = resolve(rootPath)
    // Unknown-root check FIRST, so a removed root throws instead of being served
    // a stale hit — the same ordering listAllProjectFiles uses (files.ts).
    if (!this.addressableRoots.isAddressable(absoluteRoot)) {
      throw new Error(`[Project] Unknown root: ${rootPath}`)
    }
    const commandsDir = join(absoluteRoot, '.claude', 'commands')
    // THE TTL ANSWERS "HOW OFTEN", NEVER "WHAT IS THERE". A skill added or
    // removed moves the directory's mtime, and one stat is far cheaper than
    // the readdir + N reads the cache saves — so a set that CHANGED is never
    // served from the cache. Keyed on time alone, a skill written by /setup
    // within five seconds of the last listing was missing from the very read
    // the composer makes on that change, and the composer then kept that
    // stale list until the next thread switch.
    let dirMtimeMs = -1
    try {
      dirMtimeMs = (await fsPromises.stat(commandsDir)).mtimeMs
    } catch {
      // No directory — falls through to the readdir below, which returns [].
    }
    const cached = this.commandsCache.get(absoluteRoot)
    if (
      cached !== undefined &&
      cached.dirMtimeMs === dirMtimeMs &&
      Date.now() - cached.at < COMMANDS_CACHE_TTL_MS
    ) {
      return cached.commands
    }
    let dirents
    try {
      dirents = await fsPromises.readdir(commandsDir, { withFileTypes: true })
    } catch {
      return [] // no .claude/commands directory — project has no skills
    }
    const commands: SlashCommand[] = []
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith('.md')) {
        continue
      }
      const name = dirent.name.slice(0, -'.md'.length)
      let description = ''
      try {
        const raw = await fsPromises.readFile(join(commandsDir, dirent.name), 'utf8')
        description = parseFrontmatterDescription(raw)
      } catch {
        // Unreadable file — still list the command with an empty description.
      }
      commands.push({ name, description })
    }
    commands.sort((a, b) => a.name.localeCompare(b.name))
    this.commandsCache.set(absoluteRoot, { at: Date.now(), dirMtimeMs, commands })
    return commands
  }

  /** Stop all watchers and drop pending events. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.availabilityTimer !== null) {
      clearInterval(this.availabilityTimer)
      this.availabilityTimer = null
    }
    if (this.availabilityRecheck !== null) {
      clearTimeout(this.availabilityRecheck)
      this.availabilityRecheck = null
    }
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer)
    }
    this.flushTimers.clear()
    this.pendingChanges.clear()
    const closing = [...this.watchers.values()].map((watcher) =>
      watcher.close().catch((error) => {
        console.warn('[Project] Failed to close watcher during dispose:', error)
      }),
    )
    this.watchers.clear()
    await Promise.all(closing)
    this.removeAllListeners()
  }

  // ── Watching ───────────────────────────────────────────────────────────

  private startWatching(rootPath: string): void {
    if (this.watchers.has(rootPath)) return

    const watcher = watch(rootPath, {
      ignored: WATCH_IGNORED,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    })
    watcher.on('add', (path) => this.queueChange(rootPath, { type: 'created', path }))
    watcher.on('addDir', (path) => this.queueChange(rootPath, { type: 'created', path }))
    watcher.on('change', (path) => this.queueChange(rootPath, { type: 'changed', path }))
    watcher.on('unlink', (path) => this.queueChange(rootPath, { type: 'deleted', path }))
    watcher.on('unlinkDir', (path) => {
      this.queueChange(rootPath, { type: 'deleted', path })
      // The root's OWN directory going away is the cheapest live signal that the
      // project folder was moved/deleted (#1118) — re-check instead of reporting
      // it as an ordinary in-project deletion.
      if (resolve(path) === resolve(rootPath)) this.scheduleAvailabilityRecheck()
    })
    watcher.on('error', (error) => {
      console.error(`[Project] Watcher error for ${basename(rootPath)}:`, error)
      // A watcher erroring out (ENOENT on the watched dir, unmounted volume)
      // means we can no longer trust this root's liveness — re-check it (#1118).
      this.scheduleAvailabilityRecheck()
    })
    this.watchers.set(rootPath, watcher)
  }

  private stopWatching(rootPath: string): void {
    const watcher = this.watchers.get(rootPath)
    if (!watcher) return
    this.watchers.delete(rootPath)
    const timer = this.flushTimers.get(rootPath)
    if (timer) {
      clearTimeout(timer)
      this.flushTimers.delete(rootPath)
    }
    this.pendingChanges.delete(rootPath)
    watcher.close().catch((error) => {
      console.error(`[Project] Failed to close watcher for ${rootPath}:`, error)
    })
  }

  /** Batch rapid-fire chokidar events into one debounced emission per root. */
  private queueChange(rootPath: string, change: FileChange): void {
    if (this.disposed) return
    const pending = this.pendingChanges.get(rootPath) ?? []
    pending.push(change)
    this.pendingChanges.set(rootPath, pending)

    const existingTimer = this.flushTimers.get(rootPath)
    if (existingTimer) clearTimeout(existingTimer)
    this.flushTimers.set(
      rootPath,
      setTimeout(() => this.flushChanges(rootPath), FILE_EVENT_DEBOUNCE_MS),
    )
  }

  /**
   * Register the predicate that exempts individual paths from the flow/ batch
   * filter below (null clears it). Called by the LSP channel layer, which
   * tracks every open editor document via editor:didOpen/didClose.
   */
  setOpenDocumentFilter(filter: ((path: string) => boolean) | null): void {
    this.openDocumentFilter = filter
  }

  private flushChanges(rootPath: string): void {
    this.flushTimers.delete(rootPath)
    const changes = this.pendingChanges.get(rootPath)
    this.pendingChanges.delete(rootPath)
    if (!changes || changes.length === 0) return

    // PERF: drop flow/** entries at emit time. flow/ state files churn
    // constantly while agents work (.rounds.jsonl, .wave-context.jsonl,
    // .evidence/, brain/.structure rebuilds), and the dedicated observers
    // (FlowObserver, ArtifactObserver, BlueprintObserver) own flow/ watching —
    // fanning that churn through the generic files-changed batch re-ran git
    // status, review-list, board git-status and tree refreshes per save burst.
    // Exception: a flow doc currently OPEN in the editor keeps its events so
    // external reload (#294/#353) and LSP didChange sync still work. Known
    // trade: the file tree's flow/ section goes stale until a refresh/reopen.
    const emittable = changes.filter(
      (change) =>
        !isUnderFlowDir(rootPath, change.path) ||
        (this.openDocumentFilter?.(change.path) ?? false),
    )
    if (emittable.length === 0) return

    const event: ProjectFilesChangedEvent = { rootPath, changes: emittable }
    this.emit(PROJECT_FILES_CHANGED_EVENT, event)
  }
}

function toRegisteredProject(row: ProjectRow): RegisteredProject {
  return {
    id: row.id,
    windowId: row.window_id,
    rootPath: row.root_path,
    position: row.position,
    addedAt: row.added_at,
    provisionedAt: row.provisioned_at ?? undefined,
    provisionedVersion: row.provisioned_version ?? undefined,
    basicDiscoveryAnswer: parseBasicDiscoveryAnswer(row.basic_discovery_answer),
    accentColor: row.accent_color ?? undefined,
  }
}

/** Narrow the persisted `basic_discovery_answer` column to the answer union
 *  (absent/unknown → undefined = never answered). */
function parseBasicDiscoveryAnswer(value: string | null): BasicDiscoveryAnswer | undefined {
  return value === 'yes' || value === 'no' ? value : undefined
}

/** The per-project plan-flow artifact directory (often a symlink into the
 *  central vault) whose churn is filtered out of the files-changed batch. */
const FLOW_DIR_NAME = 'flow'

/** True when `path` is `<rootPath>/flow` or anything beneath it. Exported for
 *  the flush-filter tests. */
export function isUnderFlowDir(rootPath: string, path: string): boolean {
  const rel = relative(rootPath, path)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  return rel === FLOW_DIR_NAME || rel.startsWith(`${FLOW_DIR_NAME}${sep}`)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Pull the one-line `description:` out of a command file's YAML frontmatter
 * (the leading `---` … `---` block). Returns '' when there's no frontmatter or
 * no description key. Only the leading block is scanned, so a `description:`
 * mention in the body is never mistaken for the field.
 */
function parseFrontmatterDescription(raw: string): string {
  const normalized = raw.replace(/^﻿/, '')
  if (!normalized.startsWith('---')) {
    return ''
  }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) {
    return ''
  }
  const frontmatter = normalized.slice(3, end)
  const match = /^\s*description:\s*(.+?)\s*$/m.exec(frontmatter)
  if (!match) {
    return ''
  }
  return match[1].replace(/^["']|["']$/g, '').trim()
}
