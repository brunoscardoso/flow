/**
 * Terminal panel — the unified terminal surface: user shells and per-thread
 * agent terminals as tabs (fl-tabs) over lazily-attached xterm.js hosts.
 *
 * - xterm (and its css) load via dynamic import on first attach, so the
 *   renderer boot path never pays for it.
 * - User tabs are closable; agent tabs (⚙-prefixed, labeled by thread) are
 *   read-only by default with a take-over toggle in the header.
 * - No fit addon in the dependency tree → manual cols/rows fitting from a
 *   measured character cell, re-run through a ResizeObserver.
 * - Data for tabs that exist but aren't attached yet (or terminals we
 *   haven't heard of yet — scrollback replay can race terminal:list's
 *   response) is buffered and flushed on attach.
 */
import type {
  FlowApi,
  TerminalInfo,
  TerminalOwner,
  ThreadScope,
  ThreadScopeEntry,
} from '../../shared/ipc-contract'
import type {
  FlPanel,
  FlSplit,
  FlTabs,
  TabCloseDetail,
  TabDescriptor,
  TabRenameDetail,
  TabSelectDetail,
} from '../components'
import { ensureAccentProperty } from '../project-accent'
import { baseName } from '../project-label'
import { PendingBuffer } from './pending-buffer'
import {
  terminalAttachFailedToast,
  terminalCreateFailedToast,
  type TerminalToast,
} from './terminal-feedback'
import { computeTerminalGrid, DEFAULT_GRID } from './terminal-grid'
import {
  addTerminal,
  MAX_SPLIT_PANES,
  canSplit,
  groupKey,
  groupOf,
  isUsableSizes,
  neighborInGroup,
  parseSplitSizes,
  SPLIT_SIZES_KEY,
  ARRANGEMENT_KEY,
  parseArrangement,
  restoreLayout,
  pruneLayout,
  removeTerminal as removeFromLayout,
  splitBeside,
  visiblePanes,
  type SplitLayout,
} from './terminal-split'
import { closeTerminalMenu, showTerminalMenu } from './terminal-menu'
import {
  claimOwnerFor,
  closeActiveTerminalAction,
  defaultNewTerminalRoot,
  hasLiveShellHere,
  isTerminalMine,
  isTerminalShown,
  newTerminalMenu,
  ownerSpawnOverride,
  restoredCustomTitle,
  type TerminalIdentity,
  tabProjectName,
  terminalCwdLabel,
  unscopedTabAction,
  type NewTerminalMenuItem,
  type TerminalScopeState,
} from './terminal-scope'
import { osc7FolderPath } from './terminal-title'
import { ownerKey, ScopeRestorer } from './terminal-restore'
import { terminalRootTag } from './terminal-root-tag'
import { neighborOf } from '../tab-neighbor'
import { TAB_SCOPE_EVENT, type TabScopeKey } from '../tab-scope-model'
import { initialTabExited } from './terminal-reveal'
import { terminalExitMarker } from '../../shared/terminal-exit'
import { resolveXtermTheme } from './xterm-theme'
// True while ANY modal overlay is visible (onboarding wizard, settings dialogs,
// command palette, tasks-board modals): the terminal must not steal focus from
// it (#683) — xterm swallows keys the modal needs, incl. Escape. The check used
// to be a local `.fl-settings-overlay` query, which left the board modals out
// (#1002); it now comes from the shared registry.
import { isModalOverlayOpen } from '../modal-overlay'
import { detectTerminalLinks, isOpenableTerminalUrl } from './terminal-links'

type XtermModule = typeof import('@xterm/xterm')
type XtermTerminal = import('@xterm/xterm').Terminal
type XtermTheme = import('@xterm/xterm').ITheme

// ── xterm theme — follows the app's <html data-theme> (#399). xterm can't read
//    CSS vars, so the light/dark ANSI palettes live in xterm-theme.ts. ──────────

const TERMINAL_FONT_FAMILY =
  "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const TERMINAL_FONT_SIZE = 13
const TERMINAL_SCROLLBACK_LINES = 10_000
/** Floor for a freshly-split pane's initial grid — it is refitted from real
 *  layout the moment it attaches, this just avoids a 1-column first paint. */
const MIN_SPLIT_COLS = 20

/** The effective app theme currently stamped on <html> (dark unless 'light'). */
function currentXtermTheme(): XtermTheme {
  return resolveXtermTheme(document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark')
}

/**
 * Open a URL a command printed (#1190). http(s) only — the same contract the
 * chat's external anchors carry (#1127) — because an OSC 8 escape can name ANY
 * scheme and a terminal is where untrusted output routinely lands. The anchor
 * hop is deliberate: `target=_blank` reaches main's setWindowOpenHandler, which
 * is the ONE audited route to shell.openExternal.
 */
function openTerminalUrl(url: string): void {
  if (!isOpenableTerminalUrl(url)) {
    console.warn('flow: refusing to open a non-http(s) terminal link', url)
    return
  }
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noreferrer noopener'
  anchor.click()
}

// ── xterm lazy loader (module + css exactly once) ────────────────────────

let xtermLoad: Promise<XtermModule> | null = null

function loadXterm(): Promise<XtermModule> {
  if (!xtermLoad) {
    xtermLoad = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([module]) => module)
  }
  return xtermLoad
}

// ── Panel state ──────────────────────────────────────────────────────────

interface TerminalTab {
  info: TerminalInfo
  host: HTMLDivElement
  term: XtermTerminal | null
  /** Data received before the xterm instance attached — char-bounded (#208). */
  pending: PendingBuffer
  /** Agent tabs only: user explicitly took over input. */
  takeover: boolean
  exited: boolean
  attaching: boolean
  /** The user has typed into this terminal (any forwarded keystroke). Decides
   *  whether an unscoped boot shell is ADOPTED by the first activated project
   *  or disposed as pristine (#1024 — see unscopedTabAction). */
  interacted: boolean
  /** Folder name from the shell's OSC 7 cwd report (user tabs) — the precise
   *  "current directory" title. Preferred over the OSC 2 window title. */
  cwdTitle?: string
  /** The shell's OSC 0/2 window title (user tabs) — fallback when no OSC 7. */
  windowTitle?: string
  /** User-chosen tab name (#774, double-click rename) — wins over every
   *  automatic title until cleared (committing an empty name resets). */
  customTitle?: string
  /** A boot shell just adopted by the activating project (#1024): it takes
   *  the conversation that activation lands on as its owner, once known. */
  claimOwner: boolean
}

/** What the ownership rules read off a tab. */
function identityOf(tab: TerminalTab): TerminalIdentity & { exited: boolean } {
  return {
    kind: tab.info.kind,
    projectRoot: tab.info.projectRoot,
    owner: tab.info.owner,
    exited: tab.exited,
  }
}

/**
 * Handle returned to the coordinator so the active project can be rebound
 * when the project context switches (ADR-002). Terminals for other projects
 * are hidden — their PTYs keep running in the main process untouched.
 */
export interface TerminalPanelController {
  setActiveProject(rootPath: string | null): void
}


