/**
 * Thread sidebar — threads grouped by project root, riding the virtualized
 * <fl-list> (dense 28px Stark rows).
 *
 * Each project root becomes a group header (folder basename); threads sort
 * newest-first within their group. Thread rows show a chat-bubble glyph tinted
 * by status (status-contract colors: working = accent pulse, needs-decision =
 * warning, blocked = error, done/idle = muted); task rows show a checkbox glyph
 * for their lane. Both carry the title and a relative age.
 *
 * A toolbar above the list holds the search box (threads:search, debounced)
 * and the new-thread button. The list refreshes on threads:updated batches,
 * project:listChanged, and live status stream events.
 */
import { chainCleanup, listenUntilRemoved } from './scoped-listener'
import '../components'
import {
  CREATE_SOURCES,
  SOURCE_PLACEHOLDER,
  submitState,
  type CreateSource,
  type ThreadDraft,
} from './create-modal'
import type { NewThreadPageRequest } from './new-thread-page'
import { whenIdle } from '../when-idle'
import type { FlList, ListItemDetail } from '../components'
import type {
  MessageAttachmentInput,
  ThreadStatus,
  ThreadSummary,
  TaskSummary,
  TaskLane,
  ToolCallStatus,
  RegisteredProject,
  BackgroundTaskInfo,
} from '../../shared/ipc-contract'
import {
  formatElapsed,
  taskElapsedMs,
  taskLabel,
  taskTooltip,
  threadIsLive,
} from './background-task-rows'
import { attachMenuKeyboard } from '../menu-keyboard'
import { openSubagentTask } from './subagent-open'
import {
  capThreadList,
  WORKSPACE_VISIBLE_LIMIT,
  AGENT_TASK_ROW_HEIGHT,
  SIDEBAR_ROW_HEIGHT,
} from './thread-grouping'
import {
  SIDEBAR_ORDERS,
  UNRESOLVED_LIST_KEY,
  archivedToggleLabel,
  archivedToggleTitle,
  carriesViewOptionsForward,
  compareInOrder,
  readViewOptions,
  viewOptionsStorageKey,
  writeViewOptions,
  type SidebarViewOptions,
} from './sidebar-view-options'
import { threadDeleteNotice, type ThreadDeleteSubject } from './thread-sidebar-delete-notice'
import { canOfferWorktree, worktreeActionNotice } from './worktree-outcome'
import { askCarryInline } from './carry-menu-view'
import { prepareThreadWorktree } from './prepare-worktree-flow'
import {
  THREADS_COLLAPSE_KEY,
  parseCollapseMode,
  threadsCollapseView,
  type ThreadsCollapseMode,
} from './threads-collapse'
import { shouldClearSearchOnThreadCreate, shouldClearSearchOnThreadRename } from './search-filter'
import { sidebarRefreshAction, threadEventsAffectSidebar } from './sidebar-refresh-model'
import { sidebarRowMark } from './sidebar-row-selection'
import { isolationMark, type IsolationSubject } from './thread-isolation'
import { projectName, splitRoots } from './multi-project-picker'
import { applyAccentOverrides } from '../project-accent'
import { accentPickerModel } from './accent-picker'
import { emptySidebarMessage } from './thread-search-empty'
import { archivedSectionExpanded, partitionByArchived } from './thread-archived'
import { taskBelongsInSidebar, taskThreadSuppressedFromBareList } from './sidebar-task-rows'
import { canDismissChildRow, planChildRows, visibleAgentTasks } from './sidebar-child-rows'
import { subagentRunState, trackerTaskFor } from './background-activity-model'
import { huntRequest } from '../loops/hunt-config'
import { MAX_HUNT_TEXT_LENGTH } from '../loops/hunt-limits'
import { agentLoopCommand, startHunt } from '../loops/start-hunt'
import {
  availableRoots,
  firstAvailableRoot,
  nextActiveRootAfterRemove,
} from './root-availability-select'
import { workspaceScope, type WorkspaceScopeState } from './workspace-scope'
import {
  emptyWorkspaceMessage,
  rootInScope,
  sameMembership,
  sameScope,
  type WorkspaceScope,
  PROJECT_MENU_EVENT,
} from './workspace-switcher-model'

/** A task plus its 1:1 thread's pin state (a task's pin IS its thread's pin). */
type TaskWithPin = TaskSummary & { pinnedAt: string | null }

const SEARCH_DEBOUNCE_MS = 150

/** The Workspace switcher's ask for one project's actions (detail: `{ rootPath, anchor? }`). */
export { PROJECT_MENU_EVENT }

export type SidebarRow =
  | { kind: 'thread'; thread: ThreadSummary }
  | { kind: 'task'; task: TaskWithPin; thread: ThreadSummary | null }
  /**
   * One piece of background work, nested under the thread that started it.
   *
   * ITS OWN ROW KIND, not a decoration on the parent. A thread can be waiting
   * on four review passes at once, and "4 agents" as a badge answers none of
   * the questions a person actually has — which four, how long has each been at
   * it, is one of them stuck. A list of things gets a list of rows.
   *
   * `reportedAt` is when this renderer took delivery of the task's last
   * progress report, so the elapsed clock can tick between reports without ever
   * differencing the runtime's clock against ours.
   */
  | {
      kind: 'agent-task'
      threadId: string
      task: BackgroundTaskInfo
      reportedAt: Date
      /** True for the last task under a thread, which stops the spine. */
      last: boolean
    }
  /**
   * A promoted sub-agent CHILD thread, nested under its parent (#1931).
   *
   * Unlike `agent-task` (a live, un-persisted background task), this is a real
   * resumable thread the user opened from the Background activity popover — it
   * carries the sub-agent's re-homed transcript and continues as its own
   * conversation. Nested so the relationship to its parent is visible, and kept
   * out of the top-level list so it never reads as a loose conversation.
   */
  | {
      kind: 'child-thread'
      thread: ThreadSummary
      /** True while the child's ORIGIN still runs (`subagentRunState`) — the
       *  row then carries the agent-task spinner instead of the ↳ glyph. */
      originRunning: boolean
      last: boolean
    }
  | { kind: 'more-header'; rootPath: string; count: number; expanded: boolean }
  | { kind: 'archived-header'; count: number; expanded: boolean }

/** A task or a bare thread, unified for recency interleaving in one group.
 *  `id` is the item's THREAD identity (a task carries its 1:1 thread's id) —
 *  what the fold's active exemption (#1042) and the create-reveal (#1010)
 *  compare against `#activeThreadId`. */
/**
 * A row of a project's list, with the three fields any ORDER needs.
 *
 * `title` and `createdAt` ride along because ordering became a per-project
 * choice: sorting by name or by when a thing was made cannot be answered from
 * `updatedAt` alone, and reaching back into the union's two arms at compare
 * time would put the sort rule in two places.
 */
type MergedItem =
  | {
      row: 'task'
      task: TaskWithPin
      updatedAt: string
      createdAt: string
      title: string
      pinnedAt: string | null
      id: string
    }
  | {
      row: 'thread'
      thread: ThreadSummary
      updatedAt: string
      createdAt: string
      title: string
      pinnedAt: string | null
      id: string
    }

/**
 * What a person is told happened when they changed where a thread works.
 *
 * The SENTENCE comes from main — it is the only side that knows which of the
 * two outcomes applied. These are the headings above it, and each one names the
 * outcome rather than the mechanism.
 */
const IMPORTED_PROJECTS_KEY = 'flow.projects.claudeImported'

export interface ThreadSidebarHandlers {
  /**
   * A thread row was activated (click / Enter).
   *
   * AWAITABLE, because one caller needs the selection to have LANDED. A click
   * does not care — the row is already highlighted and nothing follows. A
   * freshly created thread does: the pane will only echo into a thread it is
   * showing, so `#createThread` waits for this before putting the first
   * message on screen. Returning nothing is still a valid implementation.
   */
  onSelect: (thread: ThreadSummary) => void | Promise<void>
  /** The new-thread button created a thread (already persisted). */
  onCreate?: (thread: ThreadSummary) => void
  /**
   * Show the new-thread page and resolve with what was filled in, or null when
   * it was dismissed. Injected because the page lives in the EDITOR area, which
   * this panel does not own — and omitted by callers with no editor at all, in
   * which case a new thread simply cannot be asked about (see #promptNewThread).
   */
  openNewThreadPage?: (request: NewThreadPageRequest) => Promise<ThreadDraft | null>
  /**
   * Start a brand-new thread's FIRST turn.
   *
   * Injected because the pane owns the optimistic echo, and skipping it is what
   * made a fresh thread sit blank for the whole round trip — the message and its
   * loader only appeared when the main process broadcast them back. The composer
   * has never had that lag; it echoes first and sends second. This is the same
   * two steps, for the one turn that has no composer yet.
   *
   * `beforeSend` is the work that must finish before the turn may START but
   * has no business holding up what the person SEES: the thread's own checkout,
   * which takes seconds. It runs between the echo and the send, so the message
   * and its loader are on screen for the whole of it.
   */
  startFirstTurn?: (
    threadId: string,
    content: string,
    attachments: MessageAttachmentInput[],
    beforeSend?: () => Promise<void>,
  ) => Promise<void>
}

export class ThreadSidebar {
  #list: FlList<SidebarRow>
  #searchInput: HTMLInputElement
  #emptyHint: HTMLDivElement
  #handlers: ThreadSidebarHandlers
  #threads: ThreadSummary[] = []
  /** Promoted sub-agent child threads grouped by parent id, for nesting (#1931).
   *  Kept OUT of `#threads` so top-level ordering/counts/lookups are unchanged. */
  #childThreadsByParent = new Map<string, ThreadSummary[]>()
  /**
   * Each child thread's ORIGIN tool-call status, as PERSISTED — the FALLBACK
   * half of the lifecycle merge rule (`subagentRunState`, #1931 follow-up).
   * The LIVE half is `#backgroundTasks` (the tracker), consulted first at fold
   * time; this cache is read only when the tracker has no matching entry.
   * Terminal statuses are final and never re-read; non-terminal ones re-read
   * on the next refresh. Absent (never read / read failed / tracker covered
   * it) reads as finished, which only ever folds a row, never hides a
   * selection (`planChildRows`).
   */
  #childOriginStatus = new Map<string, ToolCallStatus>()
  /**
   * THE one expansion state a thread row's nested rows have (#1931 follow-up:
   * one caret, one level of collapse). Parents in the set show their FINISHED
   * sub-agent children; default collapsed = zero extra rows. LIVE rows — a
   * running promoted child, an unpromoted live agent task — are never in the
   * fold: they are the only trace of running work, so no collapse state hides
   * them (and the selection is force-shown by `planChildRows` regardless).
   * In-memory for the session. This replaced the old `#collapsedAgentThreads`
   * (the second caret, whose fold could put LIVE task rows away).
   */
  #expandedChildThreads = new Set<string>()
  #tasks: TaskSummary[] = []
  #roots: RegisteredProject[] = []
  #activeThreadId: string | null = null
  /**
   * What each thread is still waiting on — its live background work.
   *
   * REPLACED WHOLE on every `background-tasks` event, never merged: the runtime
   * emits its complete live set on each change exactly so a consumer cannot end
   * up with a spinner it has no event left to clear, and keeping a tally here
   * would throw that guarantee away.
   *
   * A thread with nothing running is ABSENT rather than mapped to an empty
   * array, so "is anything running anywhere" is `#backgroundTasks.size > 0` —
   * which is what gates the ticking clock.
   */
  #backgroundTasks = new Map<string, BackgroundTaskInfo[]>()
  /** When this renderer took delivery of each thread's last report — the base
   *  the elapsed clock ticks from between reports. */
  #backgroundTasksAt = new Map<string, Date>()
  /** The 1s tick that moves the elapsed timers; null while nothing is running
   *  or the list is off screen (allowed-pattern #17). */
  #elapsedTimer: number | null = null
  /**
   * #1219: hide state for the list and the chat (persisted).
   *
   * THE STATE IS STILL OWNED HERE; ITS CONTROL IS NOT. The `—` moved to the
   * chat's own top-right, where the thing it hides is — it asks for the change
   * by event and this panel is what remembers. The list's caret is gone
   * outright, along with the list-only state it was the only way into and out
   * of.
   *
   * NOTHING ENTERS THIS MODE ANY MORE. The chat's floating `—` was the only
   * control that asked for it, and it was removed on the user's report. The
   * mode itself stays, and so does the restore hint: the choice is persisted,
   * so a window already put away has to have a way back out. Read-only now —
   * a one-way door, outward.
   */
  #collapseMode: ThreadsCollapseMode = parseCollapseMode(readCollapseMode())
  #listWrap!: HTMLDivElement
  #restoreHint!: HTMLButtonElement
  /** Threads toggled into the ⌘-click multi-select set (#730) — cleared by a
   *  plain click, an archive action, or a refresh that drops the thread. */
  #selectedThreadIds = new Set<string>()
  /** The active project root (its group header is highlighted). */
  #activeRoot: string | null = null
  /**
   * #1344: per-project New-task drafts for the SIDEBAR popover, mirroring the
   * board modal's (#561). Session-scoped like the board's: the point is
   * surviving an accidental close, not a relaunch.
   */
  #newTaskDrafts = new Map<
    string,
    { title: string; description: string; start: string; ref: string }
  >()

  /** Project roots whose thread group is collapsed (persisted). */
  #query = ''
  #searchTimer: number | null = null
  #unsubscribes: Array<() => void> = []
  #disposed = false
  /** A relevant change batch arrived while the sidebar was hidden — one
   *  refresh owed on reveal (#1696). Cleared by refresh() itself: any refresh
   *  makes the list current, so the debt is settled by whichever runs first. */
  #refreshOwedWhileHidden = false
  /** Fires the owed refresh on the hidden→visible transition (#1696).
   *  `offsetParent` is null under any display:none ancestor — both the rail
   *  switch (pane display) and the collapse mode (`#listWrap.hidden`) hide the
   *  list that way, so one observer covers both reveal paths. */
  #revealObserver: IntersectionObserver | null = null
  /** Whether the "Archived" section is expanded. */
  /** Each project's order + archive answer, read once and remembered. */
  readonly #viewOptions = new Map<string, SidebarViewOptions>()
  #archivedExpanded = false
  /** Project roots whose "Show more" section is expanded (session-local). */
  #moreExpanded = new Set<string>()
  /** The single open row-actions menu (light DOM), or null. */
  #openMenu: HTMLElement | null = null
  /** The New Task button — anchors task/connect popovers. */
  #taskAnchor: HTMLElement | null = null
  /** The top "+" new-thread button — its tooltip tracks the project count. */
  #newThreadButton: HTMLElement | null = null
  /**
   * Which Workspace the person is looking at (Workspaces Phase 9). Read from
   * the one shared scope; never re-derived here.
   */
  #scope: WorkspaceScope = { kind: 'none' }
  #scopeState: WorkspaceScopeState | null = null

