/**
 * Flow shell — Cursor-style layout, with the activity bar as the sidebar's first row:
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │  titlebar — project chip · thread · branch       │
 *   ├────────────────┬─────────────────────────────────┤
 *   │ ▓▓▓ AB ▓▓▓▓▓▓▓ │                                 │
 *   ├────────────────┤            editor               │
 *   │    sidebar     │                                 │
 *   │  (swappable)   │                                 │
 *   ├────────────────┴─────────────────────────────────┤
 *   │                  status bar                      │
 *   └──────────────────────────────────────────────────┘
 *
 * AB = the activity bar (icon row) — Threads, Files, Source Control (switch sidebar),
 *      Tasks, Blueprint, Terminal (open/toggle their own surfaces). It sits INSIDE the
 *      sidebar, directly under the titlebar's project switcher and directly above the
 *      active pane's own header (the threads search box, the file tree, …), so the
 *      window has no vertical icon strip and the sidebar starts at the left edge.
 *      It therefore goes away with the sidebar (⌘B, re-clicking the active item) —
 *      Tasks / Blueprint / Terminal stay reachable from ⌘P and their shortcuts.
 * Panel sizes and collapse state persist to localStorage per (project, thread) scope and
 * follow the selected thread; they are restored on boot.
 * Later phases replace the placeholder panel bodies with real surfaces by mounting into
 * the elements returned from `mountShell`.
 */
import './components'
import { createDebugSessionRunner } from './debug/debug-session-runner'
import type { FlPanel } from './components'
import { FlSplit } from './components'
import { initFlowSettings } from './settings/flow-settings-view'
import { resolveRailItem, type RailItem } from './sidetab-state'
import { buildWorkspaceSwitcher } from './threads/workspace-switcher'
import {
  migrateLegacyLayout,
  normalizeLayoutState,
  normalizeLayoutStore,
  SOURCE_CONTROL_VISIBILITY_EVENT,
  type ShellLayoutState,
  type ShellLayoutStore,
} from './layout-state'
import {
  createThreadLayoutStore,
  sameLayoutScope,
  type LayoutScope,
} from './layout/thread-layout-store'
import {
  buildSplitPlan,
  enforceNonEmpty,
  normalizePanelLayout,
  setFocusMode,
  toggleEditor,
  togglePanel,
  type PanelLayout,
} from './panel-layout'
import { currentPlatform, titlebarInsets } from './platform-affordances'
import {
  COLLAPSED_READING_COLUMN_PX,
  keepPaneFraction,
  rightAreaShown,
  rightAreaToggleTitle,
  toggleRightArea,
} from './right-area-model'
import { isModalOverlayOpen } from './modal-overlay'
import {
  chatOnScreen,
  ESCAPE_OWNING_FOCUS_TARGETS,
  ESCAPE_OWNING_GENERIC_POPUPS,
  leaveRightExpanded,
  revealChat,
  rightExpandedIcon,
  rightExpandedLabel,
  rightExpandedShown,
  shouldLeaveExpandedOnEscape,
  toggleRightExpanded,
} from './expand-right-model'
import {
  shouldExitFocusMode,
  ESCAPE_OWNING_POPUPS,
  ESCAPE_OWNING_EDITOR_WIDGETS,
} from './focus-escape'

/**
 * Custom elements that open an Escape-owning popup inside their OWN shadow
 * root — out of reach of `document.querySelector`. `<fl-tabs>`' right-click
 * menu is a `.ctx-menu` in its shadow, so in focus mode one Escape closed it
 * AND tore the layout open: #1161 again, on the popup focus mode leaves on
 * screen.
 */
const SHADOW_POPUP_HOSTS = ['fl-tabs'] as const

/** True when any of `selectors` matches a live element (#1161) — in the
 *  document, or in the shadow root of a known popup host. */
function anyPresent(selectors: readonly string[]): boolean {
  const scopes: Array<Document | ShadowRoot> = [document]
  for (const host of document.querySelectorAll(SHADOW_POPUP_HOSTS.join(','))) {
    if (host.shadowRoot !== null) scopes.push(host.shadowRoot)
  }
  return selectors.some((selector) => scopes.some((scope) => scope.querySelector(selector) !== null))
}

/** True when any of `selectors` matches an element that has a box on screen —
 *  for generic roles that may sit in the DOM, hidden, all the time. */
function anyOnScreen(selectors: readonly string[]): boolean {
  return selectors.some((selector) =>
    Array.from(document.querySelectorAll(selector)).some((element) => element.getClientRects().length > 0),
  )
}

// v2: the sidebar and terminal became removable panes (toggles) rather than
// header-collapsible panels, and Files/Git became tabs. Old v1 state persisted
// split sizes / collapsed flags that are incompatible with the new pane
// composition and produced a broken layout (blank right strip, stuck-narrow
// sidebar), so the key is bumped to abandon it cleanly.
// v3: the terminal now docks under the EDITOR only (a vertical editor+terminal
// stack) with Files/Git as a full-height sidebar beside it — the right split
// flipped from vertical to horizontal and 'editor-area' became 'editor-stack',
// so old persisted sizes are incompatible.
// v4 (#580): persistence moves from ONE global object to a per-project record
// (ShellLayoutStore) so each project restores its own arrangement, and each
// state now carries a `panelLayout` (the model-driven side/order/visibility of
// the movable panels). A legacy v3 global migrates once into the active root.
// v5 (activity-bar): persistence gains activeRailItem + sidebarOpen; the
// movable panel system (files-git, terminal pane, ⋯ menus, ⌘⌥←/→) is retired.
// Old v4 state is incompatible (different root-split child count).
const LEGACY_LAYOUT_STORAGE_KEY_V3 = 'flow.shell.layout.v3'
const LAYOUT_STORAGE_KEY_V5 = 'flow.shell.layout.v5'
// Per-thread layouts: every (project root, thread | project view) scope keeps
// its own state. v5 above is now read-only — the fallback for a scope with no
// entry, which is how an upgrade keeps each project's existing layout.
const SCOPED_LAYOUT_STORAGE_KEY = 'flow.shell.layout.scoped.v1'

/** Attribute stamped on each movable panel's element so later phases can map a
 *  focused element back to its `MovablePanelId` (Phase 3 focused-panel detection). */
const PANEL_ID_ATTR = 'data-panel-id'

// Panel-layout keyboard shortcuts (⌘/Ctrl+⌥ + key), matched on `event.code` so
// macOS ⌥+letter glyph substitution (⌥C → 'ç') can't break detection.
const PANEL_KEY_TOGGLE_CHAT = 'KeyC' // ⌘⌥C — toggle chat/conversation.
const PANEL_KEY_TOGGLE_EDITOR = 'KeyD' // ⌘⌥D — toggle center editor.
const PANEL_KEY_TOGGLE_FOCUS = 'KeyZ' // ⌘⌥Z — toggle focus mode.
const PANEL_KEY_TOGGLE_RIGHT_AREA = 'KeyB' // ⌘⌥B — the right-hand area (mirror of ⌘B).

/** Debounce window for persisting layout mutations (resize storms, rapid toggles). */
const SAVE_DEBOUNCE_MS = 200

/** z-index for the fixed-position panel menu (above panel content + splits). */
const PANEL_MENU_Z_INDEX = 1000

/** Default pane fractions per split, keyed by the root split's COMPOSITION
 *  ('sidebar' = activity sidebar, 'conversation' = chat, 'editor' = editor
 *  stack) — never by child count (#1110): the count-keyed lookup handed the
 *  conversation's 38% share to the activity sidebar whenever the chat was
 *  hidden with the sidebar open. An unknown composition falls back to equal
 *  fractions (fail-soft). */
const DEFAULT_SIZES: Record<string, number[]> = {
  // Activity sidebar closed: conversation + editor.
  'conversation|editor': [0.38, 0.62],
  // Sidebar open, chat visible: the default 3-pane arrangement.
  'sidebar|conversation|editor': [0.22, 0.22, 0.56],
  // Chat hidden (⌘⌥C) with the sidebar open: the freed width belongs to the
  // EDITOR — the sidebar keeps its usual ~22% share (#1110).
  'sidebar|editor': [0.22, 0.78],
  // The right-hand area put away (⌘⌥B / the titlebar's right toggle): the
  // freed width belongs to the CONVERSATION — the sidebar keeps its share
  // rather than splitting the window 50/50 with the chat.
  'sidebar|conversation': [0.22, 0.78],
}

/** Phase 3/4 seam: read the current panel model and apply a reducer's result,
 *  re-rendering the shell + persisting per-project. Shortcuts (Phase 3) and the
 *  header menu (Phase 4) call `applyLayout(reducer(getLayout()))`. */
export interface ShellLayoutApi {
  getLayout(): PanelLayout
  applyLayout(next: PanelLayout): void
  /** Report whether the editor holds any open tab (initEditor → shell). An empty
   *  editor collapses its stack when no terminal is docked (#675). */
  setEditorHasTabs(has: boolean): void
}

/** Mount points later phases render into. */
export interface ShellSurfaces {
  /** Threads content container — initThreads mounts the thread list here.
   *  Lives inside the swappable activity sidebar (not a separate split panel). */
  sidebar: HTMLElement
  conversation: FlPanel
  editor: FlPanel
  /** Files tab body of the activity sidebar. */
  fileTree: HTMLElement
  /** Search tab body of the activity sidebar — content-search panel mounts here. */
  searchPanel: HTMLElement
  /** Source Control → Changes view body (git sections) (#335). */
  gitPanel: HTMLElement
  /** Source Control → Phases view body (phase-grouped review) (#335). */
  reviewPanel: HTMLElement
  terminal: FlPanel
  statusBar: HTMLElement
  /** Phase 3/4 seam — mutate + re-render the model-driven panel layout (#580). */
  layoutApi: ShellLayoutApi
}

interface Sidebar {
  element: HTMLElement
  threadsBody: HTMLElement
  filesBody: HTMLElement
  searchBody: HTMLElement
  treeBody: HTMLElement
  changesBody: HTMLElement
  phasesBody: HTMLElement
  /** Switch to the given rail item's content view. */
  showItem(item: RailItem): void
  /** Restore the view-mode (changes|phases) for source-control. */
  setViewMode(mode: 'changes' | 'phases'): void
}

/**
 * Tell the Source Control pane its on-screen state may have moved.
 *
 * Fired AFTER the DOM change that could have moved it (the pane reads its own
 * element and decides — see SOURCE_CONTROL_VISIBILITY_EVENT), from the two
 * seams that can: switching which pane the sidebar shows, and switching the
 * Source Control view mode.
 */
function announceSourceControlVisibility(): void {
  document.dispatchEvent(new CustomEvent(SOURCE_CONTROL_VISIBILITY_EVENT))
}

