// Kanban board — a Todo / Doing / Blocked / Done view of the active project's
// work, opened as an editor-area tab (like Blueprint). Cards drag between lanes
// and click to open the task's thread. Follows the active project and refreshes
// on tasks:updated.
//
// TODO IS A WINDOW ONTO SOMEBODY ELSE'S LIST (loops-on-the-board, Phase 6). It
// is drawn from a live `loop list` read and stores nothing; Doing, Blocked and
// Done are Flow's own records. Which means this file has two write paths that
// look identical to the user and are not:
//
//   · a LOCAL RECORD dragged between lanes → `tasks:update`, as it always was
//   · a QUEUE ITEM dragged into Doing      → `loops:claim`, the exact write a
//     headless loop performs, so a person and a run can never disagree about
//     who holds an item
//
// This file DECIDES NOTHING. Lanes, chips, amber, blocked reasons, group
// headings, banners and empty states are computed in board-model.ts (the work)
// and board-render.ts / board-actions.ts (the layout and the gestures), all
// three DOM-free and therefore the only testable part of the board. If you find
// yourself writing an `if` about a card's state here, it belongs in one of them.

import { dismissOnEscape } from './modal-escape'
import '../components'
import { OverlayFocusReturn } from '../settings/overlay-focus-return'
import type {
  BoardLoopState,
  IntegrationProvider,
  IssueListConfig,
  IssueListMode,
  LoopQueueSnapshot,
  LoopsSnapshot,
  RemoteIssue,
  TaskSummary,
  TaskLane,
  ThreadSummary,
  ThreadStatus,
  LoopQueueItem,
} from '../../shared/ipc-contract'
import type { EditorApi } from '../editor'
import { ipcErrorMessage } from '../ipc-error'
import {
  imagesSectionLabel,
  ipcImageFetcher,
  renderTicketImages,
  TICKET_IMAGE_STYLES,
} from './ticket-images'
import { baseName } from '../project-label'
import { renderMarkdown } from '../threads/markdown-renderer'
import { BOARD_LANES, moveFailureMessage, resolveBoardView } from './board-view'
import {
  laneCollapseStorageKey,
  parseCollapsedLanes,
  reconcileCollapsedLanes,
  serializeCollapsedLanes,
} from './board-collapse'
import { QueueReadGate } from './board-queue-gate'
import { threadEventsAffectSidebar } from '../threads/sidebar-refresh-model'
import { workspaceScope, type WorkspaceScopeState } from '../threads/workspace-scope'
import { sameMembership, sameScope } from '../threads/workspace-switcher-model'
import {
  boardRoots,
  boardTagsCards,
  cardProjectNames,
  cardProjectTag,
} from './workspace-board-model'
import { threadIsLive } from '../threads/background-task-rows'
import {
  buildBoardModel,
  huntFilterFor,
  type BoardCard,
  type BoardHunt,
  type BoardHuntFilter,
  type BoardModel,
  type BoardQueueGroup,
  type BoardThreadFilter,
} from './board-model'
import {
  huntFinished,
  laneLabel,
  planBoardRender,
  SET_UP_LIST_HINT,
  SET_UP_LIST_LABEL,
  type BoardCardPlan,
  type BoardHuntPlan,
  type BoardLanePlan,
} from './board-render'
import {
  cardRelease,
  cardShare,
  claimOutcome,
  queueItemFor,
  releaseNotice,
  resolveCardLoop,
  runRecordFacts,
  runRecordNotice,
  shareOutcome,
  type CardApproval,
  type CardRelease,
  type CardShare,
  type ClaimNotice,
} from './board-actions'
import { canGenerateBrief } from './task-brief'
import { ticketFacts } from './ticket-model'
import { buildTicketFrame, TICKET_STYLES } from './ticket-view'
import {
  ADD_PROJECTS_LABEL,
  CHANGE_LABEL,
  NEED_A_PROJECT,
  canSubmitProjects,
  cardProjectsView,
  pickerProjects,
  projectsEditable,
  splitPicked,
  submitNeed,
  type CardProjectsView,
  type PickerProject,
} from './task-projects-model'
import { createTaskProjectsPicker, projectChip, TASK_PROJECTS_STYLES } from './task-projects-picker'
import {
  REMOTE_PROVIDERS,
  providerLabel,
  modeLabel,
  remoteListStorageKey,
  remoteSourceStorageKey,
  rememberedRemoteSource,
  remoteListView,
  mergeConnected,
  type ConnectionOutcome,
  type RemoteRead,
} from './remote-list-model'
import {
  createHuntConfig,
  HUNT_CONFIG_STYLES,
  type HuntConfigControl,
} from '../loops/hunt-config-view'
import { huntRequest, type HuntConfig } from '../loops/hunt-config'
import { agentLoopCommand, startHunt } from '../loops/start-hunt'
import {
  canSubmit,
  planManualSubmit,
  skipPermissionsFailedToast,
  startTaskFailedToast,
} from './new-task-submit'
import { taskDetailSignature } from './task-detail'
import { shouldOfferConfigure } from './import-error-model'
import { attachMenuKeyboard, restoreFocusAfterAction } from '../menu-keyboard'
import {
  cardDeleteConfirm,
  cardRemovalItems,
  huntMenuItems,
  laneMenuItems,
  laneName,
} from './lane-menu-model'
import {
  draftRef,
  emptyTaskDraft,
  newTaskDraftHasContent,
  restorableDraft,
  type NewTaskDraft,
  type PersistedNewTaskDraft,
} from './task-draft'
import { backdropDismissAllowed } from './modal-dismiss-guard'
import { markModalOverlay } from '../modal-overlay'
import { shouldPollLoops } from '../loops/loops-panel-model'
import { boardLoopButton } from './board-loop-button'
import {
  createAutoFixControl,
  AUTOFIX_ON_BOARD,
  AUTOFIX_ON_IMPORT,
} from './autofix-control'
import {
  buildQueueItemDetail,
  queueItemMenuEntries,
  type QueueItemDetail,
} from './queue-item-detail'
import {
  cardChatContext,
  ADD_TO_CHAT_LABEL,
  ADD_TO_CHAT_TITLE,
} from './card-chat-context'
import { runForHunt, runChipText, runChipTitle, type LoopRunLink } from '../loops/loop-run-link'
import type { HuntControl } from '../loops/hunt-instruction'

/**
 * How often the board re-reads the loop's list.
 *
 * FIFTEEN SECONDS, and only while somebody is looking. Each tick spawns the
 * CLI, so this is a compromise between "the finding I just watched get filed is
 * on the board" and "the machine is not running a status read a second". A loop
 * beat is minutes long; nothing here is a race.
 */
const QUEUE_POLL_MS = 15_000

const BOARD_TAB_ID = 'flow://tasks'
/** The columns, in order — declared in board-view.ts so the set is unit-testable
 *  without a DOM (Todo · Doing · Blocked · Done). */
const LANES = BOARD_LANES

const SOURCE_LABEL: Record<Exclude<TaskSummary['source'], 'manual'>, string> = {
  jira: 'Jira',
  github: 'GitHub',
  azure: 'Azure',
}

/**
 * How long a `loop list` read stays good for.
 *
 * READING WRITES NOTHING, but it is not free: a GitHub-backed queue costs a
 * `gh` round trip, and `tasks:updated` fires on every turn of every agent in
 * the project. Board-open, project-switch and the explicit Retry all force a
 * fresh read (they are the moments a person is asking "what is on the list?");
 * an incidental re-render inside the window reuses the last answer rather than
 * spending a network call to redraw the same cards. Open question 1 in the plan
 * asked for exactly this default.
 */
const QUEUE_TTL_MS = 30_000

/** The snapshot the board holds before anything has been read. */
const NO_QUEUE_READ: LoopQueueSnapshot = {
  available: true,
  reason: null,
  state: null,
  loops: [],
  generatedAt: null,
}

/** A read that could not happen, in the shape the model already understands. */
function queueUnavailable(reason: string): LoopQueueSnapshot {
  return { available: false, reason, state: null, loops: [], generatedAt: null }
}

/**
 * The working glyph a card's title carries while its agent is mid-turn, or null
 * for any resting status. A small accent dot that pulses its opacity — the
 * board's echo of the thread sidebar's working glyph (same status-contract
 * accent, same slow pulse). Reduced motion keeps the dot and drops the
 * animation, so the state stays legible by colour alone.
 */
function workingPulse(status: ThreadStatus | null, backgroundTasks = 0): HTMLElement | null {
  // A card whose agent backgrounded its work is still working. `status` is
  // about the TURN, and a thread that launched four review passes finishes its
  // turn cleanly — which is exactly when this board went still and the card
  // read as abandoned ("no indicator … thread list, tasks, chat").
  if (!threadIsLive(status ?? 'idle', backgroundTasks)) return null
  const dot = document.createElement('span')
  dot.className = 'fl-board-card-working'
  dot.setAttribute('aria-hidden', 'true')
  dot.title =
    backgroundTasks > 0
      ? `${backgroundTasks} background ${backgroundTasks === 1 ? 'task' : 'tasks'} running`
      : 'Working…'
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dot.animate([{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }], {
      duration: 1400,
      iterations: Infinity,
    })
  }
  return dot
}

export class KanbanBoard {
  readonly element: HTMLElement
  #root: string | null = null
  /**
   * The Workspace being looked at (Workspaces Phase 9). In a Workspace the
   * board draws every one of its projects' cards, each tagged; otherwise it is
   * the active project's board, as it always was.
   */
  #workspace: WorkspaceScopeState | null = null
  /** Each card's extra projects (`workspaces:taskProjects`), read once per card. */
  #taskProjects = new Map<string, string[]>()
  /** The cards whose projects a person picked (the remote ticket's picker). */
  #taskProjectsChosen = new Set<string>()
  #taskProjectsReading = new Set<string>()
  /** The open "Change projects" dialog's close, or null. */
  #projectsDialog: (() => void) | null = null
  #tasks: TaskSummary[] = []
  #loaded = false
  /** Set when the last task-list load failed — drives a distinct error view (#205). */
  #loadError = false
  #subtitle: HTMLElement
  /** The Remote column and the parts of it that change. */
  #remoteEl!: HTMLElement
  #remoteCards!: HTMLElement
  #remoteCount!: HTMLElement
  /** The one-line caption of the column's effective question + result count. */
  #remoteProvenance!: HTMLElement
  #remoteLabel!: HTMLElement
  #remotePicker!: HTMLSelectElement
  #remoteControls!: HTMLElement
  #remoteToggle!: HTMLButtonElement
  /**
   * Which tracker is showing, or null for "the first connected one".
   *
   * NOT PERSISTED, unlike whether the column is on at all: a person switching
   * from GitHub to Jira is looking at something now, and a stored choice would
   * name a tracker they may since have disconnected.
   */
  #remoteSource: IntegrationProvider | null = null
  /** Which trackers are connected — from `integrations:status`, per open. */
  #remoteConnected: IntegrationProvider[] = []
  /** The last read, for the provider it was about. */
  #remoteRead: RemoteRead | null = null
  /**
   * The showing provider's list preference — mode + saved query.
   *
   * Re-fetched whenever the showing provider changes (in `#readRemote`), so the
   * mode selector and the empty-state wording follow the tracker on screen. Null
   * until the first read lands, which reads as the default (assigned, no query).
   */
  #remoteConfig: IssueListConfig | null = null
  /** The Assigned / My list / Both selector — hidden until a query is saved. */
  #remoteModePicker!: HTMLSelectElement
  /** Whether this project's board shows the column. Remembered per project. */
  #remoteOn = false
  /** True while a read is in flight — the column draws a spinner, not a blank. */
  #remoteReading = false
  /** Closes the open remote-ticket card, or null when none is open. */
  #remoteDetail: (() => void) | null = null
  /** The columns container + error banner + no-project state — one at a time. */
  #columnsEl!: HTMLElement
  #errorBanner!: HTMLElement
  /** Dedicated "No project open" empty state (#622) — mirrors the Files panel. */
  #noProjectEl!: HTMLElement
  /** The "+ New task" button — disabled while no project is open (#622). */
  #newBtn!: HTMLButtonElement
  /** Per-lane column element, card container, count badge and collapse toggle. */
  #columns = new Map<
    TaskLane,
    { col: HTMLElement; cards: HTMLElement; count: HTMLElement; collapse: HTMLButtonElement }
  >()
  /**
   * The lanes this project has minimized — a per-project view preference (#1902).
   *
   * Mirrors the Remote toggle's `#remoteOn`: loaded from localStorage on project
   * switch, written back on every change, and never committed. The decision of
   * WHICH keys are valid and WHEN a lane must reveal itself lives in the pure
   * board-collapse.ts; this set is only the current answer.
   */
  #collapsedLanes = new Set<TaskLane>()
  /**
   * Each lane's card count at the last render — the baseline the auto-reveal
   * rule compares against. Cleared on project switch so the new project's first
   * render establishes its own baseline rather than growing against the old
   * one's (which would fling every minimized lane open on switch).
   */
  #laneCounts = new Map<TaskLane, number>()
  /**
   * Whether a SETTLED render (real, loaded data for the current project) has
   * established the auto-reveal baseline yet.
   *
   * THIS IS THE GUARD THAT STOPS OPEN FROM ERASING A FOLD. `setActiveRoot` fires
   * `#readBoardLoop` and `refresh` without awaiting, and the board-loop render
   * lands first — with the previous project's tasks still in `#tasks`, or none
   * at all on a cold start. Left ungated, that stale render seeds the baseline
   * at 0, the real render then reads a folded lane's true count as "0 → N
   * growth", auto-reveals it AND persists the expansion — silently deleting the
   * saved preference. So auto-reveal waits for the FIRST settled render to prime
   * the baseline (revealing nothing), and only renders after that can reveal.
   */
  #collapsePrimed = false
  /** The open task-detail modal, if any — re-rendered live on tasks:updated. */
  #detail: { taskId: string; rerender: () => void } | null = null
  /** Whether the New-task modal is open — re-entrancy guard (#443). */
  #newTaskOpen = false
  /** Drafts preserved when the New-task modal is closed WITHOUT creating, so an
   *  accidental dismiss doesn't lose typed work; restored on reopen, cleared on
   *  a successful create (#561). Keyed BY PROJECT ROOT (#830): the old single
   *  slot meant opening + dismissing another project's empty modal silently
   *  destroyed this project's preserved draft. */
  #newTaskDrafts = new Map<string, PersistedNewTaskDraft>()
  /** Set while the modal is open — snapshots the live inputs into #newTaskDraft
   *  when close(persist) runs. Cleared on close. */
  #snapshotNewTaskDraft: (() => void) | null = null
  /** The last `loop list` answer — the live window Todo is drawn from. */
  #queue: LoopQueueSnapshot = NO_QUEUE_READ
  /** The last `loop status` answer, for the approval facts. */
  #loops: LoopsSnapshot | null = null
  /** WHEN a read may happen — the TTL's two halves plus the in-flight one they
   *  used to be missing. See board-queue-gate.ts: the freshness stamp was
   *  written after the awaits, so a second refresh entering during the first
   *  read a timestamp from before it and spawned its own pair of CLI processes. */
  #queueGate = new QueueReadGate(QUEUE_TTL_MS)
  /**
   * The word this installation claims under, or null until it has been asked
   * for (review finding H1). Read once and cached — it is minted once in main
   * and never changes for the life of the profile, and it is what lets a card
   * held by THIS window be told apart from one held by anybody else.
   */
  #owner: string | null = null
  /** The in-flight owner read, so N cards asking at once ask main once. */
  #ownerRead: Promise<string | null> | null = null
  /** Refusal lines riding cards back to Todo, by card key (Task 6.3). */
  #claimNotes = new Map<string, string>()
  /** The cards the last render drew, by key — the drop handler's lookup. */
  #cards = new Map<string, BoardCard>()
  /** The last model, so a gesture reads the same board the user is looking at. */
  #model: BoardModel | null = null
  /** The active hunt filter, or null for the whole board (Task 7.2). */
  #huntFilter: BoardHuntFilter | null = null
  /**
   * This project's threads, for the loop runs among them.
   *
   * A HUNT CARD IS NOT WORK AND HAS NO THREAD OF ITS OWN — the CLI's instruction
   * store has never heard of a conversation. What it has is a sentence, and a
   * run of that sentence wrote the same sentence onto its thread, so the two are
   * matched here rather than linked. Read alongside the tasks; a failure costs
   * the card its way into the conversation and nothing else.
   */
  #threads: ThreadSummary[] = []
  /**
   * How much background work each thread is still waiting on.
   *
   * NOT DERIVABLE FROM `#threads`. A thread that backgrounded its agents has
   * finished its turn and rests at `done`, so the thread rows say nothing about
   * it — this comes from the agent stream, which is the only place that knows.
   * A thread with nothing running is absent, so a card reads 0.
   */
  #backgroundTaskCounts = new Map<string, number>()
  /** A change arrived while nobody could see the board — settled on reveal. */
  #changedWhileHidden = false
  /**
   * The conversation the reader is in, or null for the whole board (Phase 4).
   *
   * FOLLOWED, NOT DECIDED HERE. It is set from the `flow:active-thread` signal
   * the rest of the renderer already follows — the board is one more decoupled
   * surface scoping itself to the open thread, exactly as the pending-changes
   * review and the source-control panel do, and it never asks a second question
   * about which thread is active.
   */
  #threadFilter: BoardThreadFilter | null = null
  /** The filter bar above the columns — hidden while the board shows everything. */
  /** The loops strip (Task 7.3) — pause-all, the status, and the way in. */
  #loopsStrip!: HTMLElement
  /** What main says this project's loop is doing. Null until first read. */
  #boardLoop: BoardLoopState | null = null