  constructor(container: HTMLElement, handlers: ThreadSidebarHandlers) {
    this.#handlers = handlers
    injectSidebarStyles()

    container.classList.add('fl-thread-sidebar')

    // ── Toolbar: search + new thread ─────────────────────────────────────
    const toolbar = document.createElement('div')
    toolbar.className = 'fl-thread-toolbar'

    const searchWrap = document.createElement('div')
    searchWrap.className = 'fl-thread-search'
    const searchIcon = document.createElement('fl-icon')
    searchIcon.setAttribute('name', 'search')
    searchIcon.setAttribute('size', '12')
    this.#searchInput = document.createElement('input')
    this.#searchInput.type = 'text'
    this.#searchInput.placeholder = 'Search threads'
    this.#searchInput.setAttribute('aria-label', 'Search threads')
    this.#searchInput.addEventListener('input', () => this.#onSearchInput())
    this.#searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.#searchInput.value) {
        this.#searchInput.value = ''
        this.#onSearchInput()
        return
      }
      // #1172: the box drives its own results, like ⌘P's identical input does.
      // ArrowDown/ArrowUp moved nothing and Enter opened nothing — the only way
      // to act on a search result was the mouse, or three Tabs into a list
      // whose first ArrowDown lands on a project GROUP header rather than a
      // thread. The list itself was always keyboard-first; only the route in
      // was missing.
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        this.#moveSearchCursor(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        this.#openCursorRow()
      }
    })
    searchWrap.appendChild(searchIcon)
    searchWrap.appendChild(this.#searchInput)

    // NOTE: the sidebar's own "Add project" folder button was removed (#128) —
    // adding a project is the titlebar switcher's job ("+ Open Project…"), and a
    // second entry point here was redundant. The folder picker is still reachable
    // from the switcher, the file-tree empty state, and onboarding.

    // The toolbar's second control — a checklist icon that opened "New task" —
    // is gone. `+` now asks the same question (source, title, description,
    // branch, projects) for the thread it creates, so the pair offered two
    // doors into one dialog and only one of them made a thread.
    const newButton = document.createElement('fl-button')
    newButton.setAttribute('variant', 'ghost')
    // Square and the search field's own height: a 22px-tall button whose width
    // came from text padding it never used sat beside a 26px field as a loose
    // glyph, half a control shorter than the thing it pairs with.
    newButton.setAttribute('icon', '')
    // aria-label is STABLE and accurate for every project count ("New thread"
    // is always what happens) — screen readers never hear a promise of a
    // cross-project chooser that isn't shown (#131). The multi-project detail
    // lives only in the tooltip, and only when 2+ projects are open.
    newButton.setAttribute('aria-label', 'New thread')
    newButton.setAttribute('title', 'New thread')
    this.#newThreadButton = newButton
    // Anchor for the popups the task flow still opens from elsewhere (the
    // Kanban board, ⌘P, a project row's menu): the import-error CTA and the
    // provider connect form. `+` sits where the checklist button used to.
    this.#taskAnchor = newButton
    const plusIcon = document.createElement('fl-icon')
    plusIcon.setAttribute('name', 'plus')
    plusIcon.setAttribute('size', '16')
    newButton.appendChild(plusIcon)
    newButton.addEventListener('click', () => {
      void this.#createThread()
    })

    // #1219 used to put two more controls here — a caret that collapsed the
    // list and a `—` that hid the list and the chat. Both are gone from this
    // toolbar: the `—` lives on the chat it hides (`chat-hide-control.ts`),
    // and the caret is retired, because collapsing a list of conversations
    // into nothing from a chevron INSIDE that list left a state whose only
    // exit was the control the user had just made disappear. ⌘B still puts the
    // whole sidebar away.
    // HOW THE LIST IS SHOWN — its order, and whether it shows the archive —
    // for the open Workspace as a whole. It used to sit on each project's
    // header; the one list has no headers, so it sits beside the search.
    const viewButton = document.createElement('fl-button')
    viewButton.setAttribute('variant', 'ghost')
    viewButton.setAttribute('icon', '')
    viewButton.setAttribute('aria-label', 'Sort and filter threads')
    viewButton.setAttribute('title', 'How the list is sorted, and whether it shows the archive')
    viewButton.dataset['part'] = 'list-view'
    const viewGlyph = document.createElement('fl-icon')
    viewGlyph.setAttribute('name', 'filter')
    viewGlyph.setAttribute('size', '14')
    viewButton.appendChild(viewGlyph)
    viewButton.addEventListener('click', () => this.#openProjectViewMenu(this.#listKey(), viewButton))

    toolbar.appendChild(searchWrap)
    toolbar.appendChild(viewButton)
    toolbar.appendChild(newButton)
    container.appendChild(toolbar)

    // ── List ─────────────────────────────────────────────────────────────
    const listWrap = document.createElement('div')
    listWrap.className = 'fl-thread-list'

    this.#list = document.createElement('fl-list') as unknown as FlList<SidebarRow>
    this.#list.rowHeight = SIDEBAR_ROW_HEIGHT
    this.#list.itemHeight = (row) => {
      // A nested background-work row is a footnote about the thread above it,
      // not another conversation — four of them at a thread's full pitch push
      // the next project off the screen.
      if (row.kind === 'agent-task') return AGENT_TASK_ROW_HEIGHT
      return SIDEBAR_ROW_HEIGHT
    }
    this.#list.renderItem = (row) => this.#renderRow(row)
    this.#list.addEventListener('fl-list-activate', (event) => {
      const { item, multiSelect } = (event as CustomEvent<ListItemDetail<SidebarRow>>).detail
      if (item.kind === 'thread') {
        // ⌘/Ctrl-click toggles the row into the multi-select set (#730) instead
        // of opening it; a plain click clears any selection and opens as usual.
        if (multiSelect === true) {
          if (this.#selectedThreadIds.has(item.thread.id)) {
            this.#selectedThreadIds.delete(item.thread.id)
          } else {
            this.#selectedThreadIds.add(item.thread.id)
          }
          // Re-render (not repaint): the click moved fl-list's positional
          // cursor onto the ⌘-clicked row; #renderRows re-derives it back to
          // the OPEN thread so the raised highlight never claims a row the
          // user only selected (#1043).
          this.#renderRows()
          return
        }
        if (this.#selectedThreadIds.size > 0) {
          this.#selectedThreadIds.clear()
        }
        this.#activeThreadId = item.thread.id
        this.#renderRows()
        this.#handlers.onSelect(item.thread)
      } else if (item.kind === 'child-thread') {
        // A promoted sub-agent child is a real thread — open it like any other.
        this.#activeThreadId = item.thread.id
        this.#renderRows()
        this.#handlers.onSelect(item.thread)
      } else if (item.kind === 'archived-header') {
        this.#archivedExpanded = !this.#archivedExpanded
        this.#renderRows()
      } else if (item.kind === 'task') {
        // Opening a task activates its 1:1 thread.
        if (item.thread) {
          this.#activeThreadId = item.thread.id
          this.#renderRows()
          this.#handlers.onSelect(item.thread)
        } else {
          // The task's chat was deleted out from under it (reachable right here:
          // searching flattens task threads into plain rows with a Delete). The
          // row used to be inert — attach a fresh thread and open it (#1061).
          void this.#recoverTaskThread(item.task)
        }
      } else if (item.kind === 'more-header') {
        if (this.#moreExpanded.has(item.rootPath)) this.#moreExpanded.delete(item.rootPath)
        else this.#moreExpanded.add(item.rootPath)
        this.#renderRows()
      }
    })
    listWrap.appendChild(this.#list)

    this.#emptyHint = document.createElement('div')
    this.#emptyHint.className = 'fl-thread-empty'
    this.#emptyHint.textContent = 'No threads yet'
    listWrap.appendChild(this.#emptyHint)

    this.#listWrap = listWrap
    container.appendChild(listWrap)

    // #1219: never a blank panel the user has to guess their way out of — the
    // hidden state says what it is, and clicking it brings everything back.
    this.#restoreHint = document.createElement('button')
    this.#restoreHint.type = 'button'
    this.#restoreHint.className = 'fl-thread-restore'
    this.#restoreHint.hidden = true
    this.#restoreHint.addEventListener('click', () => this.#setCollapseMode('expanded'))
    container.appendChild(this.#restoreHint)
    // Boot: apply the persisted mode, but only speak for the chat when the
    // mode is the one that hides it.
    this.#applyCollapseMode({ announceChat: this.#collapseMode === 'all-hidden' })
  }

  /** Load roots + threads and subscribe to change events. */
  async init(): Promise<void> {
    const api = window.flow
    this.#unsubscribes.push(
      // #1696: a streaming turn broadcasts a 50ms event batch continuously,
      // and every one used to refetch ALL threads plus every root's tasks and
      // rebuild the sidebar — even for pure tool-call batches that change no
      // rendered row, and even while the sidebar was hidden. Same doctrine as
      // #1640 (loops panel) and #1666 (blueprint board): pay only for what
      // someone can see.
      api.threads.onUpdated((events) => {
        this.#onChangeBatch(threadEventsAffectSidebar(events))
      }),
      api.tasks.onUpdated(() => {
        this.#onChangeBatch(true)
      }),
      // The chat's `—` asks; this panel decides and remembers. It is an ASK,
      // not a reach: the control cannot see the persisted mode and must not
      // have to, and the same event works from anywhere else that ever grows
      // one (allowed-pattern #14 — one writer of the mode).
      // A project's actions, asked for from the Workspace switcher's project
      // row. The menu anchors on the element the press came from when it is
      // still on screen, else on this panel's `+`.
      (() => {
        const listener = (event: Event): void => {
          const detail = (event as CustomEvent<{ rootPath?: unknown; anchor?: unknown }>).detail
          if (typeof detail?.rootPath !== 'string') return
          const anchor =
            detail.anchor instanceof HTMLElement && detail.anchor.isConnected ? detail.anchor : this.#newThreadButton
          if (anchor === null) return
          this.#openProjectMenu(detail.rootPath, anchor)
        }
        document.addEventListener(PROJECT_MENU_EVENT, listener)
        return () => document.removeEventListener(PROJECT_MENU_EVENT, listener)
      })(),
      // The Kanban board's "+ New task" opens the task form. The toolbar no
      // longer has a button for it; the form anchors on `+` instead.
      onDocEvent('flow:new-task', () => {
        // #1314: the form is an ANCHORED popup, positioned from a button in
        // the Threads pane's toolbar. The ⌘P palette is global; that anchor is
        // not — with the rail on Files (or the sidebar closed) the button is
        // not rendered, its rect collapses to 0,0, and the form mounted in the
        // title-bar corner UNDER the macOS window controls, where its first
        // field sits behind the traffic lights.
        //
        // Reveal before mounting, exactly as every other navigational command
        // in this palette does (#1057, #1071, #1202, and #1313 which I fixed
        // this morning). The rect is only meaningful once the pane is up, so
        // the mount waits for the reveal to land.
        document.dispatchEvent(
          new CustomEvent('flow:reveal-sidebar', { detail: { rail: 'threads' } }),
        )
        setTimeout(() => {
          if (this.#taskAnchor?.isConnected === true) this.#promptNewTask(this.#taskAnchor)
        }, 0)
      }),
      api.threads.onStream((event) => {
        if (event.kind === 'status') {
          this.#applyStatus(event.threadId, event.status)
        } else if (event.kind === 'background-tasks') {
          this.#applyBackgroundTasks(event.threadId, event.tasks)
        }
      }),
      api.project.onListChanged((roots) => {
        const before = this.#roots.map((root) => root.rootPath).join('\n')
        this.#roots = roots
        // Keep the renderer-wide accent-override registry in sync so every
        // accent surface (tree sections, git groups, terminal tabs, editor
        // tabs) repaints a changed project color live via its CSS var.
        applyAccentOverrides(roots)
        this.#syncNewThreadTooltip()
        // #1414: RE-LIST, don't just re-render. project:remove
        // deliberately prunes the removed project out of every other thread's
        // context roots (#261) — but this only repainted the CACHED
        // ThreadSummary, whose additionalRoots still named the removed folder.
        // So the sidebar kept showing a +badge for a project the store had
        // already revoked, and the context dialog offered to un-check it.
        // …but ONLY WHEN THE SET OF PROJECTS CHANGED. Most list changes are a
        // provisioning state or a stamp on a project already listed; re-listing
        // threads and every project's tasks for each was 81 tasks:list calls in
        // 25 s for five projects (allowed-pattern #17). Those repaint.
        if (roots.map((root) => root.rootPath).join('\n') !== before) void this.refresh()
        else this.#renderRows()
      }),
      api.project.onActiveChanged((context) => {
        this.#activeRoot = context?.rootPath ?? null
        this.#renderRows()
        if (this.#activeRoot) this.#autoImportClaude(this.#activeRoot)
      }),
    )
    // The resume side of the hidden-defer (#1696): the observer intersects on
    // the hidden→visible transition — rail switch back to Threads, sidebar
    // reopen, or collapse-mode expand — and settles the one owed refresh.
    this.#revealObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && this.#refreshOwedWhileHidden) {
        void this.refresh()
      }
    })
    this.#revealObserver.observe(this.#listWrap)
    // THE SCOPE CHANGES WHICH ROWS ARE DRAWN, NOT WHAT IS LOADED: every thread
    // and every root's tasks are already in hand, so a switch of Workspace is a
    // re-render, never a re-read (allowed-pattern #17).
    this.#unsubscribes.push(
      workspaceScope.subscribe((state) => {
        const previous = this.#scopeState
        this.#scopeState = state
        const scopeChanged = !sameScope(this.#scope, state.scope)
        // WHAT THE LIST WAS CALLED A MOMENT AGO, read before the scope moves:
        // an answer given while it was still unresolved belongs to the list it
        // is about to become, or the press is lost (`carriesViewOptionsForward`).
        const previousKey = this.#listKey()
        this.#scope = state.scope
        if (scopeChanged) this.#carryViewOptionsForward(previousKey)
        if (
          scopeChanged ||
          previous === null ||
          !sameMembership(previous.membership, state.membership) ||
          previous.workspaces !== state.workspaces
        ) {
          this.#renderRows()
        }
      }),
    )
    this.#roots = await api.project.list()
    applyAccentOverrides(this.#roots)
    this.#syncNewThreadTooltip()
    const active = await api.project.active().catch(() => null)
    this.#activeRoot = active ? active.rootPath : null
    // WHAT WAS ALREADY RUNNING WHEN THIS PANEL OPENED. The stream carries every
    // change from here on, but the runtime only re-announces a set that has
    // CHANGED — so a sidebar mounted into the middle of a four-agent run would
    // otherwise stay blank until one of them finished, which is the moment the
    // indicator stops being useful. Optional and best-effort: an older preload
    // has no such call, and "nothing running yet" is the right thing to believe
    // until the next event says otherwise.
    const running: Record<string, BackgroundTaskInfo[]> =
      (await api.threads.backgroundTasks?.({}).catch(() => ({}))) ?? {}
    for (const [threadId, tasks] of Object.entries(running)) {
      if (tasks.length === 0) continue
      this.#backgroundTasks.set(threadId, tasks)
      this.#backgroundTasksAt.set(threadId, new Date())
    }
    await this.refresh()
    if (this.#activeRoot) this.#autoImportClaude(this.#activeRoot)
  }

  /**
   * Import a project's Claude Code history the FIRST time it becomes active
   * (once per project, tracked in localStorage). Dedup in main makes any repeat
   * a no-op, so the guard is a convenience — it avoids a rescan on every switch.
   * Silent (no toast) — imported threads simply appear via threads:updated.
   */
  #autoImportClaude(rootPath: string): void {
    const seen = readImportedProjects()
    if (seen.has(rootPath)) return
    seen.add(rootPath)
    writeImportedProjects([...seen])
    // AFTER THE APP HAS SETTLED, NOT DURING THE OPEN IT IS COMPETING WITH.
    // The import parses every Claude Code session for this project — files up
    // to 13 MB apiece — and each parse and insert is a synchronous chunk of the
    // MAIN process, i.e. of every read the sidebar is waiting on. Fired the
    // instant a project became active, it raced the first thread list a person
    // was watching, on exactly the run where nothing is deduped yet: a fresh
    // install. Idle first; a few seconds late costs nobody anything, because
    // imported threads simply appear when they land.
    whenIdle(() => {
      void window.flow.threads
        .importClaude({ rootPath })
        .catch((error: unknown) => console.error('flow: auto-import Claude history failed', error))
    })
  }

  /** Manual "Import Claude history" (⋯ menu): re-scan and report the result. */
  async #importClaudeHistory(rootPath: string): Promise<void> {
    try {
      const { imported, skipped } = await window.flow.threads.importClaude({ rootPath })
      const seen = readImportedProjects() // mark seen so auto-import won't rescan
      seen.add(rootPath)
      writeImportedProjects([...seen])
      const body =
        imported > 0
          ? `Imported ${imported} conversation${imported === 1 ? '' : 's'} from Claude Code.`
          : skipped > 0
            ? 'No new conversations — everything is already imported.'
            : 'No Claude Code history found for this project.'
      this.#notify(rootPath, 'Claude Code import', body)
    } catch (error) {
      console.error('flow: import Claude history failed', error)
      this.#notify(rootPath, 'Claude Code import failed', 'Could not read Claude Code history.', 'error')
    }
  }

  /** Surface a toast via the shared notification center (flow:notify bridge). */
  #notify(rootId: string, title: string, body: string, level: 'info' | 'error' = 'info'): void {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId,
          title,
          body,
          timestamp: new Date().toISOString(),
          level,
        },
      }),
    )
  }

  /** Make a project active (rebinds project surfaces) via the main process. */
  #activateProject(rootPath: string): void {
    if (rootPath === this.#activeRoot) return
    void window.flow.project
      .setActive({ rootPath })
      .catch((error: unknown) => console.error('flow: failed to switch project', error))
  }

  /** Route a change batch per visibility (#1696): an irrelevant batch is
   *  dropped by the caller; a relevant one refreshes now when the list is on
   *  screen, or marks one refresh owed on reveal when it is not. */
  #onChangeBatch(affectsSidebar: boolean): void {
    const action = sidebarRefreshAction({
      affectsSidebar,
      visible: this.#listWrap.offsetParent !== null,
    })
    if (action === 'refresh') void this.refresh()
    else if (action === 'defer') this.#refreshOwedWhileHidden = true
  }

  /** Re-fetch the thread list (or the current search) and re-render. */
  async refresh(): Promise<void> {
    if (this.#disposed) {
      return
    }
    // Any refresh settles a change deferred while hidden (#1696) — the debt is
    // paid by whichever refresh runs first, never twice.
    this.#refreshOwedWhileHidden = false
    try {
      const api = window.flow
      if (this.#query) {
        // Search is a flat view — no task layer, no nesting; children (if any
        // match) show as plain rows, which is what a search result is.
        this.#threads = await api.threads.search({ query: this.#query })
        this.#childThreadsByParent = new Map()
      } else {
        // #1931: pull children too, then split — top-level threads keep their
        // own list (unchanged ordering/counts), promoted sub-agent children go
        // into a by-parent map the renderer nests under their parent row.
        const all = await api.threads.list({ includeArchived: true, includeChildren: true })
        const topLevel: ThreadSummary[] = []
        const byParent = new Map<string, ThreadSummary[]>()
        for (const thread of all) {
          const parentId = thread.parentThreadId ?? null
          if (parentId === null || parentId === undefined) {
            topLevel.push(thread)
          } else {
            // A DISMISSED child (the hover ✕ archives it, #1931 follow-up) is
            // gone from the nest entirely — not folded. It stays reachable
            // through the Background activity popover, whose open un-archives
            // it (openSubagentThread), as does any redirected row (I2).
            if (thread.archivedAt !== null) continue
            const list = byParent.get(parentId)
            if (list) list.push(thread)
            else byParent.set(parentId, [thread])
          }
        }
        this.#threads = topLevel
        this.#childThreadsByParent = byParent
        // Refresh the FALLBACK half of each child's lifecycle (the persisted
        // origin status) — the tracker half is `#backgroundTasks`, already in
        // hand. Reads only what the tracker doesn't cover and the cache hasn't
        // settled (allowed-pattern #19); a failed read leaves the child
        // counted as finished, which folds it but never hides a selection.
        for (const cachedId of [...this.#childOriginStatus.keys()]) {
          // Drop entries for children that no longer exist (deleted threads).
          if (![...byParent.values()].some((list) => list.some((child) => child.id === cachedId))) {
            this.#childOriginStatus.delete(cachedId)
          }
        }
        await this.#readChildOriginStatuses(byParent)
      }
      // Tasks are per-project — fetch across every known root and flatten.
      const taskLists = await Promise.all(
        this.#roots.map((root) =>
          // #1391: INCLUDE archived tasks. Archiving one hid it from every
        // surface in the app — the board filters to lanes, the sidebar asked
        // for active only, and nothing anywhere listed archived tasks. A
        // reversible-sounding verb with no way back is a trapdoor. They now
        // land in the same "Archived" section threads already use.
        api.tasks.list({ projectRoot: root.rootPath, includeArchived: true }).catch(() => []),
        ),
      )
      this.#tasks = taskLists.flat()
    } catch (error) {
      console.error('flow: failed to load threads/tasks', error)
      return
    }
    this.#renderRows()
  }

  /**
   * Refresh `#childOriginStatus` — the FALLBACK half of the lifecycle merge
   * rule — with `toolCalls:get` point reads (never a whole-thread list,
   * allowed-pattern #19), SKIPPING what needs no read:
   *
   *   - the TRACKER currently covers the spawn (`trackerTaskFor`): the fold
   *     reads the tracker directly, so the record is moot until the task ends;
   *   - the cache already holds a TERMINAL status: a settled tool call never
   *     runs again, so that answer is final.
   *
   * Steady state therefore reads NOTHING per refresh. A missing getter (older
   * preload), a missing link or a failed read leave the cache untouched —
   * absent reads as finished, which only ever folds a row, never hides the
   * active thread (`planChildRows`).
   */
  async #readChildOriginStatuses(byParent: ReadonlyMap<string, ThreadSummary[]>): Promise<void> {
    const getter = window.flow.toolCalls.get
    if (getter === undefined) return
    const reads: Array<Promise<void>> = []
    for (const [parentId, children] of byParent) {
      const trackerTasks = this.#backgroundTasks.get(parentId) ?? []
      for (const child of children) {
        const originId = child.originToolCallId
        if (originId === null || originId === undefined) continue
        if (trackerTaskFor(originId, trackerTasks) !== undefined) continue
        const cached = this.#childOriginStatus.get(child.id)
        if (cached !== undefined && cached !== 'pending' && cached !== 'running') continue
        reads.push(
          getter({ threadId: parentId, toolCallId: originId })
            .then((record) => {
              if (record !== null) this.#childOriginStatus.set(child.id, record.status)
            })
            .catch((error: unknown) => {
              // A failed read changes nothing it cannot see: the child folds.
              console.warn('flow: child origin status read failed', error)
            }),
        )
      }
    }
    await Promise.all(reads)
  }

  /** Create a new thread (opening a project first if none is open). Public so
   *  the conversation empty-state CTA can trigger the same flow as the +
   *  toolbar button. */
  createThread(options?: { prompt?: string }): Promise<void> {
    return this.#createThread(undefined, options?.prompt === undefined ? undefined : { prompt: options.prompt })
  }

  /** Highlight the given thread as selected (no onSelect emitted). */
  setActiveThread(threadId: string | null): void {
    this.#activeThreadId = threadId
    // Full re-render, not a repaint: the row set depends on the active thread
    // (the fold's active exemption, #1042) and the raised cursor is re-derived
    // from identity inside #renderRows (#1043) — a plain refresh would keep a
    // stale slice and a stale positional highlight.
    this.#renderRows()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#elapsedTimer !== null) {
      window.clearInterval(this.#elapsedTimer)
      this.#elapsedTimer = null
    }
    this.#closeMenu()
    this.#revealObserver?.disconnect()
    this.#revealObserver = null
    if (this.#searchTimer !== null) {
      window.clearTimeout(this.#searchTimer)
    }
    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe()
    }
    this.#unsubscribes = []
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Move the list cursor over THREAD rows only (#1172). Group headers are rows
   * too, so a naive cursor step lands on "the project", whose Enter re-activates
   * the already-active project — visibly nothing. Wraps, and starts at the
   * first/last thread when nothing is selected yet.
   */
  #moveSearchCursor(delta: 1 | -1): void {
    const rows = this.#list.items
    const threadIndexes = rows
      .map((row, index) => (row.kind === 'thread' ? index : -1))
      .filter((index) => index >= 0)
    if (threadIndexes.length === 0) return
    const current = threadIndexes.indexOf(this.#list.selectedIndex)
    const next =
      current < 0
        ? delta > 0
          ? 0
          : threadIndexes.length - 1
        : (current + delta + threadIndexes.length) % threadIndexes.length
    this.#list.selectedIndex = threadIndexes[next]
  }

  /**
   * Open the row under the cursor (#1172). With exactly one matching thread and
   * no cursor yet, Enter opens that one — the case the search box exists for.
   */
  #openCursorRow(): void {
    const rows = this.#list.items
    const threadIndexes = rows
      .map((row, index) => (row.kind === 'thread' ? index : -1))
      .filter((index) => index >= 0)
    let index = this.#list.selectedIndex
    if (!(index >= 0 && rows[index]?.kind === 'thread')) {
      if (threadIndexes.length !== 1) return
      index = threadIndexes[0]
      this.#list.selectedIndex = index
    }
    const row = rows[index]
    if (row?.kind !== 'thread') return
    // Go through the list's OWN activate event rather than opening directly, so
    // the keyboard route inherits every behaviour the click route has (#730's
    // multi-select clearing, #1043's cursor re-derivation, …) instead of
    // growing a second, drifting copy of it.
    this.#list.dispatchEvent(
      new CustomEvent('fl-list-activate', {
        detail: { item: row, index, multiSelect: false },
        bubbles: true,
        composed: true,
      }),
    )
  }

  #onSearchInput(): void {
    // #1325: SEARCH WINS OVER COLLAPSE. #1219 (mine) gave the panel two
    // put-away modes, but only the LIST is hidden — the toolbar above it,
    // search box included, stays visible and typeable. Typing then changed
    // nothing on screen at all: matches rendered into the hidden list, and
    // the one piece of feedback search has ("No threads match …") lives inside
    // the same hidden wrapper.
    //
    // #1010 settled this at the per-project level — a collapsed group must not
    // hide its threads from search. A panel-level collapse inherited none of
    // it. A query now re-opens the list; clearing the query does NOT re-close
    // it, because putting the panel away is a deliberate act and only the user
    // should undo it.
    if (this.#searchInput.value.trim() !== '' && this.#collapseMode !== 'expanded') {
      this.#setCollapseMode('expanded')
    }
    if (this.#searchTimer !== null) {
      window.clearTimeout(this.#searchTimer)
    }
    this.#searchTimer = window.setTimeout(() => {
      this.#searchTimer = null
      this.#query = this.#searchInput.value.trim()
      void this.refresh()
    }, SEARCH_DEBOUNCE_MS)
  }

  async #createThread(
    fixedRoot?: string,
    opts?: { bypassPermissions?: boolean; draft?: ThreadDraft; prompt?: string },
  ): Promise<void> {
    // IN A WORKSPACE, THE NEW THREAD STARTS IN ONE OF ITS PROJECTS — the one
    // last used there by default — and the page offers only the Workspace's
    // projects. Its first message then attaches whichever others it needs.
    let projectRoot = fixedRoot ?? workspaceScope.newThreadProject() ?? this.#pickProjectRoot()
    let additionalRoots: string[] = []
    // A REPLAY, not a re-ask. An import that failed for a missing token is
    // retried with exactly what was typed — reopening a blank dialog would
    // make the person write the whole thing again to press the same button.
    let draft: ThreadDraft | null = opts?.draft ?? null

    // ONE DIALOG, ASKED ONCE. This used to create immediately and — at 2+ open
    // projects — open a separate chooser first (#45). The Create-thread dialog
    // carries the projects along with everything else, so the second overlay is
    // gone rather than moved.
    //
    // A per-project "+" still passes `fixedRoot` and skips the dialog entirely:
    // that press has already said which project and asks for nothing else.
    if (!fixedRoot && draft === null) {
      draft = await this.#promptNewThread(projectRoot, opts?.prompt)
      if (draft === null) return // cancelled — nothing was created
    }
    // `splitRoots` — deduped, and it keeps the project this was opened from as
    // primary when that one is ticked. A checklist has no meaningful order, so
    // "whichever box is first" would be the wrong rule.
    if (draft !== null) {
      const split = splitRoots(draft.roots, projectRoot)
      projectRoot = split.primary ?? projectRoot
      additionalRoots = split.additional
    }

    if (!projectRoot) {
      // No project yet — a thread must belong to a root, so open one first.
      try {
        const root = await window.flow.project.open()
        if (!root) {
          return // user cancelled the folder picker
        }
        projectRoot = root.rootPath
      } catch (error) {
        console.error('flow: failed to open project for new thread', error)
        return
      }
    }
    try {
      // WHAT GETS MADE IS ONE DECISION WITH THREE ANSWERS, and all three end
      // holding the same thing: a thread id. A task is not a second object
      // beside the thread — it owns one 1:1 — so the board checkbox and the
      // imported sources pick a different CHANNEL, never a different outcome.
      //
      //   nothing ticked, from scratch → threads.create      (a bare thread)
      //   ticked, from scratch         → tasks.create        (a card + its chat)
      //   Jira / GitHub / Azure        → tasks.importIssue   (the issue, as a card)
      //
      // The import branch is why the three tabs are no longer decorative: the
      // reference they collect had nowhere to go, so picking Jira and pasting a
      // key made a blank untitled thread and silently dropped the issue.
      const threadId = await this.#createThreadVia(draft, projectRoot, additionalRoots)
      if (threadId === null) return
      workspaceScope.rememberProject(projectRoot)
      // OPEN IT NOW. Everything below this point is setup, and setup used to run
      // FIRST: the skip-permissions write, then `prepareWorktree`, which cuts a
      // git checkout and takes seconds. For all of it the person had a row in
      // the list that was not selected and an empty column beside it — Create
      // pressed, nothing to look at, no way to tell it was working (reported
      // 2026-09-17: "we are not selecting the new thread automatic and we are
      // not showing the loader").
      //
      // Selecting is not a reward for finishing the setup; it is the answer to
      // the press. It needs nothing but the id, so it happens on the id.
      this.#activeThreadId = threadId
      await this.#revealCreated(threadId)
      const created = await window.flow.threads.get({ threadId }).catch(() => null)
      if (created !== null) {
        this.#handlers.onCreate?.(created)
        // AWAITED, unlike a row click. The pane refuses to echo into a thread it
        // is not showing yet, so the first message below would render nowhere if
        // this were left in flight.
        //
        // …but never FATAL. A selection that throws used to be an unhandled
        // rejection beside a create that carried on; awaiting it would route the
        // throw into the catch below and silently drop the person's first
        // message instead. The thread is still theirs, and the message is still
        // sent — it just lands without the echo.
        await Promise.resolve(this.#handlers.onSelect(created)).catch((error: unknown) =>
          console.error('flow: failed to open the thread just created', error),
        )
      }

      // What must still finish before the first turn may START — and what has no
      // business holding up what the person sees.
      const settle = async (): Promise<void> => {
        // Skip-permissions opt-in (#751), mirroring the tasks modal: applied
        // BEFORE any turn — the agent session reads it at creation.
        if (opts?.bypassPermissions) {
          await window.flow.threads
            .update({ threadId, patch: { bypassPermissions: true } })
            .catch((e: unknown) => console.error('flow: failed to set bypassPermissions', e))
        }
        // THE BRANCH, BEFORE THE FIRST TURN. `prepareWorktree` cuts the checkout
        // and names it; asking for neither keeps the old path exactly — the
        // thread works in the project's own files.
        //
        // TWO FIELDS, TWO QUESTIONS, AND `start` IS THE ONE THAT DECIDES. The
        // chip on the new-thread page answers both: `branch` is what the new
        // branch is CALLED and `start` is where it BEGINS — and a thread that
        // takes an existing branch outright has a start and no name, because the
        // branch it takes already has one. So the presence of EITHER means "this
        // thread wants a branch of its own"; the absence of both is the chip's
        // "in the project" rung, which asks for nothing at all.
        //
        // Fail-soft on purpose: the name was already checked against this project
        // (`branchAvailable`) before anything was created, so a failure here is a
        // race, and a thread that exists is worth more than a name that does not.
        if (
          draft !== null &&
          (draft.branch !== '' || draft.start !== undefined || draft.worktreeName !== undefined)
        ) {
          await window.flow.threads
            .prepareWorktree({
              threadId,
              // Unchanged from before this chip existed: the create path has
              // never put the carry question on screen, and this phase moves that
              // question rather than adding it to a second moment.
              carry: 'clean',
              ...(draft.branch === '' ? {} : { branch: draft.branch }),
              ...(draft.start === undefined ? {} : { start: draft.start }),
              // THE FOLDER'S NAME, beside the branch's. Without it main has
              // nothing to call the directory and falls back to the thread's id
              // — which is the uuid people were reading in their shell prompt
              // while the chip above them showed a name they had typed.
              ...(draft.worktreeName === undefined ? {} : { worktreeName: draft.worktreeName }),
            })
            .catch((error: unknown) =>
              console.error('flow: could not take the chosen branch', error),
            )
        }
      }

      // THE DESCRIPTION IS THE FIRST MESSAGE. Sending it starts the turn, which
      // is what a person filling that box asked for. A blank one opens the
      // thread idle and sends nothing — no tokens, no worktree.
      //
      // Through `#startTask`, the SAME path the task modal's "Start with" field
      // uses (allowed-pattern #14). An earlier draft of this dispatched a
      // `flow:send-message` event; no such event exists, and nothing would have
      // listened — the description would have vanished silently.
      //
      // `settle` is handed ACROSS, not run before: the message is echoed and its
      // loader started first, and the checkout is cut underneath a screen that
      // already shows what is happening. The send still waits for it, so a turn
      // never begins in the project's own files when a branch was asked for.
      if (draft !== null && (draft.description !== '' || draft.attachments.length > 0)) {
        const first = this.#handlers.startFirstTurn
        if (first) {
          await first(threadId, draft.description, draft.attachments, settle)
        } else {
          await settle()
          await this.#startTask(threadId, draft.description, draft.attachments)
        }
      } else {
        await settle()
      }
      // AND THEN THE LOOP, if one was asked for. Last, and never in the way of
      // the thread: the conversation is what the person came for and it is
      // already open — a hunt that cannot start is reported, not raised into a
      // create that has already succeeded.
      if (draft?.hunt !== undefined) await this.#startDraftHunt(projectRoot, draft)
    } catch (error) {
      console.error('flow: failed to create thread', error)
    }
  }

  /**
   * Start the hunt a New-thread page asked for.
   *
   * THE THREAD'S SUBJECT IS THE HUNT'S SENTENCE — its title when it has one,
   * otherwise the description that became its first message. That is the whole
   * point of putting the switch on the create form: "keep looking for more like
   * this" has a `this` because the work beside it says what it is, and nobody
   * types the sentence twice.
   */
  async #startDraftHunt(projectRoot: string, draft: ThreadDraft): Promise<void> {
    const hunt = draft.hunt
    if (hunt === undefined) return
    const request = huntRequest(hunt.config)
    if (request === null || hunt.loop === null) return
    const aim = (draft.title.trim() || draft.description.trim()).slice(0, MAX_HUNT_TEXT_LENGTH)
    if (aim.length === 0) return
    const outcome = await startHunt({
      rootPath: projectRoot,
      loop: hunt.loop,
      write: { loop: hunt.loop, focus: aim, ...request },
      message: agentLoopCommand(hunt.loop, aim),
      aim,
      threadTitle: aim,
      knownThreads: this.#threads,
    })
    if (!outcome.ok) console.error('flow: could not start the thread\u2019s loop —', outcome.reason)
  }

  /**
   * Make the thread the dialog described, by whichever channel it named, and
   * resolve with its id.
   *
   * Null means "nothing was made and the person has been told why" — the only
   * case is an import whose reference the provider would not resolve, which is
   * reported through the same `#importIssue` error path the task modal uses
   * (connect form when a token is missing, a toast otherwise) rather than
   * being swallowed into a thread with no issue in it.
   */
  async #createThreadVia(
    draft: ThreadDraft | null,
    projectRoot: string,
    additionalRoots: string[],
  ): Promise<string | null> {
    if (draft !== null && draft.source !== 'manual') {
      const task = await window.flow.tasks
        .importIssue({ projectRoot, keyOrUrl: draft.reference, additionalRoots })
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          const replay = (): void => void this.#createThread(undefined, { draft })
          const provider = draft.source as 'jira' | 'github' | 'azure'
          // Exactly the task modal's two outcomes: a missing token opens the
          // connect form and retries on its own, anything else is reported.
          if (/token|check your token|permission/i.test(message)) {
            this.#promptConnectForm(provider, replay)
          } else {
            await this.#showImportError(projectRoot, provider, message, replay)
          }
          return null
        })
      return task === null ? null : this.#threadOf(task.task)
    }
    if (draft !== null && draft.asTask) {
      // The board's own channel, so the card is written by the one code path
      // that writes cards (allowed-pattern #14) — it creates the 1:1 thread as
      // part of creating the card, which is why nothing is created twice here.
      const task = await window.flow.tasks.create({
        projectRoot,
        title: draft.title,
        ...(draft.description !== '' ? { description: draft.description } : {}),
        additionalRoots,
      })
      return this.#threadOf(task)
    }
    const thread = await window.flow.threads.create({
      projectRoot,
      additionalRoots,
      // A TITLE THE PERSON WROTE, not one generated from their first message.
      // Absent when they left it blank, which is every caller before this.
      ...(draft !== null && draft.title !== '' ? { title: draft.title } : {}),
      // The runtime settings chosen on the new-thread page, OMITTED when blank
      // so a thread created any other way still takes its own defaults — an
      // empty string here would be a choice nobody made.
      ...(draft !== null && draft.model !== '' ? { model: draft.model } : {}),
      ...(draft !== null && draft.effort !== '' ? { effort: draft.effort } : {}),
    })
    return thread.id
  }

  /** A card's chat, guaranteed. A fresh task always has one, so this is the
   *  same idempotent no-op every other "open this task's chat" path makes
   *  (#1061) — it exists so a null here can never become a silent nothing. */
  async #threadOf(task: TaskSummary): Promise<string | null> {
    if (task.threadId !== null) return task.threadId
    const ensured = await window.flow.tasks.ensureThread({ taskId: task.id }).catch(() => null)
    return ensured?.threadId ?? null
  }

  /**
   * The ONE "reveal what I just created" step, shared by every create channel
   * (thread button, task form, issue import — so the next channel can't miss
   * the contract, the way the task path missed #386's for years, #1121):
   *  - a fresh thread/task can't match a stale query, so an active search
   *    filter is cleared before the re-render (#386);
   *  - the created thread is force-revealed inside a collapsed project group
   *    until the next caret toggle (#1010).
   * Refreshes explicitly so the broadcast-driven re-render can't race a stale
   * query; awaitable for callers that sequence work after the reveal.
   */
  /**
   * #1322: force a thread's row visible even inside a COLLAPSED project group.
   *
   * Three channels bind the composer to a thread the user did not click, and
   * two of them already guarantee the bound thread has a visible row. Switching
   * the active project did not: it silently opens the destination project's
   * last-active thread, and when that project's group is collapsed the thread
   * has NO row anywhere — a live composer bound to a conversation the user
   * cannot identify, where anything they type lands invisibly.
   *
   * Same mechanism CREATE uses (#1010): the row renders under the collapsed
   * header until the next deliberate caret toggle.
   */
  revealThread(threadId: string | null): Promise<void> {
    return this.#revealCreated(threadId)
  }

  #revealCreated(threadId: string | null): Promise<void> {
    if (threadId !== null) {
      // #1324: REVEAL THE CHAT. The sidebar's own "+ New thread" never joined
      // the funnel #1071 built — it called #createThread directly, while the
      // palette's identical verb goes through flow:new-thread, which reveals
      // first. So ⌘⌥C-hide the chat, click +, and the thread was created with
      // zero pixels changing: a silent create into a panel you can't see.
      //
      // Doing it HERE covers every create channel at once, which is the point
      // of having a single "reveal what I just created" step.
      document.dispatchEvent(new CustomEvent('flow:show-chat'))
      // #1219 (mine): a thread list put away can't show what was just created
      // either. Restore it for the same reason.
      if (this.#collapseMode !== 'expanded') this.#setCollapseMode('expanded')
    }
    if (shouldClearSearchOnThreadCreate(this.#query)) {
      this.#clearSearch()
    }
    return this.refresh()
  }

  /** Reset the thread-search filter (query + input + any pending debounce), so a
   *  stale query can't hide freshly-surfaced threads (#386). */
  #clearSearch(): void {
    if (this.#searchTimer !== null) {
      window.clearTimeout(this.#searchTimer)
      this.#searchTimer = null
    }
    this.#query = ''
    this.#searchInput.value = ''
  }

  /**
   * Ask for a new thread's shape, on the NEW-THREAD PAGE.
   *
   * This used to build a 250-line modal here — tabs, six labelled fields, a
   * checklist of projects, a backdrop and its own keydown trap. It is a page in
   * the editor area now (`new-thread-page.ts`), which is the same shape as the
   * thing it produces and does not dim the work behind it.
   *
   * THE CONTRACT DID NOT MOVE. It still returns a draft or null, resolved once,
   * so `#createThread` reads exactly as it did — and the RULES were already in
   * `create-modal.ts` rather than in the markup, which is the reason swapping
   * the surface cost nothing (allowed-pattern #14).
   *
   * Without an editor to put a page in, there is nothing to ask WITH, so this
   * declines rather than inventing a second dialog to fall back to: two ways to
   * ask one question is the drift that module exists to prevent.
   */
  #promptNewThread(defaultPrimary: string | null, prompt?: string): Promise<ThreadDraft | null> {
    const open = this.#handlers.openNewThreadPage
    if (!open) return Promise.resolve(null)
    // A Workspace offers its own projects.
    const roots = this.#roots.filter((root) => this.#inScope(root.rootPath))
    return open({
      roots: roots.length > 0 ? roots : this.#roots,
      primary: defaultPrimary,
      ...(prompt === undefined ? {} : { prompt }),
    })
  }

  /** Root for a new thread: active thread's root, else the first root. */
  /** The top "+" only shows the multi-project chooser at 2+ open projects, so
   *  its tooltip mentions "choose one or more projects" only then (#131). The
   *  aria-label stays the stable, always-accurate "New thread". */
  #syncNewThreadTooltip(): void {
    if (!this.#newThreadButton) return
    const multi = this.#roots.length >= 2
    this.#newThreadButton.setAttribute(
      'title',
      multi ? 'New thread — choose one or more projects' : 'New thread',
    )
  }

  #pickProjectRoot(): string | null {
    if (this.#activeThreadId) {
      const active = this.#threads.find((thread) => thread.id === this.#activeThreadId)
      if (active) {
        return active.projectRoot
      }
    }
    // Skip unavailable (unmounted) roots — creating on a nonexistent path errors (#350).
    return firstAvailableRoot(this.#roots)
  }

  /**
   * Take delivery of a thread's live background work.
   *
   * A FULL RE-RENDER, not a repaint: these rows are IN the list, so their
   * arrival and departure changes the row SET and every index below them —
   * `#list.refresh()` would redraw the old rows in their old places.
   *
   * The set replaces whatever was there. An empty one means the thread is
   * finally done waiting, and the thread leaves the map entirely so that "is
   * anything running anywhere" stays a size check.
   */
  #applyBackgroundTasks(threadId: string, tasks: BackgroundTaskInfo[]): void {
    if (tasks.length === 0) {
      const had = this.#backgroundTasks.delete(threadId)
      this.#backgroundTasksAt.delete(threadId)
      if (had) this.#renderRows()
    } else {
      this.#backgroundTasks.set(threadId, tasks)
      this.#backgroundTasksAt.set(threadId, new Date())
      this.#renderRows()
    }
    this.#syncElapsedTimer()
    // #1931 follow-up: the tracker set changed under a thread with promoted
    // children — the fold reads the tracker FIRST (`subagentRunState`), so the
    // render above already re-folded a child whose task just ended. What it
    // cannot do is refresh the FALLBACK: a task's end usually lands with its
    // tool call settling, and the sidebar's refresh policy deliberately skips
    // tool_call-only batches. One targeted point-read pass for this parent's
    // children keeps the cache honest NOW, not on the next thread-list batch.
    const children = this.#childThreadsByParent.get(threadId)
    if (children !== undefined && children.length > 0) {
      void this.#readChildOriginStatuses(new Map([[threadId, children]])).then(() =>
        this.#renderRows(),
      )
    }
  }

  /**
   * Run the elapsed clock only while there is something to count and someone to
   * see it (allowed-pattern #17).
   *
   * One second, because the reference reads in seconds and a timer that ticks
   * faster than its own unit is spending frames to redraw the same string.
   */
  #syncElapsedTimer(): void {
    const wanted = this.#backgroundTasks.size > 0 && this.#listWrap.offsetParent !== null
    if (wanted === (this.#elapsedTimer !== null)) return
    if (!wanted) {
      if (this.#elapsedTimer !== null) window.clearInterval(this.#elapsedTimer)
      this.#elapsedTimer = null
      return
    }
    this.#elapsedTimer = window.setInterval(() => this.#tickElapsed(), 1000)
  }

  /**
   * The status a ROW should draw for a thread — its TURN status.
   *
   * It used to promote a resting thread to `working` while anything it
   * started still ran. With mid-run subtasks (plan_mid-run-subtasks FR-17)
   * the turn ends with its answer while subtasks keep going: the answer is
   * there, so the thread reads done, and the work still out is said by its
   * own mark — `#backgroundRunning` and the row's "N running" tag. A thread
   * waiting on a person or one whose turn failed keeps its own mark, as before.
   *
   * `threadIsLive` still answers "is anything live here" for the surfaces that
   * need that (the Kanban card's working dot); only the row's glyph changed.
   */
  #liveStatus(thread: ThreadSummary): ThreadStatus {
    return thread.status
  }

  /**
   * How many background tasks of this thread still run while its turn is NOT
   * working — the count the row's tag draws. Zero while the turn works (the
   * working glyph already says it) and when nothing runs.
   */
  #backgroundRunning(thread: ThreadSummary): number {
    const running = this.#backgroundTasks.get(thread.id)?.length ?? 0
    if (!threadIsLive(thread.status, running) || thread.status === 'working') return 0
    return running
  }

  /** The small `2 running` tag, or null when nothing runs past the turn. */
  #runningTag(thread: ThreadSummary): HTMLElement | null {
    const running = this.#backgroundRunning(thread)
    if (running === 0) return null
    const tag = document.createElement('span')
    tag.className = 'fl-row-running'
    tag.textContent = `${String(running)} running`
    tag.title = `${String(running)} background ${running === 1 ? 'task' : 'tasks'} still running`
    tag.style.cssText = [
      'flex:none',
      'padding:0 6px',
      'border-radius:999px',
      'font-size:var(--fl-text-caption-size)',
      'color:var(--fl-color-accent)',
      'background:var(--fl-color-accent-muted)',
      'white-space:nowrap',
    ].join(';')
    return tag
  }

  /**
   * Move the elapsed timers, and move NOTHING else.
   *
   * Writing `textContent` on the spans that are already mounted, rather than
   * asking the list to render again. `#list.refresh()` re-runs renderItem for
   * every visible row, which rebuilds the spinner too — and a CSS animation on
   * a brand-new element starts at frame zero, so a secondly rebuild made every
   * running agent stutter in unison. The row set does not change here; only two
   * characters of text do.
   */
  #tickElapsed(): void {
    const root = this.#list.shadowRoot
    if (root === null) return
    const now = new Date()
    for (const [threadId, tasks] of this.#backgroundTasks) {
      const reportedAt = this.#backgroundTasksAt.get(threadId) ?? now
      for (const task of tasks) {
        const span = root.querySelector<HTMLElement>(
          `[data-elapsed-for="${CSS.escape(task.id)}"]`,
        )
        if (span === null) continue // scrolled out of the virtualized window
        const next = formatElapsed(taskElapsedMs(task, now, reportedAt))
        if (span.textContent !== next) span.textContent = next
      }
    }
  }

  #applyStatus(threadId: string, status: ThreadStatus): void {
    const thread = this.#threads.find((candidate) => candidate.id === threadId)
    if (thread && thread.status !== status) {
      thread.status = status
      this.#list.refresh()
    }
  }

  #renderRows(): void {
    // Active threads group by root; archived threads always collapse into an
    // "Archived" section at the bottom — INCLUDING in search, so an archived match
    // is grouped/labelled instead of flattened in with active rows (#482). During a
    // search the section is forced expanded so those matches are actually visible.
    const searching = this.#query.length > 0
    // WHAT THE SWITCHER IS POINTED AT: the open Workspace's projects.
    const { active, archived } = partitionByArchived(
      this.#threads.filter((thread) => this.#inScope(thread.projectRoot)),
    )
    // #1391: tasks archive too, and had nowhere to go. Same partition, same
    // section — the sidebar's one answer to "where did the thing I archived
    // go?" now covers both kinds. Only rows that belong here at all (#1789):
    // an agent-mirrored card the assistant later archived is board bookkeeping,
    // not a conversation somebody put away.
    const { archived: archivedTasks } = partitionByArchived(
      this.#tasks.filter((task) => taskBelongsInSidebar(task) && this.#inScope(task.projectRoot)),
    )
    // TWO DIFFERENT REASONS AN ARCHIVED ROW IS ON SCREEN, and they belong in
    // different places:
    //
    //  · A SEARCH matched it. It goes to the bottom section, grouped and
    //    labelled rather than flattened in with live rows — the rule #482
    //    established, older than this control and not a preference.
    //  · THE LIST ASKED for its archive (the view menu beside the search). It
    //    goes under the list's own rows, never above what is current.
    const asked = !searching && this.#viewOptionsFor(this.#listKey()).showArchived
    const inGroups = {
      threads: asked ? archived : [],
      tasks: asked ? archivedTasks : [],
    }
    const shownArchived = searching ? archived : []
    const shownArchivedTasks = searching ? archivedTasks : []
    const archivedCount = shownArchived.length + shownArchivedTasks.length
    // THE MENU IS THE DECISION, so its press shows the ITEMS — "if the user
    // press it, we should show the itens archived on the list". There is no
    // second expand to find: a row only reaches this list because a project
    // asked for its archive (or because a search matched it), and both of those
    // are already a yes. `#archivedExpanded` survives for the header's own
    // collapse, which now starts open rather than closed.
    const archivedExpanded =
      archivedSectionExpanded(searching, this.#archivedExpanded) || archivedCount > 0

    const rows: SidebarRow[] = this.#groupRows(active, searching, inGroups)

    if (archivedCount > 0) {
      rows.push({ kind: 'archived-header', count: archivedCount, expanded: archivedExpanded })
      if (archivedExpanded) {
        shownArchived.sort((a, b) =>
          (b.archivedAt ?? b.updatedAt).localeCompare(a.archivedAt ?? a.updatedAt),
        )
        for (const thread of shownArchived) {
          rows.push({ kind: 'thread', thread })
        }
        shownArchivedTasks.sort((a, b) =>
          (b.archivedAt ?? b.updatedAt).localeCompare(a.archivedAt ?? a.updatedAt),
        )
        for (const task of shownArchivedTasks) {
          // Archived tasks carry no pin (pinning orders the LIVE list).
          rows.push({
            kind: 'task',
            task: { ...task, pinnedAt: null },
            thread: this.#threadForTask(task),
          })
        }
      }
    }

    this.#list.items = rows
    // fl-list's raised-row cursor is POSITIONAL — it remembers the clicked row
    // index, so any reorder (pinning a sibling, a recency bump, clearing a
    // search) left the strongest "current thread" cue on whatever moved into
    // that index (#1043). Re-derive it from the active thread's identity on
    // every render: the highlight follows the open thread, drops to none when
    // its row isn't rendered, and appears even when the thread was opened from
    // outside the sidebar. (The setter no-ops on an unchanged index and only
    // scrolls when the cursor actually moves.)
    this.#list.selectedIndex = rows.findIndex(
      (row) =>
        (row.kind === 'thread' && row.thread.id === this.#activeThreadId) ||
        (row.kind === 'task' && row.thread !== null && row.thread.id === this.#activeThreadId),
    )
    // With empty search headers now suppressed, a no-match search collapses to
    // zero rows — surface a search-aware "No threads match …" state (#326).
    // The hint's gate counts CONTENT rows, not raw rows (#978): every project
    // root always pushes a group-header row, which used to suppress "No threads
    // yet" in the exact state it describes (a project open with zero threads)
    // and show it only on a project-less launch — where the real blocker is
    // "open a project", now its own message branch. Fold headers imply threads
    // exist, so any non-group row counts as content.
    // The clock runs only while something is running and the list is on screen
    // — checked here because every path that changes either one ends in a
    // render (allowed-pattern #17).
    this.#syncElapsedTimer()
    const hasContentRows = rows.length > 0
    this.#emptyHint.textContent =
      (searching ? null : emptyWorkspaceMessage(this.#scope, this.#scopeRoots().length > 0)) ??
      emptySidebarMessage(searching, this.#query, this.#roots.length > 0)
    this.#emptyHint.style.display = hasContentRows ? 'none' : 'flex'
  }

  /**
   * Group threads by project root into group-header + thread rows. EVERY
   * project root gets a header (even with zero threads) so the header can
   * serve as the project-management surface; collapsed projects show the
   * header only — except for search matches and a just-created thread, which
   * are force-revealed (#1010). Orphan roots (threads referencing a
   * since-removed root) are appended after the known roots.
   */
  /** Whether a row whose project is `root` is drawn for the current scope. */
  #inScope(root: string): boolean {
    const state = this.#scopeState
    if (state === null) return true
    return rootInScope(root, this.#scope, state.membership)
  }

  /** The open projects of the current scope, in sidebar order. */
  #scopeRoots(): string[] {
    return this.#roots.map((root) => root.rootPath).filter((root) => this.#inScope(root))
  }

  /**
   * The small, muted project name a row carries in the Workspace's one list —
   * the header it would have sat under, moved onto the row.
   */
  #projectTag(root: string): HTMLElement | null {
    const tag = document.createElement('span')
    tag.className = 'fl-thread-project-tag'
    const name = workspaceScope.nameOf(root)
    tag.textContent = name
    tag.title = `Project: ${name}`
    tag.style.cssText = [
      'flex:none',
      'max-width:40%',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'color:var(--fl-color-text-secondary)',
      'font-size:var(--fl-text-caption-size)',
    ].join(';')
    return tag
  }

  /** The thread a task owns, when it is loaded (#1391). */
  #threadForTask(task: TaskSummary): ThreadSummary | null {
    if (task.threadId === null) return null
    return this.#threads.find((thread) => thread.id === task.threadId) ?? null
  }

  #groupRows(
    threads: ThreadSummary[],
    searching: boolean,
    archivedInGroups: { threads: ThreadSummary[]; tasks: TaskSummary[] } = {
      threads: [],
      tasks: [],
    },
  ): SidebarRow[] {
    const rows: SidebarRow[] = []
    const threadById = new Map(this.#threads.map((t) => [t.id, t]))
    const threadOf = (task: TaskSummary): ThreadSummary | null =>
      task.threadId ? (threadById.get(task.threadId) ?? null) : null

    // A task owns one thread; those threads are shown as task rows, so "bare"
    // threads (no owning task) are the ones that interleave with task rows by
    // recency below. While searching we drop the task layer entirely and show
    // every matching thread flat (task rows aren't part of the search), so
    // nothing renders inert.
    const showTasks = !searching
    // #1467: archiving a task sets archived_at on the TASK, not on its 1:1
    // thread — so that thread is still "active" and, with the task layer dropped
    // for search, fell through into the flat result list while the Archived
    // section rendered the same task again below. One thing, two rows, and the
    // top one looked exactly like a live conversation: same chat icon, `now`
    // timestamp, and the ordinary thread menu whose Archive would have put the
    // pair into a third state. This is #482's defect in its task variant.
    //
    // So even while the task layer is dropped, a thread owned by an ARCHIVED
    // task is never a bare row: the Archived section speaks for it.
    const archivedTaskThreadIds = new Set(
      this.#tasks
        .filter((task) => task.archivedAt !== null)
        .map((task) => task.threadId)
        .filter((id): id is string => id !== null),
    )
    // A task's thread is normally suppressed from the bare list because a task
    // row speaks for it — EXCEPT a machine-filed card, which gets no row, so its
    // thread would render nowhere. Once the board's loop is working such a card,
    // let its live conversation through to the bare list (#1880), drawn with the
    // ↻ glyph off `originLoop`. Idle machine cards and archived tasks stay
    // suppressed (#1789 / #1467).
    const isLoopRun = (threadId: string | null): boolean =>
      threadId !== null && (threadById.get(threadId)?.originLoop ?? null) !== null
    const owningThreadIds = showTasks
      ? new Set(
          this.#tasks
            .filter((task) =>
              taskThreadSuppressedFromBareList({
                ...task,
                threadIsLoopRun: isLoopRun(task.threadId),
              }),
            )
            .map((t) => t.threadId)
            .filter((id): id is string => id !== null),
        )
      : archivedTaskThreadIds
    const bareThreadsByRoot = new Map<string, ThreadSummary[]>()
    for (const thread of threads) {
      if (owningThreadIds.has(thread.id)) continue
      const list = bareThreadsByRoot.get(thread.projectRoot)
      if (list) list.push(thread)
      else bareThreadsByRoot.set(thread.projectRoot, [thread])
    }

    // A task's pin IS its 1:1 thread's pin — wrap so the recency banding works.
    const tasksByRoot = new Map<string, TaskWithPin[]>()
    if (showTasks) {
      // #1391: archived tasks belong in the Archived section, not among the
      // live lanes — the list now includes them, so filter here. And only rows
      // the sidebar owns at all (#1789): an agent-mirrored card lives on the
      // board, not in the conversation list, and opening its chat does not
      // change that — the board's own "Open chat" is the way in.
      // …and only the current scope's: inside a Workspace, its projects' tasks
      // (the threads were already scoped; the task rows were not, so every
      // project's cards showed in every Workspace's list).
      for (const task of this.#tasks.filter(
        (candidate) =>
          candidate.archivedAt === null && taskBelongsInSidebar(candidate) && this.#inScope(candidate.projectRoot),
      )) {
        const withPin: TaskWithPin = { ...task, pinnedAt: threadOf(task)?.pinnedAt ?? null }
        const list = tasksByRoot.get(task.projectRoot)
        if (list) list.push(withPin)
        else tasksByRoot.set(task.projectRoot, [withPin])
      }
    }

    // ONE LIST FOR A WORKSPACE (user, 2026-10-06: "instead of list of projects
    // the idea was have a unified one"; the only list since the hard migration).
    // Every row of every project in it is folded under one key with no header,
    // so the recency order, the pinned band and the "More" fold below apply to
    // the Workspace as a whole; each row names its own project instead
    // (`#projectTag`).
    const listKey = this.#listKey()
    const bareThreads = [...bareThreadsByRoot.values()].flat()
    const tasks = [...tasksByRoot.values()].flat()
    {
      // Tasks and bare threads interleave by recency (newest first) — a task
      // never sorts ahead of a newer thread just because it's a task. Pinned
      // items still float to the top; the rest fold into one "older" section.
      const merged: MergedItem[] = [
        // A task with no 1:1 thread falls back to its own id — it can never be
        // the active THREAD, so the exemptions simply never match it.
        ...tasks.map((task) => ({ row: 'task' as const, task, updatedAt: task.updatedAt, createdAt: task.createdAt, title: task.title, pinnedAt: task.pinnedAt, id: task.threadId ?? task.id })),
        ...bareThreads.map((thread) => ({ row: 'thread' as const, thread, updatedAt: thread.updatedAt, createdAt: thread.createdAt, title: thread.title, pinnedAt: thread.pinnedAt, id: thread.id })),
      ]
      const toRow = (item: MergedItem): SidebarRow =>
        item.row === 'task'
          ? { kind: 'task', task: item.task, thread: threadOf(item.task) }
          : { kind: 'thread', thread: item.thread }

      /**
       * Push a row, then one row per piece of background work its thread is
       * still waiting on.
       *
       * BENEATH THE PARENT, ALWAYS — a sub-agent is a thing this conversation
       * started, and the only place that reads as is directly under it. Which
       * is also why they are rows in this list rather than a panel of their
       * own: the question "what is running" is asked while looking at the
       * threads, not instead of it.
       */
      const pushWithAgents = (row: SidebarRow): void => {
        rows.push(row)
        const threadId =
          row.kind === 'thread'
            ? row.thread.id
            : row.kind === 'task'
              ? (row.thread?.id ?? null)
              : null
        if (threadId === null) return
        const children = this.#childThreadsByParent.get(threadId) ?? []
        // LIVE background work (agent-task rows) — ALWAYS drawn while it runs
        // (#1931 follow-up: one caret, and live rows are never in its fold —
        // they are the only trace of running work). A task that resolved to a
        // PROMOTED child of this thread is NOT drawn here: its child row below
        // is the one row that work gets, spinner and all (`visibleAgentTasks`
        // — one join, allowed-pattern #14).
        const running = this.#backgroundTasks.get(threadId)
        if (running !== undefined && running.length > 0) {
          const visible = visibleAgentTasks(running, children)
          const reportedAt = this.#backgroundTasksAt.get(threadId) ?? new Date()
          visible.forEach((task, index) =>
            rows.push({
              kind: 'agent-task',
              threadId,
              task,
              reportedAt,
              last: index === visible.length - 1,
            }),
          )
        }
        // #1931: PROMOTED sub-agent child threads nest under their parent too.
        // The DISCLOSURE lives on the parent thread row itself (#childrenToggle)
        // — by default a thread with finished children shows NOTHING beneath
        // it; LIVE children (origin still running) always render, like the
        // agent-task rows above, and the fold never hides the active thread
        // (the plan renders the group expanded when a child is selected).
        if (children.length > 0) {
          const { rows: childRows } = this.#planChildRowsFor(threadId, children)
          childRows.forEach((planned, index) =>
            rows.push({
              kind: 'child-thread',
              thread: planned.thread,
              originRunning: planned.originRunning,
              last: index === childRows.length - 1,
            }),
          )
        }
      }

      // #71: show up to WORKSPACE_VISIBLE_LIMIT (pinned first), fold the rest under "More".
      // The OPEN thread is cap-exempt like a pinned one (#1042) — without the
      // exemption, a composer-bound older thread simply vanished behind the fold.
      const expanded = this.#moreExpanded.has(listKey)
      // THE PROJECT'S OWN ORDER, applied before the cap — so "Name" folds the
      // LAST names under "Show N more" rather than folding by recency and then
      // alphabetising whatever survived, which would put the fold somewhere the
      // reader cannot predict. `capThreadList` sorts by recency internally,
      // which is exactly right for the default and has to be overridden for the
      // other two; the pinned band keeps its own rule either way.
      const order = this.#viewOptionsFor(listKey).order
      const { pinned, visible, overflowCount } = capThreadList(merged, {
        limit: WORKSPACE_VISIBLE_LIMIT,
        searching,
        expanded,
        activeId: this.#activeThreadId,
        ...(order === 'recent' ? {} : { compare: (a, b) => compareInOrder(a, b, order) }),
      })
      for (const item of [...pinned, ...visible]) pushWithAgents(toRow(item))
      if (overflowCount > 0) {
        rows.push({ kind: 'more-header', rootPath: listKey, count: overflowCount, expanded })
      }
      // …AND THE ARCHIVE, when the list asked for it — after its live rows and
      // after the fold, so what was put away never sits above what is current.
      // Newest-archived first: the thing you most likely want back is the thing
      // you most recently put down.
      const archivedHere = [
        ...archivedInGroups.threads
          .map((thread) => ({ at: thread.archivedAt ?? thread.updatedAt, row: { kind: 'thread' as const, thread } })),
        ...archivedInGroups.tasks
          .map((task) => ({
            at: task.archivedAt ?? task.updatedAt,
            // An archived task carries no pin — pinning orders the LIVE list.
            row: {
              kind: 'task' as const,
              task: { ...task, pinnedAt: null },
              thread: threadOf(task),
            },
          })),
      ].sort((a, b) => b.at.localeCompare(a.at))
      for (const entry of archivedHere) rows.push(entry.row)
    }
    return rows
  }

  /** The one list's key — its view options and its "More" fold are the Workspace's. */
  #listKey(): string {
    return this.#scope.kind === 'workspace' ? `workspace:${this.#scope.slug}` : UNRESOLVED_LIST_KEY
  }

  #renderRow(row: SidebarRow): HTMLElement {
    if (row.kind === 'more-header' || row.kind === 'archived-header') {
      const header = document.createElement('div')
      header.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:6px',
        'width:100%',
        'cursor:pointer',
        'color:var(--fl-color-text-secondary)',
        'font-size:var(--fl-text-ui-size)',
        'font-weight:var(--fl-text-ui-weight)',
      ].join(';')
      // Both folds sit in the same label column as the rows they extend.
      header.style.paddingLeft = '26px'
      // A PLAIN WORD, no caret and no count. `▸ SHOW 97 MORE` was three
      // signals for one link: the arrow duplicates what the word says, the
      // count is a number nobody acts on (you press it either way), and the
      // caps made a footnote louder than the thread names above it.
      // "Archived" keeps its count — there the number IS the news, because
      // the section is otherwise closed and empty-looking.
      const label = document.createElement('span')
      label.textContent =
        row.kind === 'archived-header'
          ? `Archived (${row.count})`
          : row.expanded
            ? 'Less'
            : 'More'
      label.title =
        row.kind === 'archived-header'
          ? ''
          : row.expanded
            ? 'Show fewer threads'
            : `Show ${row.count} more thread${row.count === 1 ? '' : 's'}`
      header.appendChild(label)
      return header
    }

    if (row.kind === 'agent-task') {
      return this.#renderAgentTaskRow(row)
    }

    if (row.kind === 'task') {
      return this.#renderTaskRow(row.task, row.thread)
    }

    if (row.kind === 'child-thread') {
      return this.#renderChildThreadRow(row)
    }

    const { thread } = row
    const rowEl = document.createElement('div')
    const multiSelected = this.#selectedThreadIds.has(thread.id)
    const isActive = thread.id === this.#activeThreadId
    rowEl.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:8px',
      'width:100%',
      // ONE LABEL COLUMN. A thread title starts exactly where its project's
      // name starts — measured, both at 34px from the sidebar's left edge —
      // so the folder icon hangs alone in the gutter and everything readable
      // lines up under everything readable. 26px is that column: the group's
      // 6px inset plus its 14px glyph plus the 6px gap after it.
      //
      // It was 22px, which put the children 4px LEFT of their parent — the one
      // arrangement a tree must never draw, and invisible until the per-row
      // glyph stopped padding the gap.
      //
      // A Workspace's one list has no headers to line up under, so its rows
      // keep only the gutter the isolation rule hangs in.
      this.#scope.kind === 'workspace' ? 'padding-left:12px' : 'padding-left:26px',
      'overflow:hidden',
      // The isolation rule hangs in the gutter that padding already reserves —
      // see `isolationRule` for why it is placed rather than laid out.
      'position:relative',
    ].join(';')
    // WHICH THREAD IS OPEN, and ⌘-click multi-select (#730). The row asks for
    // the decoration and <fl-list> paints it on the ROW — fl-list's own
    // `.selected` only accent-tints while the list is focused (#1881), and
    // painting it here instead put a 300×20 accent box inside the row's 316×28
    // grey one ("double-selecting", 2026-09-08). Active wins over select.
    const selectionMark = sidebarRowMark({ active: isActive, multiSelected })
    if (selectionMark !== null) rowEl.classList.add(selectionMark)

    // THE GLYPH ONLY WHEN IT HAS SOMETHING TO SAY. Every row used to open with
    // a chat bubble, so the mark that was meant to distinguish rows appeared
    // identically on all of them — a column of the same icon, carrying no
    // information and costing the title 19px on every line. A loop run and a
    // thread that is working, waiting or failed still get theirs, because
    // those genuinely differ from the row above. An idle or finished chat gets
    // nothing: it is indented under its project, which already says what it is.
    // A THREAD WAITING ON ITS AGENTS IS NOT AT REST. `status` is about the
    // TURN, and a thread that backgrounded four review passes has genuinely
    // finished its turn — which is why the composer is free, and why this row
    // went blank while the work ran. The mark reads off both.
    // WHERE THIS CONVERSATION'S CHANGES GO, said before anything is read. It is
    // the first child so the DOM reads the way the row does, left to right;
    // what puts it in the gutter is placement, not order.
    rowEl.appendChild(isolationRule(thread))
    const glyph = threadGlyph(this.#liveStatus(thread), thread.originLoop)
    if (glyph !== null) rowEl.appendChild(glyph)
    // #1931 follow-up: THE one disclosure for everything nested under this
    // thread — present only when something is foldable (finished children).
    const childrenToggle = this.#childrenToggle(thread.id)
    if (childrenToggle !== null) rowEl.appendChild(childrenToggle)

    // ROW ACTIONS, ON HOVER ONLY (2026-09-04, matching the reference): pin and
    // archive, the two verbs people reach for from a list rather than from
    // inside a thread. Everything else stays on right-click.
    //
    // THEY TAKE THE DATE'S PLACE (see the ORDER note below). Zero width at
    // rest means no reserved gutter — the mistake the ⋯ column made. Revealed
    // by fl-list's shadow CSS, so a re-render under a stationary pointer
    // cannot lose them.
    const rowActions = document.createElement('span')
    rowActions.className = 'fl-row-hover'
    rowActions.style.cssText = 'flex:none;align-items:center;gap:2px;'
    const isPinned = thread.pinnedAt !== null
    const isArchived = thread.archivedAt !== null
    const actionBtn = (icon: string, label: string, run: () => void): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('aria-label', label)
      btn.title = label
      btn.style.cssText = [
        'flex:none',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'width:18px',
        'height:18px',
        'border:none',
        'border-radius:var(--fl-radius-sm)',
        'background:transparent',
        'color:var(--fl-color-text-secondary)',
        'cursor:pointer',
        'padding:0',
      ].join(';')
      const glyph = document.createElement('fl-icon')
      glyph.setAttribute('name', icon)
      glyph.setAttribute('size', '12')
      btn.appendChild(glyph)
      const stopIt = (event: Event): void => {
        event.stopPropagation()
        event.preventDefault()
      }
      btn.addEventListener('mousedown', stopIt)
      btn.addEventListener('click', (event) => {
        stopIt(event)
        run()
      })
      return btn
    }
    rowActions.appendChild(
      actionBtn('pin', isPinned ? 'Unpin' : 'Pin', () => void this.#setPinned(thread, !isPinned)),
    )
    rowActions.appendChild(
      actionBtn('archive', isArchived ? 'Unarchive' : 'Archive', () =>
        void this.#setArchived(thread, !isArchived),
      ),
    )
    // Pinned threads carry a small pin glyph and always show (recency-exempt).
    if (thread.pinnedAt !== null) {
      const pin = document.createElement('fl-icon')
      pin.setAttribute('name', 'pin')
      pin.setAttribute('size', '11')
      pin.title = 'Pinned'
      pin.style.cssText = 'flex:none;color:var(--fl-color-text-secondary);'
      rowEl.appendChild(pin)
    }

    const title = document.createElement('span')
    title.style.cssText = [
      'flex:1',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'font-size:var(--fl-text-ui-size)',
      'color:var(--fl-color-text)',
      thread.id === this.#activeThreadId
        ? 'font-weight:var(--fl-text-ui-weight-medium)'
        : 'font-weight:var(--fl-text-ui-weight)',
    ].join(';')
    title.textContent = thread.title || 'Untitled thread'
    title.title = thread.title

    const age = document.createElement('span')
    age.style.cssText =
      'flex:none;color:var(--fl-color-text-secondary);font-size:var(--fl-text-caption-size);'
    age.textContent = relativeAge(thread.updatedAt)

    // Pin / rename / archive / delete are on RIGHT-CLICK, anywhere on the row —
    // or, when this row is part of a ⌘-click multi-selection, the selection
    // menu, so Archive acts on the whole selection instead of silently hitting
    // 1 of N (#1120 — the branch #730 gave contextmenu only).
    //
    // THE ⋯ BUTTON IS GONE (2026-09-04). It was the second door to this same
    // menu, and it cost a column on every row for as long as the list is long.
    // Hiding it until hover only traded a faint dot for an empty gutter. The
    // ROW is the anchor now: #mountMenu right-aligns to the anchor's box, so
    // the menu lands on the row's own right edge where the button used to be.
    rowEl.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      if (this.#selectedThreadIds.size > 0 && this.#selectedThreadIds.has(thread.id)) {
        this.#openSelectionMenu(rowEl)
      } else {
        this.#openRowMenu(thread, rowEl)
      }
    })

    // ORDER: [glyph] · title · [project] · [worktree badge] · date | hover actions.
    //
    // NOTHING HERE IS A FIXED CELL ANY MORE. The date used to sit right-aligned
    // inside a 44px box wide enough for "Jul 23", which lined up the dates'
    // LEFT edges as well as their right ones — and that is what put 30px of air
    // between a row's content and a short date like "1h" while "Aug 26" had
    // none. The gap was widest exactly where the row had least to say.
    //
    // Sized to its content and placed last, every date still ENDS on the same
    // pixel, which is the alignment right-aligned text actually needs; and the
    // worktree badge, which sits immediately before it, now hugs the date on
    // every row instead of standing off it by however wide that row's date
    // happened to be.
    //
    // THE HOVER ACTIONS TAKE THE DATE'S PLACE, at the row's trailing edge. They
    // used to sit straight after the title, and in a Workspace — where a
    // project tag stands between title and date — that put Archive in the
    // MIDDLE of the row: measured on a 308px row, the title squeezed to 81px
    // and Archive under the centre, so the ordinary press that opens a thread
    // archived it instead, with no confirmation. At the edge they sit where
    // nobody presses to open, and the date (a resting fact) yields to them.
    rowEl.appendChild(title)
    const runningTag = this.#runningTag(thread)
    if (runningTag !== null) rowEl.appendChild(runningTag)
    const threadTag = this.#projectTag(thread.projectRoot)
    if (threadTag !== null) rowEl.appendChild(threadTag)
    const mark = this.#contextIndicator(thread)
    if (mark !== null) rowEl.appendChild(mark)
    if (age !== null) {
      age.classList.add('fl-row-rest')
      rowEl.appendChild(age)
    }
    rowEl.appendChild(rowActions)
    return rowEl
  }

  /**
   * One piece of background work, nested under the thread that started it:
   * spine · ring · what it is · how long it has been at it.
   *
   * READ-ONLY, AND DELIBERATELY SO. A row here reports; it does not offer to
   * stop, open or retarget the work. The runtime can stop a task, so the button
   * is buildable — but a control that kills a running agent, on a 22px row, one
   * pixel from the thread rows people click all day, is a mis-click with no
   * undo. It belongs where the work is discussed, not where it is listed.
   */
  #renderAgentTaskRow(row: Extract<SidebarRow, { kind: 'agent-task' }>): HTMLElement {
    const rowEl = document.createElement('div')
    rowEl.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:6px',
      'width:100%',
      // Indented past the thread title's column, so the nesting is visible
      // before anything is read: these belong to the row above them.
      'padding-left:34px',
      'overflow:hidden',
      'position:relative',
    ].join(';')

    // THE SPINE. A single vertical rule joining a thread to the work it is
    // waiting on — the thing that makes four rows read as four parts of one
    // answer rather than four more list items. It stops halfway down the LAST
    // one, so the group visibly ends instead of pointing at the next thread.
    const spine = document.createElement('span')
    spine.style.cssText = [
      'position:absolute',
      'left:27px',
      'top:0',
      row.last ? `height:${Math.round(AGENT_TASK_ROW_HEIGHT / 2)}px` : 'bottom:0',
      'width:1px',
      'background:var(--fl-color-border)',
      'pointer-events:none',
    ].join(';')
    rowEl.appendChild(spine)

    // THE RING. The same spinner every running tool card uses, at the size a
    // nested row can hold — one shape for "this is moving", wherever it moves.
    const ring = document.createElement('fl-icon')
    ring.setAttribute('name', 'spinner')
    ring.setAttribute('size', '11')
    ring.setAttribute('spin', '')
    ring.style.cssText = 'flex:none;color:var(--fl-color-accent);'
    rowEl.appendChild(ring)

    const label = document.createElement('span')
    label.style.cssText = [
      'flex:1',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'font-size:var(--fl-text-caption-size)',
      'color:var(--fl-color-text-secondary)',
    ].join(';')
    label.textContent = taskLabel(row.task)
    label.title = taskTooltip(row.task)
    rowEl.appendChild(label)

    // HOW LONG, in the column the dates use on every row above. The runtime's
    // reported duration when it has sent one, ticked locally in between — see
    // `taskElapsedMs` for why the two clocks are never mixed.
    const elapsed = document.createElement('span')
    elapsed.style.cssText =
      'flex:none;color:var(--fl-color-text-secondary);font-size:var(--fl-text-caption-size);'
    // TAGGED SO THE CLOCK CAN REACH IT WITHOUT A REBUILD. The tick used to call
    // `#list.refresh()`, which re-runs renderItem for every mounted row — so
    // once a second this whole row, spinner included, was thrown away and made
    // again. A CSS animation on a fresh element starts from zero, so eight
    // running agents visibly stuttered in lockstep every second, which reads as
    // the list resetting itself (reported 2026-09-08: "loader flickering").
    elapsed.dataset.elapsedFor = row.task.id
    elapsed.textContent = formatElapsed(taskElapsedMs(row.task, new Date(), row.reportedAt))
    rowEl.appendChild(elapsed)

    // #1931 (D-4): clicking a running sub-agent opens its full child-thread
    // chat in the MAIN pane when it resolves to its persisted spawn; otherwise
    // the right-side live progress remains the fallback. Same routing code path
    // as the chip popover's live rows (subagent-open.ts, allowed-pattern #14).
    rowEl.style.cursor = 'pointer'
    rowEl.addEventListener('click', (event) => {
      event.stopPropagation()
      void openSubagentTask(row.threadId, row.task, {
        label: taskLabel(row.task),
        running: true,
      })
    })
    return rowEl
  }

  /**
   * A promoted sub-agent CHILD thread, nested under its parent (#1931).
   *
   * Shares the agent-task row's indent + spine so a child reads as belonging to
   * the thread above it — but it is a real, clickable conversation (opens like
   * any thread), not a read-only progress footnote. While its ORIGIN runs the
   * row carries the agent-task row's own spinner (one piece of work, one row —
   * `visibleAgentTasks` suppressed the duplicate task row) plus that row's
   * elapsed clock when the tracker backs it; finished, the ↳ branch glyph says
   * "this is a continued sub-agent". The title is the sub-agent's own.
   */
  #renderChildThreadRow(row: Extract<SidebarRow, { kind: 'child-thread' }>): HTMLElement {
    const rowEl = document.createElement('div')
    rowEl.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:6px',
      'width:100%',
      'padding-left:34px',
      'overflow:hidden',
      'position:relative',
      'cursor:pointer',
    ].join(';')

    const isActive = row.thread.id === this.#activeThreadId
    const selectionMark = sidebarRowMark({ active: isActive, multiSelected: false })
    if (selectionMark !== null) rowEl.classList.add(selectionMark)

    const spine = document.createElement('span')
    spine.style.cssText = [
      'position:absolute',
      'left:27px',
      'top:0',
      row.last ? `height:${Math.round(AGENT_TASK_ROW_HEIGHT / 2)}px` : 'bottom:0',
      'width:1px',
      'background:var(--fl-color-border)',
      'pointer-events:none',
    ].join(';')
    rowEl.appendChild(spine)

    if (row.originRunning) {
      // THE SAME RING the agent-task row draws — one shape for "this is
      // moving", wherever it moves (no new visual language).
      const ring = document.createElement('fl-icon')
      ring.setAttribute('name', 'spinner')
      ring.setAttribute('size', '11')
      ring.setAttribute('spin', '')
      ring.style.cssText = 'flex:none;color:var(--fl-color-accent);'
      rowEl.appendChild(ring)
    } else {
      const glyph = document.createElement('span')
      glyph.style.cssText = 'flex:none;opacity:.7;'
      glyph.setAttribute('aria-hidden', 'true')
      glyph.textContent = '↳'
      rowEl.appendChild(glyph)
    }

    const label = document.createElement('span')
    label.style.cssText = [
      'flex:1',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'font-size:var(--fl-text-caption-size)',
      'color:var(--fl-color-text-secondary)',
    ].join(';')
    label.textContent = row.thread.title
    label.title = row.thread.title
    rowEl.appendChild(label)

    // The hover ✕ (#1931 follow-up) — the SAME reveal idiom main's top-level
    // rows use for pin/archive (`fl-row-hover`, shown by fl-list's shadow CSS
    // only while the row is hovered), on FINISHED rows only (`canDismissChildRow`
    // — a running child's next redirected row would un-archive it right back).
    // Dismiss = archive: recoverable, and the Background activity popover
    // re-opens (and un-archives) it. After the label, at the row's right edge,
    // so the title area the specs (and fingers) aim for stays clear of it.
    if (canDismissChildRow(row)) {
      const actions = document.createElement('span')
      actions.className = 'fl-row-hover'
      actions.style.cssText = 'flex:none;align-items:center;gap:2px;'
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.setAttribute('aria-label', 'Dismiss')
      // THE WAY BACK IS THE CHAT, not the strip: the strip now shows only
      // while a sub-agent is running (2026-10-13), and this row can only be
      // dismissed once its own has finished — so naming the strip here would
      // promise a door that is closed by the time anyone reads it
      // (forbidden-pattern #23). The spawn's line in the conversation goes
      // through the same open, and un-archives the same way.
      dismiss.title = 'Dismiss — reopen it from the sub-agent’s line in the chat'
      dismiss.style.cssText = [
        'flex:none',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'width:18px',
        'height:18px',
        'border:none',
        'border-radius:var(--fl-radius-sm)',
        'background:transparent',
        'color:var(--fl-color-text-secondary)',
        'cursor:pointer',
        'padding:0',
      ].join(';')
      const glyph = document.createElement('fl-icon')
      glyph.setAttribute('name', 'close')
      glyph.setAttribute('size', '12')
      dismiss.appendChild(glyph)
      const stopIt = (event: Event): void => {
        event.stopPropagation()
        event.preventDefault()
      }
      dismiss.addEventListener('mousedown', stopIt)
      dismiss.addEventListener('click', (event) => {
        stopIt(event)
        void this.#dismissChildThread(row.thread)
      })
      actions.appendChild(dismiss)
      rowEl.appendChild(actions)
    }

    // The elapsed clock the deduped agent-task row used to carry, when the
    // tracker backs this child's origin — tagged exactly like that row's span
    // so #tickElapsed keeps moving it without a rebuild.
    if (row.originRunning) {
      const parentId = row.thread.parentThreadId
      const originId = row.thread.originToolCallId
      const task =
        parentId !== null && parentId !== undefined && originId !== null && originId !== undefined
          ? trackerTaskFor(originId, this.#backgroundTasks.get(parentId) ?? [])
          : undefined
      if (task !== undefined && parentId !== null && parentId !== undefined) {
        const reportedAt = this.#backgroundTasksAt.get(parentId) ?? new Date()
        const elapsed = document.createElement('span')
        elapsed.style.cssText =
          'flex:none;color:var(--fl-color-text-secondary);font-size:var(--fl-text-caption-size);'
        elapsed.dataset.elapsedFor = task.id
        elapsed.textContent = formatElapsed(taskElapsedMs(task, new Date(), reportedAt))
        rowEl.appendChild(elapsed)
      }
    }

    rowEl.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#activeThreadId = row.thread.id
      this.#renderRows()
      this.#handlers.onSelect(row.thread)
    })
    return rowEl
  }

  /**
   * Dismiss a FINISHED child thread (#1931 follow-up): archive it — the same
   * recoverable verb and IPC the top-level rows' Archive action uses — and,
   * when it was the conversation ON SCREEN, walk back to the parent through
   * the banner's own back path (`flow:open-thread`) so the pane never sits on
   * a thread no list shows. The threads:updated broadcast refreshes the list,
   * where the archived-child filter drops the row entirely.
   */
  async #dismissChildThread(thread: ThreadSummary): Promise<void> {
    const wasActive = thread.id === this.#activeThreadId
    try {
      await window.flow.threads.update({ threadId: thread.id, patch: { archived: true } })
    } catch (error) {
      console.error('flow: failed to dismiss sub-agent thread', error)
      return
    }
    const parentId = thread.parentThreadId
    if (wasActive && parentId !== null && parentId !== undefined) {
      document.dispatchEvent(
        new CustomEvent('flow:open-thread', { detail: { threadId: parentId } }),
      )
    }
  }

  /** The ONE fold decision for a parent's children (`planChildRows`), fed the
   *  sidebar's own state — the row builder and the thread row's chevron both
   *  read this, so they can never disagree about what is hidden. A child is
   *  LIVE per the lifecycle merge rule (`subagentRunState`): the tracker's
   *  entry for its origin is authoritative; the cached persisted status is the
   *  fallback when the tracker has none. */
  #planChildRowsFor(
    threadId: string,
    children: readonly ThreadSummary[],
  ): ReturnType<typeof planChildRows<ThreadSummary>> {
    const trackerTasks = this.#backgroundTasks.get(threadId) ?? []
    const byId = new Map(children.map((child) => [child.id, child]))
    return planChildRows({
      children,
      originRunning: (childId) => {
        const originId = byId.get(childId)?.originToolCallId
        if (originId === null || originId === undefined) return false
        const status = this.#childOriginStatus.get(childId)
        const record = status === undefined ? null : { id: originId, status }
        return subagentRunState(record, trackerTasks, originId).running
      },
      expanded: this.#expandedChildThreads.has(threadId),
      activeThreadId: this.#activeThreadId,
    })
  }

  /**
   * THE ONE disclosure chevron a thread row carries for everything nested
   * under it (#1931 follow-up: one caret, one level of collapse per thread).
   * It folds the FINISHED sub-agent children; LIVE rows — running promoted
   * children and unpromoted agent-task rows — are never in its fold, because
   * they are the only trace of running work, and the selection is force-shown
   * regardless (`planChildRows`). Null when the thread has nothing foldable
   * (no finished children): a live-only nest needs no control. Default
   * collapsed: zero extra rows. Clicking toggles the in-memory state per
   * parent and NEVER selects the thread (stopPropagation) — the row around it
   * still selects as before. This absorbed the old `#agentToggle` caret, whose
   * fold could ALSO put live task rows away — a capability deliberately
   * dropped: running rows are transient and deduped now, and a thread whose
   * running work can be invisible is the failure the rows exist to prevent.
   */
  #childrenToggle(threadId: string): HTMLElement | null {
    const children = this.#childThreadsByParent.get(threadId)
    if (children === undefined || children.length === 0) return null
    const { disclosure } = this.#planChildRowsFor(threadId, children)
    if (disclosure === null) return null
    const caret = document.createElement('span')
    caret.className = 'fl-children-toggle'
    caret.style.cssText =
      'flex:none;display:inline-flex;align-items:center;cursor:pointer;color:var(--fl-color-text-secondary);'
    caret.title = disclosure.expanded
      ? 'Hide the sub-agents'
      : `Show ${String(disclosure.count)} sub-agent${disclosure.count === 1 ? '' : 's'}`
    const glyph = document.createElement('fl-icon')
    glyph.setAttribute('name', disclosure.expanded ? 'chevron-down' : 'chevron-right')
    glyph.setAttribute('size', '12')
    caret.appendChild(glyph)
    const stop = (event: Event): void => {
      event.stopPropagation()
      event.preventDefault()
    }
    caret.addEventListener('mousedown', stop)
    caret.addEventListener('click', (event) => {
      stop(event)
      if (this.#expandedChildThreads.has(threadId)) {
        this.#expandedChildThreads.delete(threadId)
      } else {
        this.#expandedChildThreads.add(threadId)
      }
      // A re-render, not a repaint: folding changes the ROW SET beneath this
      // one, and every index under it.
      this.#renderRows()
    })
    return caret
  }

  /** Render a task row: lane glyph · title · Done? · ⋯. */
  #renderTaskRow(task: TaskWithPin, thread: ThreadSummary | null): HTMLElement {
    const rowEl = document.createElement('div')
    const isActive = thread !== null && thread.id === this.#activeThreadId
    rowEl.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:8px',
      'width:100%',
      // The same label column the thread rows take — a task and a thread sit
      // side by side under one project header, so they share it.
      this.#scope.kind === 'workspace' ? 'padding-left:12px' : 'padding-left:26px',
      'overflow:hidden',
    ].join(';')
    // A RESTING TASK CARRIES NO BAR (2026-09-08). It used to draw a 2px
    // accent-muted border-left, pulled 2px into the row's padding — so an idle
    // task hung a short blue line in the gutter, unattached to anything, beside
    // rows that had none. The lane glyph is what says "this is a task", in the
    // column that already exists for it. The OPEN task takes the same accent
    // bar and fill as the open thread, from the same code path, so one row is
    // ever decorated and both kinds decorate alike (#1881).
    const selectionMark = sidebarRowMark({ active: isActive, multiSelected: false })
    if (selectionMark !== null) rowEl.classList.add(selectionMark)

    // Lane checkbox — distinct from the thread's chat-bubble glyph.
    const lane = document.createElement('fl-icon')
    lane.setAttribute('name', LANE_ICON[task.lane])
    lane.setAttribute('size', '12')
    lane.title = `Lane: ${task.lane}`
    lane.style.cssText = `flex:none;color:${LANE_COLOR[task.lane]};`
    rowEl.appendChild(lane)

    // WHAT ITS AGENT IS DOING, on the same terms as a thread row. A task row
    // drew its lane and nothing else, so a task whose chat was mid-turn — the
    // pulsing bubble every thread row gets, the amber dot for one waiting on an
    // answer — showed as still as a task nobody had opened. The user's report
    // was made on exactly this row: a Doing card with agents running under it,
    // and no sign of it anywhere in the list.
    //
    // The lane says where the WORK stands; this says whether its agent is
    // moving. Two facts, two marks, and the second one is the live one.
    const taskGlyph =
      thread === null ? null : threadGlyph(this.#liveStatus(thread), thread.originLoop)
    if (taskGlyph !== null) rowEl.appendChild(taskGlyph)
    // #1931 follow-up: a task's 1:1 thread can hold promoted children too —
    // the same ONE disclosure the thread row carries.
    const taskChildrenToggle = thread === null ? null : this.#childrenToggle(thread.id)
    if (taskChildrenToggle !== null) rowEl.appendChild(taskChildrenToggle)

    if (task.pinnedAt !== null) {
      const pin = document.createElement('fl-icon')
      pin.setAttribute('name', 'pin')
      pin.setAttribute('size', '11')
      pin.title = 'Pinned'
      pin.style.cssText = 'flex:none;color:var(--fl-color-text-secondary);'
      rowEl.appendChild(pin)
    }

    const title = document.createElement('span')
    title.style.cssText = [
      'flex:1',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'font-size:var(--fl-text-ui-size)',
      'color:var(--fl-color-text)',
      thread && thread.id === this.#activeThreadId
        ? 'font-weight:var(--fl-text-ui-weight-medium)'
        : 'font-weight:var(--fl-text-ui-weight)',
    ].join(';')
    title.textContent = task.title || 'Untitled task'
    title.title = task.externalKey ? `${task.externalKey} — ${task.title}` : task.title
    rowEl.appendChild(title)
    // Work still running past the task's turn reads as a count, not as working.
    const taskRunningTag = thread === null ? null : this.#runningTag(thread)
    if (taskRunningTag !== null) rowEl.appendChild(taskRunningTag)

    // NO "Done?" CHIP HERE (user call 2026-08-26: "remove it from the threads,
    // we don't need that"). The suggestion is unchanged and still offered on
    // the tasks board, which is where a task's lane is the subject; in a list
    // of conversations it was a lane control on a row nobody came to for
    // lanes, competing for the width the thread's own name needs.
    //
    // `suggestDone` is untouched: main still sets it on a clean turn and the
    // board's chip still accepts it in one click (kanban-board.ts), so nothing
    // about the signal or its one-click accept is lost — only this surface
    // stops carrying it.

    // Task actions are on right-click, like a thread row's — no ⋯ column.
    rowEl.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.#openTaskMenu(task, rowEl)
    })
    // A task carries no age, so its first rail cell is simply empty — which is
    // exactly why the cell exists rather than being conditionally absent.
    // A task carries no age at all, so it simply ends after its badge.
    const taskTag = this.#projectTag(task.projectRoot)
    if (taskTag !== null) rowEl.appendChild(taskTag)
    const taskMark = this.#contextIndicator(thread)
    if (taskMark !== null) rowEl.appendChild(taskMark)
    return rowEl
  }

  /**
   * The mark on a row whose thread can reach into other projects (#45, #1413 —
   * re-shaped 2026-08-26 on the user's call: "just an icon on the right side
   * of the top as an indicator … and if the user hover the mouse there we show
   * those").
   *
   * WHY IT IS NOT THE NAMES ANY MORE. The names were on the row: first beside
   * the title, where `flex:none` let them take every pixel they wanted and the
   * title rendered as "A…"; then on a second line, which cost every such row
   * an extra 18px of a sidebar whose whole job is to list things. The NAMES
   * are reference — you read them when you are asking "where can this thread
   * write?" — and the FACT is the glance. Only the fact stays on the row.
   *
   * IT STILL SAYS HOW MANY, because one other project and five are different
   * risks and an icon alone cannot tell them apart. The names arrive on hover.
   *
   * Not a bare tooltip: `title` gives no styling, no control over the delay,
   * and cannot render the chips this is meant to show. The balloon is a real
   * element (`#showContextBalloon`).
   */
  #contextIndicator(thread: ThreadSummary | null): HTMLElement | null {
    if (thread === null) return null
    const roots = thread.additionalRoots
    const branch = thread.worktreeBranch?.trim() ?? ''
    const hasCopy = thread.worktreePath !== null
    if (roots.length === 0 && !hasCopy) return null

    // ONE MARK PER ROW, EVEN WHEN THERE ARE TWO FACTS.
    //
    // A worktree glyph and a projects badge were drawn side by side, so the
    // threads that have the most going on — a copy of their own AND several
    // projects in reach — were the ones whose titles lost the most width, to
    // two marks the eye reads as one cluster anyway (user, 2026-09-17: "lets
    // combine with the context one, using only one for those that we have
    // two"). The glyph carries WHICH it is, the count carries HOW MANY, and
    // the hover carries the rest.
    const reach =
      roots.length === 0
        ? ''
        : `Also reaches ${roots.length} other ${
            roots.length === 1 ? 'project' : 'projects'
          }: ${roots.map((root) => projectName(root)).join(', ')}`
    const copy = !hasCopy ? '' : branch === '' ? 'Its own worktree' : `Its own worktree — ${branch}`
    const mark = document.createElement('span')
    mark.tabIndex = 0
    mark.setAttribute('role', 'button')
    // The accessible name carries the whole answer, because a screen reader
    // gets no hover: a mark that only says "2" tells it nothing it can use.
    mark.setAttribute('aria-label', [copy, reach].filter((part) => part !== '').join(' · '))
    // …and for a copy with no other projects there is no balloon to open, so
    // the plain tooltip is the only place the sentence can live.
    if (roots.length === 0) mark.title = copy
    mark.style.cssText = [
      'flex:none',
      'display:inline-flex',
      'align-items:center',
      'gap:2px',
      'padding:0 4px',
      'border-radius:var(--fl-radius-sm)',
      // REACH IS THE LOUD FACT. Another project in the blast radius is worth an
      // accent; a conversation working in its own copy is worth knowing and not
      // worth shouting, so on its own it stays in the row's own ink.
      roots.length === 0 ? 'color:var(--fl-color-text-secondary)' : 'color:var(--fl-color-accent)',
      roots.length === 0 ? 'opacity:0.7' : 'background:var(--fl-color-accent-muted)',
      'font-size:var(--fl-text-caption-size)',
      'line-height:16px',
      'cursor:default',
    ].join(';')

    // THE COUNT COMES FIRST, SO THE GLYPH ENDS THE MARK.
    //
    // It used to follow the icon, which meant a row with a count drew its glyph
    // ~9px further left than the row above it — measured at three different x
    // positions down one list (user, 2026-09-18: "we need to centralize that
    // icon, all should be aligned on the same position"). The mark sits
    // immediately before the date, so whatever is LAST in it is what lands on a
    // predictable pixel; making that the glyph puts every row's glyph in one
    // column and lets the count grow leftwards into the title's slack.
    //
    // One extra project is what the icon already says; a number beside it would
    // be a "1" that adds nothing.
    if (roots.length > 1) {
      const count = document.createElement('span')
      count.textContent = String(roots.length)
      mark.appendChild(count)
    }

    const icon = document.createElement('fl-icon')
    // THE GLYPH SAYS WHICH KIND OF MARK THIS IS: the folder-on-a-branch the
    // worktree panel uses, or the plain folder for reach alone. Same glyph,
    // same meaning, wherever the reader meets it.
    icon.setAttribute('name', hasCopy ? 'checkouts' : 'folder')
    // ONE SIZE FOR BOTH. `fl-icon`'s box IS its size, so an 11 beside a 12 is a
    // column of glyphs that cannot line up however they are laid out.
    icon.setAttribute('size', '12')
    icon.style.flex = 'none'
    mark.appendChild(icon)

    // Hover AND focus, because the mark is reachable by keyboard and a
    // reveal only a mouse can trigger is not a reveal for everyone.
    if (roots.length > 0) {
      mark.addEventListener('mouseenter', () => this.#showContextBalloon(mark, roots))
      mark.addEventListener('focus', () => this.#showContextBalloon(mark, roots))
    }
    mark.addEventListener('mouseleave', () => this.#hideContextBalloon())
    mark.addEventListener('blur', () => this.#hideContextBalloon())
    // Clicking a row opens its thread; the mark is a label, not a second
    // target, so it must not swallow that or act as one.
    mark.addEventListener('mousedown', (event) => event.stopPropagation())
    return mark
  }

  /** The open balloon, or null. At most one — it follows the pointer's mark. */
  #contextBalloon: HTMLElement | null = null
  #contextBalloonWatch: MutationObserver | null = null
  #contextBalloonScroll: (() => void) | null = null

  /**
   * Show the projects a thread reaches into, beside their mark.
   *
   * BODY-MOUNTED, because the row it belongs to lives inside `<fl-list>`'s
   * shadow root and is clipped to its own height — a balloon rendered in the
   * row would be sliced off at the row's edge, which is the same wall the
   * two-line row ran into.
   *
   * It watches its anchor for the #1400 reason: these are positioned once from
   * a rect, and ⌘B removes the whole sidebar the anchor sits in, which used to
   * leave a popup floating over the conversation pointing at nothing.
   */
  #showContextBalloon(anchor: HTMLElement, roots: readonly string[]): void {
    this.#hideContextBalloon()
    const balloon = document.createElement('div')
    balloon.setAttribute('role', 'tooltip')
    balloon.style.cssText = [
      'position:fixed',
      // The same layer this sidebar's own body-mounted popups use (1000): at
      // 60 the balloon was BEHIND the panel it belongs to — present in the
      // DOM, reported visible, and invisible on screen.
      'z-index:1000',
      'display:flex',
      'flex-wrap:wrap',
      'align-items:center',
      'gap:4px',
      'max-width:280px',
      'padding:5px 6px',
      'border:var(--fl-border-width) solid var(--fl-color-border)',
      'border-radius:var(--fl-radius-sm)',
      'background:var(--fl-color-surface-raised)',
      'box-shadow:var(--fl-shadow-md)',
      'pointer-events:none',
    ].join(';')

    for (const root of roots) {
      const chip = document.createElement('span')
      chip.textContent = `+${projectName(root)}`
      chip.title = root
      chip.style.cssText = [
        'flex:none',
        'white-space:nowrap',
        'font-size:var(--fl-text-caption-size)',
        'line-height:16px',
        'color:var(--fl-color-accent)',
        'background:var(--fl-color-accent-muted)',
        'border-radius:var(--fl-radius-sm)',
        'padding:0 5px',
      ].join(';')
      balloon.appendChild(chip)
    }

    document.body.appendChild(balloon)
    const rect = anchor.getBoundingClientRect()
    // Right-aligned to the mark, so a wide balloon grows back across the
    // sidebar it belongs to rather than off the window's right edge.
    const left = Math.max(8, Math.min(rect.right - balloon.offsetWidth, window.innerWidth - balloon.offsetWidth - 8))
    const below = rect.bottom + 4
    const top = below + balloon.offsetHeight > window.innerHeight
      ? Math.max(8, rect.top - balloon.offsetHeight - 4)
      : below
    balloon.style.left = `${left}px`
    balloon.style.top = `${top}px`
    this.#contextBalloon = balloon

    const watch = new MutationObserver(() => {
      if (!anchor.isConnected) this.#hideContextBalloon()
    })
    watch.observe(document.body, { childList: true, subtree: true })
    this.#contextBalloonWatch = watch
    // A WHEEL DOES NOT MOVE THE POINTER, so `mouseleave` never fires for a
    // reader who scrolls the list while the balloon is up — it would hang at
    // the rect its mark used to occupy, beside a different row. Capture,
    // because the scroll happens inside the list's own shadow scroller and
    // does not bubble to the document.
    const onScroll = (): void => this.#hideContextBalloon()
    document.addEventListener('scroll', onScroll, { capture: true, once: true })
    this.#contextBalloonScroll = onScroll
  }

  #hideContextBalloon(): void {
    this.#contextBalloonWatch?.disconnect()
    this.#contextBalloonWatch = null
    if (this.#contextBalloonScroll !== null) {
      document.removeEventListener('scroll', this.#contextBalloonScroll, { capture: true })
      this.#contextBalloonScroll = null
    }
    this.#contextBalloon?.remove()
    this.#contextBalloon = null
  }

  // ── Project group actions (collapse / reorder / remove) ────────────────────


  /** Move to a collapse mode: persist it, re-render the controls, and tell the
   *  shell about the CHAT half (#1219) — this panel owns the list, the shell
   *  owns the conversation panel. */
  #setCollapseMode(mode: ThreadsCollapseMode): void {
    this.#collapseMode = mode
    try {
      localStorage.setItem(THREADS_COLLAPSE_KEY, mode)
    } catch {
      // Private mode / quota — the mode still applies for this session.
    }
    this.#applyCollapseMode()
  }

  /** Render the current mode: the list's visibility, the restore hint, and the
   *  chat request. No control to re-label — the caret is gone and the `—` is
   *  drawn by the chat, which the `all-hidden` mode takes off screen. */
  #applyCollapseMode(options: { announceChat?: boolean } = {}): void {
    const view = threadsCollapseView(this.#collapseMode)
    this.#listWrap.hidden = !view.listVisible
    this.#restoreHint.hidden = view.restoreHint === null
    if (view.restoreHint !== null) this.#restoreHint.textContent = `${view.restoreHint} — show`
    // The shell owns the conversation panel — ask, don't reach. At BOOT the
    // ask is withheld unless the persisted mode actually hides it: a user who
    // closed the chat with ⌘⌥C must not have it reopened just because the
    // thread list is expanded.
    if (options.announceChat !== false) {
      document.dispatchEvent(
        new CustomEvent(view.chatVisible ? 'flow:show-chat' : 'flow:hide-chat'),
      )
    }
  }

  /**
   * How the Workspace's list is shown: its order, and whether it includes the
   * archive.
   *
   * ONE MENU FOR BOTH, because both are the same question asked twice — what
   * do I want to see here — and both belong to this project rather than to the
   * sidebar. The archive used to be a row under every project's threads at the
   * very bottom of the panel, which is what the reporter objected to: it is
   * about a project, so it is on the project.
   */
  #openProjectViewMenu(rootPath: string, anchor: HTMLElement): void {
    this.#closeMenu()
    const options = this.#viewOptionsFor(rootPath)
    const archived = this.#archivedCount()
    const menu = document.createElement('div')
    menu.className = 'fl-thread-menu'

    const heading = document.createElement('div')
    heading.className = 'fl-thread-menu-heading'
    heading.textContent = 'Order'
    menu.appendChild(heading)

    for (const entry of SIDEBAR_ORDERS) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'fl-thread-menu-item'
      const on = entry.value === options.order
      // The same "● <label>" mark the lane menus use for the current choice —
      // one vocabulary for "this is the one you are on".
      item.textContent = on ? `● ${entry.label}` : entry.label
      item.setAttribute('aria-checked', String(on))
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        this.#closeMenu()
        this.#setViewOptions(rootPath, { ...options, order: entry.value })
      })
      menu.appendChild(item)
    }

    const rule = document.createElement('div')
    rule.className = 'fl-thread-menu-rule'
    menu.appendChild(rule)

    const archive = document.createElement('button')
    archive.type = 'button'
    archive.className = 'fl-thread-menu-item'
    archive.textContent = options.showArchived
      ? `✓ ${archivedToggleLabel(archived)}`
      : archivedToggleLabel(archived)
    archive.setAttribute('aria-checked', String(options.showArchived))
    archive.title = archivedToggleTitle(options.showArchived, archived)
    // NOTHING TO SHOW IS NOT A PRESS. A project with an empty archive offers
    // the row so the reader can see the count is zero, and says why it cannot
    // act rather than toggling a filter that would change nothing.
    archive.disabled = archived === 0 && !options.showArchived
    archive.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
      this.#setViewOptions(rootPath, { ...options, showArchived: !options.showArchived })
    })
    menu.appendChild(archive)

    this.#mountMenu(menu, anchor)
  }

  /** This project's stored answers, or the defaults. Never throws. */
  #viewOptionsFor(rootPath: string): SidebarViewOptions {
    const cached = this.#viewOptions.get(rootPath)
    if (cached !== undefined) return cached
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(viewOptionsStorageKey(rootPath))
    } catch {
      stored = null
    }
    const options = readViewOptions(stored)
    this.#viewOptions.set(rootPath, options)
    return options
  }

  /**
   * Move an answer given before this list knew its Workspace onto the key it
   * resolved into, so the press a person made is the press that applies.
   *
   * Storage is the evidence a press happened: `#setViewOptions` is its only
   * writer, so a stored placeholder answer cannot be a default somebody merely
   * read. The in-memory entry is dropped either way — nothing should read the
   * placeholder again once the list has a name.
   */
  #carryViewOptionsForward(previousKey: string): void {
    const nextKey = this.#listKey()
    const stored = (key: string): string | null => {
      try {
        return window.localStorage.getItem(viewOptionsStorageKey(key))
      } catch {
        return null
      }
    }
    const previousStored = stored(previousKey)
    if (!carriesViewOptionsForward(previousKey, nextKey, previousStored, stored(nextKey))) {
      if (previousKey === UNRESOLVED_LIST_KEY) this.#viewOptions.delete(previousKey)
      return
    }
    const options = readViewOptions(previousStored)
    this.#viewOptions.set(nextKey, options)
    this.#viewOptions.delete(previousKey)
    try {
      window.localStorage.setItem(viewOptionsStorageKey(nextKey), writeViewOptions(options))
      window.localStorage.removeItem(viewOptionsStorageKey(previousKey))
    } catch {
      // The carry is a convenience; failing it costs the press, not the list.
    }
  }

  /** Remember them and repaint. Storage failing costs the preference, not the list. */
  #setViewOptions(rootPath: string, options: SidebarViewOptions): void {
    this.#viewOptions.set(rootPath, options)
    try {
      window.localStorage.setItem(viewOptionsStorageKey(rootPath), writeViewOptions(options))
    } catch {
      // A preference nobody could store is a preference nobody has.
    }
    this.#renderRows()
  }

  /** How many archived rows the open Workspace's list holds — threads and tasks alike. */
  #archivedCount(): number {
    const threads = this.#threads.filter(
      (thread) => thread.archivedAt !== null && this.#inScope(thread.projectRoot),
    ).length
    const tasks = this.#tasks.filter(
      (task) =>
        task.archivedAt !== null && this.#inScope(task.projectRoot) && taskBelongsInSidebar(task),
    ).length
    return threads + tasks
  }

  /**
   * Compact accent-picker popover (user request 2026-07-28): the 8 curated
   * palette swatches + "Auto" (clears the override → hash accent). Opened
   * from the ⋯ project menu's "Project color…" item (the group header itself
   * stays neutral). Selecting persists via project:setRootAccent — the ONE
   * write path — and every surface repaints live off
   * rootsChanged/threadScopeChanged. Escape and outside-click close via the
   * shared #mountMenu chrome.
   */
  #openAccentMenu(rootPath: string, anchor: HTMLElement): void {
    this.#closeMenu()
    const root = this.#roots.find((candidate) => candidate.rootPath === rootPath)
    const model = accentPickerModel(rootPath, root?.accentColor ?? null)
    const menu = document.createElement('div')
    menu.className = 'fl-thread-menu'

    const heading = document.createElement('div')
    heading.className = 'fl-thread-menu-confirm'
    heading.textContent = 'Project color'
    menu.appendChild(heading)

    const persist = (color: string | null): void => {
      this.#closeMenu()
      const projectName = baseName(rootPath)
      void window.flow.project
        .setRootAccent({ rootPath, color })
        .then(() => {
          // #1211: SAY that it landed. Every accent consumer (file-tree section
          // header, git group head, terminal/editor tab dot, pending-changes
          // header) is multi-root-only, so on an ordinary single-project thread
          // — the default — picking a colour painted nothing anywhere and
          // reported nothing. The value IS persisted, which made it worse: the
          // user concludes the feature is broken and picks again.
          //
          // The sidebar stays neutral by deliberate product decision (the same
          // one that moved this picker into the ⋯ menu), so the confirmation is
          // a toast, and it says WHERE the colour will show rather than
          // pretending it is already visible.
          this.#notify(
            rootPath,
            color === null ? `${projectName}: project color cleared` : `${projectName}: project color set`,
            'Project colors mark the file tree, Source Control and tab dots when more than one project is in view.',
          )
        })
        .catch((error: unknown) => {
          console.error('flow: failed to set project color', error)
          this.#notify(rootPath, "Couldn't set the project color", 'Try again.', 'error')
        })
    }

    const grid = document.createElement('div')
    grid.className = 'fl-accent-swatch-grid'
    model.swatches.forEach((swatch, index) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'fl-accent-swatch'
      if (swatch.selected) btn.classList.add('selected')
      btn.style.background = swatch.paint
      btn.setAttribute('aria-label', `Project color ${index + 1}`)
      btn.title = swatch.color
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        persist(swatch.color)
      })
      grid.appendChild(btn)
    })
    menu.appendChild(grid)

    const auto = document.createElement('button')
    auto.type = 'button'
    auto.className = 'fl-thread-menu-item'
    auto.textContent = model.autoSelected ? 'Auto ✓' : 'Auto'
    auto.title = 'Use the automatic project color'
    auto.addEventListener('click', (event) => {
      event.stopPropagation()
      persist(null)
    })
    menu.appendChild(auto)

    this.#mountMenu(menu, anchor)
  }

  /**
   * One project's actions — new thread or task in it, its settings, its
   * colour, archiving its threads, removing it. Opened from the Workspace
   * switcher's project rows (`flow:project-menu`): the one list has no
   * per-project header to carry them any more.
   */
  #openProjectMenu(rootPath: string, anchor: HTMLElement): void {
    this.#closeMenu()
    const menu = document.createElement('div')
    menu.className = 'fl-thread-menu'
    const known = this.#roots.some((root) => root.rootPath === rootPath)
    const available = this.#roots.find((root) => root.rootPath === rootPath)?.available !== false

    const addItem = (label: string, onClick: () => void, disabled = false, danger = false): void => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'fl-thread-menu-item'
      if (danger) item.classList.add('danger')
      item.disabled = disabled
      if (disabled) item.style.opacity = '0.4'
      item.textContent = label
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        if (disabled) return
        this.#closeMenu()
        onClick()
      })
      menu.appendChild(item)
    }

    // Creating in a folder that isn't there makes nothing (#263).
    if (available) {
      addItem('New thread', () => void this.#createThread(rootPath))
      // Dangerous opt-in (#751) — same affordance the New-task modal offers: the
      // thread's agent runs with permission prompts skipped from its first turn.
      addItem('New thread — skip permissions (dangerous)', () =>
        void this.#createThread(rootPath, { bypassPermissions: true }),
      )
      addItem('New task', () => this.#promptNewTask(anchor, rootPath))
    }
    addItem('Flow settings', () => {
      document.dispatchEvent(
        new CustomEvent<{ rootPath: string }>('flow:open-flow-settings', {
          detail: { rootPath },
        }),
      )
    })
    addItem('Import Claude history', () => {
      void this.#importClaudeHistory(rootPath)
    })
    // Accent picker entry (user call 2026-07-28: the sidebar header stays
    // neutral — no colored icon/dot — so the picker lives here). Known roots
    // only: an orphan root has no project record to persist the color on.
    if (known) {
      addItem('Project color…', () => this.#openAccentMenu(rootPath, anchor))
    }
    // Archive-all (#730): an old project can carry a long thread history —
    // archiving one-by-one is tedious. Opens an IN-MENU confirmation with the
    // exact count (mirroring Remove), so a misclick can't mass-archive.
    const activeThreads = this.#threads.filter(
      (t) => t.projectRoot === rootPath && t.archivedAt === null,
    ).length
    const archiveAll = document.createElement('button')
    archiveAll.type = 'button'
    archiveAll.className = 'fl-thread-menu-item'
    archiveAll.textContent = 'Archive all threads'
    archiveAll.disabled = activeThreads === 0
    if (activeThreads === 0) archiveAll.style.opacity = '0.4'
    archiveAll.addEventListener('click', (event) => {
      event.stopPropagation()
      if (activeThreads === 0) return
      void this.#confirmArchiveAll(rootPath, menu)
    })
    menu.appendChild(archiveAll)
    // Remove opens an inline confirmation (it's destructive — deletes the
    // project's threads too), instead of closing the menu and acting silently.
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'fl-thread-menu-item danger'
    remove.textContent = 'Remove from sidebar'
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      void this.#confirmRemoveProject(rootPath, menu)
    })
    menu.appendChild(remove)

    this.#mountMenu(menu, anchor)
  }

  /** Replace the project menu body with a remove confirmation (destructive:
   *  removing a project also deletes its threads + tasks).
   *
   *  The counts come from the STORE, never from `#threads`/`#tasks` — those
   *  hold the search-filtered subset while a query is active, but the cascade
   *  (main/project/remove-project.ts) deletes EVERY thread + task of the
   *  root, archived included. A destructive prompt that quotes a count must
   *  count the destruction, not the view (#1082). */
  async #confirmRemoveProject(rootPath: string, menu: HTMLElement): Promise<void> {
    let counts: string[]
    let closing = ''
    try {
      const [threadRecords, taskRecords, terminalRecords] = await Promise.all([
        window.flow.threads.list({ projectRoot: rootPath, includeArchived: true }),
        window.flow.tasks.list({ projectRoot: rootPath, includeArchived: true }),
        // #1484: the cascade now closes the project's shells too, so the prompt
        // has to say so. A `npm run dev` is exactly the thing a user would want
        // to know about before confirming, and it was the one item in the
        // destruction the copy never named.
        window.flow.terminal.list().catch(() => []),
      ])
      const threads = threadRecords.length
      const tasks = taskRecords.length
      const terminals = terminalRecords.filter(
        (terminal) => terminal.projectRoot === rootPath && terminal.exited !== true,
      ).length
      counts = [
        threads > 0 ? `${threads} thread${threads === 1 ? '' : 's'}` : '',
        tasks > 0 ? `${tasks} task${tasks === 1 ? '' : 's'}` : '',
      ].filter(Boolean)
      // Terminals are CLOSED, not deleted — kept out of the delete list so the
      // sentence stays true about each kind of destruction (#1484).
      closing =
        terminals > 0 ? `${terminals} running terminal${terminals === 1 ? '' : 's'}` : ''
    } catch (error) {
      // Can't count → say "all" rather than quote a number that may be wrong
      // (the filtered view is exactly the lie #1082 removed).
      console.error('flow: failed to count threads/tasks for remove confirm', error)
      counts = ['threads + tasks (count unavailable)']
    }
    // The menu can close (Escape / outside click) while the counts load.
    if (!menu.isConnected) return
    menu.textContent = ''
    const label = document.createElement('div')
    label.className = 'fl-thread-menu-confirm'
    const destruction = counts.length ? ` and delete its ${counts.join(' + ')}` : ''
    const shells = closing ? `, closing ${closing}` : ''
    label.textContent =
      destruction || shells
        ? `Remove ${baseName(rootPath)}${destruction}${shells}?`
        : `Remove ${baseName(rootPath)} from the sidebar?`
    const actions = document.createElement('div')
    actions.className = 'fl-thread-menu-actions'
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'fl-thread-menu-item danger'
    remove.textContent = 'Remove'
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
      this.#removeProject(rootPath)
    })
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-thread-menu-item'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
    })
    actions.append(cancel, remove)
    menu.append(label, actions)
  }

  /** Menu for a ⌘-click multi-selection (#730): archive the selected threads
   *  behind a counted confirmation, or clear the selection. */
  #openSelectionMenu(anchor: HTMLElement): void {
    this.#closeMenu()
    const targets = this.#threads.filter(
      (t) => this.#selectedThreadIds.has(t.id) && t.archivedAt === null,
    )
    const menu = document.createElement('div')
    menu.className = 'fl-thread-menu'

    const archive = document.createElement('button')
    archive.type = 'button'
    archive.className = 'fl-thread-menu-item'
    archive.textContent = `Archive ${targets.length} selected thread${targets.length === 1 ? '' : 's'}`
    archive.disabled = targets.length === 0
    if (targets.length === 0) archive.style.opacity = '0.4'
    archive.addEventListener('click', (event) => {
      event.stopPropagation()
      if (targets.length === 0) return
      // Counted confirmation (the #730 guard), mirroring archive-all's shape.
      menu.textContent = ''
      const label = document.createElement('div')
      label.className = 'fl-thread-menu-confirm'
      label.textContent = `Archive ${targets.length} selected thread${targets.length === 1 ? '' : 's'}?`
      const actions = document.createElement('div')
      actions.className = 'fl-thread-menu-actions'
      const confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.className = 'fl-thread-menu-item'
      confirm.textContent = 'Archive'
      confirm.addEventListener('click', (inner) => {
        inner.stopPropagation()
        this.#closeMenu()
        this.#selectedThreadIds.clear()
        void this.#archiveAllThreads(targets)
      })
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'fl-thread-menu-item'
      cancel.textContent = 'Cancel'
      cancel.addEventListener('click', (inner) => {
        inner.stopPropagation()
        this.#closeMenu()
      })
      actions.append(cancel, confirm)
      menu.append(label, actions)
    })
    menu.appendChild(archive)

    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'fl-thread-menu-item'
    clear.textContent = 'Clear selection'
    clear.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
      this.#selectedThreadIds.clear()
      this.#list.refresh()
    })
    menu.appendChild(clear)

    this.#mountMenu(menu, anchor)
  }

  /** Replace the project menu body with an archive-all confirmation (#730):
   *  shows the exact thread count so a misclick can't silently mass-archive.
   *
   *  Targets come from the STORE, not the (possibly search-filtered) `#threads`
   *  view — the item says "all", so under an active filter it must still count
   *  and archive every active thread of the root (#1082 sibling). */
  async #confirmArchiveAll(rootPath: string, menu: HTMLElement): Promise<void> {
    let targets: ThreadSummary[]
    try {
      const records = await window.flow.threads.list({
        projectRoot: rootPath,
        includeArchived: false,
      })
      targets = records.filter((t) => t.archivedAt === null)
    } catch (error) {
      // Fall back to the local view (recoverable action — archive, not delete).
      console.error('flow: failed to count threads for archive-all confirm', error)
      targets = this.#threads.filter((t) => t.projectRoot === rootPath && t.archivedAt === null)
    }
    // The menu can close (Escape / outside click) while the counts load.
    if (!menu.isConnected) return
    menu.textContent = ''
    const label = document.createElement('div')
    label.className = 'fl-thread-menu-confirm'
    label.textContent = `Archive ${targets.length} thread${targets.length === 1 ? '' : 's'} in ${baseName(rootPath)}?`
    const actions = document.createElement('div')
    actions.className = 'fl-thread-menu-actions'
    const archive = document.createElement('button')
    archive.type = 'button'
    archive.className = 'fl-thread-menu-item'
    archive.textContent = 'Archive all'
    archive.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
      void this.#archiveAllThreads(targets)
    })
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-thread-menu-item'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
    })
    actions.append(cancel, archive)
    menu.append(label, actions)
  }

  /** Archive every given thread; per-thread fail-soft so one failure doesn't
   *  abandon the rest (the threads:updated broadcast refreshes the list). */
  async #archiveAllThreads(targets: ThreadSummary[]): Promise<void> {
    const results = await Promise.allSettled(
      targets.map((thread) =>
        window.flow.threads.update({ threadId: thread.id, patch: { archived: true } }),
      ),
    )
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed > 0) {
      console.error(`flow: archive-all — ${failed} of ${targets.length} threads failed to archive`)
    }
  }

  #removeProject(rootPath: string): void {
    // Auto-activate the next AVAILABLE project (never rebind to an unmounted one) —
    // mirrors the group-click guard #263 added, closing the auto-activation gap (#350).
    if (rootPath === this.#activeRoot) {
      const next = nextActiveRootAfterRemove(this.#roots, rootPath)
      if (next) this.#activateProject(next)
    }
    // Cascade delete (tasks + threads + root) — a project with threads otherwise
    // survives as an "orphan" group. tasks:updated / threads:updated / rootsChanged
    // all re-render the sidebar.
    void window.flow.project
      .remove({ rootPath })
      .catch((error: unknown) => console.error('flow: failed to remove project', error))
  }

  /**
   * Give a thread a branch of its own to work on.
   *
   * THE PROTOCOL IS NOT HERE ANY MORE. `prepareThreadWorktree` owns the
   * two-call prepare-then-ask dance and the rule that an unanswered question
   * makes nothing; the composer's send path calls exactly the same function
   * with exactly the same question, so the two entry points cannot drift
   * (allowed-pattern #14). `requested` still marks this as a person's own
   * decision — that is what lets main retry a repository that refused earlier,
   * and what lets it drop an IDLE session so the next turn starts on the new
   * branch. A thread mid-turn is told to wait rather than quietly promised
   * something that would not take effect until the turn after next.
   *
   * WHERE IT STARTS IS NOT ASKED HERE ANY MORE. The starting point is chosen
   * on the composer's own chip when a conversation is created, which is the
   * moment a person is already deciding what this work is; asking it again
   * from a row menu meant a second dialog for a question that was settled,
   * and the dialog that asked it is gone. Omitting `start` leaves the answer
   * where it belongs — main's, from this project's own setting.
   *
   * THE CARRY QUESTION OPENS ON THE ROW'S OWN BUTTON. `#closeMenu` has already
   * run by the time this is called, but the ⋯ the person pressed is still on
   * screen — so the menu grows out of the control they used rather than
   * arriving as a modal over the whole window.
   *
   * A DISMISSAL IS SILENT. There is nothing to report: they were asked a
   * question and did not answer it, which is not the same event as Flow being
   * unable to do something, and a toast saying so would be the app telling
   * somebody off for changing their mind.
   */
  async #giveWorktree(thread: ThreadSummary, anchor: HTMLElement): Promise<void> {
    const threads = window.flow.threads
    if (typeof threads.prepareWorktree !== 'function') return
    try {
      const outcome = await prepareThreadWorktree(
        {
          prepare: (request) => threads.prepareWorktree(request),
          askCarry: (question) => askCarryInline({ anchor }, question),
        },
        { threadId: thread.id, requested: true },
      )
      if (outcome.kind === 'dismissed') return
      const notice = worktreeActionNotice(outcome.result, thread.title)
      this.#notify(thread.projectRoot, notice.title, notice.body, notice.level)
    } catch (error: unknown) {
      console.error('flow: failed to give the thread a branch of its own', error)
      this.#notify(
        thread.projectRoot,
        'Nothing changed',
        'Flow couldn’t set this thread up with a branch of its own. It keeps working in the project’s files.',
        'error',
      )
    }
  }

  // ── Row actions menu (rename / archive / delete) ───────────────────────────

  /** Open the actions menu anchored to a row's ⋯ button (light DOM overlay). */
  #openRowMenu(thread: ThreadSummary, anchor: HTMLElement): void {
    this.#closeMenu()
    const menu = document.createElement('div')
    menu.className = 'fl-thread-menu'
    const isArchived = thread.archivedAt !== null
    const isPinned = thread.pinnedAt !== null

    const addItem = (label: string, onClick: () => void, danger = false): void => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'fl-thread-menu-item'
      if (danger) item.classList.add('danger')
      item.textContent = label
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        onClick()
      })
      menu.appendChild(item)
    }

    addItem(isPinned ? 'Unpin' : 'Pin', () => {
      this.#closeMenu()
      void this.#setPinned(thread, !isPinned)
    })
    addItem('Rename', () => this.#promptRename(thread, menu))
    // "Add folder to context" (#695): checkbox list of the other open projects
    // plus a Browse… escape hatch for folders not yet opened in Flow — always
    // offered (user request 2026-07-22).
    addItem('Add folder to context…', () => {
      this.#closeMenu()
      this.#openContextRoots(thread)
    })
    // THE LAST DOOR LEFT, and the only one this thread still needs. The
    // starting choice is made on the composer's chip when a conversation is
    // created; this is for the conversation that was already running in the
    // project when somebody decided it should not be. The checkout segment in
    // the status footer offered the same thing and is gone — one door, through
    // `prepare`, which the gate does not touch.
    //
    // IT SAYS BRANCH, because that is what a person gets and the only part of
    // it they will ever see again. The noun this menu used described the
    // directory Flow makes behind the branch, which is Flow's business and
    // not a thing anybody asked for.
    if (canOfferWorktree(thread)) {
      addItem('Give it its own branch…', () => {
        this.#closeMenu()
        void this.#giveWorktree(thread, anchor)
      })
    }
    addItem(isArchived ? 'Unarchive' : 'Archive', () => {
      this.#closeMenu()
      void this.#setArchived(thread, !isArchived)
    })
    addItem('Delete', () => this.#confirmDelete(thread, menu), true)

    this.#mountMenu(menu, anchor)
  }

  /**
   * Manage a thread's ADDITIONAL context folders (#695): a checkbox list of the
   * other open projects, pre-checked with the thread's current additional roots.
   * Applying replaces the thread's additional-root set via threads:setRoots — the
   * agent reads the new folders on its next turn. Cancel/Escape leaves it unchanged.
   */
  /**
   * Open the context-folder dialog, and SAY SO when it cannot open.
   *
   * `void promptContextRoots(...)` was the whole call: an async function whose
   * rejection went nowhere, so any failure inside it — a missing bridge method,
   * a root list that would not resolve — read to the user as a menu item that
   * does nothing at all. A press must answer, and "it did not work" is an
   * answer; silence is not.
   */
  #openContextRoots(thread: ThreadSummary): void {
    try {
      void this.#promptContextRoots(thread).catch((error: unknown) => {
        console.error('flow: context folders dialog failed', error)
        this.#contextRootsFailed(thread.projectRoot)
      })
    } catch (error) {
      // A synchronous throw before the first await — the dialog is built inline,
      // so this is the path that produced a dead menu item.
      console.error('flow: context folders dialog could not open', error)
      this.#contextRootsFailed(thread.projectRoot)
    }
  }

  /** One sentence, in the terms of the thing on screen. */
  #contextRootsFailed(rootId: string): void {
    this.#notify(
      rootId,
      "Couldn't open the context folders",
      'Flow could not put the folder list on screen. Try again, and tell us if it keeps happening.',
      'error',
    )
  }

  async #promptContextRoots(thread: ThreadSummary): Promise<void> {
    const others = availableRoots(this.#roots).filter((root) => root.rootPath !== thread.projectRoot)
    const current = new Set(thread.additionalRoots)

    const selected = await new Promise<string[] | null>((resolve) => {
      const overlay = document.createElement('div')
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);'
      overlay.className = 'fl-context-roots-overlay'
      const panel = document.createElement('div')
      panel.style.cssText = [
        'min-width:320px;max-width:92vw;max-height:70vh;overflow:auto',
        'background:var(--fl-color-surface)',
        'border:var(--fl-border-width) solid var(--fl-color-border)',
        'border-radius:var(--fl-radius-lg);padding:var(--fl-space-lg)',
        'display:flex;flex-direction:column;gap:var(--fl-space-sm)',
      ].join(';')
      const heading = document.createElement('div')
      heading.textContent = 'Context folders for this thread'
      heading.style.cssText =
        'font-weight:var(--fl-text-ui-weight-medium);margin-bottom:var(--fl-space-xs);'
      const hint = document.createElement('div')
      hint.textContent = `The agent also reads these folders (beyond ${projectName(thread.projectRoot)}).`
      hint.style.cssText =
        'font-size:var(--fl-text-caption-size);color:var(--fl-color-text-secondary);margin-bottom:var(--fl-space-sm);'
      panel.append(heading, hint)

      const checks: HTMLInputElement[] = []
      const list = document.createElement('div')
      list.style.cssText = 'display:flex;flex-direction:column;gap:var(--fl-space-sm);'
      panel.appendChild(list)
      const addCheckboxRow = (rootPath: string, checked: boolean): void => {
        const row = document.createElement('label')
        row.style.cssText =
          'display:flex;align-items:center;gap:var(--fl-space-sm);font-size:var(--fl-text-ui-size);cursor:pointer;'
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.value = rootPath
        box.checked = checked
        const name = document.createElement('span')
        name.textContent = projectName(rootPath)
        name.title = rootPath
        row.append(box, name)
        list.appendChild(row)
        checks.push(box)
      }
      for (const root of others) addCheckboxRow(root.rootPath, current.has(root.rootPath))
      // Context roots the thread already carries that are NOT open projects
      // (added via Browse… earlier) still need a row, or Apply would drop them.
      for (const rootPath of thread.additionalRoots) {
        if (!others.some((root) => root.rootPath === rootPath)) addCheckboxRow(rootPath, true)
      }

      // Browse… (user request 2026-07-22): pick ANY folder from disk — the
      // screenshot case was a repo the agent needed that was never opened in
      // Flow, so the open-projects list couldn't offer it. The picked folder
      // is also added as a project root (no activation — the user's active
      // project must not change under them) so files/source-control know it.
      const browse = document.createElement('fl-button')
      browse.setAttribute('variant', 'ghost')
      browse.setAttribute('small', '')
      browse.className = 'fl-context-roots-browse'
      browse.textContent = '＋ Browse for another folder…'
      browse.addEventListener('click', () => {
        void window.flow.project.pickFolder().then((picked) => {
          if (picked === null || picked === thread.projectRoot) return
          const existing = checks.find((box) => box.value === picked)
          if (existing) {
            existing.checked = true
            return
          }
          void window.flow.project.add({ path: picked }).catch((error: unknown) => {
            console.warn('flow: could not add browsed folder as project root', { picked, error })
          })
          addCheckboxRow(picked, true)
        })
      })
      panel.appendChild(browse)

      const footer = document.createElement('div')
      footer.style.cssText =
        'display:flex;justify-content:flex-end;gap:var(--fl-space-sm);margin-top:var(--fl-space-md);'
      const done = (value: string[] | null): void => {
        overlay.remove()
        document.removeEventListener('keydown', onKeydown)
        resolve(value)
      }
      const onKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') done(null)
      }
      const cancel = document.createElement('fl-button')
      cancel.setAttribute('variant', 'ghost')
      cancel.setAttribute('small', '')
      cancel.textContent = 'Cancel'
      cancel.addEventListener('click', () => done(null))
      const apply = document.createElement('fl-button')
      apply.setAttribute('variant', 'primary')
      apply.setAttribute('small', '')
      apply.className = 'fl-context-roots-apply'
      apply.textContent = 'Apply'
      apply.addEventListener('click', () =>
        done(checks.filter((box) => box.checked).map((box) => box.value)),
      )
      footer.append(cancel, apply)
      panel.appendChild(footer)
      overlay.appendChild(panel)
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) done(null)
      })
      document.addEventListener('keydown', onKeydown)
      document.body.appendChild(overlay)
    })

    if (selected === null) return
    try {
      await window.flow.threads.setRoots({ threadId: thread.id, roots: selected })
      await this.refresh()
      // Decoupled surfaces (the git panel's thread-spanning roots) track the
      // ACTIVE thread's roots — tell them when those change mid-thread.
      document.dispatchEvent(
        new CustomEvent<{ threadId: string; additionalRoots: string[] }>('flow:thread-roots-changed', {
          detail: { threadId: thread.id, additionalRoots: selected },
        }),
      )
    } catch (error) {
      console.error('flow: failed to set thread context roots', error)
    }
  }

  /** Replace the menu body with an inline rename field. */
  #promptRename(thread: ThreadSummary, menu: HTMLElement): void {
    menu.textContent = ''
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'fl-thread-menu-input'
    input.value = thread.title
    input.setAttribute('aria-label', 'Thread name')
    // One-shot guard: commit/cancel tear the menu down, which fires the input's
    // blur — without it the blur handler would re-enter commit (or resurrect a
    // deliberately-Escaped rename).
    let done = false
    // Assigned below, once the window listener is attached; every way out of
    // the field calls it (and the menu's own cleanup does too).
    let stopListening = (): void => undefined
    const commit = (): void => {
      if (done) return
      done = true
      stopListening()
      const title = input.value.trim()
      this.#closeMenu()
      if (title.length > 0 && title !== thread.title) {
        void this.#rename(thread, title)
      }
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        done = true // deliberate cancel — the teardown blur must not commit
        stopListening()
        this.#closeMenu()
      }
    })
    // ESCAPE IS DECIDED BEFORE THE MENU HEARS IT. The menu's keyboard handler
    // (attachMenuKeyboard) listens on `document` in the capture phase, so it
    // saw Escape first and closed the menu — and the blur that removal fires
    // committed the name the person had just asked to throw away. A window
    // capture listener runs ahead of every document listener, so the cancel
    // is recorded before any teardown starts.
    const onWindowKey = (event: KeyboardEvent): void => {
      if (!input.isConnected) {
        stopListening()
        return
      }
      if (event.key === 'Escape' && document.activeElement === input) done = true
    }
    // Removed by the field's own teardown — commit, Escape, or the menu
    // closing any other way — never left for the next keydown to find.
    stopListening = listenUntilRemoved<KeyboardEvent>(window, 'keydown', onWindowKey, true)
    this.#menuCleanup = chainCleanup(this.#menuCleanup, stopListening)
    menu.appendChild(input)
    // BLUR MEANS "I CLICKED AWAY", AND IT ONLY MEANS THAT ONCE THE FIELD HAS
    // ACTUALLY HELD FOCUS.
    //
    // Rename-on-blur (#719) is right: clicking away is the ordinary "I'm done"
    // gesture in every OS rename field, and before it, typing a name and
    // clicking elsewhere silently discarded it. What was wrong was WHEN the
    // listener was attached.
    //
    // `#promptRename` runs inside the Rename item's own click handler, and that
    // click is still being dispatched. Focusing here put the caret in a field
    // the browser had not finished settling focus for; the focus then moved on,
    // the input blurred, `commit` ran on an untouched value and tore the menu
    // down with it. Measured: the menu was GONE ~600ms after the click — zero
    // `.fl-thread-menu` elements, zero inputs. Rename by mouse could not be
    // used at all, and four e2e tests had been failing on it.
    //
    // So focus is taken on the next task, after the click has finished, and the
    // blur listener is attached only once the focus has actually landed. A
    // field that never held focus cannot report losing it.
    setTimeout(() => {
      if (done || !input.isConnected) return
      input.addEventListener('focus', () => input.addEventListener('blur', commit), { once: true })
      input.focus()
      input.select()
    }, 0)
  }

  /** Replace the menu body with a delete confirmation. */
  /**
   * The task delete's confirmation (#1390) — the mechanism the thread delete
   * beside it has had since #1173, applied to the larger loss.
   */
  #confirmDeleteTask(task: TaskSummary, menu: HTMLElement): void {
    menu.textContent = ''
    const label = document.createElement('div')
    label.className = 'fl-thread-menu-confirm'
    // Name it. "Are you sure?" over an unnamed subject is how the wrong row
    // gets deleted.
    label.textContent = `Delete “${task.title || 'Untitled task'}” and its chat?`
    const actions = document.createElement('div')
    actions.className = 'fl-thread-menu-actions'
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'fl-thread-menu-item danger'
    del.textContent = 'Delete both'
    del.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
      void this.#deleteTask(task)
    })
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-thread-menu-item'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
    })
    actions.append(cancel, del)
    menu.append(label, actions)
    // The SAFE default takes focus, never Delete (#1173).
    cancel.focus()
  }

  #confirmDelete(thread: ThreadSummary, menu: HTMLElement): void {
    menu.textContent = ''
    const label = document.createElement('div')
    label.className = 'fl-thread-menu-confirm'
    // A task and its chat are 1:1, and the task side of that pair is candid about
    // it ("Delete task + thread"). The thread side said only "Delete this
    // thread?", even though searching flattens a task's thread into an ordinary
    // row — so the user could unknowingly strip a task of its only chat (#1061).
    // Name the task when one owns this thread.
    const owner = this.#tasks.find((task) => task.threadId === thread.id)
    // Phase 6: a thread with a checkout of its own is a conversation AND a
    // branch with code on it. Say what is there — and say what becomes of it.
    // Work that lives nowhere else survives, because a click meant for a
    // conversation never destroys code; a copy holding nothing is freed with
    // the conversation rather than left on disk for nobody to find.
    const subject: ThreadDeleteSubject = {
      threadTitle: thread.title,
      hasWorktree: thread.worktreePath !== null,
      branch: thread.worktreeBranch,
      changedFiles: null,
      aheadCommits: null,
      owningTaskTitle: owner ? owner.title || 'Untitled task' : null,
    }
    const detail = document.createElement('div')
    detail.className = 'fl-thread-menu-confirm-detail'
    const paint = (): void => {
      const notice = threadDeleteNotice(subject)
      label.textContent = notice.question
      detail.textContent = notice.detail ?? ''
      detail.hidden = notice.detail === null
      del.textContent = notice.confirmLabel
    }
    const actions = document.createElement('div')
    actions.className = 'fl-thread-menu-actions'
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'fl-thread-menu-item danger'
    paint()
    del.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
      // READ AT PRESS TIME, not at paint time. The worktree read lands while
      // this confirm is on screen, so the sentence the user actually read is
      // the one computed from the subject as it stands NOW — and the decision
      // to free the copy is that same sentence's other half.
      void this.#delete(thread, threadDeleteNotice(subject).releaseWorktree)
    })
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-thread-menu-item'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
    })
    actions.appendChild(cancel)
    actions.appendChild(del)
    menu.appendChild(label)
    menu.appendChild(detail)
    menu.appendChild(actions)
    // #1173: the confirm swaps the menu's contents while it is already mounted,
    // so it focuses its own SAFE default — Cancel, never Delete. Enter on a
    // destructive confirm must not be the destructive answer.
    cancel.focus()
    // What the worktree is holding needs a read of the thread's own checkout,
    // so the confirm renders immediately with honest wording that omits it and
    // refines in place when it lands — the file-tree delete's pattern (#1187).
    // Fail-soft: an unreadable worktree keeps the count-free sentence rather
    // than guessing a number.
    //
    // THE LANDING PREVIEW, NOT A STATUS READ. Uncommitted files are only half
    // of "holds work that lives nowhere else" — a clean checkout sitting on a
    // week of commits the base has never seen is the other half, and a plain
    // status answers `ahead` against the UPSTREAM, which a `thread/*` branch
    // does not have. The preview is read-only and computes the two facts the
    // release path itself checks, from the same service (allowed-pattern #14),
    // so the sentence and the refusal can never disagree.
    if (thread.worktreePath !== null) {
      void window.flow.threads
        .landingPreview({ threadId: thread.id })
        .then((preview) => {
          if (!label.isConnected) return // the user already answered
          const repo = preview.repos[0]
          if (repo === undefined) return // nothing to read: keep the honest wording
          subject.changedFiles = repo.changedFiles
          subject.aheadCommits = repo.aheadCommits
          // The store's branch is written once; the preview reads the live one.
          if (repo.branch !== null && repo.branch !== '') subject.branch = repo.branch
          paint()
        })
        .catch(() => undefined)
    }
  }

  /** Position a menu under its anchor, in document.body, and wire dismissal. */
  #mountMenu(menu: HTMLElement, anchor: HTMLElement): void {
    document.body.appendChild(menu)
    const rect = anchor.getBoundingClientRect()
    const width = menu.offsetWidth || 180
    let left = rect.right - width
    if (left < 8) left = 8
    let top = rect.bottom + 4
    const overflow = top + menu.offsetHeight - window.innerHeight
    if (overflow > 0) top = Math.max(8, rect.top - menu.offsetHeight - 4)
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    this.#openMenu = menu

    const onDocDown = (event: MouseEvent): void => {
      if (!menu.contains(event.target as Node)) this.#closeMenu()
    }
    // #1400: WATCH THE ANCHOR. These popups are body-mounted at a one-shot
    // position computed from the anchor's rect, and dismissal was wired to
    // exactly two things — an outside mousedown and Escape. Nothing watched
    // the anchor, so ⌘B (which removes the whole activity sidebar the anchor
    // lives inside) left the menu floating over the conversation at the
    // identical rect, fully interactive, pointing at a row that was no longer
    // on screen.
    //
    // A menu whose anchor has left the SCREEN has nothing to be a menu FOR —
    // but "the anchor element is gone" and "the thing it pointed at is gone"
    // are not the same question in a virtualized list, and reading the first as
    // the second is a bug this watch shipped with.
    //
    // `<fl-list>` rebuilds its rows on every render, so a row's ⋯ button is
    // destroyed and recreated by any `threads:updated` batch — and a streaming
    // turn sends one every 50ms. The menu therefore closed itself while the row
    // was still right there. MEASURED: opening a row menu straight after
    // creating a thread and clicking Rename left zero menus and zero inputs;
    // waiting 4s for the batches to settle first left one of each. Rename by
    // mouse was unusable in exactly the moment people rename — just after
    // creating the thread — and three e2e tests had been failing on it.
    //
    // So the watch asks the question #1400 actually meant: is the surface this
    // menu belongs to still on screen? ⌘B removes the activity sidebar and the
    // container goes with it, which is the case that was being guarded; a row
    // re-render leaves it exactly where it was.
    const owner = this.#list.isConnected ? this.#list : anchor
    const anchorWatch = new MutationObserver(() => {
      if (!owner.isConnected) this.#closeMenu()
    })
    anchorWatch.observe(document.body, { childList: true, subtree: true })
    // #1173: the menu is keyboard-operable. Opening it used to drop focus on
    // <body>: arrows and Enter did nothing, and Tab walked the SIDEBAR controls
    // sitting BEHIND the open popup (+ New thread, Project actions, the list)
    // while the menu stayed on screen. These popups hold the only affordances
    // for pin / rename / archive / delete, and the destructive "Delete this
    // thread?" confirm was equally unreachable — Enter on it did nothing.
    //
    // #1300: these rules now live in ONE code path (menu-keyboard.ts). The
    // board's lane menu re-implemented this popup chrome from scratch and
    // inherited none of them; a rule restated per popup drifts.
    // Defer the outside-click listener so the opening click doesn't
    // immediately close it. attachMenuKeyboard focuses the first item — a
    // destructive confirm swaps these contents later and focuses Cancel itself.
    // A DISMISS CLOSED BEFORE THIS TIMER FIRES MUST NOT LEAVE ITS LISTENER BEHIND.
    // The add is deferred so the opening click cannot close the menu; the teardown
    // only ever removed a listener, so closing inside that one tick (Escape right
    // after opening, which is what a poll of this menu does) let the timer attach
    // `onOutside` for a panel that was already gone. Nothing could remove it, and
    // its closure tests a DETACHED element — so `!contains(target)` was true for
    // every later press, and the NEXT menu was dismissed on mousedown before the
    // click reached the item. Measured: the item's handler never ran, no write
    // happened, and the menu closed anyway.
    const onDocDownTimer = window.setTimeout(
      () => document.addEventListener('mousedown', onDocDown),
      0,
    )
    // A ROW anchor is not where the keyboard lives. Since the ⋯ button left
    // (2026-09-04) a row's menu anchors on the row's content — a plain div in
    // `<fl-list>`'s shadow root that cannot take focus and is recreated on
    // every render — so Escape focused nothing and stranded the user on
    // `<body>`. The list is the row's keyboard home: Escape returns there.
    const inList = anchor.getRootNode() === this.#list.shadowRoot
    const home = inList ? () => (this.#list.isConnected ? this.#list : null) : anchor
    const detachKeyboard = attachMenuKeyboard(menu, {
      close: () => this.#closeMenu(),
      anchor: home,
    })
    // ACTING closes the menu too, and that path never reached the anchor:
    // Pin, Archive, a committed rename or a confirmed delete removed the menu
    // that held focus and left the keyboard user on `<body>`. #closeMenu is
    // the one door every action leaves through, so it hands focus home there.
    this.#menuHome = home
    this.#menuCleanup = () => {
      window.clearTimeout(onDocDownTimer)
      document.removeEventListener('mousedown', onDocDown)
      anchorWatch.disconnect()
      detachKeyboard()
    }
  }

  #menuCleanup: (() => void) | null = null
  #menuHome: HTMLElement | (() => HTMLElement | null) | null = null

  #closeMenu(): void {
    // RE-ENTRANT BY DESIGN. Removing a menu that holds focus fires `blur` on
    // the focused field DURING the removal, and the rename field's blur
    // commits — which closes the menu again. Both fields are cleared before
    // anything is torn down, so the inner call finds nothing left to remove
    // (it used to remove the menu under the outer call, which then threw
    // "NotFoundError: … moved in a 'blur' event handler").
    const cleanup = this.#menuCleanup
    const menu = this.#openMenu
    const home = this.#menuHome
    this.#menuCleanup = null
    this.#openMenu = null
    this.#menuHome = null
    const hadFocus = menu?.contains(document.activeElement) ?? false
    cleanup?.()
    menu?.remove()
    // Only when the menu held the keyboard and its removal dropped it: a click
    // elsewhere has already put focus where the person wanted it.
    if (!hadFocus) return
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    const target = typeof home === 'function' ? home() : home
    if (target?.isConnected === true) target.focus()
  }

  async #rename(thread: ThreadSummary, title: string): Promise<void> {
    try {
      await window.flow.threads.update({ threadId: thread.id, patch: { title } })
      // A rename whose new title no longer matches an active filter would drop
      // its own subject out of the sidebar behind "No threads match …" (#977 —
      // #386's residual sibling). Clear the filter and re-render so the thread
      // the user just acted on stays visible; a still-matching rename leaves
      // the filter alone.
      if (shouldClearSearchOnThreadRename(this.#query, title)) {
        this.#clearSearch()
        await this.refresh()
      }
    } catch (error) {
      console.error('flow: failed to rename thread', error)
    }
  }

  async #setArchived(thread: ThreadSummary, archived: boolean): Promise<void> {
    try {
      await window.flow.threads.update({ threadId: thread.id, patch: { archived } })
    } catch (error) {
      console.error('flow: failed to archive thread', error)
    }
  }

  async #setPinned(thread: ThreadSummary, pinned: boolean): Promise<void> {
    // On the threads:updated refresh a pinned thread moves to the pinned band at
    // the top of its project (recency-exempt); unpinning drops it back to recent
    // or the "Show older" fold by its age.
    try {
      await window.flow.threads.update({ threadId: thread.id, patch: { pinned } })
    } catch (error) {
      console.error('flow: failed to pin thread', error)
    }
  }

  /**
   * Delete a thread, and deal with its worktree rather than orphaning it.
   *
   * ORDER IS LOAD-BEARING. The release looks its subject up BY THREAD ID, so a
   * copy released after the record is gone is exactly the orphan this exists to
   * prevent — a whole checkout of the project that nothing in the app would
   * ever mention again. Release first, delete second.
   *
   * `confirmed` IS THE PRESS, RELAYED. It comes from a button whose sentence
   * said the copy is freed (forbidden-pattern #15 wants an explicit say-so, not
   * a second decision about disk that nobody asked for). `allowUnlanded` is
   * NEVER sent from here: if the copy turns out to hold work living nowhere
   * else, the release path keeps it and the conversation goes alone — which is
   * the settled rule that a click meant for a conversation never destroys code.
   *
   * A failed release never blocks the delete. The person asked for the thread
   * to go; the copy that stayed is what the conversation files list is for.
   */
  async #delete(thread: ThreadSummary, releaseWorktree = false): Promise<void> {
    if (releaseWorktree && thread.worktreePath !== null) {
      try {
        await window.flow.threads.releaseWorktree({ threadId: thread.id, confirmed: true })
      } catch (error) {
        console.error('flow: failed to release the thread’s worktree', error)
      }
    }
    try {
      await window.flow.threads.delete({ threadId: thread.id })
    } catch (error) {
      console.error('flow: failed to delete thread', error)
    }
  }

  // ── Task actions ───────────────────────────────────────────────────────────

  /** Open the task actions menu: lanes · pin · rename · archive · delete. */
  #openTaskMenu(task: TaskWithPin, anchor: HTMLElement): void {
    this.#closeMenu()
    const menu = document.createElement('div')
    menu.className = 'fl-thread-menu'
    const isPinned = task.pinnedAt !== null
    // #1466: an archived task's only exit was "Delete task + thread", which
    // destroys the conversation too — so `Archive`, which sounds reversible,
    // was a one-way trip. The archived THREAD one row above has had its way
    // back since #695/#1391; this is the still-open half of #1391.
    const isArchived = task.archivedAt !== null

    const addItem = (label: string, onClick: () => void, active = false): void => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'fl-thread-menu-item'
      item.textContent = active ? `● ${label}` : label
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        this.#closeMenu()
        onClick()
      })
      menu.appendChild(item)
    }

    // Lanes are unobservable while the task is archived (#1466): the kanban
    // lists `includeArchived: false`, so picking one really did write
    // `lane=doing` with `archived_at` still set — a state change with no
    // visible effect anywhere in the app. Offer them once there is a board to
    // move the task on.
    if (!isArchived) {
      // Every lane the board renders, including Blocked — the row menu and the
      // board's card menu are one vocabulary (#1153), so a lane that exists on
      // one surface and not the other is exactly the drift both were built to
      // avoid: a task dropped into Blocked would be unreachable from here.
      // Review included: the lane joined the board (2026-09-08) and this list
      // was left at four — the very drift the line above exists to prevent.
      for (const lane of ['todo', 'doing', 'blocked', 'review', 'done'] as const) {
        addItem(LANE_LABEL[lane], () => void this.#setTaskLane(task, lane), task.lane === lane)
      }
    }
    addItem(isPinned ? 'Unpin' : 'Pin', () => void this.#setTaskPinned(task, !isPinned))
    addItem('Rename', () => this.#promptRenameTask(task, anchor))
    // #1413: the VERB, on the row that granted the access. A task created with
    // extra context folders gives its agent read/write over those other repos,
    // and this menu offered no way to review or revoke it — while the plain
    // thread's menu has had it since #695.
    // OFFERED WHETHER OR NOT THE CHAT EXISTS YET. It used to appear only for a
    // task that already owned a thread, so on a card nobody had opened the item
    // was simply absent — and "the control is not there" is indistinguishable
    // from "the app is broken" to the person looking for it. `ensureThread` is
    // the same idempotent call the card's own "Open chat" makes; the folders are
    // granted to the conversation it returns.
    addItem('Add folder to context…', () => {
      this.#closeMenu()
      const owning = this.#threadForTask(task)
      if (owning !== null) {
        this.#openContextRoots(owning)
        return
      }
      void window.flow.tasks
        .ensureThread({ taskId: task.id })
        .then((updated) => {
          const thread = updated.threadId === null ? null : this.#threadForTask(updated)
          if (thread !== null) {
            this.#openContextRoots(thread)
            return
          }
          // The thread exists in the store but not yet in this sidebar's
          // snapshot — refresh, then open against the fresh one.
          return this.refresh().then(() => {
            const fresh = this.#threadForTask(updated)
            if (fresh !== null) this.#openContextRoots(fresh)
            else this.#contextRootsFailed(task.projectRoot)
          })
        })
        .catch((error: unknown) => {
          console.error('flow: could not open the context folders for a task', error)
          this.#contextRootsFailed(task.projectRoot)
        })
    })
    addItem(isArchived ? 'Unarchive' : 'Archive', () =>
      void this.#setTaskArchived(task, !isArchived),
    )
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'fl-thread-menu-item danger'
    del.textContent = 'Delete task + thread'
    del.addEventListener('click', (event) => {
      event.stopPropagation()
      // #1390: CONFIRM FIRST. This has the biggest blast radius in the task
      // surface — it destroys the task AND its entire 1:1 conversation, plus
      // the lane, the technical brief and the external issue link — and it
      // fired on the first click with no confirmation, no toast and no undo.
      //
      // One row down the SAME menu, the strictly smaller "Delete" (thread
      // only) already swaps in a worded confirm that focuses Cancel, so Enter
      // can't be the destructive answer (#1173). The larger loss had no guard
      // at all. Same mechanism, naming what goes.
      this.#confirmDeleteTask(task, menu)
    })
    menu.appendChild(del)

    this.#mountMenu(menu, anchor)
  }

  async #setTaskLane(task: TaskSummary, lane: TaskLane): Promise<void> {
    try {
      // Accepting/changing a lane clears the "Done?" suggestion.
      await window.flow.tasks.update({ taskId: task.id, patch: { lane, suggestDone: false } })
    } catch (error) {
      console.error('flow: failed to set task lane', error)
    }
  }

  /** A task's pin IS its 1:1 thread's pin — toggle the owning thread. */
  async #setTaskPinned(task: TaskSummary, pinned: boolean): Promise<void> {
    if (!task.threadId) return
    try {
      await window.flow.threads.update({ threadId: task.threadId, patch: { pinned } })
    } catch (error) {
      console.error('flow: failed to pin task', error)
    }
  }

  #promptRenameTask(task: TaskSummary, anchor: HTMLElement): void {
    this.#openInputForm(
      anchor,
      { title: 'Rename task', fields: [{ key: 'title', placeholder: 'Task name', value: task.title }], submitLabel: 'Rename' },
      (v) => {
        if (v['title'] && v['title'] !== task.title) {
          void window.flow.tasks
            .update({ taskId: task.id, patch: { title: v['title'] } })
            .catch((error: unknown) => console.error('flow: failed to rename task', error))
        }
      },
    )
  }

  /** #1466: both directions. The store has always accepted `archived: false`. */
  async #setTaskArchived(task: TaskSummary, archived: boolean): Promise<void> {
    try {
      await window.flow.tasks.update({ taskId: task.id, patch: { archived } })
    } catch (error) {
      console.error(`flow: failed to ${archived ? 'archive' : 'unarchive'} task`, error)
    }
  }

  async #deleteTask(task: TaskSummary): Promise<void> {
    try {
      await window.flow.tasks.delete({ taskId: task.id })
    } catch (error) {
      console.error('flow: failed to delete task', error)
    }
  }

  /** Import an issue; on a missing-token failure, prompt to connect and retry once. */
  async #importIssue(
    projectRoot: string,
    keyOrUrl: string,
    allowConnect: boolean,
    start = '',
    skip = false,
  ): Promise<void> {
    try {
      const { task, created } = await window.flow.tasks.importIssue({ projectRoot, keyOrUrl })
      this.#notify(
        projectRoot,
        created ? 'Task created' : 'Already imported',
        created ? `Imported ${task.externalKey ?? task.title}` : `${task.title} is already a task.`,
      )
      // Same reveal contract as every other create channel (#1121) — an
      // imported task must not stay hidden behind a stale search filter.
      await this.#revealCreated(task.threadId)
      await this.#afterCreate(task.threadId, start, skip)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const provider = providerOf(keyOrUrl)
      const retry = (): void =>
        void this.#importIssue(projectRoot, keyOrUrl, /* allowConnect */ false, start, skip)
      const needsToken = /token|check your token|permission/i.test(message)
      if (allowConnect && needsToken) {
        // Show the connect form; on submit it stores the token and retries.
        this.#promptConnectForm(provider, retry)
        return
      }
      // Any other failure (unrecognized ref, provider not connected, fetch
      // error): surface the error, with a Configure CTA only when the provider
      // isn't connected yet (configuring wouldn't fix a malformed URL).
      await this.#showImportError(projectRoot, provider, message, retry)
    }
  }

  /**
   * Surface an import failure. When the provider has no stored credentials,
   * shows an anchored menu (same idiom as the connect form) with a "Configure
   * <provider>" CTA; otherwise (or when no anchor is available) falls back to a
   * plain error toast.
   */
  async #showImportError(
    projectRoot: string,
    provider: 'jira' | 'github' | 'azure',
    message: string,
    retry: () => void,
  ): Promise<void> {
    const connected = await window.flow.integrations
      .status({ provider })
      .then((s) => s.connected)
      .catch(() => false)
    const anchor = this.#taskAnchor
    if (connected || !anchor) {
      this.#notify(projectRoot, 'Could not import issue', message, 'error')
      return
    }
    this.#closeMenu()
    const menu = document.createElement('div')
    menu.className = 'fl-thread-menu'
    menu.style.minWidth = '260px'
    menu.style.gap = '8px'
    const label = document.createElement('div')
    label.className = 'fl-thread-menu-confirm'
    label.textContent = message
    const providerLabel = provider === 'jira' ? 'Jira' : provider === 'azure' ? 'Azure DevOps' : 'GitHub'
    const configure = document.createElement('button')
    configure.type = 'button'
    configure.className = 'fl-thread-menu-item'
    configure.style.textAlign = 'center'
    configure.textContent = `Configure ${providerLabel}`
    configure.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#closeMenu()
      this.#promptConnectForm(provider, retry)
    })
    menu.append(label, configure)
    this.#mountMenu(menu, anchor)
  }

  /**
   * A task whose 1:1 chat was deleted has `threadId === null` — the row, the
   * board card and the detail modal all survive, but every "open the chat"
   * affordance was guarded by `if (threadId)` and became a silent dead click with
   * no in-app way to attach a new thread. Create and link one, then open it, so
   * the task is workable again instead of only deletable (#1061).
   */
  async #recoverTaskThread(task: TaskSummary): Promise<void> {
    try {
      const updated = await window.flow.tasks.ensureThread({ taskId: task.id })
      if (updated.threadId) {
        document.dispatchEvent(
          new CustomEvent('flow:open-thread', { detail: { threadId: updated.threadId } }),
        )
      }
    } catch (error) {
      console.error('flow: failed to attach a thread to task', error)
    }
  }

  /** Open the task's thread in the conversation pane (same path as selecting it). */
  #openThread(threadId: string | null): void {
    if (threadId) {
      document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId } }))
    }
  }

  /** After a task is created: apply skip-permissions (before any turn), open the
   *  thread, then send the start command. */
  async #afterCreate(threadId: string | null, start: string, skip: boolean): Promise<void> {
    if (threadId && skip) {
      // Must be set BEFORE the first turn — the session reads it at creation.
      await window.flow.threads
        .update({ threadId, patch: { bypassPermissions: true } })
        .catch((e: unknown) => console.error('flow: failed to set bypassPermissions', e))
    }
    this.#openThread(threadId)
    await this.#startTask(threadId, start)
  }

  /** Send `start` (a flow command or instructions) as the task's first message
   *  to auto-start the agent. No-op when either is empty. */
  async #startTask(
    threadId: string | null,
    start: string,
    attachments: MessageAttachmentInput[] = [],
  ): Promise<void> {
    // Images with no words are still a message worth sending — "look at this"
    // is a whole prompt — so an empty `start` is only a no-op when nothing came
    // with it.
    if (!threadId || (!start && attachments.length === 0)) return
    try {
      await window.flow.threads.sendMessage({
        threadId,
        content: start,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
    } catch (error) {
      console.error('flow: failed to start task', error)
    }
  }

  /** Inline connect form for a provider; runs `onConnected` after storing the token. */
  #promptConnectForm(provider: 'jira' | 'github' | 'azure', onConnected: () => void): void {
    const anchor = this.#taskAnchor
    if (!anchor) return
    if (provider === 'github') {
      this.#openInputForm(
        anchor,
        {
          title: 'Connect GitHub',
          fields: [{ key: 'pat', placeholder: 'GitHub Personal Access Token (read)', password: true }],
          submitLabel: 'Connect',
        },
        (v) => {
          if (!v['pat']) return
          void window.flow.integrations
            .setToken({ provider: 'github', pat: v['pat'] })
            .then(onConnected)
            .catch((e: unknown) => console.error('flow: setToken failed', e))
        },
      )
      return
    }
    if (provider === 'azure') {
      // AZURE NEEDS A PLACE AS WELL AS A CREDENTIAL: it has no "everything of
      // mine, everywhere" endpoint, so a query is scoped to one project and
      // both are part of the connection.
      this.#openInputForm(
        anchor,
        {
          title: 'Connect Azure DevOps',
          fields: [
            { key: 'org', placeholder: 'Organisation (contoso)' },
            { key: 'project', placeholder: 'Project' },
            { key: 'pat', placeholder: 'Personal Access Token (read)', password: true },
          ],
          submitLabel: 'Connect',
        },
        (v) => {
          if (!v['pat'] || !v['org'] || !v['project']) return
          void window.flow.integrations
            .setToken({ provider: 'azure', pat: v['pat'], org: v['org'], project: v['project'] })
            .then(onConnected)
            .catch((e: unknown) => console.error('flow: setToken failed', e))
        },
      )
      return
    }
    this.#openInputForm(
      anchor,
      {
        title: 'Connect Jira',
        fields: [
          { key: 'site', placeholder: 'Site (your-team.atlassian.net)' },
          { key: 'email', placeholder: 'Account email' },
          { key: 'apiToken', placeholder: 'API token', password: true },
        ],
        submitLabel: 'Connect',
      },
      (v) => {
        if (!v['site'] || !v['email'] || !v['apiToken']) return
        void window.flow.integrations
          .setToken({ provider: 'jira', site: v['site'], email: v['email'], apiToken: v['apiToken'] })
          .then(onConnected)
          .catch((e: unknown) => console.error('flow: setToken failed', e))
      },
    )
  }

  /**
   * Open the "New task" form: pick a source (From scratch / Jira / GitHub /
   * Azure), then fill the matching fields. From-scratch takes a title +
   * optional description; the others take an issue key/URL to import.
   */
  #promptNewTask(anchor: HTMLElement, fixedRoot?: string): void {
    this.#closeMenu()
    const projectRoot = fixedRoot ?? this.#activeRoot ?? firstAvailableRoot(this.#roots)

    const menu = document.createElement('div')
    menu.className = 'fl-thread-menu'
    menu.style.minWidth = '280px'
    menu.style.gap = '6px'

    const heading = document.createElement('div')
    heading.className = 'fl-thread-menu-confirm'
    heading.textContent = 'New task'
    menu.appendChild(heading)

    // The sources, their placeholders and the submit gate come from
    // `create-modal` — shared with the Create-thread dialog so a source added
    // to one cannot go missing from the other (allowed-pattern #14).
    const SOURCES = CREATE_SOURCES
    type Src = CreateSource
    const PLACEHOLDER = SOURCE_PLACEHOLDER
    let selected: Src = 'manual'

    const tabs = document.createElement('div')
    tabs.style.cssText = 'display:flex;gap:4px;'
    const tabButtons = new Map<Src, HTMLButtonElement>()
    const syncTabs = (): void => {
      for (const [key, btn] of tabButtons) {
        const on = key === selected
        btn.style.background = on ? 'var(--fl-color-accent-muted)' : 'var(--fl-color-surface)'
        btn.style.color = on ? 'var(--fl-color-accent)' : 'var(--fl-color-text-secondary)'
        btn.style.borderColor = on ? 'var(--fl-color-accent)' : 'var(--fl-color-border)'
      }
    }
    for (const source of SOURCES) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = source.label
      btn.style.cssText = [
        'flex:1',
        'padding:4px 4px',
        'border-radius:var(--fl-radius-sm)',
        'border:var(--fl-border-width) solid var(--fl-color-border)',
        'cursor:pointer',
        'font-size:var(--fl-text-caption-size)',
        'white-space:nowrap',
      ].join(';')
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        selected = source.key
        syncTabs()
        renderBody()
      })
      tabs.appendChild(btn)
      tabButtons.set(source.key, btn)
    }
    menu.appendChild(tabs)

    const body = document.createElement('div')
    body.style.cssText = 'display:flex;flex-direction:column;gap:6px;'
    menu.appendChild(body)

    // "Start with" — a flow command or instructions sent as the task's first
    // message (auto-starts the agent). Optional; applies to every source.
    const startInput = document.createElement('input')
    startInput.type = 'text'
    startInput.className = 'fl-thread-menu-input'
    startInput.placeholder = 'Start with (optional) — e.g. /review-pr'
    const datalistId = 'fl-flow-commands'
    let datalist = document.getElementById(datalistId) as HTMLDataListElement | null
    if (!datalist) {
      datalist = document.createElement('datalist')
      datalist.id = datalistId
      document.body.appendChild(datalist)
    }
    startInput.setAttribute('list', datalistId)
    const commandList = datalist
    if (projectRoot) {
      void window.flow.project
        .listCommands({ rootPath: projectRoot })
        .then((cmds) => {
          commandList.textContent = ''
          for (const c of cmds) {
            const option = document.createElement('option')
            option.value = `/${c.name}`
            option.label = c.description
            commandList.appendChild(option)
          }
        })
        .catch(() => undefined)
    }
    menu.appendChild(startInput)

    // Dangerous opt-in: run the task's agent with permission prompts skipped.
    const skipRow = document.createElement('label')
    skipRow.className = 'fl-thread-menu-skip'
    skipRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 4px;cursor:pointer;'
    const skipCheck = document.createElement('input')
    skipCheck.type = 'checkbox'
    const skipText = document.createElement('span')
    skipText.textContent = 'Skip permission prompts (dangerous)'
    skipRow.append(skipCheck, skipText)
    menu.appendChild(skipRow)

    const submitBtn = document.createElement('button')
    submitBtn.type = 'button'
    submitBtn.className = 'fl-thread-menu-item'
    submitBtn.style.textAlign = 'center'
    menu.appendChild(submitBtn)

    /**
     * #1343: the button used to be fully enabled with the required field
     * empty, and clicking it did literally nothing (`if (!title) return`) —
     * no task, no toast, no inline error. That is #412 verbatim, which the
     * board's modal already fixes by disabling the button and saying WHY in
     * its tooltip; this sibling form never got it.
     */
    const syncSubmit = (): void => {
      const { ready, hint } = submitState({
        source: selected,
        title: titleInput?.value ?? '',
        reference: refInput?.value ?? '',
        noun: 'task',
      })
      submitBtn.disabled = !ready
      submitBtn.style.opacity = ready ? '1' : '0.5'
      submitBtn.style.cursor = ready ? 'pointer' : 'default'
      submitBtn.title = hint
      submitBtn.setAttribute('aria-disabled', ready ? 'false' : 'true')
    }

    let titleInput: HTMLInputElement | null = null
    let descInput: HTMLTextAreaElement | null = null
    let refInput: HTMLInputElement | null = null

    // #1344: this popover threw away everything typed in it the moment it
    // closed — and it closes on ANY mousedown outside, so clicking the chat to
    // check what you were about to write about was enough. The board's
    // New-task modal keeps a per-project draft for exactly this reason (#561),
    // restores it on reopen, and clears it only after a successful create.
    // This copy got none of it. Same data loss #719 fixed for the sidebar's
    // inline Rename field.
    const draftKey = projectRoot ?? ''
    const draft = this.#newTaskDrafts.get(draftKey) ?? { title: '', description: '', start: '', ref: '' }
    startInput.value = draft.start
    const saveDraft = (): void => {
      this.#newTaskDrafts.set(draftKey, {
        title: titleInput?.value ?? draft.title,
        description: descInput?.value ?? draft.description,
        start: startInput.value,
        ref: refInput?.value ?? draft.ref,
      })
    }
    // Save on every keystroke: the popover has no close BUTTON to hook, and an
    // outside mousedown removes it before any blur we could listen for.
    startInput.addEventListener('input', saveDraft)

    const submit = (): void => {
      if (!projectRoot) {
        this.#closeMenu()
        this.#notify('', 'No project open', 'Open a project before creating a task.', 'error')
        return
      }
      const start = startInput.value.trim()
      const skip = skipCheck.checked
      if (selected === 'manual') {
        const title = titleInput?.value.trim() ?? ''
        if (!title) return // unreachable from the UI now — the button is gated
        const description = descInput?.value.trim() || undefined
        this.#newTaskDrafts.delete(draftKey) // #1344: only a real create clears it
        this.#closeMenu()
        void window.flow.tasks
          .create({ projectRoot, title, description })
          .then(async (task) => {
            this.#notify(projectRoot, 'Task created', title)
            // Same reveal contract as every other create channel (#1121).
            await this.#revealCreated(task.threadId)
            return this.#afterCreate(task.threadId, start, skip)
          })
          .catch((err: unknown) =>
            this.#notify(projectRoot, 'Could not create task', String(err), 'error'),
          )
      } else {
        const value = refInput?.value.trim() ?? ''
        if (!value) return // unreachable from the UI now — the button is gated
        this.#newTaskDrafts.delete(draftKey) // #1344
        this.#closeMenu()
        void this.#importIssue(projectRoot, value, /* allowConnect */ true, start, skip)
      }
    }
    const onEnter = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        event.preventDefault()
        submit()
      }
    }

    const renderBody = (): void => {
      body.textContent = ''
      titleInput = null
      descInput = null
      refInput = null
      const saved = this.#newTaskDrafts.get(draftKey)
      if (selected === 'manual') {
        titleInput = document.createElement('input')
        titleInput.type = 'text'
        titleInput.className = 'fl-thread-menu-input'
        titleInput.placeholder = 'Task title'
        titleInput.value = saved?.title ?? '' // #1344
        titleInput.addEventListener('keydown', onEnter)
        titleInput.addEventListener('input', () => {
          saveDraft()
          syncSubmit()
        })
        descInput = document.createElement('textarea')
        descInput.className = 'fl-thread-menu-input'
        descInput.placeholder = 'Description (optional)'
        descInput.rows = 3
        descInput.style.resize = 'vertical'
        descInput.value = saved?.description ?? '' // #1344
        descInput.addEventListener('input', saveDraft)
        body.append(titleInput, descInput)
        submitBtn.textContent = 'Create task'
        titleInput.focus()
      } else {
        refInput = document.createElement('input')
        refInput.type = 'text'
        refInput.className = 'fl-thread-menu-input'
        refInput.placeholder = PLACEHOLDER[selected]
        refInput.value = saved?.ref ?? '' // #1344
        refInput.addEventListener('keydown', onEnter)
        refInput.addEventListener('input', () => {
          saveDraft()
          syncSubmit()
        })
        body.appendChild(refInput)
        submitBtn.textContent = 'Import'
        refInput.focus()
      }
      syncSubmit()
    }

    submitBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      submit()
    })

    this.#mountMenu(menu, anchor)
    syncTabs()
    renderBody()
  }

  /**
   * Mount a small floating form (labeled inputs + a submit button) anchored to
   * an element, reusing the row-menu popover shell. Replaces window.prompt,
   * which Electron does not support.
   */
  #openInputForm(
    anchor: HTMLElement,
    opts: {
      title?: string
      fields: Array<{ key: string; placeholder: string; value?: string; password?: boolean }>
      submitLabel: string
    },
    onSubmit: (values: Record<string, string>) => void,
  ): void {
    this.#closeMenu()
    const menu = document.createElement('div')
    menu.className = 'fl-thread-menu'
    menu.style.minWidth = '260px'
    menu.style.gap = '4px'
    if (opts.title) {
      const heading = document.createElement('div')
      heading.className = 'fl-thread-menu-confirm'
      heading.textContent = opts.title
      menu.appendChild(heading)
    }
    const inputs: HTMLInputElement[] = []
    const submit = (): void => {
      const values: Record<string, string> = {}
      opts.fields.forEach((f, i) => {
        values[f.key] = inputs[i]!.value.trim()
      })
      this.#closeMenu()
      onSubmit(values)
    }
    for (const field of opts.fields) {
      const input = document.createElement('input')
      input.type = field.password ? 'password' : 'text'
      input.className = 'fl-thread-menu-input'
      input.placeholder = field.placeholder
      if (field.value) input.value = field.value
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          this.#closeMenu()
        }
      })
      menu.appendChild(input)
      inputs.push(input)
    }
    const submitBtn = document.createElement('button')
    submitBtn.type = 'button'
    submitBtn.className = 'fl-thread-menu-item'
    submitBtn.textContent = opts.submitLabel
    submitBtn.style.textAlign = 'center'
    submitBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      submit()
    })
    menu.appendChild(submitBtn)

    this.#mountMenu(menu, anchor)
    inputs[0]?.focus()
    inputs[0]?.select()
  }
}

