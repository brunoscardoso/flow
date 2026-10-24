// ArtifactObserver — a sibling of FlowObserver dedicated to the three
// narratable artifact dirs (`flow/discovery/`, `flow/plans/`, `flow/brainstorms/`).
//
// Why a sibling instead of extending FlowObserver: FlowObserver watches a FIXED
// set of basenames directly inside `flow/` at depth 0 and folds every change
// into one coalesced FlowState snapshot per root. Artifact watching is a
// different shape — three separate subdirs, filtered by extension (`.md`) and
// per-FILE identity (not a root-wide snapshot), emitting one event per changed
// file rather than a refreshed snapshot. Bolting that onto FlowObserver would
// mean threading a second, incompatible event model through its snapshot/
// notification machinery. A dedicated watcher with its own tiny lifecycle
// (start/dispose, roots-changed resync) mirrors FlowObserver's shape closely
// enough to stay familiar while keeping the two concerns decoupled.
//
// Fail-soft on missing dirs: `flow/discovery`, `flow/plans`, and
// `flow/brainstorms` may not exist yet in a fresh project (they're created on
// first use — see FLOW_ARTIFACT_SUBDIRS in project/files.ts), and `flow/`
// itself may not exist yet either (pre-provisioning). Empirically (verified
// against the app's chokidar 3.6 on this platform), chokidar does NOT re-arm
// a watch whose OWN target path didn't exist at watch-start — watching
// `flow/discovery` directly and creating it later never fires, no matter how
// long you wait. It only reliably detects new descendants when the WATCHED
// PATH ITSELF already existed at watch time. The one path that is always
// guaranteed to exist is the project root (RootsProvider only ever returns
// real directories) — so the whole root is watched (depth: 2 reaches
// `<root>/flow/<subdir>/<file>`), with an `ignored` predicate that prunes
// every branch outside `flow/{discovery,plans,brainstorms}` BEFORE chokidar
// descends into it. This keeps the watch cheap (node_modules, .git, etc. are
// never traversed) while still catching `flow/`, then `flow/plans/`, then
// `flow/plans/plan_x.md` being created in sequence on a brand-new project.
//
// The `learn:narrate` invoke channel lives in this module too — it's the
// natural pairing (the artifact watcher tells the renderer a doc changed; the
// narrate action is what the renderer does about it), and both need the same
// roots/bundledCli wiring.

import fs from 'fs'
import { timed } from '../ipc/slow-handler'
import { basename, extname, join, relative, sep } from 'path'
import { watch, type FSWatcher } from 'chokidar'

import { onFlowLinksChanged } from '../project/flow-link-events'