  /** The editor, for the one link the loops strip offers (the cycle log). */
  /**
   * The board holds no EditorApi of its own any more — "Cycle log" was its only
   * consumer. The constructor still TAKES one: `initTaskBoard` below uses its
   * own reference to open the board as a tab, and narrowing this signature
   * would move that decision into the caller for no gain.
   */
  constructor(_editorApi: EditorApi) {
    injectStyles()
    this.element = document.createElement('div')
    this.element.className = 'fl-board'

    /**
     * NO TOOLBAR. NONE.
     *
     * The board's top used to be a row of four controls over the columns: the
     * loop's state and its play button, a gear, Integrations, and "+ New task".
     * Every one of them was a control ABOUT a column, parked above all four —
     * so the row spent the board's full width to say things that belong to one
     * lane, and the lane headers underneath sat empty but for a name and a
     * count.
     *
     * They moved down into the lane they act on: the loop's play button and
     * "+" live in Todo's header, because Todo IS the list the loop drains and
     * the place a new task lands. Integrations went to the app's own settings,
     * where every other account lives.
     *
     * `#subtitle` survives with no header to sit in: it is still the ONE place
     * that says "No project open", and it now rides above the columns on its
     * own, showing only when there is something to say.
     */
    this.#subtitle = document.createElement('div')
    this.#subtitle.className = 'fl-board-subtitle'
    this.element.appendChild(this.#subtitle)

    const columns = document.createElement('div')
    columns.className = 'fl-board-columns'

    /**
     * THE REMOTE COLUMN, BEFORE TODO.
     *
     * "we should have a dropdown that when the user click on github, or jira,
     * we show a new column before the todo, called remote list with a exactly
     * copy from the list that we have on the remote, and the user can click on
     * those items and promote then for todo, or maybe we can have a dedicated
     * play button on that list that will start the loop fix from there as well,
     * maybe we should have both."
     *
     * BOTH, THEN. Clicking an item promotes it, and the column's own play
     * button starts the loop that drains what has been promoted.
     *
     * IT IS NOT A LANE. A lane is a place a task can BE — `todo | doing |
     * blocked | done` is a stored value on a record — and nothing here is a
     * task yet. So it holds no lane key, it is not a drop target, and it is
     * hidden entirely for a project with no remote list configured: an empty
     * column headed "Remote" would report a project has nothing on GitHub when
     * the truth is that nobody has connected GitHub.
     */
    const remote = document.createElement('div')
    remote.className = 'fl-board-column fl-board-remote'
    remote.hidden = true
    const remoteHead = document.createElement('div')
    remoteHead.className = 'fl-board-column-head'
    // THE TRACKER IS THE COLUMN'S NAME. It was headed "Remote" with the tracker
    // beside it, and at a column's width that is four things on one row — a
    // word, a count, a picker and a refresh — with the last of them clipped off
    // the edge. "Remote" was the redundant one: what the column holds is what
    // GitHub says is assigned to you, and saying so is both shorter and more
    // useful than a category label.
    const remoteNaming = document.createElement('span')
    remoteNaming.className = 'fl-board-column-naming'
    this.#remoteLabel = document.createElement('span')
    this.#remoteCount = document.createElement('span')
    this.#remoteCount.className = 'fl-board-count'
    remoteNaming.appendChild(this.#remoteLabel)
    // The dropdown is the "click on github, or jira" — one entry per remote list
    // the project's loops are pointed at. It renders only when there is a
    // CHOICE: a project with one remote list has nothing to pick between, and a
    // select with a single option is a control that cannot do anything.
    this.#remotePicker = document.createElement('select')
    this.#remotePicker.className = 'fl-board-remote-picker'
    this.#remotePicker.setAttribute('aria-label', 'Which tracker to show')
    this.#remotePicker.addEventListener('change', () => {
      this.#remoteSource = this.#remotePicker.value as IntegrationProvider
      // REMEMBERED, so the board opens where it was left. Somebody whose work
      // is on one tracker was re-picking it every time the board mounted,
      // because the column always opened on whichever provider happened to be
      // first in the list.
      this.#rememberRemoteSource()
      // A different tracker is a different question — ask it, rather than
      // redrawing the answer the last one gave.
      void this.#readRemote(true)
    })
    // THE MODE SELECTOR — Assigned / My list / Both. It exists only once a
    // saved query has unlocked `list`/`both` (view.modeOptions.length > 1),
    // exactly as the tracker picker exists only when there is a tracker to pick
    // between. Global, so switching it here is the same choice everywhere — the
    // query it draws on is a global preference too (set in Settings).
    this.#remoteModePicker = document.createElement('select')
    // A DISTINCT CLASS, not the provider picker's: the remote-column e2e selects
    // `.fl-board-remote-picker` expecting exactly one element, and a second
    // element under the same class would break its strict-mode locator.
    this.#remoteModePicker.className = 'fl-board-remote-mode'
    this.#remoteModePicker.setAttribute('aria-label', 'Which list to show')
    this.#remoteModePicker.hidden = true
    this.#remoteModePicker.addEventListener('change', () => {
      void this.#setRemoteMode(this.#remoteModePicker.value as IssueListMode)
    })
    // NAME THEN COUNT, like every other lane head — the picker stands in for
    // the name, so it goes where the name would. Appended HERE, after the
    // picker exists: `append(undefined)` inserts the literal string, which is
    // exactly what the head printed when this ran a few lines too early.
    remoteNaming.append(this.#remotePicker, this.#remoteModePicker, this.#remoteCount)

    const remotePlay = document.createElement('span')
    remotePlay.className = 'fl-board-lane-controls'
    this.#remoteControls = remotePlay
    remoteHead.append(remoteNaming, remotePlay)
    // THE PROVENANCE CAPTION — one line under the head saying which question the
    // column actually asked and how many came back ("Your saved list · 4
    // results"). It is the difference between "my query is wrong" and "the board
    // is broken", which a divergent list otherwise makes indistinguishable.
    this.#remoteProvenance = document.createElement('div')
    this.#remoteProvenance.className = 'fl-board-remote-provenance'
    this.#remoteProvenance.hidden = true
    this.#remoteCards = document.createElement('div')
    this.#remoteCards.className = 'fl-board-cards'
    remote.append(remoteHead, this.#remoteProvenance, this.#remoteCards)
    this.#remoteEl = remote
    columns.appendChild(remote)

    for (const lane of LANES) {
      const col = document.createElement('div')
      col.className = 'fl-board-column'
      const colHead = document.createElement('div')
      colHead.className = 'fl-board-column-head'
      // NAME AND COUNT ARE ONE THING, on every lane. They used to be the head's
      // two ends, which was fine while nothing else was there — but Todo now
      // has controls on its right, so its count sat beside its name while the
      // other three sat at the far edge, and four heads read three ways.
      const naming = document.createElement('span')
      naming.className = 'fl-board-column-naming'
      const label = document.createElement('span')
      label.textContent = lane.label
      const count = document.createElement('span')
      count.className = 'fl-board-count'
      naming.append(label, count)
      colHead.append(naming)
      /**
       * TODO CARRIES THE BOARD'S TWO VERBS, because they are both about Todo.
       *
       * The loop drains this list and a new task lands in it, so a play button
       * and a plus belong on its header rather than on a strip above all four
       * lanes. Every other lane's header stays what it was — a name and a
       * count — which is also how a reader tells at a glance which column is
       * the one anything happens TO.
       */
      if (lane.key === 'todo') {
        this.#loopsStrip = document.createElement('span')
        this.#loopsStrip.className = 'fl-board-lane-controls'
        /**
         * THE REMOTE TOGGLE — and it exists ONLY when there is something to
         * reveal, which is the whole rule for it.
         *
         * A tracker connected in Settings ▸ Integrations means this board can
         * show what is assigned to you on it. An extra column costs width on a
         * board whose four lanes are already tight, and somebody with a
         * connected tracker may simply not want their tracker on this screen —
         * so it is off until pressed, and the answer is remembered per project.
         *
         * The gear that briefly lived here is gone: it configured a LOOP's
         * queue, which turned out to be the wrong question entirely (see
         * remote-list-model.ts). Todo keeps the two verbs it acts on.
         */
        this.#remoteToggle = document.createElement('button')
        this.#remoteToggle.type = 'button'
        this.#remoteToggle.className = 'fl-board-lane-btn'
        this.#remoteToggle.hidden = true
        const cloud = document.createElement('fl-icon')
        cloud.setAttribute('name', 'inbox')
        cloud.setAttribute('size', '12')
        this.#remoteToggle.appendChild(cloud)
        this.#remoteToggle.addEventListener('click', () => this.#toggleRemote())

        const add = document.createElement('button')
        add.type = 'button'
        add.className = 'fl-board-lane-btn'
        add.textContent = '+'
        add.title = 'New task'
        add.setAttribute('aria-label', 'New task')
        add.addEventListener('click', () => this.#openNewTaskForm())
        this.#newBtn = add
        colHead.append(this.#loopsStrip, this.#remoteToggle, add)
      }
      /**
       * THE MINIMIZE CONTROL, on every lane (#1902). Rightmost so it sits past
       * Todo's own verbs and reads the same on all five heads. Its glyph and
       * label are set per render (#applyCollapseControl) because they flip with
       * the lane's state — a chevron that folds when open and one that reveals
       * when minimized. When the lane is minimized the CSS hides the rest of the
       * head and stands this control up as the whole strip's only affordance.
       */
      const collapse = document.createElement('button')
      collapse.type = 'button'
      collapse.className = 'fl-board-lane-btn fl-board-lane-collapse'
      collapse.addEventListener('click', (event) => {
        // The collapsed strip is itself clickable to expand; stop the click from
        // also reaching that strip handler and toggling twice back to collapsed.
        event.stopPropagation()
        this.#toggleLaneCollapsed(lane.key)
      })
      colHead.append(collapse)
      // Clicking anywhere on a minimized strip restores it — the head is all
      // that is visible then, so it must be the target. The guard keeps the
      // expanded head inert (its buttons act on their own).
      colHead.addEventListener('click', () => {
        if (this.#collapsedLanes.has(lane.key)) this.#toggleLaneCollapsed(lane.key)
      })
      const cards = document.createElement('div')
      cards.className = 'fl-board-cards'
      // Drop target: dragging a card here moves it to this lane.
      cards.addEventListener('dragover', (event) => {
        event.preventDefault()
        cards.classList.add('drag-over')
      })
      cards.addEventListener('dragleave', () => cards.classList.remove('drag-over'))
      cards.addEventListener('drop', (event) => {
        event.preventDefault()
        cards.classList.remove('drag-over')
        const cardKey = event.dataTransfer?.getData('text/plain')
        if (cardKey) void this.#dropCard(cardKey, lane.key)
      })
      // A MINIMIZED LANE IS STILL A DROP TARGET (#1902). Its cards container is
      // hidden when folded, so the only drop handler above cannot fire — a card
      // dragged onto the thin strip would be silently swallowed. These handlers
      // live on the column itself and act ONLY while it is collapsed (the
      // expanded case is the cards container's, above, and must not double-fire);
      // the drop moves the card here exactly as a lane drop does, and its arrival
      // reveals the lane on the next render.
      col.addEventListener('dragover', (event) => {
        if (!this.#collapsedLanes.has(lane.key)) return
        event.preventDefault()
        col.classList.add('drag-over')
      })
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'))
      col.addEventListener('drop', (event) => {
        col.classList.remove('drag-over')
        if (!this.#collapsedLanes.has(lane.key)) return
        event.preventDefault()
        const cardKey = event.dataTransfer?.getData('text/plain')
        if (cardKey) void this.#dropCard(cardKey, lane.key)
      })
      col.append(colHead, cards)
      columns.appendChild(col)
      this.#columns.set(lane.key, { col, cards, count, collapse })
    }
    this.#columnsEl = columns
    this.element.appendChild(columns)

    // Distinct load-error view — shown instead of the lanes when tasks:list
    // fails, so a failure is not mistaken for a genuinely empty board (#205).
    this.#errorBanner = document.createElement('div')
    this.#errorBanner.className = 'fl-board-error'
    this.#errorBanner.setAttribute('role', 'alert')
    this.#errorBanner.hidden = true
    const errorMsg = document.createElement('div')
    errorMsg.className = 'fl-board-error-msg'
    errorMsg.textContent = "Couldn't load tasks."
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'fl-board-ghost'
    retry.textContent = 'Retry'
    // An explicit Retry is a person asking again — it never serves the cached
    // list back to them.
    retry.addEventListener('click', () => void this.refresh({ reloadQueue: true }))
    this.#errorBanner.append(errorMsg, retry)
    this.element.appendChild(this.#errorBanner)

    // Distinct "No project open" empty state (#622) — shown INSTEAD of the lanes
    // with no active project, so an empty board can't be mistaken for a genuinely
    // empty active-project board. Mirrors the Files panel's "No project open /
    // Open Folder…" (file-tree.ts) and the Blueprint board's empty state (#449).
    this.#noProjectEl = document.createElement('div')
    this.#noProjectEl.className = 'fl-board-no-project'
    this.#noProjectEl.hidden = true
    const noProjLabel = document.createElement('span')
    noProjLabel.className = 'fl-board-no-project-label'
    noProjLabel.textContent = 'No project open'
    const openButton = document.createElement('fl-button')
    openButton.setAttribute('variant', 'default')
    openButton.setAttribute('small', '')
    const openIcon = document.createElement('fl-icon')
    openIcon.setAttribute('name', 'folder')
    openIcon.setAttribute('size', '13')
    const openText = document.createElement('span')
    openText.textContent = 'Open Folder…'
    openButton.append(openIcon, openText)
    openButton.addEventListener('click', () => {
      void window.flow.project.open().catch((error: unknown) => {
        console.error('flow: failed to open project', error)
      })
    })
    this.#noProjectEl.append(noProjLabel, openButton)
    this.element.appendChild(this.#noProjectEl)
  }

  setActiveRoot(rootPath: string | null): void {
    if (rootPath === this.#root) return
    this.#root = rootPath
    // NOT LOADED UNTIL refresh() SAYS SO. Reset here so no render between now and
    // the new project's first completed load counts as "settled" — the auto-
    // reveal baseline must be primed by real data, never by the board-loop
    // render that fires first with the previous project's tasks still in hand
    // (see `#collapsePrimed`). The off-screen branch below already relied on this
    // flag; making it unconditional is what closes the stale-baseline window.
    this.#loaded = false
    // A refusal belongs to the card it was about, and that card belongs to the
    // project that just closed. So does a hunt filter: another project's hunts
    // are not this one's, and a filter that survived the switch would narrow a
    // board to a sentence nobody here typed.
    this.#claimNotes.clear()
    this.#huntFilter = null
    // And so does the conversation: a thread belongs to one project (ADR-002),
    // so a filter naming the old project's thread would narrow this board to a
    // conversation that is not about it. The new project's active thread arrives
    // on the same signal moments later and re-arms it.
    this.#threadFilter = null
    // AND SO DOES THE REMOTE LIST. Which trackers are connected is app-wide,
    // but whether THIS board shows them is per project, and the items on screen
    // were somebody else's answer to somebody else's question.
    void this.#loadRemoteConnections()
    // AND WHICH LANES ARE MINIMIZED (#1902) — a per-project view preference,
    // like the remote column. The baseline counts go too, so the new project's
    // first render establishes its own rather than auto-revealing every folded
    // lane by "growing" against the last project's numbers.
    this.#loadCollapsedLanes()
    // AND THE LOOP'S STATE IS THIS PROJECT'S. Read rather than assumed: main
    // owns the run and may already be working a card from before this window
    // opened, so a board that started from "not running" would draw a play
    // button over a live agent.
    this.#boardLoop = null
    void this.#readBoardLoop()
    // NOT IF NOBODY IS LOOKING — the same rule the poll has followed since
    // #1640, applied to the bind that never asked. A queue reload spawns a CLI
    // and, on a GitHub queue, waits on `gh`; a board behind another tab has
    // nothing to be out of date with, and re-reads on the way back in
    // (`ensureLoaded`).
    if (this.#onScreen()) void this.refresh({ reloadQueue: true })
    else this.#loaded = false
  }

  /**
   * Load this project's minimized-lanes preference, and reset the baseline.
   *
   * STORAGE CAN THROW (a private window, blocked site data); a lost preference is
   * an empty set, never a broken board — the same fail-soft the remote toggle's
   * read has. Clearing `#laneCounts` is not incidental: it is what stops the
   * next render reading a folded lane's fresh count as growth against the project
   * that just closed and auto-revealing it (NFR-4).
   */
  #loadCollapsedLanes(): void {
    const root = this.#root
    this.#laneCounts.clear()
    // The next settled render primes the baseline; until then, no auto-reveal.
    this.#collapsePrimed = false
    if (root === null) {
      this.#collapsedLanes = new Set()
      return
    }
    try {
      this.#collapsedLanes = parseCollapsedLanes(
        window.localStorage.getItem(laneCollapseStorageKey(root)),
      )
    } catch {
      this.#collapsedLanes = new Set()
    }
  }

  /** Write the minimized-lanes preference back, fail-soft like every other view write. */
  #persistCollapsedLanes(): void {
    const root = this.#root
    if (root === null) return
    try {
      const value = serializeCollapsedLanes(this.#collapsedLanes)
      if (value.length === 0) window.localStorage.removeItem(laneCollapseStorageKey(root))
      else window.localStorage.setItem(laneCollapseStorageKey(root), value)
    } catch {
      // A preference nobody could store is a preference nobody has; the fold
      // still holds for this session, only its memory is lost.
    }
  }

  /** Minimize or restore a lane, remember the answer, and repaint at once. */
  #toggleLaneCollapsed(lane: TaskLane): void {
    if (this.#collapsedLanes.has(lane)) this.#collapsedLanes.delete(lane)
    else this.#collapsedLanes.add(lane)
    this.#persistCollapsedLanes()
    // PAINT NOW — a press is a thing that happened, and the strip folds or
    // unfolds in the same frame (the remote toggle's rule, same reason).
    this.#render()
  }

  /**
   * Set a lane's collapse control to the glyph and words its current state owes.
   *
   * Folded: a chevron that points the way it will grow, "Expand" — the strip is
   * a control and must say what pressing it does. Open: a chevron that points the
   * way it will shrink, "Minimize".
   */
  #applyCollapseControl(button: HTMLButtonElement, lane: TaskLane, collapsed: boolean): void {
    const label = laneLabel(lane)
    const text = collapsed ? `Expand ${label} column` : `Minimize ${label} column`
    button.textContent = collapsed ? '»' : '«'
    button.title = text
    button.setAttribute('aria-label', text)
    button.setAttribute('aria-expanded', String(!collapsed))
  }

  /** Ask main what this project's loop is doing. Never throws. */
  async #readBoardLoop(): Promise<void> {
    const root = this.#root
    const api = window.flow.tasks.boardLoop
    if (root === null || api === undefined) return
    const state = await api({ projectRoot: root }).catch(() => null)
    // THE BOARD MAY HAVE MOVED ON while this was in flight — a project switch
    // fires its own read, and a late answer for the previous project would
    // draw the wrong project's loop (#1719's rule, applied here).
    if (state === null || this.#root !== root) return
    this.#boardLoop = state
    this.#render()
  }

  /**
   * The project's list was re-pointed in Settings — re-read, or mark stale.
   *
   * THE SAME TWO BRANCHES AS EVERY OTHER RE-READ (allowed-pattern #17): an
   * off-screen board queues nothing and re-reads on the way back in. Without
   * this a person could point the project at GitHub and watch a board that
   * still says it has no remote list, which is the app disagreeing with the
   * thing it just wrote.
   */
  handleListChanged(): void {
    if (this.#onScreen()) void this.refresh({ reloadQueue: true })
    else this.#loaded = false
  }

  /**
   * A tracker was connected or disconnected in Settings — re-read which are
   * connected so the Remote toggle appears (or goes) at once.
   *
   * BEFORE THIS, connection state was read ONLY on a project switch
   * (`#loadRemoteConnections`, called from `setActiveRoot`): a tracker connected
   * while the board was open stayed invisible until you left the project and
   * came back, because nothing here listens for Settings changing. Settings now
   * dispatches `flow:integrations-changed` on a successful setToken/clearToken.
   *
   * NOT GATED ON VISIBILITY like the queue re-reads (allowed-pattern #17): this
   * fires on a deliberate, rare human action, not a hot broadcast, and it must
   * leave the toggle correct for when the reader returns to the tab.
   */
  handleIntegrationsChanged(): void {
    void this.#loadRemoteConnections()
  }

  /**
   * Follow the conversation the reader is in (Phase 4, FR-5).
   *
   * NO THREAD, NO FILTER — FR-7 exactly: a null clears the narrowing and the
   * board is the board it was before this feature existed. The title is carried
   * on the signal because the bar has to NAME the thread and an id is not a
   * thing to show a person; when it is missing the bar says "this conversation"
   * in its own words rather than inventing one.
   */
  setActiveThread(
    threadId: string | null,
    title: string | null,
    options: { onlyIfUnset?: boolean } = {},
  ): void {
    // THE BOOT READ NEVER OVERRULES A LIVE SIGNAL. The restore below races the
    // `flow:active-thread` listener, and a signal that arrived first is the
    // reader actually choosing a conversation — the same "once anything is
    // selected, the restore is a no-op" guard threads/index.ts applies to the
    // selection itself.
    /**
     * THE BOARD NO LONGER NARROWS TO THE OPEN CONVERSATION (2026-09-04).
     *
     * It used to hide every card that came from another thread and explain
     * itself in a strip along the top — "In this conversation: <title> · work
     * already started stays, whichever conversation it came from · Nothing on
     * the board came from this conversation" — which is a paragraph of
     * qualification above a board that was, most of the time, empty for a
     * reason nobody asked for.
     *
     * The narrowing goes with the strip rather than after it: the strip's "Show
     * everything" was the only way to undo it, so keeping one without the other
     * would leave a board silently filtered with no way back.
     *
     * The signal is still accepted and ignored — the caller is threads/index.ts
     * and the shape stays so it does not have to know.
     */
    void threadId
    void title
    void options
  }

  /** Load on first open (the tab may be created before a project is active). */
  ensureLoaded(): void {
    if (!this.#loaded) void this.refresh({ reloadQueue: true })
  }

  /**
   * Reload the board. `reloadQueue` forces a fresh `loop list` regardless of the
   * TTL — the moments a person is actually asking what is on the list (opening
   * the board, switching project, pressing Retry, finishing a claim).
   */
  async refresh(options: { reloadQueue?: boolean } = {}): Promise<void> {
    if (!this.#root) {
      this.#tasks = []
      this.#loadError = false
      this.#queue = NO_QUEUE_READ
      this.#loops = null
      this.#threads = []
      this.#queueGate.forget()
      this.#render()
      return
    }
    // THE ROOT THIS REFRESH IS ABOUT (#1719). A project switch fires its own
    // refresh while this one's reads are still in flight; a late answer for a
    // project no longer active must change NOTHING — the same ordering
    // loops-screen's refresh() uses and the same motivation as the queue
    // gate beside it, which protected only its half of this read. Every await
    // below re-checks; a mismatch is a silent no-op, not an error (the new
    // root's own refresh owns the board now).
    const root = this.#root
    try {
      const tasks = (
        await Promise.all(
          this.#loadRoots().map((projectRoot, index) =>
            // The active project's read decides success; a sibling's failure
            // costs that project's cards, not the board.
            index === 0
              ? window.flow.tasks.list({ projectRoot, includeArchived: false })
              : window.flow.tasks.list({ projectRoot, includeArchived: false }).catch((error: unknown) => {
                  console.warn('flow: failed to load a Workspace project’s tasks', error)
                  return []
                }),
          ),
        )
      ).flat()
      if (this.#root !== root) return
      this.#tasks = tasks
      this.#loaded = true
      this.#loadError = false
    } catch (error) {
      if (this.#root !== root) return // a stale failure is not the new project's error
      console.error('flow: failed to load board tasks', error)
      // Don't fake an empty board — flag the failure so #render shows a distinct
      // error view with Retry, and surface a toast (#205).
      this.#loadError = true
      this.#notify(
        'Could not load tasks',
        error instanceof Error ? error.message : String(error),
        'error',
      )
    }
    await this.#readThreads()
    if (this.#root !== root) return
    // Before the render, because the render asks whether a card is held by US —
    // and before the queue read, so the answer is in hand by the time a claim
    // can be pressed. One call for the life of the tab; it never changes.
    await this.#ensureOwner()
    if (this.#root !== root) return
    await this.#readQueue(root, options.reloadQueue === true)
    if (this.#root !== root) return
    this.#render()
  }

  /** This project's threads — a DB read, cheap enough to redo on any change.
   *  Same stale-answer guard as refresh() (#1719): a read that outlived its
   *  project assigns nothing. */
  async #readThreads(): Promise<void> {
    const root = this.#root
    if (root === null) {
      this.#threads = []
      return
    }
    const threads = (
      await Promise.all(
        this.#loadRoots().map((projectRoot) =>
          window.flow.threads.list({ projectRoot }).catch((error: unknown) => {
            console.error('flow: failed to read the threads', error)
            return [] as ThreadSummary[]
          }),
        ),
      )
    ).flat()
    if (this.#root !== root) return // stale answer — the new project's refresh owns the board
    this.#threads = threads
  }

  /**
   * Re-read the conversations and repaint — nothing else.
   *
   * THE CHEAP HALF OF A REFRESH. A run's chip goes from `running` to `last run`
   * when its thread's status changes, which happens many times a minute while an
   * agent works; spawning the CLI for each would be a status read per keystroke
   * of the agent's. This touches the database and repaints.
   */
  /**
   * Take delivery of a thread's live background work.
   *
   * Its own entry point rather than a re-read, because none of this is in the
   * database: the agent stream is the only place that knows, and a thread whose
   * turn ended looks identical in the threads table whether four agents are
   * running under it or none are. Off-screen boards defer exactly as every
   * other change does.
   */
  applyBackgroundTasks(threadId: string, count: number): void {
    const had = this.#backgroundTaskCounts.get(threadId) ?? 0
    if (had === count) return
    if (count === 0) this.#backgroundTaskCounts.delete(threadId)
    else this.#backgroundTaskCounts.set(threadId, count)
    if (!this.#onScreen()) {
      this.#changedWhileHidden = true
      return
    }
    this.#render()
  }

  async refreshThreads(): Promise<void> {
    if (this.#root === null) return
    // OFF SCREEN: REMEMBER, AND STOP (#1640/#1666/#1696, and the reason these
    // subscriptions are safe to keep live). A closed tab still receives every
    // batch, and repainting it buys a reader nothing — but forgetting the
    // change would leave a stale board on the way back in, so the reveal
    // settles exactly one refresh (`handleRevealed`).
    if (!this.#onScreen()) {
      this.#changedWhileHidden = true
      return
    }
    await this.#readThreads()
    this.#render()
  }

  /**
   * tasks:updated — the EXPENSIVE half, gated like everything else here
   * (#1723, completing #1696's pass on this file): a full tasks + threads read,
   * a complete DOM rebuild, and — once the queue TTL lapses — the `loop
   * list`/`loop status` CLI spawn pair, per 50ms batch, were paid for a board
   * nobody could see.
   *
   * DEFERRED, NOT DROPPED. Skipping alone leaves the board showing what it held
   * when it was hidden until the next 15s tick — a reader who switches back to
   * a stale board is the reason the blueprint's own version of this gate
   * settles on reveal (#1666) instead of waiting for a poll. `handleRevealed`
   * spends exactly one refresh, and only when something was actually missed.
   *
   * `refresh()` itself stays unconditional on purpose: it is what a PRESS calls
   * (a claim, a dismissal, a lane move), and a press happens on a surface the
   * reader is looking at.
   */
  /**
   * Main says this project's loop moved.
   *
   * FILTERED BY PROJECT, not by whether it is on screen. This arrives a handful
   * of times per card rather than per frame, and dropping one while the tab is
   * hidden would leave the button showing a run that ended (allowed-pattern
   * #17 is about hot broadcasts; this is not one).
   */
  handleBoardLoopChanged(state: BoardLoopState): void {
    if (this.#root === null || state.projectRoot !== this.#root) return
    this.#boardLoop = state
    this.#render()
  }

  /**
   * The project roots this board loads: the active project, and in a
   * Workspace every other project of it as well (`boardRoots`).
   */
  #loadRoots(): string[] {
    const state = this.#workspace
    if (state === null) return this.#root === null ? [] : [this.#root]
    const roots = boardRoots({
      scope: state.scope,
      activeRoot: this.#root,
      registered: state.registered.map((entry) => entry.rootPath),
      membership: state.membership,
    })
    // The active project always leads — its read is the one that decides an error.
    if (this.#root !== null && roots[0] !== this.#root) return [this.#root, ...roots.filter((r) => r !== this.#root)]
    return roots
  }

  /** The Workspace scope moved: a different Workspace is a different board. */
  setWorkspaceState(state: WorkspaceScopeState): void {
    const previous = this.#workspace
    this.#workspace = state
    if (previous !== null && sameScope(previous.scope, state.scope) && sameMembership(previous.membership, state.membership)) {
      return
    }
    this.handleTasksUpdated()
  }

  /** A card's extra projects changed somewhere — forget them and repaint. */
  handleTaskProjectsChanged(): void {
    this.#taskProjects.clear()
    this.#taskProjectsChosen.clear()
    if (!this.#onScreen()) {
      this.#changedWhileHidden = true
      return
    }
    this.#render()
  }

  /** Read the extra projects of the cards on screen that have not been read yet. */
  #readTaskProjects(taskIds: readonly string[]): void {
    const api = window.flow.workspaces
    if (api === undefined) return
    const wanted = taskIds.filter((id) => !this.#taskProjects.has(id) && !this.#taskProjectsReading.has(id))
    if (wanted.length === 0) return
    for (const id of wanted) this.#taskProjectsReading.add(id)
    // ONE read for every card on screen — a board of 200 cards used to ask 200 times.
    void api
      .taskProjectsMany({ taskIds: wanted })
      .catch(() => null)
      .then((answer) => {
        let found = false
        const chosen = new Set(answer?.ok === true ? (answer.chosen ?? []) : [])
        for (const taskId of wanted) {
          const roots = answer?.ok === true ? (answer.projects[taskId] ?? []) : []
          this.#taskProjects.set(taskId, roots)
          this.#taskProjectsReading.delete(taskId)
          if (chosen.has(taskId)) this.#taskProjectsChosen.add(taskId)
          else this.#taskProjectsChosen.delete(taskId)
          // A card whose projects are drawn (chips, or "Add projects") repaints too.
          if (roots.length > 0 || chosen.has(taskId) || this.#tasks.some((t) => t.id === taskId && t.source !== 'manual')) {
            found = true
          }
        }
        if (found && this.#onScreen()) this.#render()
      })
  }

  /**
   * The projects a ticket may be about: the board's Workspace's (the open
   * ones tickable, the others with why not), or the board's own outside one.
   */
  #pickerProjects(): { projects: PickerProject[]; inWorkspace: boolean } {
    const state = this.#workspace
    const scope = state?.scope ?? null
    const workspace =
      state !== null && scope !== null && scope.kind === 'workspace'
        ? (state.workspaces.find((entry) => entry.slug === scope.slug) ?? null)
        : null
    return {
      projects: pickerProjects({
        workspace,
        registeredRoot: (slug, projectId) => workspaceScope.registeredRoot(slug, projectId),
        boardRoots: this.#loadRoots(),
        nameOf: (root) => workspaceScope.nameOf(root),
      }),
      inWorkspace: workspace !== null,
    }
  }

  /** What a card draws for its task's projects — null until they have been read. */
  #cardProjectsViewFor(task: TaskSummary): CardProjectsView | null {
    const extras = this.#taskProjects.get(task.id)
    if (extras === undefined) return null
    const thread = task.threadId === null ? null : (this.#threads.find((entry) => entry.id === task.threadId) ?? null)
    return cardProjectsView({
      projectRoot: task.projectRoot,
      extraRoots: extras,
      chosen: this.#taskProjectsChosen.has(task.id),
      fromTracker: task.source !== 'manual',
      editable: projectsEditable(thread === null ? null : { sdkSessionId: thread.sdkSessionId, status: thread.status }),
      nameOf: (root) => workspaceScope.nameOf(root),
    })
  }

  /** The chips row: each chosen project in its colour, and "Change" / "Add projects". */
  #cardProjectsEl(task: TaskSummary, view: CardProjectsView): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-board-card-projects'
    if (view.kind === 'chips') {
      for (const chip of view.chips) row.appendChild(projectChip(chip.root, chip.name))
    }
    const editable = view.kind === 'add' || (view.kind === 'chips' && view.change)
    if (editable) {
      const change = document.createElement('button')
      change.type = 'button'
      change.className = 'fl-task-project-change'
      change.textContent = view.kind === 'add' ? ADD_PROJECTS_LABEL : CHANGE_LABEL
      change.title = view.kind === 'add' ? 'Choose the projects this task is about' : "Change this task's projects"
      // The card is draggable and opens on click — the chip's own gesture wins.
      change.addEventListener('mousedown', (event) => event.stopPropagation())
      change.addEventListener('click', (event) => {
        event.stopPropagation()
        const picked = view.kind === 'chips' ? view.chips.map((chip) => chip.root) : []
        this.#openProjectsDialog(task, picked)
      })
      row.appendChild(change)
    }
    return row
  }

  /** The card's "Change": the same picker, until the task's chat starts. */
  #openProjectsDialog(task: TaskSummary, picked: readonly string[]): void {
    if (this.#projectsDialog !== null) return
    const openedAt = Date.now()
    const overlay = document.createElement('div')
    overlay.className = 'fl-board-modal-overlay'
    markModalOverlay(overlay)
    const modal = document.createElement('div')
    modal.className = 'fl-board-modal fl-task-projects-dialog'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-label', "This task's projects")
    modal.tabIndex = -1
    const close = (): void => {
      this.#projectsDialog = null
      overlay.remove()
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (event: KeyboardEvent): void => {
      dismissOnEscape(event, close)
    }
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay && backdropDismissAllowed(openedAt, Date.now())) close()
    })
    document.addEventListener('keydown', onKey)

    const heading = document.createElement('div')
    heading.className = 'fl-board-modal-title'
    heading.textContent = task.title
    const choice = this.#pickerProjects()
    let current: string[] = []
    const picker = createTaskProjectsPicker({
      projects: choice.projects,
      picked,
      inWorkspace: choice.inWorkspace,
      onChange: (next) => {
        current = next
        sync()
      },
    })
    current = picker.picked()
    const actions = document.createElement('div')
    actions.className = 'fl-board-modal-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-board-ghost'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', close)
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'fl-board-new fl-board-primary'
    save.textContent = 'Save'
    const need = document.createElement('span')
    need.className = 'fl-task-projects-need'
    let saving = false
    function sync(): void {
      save.disabled = saving || !canSubmitProjects(current)
      save.title = canSubmitProjects(current) ? '' : NEED_A_PROJECT
      need.textContent = saving ? '' : submitNeed(current)
    }
    save.addEventListener('click', () => {
      if (saving || !canSubmitProjects(current)) return
      saving = true
      save.textContent = 'Saving…'
      sync()
      void window.flow.tasks
        .setProjects({ taskId: task.id, roots: current })
        .then(() => {
          this.#taskProjects.delete(task.id)
          close()
          void this.refresh({ reloadQueue: false })
        })
        .catch((error: unknown) => {
          saving = false
          save.textContent = 'Save'
          sync()
          this.#notify("Couldn't change the projects", ipcErrorMessage(error), 'error')
        })
    })
    actions.append(cancel, save, need)
    modal.append(heading, picker.element, actions)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    this.#projectsDialog = close
    sync()
    modal.focus()
  }

  /** The project tag a card carries on a Workspace board, or null. */
  #projectTagEl(task: TaskSummary | null): HTMLElement | null {
    const state = this.#workspace
    if (task === null || state === null || !boardTagsCards(state.scope)) return null
    const names = cardProjectNames({
      projectRoot: task.projectRoot,
      extraRoots: this.#taskProjects.get(task.id),
      name: (root) => workspaceScope.nameOf(root),
    })
    const tag = document.createElement('div')
    tag.className = 'fl-board-project-tag'
    tag.style.cssText = [
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'margin-bottom:2px',
      'font-size:var(--fl-text-caption-size)',
      'color:var(--fl-color-text-secondary)',
    ].join(';')
    tag.textContent = cardProjectTag(names)
    tag.title = names.length > 1 ? `Projects: ${names.join(', ')}` : `Project: ${names[0] ?? ''}`
    return tag
  }

  handleTasksUpdated(): void {
    if (!this.#onScreen()) {
      this.#changedWhileHidden = true
      return
    }
    void this.refresh()
  }

  /** The reveal seam (#1666's, on this board): settle one deferred refresh. */
  handleRevealed(): void {
    if (!this.#changedWhileHidden) return
    this.#changedWhileHidden = false
    void this.refresh({ reloadQueue: true })
  }

  /**
   * One tick of the background sync.
   *
   * A LIST NOTHING CAN NOTIFY US ABOUT. Tasks in the database announce
   * themselves (`tasks.onUpdated`), but the loop's list is a file — or a GitHub
   * repo — written by a CLI in another process, and a loop that files three
   * findings while you watch left the board showing what it held when you opened
   * it. That was the whole bug: the work was there, the board was not told.
   *
   * ONLY WHEN IT COULD MATTER. Off-screen (tab closed, another tab in front,
   * window in the background) this does nothing at all, because the read spawns
   * a process and a board nobody is looking at has nothing to be out of date
   * with — it re-reads on the way back in.
   */
  async pollTick(): Promise<void> {
    if (this.#root === null || !this.#onScreen()) return
    await this.refresh({ reloadQueue: true })
  }

  /**
   * True when a person could actually be looking at this right now.
   *
   * THE RULE IS `shouldPollLoops`, NOT A SECOND COPY OF IT. #1640 found the same
   * waste from the other end — a hidden loops panel spending a CLI process and
   * two `gh` round trips per loop to paint pixels nobody can see — and put the
   * decision in the pure model where a test pins it. This asks the two DOM
   * questions and hands them over; the judgment is not made here.
   */
  #onScreen(): boolean {
    if (!this.element.isConnected) return false
    // Chromium's own answer, when it has one: a tab behind another editor tab is
    // display:none and must not keep spawning reads.
    const element = this.element as HTMLElement & { checkVisibility?: () => boolean }
    const paneVisible = element.checkVisibility === undefined || element.checkVisibility()
    return shouldPollLoops({ documentHidden: document.visibilityState === 'hidden', paneVisible })
  }

  /**
   * This installation's claim owner, read once from main (review finding H1).
   *
   * FAIL-SOFT AND OPTIONAL, per the bridge contract: a preload that predates
   * `loops:owner` leaves it null, and null is the conservative reading
   * everywhere downstream — no Release control, and a held card is treated as
   * somebody else's, exactly as it was before the owner existed.
   */
  async #ensureOwner(): Promise<void> {
    if (this.#owner !== null) return
    const owner = window.flow.loops?.owner
    if (typeof owner !== 'function') return
    this.#ownerRead ??= owner({})
      .then((result) => {
        const named = result.owner.trim()
        return named.length > 0 ? named : null
      })
      .catch((error: unknown) => {
        console.error('flow: failed to read this installation’s claim owner', error)
        return null
      })
      .finally(() => {
        this.#ownerRead = null
      })
    this.#owner = await this.#ownerRead
  }

  /**
   * Read the list and the loops' status, fail-soft.
   *
   * NEITHER READ MAY THROW PAST HERE. A queue that could not be reached is a
   * `LoopQueueSnapshot` with `available: false` and the reason on it — the exact
   * shape the model turns into a banner — because the alternative is a rejected
   * promise swallowed into an empty Todo, which is the failure this whole
   * feature was asked to make impossible.
   *
   * WHETHER IT HAPPENS AT ALL is the gate's, not this method's. The TTL and the
   * force/no-force rule are the ones this board has always had; what the gate
   * adds is the state between them — a read already in flight, which a second
   * caller joins instead of spawning its own pair of CLI processes.
   */
  #readQueue(root: string, force: boolean): Promise<void> {
    return this.#queueGate.read(root, force, async () => {
      const api = window.flow.loops
      // OPTIONAL METHODS, per the bridge contract: a preload that predates the
      // channels must produce a notice, not a stack trace.
      if (!api || typeof api.queue !== 'function') {
        this.#queue = queueUnavailable('this build of Flow cannot read loop task lists')
        this.#loops = null
        return
      }
      const [queue, loops] = await Promise.all([
        api.queue({ rootId: root }).catch((error: unknown) => {
          console.error('flow: failed to read the loop queue', error)
          return queueUnavailable(ipcErrorMessage(error))
        }),
        // The status snapshot is the SECOND read and the optional one: without it
        // the board loses the approval facts, and the model already
        // treats an absent snapshot as "not measured" rather than "nothing is
        // waiting". A failure here must not cost the list.
        //
        // IT MOVED CHANNELS AND STAYED THE SAME READ. `loops:read` is now the
        // DIRECTIVES — a file read, with no counts and no runtime
        // pause in it — and everything this board reads off the snapshot lives
        // on `loops:activity` instead. `visible: false` is deliberate and not a
        // mistake: the board draws no runs, so it must never spend a Claude
        // Code invocation discovering them (allowed-pattern #17). It is served
        // whatever the loops screen already looked up, and nothing more.
        //
        // THAT LAST SENTENCE USED TO BE FALSE. `visible` reached the runs cache
        // and stopped there, so this tick — which fires every fifteen seconds
        // while the board is open — booted a fresh CLI runtime and made a `gh`
        // round trip per github loop anyway. The 2,103 ms read this whole
        // change removed was still running, on its own interval, for a surface
        // that had asked for none of it (review finding H1). Main now gates
        // both halves on the same flag: this call is answered from the last
        // status a visible caller looked up, or — before anyone has opened the
        // Loops screen — from the directives on disk, which cost a file read
        // and carry every loop, its queue and whether it is switched on.
        // Anything a file cannot say (counts, gated ids, standing hunts)
        // arrives ABSENT, which this board already renders as "not measured".
        typeof api.activity === 'function'
          ? api
              .activity({ rootId: root, visible: false })
              .then((result) => result.status)
              .catch((error: unknown) => {
                console.error('flow: failed to read loop status', error)
                return null
              })
          : Promise.resolve(null),
      ])
      this.#queue = queue
      this.#loops = loops
    })
  }

  // ── rendering ────────────────────────────────────────────────────────────

  #render(): void {
    // Only the state a person has to act on. Naming the open project here
    // repeated the titlebar; saying there is none is news.
    this.#subtitle.textContent = this.#root ? '' : 'No project open'
    // A load failure shows the error banner INSTEAD of the lanes, so it is never
    // mistaken for a genuinely empty board (#205).
    const view = resolveBoardView(this.#root !== null, this.#loadError)
    // One surface at a time: the lanes, the load-error banner, or the
    // no-project empty state (#205 / #622). "+ New task" is disabled with no
    // project so the empty state isn't a soft dead-end (click → toast only).
    this.#errorBanner.hidden = view !== 'load-error'
    this.#noProjectEl.hidden = view !== 'no-project'
    this.#columnsEl.hidden = view !== 'board'
    this.#newBtn.disabled = view === 'no-project'
    // A disabled control owes its reason in its own terms (forbidden-pattern
    // #12): with no project there is nowhere to file a task, and the empty
    // state beside it offers the way out.
    this.#newBtn.title =
      view === 'no-project' ? 'Open a project first — a task is filed against one.' : 'New task'
    if (view !== 'board') {
      // The strip belongs to the PROJECT, not the lanes: a board whose task
      // list failed to load still has loops and still has a reason to stop
      // them, so the strip draws (a running loop keeps its Stop button). There
      // are no lanes here, so no loop-filed cards to offer ▶.
      this.#model = null
      this.#renderLoopsStrip()
      this.#detail?.rerender()
      return
    }
    // THE MODEL IS THE BOARD. Todo comes from the live queue read joined to the
    // local records; the other three lanes are the records themselves. Nothing
    // below filters, sorts or classifies anything — it appends what the plan
    // says, in the order the plan says it.
    const model = buildBoardModel({
      queue: this.#queue,
      loops: this.#loops,
      tasks: this.#tasks,
      now: Date.now(),
      filter: this.#huntFilter,
      threadFilter: this.#threadFilter,
      // What each card's agent is doing — the board already holds the thread
      // summaries, so a card reads its own thread's status off them.
      threadStatusById: new Map(this.#threads.map((thread) => [thread.id, thread.status])),
      // …and what each one's agents are still doing after its turn ended.
      backgroundTasksById: this.#backgroundTaskCounts,
    })
    this.#model = model
    // Every board reads its cards' projects: a ticket's chosen projects are
    // drawn on its card whether or not the board spans a Workspace.
    this.#readTaskProjects(this.#tasks.map((task) => task.id))
    // Draw the strip now the model is fresh: the play button reads this render's
    // loop-filed Todo cards off it to decide whether it can act (#renderLoopsStrip).
    this.#renderLoopsStrip()
    const plan = planBoardRender(model, {
      loops: this.#loops,
      notes: this.#claimNotes,
      // So a card this installation holds says "held by you" rather than naming
      // the reader as a stranger by their own owner id (review H1).
      owner: this.#owner,
    })
    this.#cards.clear()
    this.#renderRemote()
    // AUTO-REVEAL, BEFORE ANYTHING IS DRAWN (#1902). Work that just landed in a
    // minimized lane grows its count; the pure reconcile turns that into the set
    // of lanes to unfold. Persist only on a real change, then record this
    // render's counts as the next baseline — the two must not read each other's
    // numbers, so the counts are captured after the decision is made.
    //
    // ONLY ONCE A SETTLED RENDER HAS PRIMED THE BASELINE. A render before the
    // project's data has loaded (the board-loop render that beats `refresh`, or a
    // cold start) would otherwise seed a 0 baseline and let the real render read
    // a fold as growth — revealing it and erasing the saved preference. The first
    // settled render primes and reveals nothing; only later ones can reveal.
    const counts = new Map<TaskLane, number>(plan.lanes.map((lane) => [lane.lane, lane.count]))
    const settled = this.#loaded && !this.#loadError
    if (this.#collapsePrimed && this.#collapsedLanes.size > 0) {
      const revealed = reconcileCollapsedLanes({
        collapsed: this.#collapsedLanes,
        prevCounts: this.#laneCounts,
        counts,
      })
      if (revealed.expanded.length > 0) {
        this.#collapsedLanes = revealed.collapsed
        this.#persistCollapsedLanes()
      }
    }
    this.#laneCounts = counts
    if (settled) this.#collapsePrimed = true
    // THE REDRAW REPLACES EVERY CARD, INCLUDING THE FOCUSED ONE. Every
    // tasks:updated lands here, so a keyboard user on a card — or in a menu
    // that returns to it — was dropped on <body> by somebody else's write.
    // Note which task held focus and hand it to that task's new card.
    const focused = document.activeElement
    // A shared-list item has no task id; its card key is the same identity.
    const focusedCardKey =
      focused instanceof HTMLElement && this.#columnsEl.contains(focused)
        ? focused.closest<HTMLElement>('.fl-board-card')?.dataset['cardKey']
        : undefined
    for (const lanePlan of plan.lanes) {
      const column = this.#columns.get(lanePlan.lane)
      if (!column) continue
      const collapsed = this.#collapsedLanes.has(lanePlan.lane)
      column.col.classList.toggle('is-collapsed', collapsed)
      column.count.textContent = String(lanePlan.count)
      this.#applyCollapseControl(column.collapse, lanePlan.lane, collapsed)
      column.cards.textContent = ''
      // A minimized lane draws no cards — pay only for what is visible. Its count
      // still updates (the strip shows it) and still feeds the reveal rule above.
      if (!collapsed) this.#renderLane(column.cards, lanePlan)
    }
    // Only when the redraw is what lost it: a removed node leaves <body> focused.
    if (focusedCardKey !== undefined && document.activeElement === document.body) {
      this.#cardElementByKey(focusedCardKey)?.focus({ preventScroll: true })
    }
    // Keep an open detail modal in sync with freshly loaded task data.
    this.#detail?.rerender()
  }

  /**
   * The Remote column — what is assigned to YOU on a connected tracker.
   *
   * NOT A LOOP'S QUEUE, and the first cut had that wrong: a queue is a
   * repository's list somebody pointed a loop at, in a committed file, so a
   * project reading a local list could never show this column no matter how
   * many trackers were connected. The question a person is actually asking is
   * "what is mine" (see remote-list-model.ts), which an integration answers and
   * no directive has to.
   *
   * NOTHING IS RE-ORDERED, RE-LABELLED OR FILTERED. It is a window onto somebody
   * else's list; a board that quietly sorted or hid items would be a second,
   * disagreeing view of a list the person can open in a browser.
   */
  #renderRemote(): void {
    const view = remoteListView({
      connected: this.#remoteConnected,
      read: this.#remoteRead,
      chosen: this.#remoteSource,
      on: this.#remoteOn,
      reading: this.#remoteReading,
      config: this.#remoteConfig,
    })

    // THE TOGGLE EXISTS ONLY WHEN THERE IS SOMETHING TO REVEAL. No tracker
    // connected, no control — an offer nothing can honour is worse than none.
    this.#remoteToggle.hidden = !view.available
    this.#remoteToggle.classList.toggle('is-on', view.available && this.#remoteOn)
    // FEEDBACK ON THE THING THAT WAS PRESSED, immediately. The column appears
    // in the same frame, but the button is where the finger was.
    this.#remoteToggle.classList.toggle('is-busy', view.loading)
    this.#remoteToggle.title = view.toggleLabel
    this.#remoteToggle.setAttribute('aria-label', view.toggleLabel)
    this.#remoteToggle.setAttribute('aria-pressed', String(this.#remoteOn))

    this.#remoteEl.hidden = !view.available || !this.#remoteOn || view.showing === null
    if (this.#remoteEl.hidden || view.showing === null) return

    // NO COUNT WHILE READING. "0" is an answer, and printing it over a list
    // nobody has finished asking for is the same lie the empty state was.
    this.#remoteCount.textContent = view.loading ? '…' : String(view.items.length)
    // THE EFFECTIVE QUESTION, so a divergent list is legible: empty while loading
    // or before a read lands (the view leaves it blank there), shown otherwise.
    this.#remoteProvenance.textContent = view.provenance
    this.#remoteProvenance.hidden = view.provenance.length === 0
    // A picker only when there is something to pick between — and when there
    // is, it IS the name, so the plain label steps aside rather than repeating
    // the word the picker already shows.
    this.#remotePicker.hidden = view.providers.length < 2
    this.#remoteLabel.hidden = !this.#remotePicker.hidden
    this.#remoteLabel.textContent = providerLabel(view.showing)
    this.#remotePicker.textContent = ''
    for (const provider of view.providers) {
      const option = document.createElement('option')
      option.value = provider
      option.textContent = providerLabel(provider)
      this.#remotePicker.appendChild(option)
    }
    this.#remotePicker.value = view.showing

    // THE MODE SELECTOR — only when a saved query has unlocked more than the one
    // Assigned mode, the same "a control that can only do one thing is no
    // control" rule the tracker picker follows.
    this.#remoteModePicker.hidden = view.modeOptions.length < 2
    if (!this.#remoteModePicker.hidden) {
      this.#remoteModePicker.textContent = ''
      for (const mode of view.modeOptions) {
        const option = document.createElement('option')
        option.value = mode
        option.textContent = modeLabel(mode)
        this.#remoteModePicker.appendChild(option)
      }
      this.#remoteModePicker.value = view.mode
    }

    // A REFRESH, because this list lives on somebody else's server and the
    // board has no way to be told it changed. One press, one request.
    this.#remoteControls.textContent = ''
    const again = document.createElement('button')
    again.type = 'button'
    again.className = 'fl-board-lane-btn'
    again.title = 'Read your list again'
    again.setAttribute('aria-label', 'Read your list again')
    const glyph = document.createElement('fl-icon')
    glyph.setAttribute('name', 'refresh')
    glyph.setAttribute('size', '12')
    again.appendChild(glyph)
    again.addEventListener('click', () => void this.#readRemote(true))
    this.#remoteControls.appendChild(again)

    this.#remoteCards.textContent = ''
    // A LOADER, NOT A BLANK. This read goes to somebody else's server and on a
    // cold token takes seconds; a column that showed nothing for those seconds
    // is a column that looks broken.
    if (view.loading) {
      const loading = document.createElement('div')
      loading.className = 'fl-board-remote-loading'
      loading.setAttribute('role', 'status')
      const spinner = document.createElement('fl-icon')
      spinner.setAttribute('name', 'spinner')
      spinner.setAttribute('size', '13')
      // `spin` is fl-icon's own animation, and it respects
      // prefers-reduced-motion (it becomes a pulse) — so this is one attribute
      // rather than a keyframe the board would have to own and get that right in.
      spinner.setAttribute('spin', '')
      const said = document.createElement('span')
      said.textContent = 'Reading your list…'
      loading.append(spinner, said)
      this.#remoteCards.appendChild(loading)
      return
    }
    // A read that FAILED says so, and never renders as empty — "you have
    // nothing" and "nobody could ask" are different answers (NFR-2's rule, and
    // it matters most here: a remote read fails for reasons a person can fix).
    if (view.reason !== null) {
      const banner = document.createElement('div')
      banner.className = 'fl-board-lane-banner'
      banner.setAttribute('role', 'status')
      banner.textContent = view.reason
      banner.title = view.reason
      this.#remoteCards.appendChild(banner)
      return
    }
    if (view.items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'fl-board-empty'
      empty.textContent = view.emptyText
      this.#remoteCards.appendChild(empty)
      return
    }
    // Which of them this project has already taken on — matched on the key the
    // importer stores, so a second press is never offered for work already here.
    const taken = new Set(
      this.#tasks.map((task) => (task.externalKey ?? '').trim()).filter((key) => key.length > 0),
    )
    for (const item of view.items) {
      // THE PROVIDER IS CARRIED, NOT GUESSED. A ticket's attachments are
      // fetched with one tracker's credential, and the view already knows which
      // tracker this column is showing — inferring it back out of a key would
      // be a second answer to a question that has one.
      this.#remoteCards.appendChild(
        this.#remoteCardEl(item, taken.has(item.key), view.showing),
      )
    }
  }

  /**
   * One remote item, and the press that makes it this project's work.
   *
   * IT IS A BUTTON, not a draggable card. Dragging means "move it between my
   * lanes"; this item is not in any of them, and the one thing that can happen
   * to it is becoming a task. Saying that with a button is also what makes the
   * gesture discoverable — a card that only answers a drag nobody guesses at is
   * a control with no affordance.
   */
  #remoteCardEl(
    item: RemoteIssue,
    taken: boolean,
    provider: IntegrationProvider | null,
  ): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'fl-board-card fl-board-remote-card'
    // ALREADY TAKEN ON. The issue is still on the tracker and still drawn here —
    // this column is a copy of that list, not an edit of it — but a second press
    // would be a dead one, so it says which it is instead.
    el.classList.toggle('is-taken', taken)
    el.disabled = taken
    el.title = taken ? 'Already on this board' : `Add to Todo — ${item.url}`
    const title = document.createElement('div')
    title.className = 'fl-board-card-title'
    title.textContent = item.title
    el.appendChild(title)
    const facts = document.createElement('div')
    facts.className = 'fl-board-card-facts'
    facts.textContent = [item.key, item.status, taken ? 'on the board' : '']
      .filter((part) => part.trim().length > 0)
      .join(' · ')
    el.appendChild(facts)
    // A CARD FIRST, THEN THE CHOICE. Clicking used to file the item straight
    // into Todo, which is a commitment made by a glance — the titles in this
    // column are somebody else's, often truncated, and the thing you want
    // before taking work on is to read it. So a press opens the ticket, and
    // taking it on is a second, deliberate press inside.
    el.addEventListener('click', () => this.#openRemoteDetail(item, taken, provider))
    return el
  }

  /**
   * The ticket, before any decision about it.
   *
   * READ, THEN DECIDE. A press on a remote card used to file it into Todo
   * immediately — a commitment made by a glance, on a title that is somebody
   * else's and often truncated. This shows what the tracker actually says
   * (its key, its state, its body) with the two things a person wants next:
   * open it where it lives, or take it on.
   *
   * IT EDITS NOTHING. Every control here either leaves or copies; the tracker's
   * own record is not this board's to change, which is the same rule the column
   * around it follows.
   */
  #openRemoteDetail(
    item: RemoteIssue,
    taken: boolean,
    provider: IntegrationProvider | null,
  ): void {
    if (this.#remoteDetail !== null) return // one at a time, like the task detail
    const openedAt = Date.now()
    const overlay = document.createElement('div')
    overlay.className = 'fl-board-modal-overlay'
    // It owns the keyboard while it is open, like every other board modal:
    // ⌃`/⌘B must not mutate the layout behind it and Escape must reach this
    // close handler (#1002).
    markModalOverlay(overlay)
    const modal = document.createElement('div')
    modal.className = 'fl-board-modal fl-board-detail'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.tabIndex = -1

    const close = (): void => {
      this.#remoteDetail = null
      overlay.remove()
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (event: KeyboardEvent): void => {
      dismissOnEscape(event, close)
    }
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay && backdropDismissAllowed(openedAt, Date.now())) close()
    })
    document.addEventListener('keydown', onKey)

    // THE SHARED TICKET CHROME (ticket-view.ts). Three surfaces used to draw a
    // ticket three ways; they draw it one way now.
    const frame = buildTicketFrame(modal, {
      title: item.title,
      subtitle: item.key,
      url: item.url.trim().length > 0 ? item.url : null,
      facts: ticketFacts(item),
    })

    const desc = frame.section('Description')
    if (item.description.trim().length === 0) {
      // SAID, NOT LEFT BLANK. An empty panel reads as "this failed to load"; the
      // tracker really did answer, and it answered with nothing.
      desc.classList.add('fl-board-detail-muted')
      desc.textContent = 'This ticket has no description.'
    } else {
      // The app's own renderer, which returns an ELEMENT — never innerHTML with
      // a tracker's body in it.
      desc.appendChild(renderMarkdown(item.description))
    }

    // THE SCREENSHOTS, under the words. A bug report is mostly its picture and
    // the card showed none of them — not because nobody drew them, but because
    // it could not: the page may only load `self` and `data:` images, and a
    // tracker's attachment is behind the issue's own credential. Main fetches
    // each one and answers with a data URI (`integrations:imageData`).
    const images = provider === null ? [] : (item.images ?? [])
    if (images.length > 0 && provider !== null) {
      const gallery = frame.section(imagesSectionLabel(images.length))
      void renderTicketImages(gallery, images, ipcImageFetcher(provider))
    }

    // WHICH PROJECTS THIS TICKET IS ABOUT. It was written outside Flow and
    // says nothing about the code it touches, so nothing is ticked for you:
    // the first project ticked is where the task's chat runs, the rest join it
    // as context, and the chat starts with exactly those.
    const choice = this.#pickerProjects()
    let picked: string[] = []
    const picker = createTaskProjectsPicker({
      projects: choice.projects,
      inWorkspace: choice.inWorkspace,
      onChange: (next) => {
        picked = next
        syncAdd()
      },
    })
    frame.scroll.appendChild(picker.element)

    // THE SAME QUESTION, ASKED WHERE THE DECISION IS MADE. "when I add that to
    // todo, I already wanna that information there" — taking work on and saying
    // whether it should be worked is one gesture, and splitting it into two
    // means the second one is the one people forget. There is no record to
    // write to yet, so the answer is held here and handed to the create.
    const auto = frame.section('Automation')
    const autoControl = createAutoFixControl(false, AUTOFIX_ON_IMPORT)
    auto.append(...autoControl.nodes)

    const actions = frame.actions
    if (item.url.trim().length > 0) {
      const open = document.createElement('a')
      open.className = 'fl-board-ghost'
      open.textContent = 'Open on the tracker ↗'
      open.href = item.url
      open.target = '_blank'
      open.rel = 'noreferrer'
      actions.appendChild(open)
    }
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-board-ghost'
    cancel.textContent = 'Close'
    cancel.addEventListener('click', close)
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'fl-board-new'
    add.textContent = taken ? 'Already on this board' : 'Add to Todo'
    const addStart = document.createElement('button')
    addStart.type = 'button'
    addStart.className = 'fl-board-new fl-board-primary'
    addStart.textContent = 'Add and start'
    const need = document.createElement('span')
    need.className = 'fl-task-projects-need'
    let adding = false
    // Both add buttons wait for a project; a disabled control owes its reason
    // in its own terms (forbidden-pattern #12).
    function syncAdd(): void {
      const blocked = taken || adding || !canSubmitProjects(picked)
      add.disabled = blocked
      addStart.disabled = blocked
      const reason = taken ? 'This board already has a task for this ticket.' : submitNeed(picked)
      add.title = reason
      addStart.title = reason
      need.textContent = taken || adding ? '' : submitNeed(picked)
    }
    const submit = (start: boolean): void => {
      const split = splitPicked(picked)
      if (split === null || taken || adding) return
      adding = true
      syncAdd()
      ;(start ? addStart : add).textContent = 'Adding…'
      void this.#promoteRemote(item, autoControl.value(), split, start).finally(close)
    }
    add.addEventListener('click', () => submit(false))
    addStart.addEventListener('click', () => submit(true))
    if (taken) actions.append(cancel, add)
    else actions.append(cancel, add, addStart, need)
    syncAdd()

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    this.#remoteDetail = close
    // Somewhere to put the keyboard: the first project to tick when there is
    // one, the dialog itself otherwise (the add buttons wait for a project).
    const firstBox = picker.element.querySelector<HTMLInputElement>('input:not(:disabled)')
    ;(taken || firstBox === null ? modal : firstBox).focus()
  }

  /**
   * Promote one remote item into Todo.
   *
   * THROUGH `tasks:createFromQueueItem`, not the importer. The importer takes a
   * reference and goes and FETCHES the issue — a second round trip to a server
   * that just answered. This board already has the item, so it hands over the
   * facts it read. Same store, same dedup rule: pressing twice makes one task.
   */
  async #promoteRemote(
    item: RemoteIssue,
    autoFix: boolean,
    projects: { projectRoot: string; additionalRoots: string[] },
    start: boolean,
  ): Promise<void> {
    let threadId: string | null = null
    try {
      const result = await window.flow.tasks.createFromQueueItem({
        // The FIRST project ticked — where the chat runs; the rest are context.
        projectRoot: projects.projectRoot,
        ...(projects.additionalRoots.length === 0 ? {} : { additionalRoots: projects.additionalRoots }),
        // A person picked them: the chat starts with exactly these.
        projectsChosen: true,
        title: item.title,
        externalKey: item.key,
        url: item.url,
        ...(item.description.length === 0 ? {} : { body: item.description }),
        // The screenshots ride along. They were read once, on the way in; a
        // task that did not record them here could only get them back by going
        // to the tracker again.
        ...(item.images === undefined || item.images.length === 0 ? {} : { images: item.images }),
        // The answer the ticket was given, carried into the record it becomes.
        ...(autoFix ? { autoFix: true } : {}),
      })
      this.#notify(result.created ? 'Added to Todo' : 'Already on this board', item.title)
      threadId = result.task.threadId
      this.#taskProjects.delete(result.task.id)
    } catch (error) {
      this.#notify('Could not add it', ipcErrorMessage(error), 'error')
      return
    }
    await this.refresh({ reloadQueue: false })
    // "Add and start": the task's chat opens, the same way a created task's does.
    if (start) await this.#afterCreate(threadId, '', false)
  }

  /**
   * Remember which tracker this project's column is reading.
   *
   * STORAGE CAN THROW — a private window, cleared site data, a browser set to
   * block it — and none of that is worth a broken board. Same shape as the
   * on/off write beside it: the preference is lost, the column is not.
   */
  #rememberRemoteSource(): void {
    const root = this.#root
    const source = this.#remoteSource
    if (root === null) return
    try {
      if (source === null) window.localStorage.removeItem(remoteSourceStorageKey(root))
      else window.localStorage.setItem(remoteSourceStorageKey(root), source)
    } catch {
      // A preference nobody could store is a preference nobody has. Nothing else
      // depends on this write.
    }
  }

  /** Switch the column on or off for this project, and remember the answer. */
  #toggleRemote(): void {
    this.#remoteOn = !this.#remoteOn
    const root = this.#root
    if (root !== null) {
      try {
        window.localStorage.setItem(remoteListStorageKey(root), this.#remoteOn ? '1' : '0')
      } catch {
        // Storage blocked still leaves a working toggle for this session; only
        // the memory of it is lost.
      }
    }
    // PAINT FIRST, ALWAYS, THEN ASK. This used to delegate the repaint to
    // `#readRemote`, which has four early returns — no provider, no bridge, a
    // read already in hand — and every one of them rendered nothing. So a press
    // could flip the state and change the screen not at all: switching the
    // column back on after switching it off showed nothing until some unrelated
    // repaint came along, which is the "taking long to appear and there no
    // indicator" the user hit. A press is a thing that happened; the screen
    // says so in the same frame, and the read follows.
    this.#render()
    if (this.#remoteOn) void this.#readRemote(false)
  }

  /**
   * Ask the chosen tracker what is assigned to this person.
   *
   * ONLY WHEN THE COLUMN IS ON, and only for the provider showing: this is a
   * network request to somebody else's server, and a board nobody has asked for
   * the column on must not make one (allowed-pattern #17).
   */
  async #readRemote(force: boolean): Promise<void> {
    if (!this.#remoteOn) return
    const provider = remoteListView({
      connected: this.#remoteConnected,
      read: this.#remoteRead,
      chosen: this.#remoteSource,
      on: this.#remoteOn,
      reading: this.#remoteReading,
    }).showing
    if (provider === null) return
    if (!force && this.#remoteRead?.provider === provider) return
    const api = window.flow.integrations
    if (api?.assigned === undefined) return
    // Repaint first so the column says it is reading rather than sitting on a
    // stale answer while the request is in flight.
    this.#remoteRead = null
    this.#remoteReading = true
    this.#render()
    // THE SHOWING PROVIDER'S PREFERENCE, read alongside its list — the selector
    // and the empty-state wording follow the tracker on screen. A build without
    // the channel (or a failure) leaves it null, which reads as the default.
    if (api.getListConfig !== undefined) {
      this.#remoteConfig = await api.getListConfig({ provider }).catch(() => null)
    }
    try {
      const answer = await api.assigned({ provider }).catch((error: unknown) => ({
        ok: false as const,
        provider,
        items: [] as RemoteIssue[],
        reason: ipcErrorMessage(error),
      }))
      this.#remoteRead = { provider, ok: answer.ok, items: answer.items, reason: answer.reason }
    } finally {
      // CLEARED WHATEVER HAPPENED. A spinner left spinning after a failure is
      // the one state worse than no spinner at all.
      this.#remoteReading = false
    }
    this.#render()
  }

  /**
   * Switch the showing tracker's list mode — Assigned / My list / Both.
   *
   * WRITES THE GLOBAL PREFERENCE, then re-reads: the mode is stored per provider
   * in app-settings (the same place its query lives), so this is the same choice
   * on every project's board. The write echoes back the merged config, which is
   * kept so the selector reflects it without a second read.
   */
  async #setRemoteMode(mode: IssueListMode): Promise<void> {
    const provider = remoteListView({
      connected: this.#remoteConnected,
      read: this.#remoteRead,
      chosen: this.#remoteSource,
      on: this.#remoteOn,
      reading: this.#remoteReading,
      config: this.#remoteConfig,
    }).showing
    const api = window.flow.integrations
    if (provider === null || api?.setListConfig === undefined) return
    this.#remoteConfig = await api.setListConfig({ provider, mode }).catch(() => this.#remoteConfig)
    // A different mode is a different question — ask it, rather than redrawing
    // the answer the last one gave.
    await this.#readRemote(true)
  }

  /**
   * Which trackers are connected, and whether this project wants the column.
   *
   * ASKED ON PROJECT CHANGE, not on every render: three status calls per repaint
   * would be three round trips for an answer that changes when somebody visits
   * Settings, which is rare.
   */
  async #loadRemoteConnections(): Promise<void> {
    const root = this.#root
    const api = window.flow.integrations
    // WHAT WE LAST KNEW, kept across the re-check. A failed status probe must
    // not erase a tracker we already had (see `mergeConnected`), and leaving the
    // set in place until the merge lands also means the toggle does not flicker
    // hidden for the second the three round trips take.
    const previouslyConnected = this.#remoteConnected
    this.#remoteRead = null
    this.#remoteOn = false
    if (root === null || api === undefined) {
      this.#remoteConnected = []
      return
    }
    try {
      this.#remoteOn = window.localStorage.getItem(remoteListStorageKey(root)) === '1'
      // THE TRACKER THIS PROJECT WAS LAST READING. Restored whether or not the
      // column is open: hiding it is not a change of mind about whose list is
      // yours, so reopening it must land where it was left.
      this.#remoteSource = rememberedRemoteSource(
        window.localStorage.getItem(remoteSourceStorageKey(root)),
      )
    } catch {
      this.#remoteOn = false
      this.#remoteSource = null
    }
    // THREE OUTCOMES PER TRACKER, not two: connected, disconnected, or the probe
    // itself failed (`unknown`). A rejected `status()` is a `gh`/`az` resolve
    // that timed out or a handler missing mid-update — not an answer that the
    // tracker is gone. `mergeConnected` keeps the last-known set for `unknown`.
    const outcomes = new Map<IntegrationProvider, ConnectionOutcome>(
      await Promise.all(
        REMOTE_PROVIDERS.map(
          async (provider): Promise<[IntegrationProvider, ConnectionOutcome]> =>
            api
              .status({ provider })
              .then((status): [IntegrationProvider, ConnectionOutcome] => [
                provider,
                status.connected ? 'connected' : 'disconnected',
              ])
              .catch((): [IntegrationProvider, ConnectionOutcome] => [provider, 'unknown']),
        ),
      ),
    )
    // The board may have moved on while three round trips were in flight.
    if (this.#root !== root) return
    this.#remoteConnected = mergeConnected(previouslyConnected, outcomes)
    this.#render()
    if (this.#remoteOn) void this.#readRemote(false)
  }

  /** Append one lane's banner, sections and empty state, in that order. */
  #renderLane(host: HTMLElement, lanePlan: BoardLanePlan): void {
    // THE BANNER COMES FIRST AND IS NEVER OPTIONAL (NFR-2). A failed read is
    // reported where the reader is looking for the work, carrying the CLI's own
    // sentence — the board does not get to translate it, and it does not get to
    // render "Nothing here yet" instead.
    if (lanePlan.banner) {
      const banner = document.createElement('div')
      banner.className = 'fl-board-lane-banner'
      banner.setAttribute('role', 'status')
      banner.textContent = lanePlan.banner.text
      banner.title = lanePlan.banner.text
      host.appendChild(banner)
    }
    // THE HUNTS SIT ABOVE THE WORK, not among it. A producer's standing
    // instruction is what the cards below were filed against, and the model
    // deliberately keeps it out of `lanes.doing` — so the DOM appends it as its
    // own block rather than as one more card the drop handler has to know about.
    if (lanePlan.hunts) {
      for (const huntPlan of lanePlan.hunts.cards) {
        host.appendChild(this.#huntEl(huntPlan))
      }
      if (lanePlan.hunts.note !== null) {
        const note = document.createElement('div')
        note.className = 'fl-board-section-note'
        note.textContent = lanePlan.hunts.note
        note.title = lanePlan.hunts.note
        host.appendChild(note)
      }
    }
    for (const section of lanePlan.sections) {
      if (section.label !== null) {
        const heading = document.createElement('div')
        heading.className = 'fl-board-section-head'
        heading.textContent = section.label
        heading.title = section.label
        host.appendChild(heading)
      }
      if (section.note !== null) {
        const note = document.createElement('div')
        note.className = 'fl-board-section-note'
        note.textContent = section.note
        note.title = section.note
        host.appendChild(note)
      }
      for (const cardPlan of section.cards) {
        this.#cards.set(cardPlan.card.key, cardPlan.card)
        host.appendChild(this.#cardEl(cardPlan))
      }
    }
    if (lanePlan.empty) {
      const empty = document.createElement('div')
      empty.className = 'fl-board-empty'
      const text = document.createElement('div')
      text.textContent = lanePlan.empty.text
      empty.appendChild(text)
      if (lanePlan.empty.action === 'set-up-task-list') {
        // THE BUTTON DOES THE THING. It used to only toggle a paragraph telling
        // the reader to open a terminal and run `planflow-ai init` — a command
        // THIS APP ALREADY RUNS for every project it manages (provisioner.ts
        // spawns `init --claude --force --yes`, whose step 11 seeds `loops/`).
        // So the panel instructed a user to do the app's own job, in an app
        // whose premise is zero terminal interaction.
        //
        // The justification for the dead end was that authoring a directive
        // would be "the app writing a queue store directly". That was wrong:
        // spawning the bundled CLI through `project:provisionRoot` is the
        // same single init-spawn path the provisioner uses, and the CLI still
        // authors the file. The boundary is intact; only the dead end is gone.
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'fl-board-detail-link'
        button.textContent = SET_UP_LIST_LABEL
        const hint = document.createElement('div')
        hint.className = 'fl-board-empty-hint'
        hint.hidden = true
        hint.textContent = SET_UP_LIST_HINT
        const details = document.createElement('button')
        details.type = 'button'
        details.className = 'fl-board-detail-link'
        details.textContent = 'What is a task list?'
        details.addEventListener('click', () => {
          hint.hidden = !hint.hidden
        })
        button.addEventListener('click', () => {
          void this.#setUpTaskList(button)
        })
        empty.append(button, details, hint)
      }
      host.appendChild(empty)
    }
  }

  /**
   * A producer's standing hunt, as a card in Doing (Task 7.1).
   *
   * NOT DRAGGABLE, NOT CLICKABLE-INTO-A-MODAL, and it carries no lane menu: a
   * hunt is not a piece of work, so none of the gestures that move work apply to
   * it. The one thing it offers is its filed count, which filters the board to
   * (approximately) what this loop filed — Task 7.2, and the hover text says
   * "approximate" because the lineage that would make it exact does not exist.
   */
  #huntEl(plan: BoardHuntPlan): HTMLElement {
    const el = document.createElement('div')
    el.className = 'fl-board-hunt'
    el.dataset['huntKey'] = plan.hunt.key

    // THE RUN THIS CARD IS, when one has been started from here. Matched on the
    // loop AND the sentence (see runForHunt) — the card then wears the run's own
    // name instead of the paragraph somebody typed, and can be opened.
    const run = runForHunt(plan.hunt.loops, plan.hunt.text, this.#threads)

    const text = document.createElement('div')
    text.className = 'fl-board-hunt-text'
    text.textContent = run === null ? plan.hunt.text : run.title
    // The full sentence stays reachable on hover: the short title is a name, not
    // a replacement for what the run was actually asked to do.
    text.title = plan.hunt.text
    el.appendChild(text)

    const meta = document.createElement('div')
    meta.className = 'fl-board-card-meta'
    if (run !== null) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'fl-board-badge fl-board-badge-filed'
      chip.textContent = runChipText(run)
      chip.title = runChipTitle(run)
      chip.addEventListener('click', (event) => {
        event.stopPropagation()
        document.dispatchEvent(
          new CustomEvent('flow:open-thread', { detail: { threadId: run.threadId } }),
        )
      })
      meta.appendChild(chip)
    }
    const filed = document.createElement('button')
    filed.type = 'button'
    filed.className = 'fl-board-badge fl-board-badge-filed'
    filed.textContent = plan.filedLabel
    filed.title = plan.filedTitle
    filed.disabled = !plan.filterable
    filed.addEventListener('click', (event) => {
      event.stopPropagation()
      if (!plan.filterable) return
      this.#applyHuntFilter(plan.hunt)
    })
    meta.appendChild(filed)
    // The resume control (Task 7.5), when the hunt is not running. Disabled with
    // its reason on it when the write cannot be named — the panel's rule, and
    // the same shape the approve control beside it uses.
    if (plan.resume !== null) meta.appendChild(this.#huntResumeEl(plan.resume))
    el.appendChild(meta)

    if (plan.detail.length > 0) {
      const detail = document.createElement('div')
      detail.className = 'fl-board-hunt-detail'
      detail.textContent = plan.detail
      detail.title = plan.detail
      el.appendChild(detail)
    }

    // THE THIRD CARD IN THE SAME DRIFT. A hunt answered a right-click with
    // nothing, and its two real acts were reachable only by hitting a small chip
    // exactly. It is still not work — no lanes, no exits, and nothing here
    // rewrites what the loops are looking for.
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.#showHuntMenu(plan, run, event.clientX, event.clientY, el)
    })
    el.tabIndex = 0
    el.setAttribute('role', 'group')
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      const box = el.getBoundingClientRect()
      this.#showHuntMenu(plan, run, box.left + 8, box.bottom - 4, el)
    })
    return el
  }

  /** The hunt card's menu: its conversation, and what it has filed. */
  #showHuntMenu(
    plan: BoardHuntPlan,
    run: LoopRunLink | null,
    x: number,
    y: number,
    anchor: HTMLElement,
  ): void {
    this.#closeLaneMenu?.()
    const menu = document.createElement('div')
    menu.className = 'fl-board-menu'
    menu.setAttribute('role', 'menu')
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    for (const item of huntMenuItems(run !== null, plan.filterable, huntFinished(plan.hunt))) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fl-board-menu-item'
      button.setAttribute('role', 'menuitem')
      button.textContent = item.label
      button.disabled = !item.enabled
      button.title = item.blockedReason ?? item.label
      button.addEventListener('click', () => {
        this.#closeLaneMenu?.()
        if (item.id === 'filter') {
          this.#applyHuntFilter(plan.hunt)
          return
        }
        if (item.id === 'finish') {
          void this.#finishHunt(plan.hunt)
          return
        }
        if (run === null) return
        document.dispatchEvent(
          new CustomEvent('flow:open-thread', { detail: { threadId: run.threadId } }),
        )
      })
      menu.appendChild(button)
    }
    this.#mountCardMenu(menu, x, y, anchor)
  }

  /**
   * Draw the loops card (Task 7.3).
   *
   * A DUMB RENDER LAYER, exactly as the panel's was: which scope the control
   * addresses, whether it can be pressed, what it is called and how many loops
   * are running are all decided in loops-panel-model.ts. If an `if` about a
   * loop's state appears here, it belongs there.
   *
   * ONE CONTROL, ON THE COLUMN IT ACTS ON. This was a loose "▶ Resume all",
   * then a sentence, then a card describing a CLI loop — one subject wearing
   * three controls' worth of weight across the top of a board about tasks.
   *
   * It is a play button on Todo's head, and what it starts is described inside.
   */
  #renderLoopsStrip(): void {
    this.#loopsStrip.textContent = ''
    this.#loopsStrip.hidden = this.#root === null
    if (this.#root === null) return

    /**
     * THE BOARD'S OWN LOOP, on the column it works.
     *
     * This button used to clear a pause on the CLI's loop — a producer that
     * drains `flow/loops/queue.jsonl`. Every card promoted from the Remote
     * column is a Flow task record on no queue at all, so the press worked, the
     * loop had nothing to take, and a card sat in Todo for six hours while the
     * user waited for an agent that was never coming. Nothing on screen said
     * the two facts were unrelated.
     *
     * It runs the board's list now: the oldest ticked card, in that card's own
     * chat, then the next one, until nothing ticked is left.
     */
    const plan = boardLoopButton(
      this.#boardLoop,
      this.#tasks,
      this.#threads,
      this.#model?.lanes.todo ?? [],
    )
    const control = document.createElement('button')
    control.type = 'button'
    control.className = 'fl-board-lane-btn'
    control.textContent = plan.glyph
    control.classList.toggle('is-on', !plan.start)
    control.disabled = plan.disabled
    control.title = plan.title
    control.setAttribute('aria-label', plan.label)
    control.addEventListener('click', () => {
      void this.#switchTheLoop(plan.start)
    })
    this.#loopsStrip.appendChild(control)
  }

  /**
   * Start or stop the board's loop.
   *
   * MAIN OWNS THE RUN, not this view. A run outlives the Tasks tab — closing it
   * must not abandon an agent mid-task — so this asks and then draws whatever
   * comes back, rather than keeping a state of its own that could disagree.
   */
  async #switchTheLoop(start: boolean): Promise<void> {
    const root = this.#root
    if (root === null) return
    const api = window.flow.tasks.boardLoop
    if (api === undefined) {
      this.#notify("Couldn't reach the loop", 'This build of Flow cannot work the board.', 'error')
      return
    }
    // BEFORE THE LOOP READS ITS LIST. The loop takes ticked task records; a
    // loop-filed card is a bare queue item the loop cannot see and cannot be
    // ticked. Pressing ▶ is the moment work starts, and this repo's rule is
    // that a record materializes when work starts (board-model.ts) — so turn
    // each loop-filed Todo card into a ticked record now, then start.
    if (start) await this.#ensureLoopCardsWorkable(root)
    try {
      this.#boardLoop = await api({ projectRoot: root, run: start })
    } catch (error) {
      this.#notify(
        start ? "Couldn't start" : "Couldn't stop",
        ipcErrorMessage(error),
        'error',
      )
      return
    }
    // A start may have created fresh records and moved a card to Doing; re-read
    // so the board shows them rather than a local guess. Stop draws in place.
    if (start) await this.refresh({ reloadQueue: true })
    else this.#render()
    if (start && this.#boardLoop.running) {
      this.#notify('Working through the list', 'One card at a time, in its own chat.')
    }
  }

  /**
   * Turn every loop-filed Todo card into a record the loop can take.
   *
   * A card wears the `loop` chip only when a producer filed it, which is the
   * offer to work it — but a bare queue item is not a Flow record and has no
   * `autoFix` flag, so the loop (which reads records) never sees it. Create one
   * now, ticked; or tick the record a prior claim already made. Idempotent:
   * `createFromQueueItem` dedups on the external key ("pressing twice makes one
   * task"), and a card already ticked is skipped — so a second ▶ (after a run
   * finished) does not re-file anything.
   *
   * BEST EFFORT, BUT LOUD. A write that fails says so (#1767) and does not stop
   * the others; the loop still starts on whatever landed. The lane is left in
   * Todo deliberately — unlike a manual claim (#materializeRunRecord), the loop
   * itself moves the card to Doing when it takes the turn.
   */
  async #ensureLoopCardsWorkable(root: string): Promise<void> {
    const loopCards = (this.#model?.lanes.todo ?? []).filter((card) => card.origin === 'loop')
    for (const card of loopCards) {
      try {
        if (card.taskId === null) {
          const facts = runRecordFacts(card, this.#groupFor(card), this.#queueItemFor(card))
          // NULL IS UNRECORDABLE, NOT AN EMPTY WRITE: a queue that named no
          // location and an item with no link leave nothing to file the run
          // under (board-actions.ts). The claim/drag path already says so; here
          // it simply cannot join the loop, and skipping is the honest move.
          if (facts === null) continue
          await window.flow.tasks.createFromQueueItem({ projectRoot: root, ...facts, autoFix: true })
        } else {
          const record = this.#tasks.find((task) => task.id === card.taskId)
          if (record !== undefined && !record.autoFix) {
            await window.flow.tasks.update({ taskId: card.taskId, patch: { autoFix: true } })
          }
        }
      } catch (error) {
        this.#notify("Couldn't offer a loop card to the run", ipcErrorMessage(error), 'error')
      }
    }
  }

  /**
   * Pause or resume ONE loop's state pause, optionally carrying a hunt's
   * standing instruction with the resume.
   *
   * Still here after the toolbar became a single start/stop, because two other
   * callers need it: resuming a stopped hunt from its card, and switching the
   * loop off when the last hunt on it is finished.
   */
  async #setLoopsPaused(
    loop: string,
    paused: boolean,
    hunt?: { focus: string; cap: number },
  ): Promise<void> {
    const root = this.#root
    if (root === null) return
    // Guarded and caught like every sibling write (#1767): a missing method or
    // a rejected invoke must produce the notice and still reach the re-read.
    const result = (await window.flow.loops
      ?.setPaused?.({
        rootId: root,
        loop,
        paused,
        ...(hunt === undefined ? {} : { focus: hunt.focus, cap: hunt.cap }),
      })
      .catch((error: unknown) => ({ ok: false, reason: ipcErrorMessage(error) }))) ?? {
      ok: false,
      reason: 'this build of Flow cannot write to loops',
    }
    if (!result.ok) {
      this.#notify(
        paused ? "Couldn't stop the loop" : "Couldn't start the loop",
        result.reason ?? 'the write was refused',
        'error',
      )
    }
    // Re-read either way: the pause lives in state.json and the row is a view
    // of it — a local guess about whether the write landed is a second source.
    await this.refresh({ reloadQueue: true })
  }

  /**
   * Filter the board to (approximately) one hunt's filings — Task 7.2.
   *
   * A LOCAL VIEW DECISION, and the only one on this board: it changes nothing on
   * the queue, spends no read (the snapshot in hand already holds every item),
   * and survives no re-open. Clicking the same count again clears it, which is
   * the gesture a person expects from a toggle they just pressed.
   */
  #applyHuntFilter(hunt: BoardHunt): void {
    const next = huntFilterFor(hunt)
    this.#huntFilter = this.#huntFilter?.huntKey === next.huntKey ? null : next
    this.#render()
  }

  /**
   * A stopped / dry / capped hunt's resume control (Task 7.5).
   *
   * THE INTENT WAS BUILT ELSEWHERE. `huntControlFor` decided whether this can be
   * pressed, which loop the write names, how the sentence is normalized and what
   * cap it carries — this appends a button and forwards the intent. The title it
   * carries is the whole consequence (the resume also lifts the loop's pause),
   * because the label can only name one of the two.
   */
  #huntResumeEl(control: HuntControl): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-board-badge fl-board-badge-approve'
    button.textContent = control.label
    button.disabled = !control.actionable
    button.title = control.title
    button.addEventListener('mousedown', (event) => event.stopPropagation())
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      const intent = control.intent
      if (!control.actionable || intent === null) return
      void this.#setLoopsPaused(intent.loop, false, { focus: intent.focus, cap: intent.cap })
    })
    return button
  }

  #cardEl(plan: BoardCardPlan): HTMLElement {
    const boardCard = plan.card
    const task =
      boardCard.taskId === null
        ? null
        : (this.#tasks.find((candidate) => candidate.id === boardCard.taskId) ?? null)
    const card = document.createElement('div')
    card.className = 'fl-board-card'
    // Amber, copied off the model — the two states that want a human, and no
    // third path to this colour anywhere in the render layer.
    card.classList.toggle('fl-board-card-attention', boardCard.attention)
    // #1300: identity survives the re-render, so focus can be handed back to
    // the card a lane move destroyed and rebuilt.
    if (task) card.dataset['taskId'] = task.id
    card.dataset['cardKey'] = boardCard.key
    card.draggable = plan.draggable
    card.addEventListener('dragstart', (event) => {
      // The CARD's key, not the task's id: a queue item has no task to name yet,
      // and the drop handler has to be able to tell the two kinds apart.
      event.dataTransfer?.setData('text/plain', boardCard.key)
      card.classList.add('dragging')
    })
    card.addEventListener('dragend', () => card.classList.remove('dragging'))

    // WHICH PROJECTS. A task whose projects a person picked shows them as
    // chips under its title (and those replace the project line); otherwise,
    // on a Workspace board, a line of its own above the title, so a narrow
    // card never squeezes it into "b…" beside the chips.
    const projectsView = task === null ? null : this.#cardProjectsViewFor(task)
    const projectTag = projectsView?.kind === 'chips' ? null : this.#projectTagEl(task)
    if (projectTag !== null) card.appendChild(projectTag)

    const title = document.createElement('div')
    title.className = 'fl-board-card-title'
    // A working agent pulses a small accent dot at the head of the title — the
    // board's echo of the sidebar's working glyph, so a ticket being actively
    // worked reads as alive without opening its chat. Nothing for a resting
    // status; needs-decision is carried by its own "Needs your input" chip.
    const working = workingPulse(boardCard.threadStatus, boardCard.backgroundTasks)
    if (working) title.appendChild(working)
    const titleText = document.createElement('span')
    titleText.textContent = boardCard.title || 'Untitled task'
    title.appendChild(titleText)
    card.appendChild(title)
    if (task !== null && projectsView !== null && projectsView.kind !== 'none') {
      card.appendChild(this.#cardProjectsEl(task, projectsView))
    }

    const meta = document.createElement('div')
    meta.className = 'fl-board-card-meta'
    for (const chip of plan.chips) {
      const badge = document.createElement('span')
      badge.className = 'fl-board-badge'
      badge.classList.toggle('fl-board-badge-attention', chip.attention)
      badge.classList.toggle('fl-board-badge-auto', chip.mark === 'auto')
      badge.textContent = chip.text
      if (chip.title !== null) badge.title = chip.title
      meta.appendChild(badge)
    }
    meta.appendChild(this.#addToChatEl(boardCard, task))
    if (plan.approve) meta.appendChild(this.#approveEl(plan.approve))
    // The claim's other half (review finding H1). It is computed here rather
    // than in the render plan because it is the ONE control that depends on a
    // fact the plan has never carried — which installation is asking — and the
    // model deliberately holds only what a card draws.
    const release = cardRelease(boardCard, this.#model?.groups ?? [], this.#owner)
    if (release !== null) meta.appendChild(this.#releaseEl(boardCard, release))
    // The one route from a conversation to the shared list (Phase 5). Computed
    // here for the same reason `cardRelease` is: it depends on the RECORD behind
    // the card — which conversation produced it — and the model's card carries
    // only what a card draws.
    const share = cardShare(boardCard, task, this.#model?.groups ?? [])
    if (share !== null) meta.appendChild(this.#shareEl(boardCard, share))
    if (task && task.suggestDone && task.lane !== 'done') {
      // The sidebar renders the SAME blue "Done?" chip for the same suggestion as
      // a one-click accept button. On the card it used to be an inert <span>, so
      // the click fell through to the card and opened the detail modal — which
      // never mentions the suggestion — leaving `suggestDone` true. Same chip,
      // same job, same behaviour: accept in one click (#1102). #moveTask already
      // clears suggestDone and paints optimistically.
      const hint = document.createElement('button')
      hint.type = 'button'
      hint.className = 'fl-board-badge fl-board-badge-suggest'
      hint.textContent = 'Done?'
      hint.title = 'A clean turn finished — mark this task Done'
      // The card is draggable and opens the detail modal on click — stop both so
      // the chip's own gesture wins.
      hint.addEventListener('mousedown', (event) => event.stopPropagation())
      hint.addEventListener('click', (event) => {
        event.stopPropagation()
        void this.#moveTask(task.id, 'done')
      })
      meta.appendChild(hint)
    }
    // A REVIEW CARD CARRIES ITS PULL REQUEST — a link to open it and a one-click
    // Merge. Both read straight off `task.prUrl` (the board loop wrote it when it
    // moved the card here), so a Review card with no PR draws neither, the same
    // "draw what the record has, never a guess" rule the rest of this row keeps.
    if (task && task.lane === 'review' && task.prUrl) {
      const prUrl = task.prUrl
      const link = document.createElement('a')
      link.className = 'fl-board-detail-key'
      link.textContent = 'PR ↗'
      link.href = prUrl
      link.target = '_blank'
      link.rel = 'noreferrer'
      link.title = prUrl
      link.addEventListener('mousedown', (event) => event.stopPropagation())
      link.addEventListener('click', (event) => event.stopPropagation())
      meta.appendChild(link)

      const merge = document.createElement('button')
      merge.type = 'button'
      merge.className = 'fl-board-badge fl-board-badge-merge'
      merge.textContent = 'Merge'
      merge.title = 'Squash-merge this pull request on GitHub'
      // The card is draggable and opens the detail modal on click — stop both so
      // the button's own gesture wins (same guard the "Done?" chip uses).
      merge.addEventListener('mousedown', (event) => event.stopPropagation())
      merge.addEventListener('click', (event) => {
        event.stopPropagation()
        void this.#mergeTaskPr(task.id, merge)
      })
      meta.appendChild(merge)
    }
    // The meta row is ALWAYS in the card, even empty (#1512). It used to be
    // appended only when it had content, so a background turn granting the
    // "Done?" chip grew the card by a whole row — shifting every card below it
    // under a click the user had already committed to. #1192 stopped the app
    // re-SORTING the lane under the reader; geometry has to hold too, or the
    // same click still lands on the wrong task.
    card.appendChild(meta)

    // A REFUSAL RIDES THE CARD. The drag put this card back where it started;
    // without the line saying why, that reads as a missed drop target — the
    // silent snap-back #1193 already refused once for the local lane write.
    if (plan.note !== null) {
      const note = document.createElement('div')
      note.className = 'fl-board-card-note'
      note.textContent = plan.note
      note.title = plan.note
      card.appendChild(note)
    }

    if (task === null) {
      // A QUEUE ITEM IS NOT A FLOW RECORD YET. There is no detail modal to open
      // and no lane menu to offer (its only move is the claim, which is the
      // drag) — so it gets a link to the item itself where the queue named one,
      // rather than a click that opens nothing.
      if (boardCard.url !== null) {
        const link = document.createElement('a')
        link.className = 'fl-board-detail-key'
        link.textContent = 'Open ↗'
        link.href = boardCard.url
        link.target = '_blank'
        link.rel = 'noreferrer'
        link.addEventListener('mousedown', (event) => event.stopPropagation())
        link.addEventListener('click', (event) => event.stopPropagation())
        meta.appendChild(link)
      }
      // AND IT OPENS. It used to do nothing at all — the finding a loop had just
      // written was in the app and unreadable from it, and a person who
      // disagreed with one had no answer but a terminal. Same gesture as a
      // task's card, a different modal: this one is the ITEM's, because there is
      // no local record to show.
      card.addEventListener('click', () => this.#openItemDetail(boardCard))
      // #1153's rule, applied to the new kind of card: a mouse drag must not be
      // the ONLY route to a card's actions. Enter/Space opens the ticket, which
      // is where both of them live.
      card.tabIndex = 0
      card.setAttribute('role', 'button')
      card.setAttribute(
        'aria-label',
        `${boardCard.title || 'Untitled item'} — ${laneName(boardCard.lane)}, press to open`,
      )
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          this.#openItemDetail(boardCard)
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          const box = card.getBoundingClientRect()
          this.#showItemMenu(boardCard, box.left + 8, box.bottom - 4)
        }
      })
      // THE GESTURE PEOPLE ALREADY LEARNED. A card Flow owns answers a
      // right-click with a menu; an item from the shared list answered with
      // nothing, so the reader who learned the gesture one column over found it
      // silently dead here — the drift #1153 was written against, wearing a new
      // costume. Same acts as the ticket, no new verbs.
      card.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        this.#showItemMenu(boardCard, event.clientX, event.clientY)
      })
      return card
    }

    // Open the task detail (Jira-ticket-like) modal — description + brief + actions.
    card.addEventListener('click', () => this.#openTaskDetail(task.id))

    // #1153: a mouse drag used to be the ONLY route to a task's lane. The same
    // task in the thread sidebar has a context menu, a named lane, and keyboard
    // reach; the board had none of the three. Card = focusable + Enter/Space
    // opens the detail, and right-click (or the keyboard's own menu gesture)
    // offers the lanes by name.
    card.tabIndex = 0
    card.setAttribute('role', 'button')
    card.setAttribute('aria-label', `${task.title || 'Untitled task'} — ${laneName(task.lane)}`)
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        this.#openTaskDetail(task.id)
      } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault()
        const box = card.getBoundingClientRect()
        this.#showLaneMenu(task, box.left + 8, box.bottom - 4)
      }
    })
    card.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.#showLaneMenu(task, event.clientX, event.clientY)
    })
    return card
  }

  /**
   * Attach this card to the conversation — the Board→Chat bridge.
   *
   * THE SAME EVENT A TERMINAL SELECTION USES (`flow:add-to-chat`, #152), which
   * is the whole reason this is four lines: the composer already renders a badge
   * per attachment, already dedups them, and already folds their full text into
   * the message on send. A ticket is the same kind of thing as a pasted block of
   * output — something on screen you want read before you ask about it — so it
   * attaches beside one instead of inventing a second way in.
   *
   * ON EVERY CARD, not just the queue's: a person asking about work in Doing has
   * exactly the same need as one asking about an item nobody has started.
   */
  #addToChatEl(card: BoardCard, task: TaskSummary | null): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-board-badge fl-board-badge-chat'
    button.textContent = ADD_TO_CHAT_LABEL
    button.title = ADD_TO_CHAT_TITLE
    // The card is draggable and opens on click — both gestures stop here.
    button.addEventListener('mousedown', (event) => event.stopPropagation())
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#addCardToChat(card, task)
    })
    return button
  }

  /** Dispatch one card as chat context. Attaches; never sends. */
  #addCardToChat(card: BoardCard, task: TaskSummary | null): void {
    const context = cardChatContext(card, this.#queueItemFor(card), task, this.#groupFor(card))
    if (context === null) return
    // Reveal the conversation first: a badge attached to a composer nobody can
    // see is the silent no-op #1071 already fixed for the slash-command prefill.
    document.dispatchEvent(new CustomEvent('flow:show-chat'))
    document.dispatchEvent(new CustomEvent('flow:add-to-chat', { detail: context }))
  }

  /**
   * The approve control on a blocked card (Task 6.5).
   *
   * It writes through `loops:approve` — `loop approve --loop <n> --id <id>`, the
   * same CLI write the loops panel's own control performs, on the same gate a
   * headless beat reads. Disabled-with-a-reason when the model could not name
   * its target, exactly as the panel's does: a control that cannot say what it
   * would act on says so, rather than no-oping under the press.
   */
  #approveEl(approval: CardApproval): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-board-badge fl-board-badge-approve'
    button.textContent = approval.label
    button.disabled = !approval.actionable
    button.title = approval.blockedReason ?? `Clear the approval gate on item ${approval.id}`
    // The card is draggable and (for a local record) opens the detail modal on
    // click — stop both so the control's own gesture wins.
    button.addEventListener('mousedown', (event) => event.stopPropagation())
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (!approval.actionable || approval.loop === null) return
      void this.#approveItem(approval.loop, approval.id)
    })
    return button
  }

  /** One `loop approve`, then a fresh read — never an optimistic local flip. */
  async #approveItem(loop: string, id: string): Promise<void> {
    const root = this.#root
    if (!root) return
    // Guarded and caught like every sibling write (#1767) — see #setLoopsPaused.
    const result = (await window.flow.loops
      ?.approve?.({ rootId: root, loop, id })
      .catch((error: unknown) => ({ ok: false, reason: ipcErrorMessage(error) }))) ?? {
      ok: false,
      reason: 'this build of Flow cannot write to loops',
    }
    if (!result.ok) {
      this.#notify(
        "Couldn't approve this item",
        result.reason ?? `item ${id} was not approved`,
        'error',
      )
    }
    // Re-read either way: the gate lives in the queue, and the board is a view
    // of it — a local guess about whether the write landed is a second source.
    await this.refresh({ reloadQueue: true })
  }

  /**
   * The release control on a card THIS installation holds (review finding H1).
   *
   * It writes through `loops:unclaim` — `loop unclaim --loop <n> --id <id>`,
   * the same verb a stalled run's cleanup uses, on the same claim record. Until
   * this existed, a claim that landed while its local record did not could only
   * be undone from a terminal the app never mentions; the item sat held, and the
   * board said somebody else had it.
   */
  #releaseEl(card: BoardCard, release: CardRelease): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-board-badge fl-board-badge-approve'
    button.textContent = release.label
    button.disabled = !release.actionable
    button.title = release.blockedReason ?? `Give item ${release.id} back to the queue`
    // The card is draggable and (for a local record) opens the detail modal on
    // click — stop both so the control's own gesture wins.
    button.addEventListener('mousedown', (event) => event.stopPropagation())
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (!release.actionable || release.loop === null) return
      void this.#releaseItem(card, release.loop, release.id)
    })
    return button
  }

  /** One `loop unclaim`, then a fresh read — never an optimistic local flip. */
  async #releaseItem(card: BoardCard, loop: string, id: string): Promise<void> {
    const root = this.#root
    if (root === null) return
    const unclaim = window.flow.loops?.unclaim
    if (typeof unclaim !== 'function') {
      const line = 'this build of Flow cannot release items'
      this.#claimNotes.set(card.key, line)
      this.#notify("Couldn't release this item", line, 'error')
      this.#render()
      return
    }
    await this.#ensureOwner()
    const result = await unclaim({
      rootId: root,
      loop,
      id,
      ...(this.#owner === null ? {} : { owner: this.#owner }),
    }).catch((error: unknown) => {
      console.error('flow: loop unclaim failed', error)
      return { ok: false, reason: ipcErrorMessage(error), wasClaimed: false }
    })
    const notice = releaseNotice(card.title, result)
    // A refusal RIDES THE CARD, same as a refused claim: a toast is gone in five
    // seconds and the card is still sitting there unchanged. A release that
    // worked clears the note instead — the card is about to be redrawn free.
    if (result.ok) this.#claimNotes.delete(card.key)
    else this.#claimNotes.set(card.key, notice.body)
    this.#notifyOf(notice)
    // Re-read either way: the claim lives in the queue, and the board is a view
    // of it — a local guess about whether the write landed is a second source.
    await this.refresh({ reloadQueue: true })
  }

  /**
   * The Share control on a card an assistant listed in a conversation (Phase 5).
   *
   * It writes through `loops:file` — `loop file --loop <n> --title <t>`, the same
   * verb a producer files its findings with, into the same store under the same
   * cap and the same approval gate. Nothing about a shared item is written by
   * this app: the CLI owns the queue (allowed-pattern #14), and this control's
   * whole contribution is a title and the list it goes on.
   *
   * DISABLED-WITH-A-REASON rather than absent when the board cannot name one
   * list, exactly as the approve and release controls are: a card that COULD be
   * shared says why it cannot be, in the terms of the thing on screen.
   */
  #shareEl(card: BoardCard, share: CardShare): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-board-badge fl-board-badge-approve'
    button.textContent = share.label
    button.disabled = !share.actionable
    button.title =
      share.blockedReason ??
      `Put this on ${share.listLabel ?? 'the shared list'} for anyone to pick up`
    // The card is draggable and opens the detail modal on click — stop both so
    // the control's own gesture wins.
    button.addEventListener('mousedown', (event) => event.stopPropagation())
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (!share.actionable || share.loop === null) return
      void this.#shareCard(card, share.loop, share.listLabel)
    })
    return button
  }

  /**
   * One `loop file`, then the local card leaves the board — in that order, and
   * only on an answer that landed.
   *
   * THE ARCHIVE IS NOT A GUESS ABOUT THE WRITE. It happens after the CLI has
   * answered, and never on a refusal: a share that did not land leaves the card
   * exactly where it was, carrying the reason, because a card that quietly
   * vanished on a failed write would lose the work outright. `shareOutcome`
   * decides which of those it was; nothing here re-reads the result.
   */
  async #shareCard(card: BoardCard, loop: string, listLabel: string | null): Promise<void> {
    const root = this.#root
    if (root === null || card.taskId === null) return
    const file = window.flow.loops?.file
    if (typeof file !== 'function') {
      const line = 'this build of Flow cannot add to a shared list'
      this.#claimNotes.set(card.key, line)
      this.#notify("Couldn't share this", line, 'error')
      this.#render()
      return
    }
    const result = await file({ rootId: root, loop, title: card.title }).catch((error: unknown) => {
      console.error('flow: loop file failed', error)
      return { ok: false, reason: ipcErrorMessage(error), status: null }
    })
    // The raw line goes to the console even on the paths that show a cleaned-up
    // one: the flags and the absolute paths in a CLI refusal are useful to
    // whoever is debugging and are never for the reader (forbidden pattern #12).
    if (!result.ok && result.reason !== null) console.error('flow: loop file refused', result.reason)
    const outcome = shareOutcome(card.title, listLabel, result)
    if (outcome.note === null) this.#claimNotes.delete(card.key)
    else this.#claimNotes.set(card.key, outcome.note)
    if (outcome.archive) {
      try {
        await window.flow.tasks.update({ taskId: card.taskId, patch: { archived: true } })
      } catch (error) {
        // The item IS on the shared list — the write landed. All that failed is
        // taking the local copy off the board, so the reader is told that
        // instead of being told the share failed, which it did not.
        console.error('flow: archiving a shared card failed', error)
        this.#notify(
          'Shared, and the card stayed here',
          `${card.title || 'This'} is on the list — Flow just could not take this copy off the board.`,
          'error',
        )
        await this.refresh({ reloadQueue: true })
        return
      }
    }
    this.#notifyOf(outcome.notice)
    // Re-read either way: the list lives outside this app, and a local guess
    // about what is on it is a second source.
    await this.refresh({ reloadQueue: true })
  }

  /** Where the keyboard was before the detail modal took it (#1486). */
  readonly #detailFocusReturn = new OverlayFocusReturn()

  /** The open lane menu's teardown (#1153) — one menu at a time. */
  #closeLaneMenu: (() => void) | null = null

  /** Right-click / keyboard lane menu for a card: every lane by name, the
   *  current one marked — the sidebar row's vocabulary, on the board. */
  #showLaneMenu(task: TaskSummary, x: number, y: number): void {
    this.#closeLaneMenu?.()
    const menu = document.createElement('div')
    menu.className = 'fl-board-menu'
    menu.setAttribute('role', 'menu')
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    for (const item of laneMenuItems(task.lane)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fl-board-menu-item'
      button.setAttribute('role', 'menuitem')
      // The current lane is marked, not hidden: the menu doubles as the answer
      // to "which lane is this in?", and item positions never shift.
      button.textContent = item.current ? `● ${item.label}` : item.label
      button.disabled = item.current
      button.addEventListener('click', () => {
        this.#closeLaneMenu?.()
        void this.#moveTask(task.id, item.lane)
        // #1300: the move re-renders the board and destroys the focused card,
        // dropping the keyboard user on <body> — the next Tab restarted from
        // the top of the document. Re-locate the card and hand focus back.
        restoreFocusAfterAction(() => this.#cardElement(task.id))
      })
      menu.appendChild(button)
    }

    // ── The two exits ────────────────────────────────────────────────────
    // The board could move a card between four lanes and nothing else: a card
    // you no longer wanted stayed on it forever. The sidebar's row menu has had
    // both of these since #1466, and the two surfaces are meant to be ONE
    // vocabulary (#1153) — this is the half the board never got.
    const separator = document.createElement('div')
    separator.className = 'fl-board-menu-separator'
    menu.appendChild(separator)
    for (const item of cardRemovalItems(task.archivedAt !== null)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = item.danger ? 'fl-board-menu-item danger' : 'fl-board-menu-item'
      button.setAttribute('role', 'menuitem')
      button.textContent = item.label
      button.addEventListener('click', () => {
        if (item.id === 'archive') {
          this.#closeLaneMenu?.()
          void this.#setTaskArchived(task, task.archivedAt === null)
          return
        }
        // CONFIRM FIRST, in the menu itself. This destroys the task AND its 1:1
        // conversation with no undo — the largest loss available on this
        // surface, and the sibling menu in the sidebar already guards it.
        this.#confirmDeleteTask(task, menu)
      })
      menu.appendChild(button)
    }
    // A lookup, not the node: the board re-renders under an open menu.
    this.#mountCardMenu(menu, x, y, () => this.#cardElement(task.id))
  }

  /**
   * Put a card menu on screen: clamped, dismissible, keyboard-navigable.
   *
   * ONE MOUNT FOR BOTH MENUS. The lane menu had all of this and the list item's
   * new one needed every line of it — a second hand-rolled popup would have been
   * the third in this app to support arrows-and-Escape differently (#1173's
   * complaint, on the surface that already answered it once).
   */
  #mountCardMenu(
    menu: HTMLElement,
    x: number,
    y: number,
    anchor: HTMLElement | null | (() => HTMLElement | null),
  ): void {
    document.body.appendChild(menu)

    // Clamp into the viewport — a card near the bottom edge must not push the
    // items off screen (#827's rule).
    const MARGIN = 8
    if (x + menu.offsetWidth > window.innerWidth - MARGIN) {
      menu.style.left = `${Math.max(MARGIN, window.innerWidth - MARGIN - menu.offsetWidth)}px`
    }
    if (y + menu.offsetHeight > window.innerHeight - MARGIN) {
      menu.style.top = `${Math.max(MARGIN, window.innerHeight - MARGIN - menu.offsetHeight)}px`
    }

    const onDown = (event: MouseEvent): void => {
      if (!menu.contains(event.target as Node)) this.#closeLaneMenu?.()
    }
    // #1300: arrows, contained Tab, and an Escape that returns focus to the
    // card — through the SAME path #1173 gave the sidebar's row menu.
    const detachKeyboard = attachMenuKeyboard(menu, {
      close: () => this.#closeLaneMenu?.(),
      anchor,
      stopPropagation: true, // scoped: closes the menu, not the board (#1161)
    })
    let onDownTimer = 0
    this.#closeLaneMenu = () => {
      window.clearTimeout(onDownTimer)
      document.removeEventListener('mousedown', onDown, true)
      detachKeyboard()
      menu.remove()
      this.#closeLaneMenu = null
    }
    // A DISMISS CLOSED BEFORE THIS TIMER FIRES MUST NOT LEAVE ITS LISTENER BEHIND.
    // The add is deferred so the opening click cannot close the menu; the teardown
    // only ever removed a listener, so closing inside that one tick (Escape right
    // after opening, which is what a poll of this menu does) let the timer attach
    // `onOutside` for a panel that was already gone. Nothing could remove it, and
    // its closure tests a DETACHED element — so `!contains(target)` was true for
    // every later press, and the NEXT menu was dismissed on mousedown before the
    // click reached the item. Measured: the item's handler never ran, no write
    // happened, and the menu closed anyway.
    onDownTimer = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown, true)
    }, 0)
  }

  /**
   * The right-click menu for an item on the shared list.
   *
   * EVERY ENTRY IS THE TICKET'S OWN ACT. Nothing here can do something the
   * modal cannot, and a refusal rides its item rather than hiding it — a menu
   * that silently drops "Start work" while another run holds the item teaches
   * the reader that the entry does not exist.
   */
  #showItemMenu(card: BoardCard, x: number, y: number): void {
    this.#closeLaneMenu?.()
    const detail = buildQueueItemDetail(card, this.#queueItemFor(card), this.#groupFor(card))
    const menu = document.createElement('div')
    menu.className = 'fl-board-menu'
    menu.setAttribute('role', 'menu')
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    for (const entry of queueItemMenuEntries(detail)) {
      if (entry.id === 'dismiss') {
        const separator = document.createElement('div')
        separator.className = 'fl-board-menu-separator'
        menu.appendChild(separator)
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = entry.danger ? 'fl-board-menu-item danger' : 'fl-board-menu-item'
      button.setAttribute('role', 'menuitem')
      button.textContent = entry.label
      button.disabled = !entry.enabled
      button.title = entry.blockedReason ?? entry.label
      button.addEventListener('click', () => {
        this.#closeLaneMenu?.()
        if (entry.id === 'chat') {
          this.#addCardToChat(card, null)
          return
        }
        if (entry.id === 'claim') {
          void this.#claimCard(card)
          return
        }
        // Open, and Dismiss — which opens on its reason form, because the store
        // keeps that sentence forever and a menu cannot take one.
        this.#openItemDetail(card, entry.id === 'dismiss')
      })
      menu.appendChild(button)
    }
    // Found again by key, as the lane menu finds its card by task id: a redraw
    // under the open menu detaches the node it was opened from.
    this.#mountCardMenu(menu, x, y, () => this.#cardElementByKey(card.key))
  }

  /** The delete's worded confirm, in place of the menu. Safe answer focused. */
  #confirmDeleteTask(task: TaskSummary, menu: HTMLElement): void {
    const words = cardDeleteConfirm(task.title)
    menu.textContent = ''
    const label = document.createElement('div')
    label.className = 'fl-board-menu-confirm'
    label.textContent = words.question
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-board-menu-item'
    cancel.textContent = words.cancel
    cancel.addEventListener('click', () => this.#closeLaneMenu?.())
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'fl-board-menu-item danger'
    remove.textContent = words.confirm
    remove.addEventListener('click', () => {
      this.#closeLaneMenu?.()
      void this.#deleteTask(task)
    })
    menu.append(label, cancel, remove)
    // The SAFE default takes focus, never the delete (#1173's rule).
    cancel.focus()
  }

  /** Take a card off the board without destroying anything (or put it back). */
  async #setTaskArchived(task: TaskSummary, archived: boolean): Promise<void> {
    try {
      await window.flow.tasks.update({ taskId: task.id, patch: { archived } })
    } catch (error) {
      console.error('flow: failed to archive a task', error)
      this.#notify(
        archived ? "Couldn't archive this" : "Couldn't bring this back",
        ipcErrorMessage(error),
        'error',
      )
    }
    await this.refresh()
  }

  /** Destroy the task and its conversation. Confirmed before it reaches here. */
  async #deleteTask(task: TaskSummary): Promise<void> {
    try {
      await window.flow.tasks.delete({ taskId: task.id })
    } catch (error) {
      console.error('flow: failed to delete a task', error)
      this.#notify("Couldn't delete this", ipcErrorMessage(error), 'error')
    }
    await this.refresh()
  }

  /** The card element for a task, re-located after a re-render (#1300). */
  #cardElement(taskId: string): HTMLElement | null {
    return this.element.querySelector<HTMLElement>(
      `.fl-board-card[data-task-id="${CSS.escape(taskId)}"]`,
    )
  }

  /** Any card by its board key — the only identity a shared-list item has. */
  #cardElementByKey(key: string): HTMLElement | null {
    return this.element.querySelector<HTMLElement>(
      `.fl-board-card[data-card-key="${CSS.escape(key)}"]`,
    )
  }

  /**
   * A card was dropped in a lane. Two writes wear one gesture:
   *
   *  · a LOCAL RECORD moves lane through `tasks:update`, as it always has
   *  · a QUEUE ITEM dropped in Doing is CLAIMED through `loops:claim` — the same
   *    verb, the same eligibility rules and the same record on the item a
   *    headless run writes, so the two can never disagree about who holds it
   *
   * A queue item dropped anywhere else is refused OUT LOUD. Blocked and Done are
   * lanes of Flow's own records, and an item nobody has claimed has no record to
   * put in them; silently ignoring the drop would read as a missed target.
   */
  async #dropCard(cardKey: string, lane: TaskLane): Promise<void> {
    const card = this.#cards.get(cardKey)
    if (!card || card.lane === lane) return
    if (card.taskId !== null) {
      await this.#moveTask(card.taskId, lane)
      return
    }
    if (lane !== 'doing') {
      this.#notify(
        'Claim it first',
        `${card.title || 'This item'} is on the list, not in Flow yet — drop it in ${laneLabel('doing')} to claim it.`,
      )
      return
    }
    await this.#claimCard(card)
  }

  /**
   * Claim a queue item — the human half of `loop claim`.
   *
   * THE CARD DOES NOT MOVE FIRST. Every other lane change on this board is
   * optimistic, and this one must not be: a claim is a race against every other
   * engineer and every headless run on the same list, and the answer is the only
   * thing that knows who won. Painting Doing before the CLI answers would show
   * work as taken that somebody else is already doing — the duplicate-work
   * failure the claim exists to prevent.
   */
  async #claimCard(card: BoardCard): Promise<void> {
    const root = this.#root
    if (root === null || card.itemId === null) return
    const { loop, reason } = resolveCardLoop(card, this.#model?.groups ?? [])
    if (loop === null) {
      const line = reason ?? 'nothing names the loop this item belongs to'
      this.#claimNotes.set(card.key, line)
      this.#notify("Couldn't claim this item", line, 'error')
      this.#render()
      return
    }
    const claim = window.flow.loops?.claim
    if (typeof claim !== 'function') {
      const line = 'this build of Flow cannot claim items'
      this.#claimNotes.set(card.key, line)
      this.#notify("Couldn't claim this item", line, 'error')
      this.#render()
      return
    }
    // THE OWNER RIDES THE CLAIM (review finding H1). Without it the CLI mints a
    // fresh `run-<ts>-<pid>` per invocation, and a second attempt at an item this
    // window already holds is refused BY THIS WINDOW'S OWN CLAIM. With one
    // durable word the CLI's re-entrancy rule applies and the retry succeeds.
    await this.#ensureOwner()
    const result = await claim({
      rootId: root,
      loop,
      id: card.itemId,
      ...(this.#owner === null ? {} : { owner: this.#owner }),
    }).catch((error: unknown) => {
      console.error('flow: loop claim failed', error)
      return {
        status: 'refused' as const,
        loop,
        owner: null,
        reason: ipcErrorMessage(error),
        item: null,
      }
    })
    const outcome = claimOutcome(card, result, this.#owner)
    if (outcome.note === null) this.#claimNotes.delete(card.key)
    else this.#claimNotes.set(card.key, outcome.note)
    if (outcome.notice) {
      this.#notify(outcome.notice.title, outcome.notice.body, outcome.notice.level)
    }
    // The claim landed on the queue; the local record is what makes it a run.
    if (outcome.claimed) await this.#materializeRunRecord(card)
    await this.refresh({ reloadQueue: true })
  }

  /**
   * Materialize the local run record for a claimed item (Task 6.6, D3, FR-7).
   *
   * ONE MATERIALIZATION PATH, NOT TWO — and it is no longer the importer. The
   * first cut routed this through `tasks:importIssue` because that channel
   * already dedups on the string the board joins on, which is true and still
   * true. What it also does is REFETCH the issue through the integrations
   * manager, and that refetch is the reason two whole classes of claim recorded
   * nothing at all:
   *
   *  - a **ledger** queue — Flow's own list, the truth-source mode — has no
   *    tracker to fetch from, and its `<path>#<id>` key parses as no issue
   *    reference, so the import refused before it reached the store;
   *  - a **GitHub** queue on a machine with no working `gh`/PAT claimed fine
   *    and then failed the fetch on a token it should never have needed.
   *
   * `tasks:createFromQueueItem` takes the facts THIS READ ALREADY PRODUCED —
   * key, link, title, body, which store answered — and lands in the same store
   * under the same dedup rule. The importer is not kept as a fallback: the only
   * thing it can do that this cannot is the refetch, which is precisely what is
   * being removed, and a second write path here would restore the two-paths
   * problem this comment opens by refusing.
   *
   * THE RECORD OUTLIVES THE ITEM. Nothing here or anywhere else deletes it when
   * the item closes: Todo is the window and this is the record, and a run that
   * happened stays on the board (in Done, with its thread) after the list has
   * moved on.
   *
   * A CLAIM THAT LANDED IS NOT UNDONE BY A RECORD THAT DID NOT. The item is
   * held either way — reporting the gap is the honest move; quietly releasing
   * the claim would be a second write nobody asked for.
   */
  /**
   * Provision this project, which is what actually creates a task list.
   *
   * `initShared` step 11 seeds `loops/find.md` and `loops/fix.md` — paused, and
   * bound to the project's own remote when one resolves — so provisioning IS
   * the setup this panel names. The app has run it automatically for managed
   * projects since auto-provisioning landed, which is why reaching this empty
   * state usually means a provisioning run failed or `loops/` was removed, not
   * that the reader has a step left to perform.
   *
   * Goes through `project:provisionRoot`, the app's single init-spawn path.
   * The CLI still authors every file; nothing here writes a directive.
   */
  async #setUpTaskList(button: HTMLButtonElement): Promise<void> {
    const root = this.#root
    if (root === null) return
    const label = button.textContent
    button.disabled = true
    button.textContent = 'Setting up…'
    try {
      await window.flow.project.provisionRoot({ rootPath: root })
      // The directives are new files, so the previous read's answer cannot
      // describe them — force past the TTL rather than waiting it out.
      await this.refresh({ reloadQueue: true })
    } catch (error) {
      console.error('flow: failed to provision a task list', error)
      this.#notify(
        'Could not set up a task list',
        `Flow could not provision this project — ${ipcErrorMessage(error)}`,
        'error',
      )
    } finally {
      button.disabled = false
      button.textContent = label
    }
  }

  async #materializeRunRecord(card: BoardCard): Promise<void> {
    const root = this.#root
    if (root === null || card.itemId === null) return
    const group = this.#model?.groups.find((candidate) => candidate.key === card.queueKey) ?? null
    const item = group === null ? null : queueItemFor(this.#queue, group, card.itemId)
    const facts = runRecordFacts(card, group, item)
    if (facts === null) {
      this.#notifyOf(runRecordNotice(card.title, 'unrecordable'))
      return
    }
    // TWO WRITES, TWO FAILURES, TWO SENTENCES (review finding L2). One `try` used
    // to span both, so a record that was created and then failed to MOVE was
    // reported as "Claimed, with no local record" — a sentence about a record the
    // user can see sitting in Todo. Which of the two happened is decided in
    // board-actions.ts; this decides only which one to hand it.
    let created: { id: string; lane: TaskLane }
    try {
      const { task } = await window.flow.tasks.createFromQueueItem({ projectRoot: root, ...facts })
      created = task
      // The brief is part of the run record — and it is already on its way: the
      // handler fires it in the background for a record it actually created,
      // exactly as the import path does. Asking for it again from here would be
      // a second generation of one summary (which is what this path used to do),
      // and on a re-claim it would regenerate a brief that already exists.
    } catch (error) {
      console.error('flow: failed to materialize a run record for a claimed item', error)
      this.#notifyOf(runRecordNotice(card.title, 'not-created', ipcErrorMessage(error)))
      return
    }
    // A claimed item is being worked on, so its record belongs in Doing. Every
    // task is created in Todo (the store knows nothing about claims), and the
    // model reads a joined card's lane off the record — leaving it would draw
    // the card the user just claimed back in the column they took it from.
    if (created.lane === 'doing') return
    try {
      await window.flow.tasks.update({ taskId: created.id, patch: { lane: 'doing' } })
    } catch (error) {
      console.error('flow: failed to move a claimed run record into Doing', error)
      this.#notifyOf(runRecordNotice(card.title, 'not-moved', ipcErrorMessage(error)))
    }
  }

  async #moveTask(taskId: string, lane: TaskLane): Promise<void> {
    const task = this.#tasks.find((candidate) => candidate.id === taskId)
    if (!task || task.lane === lane) return
    // The ORIGIN, captured before the optimistic write below overwrites it —
    // the failure toast must name the lane the card is restored TO, and
    // reading task.lane after the mutation named the target instead (#1687).
    const from = task.lane
    // Optimistic: reflect immediately, then persist (tasks:updated re-syncs).
    task.lane = lane
    task.suggestDone = false
    this.#render()
    try {
      await window.flow.tasks.update({ taskId, patch: { lane, suggestDone: false } })
    } catch (error) {
      console.error('flow: failed to move task', error)
      // #1193: a write failure silently undid the user's drag — the card just
      // snapped back, reading as a missed drop target. The sibling READ failure
      // has said "Couldn't load tasks" since #205; a write that discards a
      // deliberate action must be at least as loud. The refresh below restores
      // the truth from the store, so the toast is the only thing telling the
      // user their move didn't happen.
      this.#notify(
        "Couldn't move this task",
        moveFailureMessage(task.title, laneLabel(from), ipcErrorMessage(error)),
        'error',
      )
      void this.refresh()
    }
  }

  /**
   * Merge a Review card's pull request (the Merge button).
   *
   * The button is disabled while the merge runs so a second click cannot fire a
   * second merge. Main does the move to Done and broadcasts tasks:updated, so a
   * success needs no manual refresh here — the board repaints itself. A failure
   * is surfaced as a toast and the card stays in Review with its PR.
   */
  async #mergeTaskPr(taskId: string, button: HTMLButtonElement): Promise<void> {
    const task = this.#tasks.find((candidate) => candidate.id === taskId)
    if (!task) return
    button.disabled = true
    try {
      const result = await window.flow.tasks.mergePr({ taskId })
      if (result.ok) {
        this.#notify('Pull request merged', result.detail)
      } else {
        this.#notify("Couldn't merge the pull request", result.detail, 'error')
        button.disabled = false
      }
    } catch (error) {
      console.error('flow: failed to merge task PR', error)
      this.#notify("Couldn't merge the pull request", ipcErrorMessage(error), 'error')
      button.disabled = false
    }
  }

  // ── Task detail (Jira-ticket-like modal) ───────────────────────────────────

  /** Open the detail modal for a task; its body re-renders live on tasks:updated. */
  #openTaskDetail(taskId: string): void {
    if (this.#detail) return // one modal at a time
    // A double-click on a card lands its second mousedown on the just-opened
    // backdrop; ignore backdrop dismissals within the double-click window so the
    // modal doesn't flash open and vanish (#511, same guard as #openNewTaskForm/#443).
    const openedAt = Date.now()
    const overlay = document.createElement('div')
    overlay.className = 'fl-board-modal-overlay'
    // This modal owns the keyboard while it is open: ⌃`/⌘B/⌘⌥Z must not mutate
    // the layout behind it, the terminal must not steal focus from its fields,
    // and Escape must keep reaching its own close handler (#1002).
    markModalOverlay(overlay)
    const modal = document.createElement('div')
    modal.className = 'fl-board-modal fl-board-detail'
    // #1486: announce it as a dialog. Nothing did — so assistive tech had no way
    // to say a modal had opened, on the one board surface that covers what the
    // keyboard is still pointing at.
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    // Focusable itself, so there is always somewhere to put the keyboard even
    // when the body has no control of its own (a task with no actions).
    modal.tabIndex = -1
    overlay.appendChild(modal)

    // #1486: remember the card, because the modal is about to cover it. Without
    // this the keyboard stayed on the covered card: its focus ring was drawn
    // BEHIND the backdrop, its own keydown handlers stayed live — Shift+F10
    // popped that card's lane menu at z-index 1100, over the z-index 1000
    // dialog — and closing left focus on <body>, so the next Tab restarted at
    // the top of the document. The shared trap (#1006) only rescues focus from
    // a `focusin`, and a modal that opens AROUND an already-focused element
    // fires none, so the backstop never ran.
    this.#detailFocusReturn.capture(overlay)

    const close = (): void => {
      this.#detail = null
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('flow:editor-file-opened', onFileOpened)
      overlay.remove()
      // Hand the keyboard back to the card that opened it — the contract #1300
      // already gave this board's lane menu, on the surface that owns it. The
      // board re-renders its cards on every tasks:updated, so the card that
      // opened the modal is often not the card on screen when it closes: find
      // its successor by task id, the way the lane menu already does.
      this.#detailFocusReturn.restore((lost) => {
        const id = lost.dataset['taskId']
        return id === undefined ? null : this.#cardElement(id)
      })
    }
    const onKey = (event: KeyboardEvent): void => {
      dismissOnEscape(event, close)
    }
    // A path in the description (or in a generated brief) renders as a file chip
    // through the shared markdown renderer; clicking it opens the file in the
    // editor this modal covers (position: fixed; inset: 0; z-index: 1000). Step
    // aside on the editor's own `flow:editor-file-opened` announcement — the
    // signal #345 added for exactly this, which the git diff overlay already
    // honours — so the file the user asked for is actually visible instead of
    // opening behind a modal they didn't expect to still be there (#961). Doing
    // it at the SIGNAL rather than on the chip's click covers every present and
    // future in-modal affordance that opens a file, and matches the sibling
    // "Open chat" action, which already closes before navigating.
    const onFileOpened = (): void => close()
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay && backdropDismissAllowed(openedAt, Date.now())) close()
    })
    document.addEventListener('keydown', onKey)
    document.addEventListener('flow:editor-file-opened', onFileOpened)

    let lastSignature: string | null = null
    const rerender = (): void => {
      const task = this.#tasks.find((candidate) => candidate.id === taskId)
      if (!task) {
        close() // deleted underneath us
        return
      }
      // tasks:updated fires globally; skip the rebuild when THIS task's rendered
      // content is unchanged, so a background mutation doesn't reset scroll (#204).
      const signature = taskDetailSignature(task)
      if (signature === lastSignature) return
      // A genuine change still rebuilds — preserve the scroll across it so the
      // reader isn't thrown to the top (#204).
      //
      // ONE OFFSET NOW, not two. The modal used to scroll AND the description
      // inside it scrolled independently at 32vh, so both had to be captured;
      // there is one region (`.fl-board-detail-scroll`) between a fixed head
      // and fixed actions, which is also what stops a reader wondering which
      // bar they are in.
      const before = modal.querySelector('.fl-board-detail-scroll')
      const offset = before instanceof HTMLElement ? before.scrollTop : 0
      this.#renderDetailBody(modal, task, close)
      lastSignature = signature
      const after = modal.querySelector('.fl-board-detail-scroll')
      if (after instanceof HTMLElement) after.scrollTop = offset
    }
    this.#detail = { taskId, rerender }
    rerender()
    // The very first rerender can close (#1768): the task may already be gone
    // from #tasks while the stale DOM still showed its card, and close() has
    // then removed the listeners and nulled #detail. Appending anyway left a
    // ghost full-screen overlay whose Escape was already dead.
    if (this.#detail === null || this.#detail.rerender !== rerender) return
    document.body.appendChild(overlay)
    // Move the keyboard INTO the dialog, the way the sibling New-task modal and
    // the lane menu both already do. First real control if there is one, else
    // the dialog itself (#1486).
    this.#focusIntoDetail(modal)
  }

  /**
   * The ticket view of an item on the shared list.
   *
   * A SECOND MODAL, DELIBERATELY. The task detail beside it is built around a
   * record Flow owns — a lane it can move, a description it can edit, a brief it
   * can generate — and an unclaimed queue item has none of those. Squeezing it
   * into that modal would mean an `if` about "is this actually ours" on every
   * control in it; this one shows what the list says and offers the two acts the
   * queue itself defines.
   */
  #openItemDetail(card: BoardCard, straightToDismiss = false): void {
    if (this.#detail) return // one modal at a time, exactly as the task's is
    const openedAt = Date.now()
    const overlay = document.createElement('div')
    overlay.className = 'fl-board-modal-overlay'
    markModalOverlay(overlay)
    const modal = document.createElement('div')
    modal.className = 'fl-board-modal fl-board-detail'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.tabIndex = -1
    overlay.appendChild(modal)
    this.#detailFocusReturn.capture(overlay)

    const close = (): void => {
      this.#detail = null
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('flow:editor-file-opened', onFileOpened)
      overlay.remove()
      // The item's card is re-rendered under the modal like any task's; find
      // its successor by card key, the one identity an item's card carries.
      this.#detailFocusReturn.restore((lost) => {
        const key = lost.dataset['cardKey']
        return key === undefined ? null : this.#cardElementByKey(key)
      })
    }
    const onKey = (event: KeyboardEvent): void => {
      dismissOnEscape(event, close)
    }
    // The #961 rule, on the SECOND modal too (#1724): this body renders through
    // the same markdown renderer, so paths become file chips — and a chip's
    // file opened BEHIND this fixed inset-0 z-1000 overlay. Same signal-level
    // listener as the task detail beside it: any in-modal affordance that
    // opens a file makes the modal step aside.
    const onFileOpened = (): void => close()
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay && backdropDismissAllowed(openedAt, Date.now())) close()
    })
    document.addEventListener('keydown', onKey)
    document.addEventListener('flow:editor-file-opened', onFileOpened)

    // A rerender that does nothing: this modal reads a SNAPSHOT, and the board
    // behind it re-reads on its own schedule. `#detail` is still claimed so the
    // one-modal-at-a-time rule holds for both kinds.
    this.#detail = { taskId: card.key, rerender: () => undefined }
    // Opened FROM the menu's "Dismiss…": the ellipsis promised the reason box,
    // so land on it rather than making the reader press Dismiss again.
    const detail = buildQueueItemDetail(card, this.#queueItemFor(card), this.#groupFor(card))
    if (straightToDismiss && detail.dismiss.actionable) {
      this.#renderDismissForm(modal, card, detail, close)
    } else {
      this.#renderItemDetailBody(modal, card, close)
    }
    document.body.appendChild(overlay)
    this.#focusIntoDetail(modal)
  }

  /** Paint the item ticket: what the list says, and the two acts it defines. */
  #renderItemDetailBody(modal: HTMLElement, card: BoardCard, close: () => void): void {
    modal.textContent = ''
    const detail = buildQueueItemDetail(card, this.#queueItemFor(card), this.#groupFor(card))

    // THE SHARED TICKET CHROME (ticket-view.ts) — the third of the three
    // surfaces that used to draw a ticket their own way.
    const frame = buildTicketFrame(modal, {
      title: detail.title,
      subtitle: detail.subtitle,
      url: detail.url,
      // A QUEUE ITEM'S LABELS ARE NOT FACTS in the tracker's sense — they are
      // a list of tags, drawn as badges below. Its status is the lane it is in,
      // which the card it was opened from already says.
      facts: [],
    })

    if (detail.labels.length > 0) {
      const labels = document.createElement('div')
      labels.className = 'fl-board-card-meta'
      for (const label of detail.labels) {
        const badge = document.createElement('span')
        badge.className = 'fl-board-badge'
        badge.textContent = label
        labels.appendChild(badge)
      }
      frame.scroll.appendChild(labels)
    }

    const body = frame.section(detail.body === null ? 'Nothing filed' : 'Description')
    if (detail.body === null) {
      body.classList.add('fl-board-detail-muted')
      body.textContent = detail.emptyBody
    } else {
      // The same renderer the task's description uses — a finding is markdown,
      // written by an agent, and file paths in it should be file chips here too.
      body.appendChild(renderMarkdown(detail.body))
    }

    const actions = frame.actions

    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'fl-board-ghost'
    dismiss.textContent = detail.dismiss.label
    dismiss.disabled = !detail.dismiss.actionable
    dismiss.title = detail.dismiss.blockedReason ?? detail.dismiss.title
    dismiss.addEventListener('click', () => {
      if (!detail.dismiss.actionable) return
      this.#renderDismissForm(modal, card, detail, close)
    })

    const claim = document.createElement('button')
    claim.type = 'button'
    claim.className = 'fl-board-new'
    claim.textContent = detail.claim.label
    claim.disabled = !detail.claim.actionable
    claim.title = detail.claim.blockedReason ?? detail.claim.title
    claim.addEventListener('click', () => {
      if (!detail.claim.actionable) return
      close()
      void this.#claimCard(card)
    })

    const toChat = document.createElement('button')
    toChat.type = 'button'
    toChat.className = 'fl-board-ghost'
    toChat.textContent = ADD_TO_CHAT_LABEL
    toChat.title = ADD_TO_CHAT_TITLE
    toChat.addEventListener('click', () => {
      this.#addCardToChat(card, null)
      close()
    })

    actions.append(toChat, dismiss, claim)

    // A refusal that cannot be pressed still has to be READABLE — a disabled
    // button's tooltip is not an explanation somebody will find.
    const blocked = detail.dismiss.blockedReason ?? detail.claim.blockedReason
    if (blocked !== null) {
      const note = document.createElement('div')
      note.className = 'fl-board-card-note'
      note.textContent = blocked
      // IN THE SCROLLER, not after the fixed foot — appended to the modal it
      // landed below the actions bar, outside the region that scrolls.
      frame.scroll.appendChild(note)
    }
  }

  /**
   * The dismissal's second step: the reason, which is not optional.
   *
   * THE STORE KEEPS IT FOREVER AND THE PRODUCERS READ IT BACK — that is the
   * whole mechanism by which rejecting an idea once stops it being filed again,
   * and it is why this is a sentence somebody types rather than a confirm
   * dialog. The CLI refuses an unexplained dismissal; so does this form.
   */
  #renderDismissForm(
    modal: HTMLElement,
    card: BoardCard,
    detail: QueueItemDetail,
    close: () => void,
  ): void {
    modal.textContent = ''
    const heading = document.createElement('div')
    heading.className = 'fl-board-modal-title'
    heading.textContent = `${detail.dismiss.label} — ${detail.title}`
    modal.appendChild(heading)

    const label = document.createElement('label')
    label.className = 'fl-board-detail-label'
    label.textContent = detail.dismissReasonLabel
    label.htmlFor = 'fl-board-dismiss-why'
    const input = inputEl('text', detail.dismissReasonPlaceholder)
    input.id = label.htmlFor
    modal.append(label, input)

    const hint = document.createElement('div')
    hint.className = 'fl-board-card-note'
    hint.textContent = detail.dismissHint
    modal.appendChild(hint)

    const problem = document.createElement('div')
    problem.className = 'fl-board-modal-error'
    problem.setAttribute('role', 'alert')
    problem.hidden = true
    const problemText = document.createElement('div')
    problemText.className = 'fl-board-modal-error-text'
    problem.appendChild(problemText)
    modal.appendChild(problem)

    const actions = document.createElement('div')
    actions.className = 'fl-board-modal-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-board-ghost'
    cancel.textContent = 'Back'
    cancel.addEventListener('click', () => this.#renderItemDetailBody(modal, card, close))
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'fl-board-new'
    confirm.textContent = detail.dismiss.label
    // GATE THE SUBMIT LOGIC, NOT JUST THE BUTTON (#1725 — the #311 rule this
    // file already states below): the Enter keydown path never consults
    // confirm.disabled, so key repeat fired one `loop close` per repeat — the
    // first won, every follow-up came back "already closed" as a spurious
    // error toast over a successful dismissal.
    let submitting = false
    const send = (): void => {
      if (submitting) return
      const why = input.value.trim()
      if (why.length === 0) {
        problem.hidden = false
        problemText.textContent = 'Say why in a sentence — the loops keep this, and read it back.'
        input.focus()
        return
      }
      submitting = true
      confirm.disabled = true
      void this.#dismissCard(card, why, close, (message) => {
        // The typed sentence survives a refusal (#1729) — same rule as the
        // New-task modal (#299): dismiss the form ONLY on success.
        submitting = false
        confirm.disabled = false
        problem.hidden = false
        problemText.textContent = message
        input.focus()
      })
    }
    confirm.addEventListener('click', send)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') send()
    })
    actions.append(cancel, confirm)
    modal.appendChild(actions)
    input.focus()
  }

  /**
   * End a hunt from its card — and stop the loop when that was its last one.
   *
   * TWO WRITES, IN THIS ORDER, and the second is conditional on what the first
   * reported. `loop finish` marks the hunt stopped (so it keeps its count and
   * moves to Done rather than vanishing); if the loop has nothing left running,
   * a loop that goes on beating with nothing to hunt is a loop burning budget on
   * an empty question, so it is paused — at RUNTIME, which is reversible from
   * the Loops screen, never in the committed directive.
   *
   * A HUNT REPORTED BY TWO LOOPS IS FINISHED FOR BOTH. The store has no owner
   * field, so the sentence belongs to every producer that reported it; ending it
   * for one and leaving it running for the other would be a state the store
   * cannot represent.
   */
  async #finishHunt(hunt: BoardHunt): Promise<void> {
    const root = this.#root
    const finish = window.flow.loops?.finishHunt
    if (root === null || hunt.loops.length === 0) return
    if (typeof finish !== 'function') {
      this.#notify("Couldn't finish this", 'this build of Flow cannot end a hunt', 'error')
      return
    }
    for (const loop of hunt.loops) {
      const result = await finish({ rootId: root, loop, focus: hunt.text }).catch(
        (error: unknown) => ({ ok: false, reason: ipcErrorMessage(error), remaining: null }),
      )
      if (!result.ok) {
        this.#notify("Couldn't finish this", result.reason ?? 'the hunt could not be ended', 'error')
        continue
      }
      if (result.remaining === 0) await this.#setLoopsPaused(loop, true)
    }
    await this.refresh({ reloadQueue: true })
  }

  /** The raw queue row behind a card, or null — the modal's body comes from it.
   *  Scoped to the card's own group (#1765): an id is unique only per queue, so
   *  an unscoped scan could hand the modal another queue's item. One code path —
   *  the same group-scoped lookup #materializeRunRecord already uses. */
  #queueItemFor(card: BoardCard): LoopQueueItem | null {
    if (card.itemId === null) return null
    const group = this.#groupFor(card)
    if (group === null) return null
    return queueItemFor(this.#queue, group, card.itemId)
  }

  /** The queue group a card belongs to, or null. */
  #groupFor(card: BoardCard): BoardQueueGroup | null {
    return this.#model?.groups.find((group) => group.key === card.queueKey) ?? null
  }

  /**
   * Settle an item with a reason — `loop close --reason wontfix`.
   *
   * NOT OPTIMISTIC, for the reason the claim beside it is not: the store decides
   * whether this lands (somebody else's claim, an item already closed), and a
   * card that vanished before the write returned would have to come back.
   *
   * The modal closes ONLY when the write landed (#1729). On refusal the form
   * stays open with the typed sentence intact — `refused` re-arms it inline —
   * because destroying a reason somebody composed over a transient refusal is
   * the exact loss the New-task modal already refuses (#299).
   */
  async #dismissCard(
    card: BoardCard,
    why: string,
    close: () => void,
    refused: (message: string) => void,
  ): Promise<void> {
    const root = this.#root
    const loop = (card.loop ?? '').trim()
    if (root === null || card.itemId === null || loop.length === 0) {
      refused('this card cannot be dismissed from here')
      return
    }
    // Caught like every sibling write (#1766): a rejected invoke must reach
    // the refused path, not strand the form's submitting latch forever.
    const result = (await window.flow.loops
      ?.close?.({
        rootId: root,
        loop,
        id: card.itemId,
        reason: 'wontfix',
        detail: why,
      })
      .catch((error: unknown) => ({
        ok: false,
        reason: ipcErrorMessage(error),
        status: null,
        note: null,
      }))) ?? {
      ok: false,
      reason: 'this build of Flow cannot settle list items',
      status: null,
      note: null,
    }
    if (!result.ok) {
      refused(result.reason ?? 'the list refused it')
      return
    }
    close()
    if (result.note !== null) {
      // `handled`, not `closed`: somebody's own issue stays open for the pull
      // request to close, and the board must not claim otherwise.
      this.#notify('Dismissed', result.note)
    }
    await this.refresh({ reloadQueue: true })
  }

  /** Put the keyboard on the modal's first control, or the dialog itself (#1486). */
  #focusIntoDetail(modal: HTMLElement): void {
    const first = modal.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    ;(first ?? modal).focus()
  }

  /** (Re)paint the detail modal's content from the latest task data. */
  #renderDetailBody(modal: HTMLElement, task: TaskSummary, close: () => void): void {
    // THE SHARED TICKET CHROME (ticket-view.ts). This surface and the two
    // beside it used to draw a ticket three ways — one bolded its title and one
    // did not, the sections were labelled differently, and none of them showed
    // the facts a tracker prints first.
    const frame = buildTicketFrame(modal, {
      title: task.title || 'Untitled task',
      subtitle:
        task.source !== 'manual' && task.externalKey
          ? `${SOURCE_LABEL[task.source]} · ${task.externalKey}`
          : '',
      url: task.externalUrl ?? null,
      // A STORED TASK CARRIES ONLY ITS LANE. The tracker's own type, priority
      // and names are not on the record — they were never imported — so the
      // ticket shows what it has rather than five rows reading "None".
      facts: ticketFacts({ status: laneName(task.lane) }),
    })
    const scroll = frame.scroll

    // #1153: the board's ticket view now NAMES the lane and offers a control
    // for it. It used to do neither, so the modal a user opens to understand a
    // task couldn't tell them where it sat, let alone move it.
    const laneRow = frame.section('Move to')
    laneRow.classList.add('fl-board-detail-lane')
    for (const item of laneMenuItems(task.lane)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fl-board-lane-btn'
      button.classList.toggle('current', item.current)
      button.setAttribute('aria-pressed', String(item.current))
      button.textContent = laneName(item.lane)
      button.disabled = item.current
      button.title = item.current ? `Already in ${laneName(item.lane)}` : item.label
      button.addEventListener('click', () => void this.#moveTask(task.id, item.lane))
      laneRow.appendChild(button)
    }

    // OFFER IT TO THE LOOP, OR DON'T. A board is also a notebook: "sometime the
    // user wanna create some item manually just to track, but no fix or
    // implement at that moment". So the loop's population is opt-in, one card at
    // a time, and this is one of the two places a person says so — the other is
    // the remote ticket, before it is even a card (autofix-control.ts).
    const auto = frame.section('Automation')
    const autoControl = createAutoFixControl(task.autoFix, AUTOFIX_ON_BOARD, (wanted, control) => {
      void window.flow.tasks
        .update({ taskId: task.id, patch: { autoFix: wanted } })
        .catch((error: unknown) => {
          // THE BOX GOES BACK. A tick that did not reach the store must not
          // stay ticked on screen — that is the app claiming a card is offered
          // to the loop when it is not.
          control.reset(!wanted)
          this.#notify("Couldn't change it", ipcErrorMessage(error), 'error')
        })
    })
    auto.append(...autoControl.nodes)

    // Technical brief — the PM-written, engineer-focused summary.
    scroll.appendChild(this.#renderBriefSection(task))

    // Original description (issue/PR body or the manual note).
    if (task.description && task.description.trim()) {
      const desc = frame.section('Description')
      desc.classList.add('fl-board-detail-desc')
      desc.appendChild(renderMarkdown(task.description))
    }

    // THE SAME STRIP THE REMOTE CARD SHOWED. The addresses were stored with
    // the task on the way in, so an imported ticket keeps its screenshots
    // without going back to the tracker — the bytes still come from main, one
    // at a time, because only main holds the credential they are behind.
    const taskImages = task.images ?? []
    const imageProvider = taskProvider(task.source)
    if (taskImages.length > 0 && imageProvider !== null) {
      const gallery = frame.section(imagesSectionLabel(taskImages.length))
      void renderTicketImages(gallery, taskImages, ipcImageFetcher(imageProvider))
    }

    // Actions.
    const actions = frame.actions
    const openChat = document.createElement('button')
    openChat.type = 'button'
    openChat.className = 'fl-board-new'
    openChat.textContent = 'Open chat'
    openChat.addEventListener('click', () => {
      // Resolve the thread in MAIN on every click, never from `task.threadId`
      // (#1061). Two ways the cached id lies, and both made this the board's
      // silent dead click:
      //   · null — the task's 1:1 chat was deleted out from under it (the sidebar
      //     drops the task layer while searching, so a task's thread appears as an
      //     ordinary row with a Delete). The old guard just closed the modal: no
      //     toast, no message, no in-app way back, leaving a task still visible,
      //     still draggable, and impossible to ever work on.
      //   · STALE — tasks:updated is debounced, so between the delete and the
      //     board's refresh the card still holds the DEAD id, and dispatching for
      //     it opens nothing at all (verified live: this window is hit about half
      //     the time when the two gestures follow each other at UI speed).
      // `ensureThread` is idempotent and re-checks that the thread still exists,
      // so a healthy task and a recovered one take the identical path and the
      // result can't depend on refresh timing.
      openChat.disabled = true
      void window.flow.tasks
        .ensureThread({ taskId: task.id })
        .then((updated) => {
          if (updated.threadId) {
            document.dispatchEvent(
              new CustomEvent('flow:open-thread', { detail: { threadId: updated.threadId } }),
            )
          }
          close()
        })
        .catch((error: unknown) => {
          // Still never a silent dead click: say why instead of closing on nothing.
          openChat.disabled = false
          const message = ipcErrorMessage(error)
          console.error('flow: failed to attach a thread to task', error)
          this.#notify("Couldn't open this task's chat", message, 'error')
        })
    })
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'fl-board-ghost'
    closeBtn.textContent = 'Close'
    closeBtn.addEventListener('click', close)

    // THE TWO EXITS, WHERE PEOPLE LOOK FOR THEM. They also live on the card's
    // right-click menu, but a ticket view that can move a task through four
    // lanes, open its chat and generate a brief — and cannot get rid of it —
    // sends the reader hunting for a gesture they have no reason to guess.
    const removal = cardRemovalItems(task.archivedAt !== null)
    const archive = document.createElement('button')
    archive.type = 'button'
    archive.className = 'fl-board-ghost'
    archive.textContent = removal[0]?.label ?? 'Archive'
    archive.title = 'Take this off the board and keep everything on it'
    archive.addEventListener('click', () => {
      close()
      void this.#setTaskArchived(task, task.archivedAt === null)
    })

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'fl-board-ghost fl-board-danger'
    remove.textContent = removal[1]?.label ?? 'Delete task + thread'
    remove.title = 'Destroy this task and the conversation that belongs to it'
    remove.addEventListener('click', () => {
      // The same worded confirm the card menu shows, in place of the actions —
      // the modal must not be the one surface where a delete fires on the first
      // click (#1390).
      this.#renderDeleteConfirm(modal, task, close)
    })

    actions.append(remove, archive, closeBtn, openChat)
  }

  /** The delete's confirm, inside the ticket view. Safe answer focused. */
  #renderDeleteConfirm(modal: HTMLElement, task: TaskSummary, close: () => void): void {
    const words = cardDeleteConfirm(task.title)
    modal.textContent = ''
    const heading = document.createElement('div')
    heading.className = 'fl-board-modal-title'
    heading.textContent = words.question
    const note = document.createElement('div')
    note.className = 'fl-board-card-note'
    // What actually goes, named — a confirm that says only "are you sure?"
    // leaves the reader guessing whether the chat survives.
    note.textContent =
      'The task, its chat, its brief and its link to the tracker all go. This cannot be undone.'
    const actions = document.createElement('div')
    actions.className = 'fl-board-modal-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-board-ghost'
    cancel.textContent = words.cancel
    cancel.addEventListener('click', () => this.#renderDetailBody(modal, task, close))
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'fl-board-new fl-board-danger'
    confirm.textContent = words.confirm
    confirm.addEventListener('click', () => {
      close()
      void this.#deleteTask(task)
    })
    actions.append(confirm, cancel)
    modal.append(heading, note, actions)
    cancel.focus()
  }

  /** The "Technical brief" section, rendered by generation status. */
  #renderBriefSection(task: TaskSummary): HTMLElement {
    // The shared ticket section's shape, hand-built because this one is
    // returned to a caller rather than appended by `frame.section`.
    const section = document.createElement('section')
    section.className = 'fl-ticket-section fl-board-detail-section'
    const label = document.createElement('div')
    label.className = 'fl-ticket-label fl-board-detail-label'
    label.textContent = 'Technical brief'
    section.appendChild(label)

    const regenerate = (): void => {
      void window.flow.tasks
        .generateBrief({ taskId: task.id })
        .catch((e: unknown) => console.error('flow: failed to generate brief', e))
    }

    if (task.briefStatus === 'ready' && task.brief) {
      const body = document.createElement('div')
      body.className = 'fl-ticket-body fl-board-detail-brief'
      body.appendChild(renderMarkdown(task.brief))
      section.appendChild(body)
      const regen = document.createElement('button')
      regen.type = 'button'
      regen.className = 'fl-board-detail-link'
      regen.textContent = 'Regenerate'
      regen.addEventListener('click', regenerate)
      section.appendChild(regen)
    } else if (task.briefStatus === 'pending') {
      const note = document.createElement('div')
      note.className = 'fl-board-detail-muted'
      note.textContent = 'Generating a technical brief…'
      section.appendChild(note)
    } else {
      const note = document.createElement('div')
      note.className = 'fl-board-detail-muted'
      // A title-only task (no description / external key) can't produce a brief —
      // generateBrief short-circuits to idle, so the button would be a dead click
      // (#362). Show a hint instead of an action that can never succeed. (An 'error'
      // status always had content, so it still offers Retry.)
      if (task.briefStatus !== 'error' && !canGenerateBrief(task)) {
        note.textContent = 'Add a description to generate a technical brief.'
        section.appendChild(note)
        return section
      }
      note.textContent =
        task.briefStatus === 'error'
          ? 'Couldn’t generate a brief. Check that an Anthropic API key is configured.'
          : 'No brief yet.'
      const gen = document.createElement('button')
      gen.type = 'button'
      gen.className = 'fl-board-detail-link'
      gen.textContent = task.briefStatus === 'error' ? 'Retry' : 'Generate technical brief'
      gen.addEventListener('click', regenerate)
      section.append(note, gen)
    }
    return section
  }

  // ── Add task (board-native modal) ──────────────────────────────────────────

  /** A notice decided in board-actions.ts, dispatched as-is — no rewording. */
  #notifyOf(notice: ClaimNotice): void {
    this.#notify(notice.title, notice.body, notice.level)
  }

  #notify(title: string, body: string, level: 'info' | 'error' = 'info'): void {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: { kind: 'state-change', rootId: this.#root ?? '', title, body, timestamp: new Date().toISOString(), level },
      }),
    )
  }

  /** Open the board's own "New task" modal (From scratch / Jira / GitHub / Azure). */
  #openNewTaskForm(): void {
    if (this.#newTaskOpen) return // one New-task modal at a time (mirrors #detail)
    const projectRoot = this.#root
    if (!projectRoot) {
      this.#notify('No project open', 'Open a project before creating a task.', 'error')
      return
    }
    this.#newTaskOpen = true
    // The overlay is position:fixed; inset:0 — it now covers the "+ New task"
    // button. On a double-click the second mousedown lands on this backdrop; guard
    // it so a dismiss arriving within the double-click window of opening is ignored
    // (#443), otherwise the primary CTA looks like a dead click.
    const openedAt = Date.now()
    const overlay = document.createElement('div')
    overlay.className = 'fl-board-modal-overlay'
    // This modal owns the keyboard while it is open: ⌃`/⌘B/⌘⌥Z must not mutate
    // the layout behind it, the terminal must not steal focus from its fields,
    // and Escape must keep reaching its own close handler (#1002).
    markModalOverlay(overlay)
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay && backdropDismissAllowed(openedAt, Date.now())) close()
    })
    const card = document.createElement('div')
    card.className = 'fl-board-modal'
    overlay.appendChild(card)
    const onKey = (event: KeyboardEvent): void => {
      dismissOnEscape(event, close)
    }
    // Dismissing WITHOUT creating (Escape / backdrop / Cancel) preserves the
    // typed draft; a successful create passes persistDraft=false to clear it (#561).
    const close = (persistDraft = true): void => {
      if (persistDraft) this.#snapshotNewTaskDraft?.()
      else this.#newTaskDrafts.delete(projectRoot)
      this.#snapshotNewTaskDraft = null
      this.#newTaskOpen = false
      overlay.remove()
      document.removeEventListener('keydown', onKey)
    }
    document.addEventListener('keydown', onKey)
    document.body.appendChild(overlay)
    this.#renderNewTaskCard(card, projectRoot, close)
  }

  #renderNewTaskCard(card: HTMLElement, projectRoot: string, close: (persistDraft?: boolean) => void): void {
    card.textContent = ''
    const heading = document.createElement('div')
    heading.className = 'fl-board-modal-title'
    heading.textContent = 'New task'
    card.appendChild(heading)

    const SOURCES = [
      { key: 'manual', label: 'From scratch' },
      { key: 'jira', label: 'Jira' },
      { key: 'github', label: 'GitHub' },
      { key: 'azure', label: 'Azure' },
    ] as const
    type Src = (typeof SOURCES)[number]['key']
    const PLACEHOLDER: Record<Exclude<Src, 'manual'>, string> = {
      jira: 'Jira key (PRJ-123) or issue URL',
      github: 'GitHub issue URL',
      azure: 'Azure work-item or PR URL',
    }
    // Restore a draft preserved from a previous accidental close (#561) — but
    // ONLY when it belongs to THIS project (keyed by root), so a draft typed in
    // project A never leaks into project B's modal (#591).
    const saved = restorableDraft(this.#newTaskDrafts.get(projectRoot) ?? null, projectRoot)
    let selected: Src =
      saved && SOURCES.some((s) => s.key === saved.selected) ? (saved.selected as Src) : 'manual'

    const tabs = document.createElement('div')
    tabs.className = 'fl-board-modal-tabs'
    const tabBtns = new Map<Src, HTMLButtonElement>()
    const syncTabs = (): void => {
      for (const [k, b] of tabBtns) b.classList.toggle('active', k === selected)
    }
    for (const s of SOURCES) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'fl-board-modal-tab'
      b.textContent = s.label
      b.addEventListener('click', () => {
        captureDraft() // save what's typed under the CURRENT tab before rebuilding (#442)
        selected = s.key
        syncTabs()
        renderBody()
      })
      tabs.appendChild(b)
      tabBtns.set(s.key, b)
    }
    card.appendChild(tabs)

    const body = document.createElement('div')
    body.className = 'fl-board-modal-body'
    card.appendChild(body)

    // Context folders (#695): the other open projects the user can add as extra
    // roots for the task's thread. Fetched async; the set survives tab round-trips
    // (it's card-scoped), and the modal body re-renders once the roots arrive.
    // Seeded from a preserved draft (#996) so an accidental dismiss restores the
    // WHOLE form — the typed text coming back while the ticked folders silently
    // vanished read as "nothing was lost" and spawned the thread without them.
    const contextRoots = new Set<string>(saved?.contextRoots ?? [])
    let otherRoots: string[] = []
    void window.flow.project
      .list()
      .then((roots) => {
        otherRoots = roots
          .filter((root) => root.rootPath !== projectRoot && root.available !== false)
          .map((root) => root.rootPath)
        if (otherRoots.length === 0) return
        // Re-render to surface the picker — preserving anything already typed.
        // Every tab shows the section now (#1694), so no tab guard: captureDraft
        // snapshots the active tab's inputs and renderBody restores them.
        captureDraft()
        renderBody()
      })
      .catch((error: unknown) => console.error('flow: failed to list roots for task context', error))

    // "Start with" — a flow command or free instructions sent as the task's
    // first message on creation (auto-starts the agent). Optional; applies to
    // both manual and imported tasks.
    const startWrap = document.createElement('div')
    startWrap.className = 'fl-board-modal-body'
    const startLabel = document.createElement('div')
    startLabel.className = 'fl-board-modal-startlabel'
    startLabel.textContent = 'Start with (optional)'
    const startInput = inputEl('text', 'A flow command or instructions — e.g. /review-pr')
    startInput.value = saved?.start ?? '' // restore a preserved draft (#561)
    const datalistId = 'fl-flow-commands'
    let datalist = document.getElementById(datalistId) as HTMLDataListElement | null
    if (!datalist) {
      datalist = document.createElement('datalist')
      datalist.id = datalistId
      document.body.appendChild(datalist)
    }
    startInput.setAttribute('list', datalistId)
    const commandList = datalist
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
    startWrap.append(startLabel, startInput)
    card.appendChild(startWrap)

    // Dangerous opt-in: run the task's agent with permission prompts skipped.
    const skipRow = document.createElement('label')
    skipRow.className = 'fl-board-modal-skip'
    const skipCheck = document.createElement('input')
    skipCheck.type = 'checkbox'
    const skipText = document.createElement('span')
    skipText.textContent = 'Skip permission prompts (dangerous)'
    skipRow.append(skipCheck, skipText)
    card.appendChild(skipRow)

    // THE LOOP OPTION, HERE RATHER THAN ON A CONTROL CENTRE. A hunt used to be a
    // standing producer with a play button on the Loops screen — a thing you
    // switched on and then had to remember to switch off. It is created with the
    // work that prompted it now, and it carries the rule that ends it from the
    // moment it exists. `syncSubmit` is passed as the change handler because a
    // custom rule with nothing typed in it is a real refusal, and a Create
    // button that stays live over one is a dead click.
    const huntWrap = document.createElement('div')
    huntWrap.className = 'fl-board-modal-body'
    card.appendChild(huntWrap)
    // MOUNTED FURTHER DOWN, where `syncSubmit` exists. The control paints itself
    // on construction and calls its change handler while doing so, so building
    // it here — above the submit button's own state — reached `syncSubmit`
    // inside its temporal dead zone and threw, taking the rest of the form's
    // elements with it. Its POSITION in the modal is this wrapper; its
    // construction is ordered by what it depends on.
    let hunt: HuntConfigControl | null = null

    const actions = document.createElement('div')
    actions.className = 'fl-board-modal-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-board-ghost'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => close())
    const submit = document.createElement('button')
    submit.type = 'button'
    submit.className = 'fl-board-new'
    actions.append(cancel, submit)
    card.appendChild(actions)

    let titleInput: HTMLInputElement | null = null
    let descInput: HTMLTextAreaElement | null = null
    let refInput: HTMLInputElement | null = null

    // Cache typed values across renderBody() rebuilds so a source-tab round-trip
    // doesn't silently wipe the title/description/ref (#442). Captured before the
    // tab switches (while `selected` still names the tab being left), restored
    // when that tab renders again.
    const draft: NewTaskDraft = saved
      ? { title: saved.draft.title, description: saved.draft.description, refs: { ...saved.draft.refs } }
      : emptyTaskDraft()
    const captureDraft = (): void => {
      if (titleInput) draft.title = titleInput.value
      if (descInput) draft.description = descInput.value
      if (refInput) draft.refs[selected] = refInput.value
    }
    // Snapshot the live inputs into the board-level draft so an accidental close
    // (Escape / backdrop / Cancel) preserves the work; cleared on create (#561).
    this.#snapshotNewTaskDraft = (): void => {
      captureDraft()
      // Per-project write (#830): an empty close only clears THIS project's
      // entry — other projects' preserved drafts are untouched.
      const picked = [...contextRoots]
      if (newTaskDraftHasContent(draft, startInput.value, picked)) {
        this.#newTaskDrafts.set(projectRoot, {
          rootPath: projectRoot,
          draft,
          selected,
          start: startInput.value,
          contextRoots: picked,
        })
      } else {
        this.#newTaskDrafts.delete(projectRoot)
      }
    }

    // Re-entrancy latch shared by every submit path. #299 keeps the modal open
    // during the in-flight create, and the inputs also submit on Enter — so a
    // button-only `disabled` guard let a second Enter fire a duplicate create +
    // thread (#311). Gate the submit LOGIC, not just the button.
    let submitting = false
    /** The current tab's required field (title for manual, ref for import). */
    const hasRequiredInput = (): boolean => {
      const field = selected === 'manual' ? titleInput : refInput
      return (field?.value.trim().length ?? 0) > 0
    }
    // Keep the button's disabled state in sync with the same canSubmit invariant
    // doSubmit gates on, so an empty required field reads as an inert (greyed)
    // button instead of a silent dead click (#412).
    const syncSubmit = (): void => {
      // The loop's own refusal counts as a missing required field: switching the
      // loop on and typing no rule is a hunt with no way to end, and a Create
      // button that stayed live over it would start one anyway.
      const huntRefusal = hunt?.refusal() ?? null
      submit.disabled = !canSubmit(submitting, hasRequiredInput() && huntRefusal === null)
      submit.title = !hasRequiredInput()
        ? selected === 'manual'
          ? 'Enter a task title'
          : 'Enter a reference to import'
        : (huntRefusal ?? '')
    }
    const setSubmitting = (value: boolean): void => {
      submitting = value
      syncSubmit()
    }

    // THE LOOP OPTION, built now that the submit button's own state exists.
    hunt = createHuntConfig(() => syncSubmit())
    huntWrap.appendChild(hunt.element)
    // SEEDED FROM WHAT THE BOARD ALREADY HAS, then re-asked. The board's own
    // snapshot is null until its first read lands, and a modal opened before
    // that would leave the switch permanently disabled — the control renders
    // "not read yet" and "this project has none" differently for exactly this
    // reason, and the difference is only worth anything if somebody asks again.
    const huntControl = hunt
    huntControl.setLoops(this.#loops)
    void window.flow.loops
      ?.read({ rootId: projectRoot })
      .then((snapshot) => huntControl.setLoops(snapshot))
      .catch((error: unknown) => console.error('flow: failed to read loops for the task form', error))
    const doSubmit = (): void => {
      const start = startInput.value.trim()
      const skip = skipCheck.checked
      if (selected === 'manual') {
        const title = titleInput?.value.trim() ?? ''
        if (!canSubmit(submitting, title.length > 0)) return
        const description = descInput?.value.trim() || undefined
        // Don't dismiss until create RESOLVES — closing eagerly threw away the
        // typed title/description on any failure (#299). Mirror the import path:
        // close only on success; on failure keep the modal + an inline retryable error.
        setSubmitting(true)
        void window.flow.tasks
          .create({
            projectRoot,
            title,
            description,
            additionalRoots: contextRoots.size > 0 ? [...contextRoots] : undefined,
          })
          .then(async (task) => {
            this.#notify('Task created', title)
            close(false) // created → clear the preserved draft (#561)
            await this.#afterCreate(task.threadId, start, skip)
            // AFTER the task exists, and only then: a hunt is pointed at work
            // that is already on the board, and starting one for a create that
            // failed would leave a loop running against nothing.
            await this.#startHuntFor(projectRoot, title, huntControl.targetLoop(), huntControl.read())
          })
          .catch((error: unknown) => {
            const plan = planManualSubmit({ ok: false, error })
            setSubmitting(false)
            const message = plan.inlineError ?? 'Unknown error'
            this.#showModalError(card, message) // keep modal + typed input, show retry-able error
            this.#notify('Could not create task', message, 'error')
          })
      } else {
        const value = refInput?.value.trim() ?? ''
        if (!canSubmit(submitting, value.length > 0)) return
        setSubmitting(true)
        // On success #importIssue closes the modal; on failure it renders an inline
        // error and the modal stays — reset the latch either way so a retry is allowed.
        const additionalRoots = contextRoots.size > 0 ? [...contextRoots] : undefined
        void this.#importIssue(projectRoot, value, additionalRoots, card, close, start, skip).finally(
          () => setSubmitting(false),
        )
      }
    }
    submit.addEventListener('click', doSubmit)
    // "Start with" is the third text field of the same form and the one filled
    // LAST, so Enter there is exactly the keystroke a completed form reaches for —
    // yet it was the only field where Enter did nothing while Enter one field up
    // created the task (#1103). There is no <form>, so nothing covered it by
    // default. doSubmit re-reads startInput.value and is gated by the `submitting`
    // latch + canSubmit, so an empty required field still can't create anything
    // and the #311 double-submit guard holds.
    startInput.addEventListener('keydown', (event) => enterSubmit(event, doSubmit))

    const renderBody = (): void => {
      body.textContent = ''
      titleInput = descInput = refInput = null
      if (selected === 'manual') {
        titleInput = inputEl('text', 'Task title')
        descInput = document.createElement('textarea')
        descInput.className = 'fl-settings-input'
        descInput.placeholder = 'Description (optional)'
        descInput.rows = 4
        descInput.style.resize = 'vertical'
        // Restore what was typed before a tab round-trip (#442).
        titleInput.value = draft.title
        descInput.value = draft.description
        body.append(titleInput, descInput)
        submit.textContent = 'Create task'
        titleInput.addEventListener('keydown', (e) => enterSubmit(e, doSubmit))
        titleInput.addEventListener('input', syncSubmit)
        titleInput.focus()
      } else {
        refInput = inputEl('text', PLACEHOLDER[selected])
        refInput.value = draftRef(draft, selected) // restore per-tab ref (#442)
        body.appendChild(refInput)
        submit.textContent = 'Import'
        refInput.addEventListener('keydown', (e) => enterSubmit(e, doSubmit))
        refInput.addEventListener('input', syncSubmit)
        refInput.focus()
      }
      // Context folders (#695): checkboxes for the other open projects; the
      // task's thread inherits the checked ones as additional roots. Rendered on
      // every tab — an imported ticket spans sibling repos as often as a manual
      // task does (#1694). Always rendered — Browse… (#852) adds folders never
      // opened in Flow, so the section is meaningful even with a single open
      // project.
      {
        const ctxLabel = document.createElement('div')
        ctxLabel.className = 'fl-board-modal-startlabel'
        ctxLabel.textContent = 'Context folders (optional)'
        body.appendChild(ctxLabel)
        const ctxList = document.createElement('div')
        ctxList.className = 'fl-board-modal-context-roots'
        const addContextRow = (rootPath: string): void => {
          const row = document.createElement('label')
          row.className = 'fl-board-modal-context-row'
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.value = rootPath
          box.checked = contextRoots.has(rootPath)
          box.addEventListener('change', () => {
            if (box.checked) contextRoots.add(rootPath)
            else contextRoots.delete(rootPath)
          })
          const name = document.createElement('span')
          name.textContent = baseName(rootPath) || rootPath
          name.title = rootPath
          row.append(box, name)
          ctxList.appendChild(row)
        }
        for (const rootPath of otherRoots) addContextRow(rootPath)
        // Browsed folders already selected but not open projects (re-render
        // preserves them) need rows too, or they'd be invisible-yet-applied.
        for (const rootPath of contextRoots) {
          if (!otherRoots.includes(rootPath)) addContextRow(rootPath)
        }
        body.appendChild(ctxList)
        // Browse… (#852): same escape hatch as the thread picker — add a
        // folder from disk; it also joins the project list (not activated).
        const browse = document.createElement('fl-button')
        browse.setAttribute('variant', 'ghost')
        browse.setAttribute('small', '')
        browse.className = 'fl-board-modal-context-browse'
        browse.textContent = '＋ Browse for another folder…'
        browse.addEventListener('click', () => {
          void window.flow.project.pickFolder().then((picked) => {
            if (picked === null || picked === projectRoot) return
            contextRoots.add(picked)
            const existing = ctxList.querySelector(`input[value="${CSS.escape(picked)}"]`)
            if (existing instanceof HTMLInputElement) {
              existing.checked = true
              return
            }
            void window.flow.project.add({ path: picked }).catch((error: unknown) => {
              console.warn('flow: could not add browsed folder as project root', { picked, error })
            })
            addContextRow(picked)
          })
        })
        body.appendChild(browse)
      }
      // Start (and stay) disabled until the required field has content (#412).
      syncSubmit()
    }
    syncTabs()
    renderBody()
  }

  /** Open the task's thread in the conversation pane (same path as a card click). */
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
        .catch((error: unknown) => {
          console.error('flow: failed to set bypassPermissions', error)
          // Fail-safe (prompts stay on), but the user's explicit choice was ignored —
          // surface it instead of silently overriding it (#297).
          const toast = skipPermissionsFailedToast(error)
          this.#notify(toast.title, toast.body, 'error')
        })
    }
    this.#openThread(threadId)
    await this.#startTask(threadId, start)
  }

  /**
   * Start the hunt a New-task form asked for. No-op when it asked for none.
   *
   * THE TASK'S TITLE IS THE HUNT'S SENTENCE, and that is the whole idea of
   * putting the switch here: "keep looking for more like this" has a `this`
   * only because the work it was created beside says what it is. The person
   * types the sentence once.
   *
   * A FAILED HUNT NEVER UNDOES THE TASK. The task is real, it is on the board,
   * and it is what the person actually asked for; the loop is an extra. So this
   * reports and returns rather than throwing into a create that has already
   * succeeded.
   */
  async #startHuntFor(
    projectRoot: string,
    aim: string,
    loop: string | null,
    config: HuntConfig,
  ): Promise<void> {
    const request = huntRequest(config)
    if (request === null || loop === null) return
    const outcome = await startHunt({
      rootPath: projectRoot,
      loop,
      write: { loop, focus: aim, ...request },
      message: agentLoopCommand(loop, aim),
      aim,
      threadTitle: aim,
      knownThreads: [],
    })
    if (outcome.ok) this.#notify('Loop started', `${loop} is looking as ${outcome.key}.`)
    else this.#notify('Could not start the loop', outcome.reason, 'error')
  }

  /** Send `start` (a flow command or instructions) as the task's first message
   *  to auto-start the agent. No-op when either is empty. */
  async #startTask(threadId: string | null, start: string): Promise<void> {
    if (!threadId || !start) return
    try {
      await window.flow.threads.sendMessage({ threadId, content: start })
    } catch (error) {
      console.error('flow: failed to start task', error)
      // The auto-start command was dropped — the thread opened empty. Tell the
      // user so they can resend it, instead of the silent dead thread (#297).
      const toast = startTaskFailedToast(error)
      this.#notify(toast.title, toast.body, 'error')
    }
  }

  /** Import an issue from the board modal; prompt to connect on a missing token. */
  async #importIssue(
    projectRoot: string,
    keyOrUrl: string,
    additionalRoots: string[] | undefined,
    card: HTMLElement,
    close: (persistDraft?: boolean) => void,
    start: string,
    skip: boolean,
  ): Promise<void> {
    try {
      const { task, created } = await window.flow.tasks.importIssue({
        projectRoot,
        keyOrUrl,
        additionalRoots,
      })
      this.#notify(
        created ? 'Task created' : 'Already imported',
        created ? `Imported ${task.externalKey ?? task.title}` : `${task.title} is already a task.`,
      )
      close(false) // imported → clear the preserved draft (#561)
      await this.#afterCreate(task.threadId, start, skip)
    } catch (error) {
      // Unwrap Electron's "Error invoking remote method …: Error: " plumbing so
      // the banner shows the main process's crafted message, not the IPC channel
      // name (#731).
      const message = ipcErrorMessage(error)
      const provider = providerOf(keyOrUrl)
      const retry = (): void =>
        void this.#importIssue(projectRoot, keyOrUrl, additionalRoots, card, close, start, skip)
      if (/token|check your token|permission/i.test(message)) {
        this.#renderConnect(card, provider, retry)
        return
      }
      // Any other failure (unrecognized ref, provider not connected, fetch
      // error): show an inline error. Offer the "Configure" CTA only when the
      // provider isn't connected yet — for a malformed URL on a connected
      // provider, configuring wouldn't help, so just show the message.
      await this.#showImportError(card, provider, message, retry)
    }
  }

  /**
   * Inline error inside the New Task modal when an import fails for a reason
   * other than a missing token — e.g. a pasted board/non-issue URL, or a
   * provider that isn't connected yet. Shows the message; when the provider
   * has no stored credentials, adds a "Configure <provider>" CTA that opens
   * the connect form (which retries on success).
   */
  async #showImportError(
    card: HTMLElement,
    provider: 'jira' | 'github' | 'azure',
    message: string,
    retry: () => void,
  ): Promise<void> {
    const connected = await window.flow.integrations
      .status({ provider })
      .then((s) => s.connected)
      .catch(() => false)
    card.querySelector('.fl-board-modal-error')?.remove()
    const banner = document.createElement('div')
    banner.className = 'fl-board-modal-error'
    banner.setAttribute('role', 'alert')
    const text = document.createElement('div')
    text.className = 'fl-board-modal-error-text'
    text.textContent = message
    banner.appendChild(text)
    // #1152: also offer it when the failure smells like credentials, even for a
    // "connected" provider — setToken stores unvalidated input, so one wrong
    // password would otherwise remove the only route back to the connect form.
    if (shouldOfferConfigure(connected, message)) {
      const label = provider === 'jira' ? 'Jira' : provider === 'azure' ? 'Azure DevOps' : 'GitHub'
      const cta = document.createElement('button')
      cta.type = 'button'
      cta.className = 'fl-board-modal-error-cta'
      cta.textContent = `Configure ${label}`
      cta.addEventListener('click', () => this.#renderConnect(card, provider, retry))
      banner.appendChild(cta)
    }
    const actions = card.querySelector('.fl-board-modal-actions')
    if (actions) card.insertBefore(banner, actions)
    else card.appendChild(banner)
  }

  /** Inline error banner inside the New Task modal for a failed manual create
   *  (#299) — message only, no provider CTA. Keeps the modal (and the typed
   *  title/description) alive so the user can fix and retry. */
  #showModalError(card: HTMLElement, message: string): void {
    card.querySelector('.fl-board-modal-error')?.remove()
    const banner = document.createElement('div')
    banner.className = 'fl-board-modal-error'
    banner.setAttribute('role', 'alert')
    const text = document.createElement('div')
    text.className = 'fl-board-modal-error-text'
    text.textContent = message
    banner.appendChild(text)
    const actions = card.querySelector('.fl-board-modal-actions')
    if (actions) card.insertBefore(banner, actions)
    else card.appendChild(banner)
  }

  /**
   * Inline connect form (in the modal) for a provider, then retry the import.
   *
   * #1152: this is a STEP INSIDE the New-task flow, not a replacement for it.
   * The task form's nodes are detached and kept — never destroyed — so Cancel
   * puts the user back with their typed title, description, reference and
   * options intact (the values live on the input elements themselves). The
   * previous one-way swap left a form whose only button was `Connect`, and
   * whose only exits (Escape/backdrop) threw the whole task away.
   */
  #renderConnect(card: HTMLElement, provider: 'jira' | 'github' | 'azure', onConnected: () => void): void {
    const taskFormNodes = [...card.childNodes]
    /** Put the task form back exactly as it was, connect form gone. */
    const restoreTaskForm = (): void => {
      card.textContent = ''
      for (const node of taskFormNodes) card.appendChild(node)
    }
    card.textContent = ''
    const heading = document.createElement('div')
    heading.className = 'fl-board-modal-title'
    const label = provider === 'jira' ? 'Jira' : provider === 'azure' ? 'Azure DevOps' : 'GitHub'
    heading.textContent = `Connect ${label}`
    card.appendChild(heading)

    // AZURE NEEDS A PLACE AS WELL AS A CREDENTIAL: it has no "everything of
    // mine, everywhere" endpoint, so a query is scoped to one project and both
    // are part of the connection.
    const fields: Array<{ key: string; placeholder: string; password?: boolean }> =
      provider === 'jira'
        ? [
            { key: 'site', placeholder: 'Site (your-team.atlassian.net)' },
            { key: 'email', placeholder: 'Account email' },
            { key: 'apiToken', placeholder: 'API token', password: true },
          ]
        : provider === 'azure'
          ? [
              { key: 'org', placeholder: 'Organisation (contoso)' },
              { key: 'project', placeholder: 'Project' },
              { key: 'pat', placeholder: 'Personal Access Token', password: true },
            ]
          : [{ key: 'pat', placeholder: `${label} Personal Access Token`, password: true }]
    const inputs = new Map<string, HTMLInputElement>()
    for (const f of fields) {
      const i = inputEl(f.password ? 'password' : 'text', f.placeholder)
      card.appendChild(i)
      inputs.set(f.key, i)
    }
    const actions = document.createElement('div')
    actions.className = 'fl-board-modal-actions'
    // #1152: the non-destructive way out, mirroring the Cancel this step
    // replaced one click earlier. Escape/backdrop still discard the whole
    // modal — that's the "throw the task away" exit, not the only one.
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'fl-board-ghost' // same treatment as the Cancel it stands in for
    back.textContent = 'Cancel'
    back.addEventListener('click', restoreTaskForm)
    actions.appendChild(back)
    const connect = document.createElement('button')
    connect.type = 'button'
    connect.className = 'fl-board-new'
    connect.textContent = 'Connect'
    const v = (k: string): string => inputs.get(k)?.value.trim() ?? ''
    const allFilled = (): boolean => fields.every((f) => v(f.key).length > 0)
    // Same inert-not-silent invariant as the sibling submit button (#412) and
    // the Integrations Save (#217): Connect greys out (with a hint) until every
    // required field has content, instead of silently no-oping on click (#709).
    const syncConnect = (): void => {
      connect.disabled = !allFilled()
      connect.title = allFilled() ? '' : 'Fill every field'
    }
    for (const i of inputs.values()) i.addEventListener('input', syncConnect)
    syncConnect()
    connect.addEventListener('click', () => {
      if (!allFilled()) return
      const token =
        provider === 'jira'
          ? ({ provider: 'jira', site: v('site'), email: v('email'), apiToken: v('apiToken') } as const)
          : provider === 'azure'
            ? ({ provider: 'azure', pat: v('pat'), org: v('org'), project: v('project') } as const)
            : ({ provider: 'github', pat: v('pat') } as const)
      void window.flow.integrations
        .setToken(token)
        .then(() => {
          // #1152: back to the TASK form before retrying. The retry's failure
          // banner belongs next to the reference field the user has to edit —
          // it used to render into the credentials form, where the reference
          // was neither visible nor editable.
          restoreTaskForm()
          onConnected()
        })
        .catch((e: unknown) => console.error('flow: setToken failed', e))
    })
    actions.appendChild(connect)
    card.appendChild(actions)
    inputs.values().next().value?.focus()
  }
}