function createSidebar(state: ShellLayoutState, save: () => void): Sidebar {
  const element = document.createElement('div')
  element.className = 'fl-sidebar'

  // ── Threads body — initThreads mounts its thread list here ────────────
  const threadsBody = document.createElement('div')
  threadsBody.className = 'fl-sidebar-pane fl-sidebar-threads'
  threadsBody.style.cssText = 'height:100%;min-height:0;'

  // ── Files body ─────────────────────────────────────────────────────────
  //
  // THREE THINGS, IN THE ORDER A PERSON MEETS THEM: which checkout this
  // conversation works in, a box to search it, and the tree itself. Search had
  // its own rail item and its own pane, which meant leaving the explorer to
  // look for a file and coming back to it to open one (user, 2026-09-18: "lets
  // move the search to file explorer tab, between the worktree and the file
  // explorer").
  //
  // The worktree dock inserts itself at the top of this pane (see
  // `worktrees/index.ts`), so the two hosts below are the second and third
  // children and the order holds without either side knowing about the other.
  const filesBody = document.createElement('div')
  // Named like the threads pane beside it: the panes share a class, so anything
  // selecting "the sidebar" picked whichever came first.
  filesBody.className = 'fl-sidebar-pane fl-sidebar-files'

  // ── Search — the content-search panel mounts here, inside Files ──────────
  const searchBody = document.createElement('div')
  searchBody.className = 'fl-files-search'

  // ── The tree's own host, so the search above it survives the tree's mount.
  //    The editor mounts with `replaceChildren`, which would otherwise take the
  //    whole pane and everything else in it with it.
  const treeBody = document.createElement('div')
  treeBody.className = 'fl-files-tree'

  filesBody.append(searchBody, treeBody)

  // ── Source Control body (Changes | Phases toggle) ──────────────────────
  const scBody = document.createElement('div')
  scBody.className = 'fl-sidebar-pane fl-sc-body'
  const viewToggle = document.createElement('div')
  viewToggle.className = 'fl-sc-viewtoggle'
  const changesBtn = sideViewButton('Changes')
  const phasesBtn = sideViewButton('Phases')
  viewToggle.appendChild(changesBtn)
  viewToggle.appendChild(phasesBtn)
  const changesBody = document.createElement('div')
  changesBody.className = 'fl-sc-view'
  const phasesBody = document.createElement('div')
  phasesBody.className = 'fl-sc-view'
  scBody.appendChild(viewToggle)
  scBody.appendChild(changesBody)
  scBody.appendChild(phasesBody)

  function setViewMode(mode: 'changes' | 'phases'): void {
    changesBtn.classList.toggle('active', mode === 'changes')
    phasesBtn.classList.toggle('active', mode === 'phases')
    changesBody.style.display = mode === 'changes' ? '' : 'none'
    phasesBody.style.display = mode === 'phases' ? '' : 'none'
    state.sideViewMode = mode
    save()
    announceSourceControlVisibility()
  }
  changesBtn.addEventListener('click', () => setViewMode('changes'))
  phasesBtn.addEventListener('click', () => setViewMode('phases'))

  // Wire programmatic reveals (flow:show-git, flow:show-review) — this half
  // sets the pane's view mode; the shell's outer scope adds the half that
  // actually REVEALS the pane (#1202), since the rail/sidebar state lives there.
  document.addEventListener('flow:show-git', () => {
    setViewMode('changes')
  })
  document.addEventListener('flow:show-review', () => {
    setViewMode('phases')
  })

  const PANES = new Map<RailItem, HTMLElement>([
    ['threads', threadsBody],
    ['files', filesBody],
    ['source-control', scBody],
  ])

  function showItem(item: RailItem): void {
    PANES.forEach((pane, id) => {
      pane.style.display = id === item ? '' : 'none'
    })
    // A panel that pays for a read only when somebody is looking has to be TOLD
    // when that changes (allowed-pattern #17). Broadcast rather than called, so
    // the pane's owner subscribes instead of this function growing a reference
    // to every surface that might care.
    document.dispatchEvent(
      new CustomEvent('flow:rail-item-shown', { detail: { item } }),
    )
    // Only append the active pane (avoid all-at-once DOM presence).
    const active = PANES.get(item)
    if (active && !element.contains(active)) {
      element.appendChild(active)
    }
  }

  // Initial render: append all panes (hidden), show the initial one.
  PANES.forEach((pane) => element.appendChild(pane))
  setViewMode('changes')

  return {
    element,
    threadsBody,
    filesBody,
    searchBody,
    treeBody,
    changesBody,
    phasesBody,
    showItem,
    setViewMode,
  }
}

/** A stored fraction array is usable only when every entry is a finite positive
 *  number — stale/corrupt sizes must never yield a pane that fails to fill its
 *  share (the "blank strip" class of bug). */
function areValidSizes(sizes: number[] | undefined, count: number): sizes is number[] {
  return (
    Array.isArray(sizes) &&
    sizes.length === count &&
    sizes.every((n) => Number.isFinite(n) && n > 0)
  )
}

/**
 * Keep `--fl-zoom` in step with the renderer's zoom factor (#1352).
 *
 * View ▸ Zoom In/Out (Electron's stock viewMenu) changes how many device
 * pixels a CSS px is; the macOS traffic lights do not scale with it. Any
 * clearance written as a fixed CSS length therefore drifts — and the zoom
 * survives a relaunch, so one Zoom Out leaves the window controls sitting
 * over the project switcher permanently.
 *
 * Zooming resizes the layout viewport, so `resize` is the signal; there is no
 * dedicated zoom event to listen for.
 */
function trackZoomFactor(): void {
  const apply = (): void => {
    const zoom = window.flow?.zoomFactor?.() ?? 1
    document.documentElement.style.setProperty(
      '--fl-zoom',
      String(Number.isFinite(zoom) && zoom > 0 ? zoom : 1),
    )
  }
  apply()
  window.addEventListener('resize', apply)
}