import type {
  FlowArtifactChangedEvent,
  FlowArtifactKind,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../shared/ipc-contract'
import type { RootsProvider } from './flow-observer'
import { formatArtifactMarker } from '../../shared/artifact-marker'
import {
  docPathForWalkthrough,
  isWalkthroughBeingWritten,
  walkthroughPathFor,
  WALKTHROUGH_PAGE_SUFFIX,
  WALKTHROUGH_UNFILLED_MARKER,
} from '../../shared/walkthrough-page'
import { runBundledCliCapturing, type CliRunner, type CliRunResult } from '../agent/learn-session'
import type { BundledCli } from '../blueprint/derive-runner'

/** flow/<dir> → the artifact kind it narrates as. Order is stable for tests. */
const ARTIFACT_SUBDIRS: ReadonlyArray<{ dir: string; kind: FlowArtifactKind }> = [
  { dir: 'discovery', kind: 'discovery' },
  { dir: 'plans', kind: 'plan' },
  { dir: 'brainstorms', kind: 'brainstorm' },
]

/** Depth (below the watched root) needed to reach `flow/<subdir>/<file>`. */
const WATCH_DEPTH = 2

/** Quiet window before a burst of writes to the same file collapses into one event. */
const REFRESH_DEBOUNCE_MS = 300

// ── Pure logic (exported for tests) ───────────────────────────────────────

/** Map a `flow/` subdir basename (e.g. "plans") to its artifact kind, or null
 *  for any dir not in the watched set (e.g. "archive"). */
export function deriveArtifactKind(subdir: string): FlowArtifactKind | null {
  return ARTIFACT_SUBDIRS.find((entry) => entry.dir === subdir)?.kind ?? null
}

/** True for a real markdown file worth emitting — skips dotfiles (editor
 *  swap/lock files) and anything that isn't a `.md` doc. */
export function isArtifactFile(path: string): boolean {
  const name = basename(path)
  if (name.startsWith('.')) return false
  return extname(name).toLowerCase() === '.md'
}

/**
 * True for a doc's user walkthrough page (`<doc>.walkthrough.html`). The page
 * is never a card of its own — `isArtifactFile` keeps rejecting it — but its
 * add/change/unlink re-emits its doc's event, so a card learns it has a
 * feature view even when the page lands after the markdown.
 */
export function isWalkthroughFile(path: string): boolean {
  const name = basename(path)
  if (name.startsWith('.')) return false
  return name.endsWith(WALKTHROUGH_PAGE_SUFFIX) && name.length > WALKTHROUGH_PAGE_SUFFIX.length
}

/**
 * The doc whose card a file event concerns: a `.md` doc is its own; a
 * walkthrough page concerns the `.md` beside it; anything else concerns none.
 * Exported for tests.
 */
export function artifactDocFor(path: string): string | null {
  if (isArtifactFile(path)) return path
  if (isWalkthroughFile(path)) return docPathForWalkthrough(path)
  return null
}

/** Whether a doc's walkthrough page exists, and when it last changed. */
export interface WalkthroughState {
  walkthrough: boolean
  walkthroughMtime?: number
  /** Present (true) only while the page still has placeholders to fill. */
  walkthroughWriting?: true
}

/**
 * Stat the page beside `docAbsPath`. Pure over the injected stat and read so
 * it tests without a filesystem; a missing or unreadable page reads as "no page".
 *
 * The page is READ only when it changed within the writing window — the one
 * case where it can still be the half-filled template. An older page is
 * finished or abandoned either way, so a scan of a project with fifty
 * discoveries stats fifty pages and reads none.
 */
export function walkthroughStateFor(
  docAbsPath: string,
  stat: (path: string) => { mtimeMs: number } = (path) => fs.statSync(path),
  read: (path: string) => string = (path) => fs.readFileSync(path, 'utf8'),
  now: number = Date.now(),
): WalkthroughState {
  const pagePath = walkthroughPathFor(docAbsPath)
  if (pagePath === null) return { walkthrough: false }
  let mtimeMs: number
  try {
    mtimeMs = stat(pagePath).mtimeMs
  } catch {
    return { walkthrough: false }
  }
  if (!isWalkthroughBeingWritten(true, mtimeMs, now)) return { walkthrough: true, walkthroughMtime: mtimeMs }
  let unfilled = false
  try {
    unfilled = read(pagePath).includes(WALKTHROUGH_UNFILLED_MARKER)
  } catch {
    // Unreadable right now (mid-write): the next change event re-reads it.
  }
  return unfilled
    ? { walkthrough: true, walkthroughMtime: mtimeMs, walkthroughWriting: true }
    : { walkthrough: true, walkthroughMtime: mtimeMs }
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

/**
 * chokidar `ignored` predicate for a root watch: prunes every path outside
 * `flow/{discovery,plans,brainstorms}` before chokidar descends into it (so
 * node_modules, .git, flow/archive, etc. are never traversed). Exported for
 * tests.
 */
export function isOutsideArtifactSubdirs(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath)
  if (rel === '' || rel.startsWith('..')) return false // the root itself — never ignore
  const parts = rel.split(sep)
  if (parts[0] !== 'flow') return true
  if (parts.length === 1) return false // 'flow' itself — always traversed
  // flow/<subdir>[/<file>] — allow only the three watched subdirs (e.g.
  // reject flow/archive); WATCH_DEPTH already caps traversal beyond the file.
  return deriveArtifactKind(parts[1]) === null
}

// ── Observer ───────────────────────────────────────────────────────────────

/** What a doc's card shows that can change: the doc's mtime and its page's
 *  state. Two observations with the same signature are the same doc. */
function artifactSignature(event: FlowArtifactChangedEvent): string {
  return [event.mtime, event.walkthrough ?? '', event.walkthroughMtime ?? '', event.walkthroughWriting ?? ''].join('|')
}

export const FLOW_ARTIFACT_CHANGED_EVENT = 'artifact-changed'

interface RootArtifactWatch {
  watcher: FSWatcher
  timers: Map<string, NodeJS.Timeout>
  /** A second watch on `flow/`'s real target, while `flow/` is a symlink. */
  link: { target: string; watcher: FSWatcher } | null
  /**
   * The last-known signature of every doc under this root, by repo-relative
   * path — seeded from a scan when the watch starts. A doc is reported only
   * when its signature changes, so a doc MOVED rather than written (the vault
   * link relocates a project's docs with their mtimes intact, and fsevents
   * reports a moved folder's files as adds or changes) stays silent.
   */
  known: Map<string, string>
  /** The root's file handler — kept so a re-check of the link can re-arm it. */
  onFileEvent?: (path: string) => void
}

/**
 * Watches every project root's three artifact subdirs and emits:
 *   'artifact-changed' → FlowArtifactChangedEvent (one per changed .md file,
 *   and one for a doc whose `.walkthrough.html` page was added, changed or removed)
 */
export class ArtifactObserver {
  private readonly listeners = new Set<(event: FlowArtifactChangedEvent) => void>()
  /** Per debounced path: is everything queued for it a re-listing (true) or did a real write arrive (false)? */
  private readonly pendingReplay = new Map<string, boolean>()
  private readonly watches = new Map<string, RootArtifactWatch>()
  private unsubscribeRoots: (() => void) | null = null
  private unsubscribeLinks: (() => void) | null = null
  private disposed = false

  constructor(private readonly roots: RootsProvider) {}

  /** Start watching current roots and follow root list changes. */
  start(): void {
    this.syncRoots()
    this.unsubscribeRoots = this.roots.onRootsChanged(() => this.syncRoots())
    // A Workspace change can repoint `flow` (vault link → Workspace link)
    // without chokidar noticing: follow the new target when told.
    this.unsubscribeLinks = onFlowLinksChanged(() => this.relinkAll())
  }

  /** Re-check every root's `flow` link and follow its target (a no-op where it did not move). */
  relinkAll(): void {
    for (const [rootPath, entry] of this.watches) {
      if (entry.onFileEvent !== undefined) this.armLinkWatch(rootPath, entry, entry.onFileEvent)
    }
  }

  on(listener: (event: FlowArtifactChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Stop all watchers. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeRoots?.()
    this.unsubscribeRoots = null
    this.unsubscribeLinks?.()
    this.unsubscribeLinks = null
    const closing: Array<Promise<void>> = []
    for (const entry of this.watches.values()) {
      for (const timer of entry.timers.values()) clearTimeout(timer)
      closing.push(entry.watcher.close())
      if (entry.link !== null) closing.push(entry.link.watcher.close())
    }
    this.watches.clear()
    await Promise.all(closing)
    this.listeners.clear()
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private syncRoots(): void {
    if (this.disposed) return
    const current = new Set(this.roots.getRoots().map((root) => root.rootPath))
    for (const rootPath of [...this.watches.keys()]) {
      if (!current.has(rootPath)) this.stopWatch(rootPath)
    }
    for (const rootPath of current) {
      if (!this.watches.has(rootPath)) this.startWatch(rootPath)
    }
  }

  private startWatch(rootPath: string): void {
    const timers = new Map<string, NodeJS.Timeout>()
    // Watch the ROOT (always exists) rather than `flow/<subdir>` directly —
    // see the file-header note on why a directly-watched, initially-missing
    // path never re-arms. `ignored` prunes everything outside
    // flow/{discovery,plans,brainstorms} before chokidar descends into it, so
    // this stays cheap even on a large repo.
    const watcher = watch(rootPath, {
      depth: WATCH_DEPTH,
      ignoreInitial: true,
      persistent: true,
      ignored: (path: string) => isOutsideArtifactSubdirs(rootPath, path),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    const known = new Map(scanArtifacts(rootPath).map((event) => [event.path, artifactSignature(event)]))
    const onFileEvent = (path: string, replayed = false): void => {
      // A walkthrough page's event is its doc's event: the card re-reads
      // whether the page exists, and an open feature view reloads it.
      const docPath = artifactDocFor(path)
      if (docPath === null) return
      const parts = relative(rootPath, docPath).split(sep)
      const kind = parts.length >= 2 ? deriveArtifactKind(parts[1]) : null
      if (kind) this.queueEmit(rootPath, kind, docPath, timers, known, replayed)
    }
    watcher.on('add', onFileEvent)
    watcher.on('change', onFileEvent)
    // Only a page's removal matters: its doc's card loses the feature-view
    // door. A removed doc keeps today's behaviour (no event; the emit's stat
    // would find nothing to report anyway).
    watcher.on('unlink', (path: string) => {
      if (isWalkthroughFile(path)) onFileEvent(path)
    })
    watcher.on('error', (error) => {
      console.error(`[ArtifactObserver] Watcher error for ${rootPath}:`, error)
    })
    const entry: RootArtifactWatch = { watcher, timers, link: null, known, onFileEvent }
    this.watches.set(rootPath, entry)
    // `flow/` itself replaced — provisioning moves it into the vault and leaves
    // a symlink — re-checks whether it now needs following (see armLinkWatch).
    const flowDir = join(rootPath, 'flow')
    watcher.on('all', (_event: string, path: string) => {
      if (path !== flowDir) return
      this.armLinkWatch(rootPath, entry, onFileEvent)
    })
    this.armLinkWatch(rootPath, entry, onFileEvent)
  }

  /**
   * Follow `<root>/flow` when it is a SYMLINK (a project linked into the
   * central vault: `flow -> ~/plan-flow/brain/projects/<p>/flow`). A root
   * watch that was running when the folder became a link never sees a write
   * behind it — every card for such a project went silent. The link's real
   * target is watched separately and its paths are reported under the root's
   * own `flow/`, so consumers cannot tell the difference. Both watches may
   * report one write; the per-path debounce in queueEmit makes it one event.
   */
  private armLinkWatch(
    rootPath: string,
    entry: RootArtifactWatch,
    onFileEvent: (path: string, replayed?: boolean) => void,
  ): void {
    if (this.disposed || this.watches.get(rootPath) !== entry) return
    const flowDir = join(rootPath, 'flow')
    let target: string | null = null
    try {
      if (fs.lstatSync(flowDir).isSymbolicLink()) target = fs.realpathSync(flowDir)
    } catch {
      // Missing or dangling — nothing behind the link to follow (yet).
      target = null
    }
    if (entry.link !== null && entry.link.target === target) return
    if (entry.link !== null) {
      const stale = entry.link.watcher
      entry.link = null
      stale.close().catch((error) => {
        console.error(`[ArtifactObserver] Failed to close link watcher for ${rootPath}:`, error)
      })
    }
    if (target === null) return
    const realFlow = target
    const asRootPath = (path: string): string => join(flowDir, relative(realFlow, path))
    const linkWatcher = watch(realFlow, {
      depth: WATCH_DEPTH - 1,
      ignoreInitial: true,
      persistent: true,
      ignored: (path: string) => isOutsideArtifactSubdirs(rootPath, asRootPath(path)),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    const forward = (path: string, replayed = false): void => onFileEvent(asRootPath(path), replayed)
    linkWatcher.on('add', forward)
    linkWatcher.on('change', forward)
    // A doc written while this watch was still starting is one chokidar counts
    // as initial and never reports. Offer every doc once it is ready; the
    // signature check (RootArtifactWatch.known) keeps the unchanged ones quiet.
    linkWatcher.on('ready', () => {
      for (const { dir: subdir } of ARTIFACT_SUBDIRS) {
        let names: string[]
        try {
          names = fs.readdirSync(join(realFlow, subdir))
        } catch {
          continue
        }
        for (const name of names) {
          const path = join(realFlow, subdir, name)
          if (isArtifactFile(path) || isWalkthroughFile(path)) forward(path, true)
        }
      }
    })
    linkWatcher.on('unlink', (path: string) => {
      if (isWalkthroughFile(path)) forward(path)
    })
    linkWatcher.on('error', (error) => {
      console.error(`[ArtifactObserver] Link watcher error for ${rootPath}:`, error)
    })
    entry.link = { target: realFlow, watcher: linkWatcher }
  }

  private stopWatch(rootPath: string): void {
    const entry = this.watches.get(rootPath)
    if (!entry) return
    this.watches.delete(rootPath)
    for (const timer of entry.timers.values()) clearTimeout(timer)
    entry.watcher.close().catch((error) => {
      console.error(`[ArtifactObserver] Failed to close watcher for ${rootPath}:`, error)
    })
    entry.link?.watcher.close().catch((error) => {
      console.error(`[ArtifactObserver] Failed to close link watcher for ${rootPath}:`, error)
    })
  }

  private queueEmit(
    rootPath: string,
    kind: FlowArtifactKind,
    path: string,
    timers: Map<string, NodeJS.Timeout>,
    known: Map<string, string>,
    replayed = false,
  ): void {
    const existing = timers.get(path)
    if (existing) clearTimeout(existing)
    // A real write within the debounce window wins over a re-listing of the same doc.
    const wasReplay = this.pendingReplay.get(path) ?? true
    this.pendingReplay.set(path, wasReplay && replayed)
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path)
        const asReplay = this.pendingReplay.get(path) === true
        this.pendingReplay.delete(path)
        this.emitChange(rootPath, kind, path, known, asReplay)
      }, REFRESH_DEBOUNCE_MS),
    )
  }

  private emitChange(
    rootPath: string,
    kind: FlowArtifactKind,
    path: string,
    known: Map<string, string>,
    replayed = false,
  ): void {
    let mtimeMs: number
    try {
      mtimeMs = fs.statSync(path).mtimeMs
    } catch {
      // Vanished between the debounced write and the stat — nothing to report.
      return
    }
    const event: FlowArtifactChangedEvent = {
      rootId: rootPath,
      kind,
      path: toPosix(relative(rootPath, path)),
      name: basename(path),
      mtime: mtimeMs,
      ...walkthroughStateFor(path),
      ...(replayed ? { replayed: true } : {}),
    }
    // Unchanged since last seen — a move or a re-listing, not a write.
    const signature = artifactSignature(event)
    if (known.get(event.path) === signature) return
    known.set(event.path, signature)
    for (const listener of this.listeners) listener(event)
  }
}

/**
 * Scan a root's three artifact subdirs for existing `.md` docs, returning one
 * FlowArtifactChangedEvent per doc (same shape the watcher emits). This is what
 * the renderer seeds its cards from on mount — the watcher runs `ignoreInitial`,
 * so pre-existing docs never arrive as live events after a reload. Fail-soft:
 * a missing subdir or unreadable file is skipped, never thrown.
 */
export function scanArtifacts(rootPath: string): FlowArtifactChangedEvent[] {
  const out: FlowArtifactChangedEvent[] = []
  for (const { dir, kind } of ARTIFACT_SUBDIRS) {
    const subdir = join(rootPath, 'flow', dir)
    let names: string[]
    try {
      names = fs.readdirSync(subdir)
    } catch {
      continue // subdir absent — nothing to surface
    }
    for (const name of names) {
      const full = join(subdir, name)
      if (!isArtifactFile(full)) continue
      let mtimeMs: number
      try {
        mtimeMs = fs.statSync(full).mtimeMs
      } catch {
        continue
      }
      out.push({
        rootId: rootPath,
        kind,
        path: toPosix(relative(rootPath, full)),
        name,
        mtime: mtimeMs,
        ...walkthroughStateFor(full),
      })
    }
  }
  return out
}

// ── Inline artifact markers (#1056) ───────────────────────────────────────

/**
 * Where a live artifact observation is durably recorded so the transcript can
 * render the doc's card INLINE at that position after a reload (see
 * shared/artifact-marker.ts). Implemented over ProjectContextManager +
 * ThreadStore in main/index.ts; injectable so the persist logic tests without
 * electron or a database.
 */
export interface ArtifactMarkerSink {
  /** The thread whose agent most recently WROTE this doc, or null (#1717).
   *  It is the ONLY owner a doc can have: a card lives in the conversation
   *  that made it. Attributing by "what was on screen" put one thread's
   *  discovery into another thread that merely had the same project open
   *  (live 2026-10-23), so a doc with no recorded writer gets no card.
   *  `observedAt` is the doc's mtime — what dates a shell write. */
  owningThreadFor(rootPath: string, path: string, observedAt: number): string | null
  /** The thread's own (primary) project root, or null when unknown. A doc
   *  observed under any OTHER root — a project attached to the thread — gets
   *  that root in its marker, so the card reads and opens it there. */
  primaryRootOf?(threadId: string): string | null
  /** True when `threadId` already carries a marker row with this content —
   *  the once-per-(thread, docPath) dedupe. */
  hasMarker(threadId: string, content: string): boolean
  /** Append the marker as a `system` row at the thread's transcript end. */
  append(threadId: string, content: string): void
}

/**
 * Build the per-event marker persister used by registerArtifactChannels: on a
 * live watcher event, record `[artifact] <kind> <path>` ONCE per
 * (thread, docPath) into the thread whose agent wrote the doc — and into no
 * other: a doc nobody's agent wrote (a hand edit, a re-listed folder) gets no
 * marker, never the thread that happens to be open. A doc in a project other than the thread's own carries that root
 * (`… @<root>`). An in-memory guard short-circuits repeat events within the
 * session before the store is queried. Fail-soft — a sink error is logged and
 * never breaks the broadcast path. Returns the thread the doc belongs to (or
 * null), which the broadcast carries so the renderer of THAT thread shows the
 * card even when the doc's project is not the active one. Exported for tests
 * (pure over the injected sink).
 */
export function makeMarkerPersister(
  sink: ArtifactMarkerSink | null | undefined,
): (event: FlowArtifactChangedEvent) => string | null {
  const recorded = new Set<string>()
  return (event: FlowArtifactChangedEvent): string | null => {
    if (!sink) return null
    try {
      // The WRITER owns the card (#1717), and nobody else does: no fallback
      // to the open thread, which is how a doc crossed conversations.
      const threadId = sink.owningThreadFor(event.rootId, event.path, event.mtime)
      if (threadId === null) return null
      const guardKey = `${threadId}\n${event.rootId}\n${event.path}`
      if (recorded.has(guardKey)) return threadId
      const primary = sink.primaryRootOf?.(threadId) ?? null
      const root = primary !== null && primary !== event.rootId ? event.rootId : undefined
      const content = formatArtifactMarker(event.kind, event.path, root)
      if (!sink.hasMarker(threadId, content)) sink.append(threadId, content)
      recorded.add(guardKey)
      return threadId
    } catch (error) {
      console.error('[ArtifactObserver] Failed to persist artifact marker:', error)
      return null
    }
  }
}

// ── IPC registration ──────────────────────────────────────────────────────

export interface ArtifactChannelDeps {
  /** Project roots provider (adapter over ProjectRegistry — see rootsProviderFrom). */
  roots: RootsProvider
  /** Optional pre-built observer (tests); defaults to one built from `roots`. */
  observer?: ArtifactObserver
  /** The app-embedded planflow-ai CLI, used to spawn `blueprint narrate`. Null/undefined
   *  disables `learn:narrate` (returns a fail-soft `{ ok: false }`). */
  bundledCli?: BundledCli | null
  /** Injectable CLI runner (tests). Defaults to runBundledCliCapturing. */
  runCli?: CliRunner
  /** Marker persistence for inline artifact cards (#1056). Absent/null keeps
   *  the watcher broadcast-only (harnesses, older callers). */
  markers?: ArtifactMarkerSink | null
}

/** Last non-empty line of a possibly multi-line success message. */
function lastNonEmptyLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.length > 0 ? lines[lines.length - 1] : null
}

/** `learn:narrate`'s response shape. */
export type NarrateResult = { ok: true; summary: string } | { ok: false; reason: string }

/**
 * Shape a `blueprint narrate` CliRunResult into the channel's response.
 * Success: the CLI's own `narrate: <plan> — N steps compiled[…]` stdout line.
 * Failure: the CLI's own refusal text, verbatim — the full stderr tail when
 * available (strict-mode refusals can list several violations, one per line),
 * falling back to the truncated last-line `error` for failures that never
 * wrote a stderr block (spawn error, timeout). Exported for tests — no
 * spawn/electron dependency needed to exercise this logic.
 */
export function parseNarrateResult(result: CliRunResult): NarrateResult {
  if (!result.ok) {
    const reason = (result.stderr ?? '').trim() || result.error || 'narrate failed'
    return { ok: false, reason }
  }
  return { ok: true, summary: lastNonEmptyLine(result.stdout) ?? 'narrate: done' }
}

/**
 * Implements the contract's `learn:narrate` invoke channel and pushes
 * `flow:artifactChanged` events to every window. Returns a dispose function
 * that unregisters the handler and stops the observer.
 */
export function registerArtifactChannels(deps: ArtifactChannelDeps): () => void {
  // Lazy require keeps this module importable from plain Node (harnesses);
  // typing stays exact via `typeof import('electron')`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ipcMain, BrowserWindow } = require('electron') as typeof import('electron')

  const observer = deps.observer ?? new ArtifactObserver(deps.roots)
  observer.start()

  const registeredChannels: IpcInvokeChannel[] = []

  /** Contract-typed ipcMain.handle (same pattern as flow-observer.ts). */
  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registeredChannels.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  function broadcast<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  }

  const runCli = deps.runCli ?? runBundledCliCapturing

  handle('flow:listArtifacts', ({ rootId }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { artifacts: [] }
    }
    return { artifacts: scanArtifacts(rootId) }
  })

  handle('learn:narrate', async ({ rootId, docPath }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { ok: false as const, reason: 'unknown project root' }
    }
    if (!deps.bundledCli) {
      return { ok: false as const, reason: 'narrate is unavailable — no bundled CLI configured' }
    }
    const result = await runCli(deps.bundledCli, rootId, ['blueprint', 'narrate', '--from', docPath])
    return parseNarrateResult(result)
  })

  const persistMarker = makeMarkerPersister(deps.markers)
  const onArtifactChanged = (event: FlowArtifactChangedEvent): void => {
    // #1056: pin the doc to its thread's transcript position so the card
    // renders inline (not in a bottom pile) on every future reload — FIRST, so
    // the broadcast can say whose doc it is: a doc written into a project
    // attached to a thread is not the active project's, and only its thread
    // may show it.
    const threadId = persistMarker(event)
    broadcast('flow:artifactChanged', threadId === null ? event : { ...event, threadId })
  }
  const unsubscribe = observer.on(onArtifactChanged)

  return function disposeArtifactChannels(): void {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel)
    }
    registeredChannels.length = 0
    unsubscribe()
    observer.dispose().catch((error) => {
      console.error('[ArtifactObserver] Dispose failed:', error)
    })
  }
}
