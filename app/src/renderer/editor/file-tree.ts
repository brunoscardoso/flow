/**
 * File tree — lazy directory tree over window.flow.project, scoped to the
 * active thread's roots (multi-project threads Phase 3).
 *
 * Two binding modes, one DOM:
 *   - Thread scope (`setScope`) — one collapsible section per scope root, in
 *     scope order. A ONE-root scope renders exactly the pre-scope tree (no
 *     section headers, no accent chrome — NFR1's byte-identical guarantee);
 *     N roots render a header row per root (a 3px left accent border +
 *     chevron + name — the primary root marked by tooltip only, same border
 *     as secondaries — with the sidebar's "unavailable" tag treatment for
 *     unreachable roots). A multi-project thread opens with every section
 *     folded; the person's folds are kept while that thread stays open
 *     (file-tree-sections.ts, `SectionFoldMemory`).
 *   - Legacy single root (`setActiveRoot`) — the ADR-002 coordinator binding,
 *     kept as the fail-soft fallback when the scope layer is unavailable.
 *
 * Directories load one level at a time through project:listDir and stay
 * cached until a project:fileChanged batch touches their parent directory,
 * which reloads just the affected listings (expansion state preserved). File
 * events already carry their root, so watcher routing is per-root by
 * construction.
 *
 * Rendering rides the virtualized <fl-list> (dense 28px Stark rows): the
 * expanded forest is flattened into rows, indentation is depth-based, and
 * activation either toggles a directory/section or hands the file to the
 * editor via the onOpenFile callback.
 */
import type { FlList, ListItemDetail } from '../components'
import type {
  DirectoryEntry,
  ThreadScope,
  ProjectFilesChangedEvent,
} from '../../shared/ipc-contract'
import { ensureAccentProperty } from '../project-accent'
import { revealLabel } from '../reveal-label'
import {
  fileOpFailedToast,
  listDirFailedToast,
  listDirFailureHint,
  type EditorToast,
} from './editor-feedback'
import { fileIconBadge, fileIconColor } from './file-icon-color'
import { deleteConfirmMessage, deleteConfirmWarning } from './delete-confirm'
import {
  emptyFoldMemory,
  foldMemoryFor,
  sectionsForScope,
  setRootExpanded,
  type FileTreeSectionModel,
  type SectionFoldMemory,
} from './file-tree-sections'
import { workspaceScope, type WorkspaceScopeState } from '../threads/workspace-scope'
import { isRootAvailable } from '../../shared/root-selection'
import {
  PICKER_EMPTY,
  PICKER_TITLE,
  PICKER_UNAVAILABLE,
  filesPanelMode,
  type PickerProject,
} from './file-tree-picker-model'
import {
  REVEAL_IN_TREE_EVENT,
  readRevealDetail,
  revealChain,
  type RevealInTreeDetail,
} from './file-tree-reveal'

const INDENT_PX = 12

interface TreeNode {
  rootPath: string
  /** Root-relative path with '/' separators; '' for the root node itself. */
  relPath: string
  name: string
  /** True when this root is the thread's own checkout. Root nodes only. */
  threadCopy?: boolean
  type: 'file' | 'directory'
  depth: number
  expanded: boolean
  /** True once children reflect a successful listDir call. */
  loaded: boolean
  /** Why the last listDir failed, in the user's terms — null when it succeeded
   *  (#1464). An unreadable folder must not render as an empty one. */
  readError?: string | null
  children: TreeNode[]
}

export type OpenFileHandler = (rootPath: string, relPath: string) => void

export class FileTree {
  #list: FlList<TreeNode>
  #emptyHint: HTMLDivElement
  /** What the tree's own state says the empty/error hint should be ('flex' |
   *  'none') — kept so the picker can hand it back when it steps aside. */
  #emptyHintDisplay = 'none'
  #emptyLabel!: HTMLSpanElement
  #openButton!: HTMLElement
  #retryButton!: HTMLElement
  #roots: TreeNode[] = []
  #unsubscribes: Array<() => void> = []
  #onOpenFile: OpenFileHandler
  #disposed = false
  /** Per-root section chrome (multi-root scopes only). Empty ⇒ every depth-0
   *  row renders exactly the pre-scope plain root row (NFR1). */
  #sectionMeta = new Map<string, FileTreeSectionModel>()
  /** What the person unfolded in the open thread (multi-root headers only).
   *  Reset whenever the scope names another thread, so a multi-project thread
   *  always opens with every project folded. */
  #foldMemory: SectionFoldMemory = emptyFoldMemory()
  /** Monotonic apply token — a newer setScope/setActiveRoot invalidates the
   *  render of any older in-flight load. */
  #applyToken = 0
  /** Roots already toasted as missing (#1118) — one "folder not found" per root,
   *  not one per failed listing (a vanished root fails every expanded node). */
  #notifiedMissingRoots = new Set<string>()
  /** The tree's host element — anchors the ⌘P "New file" prompt. */
  #container: HTMLElement
  /**
   * WORKSPACES (Phase 9): with no thread selected in a Workspace, the panel asks
   * which project to browse instead of claiming one. These hold what that
   * decision reads — the scope's thread and roots, and the person's pick.
   */
  #scopeThreadId: string | null = null
  #scopeRootPaths: string[] = []
  #picked: string | null = null
  #workspace: WorkspaceScopeState | null = null
  #picker!: HTMLDivElement
  /** The open context menu (right-click actions), if any. */
  #menu: HTMLElement | null = null
  #menuDismiss: (() => void) | null = null
  /**
   * A reveal asked for a project the tree is not showing yet (the Workspace's
   * "which project?" state, or a root still loading) — answered by the next
   * apply that shows it, then forgotten.
   */
  #pendingReveal: RevealInTreeDetail | null = null