export function mountShell(root: HTMLElement): ShellSurfaces {
  trackZoomFactor()
  // Live working state for the ACTIVE project's layout (#580). STABLE identity —
  // hydrate() mutates its fields in place on project switch so every closure over
  // `state` (sideTabs, terminal/sidebar toggles, the persistence listeners) stays
  // valid. Provisional default until the active project resolves asynchronously.
  const state: ShellLayoutState = normalizeLayoutState(undefined)
  // The panel model is the source of truth for the root arrangement. Reducers
  // (togglePanel, …) return NEW layouts; applyLayout re-renders + persists.
  let layout: PanelLayout = state.panelLayout ?? normalizePanelLayout(undefined)
  // The scope whose layout is on screen — (project root, thread | null). Null
  // until the first activeProject resolves (no project ⇒ nothing to save).
  let activeScope: LayoutScope | null = null
  const threadLayouts = createThreadLayoutStore<ShellLayoutState>({
    namespace: SCOPED_LAYOUT_STORAGE_KEY,
    storage: () => window.localStorage,
    normalize: normalizeLayoutState,
  })
  // Suppresses saves while hydrate() re-applies stored state (would otherwise
  // read-modify-write the store with in-flight values).
  let hydrating = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  // ── Panels ─────────────────────────────────────────────────────────────
  const conversation = createPanel('conversation', 'Conversation', state, { chromeless: true })

  const editor = createPanel('editor', 'Editor', state, { chromeless: true })

  // Terminal — docked at the bottom of the editor stack (vertical split).
  // Chromeless: toggled in/out of the stack entirely (no header strip when hidden).
  const terminal = createPanel('terminal', 'Terminal', state, { chromeless: true })
  // terminalVisible tracks whether the terminal is currently in the editorStack.
  // Default true; restored from persisted state below (via hydrate).
  let terminalVisible: boolean = state.terminalVisible !== false
  // Whether the editor holds any open tab (file OR view). An empty editor is a
  // content-less void; its stack is dropped from the root split only when
  // nothing else fills the panel area either — no docked terminal and no
  // conversation panel open (#675) — so it never leaves a phantom divider
  // when everything is closed, yet the chat keeps its normal left width when
  // it's open. initEditor wires this via the layoutApi once tabs settle; boot
  // state is "empty" until then.
  let editorHasTabs = false

  const sidebarPanels = createSidebar(state, () => saveActive())

  // The activity sidebar lives as its own root-split child. The threads content
  // (threadsBody) lives inside it — initThreads mounts into threadsBody directly,
  // so replaceChildren on that element never wipes other sidebar panes.
  const activitySidebarWrapper = document.createElement('div')
  activitySidebarWrapper.className = 'fl-activity-sidebar'
  // The activity bar is PREPENDED below (it is built further down, once
  // onRailSelect exists) so the icon row is the sidebar's first line.

  // Activity-bar: the active rail item and whether the sidebar panel is open.
  let activeRailItem: RailItem = resolveRailItem(state.activeRailItem)
  let sidebarOpen: boolean = state.sidebarOpen !== false

  /** The ONE focus-mode swallow rule (#836/#924/#967/#968, allowed-pattern #14):
   *  focus mode (⌘⌥Z) is a pure overlay — no panel or sidebar can render under
   *  it, so a panel-visibility mutation from ANY input path (⌘B, ⌘1-3, ⌘⌥C/⌘⌥D,
   *  the titlebar sidebar button, a rail item click) would only rewrite the
   *  layout the user gets back on exit, invisibly and silently. Every such
   *  mutator asks this before acting, so the rule can't drift per input device.
   *  Returns true when the action must be swallowed. */
  function swallowedByFocusMode(): boolean {
    return layout.focusMode
  }

  function onRailSelect(item: RailItem): void {
    // Inert under focus mode (#924 — ⌘1-3 and the rail icons both land here):
    // the sidebar can't render behind the overlay, so this would only reopen or
    // switch a sidebar the user never sees until they exit.
    if (swallowedByFocusMode()) return
    if (item === activeRailItem && sidebarOpen) {
      // Re-clicking the active item collapses the sidebar.
      sidebarOpen = false
    } else {
      activeRailItem = item
      sidebarOpen = true
    }
    state.activeRailItem = activeRailItem
    state.sidebarOpen = sidebarOpen
    activityBar.setActive(activeRailItem)
    applySidebarBody()
    saveActive()
  }

  const activityBar = buildActivityBar(activeRailItem, onRailSelect)

  // The icon row, then the swappable pane: the sidebar's own two rows. The rail
  // used to be a 48px column to the left of this wrapper; it moved in here so
  // the window has no vertical strip and the panes start at the window edge.
  activitySidebarWrapper.appendChild(activityBar.element)

  // WHOSE FILES THE FILES ITEM OPENS. The worktree panel owns the answer; this
  // paints it, so the rail, the thread row and the panel all show one glyph for
  // one fact.
  document.addEventListener('flow:files-are-copy', (event) => {
    const isCopy = (event as CustomEvent<{ isCopy?: boolean }>).detail?.isCopy === true
    activityBar.setFilesAreCopy(isCopy)
  })
  activitySidebarWrapper.appendChild(sidebarPanels.element)

  // Show the initial sidebar item.
  sidebarPanels.showItem(activeRailItem)

  // Map each movable panel id → the STABLE WRAPPER reconciled into the root split.
  // Only conversation remains movable; activity sidebar is managed outside the model.
  const panelElements: Record<'conversation', HTMLElement> = {
    conversation: wrapMovablePanel(conversation, 'conversation'),
  }

  // ── Splits ─────────────────────────────────────────────────────────────
  // Editor stack — editor always present; terminal added when terminalVisible.
  const editorStack = createSplit('editor-stack', 'vertical', state, terminalVisible ? [editor, terminal] : [editor])
  editorStack.setAttribute('min-size', '96')

  // THE EMPTY-PANEL WATERMARK (#1538). The last-resort surface for the one
  // layout that renders nothing at all: chat, terminal and sidebar put away on
  // a window with no editor tabs. It exists so the non-empty invariant has
  // something to be true WITH — the model can force `editorVisible` back on,
  // but it cannot conjure a tab for the editor to show.
  //
  // It names the way back rather than just filling space: nothing on screen
  // said how to get anything back, which is why the state reads as a crash
  // instead of a layout the user chose. It offers KEYS only — the icon row
  // rides inside the sidebar, so in this exact state there is no rail to point
  // at, and a hint naming a control that isn't rendered is worse than none.
  const emptyPanel = document.createElement('div')
  emptyPanel.className = 'fl-empty-panel'
  emptyPanel.setAttribute('data-testid', 'empty-panel')
  emptyPanel.innerHTML = `
    <div class="fl-empty-panel-body">
      <p class="fl-empty-panel-title">Everything is put away</p>
      <p class="fl-empty-panel-hint">
        <kbd>⌘B</kbd> brings the sidebar back · <kbd>⌘⌥C</kbd> the chat · <kbd>⌃\`</kbd> the terminal
      </p>
    </div>
  `

  /** Re-apply the persisted editor|terminal fractions to the editor stack
   *  (#1059). Every drag of the stack gutter IS persisted (fl-split-resize →
   *  state.splits), but createSplit applied stored sizes exactly once — at
   *  shell construction, before any project hydrated — so the dragged height
   *  snapped back to 50/50 on every hide/show, project switch and relaunch
   *  while the sibling root split restored fine. Called wherever the stack's
   *  pane set changes (reconcileEditorStack) and on hydrate. Validated against
   *  the CURRENT pane count so a stale 1-pane/2-pane mismatch never yields a
   *  blank strip; the attribute keeps fl-split's own child-list rebuild from
   *  reverting to equal fractions. */
  function applyStoredStackSizes(): void {
    const stored = state.splits[editorStack.id]
    if (areValidSizes(stored, editorStack.children.length)) {
      editorStack.setAttribute('sizes', stored.join(','))
      editorStack.setSizes(stored)
    } else {
      // No usable stored value for THIS pane count/project — drop any stale
      // attribute so fl-split falls back to its equal-fraction default instead
      // of another project's lingering fractions.
      editorStack.removeAttribute('sizes')
    }
  }

  /** Add or remove the terminal from the editor stack and persist. `announce`
   *  fires flow:terminal-shown on a USER reveal so the terminal panel
   *  auto-starts a shell when none is live (VS Code parity — the listener is
   *  terminal-panel.ts's ensureStarted). Silent restores (hydrate) skip it so
   *  re-applying persisted state never spawns a shell by itself. */
  /** What the last announcement said, so only real transitions are announced. */
  let announcedTerminalVisible = false

  function reconcileEditorStack(announce = false): void {
    const hasTerminal = editorStack.contains(terminal)
    if (terminalVisible && !hasTerminal) {
      editorStack.appendChild(terminal)
      // Restore the user's dragged editor|terminal height rather than the
      // 50/50 default the re-append would otherwise land on (#1059).
      applyStoredStackSizes()
      if (announce) {
        document.dispatchEvent(new CustomEvent('flow:terminal-shown'))
      }
    } else if (!terminalVisible && hasTerminal) {
      editorStack.removeChild(terminal)
    }
    state.terminalVisible = terminalVisible
    saveActive()
    // ── WHAT THE TERMINAL JUST BECAME ──────────────────────────────────────
    //
    // Announced HERE because this is where every path converges — `toggleTerminal`
    // (the rail item, ⌃`, the footer button) and `showTerminal` (the palette)
    // both end in it — and on the TRANSITION rather than on the append.
    //
    // Three signals were tried before this one and each was subtly wrong:
    // `flow:show-terminal` is a REQUEST only some surfaces dispatch;
    // `flow:terminal-shown` fires only when the element is APPENDED, so a
    // terminal that was already in the stack came back silently; and a flag in
    // `toggleTerminal` alone missed `showTerminal` entirely. Each version left
    // the browser's debug drawer open beside a terminal that had just returned
    // (user, 2026-09-21, twice).
    if (terminalVisible !== announcedTerminalVisible) {
      announcedTerminalVisible = terminalVisible
      document.dispatchEvent(
        new CustomEvent('flow:terminal-visibility', { detail: { visible: terminalVisible } }),
      )
    }
  }

  /** Toggle the terminal from a USER control (⌃` or the Terminal rail action).
   *  The terminal lives inside the editorStack, which is detached from the root
   *  split whenever the editor is hidden (⌘⌥D) — so a naive terminalVisible flip
   *  is a dead control that lies about its state (#626, reopened by #668/#674).
   *  Honest semantics: the terminal is "effectively visible" only when the editor
   *  host is also shown. Asking for it while the editor is hidden re-surfaces it
   *  in ONE action by bringing the editor host back; hiding it (when effectively
   *  visible) just drops it from the stack. */
  function toggleTerminal(): void {
    const effectivelyVisible = layout.editorVisible && terminalVisible
    if (effectivelyVisible) {
      terminalVisible = false
      reconcileEditorStack(false)
      // If the terminal was the editor stack's only content (empty editor), the
      // stack is now content-less — re-reconcile so it collapses (#675).
      applyLayout(layout)
      return
    }
    terminalVisible = true
    // Bring the editor host back (if hidden) AND (re)include its stack now that
    // the terminal makes it non-empty — attach BEFORE announcing so the shell
    // auto-starts in an attached node.
    applyLayout(layout.editorVisible ? layout : toggleEditor(layout))
    reconcileEditorStack(true)
    // applyLayout painted the toggles BEFORE the terminal was attached, so the
    // Terminal control read "hidden" beside a terminal that had just come
    // back (#1401's honesty rule, broken on the reveal path). Paint again now
    // that it is in the stack.
    syncToggleStates()
  }

  /** The ⌃` / ⌘J shortcut governs the BOTTOM SLOT, not just the terminal.
   *  Editor-area surfaces (the blueprint's peek / learning / story / drift
   *  panes) open in the same strip the terminal lives in; toggling the
   *  terminal on top of them stacked two bottom panes into a sliver. The
   *  shortcut now asks those surfaces first (flow:terminal-will-toggle,
   *  synchronous): if one was open it closes itself and claims the event, and
   *  the terminal REPLACES it in the freed slot; otherwise plain toggle.
   *  Terminal-specific controls (rail item, header ⌄, footer button) keep
   *  their exact semantics — only the shared shortcut arbitrates the slot. */
  function toggleBottomArea(): void {
    // #1034: arbitrate the slot ONLY when the terminal is about to be REVEALED —
    // that's the case the anti-stacking replace semantics were written for. On
    // the hide path (terminal already visible) the shortcut must behave exactly
    // like the rail Terminal item: hide the terminal, never evict a blueprint
    // bottom pane the user is reading. The old unconditional dispatch let the
    // board claim the event while the terminal was visible, so ⌃`/⌘J became a
    // no-op that silently destroyed the open peek/learning/story/drift pane.
    const revealing = !(layout.editorVisible && terminalVisible)
    if (!revealing) {
      toggleTerminal()
      return
    }
    const intent = new CustomEvent<{ replaced: boolean }>('flow:terminal-will-toggle', {
      detail: { replaced: false },
      bubbles: true,
      composed: true,
    })
    document.dispatchEvent(intent)
    toggleTerminal() // reveal — into the freed slot if a pane claimed the event
  }

  /** REVEAL the terminal (never hide it) and ensure a live shell — the ⌘P
   *  palette's "New terminal" entry point (flow:show-terminal). Unlike
   *  toggleTerminal, an already-visible panel gets an ADDITIONAL terminal rather
   *  than being dismissed, so "New terminal" always ends with a shell on screen. */
  function showTerminal(): void {
    const effectivelyVisible = layout.editorVisible && terminalVisible
    if (effectivelyVisible) {
      document.dispatchEvent(new CustomEvent('flow:terminal-new'))
      return
    }
    terminalVisible = true
    applyLayout(layout.editorVisible ? layout : toggleEditor(layout))
    reconcileEditorStack(true) // fires flow:terminal-shown → ensureStarted spawns one
    syncToggleStates() // see toggleTerminal: the paint above predates the attach
  }
  document.addEventListener('flow:show-terminal', showTerminal)
  // The editor's top bar owns the Terminal control now, and it is in another
  // module — so the toggle gets a channel rather than a shared reference.
  document.addEventListener('flow:toggle-terminal', () => {
    toggleTerminal()
  })

  // Collapse/hide the terminal from its own header button (#703). A pure HIDE
  // (never a toggle-that-reveals): only acts when the terminal is effectively
  // visible, so it can't accidentally surface a hidden terminal. Re-open with
  // ⌘J / ⌃` / the Terminal rail item.
  document.addEventListener('flow:hide-terminal', () => {
    if (terminalVisible && layout.editorVisible) toggleTerminal()
  })

  // Ensure the editor area is visible — surfaces that open an editor-area tab
  // (Blueprint, Board, a file) dispatch this so they still appear when the user
  // has hidden the editor (⌘⌥D); otherwise the tab opens into a hidden host.
  document.addEventListener('flow:show-editor', () => {
    if (!layout.editorVisible) applyLayout(toggleEditor(layout))
  })

  // Ensure the Chat (conversation) panel is visible — actions whose whole
  // purpose is to open a conversation (new thread, open thread, ⌘P slash
  // commands) dispatch this so they still land when the user hid the chat with
  // ⌘⌥C (#1071); the exact sibling of flow:show-editor above (#1057). Reveal
  // only — it never hides an already-visible panel.
  document.addEventListener('flow:show-chat', () => {
    // Whichever reason put it away — ⌘⌥C, or the right side expanded over it.
    const next = revealChat(layout)
    if (next !== layout) applyLayout(next)
  })

  // #1219: the threads panel's hide control puts the chat away too ("the chat
  // thread and list"). Hide-only, mirroring flow:show-chat — a toggle here
  // would flip an already-hidden chat back on when the sidebar re-applies its
  // persisted mode at boot.
  document.addEventListener('flow:hide-chat', () => {
    if (swallowedByFocusMode()) return
    // Hide-only: a chat already off screen (the right side expanded over it)
    // stays as it is — a toggle there would bring it back.
    if (chatOnScreen(layout)) applyLayout(togglePanel(layout, 'conversation'))
  })

  // Discoverable Chat toggle — the ⌘P palette's "Toggle Chat" entry (#967/#1071):
  // a hidden chat must never be recoverable by shortcut only. Inert under focus
  // mode like every other panel mutator.
  document.addEventListener('flow:toggle-chat', () => {
    if (swallowedByFocusMode()) return
    applyLayout(togglePanel(layout, 'conversation'))
  })

  // Root split — model-driven: applyLayout reconciles its children to the
  // buildSplitPlan of the current PanelLayout ([…left · editorStack · …right]).
  const rootSplit = document.createElement('fl-split')
  rootSplit.id = 'fl-split-root'
  rootSplit.setAttribute('direction', 'horizontal')
  rootSplit.setAttribute('min-size', '180')

  // ── Status bar ─────────────────────────────────────────────────────────
  const statusBar = document.createElement('footer')
  statusBar.className = 'fl-status-bar'
  // Bottom-left: the Accounts button (replaces the old static "no repo" item).
  // The live flow status line ("flow: idle", autopilot, unread) is mounted
  // into this footer by initFlowUi — no static placeholder here, or it shows
  // up twice.

  // Focus-mode exit affordance (#616) — a persistent, clickable pill shown only
  // while focus mode is on. Its visibility is driven by syncToggleStates.
  const focusHint = document.createElement('button')
  focusHint.type = 'button'
  focusHint.className = 'fl-focus-hint'
  focusHint.textContent = 'Focus mode · Esc to exit'
  focusHint.title = 'Exit focus mode (Esc or ⌘⌥Z)'
  focusHint.hidden = true
  focusHint.addEventListener('click', () => applyLayout(setFocusMode(layout, false)))

  // ── Title bar ────────────────────────────────────────────────────────────
  // A slim draggable strip. Its padding clears the OS window controls — the
  // macOS traffic lights on the left (titleBarStyle: 'hiddenInset'), the
  // Windows control box on the right (Window Controls Overlay) — so nothing
  // collides with the close/min/max buttons. See `platform-affordances.ts`.
  // Also the home for global actions.
  const titleBar = document.createElement('header')
  titleBar.className = 'fl-titlebar'

  // Sidebar toggle (⌘B) — removes/restores the Threads pane from the root
  // split. Restored as the first pane so column order is preserved.
  const sidebarToggle = document.createElement('button')
  sidebarToggle.type = 'button'
  sidebarToggle.className = 'fl-titlebar-icon'
  sidebarToggle.title = 'Toggle sidebar (⌘B)'
  const sidebarIcon = document.createElement('fl-icon')
  sidebarIcon.setAttribute('name', 'sidebar-left')
  sidebarIcon.setAttribute('size', '14')
  sidebarToggle.appendChild(sidebarIcon)
  // ⌘B toggles the activity sidebar (activitySidebarWrapper) open/closed.
  // Threads is now inside the sidebar, so closing the sidebar hides threads too.
  function setSidebarVisible(visible: boolean): void {
    if (sidebarOpen === visible) {
      syncToggleStates()
      return
    }
    sidebarOpen = visible
    state.sidebarOpen = sidebarOpen
    applySidebarBody()
    saveActive()
  }
  /** USER-initiated sidebar toggle — the titlebar button AND ⌘B route through
   *  here so the focus-mode swallow rule lives in one place (#836 keyboard path,
   *  #968 mouse path): inert under the overlay, the sidebar returns on exit
   *  exactly as the user left it. */
  function toggleSidebarFromUser(): void {
    if (swallowedByFocusMode()) return
    setSidebarVisible(!sidebarOpen)
  }
  sidebarToggle.addEventListener('click', toggleSidebarFromUser)
  // Creating a thread reveals the sidebar and switches to the Threads view.
  // #1202: "Show Git" / "Show Review" REVEAL the Source Control pane. Their only
  // listeners set the pane's view mode and nothing else — no open of a closed
  // sidebar, no rail switch — and since the default rail item is Threads,
  // running either from a stock window flipped a toggle inside a pane the user
  // cannot see: the palette closed and the screen was byte-for-byte identical.
  // Every other navigational command reveals its surface first (#1057's
  // flow:show-editor, #1071's flow:show-chat, and why "New terminal" maps to
  // flow:show-terminal rather than flow:terminal-new).
  const revealSourceControl = (): void => {
    // A "show" must never toggle OFF, so this reveals directly instead of going
    // through onRailSelect, which collapses an already-active item.
    activeRailItem = 'source-control'
    sidebarOpen = true
    state.activeRailItem = activeRailItem
    state.sidebarOpen = sidebarOpen
    activityBar.setActive(activeRailItem)
    applySidebarBody()
    saveActive()
  }
  document.addEventListener('flow:show-git', revealSourceControl)
  document.addEventListener('flow:show-review', revealSourceControl)

  // #search: "Show Search" (⌘⇧F) reveals the pane the search box lives in — the
  // FILES pane, since 2026-09-18 — and focuses its input. Reveals directly
  // (never toggles OFF), mirroring revealSourceControl.
  const revealSearch = (): void => {
    if (layout.focusMode) applyLayout(setFocusMode(layout, false))
    activeRailItem = 'files'
    sidebarOpen = true
    state.activeRailItem = activeRailItem
    state.sidebarOpen = sidebarOpen
    activityBar.setActive(activeRailItem)
    applySidebarBody()
    saveActive()
    // Let the pane mount/lay out before focusing its input.
    requestAnimationFrame(() => document.dispatchEvent(new CustomEvent('flow:focus-search-input')))
  }
  document.addEventListener('flow:show-search', revealSearch)

  document.addEventListener('flow:reveal-sidebar', (event) => {
    // #1201: the ⌘P palette sits ABOVE the modal guard and focus mode is not a
    // modal, so "Reveal Sidebar" (and "New thread", which fires the same event)
    // reached this handler under focus mode — the ONE panel mutator that never
    // asked swallowedByFocusMode(). It force-set the rail to Threads and
    // saveActive()'d that behind the overlay: nothing visible happened, and on
    // exit the user got Threads / "No threads yet" instead of the Files tree
    // they had been working in — persisted, so it survived a restart.
    //
    // Swallowing would make an explicitly-invoked command a dead click, so this
    // takes the other route the codebase already uses: the HONEST TOGGLE (⌃`
    // does it for the hidden editor) — leave focus mode, then reveal, so the
    // thing the user asked for is actually on screen.
    if (layout.focusMode) applyLayout(setFocusMode(layout, false))
    sidebarOpen = true
    // #1201: the rail switch is OPT-IN. This handler used to force 'threads' on
    // every caller, so the palette's generic "Reveal Sidebar" discarded the
    // user's rail selection — they were in Files, and came back to Threads /
    // "No threads yet", persisted. The three thread-flow callers (new thread,
    // open thread, open project) ask for it explicitly; nobody else does.
    const requestedRail = (event as CustomEvent<{ rail?: RailItem }>).detail?.rail
    if (requestedRail) activeRailItem = requestedRail
    state.activeRailItem = activeRailItem
    state.sidebarOpen = sidebarOpen
    activityBar.setActive(activeRailItem)
    applySidebarBody()
    saveActive()
  })

  // ── Right-hand area toggle (⌘⌥B) — the mirror of the sidebar toggle ──────
  // The left corner puts the sidebar away; the right corner puts away the
  // whole editor area (its tabs, its chrome icons and the terminal docked
  // under it), and the conversation takes the freed width (user, 2026-10-06).
  // The rules — pressed means on screen, a press is never dead — live in
  // right-area-model.ts; the state is the panel model's own editorVisible, so
  // it persists with the layout and every flow:show-editor brings it back.
  const rightAreaToggle = document.createElement('button')
  rightAreaToggle.type = 'button'
  rightAreaToggle.className = 'fl-titlebar-icon fl-right-area-toggle'
  rightAreaToggle.setAttribute('data-testid', 'right-area-toggle')
  rightAreaToggle.setAttribute('aria-label', 'Editor area')
  const rightAreaIcon = document.createElement('fl-icon')
  rightAreaIcon.setAttribute('name', 'sidebar-right')
  rightAreaIcon.setAttribute('size', '14')
  rightAreaToggle.appendChild(rightAreaIcon)
  // A chrome press must not move the keyboard (the Settings gear's rule).
  rightAreaToggle.addEventListener('mousedown', (event) => event.preventDefault())
  /** Whether the editor stack is in the window right now. */
  function rightAreaContext(): { rendered: boolean; otherSurfacesVisible: boolean } {
    return {
      rendered: rootSplit.contains(editorStack),
      otherSurfacesVisible: sidebarOpen && !layout.focusMode,
    }
  }
  /** USER-initiated — the titlebar button AND ⌘⌥B route through here. */
  function toggleRightAreaFromUser(): void {
    if (swallowedByFocusMode()) return
    applyLayout(toggleRightArea(layout, rightAreaContext()))
  }
  rightAreaToggle.addEventListener('click', toggleRightAreaFromUser)

  // ── Expand the right side — the chat steps aside (user, 2026-10-09) ──────
  // Beside the toggle above: one press takes only the chat column off screen;
  // the sidebar stays and the right side takes the freed width. The next press
  // (or Escape) gives the chat its column back. The rules live in
  // expand-right-model.ts; the state is the panel model's `rightExpanded`, so
  // it is remembered per project and thread with the rest of the layout.
  const expandToggle = document.createElement('button')
  expandToggle.type = 'button'
  expandToggle.className = 'fl-titlebar-icon fl-expand-right-toggle'
  expandToggle.setAttribute('data-testid', 'expand-right-toggle')
  const expandIcon = document.createElement('fl-icon')
  expandIcon.setAttribute('name', rightExpandedIcon(false))
  expandIcon.setAttribute('size', '14')
  expandToggle.appendChild(expandIcon)
  expandToggle.addEventListener('mousedown', (event) => event.preventDefault())
  expandToggle.addEventListener('click', () => {
    if (swallowedByFocusMode()) return
    applyLayout(toggleRightExpanded(layout))
  })

  // Blueprint's open affordance lives in the EDITOR tab strip's actions
  // slot (see renderer/editor/index.ts) — it is an editor-level action,
  // not a global titlebar one.

  const brand = document.createElement('span')
  brand.className = 'fl-titlebar-brand'
  brand.appendChild(flowMark(15))
  const brandWord = document.createElement('span')
  brandWord.className = 'fl-brand-word'
  brandWord.textContent = 'flow'
  brand.appendChild(brandWord)
  // ── Orientation ─────────────────────────────────────────────────────────
  // The titlebar used to append the ACTIVE THREAD'S NAME after the project
  // chip whenever that thread had a checkout of its own — orientation for the
  // one state where the editor, the terminal and source control are all
  // pointed at a checkout of its own rather than the project itself. Removed
  // on the user's report: the thread's name is already on screen, selected, in
  // the list two rows below, so the titlebar was spending its width on a
  // second copy of it. What went with it is the OWN-BRANCH signal, which the
  // name was only the carrier for; Source Control's branch line and the
  // conversation files list still say that where a person can act on it.
  // THE DROPDOWN CHOOSES A WORKSPACE (Workspaces Phase 9; always, since the
  // hard migration — every project lives in one, so there is no project
  // switcher beside it any more).
  const workspaceSwitcher = buildWorkspaceSwitcher()

  titleBar.appendChild(sidebarToggle)
  // The switcher is the FIRST item of the sidebar's rail now (user,
  // 2026-10-06), not a titlebar dropdown.
  activityBar.element.insertBefore(workspaceSwitcher, activityBar.element.firstChild)
  // Right-aligned slot — the update chip (update-banner.ts) mounts here so
  // update availability reads as part of the titlebar, not a floating popup.
  const titlebarRight = document.createElement('div')
  titlebarRight.className = 'fl-titlebar-right'
  // THE GEAR MOVED DOWN to the editor's top bar, where the other chrome icons
  // are. It sat alone in the window's corner with a row of four icons directly
  // beneath it — two stacked strips of icons, which is one more than there is
  // any reason for (user, 2026-09-17). The update chip still mounts into this
  // slot and still prepends itself; with the gear gone it simply has the corner
  // to itself.
  // The right-area toggle sits in the window's right corner, the way the
  // sidebar toggle sits in the left one. The update chip prepends itself into
  // this slot, so the toggle stays the last thing on the row.
  titlebarRight.appendChild(expandToggle)
  titlebarRight.appendChild(rightAreaToggle)
  titleBar.appendChild(titlebarRight)
  // Adding / opening projects now lives in the left sidebar's Projects header,
  // so the titlebar no longer carries a global "Open Project" action.
  // Brand is absolutely centered (overlay) — appended last, out of flow.
  titleBar.appendChild(brand)

  // ── Assemble ───────────────────────────────────────────────────────────
  injectShellStyles()
  root.textContent = ''
  root.className = 'fl-shell'
  root.appendChild(titleBar)
  const main = document.createElement('div')
  main.className = 'fl-shell-main'
  main.appendChild(rootSplit)
  root.appendChild(main)
  // ── Debug session ────────────────────────────────────────────────────────
  // THE BUTTON IS IN THE BROWSER TOOLBAR, beside Inspect — that is where a
  // person is standing when they decide to record something (user, 2026-09-21).
  // It started here in the status bar, on the reasoning that a session records
  // the terminals too and therefore belongs to the window; in practice the
  // bottom strip is the corner nobody looks at, and the button landed directly
  // under the browser's own Console/Network tabs, reading as part of them.
  //
  // What stays here is the SESSION ITSELF and the outcome message. The runner
  // outlives any browser tab, which the chrome that draws the button does not;
  // and a transient sentence about what just happened is what a status bar is
  // for. The palette keeps the action reachable from every other tab.
  const debugNote = document.createElement('span')
  debugNote.className = 'fl-status-item fl-debug-note'
  debugNote.hidden = true
  let debugNoteTimer: ReturnType<typeof setTimeout> | null = null

  let lastOpenedThreadId: string | null = null
  document.addEventListener('flow:open-thread', (event) => {
    const detail = (event as CustomEvent<{ threadId?: string }>).detail
    if (typeof detail?.threadId === 'string') lastOpenedThreadId = detail.threadId
  })

  const debugRunner = createDebugSessionRunner({
    api: window.flow.debug,
    activeThreadId: () => lastOpenedThreadId,
    // SAID WHERE IT HAPPENED. There is no general toast surface in this shell,
    // and inventing one for this would be a second notification system; the
    // status bar is already always on screen, which is the whole reason the
    // control lives here.
    notify: (message) => {
      debugNote.textContent = message
      debugNote.hidden = false
      if (debugNoteTimer !== null) clearTimeout(debugNoteTimer)
      debugNoteTimer = setTimeout(() => {
        debugNote.hidden = true
      }, 12_000)
    },
  })
  statusBar.appendChild(debugNote)
  void debugRunner

  root.appendChild(statusBar)
  // Focus-mode exit affordance (#616): a persistent pill shown only while focus
  // mode is on, so the mode is visible and escapable without knowing ⌘⌥Z.
  root.appendChild(focusHint)

  // SETTINGS IS A PAGE NOW, and a page needs the editor to open into — so it
  // is wired in main.ts, after `initEditor`, alongside the Tasks board and the
  // Blueprint. Nothing here mounts it any more.
  // Flow settings overlay (per-project .flowconfig) — self-mounts, listens for
  // the status-bar ⚙ button's flow:open-flow-settings event.
  initFlowSettings()

  // ── Persistence wiring ─────────────────────────────────────────────────
  root.addEventListener('fl-split-resize', (event) => {
    const split = event.target
    if (split instanceof FlSplit && split.id) {
      // The root split stores fractions PER COMPOSITION (#1111): a drag made
      // with the chat (or sidebar) hidden must not overwrite the tuned widths
      // of a different arrangement under one shared key.
      const key =
        split === rootSplit
          ? rootSizesKey(rootSignature(Array.from(split.children)))
          : split.id
      state.splits[key] = split.getSizes()
      saveActive()
    }
  })

  root.addEventListener('fl-panel-toggle', (event) => {
    const panel = event.target as FlPanel
    if (!panel.id) {
      return
    }
    state.collapsed[panel.id] = panel.collapsed
    saveActive()
    syncCollapsedPane(panel)
  })

  // VS Code keyboard parity. Capture so it fires regardless of focus
  // (Monaco/xterm otherwise swallow these). `event.code === 'Backquote'` is
  // used instead of `event.key` because Shift turns the backtick into '~'.
  window.addEventListener(
    'keydown',
    (event) => {
      // A modal overlay (settings, onboarding wizard, command palette, a
      // tasks-board modal…) owns the keyboard while open — don't let global panel
      // shortcuts mutate the layout behind it, and don't let ⌃` open a terminal
      // that steals focus and kills Escape (#525). Asked of the shared registry,
      // not of one class: enumerating `.fl-settings-overlay` here silently left
      // the board modals unguarded (#1002).
      if (isModalOverlayOpen()) return
      // Escape is a discoverable exit from focus mode — a whole-UI overlay whose
      // only other exit is re-pressing ⌘⌥Z (#616). #1161: it now really is
      // "skipped while a menu is open", which this comment always claimed but
      // the code never did. Focus mode is the EDITOR-only view, so Monaco's
      // find widget and the shell's popup menus are exactly what the user is
      // looking at; they register on `document` and always lost to this capture
      // listener, so one Escape both dismissed the widget and tore the whole
      // layout back open. The pill's promised exit is still one Escape away —
      // once the thing in front has taken its own.
      if (
        event.key === 'Escape' &&
        shouldExitFocusMode({
          focusMode: layout.focusMode,
          modalOpen: false, // isModalOverlayOpen() already returned above
          popupOpen: anyPresent(ESCAPE_OWNING_POPUPS),
          editorWidgetOpen: anyPresent(ESCAPE_OWNING_EDITOR_WIDGETS),
        })
      ) {
        event.preventDefault()
        applyLayout(setFocusMode(layout, false))
        return
      }
      // ⌃` — toggle the terminal panel (VS Code parity). Honest toggle: when the
      // editor is hidden, asking for the terminal brings its editor host back in
      // one action rather than being a dead control (#626/#674). Backquote used
      // (not event.key) because Shift makes it '~'.
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Backquote') {
        event.preventDefault()
        toggleBottomArea()
        return
      }
      // #1099: while the terminal owns the keyboard, Ctrl-only chords belong to
      // the SHELL — Ctrl+P is readline previous-history, Ctrl+J accept-line,
      // Ctrl+B backward-char / the tmux prefix, Ctrl+1-5 pass to TUIs. The
      // app's advertised bindings are ⌘-based on macOS, and preventDefault()
      // here never stopped propagation to xterm, so each stolen chord fired the
      // layout action AND reached the PTY (destructive, not just surprising).
      // ⌃` above stays exempt: it is the documented terminal toggle and has no
      // readline meaning. ⌘-chords keep working from inside the terminal.
      if (event.ctrlKey && !event.metaKey && document.activeElement?.closest('.fl-term-host')) {
        return
      }
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      // ⌘P / Ctrl+P — command palette (quick-open). ⌘⇧P opens straight into
      // command mode (the `>` prefix). Placed AFTER the modal-overlay guard so a
      // second ⌘P while the palette is open is owned by the palette, not this.
      // `event.code === 'KeyP'` (not `key`) so Shift's glyph shift is irrelevant.
      if (mod && !event.altKey && event.code === 'KeyP') {
        event.preventDefault()
        document.dispatchEvent(
          new CustomEvent('flow:open-palette', {
            detail: { mode: event.shiftKey ? 'command' : 'content' },
          }),
        )
        return
      }
      // ⌘1-6 / Ctrl+1-6 — rail items (VS Code style).
      // 1-3 and 6 switch the sidebar; 4-5 open editor tabs.
      if (mod && !event.altKey && !event.shiftKey && event.code.startsWith('Digit')) {
        const digit = parseInt(event.code.replace('Digit', ''), 10)
        if (digit === 1) { event.preventDefault(); onRailSelect('threads'); return }
        if (digit === 2) { event.preventDefault(); onRailSelect('files'); return }
        if (digit === 3) { event.preventDefault(); onRailSelect('source-control'); return }
        if (digit === 4) { event.preventDefault(); document.dispatchEvent(new CustomEvent('flow:open-board')); return }
        if (digit === 5) { event.preventDefault(); document.dispatchEvent(new CustomEvent('flow:open-blueprint')); return }
        // Search is in the Files pane now, so its shortcut opens that pane and
        // puts the caret in the box — the same thing ⌘⇧F does.
        if (digit === 6) { event.preventDefault(); document.dispatchEvent(new CustomEvent('flow:show-search')); return }
      }
      if (key === 'j' && mod && !event.altKey && !event.shiftKey) {
        // ⌘/Ctrl+J — toggle the bottom slot (VS Code parity, #674): terminal
        // when the slot is free, replace when a blueprint pane occupies it.
        event.preventDefault()
        toggleBottomArea()
      } else if (key === 'b' && mod && event.shiftKey) {
        // ⌘/Ctrl+⇧B — open the blueprint board (#1175). The composer's Blueprint
        // button advertises this shortcut in its tooltip, but nothing bound it:
        // the sidebar toggle below matched `key === 'b' && mod` with NO shift
        // guard, so ⌘⇧B fell through to ⌘B — the board never opened and the
        // user's thread sidebar silently vanished instead. A shortcut that is
        // simultaneously dead and destructive-looking.
        event.preventDefault()
        document.dispatchEvent(new CustomEvent('flow:open-blueprint'))
      } else if (key === 'f' && mod && event.shiftKey) {
        // ⌘/Ctrl+⇧F — reveal the content-search pane and focus its input
        // (VS Code parity). Reveals directly, never toggles off.
        event.preventDefault()
        document.dispatchEvent(new CustomEvent('flow:show-search'))
      } else if (key === 'b' && mod && !event.altKey) {
        // ⌘/Ctrl+B — toggle the activity sidebar (threads/files/source-control).
        // Routed through toggleSidebarFromUser so it shares the titlebar
        // button's focus-mode guard (#836 keyboard path, #968 mouse path): the
        // sidebar can't render under the overlay, so the toggle would only
        // invert the restore state behind it — the user exits focus mode and
        // finds their open sidebar silently gone (the focus-mode analog of the
        // #525 modal shortcut-isolation).
        event.preventDefault()
        toggleSidebarFromUser()
      } else if (mod && event.altKey && !event.shiftKey) {
        // ── Panel-layout shortcuts (⌘/Ctrl+⌥ + key). Matched on `event.code`,
        //    not `event.key`: on macOS ⌥+letter yields a special glyph in
        //    `event.key` (⌥C → 'ç'), but `event.code` stays 'KeyC' regardless.
        //    ⌘⌥ + letter / horizontal-arrow avoids Monaco's bindings (⌘F find,
        //    ⌥F/⇧⌥F format, ⌥⌘↑/↓ multi-cursor, ⌘K chords).
        //    ⌘⌥C/⌘⌥D are inert under focus mode (#967): no panel can render
        //    behind the overlay, so the toggle would silently drop the Chat
        //    panel from the layout the user gets back on exit — persisted per
        //    project, with ⌘⌥C the only way back. Only ⌘⌥Z (exit) acts.
        switch (event.code) {
          case PANEL_KEY_TOGGLE_CHAT: // ⌘⌥C — toggle the Chat (conversation) panel.
            event.preventDefault()
            if (!swallowedByFocusMode()) applyLayout(togglePanel(layout, 'conversation'))
            break
          case PANEL_KEY_TOGGLE_EDITOR: // ⌘⌥D — toggle the center editor area.
            event.preventDefault()
            if (!swallowedByFocusMode()) applyLayout(toggleEditor(layout))
            break
          case PANEL_KEY_TOGGLE_RIGHT_AREA: // ⌘⌥B — the right-hand area (mirror of ⌘B).
            event.preventDefault()
            toggleRightAreaFromUser()
            break
          case PANEL_KEY_TOGGLE_FOCUS: // ⌘⌥Z — toggle focus mode.
            event.preventDefault()
            applyLayout(setFocusMode(layout, !layout.focusMode))
            break
          default:
            break
        }
      }
    },
    true,
  )

  // Escape leaves the expanded right side — in the BUBBLE phase, unlike the
  // capture listener above, so a menu, a popover or a field that handles its
  // own Escape (and says so with preventDefault) gets the key first. What
  // does not say so is asked of the DOM: open modals, menus, Monaco widgets,
  // and focus in a terminal, the code editor or a text field.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    const active = document.activeElement
    const leave = shouldLeaveExpandedOnEscape({
      expanded: rightExpandedShown(layout),
      handled: event.defaultPrevented,
      modalOpen: isModalOverlayOpen(),
      popupOpen: anyPresent(ESCAPE_OWNING_POPUPS) || anyOnScreen(ESCAPE_OWNING_GENERIC_POPUPS),
      editorWidgetOpen: anyPresent(ESCAPE_OWNING_EDITOR_WIDGETS),
      focusInEditable:
        active instanceof Element && active.closest(ESCAPE_OWNING_FOCUS_TARGETS.join(',')) !== null,
    })
    if (!leave) return
    event.preventDefault()
    applyLayout(leaveRightExpanded(layout))
  })

  // Reflect any restored collapsed panels into their splits.
  for (const panel of [conversation, editor]) {
    if (panel.collapsed) {
      syncCollapsedPane(panel)
    }
  }

  // ── Model-driven layout ──────────────────────────────────────────────────

  /** Whether the activity sidebar is shown, mirrored onto the sidebar toggle. */
  function syncToggleStates(): void {
    // #1162: the RAIL goes with the sidebar body (#713 hid only the body).
    // Focus mode is the editor-only view, and the rail's three sidebar icons
    // are inert under it (#924) — an enabled control that silently does
    // nothing, next to three siblings that still work, with the previously
    // selected item still painted `active` beside a pane that isn't there.
    // VS Code's Zen mode hides the activity bar outright; so does this. Tasks /
    // Blueprint / Terminal stay reachable from ⌘P and their own shortcuts.
    // Now that the rail is a row INSIDE the sidebar, the sidebar's own removal
    // already takes it off screen — this stays as the belt to that braces, and
    // because focus mode is not the only way the wrapper can be rendered.
    activityBar.element.hidden = layout.focusMode
    sidebarToggle.classList.toggle('active', sidebarOpen && !layout.focusMode)
    // The right-area toggle reflects what is ON SCREEN, by the same rule.
    const rightShown = rightAreaShown(layout, rightAreaContext())
    rightAreaToggle.classList.toggle('active', rightShown)
    rightAreaToggle.setAttribute('aria-pressed', String(rightShown))
    rightAreaToggle.title = rightAreaToggleTitle(rightShown)
    const expanded = rightExpandedShown(layout)
    expandToggle.classList.toggle('active', expanded)
    expandToggle.setAttribute('aria-pressed', String(expanded))
    expandToggle.setAttribute('aria-label', rightExpandedLabel(expanded))
    expandToggle.title = rightExpandedLabel(expanded)
    expandIcon.setAttribute('name', rightExpandedIcon(expanded))
    // With the area away, the conversation's reading column narrows and
    // centres: the freed width becomes margin, not longer lines.
    root.toggleAttribute('data-right-area-collapsed', !rightShown && rootSplit.contains(panelElements.conversation))
    // #1212: the rail follows the SAME effective-visibility rule as the button
    // above, from the same place, so the two controls can't disagree.
    activityBar.setShown(sidebarOpen && !layout.focusMode)
    // #1401: the Terminal rail toggle reflects the docked terminal's EFFECTIVE
    // visibility, the same rule the sidebar items follow (#1212).
    activityBar.setTerminalShown(terminal.isConnected && !layout.focusMode)
    // Surface the focus-mode exit pill while (and only while) focus mode is on.
    focusHint.hidden = !layout.focusMode
  }

  /** Stable name for a root-split child, for composition-keyed size storage
   *  (#1110/#1111). */
  function rootChildName(element: Element): string {
    if (element === activitySidebarWrapper) return 'sidebar'
    if (element === editorStack) return 'editor'
    return element.getAttribute(PANEL_ID_ATTR) ?? 'pane'
  }

  /** The root split's composition signature, e.g. 'sidebar|conversation|editor'. */
  function rootSignature(children: Element[]): string {
    return children.map(rootChildName).join('|')
  }

  /** Storage key for the root split's fractions under a given composition
   *  (#1110/#1111): each arrangement keeps its OWN tuned widths, so a drag in
   *  one arrangement can never evict another's, and a default can never be
   *  applied to the wrong children. */
  function rootSizesKey(signature: string): string {
    return `${rootSplit.id}:${signature}`
  }

  /** Stored (else default) root-split fractions for the desired composition, or
   *  null when neither matches (fl-split then falls back to equal fractions). */
  function rootSizesFor(desired: Element[]): number[] | null {
    const signature = rootSignature(desired)
    const stored = state.splits[rootSizesKey(signature)]
    if (areValidSizes(stored, desired.length)) return stored
    // Legacy shared-key store (pre-composition keys): trust it only for the
    // compositions the old count-keyed lookup actually meant — a legacy
    // 2-length array applied to [sidebar · editor] is exactly the #1110 bug.
    const legacy = state.splits[rootSplit.id]
    if (
      (signature === 'sidebar|conversation|editor' || signature === 'conversation|editor') &&
      areValidSizes(legacy, desired.length)
    ) {
      return legacy
    }
    const def = DEFAULT_SIZES[signature]
    return def && def.length === desired.length ? def : null
  }

  /** Reconcile the root split's children to `desired` (add/remove/reorder) and
   *  apply the matching stored/default sizes. The editorStack (editor+terminal)
   *  is inserted as the center; conversation/sideTabs are individually removable. */
  function reconcileRootChildren(desired: HTMLElement[], expansionChanged = false): void {
    // THE SIDEBAR KEEPS ITS WIDTH when the right-hand area goes or comes back
    // (user, 2026-10-06): measured BEFORE the reconcile, so the width it is
    // pinned to is the one the person sees — their own resize included — and
    // the freed width goes to the conversation, never to the sidebar. Not
    // while hydrating: a restore applies the scope's stored widths, and what is
    // on screen then is the outgoing scope's.
    const before = Array.from(rootSplit.children)
    // The same holds when the chat steps aside for the right side, or comes
    // back: the sidebar keeps its width, the right side takes the chat's.
    const editorToggled =
      before.includes(editorStack) !== desired.includes(editorStack) || expansionChanged
    const sidebarStays = before.includes(activitySidebarWrapper) && desired.includes(activitySidebarWrapper)
    const totalPx = rootSplit.getBoundingClientRect().width
    const sidebarFraction =
      editorToggled && sidebarStays && !hydrating && totalPx > 0
        ? activitySidebarWrapper.getBoundingClientRect().width / totalPx
        : 0
    for (const child of Array.from(rootSplit.children)) {
      if (!desired.includes(child as HTMLElement)) {
        rootSplit.removeChild(child)
      }
    }
    desired.forEach((element, index) => {
      if (rootSplit.children[index] !== element) {
        rootSplit.insertBefore(element, rootSplit.children[index] ?? null)
      }
    })
    let sizes = rootSizesFor(desired)
    if (sidebarFraction > 0) {
      const base = sizes ?? desired.map(() => 1 / desired.length)
      sizes = keepPaneFraction(base, desired.indexOf(activitySidebarWrapper), sidebarFraction)
      // Remembered for this arrangement, so a relaunch into it restores the
      // same sidebar width rather than a default.
      state.splits[rootSizesKey(rootSignature(desired))] = sizes
    }
    if (sizes) {
      // Attribute drives the count-change rebuild path; setSizes handles the
      // same-count path (project switch, same arrangement, different widths).
      rootSplit.setAttribute('sizes', sizes.join(','))
      rootSplit.setSizes(sizes)
    } else {
      rootSplit.removeAttribute('sizes')
    }
  }

  /** Apply a panel model: render its split plan into the root split and persist.
   *  The Phase 3/4 seam — shortcuts/menu call applyLayout(reducer(getLayout())).
   *  The activitySidebarWrapper is prepended as its own root-split child when
   *  sidebarOpen is true — kept separate from the threads panel so initThreads()'s
   *  replaceChildren() never destroys the swappable sidebar panes. */
  function applyLayout(next: PanelLayout): void {
    // #1351: tell the non-empty guard about the activity sidebar before it
    // decides anything. It renders (306px, open by default) but lives outside
    // the panel model, so without this the guard forced the editor back on in
    // states that were never going to be blank — making ⌘⌥D a dead key with
    // Chat hidden, and ⌘⌥C silently re-open the editor the user had hidden.
    // #1538: and about whether the editor will actually PAINT. `editorVisible`
    // is a request; #675 collapses an empty stack, so the guard used to pass a
    // layout whose centre rendered a blank rectangle. `editorHasTabs ||
    // terminalVisible` is the honest half — the movable-panel half of
    // `editorHasContent` below is already covered by `effectivePanels`.
    next = enforceNonEmpty({
      ...next,
      otherSurfacesVisible: sidebarOpen && !next.focusMode,
      editorHasContent: editorHasTabs || terminalVisible,
    })
    const expansionChanged = (layout.rightExpanded === true) !== (next.rightExpanded === true)
    layout = next
    state.panelLayout = next
    const plan = buildSplitPlan(next)
    const desired: HTMLElement[] = []
    // Focus mode is editor-ONLY (#713): the activity sidebar hides with the
    // movable panels (mirroring effectivePanels() → []), and since sidebarOpen
    // itself is untouched, exiting focus restores the user's prior sidebar
    // state. This also makes the titlebar toggle honest — syncToggleStates
    // already reads it inactive under focusMode.
    if (sidebarOpen && !next.focusMode) desired.push(activitySidebarWrapper)
    for (const id of plan.left) desired.push(panelElements[id])
    // The empty editor collapses ONLY when nothing else fills the panel area
    // (#675): drop its stack when it has no content (no tab, no docked
    // terminal) AND no movable panel (the conversation) is open. With the
    // conversation open, keep the editor so the chat stays its normal left
    // width instead of stretching to fill and centering into the void.
    const editorWanted = plan.center === 'editor'
    const movablePresent = plan.left.length > 0 || plan.right.length > 0
    // Expanded, the right side IS the point: it stays even with nothing open,
    // so the chat's column never turns into an empty middle.
    const expandedOverChat = next.rightExpanded === true && !next.focusMode
    const editorHasContent = editorHasTabs || terminalVisible || movablePresent || expandedOverChat
    if (editorWanted && editorHasContent) desired.push(editorStack)
    for (const id of plan.right) desired.push(panelElements[id])
    // Never reconcile the root split to nothing (#1538). The old last resort
    // here was the editor stack itself — but the only way to reach this line is
    // for that stack to have nothing in it, so it kept the split non-empty
    // while leaving the WINDOW blank: no panel, no watermark, not one rail item
    // lit, and the layout persisted and restored verbatim on the next launch.
    // The watermark is a surface that always says something, and names the way
    // back. Deliberately not "refuse the last put-away": that would make ⌘B or
    // ⌃` a dead key, which is the #1351 symptom this must not re-create.
    if (desired.length === 0) desired.push(emptyPanel)
    reconcileRootChildren(desired, expansionChanged)
    syncToggleStates()
    saveActive()
    // AFTER the reconcile, never before: the pane answers by measuring itself,
    // and until the split has been rebuilt its wrapper may not be in it yet.
    // Here rather than in applySidebarBody so EVERY path that can put the pane
    // back on screen is covered — a rail switch, ⌘B, and leaving focus mode,
    // which reveals the whole sidebar without touching the rail at all.
    announceSourceControlVisibility()
  }

  /** Editor tab-count signal (initEditor → layoutApi.setEditorHasTabs): an empty
   *  editor collapses its stack when no terminal is docked (#675). Re-reconciles
   *  the root split only when the emptiness actually flips. */
  function setEditorHasTabs(has: boolean): void {
    if (editorHasTabs === has) return
    editorHasTabs = has
    applyLayout(layout)
  }

  /** Wrap a movable panel in a STABLE positioned container that carries its
   *  data-panel-id. The wrapper (not the inner fl-panel) is what the root split
   *  reconciles + what focused-panel detection reads. The ⋯ reposition trigger
   *  is retired in Phase 2 (activity-bar restructure). */
  function wrapMovablePanel(inner: HTMLElement, id: 'conversation'): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'fl-panel-wrap'
    wrap.setAttribute(PANEL_ID_ATTR, id)
    wrap.appendChild(inner)
    return wrap
  }

  function applySidebarBody(): void {
    sidebarPanels.showItem(activeRailItem)
    // Re-reconcile the root split so activitySidebarWrapper is added/removed
    // based on the current sidebarOpen state. applyLayout re-derives the desired
    // children array (which now includes activitySidebarWrapper when open).
    applyLayout(layout)
  }

  // ── Per-thread persistence ─────────────────────────────────────────────────
  //
  // Each chat thread is its own context, and the panel layout follows it: the
  // live `state` belongs to ONE scope — (project root, thread | null), where
  // null is the project view — and switching scope saves the outgoing one and
  // applies the incoming one. The keying, the inherit rule and the storage
  // bound live in layout/thread-layout-store.ts; the shell only decides WHEN.
  //
  // The pre-thread per-project v5 store is now read-only: it is the fallback
  // for any scope with no entry of its own, so an upgrade lands every project
  // on the layout it already had.

  /** Read the legacy v5 store, migrating a legacy v3 global into `rootId` once.
   *  Fail-soft: a corrupt/absent store → an empty v5 store. */
  function loadLegacyStore(rootId: string): ShellLayoutStore {
    try {
      const v5Raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY_V5)
      if (v5Raw) return normalizeLayoutStore(JSON.parse(v5Raw))
      const v3Raw = window.localStorage.getItem(LEGACY_LAYOUT_STORAGE_KEY_V3)
      if (v3Raw) {
        const migrated = migrateLegacyLayout(JSON.parse(v3Raw), rootId)
        window.localStorage.setItem(LAYOUT_STORAGE_KEY_V5, JSON.stringify(migrated))
        return migrated
      }
    } catch (error) {
      console.warn('flow: failed to restore shell layout store, using defaults', error)
    }
    return { version: 5, roots: {} }
  }

  /** The layout a scope with nothing saved falls back to: the project's
   *  pre-thread layout, else the built-in default. */
  function legacyLayoutFor(rootId: string): ShellLayoutState {
    return loadLegacyStore(rootId).roots[rootId] ?? normalizeLayoutState(undefined)
  }

  /** Write the live state under the active scope. No-op without one. */
  function writeStore(): void {
    if (!activeScope) return
    // normalizeLayoutState clones + validates the live working state.
    threadLayouts.write(activeScope, normalizeLayoutState(state))
  }

  /** Debounced save of the active scope's state (skipped while hydrating). */
  function saveActive(): void {
    if (hydrating || !activeScope) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      writeStore()
    }, SAVE_DEBOUNCE_MS)
  }

  /** Write any pending debounced save IMMEDIATELY. Called on page unload so the
   *  user's last layout change (made inside the 200ms debounce window) survives a
   *  quit/reload instead of being silently dropped — e.g. hiding the sidebar and
   *  immediately quitting would otherwise re-show it on next launch (#454 gap). */
  function flushSave(): void {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (activeScope) writeStore()
  }

  /** Switch the layout to `scope` — a thread, or a project's own view — and
   *  re-apply every surface it drives (terminal, side tab/view, split sizes,
   *  panel arrangement). Runs on the first active project, on every project
   *  switch and on every thread switch; never mid-drag, since nothing but a
   *  switch calls it. A repeat of the current scope applies nothing. */
  function hydrate(scope: LayoutScope): void {
    if (sameLayoutScope(activeScope, scope)) return
    // Persist the OUTGOING scope's pending debounced layout change before
    // swapping state — otherwise a toggle made <200ms before a switch is
    // silently dropped (the timer would fire after the swap and write the NEW
    // scope's state under it). Same class as the #454 pagehide flush (#767).
    flushSave()
    const onScreen = activeScope ? { scope: activeScope, value: normalizeLayoutState(state) } : null
    const resolved = threadLayouts.resolve(scope, onScreen, () => legacyLayoutFor(scope.root))
    activeScope = scope
    // A new thread opened from this project's screen keeps exactly what is
    // there — nothing to re-apply, so nothing moves. It is snapshotted below
    // so the thread diverges from here on.
    const keepsScreen = onScreen !== null && resolved.value === onScreen.value
    if (!keepsScreen) applyLayoutState(resolved.value)
    if (resolved.inherited) writeStore()
  }

  /** Copy a stored layout into the live state and re-apply it to the DOM. */
  function applyLayoutState(src: ShellLayoutState): void {
    hydrating = true
    try {
      // Copy fields INTO the stable `state` object so existing closures stay valid.
      state.splits = src.splits
      state.collapsed = src.collapsed
      state.sideViewMode = src.sideViewMode
      state.sidebarVisible = src.sidebarVisible
      state.terminalVisible = src.terminalVisible
      state.panelLayout = src.panelLayout
      state.activeRailItem = src.activeRailItem
      state.sidebarOpen = src.sidebarOpen

      // Root arrangement — applyLayout sets the root split sizes from state.splits.
      // normalizePanelLayout re-validates against the current MOVABLE_PANEL_IDS,
      // dropping any stale 'threads' entry from pre-refactor persisted layouts.
      // Force focus mode OFF: it's a transient overlay, never restored on relaunch.
      applyLayout(setFocusMode(normalizePanelLayout(src.panelLayout), false))

      // Restore terminal visibility in the editor stack.
      terminalVisible = src.terminalVisible !== false
      reconcileEditorStack()
      // Restore the scope's dragged editor|terminal height (#1059) — the
      // reconcile above only re-applies sizes when it re-appends the terminal,
      // but on a switch/relaunch the pane set is often unchanged while the
      // stored fractions are this scope's own.
      applyStoredStackSizes()

      // Restore activity bar state.
      activeRailItem = resolveRailItem(src.activeRailItem)
      sidebarOpen = src.sidebarOpen !== false
      activityBar.setActive(activeRailItem)

      // Restore sidebar view.
      applySidebarBody()
      sidebarPanels.setViewMode(src.sideViewMode === 'phases' ? 'phases' : 'changes')
    } finally {
      hydrating = false
    }
  }

  // Initial render with the provisional default; hydrate() settles it once the
  // active project resolves (and on every switch thereafter).
  applyLayout(layout)

  // THE THREAD SIGNAL. threads/index.ts announces every selection — and the
  // return to the project view (threadId null) — with the thread's own project
  // root, because a thread in another project is announced BEFORE the project
  // switch it causes; keying it under the outgoing root would file it in the
  // wrong project.
  document.addEventListener('flow:active-thread', (event) => {
    const detail = (event as CustomEvent<{ threadId?: string | null; projectRoot?: string | null }>)
      .detail
    const root = detail?.projectRoot ?? activeScope?.root ?? null
    if (!root) return
    hydrate({ root, threadId: detail?.threadId ?? null })
  })

  const projectApi = window.flow?.project
  if (projectApi) {
    // Boot: the project's last-active thread is already known here, so the
    // first apply is that thread's layout — not the project's, then the
    // thread's a moment later.
    void projectApi
      .active()
      .then((context) => {
        if (context?.rootPath && activeScope === null) {
          hydrate({ root: context.rootPath, threadId: context.activeThreadId ?? null })
        }
      })
      .catch((error) => console.warn('flow: failed to load active project layout', error))
    // A project switch lands on that project's recorded thread (the threads
    // module selects it, or clears to the project view, and announces which).
    // A same-project broadcast carries nothing new about the thread — the
    // thread signal above owns that — so it applies nothing.
    projectApi.onActiveChanged((context) => {
      if (!context?.rootPath || context.rootPath === activeScope?.root) return
      hydrate({ root: context.rootPath, threadId: context.activeThreadId ?? null })
    })
  }

  // Flush a pending debounced save before the page unloads (quit/reload) so the
  // last layout change isn't dropped by the 200ms debounce (#454 gap). pagehide
  // fires on both navigation-away and tab/window close, unlike a bare unload.
  window.addEventListener('pagehide', flushSave)

  return {
    sidebar: sidebarPanels.threadsBody,
    conversation,
    editor,
    // THE TREE'S OWN HOST, not the whole pane: the editor mounts the tree with
    // `replaceChildren`, and the pane now also holds the worktree dock and the
    // search box above it.
    fileTree: sidebarPanels.treeBody,
    searchPanel: sidebarPanels.searchBody,
    gitPanel: sidebarPanels.changesBody,
    reviewPanel: sidebarPanels.phasesBody,
    terminal,
    statusBar,
    layoutApi: {
      getLayout: () => layout,
      applyLayout,
      setEditorHasTabs,
    },
  }
}