// ── Row glyphs ─────────────────────────────────────────────────────────────

/**
 * THE RULE AT THE HEAD OF A THREAD ROW — whether this conversation's changes
 * are kept apart, and nothing else.
 *
 * This is what replaces the footer's status segment and its menu. The segment
 * managed a thing the reader was never introduced to; the rule reports a
 * PROPERTY of the thing they already hold in their head. `thread-isolation.ts`
 * decides it — the tone, and the sentence that names the branch.
 *
 * IT ALWAYS EXISTS, AND MOST OF THE TIME IT IS INVISIBLE. An element returned
 * only when there is something to draw would let a row change width the moment
 * a thread took a branch of its own, and a list that shifts sideways while you
 * read it is worse than a list that says less. So the element is unconditional
 * and it is PLACED rather than laid out: absolutely positioned in the 26px
 * gutter the label column already reserves, it can neither move the title nor
 * be moved by it, whatever state the thread is in.
 *
 * IT DRAWS 3px AND LISTENS ACROSS 9px. A 3px hover target is a hover target in
 * name only, and the sentence — which is the whole of the explanation, since
 * there is no badge and no word — would be unreachable in practice. The padding
 * widens the box while `background-clip` keeps the ink where the design put it.
 *
 * NO BADGE, NO WORD, NO GLYPH. Every one of those needs a column on every row,
 * forever, to say something that is false for most rows; a colour in a gutter
 * costs nothing when it has nothing to say.
 */