  constructor(container: HTMLElement, onOpenFile: OpenFileHandler) {
    this.#onOpenFile = onOpenFile
    this.#container = container

    // REVEAL A FOLDER (plan feature-home-folders, FR-8) — the mirror of this
    // tree's own "Reveal in Blueprint": a feature card's folder row asks for
    // its folder, and the tree opens down to it and selects it.
    const onReveal = (event: Event): void => {
      const detail = readRevealDetail((event as CustomEvent<unknown>).detail)
      if (detail !== null) void this.revealFolder(detail)
    }
    document.addEventListener(REVEAL_IN_TREE_EVENT, onReveal)
    this.#unsubscribes.push(() => document.removeEventListener(REVEAL_IN_TREE_EVENT, onReveal))

    // ⌘P palette "New file": prompt for a name at the active root and create it.
    const onNewFile = (): void => this.promptNewFileAtRoot()
    document.addEventListener('flow:new-file', onNewFile)
    this.#unsubscribes.push(() => document.removeEventListener('flow:new-file', onNewFile))

    container.style.height = '100%'
    container.style.minHeight = '0'
    container.style.position = 'relative'

    this.#list = document.createElement('fl-list') as unknown as FlList<TreeNode>
    this.#list.rowHeight = 28
    this.#list.renderItem = (node) => this.#renderRow(node)
    this.#list.addEventListener('fl-list-activate', (event) => {
      const { item } = (event as CustomEvent<ListItemDetail<TreeNode>>).detail
      void this.#activate(item)
    })
    container.appendChild(this.#list)

    this.#emptyHint = document.createElement('div')
    this.#emptyHint.style.cssText = [
      'position:absolute',
      'inset:0',
      'display:none',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:var(--fl-space-sm)',
      'color:var(--fl-color-text-secondary)',
      'font-size:var(--fl-text-ui-size)',
      'user-select:none',
    ].join(';')
    const emptyLabel = document.createElement('span')
    emptyLabel.textContent = 'No project open'
    this.#emptyLabel = emptyLabel
    const openButton = document.createElement('fl-button')
    openButton.setAttribute('variant', 'default')
    openButton.setAttribute('small', '')
    const openIcon = document.createElement('fl-icon')
    openIcon.setAttribute('name', 'folder')
    openIcon.setAttribute('size', '13')
    const openText = document.createElement('span')
    openText.textContent = 'Open Folder…'
    openButton.appendChild(openIcon)
    openButton.appendChild(openText)
    openButton.addEventListener('click', () => {
      void window.flow.project.open().catch((error: unknown) => {
        console.error('flow: failed to open project', error)
      })
    })
    this.#openButton = openButton
    // #1464: the way out of a read failure is to fix the folder and try again,
    // so the pane offers exactly that instead of only naming the problem.
    const retryButton = document.createElement('fl-button')
    retryButton.setAttribute('variant', 'default')
    retryButton.setAttribute('small', '')
    retryButton.style.display = 'none'
    const retryText = document.createElement('span')
    retryText.textContent = 'Try again'
    retryButton.appendChild(retryText)
    retryButton.addEventListener('click', () => {
      void this.#retryRoots()
    })
    this.#retryButton = retryButton
    this.#emptyHint.appendChild(emptyLabel)
    this.#emptyHint.appendChild(openButton)
    this.#emptyHint.appendChild(retryButton)
    container.appendChild(this.#emptyHint)

    this.#picker = document.createElement('div')
    this.#picker.className = 'fl-file-tree-picker'
    this.#picker.style.cssText = [
      'position:absolute',
      'inset:0',
      'display:none',
      'flex-direction:column',
      'align-items:stretch',
      'gap:2px',
      'padding:var(--fl-space-md) var(--fl-space-sm)',
      'overflow-y:auto',
      'background:var(--fl-color-surface)',
      'color:var(--fl-color-text-secondary)',
      'font-size:var(--fl-text-ui-size)',
    ].join(';')
    container.appendChild(this.#picker)
  }

  /**
   * Subscribe to file-change events. The active root is driven externally by
   * the coordinator via {@link setActiveRoot}; init does not auto-load roots.
   */
  async init(): Promise<void> {
    this.#unsubscribes.push(
      window.flow.project.onFileChanged((event) => {
        void this.#onFilesChanged(event)
      }),
    )
    // Only the Workspace scope's own changes — never a thread or file broadcast.
    if (window.flow.workspaces !== undefined) {
      this.#unsubscribes.push(
        workspaceScope.subscribe((state) => {
          this.#workspace = state
          this.#renderPicker()
        }),
      )
    }
    // Render the empty state on boot so a fresh launch (no active-root event ever
    // fires) shows "No project open / Open Folder…" instead of a blank panel (#360).
    // With 0 roots #render flips #emptyHint from display:none → flex.
    this.#render()
  }

  /**
   * Show exactly one project root (top level, expanded), replacing whatever
   * root was shown before. `null` clears the tree to the empty state.
   *
   * Overlapping switches are guarded: a later call replaces `#roots`, so an
   * in-flight load whose node is no longer the active root discards its result.
   */
  setActiveRoot(rootPath: string | null): void {
    void this.#applyActiveRoot(rootPath)
  }

  async #applyActiveRoot(rootPath: string | null): Promise<void> {
    if (this.#disposed) {
      return
    }
    const token = ++this.#applyToken
    this.#scopeThreadId = null
    this.#scopeRootPaths = rootPath === null ? [] : [rootPath]
    // Legacy binding shows one root with no section chrome.
    this.#sectionMeta = new Map()
    if (rootPath === null) {
      this.#roots = []
      this.#render()
      return
    }
    // Same root already shown → nothing to reload.
    if (this.#roots.length === 1 && this.#roots[0].rootPath === rootPath) {
      this.#render()
      return
    }
    const node: TreeNode = {
      rootPath,
      relPath: '',
      name: lastSegment(rootPath),
      type: 'directory',
      depth: 0,
      expanded: true,
      loaded: false,
      children: [],
    }
    this.#roots = [node]
    await this.#loadChildren(node)
    // A newer setActiveRoot/setScope may have superseded this one while we awaited.
    if (this.#disposed || token !== this.#applyToken || this.#roots[0] !== node) {
      return
    }
    this.#render()
    this.#answerPendingReveal()
  }

  /**
   * Bind the tree to the active thread's scope: one section per scope root,
   * in scope order. The section model (file-tree-sections.ts) decides the
   * chrome — a single-root scope carries no headers and renders exactly the
   * legacy tree. Root nodes are reused across scope changes by rootPath, so
   * expansion state and cached listings survive a re-derive; an in-flight
   * apply superseded by a newer call discards its render.
   */
  setScope(scope: ThreadScope): void {
    void this.#applyScope(scope)
  }

  async #applyScope(scope: ThreadScope): Promise<void> {
    if (this.#disposed) {
      return
    }
    const token = ++this.#applyToken
    this.#scopeThreadId = scope.threadId
    this.#scopeRootPaths = scope.roots.map((root) => root.rootPath)
    // A selected thread answers "which project" itself; a pick made for the
    // no-thread state is spent, and the next no-thread state asks again.
    if (scope.threadId !== null) this.#picked = null
    this.#foldMemory = foldMemoryFor(this.#foldMemory, scope.threadId)
    const sections = sectionsForScope(scope, this.#foldMemory.expanded)
    const previous = new Map(this.#roots.map((node) => [node.rootPath, node]))
    this.#sectionMeta = new Map(
      sections.filter((section) => section.header).map((section) => [section.rootPath, section]),
    )
    this.#roots = sections.map((section) => {
      const existing = previous.get(section.rootPath)
      if (existing) {
        // Headered sections follow the thread's fold memory; the chrome-free
        // single root keeps whatever expansion the user last set — today's
        // behavior, untouched.
        if (section.header) {
          existing.expanded = !section.collapsed
        }
        existing.name = section.name
        existing.threadCopy = section.threadCopy === true
        return existing
      }
      return {
        rootPath: section.rootPath,
        relPath: '',
        name: section.name,
        threadCopy: section.threadCopy === true,
        type: 'directory',
        depth: 0,
        expanded: section.header ? !section.collapsed : true,
        loaded: false,
        children: [],
      }
    })
    // Load expanded, reachable roots that have no cached listing yet.
    // Unavailable roots never hit listDir (nothing to list, #263 idiom).
    const loads = this.#roots.filter((node) => {
      const meta = this.#sectionMeta.get(node.rootPath)
      const available = meta ? meta.available : true
      return available && node.expanded && !node.loaded
    })
    await Promise.all(loads.map((node) => this.#loadChildren(node)))
    if (this.#disposed || token !== this.#applyToken) {
      return
    }
    this.#render()
    this.#answerPendingReveal()
  }

  /**
   * Open the tree down to `relPath` under `rootPath` and select it: every
   * ancestor expanded (each listing loaded as it is reached), the folder
   * itself expanded too — it was asked for to see what is in it — then the
   * row selected and scrolled into view. `.` selects the project's own row.
   *
   * A project the tree is not showing is remembered and answered when it is
   * shown; in a Workspace with no conversation selected, that project is
   * picked — exactly what pressing it in the "which project?" list does.
   */
  async revealFolder(detail: RevealInTreeDetail): Promise<void> {
    if (this.#disposed) return
    const chain = revealChain(detail.relPath)
    if (chain === null) return
    const root = this.#roots.find((node) => node.rootPath === detail.rootPath)
    if (root === undefined) {
      this.#pendingReveal = detail
      this.#pickForReveal(detail.rootPath)
      return
    }
    this.#pendingReveal = null
    // THE "WHICH PROJECT?" LIST STEPS ASIDE: the reveal named the project.
    if (this.#scopeThreadId === null && this.#workspace?.scope.kind === 'workspace') this.#picked = root.rootPath
    const meta = root.depth === 0 ? this.#sectionMeta.get(root.rootPath) : undefined
    if (meta?.header === true) {
      if (!meta.available) return
      this.#foldMemory = setRootExpanded(this.#foldMemory, root.rootPath, true)
    }
    let node = root
    const steps: TreeNode[] = [root]
    for (const rel of chain) {
      if (!node.loaded) await this.#loadChildren(node)
      const name = rel.slice(rel.lastIndexOf('/') + 1)
      const child = node.children.find((candidate) => candidate.type === 'directory' && candidate.name === name)
      // A FOLDER THAT IS NOT THERE (moved since the map was read): stop at the
      // deepest one that is — the reader lands as close as the tree can say.
      if (child === undefined) break
      node = child
      steps.push(child)
    }
    if (this.#disposed) return
    for (const step of steps) {
      if (!step.loaded) await this.#loadChildren(step)
      step.expanded = true
    }
    if (this.#disposed) return
    this.#render()
    const index = this.#flatten().indexOf(node)
    if (index < 0) return
    // AFTER THE PANE IS ON SCREEN: the scroll that reveals the row reads the
    // list's own height, which is 0 while the Files pane is still hidden.
    requestAnimationFrame(() => {
      if (this.#disposed) return
      this.#list.selectedIndex = -1
      this.#list.selectedIndex = index
    })
  }

  /** A reveal waiting for its project, asked again now that a project is shown. */
  #answerPendingReveal(): void {
    const pending = this.#pendingReveal
    if (pending === null) return
    if (!this.#roots.some((node) => node.rootPath === pending.rootPath)) return
    void this.revealFolder(pending)
  }

  /** In a Workspace with no conversation selected, choose the project the reveal is for. */
  #pickForReveal(rootPath: string): void {
    const state = this.#workspace
    if (state === null || state.scope.kind !== 'workspace') return
    if (!workspaceScope.scopeRoots(state).includes(rootPath)) return
    this.#picked = rootPath
    if (this.#scopeRootPaths.includes(rootPath)) {
      this.#renderPicker()
      return
    }
    void window.flow.project
      .setActive({ rootPath })
      .catch((error: unknown) => console.error('flow: failed to switch project', error))
  }

  dispose(): void {
    this.#disposed = true
    this.#closeMenu()
    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe()
    }
    this.#unsubscribes = []
  }

  // ── Data ───────────────────────────────────────────────────────────────

  async #loadChildren(node: TreeNode): Promise<void> {
    try {
      const entries = await window.flow.project.listDir({
        rootPath: node.rootPath,
        relPath: node.relPath === '' ? undefined : node.relPath,
      })
      const previous = new Map(node.children.map((child) => [child.relPath, child]))
      node.children = entries.map((entry) => toChildNode(node, entry, previous))
      node.loaded = true
      node.readError = null
      // Reachable again (re-mounted drive, folder moved back) — re-arm the toast.
      this.#notifiedMissingRoots.delete(node.rootPath)
    } catch (error) {
      console.error('flow: failed to list directory', {
        rootPath: node.rootPath,
        relPath: node.relPath,
        error,
      })
      node.children = []
      node.loaded = false
      // #1464: say it in the PANE, not only in a toast. A toast is transient and
      // lands outside the surface the user is looking at; an unreadable root
      // otherwise renders as an ordinary empty project for as long as it is open.
      node.readError = listDirFailureHint(error)
      // A gone project folder used to render here as an ordinary EMPTY project —
      // the tree just showed zero children and said nothing (#1118). Toast the
      // missing-path case once per root; other read errors stay console-only.
      const toast = listDirFailedToast(lastSegment(node.rootPath), error)
      if (toast && !this.#notifiedMissingRoots.has(node.rootPath)) {
        this.#notifiedMissingRoots.add(node.rootPath)
        this.#notifyError(node.rootPath, toast)
      }
    }
  }

  async #activate(node: TreeNode): Promise<void> {
    if (node.type === 'file') {
      this.#onOpenFile(node.rootPath, node.relPath)
      return
    }
    // Section header (multi-root scope): fold/unfold the section, remembered
    // while this thread stays open. Unavailable sections are inert — nothing to list until
    // the location is reachable again (mirrors the sidebar's #263 treatment).
    const meta = node.depth === 0 ? this.#sectionMeta.get(node.rootPath) : undefined
    if (meta?.header) {
      if (!meta.available) {
        return
      }
      this.#foldMemory = setRootExpanded(this.#foldMemory, node.rootPath, !node.expanded)
    }
    if (!node.expanded && !node.loaded) {
      await this.#loadChildren(node)
    }
    node.expanded = !node.expanded
    this.#render()
  }

  /** Reload the listings of loaded directories whose contents changed. */
  async #onFilesChanged(event: ProjectFilesChangedEvent): Promise<void> {
    if (this.#disposed) {
      return
    }
    const affectedDirs = new Set<string>()
    for (const change of event.changes) {
      const relPath = toRelative(event.rootPath, change.path)
      if (relPath === null || relPath === '') {
        continue
      }
      const slash = relPath.lastIndexOf('/')
      affectedDirs.add(slash === -1 ? '' : relPath.slice(0, slash))
    }

    let touched = false
    for (const dir of affectedDirs) {
      const node = this.#findNode(event.rootPath, dir)
      if (node && node.type === 'directory' && node.loaded) {
        await this.#loadChildren(node)
        touched = true
      }
    }
    if (touched) {
      this.#render()
    }
  }

  #findNode(rootPath: string, relPath: string): TreeNode | null {
    const rootNode = this.#roots.find((node) => node.rootPath === rootPath)
    if (!rootNode) {
      return null
    }
    if (relPath === '') {
      return rootNode
    }
    let current = rootNode
    for (const segment of relPath.split('/')) {
      const child = current.children.find((candidate) => candidate.name === segment)
      if (!child) {
        return null
      }
      current = child
    }
    return current
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  #render(): void {
    const rows = this.#flatten()
    // #1464: a root the app could not read is not an empty project, and the tree
    // is the one surface that used to claim it was. Only when EVERY root failed —
    // in a multi-root scope the readable ones still have a tree to show.
    const unreadable =
      this.#roots.length > 0 && this.#roots.every((root) => typeof root.readError === 'string')
        ? (this.#roots[0]?.readError ?? null)
        : null
    this.#emptyLabel.textContent = unreadable ?? 'No project open'
    this.#openButton.style.display = unreadable === null ? '' : 'none'
    this.#retryButton.style.display = unreadable === null ? 'none' : ''
    this.#emptyHintDisplay = this.#roots.length === 0 || unreadable !== null ? 'flex' : 'none'
    this.#emptyHint.style.display = this.#emptyHintDisplay
    this.#list.items = rows
    this.#renderPicker()
  }

  /**
   * The Workspace's "which project?" state, drawn over the tree when it applies
   * (`filesPanelMode`). Outside a Workspace this hides itself and the panel is
   * exactly the tree it always was.
   */
  #renderPicker(): void {
    const state = this.#workspace
    const inWorkspace = state !== null && state.scope.kind === 'workspace'
    const projects: PickerProject[] =
      state === null || !inWorkspace
        ? []
        : workspaceScope.scopeRoots(state).map((root) => {
            const record = state.registered.find((entry) => entry.rootPath === root)
            return {
              root,
              name: workspaceScope.nameOf(root),
              available: record === undefined ? false : isRootAvailable(record),
            }
          })
    const mode = filesPanelMode({
      inWorkspace,
      scopeThreadId: this.#scopeThreadId,
      scopeRoots: this.#scopeRootPaths,
      picked: this.#picked,
      projects,
    })
    if (mode.kind === 'tree') {
      this.#picker.style.display = 'none'
      this.#list.style.visibility = ''
      // Give the tree back its OWN empty/error state. The picker hides the hint
      // while it is up, and a pick (or a thread opening) returns here without a
      // full render — so an unreadable project, picked, showed a blank pane: the
      // "Couldn't read this folder" line #1464 put there stayed display:none.
      this.#emptyHint.style.display = this.#emptyHintDisplay
      return
    }
    this.#list.style.visibility = 'hidden'
    this.#emptyHint.style.display = 'none'
    this.#picker.style.display = 'flex'
    const heading = document.createElement('div')
    heading.textContent = mode.projects.length === 0 ? PICKER_EMPTY : PICKER_TITLE
    heading.style.cssText = 'padding:0 var(--fl-space-sm) var(--fl-space-xs);font-size:var(--fl-text-caption-size);'
    const items: HTMLElement[] = [heading]
    for (const project of mode.projects) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fl-file-tree-pick'
      button.disabled = !project.available
      button.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:var(--fl-space-xs)',
        'height:28px',
        'padding:0 var(--fl-space-sm)',
        'border:none',
        'border-radius:var(--fl-radius-sm)',
        'background:transparent',
        'color:var(--fl-color-text)',
        'font:inherit',
        'text-align:left',
        project.available ? 'cursor:pointer' : 'cursor:default;opacity:0.55',
      ].join(';')
      const icon = document.createElement('fl-icon')
      icon.setAttribute('name', 'folder')
      icon.setAttribute('size', '13')
      const name = document.createElement('span')
      name.textContent = project.name
      button.append(icon, name)
      if (!project.available) {
        const tag = document.createElement('span')
        tag.textContent = PICKER_UNAVAILABLE
        tag.style.cssText = 'margin-left:auto;font-size:var(--fl-text-caption-size);color:var(--fl-color-text-secondary);'
        button.appendChild(tag)
      }
      button.addEventListener('mouseenter', () => {
        if (project.available) button.style.background = 'var(--fl-color-accent-muted)'
      })
      button.addEventListener('mouseleave', () => {
        button.style.background = 'transparent'
      })
      button.addEventListener('click', () => {
        if (!project.available) return
        this.#picked = project.root
        if (this.#scopeRootPaths.includes(project.root)) {
          this.#renderPicker()
          return
        }
        void window.flow.project
          .setActive({ rootPath: project.root })
          .catch((error: unknown) => console.error('flow: failed to switch project', error))
      })
      items.push(button)
    }
    this.#picker.replaceChildren(...items)
  }

  /** Re-run the failed listing for every root — the folder's permissions may
   *  have been fixed, or the drive re-mounted, since (#1464). */
  async #retryRoots(): Promise<void> {
    for (const root of this.#roots) {
      await this.#loadChildren(root)
    }
    if (!this.#disposed) this.#render()
  }

  #flatten(): TreeNode[] {
    const rows: TreeNode[] = []
    const visit = (node: TreeNode): void => {
      rows.push(node)
      if (node.type === 'directory' && node.expanded) {
        for (const child of node.children) {
          visit(child)
        }
      }
    }
    for (const root of this.#roots) {
      visit(root)
    }
    return rows
  }

  /** Rows live inside fl-list's shadow root, so styling is inline (custom
   *  properties still inherit through the shadow boundary). */
  #renderRow(node: TreeNode): HTMLElement {
    // Multi-root scope: the depth-0 row of a headered section renders as a
    // section header. With no section chrome (single root / legacy binding)
    // this branch never runs and the row below is exactly the pre-scope DOM.
    if (node.depth === 0) {
      const meta = this.#sectionMeta.get(node.rootPath)
      if (meta?.header) {
        return this.#renderSectionHeader(node, meta)
      }
    }
    const row = document.createElement('span')
    // What a reveal (and a test) finds the row by — the root-relative path.
    row.dataset['relPath'] = node.relPath
    row.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:var(--fl-space-xs)',
      `padding-left:${node.depth * INDENT_PX}px`,
      'min-width:0',
      'overflow:hidden',
      'white-space:nowrap',
      'font-size:var(--fl-text-ui-size)',
    ].join(';')

    if (node.type === 'directory') {
      const chevron = document.createElement('fl-icon')
      chevron.setAttribute('name', node.expanded ? 'chevron-down' : 'chevron-right')
      chevron.setAttribute('size', '12')
      chevron.style.color = 'var(--fl-color-text-secondary)'
      row.appendChild(chevron)
    } else {
      const spacer = document.createElement('span')
      spacer.style.cssText = 'display:inline-block;width:12px;flex:none;'
      row.appendChild(spacer)
    }

    // A TYPE BADGE where the file has one (TS / JS / {} …), the generic glyph
    // otherwise — see file-icon-color.ts for why the badge set is small.
    // Both occupy the same 14px cell, so the names stay in one column whichever
    // a row gets. Folders always take the glyph: a folder's own colour would
    // fight the tree's hierarchy, so only files carry a language tint.
    const badge = node.type === 'directory' ? null : fileIconBadge(node.name)
    if (badge !== null) {
      const chip = document.createElement('span')
      chip.className = 'fl-file-badge'
      chip.textContent = badge
      // Inline, like the rest of this tree's rows — the module injects no
      // stylesheet. 14px wide is the glyph's cell, so badged and unbadged rows
      // align; the mono face and the tight tracking are what make two letters
      // read as a mark rather than as the start of the filename.
      chip.style.cssText = [
        'flex:none',
        'width:14px',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'font-family:var(--fl-font-mono)',
        'font-size:9px',
        'font-weight:600',
        'letter-spacing:-0.04em',
        'line-height:1',
        'user-select:none',
      ].join(';')
      chip.style.color = fileIconColor(node.name)
      // Decorative: the file's name is right beside it and is the real label.
      chip.setAttribute('aria-hidden', 'true')
      row.appendChild(chip)
    } else {
      const icon = document.createElement('fl-icon')
      icon.setAttribute('name', nodeIconName(node))
      icon.setAttribute('size', '14')
      icon.style.color =
        node.type === 'directory' ? 'var(--fl-color-text-secondary)' : fileIconColor(node.name)
      row.appendChild(icon)
    }

    const label = document.createElement('span')
    label.textContent = node.name
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;color:var(--fl-color-text);'
    if (node.depth === 0) {
      label.style.fontWeight = 'var(--fl-text-ui-weight-medium)'
    }
    row.appendChild(label)

    // Right-click → file actions (new file/folder, rename, delete).
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.#openContextMenu(node, event.clientX, event.clientY)
    })

    return row
  }

  /**
   * Section header row for a multi-root scope: a clean 3px left accent
   * border + collapse chevron + name, with the sidebar's dimmed +
   * "unavailable" tag treatment (#263) when the root is unreachable. The
   * accent lives ONLY in the border (user call 2026-07-28: no circles) —
   * primary and secondary roots carry the SAME border; the primary root is
   * marked by its "primary project" tooltip on the header row. (A "main"
   * text tag here read as branch information — wrong signal — and was
   * removed by user request.)
   */
  #renderSectionHeader(node: TreeNode, meta: FileTreeSectionModel): HTMLElement {
    // Deterministic per-project accent (Phase 2) — a left border, never a row
    // fill. Override-aware: the scope entry's user-picked accent (meta.accent)
    // wins over the hash color.
    const accentRef = ensureAccentProperty(node.rootPath, meta.accent ?? null)
    const row = document.createElement('span')
    row.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:var(--fl-space-xs)',
      'min-width:0',
      'overflow:hidden',
      'white-space:nowrap',
      'font-size:var(--fl-text-ui-size)',
      `border-left:3px solid ${accentRef}`,
      'padding-left:var(--fl-space-xs)',
    ].join(';')
    if (meta.primary) {
      row.title = 'Primary project — owns plans and flow state'
    }

    const chevron = document.createElement('fl-icon')
    chevron.setAttribute('name', node.expanded ? 'chevron-down' : 'chevron-right')
    chevron.setAttribute('size', '12')
    chevron.style.color = 'var(--fl-color-text-secondary)'
    row.appendChild(chevron)

    const label = document.createElement('span')
    label.textContent = node.name
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;'
    label.style.fontWeight = 'var(--fl-text-ui-weight-medium)'
    label.style.color = meta.available
      ? 'var(--fl-color-text)'
      : 'var(--fl-color-text-secondary)'
    // The primary marker lives in the tooltip (on the header row and here) —
    // never in a text tag, which read as a branch name.
    const primaryNote = meta.primary ? '\nPrimary project — owns plans and flow state' : ''
    label.title = meta.available
      ? `${node.rootPath}${primaryNote}`
      : `${node.rootPath}${primaryNote}\nLocation unreachable — reconnect the drive`
    row.appendChild(label)

    if (!meta.available) {
      row.appendChild(headerTag('unavailable', 'Location unreachable — reconnect the drive'))
    }

    // Right-click file actions target this root — but never an unreachable
    // one (creating on a nonexistent path just errors, #350 idiom).
    if (meta.available) {
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.#openContextMenu(node, event.clientX, event.clientY)
      })
    }

    return row
  }

  // ── Context menu (new / rename / delete) ────────────────────────────────

  /**
   * Prompt for a new file name at the ACTIVE ROOT and create it — the ⌘P
   * palette's "New file" entry point (flow:new-file). Reuses the context-menu
   * chrome + inline #promptName, anchored to the tree. No-op with no active root
   * (notifies), so a keystroke never silently does nothing.
   */
  promptNewFileAtRoot(): void {
    const root = this.#roots[0]
    if (!root) {
      document.dispatchEvent(
        new CustomEvent('flow:notify', {
          detail: { kind: 'state-change', message: 'Open a project first to create a file.' },
        }),
      )
      return
    }
    this.#closeMenu()
    const menu = document.createElement('div')
    menu.className = 'fl-tree-menu'
    const anchor = this.#container.getBoundingClientRect()
    const left = Math.max(8, anchor.left + 8)
    const top = Math.max(8, anchor.top + 8)
    menu.style.cssText = [
      'position:fixed',
      `left:${left}px`,
      `top:${top}px`,
      'z-index:1000',
      'min-width:200px',
      'background:var(--fl-color-surface-raised)',
      'border:var(--fl-border-width) solid var(--fl-color-border)',
      'border-radius:var(--fl-radius-md)',
      'padding:4px',
      'box-shadow:var(--fl-shadow-md)',
    ].join(';')
    document.body.appendChild(menu)
    this.#menu = menu
    // Dismiss wiring MUST match #openContextMenu: #menuDismiss is the listener
    // CLEANUP (not #closeMenu itself, which CALLS #menuDismiss — that recurses
    // into a stack overflow on submit, so the file was never created).
    const onDown = (event: MouseEvent): void => {
      if (this.#menu && !this.#menu.contains(event.target as Node)) this.#closeMenu()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') this.#closeMenu()
    }
    this.#menuDismiss = () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    this.#promptName(menu, 'New file name', '', (name) =>
      void this.#create(root.rootPath, name, 'file'),
    )
  }

  #openContextMenu(node: TreeNode, x: number, y: number): void {
    this.#closeMenu()
    const menu = document.createElement('div')
    menu.className = 'fl-tree-menu'
    menu.style.cssText = [
      'position:fixed',
      `left:${x}px`,
      `top:${y}px`,
      'z-index:1000',
      'min-width:170px',
      'background:var(--fl-color-surface-raised)',
      'border:var(--fl-border-width) solid var(--fl-color-border)',
      'border-radius:var(--fl-radius-md)',
      'padding:4px',
      'box-shadow:var(--fl-shadow-md)',
      'font-size:var(--fl-text-ui-size)',
    ].join(';')

    // New items go INTO a directory, or into a file's parent directory.
    const parentRel = node.type === 'directory' ? node.relPath : parentDir(node.relPath)
    this.#menuItem(menu, 'New File…', () =>
      this.#promptName(menu, 'New file name', '', (name) =>
        void this.#create(node.rootPath, joinRel(parentRel, name), 'file'),
      ),
    )
    this.#menuItem(menu, 'New Folder…', () =>
      this.#promptName(menu, 'New folder name', '', (name) =>
        void this.#create(node.rootPath, joinRel(parentRel, name), 'directory'),
      ),
    )
    // #1063: hand the path to the OS file manager. Root-contained main-side, so
    // the renderer only ever names a project-relative path.
    this.#menuItem(menu, revealLabel(), () => {
      this.#closeMenu()
      void window.flow.project
        .revealPath({ rootPath: node.rootPath, relPath: node.relPath })
        .catch((error: unknown) => console.warn('flow: reveal failed', error))
    })
    // Reveal on the blueprint map — decoupled via a document event handled by the
    // blueprint wiring, which opens the board and drills to the owning module (#UX).
    this.#menuItem(menu, 'Reveal in Blueprint', () => {
      this.#closeMenu()
      document.dispatchEvent(
        new CustomEvent('flow:reveal-in-blueprint', { detail: { relPath: node.relPath } }),
      )
    })
    if (node.relPath !== '') {
      // The root itself can't be renamed/deleted from here.
      this.#menuItem(menu, 'Rename…', () =>
        this.#promptName(menu, 'Rename', node.name, (name) => void this.#rename(node, name)),
      )
      this.#menuItem(menu, 'Delete', () => this.#confirmDelete(menu, node), true)
    }

    document.body.appendChild(menu)
    this.#menu = menu
    // Keep the menu inside the viewport.
    const rect = menu.getBoundingClientRect()
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`

    const onDown = (event: MouseEvent): void => {
      if (this.#menu && !this.#menu.contains(event.target as Node)) this.#closeMenu()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') this.#closeMenu()
    }
    this.#menuDismiss = () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
  }

  #menuItem(menu: HTMLElement, label: string, onClick: () => void, danger = false): void {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.style.cssText = [
      'display:block',
      'width:100%',
      'text-align:left',
      'padding:4px 8px',
      'background:none',
      'border:none',
      'cursor:pointer',
      'border-radius:var(--fl-radius-sm)',
      `color:${danger ? 'var(--fl-color-error)' : 'var(--fl-color-text)'}`,
    ].join(';')
    button.addEventListener('mouseenter', () => (button.style.background = 'var(--fl-color-surface)'))
    button.addEventListener('mouseleave', () => (button.style.background = 'none'))
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      onClick()
    })
    menu.appendChild(button)
  }

  /** Swap the menu body for a single-line text input. */
  #promptName(
    menu: HTMLElement,
    placeholder: string,
    initial: string,
    onSubmit: (name: string) => void,
  ): void {
    menu.replaceChildren()
    const input = document.createElement('input')
    input.type = 'text'
    input.value = initial
    input.placeholder = placeholder
    input.spellcheck = false
    input.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'padding:4px 6px',
      'background:var(--fl-color-surface)',
      'border:var(--fl-border-width) solid var(--fl-color-border)',
      'border-radius:var(--fl-radius-sm)',
      'color:var(--fl-color-text)',
      'font-size:var(--fl-text-ui-size)',
    ].join(';')
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const value = input.value.trim()
        this.#closeMenu()
        if (value) onSubmit(value)
      } else if (event.key === 'Escape') {
        this.#closeMenu()
      }
    })
    menu.appendChild(input)
    input.focus()
    input.select()
  }

  #confirmDelete(menu: HTMLElement, node: TreeNode): void {
    menu.replaceChildren()
    const target = {
      name: node.name,
      kind: node.type,
      // #1187: what's inside, when we already know it. Folders are COLLAPSED by
      // default, so the count usually has to be fetched — the confirm renders
      // immediately with "everything inside it" and upgrades in place.
      childCount: node.type === 'directory' && node.loaded ? node.children.length : null,
    }
    const label = document.createElement('div')
    label.textContent = deleteConfirmMessage(target)
    label.style.cssText = 'padding:4px 8px;color:var(--fl-color-text);'
    menu.appendChild(label)

    const warningText = deleteConfirmWarning(target)
    if (warningText !== null) {
      const warning = document.createElement('div')
      warning.style.cssText =
        'padding:0 8px 4px;color:var(--fl-color-error);font-size:var(--fl-text-caption-size);max-width:260px;'
      warning.textContent = warningText
      menu.appendChild(warning)
    }

    this.#menuItem(menu, 'Delete', () => void this.#delete(node), true)
    this.#menuItem(menu, 'Cancel', () => this.#closeMenu())

    // Fetch the count for a folder we haven't expanded, then refine the copy.
    // Fail-soft: on any error the confirm keeps its (already honest) wording.
    if (node.type === 'directory' && target.childCount === null) {
      void window.flow.project
        .listDir({ rootPath: node.rootPath, relPath: node.relPath === '' ? undefined : node.relPath })
        .then((entries) => {
          if (!label.isConnected) return // the user already answered
          label.textContent = deleteConfirmMessage({ ...target, childCount: entries.length })
        })
        .catch(() => undefined)
    }
  }

  #closeMenu(): void {
    this.#menuDismiss?.()
    this.#menuDismiss = null
    this.#menu?.remove()
    this.#menu = null
  }

  async #create(rootPath: string, relPath: string, kind: 'file' | 'directory'): Promise<void> {
    try {
      await window.flow.project.createPath({ rootPath, relPath, kind })
      // #1188: SHOW it. The fs watcher only reloads directories that are
      // already loaded, and the tree keeps everything but the root collapsed —
      // so creating inside a folder the user hadn't expanded put the new entry
      // on disk and nowhere on screen. New File… had an accidental tell (it
      // opens a tab); New Folder… had no feedback at all, which made the only
      // create-folder affordance look broken.
      await this.#revealCreated(rootPath, relPath)
      // Open a new file so the user lands in it right away.
      if (kind === 'file') this.#onOpenFile(rootPath, relPath)
    } catch (error) {
      console.error('flow: failed to create path', { relPath, kind, error })
      // Surface it — a name collision / invalid name / permission error was a
      // silent no-op; the menu just closed with no explanation (#196).
      this.#notifyError(rootPath, fileOpFailedToast('create', relPath, error))
    }
  }

  /**
   * Expand and load every ancestor of `relPath` so a just-created entry is
   * actually visible (#1188). Fail-soft: a listing that fails leaves the tree as
   * it was — the create itself already succeeded, and its own error path owns
   * reporting failures.
   */
  async #revealCreated(rootPath: string, relPath: string): Promise<void> {
    const segments = relPath.split('/').filter((segment) => segment.length > 0)
    // Walk the ANCESTORS (everything but the created leaf itself).
    let current = this.#findNode(rootPath, '')
    let walked = ''
    for (const segment of segments.slice(0, -1)) {
      if (!current) break
      current.expanded = true
      if (!current.loaded) await this.#loadChildren(current)
      walked = walked === '' ? segment : `${walked}/${segment}`
      current = this.#findNode(rootPath, walked)
    }
    // The immediate parent must be (re)loaded so the new child is in its list —
    // it may have been loaded BEFORE the create.
    if (current && current.type === 'directory') {
      current.expanded = true
      await this.#loadChildren(current)
    }
    this.#render()
  }

  async #rename(node: TreeNode, newName: string): Promise<void> {
    const newRelPath = joinRel(parentDir(node.relPath), newName)
    if (newRelPath === node.relPath) return
    try {
      await window.flow.project.renamePath({
        rootPath: node.rootPath,
        relPath: node.relPath,
        newRelPath,
      })
    } catch (error) {
      console.error('flow: failed to rename path', { from: node.relPath, to: newRelPath, error })
      this.#notifyError(node.rootPath, fileOpFailedToast('rename', newRelPath, error))
    }
  }

  async #delete(node: TreeNode): Promise<void> {
    this.#closeMenu()
    try {
      await window.flow.project.deletePath({ rootPath: node.rootPath, relPath: node.relPath })
    } catch (error) {
      console.error('flow: failed to delete path', { relPath: node.relPath, error })
      this.#notifyError(node.rootPath, fileOpFailedToast('delete', node.relPath, error))
    }
  }

  /** Surface an error toast via the flow:notify bridge (→ NotificationCenter) so
   *  a failed file operation isn't a silent no-op (#196). */
  #notifyError(rootId: string, toast: EditorToast): void {
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
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Small bordered chip for section headers — the thread sidebar's tag idiom
 *  (#263 "unavailable" / #513 provisioning tags). */
function headerTag(text: string, title: string): HTMLElement {
  const tag = document.createElement('span')
  tag.textContent = text
  tag.title = title
  tag.style.cssText = [
    'flex:none',
    'font-size:var(--fl-text-caption-size)',
    'letter-spacing:0',
    'text-transform:none',
    'padding:0 5px',
    'border-radius:var(--fl-radius-sm)',
    'border:var(--fl-border-width) solid var(--fl-color-border)',
    'color:var(--fl-color-text-secondary)',
  ].join(';')
  return tag
}

/** Icon shown next to a tree row: folder (open/closed) or file. */
function nodeIconName(node: TreeNode): string {
  if (node.type !== 'directory') {
    return 'file'
  }
  return node.expanded ? 'folder-open' : 'folder'
}

function toChildNode(
  parent: TreeNode,
  entry: DirectoryEntry,
  previous: Map<string, TreeNode>,
): TreeNode {
  const relPath = parent.relPath === '' ? entry.name : `${parent.relPath}/${entry.name}`
  const existing = previous.get(relPath)
  if (existing && existing.type === entry.type) {
    return existing
  }
  return {
    rootPath: parent.rootPath,
    relPath,
    name: entry.name,
    type: entry.type,
    depth: parent.depth + 1,
    expanded: false,
    loaded: false,
    children: [],
  }
}

/** Root-relative path of `absolutePath`, or null when outside the root. */
function toRelative(rootPath: string, absolutePath: string): string | null {
  if (absolutePath === rootPath) {
    return ''
  }
  const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`
  if (!absolutePath.startsWith(prefix)) {
    return null
  }
  return absolutePath.slice(prefix.length)
}

function lastSegment(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** Parent of a root-relative posix path ('' for a top-level entry). */
function parentDir(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? '' : relPath.slice(0, slash)
}

/** Join a root-relative parent dir with a child name (posix). */
function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}
