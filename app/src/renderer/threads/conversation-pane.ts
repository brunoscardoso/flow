/**
 * Conversation pane — the streaming transcript for the selected thread.
 *
 * History renders from messages:list + toolCalls:list merged by timestamp;
 * live turns render from `threads:stream` events (message-start/delta/
 * thinking/tool-start/tool-end/usage/status/error/done). StreamBridge uses a
 * bridge-generated correlation id for message-start/delta, so on `done` the
 * transcript reconciles against persisted rows via a messages:list re-fetch.
 *
 * Rendering cost: message heights vary, so instead of the fixed-row
 * <fl-list> the pane uses CSS `content-visibility: auto` per entry (browser
 * skips layout/paint for off-screen entries) plus chunked history — only the
 * newest HISTORY_WINDOW entries mount initially, with a "Show earlier"
 * control for the rest.
 *
 * Auto-scroll follows the stream while the user is at the bottom; scrolling
 * up locks the viewport (scroll-lock-on-user-scroll) until they return.
 */
import '../components'
import { backgroundActivityLabel } from './background-task-rows'
import type {
  AgentStreamEvent,
  BackgroundTaskInfo,
  MessageAttachmentInput,
  PermissionRequest,
  ThreadMessage,
  ThreadStatus,
  ThreadSummary,
  ToolCallRecord,
} from '../../shared/ipc-contract'
import { attachmentDataUrl } from './attachment-chips'
import { thumbModels } from './attachment-thumbs'
import { showRevealMenu } from '../reveal-menu'
import { openImageViewer, closeImageViewer } from './image-viewer'
import { renderMarkdown, StreamingMarkdown } from './markdown-renderer'
import { PermissionCard } from './permission-card'
import { QuestionCard } from './question-card'
import { SessionGoneError, isSessionGone } from './question-submit'
import { PendingCardQueue, QuestionQueue } from './question-queue'
import type {
  BlueprintStory,
  BlueprintStoryStep,
  FlowArtifactChangedEvent,
  FlowArtifactKind,
  FlowState,
  PlanNoteCounts,
  UserDialogCancel,
  UserQuestionRequest,
} from '../../shared/ipc-contract'
import { ArtifactCard, type ArtifactCardCallbacks } from './artifact-card'
import {
  artifactCardHosts,
  artifactCommandFor,
  artifactRenderDecision,
  buildArtifactModel,
  planWrittenFromDocument,
  deriveFeatureViewAction,
  executeCommandFor,
  foldHostIndex,
  holdsNewArtifactCard,
  artifactEventIsHistorical,
  planCommandFor,
  planPhaseCount,
  planSlugOf,
  rejectedLeftOutText,
  cardRunAfter,
  startCardRun,
  PlanRequests,
  UNSEEN_RUN_IDLE_LIMIT_MS,
  type CardRun,
  type CardRunEvent,
  planRunStateFor,
  docMention,
  runningLine,
  type ArtifactCardModel,
  type ArtifactDocRef,
  type PlanRunState,
  storyHostIndex,
} from './artifact-card-model'
import { ConflictReviewCard } from './conflict-review-card'
import {
  CONFLICT_REVIEW_EVENT,
  type ConflictReviewEventDetail,
} from './conflict-review-event'
import { isConflictProposalReply } from '../editor/conflict-proposal'
import { StoryCard, type StoryAttachRef } from './story-card'
import { ContextMeter } from './context-meter'
import { readContext, SHORTEN_COMMAND } from '../../shared/context-usage'
import {
  StoryMinimizeMemory,
  StoryOwnership,
  type StoryOwnershipState,
  shouldRenderStory,
  storyIdentity,
} from './story-card-model'
import { ToolCard } from './tool-card'
import { ToolGroupCard } from './tool-group-card'
import { groupPresentation, planToolGroups, toolCallGroupKey } from './tool-group-model'
import { TurnRow } from './turn-row'
import { turnSummary, type TurnRole } from './turn-summary'
import { requestSummary, type Request, type RequestRole } from './request-summary'
import { RequestRow, sentWhileWorkingNote } from './request-row'
import { liveRequestSummary, type RequestRowStepInput } from './request-row-model'
import {
  DEFAULT_FEED_DENSITY,
  feedUnits,
  projectFeed,
  type FeedClassifiers,
  type FeedDensity,
} from './feed-density'
import { getFeedDensity, onFeedDensityChanged } from './feed-density-controller'
import { reconcileScrollTop } from './conversation-scroll'
import { historyWindow } from './history-window'
import { jumpToLatestView } from './jump-to-latest'
import { modelLabel } from './model-label'
import { ForeignRefreshScheduler } from './foreign-refresh'
import {
  THREAD_SAVINGS_TOOLTIP,
  turnSavedSegmentLabel,
  turnTokensLabel,
} from './turn-stats-model'
import { isTurnFailureNote } from '../../shared/turn-failure'
import {
  LEARNING_FIRST_RETRY,
  learningFirstWaiting,
  type LearningFirstState,
} from '../../shared/basic-discovery'
import { parseArtifactMarker, type ArtifactMarker } from '../../shared/artifact-marker'
import { parseFolderBehindMarker } from '../../shared/folder-behind-marker'
import { FolderBehindCard } from './folder-behind-card'
import { isWalkthroughBeingWritten } from '../../shared/walkthrough-page'
import { onCommandNamesChanged } from './command-names'
import { renderHighlightedText } from './message-token-view'
import { liveWorkTarget, turnLiveAfter, type TurnEdge } from './turn-liveness'

const HISTORY_WINDOW = 200
/** Frames the reader's place is re-applied after older messages load in. */
const EARLIER_ANCHOR_FRAMES = 3
/**
 * Fetched per open: the window, plus a margin.
 *
 * The feed shows the last HISTORY_WINDOW *entries*, and an entry is a message
 * OR a tool call — so the last 200 entries can never need more than 200
 * messages. The margin is for the reconcile paths that rebuild mid-turn. Set
 * generously at first (600) and cut after measuring: on a real thread these
 * messages average ~10 KB, so every extra hundred is another megabyte across
 * the boundary to render nothing.
 */
const HISTORY_FETCH = HISTORY_WINDOW + 50

/**
 * How many of the newest tool calls arrive WITH their output.
 *
 * Smaller than the history window on purpose. The window is what mounts;
 * this is what is SENT, and the two are different questions — a mounted card
 * shows its output only when the reader opens it, and most are never opened.
 * Measured on a synthetic 600-call thread at 8 KB per output: 4.96 MB whole,
 * 1.77 MB at 200, 0.65 MB at 60. The cards beyond it fetch their own on open,
 * which is one point read of one row.
 */
const TOOL_OUTPUT_WINDOW = 60

/**
 * The floor under the tool-call window.
 *
 * The feed mounts the newest HISTORY_WINDOW entries and a tool call is an
 * entry, so the last 200 entries can never need more than 200 tool calls —
 * plus the same margin the message fetch keeps for mid-turn reconciles. It
 * exists because the time window alone can be empty: an agent-heavy turn runs
 * hundreds of calls between two messages, and every one of them is older than
 * the oldest message the pane mounted.
 */
const TOOL_ROW_FLOOR = HISTORY_FETCH
const BOTTOM_LOCK_THRESHOLD_PX = 48

/** How long after a user gesture (wheel/touch/pointer/keys) scroll events are
 *  treated as user-driven and may unpin auto-follow (#823). Long enough to
 *  cover the gesture's own scroll events, short enough that growth-driven
 *  events during streaming quickly stop counting as the user. */
const USER_SCROLL_INTENT_WINDOW_MS = 150

/** Upper bound on the animation frames a FORCED scroll-to-bottom keeps
 *  re-asserting for (#939). A transcript rebuild mounts fresh entries at their
 *  96px content-visibility placeholder height, so the "bottom" is a large
 *  under-estimate; scrolling to it makes the next band of entries relevant,
 *  they render at their real height, and the bottom moves again. The chain
 *  converges in a handful of frames on real transcripts and stops the moment
 *  the height holds steady — this cap only bounds the pathological case. */
const FORCED_BOTTOM_REASSERT_FRAMES = 12


/** localStorage key for the persisted story→owning-thread map (survives relaunch). */
const STORY_OWNER_KEY = 'flow.story.owner.v1'

/**
 * How long after a text block ends before the loader comes back.
 *
 * Long enough that a turn ending normally (`done` follows its last `text-stop`
 * almost immediately) never flashes a spinner under the finished answer; short
 * enough that a real pause — the agent deciding its next move, which can run to
 * seconds — is not a dead screen. Anything conclusive arriving first cancels it.
 */
const ACTIVITY_RESUME_DELAY_MS = 220

/** Load the persisted story-ownership snapshot (empty on absence/corruption). */
function loadStoryOwnership(): StoryOwnership {
  try {
    const raw = localStorage.getItem(STORY_OWNER_KEY)
    if (!raw) return new StoryOwnership()
    return new StoryOwnership(JSON.parse(raw) as StoryOwnershipState)
  } catch {
    return new StoryOwnership()
  }
}

/** Persist the story-ownership snapshot; a storage failure is non-fatal. */
function saveStoryOwnership(state: StoryOwnershipState): void {
  try {
    localStorage.setItem(STORY_OWNER_KEY, JSON.stringify(state))
  } catch {
    // Quota/private-mode failures must not break the conversation pane.
  }
}

export interface ConversationPaneHandlers {
  /** Status stream events for the pane's current thread. */
  onStatus?: (threadId: string, status: ThreadStatus) => void
  /** Invoked by the empty-state "New Thread" button (a project is open). */
  onNewThread?: () => void
  /** Invoked by the empty-state "Open Project" button (no project yet) —
   *  opens the native folder picker. */
  onOpenProject?: () => void
}

type HistoryEntry =
  | { kind: 'message'; at: string; message: ThreadMessage }
  | { kind: 'tool'; at: string; toolCall: ToolCallRecord }

/**
 * What a history entry is to the TURN fold (`planTurns`).
 *
 * The model is generic on purpose — it imports no view types — so this is the
 * one place `HistoryEntry` is translated for it. A tool call names its turn
 * through the `messageId` main stamps from `lastAssistantMessageId`, so a turn
 * is the assistant text plus everything the agent did before saying the next
 * thing. Everything else — the user's own messages and the system rows that
 * carry artifact markers and failure notices — is a `break`: it ends the turn
 * and renders as itself, never folded away.
 *
 * FR-6's untouchables (permission asks, question cards) never reach here at
 * all: they are live elements the pane appends to the feed directly, not
 * `HistoryEntry` values, so no fold can ever swallow one.
 */
function turnRoleFor(entry: HistoryEntry): TurnRole {
  if (entry.kind === 'tool') return { kind: 'tool', messageId: entry.toolCall.messageId }
  if (entry.message.role === 'assistant') {
    return { kind: 'assistant', messageId: entry.message.id }
  }
  return { kind: 'break' }
}

/**
 * What a history entry is to the REQUEST fold (`planRequests`). Permission and
 * question cards never reach here (see `turnRoleFor`), so no entry is a
 * `card`; system rows (artifact markers, failure notices) are `other`.
 */
function requestRoleFor(entry: HistoryEntry): RequestRole {
  if (entry.kind === 'tool') {
    return { kind: 'tool', messageId: entry.toolCall.messageId, record: entry.toolCall }
  }
  const { message } = entry
  if (message.role === 'user') return { kind: 'user', createdAt: message.createdAt }
  if (message.role === 'assistant') {
    return {
      kind: 'assistant',
      messageId: message.id,
      endsTurn: message.endsTurn === true,
      content: message.content,
      model: message.model,
      createdAt: message.createdAt,
    }
  }
  return { kind: 'other' }
}

/**
 * How the density projection reads a history entry — the ONE place
 * `HistoryEntry` is translated for the two folds. Both models are generic and
 * import no view types, so this pair is the whole seam between them and the
 * pane.
 */
const FEED_CLASSIFIERS: FeedClassifiers<HistoryEntry> = {
  turnRole: turnRoleFor,
  requestRole: requestRoleFor,
  groupKey: (entry) => (entry.kind === 'tool' ? toolCallGroupKey(entry.toolCall) : null),
}

/**
 * Reuse identity for a history entry (PERF, conservative reconcile reuse):
 * user/assistant messages and tool calls only — system rows carry side-effect
 * registries (artifact markers #1056, failure cards #1048) and always rebuild.
 * The hash is a cheap change guard so a mutated row (a tool call resolving,
 * an edited length) re-renders; persisted rows are append-only in practice.
 */
function reuseKeyFor(entry: HistoryEntry, showBadge: boolean): { id: string; hash: string } | null {
  if (entry.kind === 'tool') {
    const { toolCall } = entry
    return {
      id: `tool:${toolCall.id}`,
      hash: `${toolCall.status}:${toolCall.inputJson?.length ?? 0}:${toolCall.outputJson?.length ?? 0}`,
    }
  }
  const { message } = entry
  if (message.role !== 'user' && message.role !== 'assistant') return null
  return {
    id: `msg:${message.id}`,
    // The badge is part of the element (Detailed only — plan_chat-cleanup
    // FR-4), so a density change must not reuse an element built for the
    // other one.
    hash: `${message.role}:${message.content.length}:${message.model ?? ''}:${showBadge ? 'badge' : ''}`,
  }
}

/**
 * The request running now, as the pane watches it (Compact only —
 * plan_chat-cleanup notes 21, 22). One live work row stands for every tool
 * and every spoken block of the request; the reconcile that follows `done`
 * rebuilds it from persisted history as a closed row and its answer.
 */
interface LiveRequest {
  row: RequestRow
  /** When the request started (the person's message), for `Working · N min`. */
  startedAt: number | null
  /** Every tool record of the request so far, latest status, by id. */
  records: Map<string, ToolCallRecord>
  /** The steps: a spoken block (its stream, or a stored text) and its tools. */
  steps: Array<{ text: string | null; stream: StreamingMarkdown | null; toolIds: string[] }>
  /** The model the history named, until the session reports one. */
  model: string | null
  /** False once the turn rests (done, a parked ask, an interrupt). */
  active: boolean
}

/** How often a live row's minutes are redrawn when no event does it. */
const LIVE_REQUEST_TICK_MS = 30_000

/** The key a request's expansion is remembered by: the person's message id,
 *  else the first entry it covers. */
function requestKey(request: Request<HistoryEntry>): string {
  const first = request.user ?? request.entries[0]
  if (first === undefined) return ''
  return first.kind === 'tool' ? `tool:${first.toolCall.id}` : first.message.id
}

/** The key a step's expansion is remembered by: its message id, else its
 *  first tool's id. */
function stepKeyOf(step: { head: HistoryEntry | null; tools: HistoryEntry[] }): string {
  if (step.head !== null && step.head.kind === 'message') return step.head.message.id
  const tool = step.tools[0]
  return tool !== undefined && tool.kind === 'tool' ? `tool:${tool.toolCall.id}` : ''
}

