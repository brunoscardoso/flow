/**
 * Editor surface composition — wires the Monaco host, editor tab strip, and
 * file tree into the shell surfaces and exposes the EditorApi later phases
 * (TS LSP providers, inline diff review) build on.
 *
 * The coordinator calls `initEditor(surfaces)` once after boot:
 *   - surfaces.editor   ← tab strip over the (lazy) Monaco host
 *   - surfaces.fileTree ← per-root lazy tree over window.flow.project
 *
 * Keyboard: cmd/ctrl+S saves the active file via project:writeFile
 * (atomic on the main side); ctrl+Tab / ctrl+shift+Tab cycle tabs.
 */
import type * as Monaco from 'monaco-editor'

import type {
  OpenFileRef,
  OpenViewRef,
  ProjectContext,
  TabSet,
  ThreadScope,
} from '../../shared/ipc-contract'
import '../components'
import { buildSettingsButton, type ShellSurfaces } from '../shell'
import { applyAccentOverrides, ensureAccentProperty } from '../project-accent'
import { ambiguousAcrossRoots, disambiguateTabLabels } from './tab-labels'
import { registerConflictMergeEditor } from './conflict-merge-editor'
import { registerConflictSidePreview } from './conflict-side-preview'
import { parseConflicts } from './conflict-parser'
import { EditorTabs } from './editor-tabs'
import {
  fileChangedOnDiskToast,
  fileDeletedOnDiskToast,
  openFileFailedToast,
  saveFailedToast,
} from './editor-feedback'
import { FileTree } from './file-tree'
import { SearchPanel } from '../search/search-panel'
import { isMarkdownPath, previewToggleLabel } from './markdown-preview'
import { fileRefNotifyRoot, fileRefRoots } from './file-ref-roots'
import { fileUrl } from '../threads/file-path'
import { reconcileOpenTabs, shouldApplyReload } from './tab-reconcile'
import { UNTITLED_PREFIX, isUntitledPath } from './untitled'
import { MonacoHost, monacoNamespace } from './monaco-host'
import { highlightRange } from './range-highlight'
import { normalizeHighlightRange } from './range-highlight-model'
import { renderMarkdown } from '../threads/markdown-renderer'
import { isModalOverlayOpen } from '../modal-overlay'
import { runInWantedScope } from '../tab-scope-gate'
import {
  contentHash,
  decideDirtyRestore,
  decideLiveReopen,
  modelsToRelease,
} from './buffer-baseline'

/** Class used to hide a stacked editor-area view. `display:none !important` so it
 *  beats a view's OWN inline display (e.g. the merge editor's `display:flex`) —
 *  toggling `style.display` instead would delete that inline flex and collapse
 *  the view's layout (#618). Injected once. */
const VIEW_HIDDEN_CLASS = 'fl-editor-view-hidden'

/** How long a reveal-on-open waits for Monaco to swap in the target model before
 *  giving up quietly (the model swap after openFile can be async). */
const REVEAL_MODEL_SWAP_TIMEOUT_MS = 1000

let viewHiddenStyleInjected = false
function ensureViewHiddenStyle(): void {
  if (viewHiddenStyleInjected) return
  viewHiddenStyleInjected = true
  const style = document.createElement('style')
  style.textContent = `.${VIEW_HIDDEN_CLASS} { display: none !important; }`
  document.head.appendChild(style)
}

export interface OpenFileInfo {
  rootPath: string
  /** Root-relative path with '/' separators. */
  relPath: string
  /** Absolute path — the tab id and Monaco model key. */
  path: string
  binary: boolean
}

/**
 * A non-file view that opens as an editor-area tab (e.g. the Blueprint
 * view). The element is mounted once into the editor body and shown/hidden
 * as its tab activates — closing the tab hides it (state preserved), and
 * reopening the same id re-adds the tab. View tabs are never persisted as
 * open files and never dirty.
 */
export interface EditorViewDescriptor {
  /** Stable non-path id (convention: 'flow://<name>') — the tab id. */
  id: string
  label: string
  /** fl-icon name for the tab. */
  icon: string
  element: HTMLElement
  /**
   * Present when the view BELONGS TO A CONVERSATION'S TAB SET (a feature view,
   * the blueprint, the browser, the Changes tab): it is captured into the set,
   * closed when the conversation is switched away from, and rebuilt by the
   * restorer registered under `kind` when it is switched back to.
   *
   * Absent for views that are not about one conversation — the Tasks board,
   * Settings, a merge resolver — which stay open across every switch.
   */
  persist?: ViewPersistence
}

/** How a view in a tab set is captured — see `EditorViewDescriptor.persist`. */
export interface ViewPersistence {
  /** The restorer that rebuilds this view (`registerViewRestorer`). */
  kind: string
  /** The view's identity NOW — read whenever the set is captured. */
  state: () => OpenViewRef['state']
}

/** Whose tab set the editor is showing: a conversation, or (null) the project. */
export interface TabScope {
  rootPath: string
  threadId: string | null
}

/**
 * Rebuild one view of a tab set. Must open it WITHOUT revealing the editor or
 * taking focus (a restore is not a person's press), and returns the tab id it
 * opened — or null when the view can no longer be shown.
 */
export type ViewRestorer = (
  state: OpenViewRef['state'],
  scope: TabScope,
) => string | null | Promise<string | null>

export interface EditorApi {
  /** Open (or focus) a file addressed by project root + relative path. */
  openFile(rootPath: string, relPath: string): Promise<void>
  /** Open (or focus) a non-file view as an editor-area tab. */
  openView(view: EditorViewDescriptor): void
  /** Close a tab by absolute path; dirty buffers prompt before discarding. */
  closeFile(path: string): void
  /** Close whatever tab is active — file or view; no-op with none (#673). */
  closeActiveTab(): void
  /** Open an empty in-memory note in a tab (⌘N, #941). */
  newScratchNote(): Promise<void>
  /** Save the active file through project:writeFile (no-op when clean-less). */
  saveActiveFile(): Promise<void>
  /**
   * Sync an open buffer to content FLOW ITSELF just wrote to disk (the conflict
   * CodeLens resolve), as an undoable edit whose baseline moves with it — so the
   * tab stays clean and the app never warns about its own write (#1097).
   *
   * Callers must not hand-roll this: a raw `model.pushEditOperations` bumps the
   * version id, the tab goes dirty for content nobody typed, and the watcher
   * event for the app's own write then takes the dirty-tab branch and raises
   * "File changed on disk" mid-merge. Returns whether the buffer changed.
   */
  syncBufferFromDisk(path: string, content: string): boolean
  activeFile(): OpenFileInfo | null
  /**
   * Rebind the editor to a project (ADR-002): point the file tree at the
   * project's root, close all current tabs (without prompting — the outgoing
   * project's unsaved buffers were already persisted by the coordinator via
   * snapshotTabs/saveOpenFiles, #955), then reopen the project's saved tabs in
   * order, rehydrate its persisted dirty buffers, and activate its active
   * file. Overlapping switches are guarded by a token.
   */
  setActiveProject(context: ProjectContext, set?: TabSet, scope?: TabScope): Promise<void>
  /**
   * Swap the whole tab set within the active project — a conversation switch.
   * Closes every file tab and every view that belongs to a set (silently: the
   * coordinator captured them first), then rebuilds `set`. Views without
   * `persist` (the Tasks board, Settings) are left open.
   */
  switchTabSet(set: TabSet, scope: TabScope): Promise<void>
  /** Register how views of one `kind` are rebuilt when a tab set is restored. */
  registerViewRestorer(kind: string, restore: ViewRestorer): void
  /**
   * Forget a view entirely: close its tab if open and unmount its element. A
   * later `openView` under the same id mounts the element it is handed then —
   * which is what lets a surface release a view's resources (a feature view's
   * page) and rebuild it fresh when its set comes back.
   */
  disposeView(id: string): void
  /** Reset to the no-project empty state (last/active project removed, #323). */
  clearActiveProject(): void
  /** Snapshot the open tabs (in tab order), the active tab's relPath, and the
   *  unsaved buffer contents by absolute path (#955 — persisted per project so
   *  a switch never destroys typed work). */
  snapshotTabs(): TabSet
  /** Register a listener fired on any tab change (open, close, active switch). */
  onTabsChanged(listener: () => void): void
  /** Whether the editor holds any open tab (file OR view) — drives the shell's
   *  collapse-empty-editor layout (#675). */
  hasOpenTabs(): boolean
  /**
   * Whether ONE tab is open, by its id (a view id, or a file's absolute path).
   *
   * A view's element stays mounted after its tab is closed, so nothing outside
   * could tell "open" from "closed and remembered" — which a surface that
   * restores its own tab per conversation has to know (the Changes tab). Asked
   * of the tab strip, which is what activation is judged by everywhere else.
   */
  hasTab(id: string): boolean
  /** Configured Monaco namespace — attach LSP providers here (Phase 7). */
  monaco(): Promise<typeof Monaco>
  /** The single editor instance — attach widgets/decorations here (Phase 8). */
  editor(): Promise<Monaco.editor.IStandaloneCodeEditor>
  dispose(): void
}

