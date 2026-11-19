// DraftsObserver — a sibling of ArtifactObserver for canvas folders
// (`flow/drafts/<canvas>/`). The project file watcher drops `flow/**`, and the
// artifact observer watches only the three doc dirs, so drafts need a watcher
// of their own.
//
// What it does with a change, in order (`processDraftChange`):
//   1. Flow's own write (an edit, an undo, a restore, a stamp) is recognised by
//      its write token — path + content hash in the DraftWriteLedger — and
//      ignored: not re-stamped (no stamping loop) and not broadcast (no reload
//      for our own write, allowed-pattern #17).
//   2. An agent's write to a screen gets ids stamped on every element that has
//      none, written back as Flow's own.
//   3. The agent's previous version, when one was known, becomes an undo
//      snapshot — undo reverts the agent's change exactly like a person's.
//   4. One coalesced `{ rootPath, canvas, files }` event per canvas.
//
// Shape mirrors ArtifactObserver: the ROOT is watched (it always exists;
// chokidar never re-arms a watch whose own target was missing at start), with
// an `ignored` predicate that prunes everything outside
// `flow/drafts/<canvas>/<file>` — history, versions, temp files and dotfiles
// included — before chokidar descends. A `flow/` that is a link into the vault
// gets a second watch on its real target, reported under the root's own path.
// Every read here is fs/promises (allowed-pattern #19).

import { promises as fsPromises } from 'fs'
import { join, relative, sep } from 'path'
import { watch, type FSWatcher } from 'chokidar'

import { onFlowLinksChanged } from '../project/flow-link-events'
import type { RootsProvider } from '../flow/flow-observer'
import { isDraftSlug, resolveDraftPath, type DraftsChangedEvent } from '../../shared/ui-drafts'
import { stampDraftIds } from './draft-stamp'
import { snapshotDraft, writeDraftAtomic, type DraftStoreDeps } from './draft-store'

/** Depth below the watched root needed to reach `flow/drafts/<canvas>/<file>`. */
const WATCH_DEPTH = 3

/** Quiet window before a burst of writes to one file is processed once. */
const FILE_DEBOUNCE_MS = 250

/** Quiet window before a canvas's processed files are broadcast as one event. */
const CANVAS_DEBOUNCE_MS = 150

/** Files larger than this are never cached for undo (a screen is a few KB). */
const MAX_CACHED_BYTES = 2 * 1024 * 1024

// ── Pure logic (exported for tests) ───────────────────────────────────────

/** The canvas and file a path under a root names, or null when it is not a canvas file. */
export function draftFileOf(rootPath: string, absPath: string): { canvas: string; file: string } | null {
  const parts = relative(rootPath, absPath).split(sep)
  if (parts.length !== 4 || parts[0] !== 'flow' || parts[1] !== 'drafts') return null
  const [, , canvas, file] = parts
  return resolveDraftPath(rootPath, canvas, file).ok ? { canvas, file } : null
}

/**
 * chokidar `ignored` predicate: keeps the root, `flow`, `flow/drafts`, each
 * canvas folder and each known file inside it; prunes everything else —
 * including `.history/`, `versions/`, temp files and dotfiles.
 */
export function isOutsideDrafts(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath)
  if (rel === '' || rel.startsWith('..')) return false
  const parts = rel.split(sep)
  if (parts[0] !== 'flow') return true
  if (parts.length === 1) return false
  if (parts[1] !== 'drafts') return true
  if (parts.length === 2) return false
  if (!isDraftSlug(parts[2])) return true
  if (parts.length === 3) return false
  if (parts.length > 4) return true
  return !resolveDraftPath(rootPath, parts[2], parts[3]).ok
}

/** What the observer remembers between changes: the last content seen per file. */
export type DraftContentCache = Map<string, string>

export interface DraftChangeDeps extends DraftStoreDeps {
  cache: DraftContentCache
}

/**
 * Handle one settled change of one canvas file. Returns whether it is worth
 * broadcasting (false for Flow's own writes and for content already seen).
 */
export async function processDraftChange(
  deps: DraftChangeDeps,
  change: { root: string; canvas: string; file: string; absPath: string; removed?: boolean },
): Promise<boolean> {
  if (change.removed === true) {
    deps.cache.delete(change.absPath)
    return true
  }
  let content: string
  try {
    content = await deps.fs.readFile(change.absPath)
  } catch {
    // Gone between the event and the read: the unlink event reports it.
    return false
  }
  const previous = deps.cache.get(change.absPath)
  if (deps.ledger.claim(change.absPath, content)) {
    remember(deps.cache, change.absPath, content)
    return false
  }
  if (previous === content) return false
  // The agent's previous version becomes the newest undo step.
  if (previous !== undefined) {
    await snapshotDraft(deps, { root: change.root, canvas: change.canvas, file: change.file, previous })
  }
  let final = content
  const resolution = resolveDraftPath(change.root, change.canvas, change.file)
  if (resolution.ok && resolution.kind === 'screen') {
    const stamped = stampDraftIds(content, new Set())
    if (stamped.added > 0) {
      await writeDraftAtomic(deps, change.absPath, stamped.html)
      final = stamped.html
    }
  }
  remember(deps.cache, change.absPath, final)
  return true
}