export class ConversationPane {
  #scroller: HTMLDivElement
  /** "Continuing from sub-agent" header with a back-to-parent link, shown only
   *  when the open thread is a promoted sub-agent child (#1931). */
  #subagentBanner: HTMLDivElement
  /** The thread the banner was last rendered for, so a later origin-running
   *  change (#1931 D-4) can re-render it without a thread switch. */
  #bannerThread: ThreadSummary | null = null
  /** Whether the promoted child's origin tool call is still running. */
  #subagentOriginRunning = false
  /** Coalesces foreign message/tool_call refetches (#1931) — a promoted child's
   *  rows arrive from the PARENT's streaming session in 50ms batches. The
   *  scheduler owns the debounce (with a max-wait bound so a continuous stream
   *  cannot starve the refetch), the busy/loading DEFERRAL (never a drop — a
   *  child pane has no turn-done reconcile to make dropping safe) and the one
   *  follow-up consumed when a load settles. See foreign-refresh.ts. */
  #foreignRefresh = new ForeignRefreshScheduler({
    busy: () => this.#busy || this.#streaming,
    loading: () => this.#historyLoading,
    // Through the reconcile, never a bare reload: this rebuild wipes the feed
    // exactly as a completing turn's does, so it must keep what that one keeps
    // — the reader's scroll position, expanded cards and SELECTION (#179,
    // #1088). It routinely lands just after a turn: main persists the answer,
    // the turn goes idle, and the debounced message broadcast arrives a moment
    // later with nothing busy any more.
    refresh: () => {
      const threadId = this.#threadId
      if (threadId !== null) void this.#reconcile(threadId)
    },
  })
  #feed: HTMLDivElement
  #activity: HTMLDivElement
  #activityLabel: HTMLSpanElement
  #usage: HTMLDivElement
  /** How full the window is, beside the turn's tokens (#1955). Hidden whenever
   *  nothing can say — no session, or a provider that reports no window. */
  #contextMeter: ContextMeter
  /** Per-turn token text inside the usage bar ("↑ … · ↓ … tokens · Model"). */
  #usageText: HTMLSpanElement
  /** Per-turn savings segment (brain icon + "~Nk saved") — shown only when
   *  this turn's `brain-savings` stream event arrives with a positive
   *  estimate; a new turn's usage stats hide it again. */
  #usageSavings: HTMLSpanElement
  #usageSavingsLabel: HTMLSpanElement
  /**
   * The footer band under the transcript, on the transcript's own column.
   *
   * It used to also carry a thread-CUMULATIVE savings chip, recomputed over the
   * thread's persisted tool calls. It printed the same figure the usage line
   * one row above it already printed — "weird that way that we are showing
   * duplicated the tokens" (user, 2026-09-10) — so it is gone, along with its
   * keep-visible root fallback and the `threads:brainSavings` refetch on every
   * thread switch. The per-TURN segment on the usage line survives; it is the
   * one that says something new.
   */
  #footer!: HTMLDivElement
  /** The footer's left half — filled by whoever owns what goes there. */
  #footerLead!: HTMLDivElement
  /** Turn-activity state — drives the "Working…"/"Thinking…" indicator. The
   *  loader shows whenever the turn is busy and nothing visible is streaming
   *  (no assistant text mid-flight, no tool card actively running). */
  #busy = false
  /**
   * Whether this thread's agent turn is RUNNING — moved only by the events
   * that start or end a turn (`turnLiveAfter`), never by motion. `#busy` is the
   * loader's flag and any tool or thinking event sets it, including a
   * background agent's after `done`, so it cannot answer "is a turn running?".
   */
  #turnLive = false
  #thinkingActive = false
  #streaming = false
  /**
   * How long each settled turn spent THINKING, keyed by the turn's persisted
   * assistant message id — the fact behind the `Thought Ns` row (FR-5).
   *
   * This map is the ONLY place that fact lives, and it lives here because
   * nothing else records it. The `thinking` stream event is
   * `{ kind, threadId, active }` — a boolean edge with no text, no timestamp
   * and no message id — and BOTH persistence halves (`stream-bridge.ts` and
   * `runtime-event-sink.ts`) name it explicitly as ephemeral and drop it. The
   * `messages` table has no column for it. So a turn's thinking is knowable
   * only to a pane that WATCHED it happen, and only for as long as that pane
   * lives. Reloading the app is not a bug here; it is the shape of the data.
   *
   * That is also why the row shows a duration and nothing else: there is no
   * thinking TEXT anywhere to expand into. Giving it a chevron that opens onto
   * nothing would be the empty `Thought 0s` this plan exists to remove, one
   * fold deeper. Persisting the text is a store change and a payload change,
   * which NFR-1 rules out.
   *
   * Keyed by `done.messageId` — the LAST persisted assistant message of the
   * turn, which is the one stable id the renderer ever sees (message-start /
   * delta carry a bridge-generated CORRELATION id that the reconcile throws
   * away). For the ordinary one-message turn that is the turn's only message.
   * For a turn that spoke twice the whole turn's thinking lands on the second
   * block — an approximation stated here rather than a precision invented.
   *
   * NOT cleared on thread switch, unlike #expandedTurns: a message id is
   * globally unique, so nothing can collide, and the pane genuinely observed
   * this. Throwing it away would lose a fact that cannot be re-derived.
   */
  #thoughtMs = new Map<string, number>()
  /** When the OPEN thinking block started (`performance.now`-free: the wall
   *  clock is what "Thought 4s" means to a reader). Null between blocks. */
  #thinkingStartedAt: number | null = null
  /** Thinking milliseconds accumulated across every block of the turn in
   *  progress. A turn interleaves thinking, prose and tools, so the row's
   *  number is the SUM of its thinking blocks, not the last one. Sealed into
   *  #thoughtMs on `done` and reset there. */
  #thinkingElapsedMs = 0
  /**
   * Pending re-show of the loader after a text block ended (`text-stop`).
   *
   * The gap between prose ending and the next tool starting is real work, and
   * it used to render as a dead screen. But at the END of a turn `done` arrives
   * right behind the stop, so showing the loader the instant text stops would
   * flash a spinner on every completed answer. The delay is what separates
   * "the agent is thinking about its next move" from "the turn just finished".
   */
  #activityResumeTimer: number | null = null
  #toolRunning = false
  /**
   * Background work THIS thread is still waiting on after its turn ended.
   *
   * The turn genuinely finished — the composer is free and typing into it will
   * get an answer — so `#busy` is false and the loader is correctly down. What
   * was missing is the sentence saying the conversation is not over: an agent
   * that backgrounded four review passes left this pane looking exactly like
   * one that had nothing left to do ("seems to me that the chat is stopped").
   */
  #backgroundTasks: BackgroundTaskInfo[] = []
  #empty: HTMLDivElement
  #emptyLabel: HTMLSpanElement
  /** Empty-state action button label — swaps with project state. */
  #emptyButtonLabel: HTMLSpanElement | null = null
  #projectAvailable = false
  #handlers: ConversationPaneHandlers
  #threadId: string | null = null
  /** Live streaming renderers keyed by bridge correlation message id. */
  #streams = new Map<string, StreamingMarkdown>()
  /**
   * Assistant wrappers created but not yet in the feed — one per open block
   * that has produced no text.
   *
   * They are held rather than appended because an empty wrapper is invisible to
   * a reader and fatal to the live fold: it becomes the feed's last child and
   * breaks a run of tool calls that the reader sees as consecutive. Dropped on
   * thread switch and on `done` — a block that never spoke leaves no trace,
   * which is what the persisted history already does.
   */
  #pendingStreams = new Map<string, HTMLElement>()
  /**
   * The turn currently running, and the tool calls it has made so far.
   *
   * Held so the row can grow: every tool that lands updates its count, its
   * status and its `· N failed` segment in place. Closed by `message-start`
   * (a new assistant block is a new turn) and by the reconcile that follows
   * `done`, which rebuilds the same shape from persisted history.
   */
  #liveTurn: { row: TurnRow; records: ToolCallRecord[] } | null = null
  /** Compact's live work row for the request running now — see LiveRequest. */
  #liveRequest: LiveRequest | null = null
  /** Redraws the live row's minutes between events; null when no row is live. */
  #liveRequestTimer: number | null = null
  /** Tool cards keyed by tool-call id (live + history). Inner cards of a
   *  collapsed tool group stay registered here so live updates, the #179
   *  expand-restore, and the withheld-output load-on-open contract keep
   *  working through the group. */
  #toolCards = new Map<string, ToolCard>()
  /** Which tool groups the reader has expanded, keyed by the group's first
   *  tool-call id (stable across reconciles). Pane state, so it survives the
   *  feed wipe a history rebuild does — that is how a group the reader opened
   *  stays open after a turn settles. Cleared on thread switch (#17). */
  #expandedGroups = new Set<string>()
  /** Which TURNS the reader has opened, keyed by the turn's assistant message
   *  id. The same discipline as #expandedGroups one level out: pane state, so
   *  it survives the feed wipe a history rebuild does. Without it a reconcile
   *  landing mid-read would slam shut the turn someone was reading — which is
   *  exactly the reconcile #179 fixed for cards, one fold higher up. Cleared
   *  on thread switch; a live turn's expansion is NOT recorded here (see
   *  #buildTurnRow), so folding on settle stays automatic. */
  #expandedTurns = new Set<string>()
  /** Which work rows the reader opened, keyed by `requestKey` (the person's
   *  message id) — the same discipline as #expandedTurns, one fold out. */
  #expandedRequests = new Set<string>()
  /** Which steps inside a work row the reader opened, keyed by `stepKeyOf`. */
  #expandedSteps = new Set<string>()
  /**
   * How much folding the READER asked for. Compact by default — the fold this
   * whole feature exists to deliver — and changed only through `setDensity`.
   *
   * It is a per-USER reading preference, not a property of a thread or a
   * project, so it is never cleared on thread switch: someone who chose to see
   * every call did not un-choose it by opening another conversation.
   */
  #density: FeedDensity = DEFAULT_FEED_DENSITY
  /**
   * The sorted entry list the feed was last painted from, or null before the
   * first history load. Held so a density change repaints from what is already
   * in hand — the projection is pure and the record has not moved, so a
   * re-read would answer a question nobody asked (NFR-1).
   */
  #historyEntries: HistoryEntry[] | null = null
  /** Inner-card id → its owning TURN, for the CURRENT feed. The reconcile
   *  expand-restore has to open both levels around a card the reader had
   *  expanded live: a card that settles into a collapsed group inside a
   *  collapsed turn is hidden twice over, and opening only the group would
   *  leave the #179 restore silently lost behind the turn row. Rebuilt with
   *  #toolCards. */
  #turnByCardId = new Map<string, TurnRow>()
  /** Tool-call id → the work row and step that hold it, for the CURRENT feed —
   *  known before the step is built (steps build lazily), so the reconcile
   *  expand-restore can build and open the step around a card the reader had
   *  open. Rebuilt with #toolCards. */
  #requestByCardId = new Map<string, { row: RequestRow; step: number }>()
  /** Inner-card id → its owning group, for the CURRENT feed. Lets the reconcile
   *  expand-restore open the group around a card the reader had expanded (a
   *  card expanded live, then collapsed into a group on settle, would otherwise
   *  hide inside the group's closed detail — #179), and lets a live `tool-end`
   *  repaint a mid-turn group's aggregate glyph. Rebuilt with #toolCards. */
  #toolGroupByCardId = new Map<string, ToolGroupCard>()
  /** The ToolGroupCard behind a live tool-group wrapper at the feed tail, so a
   *  new tool-start can grow it instead of starting a new lone card. WeakMap:
   *  entries drop with the wrapper when the feed is wiped. */
  #groupByWrapper = new WeakMap<HTMLElement, ToolGroupCard>()
  /** PERF (reconcile reuse): set only DURING one #loadHistory rebuild — DOM
   *  entries harvested from the outgoing feed keyed by `reuseKeyFor` id, plus
   *  the outgoing ToolCard instances so a reused card re-registers. Null
   *  outside a rebuild (e.g. the Show-earlier click path always builds fresh). */
  #reuseElements: Map<string, HTMLElement> | null = null
  #reuseToolCards: Map<string, ToolCard> | null = null
  /** Unresolved permission cards keyed by requestId. */
  #permissionCards = new Map<string, PermissionCard>()
  #questionCards = new Map<string, QuestionCard>()
  /** Unanswered cards a feed wipe took off screen, kept so their re-render
   *  mounts the SAME card: a reconcile or a thread switch must not throw away
   *  the picks and the page the user had reached. */
  #wipedQuestionCards = new Map<string, QuestionCard>()
  /** Routing state so a question is never dropped: renders when its thread is
   *  active + loaded, buffers otherwise, re-buffers on thread switch. */
  #questionQueue = new QuestionQueue()
  /** Same never-drop routing for permission asks (#949): the broker parks the
   *  tool call until a verdict arrives, so a pending ask destroyed by a thread
   *  switch (or dropped because its thread was in the background) left the turn
   *  hung with no allow/deny affordance anywhere. */
  #permissionQueue = new PendingCardQueue<PermissionRequest>()
  /** True while #loadHistory is fetching + rendering — a card appended now would
   *  be wiped by the feed reset, so incoming questions buffer instead. */
  #historyLoading = false
  /** Set when a NEW turn's live nodes (echoed user message / stream start) are
   *  appended DURING a #loadHistory fetch — a follow-up sent the instant the
   *  prior turn finished. The reconcile then skips its feed wipe so those live
   *  nodes survive (#101). Reset at the start of each load. */
  #liveDuringLoad = false
  /** The SDK-resolved model of the latest turn (#129) — appended to the usage
   *  line so the transcript shows which model ran. */
  #currentModel: string | null = null
  #pinned = true
  /** #1374: watches the pane's own height so a shrinking viewport can't slide
   *  the live end under the fold. */
  #paneObserver: ResizeObserver | null = null
  /** #1330: messages appended since the user scrolled away from the live end. */
  /**
   * How many history entries the feed held when the reader unpinned (#1472).
   *
   * `missed` used to be incremented by #appendHistoryEntry, which is the BULK
   * REBUILD loop — so one reply landing while the reader was scrolled up
   * re-rendered the window and reported the whole transcript ("41 new" in a
   * 41-entry thread). The count has to be a delta against where the reader
   * actually stopped, not a tally of DOM work.
   */
  #entriesAtUnpin: number | null = null
  /** History entries currently rendered for this thread — the delta's other half. */
  #renderedEntries = 0
  /** The jump-to-latest control (container level, like .fl-conv-usage). */
  #jumpBtn: HTMLButtonElement | null = null
  /** The active thread's failed-turn notice — re-appended after each history
   *  rebuild until the next turn starts, so a failed turn always leaves a
   *  visible trace (#846). */
  #turnError: { threadId: string; message: string } | null = null
  /**
   * True while the files this conversation works in are being made.
   *
   * THE CUT HAS NEVER HAD A VOICE. Creating a worktree blocks the first
   * message for seconds — minutes once a project sets a setup command — and
   * the only thing that ever reached the thread was a refusal, so a working
   * app and a stuck one looked identical from here. Transient by contract: it
   * is not history, and a pane that missed the opening edge has nothing to
   * clear.
   */
  #worktreeSetup = false
  /**
   * The line while this thread's first message waits on its project's basic
   * discovery ("Learning orbit-core first — …"), or null. Transient like the
   * worktree line; a pane that opens mid-wait asks for it (`setThread`).
   */
  #learningFirstLine: string | null = null
  /** The failure card with Try again, while one is showing. */
  #learningFirstCard: HTMLElement | null = null
  /** Failure notices that arrived for BACKGROUND threads (#1048) — `#onStream`
   *  drops wrong-thread events, so without this buffer an error for a thread
   *  the user isn't looking at would vanish before it could render. Consumed
   *  (and deduped against the persisted failure row main writes) on the next
   *  history load of that thread; cleared when the thread starts a new turn. */
  #backgroundErrors = new Map<string, string>()
  /** Deadline (performance.now ms) of the current user-gesture intent window —
   *  scroll events inside it may unpin; outside it they may only re-pin (#823). */
  #userScrollIntentUntil = 0
  /** Last observed scrollTop/scrollHeight — an upward move at STABLE height
   *  reads as intentional; one accompanying a height change is layout churn (#823). */
  #lastScrollTop = 0
  #lastScrollHeight = 0
  /** True while a pointer is down on the scroller (scrollbar drag, #823). */
  #scrollPointerDown = false
  #loadToken = 0
  /** True once the reader expanded the "Show earlier" chunk in the CURRENT
   *  feed (#1088). Every rebuild after that mounts the FULL history instead of
   *  re-chunking it — the residual of #179 the shipped fix never covered.
   *  Re-collapsing does not merely undo their click: #179 restores the numeric
   *  scrollTop, so dropping ~20 entries from above them teleports the reader
   *  onto unrelated messages. Reset on thread switch (a different transcript
   *  starts from its own window). */
  #earlierExpanded = false

  /** How many messages the next load asks for — the whole thread once the
   *  reader has opened "Show earlier", since they are looking at it. */
  #historyFetchLimit: number | undefined = HISTORY_FETCH

  /** True when the last read hit its limit: there are older messages the pane
   *  does not have. WITHHELD IS NOT EMPTY (allowed-pattern #18) — the control
   *  says so and fetches them, rather than showing a shorter thread. */
  #historyTruncated = false
  /** The blueprint story card (at most one per feed), rebuilt across thread
   *  switches but preserved (step + minimize state) across turn reconciles. */
  #storyCard: StoryCard | null = null
  /** The artifact card currently hosting the story card, when one claims it. */
  #storyHost: ArtifactCard | null = null
  #storyEntry: HTMLElement | null = null
  /** Per-(thread, story-identity) minimize memory (see story-card-model). */
  #storyMinimizeMemory = new StoryMinimizeMemory()
  /** Persisted story→owning-thread map: a story renders ONLY in the thread that
   *  authored it (the thread active when it was narrated), never in unrelated
   *  or brand-new threads. Claimed on a live narrate; survives relaunch. */
  #storyOwnership = loadStoryOwnership()
  /** Latest known story for the ACTIVE project — rendered into whichever thread
   *  is active + loaded; null removes the card. Never persisted. */
  #currentStory: BlueprintStory | null = null
  #currentStoryIdentity: string | null = null
  /** The story's active step (null while minimized/empty) — tracked so an
   *  anchor-attach click (Phase 5) knows which step to reference. */
  #activeStoryStep: BlueprintStoryStep | null = null
  /** Session-scoped known flow/ artifacts for the ACTIVE project, latest per
   *  kind (blueprint-interaction Phase 2). Sources hold the raw event + doc text
   *  so the derived model can be rebuilt when the compiled story changes (a
   *  narrate flips the story status) without re-reading the doc, plus the
   *  OWNING thread — the thread active when the change arrived (#658): the card
   *  renders only there, mirroring the story-ownership rule, so it never leaks
   *  onto unrelated chats. Never persisted; cleared on active-project change. */
  #artifactSources = new Map<
    FlowArtifactKind,
    {
      event: FlowArtifactChangedEvent
      docText: string | null
      owner: string | null
      /** True when this source came from the startup SEED (historical doc,
       *  no live change this session). Seeded markerless docs never render a
       *  feed-end card (user call 2026-07-28: days-old docs pinned at the
       *  bottom) — they only hydrate inline marker cards. */
      seeded: boolean
    }
  >()
  #artifactModels = new Map<FlowArtifactKind, ArtifactCardModel>()
  /** Live card instances for the CURRENT thread's feed (dropped on thread
   *  switch; the models above survive so the card re-mounts when its OWNING
   *  thread returns). */
  #artifactCards = new Map<FlowArtifactKind, ArtifactCard>()
  #artifactEntries = new Map<FlowArtifactKind, HTMLElement>()
  /** Inline marker-backed artifact cards for the CURRENT thread's feed, keyed
   *  by doc path (#1056): a persisted `[artifact]` system row renders as an
   *  ArtifactCard at its own transcript position, and live watcher updates
   *  refresh it IN PLACE wherever it sits. Rebuilt with every history load. */
  #markerCards = new Map<string, ArtifactCard>()
  /** Live folder-behind cards, so a feed rebuild can stop them painting. */
  #folderBehindCards = new Set<FolderBehindCard>()
  /** Doc paths with a persisted marker row ANYWHERE in the current thread's
   *  history — including rows still collapsed behind "Show earlier". These
   *  never render a bottom (feed-end) card: the marker position owns them. */
  #markerPaths = new Set<string>()
  /** What the watcher last said about each doc's walkthrough page, keyed by
   *  doc path — seeded from the listing and kept current by live events. A
   *  marker card for an OLDER discovery is not the kind's latest source, so it
   *  would never hear about a page written after it; this is how it does. */
  #walkthroughs = new Map<string, Pick<FlowArtifactChangedEvent, 'walkthrough' | 'walkthroughMtime' | 'walkthroughWriting'>>()
  /** Plans folded into the discovery card they were written from (user call
   *  2026-09-30) — keyed by the plan's path; the value is the card that stands
   *  for it, so a live change to the plan updates that card. Every other doc,
   *  every version included, has a card of its own (user call 2026-10-01). */
  #foldedPaths = new Map<string, ArtifactCard>()
  /** For each marker path in the current thread, the path of the card that
   *  stands for it — itself, or the discovery its plan folds into. Decided over
   *  the whole transcript before anything is built (`artifactCardHosts`). */
  #markerHosts = new Map<string, string>()
  /** What each plan's change notes say, keyed by plan path (this project) —
   *  read once per plan and again only when that plan file changes. Null =
   *  unreadable / no reader. */
  #planNotes = new Map<string, { counts: PlanNoteCounts | null; phases: number | null }>()
  /** Plan paths whose notes are being read; `again` = the file changed meanwhile. */
  #planNotesReading = new Map<string, { again: boolean }>()
  /** Plans a person pressed Execute the plan for (this project), and where
   *  each run stands (`cardRunAfter`): seen live, carried by a turn, resting. */
  #executing = new Map<string, CardRun>()
  /** The idle clock of each unseen run (`UNSEEN_RUN_IDLE_LIMIT_MS`). */
  #executingTimers = new Map<string, number>()
  /** The thread each card run's message was sent into — only ITS turns move it. */
  #executingThread = new Map<string, string | null>()
  /** Discoveries this pane's threads asked to plan from (`PlanRequests`). */
  #planRequests = new PlanRequests()
  /** Each project's run state, as last broadcast — read only while something
   *  executes. Keyed by root: a plan in a project attached to the thread is
   *  run from the thread's project, so both may be asked (`planRunStateFor`). */
  #runStates = new Map<string, PlanRunState>()
  /** The project each plan this thread knows lives in, keyed by plan path —
   *  from its marker (`@<root>`) or its live event. A plan absent here is the
   *  active project's. Every plan action (notes, run state, Review the change,
   *  Execute) is aimed at this root, never at the active one by default. */
  #planRoots = new Map<string, string>()
  /** The active project root (ADR-002) — the rootId for blueprint:read on the
   *  decoupled flow:open-blueprint signal (blueprint:changed carries its own). */
  #activeRoot: string | null = null
  #openBlueprintHandler?: () => void
  /** Live conflict-review cards for the CURRENT thread's feed (dropped on thread
   *  switch, like the other live cards — the feed wipe detaches their elements). */
  #conflictReviewCards: ConflictReviewCard[] = []
  #conflictReviewHandler?: (event: Event) => void
  #unsubscribes: Array<() => void> = []
  /** Pending requestAnimationFrame id for the coalesced scroll-follow. */
  #scrollFrame: number | null = null

  constructor(container: HTMLElement, handlers: ConversationPaneHandlers = {}) {
    injectConversationStyles()
    this.#handlers = handlers
    // The reader's density, and a live subscription to it: changing the
    // setting must repaint the conversation they are looking at, not the next
    // one they open (Phase 5.4).
    this.#density = getFeedDensity()
    this.#unsubscribes.push(
      onFeedDensityChanged((density) => {
        this.#density = density
        this.#repaintForDensity()
      }),
    )

    container.classList.add('fl-conversation')

    this.#scroller = document.createElement('div')
    this.#scroller.className = 'fl-conv-scroller'
    // Only a GENUINE user gesture may unpin auto-follow (#823). Scroll events
    // also fire from our own follow-scrolls, content-visibility growth, and CSS
    // scroll anchoring — all of which measure a large distance-from-bottom the
    // instant streamed text renders taller than its 96px placeholder estimate,
    // which used to flip #pinned false and kill auto-follow for the whole turn.
    // Gesture events mark a short intent window; scroll events inside it obey
    // the user, scroll events outside it may only re-pin (never unpin).
    const markUserScrollIntent = (): void => {
      this.#userScrollIntentUntil = performance.now() + USER_SCROLL_INTENT_WINDOW_MS
    }
    this.#scroller.addEventListener('wheel', markUserScrollIntent, { passive: true })
    this.#scroller.addEventListener('touchmove', markUserScrollIntent, { passive: true })
    this.#scroller.addEventListener('keydown', markUserScrollIntent)
    // Scrollbar drags: intent holds for as long as the pointer is down.
    this.#scroller.addEventListener('pointerdown', () => {
      this.#scrollPointerDown = true
    })
    window.addEventListener('pointerup', () => {
      this.#scrollPointerDown = false
    })
    this.#scroller.addEventListener('scroll', () => {
      const top = this.#scroller.scrollTop
      const scrollHeight = this.#scroller.scrollHeight
      const distance = scrollHeight - top - this.#scroller.clientHeight
      const nearBottom = distance < BOTTOM_LOCK_THRESHOLD_PX
      // Two signals may unpin: a user gesture (wheel/touch/keys/scrollbar
      // drag), or an upward move while the content height is STABLE (a
      // programmatic re-read, e.g. jump-to-message). An upward move in the
      // same event as a scrollHeight change is layout churn — entries swapping
      // their 96px content-visibility placeholder for real (smaller) heights
      // shrink-clamp scrollTop down by hundreds of px during streaming
      // (measured live: −270px in one event, #823) — and may only RE-pin.
      // The old handler treated all of it as the user and killed auto-follow.
      const heightStable = Math.abs(scrollHeight - this.#lastScrollHeight) <= 1
      const movedUp = top < this.#lastScrollTop - 1
      this.#lastScrollTop = top
      this.#lastScrollHeight = scrollHeight
      const userIntent = this.#scrollPointerDown || performance.now() <= this.#userScrollIntentUntil
      const wasPinned = this.#pinned
      if (userIntent || (movedUp && heightStable)) {
        this.#pinned = nearBottom
      } else if (nearBottom) {
        this.#pinned = true
      }
      // #1330: re-pinning means the user is back at the live end — nothing is
      // missed any more.
      if (!wasPinned && this.#pinned) this.#entriesAtUnpin = null
      // #1472: leaving the live end is what "new" is measured from.
      if (wasPinned && !this.#pinned) this.#entriesAtUnpin = this.#renderedEntries
      this.#syncJumpControl()
    })

    // #1374: DEFEND THE LIVE END WHEN THE VIEWPORT SHRINKS, not only when the
    // content grows. #651, #823, #939 and #1178 all guard the content
    // direction; nothing watched this one, and the pane never observed its own
    // height at all.
    //
    // The everyday trigger is the composer: typing a multi-line follow-up with
    // ⇧⏎ — which the composer's own placeholder tells you to use — auto-grows
    // the textarea from 128px to its 312px max, taking 184px straight out of
    // the transcript's viewport. The answer you are replying to scrolled out
    // of view while you typed the reply.
    //
    // Only re-assert while PINNED: a reader who has deliberately scrolled up
    // must keep their place (#823's rule), and #1330's control is their way
    // back.
    this.#paneObserver = new ResizeObserver(() => {
      if (this.#pinned) this.#scrollToBottom(true)
    })
    this.#paneObserver.observe(this.#scroller)

    this.#feed = document.createElement('div')
    this.#feed.className = 'fl-conv-feed'
    this.#scroller.appendChild(this.#feed)
    // A command list arriving (or changing) re-highlights the user messages
    // already on screen — rare, so a query over the mounted window is fine.
    onCommandNamesChanged(() => {
      for (const body of this.#feed.querySelectorAll<HTMLElement>('.fl-conv-user-body')) {
        const text = userBodyText.get(body)
        if (text !== undefined) renderHighlightedText(body, text)
      }
    })

    this.#activity = document.createElement('div')
    this.#activity.className = 'fl-conv-activity'
    this.#activity.hidden = true
    const dots = document.createElement('div')
    dots.className = 'fl-conv-dots'
    dots.setAttribute('aria-hidden', 'true')
    dots.appendChild(document.createElement('span'))
    dots.appendChild(document.createElement('span'))
    dots.appendChild(document.createElement('span'))
    this.#activityLabel = document.createElement('span')
    this.#activityLabel.className = 'fl-conv-activity-label'
    this.#activityLabel.textContent = 'Working…'
    this.#activity.appendChild(dots)
    this.#activity.appendChild(this.#activityLabel)
    this.#scroller.appendChild(this.#activity)

    this.#empty = document.createElement('div')
    this.#empty.className = 'fl-conv-empty'
    const emptyIcon = document.createElement('fl-icon')
    emptyIcon.setAttribute('name', 'message')
    emptyIcon.setAttribute('size', '20')
    this.#emptyLabel = document.createElement('span')
    this.#empty.appendChild(emptyIcon)
    this.#empty.appendChild(this.#emptyLabel)
    if (this.#handlers.onNewThread || this.#handlers.onOpenProject) {
      const button = document.createElement('fl-button')
      button.setAttribute('variant', 'primary')
      button.setAttribute('small', '')
      const btnIcon = document.createElement('fl-icon')
      btnIcon.setAttribute('name', 'plus')
      btnIcon.setAttribute('size', '13')
      this.#emptyButtonLabel = document.createElement('span')
      button.appendChild(btnIcon)
      button.appendChild(this.#emptyButtonLabel)
      button.addEventListener('click', () => {
        if (this.#projectAvailable) {
          this.#handlers.onNewThread?.()
        } else {
          this.#handlers.onOpenProject?.()
        }
      })
      this.#empty.appendChild(button)
    }
    this.#renderEmptyState()

    // #1330: the way back to the live end. Container level (outside the
    // scroller, like the usage line) so it floats over the feed rather than
    // scrolling away with it.
    const jump = document.createElement('button')
    jump.type = 'button'
    jump.className = 'fl-conv-jump'
    jump.hidden = true
    jump.addEventListener('click', () => {
      this.#pinned = true
      this.#entriesAtUnpin = null // back at the live end — nothing is missed (#1472)
      this.#scrollToBottom(true)
      this.#syncJumpControl()
    })
    this.#jumpBtn = jump

    this.#usage = document.createElement('div')
    this.#usage.className = 'fl-conv-usage'
    this.#usage.hidden = true
    this.#usageText = document.createElement('span')
    this.#usageSavings = document.createElement('span')
    this.#usageSavings.className = 'fl-conv-usage-saved'
    this.#usageSavings.hidden = true
    this.#usageSavings.title = THREAD_SAVINGS_TOOLTIP
    const usageSavedIcon = document.createElement('fl-icon')
    usageSavedIcon.setAttribute('name', 'brain')
    usageSavedIcon.setAttribute('size', '12')
    this.#usageSavingsLabel = document.createElement('span')
    this.#usageSavings.append(usageSavedIcon, this.#usageSavingsLabel)
    // The row inside carries the column cap; the outer element keeps the
    // scroller's padding, so the two together land on the feed's own edges.
    this.#contextMeter = new ContextMeter({
      onShorten: () => this.#shortenConversation(),
    })
    const usageRow = document.createElement('div')
    usageRow.className = 'fl-conv-usage-row'
    usageRow.append(this.#usageText, this.#usageSavings, this.#contextMeter.element)
    this.#usage.append(usageRow)

    /**
     * THE CONVERSATION'S FOOTER LINE — one row, on the transcript's own column.
     *
     * The savings chip used to hang off the pane's right EDGE (`align-self:
     * flex-end` on the container), which put it past the right-hand end of every
     * message above it: the reader's eye follows a column of text down and then
     * finds the badge outside it. Called out with a drawn line
     * (user, 2026-09-10) — "that should respect that line of the UI".
     *
     * So the footer reproduces the feed's geometry exactly — the scroller's own
     * horizontal padding on the outside, the same `--fl-conv-column` cap and
     * auto margins on the inside — and everything that belongs to the
     * conversation rather than to a message lines up with it. `#footerLead` is
     * the left half, filled from outside (the Changes strip, `threads/index.ts`);
     * the chip is the right.
     */
    this.#footer = document.createElement('div')
    this.#footer.className = 'fl-conv-footer'
    const footerRow = document.createElement('div')
    footerRow.className = 'fl-conv-footer-row'
    this.#footerLead = document.createElement('div')
    this.#footerLead.className = 'fl-conv-footer-lead'
    const footerSpacer = document.createElement('span')
    footerSpacer.className = 'fl-conv-footer-spacer'
    // ONE ROW: the Changes strip on the left, the turn's cost on the right.
    // They were two stacked rows sharing the same column, which read as a
    // column of loose fragments rather than a footer — "make they aligned
    // horizontaly" (user, 2026-09-16). The comment above already described this
    // shape; only the usage line had never moved into it.
    footerRow.append(this.#footerLead, footerSpacer, this.#usage)
    this.#footer.appendChild(footerRow)

    // Usage line + footer as ONE bottom block with `margin-top: auto`, so they
    // stay at the foot of the pane even when the scroller above them is not
    // filling it — an unbound or empty transcript otherwise floats the whole
    // footer to the top of the column, which is where it was found sitting.
    // Auto-margin on each of them separately would split the free space
    // between the two instead of putting all of it above the pair.
    const foot = document.createElement('div')
    foot.className = 'fl-conv-foot'
    foot.append(this.#footer)

    // #1931 — the sub-agent-continuation header sits ABOVE the scroller so it
    // stays visible while the transcript scrolls. Hidden until setThread opens a
    // promoted child thread. The back link dispatches flow:open-thread so the
    // one guarded navigation handler returns the user to the parent.
    this.#subagentBanner = document.createElement('div')
    this.#subagentBanner.className = 'fl-conv-subagent-banner'
    this.#subagentBanner.style.display = 'none'
    injectSubagentBannerStyles()

    container.appendChild(this.#subagentBanner)
    container.appendChild(this.#scroller)
    container.appendChild(this.#empty)
    container.appendChild(jump) // #1330
    container.appendChild(foot)

    const api = window.flow
    this.#unsubscribes.push(
      api.threads.onStream((event) => this.#onStream(event)),
      api.threads.onPermissionRequest((request) => this.#onPermissionRequest(request)),
      api.threads.onDialogRequest((request) => this.#onDialogRequest(request)),
      api.threads.onDialogCancel((cancel) => this.#onDialogCancel(cancel)),
      // A MESSAGE WRITTEN BY MAIN, OUTSIDE A TURN, MUST STILL APPEAR.
      //
      // Main appends system messages the pane knows nothing about — a
      // worktree's dependency note, a debug session's summary. The row lands
      // in the store and `threads:updated` carries an `entity: 'message'`
      // event, but nothing here was listening: the transcript is loaded when a
      // thread is opened and extended by the stream, so a write from anywhere
      // else was invisible until the thread was re-opened. Reported as the
      // debug session doing nothing at all (user, 2026-09-21) — the agent had
      // the summary in its context, and the person could not see it.
      //
      // NOT DURING A TURN. Streaming emits message events constantly, and
      // answering a hot broadcast with a full re-read is exactly
      // forbidden-pattern #14 — the stream already delivers that content. This
      // fires only when nothing is in flight, which is precisely when an
      // appended row has no other way in.
      api.threads.onUpdated((events) => this.#onForeignMessages(events)),
    )

    // ── Blueprint story card (blueprint-v2) ──────────────────────────────────
    // The story card mirrors the question/tool live-card pattern: it lives in
    // the active thread's feed and is (re)read on the decoupled open signal and
    // on any blueprint change for the active project. Guarded — the same preload
    // absence check the surface composer already tolerates.
    if (api.blueprint) {
      this.#unsubscribes.push(
        api.blueprint.onChanged(({ rootId, learningOnly }) => {
          // A LEARN RUN IS NOT A STORY CHANGE. It rewrites feature-learning state
          // hundreds of times per run and never touches the plan story, yet each
          // tick used to fire a full readStory IPC + card rebuild — exactly while
          // the user is on the board tab and this pane is hidden. Skip those
          // (mirrors blueprint-board.handleChanged's learningOnly gate, #1666).
          if (learningOnly) return
          // A live blueprint change (the narrate that (re)compiled the story) lets
          // the ACTIVE thread claim ownership — that's how a story gets bound to
          // the thread that authored it. Bind/relaunch reads (below) never claim.
          if (rootId === this.#activeRoot) void this.#readStory(rootId, { claim: 'live' })
        }),
      )
    }
    // ── Flow artifact cards (blueprint-interaction Phase 2) ──────────────────
    // A discovery/plan/brainstorm doc changed under flow/ — surface it as an
    // inline card for the active project. Guarded like the blueprint wiring.
    if (api.flow) {
      this.#unsubscribes.push(
        api.flow.onArtifactChanged((event) => void this.#onArtifactChanged(event)),
      )
      // The running line of a plan executed from a card. Answered only while
      // such a run is going, and only for this project (allowed-pattern #17).
      if (api.flow.onStateChanged) {
        this.#unsubscribes.push(api.flow.onStateChanged((state) => this.#onFlowState(state)))
      }
    }
    if (api.project) {
      this.#unsubscribes.push(
        api.project.onActiveChanged((context) => {
          this.#activeRoot = context?.rootPath ?? null
          // Artifacts belong to a project — the previous project's cards must not
          // leak onto the new one.
          this.#clearArtifacts()
          if (this.#activeRoot) {
            void this.#readStory(this.#activeRoot)
            void this.#seedArtifacts(this.#activeRoot)
          } else this.#applyStory(null)
        }),
      )
      void api.project
        .active()
        .then((context) => {
          this.#activeRoot = context?.rootPath ?? null
          // Read the story on the INITIAL bind too, not just on change — otherwise
          // the common relaunch path (project already active, no change event) never
          // auto-opens the story card until a later trigger (#516). Artifact cards
          // have the SAME relaunch gap (the watcher is ignoreInitial), so seed them
          // from the existing docs here too.
          if (this.#activeRoot) {
            void this.#readStory(this.#activeRoot)
            void this.#seedArtifacts(this.#activeRoot)
          }
        })
        .catch(() => undefined)
    }
    this.#openBlueprintHandler = (): void => {
      // Opening the blueprint from a thread is an intentional engagement — the
      // thread ADOPTS an orphaned story (legacy / not yet owned), but never
      // steals one already owned by another thread.
      if (this.#activeRoot) void this.#readStory(this.#activeRoot, { claim: 'adopt' })
    }
    document.addEventListener('flow:open-blueprint', this.#openBlueprintHandler)
    // ── Conflict review card (conflict-UX v2, Phase 4) ───────────────────────
    // Resolve-with-AI (editor/conflict-resolve-index.ts) dispatches this once the
    // agent's proposals are ready — mount the human-in-the-loop review card. The
    // apply/verify wiring rides on the event's callbacks; the card owns its DOM.
    this.#conflictReviewHandler = (event: Event): void => {
      this.#renderConflictReviewCard((event as CustomEvent<ConflictReviewEventDetail>).detail)
    }
    document.addEventListener(CONFLICT_REVIEW_EVENT, this.#conflictReviewHandler)
  }

  /** Mount a conflict-review card into the feed, tracking it so a thread switch
   *  drops the reference (its element is detached by the feed wipe). */
  #renderConflictReviewCard(detail: ConflictReviewEventDetail): void {
    if (!detail || detail.inputs.length === 0) return
    const card = new ConflictReviewCard(detail.inputs, detail.onDecision, detail.onDecisionAll)
    this.#conflictReviewCards.push(card)
    this.#feed.appendChild(entryWrapper('permission', card.element))
    // An actionable review is worth forcing into view, like a pending question.
    this.#scrollToBottom(true)
  }

  #onDialogRequest(request: UserQuestionRequest): void {
    // The queue buffers (never drops) when the question is for a thread we're not
    // showing, or while history is loading — a card appended mid-load would be
    // wiped by #loadHistory's feed reset, leaving the agent parked forever.
    const toRender = this.#questionQueue.incoming(request, {
      activeThreadId: this.#threadId,
      loading: this.#historyLoading,
    })
    if (toRender) this.#renderQuestionCard(toRender)
  }

  /**
   * The agent's parked questions were cancelled because the user sent a message
   * instead of answering (#692). Remove the stale card(s) from the feed and mark
   * them resolved in the queue so the never-drop invariant stops re-buffering and
   * re-rendering them on the next feed rebuild. A card buffered (not yet rendered)
   * is dropped via resolve() alone.
   */
  #onDialogCancel(cancel: UserDialogCancel): void {
    for (const requestId of cancel.requestIds) {
      const card = this.#questionCards.get(requestId)
      if (card) {
        card.dispose() // release the digit-shortcut registration (#984)
        card.element.remove()
      }
      this.#forgetQuestionCard(requestId)
    }
  }

  #renderQuestionCard(request: UserQuestionRequest): void {
    if (this.#questionCards.has(request.requestId)) return
    const wiped = this.#wipedQuestionCards.get(request.requestId)
    if (wiped) {
      this.#wipedQuestionCards.delete(request.requestId)
      wiped.resume()
      this.#questionCards.set(request.requestId, wiped)
      this.#feed.appendChild(entryWrapper('permission', wiped.element))
      this.#scrollToBottom(true)
      return
    }
    const dismiss = (): void => this.#forgetQuestionCard(request.requestId)
    const card = new QuestionCard(
      request,
      async (answers) => {
        try {
          await window.flow.threads.respondDialog({ requestId: request.requestId, answers })
        } catch (error) {
          console.error('flow: failed to deliver question answer', error)
          // A disposed-dialog rejection (session crashed/ended, #290) is TERMINAL —
          // retrying can never succeed, so raise a typed error the card renders as a
          // dead-end with a Dismiss (#301). Any other rejection is transient ("Try again").
          if (isSessionGone(error)) throw new SessionGoneError()
          throw new Error("couldn't reach the agent")
        }
        this.#forgetQuestionCard(request.requestId)
      },
      dismiss,
    )
    this.#questionCards.set(request.requestId, card)
    this.#feed.appendChild(entryWrapper('permission', card.element))
    // A pending question is actionable — force it into view.
    this.#scrollToBottom(true)
  }

  /** A question is answered, dismissed or cancelled — nothing re-renders it. */
  #forgetQuestionCard(requestId: string): void {
    this.#questionCards.delete(requestId)
    this.#wipedQuestionCards.delete(requestId)
    this.#questionQueue.resolve(requestId)
  }

  /** Render any questions that arrived for `threadId` while it was inactive or
   *  loading (so the agent un-parks when the user returns to the thread), then
   *  ask main what it still holds — the pane's buffer is the only copy otherwise,
   *  and a renderer that lost it (reload, recreate) would leave the agent parked
   *  forever with no card to answer. */
  #flushPendingQuestions(threadId: string): void {
    for (const request of this.#questionQueue.flush(threadId)) this.#renderQuestionCard(request)
    void this.#syncBrokerQuestions(threadId)
  }

  /** Fetch the broker's still-parked questions for `threadId` and render any the
   *  pane doesn't already show. Fail-soft — a fetch error just means the live
   *  event path is the only source. Every request goes through the queue so a
   *  question the live event already delivered is never drawn twice. */
  async #syncBrokerQuestions(threadId: string): Promise<void> {
    let parked: UserQuestionRequest[]
    try {
      parked = await window.flow.threads.pendingDialogs({ threadId })
    } catch (error) {
      console.warn('flow: failed to fetch pending questions', { threadId, error })
      return
    }
    if (this.#threadId !== threadId || this.#historyLoading) return
    for (const request of parked) {
      const toRender = this.#questionQueue.incoming(request, {
        activeThreadId: this.#threadId,
        loading: false,
      })
      if (toRender) this.#renderQuestionCard(toRender)
    }
  }

  get threadId(): string | null {
    return this.#threadId
  }

  /**
   * The footer's left half — the transcript's own column, beside the savings
   * chip.
   *
   * Exposed rather than filled here so the pane keeps knowing nothing about the
   * change review: whoever owns a footer control mounts it, and gets the
   * conversation's geometry for free. Hidden and shown WITH the transcript,
   * because everything in this row is about the conversation on screen.
   */
  get footerSlot(): HTMLElement {
    return this.#footerLead
  }

  /** Tell the empty state whether a project is open, so its action reads
   *  "New Thread" (creates one) vs "Open Project" (opens the folder picker) —
   *  no surprise native dialog behind a "New Thread" button. */
  setProjectAvailable(available: boolean): void {
    if (this.#projectAvailable === available) {
      return
    }
    this.#projectAvailable = available
    this.#renderEmptyState()
  }

  #renderEmptyState(): void {
    if (this.#projectAvailable) {
      this.#emptyLabel.textContent = 'Select or create a thread to talk to the agent'
      if (this.#emptyButtonLabel) this.#emptyButtonLabel.textContent = 'New Thread'
    } else {
      this.#emptyLabel.textContent = 'Open a project to start talking to the agent'
      if (this.#emptyButtonLabel) this.#emptyButtonLabel.textContent = 'Open Project'
    }
  }

  /** Switch the pane to a thread (null clears to the empty state).
   *
   *  `status` is the thread row's live status — the same source the composer
   *  reads (composer.ts `setStatus(thread?.status ?? 'idle')`). Without it a
   *  return to a still-running thread showed a transcript that read idle while
   *  the composer offered Interrupt (#1049): `#resetActivity()` cleared the
   *  loader and nothing re-derived busy-ness until the next stream event. */
  async setThread(
    threadId: string | null,
    status?: ThreadStatus,
    thread?: ThreadSummary | null,
  ): Promise<void> {
    this.#threadId = threadId
    this.#clearLive()
    // A pending foreign refetch belongs to the conversation just left.
    this.#foreignRefresh.reset()
    // #1931 — show the "continuing from sub-agent" header + back-to-parent link
    // when the opened thread is a promoted sub-agent child, hide it otherwise.
    // Origin-running starts false on every switch; the gate in threads/index.ts
    // re-asserts it asynchronously when the origin tool call is still going.
    this.#subagentOriginRunning = false
    this.#renderSubagentBanner(thread ?? null)
    // Another thread's transcript is not this one's: a density change arriving
    // before the new history lands must never repaint the feed from entries
    // that belong to the conversation just left.
    this.#historyEntries = null
    // A thread switch wipes the feed, so drop the story-card reference — the new
    // thread rebuilds its own card from #currentStory after history loads (its
    // minimize state comes from the per-thread memory). Turn reconciles keep the
    // reference so the card's step/minimize survive them.
    this.#storyCard = null
    this.#storyEntry = null
    // A different thread's background work is not this one's — cleared on
    // switch so the note never describes the conversation you just left.
    this.#backgroundTasks = []
    // Same discipline for artifact cards: the feed wipe detaches their elements,
    // so drop the live card refs — the models survive and re-mount after load,
    // but only in the thread that owns them (#658).
    this.#artifactCards.clear()
    this.#artifactEntries.clear()
    // Marker-backed inline cards (#1056) are per-feed too — the next
    // #loadHistory rebuilds them from the thread's own marker rows.
    this.#markerCards.clear()
    this.#clearFolderBehindCards()
    this.#markerPaths.clear()
    this.#foldedPaths.clear()
    this.#markerHosts.clear()
    // Conflict-review cards are per-feed live cards — drop their refs on switch.
    this.#conflictReviewCards = []
    // A different transcript starts from its own history window (#1088) — and
    // from its own "new" count: the old one used to follow the reader into a
    // thread where nothing had happened (#1472).
    this.#earlierExpanded = false
    // Group expansion is keyed by this thread's tool-call ids — a new
    // transcript starts with every group collapsed (#17).
    this.#expandedGroups.clear()
    this.#toolGroupByCardId.clear()
    // Turn expansion is keyed by this thread's assistant message ids — same
    // reason, one fold out.
    this.#expandedTurns.clear()
    this.#turnByCardId.clear()
    this.#expandedRequests.clear()
    this.#expandedSteps.clear()
    this.#requestByCardId.clear()
    // The half-counted turn is dropped, the counted ones are kept. A thread
    // switched away from mid-thought never reaches `done`, so its open span
    // would otherwise be added to whatever turn finishes next — in another
    // conversation. #thoughtMs itself survives (see its comment): those turns
    // are already named and already over.
    this.#thinkingStartedAt = null
    this.#thinkingElapsedMs = 0
    // A new thread starts bounded again — the previous one's "show everything"
    // was about that transcript, not this one.
    this.#historyFetchLimit = HISTORY_FETCH
    this.#historyTruncated = false
    this.#entriesAtUnpin = null
    this.#renderedEntries = 0
    this.#feed.textContent = ''
    this.#usage.hidden = true
    this.#usageSavings.hidden = true
    // A reading belongs to the thread it was taken in; carrying it across a
    // switch would show one conversation's fullness over another's.
    this.#contextMeter.update(null)
    this.#currentModel = null // a new thread's model is unknown until its next turn
    this.#learningFirstLine = null
    this.#learningFirstCard = null
    this.#resetActivity()
    this.#applyTurnEdge({ kind: 'thread-opened', status: threadId ? status : undefined })
    this.#pinned = true
    // Clean, Zed-like empty state: no placeholder/CTA when no thread is open —
    // just a blank surface (new threads start from the sidebar's + button).
    this.#empty.style.display = 'none'
    this.#scroller.style.display = threadId ? 'block' : 'none'
    if (threadId) {
      // #1049: restore the in-progress indication for a turn that kept running
      // while the pane was elsewhere. The FLAG is set before the rebuild
      // because the turn fold reads it — a turn still in flight renders open
      // (NFR-3), and switching into a working thread whose last tool already
      // returned would otherwise fold the very turn the reader came to watch.
      // The loader is still REFRESHED after the rebuild, which is what #1049
      // was about: #loadHistory re-derives #toolRunning from the persisted
      // records, so a restored still-running tool card keeps suppressing the
      // loader rather than stacking one on top of its own spinner.
      if (status === 'working') this.#busy = true
      await this.#loadHistory(threadId)
      // A later stream event reconciles cleanly — 'status working' re-asserts
      // #busy, 'done'/'error' reset it — the loader is a single toggled node,
      // so no duplicate indicator is possible.
      if (status === 'working' && this.#threadId === threadId) {
        this.#refreshActivity()
      }
      // AND WHAT THIS THREAD IS STILL WAITING ON. Same reason as the line
      // above, for the state that is not a turn: switching into a thread whose
      // agents are running mid-flight has missed every event that announced
      // them, and the runtime only re-announces a set that CHANGED.
      const running = await window.flow.threads
        .backgroundTasks?.({})
        .catch(() => ({}) as Record<string, BackgroundTaskInfo[]>)
      if (this.#threadId === threadId) {
        this.#applyBackgroundTasks(running?.[threadId] ?? [])
      }
      // …and whether its first message is still waiting on a basic discovery
      // (the stream only carries the change, which this pane may have missed).
      const held = await window.flow.threads.learningFirst?.({ threadId }).catch(() => null)
      if (held !== null && held !== undefined && this.#threadId === threadId) {
        this.#applyLearningFirst(held)
      }
      this.#scrollToBottom(true)
    }
  }

  /** Show/hide the sub-agent-continuation header for the opened thread (#1931).
   *  A promoted child carries `parentThreadId`; the back link dispatches
   *  flow:open-thread so the one guarded navigation handler returns to the
   *  parent conversation. */
  #renderSubagentBanner(thread: ThreadSummary | null): void {
    this.#bannerThread = thread
    const parentThreadId = thread?.parentThreadId ?? null
    if (parentThreadId === null || parentThreadId === undefined) {
      this.#subagentBanner.style.display = 'none'
      this.#subagentBanner.replaceChildren()
      return
    }
    this.#subagentBanner.replaceChildren()

    const label = document.createElement('span')
    label.className = 'fl-conv-subagent-banner-label'
    label.textContent = this.#subagentOriginRunning
      ? `Sub-agent still running: ${thread?.title ?? 'Sub-agent'} — this chat updates live; replies unlock when it finishes`
      : `Continuing from sub-agent: ${thread?.title ?? 'Sub-agent'}`

    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'fl-conv-subagent-banner-back'
    back.textContent = '← Back to parent'
    back.addEventListener('click', () => {
      document.dispatchEvent(
        new CustomEvent('flow:open-thread', { detail: { threadId: parentThreadId } }),
      )
    })

    this.#subagentBanner.append(label, back)
    this.#subagentBanner.style.display = ''
  }

  /**
   * Tell the banner whether the child's ORIGIN tool call is still running
   * (#1931 D-4) — resolved by threads/index.ts (the same place that locks the
   * composer, so the two surfaces can never disagree). Re-renders only on a
   * real change; a no-op for a thread that is not a promoted child.
   */
  setSubagentOriginRunning(running: boolean): void {
    if (this.#subagentOriginRunning === running) return
    this.#subagentOriginRunning = running
    this.#renderSubagentBanner(this.#bannerThread)
  }

  /** Optimistically render the user's message the instant they hit send,
   *  before the round-trip resolves — the composer calls this so the pane
   *  never sits blank while the session spins up. The bubble is replaced by
   *  the persisted row on turn reconciliation, so there's no duplicate.
   *
   *  Returns a rollback closure (or null when there's no thread): a caller whose
   *  send never lands calls it to remove the phantom bubble AND stop the loader
   *  it started, so a failed send doesn't misrepresent a message as sent (#180). */
  echoUserMessage(
    content: string,
    attachments?: readonly MessageAttachmentInput[],
  ): (() => void) | null {
    if (!this.#threadId) {
      return null
    }
    // Optimistic echo carries the bytes in hand → render thumbnails immediately.
    const thumbs = attachments?.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      dataUrl: attachmentDataUrl(attachment),
    }))
    const entry = entryWrapper('user', userBubble(content, thumbs))
    entry.classList.add('fl-conv-enter')
    this.#feed.appendChild(entry)
    // A new message is a new request: its work gets its own row below it.
    this.#endLiveRequest()
    // If a reconcile is mid-fetch, tell it not to wipe this fresh turn (#101).
    if (this.#historyLoading) this.#liveDuringLoad = true
    // The turn is starting — show the activity loader immediately.
    this.#busy = true
    this.#applyTurnEdge({ kind: 'send' })
    this.#streaming = false
    this.#thinkingActive = false
    this.#toolRunning = false
    this.#refreshActivity()
    this.#scrollToBottom(true)
    return () => {
      entry.remove()
      this.#busy = false
      this.#applyTurnEdge({ kind: 'send-rolled-back' })
      this.#refreshActivity()
    }
  }

  dispose(): void {
    for (const timer of this.#executingTimers.values()) window.clearTimeout(timer)
    this.#executingTimers.clear()
    this.#paneObserver?.disconnect()
    this.#paneObserver = null
    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe()
    }
    this.#unsubscribes = []
    if (this.#openBlueprintHandler) {
      document.removeEventListener('flow:open-blueprint', this.#openBlueprintHandler)
      this.#openBlueprintHandler = undefined
    }
    if (this.#conflictReviewHandler) {
      document.removeEventListener(CONFLICT_REVIEW_EVENT, this.#conflictReviewHandler)
      this.#conflictReviewHandler = undefined
    }
    if (this.#scrollFrame !== null) {
      cancelAnimationFrame(this.#scrollFrame)
      this.#scrollFrame = null
    }
    this.#foreignRefresh.reset()
    // #1138: the viewer is body-mounted, so it would outlive the pane that
    // opened it — a full-screen overlay of an image whose thread is gone.
    closeImageViewer()
  }

  /**
   * Re-read the transcript when somebody else wrote to the open thread.
   *
   * Gated so it cannot become a refresh-per-broadcast: the open thread only,
   * message/tool_call events only, debounced with a max-wait bound, and
   * DEFERRED (never dropped) while a turn is live or a load is in flight. The
   * scheduling itself lives in ForeignRefreshScheduler (#1931) — see its
   * header for the two child-pane failure modes it closes.
   *
   * tool_call counts too (#1931): a promoted sub-agent CHILD thread's rows —
   * messages AND tool calls — are written by the PARENT's streaming session,
   * so this pane's own stream never carries them; these events are their only
   * way in. Debounced, because that session batches every 50ms and each
   * refetch is a full (bounded) history read — one read per window, not per
   * batch (allowed-pattern #17 / forbidden #14).
   */
  #onForeignMessages(events: readonly { threadId: string; entity: string }[]): void {
    const threadId = this.#threadId
    if (threadId === null) return
    const touched = events.some(
      (event) =>
        event.threadId === threadId &&
        (event.entity === 'message' || event.entity === 'tool_call'),
    )
    if (!touched) return
    this.#foreignRefresh.touched()
  }

  /**
   * Run the ONE follow-up load a deferred foreign refresh asked for (#1931).
   * Called wherever an owning `#loadHistory` settles and when a live turn
   * ends. Bounded: the scheduler clears the flag before refreshing, and only
   * a NEW foreign event arriving during the follow-up can set it again —
   * exactly the case that needs another read.
   */
  #consumePendingForeignRefresh(threadId: string): void {
    if (this.#threadId !== threadId) return
    this.#foreignRefresh.consume()
  }

  // ── History ──────────────────────────────────────────────────────────────

  async #loadHistory(threadId: string): Promise<void> {
    const token = (this.#loadToken += 1)
    this.#historyLoading = true
    this.#liveDuringLoad = false
    // Any foreign event from BEFORE this fetch begins is captured by the fetch
    // itself — only events arriving while it is in flight re-arm the flag.
    this.#foreignRefresh.loadStarted()
    const api = window.flow
    let messages: ThreadMessage[]
    let toolCalls: ToolCallRecord[]
    try {
      // ONLY THE MESSAGES THIS PANE WILL MOUNT, plus a margin so the window is
      // never short. A real thread here is 1,260 messages and 2.74 MB,
      // transferred whole on every open to render 200 (forbidden-pattern #13).
      // "Show earlier" fetches the rest when a reader asks for it.
      messages = await api.messages.list({ threadId, limit: this.#historyFetchLimit })
      // AND ONLY THE TOOL CALLS THAT WINDOW COVERS. Bounding their OUTPUTS was
      // half the job: the rows themselves were still the whole thread — 1.19 MB
      // of metadata for 1,800 calls, to draw the couple of hundred beside these
      // messages. Anything older belongs to a turn nobody is looking at, and
      // arrives when "Show earlier" widens the window.
      //
      // Sequenced, not parallel, because the cutoff IS the oldest message —
      // two reads of a few milliseconds each, against a megabyte that used to
      // cross on every open and every turn's reconcile.
      const oldest = messages[0]?.createdAt
      toolCalls = await api.toolCalls.list({
        threadId,
        outputLimit: TOOL_OUTPUT_WINDOW,
        // …with a floor, because an agent-heavy turn can run hundreds of calls
        // between two messages: bounding on the message timestamp alone would
        // drop every card of a turn whose messages all arrived after it.
        ...(oldest === undefined ? {} : { since: oldest, atLeast: TOOL_ROW_FLOOR }),
      })
    } catch (error) {
      console.error('flow: failed to load thread history', { threadId, error })
      if (token === this.#loadToken && this.#threadId === threadId) {
        this.#historyLoading = false
        this.#appendErrorCard('Failed to load thread history')
        this.#flushPendingQuestions(threadId)
        this.#flushPendingPermissions(threadId)
        this.#consumePendingForeignRefresh(threadId)
      }
      return
    }
    if (token !== this.#loadToken || this.#threadId !== threadId) {
      return // thread switched while loading — the newer load owns #historyLoading
    }

    if (this.#liveDuringLoad) {
      // A new turn began during this fetch (a follow-up sent the instant the
      // prior turn finished): the feed already holds its echoed bubble + live
      // stream node. Wiping now would destroy them, leaving a blank/frozen pane
      // (#101). Skip this stale reconcile — the new turn's own reconcile
      // re-fetches and rebuilds cleanly once it completes.
      this.#historyLoading = false
      this.#flushPendingQuestions(threadId)
      this.#flushPendingPermissions(threadId)
      // A deferred foreign refresh is consumed here too — in practice the new
      // turn's #busy supersedes it (its own reconcile re-reads everything).
      this.#consumePendingForeignRefresh(threadId)
      return
    }

    // A read that came back exactly full is a read that left something behind.
    this.#historyTruncated =
      this.#historyFetchLimit !== undefined && messages.length >= this.#historyFetchLimit
    const entries: HistoryEntry[] = [
      ...messages.map((message): HistoryEntry => ({
        kind: 'message',
        at: message.createdAt,
        message,
      })),
      ...toolCalls.map((toolCall): HistoryEntry => ({
        kind: 'tool',
        at: toolCall.startedAt,
        toolCall,
      })),
    ]
    entries.sort((a, b) => a.at.localeCompare(b.at))

    // Kept so a density change can repaint from the entries already in hand
    // rather than going back to the store (Phase 5.4 / NFR-1).
    this.#historyEntries = entries
    this.#paintFeed(entries)
    // History is on screen — safe to render any questions and permission asks
    // that arrived while it was loading (they were buffered so the feed reset
    // above wouldn't wipe them).
    this.#historyLoading = false
    this.#flushPendingQuestions(threadId)
    this.#flushPendingPermissions(threadId)
    // Surface the buffered blueprint story now that the feed is settled (the same
    // "render once active + loaded" discipline as the question queue).
    this.#remountLiveCards()
    // Re-surface the current turn's failure after the feed rebuild — one the
    // pane witnessed live (#846) or one that arrived while this thread was in
    // the background (#1048). Main persists failure notes as system rows that
    // render above as error cards, so only append when the rebuilt history does
    // NOT already carry this exact notice — a live-witnessed failure whose row
    // was persisted must not produce two cards.
    const witnessed =
      this.#turnError !== null && this.#turnError.threadId === threadId
        ? this.#turnError.message
        : null
    const background = this.#backgroundErrors.get(threadId) ?? null
    this.#backgroundErrors.delete(threadId)
    const failureNotice = witnessed ?? background
    if (failureNotice !== null) {
      const alreadyPersisted = messages.some(
        (message) => message.role === 'system' && message.content === failureNotice,
      )
      if (!alreadyPersisted) this.#appendErrorCard(failureNotice)
    }
    // A foreign write that landed while this load was fetching is not in what
    // was just painted — run the one follow-up it asked for (#1931).
    this.#consumePendingForeignRefresh(threadId)
  }

  /**
   * Re-mount the cards that live ON the feed rather than IN its history.
   *
   * The story card and the artifact cards are appended after a rebuild, not
   * derived from the entry list — so every path that wipes the feed owes them
   * a remount. That obligation used to live only inside `#loadHistory`, and
   * the moment a SECOND wiper appeared (the density repaint) it was silently
   * skipped: changing Conversation density made a thread's story card and
   * artifact cards disappear until the next turn or a thread switch brought
   * them back.
   *
   * IT IS DELIBERATELY NOT EVERYTHING. A failure card and a conflict-review
   * card are also un-derivable from the entries, and they are NOT restored
   * here — because they are not survivable at all: the failure card needs
   * `#loadHistory`'s de-duplication against persisted system rows, and a
   * conflict-review card is actionable state a rebuild cannot reconstruct.
   * `#feedHoldsLiveNodes` is what protects those: a repaint does not happen
   * while either is on screen. An earlier version of this docstring claimed to
   * restore the failure card and did not, which is the shape of comment that
   * makes a reader stop checking.
   *
   * One name, called by both wipers (allowed-pattern #14) — the same invariant
   * this change collapsed `groupPresentation` for, reintroduced one level up
   * and now closed at the level it belongs to.
   */
  #remountLiveCards(): void {
    this.#renderStoryCard()
    this.#renderKnownArtifacts()
  }

  /**
   * Re-fold the feed the reader is looking at, WITHOUT going back to the store.
   *
   * The entries are already in hand and `projectFeed` is pure, so a density
   * change is a repaint and nothing more — no history refetch, no new payload
   * (Phase 5.4 / NFR-1).
   *
   * Deferred while a turn is in flight. Mid-turn the feed holds live nodes that
   * nothing has persisted yet — the streaming assistant text, the echoed user
   * bubble of a follow-up — and #paintFeed wipes the feed before rebuilding it,
   * which is the same reason the reconcile itself bails out on a live tail
   * (#101). The change is not lost: the reconcile that `done` already runs
   * rebuilds through the new density a moment later.
   */
  #repaintForDensity(): void {
    const entries = this.#historyEntries
    if (entries === null || this.#threadId === null) return
    if (this.#historyLoading || this.#feedHoldsLiveNodes()) return
    this.#paintFeed(entries)
    // #paintFeed WIPES; anything appended after a rebuild has to come back.
    this.#remountLiveCards()
  }

  /**
   * Whether the feed is holding anything a rebuild could not put back.
   *
   * ACTIVITY FLAGS ARE NOT A GUARD AGAINST ACTIVITY, which is what the first
   * version of this used and what made a density change destructive. When the
   * agent parks on a permission ask, main emits `needs-decision`; the status
   * handler routes every non-`working` status to `#resetActivity()`, which
   * clears `#busy`, `#streaming` AND `#toolRunning` — so a turn that is
   * maximally in flight passed all three checks. `#paintFeed` then wiped the
   * feed, and `#renderPermissionCard` cannot re-append the card because
   * `#permissionCards` still holds its id: the turn hung with the broker
   * parked and no `done` coming. Same shape after an interrupt and after
   * `markThreadFailed`, both of which end a turn without a `done`.
   *
   * So the question is not "is something moving" but "is the feed showing
   * anything I cannot rebuild from `#historyEntries`":
   *
   *  · a streaming assistant node, still receiving deltas into an element the
   *    wipe would detach — the rest of the answer would never render;
   *  · a permission or question card, which is ACTIONABLE and un-persisted,
   *    and whose registry entry blocks it from ever being re-rendered;
   *  · a conflict-review card, actionable for the same reason;
   *  · a failure card the pane witnessed live but whose row is not yet in the
   *    entry list.
   *
   * Any of those and the repaint waits. Nothing is lost: the reconcile that
   * follows the turn rebuilds through the new density a moment later, and the
   * density itself is already stored.
   */
  #feedHoldsLiveNodes(): boolean {
    return (
      this.#busy ||
      this.#streaming ||
      this.#streams.size > 0 ||
      this.#permissionCards.size > 0 ||
      this.#questionCards.size > 0 ||
      this.#conflictReviewCards.length > 0 ||
      this.#turnError !== null
    )
  }

  /**
   * Paint the feed from a sorted entry list — the whole visual half of a
   * reconcile, with no store read in it.
   *
   * Separated from #loadHistory so a DENSITY change can repaint what is
   * already in hand: the entries are held in #historyEntries and the density
   * projection is pure, so re-reading the thread to change how it is folded
   * would be a round trip that answers a question nobody asked (Phase 5.4,
   * NFR-1 — no new payload for the feed).
   */
  #paintFeed(entries: HistoryEntry[]): void {
    // PERF (conservative reuse): harvest the outgoing feed's entry elements
    // keyed by message/tool-call id BEFORE wiping. Unchanged user/assistant
    // messages and settled tool calls re-append their existing element (no
    // markdown re-render, ToolCard re-registered); live nodes, system rows,
    // and anything whose content hash moved rebuild exactly as before —
    // ordering, markers, and reconcile semantics are untouched.
    const harvested = new Map<string, HTMLElement>()
    for (const child of Array.from(this.#feed.children)) {
      const entryId = (child as HTMLElement).dataset?.entryId
      if (entryId !== undefined) harvested.set(entryId, child as HTMLElement)
    }
    this.#reuseElements = harvested
    this.#reuseToolCards = new Map(this.#toolCards)

    this.#feed.textContent = ''
    this.#toolCards.clear()
    // Rebuilt alongside #toolCards as the feed is re-created below.
    this.#toolGroupByCardId.clear()
    this.#turnByCardId.clear()
    this.#requestByCardId.clear()

    // #1056: index the thread's artifact-marker rows BEFORE building entries —
    // docs pinned inline (visible or collapsed behind "Show earlier") must not
    // also pile up as feed-end cards when #renderKnownArtifacts runs below.
    this.#markerCards.clear()
    this.#clearFolderBehindCards()
    this.#markerPaths.clear()
    this.#foldedPaths.clear()
    const markers: ArtifactMarker[] = []
    for (const entry of entries) {
      if (entry.kind !== 'message' || entry.message.role !== 'system') continue
      const marker = parseArtifactMarker(entry.message.content)
      if (marker === null) continue
      this.#markerPaths.add(marker.path)
      markers.push(marker)
    }
    this.#markerHosts = artifactCardHosts(markers)

    // #1049: mirror the live tool-start/tool-end flag from the persisted
    // records — a restored tool call that is still running is its own progress
    // indicator, so a seeded busy state (setThread) must not stack the loader
    // on top of its card.
    this.#toolRunning = entries.some(
      (entry) => entry.kind === 'tool' && entry.toolCall.status === 'running',
    )

    // #1088: the window honors what the reader already expanded — see
    // history-window.ts for the rule.
    const plan = historyWindow(entries.length, HISTORY_WINDOW, this.#earlierExpanded)
    if (plan.earlierCount > 0 || this.#historyTruncated) {
      this.#feed.appendChild(this.#earlierControl(entries.slice(0, plan.earlierCount)))
    }
    // `liveTail`: this slice ends at the live end of the transcript, so its
    // last turn may still be running (a thread opened mid-turn — #toolRunning
    // was just re-derived from the persisted records above — or a rebuild that
    // raced a working turn). The "Show earlier" build below passes nothing:
    // its last unit is old history, and a turn that ended long ago must not
    // render open because the pane happens to be busy now.
    //
    // THE TURN, NOT THE LOADER. `#busy` is set by any motion — including a
    // background agent's tool after `done`. One landing while `done`'s own
    // reconcile was in flight rebuilt the ended request as live, and its row
    // pulsed "Working" until the next turn (`turn-liveness.ts`).
    const liveTail = this.#turnLive || this.#toolRunning
    for (const element of this.#buildGroupedEntries(entries.slice(plan.visibleFrom), liveTail)) {
      this.#feed.appendChild(element)
    }
    // #1472: the transcript's size, recorded once per rebuild. The whole entry
    // list (not the visible window) so expanding "Show earlier" can't read as
    // messages arriving.
    this.#renderedEntries = entries.length
    this.#syncJumpControl()
    // Reuse window closes with the rebuild — later builds (Show earlier,
    // live paths) must never resurrect elements from a previous feed.
    this.#reuseElements = null
    this.#reuseToolCards = null
  }

  #earlierControl(earlier: HistoryEntry[]): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'fl-conv-earlier'
    const button = document.createElement('fl-button')
    button.setAttribute('small', '')
    const label = document.createElement('span')
    // A count we do not have is not a count. When the read was bounded there
    // are older messages still on disk, and claiming a number would be
    // claiming the thread is shorter than it is.
    label.textContent = this.#historyTruncated
      ? 'Show earlier messages'
      : `Show ${earlier.length} earlier ${earlier.length === 1 ? 'entry' : 'entries'}`
    button.appendChild(label)
    button.addEventListener('click', () => {
      // Remembered so the next rebuild does not undo this click (#1088).
      this.#earlierExpanded = true
      if (this.#historyTruncated) {
        // The rest is on disk, not in memory: fetch it, then rebuild with the
        // whole transcript visible. The thread stays open the whole time.
        const threadId = this.#threadId
        this.#historyFetchLimit = undefined
        label.textContent = 'Loading earlier messages…'
        if (threadId === null) return
        // KEEP THE READER WHERE THEY WERE, as the in-memory branch below does.
        // Everything the re-read adds lands ABOVE what is on screen, so the
        // distance from the bottom is the invariant: without this the rebuild
        // left scrollTop at the top of a transcript thousands of pixels taller
        // and the message being read jumped out of view.
        const fromBottom = this.#scroller.scrollHeight - this.#scroller.scrollTop
        void this.#loadHistory(threadId).then(() => {
          if (this.#threadId !== threadId) return
          // The load ends with a FORCED follow-to-bottom (a thread switch
          // must land at the latest message), and its next-frame re-asserts
          // would carry the reader off again. This was not a switch: the
          // reader asked for older messages, so the follow is called off and
          // the anchor re-applied while the rebuilt entries settle.
          if (this.#scrollFrame !== null) {
            cancelAnimationFrame(this.#scrollFrame)
            this.#scrollFrame = null
          }
          this.#pinned = false
          const hold = (frames: number): void => {
            if (this.#threadId !== threadId) return
            this.#scroller.scrollTop = this.#scroller.scrollHeight - fromBottom
            if (frames > 0) requestAnimationFrame(() => hold(frames - 1))
          }
          hold(EARLIER_ANCHOR_FRAMES)
        })
        return
      }
      const anchor = wrap.nextElementSibling
      const previousHeight = this.#scroller.scrollHeight
      const fragment = document.createDocumentFragment()
      for (const element of this.#buildGroupedEntries(earlier)) {
        fragment.appendChild(element)
      }
      this.#feed.insertBefore(fragment, anchor)
      wrap.remove()
      // Keep the viewport anchored where the user was.
      this.#scroller.scrollTop += this.#scroller.scrollHeight - previousHeight
    })
    wrap.appendChild(button)
    return wrap
  }

  /**
   * Build the feed elements for a run of entries, folded TWICE.
   *
   * The outer fold is the turn (`planTurns`): a settled turn renders as the
   * agent's prose plus one row saying what it did. The inner fold is the
   * existing per-activity grouping, and it is untouched — expanding a turn
   * reveals exactly what the feed shows today, and expanding one of those
   * reveals today's cards. Nothing that existed was replaced.
   *
   * Entries that belong to NO turn (the user's messages, system rows, and tool
   * calls whose assistant message is outside this slice) pass through the
   * activity grouping exactly as before, in contiguous runs — buffering them
   * rather than emitting one at a time is what keeps a run of ungrouped tool
   * calls grouping the way it does today.
   *
   * `liveTail` says the caller is building the LIVE end of the feed; see
   * #buildTurnRow for why only that turn is born open (NFR-3).
   */
  #buildGroupedEntries(entries: HistoryEntry[], liveTail = false): HTMLElement[] {
    // Which of the two folds apply is the READER's choice, and it is decided
    // in exactly one place (`projectFeed`) so the three densities cannot drift
    // apart. `detailed` is the identity there, which is why this method has no
    // branch of its own for it: there is no code path here on which "Detailed"
    // can render less than everything (C-2 / FR-7).
    //
    // `running` is said, not inferred: only the live end of the feed can hold
    // a request that is still running, and a running request has no answer
    // yet — its messages are steps (plan_chat-cleanup FR-5).
    const units = projectFeed(this.#density, feedUnits(entries), FEED_CLASSIFIERS, {
      running: liveTail,
    })
    const out: HTMLElement[] = []
    // THE LIVE TURN IS THE LAST *TURN*, not the last unit.
    //
    // This asked `index === units.length - 1`, which is only the same thing
    // when nothing follows the running turn. Things do: a system row persisted
    // mid-turn (an artifact marker, an auto-attach note), or tool calls that
    // fell outside the fold. Then no unit matched, `live` was false for every
    // one of them, and a reader clicking into a working thread got a COLLAPSED
    // summary over a turn that was still executing — NFR-3 failing silently,
    // in the one state it exists to protect.
    let lastTurnIndex = -1
    units.forEach((unit, index) => {
      if (unit.level === 'turn') lastTurnIndex = index
    })
    units.forEach((unit, index) => {
      if (unit.level === 'turn') {
        // `Thought Ns` heads the turn, above the prose it preceded — the order
        // the work happened in, and the order the reference shows it. Only a
        // turn this pane WATCHED think has an entry, so a rebuilt history and a
        // turn that answered straight away both correctly render no row at all
        // (FR-5, Q-3: the elapsed time belongs here and nowhere else — a
        // duration on the turn row would compete with the counts, which are the
        // facts a reader decides on).
        const thought = this.#buildThoughtRow(unit.messageId, unit.head)
        if (thought !== null) out.push(thought)
        out.push(this.#buildHistoryEntry(unit.head))
        // A turn that only spoke gets no row. `turnSummaryLabel` would be empty,
        // and an empty row is the noise this plan exists to remove.
        if (unit.tools.length === 0) return
        out.push(this.#buildTurnRow(unit.messageId, unit.tools, liveTail && index === lastTurnIndex))
        return
      }
      if (unit.level === 'group') {
        out.push(this.#buildToolGroup(unit.key, unit.entries))
        return
      }
      // Below Compact there is no turn unit to head, so the thinking row hangs
      // off the assistant message itself. FR-5 is a fact about the turn, not a
      // property of the fold: a reader who chose to see more must not see LESS
      // of what the pane observed.
      if (unit.level === 'request') {
        out.push(...this.#buildRequest(unit.request, liveTail))
        return
      }
      const { entry } = unit
      if (entry.kind === 'message' && entry.message.role === 'assistant') {
        const thought = this.#buildThoughtRow(entry.message.id, entry)
        if (thought !== null) out.push(thought)
      }
      out.push(this.#buildHistoryEntry(entry))
    })
    return out
  }

  /**
   * One request in Compact (plan_chat-cleanup note 19): the person's message,
   * ONE work row for every step, the answer, then the request's system rows
   * (the doc cards) in their order.
   *
   * A request with no steps — a one-line answer — gets no row: an empty row is
   * the noise this plan removes. A request still running gets a live row even
   * before its first step, so the stream has a row to grow.
   */
  #buildRequest(request: Request<HistoryEntry>, liveTail: boolean): HTMLElement[] {
    const out: HTMLElement[] = []
    if (request.user !== null) {
      out.push(this.#buildHistoryEntry(request.user))
      // A message that went into a running turn says so (plan_mid-run-subtasks).
      if (request.sentWhileWorking) out.push(entryWrapper('midrun-note', sentWhileWorkingNote()))
    }
    const live = request.live && liveTail
    if (request.steps.length > 0 || live) out.push(this.#buildRequestRow(request, live))
    if (request.answer !== null) {
      // The turn that ended in this answer is the one `done` named, so its
      // `Thought Ns` sits right above it (FR-5 of the feed-signal plan).
      if (request.answer.kind === 'message') {
        const thought = this.#buildThoughtRow(request.answer.message.id, request.answer)
        if (thought !== null) out.push(thought)
      }
      out.push(this.#buildHistoryEntry(request.answer))
    }
    for (const entry of request.trailing) out.push(this.#buildHistoryEntry(entry))
    return out
  }

  /**
   * The work row over a request's steps. Each step's contents — its message,
   * then its tools grouped exactly as the feed groups them elsewhere — are
   * built only when the step opens; the cards it will hold are known now, so
   * the reconcile expand-restore can still reach them (#requestByCardId).
   *
   * A LIVE row (a thread opened mid-request, or a rebuild that raced a running
   * turn) becomes the pane's live request, so the stream keeps growing THIS
   * row rather than starting a second one under it. Its steps are built now:
   * live cards are appended into them.
   */
  #buildRequestRow(request: Request<HistoryEntry>, live: boolean): HTMLElement {
    const key = requestKey(request)
    const steps = request.steps
    const recordsOf = (tools: HistoryEntry[]): ToolCallRecord[] =>
      tools.flatMap((entry) => (entry.kind === 'tool' ? [entry.toolCall] : []))
    const inputs: RequestRowStepInput[] = steps.map((step) => ({
      text: step.head !== null && step.head.kind === 'message' ? step.head.message.content : null,
      records: recordsOf(step.tools),
    }))
    const summary = requestSummary(request, { classify: requestRoleFor })
    const row = new RequestRow(summary, inputs, live, {
      expanded: this.#expandedRequests.has(key),
      onToggle: (expanded) => {
        if (expanded) this.#expandedRequests.add(key)
        else this.#expandedRequests.delete(key)
      },
      buildStep: (index) => {
        const step = steps[index]
        if (step === undefined) return []
        const head = step.head === null ? [] : [this.#buildHistoryEntry(step.head)]
        return [...head, ...this.#buildActivityGroups(step.tools)]
      },
      isStepExpanded: (index) => {
        const step = steps[index]
        return step !== undefined && this.#expandedSteps.has(stepKeyOf(step))
      },
      onStepToggle: (index, expanded) => {
        const step = steps[index]
        if (step === undefined) return
        if (expanded) this.#expandedSteps.add(stepKeyOf(step))
        else this.#expandedSteps.delete(stepKeyOf(step))
      },
    })
    steps.forEach((step, index) => {
      for (const record of recordsOf(step.tools)) this.#requestByCardId.set(record.id, { row, step: index })
    })
    const wrapper = entryWrapper('request', row.element)
    const last = request.entries[request.entries.length - 1]
    if (last !== undefined) wrapper.dataset.at = last.at
    if (live) {
      steps.forEach((_, index) => row.stepDetail(index))
      const records = new Map<string, ToolCallRecord>()
      for (const input of inputs) for (const record of input.records) records.set(record.id, record)
      const userAt = request.user === null ? Number.NaN : Date.parse(request.user.at)
      this.#endLiveRequest()
      this.#liveRequest = {
        row,
        startedAt: Number.isNaN(userAt) ? null : userAt,
        records,
        steps: inputs.map((input) => ({
          text: input.text,
          stream: null,
          toolIds: input.records.map((record) => record.id),
        })),
        model: summary.model,
        active: true,
      }
      this.#startLiveRequestTimer()
    }
    return wrapper
  }

  /**
   * The inner fold, unchanged from before the turn row existed: collapse a
   * CONTIGUOUS run of the same tool on the same file into one group card
   * (#17). Single entries take the reuse path (`#buildHistoryEntry`); groups
   * always build fresh (they carry no `dataset.entryId`, so the reuse harvest
   * never touches them — same discipline as system rows).
   */
  #buildActivityGroups(entries: HistoryEntry[]): HTMLElement[] {
    const units = planToolGroups(entries, (entry) =>
      entry.kind === 'tool' ? toolCallGroupKey(entry.toolCall) : null,
    )
    const out: HTMLElement[] = []
    for (const unit of units) {
      out.push(unit.grouped ? this.#buildToolGroup(unit.key, unit.entries) : this.#buildHistoryEntry(unit.entry))
    }
    return out
  }

  /**
   * The `Thought Ns` row, or null when this turn has nothing to say about
   * thinking (FR-5).
   *
   * Quieter than the turn row beside it, which is already the quietest thing
   * in the feed: secondary text at caption size, no ground, no edge, no
   * chevron. It is a note in the margin about how the answer came to be, and
   * it must not compete with either the answer or the row that says what the
   * agent DID — the counts are what a reader decides on (Q-3).
   *
   * NO EXPANSION, deliberately. The thinking text never reaches this process:
   * the `thinking` event is a boolean edge (`{ active }`), and both
   * persistence halves drop it as ephemeral, so there is no captured text
   * anywhere for a chevron to open onto. An affordance that opens on nothing
   * is the empty `Thought 0s` this plan exists to remove, wearing a caret.
   * When thinking text is one day persisted, the detail hangs off this row and
   * the header grows the same caret the turn row and the group header share.
   */
  #buildThoughtRow(messageId: string, head: HistoryEntry): HTMLElement | null {
    const elapsed = this.#thoughtMs.get(messageId)
    if (elapsed === undefined) return null
    const label = thoughtLabel(elapsed)
    // Rounds to zero — a turn that thought for 300ms did not think, as far as
    // a reader is concerned, and `Thought 0s` is a fact nobody asked for.
    if (label === null) return null
    const row = document.createElement('div')
    row.className = 'fl-conv-thought'
    row.textContent = label
    const wrapper = entryWrapper('thought', row)
    // Stamped from the message it heads, like a group's or a turn's slot, so
    // the story card's timestamp-ordered placement (#placeStoryEntry) sees a
    // consistent feed rather than a hole.
    wrapper.dataset.at = head.at
    return wrapper
  }

  /**
   * Build one turn's summary row over the tool entries belonging to it.
   *
   * FOLD ON SETTLE, NEVER DURING (NFR-3). `live` is true only for the turn at
   * the live end of the feed while the pane is still busy — a thread opened
   * mid-turn, or a rebuild that raced a running turn. That turn renders OPEN,
   * so a reader watching an agent work sees exactly what they see today; when
   * the turn completes, `done` resets the activity state and the reconcile
   * that follows rebuilds it closed. That initial expansion is deliberately
   * NOT recorded in #expandedTurns — it is a fact about the turn's state, not
   * a choice the reader made, and recording it would keep every turn they ever
   * watched permanently open.
   *
   * Each inner ToolCard is registered in #toolCards by id (through
   * #buildActivityGroups) so live update, the #179 expand-restore and the
   * withheld-output load-on-open contract keep reaching it through BOTH folds.
   */
  #buildTurnRow(messageId: string, tools: HistoryEntry[], live: boolean): HTMLElement {
    const records = tools.map((entry) => (entry as { toolCall: ToolCallRecord }).toolCall)
    const children = this.#buildActivityGroups(tools)
    const row = new TurnRow(turnSummary(records), children, {
      expanded: live || this.#expandedTurns.has(messageId),
      onToggle: (expanded) => {
        if (expanded) this.#expandedTurns.add(messageId)
        else this.#expandedTurns.delete(messageId)
      },
    })
    for (const record of records) this.#turnByCardId.set(record.id, row)
    const wrapper = entryWrapper('turn', row.element)
    // Stamped like a group's slot so the story card's timestamp-ordered
    // placement (#placeStoryEntry) still sees it.
    wrapper.dataset.at = tools[tools.length - 1].at
    return wrapper
  }

  /** Build one tool group from >=2 contiguous entries sharing a group key (#17):
   *  either same-tool-same-file (an edit/write/notebookedit run) or the shared
   *  CONTEXT_GROUP_KEY (a run of read/grep/glob/websearch/webfetch calls, muted
   *  as routine noise regardless of what each one touched). Each inner ToolCard is
   *  registered in #toolCards by id so the pane's existing machinery (live
   *  update, expand-restore, withheld-output load) reaches it through the group.
   *  Group expansion is keyed by the first call's id and restored from
   *  #expandedGroups, which survives the feed wipe. */
  #buildToolGroup(key: string, entries: HistoryEntry[]): HTMLElement {
    const cards: ToolCard[] = []
    const records = entries.map((entry) => (entry as { toolCall: ToolCallRecord }).toolCall)
    for (const toolCall of records) {
      const card = new ToolCard(toolCall)
      this.#toolCards.set(toolCall.id, card)
      cards.push(card)
    }
    const first = records[0]
    const groupKey = first.id
    // Label AND icon come from one place (`groupPresentation`) rather than a
    // ternary repeated here and in the live-promotion path — a binary had room
    // for exactly two kinds of group, and a third silently rendered as
    // `Bash  · 3 changes`.
    const relabel = (live: readonly ToolCallRecord[]): string =>
      groupPresentation(key, live.length > 0 ? live : records).label
    const iconName = groupPresentation(key, records).icon
    const group = new ToolGroupCard(
      relabel,
      iconName,
      cards,
      (expanded) => {
        if (expanded) this.#expandedGroups.add(groupKey)
        else this.#expandedGroups.delete(groupKey)
      },
    )
    for (const record of records) this.#toolGroupByCardId.set(record.id, group)
    if (this.#expandedGroups.has(groupKey)) group.setExpanded(true)
    const wrapper = entryWrapper('tool', group.element)
    wrapper.dataset.groupKey = key
    this.#groupByWrapper.set(wrapper, group)
    // Stamp the group's slot with its newest entry's timestamp so the story
    // card's timestamp-ordered placement (#placeStoryEntry) still sees it — a
    // single entry gets this in #buildHistoryEntry, and a group must too or the
    // card mis-anchors around grouped runs.
    wrapper.dataset.at = entries[entries.length - 1].at
    return wrapper
  }

  /** Append a live tool card, folding it into the feed TAIL when it continues a
   *  run: growing an open group, or promoting the previous lone card into one.
   *  A message (or any non-tool entry) at the tail breaks the run, so nothing
   *  special is needed to reset between turns -- the DOM is the state. */
  #appendLiveToolCard(card: ToolCard, record: ToolCallRecord): void {
    // THE LIVE TURN FOLDS TOO. It used to render every row so a reader could
    // watch the agent work — and three reports in a row said the watching was
    // the noisy part ("still showing a lot of tools outside of the group";
    // "show only the thing that really matters"). So a running turn collapses
    // exactly like a finished one, and its row is what moves: the count climbs
    // as tools land, and `· N failed` appears the instant something does.
    //
    // Cards go INSIDE that row, which is why the grouping below works against a
    // container rather than the feed — a run of commands still folds to
    // `Ran 3 commands`, one level deeper.
    const turn = this.#liveTurnContainer(record)
    const container = turn ?? this.#feed
    const key = toolCallGroupKey(record)
    const tail = container.lastElementChild as HTMLElement | null
    if (key !== null && tail !== null && tail.dataset.groupKey === key) {
      const group = this.#groupByWrapper.get(tail)
      if (group !== undefined) {
        group.addCard(card)
        this.#toolGroupByCardId.set(record.id, group)
        return
      }
    }
    if (key !== null && tail !== null && tail.dataset.toolId !== undefined) {
      const prev = this.#toolCards.get(tail.dataset.toolId)
      if (prev !== undefined && toolCallGroupKey(prev.record) === key) {
        this.#promoteToLiveGroup(prev, card, key, tail)
        return
      }
    }
    const wrapper = entryWrapper('tool', card.element)
    wrapper.dataset.toolId = record.id
    container.appendChild(wrapper)
  }

  /**
   * The open turn's fold, creating it if this is the turn's first tool.
   *
   * A turn is one assistant block, so `message-start` closes the open one — the
   * same boundary `planTurns` uses when the history is rebuilt, which is what
   * keeps the live feed and the settled feed showing the same shape.
   *
   * Never null in practice — a tool call always belongs to some turn, and the
   * reconcile reshapes whatever this produced from the persisted history a
   * moment later. The return type stays nullable so the caller keeps its
   * feed-level fallback rather than growing a second code path.
   */
  #liveTurnContainer(record: ToolCallRecord): HTMLElement | null {
    // Compact: ONE live work row for every tool of the request, across all
    // its message blocks (plan_chat-cleanup note 21) — not a row per block.
    if (this.#density === 'compact') {
      // Only the running turn's work starts or grows the live row — a
      // background agent's tool after `done` goes to the feed instead.
      return liveWorkTarget(this.#density, this.#turnLive) === 'request-row' ? this.#liveRequestToolContainer(record) : null
    }
    const live = this.#liveTurn
    if (live !== null) {
      live.records.push(record)
      live.row.update(turnSummary(live.records))
      return live.row.detail
    }
    const row = new TurnRow(turnSummary([record]), [], {
      onToggle: (expanded) => {
        if (expanded) this.#expandedTurns.add(record.id)
        else this.#expandedTurns.delete(record.id)
      },
    })
    const wrapper = entryWrapper('turn', row.element)
    this.#feed.appendChild(wrapper)
    this.#liveTurn = { row, records: [record] }
    return row.detail
  }

  // ── Live work row (Compact) ──────────────────────────────────────────────

  /**
   * The live request's row, created at the feed's end on the request's first
   * tool or first spoken block. Its start time is the person's message above
   * it (a stored one carries its time; a fresh echo is "now").
   */
  #ensureLiveRequest(): LiveRequest {
    if (this.#liveRequest !== null) {
      this.#liveRequest.active = true
      return this.#liveRequest
    }
    const users = this.#feed.querySelectorAll<HTMLElement>(':scope > .fl-conv-entry-user')
    const lastUser = users.length > 0 ? users[users.length - 1] : null
    const userAt = lastUser?.dataset.at === undefined ? Number.NaN : Date.parse(lastUser.dataset.at)
    const startedAt = Number.isNaN(userAt) ? Date.now() : userAt
    const entryId = lastUser?.dataset.entryId
    const key = entryId !== undefined && entryId.startsWith('msg:') ? entryId.slice('msg:'.length) : null
    const summary = liveRequestSummary([], { startedAt, now: Date.now(), model: this.#currentModel })
    const row = new RequestRow(summary, [], true, {
      expanded: key !== null && this.#expandedRequests.has(key),
      onToggle: (expanded) => {
        if (key === null) return
        if (expanded) this.#expandedRequests.add(key)
        else this.#expandedRequests.delete(key)
      },
    })
    this.#feed.appendChild(entryWrapper('request', row.element))
    // A row appended mid-load belongs to a new turn — keep the reconcile from
    // wiping it (#101), exactly as for a stream node.
    if (this.#historyLoading) this.#liveDuringLoad = true
    this.#liveRequest = { row, startedAt, records: new Map(), steps: [], model: null, active: true }
    this.#startLiveRequestTimer()
    return this.#liveRequest
  }

  /** Where a live tool card goes: the newest step of the live row — a
   *  head-less one when no block has spoken yet. */
  #liveRequestToolContainer(record: ToolCallRecord): HTMLElement | null {
    const live = this.#ensureLiveRequest()
    this.#keepLiveRowBelowAnswers(live)
    if (live.steps.length === 0) live.steps.push({ text: null, stream: null, toolIds: [] })
    const index = live.steps.length - 1
    live.steps[index].toolIds.push(record.id)
    live.records.set(record.id, record)
    this.#updateLiveRequest()
    return live.row.stepDetail(index)
  }

  /**
   * A block spoke: it becomes the live row's newest step (plan_chat-cleanup
   * note 22). Its streaming text goes INSIDE the step, so the opened row can
   * show it whole; the row's second line shows its first line.
   */
  #addLiveRequestStep(stream: StreamingMarkdown, wrapper: HTMLElement): void {
    const live = this.#ensureLiveRequest()
    this.#keepLiveRowBelowAnswers(live)
    live.steps.push({ text: null, stream, toolIds: [] })
    this.#updateLiveRequest()
    live.row.stepDetail(live.steps.length - 1)?.appendChild(wrapper)
  }

  /**
   * WORK AFTER AN ANSWER GOES UNDER THE QUESTION (user, 2026-10-09: "if the
   * user replied already and then the agent starts working again, that
   * component should be on the bottom of the user question, because it is the
   * most recent").
   *
   * A question or permission card is appended at the feed's end when it
   * arrives, under the live row. Once it is answered and the agent works
   * again, the live row moves back to the end, so the newest thing on screen
   * is at the bottom. A card still waiting for its answer keeps the bottom: no
   * row moves past it.
   */
  #keepLiveRowBelowAnswers(live: LiveRequest): void {
    const wrapper = live.row.element.parentElement
    if (wrapper === null || wrapper.parentElement !== this.#feed) return
    const waiting = [
      ...[...this.#questionCards.values()].map((card) => card.element),
      ...[...this.#permissionCards.values()].map((card) => card.element),
      ...this.#conflictReviewCards.map((card) => card.element),
    ]
    let passedAnswer = false
    for (let next = wrapper.nextElementSibling; next !== null; next = next.nextElementSibling) {
      if (!next.classList.contains('fl-conv-entry-permission')) continue
      const card = next
      if (waiting.some((element) => card.contains(element))) return
      passedAnswer = true
    }
    if (passedAnswer) this.#feed.appendChild(wrapper)
  }

  /** Keep the live row's copy of a tool record current (a failure must show
   *  on the row the moment it lands). No-op for a record it does not hold. */
  #noteLiveRecord(record: ToolCallRecord): void {
    const live = this.#liveRequest
    if (live === null || !live.records.has(record.id)) return
    live.records.set(record.id, record)
    this.#updateLiveRequest()
  }

  /** Redraw the live row in place: counts, minutes, newest step (NFR-3 — the
   *  row diffs what it draws, so a text batch costs one line's write). */
  #updateLiveRequest(): void {
    const live = this.#liveRequest
    if (live === null) return
    const steps: RequestRowStepInput[] = live.steps.map((step) => ({
      text: step.stream !== null ? step.stream.source : step.text,
      records: step.toolIds.flatMap((id) => {
        const record = live.records.get(id)
        return record === undefined ? [] : [record]
      }),
    }))
    const summary = liveRequestSummary([...live.records.values()], {
      startedAt: live.startedAt,
      now: Date.now(),
      model: this.#currentModel ?? live.model,
    })
    live.row.update(summary, steps, live.active)
  }

  #startLiveRequestTimer(): void {
    if (this.#liveRequestTimer !== null) return
    this.#liveRequestTimer = window.setInterval(() => {
      // Pay only for what someone can see (allowed-pattern #17).
      if (document.hidden || this.#liveRequest === null || !this.#liveRequest.active) return
      this.#updateLiveRequest()
    }, LIVE_REQUEST_TICK_MS)
  }

  /** Forget the live request (its row stays in the feed until a rebuild). */
  #endLiveRequest(): void {
    this.#liveRequest = null
    if (this.#liveRequestTimer !== null) {
      window.clearInterval(this.#liveRequestTimer)
      this.#liveRequestTimer = null
    }
  }

  /** Fold the previous lone card and this new one into a fresh live group,
   *  replacing the lone wrapper at the feed tail with the group wrapper. */
  #promoteToLiveGroup(prev: ToolCard, card: ToolCard, key: string, tail: HTMLElement): void {
    // Same one decision as the history path — see `groupPresentation`.
    const relabel = (live: readonly ToolCallRecord[]): string =>
      groupPresentation(key, live.length > 0 ? live : [prev.record]).label
    const iconName = groupPresentation(key, [prev.record]).icon
    const groupKey = prev.record.id
    const group = new ToolGroupCard(relabel, iconName, [prev, card], (expanded) => {
      if (expanded) this.#expandedGroups.add(groupKey)
      else this.#expandedGroups.delete(groupKey)
    })
    this.#toolGroupByCardId.set(prev.record.id, group)
    this.#toolGroupByCardId.set(card.record.id, group)
    const wrapper = entryWrapper('tool', group.element)
    wrapper.dataset.groupKey = key
    if (tail.dataset.at !== undefined) wrapper.dataset.at = tail.dataset.at
    this.#groupByWrapper.set(wrapper, group)
    // Swap in the tail's OWN parent, not the feed: once a live turn folds, that
    // parent is the turn's detail. Replacing against the feed silently did
    // nothing there, so a run of commands inside a live turn never grouped.
    ;(tail.parentNode ?? this.#feed).replaceChild(wrapper, tail)
  }

  #buildHistoryEntry(entry: HistoryEntry): HTMLElement {
    const key = reuseKeyFor(entry, this.#density === 'detailed')
    if (key !== null) {
      const reused = this.#takeReusableEntry(key)
      if (reused !== null) {
        reused.dataset.at = entry.at
        return reused
      }
    }
    const element = this.#buildHistoryEntryElement(entry)
    // Stamped so anchored insertions (the story card) can find their feed
    // position by timestamp; ISO strings compare lexicographically.
    element.dataset.at = entry.at
    if (key !== null) {
      element.dataset.entryId = key.id
      element.dataset.reuseHash = key.hash
    }
    return element
  }

  /** Pop `key.id` from the reuse harvest when its stored hash still matches.
   *  A reused tool entry also re-registers its ToolCard instance (expansion
   *  restore and live updates key on #toolCards); a missing card vetoes reuse. */
  #takeReusableEntry(key: { id: string; hash: string }): HTMLElement | null {
    const element = this.#reuseElements?.get(key.id)
    if (element === undefined || element.dataset.reuseHash !== key.hash) return null
    if (key.id.startsWith('tool:')) {
      const toolCallId = key.id.slice('tool:'.length)
      const card = this.#reuseToolCards?.get(toolCallId)
      if (card === undefined) return null
      this.#toolCards.set(toolCallId, card)
    }
    this.#reuseElements?.delete(key.id)
    return element
  }

  #buildHistoryEntryElement(entry: HistoryEntry): HTMLElement {
    if (entry.kind === 'tool') {
      const card = new ToolCard(entry.toolCall)
      this.#toolCards.set(entry.toolCall.id, card)
      return entryWrapper('tool', card.element)
    }
    const { message } = entry
    if (message.role === 'user') {
      return entryWrapper('user', userBubble(message.content, message.attachments))
    }
    if (message.role === 'system') {
      // #1056: persisted artifact markers (main writes them when the watcher
      // first observes a doc in this thread) render as the SAME ArtifactCard
      // the live path shows — inline, at the position the doc was created.
      const marker = parseArtifactMarker(message.content)
      if (marker !== null) {
        return this.#markerEntry(marker, message)
      }
      // The folder this conversation works in was behind its remote branch when
      // it began (user, 2026-10-12). Main writes the row; the card reads the
      // LIVE comparison, so a folder somebody has since pulled reads as up to
      // date rather than repeating a count that has expired.
      const behind = parseFolderBehindMarker(message.content)
      if (behind !== null) {
        return entryWrapper('folder-behind', this.#folderBehindCard(behind.branch))
      }
      // #1048: persisted failure notes (main writes them at failure time so a
      // background failure survives any pane state) render as the same error
      // card the live stream path shows — not as a calm system note. A #981
      // "Interrupted by you" note is NOT a failure and stays a system line.
      if (isTurnFailureNote(message.content)) {
        return entryWrapper('error', this.#errorCard(message.content))
      }
      const note = document.createElement('div')
      note.className = 'fl-conv-system'
      note.textContent = message.content
      return entryWrapper('system', note)
    }
    return entryWrapper('assistant', this.#assistantContent(message))
  }

  /** Assistant message body + a small per-message model badge (#129), shown
   *  when the producing model was recorded (older messages have none) — and
   *  only in Detailed (plan_chat-cleanup note 20, FR-4). In Compact the work
   *  row names the model once per request; Balanced shows no model at all,
   *  which is the accepted cost of one model name per request rather than one
   *  under every message. */
  #assistantContent(message: ThreadMessage): HTMLElement {
    // #1919: a "Resolve with AI" reply is a fenced conflict-proposals JSON
    // payload — the human-in-the-loop review card (mounted from the resolve
    // flow) is its surface, not a raw JSON dump in the transcript. Render a
    // compact pointer instead; the message stays in stored history untouched.
    if (isConflictProposalReply(message.content)) {
      return this.#conflictProposalPlaceholder()
    }
    const body = renderMarkdown(message.content)
    if (!message.model || this.#density !== 'detailed') return body
    const wrap = document.createElement('div')
    wrap.className = 'fl-conv-assistant'
    const badge = document.createElement('span')
    badge.className = 'fl-conv-model-badge'
    badge.textContent = modelLabel(message.model)
    badge.title = message.model
    wrap.append(body, badge)
    return wrap
  }

  /** The compact stand-in shown in place of a raw conflict-proposals reply
   *  (#1919) — points the reader at the review card the resolve flow mounts. */
  #conflictProposalPlaceholder(): HTMLElement {
    const note = document.createElement('div')
    note.className = 'fl-conv-proposal-note'
    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', 'git-merge')
    icon.setAttribute('size', '14')
    const text = document.createElement('span')
    text.textContent = 'Conflict resolution proposed — review it in the card below.'
    note.append(icon, text)
    return note
  }

  // ── Live stream ──────────────────────────────────────────────────────────

  #onStream(event: AgentStreamEvent): void {
    if (event.threadId !== this.#threadId) {
      // #1048: a failure for a BACKGROUND thread must not vanish — remember it
      // so the thread's next history load can render the error card (belt to
      // the persisted-row braces main writes; deduped there). A new turn on
      // that thread supersedes the stale notice, mirroring the #turnError
      // reset on message-start below.
      if (event.kind === 'error') {
        this.#backgroundErrors.set(event.threadId, event.message)
      } else if (
        event.kind === 'message-start' ||
        (event.kind === 'status' && event.status === 'working')
      ) {
        this.#backgroundErrors.delete(event.threadId)
      }
      return
    }
    switch (event.kind) {
      case 'background-tasks':
        this.#applyBackgroundTasks(event.tasks)
        return
      case 'learning-first':
        this.#applyLearningFirst(event)
        return
      case 'worktree-setup':
        this.#worktreeSetup = event.state === 'running'
        this.#refreshActivity()
        // A FAILURE IS A CARD, NOT A LINE. The line comes down on this event
        // and on `#resetActivity` — NOT when the turn starts, which is what
        // this used to claim: `#refreshActivity` returns on `#worktreeSetup`
        // before it reads any turn state, so a turn cannot lower it
        // (forbidden-pattern #23). Something the person has to know about
        // their worktree must outlive the line either way.
        // It is still not history — nothing persists it —
        // so a reconcile simply will not carry it, which is correct: the next
        // cut is a different question.
        if (event.state === 'failed' && event.detail !== undefined) {
          this.#appendErrorCard(event.detail)
        }
        return
      case 'message-start': {
        // A new turn supersedes the previous turn's failure notice (#846).
        this.#turnError = null
        const stream = new StreamingMarkdown()
        this.#streams.set(event.messageId, stream)
        // HELD BACK UNTIL THERE IS TEXT, not appended now.
        //
        // The runtime opens a new assistant block for every tool round, so a
        // turn that runs three commands emits three `message-start`s — most of
        // them carrying no prose at all. Appending on start put an EMPTY,
        // invisible assistant wrapper between each pair of tool cards, and the
        // live fold reads the feed's last child to decide whether a run
        // continues: the run was broken by a node with nothing in it, so
        // consecutive commands never grouped while the turn was live. Reported
        // as "still seeing bash runs" on a turn that was mid-flight.
        //
        // The reconcile never showed this, because a text-less block is not
        // persisted — so the same turn folded correctly the moment it settled,
        // which is exactly why it looked like the fold was ignoring live turns.
        this.#pendingStreams.set(event.messageId, entryWrapper('assistant', stream.element))
        // Keep the loader up until real text arrives (an empty bubble is not
        // yet feedback) — the first delta flips `streaming` on.
        this.#busy = true
        this.#refreshActivity()
        this.#scrollToBottom()
        break
      }
      case 'message-delta': {
        let stream = this.#streams.get(event.messageId)
        if (!stream) {
          // Delta without a start (e.g. pane mounted mid-turn) — recover.
          stream = new StreamingMarkdown()
          this.#streams.set(event.messageId, stream)
          if (liveWorkTarget(this.#density, this.#turnLive) === 'request-row') {
            this.#addLiveRequestStep(stream, entryWrapper('assistant', stream.element))
          } else {
            this.#feed.appendChild(entryWrapper('assistant', stream.element))
          }
          if (this.#historyLoading) this.#liveDuringLoad = true
        }
        // First text for this block: NOW the wrapper earns its place in the feed.
        const pending = this.#pendingStreams.get(event.messageId)
        if (pending !== undefined) {
          this.#pendingStreams.delete(event.messageId)
          // Compact: the block's text becomes the live row's newest step, not
          // a new message in the feed (plan_chat-cleanup note 22). The full
          // text lives inside that step, one click away.
          if (liveWorkTarget(this.#density, this.#turnLive) === 'request-row') this.#addLiveRequestStep(stream, pending)
          else this.#feed.appendChild(pending)
          // A BLOCK THAT SPEAKS OPENS A NEW TURN — not every `message-start`.
          //
          // The runtime opens an assistant block for each tool round, so
          // closing the turn on `message-start` gave every single tool call a
          // turn of its own: three commands, three rows, no better than before.
          // The persisted side already draws the boundary here — a text-less
          // block never becomes `lastAssistantMessageId`, so its tools are
          // attributed to the last block that actually said something — and
          // matching it is what makes the live feed and the rebuilt feed show
          // the same turns.
          this.#liveTurn = null
          // A stream node appended mid-load belongs to a new turn — keep the
          // reconcile from wiping it (#101).
          if (this.#historyLoading) this.#liveDuringLoad = true
        }
        stream.append(event.text)
        // The live row's second line follows the newest text, in place.
        // Only while the turn runs: text after `done` (a background agent's)
        // must not wake the settled row into pulsing "Working" again.
        if (this.#liveRequest !== null && liveWorkTarget(this.#density, this.#turnLive) === 'request-row') {
          this.#liveRequest.active = true
          this.#updateLiveRequest()
        }
        // Visible text is now flowing — that IS the feedback, so drop the loader.
        this.#busy = true
        this.#streaming = true
        this.#thinkingActive = false
        // Prose is proof the thinking block ended, whether or not its closing
        // edge arrived. Without this, a runtime that skips `active: false`
        // would leave the span open across the whole turn and `done` would
        // seal "Thought 4m" onto a turn that thought for three seconds — a
        // number worse than no number.
        this.#closeThinkingSpan()
        this.#refreshActivity()
        this.#scrollToBottom()
        break
      }
      case 'text-stop': {
        // Text stopped flowing, so the thing that was standing in for the
        // loader is gone. The run is still live (`busy`), and what happens next
        // — a tool, more prose, the end of the turn — is not knowable here, so
        // the loader comes back rather than leaving the pane silent.
        //
        // DELAYED, not immediate: `done` lands right behind this stop at the end
        // of a turn, and an instant re-show would flash a spinner under every
        // finished answer. Anything that resolves the question sooner (a tool
        // starting, thinking, the turn ending) cancels the timer through
        // `#refreshActivity` / `#resetActivity`.
        this.#streaming = false
        this.#clearActivityResume()
        this.#activityResumeTimer = window.setTimeout(() => {
          this.#activityResumeTimer = null
          this.#refreshActivity()
        }, ACTIVITY_RESUME_DELAY_MS)
        break
      }
      case 'thinking': {
        this.#busy = this.#busy || event.active
        this.#thinkingActive = event.active
        if (event.active) {
          this.#streaming = false
          // Open a span, if one is not already open. The event is a bare edge
          // — no duration comes with it — so the pane times it itself or the
          // number does not exist (see #thoughtMs). "Thinking" is treated as a
          // LEVEL rather than a stack of spans: a repeated `active: true`
          // must not discard the start that is already being timed.
          this.#thinkingStartedAt ??= Date.now()
        } else {
          this.#closeThinkingSpan()
        }
        this.#refreshActivity()
        break
      }
      case 'tool-start': {
        const existing = this.#toolCards.get(event.toolCall.id)
        if (existing) {
          existing.update(event.toolCall)
          // If this card lives in a group (a thread reopened mid-turn), keep the
          // group's aggregate glyph in step with the inner card's new status.
          this.#toolGroupByCardId.get(event.toolCall.id)?.refreshStatus()
          this.#noteLiveRecord(event.toolCall)
        } else {
          const card = new ToolCard(event.toolCall)
          this.#toolCards.set(event.toolCall.id, card)
          this.#appendLiveToolCard(card, event.toolCall)
        }
        // THE LOADER STAYS UP WHILE A TURN IS FOLDED.
        //
        // This suppressed it on the grounds that "the tool card is its own
        // running indicator" — true while every card was on screen, and false
        // the moment the live turn started folding them away. Left as it was,
        // a folded turn showed a static row and a hidden loader: nothing in the
        // feed moved at all while the agent worked, which is worse than the
        // noise it replaced.
        //
        // The turn row does carry the running status, but a count that changes
        // every few seconds is not motion a person reads as "still going".
        this.#busy = true
        this.#toolRunning = this.#liveTurn === null && this.#liveRequest === null
        this.#streaming = false
        // A tool starting is the other proof that thinking ended; same reason
        // as `message-delta` above — the span must never outlive the block.
        this.#closeThinkingSpan()
        this.#refreshActivity()
        this.#scrollToBottom()
        break
      }
      case 'tool-end': {
        const card = this.#toolCards.get(event.toolCall.id)
        if (card) {
          card.update(event.toolCall)
          // A mid-turn group's header spinner must flip to the settled glyph
          // when its inner call ends, not wait for the end-of-turn reconcile.
          this.#toolGroupByCardId.get(event.toolCall.id)?.refreshStatus()
          // …and the live work row's counts, so `1 failed` shows at once.
          this.#noteLiveRecord(event.toolCall)
        } else {
          const late = new ToolCard(event.toolCall)
          this.#toolCards.set(event.toolCall.id, late)
          this.#feed.appendChild(entryWrapper('tool', late.element))
        }
        // Tool done — show the loader again until the next content arrives.
        this.#toolRunning = false
        this.#refreshActivity()
        break
      }
      case 'usage': {
        this.#usage.hidden = false
        const tokens = turnTokensLabel(
          event.inputTokens,
          event.cachedInputTokens,
          event.outputTokens,
        )
        // Append the turn's model (#129) so the transcript records what ran and
        // what it cost — the 'model' event (init) always precedes 'usage' (end).
        this.#usageText.textContent = this.#currentModel
          ? `${tokens} · ${modelLabel(this.#currentModel)}`
          : tokens
        // The end of a turn is the only moment the window's fullness changed,
        // and `detail: 'summary'` costs no API call — so it is asked for here
        // rather than polled (allowed-pattern #17: pay only for what someone
        // can see).
        void this.#refreshContextMeter(event.threadId)
        // A fresh turn's stats — the previous turn's savings segment no longer
        // applies. It re-shows if this turn's brain-savings event follows.
        this.#usageSavings.hidden = true
        break
      }
      case 'brain-savings': {
        // Post-turn estimate from main's BrainUsageTracker (only emitted when
        // positive — see ipc-contract). Render the stats-line segment and
        // refresh the cumulative chip: the tracker fires AFTER folding the
        // store, so the IPC recompute reads fresh burst samples.
        // #1280: an older main without the provenance fields reads as
        // calibrated — the pre-#1280 behaviour, never a silently blank segment.
        const label = turnSavedSegmentLabel(event.savedTokens, {
          calibrated: event.calibrated ?? true,
          hits: event.hits ?? 0,
        })
        if (label !== null) {
          this.#usageSavingsLabel.textContent = label
          this.#usageSavings.hidden = false
        }
        break
      }
      case 'model': {
        this.#currentModel = event.model
        // Forward the SDK-resolved model to the composer indicator (#129) —
        // decoupled, so the pane doesn't need a composer reference.
        document.dispatchEvent(
          new CustomEvent<{ threadId: string; model: string }>('flow:active-model', {
            detail: { threadId: event.threadId, model: event.model },
          }),
        )
        break
      }
      case 'status': {
        this.#applyTurnEdge({ kind: 'status', status: event.status })
        if (event.status === 'working') {
          this.#busy = true
        } else {
          this.#resetActivity()
          // The turn is over without a reconcile on this pane — run the one
          // refetch a busy-deferred foreign write asked for (#1931).
          this.#consumePendingForeignRefresh(event.threadId)
        }
        this.#refreshActivity()
        this.#handlers.onStatus?.(event.threadId, event.status)
        break
      }
      case 'error': {
        this.#resetActivity()
        this.#applyTurnEdge({ kind: 'error' })
        // Remember the failure: the imminent `done` reconcile wipes the feed
        // and rebuilds from persisted rows only, which erased this card and
        // left the transcript with no sign the turn failed (#846). #loadHistory
        // re-appends it after the rebuild.
        this.#turnError = { threadId: event.threadId, message: event.message }
        this.#appendErrorCard(event.message)
        // #1178: FORCED, like the permission and question cards ("a pending
        // permission is actionable and must never sit off-screen looking like a
        // stalled turn"). The plain call is a no-op whenever the reader has
        // scrolled up (#823 unpins auto-follow), so a turn that failed while
        // they were re-reading something earlier left the pane indistinguishable
        // from "still thinking" or "finished fine": the card sat ~2,500px below
        // the fold, the loader just vanished, and the composer flipped back to
        // Send exactly as it does on success. #846 and #1048 fixed the card's
        // PERSISTENCE; this is the third channel — it exists, it was just never
        // brought to the reader it belongs to.
        this.#scrollToBottom(true)
        break
      }
      case 'done': {
        // Seal the turn's thinking BEFORE #resetActivity, which clears the
        // live indicator state and would otherwise leave an open span dangling
        // on a turn that ended mid-thought (an interrupt, a crash). `done`
        // carries the last PERSISTED assistant message id, so this is the one
        // moment the pane can name the turn the reconcile is about to rebuild.
        this.#recordThought(event.messageId)
        this.#resetActivity()
        this.#applyTurnEdge({ kind: 'done' })
        const stream = this.#streams.get(event.messageId)
        stream?.finalize()
        // Correlation ids are bridge-generated; reconcile the transcript
        // against the persisted rows now that the turn is stored.
        void this.#reconcile(event.threadId)
        break
      }
    }
  }

  // ── Activity indicator ─────────────────────────────────────────────────────

  /** Show the loader whenever the turn is busy and nothing visible is already
   *  conveying progress (streaming assistant text or a running tool card). */
  /** Drop a pending post-text re-show. Idempotent. */
  #clearActivityResume(): void {
    if (this.#activityResumeTimer !== null) {
      window.clearTimeout(this.#activityResumeTimer)
      this.#activityResumeTimer = null
    }
  }

  #refreshActivity(): void {
    // Anything that reaches here has decided the pane's state definitively, so
    // a delayed re-show queued by `text-stop` is stale — a tool that started in
    // the meantime already carries its own running indicator.
    this.#clearActivityResume()
    // BEFORE EVERYTHING ELSE, because it happens before everything else: the
    // worktree is cut before the session spawns, so there is no turn to be
    // busy, nothing streaming and no tool running. Without this the line would
    // lose to `#busy` being false and the pane would sit blank exactly as it
    // always has.
    if (this.#worktreeSetup) {
      this.#activity.hidden = false
      // WHAT IS BEING SET UP, IN THE ONE NOUN LEFT. It said "this thread's
      // workspace", which named the directory Flow makes rather than the thing
      // a person chose — and that word left the product with the surfaces that
      // managed it (worktree-ui-removal Phase 5, task 5.6).
      this.#activityLabel.textContent = 'Setting up this conversation’s branch…'
      this.#scrollToBottom()
      return
    }
    // Before the turn, like the worktree: the message is stored and waits on
    // its project's basic discovery, so there is nothing busy to show yet.
    if (this.#learningFirstLine !== null) {
      this.#activity.hidden = false
      this.#activityLabel.textContent = this.#learningFirstLine
      this.#scrollToBottom()
      return
    }
    // A live work row already pulses and says `Working · N min` — a second
    // "Working…" under it would say the same thing twice (Compact only; the
    // background-agents line below still shows).
    const rowShowsWork = this.#liveRequest !== null && this.#liveRequest.active
    const show = this.#busy && !this.#streaming && !this.#toolRunning && !rowShowsWork
    // A RESTING TURN WITH WORK STILL OUT keeps the line, saying what is out.
    // The turn is over, so this does not scroll and does not pretend to be the
    // agent typing: it is a standing note that an answer is still coming.
    const waiting = !show && this.#backgroundTasks.length > 0
    this.#activity.hidden = !show && !waiting
    if (show) {
      this.#activityLabel.textContent = this.#thinkingActive ? 'Thinking…' : 'Working…'
      this.#scrollToBottom()
    } else if (waiting) {
      this.#activityLabel.textContent = backgroundActivityLabel(this.#backgroundTasks)
    }
  }

  /**
   * Take delivery of this thread's live background work.
   *
   * Filtered to the OPEN thread by the caller, like every other stream event
   * this pane reads — a background agent belonging to some other conversation
   * is that conversation's news, and its own row in the sidebar says so.
   */
  #applyBackgroundTasks(tasks: BackgroundTaskInfo[]): void {
    this.#backgroundTasks = tasks
    this.#refreshActivity()
  }

  /** Fold an open thinking block into this turn's total. Idempotent — a
   *  `thinking` edge that never closes (an interrupt) is closed by `done`. */
  #closeThinkingSpan(): void {
    if (this.#thinkingStartedAt === null) return
    this.#thinkingElapsedMs += Math.max(0, Date.now() - this.#thinkingStartedAt)
    this.#thinkingStartedAt = null
  }

  /**
   * Attribute the finished turn's thinking to the message the reconcile will
   * rebuild it around, and start the next turn from zero.
   *
   * A turn that never thought records NOTHING — not a zero. `Thought 0s` on
   * every answer is precisely the noise this plan exists to remove, and the
   * absence of a key is what makes "no thinking, no row" a property of the
   * data rather than a check the render path has to remember.
   */
  #recordThought(messageId: string): void {
    this.#closeThinkingSpan()
    const elapsed = this.#thinkingElapsedMs
    this.#thinkingElapsedMs = 0
    // An empty id is StreamBridge's "this turn persisted no assistant message"
    // fallback; there is no turn for the row to head.
    if (elapsed <= 0 || messageId === '') return
    this.#thoughtMs.set(messageId, elapsed)
  }

  /**
   * Move the turn's liveness by one turn edge (`turnLiveAfter`). Nothing is
   * mounted here: every turn's end is followed by `done`, whose reconcile
   * mounts a card held for the turn (`holdsNewArtifactCard`).
   */
  #applyTurnEdge(edge: TurnEdge): void {
    const before = this.#turnLive
    this.#turnLive = turnLiveAfter(before, edge)
    // A run started from a card follows the turn that carries its message —
    // only the turns of the thread it was sent into.
    if (this.#executing.size === 0) return
    const mine = (path: string): boolean => this.#executingThread.get(path) === this.#threadId
    const now = Date.now()
    const ended = (path: string, slug: string): CardRunEvent => ({ kind: 'turn-end', now, run: this.#runStateOf(path, slug) })
    if (edge.kind === 'thread-opened') {
      // Back in the run's thread: a resting thread means the turn that carried
      // the message (or would have) is over; a live one decides on its end.
      if (edge.status !== undefined && !this.#turnLive) this.#stepCardRuns(ended, mine)
      return
    }
    if (edge.kind === 'send' || (!before && this.#turnLive)) this.#stepCardRuns(() => ({ kind: 'turn-start' }), mine)
    else if (before && !this.#turnLive) this.#stepCardRuns(ended, mine)
  }

  #resetActivity(): void {
    // Reached on `done`, on errors and on teardown. It does NOT go through
    // `#refreshActivity`, so it has to drop the pending re-show itself —
    // otherwise a turn that ends within the delay window fires the timer onto a
    // finished turn and paints "Working…" under a completed answer.
    this.#clearActivityResume()
    this.#busy = false
    this.#thinkingActive = false
    this.#streaming = false
    this.#toolRunning = false
    // THE CUT'S LINE IS A TRANSIENT TOO, and it was the only one here that was
    // not cleared — so a setup whose terminal event never arrived outranked
    // every other state for the rest of the session, and followed the reader
    // into other conversations on switch (this method is the switch's reset).
    // Main now guarantees that edge; this is the belt to it, in the one place
    // that already answers "nothing is happening in this pane".
    this.#worktreeSetup = false
    // DISCARD AN OPEN THINKING SPAN, never carry it.
    //
    // The span is closed and attributed on `done` — but two paths end a turn
    // without one: an interrupt whose settling result never arrives (only
    // `status: 'idle'`), and `markThreadFailed` (`status: 'failed'` + `error`).
    // Both land here. Left open, the span outlives the turn and the NEXT
    // `done` seals its whole elapsed time onto the next turn's message:
    // interrupt a thought, come back forty minutes later, say "hi", and the
    // instant reply renders "Thought 40m".
    //
    // A lost measurement beats a wrong one — the same rule that keeps
    // `Thought 0s` off a sub-second turn.
    this.#thinkingStartedAt = null
    this.#thinkingElapsedMs = 0
    // The turn rests (done, a parked ask, an interrupt): the live row stops
    // pulsing. The next stream event wakes it; the reconcile replaces it.
    if (this.#liveRequest !== null && this.#liveRequest.active) {
      this.#liveRequest.active = false
      this.#updateLiveRequest()
    }
    // NOT `hidden = true` UNCONDITIONALLY. `done` arrives the moment a turn
    // that launched background agents ends, and blanking the line here is
    // precisely how the pane went quiet with four agents running.
    this.#refreshActivity()
  }

  /** Re-fetch persisted history after a turn completes. */
  async #reconcile(threadId: string): Promise<void> {
    // Preserve the reader's view-state across the full rebuild (#179): capture
    // scroll position / bottom-pin and which tool cards are expanded BEFORE the
    // feed is wiped, then restore them after — so a completed turn doesn't yank a
    // reader away from earlier messages or silently collapse cards they opened.
    const wasPinned = this.#pinned
    const prevScrollTop = this.#scroller.scrollTop
    const expandedToolIds = new Set<string>()
    for (const [id, card] of this.#toolCards) {
      if (card.expanded) expandedToolIds.add(id)
    }
    // #1088 (second casualty of the same wipe): the reader's selection over
    // already-persisted history. Select an answer to copy it, a turn lands, and
    // ⌘C copies nothing.
    const selection = captureFeedSelection(this.#feed)

    this.#clearLive()
    await this.#loadHistory(threadId)

    for (const id of expandedToolIds) {
      // A card inside a work row is built only when its step opens, so the
      // step is opened (and built) first — then the card exists to expand.
      const owner = this.#requestByCardId.get(id)
      if (owner !== undefined) owner.row.revealStep(owner.step)
      this.#toolCards.get(id)?.setExpanded(true)
      // If that card settled into a collapsed group, open the group too — else
      // the restored card sits inside a hidden detail and the reader's #179
      // expansion is silently lost behind the new group header.
      this.#toolGroupByCardId.get(id)?.setExpanded(true)
      // …and the turn around it, which on settle is the OUTER thing hiding it.
      // Opening only the group would leave the restored card inside a closed
      // turn row: the #179 loss, one fold further out.
      this.#turnByCardId.get(id)?.reveal()
    }
    restoreFeedSelection(this.#feed, selection)
    const maxScrollTop = this.#scroller.scrollHeight - this.#scroller.clientHeight
    this.#scroller.scrollTop = reconcileScrollTop(wasPinned, prevScrollTop, maxScrollTop)
    if (wasPinned) {
      // #939 ("chat panel scrolls up by itself"): `scrollHeight` read the
      // instant the feed is rebuilt is an UNDER-estimate — every freshly built
      // entry still stands at its 96px `contain-intrinsic-size` placeholder,
      // and the turn's own answer is always freshly built and usually far
      // taller. Landing on that stale max parks the reader hundreds of px above
      // the true bottom, which reads as the transcript scrolling itself back up
      // to around where they sent the message. Re-assert through the shared
      // follow-scroll, which keeps writing the bottom for a few frames while
      // the placeholders resolve into real heights (the #651 idiom).
      this.#scrollToBottom(true)
    }
  }

  #onPermissionRequest(request: PermissionRequest): void {
    // #949: route through the never-drop queue (the questions' discipline) — an
    // ask for a thread we're not showing, or one arriving while history loads,
    // buffers instead of vanishing. The broker keeps the tool call parked until
    // a verdict arrives, so a dropped card meant a permanently hung turn.
    const toRender = this.#permissionQueue.incoming(request, {
      activeThreadId: this.#threadId,
      loading: this.#historyLoading,
    })
    if (toRender) this.#renderPermissionCard(toRender)
  }

  #renderPermissionCard(request: PermissionRequest): void {
    if (this.#permissionCards.has(request.requestId)) return
    const card = new PermissionCard(request, async (requestId, verdict) => {
      await window.flow.threads.respondPermission({ requestId, verdict })
      // A feed rebuilt while the verdict was in flight (`#clearLive` re-buffers
      // every rendered ask) shows this ask as a NEW card with live buttons.
      // That card is the one on screen, so it carries the answer.
      const shown = this.#permissionCards.get(requestId)
      if (shown !== undefined && shown !== card) shown.markResolved(verdict)
      this.#permissionCards.delete(requestId)
      // Answered — stop the queue from re-buffering/re-rendering this ask.
      this.#permissionQueue.resolve(requestId)
    })
    this.#permissionCards.set(request.requestId, card)
    this.#feed.appendChild(entryWrapper('permission', card.element))
    // Force into view even if the user scrolled up — a pending permission is
    // actionable and must never sit off-screen looking like a stalled turn.
    this.#scrollToBottom(true)
  }

  /** Render any permission asks that arrived for `threadId` while it was
   *  inactive or loading, then re-sync against the broker's parked state (#949)
   *  — main keeps the promise parked across renderer reloads, so the pane must
   *  be able to REBUILD a card it never witnessed live. Deduped by requestId
   *  (the queue drops anything already rendered or buffered). */
  #flushPendingPermissions(threadId: string): void {
    for (const request of this.#permissionQueue.flush(threadId)) {
      this.#renderPermissionCard(request)
    }
    void this.#syncBrokerPermissions(threadId)
  }

  /** Fetch the broker's still-parked asks for `threadId` and render any the
   *  pane doesn't already show. Fail-soft — a fetch error just means the live
   *  event path is the only source (exactly the pre-#949 behavior). */
  async #syncBrokerPermissions(threadId: string): Promise<void> {
    let parked: PermissionRequest[]
    try {
      parked = await window.flow.threads.pendingPermissions({ threadId })
    } catch (error) {
      console.warn('flow: failed to fetch pending permission asks', { threadId, error })
      return
    }
    if (this.#threadId !== threadId || this.#historyLoading) return
    for (const request of parked) {
      const toRender = this.#permissionQueue.incoming(request, {
        activeThreadId: this.#threadId,
        loading: false,
      })
      if (toRender) this.#renderPermissionCard(toRender)
    }
  }

  // ── Blueprint story card ───────────────────────────────────────────────────

  /** Re-read a root's compiled story and apply it, fail-soft (a read error keeps
   *  the current card rather than flashing it away). `story` undefined → clear. */
  /**
   * Read the active project's compiled story and render it (only) into its
   * owning thread. `claim` binds the story to the current thread on an
   * INTENTIONAL surfacing — `'live'` (a narrate just changed the story: claim,
   * transferring on a re-narrate) or `'adopt'` (the user opened the blueprint:
   * claim only when the story is still orphaned). Auto-reads (project bind /
   * thread switch / relaunch) pass no `claim`, so they never attach a story to
   * an unrelated thread.
   */
  async #readStory(rootId: string, opts: { claim?: 'live' | 'adopt' } = {}): Promise<void> {
    let story: BlueprintStory | undefined
    try {
      // ONE FIELD, ONE FILE. The full read touches ten files in main and ships
      // the graph — 1.1 MB on this repository — to be dropped on arrival here.
      // Optional on the bridge, so an older preload still answers.
      const api = window.flow.blueprint
      story =
        api.readStory !== undefined
          ? (await api.readStory({ rootId })).story
          : (await api.read({ rootId })).story
    } catch (error) {
      console.warn('flow: failed to read blueprint story', { rootId, error })
      return
    }
    // A change may have landed for a project that is no longer active.
    if (rootId !== this.#activeRoot) return
    if (opts.claim && story && this.#threadId) {
      const owner = this.#storyOwnership.ownerOf(rootId, story.plan)
      const previousIdentity = this.#currentStory ? storyIdentity(this.#currentStory) : null
      // 'live': claim only from a real story change (a plain derive leaves the
      // identity unchanged → no steal). 'adopt': claim only an orphaned story.
      const shouldClaim =
        opts.claim === 'live' ? storyIdentity(story) !== previousIdentity : owner === undefined
      // The claim moment IS the plan-creation moment — anchor the card there so
      // it stays at that feed position instead of chasing the feed end.
      if (shouldClaim && this.#storyOwnership.claim(rootId, story.plan, this.#threadId, new Date().toISOString())) {
        saveStoryOwnership(this.#storyOwnership.toJSON())
      }
    }
    this.#applyStory(story ?? null)
  }

  /** Record the active project's story and (re)render it into the feed. */
  #applyStory(story: BlueprintStory | null): void {
    this.#currentStory = story
    // A compiled story change (e.g. a successful narrate) flips the story status
    // of any artifact card whose feature now matches — re-derive from the stored
    // sources so the card reflects it without re-reading the doc. This runs
    // BEFORE the story renders: the card that will host the story has to exist
    // and carry its new feature before #placeStory looks for a host.
    for (const kind of this.#artifactSources.keys()) this.#rebuildArtifactModel(kind)
    this.#renderStoryCard()
  }

  /** Insert / update / remove the single story card at the feed end. Buffered
   *  (no-op) until a thread is active and its history has finished loading —
   *  #loadHistory calls this again once the feed is settled. */
  #renderStoryCard(): void {
    if (!this.#currentStory) {
      this.#removeStoryCard()
      return
    }
    if (!this.#threadId || this.#historyLoading) return
    const story = this.#currentStory
    // The story renders ONLY in the thread that owns it — never in an unrelated
    // or brand-new thread. An unclaimed story (legacy / not yet narrated in this
    // session) owns no thread, so it renders nowhere until its authoring thread
    // re-claims it on the next narrate.
    const owner = this.#storyOwnership.ownerOf(this.#activeRoot, story.plan)
    if (!shouldRenderStory(owner, this.#threadId)) {
      this.#removeStoryCard()
      return
    }
    const identity = storyIdentity(story)
    this.#currentStoryIdentity = identity
    // Decide expand BEFORE building the card: a fresh card's constructor emit
    // records minimized=false, which would otherwise clobber a remembered
    // minimize choice for this same (thread, story) before we could read it.
    const expand = this.#storyMinimizeMemory.resolveAutoExpand(this.#threadId, identity)
    if (this.#storyCard) {
      this.#storyCard.setStory(story)
    } else {
      this.#storyCard = new StoryCard({
        story,
        onStepChange: (step) => this.#onStoryStep(step),
        onAttach: (ref) => this.#onStoryAttach(ref),
      })
    }
    this.#placeStory(story)
    // Auto-expand a NEW story identity; a known one honors the user's last choice.
    this.#storyCard.setMinimized(!expand)
  }

  /**
   * Put the story card where it belongs: INSIDE its doc's artifact card when
   * one is present in this feed, else standing alone at its anchored feed
   * position (user call 2026-08-11 — "we don't need two"; the story is a
   * property of the discovery/plan doc, not a sibling of it).
   *
   * Idempotent, because the pane re-runs this on every reconcile: a card object
   * survives turn reconciles while its element is detached by the feed wipe, so
   * "already where it should be" and "needs re-attaching" both land here.
   */
  #placeStory(story: BlueprintStory): void {
    const card = this.#storyCard
    if (!card) return
    const host = this.#storyHostFor(story)
    if (host !== null) {
      if (this.#storyHost !== null && this.#storyHost !== host) this.#storyHost.mountStory(null)
      this.#storyHost = host
      // A hosted story owns no feed entry — drop the standalone wrapper, or the
      // card would render twice after a doc card appears late.
      this.#storyEntry?.remove()
      this.#storyEntry = null
      host.mountStory(card.element)
      return
    }
    this.#releaseStoryHost()
    // Its doc's card is being held until the turn ends (`holdsNewArtifactCard`);
    // a standalone story now would be the half the reader should not see.
    if (this.#turnLive) return
    if (!this.#storyEntry || !this.#storyEntry.isConnected) {
      this.#storyEntry = entryWrapper('story', card.element)
      this.#placeStoryEntry(this.#storyEntry, story.plan)
    }
  }

  /**
   * The artifact card that owns `plan`, or null when none is mounted. The match
   * is the model's derived feature — the same derivation `narrate` compares
   * story.json's plan against, so the two can never drift apart. When several
   * cards share a feature (every version of a discovery has its own), the one
   * holding the story's source document wins, else the NEWEST — an older
   * version's card never hosts the story (see `storyHostIndex`).
   */
  #storyHostFor(story: BlueprintStory): ArtifactCard | null {
    // A detached card is not a host, so the mounted set is filtered first and
    // the CHOICE is made by the pure, tested rule (storyHostIndex).
    const mounted = [...this.#markerCards.values(), ...this.#artifactCards.values()].filter(
      (card) => card.element.isConnected,
    )
    const index = storyHostIndex(
      mounted.map((card) => ({
        feature: card.model.feature,
        mtime: card.model.mtime,
        paths: card.docs.map((doc) => doc.path),
      })),
      story,
      // Every doc this thread has a card or marker for, mounted or collapsed:
      // a source collapsed behind "Show earlier" keeps the story standalone
      // instead of letting another version's card host it.
      [...this.#markerPaths, ...this.#foldedPaths.keys(), ...[...this.#artifactCards.values()].map((card) => card.model.path)],
    )
    return index === -1 ? null : (mounted[index] ?? null)
  }

  /** Unmount the story from whatever card is hosting it. */
  #releaseStoryHost(): void {
    this.#storyHost?.mountStory(null)
    this.#storyHost = null
  }

  /**
   * Insert the story entry at the feed position where the plan was created
   * (user request 2026-07-22: the card must NOT re-append at the feed end on
   * every turn — it lives inline where it was generated). Position = before
   * the first stamped entry newer than the story's anchor; a story newer than
   * all history lands at the end, which at claim time is exactly "where it was
   * created". Legacy records without an anchor are backfilled to the current
   * last entry — pinning them from now on instead of chasing the bottom.
   */
  #placeStoryEntry(entry: HTMLElement, plan: string): void {
    let anchorAt = this.#storyOwnership.anchorOf(this.#activeRoot, plan)
    if (anchorAt === undefined) {
      const stamped = this.#feed.querySelectorAll<HTMLElement>(':scope > [data-at]')
      anchorAt = stamped[stamped.length - 1]?.dataset.at ?? new Date().toISOString()
      if (this.#activeRoot && this.#storyOwnership.setAnchor(this.#activeRoot, plan, anchorAt)) {
        saveStoryOwnership(this.#storyOwnership.toJSON())
      }
    }
    for (const child of this.#feed.children) {
      const at = (child as HTMLElement).dataset?.at
      if (at !== undefined && at > anchorAt) {
        this.#feed.insertBefore(entry, child)
        return
      }
    }
    this.#feed.appendChild(entry)
  }

  #removeStoryCard(): void {
    this.#releaseStoryHost()
    this.#storyEntry?.remove()
    this.#storyEntry = null
    this.#storyCard = null
    this.#currentStoryIdentity = null
  }

  /** The card reports its active step (null on minimize) — persist the minimize
   *  choice so the card re-mounts the same way on thread return / reconcile,
   *  and remember the step itself so an anchor-attach click (Phase 5) knows
   *  which step to reference. */
  #onStoryStep(step: BlueprintStoryStep | null): void {
    this.#activeStoryStep = step
    if (!this.#threadId || !this.#currentStoryIdentity) return
    this.#storyMinimizeMemory.setMinimized(this.#threadId, this.#currentStoryIdentity, step === null)
  }

  /** An anchor chip was clicked in the story card (Phase 5) — attach the
   *  ACTIVE STEP as a composer chip via the existing Board→Chat bridge, using
   *  the story-chip payload (composer-chips.ts's `[blueprint story: …]`
   *  contract, #486) rather than a plain node chip: an individual anchor ref
   *  ("manager.ts") isn't itself a resolvable/attachable graph reference, but
   *  the step it belongs to always is. `ref` (the clicked anchor) is not
   *  serialized — the story-chip contract carries only plan/stepId/title —
   *  so it only needs to exist for the click to have fired at all. */
  #onStoryAttach(_ref: StoryAttachRef): void {
    const story = this.#currentStory
    const step = this.#activeStoryStep
    if (!story || !step) return
    document.dispatchEvent(
      new CustomEvent('flow:blueprint-selected', {
        detail: {
          nodeId: `story:${story.plan}/${step.id}`,
          label: step.title,
          kind: 'story',
          story: { plan: story.plan, stepId: step.id, title: step.title },
        },
      }),
    )
  }

  // ── Flow artifact cards (blueprint-interaction Phase 2) ────────────────────

  /** A flow/ artifact changed for the active project — fetch it fail-soft and
   *  (re)derive its card. Ignores events for other projects and stale (older)
   *  events for a kind already shown. */
  /**
   * Seed artifact cards from the root's EXISTING docs (mount / relaunch path).
   * The watcher is `ignoreInitial`, so a doc that isn't edited after startup
   * never arrives as a live event — without this, cards vanish on every reload
   * and only reappear when a doc is next touched. Each existing doc is fed
   * through the same path a live change takes. Fail-soft: no API / error / a
   * project switch mid-flight just yields no seed.
   */
  async #seedArtifacts(rootId: string): Promise<void> {
    // `api` is a per-method local (window.flow) elsewhere in this class; in this
    // method use window.flow directly — referencing `api` here throws
    // ReferenceError on every project activation.
    if (!window.flow?.flow?.listArtifacts) return
    let result
    try {
      result = await window.flow.flow.listArtifacts({ rootId })
    } catch {
      return
    }
    if (rootId !== this.#activeRoot) return
    for (const event of result.artifacts) {
      // mtime-guarded inside #onArtifactChanged — a live event that already
      // landed for a newer version wins, so seeding never clobbers fresh state.
      await this.#onArtifactChanged(event, true)
    }
  }

  /**
   * Whether this pane shows a doc event: the active project's docs, as always,
   * plus a doc main attributed to THIS thread in another project — one the
   * agent wrote into a project attached to the conversation (live 2026-10-09:
   * a discovery written into a sibling project never showed a card).
   */
  #showsArtifactEvent(event: FlowArtifactChangedEvent): boolean {
    if (event.rootId === this.#activeRoot) return true
    return event.threadId !== undefined && event.threadId === this.#threadId
  }

  async #onArtifactChanged(event: FlowArtifactChangedEvent, seededListing = false): Promise<void> {
    if (!this.#showsArtifactEvent(event)) return
    this.#noteWalkthrough(event)
    const prior = this.#artifactSources.get(event.kind)
    if (prior && prior.event.mtime > event.mtime) return // an older event lost the race
    // A doc the watch only RE-LISTED is history, like the startup seed — it
    // never pins a feed-end card in whatever thread happens to be open.
    const seeded =
      seededListing ||
      artifactEventIsHistorical({
        replayed: event.replayed === true,
        eventThreadId: event.threadId ?? null,
        threadId: this.#threadId,
        priorLive: prior !== undefined && !prior.seeded && prior.event.path === event.path,
      })
    // Fetch the doc — a read failure degrades to a name-only card (null text).
    let docText: string | null = null
    try {
      const file = await window.flow.project.readFile({
        rootPath: event.rootId,
        relPath: event.path,
        missingOk: true,
      })
      docText = file.binary || file.tooLarge ? null : file.content
    } catch (error) {
      console.warn('flow: failed to read artifact doc', { path: event.path, error })
    }
    // The active project / thread (or a newer event) may have landed during the await.
    if (!this.#showsArtifactEvent(event)) return
    const current = this.#artifactSources.get(event.kind)
    if (current && current.event.mtime > event.mtime) return
    // The thread whose agent WROTE the doc owns the card — main names it on
    // the event, and nothing else can (#658). Not the thread on screen: two
    // threads with one project open would both show it (live 2026-10-23). An
    // event naming no thread has no owner and shows nowhere.
    this.#artifactSources.set(event.kind, { event, docText, owner: event.threadId ?? null, seeded })
    // A live plan event names the plan's own project (a seeded one only ever
    // lists the active project's, and never overrides what a marker said).
    if (event.kind === 'plan' && !seeded) this.#planRoots.set(event.path, event.rootId)
    this.#rebuildArtifactModel(event.kind)
    // THAT plan file changed (a note accepted, a plan revised): its counts are
    // read again — and only its own (allowed-pattern #17), in its own project.
    if (event.kind === 'plan' && !seeded) this.#onPlanFileChanged(event.path)
  }

  /** Rebuild a kind's derived model from its stored source + the active story,
   *  then render it. No-op when the source is gone (project cleared). */
  #rebuildArtifactModel(kind: FlowArtifactKind): void {
    const source = this.#artifactSources.get(kind)
    if (!source) return
    const model = buildArtifactModel(source.event, source.docText, this.#currentStory ?? undefined)
    this.#artifactModels.set(kind, model)
    this.#renderArtifactCard(kind)
  }

  /**
   * Build the inline feed entry for a persisted artifact-marker row (#1056):
   * the SAME ArtifactCard the live watcher path shows, at the marker's own
   * transcript position. Built synchronously from the best model at hand (the
   * live session source when its path matches, else a provisional name-only
   * model stamped with the row's time), then hydrated from the doc fail-soft.
   */
  /**
   * Stop every folder-behind card painting, because its element is going away.
   *
   * Each card has a `git:status` read in flight; one that lands after its
   * element is detached would paint into an orphan, and the next feed builds
   * fresh cards from the same rows anyway.
   */
  #clearFolderBehindCards(): void {
    for (const card of this.#folderBehindCards) card.dispose()
    this.#folderBehindCards.clear()
  }

  /**
   * The folder-behind notice for one marker row.
   *
   * THE READ AND THE ACTION ARE THE APP'S EXISTING ONES. `git:status` is the
   * coalesced scan the git panel already runs, and `git:pull` already reports
   * what arrived — so this card adds no git and cannot disagree with the panel
   * sitting beside it (allowed-pattern #14). A pane with no active project
   * cannot read either, and the card then says only what the row knows.
   */
  #folderBehindCard(branch: string): HTMLElement {
    const rootId = this.#activeRoot
    const card = new FolderBehindCard(branch, {
      readStatus: async () => {
        if (rootId === null || rootId === '') return null
        const status = await window.flow.git.status({ rootId })
        if (status === null || status.detached === true || status.branch === '') return null
        return {
          branch: status.branch,
          ahead: status.ahead,
          behind: status.behind,
          dirtyFiles: status.changes.length,
        }
      },
      pull: async () => {
        if (rootId === null || rootId === '') throw new Error('No project is open.')
        return window.flow.git.pull({ rootId })
      },
      openChanges: () => document.dispatchEvent(new CustomEvent('flow:show-git')),
    })
    this.#folderBehindCards.add(card)
    return card.element
  }

  #markerEntry(marker: ArtifactMarker, message: ThreadMessage): HTMLElement {
    // A marker names its root only for a doc in a project attached to the
    // thread; every other marker is the active project's.
    const docRoot = marker.root ?? this.#activeRoot ?? ''
    if (marker.kind === 'plan' && docRoot !== '') this.#planRoots.set(marker.path, docRoot)
    const source = this.#artifactSources.get(marker.kind)
    const live = source !== undefined && source.event.path === marker.path && source.event.rootId === docRoot ? source : null
    const event: FlowArtifactChangedEvent = live !== null
      ? live.event
      : {
          rootId: docRoot,
          kind: marker.kind,
          path: marker.path,
          name: marker.path.split('/').pop() ?? marker.path,
          mtime: Date.parse(message.createdAt) || Date.now(),
        }
    const model = buildArtifactModel(this.#withWalkthrough(event), live?.docText ?? null, this.#currentStory ?? undefined)
    // ONE CARD PER VERSION, with one fold: a plan joins the card of the
    // discovery it was written from (`artifactCardHosts`) and leaves an empty
    // placeholder at its own position. That card precedes the plan in the
    // transcript; when it is still collapsed behind "Show earlier" the plan
    // shows a card of its own rather than vanishing.
    const hostPath = this.#markerHosts.get(marker.path) ?? marker.path
    const host = hostPath === marker.path ? undefined : this.#markerCards.get(hostPath)
    if (host !== undefined) {
      host.foldDoc(model)
      this.#foldedPaths.set(marker.path, host)
      this.#markerPaths.add(marker.path)
      const placeholder = document.createElement('div')
      placeholder.hidden = true
      return placeholder
    }
    const card = new ArtifactCard(model, this.#cardCallbacks(marker.kind, event.rootId))
    this.#markerCards.set(marker.path, card)
    this.#markerPaths.add(marker.path)
    if (live === null) void this.#hydrateMarkerCard(marker, card, event)
    return entryWrapper('artifact', card.element)
  }

  /** Read the marker card's doc and upgrade the provisional model in place
   *  (real title / feature / story status). A vanished or unreadable doc keeps
   *  the name-only card — the marker still records that the doc existed. */
  async #hydrateMarkerCard(
    marker: ArtifactMarker,
    card: ArtifactCard,
    event: FlowArtifactChangedEvent,
  ): Promise<void> {
    const rootId = marker.root ?? this.#activeRoot
    if (rootId === null) return
    let docText: string | null
    try {
      const file = await window.flow.project.readFile({ rootPath: rootId, relPath: marker.path, missingOk: true })
      if (file.missing === true) return // a vanished doc keeps the name-only card
      docText = file.binary || file.tooLarge ? null : file.content
    } catch {
      return
    }
    // The feed may have been rebuilt (thread switch / reconcile) mid-read —
    // only the card still registered for this path may be updated.
    if (this.#markerCards.get(marker.path) !== card) return
    const model = buildArtifactModel(this.#withWalkthrough({ ...event, rootId }), docText, this.#currentStory ?? undefined)
    card.setModel(model)
  }

  /** Insert / update the single artifact card for `kind` at the feed end.
   *  Buffered (no-op) until a thread is active and history has settled —
   *  #loadHistory calls #renderKnownArtifacts once the feed is ready. */
  #renderArtifactCard(kind: FlowArtifactKind): void {
    const model = this.#artifactModels.get(kind)
    if (!model) return
    if (!this.#threadId || this.#historyLoading) return
    // #1056: a doc pinned inline by a marker row in this thread is updated IN
    // PLACE wherever it sits — never re-added as a feed-end card. A marker
    // still collapsed behind "Show earlier" has no card yet; the doc is
    // suppressed here too so expanding never reveals a duplicate.
    const markerCard = this.#markerCards.get(model.path)
    if (markerCard !== undefined) {
      markerCard.setModel(model)
      return
    }
    const foldedInto = this.#foldedPaths.get(model.path)
    if (foldedInto !== undefined) {
      foldedInto.foldDoc(model)
      return
    }
    if (this.#markerPaths.has(model.path)) return
    const source = this.#artifactSources.get(kind)
    // Historical docs (startup seed, no live change this session) never pin a
    // feed-end card — a days-old brainstorm at the bottom of every reopen was
    // exactly the #1056 complaint. Their content still hydrates inline marker
    // cards above; a LIVE change this session clears the flag and renders.
    if (source?.seeded) {
      this.#removeArtifactCard(kind)
      return
    }
    // Ownership gate (#658): render only in the thread that observed the doc
    // change — never carry another thread's card across a chat switch. An
    // unowned card (event arrived with no thread active) is adopted by the
    // first thread to render it.
    if (artifactRenderDecision(source?.owner ?? null, this.#threadId) === 'skip') {
      this.#removeArtifactCard(kind)
      return
    }
    // ONE CARD PER VERSION — the same rule as the marker path: only a plan
    // folds, into the most recent discovery card of its feature already in the
    // feed (`foldHostIndex`). Any card this kind had of its own is dropped, or
    // the plan would show twice.
    const existing = this.#artifactCards.get(kind)
    const host = this.#liveFoldHost(model, existing)
    if (host !== null) {
      host.foldDoc(model)
      this.#foldedPaths.set(model.path, host)
      this.#removeArtifactCard(kind)
      this.#renderStoryCard()
      return
    }
    if (existing && existing.model.path === model.path) {
      existing.setModel(model)
      let entry = this.#artifactEntries.get(kind)
      if (!entry || !entry.isConnected) {
        entry = entryWrapper('artifact', existing.element)
        this.#artifactEntries.set(kind, entry)
        this.#feed.appendChild(entry)
      }
      return
    }
    // The FIRST appearance of a card waits for the turn to end, so the reader
    // sees it once, whole — never a small card that grows when its story lands
    // (`holdsNewArtifactCard`). The turn's reconcile mounts it. A turn that
    // RUNS, not a pane that shows motion: a background agent's tool after
    // `done` is no turn, and nothing would end it (`turn-liveness.ts`).
    if (holdsNewArtifactCard({ turnRunning: this.#turnLive, seeded: source?.seeded ?? false })) return
    // A NEW VERSION of this kind: the previous version's card stays where it
    // is in the feed — it is still that version — and the new one gets its own.
    // The next history load puts both at their marker positions.
    if (existing) {
      this.#artifactCards.delete(kind)
      this.#artifactEntries.delete(kind)
    }
    const card = new ArtifactCard(model, this.#cardCallbacks(kind, source?.event.rootId ?? null))
    this.#artifactCards.set(kind, card)
    const entry = entryWrapper('artifact', card.element)
    this.#artifactEntries.set(kind, entry)
    this.#feed.appendChild(entry)
    // A doc card arriving AFTER its story was already rendered standalone claims
    // it — otherwise the pair the user asked to merge stays split until the next
    // narrate happens to re-render.
    this.#renderStoryCard()
  }

  /**
   * A card's actions, aimed at the project its doc lives in. A doc in a
   * project attached to the thread (`docRoot` other than the active project)
   * opens, narrates and shows its artifact THERE, and every message a card
   * sends names it by its absolute path — the agent's working directory is the
   * thread's own project, where the relative path names nothing.
   */
  #cardCallbacks(kind: FlowArtifactKind, docRoot: string | null): ArtifactCardCallbacks {
    const foreign = docRoot !== null && docRoot !== '' && docRoot !== this.#activeRoot ? docRoot : null
    const mention = (path: string): string => docMention(path, foreign, this.#activeRoot)
    return {
      onOpenDoc: (m) => this.#onArtifactOpenDoc(m, foreign),
      onViewBoard: () => document.dispatchEvent(new CustomEvent('flow:open-blueprint')),
      onOpenFeatureView: (m) => this.#onArtifactOpenFeatureView(m, foreign),
      onNarrate: (m) => void this.#onArtifactNarrate(kind, m, foreign),
      onAskAgent: (m) => this.#onArtifactAskAgent(m, mention),
      onGenerateArtifact: (m) => this.#onArtifactGenerate(m, mention),
      ...this.#nextStepCallbacks(mention),
    }
  }

  /**
   * The card a live (not yet marked) doc folds into, or null when it gets its
   * own. The candidates are the cards mounted in the feed, in FEED order — the
   * live doc sits at the feed end, so all of them precede it — and the choice
   * is the pure, tested rule (`foldHostIndex`). The doc's own live card is
   * never its host.
   */
  #liveFoldHost(model: ArtifactCardModel, own: ArtifactCard | undefined): ArtifactCard | null {
    const mounted = [...this.#markerCards.values(), ...this.#artifactCards.values()]
      .filter((card) => card !== own && card.element.isConnected)
      .sort((a, b) => (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    const index = foldHostIndex(
      mounted.map((card) => ({ kind: card.model.kind, feature: card.model.feature, docs: card.docs })),
      model,
    )
    return index === -1 ? null : (mounted[index] ?? null)
  }

  /** (Re)mount every known artifact card — called once history has loaded.
   *  Each card's ownership gate decides whether it shows in this thread. */
  #renderKnownArtifacts(): void {
    for (const kind of this.#artifactModels.keys()) this.#renderArtifactCard(kind)
  }

  /** Detach one kind's live card (it belongs to a different thread). The model
   *  and source survive so the owning thread re-mounts it on return. */
  #removeArtifactCard(kind: FlowArtifactKind): void {
    this.#artifactEntries.get(kind)?.remove()
    this.#artifactEntries.delete(kind)
    this.#artifactCards.delete(kind)
  }

  /** Drop all artifact state (project switch) — cards, entries, models, sources. */
  #clearArtifacts(): void {
    for (const entry of this.#artifactEntries.values()) entry.remove()
    this.#artifactEntries.clear()
    this.#artifactCards.clear()
    this.#artifactModels.clear()
    this.#artifactSources.clear()
    // Marker cards belong to the previous project's thread feed — the next
    // thread load rebuilds them from its own marker rows (#1056).
    this.#markerCards.clear()
    this.#clearFolderBehindCards()
    this.#markerPaths.clear()
    this.#walkthroughs.clear()
    this.#foldedPaths.clear()
    this.#markerHosts.clear()
    this.#planNotes.clear()
    this.#planNotesReading.clear()
    this.#executing.clear()
    this.#executingThread.clear()
    for (const timer of this.#executingTimers.values()) window.clearTimeout(timer)
    this.#executingTimers.clear()
    this.#runStates.clear()
    this.#planRoots.clear()
  }

  /**
   * Record what an event says about its doc's walkthrough page, and bring an
   * inline marker card for that doc up to date without re-reading anything —
   * only the feature-view door can have changed.
   */
  #noteWalkthrough(event: FlowArtifactChangedEvent): void {
    this.#walkthroughs.set(event.path, {
      walkthrough: event.walkthrough === true,
      walkthroughMtime: event.walkthroughMtime,
      walkthroughWriting: event.walkthroughWriting,
    })
    // Only the doc's own marker card has a feature-view door to update — a
    // folded plan has no walkthrough page.
    const card = this.#markerCards.get(event.path)
    if (card === undefined) return
    const door = deriveFeatureViewAction(
      card.model.kind,
      card.model.feature,
      card.model.path,
      event.walkthrough === true,
      isWalkthroughBeingWritten(event.walkthroughWriting === true, event.walkthroughMtime, Date.now()),
    )
    if (JSON.stringify(door) === JSON.stringify(card.model.featureViewAction)) return
    card.setModel({ ...card.model, featureViewAction: door })
  }


  /** The event a marker card is built from, carrying the latest page state known. */
  #withWalkthrough(event: FlowArtifactChangedEvent): FlowArtifactChangedEvent {
    const known = this.#walkthroughs.get(event.path)
    return known === undefined ? event : { ...event, ...known }
  }

  /** Open doc → reuse the chat's file-open bridge (resolves + reveals in the
   *  editor); the same path a markdown file link takes. */
  #onArtifactOpenDoc(model: ArtifactCardModel, docRoot: string | null = null): void {
    document.dispatchEvent(
      new CustomEvent('flow:open-file-path', {
        // Cards open straight into the rendered md preview (user call
        // 2026-07-27) — reading beats editing for discovery/plan docs.
        detail: { path: model.path, rootPath: docRoot ?? this.#activeRoot ?? undefined, preview: true },
      }),
    )
  }

  /**
   * Open artifact → an editor tab walks through what people will see.
   *
   * Decoupled like every other card action: a `document` CustomEvent the
   * feature-view host listens for. The detail carries the walkthrough PAGE's
   * path the host frames (the card holds none of the page, forbidden-pattern
   * #13), the SLUG the tab is keyed by, and the title the view's header shows.
   */
  #onArtifactOpenFeatureView(model: ArtifactCardModel, docRoot: string | null = null): void {
    const action = model.featureViewAction
    // The button exists only when the action does; guarded, not asserted.
    if (action === null) return
    document.dispatchEvent(
      new CustomEvent('flow:open-feature-view', {
        detail: {
          rootPath: docRoot ?? this.#activeRoot,
          path: action.path,
          slug: action.slug,
          title: model.title,
        },
      }),
    )
  }

  /**
   * Generate artifact → `/artifact @<doc>` goes into THIS thread as a message.
   *
   * Through the composer's own send (`flow:send-prompt`), never a second route
   * to `threads:sendMessage` (allowed-pattern #14): the composer echoes it like
   * a typed message, queues it when the turn is busy, and restores nothing it
   * did not take. The page that results arrives through the watcher like any
   * other, which is what turns the button into its loader and then its door.
   */
  /**
   * Take a context reading for `threadId` and show it, or show nothing.
   *
   * Discarded when the pane has moved on: an await means the answer can land
   * after a thread switch, and a stale reading on the wrong conversation is
   * worse than none.
   */
  async #refreshContextMeter(threadId: string): Promise<void> {
    const api = window.flow?.threads
    if (api?.contextUsage === undefined) return
    try {
      const snapshot = await api.contextUsage({ threadId })
      if (this.#threadId !== threadId) return
      this.#contextMeter.update(readContext(snapshot))
    } catch {
      // An older preload, a closed session. The footer keeps the line it had.
    }
  }

  /**
   * Shorten the conversation — sent through the composer, never run from here.
   *
   * The same door Generate artifact and Execute the plan use: a person pressed
   * a button, and what happens next is a message in their own thread they can
   * see, scroll back to and interrupt. Nothing auto-chains (Critical Rule 1).
   */
  #shortenConversation(): void {
    const threadId = this.#threadId
    if (threadId === null) return
    document.dispatchEvent(
      new CustomEvent('flow:send-prompt', { detail: { threadId, text: `/${SHORTEN_COMMAND}` } }),
    )
  }

  #onArtifactGenerate(model: ArtifactCardModel, mention: (path: string) => string = (path) => path): void {
    const action = model.featureViewAction
    const threadId = this.#threadId
    if (action === null || action.state !== 'generate' || threadId === null) return
    document.dispatchEvent(
      new CustomEvent('flow:send-prompt', {
        detail: { threadId, text: artifactCommandFor(mention(action.docPath)) },
      }),
    )
  }

  // ── The next step from the card (plan `plan_change_review`, Phase 7) ──────

  /** The card callbacks that run the workflow's next step. */
  #nextStepCallbacks(mention: (path: string) => string = (path) => path): {
    onCreatePlan: (discoveryPath: string) => boolean
    planRequested: (discoveryPath: string) => boolean
    onReviewChange: (plan: ArtifactDocRef) => void
    onExecutePlan: (plan: ArtifactDocRef) => void
    onPlanDoc: (card: ArtifactCard, planPath: string) => void
    knownPlanPaths: () => readonly string[]
  } {
    return {
      onCreatePlan: (path) => {
        const threadId = this.#threadId
        // Recorded only once the message really went: a press that sent
        // nothing leaves Create the plan on offer.
        if (threadId === null || !this.#sendFromCard(planCommandFor(mention(path)))) return false
        this.#planRequests.record(threadId, path)
        return true
      },
      planRequested: (path) =>
        this.#planRequests.isRequested(this.#threadId, path, this.#planWrittenFor(path)),
      onReviewChange: (plan) => this.#onPlanReview(plan),
      onExecutePlan: (plan) => this.#onPlanExecute(plan),
      onPlanDoc: (card, path) => this.#onPlanDoc(card, path),
      knownPlanPaths: () => this.#knownPlanPaths(),
    }
  }

  /**
   * Whether this thread knows a plan written from THIS discovery document. It
   * asks `planWrittenFromDocument`, the one rule the card's action row also
   * uses, so Create the plan and the double-press guard cannot disagree. The
   * old question compared version-stripped feature names, so a v1 plan hid
   * Create the plan on a v2 discovery.
   */
  #planWrittenFor(discoveryPath: string): boolean {
    return planWrittenFromDocument(discoveryPath, this.#knownPlanPaths())
  }

  /**
   * Every plan path this thread knows — from a plan marker in its transcript or
   * a live plan event this session. A plan has its own card, so the discovery's
   * card cannot see it and asks here.
   */
  #knownPlanPaths(): string[] {
    return [
      ...[...this.#markerPaths].filter((path) => path.startsWith('flow/plans/')),
      ...[...this.#artifactSources.values()].filter((source) => source.event.kind === 'plan').map((source) => source.event.path),
    ]
  }

  /**
   * A card's next step goes into THIS thread as a message, through the
   * composer's own send — exactly as Generate artifact does: echoed like a
   * typed message, queued while a turn runs.
   */
  #sendFromCard(text: string): boolean {
    const threadId = this.#threadId
    if (threadId === null) return false
    document.dispatchEvent(new CustomEvent('flow:send-prompt', { detail: { threadId, text } }))
    return true
  }

  /** The project a plan lives in: its marker's or live event's root, else the active project. */
  #planRootOf(path: string): string | null {
    return this.#planRoots.get(path) ?? this.#activeRoot
  }

  /** Review the change → the plan's code story, in Proposal (the board listens),
   *  read in the plan's OWN project — an attached one included. */
  #onPlanReview(plan: ArtifactDocRef): void {
    const slug = planSlugOf(plan.path)
    const rootPath = this.#planRootOf(plan.path)
    if (slug === null || rootPath === null) return
    window.dispatchEvent(
      new CustomEvent('flow:open-plan-review', { detail: { rootPath, plan: slug, threadId: this.#threadId } }),
    )
  }

  /** Execute the plan → the message, then the card shows the run. The message
   *  names the plan by its absolute path when it lives in an attached project. */
  #onPlanExecute(plan: ArtifactDocRef): void {
    const planRoot = this.#planRootOf(plan.path)
    // Tracked BEFORE the send: a free composer sends (and echoes, starting the
    // turn) synchronously, and that turn's start is what the run follows.
    const previous = this.#executing.get(plan.path)
    this.#executing.set(plan.path, startCardRun(Date.now(), this.#turnLive))
    this.#executingThread.set(plan.path, this.#threadId)
    if (!this.#sendFromCard(executeCommandFor(docMention(plan.path, planRoot, this.#activeRoot)))) {
      if (previous === undefined) this.#executing.delete(plan.path)
      else this.#executing.set(plan.path, previous)
      return
    }
    this.#armCardRunClock(plan.path)
    this.#applyPlanState(plan.path)
    // One read of where the run stands now, in each project that may record
    // it; the broadcast keeps it current.
    if (!window.flow?.flow?.state) return
    for (const rootId of this.#runRootsOf(plan.path)) {
      window.flow.flow
        .state({ rootId })
        .then((state) => this.#onFlowState(state))
        .catch((error: unknown) => console.warn('flow: could not read the run state', { error }))
    }
  }

  /** The projects whose run state may name a plan's run: its own, then the thread's. */
  #runRootsOf(path: string): string[] {
    const roots = [this.#planRootOf(path), this.#activeRoot].filter((root): root is string => root !== null)
    return [...new Set(roots)]
  }

  /** The run state a plan's card reads (`planRunStateFor`). */
  #runStateOf(path: string, slug: string): PlanRunState | null {
    return planRunStateFor(
      this.#runRootsOf(path).map((root) => this.#runStates.get(root) ?? null),
      slug,
    )
  }

  /** The run state changed — only plans executed from a card care. */
  #onFlowState(state: FlowState): void {
    if (this.#executing.size === 0) return
    let mine = false
    for (const path of this.#executing.keys()) if (this.#runRootsOf(path).includes(state.rootId)) mine = true
    if (!mine) return
    this.#runStates.set(state.rootId, { activeSkill: state.activeSkill, activePlan: state.activePlan, activePhase: state.activePhase })
    this.#stepCardRuns(
      (path, slug) => ({ kind: 'state', run: this.#runStateOf(path, slug) }),
      (path) => this.#runRootsOf(path).includes(state.rootId),
    )
  }

  /** Move every card run (or those `only` admits) by one event; an ended run is dropped. */
  #stepCardRuns(
    eventFor: (path: string, slug: string) => CardRunEvent,
    only: (path: string) => boolean = () => true,
  ): void {
    for (const [path, run] of [...this.#executing]) {
      const slug = planSlugOf(path)
      if (slug === null || !only(path)) continue
      const next = cardRunAfter(run, eventFor(path, slug), slug)
      if (next === null) this.#endCardRun(path)
      else {
        this.#executing.set(path, next)
        this.#armCardRunClock(path)
      }
      this.#applyPlanState(path)
    }
  }

  /** Start (or keep) the idle clock of a resting, unseen run; stop it otherwise. */
  #armCardRunClock(path: string): void {
    const run = this.#executing.get(path)
    const resting = run !== undefined && !run.seen && run.idleSince !== null
    const timer = this.#executingTimers.get(path)
    if (!resting) {
      if (timer !== undefined) window.clearTimeout(timer)
      this.#executingTimers.delete(path)
      return
    }
    if (timer !== undefined) return
    const due = Math.max(0, run.idleSince! + UNSEEN_RUN_IDLE_LIMIT_MS - Date.now())
    this.#executingTimers.set(
      path,
      window.setTimeout(() => {
        this.#executingTimers.delete(path)
        const now = Date.now()
        this.#stepCardRuns(
          () => ({ kind: 'tick', now, turnLive: this.#turnLive }),
          (candidate) => candidate === path,
        )
      }, due),
    )
  }

  #endCardRun(path: string): void {
    this.#executing.delete(path)
    this.#executingThread.delete(path)
    const timer = this.#executingTimers.get(path)
    if (timer !== undefined) window.clearTimeout(timer)
    this.#executingTimers.delete(path)
  }

  /** A card holds this plan now: answer from what is known, else read it once. */
  #onPlanDoc(card: ArtifactCard, path: string): void {
    const known = this.#planNotes.get(path)
    if (known !== undefined) {
      // Deferred: the card may still be inside its constructor.
      queueMicrotask(() => this.#applyPlanStateTo(card, path))
      return
    }
    void this.#readPlanNotes(path, card)
  }

  /** The plan file changed: forget its notes, and read them again when a card shows it. */
  #onPlanFileChanged(path: string): void {
    this.#planNotes.delete(path)
    if (this.#cardsHolding(path).length > 0) void this.#readPlanNotes(path)
  }

  /** Read a plan's notes (and its phase count) once; a change mid-read reads again. */
  async #readPlanNotes(path: string, card?: ArtifactCard): Promise<void> {
    const reading = this.#planNotesReading.get(path)
    if (reading !== undefined) {
      reading.again = true
      return
    }
    // The plan's OWN project — a plan in a project attached to the thread is
    // read there, its notes resolved against that project's code.
    const rootPath = this.#planRootOf(path)
    const activeRoot = this.#activeRoot
    const slug = planSlugOf(path)
    if (rootPath === null || slug === null) return
    this.#planNotesReading.set(path, { again: false })
    let counts: PlanNoteCounts | null = null
    let phases: number | null = null
    try {
      const plans = window.flow?.plans
      if (plans !== undefined) {
        const answer = await plans.notes({ rootPath, plan: slug })
        if (answer.ok) counts = answer.counts
        else console.warn('flow: could not read the plan notes', { plan: slug, detail: answer.detail })
      }
      const file = await window.flow.project.readFile({ rootPath, relPath: path, missingOk: true })
      phases = planPhaseCount(file.binary || file.tooLarge ? null : file.content)
    } catch (error) {
      console.warn('flow: could not read the plan notes', { plan: slug, error })
    }
    const again = this.#planNotesReading.get(path)?.again === true
    this.#planNotesReading.delete(path)
    // The project may have changed during the read (which forgets every plan's root).
    if (activeRoot !== this.#activeRoot || rootPath !== this.#planRootOf(path)) return
    this.#planNotes.set(path, { counts, phases })
    if (card !== undefined) this.#applyPlanStateTo(card, path)
    this.#applyPlanState(path)
    if (again) {
      this.#planNotes.delete(path)
      void this.#readPlanNotes(path)
    }
  }

  /** Every card in this feed that holds `path`. */
  #cardsHolding(path: string): ArtifactCard[] {
    const cards = new Set([...this.#markerCards.values(), ...this.#artifactCards.values()])
    return [...cards].filter((card) => card.planPaths.includes(path))
  }

  #applyPlanState(path: string): void {
    for (const card of this.#cardsHolding(path)) this.#applyPlanStateTo(card, path)
  }

  /** Hand a card its plan's counts and, while it runs, its running line. */
  #applyPlanStateTo(card: ArtifactCard, path: string): void {
    const known = this.#planNotes.get(path)
    const counts = known?.counts ?? null
    card.setPlanNotes(path, counts)
    const slug = planSlugOf(path)
    if (slug === null || !this.#executing.has(path)) {
      card.setRunning(path, null)
      return
    }
    card.setRunning(path, runningLine(this.#runStateOf(path, slug), slug, known?.phases ?? null), rejectedLeftOutText(counts))
  }

  /** Narrate → compile the doc's `## Story` via learn:narrate. Success toasts
   *  the summary (the story pipeline flips the card status naturally); a refusal
   *  toasts the CLI's verbatim reason. */
  async #onArtifactNarrate(kind: FlowArtifactKind, model: ArtifactCardModel, docRoot: string | null = null): Promise<void> {
    const rootId = docRoot ?? this.#activeRoot
    if (!rootId || !window.flow.learn) return
    const card = this.#artifactCards.get(kind)
    card?.setBusy(true)
    try {
      const result = await window.flow.learn.narrate({ rootId, docPath: model.path })
      if (result.ok) {
        this.#artifactToast('Story compiled', result.summary, 'info', rootId)
      } else {
        this.#artifactToast('Narrate refused', result.reason, 'warn', rootId)
      }
    } catch (error) {
      this.#artifactToast(
        'Narrate failed',
        error instanceof Error ? error.message : String(error),
        'error',
        rootId,
      )
    } finally {
      this.#artifactCards.get(kind)?.setBusy(false)
    }
  }

  /** Ask agent → prefill the composer with a story-authoring request. Never
   *  auto-sends — the user reviews and sends. */
  #onArtifactAskAgent(model: ArtifactCardModel, mention: (path: string) => string = (path) => path): void {
    document.dispatchEvent(
      new CustomEvent('flow:prefill-composer', {
        detail: { text: `Author a ## Story section for ${mention(model.path)} and narrate it` },
      }),
    )
  }

  /** Surface a toast via the flow:notify bridge (→ NotificationCenter), the same
   *  decoupled path the settings/git/terminal surfaces use. */
  #artifactToast(
    title: string,
    body: string,
    level: 'info' | 'warn' | 'error',
    rootId: string,
  ): void {
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

  // ── Internals ────────────────────────────────────────────────────────────

  #clearLive(): void {
    this.#streams.clear()
    // A held-back wrapper that never got text is not owed to anyone: the block
    // it belonged to said nothing, and the persisted history records nothing
    // either. Dropping it is what keeps `#pendingStreams` from outliving its
    // thread.
    this.#pendingStreams.clear()
    // The reconcile rebuilds the same turn from persisted history; holding the
    // live one would grow a row that is no longer in the feed.
    this.#liveTurn = null
    this.#endLiveRequest()
    // #949: same re-buffer treatment for unanswered permission asks — the
    // broker is still parked on them, so dropping the cards here left the turn
    // hung with no way to allow or deny after an ordinary thread switch.
    this.#permissionQueue.clearRendered()
    this.#permissionCards.clear()
    // The feed is about to be wiped. Re-buffer unanswered questions so they
    // re-render when their thread is shown again — otherwise the agent stays
    // parked on a card that no longer exists. Dispose each card so the wiped
    // instances release their digit-shortcut registrations (#984), and keep it:
    // the re-render mounts the same card, which registers again on resume.
    for (const [requestId, card] of this.#questionCards) {
      card.dispose()
      this.#wipedQuestionCards.set(requestId, card)
    }
    this.#questionQueue.clearRendered()
    this.#questionCards.clear()
  }

  /** Build the failed-turn error card — shared by the live stream path and the
   *  persisted failure-note history rows (#1048), so both render identically. */
  #errorCard(message: string): HTMLElement {
    const card = document.createElement('fl-card')
    card.setAttribute('tone', 'error')
    card.setAttribute('dense', '')
    const head = document.createElement('div')
    head.className = 'fl-conv-error-head'
    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', 'error')
    icon.setAttribute('size', '14')
    icon.style.color = 'var(--fl-color-error)'
    const text = document.createElement('span')
    text.textContent = message
    head.appendChild(icon)
    head.appendChild(text)
    card.appendChild(head)
    return card
  }

  /**
   * Draw a held first message's state: `waiting` is the activity line,
   * `failed` one sentence with Try again (the message is kept; pressing it
   * runs the discovery again), `done` clears both — the turn takes over.
   */
  #applyLearningFirst(held: LearningFirstState): void {
    this.#learningFirstCard?.remove()
    this.#learningFirstCard = null
    if (held.state === 'waiting') {
      this.#learningFirstLine = learningFirstWaiting(held.projects)
    } else {
      this.#learningFirstLine = null
    }
    if (held.state === 'failed') {
      // Nothing is running: the echo's loader must not say "Working…".
      this.#busy = false
      this.#applyTurnEdge({ kind: 'learning-first-failed' })
      const card = this.#errorCard(held.detail ?? learningFirstWaiting(held.projects))
      const retry = document.createElement('fl-button')
      retry.setAttribute('variant', 'primary')
      retry.setAttribute('small', '')
      retry.className = 'fl-conv-learning-retry'
      retry.textContent = LEARNING_FIRST_RETRY
      const threadId = this.#threadId
      retry.addEventListener('click', () => {
        if (threadId === null) return
        retry.setAttribute('disabled', '')
        void window.flow.threads.retryLearningFirst?.({ threadId }).catch((error: unknown) => {
          console.warn('flow: could not try the basic discovery again', error)
          retry.removeAttribute('disabled')
        })
      })
      card.appendChild(retry)
      const entry = entryWrapper('error', card)
      entry.classList.add('fl-conv-learning-first')
      this.#feed.appendChild(entry)
      this.#learningFirstCard = entry
    }
    this.#refreshActivity()
  }

  #appendErrorCard(message: string): void {
    this.#feed.appendChild(entryWrapper('error', this.#errorCard(message)))
  }

  #writeFollowScroll(): void {
    this.#scroller.scrollTop = this.#scroller.scrollHeight
  }

  /** Re-write the bottom for up to `frames` more animation frames, so heights
   *  that only become real AFTER the current one can't strand the viewport
   *  short of the true bottom (#651/#939): scrolling to the placeholder-derived
   *  "bottom" is what makes the next band of entries relevant, so each frame
   *  reveals a little more real height and the target keeps moving.
   *
   *  Two brakes, so this can never fight the reader or spin: it STOPS as soon
   *  as the height holds steady between frames (the transcript has settled),
   *  and it yields to an unpin — the scroll handler's verdict on a real
   *  gesture. */
  #reassertBottom(frames: number, previousHeight = -1): void {
    if (frames <= 0) return
    this.#scrollFrame = requestAnimationFrame(() => {
      this.#scrollFrame = null
      if (!this.#pinned) return
      const height = this.#scroller.scrollHeight
      this.#writeFollowScroll()
      if (height === previousHeight) return
      this.#reassertBottom(frames - 1, height)
    })
  }

  /**
   * Show or hide the jump-to-latest control, and say how much was missed
   * (#1330). Cheap enough to call from the scroll handler: two reads and a
   * class toggle, no layout write.
   */
  #syncJumpControl(): void {
    const button = this.#jumpBtn
    if (button === null) return
    const distance =
      this.#scroller.scrollHeight - this.#scroller.scrollTop - this.#scroller.clientHeight
    // #1472: what arrived since the reader stopped following, not what was
    // rendered. Null (never unpinned, or re-pinned since) means nothing missed.
    const missed =
      this.#entriesAtUnpin === null ? 0 : Math.max(0, this.#renderedEntries - this.#entriesAtUnpin)
    const view = jumpToLatestView({
      pinned: this.#pinned,
      distanceFromBottom: distance,
      missed,
    })
    button.hidden = !view.visible
    button.textContent = view.label
    button.setAttribute('aria-label', view.ariaLabel)
  }

  #scrollToBottom(force = false): void {
    if (force) {
      // Immediate — thread switches must land at the bottom right away.
      if (this.#scrollFrame !== null) {
        cancelAnimationFrame(this.#scrollFrame)
        this.#scrollFrame = null
      }
      this.#writeFollowScroll()
      // Re-assert after the next layout pass: content appended this tick can
      // still grow before paint (custom-element upgrades, fonts, entries
      // leaving their content-visibility placeholder as they enter the
      // viewport), which would strand the viewport short of the true bottom
      // (#651). Unconditional, like the original single-frame re-assert.
      this.#scrollFrame = requestAnimationFrame(() => {
        this.#scrollFrame = null
        this.#writeFollowScroll()
        // #939: a post-reconcile rebuild mounts a whole transcript of fresh
        // entries, so placeholder→real-height settling takes more than the
        // single frame #651 needed for one appended card. These extra frames
        // yield to the reader (see #reassertBottom).
        this.#reassertBottom(FORCED_BOTTOM_REASSERT_FRAMES)
      })
      return
    }
    if (!this.#pinned || this.#scrollFrame !== null) {
      return // not following, or a scroll is already scheduled for this frame
    }
    // Coalesce to one scrollHeight read + scrollTop write per frame — stream
    // deltas can arrive many times per frame and each sync scroll forces a
    // reflow.
    this.#scrollFrame = requestAnimationFrame(() => {
      this.#scrollFrame = null
      if (!this.#pinned) {
        return
      }
      this.#writeFollowScroll()
      // Same next-frame re-assert as the force path (#651): the streamed chunk
      // renders taller than its placeholder AFTER this scroll, which would
      // otherwise leave the tail below the fold until the next delta (#823).
      this.#reassertBottom(1)
    })
  }
}