export function createTerminalPanel(panel: FlPanel, api: FlowApi): TerminalPanelController {
  injectPanelStyles()

  // ── DOM scaffold (replaces the shell's placeholder) ────────────────────
  panel.textContent = ''
  const root = document.createElement('div')
  root.className = 'fl-term-root'

  const header = document.createElement('div')
  header.className = 'fl-term-header'

  const tabsEl = document.createElement('fl-tabs') as FlTabs
  tabsEl.classList.add('fl-term-tabs')

  const takeoverButton = document.createElement('button')
  takeoverButton.className = 'fl-term-tool'
  takeoverButton.hidden = true

  // #1133: split the current terminal — VS Code parity. The panel could only
  // ever show ONE terminal, so comparing a server log against a test run meant
  // flipping tabs back and forth.
  const splitButton = document.createElement('button')
  splitButton.className = 'fl-term-tool'
  splitButton.title = 'Split terminal'
  splitButton.setAttribute('aria-label', 'Split terminal')
  const splitIcon = document.createElement('fl-icon')
  splitIcon.setAttribute('name', 'split-horizontal')
  splitIcon.setAttribute('size', '14')
  splitButton.appendChild(splitIcon)

  const newButton = document.createElement('button')
  newButton.className = 'fl-term-tool'
  newButton.title = 'New terminal'
  newButton.setAttribute('aria-label', 'New terminal')
  const plusIcon = document.createElement('fl-icon')
  plusIcon.setAttribute('name', 'plus')
  plusIcon.setAttribute('size', '14')
  newButton.appendChild(plusIcon)

  // Collapse/hide the terminal to give the editor the full height (#703). Reuses
  // the shell's honest hide (⌘J / ⌃` / the Terminal rail item) via a document
  // event — a visible affordance on the panel itself, which the keyboard/rail
  // toggles didn't provide. Re-open with the same controls.
  const collapseButton = document.createElement('button')
  collapseButton.className = 'fl-term-tool fl-term-collapse'
  collapseButton.title = 'Hide terminal'
  collapseButton.setAttribute('aria-label', 'Hide terminal')
  const collapseIcon = document.createElement('fl-icon')
  collapseIcon.setAttribute('name', 'chevron-down')
  collapseIcon.setAttribute('size', '14')
  collapseButton.appendChild(collapseIcon)
  collapseButton.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('flow:hide-terminal'))
  })

  header.appendChild(tabsEl)
  header.appendChild(takeoverButton)
  header.appendChild(splitButton)
  header.appendChild(newButton)
  header.appendChild(collapseButton)

  const hosts = document.createElement('div')
  hosts.className = 'fl-term-hosts'

  // #1133: the visible row. <fl-split> owns the draggable dividers; the hosts
  // that aren't on screen live in the stash, because every direct child of an
  // fl-split becomes a pane.
  const splitEl = document.createElement('fl-split') as FlSplit
  splitEl.className = 'fl-term-split'
  const stash = document.createElement('div')
  stash.className = 'fl-term-stash'
  stash.hidden = true

  const empty = document.createElement('div')
  empty.className = 'fl-term-empty'
  empty.textContent = 'No terminals — press + to open one'
  hosts.append(splitEl, stash, empty)

  root.appendChild(header)
  root.appendChild(hosts)
  panel.appendChild(root)

  // ── State ──────────────────────────────────────────────────────────────
  const tabs = new Map<string, TerminalTab>()
  /** Data for terminal ids we haven't built a tab for yet — char-bounded (#208). */
  const orphanData = new Map<string, PendingBuffer>()
  let activeId: string | null = null
  /** Which terminals are on screen together, and in what order (#1133). */
  let layout: SplitLayout = []
  /**
   * #1294: divider ratios per row, keyed by membership. renderPanes empties
   * <fl-split> when the visible group changes, and its rebuild resets sizes on
   * any pane-count change — so a tuned row came back 50/50 after a two-second
   * visit to a sibling tab, while hiding the whole panel kept it. Persisted,
   * so a relaunch keeps it too (the lesson #1059 taught the panel height).
   */
  let splitSizes: Record<string, number[]> = readSplitSizes()

  /**
   * #1445: the arrangement — rows and custom tab names — persisted beside the
   * ratios that already survived. Read once at construction; the boot path
   * applies it after `terminal:list` has told us which terminals still exist.
   */
  const savedArrangement = readArrangement()
  let lastArrangementJson = ''

  function readArrangement(): { layout: SplitLayout; titles: Record<string, string> } {
    try {
      return parseArrangement(localStorage.getItem(ARRANGEMENT_KEY))
    } catch {
      return { layout: [], titles: {} } // private mode / quota — never load-bearing
    }
  }

  /** Save rows + custom names. Called from renderTabs, so every path that can
   *  change either one is covered without each remembering to persist; the
   *  no-change guard keeps that from writing on unrelated repaints. */
  function persistArrangement(): void {
    const titles: Record<string, string> = {}
    for (const [terminalId, tab] of tabs) {
      if (tab.customTitle !== undefined) titles[terminalId] = tab.customTitle
    }
    const next = JSON.stringify({ layout, titles })
    if (next === lastArrangementJson) return
    lastArrangementJson = next
    try {
      localStorage.setItem(ARRANGEMENT_KEY, next)
    } catch {
      // Still applies for this session.
    }
  }

  function readSplitSizes(): Record<string, number[]> {
    try {
      return parseSplitSizes(localStorage.getItem(SPLIT_SIZES_KEY))
    } catch {
      return {} // private mode / quota — ratios are chrome, never load-bearing
    }
  }

  /** Remember the row's current ratio (called after a drag settles). */
  function rememberSplitSizes(paneIds: readonly string[]): void {
    if (paneIds.length < 2) return
    const sizes = splitEl.getSizes()
    if (!isUsableSizes(sizes, paneIds.length)) return
    splitSizes = { ...splitSizes, [groupKey(paneIds)]: sizes }
    try {
      localStorage.setItem(SPLIT_SIZES_KEY, JSON.stringify(splitSizes))
    } catch {
      // Still applies for this session.
    }
  }

  /** Re-apply the row's remembered ratio after fl-split rebuilt itself. */
  function restoreSplitSizes(paneIds: readonly string[]): void {
    const sizes = splitSizes[groupKey(paneIds)]
    if (!isUsableSizes(sizes, paneIds.length)) return
    splitEl.setSizes(sizes)
  }
  let cell: { width: number; height: number } | null = null
  /** Guards the auto-start so a burst of shown-events opens ONE terminal. */
  let starting = false
  /**
   * Active project (ADR-002). null → unscoped: every terminal is
   * shown (boot default and backward-compatible with pre-scoping terminals).
   * When set, only terminals whose projectRoot matches are shown as tabs;
   * others stay in the map with their PTYs alive but hidden.
   */
  let activeProjectRoot: string | null = null
  /**
   * The active thread's scope roots (multi-project threads Phase 5) — null
   * until the thread-scope layer delivers a scope. Once set, visibility is
   * scope-driven: a tab is visible when its projectRoot is IN the root set
   * (single-root scope ≡ today's activeProjectRoot equality — the degenerate
   * regression guard). PTYs are NEVER restarted or killed by scope changes.
   */
  let scopeRoots: ThreadScopeEntry[] | null = null
  /** The thread `scopeRoots` were derived for (undefined until a scope lands). */
  let scopeThreadId: string | null | undefined = undefined
  /**
   * The conversation on screen — the editor's tab scope. Each conversation is
   * its own context: a user shell is shown only while the scope it was opened
   * in is this one. undefined until the first scope is known; null while no
   * project is active.
   */
  let ownerScope: TerminalOwner | null | undefined = undefined
  /** The scope layer's thread when the project view came on screen — the
   *  baseline that tells a settled project view from a selection in flight. */
  let projectViewScopeThreadId: string | null | undefined = undefined
  /** Shells being created per scope (ownerKey) — an auto-start must not add a
   *  second one beside a shell that is already on its way. */
  const creating = new Map<string, number>()
  /** A + pressed while the scope roots still belonged to the conversation
   *  being left — run, for that conversation only, once they arrive. */
  let deferredNewFor: string | null = null

  /** The panel's current scoping inputs for the pure decision layer. */
  function scopeState(): TerminalScopeState {
    return { scopeRoots, activeProjectRoot, ownerScope, scopeThreadId, projectViewScopeThreadId }
  }

  /** Each scope's saved shells, re-spawned once per window and before anything
   *  new is opened in it (see terminal-restore.ts). */
  const restorer = new ScopeRestorer({
    load: async (owner) =>
      typeof api.project.loadScopeTerminals === 'function'
        ? api.project.loadScopeTerminals({ rootPath: owner.rootPath, threadId: owner.threadId })
        : [],
    live: async (owner) =>
      (await api.terminal.list())
        .filter(
          (info) =>
            info.kind === 'user' &&
            info.exited !== true &&
            info.owner !== undefined &&
            info.owner.rootPath === owner.rootPath &&
            info.owner.threadId === owner.threadId,
        )
        .map((info) => ({ title: info.customTitle ?? info.title, cwd: info.cwd })),
    spawn: (rootPath, ref, owner) =>
      createTerminal(rootPath, undefined, {
        owner,
        restoring: true,
        customTitle: restoredCustomTitle(ref),
      }),
  })

  // ── Is each shell's directory still there? ──────────────────────────────
  // A running shell's cwd was fixed when it spawned, so it cannot follow
  // anything anywhere. This strip used to tag every tab with the tree it was
  // in, back when a conversation's checkout was an object a person managed;
  // that went with the surfaces that managed it. What survives is the one tag
  // with a consequence (C3): a shell whose directory has been freed keeps its
  // scrollback and loses its ground, and nothing else on screen says so.
  /** Roots whose directory could not be read — a directory removed out from
   *  under a shell that is still running in it. */
  const missingRoots = new Set<string>()
  /** Roots already probed since the last scope change, so the check costs one
   *  read per tree rather than one per render. */
  const probedRoots = new Set<string>()

  /**
   * Check whether the trees the VISIBLE tabs sit in are still there — at most
   * one read per tree per scope change, and only while the panel is on screen
   * (allowed-pattern #17: an off-screen surface re-checks on the way back in).
   */
  function probeVisibleRoots(): void {
    if (!panel.isConnected) return
    for (const tab of tabs.values()) {
      const root = tab.info.projectRoot
      if (root === undefined || !isTabVisible(tab) || probedRoots.has(root)) continue
      probedRoots.add(root)
      void api.project
        .listDir({ rootPath: root })
        .then(() => {
          if (missingRoots.delete(root)) renderTabs()
        })
        .catch(() => {
          if (missingRoots.has(root)) return
          missingRoots.add(root)
          renderTabs()
        })
    }
  }

  /** A user shell is visible while the conversation it was opened in is on
   *  screen; agent tabs (and unowned boot shells) while their root is in the
   *  thread scope (or, in legacy mode, unscoped / the active project's). */
  function isTabVisible(tab: TerminalTab): boolean {
    return isTerminalShown(identityOf(tab), scopeState())
  }

  function firstVisibleTab(): TerminalTab | null {
    for (const tab of tabs.values()) {
      if (isTabVisible(tab)) {
        return tab
      }
    }
    return null
  }

  // ── Fitting (manual — no fit addon in deps) ────────────────────────────

  function measureCell(): { width: number; height: number } {
    if (cell) {
      return cell
    }
    const probe = document.createElement('span')
    probe.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;' +
      `font-family:${TERMINAL_FONT_FAMILY};font-size:${TERMINAL_FONT_SIZE}px;line-height:normal`
    probe.textContent = 'W'.repeat(50)
    hosts.appendChild(probe)
    const rect = probe.getBoundingClientRect()
    hosts.removeChild(probe)
    cell = {
      width: rect.width / 50 || 8,
      height: Math.ceil(rect.height) || 17,
    }
    return cell
  }

  /** Null when the panel has no layout area (hidden/removed or 0×0) — see #99.
   *  #1133: measured against the given HOST, since split panes each have their
   *  own width — sizing every pane to the whole panel would overflow them. */
  function computeGrid(host: HTMLElement = hosts): { cols: number; rows: number } | null {
    return computeTerminalGrid(host.getBoundingClientRect(), measureCell(), host.isConnected)
  }

  function fitTab(tab: TerminalTab): void {
    if (!tab.term) {
      return
    }
    // No layout area → do NOT resize. Fitting a hidden panel would clamp to the
    // minimum grid and SIGWINCH the live PTY, reflowing running programs (#99).
    // A stashed (off-screen) pane measures 0×0 and is skipped by the same rule.
    const grid = computeGrid(tab.host)
    if (!grid) {
      return
    }
    const { cols, rows } = grid
    if (tab.term.cols === cols && tab.term.rows === rows) {
      return
    }
    tab.term.resize(cols, rows)
    api.terminal
      .resize({ terminalId: tab.info.terminalId, cols, rows })
      .catch(console.warn)
  }

  const resizeObserver = new ResizeObserver(() => {
    cell = null // font metrics survive, but re-derive against fresh bounds
    // #1133: every pane in the row, not just the focused one — a resize
    // changes all of their widths.
    fitVisiblePanes()
  })
  resizeObserver.observe(hosts)

  // ── Tabs strip rendering ───────────────────────────────────────────────

  function renderTabs(): void {
    persistArrangement() // #1445 — rows + names, so ⌘R hands back what was arranged
    const visible = [...tabs.values()].filter(isTabVisible)
    const descriptors: TabDescriptor[] = visible.map((tab) => {
      // Multi-root scope only: the tab carries its project's accent dot, with
      // the project name as the tooltip (stable per tab — the churning label
      // must NOT feed the tooltip, which is a structural field whose change
      // forces a strip rebuild, defeating the #993 patch path). Single-root
      // scope / legacy: no dot, byte-identical to today.
      const projectName = tabProjectName(tab.info.projectRoot, scopeState())
      // A removed directory says so ON the tab — a tab that silently points at
      // nothing is the confusing case the tag exists to end.
      const rootTag = terminalRootTag(tab.info.projectRoot, missingRoots)
      const goneMark = rootTag === null ? '' : ` (${rootTag.label})`
      return {
        id: tab.info.terminalId,
        // A user-chosen name (#774) wins over every automatic title; agent tabs
        // keep the ⚙ marker either way.
        label:
          (tab.info.kind === 'agent'
            ? `⚙ ${tab.customTitle ?? tab.info.title}`
            : // User tabs follow the shell's current folder (OSC 7 cwd, then the
              // OSC 2 window title), falling back to the creation title.
              (tab.customTitle ?? tab.cwdTitle ?? tab.windowTitle ?? tab.info.title)) +
          (tab.exited ? ' (exited)' : '') +
          goneMark,
        icon: tab.info.kind === 'user' ? 'terminal' : undefined,
        // Agent (⚙) tabs are closable too — otherwise they accumulate one-per-thread
        // and can never be dismissed (#304). Close → dispose → terminal:removed.
        closable: true,
        renamable: true,
        // The dot is the existing multi-project marker; the tooltip is the
        // gone-directory answer when there is one (it says strictly more than
        // the bare project name it replaces), else the older name-only hover.
        ...(rootTag !== null && tab.info.projectRoot !== undefined
          ? { accent: ensureAccentProperty(tab.info.projectRoot), tooltip: rootTag.tooltip }
          : projectName !== null && tab.info.projectRoot !== undefined
            ? { accent: ensureAccentProperty(tab.info.projectRoot), tooltip: projectName }
            : {}),
      }
    })
    tabsEl.tabs = descriptors
    tabsEl.activeId = activeId
    empty.hidden = visible.length > 0
    // #1133: Split is only offered when there is something to split and room
    // to split it into — a disabled button with a reason beats a dead click.
    const splittable = canSplit(layout, activeId)
    splitButton.disabled = !splittable
    splitButton.title = splittable
      ? 'Split terminal'
      : activeId === null
        ? 'Split terminal — open a terminal first'
        : `Split terminal — at most ${MAX_SPLIT_PANES} side by side`
    renderTakeoverToggle()
  }

  function renderTakeoverToggle(): void {
    const active = activeId ? tabs.get(activeId) : null
    if (!active || active.info.kind !== 'agent') {
      takeoverButton.hidden = true
      return
    }
    takeoverButton.hidden = false
    takeoverButton.textContent = active.takeover ? 'Read-only' : 'Take over'
    takeoverButton.title = active.takeover
      ? 'Return this agent terminal to read-only'
      : 'Send your keystrokes to this agent terminal'
    takeoverButton.classList.toggle('active', active.takeover)
  }

  // ── Attach / write ─────────────────────────────────────────────────────

  async function attachXterm(tab: TerminalTab): Promise<void> {
    if (tab.term || tab.attaching) {
      return
    }
    tab.attaching = true
    try {
      const { Terminal } = await loadXterm()
      if (!tabs.has(tab.info.terminalId)) {
        return // closed while the module was loading
      }
      const term = new Terminal({
        theme: currentXtermTheme(),
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: TERMINAL_FONT_SIZE,
        scrollback: TERMINAL_SCROLLBACK_LINES,
        cursorBlink: tab.info.kind === 'user',
        // #1190: OSC 8 hyperlinks (what gh / vitest / ls --hyperlink / cargo
        // emit) rendered underlined WITH a hand cursor and did nothing when
        // clicked — xterm's fallback activation goes through window.open(),
        // which this window's setWindowOpenHandler denies after handing the URL
        // to shell.openExternal, so the link was dropped silently. An
        // affordance that says "clickable" and isn't is worse than none.
        linkHandler: {
          activate: (_event, uri) => openTerminalUrl(uri),
        },
      })
      term.open(tab.host)
      // #1149: right-click inside the shell opens Copy/Paste/Select All/Clear.
      // The gesture was inert here while the tab strip 20px above answered it,
      // and it is how every terminal a user comes from does copy/paste.
      tab.host.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        // A read-only agent tab takes no input (same rule as onData below), so
        // Paste/Clear render disabled rather than lying about what they'll do.
        const writable = tab.info.kind !== 'agent' || tab.takeover === true
        showTerminalMenu(
          event.clientX,
          event.clientY,
          {
            hasSelection: term.getSelection().length > 0,
            writable,
            // The menu belongs to THIS pane, so it splits this one — which may
            // not be the focused tab when the row already holds several.
            splittable: canSplit(layout, tab.info.terminalId),
          },
          {
            copy: () => {
              void navigator.clipboard
                .writeText(term.getSelection())
                .catch((error: unknown) => console.warn('flow: terminal copy failed', error))
            },
            paste: () => {
              void navigator.clipboard
                .readText()
                // term.paste (not a raw write) so bracketed paste still applies —
                // a multi-line paste must not auto-execute.
                .then((text) => {
                  if (text) term.paste(text)
                })
                .catch((error: unknown) => console.warn('flow: terminal paste failed', error))
            },
            selectAll: () => term.selectAll(),
            clear: () => term.clear(),
            split: () => splitFrom(tab.info.terminalId),
            // #1387: HAND THE KEYBOARD BACK. Every item left focus on <body>
            // — the shell still LOOKED focused (cursor block, painted
            // selection, highlighted tab) but was no longer listening, so the
            // next command was silently discarded. Worse after Select All,
            // where the natural next gesture is ⌘C: it copied nothing and the
            // clipboard kept its stale contents, which is silent wrong data
            // rather than a no-op.
            refocus: () => term.focus(),
          },
        )
      })
      // #1190: bare URLs printed by a command (`Local: http://localhost:5173/`)
      // carry no escape at all, so they need a provider. The chat already
      // linkifies the identical string (#1127) 200px away.
      term.registerLinkProvider({
        provideLinks: (bufferLineNumber, callback) => {
          const line = term.buffer.active.getLine(bufferLineNumber - 1)
          if (!line) {
            callback(undefined)
            return
          }
          const links = detectTerminalLinks(line.translateToString(true)).map((span) => ({
            range: {
              start: { x: span.startColumn, y: bufferLineNumber },
              end: { x: span.endColumn - 1, y: bufferLineNumber },
            },
            text: span.url,
            activate: () => openTerminalUrl(span.url),
          }))
          callback(links.length > 0 ? links : undefined)
        },
      })
      // Live tab title from the shell (user tabs): OSC 7 reports the cwd (macOS
      // zsh emits it by default) → the folder name; OSC 0/2 sets the window
      // title as a fallback. Both re-render the tab strip so a `cd` updates the
      // tab instead of leaving the stale creation title.
      if (tab.info.kind === 'user') {
        term.onTitleChange((title) => {
          const next = title.trim() || undefined
          if (next !== tab.windowTitle) {
            tab.windowTitle = next
            // #993: the label is customTitle ?? cwdTitle ?? windowTitle — when
            // either shadow is set, a windowTitle change can't affect what's
            // rendered, so skip the re-render entirely (a git-aware zsh prompt
            // fires this ~1×/s per open shell).
            if (tab.customTitle === undefined && tab.cwdTitle === undefined) {
              renderTabs()
            }
          }
        })
        term.parser.registerOscHandler(7, (data) => {
          // THE PATH, then the NAME — a thread's checkout is a UUID on disk and
          // the scope is the only thing that knows what to call it.
          const cwd = osc7FolderPath(data)
          const folder = cwd === null ? null : terminalCwdLabel(cwd, scopeState())
          if (folder && folder !== tab.cwdTitle) {
            tab.cwdTitle = folder
            renderTabs()
          }
          return true
        })
      }
      term.onData((data) => {
        if (tab.info.kind === 'agent' && !tab.takeover) {
          return // read-only agent tab
        }
        // A forwarded keystroke marks the shell as USED — an unscoped boot
        // shell the user worked in gets adopted on project activation instead
        // of disposed (#1024).
        tab.interacted = true
        api.terminal
          .write({ terminalId: tab.info.terminalId, data })
          .catch(console.warn)
      })
      // cmd+L on a non-empty selection → attach it to the composer as a context
      // chip instead of sending the keystroke to the shell (#152). Return false so
      // xterm doesn't forward the key. cmd (not ctrl) so it never shadows ⌃L clear.
      term.attachCustomKeyEventHandler((event) => {
        if (
          event.type === 'keydown' &&
          event.metaKey &&
          !event.ctrlKey &&
          event.key.toLowerCase() === 'l'
        ) {
          const selection = term.getSelection().trim()
          if (selection.length > 0) {
            document.dispatchEvent(
              new CustomEvent('flow:add-to-chat', {
                detail: { source: 'terminal', text: selection, label: 'Terminal' },
              }),
            )
            return false
          }
        }
        return true
      })
      tab.term = term
      for (const chunk of tab.pending.drain()) {
        term.write(chunk)
      }
      fitTab(tab)
    } catch (error) {
      console.error('flow: failed to attach terminal view', error)
      notify(tab.info.projectRoot ?? '', terminalAttachFailedToast(error))
    } finally {
      tab.attaching = false
    }
  }

  function writeToTab(tab: TerminalTab, data: string): void {
    if (tab.term) {
      tab.term.write(data)
    } else {
      tab.pending.push(data) // char-bounded: an unopened tab can't leak (#208)
    }
  }

  /** Surface a toast via the flow:notify bridge (→ NotificationCenter) so a
   *  failed terminal open isn't a silent dead click (#209). */
  function notify(rootId: string, toast: TerminalToast): void {
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

  // ── Tab lifecycle ──────────────────────────────────────────────────────

  function addTab(info: TerminalInfo): TerminalTab {
    const existing = tabs.get(info.terminalId)
    if (existing) {
      return existing
    }
    const host = document.createElement('div')
    host.className = 'fl-term-host'
    host.hidden = true
    // #1133: the pane's identity, so renderPanes can diff the visible row
    // without a parallel bookkeeping map.
    host.dataset['terminalId'] = info.terminalId
    stash.appendChild(host)
    // Focus follows the click, like every other split editor: clicking into a
    // pane makes it the active terminal (and moves the tab strip's selection).
    host.addEventListener('mousedown', () => {
      if (activeId === info.terminalId) return
      const tab = tabs.get(info.terminalId)
      if (!tab || !isTabVisible(tab)) return
      activeId = info.terminalId
      renderPanes()
      renderTabs()
    })

    // #1024 (late-arrival leg): a USER terminal that lands unscoped while a
    // project is already active can only be the boot-path auto-start racing the
    // first activation (nothing can deliberately create one in this state) —
    // scope it to the active project immediately so it never starts life as an
    // unreachable tab.
    if (info.projectRoot === undefined && info.kind === 'user' && activeProjectRoot !== null) {
      info.projectRoot = activeProjectRoot
    }
    const tab: TerminalTab = {
      info,
      host,
      term: null,
      pending: orphanData.get(info.terminalId) ?? new PendingBuffer(),
      takeover: false,
      // Restore exit state replayed from terminal:list so a window reopened from the
      // dock doesn't present a dead shell as live (#446).
      exited: initialTabExited(info),
      attaching: false,
      interacted: false,
      claimOwner: false,
      // The name main kept for it — what a reloaded window shows.
      ...(info.customTitle === undefined ? {} : { customTitle: info.customTitle }),
    }
    orphanData.delete(info.terminalId)
    tabs.set(info.terminalId, tab)
    // An unowned user shell landing while a conversation is on screen can only
    // be the boot auto-start racing it — it is that conversation's.
    if (info.kind === 'user' && info.owner === undefined && ownerScope !== undefined && ownerScope !== null) {
      claimTab(tab, ownerScope)
    }
    layout = addTerminal(layout, info.terminalId) // its own group until split (#1133)

    // Auto-activate only a terminal that belongs to the active project;
    // other-project terminals join hidden (host stays hidden by default).
    if (!activeId && isTabVisible(tab)) {
      activateTab(info.terminalId)
    } else {
      renderPanes()
      renderTabs()
    }
    return tab
  }

  /**
   * Put the active terminal's group on screen as side-by-side panes (#1133),
   * and everything else in the stash. A single-terminal group is one pane —
   * byte-for-byte the pre-split experience.
   *
   * Hosts are MOVED between the stash and the split, so this only touches the
   * DOM when the visible set actually changes: an xterm reparent costs a
   * re-fit, and doing it on every focus change would flicker the row.
   */
  function renderPanes(): void {
    layout = pruneLayout(layout, new Set(tabs.keys()))
    const paneIds = visiblePanes(layout, activeId, (id) => {
      const tab = tabs.get(id)
      return tab !== undefined && isTabVisible(tab)
    })
    const current = [...splitEl.children].map((child) => (child as HTMLElement).dataset['terminalId'])
    const changed =
      current.length !== paneIds.length || paneIds.some((id, index) => current[index] !== id)
    if (changed) {
      for (const tab of tabs.values()) {
        if (paneIds.includes(tab.info.terminalId)) continue
        tab.host.hidden = true
        if (tab.host.parentElement !== stash) stash.appendChild(tab.host)
      }
      // Append in ORDER — fl-split's panes follow child order, and its
      // MutationObserver rebuilds the handles for us.
      for (const id of paneIds) {
        const tab = tabs.get(id)
        if (!tab) continue
        tab.host.hidden = false
        splitEl.appendChild(tab.host)
      }
      // #1294: that rebuild is asynchronous (MutationObserver) and resets the
      // sizes, so the ratio is re-applied after it — not before, or it would
      // be immediately overwritten by the even split.
      queueMicrotask(() => restoreSplitSizes(paneIds))
    }
    // The focused pane is marked, not just implied: with two shells side by
    // side, "where do my keystrokes go" needs an answer you can see.
    for (const tab of tabs.values()) {
      tab.host.classList.toggle(
        'focused',
        tab.info.terminalId === activeId && paneIds.length > 1,
      )
    }
    splitEl.hidden = paneIds.length === 0
    if (changed) {
      for (const id of paneIds) {
        const tab = tabs.get(id)
        if (!tab) continue
        void attachXterm(tab).then(() => fitTab(tab))
      }
    }
  }

  /** A LIVE pane sharing the row with `terminalId` — the survivor a dying
   *  shell should hand the keyboard to (#1293). Prefers the pane to its right,
   *  then its left, matching every other adjacency rule here (#408). */
  function liveSiblingPane(terminalId: string): string | null {
    const group = groupOf(layout, terminalId)
    if (group === null) return null
    const index = group.indexOf(terminalId)
    const ordered = [...group.slice(index + 1), ...group.slice(0, index).reverse()]
    for (const candidate of ordered) {
      const tab = tabs.get(candidate)
      if (tab && !tab.exited && isTabVisible(tab)) return candidate
    }
    return null
  }

  /** Re-fit every pane on screen — a divider drag or a panel resize changes
   *  all of them, not just the focused one. */
  function fitVisiblePanes(): void {
    for (const child of splitEl.children) {
      const id = (child as HTMLElement).dataset['terminalId']
      const tab = id === undefined ? undefined : tabs.get(id)
      if (tab) fitTab(tab)
    }
  }

  /**
   * Make a terminal the visible/active one.
   *
   * #1410: `focus` is OPT-IN. This always took the keyboard, and the
   * project-switch arrival path (`setActiveProject` → `ensureStarted`) reaches
   * it — so a switch moved focus into the shell's hidden
   * `.xterm-helper-textarea`, and the next thing the user typed went to the
   * shell prompt, with Enter RUNNING it. (My #1341 fix made this reachable on
   * the first project too: the panel now correctly survives the boot-shell
   * disposal, so the arrival really does start and activate a terminal.)
   *
   * Revealing a terminal and STEALING THE KEYBOARD are different acts. Only
   * the paths where the user asked for the terminal pass `focus: true`.
   */
  function activateTab(terminalId: string, options: { focus?: boolean } = {}): void {
    const tab = tabs.get(terminalId)
    if (!tab) {
      return
    }
    activeId = terminalId
    layout = addTerminal(layout, terminalId)
    renderPanes()
    renderTabs()
    void attachXterm(tab).then(() => {
      fitTab(tab)
      // Never yank focus away from an open modal overlay — the first-run
      // onboarding wizard (and the settings dialogs) reuse `.fl-settings-overlay`
      // and own focus while visible. The boot terminal auto-start would otherwise
      // focus the hidden xterm textarea BEHIND the wizard, and xterm's
      // stopPropagation then swallows the wizard's Escape-to-dismiss (#683).
      if (options.focus === true && !isModalOverlayOpen()) tab.term?.focus()
    })
  }

  /**
   * Drop a tab. `userInitiated` decides whether the LAST close also hides the
   * panel (#940) — and #1341 is what happens when it doesn't decide anything:
   *
   * Opening your first project disposes the pristine boot shell (#1024, so its
   * PTY can't leak alive-but-unreachable). That disposal ran through here,
   * hit the "last terminal closed" branch, and dispatched flow:hide-terminal —
   * which removes the panel from the DOM. The arrival guard immediately below
   * then checked `panel.isConnected` to decide whether to start the project's
   * shell, found false, and did nothing. Terminal gone, no tabs, no PTYs, no
   * message, on the very next thing every new user does.
   *
   * Auto-hide is a courtesy for a user who closed their last terminal. It must
   * never fire for housekeeping the user did not ask for.
   */
  function removeTab(terminalId: string, options: { userInitiated?: boolean } = {}): void {
    const tab = tabs.get(terminalId)
    if (!tab) {
      return
    }
    // Closing the ACTIVE tab activates its ADJACENT neighbor (right, else left)
    // among the VISIBLE tabs — matching the editor tab strip — instead of jumping
    // to the first/oldest terminal (#408). Compute BEFORE deleting so the closed
    // tab's position is still known.
    const wasActive = activeId === terminalId
    // #1133: with the row split, focus stays in the ROW — the pane beside the
    // closed one — before falling back to the strip's global adjacency.
    const nextId = wasActive
      ? (neighborInGroup(layout, terminalId) ??
        neighborOf([...tabs.values()].filter(isTabVisible).map((t) => t.info.terminalId), terminalId))
      : null
    tabs.delete(terminalId)
    layout = removeFromLayout(layout, terminalId)
    // #1149: the menu is body-mounted, so a tab closing under an open menu
    // would leave it hovering over a terminal that no longer exists.
    closeTerminalMenu()
    tab.term?.dispose()
    tab.host.remove()
    if (wasActive) {
      activeId = null
      if (nextId) {
        activateTab(nextId, { focus: true }) // they were typing in the one that closed
        return
      }
    }
    renderPanes()
    renderTabs()
    // #940: closing the LAST terminal leaves an empty panel occupying the
    // bottom slot ("No terminals — press + to open one"). Give the space back
    // to the editor automatically; the rail item, ⌃`/⌘J and the footer button
    // all still bring it back (and a reveal auto-starts a shell, #439).
    if (options.userInitiated === true && visibleTabCount() === 0) {
      document.dispatchEvent(new CustomEvent('flow:hide-terminal'))
    }
  }

  /** Terminals currently shown for the active thread scope — the panel is
   *  "empty" (and worth hiding) only when this is zero. */
  function visibleTabCount(): number {
    return [...tabs.values()].filter(isTabVisible).length
  }

  // ── New-terminal button (per project root) ───────────────────────────

  /** `splitFrom` — open the terminal BESIDE that one instead of in its own
   *  group (#1133). The grid is measured from the anchor's host, which is about
   *  to be halved, so the new pane starts near its real width. */
  async function createTerminal(
    rootId?: string,
    splitFrom?: string,
    // #1410: did a HUMAN ask for this terminal? The boot/arrival auto-start
    // did not, and must not take the keyboard.
    // `owner`: the conversation the shell is for — the one on screen unless a
    // restore says otherwise (it may finish after the person has moved on).
    // `restoring`: this IS the restore re-spawning a saved shell.
    // `customTitle`: the name a person gave the saved shell.
    options: {
      focus?: boolean
      run?: string
      owner?: TerminalOwner
      restoring?: boolean
      customTitle?: string
    } = {},
  ): Promise<void> {
    const owner = options.owner ?? ownerScope ?? undefined
    // Counted from the start — before the restore await below — so an
    // auto-start resuming in the same tick sees this shell is on its way.
    const busyKey = owner === undefined ? null : ownerKey(owner)
    if (busyKey !== null) creating.set(busyKey, (creating.get(busyKey) ?? 0) + 1)
    try {
      // The conversation's saved shells come back FIRST: main re-saves a
      // scope's live set whenever a shell opens, so a new one opened before the
      // restore would save a set of one over them.
      if (options.restoring !== true && options.owner === undefined) {
        await restorer.restore(scopeState())
      }
      // A terminal opened before the panel has layout starts at the default
      // grid; the ResizeObserver refits it once the panel is actually sized (#99).
      const anchorHost = splitFrom === undefined ? undefined : tabs.get(splitFrom)?.host
      const measured = computeGrid(anchorHost ?? hosts) ?? DEFAULT_GRID
      const { rows } = measured
      const cols =
        splitFrom === undefined ? measured.cols : Math.max(MIN_SPLIT_COLS, Math.floor(measured.cols / 2))
      const info = await api.terminal.create({
        rootId,
        cols,
        rows,
        ...(owner === undefined ? {} : { owner: { ...owner } }),
      })
      const tab = addTab(info) // terminal:created may have raced us; addTab dedupes
      if (options.customTitle !== undefined) {
        tab.customTitle = options.customTitle
        renameInMain(info.terminalId, options.customTitle)
      }
      if (splitFrom !== undefined) layout = splitBeside(layout, splitFrom, info.terminalId)
      // A shell restored for a conversation the person has since left joins
      // hidden — it is that conversation's, and must not take this screen.
      if (!isTabVisible(tab)) {
        renderPanes()
        renderTabs()
        return
      }
      // Opening a terminal IS asking for it — but only when a human asked;
      // the boot/arrival auto-start goes through ensureStarted (#1410).
      activateTab(info.terminalId, { focus: options.focus === true })
      // A COMMAND THE CALLER ASKED FOR, typed into the new shell. Used by the
      // sign-in buttons: `codex login` needs a real TTY and a browser hand-off,
      // which is a terminal's job and not something a settings panel can fake.
      // Written after activation so the shell that receives it is the one on
      // screen — and left for the shell to echo, so the reader sees the command
      // that ran rather than output from nowhere.
      if (options.run !== undefined && options.run.length > 0) {
        await api.terminal.write({ terminalId: info.terminalId, data: `${options.run}\n` })
      }
    } catch (error) {
      console.error('flow: failed to create terminal', error)
      notify(rootId ?? activeProjectRoot ?? '', terminalCreateFailedToast(error))
    } finally {
      if (busyKey !== null) {
        const left = (creating.get(busyKey) ?? 1) - 1
        if (left > 0) creating.set(busyKey, left)
        else creating.delete(busyKey)
      }
    }
  }

  /** Tell main a tab's name, so it is saved with the shell (null clears it). */
  function renameInMain(terminalId: string, title: string | null): void {
    if (typeof api.terminal.rename !== 'function') return
    void api.terminal
      .rename({ terminalId, title })
      .catch((error: unknown) => console.warn('flow: could not record the terminal’s name', error))
  }

  /** VS Code parity: opening the terminal panel with none open auto-starts a
   *  terminal. Called on the shell's "terminal shown" event and on first mount
   *  when the panel is already visible. No-op when a terminal already exists. */
  /** Open a new terminal, guarded so concurrent triggers coalesce (#372). The
   *  ⌘⇧` shortcut reveals the panel AND dispatches flow:terminal-new; on an empty
   *  reveal, flow:terminal-shown → ensureStarted already starts one, so the guard
   *  makes the flow:terminal-new that lands in the same keystroke a no-op instead
   *  of opening a duplicate. */
  function startTerminal(interactive: boolean): void {
    if (starting) {
      return
    }
    starting = true
    void onNewTerminal(interactive).finally(() => {
      starting = false
    })
  }

  function ensureStarted(): void {
    // Auto-start on reveal unless a LIVE shell already exists. An exited tab must
    // NOT count as live, or reopening after the only shell exits leaves a dead
    // "(exited)" tab that silently swallows keystrokes (#439). Scrollback stays.
    //
    // THIS CONVERSATION'S OWN shells, not merely what is on screen: a shell
    // another conversation opened is not this one's (it is hidden), and a
    // root-scoped shell left in the project's tree after a thread's checkout
    // displaced it is not either — counting it left people typing on the
    // project's branch in a thread that had its own.
    if (starting) return
    // Nobody has said yet which conversation is on screen — or whether there
    // is a project at all. A shell started now would belong to nobody and
    // show in every thread of its project (and would stand in for the shells
    // the real scope has saved). The answer (applyOwnerScope) calls back in.
    if (ownerScope === undefined) return
    const state = scopeState()
    // The scope roots still belong to the conversation being left — the
    // scope's arrival calls back in, with the right checkout to start in.
    const override = ownerSpawnOverride(state)
    if (override !== null && 'wait' in override) return
    // A + pressed while waiting for exactly this: it opens its shell now (after
    // the conversation's saved ones), and stands in for the auto-start.
    if (deferredNewFor !== null) {
      const pressedFor = deferredNewFor
      deferredNewFor = null
      if (ownerScope !== null && ownerKey(ownerScope) === pressedFor) {
        startTerminal(true)
        return
      }
    }
    if (hasLiveShellHere([...tabs.values()].map(identityOf), state)) return
    // First visit to this conversation in this window: bring back the shells
    // it had open when the app last closed, rather than a fresh one.
    if (ownerScope !== null && !restorer.started(ownerScope)) {
      const run = restorer.restore(state)
      if (run !== null) {
        starting = true
        void run.finally(() => {
          starting = false
          // Whatever is on screen now (the person may have moved on while this
          // loaded) gets its own answer — the plain auto-start when nothing
          // was saved, a no-op when the restore covered it.
          if (panel.isConnected) ensureStarted()
        })
        return
      }
    }
    // Auto-start is not a user gesture — it must never pop the root menu, so a
    // multi-root thread's empty panel spawns straight into the primary root.
    startTerminal(false)
  }

  /**
   * `interactive` — true for explicit user gestures (+ button, ⌘⇧`): under a
   * multi-root thread scope these open the "New terminal in:" root menu.
   * Non-interactive triggers (reveal auto-start) always spawn directly.
   */
  async function onNewTerminal(interactive: boolean): Promise<void> {
    const owner = ownerScope
    if (owner !== undefined && owner !== null) {
      // The roots still belong to the conversation being left: a shell now
      // would open in its checkout — and, saved under this conversation,
      // replace the shells it has not restored yet. The scope's arrival runs
      // the + (ensureStarted); an auto-start simply re-asks then.
      const waiting = ownerSpawnOverride(scopeState())
      if (waiting !== null && 'wait' in waiting) {
        if (interactive) deferredNewFor = ownerKey(owner)
        return
      }
      // Saved shells come back before anything new opens here.
      await restorer.restore(scopeState())
      // The person moved on while that ran — this ask was for a conversation
      // no longer on screen.
      if (ownerScope === undefined || ownerScope === null || ownerKey(ownerScope) !== ownerKey(owner)) return
      // An auto-start is "a shell when there is none": the restore may have
      // brought some back, or a + may already be opening one.
      if (
        !interactive &&
        (hasLiveShellHere([...tabs.values()].map(identityOf), scopeState()) || creating.has(ownerKey(owner)))
      ) {
        return
      }
    }
    // The project view's shells live in the project's own tree, whatever thread
    // the scope layer last derived; a thread whose roots have not arrived yet
    // starts in its own primary root once they do (an explicit + is not
    // dropped — it falls through to the scope it has).
    const override = ownerSpawnOverride(scopeState())
    if (override !== null && 'rootPath' in override) {
      await createTerminal(override.rootPath, undefined, { focus: interactive })
      return
    }
    // Thread scope in charge (Phase 5): multi-root + a user gesture → per-root
    // menu (available roots only, primary first); otherwise spawn in the
    // scope's default root. Single-root scope: exactly today's behavior.
    const scoped = defaultNewTerminalRoot(scopeState())
    if (scoped !== undefined) {
      const menuItems = interactive ? newTerminalMenu(scopeState()) : null
      if (menuItems) {
        showRootMenu(menuItems, {
          label: 'New terminal in:',
          onPick: (rootPath) => void createTerminal(rootPath, undefined, { focus: true }),
          returnFocusTo: newButton,
        })
        return
      }
      await createTerminal(scoped, undefined, { focus: interactive })
      return
    }
    // ADR-002 legacy path (no scope yet / scope layer unavailable): new
    // terminals belong to the active project. Only when unscoped (no active
    // project) do we fall back to the project-roots picker.
    if (activeProjectRoot !== null) {
      await createTerminal(activeProjectRoot, undefined, { focus: interactive })
      return
    }
    let roots: Awaited<ReturnType<typeof api.project.list>> = []
    try {
      roots = await api.project.list()
    } catch (error) {
      console.warn('flow: could not list project roots for new terminal', error)
    }
    if (roots.length <= 1) {
      await createTerminal(roots[0]?.rootPath, undefined, { focus: interactive })
      return
    }
    showRootMenu(
      roots.map((project) => ({
        rootPath: project.rootPath,
        name: baseName(project.rootPath) || project.rootPath,
      })),
      {
        label: 'New terminal in:',
        onPick: (rootPath) => void createTerminal(rootPath, undefined, { focus: true }),
        returnFocusTo: newButton,
      },
    )
  }

  /**
   * Lightweight one-shot picker under the header buttons (multi-root only): one
   * row per root — accent dot + project name — under a label that says what
   * picking one will DO.
   *
   * TWO CALLERS, ONE MENU. The + button opens a terminal in the chosen project;
   * the split button opens one BESIDE the current pane. Splitting used to take
   * the anchor's project with no say in it, so a person splitting to watch a
   * backend beside a frontend got the same project twice and had to move the
   * tab afterwards (user, 2026-09-18). The only differences are the sentence
   * and what happens on click, so those are the arguments.
   */
  function showRootMenu(
    items: NewTerminalMenuItem[],
    options: { label: string; onPick: (rootPath: string) => void; returnFocusTo: HTMLElement },
  ): void {
    // #1150: one picker at a time. Enter used to re-fire the + button that
    // still held focus, stacking a SECOND menu on top of the first.
    closeRootMenu()
    const menu = document.createElement('div')
    menu.className = 'fl-term-root-menu'
    const label = document.createElement('div')
    label.className = 'fl-term-root-menu-label'
    label.textContent = options.label
    menu.appendChild(label)
    for (const { rootPath, name } of items) {
      const item = document.createElement('button')
      item.className = 'fl-term-root-item'
      const dot = document.createElement('span')
      dot.className = 'fl-term-root-dot'
      dot.style.background = ensureAccentProperty(rootPath)
      item.appendChild(dot)
      item.appendChild(document.createTextNode(name))
      item.title = rootPath
      item.type = 'button'
      item.addEventListener('click', () => {
        closeRootMenu()
        options.onPick(rootPath)
      })
      menu.appendChild(item)
    }

    // #1150: the picker is keyboard-operable, like every other shell menu
    // (#638's project switcher, #539's thread chooser, fl-tabs' close-ops).
    // The route IN is often the ⌘P palette's "New terminal", so a keyboard
    // user was being dropped into a popup they could neither drive nor leave.
    const rows = (): HTMLButtonElement[] =>
      [...menu.querySelectorAll<HTMLButtonElement>('.fl-term-root-item')]
    const move = (delta: 1 | -1): void => {
      const all = rows()
      if (all.length === 0) return
      const at = all.indexOf(document.activeElement as HTMLButtonElement)
      // From "nothing focused", ArrowDown lands on the first row and ArrowUp on
      // the last; from a row it wraps, so the list has no dead ends.
      const next = at === -1 ? (delta === 1 ? 0 : all.length - 1) : (at + delta + all.length) % all.length
      all[next]?.focus()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Scoped (#1161): this Escape closes the picker and must not also exit
        // focus mode or reach the shell behind it.
        event.preventDefault()
        event.stopPropagation()
        closeRootMenu()
        options.returnFocusTo.focus() // back where the user opened it from
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        move(event.key === 'ArrowDown' ? 1 : -1)
      }
    }
    const onDown = (event: MouseEvent): void => {
      if (!menu.contains(event.target as Node)) closeRootMenu()
    }
    closeOpenRootMenu = () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      menu.remove()
      closeOpenRootMenu = null
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    header.appendChild(menu)
    // Focus the menu itself, not a row: Enter must not pick a root the user
    // never chose, but ArrowDown/Escape have to reach the handler above without
    // a click first.
    menu.tabIndex = -1
    menu.focus()
  }

  /** Teardown for the open "New terminal in:" picker, if any (#1150). */
  let closeOpenRootMenu: (() => void) | null = null

  function closeRootMenu(): void {
    closeOpenRootMenu?.()
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  newButton.addEventListener('click', () => {
    void onNewTerminal(true)
  })

  takeoverButton.addEventListener('click', () => {
    const active = activeId ? tabs.get(activeId) : null
    if (active && active.info.kind === 'agent') {
      active.takeover = !active.takeover
      renderTakeoverToggle()
      if (active.takeover) {
        active.term?.focus()
      }
    }
  })

  tabsEl.addEventListener('fl-tab-select', (event) => {
    const { id } = (event as CustomEvent<TabSelectDetail>).detail
    activateTab(id, { focus: true }) // the user clicked this tab
  })

  tabsEl.addEventListener('fl-tab-close', (event) => {
    const { id } = (event as CustomEvent<TabCloseDetail>).detail
    void api.terminal.dispose({ terminalId: id })
    removeTab(id, { userInitiated: true }) // the tab strip's ✕
  })

  // Double-click rename (#774): a committed name pins the tab's title; an empty
  // commit clears it back to the automatic (cwd/window/creation) title.
  tabsEl.addEventListener('fl-tab-rename', (event) => {
    const { id, label } = (event as CustomEvent<TabRenameDetail>).detail
    const tab = tabs.get(id)
    if (!tab) return
    tab.customTitle = label.length > 0 ? label : undefined
    // Main keeps it too, so the name is saved with the shell and survives a
    // restart (the arrangement in localStorage is keyed by this run's ids).
    renameInMain(id, tab.customTitle ?? null)
    renderTabs()
  })

  api.terminal.onData(({ terminalId, data }) => {
    const tab = tabs.get(terminalId)
    if (tab) {
      writeToTab(tab, data)
      return
    }
    // Scrollback replay can arrive before the terminal:list response builds
    // the tab — hold the bytes (char-bounded) until it exists.
    const buffered = orphanData.get(terminalId)
    if (buffered) {
      buffered.push(data)
    } else {
      const buffer = new PendingBuffer()
      buffer.push(data)
      orphanData.set(terminalId, buffer)
    }
  })

  api.terminal.onCreated((info) => {
    addTab(info)
  })

  // Main disposed a terminal (user close, thread teardown, quit) — drop its tab.
  // Virtual agent terminals never emit terminal:exit, so this is the ONLY signal
  // that removes their ⚙ tabs (#304). Idempotent with the close handler's removeTab.
  api.terminal.onRemoved(({ terminalId }) => {
    removeTab(terminalId)
  })

  api.terminal.onExit(({ terminalId, exitCode }) => {
    const tab = tabs.get(terminalId)
    if (!tab) {
      // An orphan that exited before ever getting a tab — drop its buffer so a
      // never-tabbed id can't linger in orphanData forever (#208).
      orphanData.delete(terminalId)
      return
    }
    tab.exited = true
    writeToTab(tab, terminalExitMarker(exitCode))
    // #1293: the keyboard must not be left inside the corpse. #439 and #957
    // fixed this for the reveal and project-switch arrivals, but both only
    // fire when NO live shell exists — and a split row is precisely the case
    // where one does. Dying in place was the arrival nobody covered: with a
    // live pane beside it, everything typed afterwards vanished, while the
    // focus marker kept pointing at the dead pane.
    if (terminalId === activeId) {
      const survivor = liveSiblingPane(terminalId)
      if (survivor !== null) {
        activateTab(survivor, { focus: true }) // #1293: the keyboard was in the corpse
        return
      }
    }
    renderPanes() // the focus marker must stop claiming a dead pane
    renderTabs()
  })

  // The shell fires this when the terminal pane is toggled into view — open a
  // terminal if the panel is empty (matches VS Code opening the panel).
  document.addEventListener('flow:terminal-shown', () => {
    ensureStarted()
    // Revealing a panel that ALREADY holds a live shell must focus it (VS Code
    // parity) — a fresh spawn focuses via activateTab, but with a live tab
    // present ensureStarted is a no-op and nothing else would move the
    // keyboard into the shell the user just asked for. Modal overlays keep
    // their focus (#683).
    const active = activeId ? tabs.get(activeId) : null
    if (active && !active.exited && isTabVisible(active) && !isModalOverlayOpen()) {
      void attachXterm(active).then(() => {
        fitTab(active)
        active.term?.focus()
      })
    }
  })
  // ⌘/Ctrl+Shift+` — open a NEW terminal, even if one exists. Routed through the
  // same starting-guarded start as the reveal path so a hidden-panel reveal that
  // auto-opened a terminal doesn't also open a second one from this keystroke (#372).
  document.addEventListener('flow:terminal-new', () => startTerminal(true))
  // RUN THIS IN A SHELL — the seam a surface uses when the thing it offers is
  // genuinely a command (a CLI login). It reveals the panel itself, because a
  // command typed into a hidden terminal is a button that did nothing.
  document.addEventListener('flow:terminal-run', (event) => {
    const command = (event as CustomEvent<{ command?: unknown }>).detail?.command
    if (typeof command !== 'string' || command.trim().length === 0) return
    document.dispatchEvent(new CustomEvent('flow:show-terminal'))
    void createTerminal(activeProjectRoot ?? undefined, undefined, {
      focus: true,
      run: command.trim(),
    })
  })

  /**
   * #1388: the app menu's Edit ▸ Select All / Undo / Redo, when a shell holds
   * focus. #1338 routed these to Monaco or to `document.execCommand`, and
   * xterm takes input through a HIDDEN, EMPTY `.xterm-helper-textarea` — so
   * execCommand selected that empty node and ⌘A was a dead key, while the
   * terminal's own right-click Select All selected the whole buffer.
   *
   * Undo/redo have no meaning in a shell buffer (the shell owns its own line
   * editing), so they are deliberately no-ops here rather than pretending.
   */
  document.addEventListener('flow:terminal-edit-action', (event) => {
    const action = (event as CustomEvent<{ action: 'undo' | 'redo' | 'selectAll' }>).detail?.action
    if (action !== 'selectAll') return
    const tab = activeId === null ? null : tabs.get(activeId)
    tab?.term?.selectAll()
  })

  /**
   * Split the focused terminal (#1133): open a new one in the SAME project
   * root and place it beside the current pane. Guarded by the same `starting`
   * flag as the + button, so a double-fire opens one pane, not two.
   */
  /**
   * Open a pane beside `anchorId`.
   *
   * `rootPath` IS THE PANE'S PROJECT, and it is the anchor's only when nobody
   * said otherwise. A split inherited the anchor's project unconditionally,
   * which is the right default and was the only option — so splitting to put a
   * backend beside a frontend gave you the same project twice (user,
   * 2026-09-18).
   */
  function splitFrom(anchorId: string, rootPath?: string): void {
    const anchor = tabs.get(anchorId)
    if (!anchor || !canSplit(layout, anchorId) || starting) return
    starting = true
    void createTerminal(
      rootPath ?? anchor.info.projectRoot ?? activeProjectRoot ?? undefined,
      anchorId,
      {
        focus: true, // a split is always a deliberate ask
      },
    ).finally(() => {
      starting = false
    })
  }
  /**
   * Split the FOCUSED terminal — the header button and the palette command.
   *
   * IT ASKS WHEREVER THE + ASKS, and for the same reason: with more than one
   * project in reach, which one this pane is for is a question only the person
   * can answer. With one project there is nothing to ask, so it splits straight
   * away — exactly what it has always done.
   */
  function splitTerminal(): void {
    if (activeId === null) return
    const anchorId = activeId
    if (!canSplit(layout, anchorId) || starting) return
    const menuItems = newTerminalMenu(scopeState())
    if (menuItems) {
      showRootMenu(menuItems, {
        label: 'Split with:',
        onPick: (rootPath) => splitFrom(anchorId, rootPath),
        returnFocusTo: splitButton,
      })
      return
    }
    splitFrom(anchorId)
  }
  splitButton.addEventListener('click', () => splitTerminal())
  /**
   * #1313: the ⌘P "Split terminal" command must REVEAL the panel first — the
   * lesson #1057 (editor), #1071 (chat), #1202 (git/review) and the palette's
   * own "New terminal" all bought.
   *
   * I wrote the registry entry that claimed otherwise ("the panel is already
   * open whenever there is something to split"), and it is false: ⌃`/⌘J
   * removes the panel from the DOM while every PTY stays alive — exactly the
   * state where you have something to split and no panel. The split then
   * happened OFF SCREEN, ambushing the user on their next ⌃`.
   *
   * With no terminal at all, splitting nothing is meaningless, so it opens one
   * — the command does the nearest sensible thing rather than nothing at all.
   */
  document.addEventListener('flow:terminal-split', () => {
    const hidden = !panel.isConnected
    if (hidden) document.dispatchEvent(new CustomEvent('flow:show-terminal'))
    // After the reveal: the panel mounts (and may auto-start a shell) in this
    // same task, so the split runs once that has settled.
    const run = (): void => {
      if (activeId === null) {
        startTerminal(true) // nothing to split — open one
        return
      }
      splitTerminal()
    }
    if (hidden) setTimeout(run, 0)
    else run()
  })

  // A divider drag changes every pane's width — refit them all, or xterm keeps
  // rendering at the old grid and the PTY never learns.
  splitEl.addEventListener('fl-split-resize', () => {
    rememberSplitSizes(
      [...splitEl.children].map((child) => (child as HTMLElement).dataset['terminalId'] ?? ''),
    )
    fitVisiblePanes()
  })
  // ⌘W / Ctrl+W when the terminal is focused — close the ACTIVE terminal tab
  // (the shell's focus-aware Close-Tab router dispatches this instead of closing
  // an editor tab). No-op when no terminal is active.
  document.addEventListener('flow:close-active-terminal', () => {
    if (!activeId) return
    const terminalId = activeId
    const tab = tabs.get(terminalId)
    if (!tab) return
    // A person's shell: ⌘W closes it exactly as the tab's ✕ does — the PTY
    // goes too, or it runs unreachable and comes back with its conversation
    // after a restart. An agent tab is only taken off the strip: its PTY may
    // be running the agent's command, which a keystroke must not SIGKILL.
    if (closeActiveTerminalAction(tab.info.kind) === 'dispose') {
      void api.terminal.dispose({ terminalId }).catch(console.warn)
    }
    removeTab(terminalId, { userInitiated: true }) // ⌘W
  })

  // Follow the app theme: when <html data-theme> flips, re-theme every OPEN xterm
  // (mirrors Monaco's data-theme observer). xterm can't read CSS vars (#399).
  new MutationObserver(() => {
    const theme = currentXtermTheme()
    for (const tab of tabs.values()) {
      if (tab.term) tab.term.options.theme = theme
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  // Initial load — main replays retained scrollback per terminal as
  // terminal:data events scoped to this window (see registerTerminalChannels).
  void (async () => {
    try {
      const infos = await api.terminal.list()
      for (const info of infos) {
        addTab(info)
      }
      // #1445: addTab gives every terminal its own unnamed group — correct for a
      // brand-new shell, and exactly the collapse a reload used to inflict on a
      // split row. Now that the live set is known, put the arrangement back:
      // saved rows minus terminals that no longer exist, plus any the save
      // didn't know about, and each tab's user-set name.
      if (infos.length > 0) {
        layout = restoreLayout(savedArrangement.layout, new Set(tabs.keys()))
        for (const [terminalId, tab] of tabs) {
          const title = savedArrangement.titles[terminalId]
          if (title !== undefined) tab.customTitle = title
        }
        renderPanes()
        renderTabs()
      }
    } catch (error) {
      console.error('flow: failed to list terminals', error)
    }
    // Auto-start on boot when the panel is already visible and no LIVE shell for
    // the active project exists. Defer to ensureStarted's live-tab check rather than
    // firstVisibleTab() — a reopened-from-dock window replays an exited shell as a
    // visible (but dead) tab, and counting it as present would skip auto-start and
    // strand the user typing into a dead PTY (#446).
    if (panel.isConnected) {
      ensureStarted()
    }
  })()

  // ── Controller (ADR-002 project scoping) ───────────────────────────────

  /** The scope's first LIVE (visible, not exited) tab — what an arrival path
   *  should hand the user, never a dead "(exited)" host (#957). */
  function firstLiveVisibleTab(): TerminalTab | null {
    // THE THREAD'S OWN TREE FIRST. A shell in the project's tree stays visible
    // after a thread's checkout displaces that tree, so "first visible and
    // live" would hand someone a prompt on the project's branch for a thread
    // that has its own — the same conflation of *visible* with *mine* that made
    // reveal start nothing. Displaced shells remain reachable in the strip;
    // they are just not what a switch drops you into.
    const state = scopeState()
    for (const tab of tabs.values()) {
      if (isTabVisible(tab) && !tab.exited && isTerminalMine(identityOf(tab), state)) {
        return tab
      }
    }
    for (const tab of tabs.values()) {
      if (isTabVisible(tab) && !tab.exited) {
        return tab
      }
    }
    return null
  }

  /** Reconcile the active tab with the current visibility domain after a
   *  scope/project rebind. Visibility only — PTYs are never touched.
   *  Liveness-aware (#957): arriving at a scope must never FOCUS a dead
   *  "(exited)" tab while a live sibling exists — the reveal path's contract
   *  (#439), applied to the switch path. Exited tabs stay reachable in the
   *  strip for their scrollback; they're just not what the user is silently
   *  dropped into. */
  function reconcileActiveTab(): void {
    const current = activeId ? tabs.get(activeId) : null
    // "STILL IN SCOPE" IS NOT ENOUGH WHEN THE THREAD HAS ITS OWN TREE. A
    // displaced project shell satisfies visibility and liveness, so this used
    // to keep it active across a switch into a thread with its own checkout —
    // and the person typed on the project's branch. Where nothing is displaced
    // the two tests are identical and this is byte-for-byte the old behaviour.
    if (
      current &&
      isTabVisible(current) &&
      !current.exited &&
      isTerminalMine(identityOf(current), scopeState())
    ) {
      // The active terminal is still in scope and live — its siblings'
      // visibility changed, so just re-render the strip (and the row, whose
      // members may have left the scope).
      renderPanes()
      renderTabs()
      return
    }
    // Prefer the scope's first live tab; fall back to the (visible but exited)
    // current tab, then any visible tab, then the empty state.
    const next =
      firstLiveVisibleTab() ??
      (current && isTabVisible(current) ? current : null) ??
      firstVisibleTab()
    if (next) {
      if (next.info.terminalId !== activeId) {
        activeId = null
        activateTab(next.info.terminalId)
      } else {
        renderTabs()
      }
      return
    }
    activeId = null
    renderPanes()
    renderTabs()
  }

  /**
   * Rebind the terminal panel to a project. Re-renders the tab
   * strip to show only that project's terminals; PTYs for other projects
   * keep running in the main process and reappear (with retained scrollback)
   * when their project is reactivated. Pass null to unscope (show all).
   * Once the thread-scope layer is in charge, this keeps maintaining the
   * legacy binding (the fail-soft fallback + toast rootId), while visibility
   * follows the scope — the scope layer re-derives on project switches too.
   */
  function setActiveProject(rootPath: string | null): void {
    activeProjectRoot = rootPath
    // #1024: settle any UNSCOPED boot-shell tabs before scoping hides them
    // forever (unscoped tabs are only visible while no project is active — a
    // state the UI never returns to). A shell the user typed into is ADOPTED
    // by the activating project (their processes stay reachable); a pristine
    // or exited one is disposed so its PTY never leaks alive-but-unreachable.
    for (const tab of [...tabs.values()]) {
      const action = unscopedTabAction(
        {
          kind: tab.info.kind,
          projectRoot: tab.info.projectRoot,
          interacted: tab.interacted,
          exited: tab.exited,
        },
        rootPath,
      )
      if (action === 'adopt') {
        tab.info.projectRoot = rootPath ?? undefined
        // Its owner is the conversation this activation lands on — known when
        // the editor announces it (applyOwnerScope), or already on screen.
        flagForClaim(tab)
      } else if (action === 'dispose') {
        api.terminal.dispose({ terminalId: tab.info.terminalId }).catch(console.warn)
        removeTab(tab.info.terminalId)
      } else if (
        rootPath !== null &&
        tab.info.kind === 'user' &&
        tab.info.owner === undefined &&
        tab.info.projectRoot === rootPath
      ) {
        // A shell that started in this project before anyone said which
        // conversation was on screen (the boot shell, spawned into the only
        // root): the conversation this activation lands on adopts it, or it
        // would show in every thread of the project.
        flagForClaim(tab)
      }
    }
    reconcileActiveTab()
    // #957 + #1024 (secondary): arriving at a project via a switch must hand
    // the user a LIVE shell — parity with the reveal path's
    // flow:terminal-shown → ensureStarted. Without it the visible panel is
    // left blank (no shells) or focused on a dead "(exited)" tab that
    // silently swallows keystrokes.
    if (panel.isConnected) {
      ensureStarted()
    }
  }

  /** Apply a thread scope from the scope layer (Phase 5): visibility follows
   *  the scope's root set; tabs re-render with accent dots when multi-root. */
  function applyThreadScope(scope: ThreadScope): void {
    scopeRoots = scope.roots
    scopeThreadId = scope.threadId
    // The project view came on screen before any scope had landed: the first
    // one is its settled scope, not a selection in flight.
    const onProjectView = ownerScope !== undefined && ownerScope !== null && ownerScope.threadId === null
    if (onProjectView && projectViewScopeThreadId === undefined) projectViewScopeThreadId = scope.threadId
    // A new scope is a new set of trees to vouch for — re-ask, once each.
    probedRoots.clear()
    reconcileActiveTab()
    probeVisibleRoots()
    // A thread whose own tree has no shell gets one, the moment the scope says
    // which tree that is — otherwise the panel sits on a displaced project
    // shell until something else happens to trigger a reveal. Gated on the
    // panel being on screen, like every other cost here (allowed-pattern #17).
    if (panel.isConnected) ensureStarted()
  }

  // ── Thread scope (multi-project threads Phase 5) ───────────────────────
  // Initial paint from getThreadScope, live updates from threadScopeChanged —
  // the same consumption idiom as the Phase 3 file tree and Phase 4 git panel.
  // When the scope API is unavailable (older preload, failed handler) the
  // guards keep scopeRoots null and the legacy setActiveProject binding keeps
  // working exactly as before (fail-soft).
  if (
    typeof api.project.getThreadScope === 'function' &&
    typeof api.project.onThreadScopeChanged === 'function'
  ) {
    api.project.onThreadScopeChanged((scope) => {
      applyThreadScope(scope)
    })
    void api.project
      .getThreadScope()
      .then((scope) => {
        applyThreadScope(scope)
      })
      .catch(() => {
        // Scope layer unavailable — the active-project fallback stays in charge.
      })
  }

  // An off-screen panel queues nothing; it re-checks its trees on the way in.
  document.addEventListener('flow:terminal-shown', () => {
    probeVisibleRoots()
  })

  // ── Conversation ownership (each thread is its own context) ────────────
  /** Give an unowned shell its conversation — here, and in main, so a
   *  reloaded window and the next restart agree. */
  function claimTab(tab: TerminalTab, owner: TerminalOwner): void {
    tab.info.owner = { rootPath: owner.rootPath, threadId: owner.threadId }
    if (typeof api.terminal.claim !== 'function') return
    void api.terminal
      .claim({ terminalId: tab.info.terminalId, owner: { ...tab.info.owner } })
      .catch((error: unknown) => console.warn('flow: could not record the shell’s conversation', error))
  }

  /**
   * The editor settled on a conversation's tab set — that conversation (or the
   * project view) is the scope on screen, so ITS shells are the ones shown.
   * Visibility only: every other shell keeps running, hidden.
   */
  function applyOwnerScope(next: TabScopeKey | null): void {
    const same =
      ownerScope !== undefined &&
      (next === null
        ? ownerScope === null
        : ownerScope !== null && ownerScope.rootPath === next.rootPath && ownerScope.threadId === next.threadId)
    if (same) {
      // Nothing moved, but a flag may have been raised since this scope came
      // on screen — answer it here, not with whichever conversation is next.
      if (claimFlaggedTabs()) reconcileActiveTab()
      return
    }
    ownerScope = next === null ? null : { rootPath: next.rootPath, threadId: next.threadId }
    // The project view's baseline is the thread the scope layer is on NOW;
    // undefined until a scope lands (applyThreadScope then sets it).
    projectViewScopeThreadId = ownerScope !== null && ownerScope.threadId === null ? scopeThreadId : undefined
    claimFlaggedTabs()
    reconcileActiveTab()
    if (panel.isConnected) ensureStarted()
  }

  /** Flag an unowned shell for adoption — and adopt it at once when the
   *  conversation it belongs to is already on screen (no scope change is
   *  coming to answer the flag). */
  function flagForClaim(tab: TerminalTab): void {
    tab.claimOwner = true
    const owner = claimOwnerFor(tab.info, ownerScope)
    if (owner === null) return
    tab.claimOwner = false
    if (tab.info.owner === undefined) claimTab(tab, owner)
  }

  /** Answer every flag the scope on screen can answer. True if any was. */
  function claimFlaggedTabs(): boolean {
    let claimed = false
    for (const tab of tabs.values()) {
      if (!tab.claimOwner) continue
      const owner = claimOwnerFor(tab.info, ownerScope)
      if (owner === null) continue // another project's flag — its own activation answers it
      tab.claimOwner = false
      if (tab.info.owner === undefined) {
        claimTab(tab, owner)
        claimed = true
      }
    }
    return claimed
  }

  document.addEventListener(TAB_SCOPE_EVENT, (event) => {
    applyOwnerScope((event as CustomEvent<TabScopeKey | null>).detail ?? null)
  })
  // Boot: the conversation main restored as active — so the first paint shows
  // its shells while the editor rebuilds — or, with no project at all, the
  // answer that there is none (the boot shell's cue). A failed read is
  // treated as "no project": a panel that waits forever is worse.
  void api.project
    .active()
    .then((context) => {
      if (ownerScope !== undefined) return
      applyOwnerScope(
        context === null ? null : { rootPath: context.rootPath, threadId: context.activeThreadId },
      )
    })
    .catch((error: unknown) => {
      console.warn('flow: could not read the active project for the terminal panel', error)
      if (ownerScope === undefined) applyOwnerScope(null)
    })

  return { setActiveProject }
}

// ── Styles (light DOM, injected once) ────────────────────────────────────

let stylesInjected = false

function injectPanelStyles(): void {
  if (stylesInjected) {
    return
  }
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-term-root {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: var(--fl-color-surface);
    }
    .fl-term-header {
      position: relative;
      display: flex;
      align-items: center;
      flex: none;
      gap: var(--fl-space-xs);
      padding-right: var(--fl-space-xs);
      /* A region seam — the header's chrome against the terminal body below —
         so it takes the separator token, not the object-edge one. */
      border-bottom: var(--fl-border-width) solid var(--fl-color-separator);
    }
    .fl-term-tabs {
      flex: 1;
      min-width: 0;
      border-bottom: none;
    }
    .fl-term-tool {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
      flex: none;
      height: 22px;
      padding: 0 var(--fl-space-sm);
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .fl-term-tool:hover {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .fl-term-tool.active {
      color: var(--fl-color-accent);
    }
    .fl-term-hosts {
      position: relative;
      flex: 1;
      min-height: 0;
      background: var(--fl-color-surface);
    }
    /* #1133: the visible row fills the panel; its panes are fl-split children,
       so they lay out in flow (flex) rather than stacked absolutely. */
    .fl-term-split {
      position: absolute;
      inset: 0;
    }
    .fl-term-host {
      position: relative;
      height: 100%;
      min-width: 0;
      overflow: hidden;
      padding: 2px 4px;
    }
    /* With two shells side by side, "where do my keystrokes go" needs a visible
       answer — so the focused pane is marked (single-pane rows are unmarked,
       since there is nothing to disambiguate). */
    .fl-term-host.focused {
      box-shadow: inset 0 0 0 1px var(--fl-color-accent);
    }
    .fl-term-tool:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .fl-term-host .xterm {
      height: 100%;
    }
    .fl-term-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-ui-size);
      user-select: none;
    }
    .fl-term-root-menu {
      position: absolute;
      top: calc(var(--fl-tab-height) - 4px);
      right: var(--fl-space-sm);
      z-index: 10;
      display: flex;
      flex-direction: column;
      min-width: 160px;
      padding: var(--fl-space-xs);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      background: var(--fl-color-surface-raised);
    }
    .fl-term-root-menu-label {
      padding: var(--fl-space-xs) var(--fl-space-sm);
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      user-select: none;
    }
    .fl-term-root-item {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      padding: var(--fl-space-xs) var(--fl-space-sm);
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      text-align: left;
      cursor: pointer;
    }
    .fl-term-root-dot {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .fl-term-root-item:hover {
      background: var(--fl-color-accent-muted);
    }
  `
  document.head.appendChild(style)
}