export function initEditor(surfaces: ShellSurfaces): EditorApi {
  // ── Editor pane: tab strip over Monaco host ────────────────────────────
  const editorWrap = document.createElement('div')
  editorWrap.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;'

  const tabsEl = document.createElement('fl-tabs')
  // #1509: the docked terminal has its own <fl-tabs> (mounted by default since
  // #674), so a bare `fl-tabs .tab` selector counts terminal tabs as editor
  // tabs — and the terminal mounts asynchronously, so the miscount is a race.
  // This class is the editor strip's identity for anything that must count.
  tabsEl.classList.add('fl-editor-tabs')
  // Blueprint is opened from the status bar (flow:open-blueprint), not a tab-
  // strip action — the strip carries only real tabs and hides when empty.
  // Body: the Monaco host and any view elements are stacked absolutely so a
  // shown view fully covers the (hidden) editor surface beneath it.
  const bodyEl = document.createElement('div')
  bodyEl.style.cssText = 'flex:1;min-height:0;position:relative;'
  const hostEl = document.createElement('div')
  // Height only — MonacoHost sets its container's position itself.
  hostEl.style.cssText = 'height:100%;'
  bodyEl.appendChild(hostEl)
  // ── The editor's top bar ───────────────────────────────────────────────
  //
  // ONE ROW, TWO HALVES: the tabs on the left, and the controls that OPEN tabs
  // on the right. Those controls used to sit in the left rail beside Threads and
  // Files — a strip where nine icons did three different jobs, so pressing one
  // was a small gamble about where the result would appear. They belong on the
  // strip they add to (user, 2026-09-17: "we have the tabs here as well, so it
  // will be a way to manage the tabs").
  //
  // THE ROW OUTLIVES THE TABS. `fl-tabs` hides itself when empty, so mounting
  // the controls inside it would take them away exactly when the editor is
  // empty and somebody most wants to open something.
  const topBar = document.createElement('div')
  topBar.className = 'fl-editor-topbar'
  topBar.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:var(--fl-space-xs)',
    'min-height:32px',
    'padding-right:var(--fl-space-xs)',
    'border-bottom:1px solid var(--fl-color-border-subtle, #232529)',
  ].join(';')
  tabsEl.style.flex = '1 1 auto'
  tabsEl.style.minWidth = '0'
  topBar.appendChild(tabsEl)
  topBar.appendChild(buildViewActions())
  editorWrap.appendChild(topBar)
  editorWrap.appendChild(bodyEl)
  surfaces.editor.replaceChildren(editorWrap)

  const openFiles = new Map<string, OpenFileInfo>()
  // Open tabs whose backing file was deleted/renamed on disk while dirty (#294).
  // The save path guards on this so cmd+S can't silently resurrect the gone file.
  const deletedOnDisk = new Set<string>()
  // Open DIRTY tabs whose backing file changed on disk (#353). The save path guards
  // on this so cmd+S can't silently clobber the external edit; a clean tab reloads.
  const changedOnDisk = new Set<string>()
  /** Mounted non-file views by tab id (element stays mounted when closed). */
  const views = new Map<string, HTMLElement>()
  /** How each view that belongs to a tab set is captured, by tab id. */
  const viewPersist = new Map<string, ViewPersistence>()
  /** How views of each kind are rebuilt when a tab set is restored. */
  const viewRestorers = new Map<string, ViewRestorer>()
  /** True while a tab set's views are being rebuilt — a restore never
   *  reveals the editor (its layout is the person's, not the set's). */
  let restoringViews = false

  const host = new MonacoHost(hostEl, (path, dirty) => {
    tabs.setDirty(path, dirty)
  })

  // #1338: the app menu's Edit ▸ Undo / Redo / Select All, routed here by the
  // renderer entry when Monaco holds focus. They were dead clicks: Monaco 0.55
  // focuses an EditContext div, so Blink's own commands have no editable
  // target — while Cut/Copy/Paste kept working in the same buffer, which is
  // what made Edit ▸ Cut able to empty a file that Edit ▸ Undo could not
  // restore.
  document.addEventListener('flow:editor-edit-action', (event) => {
    const action = (event as CustomEvent<{ action: 'undo' | 'redo' | 'selectAll' }>).detail?.action
    if (action === undefined) return
    host.runEditAction(action)
  })

  const tabs = new EditorTabs(tabsEl, {
    onSelect: (id) => {
      activateTab(id)
    },
    onClose: (id) => {
      closeFile(id)
    },
  })

  // ── Markdown preview (#575) ──────────────────────────────────────────────
  // A `.md`/`.markdown` file can toggle between its Monaco source buffer and a
  // rendered preview. Preview mode is tracked per file path so switching tabs
  // restores each file's own mode; the toggle + pane always reflect the ACTIVE
  // tab. The preview renders from the LIVE buffer (host.getContent) so unsaved
  // edits show; it re-renders on every toggle/activate (no live-typing re-render).
  const previewOn = new Set<string>()

  // Scrollable overlay stacked over the Monaco host — same inset:0 pattern as the
  // non-file views.
  //
  // COVERING IT IS NOT ENOUGH, AND THAT IS WHY THE EDITOR IS HIDDEN BELOW.
  // Monaco's decorations and overlay widgets carry their own stacking, so an
  // opaque pane painted over them does not put them behind it: a preview of a
  // file with pending changes came up with the accept/reject bars and their
  // diff highlights drawn straight through the rendered markdown (user,
  // 2026-09-14). Out-stacking a widget layer is a race with somebody else's
  // z-index; hiding the subtree is not.
  const previewPane = document.createElement('div')
  previewPane.style.cssText = [
    'position:absolute',
    'inset:0',
    'display:none',
    'overflow:auto',
    'padding:var(--fl-space-lg) var(--fl-space-xl)',
    'background:var(--fl-color-surface)',
  ].join(';')
  bodyEl.appendChild(previewPane)

  // Floating toggle pill, top-right, above both the host and the preview pane.
  const previewToggle = document.createElement('fl-button')
  previewToggle.setAttribute('small', '')
  previewToggle.style.cssText = 'position:absolute;top:8px;right:12px;z-index:5;display:none;'
  const previewToggleLabelEl = document.createElement('span')
  previewToggle.appendChild(previewToggleLabelEl)
  bodyEl.appendChild(previewToggle)

  /** Render the active file's live buffer into the preview pane. */
  function renderPreviewPane(path: string): void {
    const text = host.getContent(path) ?? ''
    previewPane.replaceChildren(renderMarkdown(text))
    previewPane.scrollTop = 0
  }

  /** Sync the toggle visibility/label and the preview pane to the ACTIVE tab.
   *  Called after every tab mutation (open, close, activate, project switch). */
  function syncPreviewChrome(): void {
    const active = tabs.activeId
    const info = active ? openFiles.get(active) : undefined
    const isMdFile = !!active && !!info && !info.binary && isMarkdownPath(active)
    if (!isMdFile) {
      previewToggle.style.display = 'none'
      previewPane.style.display = 'none'
      showEditor(true)
      return
    }
    previewToggle.style.display = ''
    const on = previewOn.has(active)
    previewToggleLabelEl.textContent = previewToggleLabel(on)
    if (on) {
      renderPreviewPane(active)
      previewPane.style.display = 'block'
      showEditor(false)
    } else {
      previewPane.style.display = 'none'
      showEditor(true)
    }
  }

  /**
   * Hide or show the editor UNDER the preview.
   *
   * `visibility`, not `display`. Hiding the subtree takes its widgets with it,
   * which is the point — but `display:none` would also take away Monaco's
   * measured size, and it comes back to a zero-width layout that has to be
   * recomputed. Visibility keeps the box, so returning from a preview is the
   * same editor in the same place, still scrolled where it was.
   */
  function showEditor(visible: boolean): void {
    hostEl.style.visibility = visible ? '' : 'hidden'
  }

  /** Flip preview mode for the active markdown tab (toggle button + ⌘⇧V). */
  function toggleActivePreview(): void {
    const active = tabs.activeId
    const info = active ? openFiles.get(active) : undefined
    if (!active || !info || info.binary || !isMarkdownPath(active)) return
    if (previewOn.has(active)) {
      previewOn.delete(active)
    } else {
      previewOn.add(active)
    }
    syncPreviewChrome()
  }

  previewToggle.addEventListener('click', () => {
    toggleActivePreview()
  })

  // ── Tab-change notification (coordinator persists via saveOpenFiles) ─────
  const tabsChangedListeners: Array<() => void> = []
  // Suppressed during a programmatic project switch so partial mid-switch
  // states are not persisted; a single emit fires once the switch settles.
  let suppressTabsEvents = false
  // Monotonic switch token — a newer setActiveProject invalidates older ones.
  let switchToken = 0
  // Active project root — used to resolve raw file references from the chat.
  let activeRoot: string | null = null
  // Every root in the current thread scope — the content-search panel searches
  // across all of them. Empty until the first scope lands; the getRoots accessor
  // below falls back to the active root so search works pre-scope too.
  let searchScopeRoots: string[] = []
  /**
   * The open thread's OWN checkout, when it has one (thread-worktrees).
   *
   * ASKED AT CLICK TIME, not remembered from a broadcast. The first cut of this
   * listened to `flow:thread-worktree` and kept the answer in a variable — and
   * a click that arrived before the announce did resolved against the project
   * and opened the wrong copy. That is a race a user would hit and never be able
   * to describe, and it was caught only because the spec ran twice.
   *
   * The thread scope already decides this for the whole app — its primary root
   * IS `worktreePath ?? projectRoot` — so this asks it rather than keeping a
   * second, staler copy of the same fact (allowed-pattern #14). One extra IPC
   * per clicked file chip, which is a keypress-free user gesture.
   *
   * Fail-soft: an unreachable scope leaves the lookup exactly as it was before
   * any of this — the project, and nothing lost.
   */
  /**
   * Every checkout the open thread can reach, in scope order.
   *
   * ALL OF THEM, NOT THE PRIMARY. This took only `roots.find(primary)` and
   * dropped the rest, which is correct for a thread that works in one project
   * and wrong for every thread that reaches into more. `ThreadScope.roots` is
   * documented as the whole ordered set — primary first, then the additional
   * roots — and an agent may write in any of them, so a file created in the
   * second one was named in the chat and could not be opened.
   */
  async function threadCheckoutRoots(): Promise<string[]> {
    try {
      const scope = await window.flow.project.getThreadScope()
      if (scope.threadId === null) return []
      // Primary first even if the store ever hands them back unordered; the
      // rest keep the order the scope gave them.
      const primary = scope.roots.filter((entry) => entry.primary)
      const rest = scope.roots.filter((entry) => !entry.primary)
      return [...primary, ...rest].map((entry) => entry.rootPath).filter((path) => path !== '')
    } catch (error) {
      console.error('flow: could not read the thread scope for a file reference', error)
      return []
    }
  }

  /** Hide the tab strip entirely when there are no tabs — a clean, Zed-like
   *  empty editor (no thin empty bar). */
  function refreshTabStrip(): void {
    // The STRIP hides when empty; the row it lives in does not, because the
    // controls beside it are how a person opens the first tab.
    tabsEl.style.display = tabs.isEmpty ? 'none' : ''
  }

  function emitTabsChanged(): void {
    // Sync strip visibility on every tab mutation, even during a suppressed
    // project switch (only the persistence listeners are gated by suppress).
    refreshTabStrip()
    // The markdown-preview toggle + pane follow the active tab (#575) — a view
    // or non-md tab hides both, an md tab reflects its own preview mode.
    syncPreviewChrome()
    if (suppressTabsEvents) {
      return
    }
    for (const listener of tabsChangedListeners) {
      listener()
    }
  }

  // Start hidden — the editor opens with no tabs.
  refreshTabStrip()

  // ── File tree pane ─────────────────────────────────────────────────────
  const treeContainer = document.createElement('div')
  treeContainer.style.cssText = 'height:100%;min-height:0;'
  surfaces.fileTree.replaceChildren(treeContainer)

  const fileTree = new FileTree(treeContainer, (rootPath, relPath) => {
    void openFile(rootPath, relPath).catch((error) => {
      console.error('flow: failed to open file', { rootPath, relPath, error })
    })
  })
  void fileTree.init().catch((error) => {
    console.error('flow: failed to initialize file tree', error)
  })

  // ── Content-search pane ──────────────────────────────────────────────────
  // The Search rail's panel. It searches file CONTENTS across the current thread
  // scope's roots (falling back to the active project root before a scope lands),
  // and dispatches flow:open-file with a line on activation (jump-to-match).
  const searchContainer = document.createElement('div')
  searchContainer.style.cssText = 'height:100%;min-height:0;'
  surfaces.searchPanel.replaceChildren(searchContainer)
  const searchPanel = new SearchPanel(searchContainer, {
    searchContent: (request) => window.flow.project.searchContent(request),
    getRoots: () =>
      searchScopeRoots.length > 0 ? searchScopeRoots : activeRoot ? [activeRoot] : [],
  })
  // ⌘⇧F reveals the pane (shell.ts) and asks it to focus the input.
  document.addEventListener('flow:focus-search-input', () => searchPanel.focusInput())

  // ── Thread scope (multi-project threads Phase 3) ─────────────────────────
  // The tree consumes the thread-scope layer — the one scope source of truth
  // (allowed-pattern #14): initial paint from getThreadScope, live updates
  // from threadScopeChanged. Once the first scope lands, project switches
  // stop rebinding the tree directly (the scope layer re-derives on active
  // project change too); until then — and forever if the scope API is
  // unavailable (older preload, failed handler) — setActiveProject's
  // active-root binding keeps working exactly as before (fail-soft).
  let scopeDriven = false
  /** Non-primary scope roots (by rootPath) — their files' tabs carry the
   *  project accent dot + a full-path tooltip. Empty for single-root scopes,
   *  so today's tabs stay untouched (NFR1). */
  let secondaryScopeRoots = new Set<string>()

  /** Sync every open file tab's accent dot/tooltip to the current scope —
   *  a root can gain/lose "secondary" status on any thread switch. */
  function refreshTabAccents(): void {
    // #1482: whether a tab's relPath is shared with a file from another root is
    // a fact about the OPEN SET, not about the current thread's scope. The
    // tooltip used to fall back to the bare relPath the moment the scope stopped
    // calling the root "secondary" — and a bare `src/index.ts`, read in the
    // current project, names a different file that also exists.
    const ambiguous = ambiguousAcrossRoots(
      [...openFiles.values()].map((info) => ({
        id: info.path,
        relPath: info.relPath,
        rootPath: info.rootPath,
      })),
    )
    for (const info of openFiles.values()) {
      const secondary = secondaryScopeRoots.has(info.rootPath)
      tabs.setAccent(
        info.path,
        secondary ? ensureAccentProperty(info.rootPath) : undefined,
        // #991: the full path is the unambiguous channel — every file tab
        // carries it, not just the secondary-root ones that also get a dot.
        secondary || ambiguous.has(info.path) ? info.path : info.relPath,
      )
    }
  }

  /**
   * #991: two open files with the same basename rendered as identical tabs.
   * Re-derive every file tab's label from the CURRENT open set — a unique
   * basename stays bare, a colliding one grows the shortest distinguishing
   * path tail — and run it after every open/close so labels collapse back to
   * bare names when the collision goes away.
   */
  function refreshTabLabels(): void {
    const labels = disambiguateTabLabels(
      [...openFiles.values()].map((info) => ({
        id: info.path,
        relPath: info.relPath,
        // #1482: without the root, two repos' `src/index.ts` are one label.
        rootPath: info.rootPath,
      })),
    )
    for (const entry of labels) tabs.setLabel(entry.id, entry.label)
  }

  function applyThreadScope(scope: ThreadScope): void {
    scopeDriven = true
    searchScopeRoots = scope.roots.map((root) => root.rootPath)
    secondaryScopeRoots = new Set(
      scope.roots.filter((root) => !root.primary).map((root) => root.rootPath),
    )
    // Sync each scope root's user accent override into the renderer-wide
    // registry so the tab dots below (and every other var() consumer)
    // resolve the user's color, not the hash fallback.
    applyAccentOverrides(
      scope.roots.map((root) => ({ rootPath: root.rootPath, accentColor: root.accent ?? null })),
    )
    fileTree.setScope(scope)
    refreshTabAccents()
  }

  const projectApi = window.flow.project
  if (
    typeof projectApi.getThreadScope === 'function' &&
    typeof projectApi.onThreadScopeChanged === 'function'
  ) {
    projectApi.onThreadScopeChanged((scope) => {
      applyThreadScope(scope)
    })
    void projectApi
      .getThreadScope()
      .then((scope) => {
        applyThreadScope(scope)
      })
      .catch(() => {
        // Scope layer unavailable — the active-root fallback stays in charge.
      })
  }

  // Open-file requests from decoupled surfaces (e.g. the Blueprint feature
  // layer's file rows) — same document-event convention as flow:open-blueprint.
  document.addEventListener('flow:open-file', (event) => {
    const detail = (
      event as CustomEvent<{
        rootPath?: string
        relPath?: string
        revealConflictHunkId?: string
        /** 1-based line to reveal + select after opening (e.g. a search match). */
        line?: number
        /** 1-based column of the selection start on that line (default 1). */
        column?: number
        /** 1-based last line of a RANGE to reveal + highlight (with `line` as its
         *  first). Absent = the single-line jump every older caller gets. */
        endLine?: number
      }>
    ).detail
    if (!detail?.rootPath || !detail?.relPath) return
    const { rootPath, relPath, revealConflictHunkId, line, column, endLine } = detail
    void (async () => {
      try {
        await openFile(rootPath, relPath)
        // Optional: after the file is open + its model set, scroll the named
        // conflict hunk into view so the user reads it in context before deciding.
        // Reveal BY hunkId (content-derived, stable) so it survives line shifts,
        // and fail-soft — a missing model/block leaves the file open, never throws.
        if (revealConflictHunkId) {
          await revealConflictHunk(revealConflictHunkId, joinPath(rootPath, relPath))
        } else if (typeof line === 'number' && line > 0 && typeof endLine === 'number') {
          // A piece of code (the storyline's ↗): reveal the range centred and
          // mark it — see range-highlight.ts for when the mark goes away.
          await revealRange(line, endLine, joinPath(rootPath, relPath))
        } else if (typeof line === 'number' && line > 0) {
          // Jump-to-match: reveal + select the matching line (content search).
          // Same model-swap-safe path as revealConflictHunk — fail-soft.
          await revealLine(line, column, joinPath(rootPath, relPath))
        }
      } catch (error) {
        console.error('flow: failed to open file', { rootPath, relPath, error })
        // Console-only was the bug (#1118): a restored tab, git-panel row,
        // blueprint peek or thread file reference pointing into a project whose
        // folder vanished produced a dead click with zero user-visible feedback.
        dispatchEditorToast(rootPath, openFileFailedToast(relPath, error))
      }
    })()
  })

  /** Scroll the conflict hunk with the given content-derived id into view and
   *  briefly highlight it. Reuses the app's open-file + reveal pattern (one
   *  navigation path). Fail-soft: an absent model or unmatched hunk is a no-op.
   *
   *  Robust against an async model swap: openFile resolves before Monaco has
   *  necessarily swapped its active model to the just-opened file. We only reveal
   *  once the editor's current model IS the target path; if it isn't yet, we wait
   *  once for the next model change (bounded) and try again — never revealing into
   *  the wrong (previously-active) buffer, and giving up quietly on timeout. */
  async function revealConflictHunk(hunkId: string, expectedPath: string): Promise<void> {
    const editor = await host.editorInstance()
    const monaco = await monacoNamespace()
    const targetUriPath = monaco.Uri.file(expectedPath).path

    const attempt = (): 'revealed' | 'wrong-model' | 'no-block' => {
      const model = editor.getModel()
      if (!model || model.uri.path !== targetUriPath) return 'wrong-model'
      const block = parseConflicts(model.getValue()).find((candidate) => candidate.hunkId === hunkId)
      if (!block) return 'no-block'
      editor.revealLineInCenter(block.startLine)
      editor.setSelection(new monaco.Range(block.startLine, 1, block.endLine, 1))
      editor.focus()
      return 'revealed'
    }

    // Model already swapped (fast path) or right model but no matching block:
    // both are terminal — only a not-yet-swapped model warrants a retry.
    if (attempt() !== 'wrong-model') return

    await new Promise<void>((resolveWait) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        subscription.dispose()
        clearTimeout(timer)
        resolveWait()
      }
      const subscription = editor.onDidChangeModel(() => {
        if (editor.getModel()?.uri.path === targetUriPath) {
          attempt()
          finish()
        }
      })
      const timer = setTimeout(finish, REVEAL_MODEL_SWAP_TIMEOUT_MS)
    })
  }

  /** Scroll a specific 1-based line into view and place the cursor there — the
   *  content-search "jump to match" path. Shares revealConflictHunk's
   *  model-swap-safe retry: openFile can resolve before Monaco swaps the active
   *  model, so reveal only once the current model IS the target buffer, waiting
   *  once (bounded) for the swap otherwise. Fail-soft — never throws. */
  async function revealLine(line: number, column: number | undefined, expectedPath: string): Promise<void> {
    const editor = await host.editorInstance()
    const monaco = await monacoNamespace()
    const col = typeof column === 'number' && column > 0 ? column : 1
    await onTargetModel(editor, monaco.Uri.file(expectedPath).path, (model) => {
      // Clamp to the model's real line count — a stale match line must not throw.
      const targetLine = Math.min(Math.max(1, line), model.getLineCount())
      editor.revealLineInCenter(targetLine)
      editor.setSelection(new monaco.Range(targetLine, col, targetLine, col))
      editor.focus()
    })
  }

  /** Reveal lines `line..endLine` centred and highlight them (range-highlight.ts
   *  owns the mark and its calm clearing rule). Same model-swap-safe wait as
   *  revealLine; a range beyond the file is clamped, a reversed one swapped. */
  async function revealRange(line: number, endLine: number, expectedPath: string): Promise<void> {
    const editor = await host.editorInstance()
    const monaco = await monacoNamespace()
    await onTargetModel(editor, monaco.Uri.file(expectedPath).path, (model) => {
      const range = normalizeHighlightRange(line, endLine, model.getLineCount())
      if (range === null) return
      highlightRange(editor, monaco, range)
      editor.focus()
    })
  }

  /** Run `act` once the editor's current model IS `targetUriPath` — at once when
   *  it already is, else after the next matching model swap (bounded by
   *  REVEAL_MODEL_SWAP_TIMEOUT_MS, then given up quietly). Never acts on the
   *  previously-active buffer. */
  async function onTargetModel(
    editor: Monaco.editor.IStandaloneCodeEditor,
    targetUriPath: string,
    act: (model: Monaco.editor.ITextModel) => void,
  ): Promise<void> {
    const attempt = (): 'revealed' | 'wrong-model' => {
      const model = editor.getModel()
      if (!model || model.uri.path !== targetUriPath) return 'wrong-model'
      act(model)
      return 'revealed'
    }

    if (attempt() !== 'wrong-model') return

    await new Promise<void>((resolveWait) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        subscription.dispose()
        clearTimeout(timer)
        resolveWait()
      }
      const subscription = editor.onDidChangeModel(() => {
        if (editor.getModel()?.uri.path === targetUriPath) {
          attempt()
          finish()
        }
      })
      const timer = setTimeout(finish, REVEAL_MODEL_SWAP_TIMEOUT_MS)
    })
  }

  // A raw file reference clicked in the chat (markdown file links). The agent
  // often names a file by bare name or partial path (e.g. a flow/ artifact), so
  // resolve it against the project in main (flow/ dirs first, then a bounded
  // search). Notify — never open a phantom path or spam ENOENT — when unfound.
  document.addEventListener('flow:open-file-path', (event) => {
    const detail = (
      event as CustomEvent<{
        path?: string
        rootPath?: string
        preview?: boolean
        /** Where to open it. Absent means the editor, as it always has. */
        as?: 'browser'
      }>
    ).detail
    const raw = detail?.path?.trim()
    if (!raw) return
    // THE THREAD'S OWN CHECKOUT COUNTS AS A PLACE TO LOOK. A file an agent
    // wrote while working in a thread's worktree is not in the project
    // directory, and asking only the project answered "File not found" about a
    // file that was right there. `fileRefRoots` says which checkouts to ask and
    // in what order; it asks once when there is only one, which is every thread
    // that works in the project itself.
    void (async () => {
      try {
        const refInput = {
          requested: detail?.rootPath ?? null,
          threadRoots: await threadCheckoutRoots(),
          activeRoot,
        }
        const roots = fileRefRoots(refInput)
        if (roots.length === 0) return
        for (const rootPath of roots) {
          const { relPath } = await window.flow.project.resolveFileRef({ rootPath, ref: raw })
          if (!relPath) continue
          // THE SAME RESOLUTION, A DIFFERENT DESTINATION. A generated page is
          // meant to be looked at, so the chat's chip asks for the browser — and
          // it asks HERE rather than resolving a path of its own, because what
          // `docs/x.html` means is a question only this handler can answer
          // (allowed-pattern #14).
          if (detail?.as === 'browser') {
            document.dispatchEvent(
              new CustomEvent('flow:open-browser', {
                detail: { url: fileUrl(rootPath, relPath) },
              }),
            )
            return
          }
          // `preview: true` opens markdown straight into the rendered preview
          // (artifact-card click UX, user call 2026-07-27) — non-md ignores it.
          if (detail?.preview === true && isMarkdownPath(relPath)) {
            previewOn.add(relPath)
          }
          await openFile(rootPath, relPath)
          syncPreviewChrome()
          return
        }
        // Unfound in every checkout that could have held it.
        document.dispatchEvent(
          new CustomEvent('flow:notify', {
            detail: {
              kind: 'state-change',
              rootId: fileRefNotifyRoot(refInput) ?? roots[0],
              title: 'File not found',
              // WHAT WAS ACTUALLY SEARCHED. "in this project" was a lie
              // whenever more than one checkout was asked — and the thread that
              // reported this bug spanned three, so the message named the one
              // project the file was NOT in.
              body:
                roots.length === 1
                  ? `Couldn’t locate ${raw} in this project.`
                  : `Couldn’t locate ${raw} in this project or in the ${roots.length - 1} other ${roots.length === 2 ? 'place' : 'places'} this thread works.`,
              timestamp: new Date().toISOString(),
              level: 'error',
            },
          }),
        )
      } catch (error) {
        console.error('flow: failed to open referenced file', { raw, activeRoot, error })
      }
    })()
  })

  // Reconcile open tabs when their file is renamed/deleted on disk (#294). The
  // editor was the outlier surface that ignored file events, so an open tab kept
  // a stale path + content and cmd+S silently recreated the gone file. A rename
  // arrives as delete(old)+create(new), so acting on 'deleted' covers both.
  window.flow.project.onFileChanged(({ changes }) => {
    const actions = reconcileOpenTabs(changes, new Set(openFiles.keys()), (p) => host.isDirty(p))
    for (const path of actions.clearDeleted) deletedOnDisk.delete(path)
    for (const path of actions.markDeleted) {
      if (deletedOnDisk.has(path)) continue
      deletedOnDisk.add(path)
      const info = openFiles.get(path)
      if (info) dispatchEditorToast(info.rootPath, fileDeletedOnDiskToast(info.relPath))
    }
    // Clean tabs for a gone file have nothing to lose — close them.
    for (const path of actions.close) closeFile(path)
    // A clean tab whose file changed on disk (agent/external edit) reloads to the
    // new content instead of showing stale text + clobbering it on save (#353).
    for (const path of actions.reload) void reloadTab(path)
    // A DIRTY tab can't be reloaded without losing edits — flag it so the save path
    // prompts before overwriting the external change, and tell the user.
    for (const path of actions.markChangedOnDisk) {
      if (changedOnDisk.has(path)) continue
      changedOnDisk.add(path)
      const info = openFiles.get(path)
      if (info) dispatchEditorToast(info.rootPath, fileChangedOnDiskToast(info.relPath))
    }
  })

  /**
   * Sync an open buffer to content FLOW ITSELF just wrote (#1097) — see the
   * EditorApi doc. Beyond the model edit + clean baseline (`applyDiskContent`),
   * this clears any `changedOnDisk` flag: the buffer now matches disk, so a
   * flag raised by an earlier event for the same write must not survive to
   * make the next ⌘S ask permission to "overwrite the newer version".
   */
  function syncBufferFromDisk(path: string, content: string): boolean {
    if (!openFiles.has(path)) return false
    const applied = host.applyDiskContent(path, content)
    changedOnDisk.delete(path)
    if (previewOn.has(path) && tabs.activeId === path) renderPreviewPane(path)
    return applied
  }

  /** Re-read a clean tab's file and reload its buffer, preserving view state (#353).
   *  No-op if the tab closed meanwhile, the file is binary, or content is unchanged. */
  async function reloadTab(path: string): Promise<void> {
    const info = openFiles.get(path)
    if (!info) return
    try {
      const file = await window.flow.project.readFile({
        rootPath: info.rootPath,
        relPath: info.relPath,
      })
      // The clean/dirty decision was made synchronously at reconcile time, but the
      // read above is async. If the user typed during that window the tab is now
      // dirty — DON'T reload (it would silently clobber the edit); fall through to
      // the dirty-tab path: flag + toast so a save guards the external change (#357).
      if (openFiles.has(path) && !file.binary && host.isDirty(path)) {
        if (!changedOnDisk.has(path)) {
          changedOnDisk.add(path)
          dispatchEditorToast(info.rootPath, fileChangedOnDiskToast(info.relPath))
        }
        return
      }
      if (!shouldApplyReload(openFiles.has(path), file.binary, host.isDirty(path))) return
      const reloaded = host.reloadFromDisk(path, file.content)
      changedOnDisk.delete(path) // now in sync with disk
      // #588: reloadFromDisk mutates the Monaco model in place and emits no tab
      // event, so a rendered Markdown preview would stay frozen on the pre-edit
      // content. Agents rewrite .md files (plans/docs) under the user constantly —
      // refresh the preview when this is the actively-previewed tab.
      if (reloaded && previewOn.has(path) && tabs.activeId === path) {
        renderPreviewPane(path)
      }
    } catch (error) {
      console.warn('flow: failed to reload changed file', { path, error })
    }
  }

  /** Dispatch an editor toast through the flow:notify → NotificationCenter bridge. */
  function dispatchEditorToast(rootId: string, toast: { title: string; body: string; level: 'info' | 'error' }): void {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId,
          title: toast.title,
          body: toast.body,
          timestamp: new Date().toISOString(),
          level: toast.level,
        },
      }),
    )
  }

  // ── Actions ────────────────────────────────────────────────────────────

  /**
   * A person's open (anything but a tab-set restore, which passes
   * `reveal:false`) is filed into the conversation it was pressed in: held while
   * a switch is still bringing that conversation's set on screen, so it never
   * lands in the set being left.
   */
  async function openFile(
    rootPath: string,
    relPath: string,
    options: { reveal?: boolean } = {},
  ): Promise<void> {
    if (options.reveal === false) return openFileNow(rootPath, relPath, options)
    await runInWantedScope(() => openFileNow(rootPath, relPath, options))
  }

  async function openFileNow(
    rootPath: string,
    relPath: string,
    options: { reveal?: boolean } = {},
  ): Promise<void> {
    // Reveal the editor area FIRST if the user hid it (⌘⌥D) — every user
    // file-open source (Files tree, ⌘P quick-open, flow:open-file,
    // flow:open-file-path, blueprint rows) funnels through here, and opening
    // into a detached host is a completely dead click (#1057). Revealed BEFORE
    // the open so Monaco's model swap lands in an attached node, matching the
    // Blueprint/Board which dispatch flow:show-editor before their tabs.
    // Project-switch rehydration passes reveal:false — restoring a project's
    // saved tabs must not override its persisted editorVisible:false layout.
    if (options.reveal !== false) {
      document.dispatchEvent(new CustomEvent('flow:show-editor'))
    }
    const path = joinPath(rootPath, relPath)
    if (!openFiles.has(path)) {
      const file = await window.flow.project.readFile({ rootPath, relPath })
      // Re-check: a second click may have raced this read.
      if (!openFiles.has(path)) {
        // ONE BUFFER PER FILE: a model still alive from another conversation's
        // set (kept because it is dirty) is reused, not replaced — see
        // `reconcileLiveBuffer` for what the fresh read says about it.
        const wasLive = host.hasModel(path)
        await host.open(path, file.content, file.binary, file.tooLarge ?? false)
        openFiles.set(path, { rootPath, relPath, path, binary: file.binary })
        tabs.add(path, lastSegment(relPath))
        if (wasLive) reconcileLiveBuffer(path, rootPath, relPath, file)
        // Secondary-root files (multi-project threads) get their project
        // accent dot + full-path tooltip from the moment the tab opens.
        refreshTabAccents()
        refreshTabLabels()
        emitTabsChanged()
      }
    }
    activateTab(path)
    // Announce that a file now occupies the editor area, so overlays covering it
    // (the git diff view) can step aside — otherwise a just-opened file stays hidden
    // behind a stale diff (#345). Every open source (Files tree, flow:open-file,
    // blueprint rows) funnels through here, so one signal covers them all.
    document.dispatchEvent(new CustomEvent('flow:editor-file-opened', { detail: { path } }))
  }

  /**
   * A live buffer was just given a tab again, and the disk read beside it. The
   * tab strip learns its dirty state (the host only reports CHANGES), and a
   * disk that moved on while no tab held it is honoured: a clean buffer
   * reloads, a dirty one is flagged so ⌘S asks before overwriting.
   */
  function reconcileLiveBuffer(
    path: string,
    rootPath: string,
    relPath: string,
    file: { content: string; binary: boolean; tooLarge?: boolean },
  ): void {
    tabs.setDirty(path, host.isDirty(path))
    if (file.binary || file.tooLarge === true) return
    const decision = decideLiveReopen({
      dirty: host.isDirty(path),
      baseline: host.baselineOf(path),
      disk: contentHash(file.content),
    })
    if (decision === 'reload') host.reloadFromDisk(path, file.content)
    else if (decision === 'flag-changed-on-disk') flagChangedOnDisk(path, rootPath, relPath)
  }

  /** Mark a dirty tab whose file changed on disk (#353) and say so, once. */
  function flagChangedOnDisk(path: string, rootPath: string, relPath: string): void {
    if (changedOnDisk.has(path)) return
    changedOnDisk.add(path)
    dispatchEditorToast(rootPath, fileChangedOnDiskToast(relPath))
  }

  // ── Non-file views (editor-area tabs like Blueprint) ────────────────────

  function hideAllViews(): void {
    for (const element of views.values()) {
      element.classList.add(VIEW_HIDDEN_CLASS)
    }
  }

  function openView(view: EditorViewDescriptor): void {
    let element = views.get(view.id)
    if (!element) {
      element = view.element
      // Position the stacked view WITHOUT touching its `display` — some views set
      // their own layout display inline (the merge editor's flex column). Visibility
      // is toggled by VIEW_HIDDEN_CLASS (display:none !important), never style.display,
      // so a view's own inline display survives being shown again (#618).
      ensureViewHiddenStyle()
      element.style.position = 'absolute'
      element.style.inset = '0'
      element.style.background = 'var(--fl-color-surface)'
      element.classList.add(VIEW_HIDDEN_CLASS)
      bodyEl.appendChild(element)
      views.set(view.id, element)
    }
    // Same reveal as openFile (#1057): a view tab must never open into a hidden
    // host. Callers (Blueprint, Board) no longer have to remember to dispatch it.
    // A tab-set restore is not a person opening something, so it never reveals.
    if (!restoringViews) document.dispatchEvent(new CustomEvent('flow:show-editor'))
    if (view.persist !== undefined) viewPersist.set(view.id, view.persist)
    else viewPersist.delete(view.id)
    if (!tabs.has(view.id)) {
      tabs.add(view.id, view.label, view.icon)
      emitTabsChanged()
    } else {
      // Reopening an open view is how a view renames itself (the Changes tab's
      // label IS its mode). Without this the descriptor's label was dropped and
      // the tab kept the name it was first opened with. No-op when unchanged.
      tabs.setLabel(view.id, view.label)
    }
    activateTab(view.id)
  }

  function activateTab(path: string): void {
    const viewElement = views.get(path)
    if (viewElement) {
      hideAllViews()
      viewElement.classList.remove(VIEW_HIDDEN_CLASS)
      tabs.setActive(path)
      emitTabsChanged()
      return
    }
    if (host.activePath !== path && !host.show(path)) {
      return
    }
    hideAllViews()
    tabs.setActive(path)
    emitTabsChanged()
  }

  /**
   * Close every open tab without the dirty-confirm prompt. Used by
   * setActiveProject/clearActiveProject — a programmatic switch, not a user
   * close. Unsaved buffers are NOT lost (#955): the project-context
   * coordinator persists them (snapshotTabs → saveOpenFiles) before the
   * teardown, and setActiveProject rehydrates them on the way back in.
   * Emission is caller-controlled.
   */
  function closeAllTabsSilently(keepModels = false): void {
    for (const path of [...openFiles.keys()]) {
      tabs.remove(path)
      // A conversation switch keeps the MODELS (undo history, cursor, and the
      // one buffer of a dirty file); the rebuild releases the ones its set
      // does not want. A scratch note always goes — it belongs to one set and
      // comes back from that set's snapshot.
      if (!keepModels || isUntitledPath(path)) host.close(path)
      openFiles.delete(path)
      deletedOnDisk.delete(path)
      changedOnDisk.delete(path)
      previewOn.delete(path)
    }
    tabs.setActive(null)
    host.showNone()
    refreshTabStrip()
    syncPreviewChrome()
  }

  function closeFile(path: string): void {
    // View tab: remove the tab and hide the element — the element (and its
    // state) stays mounted so reopening the view is instant.
    const viewElement = views.get(path)
    if (viewElement) {
      // A view's element STAYS MOUNTED after its tab is closed, so `views.get`
      // keeps answering for a view nobody has open. Without this guard, closing
      // an already-closed view removed a tab that is not there and emitted a
      // tabs-changed for nothing — which matters now that a view can be closed
      // programmatically (the Changes tab, when the conversation switches) and
      // not only by a click on a tab that visibly exists.
      if (!tabs.has(path)) return
      const wasActive = tabs.activeId === path
      const neighbor = tabs.neighborOf(path)
      tabs.remove(path)
      viewElement.classList.add(VIEW_HIDDEN_CLASS)
      if (wasActive) {
        if (neighbor) {
          activateTab(neighbor)
        } else {
          tabs.setActive(null)
          host.showNone()
        }
      }
      emitTabsChanged()
      return
    }
    const info = openFiles.get(path)
    if (!info) {
      return
    }
    if (host.isDirty(path)) {
      const discard = window.confirm(`Discard unsaved changes in ${info.relPath}?`)
      if (!discard) {
        return
      }
    }
    // The visually active tab may be a view while this file still holds the
    // Monaco model — activation is judged by the tab strip, not the host.
    const wasActive = tabs.activeId === path
    const neighbor = tabs.neighborOf(path)
    tabs.remove(path)
    host.close(path)
    openFiles.delete(path)
    deletedOnDisk.delete(path)
    changedOnDisk.delete(path)
    previewOn.delete(path)
    // #991: a closed file can end a basename collision — the survivor collapses
    // back to its bare name instead of keeping a now-pointless path tail.
    refreshTabLabels()
    if (wasActive) {
      if (neighbor) {
        activateTab(neighbor)
      } else {
        tabs.setActive(null)
        host.showNone()
      }
    }
    emitTabsChanged()
  }

  async function saveFile(path: string): Promise<void> {
    const info = openFiles.get(path)
    if (!info || info.binary || !host.isDirty(path)) {
      return
    }
    // #941: a scratch note has no disk path yet — it saves through saveUntitled.
    if (isUntitled(path)) {
      await saveUntitled(path)
      return
    }
    const content = host.getContent(path)
    if (content === null) {
      return
    }
    // The file was deleted/renamed on disk while this tab stayed dirty (#294) —
    // don't silently resurrect it; make recreation an explicit choice.
    if (deletedOnDisk.has(path)) {
      const recreate = window.confirm(
        `${info.relPath} was deleted or renamed on disk. Recreate it with your changes?`,
      )
      if (!recreate) {
        return // keep the buffer dirty; nothing typed is lost
      }
      deletedOnDisk.delete(path)
    }
    // The file changed on disk while this tab was dirty (#353) — don't silently
    // clobber the external edit; make overwriting an explicit choice.
    if (changedOnDisk.has(path)) {
      const overwrite = window.confirm(
        `${info.relPath} changed on disk. Overwrite the newer version with your changes?`,
      )
      if (!overwrite) {
        return // keep the buffer dirty; nothing typed is lost
      }
      changedOnDisk.delete(path)
    }
    try {
      await window.flow.project.writeFile({
        rootPath: info.rootPath,
        relPath: info.relPath,
        content,
      })
      host.markSaved(path)
    } catch (error) {
      console.error('flow: failed to save file', { path, error })
      // Surface it — a lingering dirty dot reads as "unsaved edits", not "your
      // save just failed", so a silent failure is a data-loss trap (#195). The
      // buffer stays dirty (we rethrow), so nothing typed is lost.
      dispatchEditorToast(info.rootPath, saveFailedToast(info.relPath, error))
      throw error
    }
  }

  function cycleTab(offset: 1 | -1): void {
    const next = tabs.cycle(offset)
    if (next) {
      activateTab(next)
    }
  }

  // ── Project scoping (ADR-002) ────────────────────────────────────────────

  async function setActiveProject(context: ProjectContext, set?: TabSet, scope?: TabScope): Promise<void> {
    const token = ++switchToken
    activeRoot = context.rootPath
    // Scope-driven trees follow project:threadScopeChanged instead — the
    // scope layer re-derives on active-project change, so rebinding here too
    // would clobber multi-root sections with a single root.
    if (!scopeDriven) {
      fileTree.setActiveRoot(context.rootPath)
    }
    await rebuildTabs(
      token,
      false,
      set ?? {
        openFiles: context.openFiles,
        activeFile: context.activeFile,
        dirtyBuffers: context.dirtyBuffers,
        openViews: [],
      },
      scope ?? { rootPath: context.rootPath, threadId: null },
    )
  }

  async function switchTabSet(set: TabSet, scope: TabScope): Promise<void> {
    // Same project: the models stay alive across the switch (see rebuildTabs).
    await rebuildTabs(++switchToken, true, set, scope)
  }

  function disposeView(id: string): void {
    const element = views.get(id)
    if (element === undefined) return
    if (tabs.has(id)) closeFile(id)
    views.delete(id)
    viewPersist.delete(id)
    element.remove()
  }

  /**
   * Close every view that belongs to a tab set, WITHOUT emitting — the
   * coordinator captured them before asking for a switch. Views without
   * `persist` (the Tasks board, Settings) are about no conversation and stay.
   */
  function closeScopedViewsSilently(): void {
    for (const id of tabs.ids) {
      if (!viewPersist.has(id)) continue
      const element = views.get(id)
      tabs.remove(id)
      element?.classList.add(VIEW_HIDDEN_CLASS)
    }
  }

  /**
   * Replace the tab strip's contents with `set` (ADR-002 project switch, and a
   * conversation switch within one project). Only the winning switch (`token`)
   * lifts the suppression and emits the settled state.
   *
   * `keepModels` (a conversation switch): the outgoing tabs' MODELS are not
   * disposed with their tabs. A file both sets hold keeps its undo history and
   * cursor; a dirty file's model stays alive even when the incoming set does not
   * hold it, because it is that file's ONE buffer — a set that opens the file
   * gets it, rather than a second copy that diverges and whose save reverts the
   * other's. Whatever the rebuilt set does not want, and is not a dirty file, is
   * released at the end.
   */
  async function rebuildTabs(token: number, keepModels: boolean, set: TabSet, scope: TabScope): Promise<void> {
    suppressTabsEvents = true
    // The model INSTANCES alive before the set is rebuilt — a snapshot taken
    // from one of them is older than the buffer itself.
    const liveBefore = new Map(host.livePaths().map((path) => [path, host.modelIdOf(path)]))
    // Views that belong to no conversation survive the switch — remember which
    // one was active so it can be re-activated when the set names nothing.
    const activeViewBefore =
      tabs.activeId !== null && views.has(tabs.activeId) && !viewPersist.has(tabs.activeId)
        ? tabs.activeId
        : null
    try {
      closeAllTabsSilently(keepModels)
      closeScopedViewsSilently()
      hideAllViews()
      // #1441: where each restored ref ended up, so the persisted activeFile
      // (a display name) can be resolved back to a tab id — a note's id is its
      // synthetic `untitled:N`, not a path under the root.
      const restoredPathByName = new Map<string, string>()
      // #1481: the tab id the ACTIVE ref resolved to, whatever root it came from.
      let activeFromRef: string | null = null
      for (const ref of set.openFiles) {
        // A newer switch supersedes this one — stop issuing stale opens.
        if (token !== switchToken) {
          return
        }
        if (ref.untitled === true) {
          const notePath = await restoreScratchNote(ref)
          if (notePath !== null) {
            restoredPathByName.set(ref.relPath, notePath)
            if (ref.active === true) activeFromRef = notePath
          }
          continue
        }
        // reveal:false — restoring saved tabs must not override the project's
        // persisted editorVisible:false layout (#1057 scopes to USER opens).
        await openFile(ref.rootPath, ref.relPath, { reveal: false }).catch((error) => {
          console.error('flow: failed to open project file', { ref, error })
        })
        if (ref.active === true) activeFromRef = joinPath(ref.rootPath, ref.relPath)
      }
      if (token !== switchToken) {
        return
      }
      // #955: rehydrate the set's persisted unsaved buffers — the tab set
      // comes back AND the typed-but-unsaved text comes back dirty with it.
      // The host guards in code (binary / already-dirty / identical content
      // are no-ops), so a buffer that matches disk simply stays clean.
      //
      // A snapshot taken FROM a model that is still alive is NOT restored: that
      // model is newer than the snapshot (it may have been saved from another
      // conversation since), and applying the snapshot would make the next ⌘S
      // revert that save. A model that merely exists for the path (opened fresh
      // this run) does not absorb an older run's snapshot — that one is owed. A snapshot typed over content the disk no longer
      // holds comes back, but flagged — the same changed-on-disk guard a dirty
      // tab gets from the watcher, so a save asks first.
      const captured = new Map<string, OpenFileRef>()
      for (const ref of set.openFiles) {
        if (ref.untitled !== true) captured.set(joinPath(ref.rootPath, ref.relPath), ref)
      }
      for (const [path, content] of Object.entries(set.dirtyBuffers)) {
        const info = openFiles.get(path)
        if (info === undefined) continue
        const ref = captured.get(path)
        const decision = decideDirtyRestore({
          wasLive:
            ref?.dirtyModel !== undefined &&
            liveBefore.get(path) === ref.dirtyModel &&
            host.modelIdOf(path) === ref.dirtyModel,
          capturedBaseline: ref?.dirtyBaseline,
          diskBaseline: host.baselineOf(path),
        })
        if (decision === 'keep-live') continue
        host.restoreDirtyContent(path, content)
        if (decision === 'restore-changed-on-disk' && host.isDirty(path)) {
          flagChangedOnDisk(path, info.rootPath, info.relPath)
        }
      }
      // The set's views, rebuilt lazily by the surface that owns each kind.
      let activeView: string | null = null
      for (const ref of set.openViews) {
        if (token !== switchToken) return
        const restore = viewRestorers.get(ref.kind)
        if (restore === undefined) continue
        restoringViews = true
        try {
          const id = await restore(ref.state, scope)
          if (id !== null && ref.active === true) activeView = id
        } catch (error) {
          console.error('flow: failed to restore a view tab', { kind: ref.kind, error })
        } finally {
          restoringViews = false
        }
      }
      if (token !== switchToken) return
      // #1481: prefer the ref that says it was active — it carries its own root.
      // `set.activeFile` is the legacy pointer (a bare relPath joined to the
      // ACTIVE project's root): right for a single-root project, wrong for a file
      // from any other root, and all that rows written before this have.
      if (activeView !== null && tabs.has(activeView)) {
        activateTab(activeView)
      } else if (activeFromRef !== null && openFiles.has(activeFromRef)) {
        activateTab(activeFromRef)
      } else if (set.activeFile !== null && openFiles.size > 0) {
        // activeFile is a display name; for a restored note that name maps to a
        // synthetic id, never to a path under the root (#1441).
        const activePath =
          restoredPathByName.get(set.activeFile) ?? joinPath(scope.rootPath, set.activeFile)
        if (openFiles.has(activePath)) {
          activateTab(activePath)
        }
      } else if (activeViewBefore !== null && tabs.has(activeViewBefore)) {
        activateTab(activeViewBefore)
      } else if (tabs.activeId === null) {
        // Nothing named active: show the first tab rather than an empty body
        // under a populated strip.
        const first = tabs.ids[0]
        if (first !== undefined) activateTab(first)
      }
    } finally {
      // Only the winning switch lifts suppression and emits the settled state.
      if (token === switchToken) {
        // Let go of the models this set does not hold — except a dirty file's,
        // which is that file's only buffer (see above).
        const open = new Set(openFiles.keys())
        for (const path of modelsToRelease({
          live: host.livePaths(),
          open,
          isDirty: (candidate) => host.isDirty(candidate),
          isUntitled: isUntitledPath,
        })) {
          host.close(path)
        }
        suppressTabsEvents = false
        emitTabsChanged()
      }
    }
  }

  /** Reset the editor to the no-project state (#323): close all file tabs and
   *  point the file tree at nothing. Used when the last/active project is removed
   *  and there is no project left to rebind to. */
  function clearActiveProject(): void {
    const token = ++switchToken
    activeRoot = null
    if (!scopeDriven) {
      fileTree.setActiveRoot(null)
    }
    suppressTabsEvents = true
    try {
      closeAllTabsSilently()
      closeScopedViewsSilently()
      hideAllViews()
    } finally {
      if (token === switchToken) {
        suppressTabsEvents = false
        emitTabsChanged()
      }
    }
  }

  function snapshotTabs(): TabSet {
    // View tabs have no OpenFileInfo; the ones that belong to a set are
    // captured below by their own `persist.state()`.
    const refs: OpenFileRef[] = []
    const openViews: OpenViewRef[] = []
    // Unsaved buffer contents by absolute path (#955): captured alongside the
    // tab set so a project switch can restore the typed work, not just the tabs.
    const dirtyBuffers: Record<string, string> = {}
    const activeId = tabs.activeId
    for (const id of tabs.ids) {
      const persist = viewPersist.get(id)
      if (persist !== undefined) {
        try {
          openViews.push({
            kind: persist.kind,
            state: persist.state(),
            ...(id === activeId ? { active: true } : {}),
          })
        } catch (error) {
          console.error('flow: could not capture a view tab', { id, error })
        }
        continue
      }
      const info = openFiles.get(id)
      if (info) {
        // #1441: a scratch note is persisted AS a note. It used to go in as an
        // ordinary `{rootPath, relPath: 'Untitled-3'}` — a file ref for a path
        // that exists nowhere — so restore's readFile ENOENT'd and both the tab
        // and the text under `untitled:3` were dropped without a word.
        // #1481: the ACTIVE marker rides with the ref, which carries the root.
        // Persisted separately as a bare relPath, it was restored by joining it
        // to whatever project was active — so in a two-repo thread the reload
        // re-activated the other repo's identically-named file.
        const content = !info.binary && host.isDirty(id) ? host.getContent(id) : null
        // What an unsaved buffer was typed over, so a restore can tell when the
        // disk has moved on since (see rebuildTabs). Notes have no disk side.
        const baseline = content !== null && !isUntitled(id) ? host.baselineOf(id) : undefined
        const model = content !== null && !isUntitled(id) ? host.modelIdOf(id) : undefined
        refs.push({
          rootPath: info.rootPath,
          relPath: info.relPath,
          ...(isUntitled(id) ? { untitled: true } : {}),
          ...(id === activeId ? { active: true } : {}),
          ...(baseline !== undefined ? { dirtyBaseline: baseline } : {}),
          ...(model !== undefined ? { dirtyModel: model } : {}),
        })
        if (content !== null) dirtyBuffers[id] = content
      }
    }
    const active = tabs.activeId
    const activeInfo = active ? openFiles.get(active) : undefined
    return {
      openFiles: refs,
      activeFile: activeInfo ? activeInfo.relPath : null,
      dirtyBuffers,
      openViews,
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────

  // ── Scratch notes (⌘N, #941) ────────────────────────────────────────────
  //
  // A note you can start typing IMMEDIATELY, with no file dialog: ⌘N opens an
  // in-memory buffer in a normal editor tab. Ignore it and it costs nothing
  // (closing prompts once, like any dirty tab); ⌘S turns it into a real file —
  // one inline prompt for the name, then it behaves like every other file from
  // that moment on.
  //
  // Untitled buffers are keyed by a synthetic path (never a real one) so the
  // save/reload/watcher machinery can tell them apart at a glance.
  let untitledCounter = 0

  // UNTITLED_PREFIX / isUntitledPath live in ./untitled — the tab strip needs the
  // same answer to gate file-only actions (#1442), and a second copy of the
  // prefix is exactly how the two surfaces disagreed before.
  const isUntitled = isUntitledPath

  /** Open a fresh, empty note in a tab and focus it (#941) — in the
   *  conversation the keystroke was made in (see `openFile`). */
  async function newScratchNote(): Promise<void> {
    await runInWantedScope(newScratchNoteNow)
  }

  async function newScratchNoteNow(): Promise<void> {
    const rootPath = activeRoot
    if (rootPath === null) return // nothing to eventually save INTO
    untitledCounter += 1
    const name = `Untitled-${untitledCounter}`
    const path = `${UNTITLED_PREFIX}${untitledCounter}`
    document.dispatchEvent(new CustomEvent('flow:show-editor'))
    await host.open(path, '', false, false)
    openFiles.set(path, { rootPath, relPath: name, path, binary: false })
    tabs.add(path, name)
    refreshTabAccents()
    refreshTabLabels()
    emitTabsChanged()
    activateTab(path)
    // The whole point is typing IMMEDIATELY — make sure the caret is in the
    // note, even if Monaco finished booting after the tab was activated.
    void host
      .editorInstance()
      .then((editor) => editor.focus())
      .catch(() => undefined)
  }

  /**
   * Re-open a persisted scratch note (#1441) — the restore-side twin of
   * `newScratchNote`, minus the focus/reveal (restore must not steal the view).
   *
   * The tab is rebuilt under its ORIGINAL synthetic id, because that id is the
   * key its unsaved text was snapshotted under: restore looks the buffer up by
   * `openFiles.has(path)` immediately after this, and a fresh id would miss it
   * and drop the text — the second half of the bug. The counter is advanced past
   * every restored note so the next ⌘N cannot collide with one.
   *
   * Returns the tab id, or null for a name this can't be responsible for.
   */
  async function restoreScratchNote(ref: OpenFileRef): Promise<string | null> {
    const seq = Number.parseInt(/^Untitled-(\d+)$/.exec(ref.relPath)?.[1] ?? '', 10)
    if (!Number.isInteger(seq)) return null
    const path = `${UNTITLED_PREFIX}${seq}`
    if (openFiles.has(path)) return path
    untitledCounter = Math.max(untitledCounter, seq)
    // Opened EMPTY on purpose: the persisted text is applied by the dirtyBuffers
    // pass through restoreDirtyContent, which keeps '' as the saved baseline so
    // the note comes back dirty — the same contract a restored file gets (#955).
    await host.open(path, '', false, false)
    openFiles.set(path, { rootPath: ref.rootPath, relPath: ref.relPath, path, binary: false })
    tabs.add(path, ref.relPath)
    refreshTabAccents()
    refreshTabLabels()
    return path
  }

  /**
   * Inline "Save note as" bar over the editor area (#941). Electron has no
   * window.prompt, and a native dialog would be heavier than this needs to be:
   * one input + Save/Cancel, Enter submits, Escape cancels. Resolves the typed
   * path, or null when the user backs out (the note stays open and dirty).
   */
  function promptNoteName(suggested: string): Promise<string | null> {
    return new Promise((resolve) => {
      const bar = document.createElement('div')
      bar.className = 'fl-note-save-bar'
      bar.style.cssText = [
        'position:absolute',
        'top:8px',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:20',
        'display:flex',
        'gap:var(--fl-space-xs)',
        'align-items:center',
        'padding:8px 10px',
        'background:var(--fl-color-surface-raised, var(--fl-color-surface))',
        'border:1px solid var(--fl-color-border)',
        'border-radius:var(--fl-radius-md)',
        'box-shadow:var(--fl-shadow-md)',
      ].join(';')

      const label = document.createElement('span')
      label.textContent = 'Save note as'
      label.style.cssText = 'font-size:var(--fl-text-ui-size);color:var(--fl-color-text-secondary)'

      const input = document.createElement('input')
      input.type = 'text'
      input.value = suggested
      input.spellcheck = false
      input.style.cssText = [
        'min-width:280px',
        'padding:4px 6px',
        'background:var(--fl-color-surface)',
        'color:var(--fl-color-text)',
        'border:1px solid var(--fl-color-border)',
        'border-radius:var(--fl-radius-sm)',
        'font-family:var(--fl-font-mono, monospace)',
        'font-size:var(--fl-text-ui-size)',
      ].join(';')

      let settled = false
      const finish = (value: string | null): void => {
        if (settled) return
        settled = true
        bar.remove()
        resolve(value)
      }

      const save = document.createElement('button')
      save.type = 'button'
      save.textContent = 'Save'
      save.className = 'fl-note-save-confirm'
      save.addEventListener('click', () => finish(input.value))

      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.textContent = 'Cancel'
      cancel.addEventListener('click', () => finish(null))

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(input.value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(null)
        }
      })

      bar.append(label, input, save, cancel)
      bodyEl.appendChild(bar)
      input.focus()
      input.select()
    })
  }

  /**
   * Give an untitled buffer a real home: prompt for a name, write it, then
   * re-key the tab to the real path so every later save is an ordinary save.
   * Returns false when the user cancels (buffer stays untitled and dirty).
   */
  async function saveUntitled(path: string): Promise<boolean> {
    const info = openFiles.get(path)
    if (info === undefined) return false
    // Electron does NOT implement window.prompt (it throws) — ask inline.
    const answer = await promptNoteName(`${info.relPath}.md`)
    const relPath = answer?.trim().replace(/^\/+/, '') ?? ''
    if (relPath === '') return false
    const content = host.getContent(path) ?? ''

    // #1384: DON'T SILENTLY REPLACE AN EXISTING FILE. A name already taken
    // wrote the note straight over it — no confirm, no toast, no undo — and
    // the tab quietly re-keyed to the file it had just destroyed, showing the
    // note's text as though that were always its content. The Files tree's
    // New File… one menu away refuses a collision outright; ⌘S on a real file
    // already makes both of its "you are about to lose something" cases an
    // explicit choice (deletedOnDisk / changedOnDisk).
    const existing = await window.flow.project
      .readFile({ rootPath: info.rootPath, relPath })
      .catch(() => null)
    if (existing !== null) {
      const overwrite = window.confirm(
        `${relPath} already exists. Replace it with this note?\n\nIts current contents will be lost.`,
      )
      if (!overwrite) return false
    }

    try {
      // A note may name a folder that doesn't exist yet ("notes/scratch.md").
      // project:writeFile does NOT create parents — make them first, so the
      // save doesn't fail silently on the very first note.
      const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
      if (parent !== '') {
        await window.flow.project
          .createPath({ rootPath: info.rootPath, relPath: parent, kind: 'directory' })
          .catch(() => undefined) // already exists — fine
      }
      await window.flow.project.writeFile({ rootPath: info.rootPath, relPath, content })
    } catch (error) {
      // #1385: SAY SO. The name bar closed exactly as it does on success, the
      // tab stayed Untitled-N with its dirty dot, nothing was written, and the
      // only record was a console.error no user will see — verbatim the harm
      // #195 fixed for the ordinary ⌘S, whose own builder even enumerates this
      // failure mode.
      console.error('flow: failed to save note', error)
      dispatchEditorToast(info.rootPath, saveFailedToast(relPath, error))
      return false
    }
    // Swap the scratch tab for the real file — same content, now on disk.
    const wasActive = tabs.activeId === path
    tabs.remove(path)
    host.close(path)
    openFiles.delete(path)
    await openFile(info.rootPath, relPath)
    if (!wasActive) activateTab(tabs.activeId ?? '')
    return true
  }

  const onKeydown = (event: KeyboardEvent): void => {
    // #1455: a modal owns the keyboard while it is open. This window-level
    // listener was the fourth global shortcut consumer and the only one that
    // never asked — #525 (shell panel toggles), #683 (terminal autofocus) and
    // #1198 (app-menu ⌘W) all did. The shell's guard `return`s WITHOUT
    // stopPropagation, so bailing out there handed the identical keystroke
    // straight here.
    //
    // ⌘N was the sharp one: newScratchNote dispatches `flow:show-editor` (a
    // layout mutation behind the backdrop, exactly what #525 forbids), adds a
    // tab, activates it and then calls editor.focus() — and the overlay's focus
    // trap cannot undo that steal when nothing inside the overlay has been
    // focused yet, which is precisely the state the Flow-settings modal
    // auto-opens in the first time a project becomes active. Everything typed
    // after that landed in a buffer the user could not see, and since #1441
    // those invisible notes now persist across a reload too.
    if (isModalOverlayOpen()) return
    const primaryModifier = event.metaKey || event.ctrlKey
    // ⌘N / ctrl+N — start a note right here (#941).
    if (primaryModifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault()
      void newScratchNote().catch((error: unknown) => console.error('flow: new note failed', error))
      return
    }
    if (primaryModifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
      // Save only when the visually active tab is a file (not a view).
      const active = tabs.activeId
      if (active && openFiles.has(active)) {
        event.preventDefault()
        // #941: an untitled note needs a name before it can be written.
        if (isUntitled(active)) {
          void saveUntitled(active).catch((error: unknown) =>
            console.error('flow: save note failed', error),
          )
          return
        }
        void saveFile(active).catch(() => {
          // Already logged in saveFile; keep the buffer dirty so nothing is lost.
        })
      }
      return
    }
    // ⌘⇧V / ctrl+shift+V — toggle the markdown preview for the active md file (#575).
    if (primaryModifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v') {
      const active = tabs.activeId
      if (active && openFiles.has(active) && isMarkdownPath(active)) {
        event.preventDefault()
        toggleActivePreview()
      }
      return
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
      if (!tabs.isEmpty) {
        event.preventDefault()
        cycleTab(event.shiftKey ? -1 : 1)
      }
    }
  }
  window.addEventListener('keydown', onKeydown)

  // ── Public API ─────────────────────────────────────────────────────────

  const api: EditorApi = {
    openFile,
    openView,
    closeFile,
    closeActiveTab: () => {
      // closeFile handles both kinds — file tabs (dirty prompt) and view tabs
      // (hide, state preserved). No active tab → nothing to close (#673: ⌘W
      // must never fall through to closing the window).
      const active = tabs.activeId
      if (active) closeFile(active)
    },
    newScratchNote,
    saveActiveFile: async () => {
      const active = tabs.activeId
      if (active && openFiles.has(active)) {
        await saveFile(active)
      }
    },
    syncBufferFromDisk,
    activeFile: () => {
      // Judged by the tab strip: a view tab being active means no active file.
      const active = tabs.activeId
      return active ? (openFiles.get(active) ?? null) : null
    },
    setActiveProject,
    switchTabSet,
    registerViewRestorer: (kind, restore) => {
      viewRestorers.set(kind, restore)
    },
    clearActiveProject,
    snapshotTabs,
    onTabsChanged: (listener) => {
      tabsChangedListeners.push(listener)
    },
    hasOpenTabs: () => !tabs.isEmpty,
    hasTab: (id) => tabs.has(id),
    monaco: () => monacoNamespace(),
    editor: () => host.editorInstance(),
    disposeView,
    dispose: () => {
      window.removeEventListener('keydown', onKeydown)
      fileTree.dispose()
      host.dispose()
      openFiles.clear()
    },
  }

  // The merge editor surface (Phase 5) opens conflict tabs through this api.
  registerConflictMergeEditor(api)
  // …and the source-control panel previews a side's version through it.
  registerConflictSidePreview(api)

  return api
}