function isolationRule(thread: IsolationSubject): HTMLElement {
  const mark = isolationMark(thread)
  const rule = document.createElement('span')
  const ink =
    mark.tone === null
      ? 'transparent'
      : mark.tone === 'own'
        ? 'var(--fl-color-accent)'
        : // A loop took this one while nobody was watching — the same amber the
          // chip uses for it, because "something else is driving" is one fact
          // and should not have two colours.
          'var(--fl-color-warning)'
  rule.style.cssText = [
    'position:absolute',
    'left:0',
    // Centred and short, so it reads as a rule beside the row rather than as a
    // border around it.
    'top:50%',
    'transform:translateY(-50%)',
    'height:16px',
    // THE INK IS THE BORDER, THE BOX IS THE TARGET. The border paints exactly
    // 3px at the row's left edge; the 6px of transparent content beside it is
    // there only so the pointer has something to find.
    `border-left:3px solid ${ink}`,
    'width:6px',
    // Nothing to say, nothing to hover: an invisible box that swallowed the
    // pointer would be a dead patch at the edge of every ordinary row.
    mark.tone === null ? 'pointer-events:none' : '',
  ].join(';')
  if (mark.title !== '') rule.title = mark.title
  return rule
}


/**
 * The mark at the head of a thread row, or NULL when the row has nothing to
 * mark — which is most rows, most of the time.
 *
 * It shows a chat-bubble glyph, unmistakably NOT a task's checkbox. Status
 * rides the tint (status-contract colors) and the bubble pulses while working.
 * An idle or done thread returns null: those are the resting states, they were
 * drawn in the same muted grey on every row, and an icon that never varies is
 * decoration standing in a column the titles need.
 *
 * A LOOP RUN IS NOT A CHAT SOMEBODY STARTED, and gets the loops' own glyph
 * instead. It is still a conversation — it opens, reads and scrolls exactly like
 * every row around it — but a person scanning this list for "the thing that ran
 * by itself" is asking a different question than "where was I typing", and the
 * two answers should not look identical. The glyph is the one the command
 * palette and the board's loops card already use for this destination.
 */