// ── Builders ─────────────────────────────────────────────────────────────

function createPanel(
  id: string,
  label: string,
  state: ShellLayoutState,
  options: { chromeless?: boolean } = {},
): FlPanel {
  const panel = document.createElement('fl-panel')
  panel.id = `fl-panel-${id}`
  panel.setAttribute('label', label)
  // Chromeless panels (the content panes) show no header label or collapse
  // chevron — a clean, Zed-like surface. Only labelled/collapsible panels get
  // the header + persisted collapse state.
  if (options.chromeless) {
    panel.setAttribute('chromeless', '')
    return panel
  }
  panel.setAttribute('collapsible', '')
  if (state.collapsed[panel.id]) {
    panel.setAttribute('collapsed', '')
  }
  return panel
}

function createSplit(
  id: string,
  direction: 'horizontal' | 'vertical',
  state: ShellLayoutState,
  panes: HTMLElement[],
): FlSplit {
  const split = document.createElement('fl-split')
  split.id = `fl-split-${id}`
  split.setAttribute('direction', direction)
  const sizes = state.splits[split.id] ?? DEFAULT_SIZES[id]
  // Only apply stored sizes when they match the current pane count AND are all
  // finite positive fractions — stale/corrupt state must never yield a pane
  // that fails to fill its share (the "blank strip" class of bug).
  if (
    sizes &&
    sizes.length === panes.length &&
    sizes.every((n) => Number.isFinite(n) && n > 0)
  ) {
    split.setAttribute('sizes', sizes.join(','))
  }
  for (const pane of panes) {
    split.appendChild(pane)
  }
  return split
}