// ── Helpers ────────────────────────────────────────────────────────────────

function joinPath(rootPath: string, relPath: string): string {
  const base = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  return `${base}/${relPath}`
}

function lastSegment(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? relPath : relPath.slice(slash + 1)
}


/**
 * THE CONTROLS THAT OPEN TABS, ON THE STRIP THEY OPEN INTO.
 *
 * They used to live in the left rail, in a row of nine icons doing three
 * different jobs — five swapped the sidebar, three opened a tab, one toggled the
 * bottom dock — with a separator that split "sidebar" from "actions" and so put
 * Terminal beside Blueprint. Nothing on screen said which did what, and a
 * control far from its result is a guess about where the result will appear.
 *
 * Each of these dispatches the event the rail dispatched. Moving a control is
 * not a reason to move the behaviour: the shell still owns what happens, and
 * this file owns only where the button is.
 */
function buildViewActions(): HTMLElement {
  const group = document.createElement('div')
  group.className = 'fl-editor-actions'
  // ALWAYS AGAINST THE RIGHT EDGE. `margin-left:auto` rather than relying on the
  // tab strip to fill the space beside it: that strip sets `display:none` when
  // there are no tabs, so it stops taking any room and these icons slid to the
  // LEFT — then jumped right the moment a tab opened. The controls do not move
  // because the editor's contents changed (user, 2026-09-17).
  group.style.cssText =
    'display:flex;align-items:center;gap:2px;flex:none;margin-left:auto;'
  group.setAttribute('role', 'toolbar')
  group.setAttribute('aria-label', 'Open a view')

  const ACTIONS: Array<{ icon: string; label: string; event: string }> = [
    { icon: 'checklist', label: 'Tasks', event: 'flow:open-board' },
    { icon: 'map', label: 'Blueprint', event: 'flow:open-blueprint' },
    { icon: 'globe', label: 'Browser', event: 'flow:open-browser' },
    { icon: 'terminal', label: 'Terminal', event: 'flow:toggle-terminal' },
  ]

  for (const { icon, label, event } of ACTIONS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'fl-rail-item'
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.setAttribute('data-view-action', label.toLowerCase())
    const glyph = document.createElement('fl-icon')
    glyph.setAttribute('name', icon)
    glyph.setAttribute('size', '15')
    btn.appendChild(glyph)
    btn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent(event))
    })
    group.appendChild(btn)

    // #1401: Terminal is a TOGGLE, not an "open" — the dock is visible by
    // default, so the first press makes it disappear while the control looks
    // byte-for-byte identical before and after. It reflects EFFECTIVE
    // visibility, or it lies. The shell owns that fact and announces it.
    if (event === 'flow:toggle-terminal') {
      const paint = (visible: boolean): void => {
        btn.classList.toggle('active', visible)
        btn.setAttribute('aria-pressed', String(visible))
        btn.title = visible ? 'Hide terminal' : 'Show terminal'
      }
      paint(true)
      document.addEventListener('flow:terminal-visible', (e) => {
        paint((e as CustomEvent<{ visible?: boolean }>).detail?.visible === true)
      })
    }
  }

  // SETTINGS, AT THE END OF THE SAME ROW. It used to sit alone in the window's
  // corner, directly above these four — two strips of icons where one will do.
  //
  // NO DIVIDER. I added one to mark that this is a different KIND of control —
  // the four open a view, this opens the app's settings — and it read as clutter
  // rather than as a boundary (user, 2026-09-17). Five icons in a row do not
  // need a rule drawn through them; the gear is already the most over-learned
  // glyph in the category and its position at the end says enough.
  group.appendChild(buildSettingsButton())

  return group
}