function threadGlyph(status: ThreadStatus, originLoop: string | null = null): HTMLElement | null {
  // Quiet rows carry no mark — see the call site. `done` is quiet too: it is
  // the resting state of a finished conversation, not an event.
  if (originLoop === null && (status === 'idle' || status === 'done')) return null

  /**
   * A THREAD WAITING ON YOU GETS A DOT, not a bubble.
   *
   * `needs-decision` and `blocked` are the two states where the thread cannot
   * move until a person answers, and they were drawn as the same chat bubble
   * every other row had, in a slightly different tint — the one status worth
   * spotting from across the list, rendered as the shape that says "this is a
   * conversation", which is what all of them are. A filled dot reads at 13px
   * from the corner of the eye; a 1.2px-stroked outline does not.
   */
  if (status === 'needs-decision' || status === 'blocked') {
    const dot = document.createElement('span')
    dot.style.cssText = [
      'flex:none',
      'width:7px',
      'height:7px',
      'margin:0 3px',
      'border-radius:50%',
      `background:${STATUS_COLORS[status]}`,
    ].join(';')
    dot.title =
      status === 'needs-decision'
        ? 'Waiting for your answer'
        : 'Blocked — waiting for your answer'
    return dot
  }

  const icon = document.createElement('fl-icon')
  icon.setAttribute('name', originLoop === null ? 'message' : 'refresh')
  icon.setAttribute('size', '13')
  icon.title = originLoop === null ? `Thread · ${status}` : `${originLoop} run · ${status}`
  icon.style.cssText = `flex:none;color:${STATUS_COLORS[status]};`
  if (status === 'working' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // element.animate works inside shadow trees where document @keyframes
    // cannot reach (fl-list renders rows into its shadow root) — which also
    // means a CSS media query cannot guard it, so reduced motion is checked
    // here. Color + title still carry the working status without the pulse.
    icon.animate(
      [{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }],
      { duration: 1400, iterations: Infinity, easing: 'ease-in-out' },
    )
  }
  return icon
}