// ── Reader selection across a rebuild (#1088) ──────────────────────────────
//
// Live Ranges do NOT survive the wipe: the DOM removing steps collapse any
// range whose boundary is inside a removed subtree onto the parent, so a cloned
// Range comes back empty. What DOES survive is the node identity — the
// reuse-aware rebuild re-appends the very elements the reader selected — so the
// boundaries are captured as plain (node, offset) pairs and a FRESH range is
// built from them afterwards.

interface FeedSelection {
  startContainer: Node
  startOffset: number
  endContainer: Node
  endOffset: number
}

/** The reader's selection, if it lies inside `feed`. Null otherwise. */
function captureFeedSelection(feed: HTMLElement): FeedSelection | null {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!feed.contains(range.commonAncestorContainer)) return null
  return {
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
  }
}

/** Re-select `captured` when both of its boundary nodes came back with the
 *  rebuild. Never clobbers a selection the reader made in the meantime. */
function restoreFeedSelection(feed: HTMLElement, captured: FeedSelection | null): void {
  if (captured === null) return
  if (!feed.contains(captured.startContainer) || !feed.contains(captured.endContainer)) return
  const selection = window.getSelection()
  if (selection === null || !selection.isCollapsed) return
  try {
    const range = document.createRange()
    range.setStart(captured.startContainer, captured.startOffset)
    range.setEnd(captured.endContainer, captured.endOffset)
    selection.removeAllRanges()
    selection.addRange(range)
  } catch {
    // The node came back with different content — leave the selection cleared
    // rather than throwing inside a reconcile.
  }
}