/** A segmented view-mode button for the Source Control Changes|Phases toggle (#335). */
function sideViewButton(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'fl-sc-viewbtn'
  button.type = 'button'
  button.textContent = label
  return button
}

/**
 * Settings — a gear at the TOP-RIGHT of the window, opening the settings
 * overlay via flow:open-settings.
 *
 * It used to be a labelled "Settings" item at the bottom-LEFT of the status
 * bar, next to the flow/autopilot readouts. Those are a running state you
 * glance at; this is a place you go, and it is where every editor puts it —
 * so it moved to the corner people already look in, and dropped its word: the
 * gear is the most over-learned icon in the category, and the tooltip and the
 * accessible name still say it in full for anyone who needs them.
 *
 * "Settings", not "Claude accounts": the accounts moved inside Model settings
 * when a thread stopped being Claude-only, so a button named after one
 * runtime's logins now opens a screen that is mostly about other things.
 */
export function buildSettingsButton(): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'fl-titlebar-icon'
  button.title = 'Settings'
  button.setAttribute('aria-label', 'Settings')
  const icon = document.createElement('fl-icon')
  icon.setAttribute('name', 'settings')
  icon.setAttribute('size', '15')
  button.appendChild(icon)
  // #1199/#1509, inherited from the status-bar button this replaced: a mouse
  // press on a chrome action must not move the keyboard. Chromium focuses a
  // clicked <button>, so the Settings overlay's focus capture
  // (overlay-focus-return.ts) ran AFTER this button had already taken focus
  // from the composer — close then "restored" the keyboard to the button, and
  // everything typed next was lost. Toolbar convention instead: the press
  // leaves focus where it was; Tab still reaches the button.
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('flow:open-settings'))
  })
  return button
}