const STATUS_COLORS: Record<ThreadStatus, string> = {
  idle: 'var(--fl-color-text-secondary)',
  working: 'var(--fl-color-accent)',
  'needs-decision': 'var(--fl-color-warning)',
  blocked: 'var(--fl-color-error)',
  done: 'var(--fl-color-text-secondary)',
  failed: 'var(--fl-color-error)',
}

// Kanban lane presentation — a checkbox progression (empty → in-progress →
// checked), deliberately distinct from the thread's chat-bubble glyph so a task
// row never reads as a plain thread.
const LANE_ICON: Record<TaskLane, string> = {
  todo: 'square',
  doing: 'square-dot',
  // Blocked breaks the checkbox family on purpose: it is not a step along the
  // progression, it is the progression stopped and waiting on a person.
  blocked: 'warning',
  // Review is a step: work done, a pull request open, waiting on a human to
  // merge — the last checkbox before Done.
  review: 'git-merge',
  done: 'check-square',
}
const LANE_COLOR: Record<TaskLane, string> = {
  todo: 'var(--fl-color-text-secondary)',
  doing: 'var(--fl-color-accent)',
  // Warning, not error: blocked work is waiting for a human, not broken — the
  // same distinction the status colours draw for `needs-decision` vs `failed`.
  blocked: 'var(--fl-color-warning)',
  // Accent, like Doing: Review is active work awaiting a merge, not a rest state.
  review: 'var(--fl-color-accent)',
  done: 'var(--fl-color-success)',
}
const LANE_LABEL: Record<TaskLane, string> = {
  todo: 'Move to Todo',
  doing: 'Move to Doing',
  blocked: 'Move to Blocked',
  review: 'Move to Review',
  done: 'Move to Done',
}