// ── Entry building ─────────────────────────────────────────────────────────

/**
 * `Thought 4s` from a measured span, or null when it rounds to nothing.
 *
 * Null IS the answer for a sub-second think: the row's whole justification is
 * that a reader wants to know the agent stopped to consider, and `Thought 0s`
 * says the opposite while taking the same space. Seconds up to a minute, then
 * minutes — the resolution a reader can act on, not the one the clock has.
 */
function thoughtLabel(ms: number): string | null {
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return null
  if (seconds < 60) return `Thought ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `Thought ${minutes}m` : `Thought ${minutes}m ${rest}s`
}

function entryWrapper(kind: string, content: HTMLElement): HTMLElement {
  const entry = document.createElement('div')
  entry.className = `fl-conv-entry fl-conv-entry-${kind}`
  entry.appendChild(content)
  return entry
}

/** Each rendered user body's original text, so a command list arriving later
 *  can re-highlight it (the feed renders before the list is fetched). */
const userBodyText = new WeakMap<HTMLElement, string>()

function userBubble(
  content: string,
  attachments?: readonly { id: string; fileName?: string; dataUrl?: string }[],
): HTMLElement {
  const bubble = document.createElement('div')
  bubble.className = 'fl-conv-user'
  const label = document.createElement('div')
  label.className = 'fl-conv-user-label'
  label.textContent = 'You'
  bubble.appendChild(label)
  const thumbs = thumbModels(attachments)
  if (thumbs.length > 0) {
    const grid = document.createElement('div')
    grid.className = 'fl-conv-attachments'
    for (const thumb of thumbs) {
      const img = document.createElement('img')
      img.className = 'fl-conv-attachment-thumb'
      img.alt = thumb.alt
      // #1138 — the thumbnail is capped at 220×160, so it is an affordance, not
      // the image: say so (cursor + title + a keyboard role), and open the real
      // thing on activation. Without this there is NO route to the bytes — they
      // live in userData/attachments/, out of reach of the tree and the editor.
      img.title = `${thumb.alt} — click to view full size`
      img.tabIndex = 0
      img.setAttribute('role', 'button')
      const openFullSize = (): void => {
        // `img.src` is whatever resolved: the optimistic echo, or the bytes the
        // read channel filled in. Empty only while a history row is still
        // loading, in which case there is nothing to show yet.
        if (!img.src) return
        openImageViewer({ src: img.src, alt: thumb.alt, returnFocusTo: img })
      }
      img.addEventListener('click', openFullSize)
      img.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        openFullSize()
      })
      // #1063 — right-click reveals the persisted attachment file in the OS file
      // manager. Only the id crosses to main, which resolves + confines the path.
      img.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        showRevealMenu(event.clientX, event.clientY, () => {
          void window.flow.attachments
            .revealPath({ attachmentId: thumb.id })
            .catch((error: unknown) => console.warn('flow: reveal failed', error))
        })
      })
      if (thumb.dataUrl) {
        img.src = thumb.dataUrl // optimistic echo — bytes in hand
      } else {
        // History row — fetch bytes lazily via the read channel (#456).
        void window.flow.attachments
          .read({ attachmentId: thumb.id })
          .then((result) => {
            if (result) img.src = result.dataUrl
          })
          .catch(() => {})
      }
      grid.appendChild(img)
    }
    bubble.appendChild(grid)
  }
  // A text body only when there's text (an attachment-only message has none).
  if (content.length > 0) {
    const body = document.createElement('div')
    body.className = 'fl-conv-user-body'
    // Commands and @-files highlighted as spans built from the text — never
    // HTML from the content; textContent stays the message exactly.
    renderHighlightedText(body, content)
    userBodyText.set(body, content)
    bubble.appendChild(body)
  }
  return bubble
}

// ── Styles (light DOM) ─────────────────────────────────────────────────────

let conversationStylesInjected = false

function injectConversationStyles(): void {
  if (conversationStylesInjected) {
    return
  }
  conversationStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-conversation {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      position: relative;
    }
    .fl-conv-scroller {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--fl-space-md) var(--fl-space-lg);
    }
    .fl-conv-feed {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-md);
      max-width: var(--fl-conv-column);
      margin: 0 auto;
    }
    .fl-conv-entry {
      content-visibility: auto;
      contain-intrinsic-size: auto 96px;
    }
    /* A collapsed turn is one 28px line, so it gets the row-sized estimate the
       tool entries use rather than the 96px message default — the auto keyword
       still remembers the real height once an expanded turn has rendered. */
    .fl-conv-entry-tool, .fl-conv-entry-error, .fl-conv-entry-turn {
      contain-intrinsic-size: auto 32px;
    }
    /* A closed work row is one bordered line (two while live). */
    .fl-conv-entry-request {
      contain-intrinsic-size: auto 40px;
    }
    /* One caption line, and it never grows — nothing expands out of it. */
    .fl-conv-entry-thought {
      contain-intrinsic-size: auto 20px;
    }
    .fl-conv-thought {
      /* Quieter than the turn row, which is already the feed's quietest thing:
         caption size, secondary colour, no ground and no edge. A note about
         how the answer came to be must not compete with the answer, nor with
         the counts on the turn row (Q-3). The left pad matches the turn row's
         so the two line up as siblings under the same prose. */
      padding: 0 var(--fl-space-xs);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    /* Actionable cards (permission + question requests share this entry kind)
       are force-scrolled into view the moment they append. Under
       content-visibility:auto they'd be appended below the fold at the
       placeholder height, the scroll would target that estimate, and the card
       would then render its real (much taller) content just past the bottom —
       leaving only its top edge visible (#651). They're rare and live-only,
       so skipping virtualization for them costs nothing. */
    .fl-conv-entry-permission {
      content-visibility: visible;
      contain-intrinsic-size: none;
    }
    .fl-conv-user {
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      /* The widest container in the chat column, so it takes the largest of
         the container radii — a corner has to curve in proportion to the box
         it turns, or a wide bubble reads as a rectangle with a chipped edge. */
      border-radius: var(--fl-radius-lg);
      padding: var(--fl-space-sm) var(--fl-space-md);
    }
    .fl-conv-user-label {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: var(--fl-space-xs);
      user-select: none;
    }
    .fl-conv-user-body {
      font-size: var(--fl-text-prose-size);
      white-space: pre-wrap;
      overflow-wrap: break-word;
    }
    /* Image attachments in a user bubble (#456). */
    .fl-conv-attachments {
      display: flex; flex-wrap: wrap; gap: var(--fl-space-xs);
      margin-top: var(--fl-space-xs);
    }
    .fl-conv-attachment-thumb {
      max-width: 220px; max-height: 160px; height: auto;
      border-radius: var(--fl-radius-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      /* #1138 — the thumbnail opens the full-size viewer, so it reads as the
         control it is (and takes a visible focus ring for the keyboard path). */
      cursor: pointer;
    }
    .fl-conv-attachment-thumb:hover {
      border-color: var(--fl-color-border-strong, var(--fl-color-accent));
    }
    .fl-conv-attachment-thumb:focus-visible {
      outline: 2px solid var(--fl-color-accent);
      outline-offset: 2px;
    }
    .fl-conv-system {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      white-space: pre-wrap;
    }
    /* #1919: stand-in for a suppressed raw conflict-proposals reply. */
    .fl-conv-proposal-note {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .fl-conv-proposal-note fl-icon { color: var(--fl-color-accent); }
    /* Per-message model badge (#129) — a small muted label under the reply. */
    .fl-conv-assistant { display: flex; flex-direction: column; align-items: flex-start; gap: var(--fl-space-xs); }
    /*
     * CAP THE CHILDREN AT THE COLUMN. align-items:flex-start is what keeps the
     * model badge from stretching into a full-width bar — but it also sizes
     * every child to its MAX-CONTENT width, and a flex item sized to
     * max-content never wraps: one unbreakable token (a long absolute path, a
     * wide code fence) made the whole block as wide as that token and ran the
     * prose out past the right edge of the pane, where it was clipped.
     *
     * A 100% max-width puts the ceiling back without stretching anything that
     * is naturally narrow, so text wraps again and a code fence stays inside
     * the column and scrolls within itself.
     *
     * (No backticks in here: this block lives inside a template literal.)
     */
    .fl-conv-assistant > * { max-width: 100%; min-width: 0; }
    .fl-conv-model-badge {
      align-self: flex-start;
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
      letter-spacing: 0.02em;
      opacity: 0.75;
    }
    .fl-conv-activity {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      box-sizing: border-box;
      max-width: var(--fl-conv-column);
      /* Match the message column: same 820px track, and pad the left by one
         bubble inset so the dots line up with message TEXT (not the bubble
         border). Top margin matches the inter-message gap so it isn't cramped
         against the message above. */
      margin: var(--fl-space-md) auto var(--fl-space-sm);
      padding-left: var(--fl-space-md);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-ui-size);
      user-select: none;
    }
    /* display:flex above ties the UA [hidden]{display:none} on specificity and
       wins by order — without this the loader shows forever on thread select. */
    .fl-conv-activity[hidden] { display: none; }
    .fl-conv-activity-label { font-style: italic; opacity: 0.85; }
    .fl-conv-dots {
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .fl-conv-dots span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--fl-color-accent, var(--fl-color-text-secondary));
      opacity: 0.35;
      animation: fl-conv-dot 1.2s ease-in-out infinite;
    }
    .fl-conv-dots span:nth-child(2) { animation-delay: 0.18s; }
    .fl-conv-dots span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes fl-conv-dot {
      0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
      30% { opacity: 1; transform: translateY(-3px); }
    }
    @media (prefers-reduced-motion: reduce) {
      .fl-conv-dots span { animation: none; opacity: 0.6; }
    }
    /* Newly appended live entries ease in so streamed content and the
       optimistic user bubble don't pop. */
    .fl-conv-enter { animation: fl-conv-enter 0.18s ease-out; }
    @keyframes fl-conv-enter {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .fl-conv-enter { animation: none; }
    }
    .fl-conv-empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--fl-space-sm);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-ui-size);
      user-select: none;
      pointer-events: none;
    }
    /* #1330: the way back to the live end. Floats over the feed (the pane is
       the positioning context) so it never scrolls away with the content it is
       offering to escape. */
    .fl-conv-jump {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: 64px;
      z-index: 5;
      /* #1473: this floats OVER the transcript, and at bottom:64px it usually
         lands on a user bubble — which is also --fl-color-surface-raised, so
         the pill's fill matched what it covered exactly, its border sat one
         unit off its own fill, and --fl-shadow-md resolved to nothing. All
         three separations collapsed and the control read as text spliced into
         a sentence. It now differs from the bubble on every channel: a darker
         fill, a border drawn in a colour the reader can actually see, and real
         elevation (the token is defined now — see theme/tokens.css). */
      border: var(--fl-border-width) solid var(--fl-color-text-secondary);
      background: var(--fl-color-bg);
      color: var(--fl-color-text);
      border-radius: 999px;
      padding: 4px 12px;
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
      box-shadow: var(--fl-shadow-md);
    }
    .fl-conv-jump:hover { border-color: var(--fl-color-accent); color: var(--fl-color-accent); }
    /* The usage line and the footer below it share ONE geometry with the feed:
       the scroller's horizontal padding outside, the column cap and auto
       margins inside. Anything that belongs to the conversation rather than to
       a single message lines up with the text, instead of with the pane's
       edge — which is where the savings chip used to sit, past the right-hand
       end of every message above it. */
    /* Inside the footer row now, so the padding and the column cap come from
       it — carrying its own would inset this half twice and break the
       alignment it is here for. A zero min-width lets a long line ellipsis
       instead of shoving the Changes strip off its own edge. */
    .fl-conv-usage {
      flex: 0 1 auto;
      min-width: 0;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      user-select: none;
    }
    .fl-conv-usage-row {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: var(--fl-space-sm);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fl-conv-foot {
      flex: none;
      margin-top: auto;
    }
    .fl-conv-footer {
      flex: none;
      padding: 0 var(--fl-space-lg) var(--fl-space-xs);
      user-select: none;
    }
    .fl-conv-footer-row {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      max-width: var(--fl-conv-column);
      margin: 0 auto;
      min-height: 22px;
    }
    .fl-conv-footer-lead { display: flex; align-items: center; min-width: 0; }
    .fl-conv-footer-spacer { flex: 1; }
    /* display:flex would tie the UA [hidden] rule — same guard as the
       activity loader above. */
    .fl-conv-usage[hidden] { display: none; }
    /* Per-turn savings segment: brain icon + "~Nk saved", same muted tone as
       the token stats it follows. */
    .fl-conv-usage-saved {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      opacity: 0.85;
    }
    .fl-conv-usage-saved[hidden] { display: none; }
    .fl-conv-earlier {
      display: flex;
      justify-content: center;
      padding: var(--fl-space-xs) 0;
    }
    .fl-conv-error-head {
      display: flex;
      /* #1179: align to the TOP, not the centre — a multi-line reason next to a
         14px glyph should hang off the icon's line, not float beside the middle
         of a paragraph. */
      align-items: flex-start;
      gap: var(--fl-space-sm);
      font-size: var(--fl-text-ui-size);
    }
    /* #1179: the reason is the whole point of the card, and it was clipped at
       the card edge — a flex row with no min-width:0 refuses to shrink its text
       child below its content width, so a URL or path in the failure ran off
       the side with no wrap, no ellipsis and no tooltip, and a multi-line
       reason collapsed into one run-on line. */
    .fl-conv-error-head > span {
      min-width: 0;
      flex: 1;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .fl-conv-error-head > fl-icon { flex: none; }
    .fl-conv-learning-retry { display: block; margin-top: var(--fl-space-sm); margin-left: auto; width: max-content; }
  `
  document.head.appendChild(style)
}

let subagentBannerStylesInjected = false

/** #1931 — the continuing-from-sub-agent header. Existing tokens only, over a
 *  thin accent strip so it reads as context, not a dialog. */
function injectSubagentBannerStyles(): void {
  if (subagentBannerStylesInjected) {
    return
  }
  subagentBannerStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-conv-subagent-banner {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-xs) var(--fl-space-md);
      background: var(--fl-color-surface-raised, rgba(74, 158, 255, .08));
      border-bottom: 1px solid var(--fl-color-border);
      font-size: var(--fl-font-size-sm, 12px);
      color: var(--fl-color-text-secondary);
    }
    .fl-conv-subagent-banner-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fl-conv-subagent-banner-back {
      flex: none;
      cursor: pointer;
      background: none;
      border: 1px solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm, 4px);
      padding: 2px 8px;
      color: var(--fl-color-text);
      font: inherit;
    }
    .fl-conv-subagent-banner-back:hover {
      background: var(--fl-color-surface-hover, rgba(255, 255, 255, .06));
    }
  `
  document.head.appendChild(style)
}