interface ActivityBarResult {
  element: HTMLElement
  setActive(item: RailItem): void
  /** Whether the sidebar the first three items open is on screen (#1212) — the
   *  rail must not keep an item lit over a pane that is not rendered. */
  setShown(shown: boolean): void
  /** #1401: paint the Terminal toggle's own state. */
  setTerminalShown(shown: boolean): void
  /**
   * Whether the conversation on screen works in a worktree.
   *
   * THE RAIL SAYS WHOSE FILES THESE ARE. The Files item is the door to a tree
   * whose contents change entirely depending on the answer, and it drew the
   * same folder either way — while the thread row beside it and the panel
   * inside it both carried the mark (user, 2026-09-17: "when we click on the
   * thread that has the new icon, lets update that icon here on the top").
   */
  setFilesAreCopy(isCopy: boolean): void
}

/**
 * The left rail — ONE KIND OF THING.
 *
 * It used to carry nine icons doing three jobs, and a three-item cap with an
 * expander to keep that manageable. The cap was the wrong fix: capping a list
 * only helps once the list is one kind of thing, and capping this one hid
 * Worktree behind an arrow the day it shipped. The controls that open tabs moved
 * to the editor's top bar, and what is left is five sidebar surfaces — which
 * fit, so the cap and the arrow are gone with them.
 */