/** Infer the provider from a reference string. */
function providerOf(text: string): 'jira' | 'github' | 'azure' {
  if (/dev\.azure\.com|visualstudio\.com/.test(text)) return 'azure'
  if (/github\.com|^[\w.-]+\/[\w.-]+#\d+$/.test(text)) return 'github'
  return 'jira'
}

// ── Helpers ────────────────────────────────────────────────────────────────

function baseName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** Subscribe to a document event, returning an unsubscribe (for #unsubscribes). */
function onDocEvent(name: string, handler: () => void): () => void {
  document.addEventListener(name, handler)
  return () => document.removeEventListener(name, handler)
}


/** Roots whose Claude Code history was already auto-imported (best-effort). */
function readImportedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(IMPORTED_PROJECTS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(
      Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

function writeImportedProjects(roots: string[]): void {
  try {
    localStorage.setItem(IMPORTED_PROJECTS_KEY, JSON.stringify(roots))
  } catch {
    // ignore — auto-import guard is a convenience; dedup in main is the real safety
  }
}

/** Compact relative age: now, 5m, 3h, 2d, then a short date. */
function relativeAge(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) {
    return ''
  }
  const seconds = Math.max(0, (Date.now() - then) / 1000)
  if (seconds < 60) {
    return 'now'
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`
  }
  if (seconds < 7 * 86400) {
    return `${Math.floor(seconds / 86400)}d`
  }
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ── Styles (light DOM around the list; row content styles are inline
//    because rows render inside <fl-list>'s shadow root) ───────────────────

let sidebarStylesInjected = false

function injectSidebarStyles(): void {
  if (sidebarStylesInjected) {
    return
  }
  sidebarStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-thread-sidebar {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    .fl-thread-toolbar {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      flex: none;
      /* This used to end in 28px of right padding, reserving the top-right
         zone for the movable-panel ⋯ reposition trigger (#636) so it could not
         sit over these buttons and steal their clicks. That trigger no longer
         exists — .fl-panel-menu-trigger appears nowhere in the renderer but
         in the comment that reserved space for it — so the reservation was
         holding a gap open for nothing, which is exactly what the user saw
         once the two put-away controls stopped filling it. */
      padding: var(--fl-space-sm);
      /* NO bottom rule. This row sat between two other horizontal lines — the
         activity bar's divider above it and the outlined search box's own top
         and bottom edges — so a 34px strip carried four rules in a stack and
         the field, the thing you are meant to look at, read as one more of
         them. The divider above already says where the chrome ends; the field
         says what it is by being filled. */
    }
    /* A FILLED field, not an outlined one. The outline was a third and fourth
       line in that stack and it bought nothing: on this background a raised
       fill states "you can type here" on its own, and the focus ring then has
       a state of its own to express instead of merely changing a line's
       colour. */
    .fl-thread-search {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      flex: 1;
      min-width: 0;
      height: 26px;
      padding: 0 var(--fl-space-sm);
      background: var(--fl-color-surface-raised);
      border: none;
      border-radius: var(--fl-radius-md);
      color: var(--fl-color-text-secondary);
    }
    /* A ring rather than a border: drawn outside the box model, so focusing
       cannot nudge the field's height or the row's baseline. */
    .fl-thread-search:focus-within {
      box-shadow: 0 0 0 1px var(--fl-color-focus-ring);
    }
    .fl-thread-search input {
      flex: 1;
      min-width: 0;
      border: none;
      outline: none;
      background: transparent;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    .fl-thread-search input::placeholder {
      color: var(--fl-color-text-secondary);
    }
    .fl-thread-list {
      flex: 1;
      min-height: 0;
      position: relative;
    }
    /* #1219: the way back from the fully-hidden state, stated rather than
       implied — a blank panel the user has to guess out of is the failure mode
       every collapse affordance here is written against. */
    .fl-thread-restore {
      display: block;
      width: 100%;
      padding: 10px 12px;
      background: none;
      border: none;
      text-align: left;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-ui-size);
      cursor: pointer;
    }
    .fl-thread-restore:hover { color: var(--fl-color-text); }
    .fl-thread-empty {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-ui-size);
      user-select: none;
      pointer-events: none;
    }
    .fl-thread-menu {
      position: fixed;
      z-index: 1000;
      min-width: 160px;
      display: flex;
      flex-direction: column;
      padding: var(--fl-space-xs);
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
    }
    /* The group label above a set of choices — not pressable, and sized so it
       reads as a label rather than as a disabled item. */
    .fl-thread-menu-heading {
      padding: 4px 10px 2px;
      font-size: var(--fl-text-caption-size);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--fl-color-text-secondary);
    }
    /* WHAT SEPARATES A CHOICE FROM A SWITCH. Above the rule the items are one
       question with one answer (the order); below it is a toggle. Without the
       line they read as a fourth order, which is a different sentence. */
    .fl-thread-menu-rule {
      height: var(--fl-border-width);
      margin: 4px 0;
      background: var(--fl-color-separator);
    }
    .fl-thread-menu-item {
      display: block;
      width: 100%;
      text-align: left;
      border: none;
      background: transparent;
      cursor: pointer;
      padding: 5px var(--fl-space-sm);
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    .fl-thread-menu-item:hover { background: var(--fl-color-surface); }
    .fl-thread-menu-item.danger { color: var(--fl-color-error); }
    .fl-thread-menu-input {
      width: 100%;
      box-sizing: border-box;
      padding: 5px var(--fl-space-sm);
      background: var(--fl-color-bg);
      border: var(--fl-border-width) solid var(--fl-color-focus-ring);
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      outline: none;
    }
    .fl-thread-menu-confirm {
      padding: 4px var(--fl-space-sm) 6px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    /* What a thread with a checkout of its own is holding (Phase 6) — the
       count, the branch, and what becomes of the copy: kept when it holds work
       that lives nowhere else, freed when it does not. Wraps rather than
       truncates: this line's whole job is to be read. */
    .fl-thread-menu-confirm-detail {
      padding: 0 var(--fl-space-sm) 6px;
      max-width: 260px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      line-height: 1.4;
    }
    .fl-thread-menu-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--fl-space-xs);
    }
    .fl-thread-menu-actions .fl-thread-menu-item { width: auto; }
    .fl-accent-swatch-grid {
      display: grid;
      grid-template-columns: repeat(4, 20px);
      gap: var(--fl-space-xs);
      padding: 2px var(--fl-space-sm) 6px;
    }
    .fl-accent-swatch {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 2px solid transparent;
      padding: 0;
      cursor: pointer;
      box-sizing: border-box;
    }
    .fl-accent-swatch:hover { border-color: var(--fl-color-border); }
    .fl-accent-swatch.selected { border-color: var(--fl-color-text); }
  `
  document.head.appendChild(style)
}

/** The persisted threads collapse mode (#1219). Unreadable storage → the
 *  default, which shows everything. */
function readCollapseMode(): string | null {
  try {
    return localStorage.getItem(THREADS_COLLAPSE_KEY)
  } catch {
    return null
  }
}