function remember(cache: DraftContentCache, absPath: string, content: string): void {
  if (content.length > MAX_CACHED_BYTES) cache.delete(absPath)
  else cache.set(absPath, content)
}

/**
 * Seed the cache with what every canvas file holds now, so the first agent
 * write after start still leaves the previous version for undo. Fail-soft.
 */
export async function seedDraftCache(cache: DraftContentCache, rootPath: string): Promise<void> {
  const draftsDir = join(rootPath, 'flow', 'drafts')
  let canvases: string[]
  try {
    canvases = await fsPromises.readdir(draftsDir)
  } catch {
    return
  }
  for (const canvas of canvases.filter(isDraftSlug)) {
    let files: string[]
    try {
      files = await fsPromises.readdir(join(draftsDir, canvas))
    } catch {
      continue
    }
    for (const file of files) {
      if (!resolveDraftPath(rootPath, canvas, file).ok) continue
      const absPath = join(draftsDir, canvas, file)
      if (cache.has(absPath)) continue
      try {
        remember(cache, absPath, await fsPromises.readFile(absPath, 'utf8'))
      } catch {
        continue
      }
    }
  }
}

// ── Observer ───────────────────────────────────────────────────────────────

interface RootDraftWatch {
  watcher: FSWatcher
  link: { target: string; watcher: FSWatcher } | null
  onEvent: (absPath: string, removed: boolean) => void
}

export class DraftsObserver {
  private readonly listeners = new Set<(event: DraftsChangedEvent) => void>()
  private readonly watches = new Map<string, RootDraftWatch>()
  private readonly fileTimers = new Map<string, NodeJS.Timeout>()
  private readonly canvasTimers = new Map<string, NodeJS.Timeout>()
  private readonly pendingFiles = new Map<string, Set<string>>()
  private readonly cache: DraftContentCache = new Map()
  /** One processing chain per file, so a stamp never races the next change. */
  private readonly chains = new Map<string, Promise<void>>()
  private unsubscribeRoots: (() => void) | null = null
  private unsubscribeLinks: (() => void) | null = null
  private disposed = false

  constructor(
    private readonly roots: RootsProvider,
    private readonly store: DraftStoreDeps,
  ) {}

  start(): void {
    this.syncRoots()
    this.unsubscribeRoots = this.roots.onRootsChanged(() => this.syncRoots())
    this.unsubscribeLinks = onFlowLinksChanged(() => {
      for (const [rootPath, entry] of this.watches) void this.armLinkWatch(rootPath, entry)
    })
  }