function buildActivityBar(
  initialItem: RailItem,
  onSelect: (item: RailItem) => void,
): ActivityBarResult {
  const rail = document.createElement('div')
  rail.className = 'fl-activity-bar'
  rail.setAttribute('role', 'navigation')
  rail.setAttribute('aria-label', 'Activity bar')

  const ENTRIES: Array<{ item: RailItem; icon: string; label: string }> = [
    { item: 'threads', icon: 'message', label: 'Threads' },
    { item: 'files', icon: 'folder', label: 'Files' },
    { item: 'source-control', icon: 'git-branch', label: 'Source Control' },
  ]

  const buttons = new Map<RailItem, HTMLButtonElement>()

  for (const { item, icon, label } of ENTRIES) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'fl-rail-item'
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.setAttribute('data-rail-item', item)
    const iconEl = document.createElement('fl-icon')
    // 15, not 18: at 18 the glyphs filled their buttons edge to edge and the
    // row read as a strip of tiles rather than a row of icons.
    iconEl.setAttribute('name', icon)
    iconEl.setAttribute('size', '15')
    btn.appendChild(iconEl)
    btn.addEventListener('click', () => onSelect(item))
    rail.appendChild(btn)
    buttons.set(item, btn)
  }

  // #1212: the rail tracks WHICH item is selected AND WHETHER its pane is
  // actually shown. It used to track only the first, so collapsing the sidebar
  // left the item lit — blue icon, 2px indicator, aria-pressed="true" — with no
  // pane rendered, while the titlebar button in the same row correctly went
  // dark. shell.ts already states the rule for that button ("Reflect EFFECTIVE
  // visibility … it would lie, #616"); this applies it to the other control.
  let selected: RailItem = initialItem
  let shown = true

  function paint(): void {
    buttons.forEach((btn, id) => {
      const active = shown && id === selected
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', String(active))
    })
  }

  function setActive(item: RailItem): void {
    selected = item
    paint()
  }

  /** The Files glyph follows the conversation: plain folder, or the same
   *  folder-on-a-branch the thread row and the worktree panel use. */
  function setFilesAreCopy(isCopy: boolean): void {
    const icon = buttons.get('files')?.querySelector('fl-icon')
    icon?.setAttribute('name', isCopy ? 'checkouts' : 'folder')
  }

  /** Whether the sidebar those three items open is on screen at all. */
  function setShown(next: boolean): void {
    shown = next
    paint()
  }

  /**
   * #1401: the docked terminal's effective visibility.
   *
   * The Terminal control lives on the editor's top bar now, so the rail has
   * nothing to paint — but the entry point stays, because the shell calls it and
   * the state it reports is still true. Its consumer moved; the fact did not.
   */
  function setTerminalShown(next: boolean): void {
    document.dispatchEvent(
      new CustomEvent('flow:terminal-visible', { detail: { visible: next } }),
    )
  }

  paint()
  setTerminalShown(true) // docked-visible by default

  return { element: rail, setActive, setShown, setTerminalShown, setFilesAreCopy }
}

/** The Flow mark: `/>>` (flow slash + double-chevron fast-forward), stroked in
 *  currentColor so it inherits the title-bar text color. Matches the app icon. */
function flowMark(size = 15): SVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 96 96')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('class', 'fl-brand-mark')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ['M25 66 L36 34', 'M47 37 L57 50 L47 63', 'M59 37 L69 50 L59 63']) {
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', d)
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '8')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    path.setAttribute('fill', 'none')
    svg.appendChild(path)
  }
  return svg
}

/** When a panel collapses, its parent split pane must stop flexing. */
function syncCollapsedPane(panel: FlPanel): void {
  const split = panel.parentElement
  if (!(split instanceof FlSplit)) {
    return
  }
  const index = Array.from(split.children).indexOf(panel)
  if (index >= 0) {
    split.setPaneCollapsed(index, panel.collapsed)
  }
}

// Layout persistence now lives in mountShell's per-project store (v4): loadStore /
// writeStore / saveActive / hydrate. See the "Per-project persistence" block above.

// ── Shell chrome styles (light DOM) ──────────────────────────────────────

let stylesInjected = false