/**
 * Wire the singleton Kanban board: open it as an editor tab on `flow:open-board`
 * (from the status bar), follow the active project, and refresh on task changes.
 */
export function initTaskBoard(editorApi: EditorApi, container?: HTMLElement): void {
  const api = window.flow
  if (!api?.tasks || !api?.project) {
    console.warn('flow: preload bridge missing — task board disabled')
    return
  }
  const board = new KanbanBoard(editorApi)

  api.tasks.onUpdated(() => board.handleTasksUpdated())
  // THE LOOP ANNOUNCES ITSELF, so the button never has to be polled for. Main
  // owns the run — it outlives this tab — and pushes every start, hand-over and
  // stop; the board is a view of that and keeps no second answer of its own.
  api.tasks.onBoardLoopChanged?.((state) => board.handleBoardLoopChanged(state))
  api.project.onActiveChanged((context) => board.setActiveRoot(context?.rootPath ?? null))
  // ONE BOARD PER WORKSPACE (Phase 9): switching Workspace switches the board.
  // The scope is read from the one shared store; a card's extra projects are
  // re-read only when main says they changed.
  if (api.workspaces !== undefined) {
    workspaceScope.subscribe((state) => board.setWorkspaceState(state))
    api.workspaces.onChanged((event) => {
      if (event.cause === 'task-projects') board.handleTaskProjectsChanged()
    })
  }

  // KEEP THE LIST IN STEP WITH THE LOOPS. Everything else on this board
  // announces itself; the loop's list does not — it is written by a CLI in
  // another process (or by GitHub), so a loop that filed three findings while
  // somebody watched left the board showing what it held when they opened it.
  // A tick that is off-screen costs nothing (see `pollTick`).
  window.setInterval(() => void board.pollTick(), QUEUE_POLL_MS)
  // The cheap half: a run's chip follows its conversation's status. Cheap is
  // relative, though — a STREAMING turn broadcasts a 50ms batch continuously,
  // and answering every one with a thread list + a full board repaint is ~20
  // repaints a second while an agent works, which is what a spinning cursor is
  // made of. Two filters, the same two the sidebar settled on (#1696):
  //   · a batch of pure tool-call churn changes no thread row this board draws
  //   · a board nobody is looking at repaints on the way back in, not now
  api.threads.onUpdated((events) => {
    if (!threadEventsAffectSidebar(events)) return
    void board.refreshThreads()
  })
  // WORK THAT OUTLIVES A TURN. The status above goes back to resting the
  // moment an agent backgrounds its sub-agents, so without this the card of a
  // running multi-agent review sits on the board looking abandoned. Not a
  // threads:updated event: none of this is in the database.
  api.threads.onStream((event) => {
    if (event.kind === 'background-tasks') {
      board.applyBackgroundTasks(event.threadId, event.tasks.length)
    }
  })
  // What was already running when the board mounted — the runtime only
  // re-announces a set that CHANGED, so a board opened mid-run would otherwise
  // stay quiet until something finished.
  void api.threads
    .backgroundTasks?.({})
    .then((running) => {
      for (const [threadId, tasks] of Object.entries(running)) {
        board.applyBackgroundTasks(threadId, tasks.length)
      }
    })
    .catch(() => {
      // An older preload has no such call: the stream still brings the next
      // change, and "nothing running yet" is the right thing to believe.
    })

  // Follow the conversation the reader is in (Phase 4, FR-5) — the SAME signal
  // the pending-changes review and the source-control panel already follow, not
  // a second answer to "which thread is active". `threads/index.ts` dispatches
  // it from selectThread / clearSelectedThread, whose own source is the
  // persisted `active_thread_id` that main hands back on the project context.
  document.addEventListener('flow:active-thread', (event) => {
    const detail = (event as CustomEvent<{ threadId: string | null; title?: string | null }>).detail
    board.setActiveThread(detail?.threadId ?? null, detail?.title ?? null)
  })

  void api.project
    .active()
    .then((context) => {
      board.setActiveRoot(context ? context.rootPath : null)
      // THE BOOT CASE (#1083, one surface over). The restore happens in main
      // before any of this renderer wiring exists, so the change event above
      // never fires for it — and a board tab opened later would sit unnarrowed
      // over a conversation that has been open since launch. Same fact, same
      // source: the project context's own `activeThreadId`, resolved to a
      // title through the thread the sidebar would have named.
      const threadId = context?.activeThreadId ?? null
      if (threadId === null) return
      return api.threads
        .get({ threadId })
        .then((detail) => {
          // Recorded thread since deleted (the #411 dangling pointer): there is
          // no conversation to narrow to, so the board stays the whole board.
          board.setActiveThread(detail?.id ?? null, detail?.title ?? null, { onlyIfUnset: true })
        })
        .catch(() => undefined)
    })
    .catch(() => undefined)

  if (container) {
    container.appendChild(board.element)
    board.ensureLoaded()
  }

  // THE REVEAL SEAM (#1666's, verbatim in shape). The board hides two ways — a
  // different editor tab, or the whole editor host toggled away — and only the
  // second is visible to the tab strip. An IntersectionObserver sees both,
  // because it fires on a display flip of any ancestor; entering the viewport
  // with nothing deferred is a no-op inside `handleRevealed`.
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) board.handleRevealed()
  }).observe(board.element)

  // The project's list was re-pointed in Settings. Decoupled through document
  // like every other cross-surface signal here — the settings panel knows
  // nothing about the board, and the board owns what it does about it.
  document.addEventListener('flow:loops-changed', () => board.handleListChanged())
  // A tracker connected/disconnected in Settings — re-check so the Remote toggle
  // shows (or goes) without leaving and re-entering the project (#0c8f00e6 gap).
  document.addEventListener('flow:integrations-changed', () => board.handleIntegrationsChanged())

  document.addEventListener('flow:open-board', () => {
    // Reveal the editor host first so the board tab appears even when the editor
    // is hidden (⌘P "Tasks"/"Open Board").
    document.dispatchEvent(new CustomEvent('flow:show-editor'))
    if (container) {
      if (!container.contains(board.element)) {
        container.appendChild(board.element)
      }
      board.ensureLoaded()
    } else {
      editorApi.openView({ id: BOARD_TAB_ID, label: 'Tasks', icon: 'checklist', element: board.element })
      board.ensureLoaded()
    }
  })
}