  on(listener: (event: DraftsChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeRoots?.()
    this.unsubscribeLinks?.()
    for (const timer of [...this.fileTimers.values(), ...this.canvasTimers.values()]) clearTimeout(timer)
    this.fileTimers.clear()
    this.canvasTimers.clear()
    const closing: Array<Promise<void>> = []
    for (const entry of this.watches.values()) {
      closing.push(entry.watcher.close())
      if (entry.link !== null) closing.push(entry.link.watcher.close())
    }
    this.watches.clear()
    await Promise.all(closing)
    this.listeners.clear()
  }

  private syncRoots(): void {
    if (this.disposed) return
    const current = new Set(this.roots.getRoots().map((root) => root.rootPath))
    for (const rootPath of [...this.watches.keys()]) if (!current.has(rootPath)) this.stopWatch(rootPath)
    for (const rootPath of current) if (!this.watches.has(rootPath)) this.startWatch(rootPath)
  }

  private startWatch(rootPath: string): void {
    const watcher = watch(rootPath, {
      depth: WATCH_DEPTH,
      ignoreInitial: true,
      persistent: true,
      ignored: (path: string) => isOutsideDrafts(rootPath, path),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    const onEvent = (absPath: string, removed: boolean): void => this.queue(rootPath, absPath, removed)
    watcher.on('add', (path: string) => onEvent(path, false))
    watcher.on('change', (path: string) => onEvent(path, false))
    watcher.on('unlink', (path: string) => onEvent(path, true))
    watcher.on('error', (error) => console.error(`[DraftsObserver] Watcher error for ${rootPath}:`, error))
    const entry: RootDraftWatch = { watcher, link: null, onEvent }
    this.watches.set(rootPath, entry)
    const flowDir = join(rootPath, 'flow')
    watcher.on('all', (_event: string, path: string) => {
      if (path === flowDir) void this.armLinkWatch(rootPath, entry)
    })
    void this.armLinkWatch(rootPath, entry)
    void seedDraftCache(this.cache, rootPath)
  }

  /** Follow `<root>/flow` when it is a link (see ArtifactObserver.armLinkWatch). */
  private async armLinkWatch(rootPath: string, entry: RootDraftWatch): Promise<void> {
    const flowDir = join(rootPath, 'flow')
    let target: string | null = null
    try {
      if ((await fsPromises.lstat(flowDir)).isSymbolicLink()) target = await fsPromises.realpath(flowDir)
    } catch {
      target = null
    }
    if (this.disposed || this.watches.get(rootPath) !== entry) return
    if (entry.link !== null && entry.link.target === target) return
    if (entry.link !== null) {
      const stale = entry.link.watcher
      entry.link = null
      stale.close().catch((error) => console.error(`[DraftsObserver] Failed to close link watcher:`, error))
    }
    if (target === null) return
    const realFlow = target
    const asRootPath = (path: string): string => join(flowDir, relative(realFlow, path))
    const linkWatcher = watch(realFlow, {
      depth: WATCH_DEPTH - 1,
      ignoreInitial: true,
      persistent: true,
      ignored: (path: string) => isOutsideDrafts(rootPath, asRootPath(path)),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    linkWatcher.on('add', (path: string) => entry.onEvent(asRootPath(path), false))
    linkWatcher.on('change', (path: string) => entry.onEvent(asRootPath(path), false))
    linkWatcher.on('unlink', (path: string) => entry.onEvent(asRootPath(path), true))
    linkWatcher.on('error', (error) => console.error(`[DraftsObserver] Link watcher error for ${rootPath}:`, error))
    entry.link = { target: realFlow, watcher: linkWatcher }
  }

  private stopWatch(rootPath: string): void {
    const entry = this.watches.get(rootPath)
    if (!entry) return
    this.watches.delete(rootPath)
    entry.watcher.close().catch((error) => console.error(`[DraftsObserver] Failed to close watcher:`, error))
    entry.link?.watcher.close().catch((error) => console.error(`[DraftsObserver] Failed to close link watcher:`, error))
    const prefix = `${join(rootPath, 'flow', 'drafts')}${sep}`
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key)
  }

  /**
   * Process one change of a canvas file NOW, on the same per-file chain and
   * through the same `processDraftChange` the watcher's settled events take —
   * the previous version still becomes an undo step, the screen is still
   * stamped, and the canvas is still broadcast. For a caller that knows a file
   * changed and cannot wait on the watcher (a hidden end-to-end run on a macOS
   * temp folder, where fsevents is not reliable). A later watcher event for the
   * same content is a no-op: the cache already holds it. Resolves with whether
   * the change was worth a broadcast; false for a path that is not a canvas file.
   */
  processChange(rootPath: string, absPath: string, removed = false): Promise<boolean> {
    const target = draftFileOf(rootPath, absPath)
    if (target === null || this.disposed) return Promise.resolve(false)
    return this.run(rootPath, absPath, target, removed)
  }

  private queue(rootPath: string, absPath: string, removed: boolean): void {
    const target = draftFileOf(rootPath, absPath)
    if (target === null || this.disposed) return
    const existing = this.fileTimers.get(absPath)
    if (existing) clearTimeout(existing)
    this.fileTimers.set(
      absPath,
      setTimeout(() => {
        this.fileTimers.delete(absPath)
        void this.run(rootPath, absPath, target, removed)
      }, FILE_DEBOUNCE_MS),
    )
  }

  /** Chain one change of one file after the last one, so a stamp never races the next change. */
  private run(
    rootPath: string,
    absPath: string,
    target: { canvas: string; file: string },
    removed: boolean,
  ): Promise<boolean> {
    const previous = this.chains.get(absPath) ?? Promise.resolve()
    const worthIt = previous.then(() =>
      processDraftChange(
        { ...this.store, cache: this.cache },
        { root: rootPath, canvas: target.canvas, file: target.file, absPath, removed },
      ),
    )
    const next: Promise<void> = worthIt
      .then((worth) => {
        if (worth) this.queueBroadcast(rootPath, target.canvas, target.file)
      })
      .catch((error) => console.error('[DraftsObserver] Failed to process a draft change', { absPath, error }))
      .finally(() => {
        if (this.chains.get(absPath) === next) this.chains.delete(absPath)
      })
    this.chains.set(absPath, next)
    return next.then(() => worthIt.catch(() => false))
  }

  private queueBroadcast(rootPath: string, canvas: string, file: string): void {
    if (this.disposed) return
    const key = `${rootPath}\n${canvas}`
    const files = this.pendingFiles.get(key) ?? new Set<string>()
    files.add(file)
    this.pendingFiles.set(key, files)
    const existing = this.canvasTimers.get(key)
    if (existing) clearTimeout(existing)
    this.canvasTimers.set(
      key,
      setTimeout(() => {
        this.canvasTimers.delete(key)
        const pending = this.pendingFiles.get(key)
        this.pendingFiles.delete(key)
        if (pending === undefined || pending.size === 0) return
        const event: DraftsChangedEvent = { rootPath, canvas, files: [...pending].sort() }
        for (const listener of this.listeners) listener(event)
      }, CANVAS_DEBOUNCE_MS),
    )
  }
}