function injectShellStyles(): void {
  if (stylesInjected) {
    return
  }
  stylesInjected = true
  // Which titlebar edge the OS window controls occupy is platform-dependent:
  // macOS traffic lights on the left, the Windows control box on the right.
  const insets = titlebarInsets(currentPlatform())
  const style = document.createElement('style')
  style.textContent = `
    .fl-shell {
      display: flex;
      flex-direction: column;
      height: 100vh;
      background: var(--fl-color-bg);
    }
    .fl-titlebar {
      -webkit-app-region: drag;
      position: relative;
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      flex: none;
      height: 34px;
      /* Clear the OS window controls: the macOS traffic lights (hiddenInset)
         on the LEFT, the Windows control box (Window Controls Overlay) on the
         RIGHT. The 78px left reserve was applied on every platform, so Windows
         got a dead strip on the left and its caption buttons sat on top of the
         titlebar's own controls on the right.
         #1352: DIVIDED BY THE ZOOM. The controls are OS chrome at a fixed
         DEVICE size; a CSS length is not. Zoom out and 78 CSS px became far
         fewer device px, so the window controls walked over the project
         switcher — every step of View ▸ Zoom Out pushed them further in, and
         the state survives a relaunch, so a user who zooms out once lands
         back in it forever. Zoom in and the strip became dead space. */
      padding: 0 ${insets.right} 0 ${insets.left};
      background: var(--fl-color-titlebar);
      /* NO edge at all. It carried the project's accent colour for a while —
         one project, one colour on the window's own border — and that was
         dropped because at this height a coloured line reads as a band across
         the top of the app. The neutral rule that replaced it had the same
         problem in miniature: it was lighter than the chrome on BOTH sides of
         it (the titlebar and the sidebar are the same fill), so it separated
         nothing and simply drew a bright line across the window. */
      user-select: none;
    }
    .fl-titlebar-right {
      -webkit-app-region: no-drag;
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      /* Above the absolutely-centered brand overlay so the chip stays clickable. */
      position: relative;
      z-index: 2;
    }
    .fl-titlebar-brand {
      /* Centered across the full header width, independent of the left/right
         control groups. pointer-events:none keeps the drag region intact. */
      position: absolute;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      pointer-events: none;
      color: var(--fl-color-text);
    }
    .fl-brand-mark { display: block; color: var(--fl-color-text); }
    .fl-brand-word {
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-ui-size);
      font-weight: var(--fl-text-ui-weight-medium);
      letter-spacing: -0.02em;
      color: var(--fl-color-text);
    }
    /* Interactive controls must escape the drag region. */
    .fl-titlebar-action {
      -webkit-app-region: no-drag;
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
    }
    .fl-titlebar-icon {
      -webkit-app-region: no-drag;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 22px;
      border: none;
      background: transparent;
      color: var(--fl-color-text-secondary);
      border-radius: var(--fl-radius-sm);
      cursor: pointer;
    }
    .fl-titlebar-icon:hover { color: var(--fl-color-text); background: var(--fl-color-surface-raised); }
    .fl-titlebar-icon.active { color: var(--fl-color-text); }
    /* The right-hand area put away: the transcript, its header and the
       composer all cap on --fl-conv-column, centred — narrow it so the freed
       width becomes margin around a readable column. */
    .fl-shell[data-right-area-collapsed] { --fl-conv-column: ${COLLAPSED_READING_COLUMN_PX}px; }
    .fl-project-switcher {
      -webkit-app-region: no-drag;
      position: relative;
      display: inline-flex;
    }
    .fl-project-current {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
      height: 22px;
      padding: 0 var(--fl-space-sm);
      border: var(--fl-border-width) solid transparent;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .fl-project-current:hover {
      background: var(--fl-color-surface-raised);
      border-color: var(--fl-color-border);
    }
    .fl-project-current fl-icon:last-child { color: var(--fl-color-text-secondary); }
    .fl-project-menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 50;
      min-width: 180px;
      display: flex;
      flex-direction: column;
      padding: var(--fl-space-xs);
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      /* Bounded + scrollable so every project and the trailing "+ Open
         Project…" stay reachable with many roots (#818, same class as #81).
         128px ≈ titlebar + menu offset + bottom breathing room. */
      max-height: calc(100vh - 128px);
      overflow-y: auto;
    }
    .fl-project-item {
      display: block;
      padding: var(--fl-space-xs) var(--fl-space-sm);
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }
    .fl-project-item:hover { background: var(--fl-color-accent-muted); }
    .fl-project-item.active { color: var(--fl-color-accent); }
    /* An unreachable root (#263/#974): visible but plainly not enterable —
       the threads sidebar's treatment, mirrored on the titlebar switcher. */
    .fl-project-item.unavailable {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      opacity: 0.55;
      cursor: default;
      color: var(--fl-color-text-secondary);
    }
    .fl-project-item.unavailable:hover { background: transparent; }
    .fl-project-item-tag,
    .fl-project-gone {
      flex: none;
      padding: 0 5px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      font-size: var(--fl-text-caption-size);
      letter-spacing: 0;
      text-transform: none;
      color: var(--fl-color-text-secondary);
    }
    .fl-project-current--gone .fl-project-name { color: var(--fl-color-text-secondary); }
    .fl-project-open {
      margin-top: var(--fl-space-xs);
      border-top: var(--fl-border-width) solid var(--fl-color-border);
      color: var(--fl-color-text-secondary);
    }
    .fl-shell-main {
      display: flex;
      flex-direction: row;
      flex: 1;
      min-height: 0;
    }
    .fl-shell-main > fl-split {
      flex: 1;
      min-width: 0;
    }
    /* Activity sidebar — swappable content panel (Files/SC/Terminal/Tasks/Blueprint).
       Separate from the threads fl-panel so initThreads' replaceChildren never wipes it. */
    .fl-activity-sidebar {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .fl-activity-sidebar > * {
      flex: 1;
      min-height: 0;
    }
    /* …except the icon row, which is a fixed-height first line, not a pane. */
    .fl-activity-sidebar > .fl-activity-bar {
      flex: none;
    }
    /* Threads pane inside the activity sidebar — fills the full pane height. */
    .fl-sidebar-threads {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    /* Separator between sidebar-switching items and action items in the rail.
       The rail runs horizontally, so the divider is a vertical hairline. */
    .fl-rail-separator {
      width: 1px;
      height: 16px;
      background: var(--fl-color-border);
      margin: 0 var(--fl-space-xs);
      flex: none;
    }
    /* Activity bar — a horizontal icon row, the sidebar's first line (Cursor
       layout). It used to be a 48px column at the window's far left; moving it
       in here is what lets the panes below start at the window edge. */
    .fl-activity-bar {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: center;
      flex: none;
      height: 34px;
      background: var(--fl-color-bg);
      /* No bottom rule. The sidebar's top used to stack four horizontal lines
         in 34px — this one, the search box's own two edges, and the toolbar's.
         The other three are gone; keeping this one would leave a rule with
         nothing on either side of it to separate, since the row below is the
         filled search field, which already reads as its own object. */
      gap: 2px;
      user-select: none;
      /* The whole row must survive the sidebar's narrowest legal width — the
         root split's min-size is 180px, and 6 items + the divider come to 175.
         overflow guards the case where that arithmetic ever stops holding, so
         a spilled icon can never land on the pane below. */
      overflow: hidden;
    }
    .fl-rail-item {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 24px;
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
      transition: color var(--fl-transition-fast), background var(--fl-transition-fast);
      position: relative;
      flex: none;
    }
    .fl-rail-item:hover {
      color: var(--fl-color-text);
      background: var(--fl-color-surface-raised);
    }
    /* The selected item is a tinted PILL, not a marker line. As a column, the
       rail marked its selection with a bar on the row's leading edge; turned
       horizontal that became an underline on the row's bottom edge, which read
       as a marker only while the row still had a bottom border for it to sit
       against. With that rule gone the underlines were two short dashes
       floating under two icons. A filled shape needs no edge to be read
       against, and the accent tint keeps it distinct from the neutral hover. */
    .fl-rail-item.active {
      color: var(--fl-color-accent);
      background: var(--fl-color-accent-muted);
    }
    .fl-rail-item.active:hover {
      background: var(--fl-color-accent-muted);
    }
    @media (prefers-reduced-motion: reduce) {
      .fl-rail-item { transition: none; }
    }
    .fl-status-bar {
      display: flex;
      align-items: center;
      gap: var(--fl-space-lg);
      flex: none;
      height: 24px;
      padding: 0 var(--fl-space-sm);
      background: var(--fl-color-bg);
      /* A region seam — the bar's chrome fill against the content above it. */
      border-top: var(--fl-border-width) solid var(--fl-color-separator);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      user-select: none;
    }
    .fl-status-item {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
    }
    .fl-status-right { margin-left: auto; }
    .fl-status-button {
      border: none;
      background: transparent;
      color: var(--fl-color-text-secondary);
      font: inherit;
      cursor: pointer;
      padding: 0 var(--fl-space-xs);
      height: 100%;
      border-radius: var(--fl-radius-sm);
    }
    .fl-status-button:hover { color: var(--fl-color-text); }
    .fl-status-button.active { color: var(--fl-color-accent); }

    /* THE DEBUG BUTTON, in the browser toolbar beside Inspect.

       It is a primary fl-button while recording, which is this app's idiom
       for a pressed toggle — but a debug session is not a toggle you can leave
       pressed harmlessly: it retains output, writes a file and eventually stops
       itself at a ceiling. So recording also BREATHES. The pressed colour says
       "on"; the pulse says "still on, right now", which is the part somebody
       who walked away needs. */
    /* RECORDING IS RED, not the app's accent.
       Blue is what every pressed toggle in this app looks like, and this one is
       not a preference left on — it is retaining output, writing a file and
       counting down to a ceiling. Red is the colour a recording light has been
       for as long as recording lights have existed (user, 2026-09-21).

       Done by overriding the two custom properties the primary variant of
       fl-button already reads, rather than reaching into its shadow root: a
       variable inherits across that boundary and a selector does not. */
    fl-button.fl-debug-btn.is-recording {
      --fl-color-accent: var(--fl-color-error);
      --fl-color-accent-muted: color-mix(in srgb, var(--fl-color-error) 18%, transparent);
      animation: fl-debug-pulse 1.6s ease-in-out infinite;
    }
    .fl-debug-label {
      font-size: var(--fl-text-caption-size);
      font-weight: 500;
      letter-spacing: 0.02em;
    }
    @keyframes fl-debug-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }
    /* A reader who asked for less motion still needs the state, so the button
       keeps its pressed colour and simply stops moving. */
    @media (prefers-reduced-motion: reduce) {
      fl-button.fl-debug-btn.is-recording { animation: none; }
    }
    .fl-debug-note {
      color: var(--fl-color-text-muted);
      max-width: 52ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Source Control: view-mode toggle over two stacked sub-views (#335). */
    .fl-sc-body { display: flex; flex-direction: column; }
    .fl-sc-viewtoggle {
      display: flex;
      gap: 2px;
      padding: var(--fl-space-xs);
      /* Region seam — the Changes|Phases strip against the pane below it. */
      border-bottom: var(--fl-border-width) solid var(--fl-color-separator);
    }
    .fl-sc-viewbtn {
      flex: 1;
      height: 22px;
      border: var(--fl-border-width) solid transparent;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .fl-sc-viewbtn:hover { color: var(--fl-color-text); }
    .fl-sc-viewbtn.active {
      background: var(--fl-color-surface);
      border-color: var(--fl-color-border);
      color: var(--fl-color-text);
    }
    .fl-sc-view { flex: 1; min-height: 0; overflow-y: auto; }
    .fl-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--fl-space-sm);
      height: 100%;
      min-height: 80px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-ui-size);
      user-select: none;
    }
    /* Activity-bar sidebar panel: full-height, fills the threads fl-panel. */
    .fl-sidebar {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--fl-color-bg);
    }
    .fl-sidebar-pane {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .fl-sidebar-terminal,
    .fl-sidebar-tasks,
    .fl-sidebar-blueprint {
      overflow-y: auto;
    }
    /* THE FILES PANE IS A COLUMN OF THREE: the worktree dock (inserted at the
       top by worktrees/index.ts), the search box, and the tree. It is a column
       unconditionally — the dock's own rule used to make it one only while the
       dock was showing, which is no longer enough now that something sits
       between them. */
    .fl-sidebar-files {
      display: flex;
      flex-direction: column;
    }
    /* IDLE SEARCH TAKES ONLY ITS INPUT. A results list holding half the
       explorer open to say "Type to search file contents." is the reserved
       gutter this layout exists to avoid, so the box is content-sized until it
       has something to show. The pane reads the state the panel PUBLISHES
       rather than re-deriving it from the query. */
    .fl-files-search { flex: none; }
    /* NO RULE UNDER THE BOX. The box sits between the worktree panel and the
       tree, and neither neighbour needs a rule to be told apart from a text
       field that already has a border of its own — the space does that (user,
       2026-09-18). The rule appears for the one place it separates something:
       the input from its results, once there are any. */
    .fl-files-search > [data-search-state="searching"] .fl-search-header,
    .fl-files-search > [data-search-state="results"] .fl-search-header,
    .fl-files-search > [data-search-state="empty"] .fl-search-header {
      border-bottom: 1px solid var(--fl-color-border);
    }
    .fl-files-search > [data-search-state] { height: auto; }
    .fl-files-search .fl-search-status,
    .fl-files-search fl-list { display: none; }
    /* It grows with its results and stops at half the pane, which is the
       point the tree beneath it stops being usable. */
    .fl-files-search {
      max-height: 50%;
      overflow-y: auto;
    }
    .fl-files-search > [data-search-state="searching"] .fl-search-status,
    .fl-files-search > [data-search-state="results"] .fl-search-status,
    .fl-files-search > [data-search-state="empty"] .fl-search-status { display: block; }
    .fl-files-search > [data-search-state="searching"] fl-list,
    .fl-files-search > [data-search-state="results"] fl-list { display: block; }
    /* The tree takes whatever is left, and scrolls inside it. */
    .fl-files-tree {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    /* Stable wrapper around each movable panel (#580): fills its split pane and
       lets the inner fl-panel/div fill it. */
    .fl-panel-wrap {
      position: relative;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .fl-panel-wrap > * {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
    }
    /* Focus-mode exit pill (#616) — floats bottom-center while focus mode is on. */
    .fl-focus-hint {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      z-index: ${PANEL_MENU_Z_INDEX};
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
      padding: 6px 14px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-pill, 999px);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      box-shadow: var(--fl-shadow-md);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      cursor: pointer;
      opacity: 0.92;
      transition: opacity var(--fl-transition-fast), background var(--fl-transition-fast);
    }
    .fl-focus-hint:hover,
    .fl-focus-hint:focus-visible {
      opacity: 1;
      background: var(--fl-color-accent-muted);
    }
    .fl-focus-hint[hidden] { display: none; }
    @media (prefers-reduced-motion: reduce) {
      .fl-focus-hint { transition: none; }
    }
    /* Empty-panel watermark (#1538) — the last-resort root-split child, so
       putting every surface away leaves a window that still says something and
       names the way back, instead of the blank rectangle an empty editor stack
       painted. Quiet by design: it is a signpost, not a panel. */
    .fl-empty-panel {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 0;
      min-height: 0;
      padding: var(--fl-space-lg, 24px);
      background: var(--fl-color-surface);
      user-select: none;
    }
    .fl-empty-panel-body {
      max-width: 46ch;
      text-align: center;
      font-family: var(--fl-font-ui);
      color: var(--fl-color-text-muted);
    }
    .fl-empty-panel-title {
      margin: 0 0 var(--fl-space-xs, 6px);
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text);
    }
    .fl-empty-panel-hint {
      margin: 2px 0;
      font-size: var(--fl-text-ui-size);
      line-height: 1.6;
    }
    .fl-empty-panel kbd {
      padding: 1px 5px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm, 4px);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      font-family: var(--fl-font-mono, ui-monospace, monospace);
      font-size: 0.92em;
    }
  `
  document.head.appendChild(style)
}