function inputEl(type: string, placeholder: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = type
  input.className = 'fl-settings-input'
  input.placeholder = placeholder
  return input
}

function enterSubmit(event: KeyboardEvent, fn: () => void): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    fn()
  }
}

/** Infer the provider from a pasted reference (for the connect form). */
/**
 * Which tracker a stored task came from, or null when it came from none.
 *
 * READ OFF THE RECORD, never guessed from a key. `source` is what the importer
 * wrote at the moment it knew; `providerOf` below is a guess from a string, and
 * a guess is not good enough to pick whose credential an attachment is fetched
 * with. A manual task has no tracker at all, which is what null says.
 */
function taskProvider(source: TaskSummary['source']): IntegrationProvider | null {
  return source === 'manual' ? null : source
}

function providerOf(text: string): 'jira' | 'github' | 'azure' {
  if (/dev\.azure\.com|visualstudio\.com/.test(text)) return 'azure'
  if (/github\.com|^[\w.-]+\/[\w.-]+#\d+$/.test(text)) return 'github'
  return 'jira'
}

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-board { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--fl-color-bg); }
    /* NO HEADER RULE, because there is no header. The board's top band is gone
       and its two verbs live on Todo's own head, so the first thing under the
       tab is the columns — and the seam that used to separate the band from
       them separated nothing. */
    .fl-board-subtitle {
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
      padding: var(--fl-space-sm) var(--fl-space-md) 0;
    }
    .fl-board-subtitle:empty { display: none; }
    /* Still a shared button class — the modals use it for their primary action;
       it just no longer appears on the board's own surface. */
    .fl-board-new {
      display: inline-flex; align-items: center; height: 24px;
      border: var(--fl-border-width) solid var(--fl-color-border); background: var(--fl-color-surface);
      color: var(--fl-color-text); border-radius: var(--fl-radius-sm); padding: 0 var(--fl-space-sm); cursor: pointer;
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size); white-space: nowrap;
    }
    .fl-board-new:hover:not(:disabled) { border-color: var(--fl-color-text-secondary); }
    .fl-board-new:disabled { opacity: 0.5; cursor: default; }
    .fl-board-ghost {
      display: inline-flex; align-items: center; height: 24px;
      border: none; background: transparent; color: var(--fl-color-text-secondary);
      border-radius: var(--fl-radius-sm); padding: 0 var(--fl-space-sm); cursor: pointer;
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size); white-space: nowrap;
    }
    .fl-board-ghost:hover { color: var(--fl-color-text); background: var(--fl-color-surface-raised); }
    /* An anchor wearing the ghost's clothes — the ticket card's "open where it
       lives" — should read as one of the row's buttons, not as prose with a
       rule under it. */
    a.fl-board-ghost { text-decoration: none; }
    /* Four columns have to fit the narrowest window the app allows, and the
       arithmetic is tight enough to be worth writing down: a 960px minimum
       window (WINDOW_MIN_WIDTH) less the 48px activity rail and a ~240px
       sidebar leaves the board about 672px. Four columns cost
       4 × (150px + 2px border) + 3 × 12px gap + 2 × 12px padding = 668px, so
       they fit. The old 220px min-width wanted 948px for three columns and
       would have wanted 1,180px for four — i.e. the board would have scrolled
       sideways at every window size a laptop actually uses. The overflow: auto
       below stays as the last resort, not the normal case. */
    .fl-board-columns { flex: 1; min-height: 0; display: flex; gap: var(--fl-space-md); padding: var(--fl-space-lg) var(--fl-space-md); overflow: auto; }
    .fl-board-column {
      flex: 1; min-width: 150px; display: flex; flex-direction: column; min-height: 0;
      background: var(--fl-color-surface); border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
    }
    .fl-board-column-naming { display: inline-flex; align-items: center; gap: var(--fl-space-sm); }
    /* THE REMOTE COLUMN reads as somebody else's list rather than one of this
       project's lanes: a dashed edge and no fill, so a glance tells you which
       side of the boundary a card is on before you read a word of it. What is
       in it is what a TRACKER says is assigned to you — not a lane, not a
       claim, and nothing this board may edit. */
    .fl-board-remote {
      background: transparent;
      border-style: dashed;
      /* Wider than a lane by the width of its own head: the name, the count,
         a tracker picker and a refresh all live on one row there, and at a
         lane's 200px the last of them was clipped off the edge. */
      flex: 0 1 220px;
    }
    .fl-board-remote[hidden] { display: none; }
    .fl-board-remote-provenance {
      padding: 2px 4px 6px; color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
      letter-spacing: normal; text-transform: none;
    }
    .fl-board-remote-provenance[hidden] { display: none; }
    .fl-board-remote-picker, .fl-board-remote-mode {
      max-width: 96px; min-width: 0; height: 20px; padding: 0 2px;
      background: transparent; color: var(--fl-color-text-secondary);
      border: none; border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
      text-transform: none; letter-spacing: normal;
    }
    .fl-board-remote-picker[hidden], .fl-board-remote-mode[hidden] { display: none; }
    .fl-board-remote .fl-board-column-naming > span[hidden] { display: none; }
    /* A button, not a draggable card: the one thing that can happen to a remote
       item is becoming a task, and a card that only answers a drag nobody
       guesses at is a control with no affordance. */
    .fl-board-remote-card {
      display: block; width: 100%; text-align: left;
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text);
    }
    .fl-board-card-title { overflow-wrap: anywhere; }
    .fl-board-card-facts {
      margin-top: 2px; color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    /* The loader: a spinner and a sentence, on the ground the cards sit on so
       it reads as the column working rather than as an item in it. */
    .fl-board-remote-loading {
      display: flex; align-items: center; gap: var(--fl-space-sm);
      padding: var(--fl-space-sm) var(--fl-space-xs);
      color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size);
    }
    /* The pressed control says it is working too — the column appears in the
       same frame, but the button is where the finger was. */
    .fl-board-lane-btn.is-busy { color: var(--fl-color-accent); opacity: 0.7; }
    .fl-board-remote-card.is-taken { opacity: 0.55; cursor: default; }
    .fl-board-remote-card.is-taken:hover { border-color: var(--fl-color-border); }
    .fl-board-column-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: var(--fl-space-sm) var(--fl-space-md);
      font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium);
      letter-spacing: 0.06em; text-transform: uppercase; color: var(--fl-color-text-secondary);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-board-count {
      min-width: 18px; text-align: center; padding: 0 6px; border-radius: 9px;
      background: var(--fl-color-surface-raised); color: var(--fl-color-text-secondary);
    }
    /* THE LANE'S OWN VERBS. Pushed to the right edge of the head so the name
       and the count stay where a reader's eye already goes, and sized to the
       head's own text rather than to a toolbar's. NO BACKTICKS IN HERE — this
       whole stylesheet is a template literal and one ends it, with a
       TypeScript error pointing somewhere else entirely. */
    .fl-board-lane-controls { display: inline-flex; align-items: center; margin-left: auto; }
    .fl-board-lane-controls[hidden] { display: none; }
    .fl-board-lane-controls + .fl-board-lane-btn { margin-left: 0; }
    .fl-board-lane-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; flex: none; margin-left: auto;
      border: none; border-radius: var(--fl-radius-sm); background: transparent;
      color: var(--fl-color-text-secondary); cursor: pointer; line-height: 1;
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
    }
    .fl-board-lane-btn:hover:not(:disabled) {
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
    }
    /* A running loop is the one state worth colouring: it is the difference
       between a board that is working and one that is waiting for you. */
    .fl-board-lane-btn.is-on { color: var(--fl-color-accent); }
    .fl-board-lane-btn:disabled { opacity: 0.4; cursor: default; }
    /* MINIMIZE / MAXIMIZE (#1902). A folded lane shrinks to a thin vertical
       strip: its cards and its secondary verbs are hidden, its head stands up on
       end showing name + count, and the whole strip is clickable to restore it.
       The collapse control stays on top as the strip's expand affordance. */
    .fl-board-column.is-collapsed {
      flex: 0 0 auto; min-width: 0; width: 40px; cursor: pointer;
    }
    /* A card dragged onto the folded strip is a real drop target — say so. */
    .fl-board-column.is-collapsed.drag-over { background: var(--fl-color-accent-muted); }
    .fl-board-column.is-collapsed .fl-board-cards { display: none; }
    .fl-board-column.is-collapsed .fl-board-lane-controls,
    .fl-board-column.is-collapsed .fl-board-column-head .fl-board-lane-btn:not(.fl-board-lane-collapse) {
      display: none;
    }
    .fl-board-column.is-collapsed .fl-board-column-head {
      flex-direction: column; align-items: center; justify-content: flex-start;
      gap: var(--fl-space-sm); height: 100%; padding: var(--fl-space-sm) 2px; border-bottom: none;
    }
    .fl-board-column.is-collapsed .fl-board-column-naming {
      writing-mode: vertical-rl; align-items: center; gap: var(--fl-space-sm);
    }
    /* The control on top, the vertical name below it. */
    .fl-board-column.is-collapsed .fl-board-lane-collapse { order: -1; margin: 0; }
    .fl-board-cards { flex: 1; min-height: 0; overflow-y: auto; padding: var(--fl-space-sm); display: flex; flex-direction: column; gap: var(--fl-space-sm); }
    .fl-board-cards.drag-over { background: var(--fl-color-accent-muted); border-radius: var(--fl-radius-sm); }
    .fl-board-card {
      background: var(--fl-color-surface-raised); border: var(--fl-border-width) solid var(--fl-color-border);
      /* The container radius the rest of the app settled on — a 4px corner on a
         card this size reads as square. */
      border-radius: var(--fl-radius-md); padding: var(--fl-space-sm); cursor: pointer;
    }
    /* Hover LIFTS rather than outlines: a focus-ring-coloured border on hover
       said "focused" about a card nobody had focused, next to a real focus ring
       two lines below that means it. */
    .fl-board-card:hover { border-color: var(--fl-color-text-secondary); }
    /* #1153 — the card is focusable now, so it needs a visible focus ring. */
    .fl-board-card:focus-visible { outline: 2px solid var(--fl-color-accent); outline-offset: 2px; }
    /* Lane menu (right-click / Shift+F10 on a card). */
    .fl-board-menu {
      position: fixed; z-index: 1100; min-width: 170px; padding: 4px;
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md); box-shadow: var(--fl-shadow-md);
      font-size: var(--fl-text-ui-size);
    }
    .fl-board-menu-item {
      display: block; width: 100%; text-align: left; padding: 4px 8px;
      background: none; border: none; border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text); cursor: pointer;
    }
    .fl-board-menu-item:hover:not(:disabled) { background: var(--fl-color-surface); }
    .fl-board-menu-item:disabled { opacity: 0.6; cursor: default; }
    /* The destructive item reads as one BEFORE it is pressed — the sidebar's
       own treatment for the same act, on the surface that lacked it. */
    .fl-board-menu-item.danger { color: var(--fl-color-danger, #d9534f); }
    .fl-board-danger { color: var(--fl-color-danger, #d9534f); }
    .fl-board-danger:hover { border-color: var(--fl-color-danger, #d9534f); }
    .fl-board-menu-separator {
      height: var(--fl-border-width); margin: var(--fl-space-xs) 0;
      background: var(--fl-color-border);
    }
    .fl-board-menu-confirm {
      padding: var(--fl-space-xs) var(--fl-space-sm);
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text);
      max-width: 32ch; line-height: 1.4;
    }
    /* Lane row in the detail modal — the board's ticket view names the lane. */
    /* A ROW OF CHOICES, NOT A SPREAD. Inside the ticket's section the lane
       buttons became flex CHILDREN of a column and stretched across the
       dialog, so four words sat one per quarter-width with nothing between
       them. They are a row of chips again. */
    .fl-board-detail-lane {
      display: flex; flex-direction: row; align-items: center;
      gap: var(--fl-space-xs); flex-wrap: wrap;
    }
    /* ONE CLASS NAME, TWO POPULATIONS — and for a while, one broken pair. The
       column head's icon buttons and these lane chips both answer to
       .fl-board-lane-btn, and the head's rule sizes its icons at a 20px square
       pushed right by margin-left:auto. Unscoped, that rule reached these
       chips too: four words at 20px each, shoved apart across the dialog. The
       chips are scoped to their own row now, so their rule wins, and the three
       properties the head sets for an icon are said back explicitly rather
       than left to cascade order. */
    .fl-board-detail-lane .fl-board-lane-btn {
      width: auto; height: auto; margin-left: 0; flex: 0 0 auto;
      padding: 3px var(--fl-space-sm); border-radius: var(--fl-radius-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      background: transparent; color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size); cursor: pointer;
    }
    .fl-board-detail-lane .fl-board-lane-btn:hover:not(:disabled) { border-color: var(--fl-color-focus-ring); color: var(--fl-color-text); }
    .fl-board-detail-lane .fl-board-lane-btn.current { background: var(--fl-color-surface-raised); color: var(--fl-color-text); border-color: var(--fl-color-accent); cursor: default; }
    .fl-board-card.dragging { opacity: 0.5; }
    .fl-board-card-title {
      color: var(--fl-color-text); font-size: var(--fl-text-ui-size);
      overflow-wrap: anywhere; line-height: var(--fl-line-height);
    }
    /* The working glyph — a small accent dot at the head of the title, the
       board's echo of the sidebar's working pulse. Inline so a long title still
       wraps normally around it; its opacity animation is applied in JS and
       omitted under prefers-reduced-motion. */
    .fl-board-card-working {
      display: inline-block; width: 7px; height: 7px; border-radius: 50%;
      background: var(--fl-color-accent); margin-right: var(--fl-space-xs);
      vertical-align: middle; flex: none;
    }
    /* min-height = the badge row's 15px line, so a chip appearing (or leaving)
       never changes the card's height — cards must not move under a committed
       click (#1512). */
    .fl-board-card-meta {
      display: flex; align-items: center; gap: var(--fl-space-xs);
      margin-top: var(--fl-space-xs); min-height: 18px;
      /* NOTHING LEAVES THE CARD. A lane is 186px wide and a card's meta row is
         150; "you · just now · Add to chat · Done?" needs 191. With every child
         nowrap and none of them allowed to shrink, the overflow went somewhere:
         the last button was pushed clean past the card's right edge into the
         gutter between two columns, where its own centre point belongs to no
         column at all. It looked fine and could not be clicked. */
      overflow: hidden;
    }
    /* The facts give way first, and they can afford to: each one carries its
       full text in a title. A control cannot degrade — half a button is not a
       smaller button, it is a button somewhere else. */
    span.fl-board-badge { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    /* THE LOOP MARK NEVER SHRINKS. It is one glyph wide and it is the whole of
       what it says — an ellipsised marker marks nothing. */
    span.fl-board-badge.fl-board-badge-auto { flex: none; color: var(--fl-color-accent); }
    /* AND IT IS NOT ONE OF THE FACTS, so it takes no middot. The separator
       belongs between things being read as a list ("you · just now"); putting
       one after a mark spends ~14px of a 150px row on punctuation, which on a
       narrow card is the difference between "just now" and "just …". */
    span.fl-board-badge-auto + span.fl-board-badge::before { content: none; }
    button.fl-board-badge { flex: none; }
    /*
     * FACTS ARE TEXT; ACTIONS ARE BUTTONS.
     *
     * Every chip on a card — "you", "just now", "Add to chat", "Approve" —
     * carried the same accent-tinted pill, so two passive labels and a control
     * were indistinguishable, and a card read as a row of three buttons of
     * which one worked. The passive ones are plain muted text now.
     *
     * nowrap because these are two-word labels in a ~150px column: without it
     * "just now" broke across two lines and the card grew a row for it.
     */
    .fl-board-badge {
      padding: 0; border-radius: var(--fl-radius-sm); font-size: var(--fl-text-caption-size);
      line-height: 18px; white-space: nowrap;
      color: var(--fl-color-text-secondary); background: transparent;
    }
    /*
     * Anything pressable keeps a surface to press, and says so on hover.
     *
     * The ground is --fl-color-bg, not surface-raised: the CARD is already
     * surface-raised, so a raised button on it was the same colour as the thing
     * behind it and read as plain text. A control has to be darker or lighter
     * than what it sits on; which one does not matter, sameness does.
     */
    button.fl-board-badge {
      padding: 0 var(--fl-space-xs); background: var(--fl-color-bg);
      color: var(--fl-color-text-secondary); cursor: pointer;
    }
    button.fl-board-badge:hover:not(:disabled) {
      color: var(--fl-color-text); background: var(--fl-color-surface);
    }
    /* The actions sit at the RIGHT edge, after the facts — one column of
       controls down the lane instead of a ragged left-packed mixture. */
    .fl-board-card-meta button.fl-board-badge:first-of-type { margin-left: auto; }
    /* A middot between two FACTS, the way the commit rows and the thread rows
       already separate an author from a time. Only between passive spans —
       never before a button, which has its own edge. */
    span.fl-board-badge + span.fl-board-badge::before {
      content: '·'; margin-right: var(--fl-space-xs); color: var(--fl-color-text-secondary); opacity: 0.6;
    }
    .fl-board-badge-suggest { color: var(--fl-color-accent); }
    /* AMBER IS RESERVED (loops-on-the-board): an item behind the approval gate —
       the state that wants a human. The model gates it via \`attention\`; there
       is no second path to this colour. */
    .fl-board-card-attention { border-color: var(--fl-color-warning, #d9a441); }
    .fl-board-badge-attention { color: var(--fl-color-warning, #d9a441); }
    button.fl-board-badge-approve {
      border: none; cursor: pointer; font-family: var(--fl-font-ui);
      color: var(--fl-color-accent);
      background: var(--fl-color-accent-muted);
    }
    button.fl-board-badge-approve:hover:not(:disabled) { text-decoration: underline; }
    button.fl-board-badge-approve:disabled { cursor: default; opacity: 0.6; }
    /* The Review card's primary action — merge its pull request. Reads as an
       action (accent-muted, like Approve), since a card in Review exists to be
       merged, and sits disabled while the merge is in flight. */
    button.fl-board-badge-merge {
      border: none; cursor: pointer; font-family: var(--fl-font-ui);
      color: var(--fl-color-accent);
      background: var(--fl-color-accent-muted);
    }
    button.fl-board-badge-merge:hover:not(:disabled) { text-decoration: underline; }
    button.fl-board-badge-merge:disabled { cursor: default; opacity: 0.6; }
    /* A refused claim's reason, riding the card back to Todo. */
    .fl-board-card-note {
      margin-top: 5px; font-size: var(--fl-text-caption-size);
      color: var(--fl-color-danger, #d9534f); overflow-wrap: anywhere;
    }
    /* A failed queue read, at the top of the lane it emptied (NFR-2). */
    .fl-board-lane-banner {
      padding: var(--fl-space-xs) var(--fl-space-sm); margin-bottom: var(--fl-space-xs);
      border: var(--fl-border-width) solid var(--fl-color-danger, #d9534f);
      background: var(--fl-color-danger-muted, rgba(220,60,60,0.12));
      border-radius: var(--fl-radius-sm);
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text);
      overflow-wrap: anywhere;
    }
    /* Per-queue headings — drawn only when there is more than one list. */
    .fl-board-section-head {
      padding: var(--fl-space-xs) 2px 0;
      font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium);
      letter-spacing: 0.04em; color: var(--fl-color-text-secondary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fl-board-section-note {
      padding: 0 2px; font-size: var(--fl-text-caption-size);
      color: var(--fl-color-danger, #d9534f); overflow-wrap: anywhere;
    }
    /* A producer's standing hunt (Task 7.1) — a card in Doing that is NOT a
       piece of work: dashed edge, no drag affordance, no hover lift. It reads as
       the thing the cards below it were filed against. */
    .fl-board-hunt {
      border: var(--fl-border-width) dashed var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      padding: var(--fl-space-sm);
      margin-bottom: var(--fl-space-xs);
      background: var(--fl-color-surface);
    }
    .fl-board-hunt-text { color: var(--fl-color-text); font-size: var(--fl-text-ui-size); overflow-wrap: anywhere; }
    .fl-board-hunt-detail {
      margin-top: 4px; font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* The filed count is the filter's control (Task 7.2) — a chip that is a
       button, like the approve control beside it. */
    button.fl-board-badge-filed {
      border: none; cursor: pointer; font-family: var(--fl-font-ui);
      color: var(--fl-color-accent);
    }
    button.fl-board-badge-filed:hover:not(:disabled) { text-decoration: underline; }
    /* The Board→Chat control: a chip, because it is one more thing the card can
       do rather than a decision about the work. */
    button.fl-board-badge-chat {
      border: none; cursor: pointer; font-family: var(--fl-font-ui);
      color: var(--fl-color-text-secondary);
    }
    button.fl-board-badge-chat:hover { color: var(--fl-color-accent); text-decoration: underline; }
    button.fl-board-badge-filed:disabled { cursor: default; opacity: 0.6; color: var(--fl-color-text-secondary); }
    /* All that is left of the loops strip: the wrapper the loop's own button
       lives in, on Todo's head. Everything else — the name, the state line, the
       gear — went with the toolbar and the screen it opened. */
    .fl-board-loops[hidden] { display: none; }
    .fl-board-empty-hint {
      margin-top: var(--fl-space-xs); text-align: left;
      color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size);
      overflow-wrap: anywhere;
    }
    /* The suggestion chip is a real accept button (#1102) — strip the UA button
       chrome so it still reads as the same chip the sidebar shows. */
    button.fl-board-badge-suggest {
      border: none; cursor: pointer; font-family: var(--fl-font-ui);
    }
    button.fl-board-badge-suggest:hover { text-decoration: underline; }
    .fl-board-empty { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); padding: var(--fl-space-sm); text-align: center; }
    /* Load-error view (#205) — distinct from a genuinely empty board. */
    .fl-board-error { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--fl-space-md); padding: var(--fl-space-lg); }
    .fl-board-error-msg { color: var(--fl-color-text-secondary); font-size: var(--fl-text-ui-size); }
    /* "No project open" empty state (#622) — mirrors the Files panel. */
    .fl-board-no-project { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--fl-space-sm); padding: var(--fl-space-lg); user-select: none; }
    .fl-board-no-project[hidden] { display: none; }
    .fl-board-no-project-label { color: var(--fl-color-text-secondary); font-size: var(--fl-text-ui-size); }
    .fl-board-new:disabled { opacity: 0.5; cursor: default; }
    /* New-task modal (board-native) */
    .fl-board-modal-overlay {
      position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.4);
    }
    .fl-board-modal {
      width: 380px; max-width: calc(100vw - 32px); display: flex; flex-direction: column; gap: var(--fl-space-md);
      padding: var(--fl-space-lg); background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-lg);
      box-shadow: 0 12px 40px rgba(0,0,0,0.4);
    }
    .fl-board-modal-title { font-size: var(--fl-text-ui-size); font-weight: var(--fl-text-ui-weight-medium); color: var(--fl-color-text); }
    .fl-board-modal-tabs { display: flex; gap: 4px; }
    .fl-board-modal-tab {
      flex: 1; padding: 5px 4px; border-radius: var(--fl-radius-sm); cursor: pointer;
      border: var(--fl-border-width) solid var(--fl-color-border); background: var(--fl-color-surface);
      color: var(--fl-color-text-secondary); font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
    }
    .fl-board-modal-tab.active { background: var(--fl-color-accent-muted); color: var(--fl-color-accent); border-color: var(--fl-color-accent); }
    .fl-board-modal-body { display: flex; flex-direction: column; gap: var(--fl-space-sm); }
    .fl-board-modal-startlabel { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-board-modal-context-roots { display: flex; flex-direction: column; gap: 4px; }
    .fl-board-modal-context-row { display: flex; align-items: center; gap: var(--fl-space-sm); font-size: var(--fl-text-ui-size); cursor: pointer; }
    .fl-board-modal-skip { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-board-modal-actions { display: flex; justify-content: flex-end; gap: var(--fl-space-sm); }
    .fl-board-modal-error {
      display: flex; flex-direction: column; gap: var(--fl-space-sm); padding: var(--fl-space-sm) var(--fl-space-md);
      background: var(--fl-color-danger-muted, rgba(220,60,60,0.12)); border: var(--fl-border-width) solid var(--fl-color-danger, #d9534f);
      border-radius: var(--fl-radius-sm);
    }
    .fl-board-modal-error-text { font-size: var(--fl-text-caption-size); color: var(--fl-color-text); }
    .fl-board-modal-error-cta {
      align-self: flex-start; padding: 4px 10px; cursor: pointer; font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
      border-radius: var(--fl-radius-sm); border: var(--fl-border-width) solid var(--fl-color-accent);
      background: var(--fl-color-accent-muted); color: var(--fl-color-accent);
    }
    .fl-board-modal-error-cta:hover { border-color: var(--fl-color-focus-ring); }
    /* ── THE TICKET, AS SOMETHING TO READ ──────────────────────────────
       ONE SCROLLER, NOT THREE. The modal scrolled, and the description inside
       it scrolled at 32vh, and a table inside THAT scrolled sideways — so a
       long ticket had three bars and a reader could not tell which one they
       were in, or how much was left. The chrome is fixed now (a title that
       stays, actions that stay) and exactly one region moves.
       WIDER, because the content is prose with tables and code in it: 620px
       set a line that broke a two-column table onto four lines. */
    /* THE DETAIL'S CHROME MOVED TO TICKET_STYLES. Every dialog that carried
       .fl-board-detail is a ticket frame now and is sized, headed, scrolled and
       footed there. The rules that used to sit here said the same things at the
       same specificity — a size, a gap, a padding — so which one a reader got
       depended on stylesheet order. The class names stay: they are what the
       board's own scroll-preservation and a shelf of guards reach for. */
    .fl-board-detail-key { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); text-decoration: none; width: fit-content; }
    a.fl-board-detail-key:hover { color: var(--fl-color-accent); text-decoration: underline; }
    .fl-board-detail-section { display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-board-detail-label { font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium); text-transform: uppercase; letter-spacing: 0.04em; color: var(--fl-color-text-secondary); }
    .fl-board-detail-brief, .fl-board-detail-desc { font-size: var(--fl-text-ui-size); color: var(--fl-color-text); }
    /* NO SECOND SCROLLER, and no dimming: a description at 0.9 opacity is the
       main thing on the screen, rendered as though it were an aside. */
    .fl-board-detail-desc { line-height: 1.55; }
    .fl-board-detail-muted { font-size: var(--fl-text-ui-size); color: var(--fl-color-text-secondary); }
    /* THE BODY'S TYPOGRAPHY MOVED. Every surface that renders a description
       is a ticket frame now, and TICKET_STYLES owns how one reads — headings,
       lists, blockquotes, tables. The copy that used to sit here was the same
       rules at the same specificity, which meant the two disagreed by
       stylesheet order rather than by intent. */
    .fl-board-detail-link { align-self: flex-start; background: none; border: none; padding: 0; cursor: pointer; color: var(--fl-color-accent); font-size: var(--fl-text-caption-size); }
    .fl-board-detail-link:hover { text-decoration: underline; }
  ${HUNT_CONFIG_STYLES}
  ${TICKET_STYLES}
  ${TASK_PROJECTS_STYLES}
  ${TICKET_IMAGE_STYLES}
    .fl-board-autofix {
      display: flex; align-items: center; gap: var(--fl-space-sm);
      cursor: pointer; font-size: var(--fl-text-ui-size); color: var(--fl-color-text);
    }
    .fl-board-autofix input { margin: 0; }
    .fl-board-autofix-why {
      display: block; margin-top: 4px;
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
    }
  `
  document.head.appendChild(style)
}
