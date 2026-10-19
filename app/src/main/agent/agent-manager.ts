// AgentManager — session-per-thread lifecycle over the Claude Agent SDK.
//
// One live SDK Query per active thread, driven with streaming input so a
// thread holds a single long-lived session across many user turns
// (create → send → interrupt → resume → dispose). The SDK runs ONLY here in
// the main process; the renderer sees typed AgentStreamEvents over IPC.
//
// Crash isolation: every session loop is wrapped — an SDK/session failure
// marks the thread 'failed' via ThreadStore and emits an error stream event;
// the app (and every other session) keeps running. A failed thread can be
// retried with a new sendMessage, which starts a fresh session resuming the
// persisted sdk_session_id.
//
// SECURITY: the Anthropic API key (if configured) is passed to the SDK
// subprocess via environment only — never composed into prompts, never over
// IPC. With no stored key the subprocess inherits the user's CLI auth.
//
// MODULE FORMAT: @anthropic-ai/claude-agent-sdk is ESM-only while the main
// process bundles to CJS, so the SDK is loaded through a runtime dynamic
// import() (kept out of TypeScript's CJS down-compilation via new Function).
// Types are erased imports and cost nothing at runtime.

import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'

import type {
  McpServerConfig,
  Options,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

import type {
  AgentStreamEvent,
  MessageAttachmentInput,
  ModelSelection,
  PermissionRequest,
  PermissionVerdict,
} from '../../shared/ipc-contract'
import { SHORTEN_COMMAND, type ContextUsageSnapshot } from '../../shared/context-usage'
import type { AttachmentStore } from '../store/attachment-store'
import { buildUserContent } from './user-content'
import { BRAIN_FIRST_COMPACT } from './brain-first'
import type { BoardToolsProvider } from './board-tools/board-tools-provider'
import type { CredentialsManager } from '../credentials'
import {
  THREAD_STORE_CHANGE_EVENT,
  type ThreadStore,
  type ThreadRecord,
  type MessageRecord,
  type ThreadChangeEvent,
} from '../store/thread-store'
import type { AccountResolver } from './account-resolver'
import { bindAgentBinary, ensureAgentBinary } from './agent-binary'
import { buildAccountEnv } from './account-env'
import { withShimPath } from './cli-shim'
import type { EditTracker } from './edit-tracker'
import { PermissionBroker, PERMISSION_REQUEST_EVENT } from './permissions'
import {
  UserDialogBroker,
  DIALOG_REQUEST_EVENT,
  DIALOG_CANCEL_EVENT,
  ASK_USER_QUESTION_KINDS,
  type DialogCancel,
} from './dialogs'
import { BackgroundTaskTracker } from './background-tasks'
import { StreamBridge, type ToolCallObservation } from './stream-bridge'
import {
  bashCommand,
  bashContainmentCheck,
  containmentCheck,
  editFilePath,
  isSessionPlanFile,
  readContainmentCheck,
  readTargetPath,
  type ReadAllowance,
} from './path-containment'
import { attachRootForWritePath, bashAttachDecision, TurnAttachTracker } from './auto-attach'
import { containmentRoots, externalRuntimeRoots, sessionWorkspaceWriteFiles, sessionWritableRoots } from './flow-artifacts'
import { resolveFlowLinkTargets } from './flow-link-roots'
import { expandSlashCommand } from './runtime/slash-command'
import { loadExternalMcpServers } from './external-mcp'
import type { ContextGate, FastModelCall } from './context-gate'

import type {
  UserQuestionAnswer,
  UserQuestionRequest,
  ThreadStatus,
  BackgroundTaskInfo,
} from '../../shared/ipc-contract'
import { resolveAutoModel, type ModelRouting } from '../../shared/model-routing'
import { resolveProvider, type ProviderId } from './runtime/runtime-registry'
import { modelForRuntime } from '../../shared/runtime-models'
import { cachedUserPathEnv } from './runtime/tool-path'
import type { AgentRuntime, RuntimeSession } from './runtime/agent-runtime'
import { CodexRuntime } from './runtime/codex-runtime'
import { CopilotRuntime } from './runtime/copilot-runtime'
import { createRuntime, type RuntimeFactoryDeps } from './runtime/runtime-registry'
import { RuntimeEventSink } from './runtime/runtime-event-sink'
import { e2eSeams } from '../e2e-seams'
import type { BasicDiscovery } from '../learn/basic-discovery'
import { learningFirstFailed, type LearningFirstState } from '../../shared/basic-discovery'
import { SESSION_FAILURE_PREFIX } from '../../shared/turn-failure'
import { sessionRootFor } from '../project/session-root'
import { writingRulesBriefing } from './writing-rules'

// The work-root resolver lives in its own dependency-free module; re-exported
// here so existing importers keep working.
export { sessionRootFor }

/**
 * The one line of situation a worktree thread's session is told about itself,
 * appended to the SDK's preset system prompt. Null when the thread has no
 * worktree — the session is then byte-identical to before.
 *
 * Until now a session was told nothing narrative about where it was: only a cwd
 * and a directory list, from which "I am in a disposable checkout" cannot be
 * inferred. Two consequences were already predictable. An agent being helpful
 * runs `git checkout main` and moves a branch the reader is standing on. And an
 * agent that cannot see the reader's uncommitted work says it looked and found
 * nothing, which is a lie it had no way of knowing it was telling.
 *
 * Read by an AGENT, not a person — absolute paths are the point here, and
 * forbidden-pattern #12 (no paths in UI text) does not reach this string.
 */
export function threadWorktreeBriefing(thread: {
  projectRoot: string
  worktreePath: string | null
  worktreeBranch: string | null
  worktreeBase: string | null
}): string | null {
  if (thread.worktreePath === null) return null
  const branch =
    thread.worktreeBranch === null
      ? 'This worktree is DETACHED — it has no branch yet (one is created for it once this thread has a name). Commit normally; do not check out or switch branches here, and never run `git checkout` against the main checkout.'
      : `This worktree is on branch \`${thread.worktreeBranch}\`. Commit to it normally; do not switch it to another branch.`
  const base =
    thread.worktreeBase === null
      ? ''
      : ` It was cut from \`${thread.worktreeBase}\`, which is where this work is meant to land.`
  return [
    `You are working in a git worktree at ${thread.worktreePath} — a private checkout of the project at ${thread.projectRoot}.${base}`,
    branch,
    `The main checkout is deliberately outside your reach, and the user's UNCOMMITTED work there is not present here. If you cannot find a change they describe, the honest answer is that it is in their working copy where you cannot see it — never report it as absent or unwritten.`,
  ].join(' ')
}

/**
 * How a turn ENDS — appended to every CLAUDE session's system prompt, worktree
 * or not.
 *
 * The other briefing above says where the session is; this one says what a
 * finished answer looks like. It ships for every Claude thread on purpose: a
 * collapsed turn in the feed shows the agent's closing words as its headline,
 * so a turn that trails off in a tool call reads, folded, as nothing at all.
 *
 * IT DOES NOT REACH CODEX OR COPILOT, and their turns fold anyway. `createSession`
 * routes every `provider !== 'claude'` thread to `createRuntimeSession` before
 * `buildSessionOptions` is ever called, and `RuntimeStartOptions` carries no
 * system-prompt field at all. Those runtimes get the writing rules
 * (writing-rules.ts) ahead of their first prompt — `startOrSendRuntimeTurn` —
 * and not this answer shape. Do not "fix" that by editing this
 * docstring back to "every session".
 *
 * Deliberately permissive. A prompt that DEMANDS a template on every turn buys
 * a heading and a numbered list on the turn that answered a yes/no question,
 * which is the same noise this exists to remove — so the instruction names the
 * turns it is for and tells the agent to skip it otherwise.
 *
 * Written in the writing rules' own style (short sentences, instructions that
 * start with the verb), because it sits beside them in the same briefing and
 * two instructions about one answer must not disagree.
 *
 * Every shape named here is one `markdown-renderer.ts` already renders
 * (headings, ordered lists, fenced code with a language tag, inline code), so
 * nothing in the renderer depends on this string.
 */
export const TURN_CLOSE_BRIEFING = [
  'Close a turn that did real work with a short summary. Real work is a changed file, a diagnosed bug or a finished investigation.',
  'Start the summary with a verb heading, for example `## Fix`, `## Update` or `## Analysis`.',
  'Under the heading, write a short numbered list of what changed. Name files, symbols and commands in inline code.',
  'Quote a snippet only when it makes the change clearer. Quote only the changed lines, in a fenced block with a language tag.',
  'Do not use this summary on every turn. When one sentence answers the question, close the turn with that sentence.',
].join(' ')

/**
 * Ask with the picker, not with a lettered list in the prose.
 *
 * REPORTED AS A BROKEN TOOL (user, 2026-10-13: "the ask tool is not working
 * sometimes when the agent are asking something"), and measured as the
 * opposite: 149 of 159 `AskUserQuestion` calls on the real profile succeeded,
 * and the thread in the report made NONE — it wrote "First question: who
 * decides…" with options A, B and C as markdown, so no card could appear and
 * the reader had to type their answer back in prose.
 *
 * NOTHING HAD TOLD IT OTHERWISE. The skills that ask (`/brainstorm`,
 * `/discovery-plan`) carry the instruction themselves, so an ordinary
 * conversation — which is where this happened — had no rule at all, while the
 * writing rules beside this one say "Use a list for items that are alike".
 * That is a fair description of three options, and a lettered list is what it
 * produces.
 *
 * CLAUDE-ONLY, like its siblings and for a harder reason than theirs: the
 * question card exists only on this path (`canUseTool` → `askForToolInput` →
 * the dialog broker). A Copilot or Codex session has no such channel, so this
 * instruction would name a tool it does not have (forbidden-pattern #12's
 * cousin — never tell a reader to press something that is not there).
 *
 * Written in the writing rules' own style, because it sits beside them.
 */
export const ASKING_BRIEFING = [
  'Use the `AskUserQuestion` tool when you need a decision from the person. It shows a picker they can click.',
  'Do not write the choice as a lettered or numbered list in your answer. A list in prose cannot be clicked, and the person must then type the answer back.',
  'Give each question 2 to 4 options. Each option needs a short label and one line that says what it means.',
  'Ask with the tool when the answer changes what you build next. Ask several related questions in one call.',
  'Keep writing in prose when you report, explain or recommend. Those are not decisions for the person to make.',
].join(' ')

/**
 * The whole append for a Claude session's system prompt: the thread's situation
 * (only when it has a worktree), the writing rules, the answer shape, then how
 * to ask. One function, so the parts never drift into separate call sites
 * deciding independently what a session is told (allowed-pattern #14).
 *
 * Claude-only, for the reason `TURN_CLOSE_BRIEFING` gives: the runtime providers
 * never reach `buildSessionOptions`, so nothing calls this for them.
 */
export function sessionBriefing(thread: {
  projectRoot: string
  worktreePath: string | null
  worktreeBranch: string | null
  worktreeBase: string | null
}): string {
  const situation = threadWorktreeBriefing(thread)
  return [situation, writingRulesBriefing(), TURN_CLOSE_BRIEFING, ASKING_BRIEFING]
    .filter((part): part is string => part !== null)
    .join('\n\n')
}

/**
 * The prompt a Copilot or Codex session starts with: the writing rules, then
 * the person's (seeded) text. Only the runtime sees it; the transcript keeps
 * what was typed.
 */
export function runtimeFirstPrompt(text: string): string {
  return `${writingRulesBriefing()}\n\n${text}`
}

/** Emitted for every AgentStreamEvent. Payload: AgentStreamEvent. */
export const AGENT_STREAM_EVENT = 'stream'
/** Re-emitted from the PermissionBroker. Payload: PermissionRequest. */
export { PERMISSION_REQUEST_EVENT }
/** Re-emitted from the UserDialogBroker. Payload: UserQuestionRequest. */
export { DIALOG_REQUEST_EVENT, DIALOG_CANCEL_EVENT }

/** Shape of query() — injectable so tests can run a mocked SDK stream. */
export type QueryFunction = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options?: Options
}) => Query

/**
 * Produce a concise thread title from the opening transcript. Injectable so
 * tests exercise the auto-title flow without spinning up a real SDK session;
 * the default runs a one-shot haiku query (see sdkTitleGenerator).
 */
export type TitleGenerator = (input: {
  projectRoot: string
  transcript: string
}) => Promise<string | null>

export interface AgentManagerOptions {
  /** Override the SDK query function (tests/mocks). Default: lazy-load the
   *  real @anthropic-ai/claude-agent-sdk. */
  queryFn?: QueryFunction
  /** Override auto-title generation (tests). Default: one-shot haiku query. */
  titleGenerator?: TitleGenerator
  /** Per-project account resolution (multi-account feature). When absent, the
   *  session uses today's legacy auth (stored API key / inherited CLI login). */
  accountResolver?: AccountResolver
  /**
   * Task-list hooks (all optional, all decoupled — AgentManager never knows
   * about tasks). `seedProvider` returns starting context prepended to the
   * agent's FIRST turn on a thread (not stored as the user's message).
   * `onTurnStart`/`onTurnComplete` drive Kanban lane automation.
   */
  seedProvider?: (threadId: string) => string | null
  onTurnStart?: (threadId: string) => void
  onTurnComplete?: (threadId: string, success: boolean) => void
  /**
   * Every thread STATUS transition, as it is emitted (working / idle /
   * needs-decision / blocked / done / failed). Decoupled like its siblings —
   * AgentManager never knows about tasks — and used to drive the Kanban card's
   * lane: a card whose thread goes `needs-decision` moves to Blocked and back.
   * Fires from the one choke point every status event already flows through, so
   * transitions from both the manager and the StreamBridge are covered.
   */
  onThreadStatus?: (threadId: string, status: ThreadStatus) => void
  /**
   * Every tool use the bridge announced, forwarded with its thread.
   *
   * The board's mirrors are the reason it exists, but this stays as ignorant as
   * its siblings: a tool name, the payloads as stored, which moment this is, and
   * no opinion about who wants them. Must not throw and must not block — the
   * bridge guards the first and the hook's own implementation owes the second.
   */
  onToolCallRecorded?: (input: { threadId: string } & ToolCallObservation) => void
  /** Auto-mode effort→model routing (#129). When present, a thread set to
   *  'auto' resolves its model from its effort via this map; absent → SDK
   *  default. Read lazily so live settings edits take effect next turn. */
  getModelRouting?: () => ModelRouting
  /** Record a model a runtime reported using — the picker's own evidence. */
  rememberRuntimeModel?: (provider: string, model: string) => void
  /** Persist the user's explicit model+effort pick as the app-wide default for
   *  future threads (#848). Optional; fire-and-forget. */
  saveDefaultModelSelection?: (selection: ModelSelection) => void
  /** Directory containing the on-PATH `planflow-ai` shim (see cli-shim.ts),
   *  or null when the shim could not be written (fail-soft — see
   *  ensureCliShim). When present, every session's env gets this prepended
   *  to PATH so skills can shell out to `planflow-ai` with no local install,
   *  even in a project with no bundled/installed CLI of its own. */
  cliShimDir?: string | null
  /**
   * Session-start provisioning gate (#513 phase 2). Called with the thread's
   * primary project root BEFORE the SDK session spawns; resolves once the
   * root's plan-flow provisioning settles (ready/failed) or a bound timeout
   * elapses. MUST never reject and MUST be bounded — gating is a best-effort
   * convenience, never a hard block. Absent → sessions start immediately
   * (backward compatible; tests/headless omit it).
   */
  awaitProvisioning?: (rootPath: string) => Promise<void>
  /**
   * KNOWN project roots for auto-attach (multi-project threads, phase 6).
   * A write landing inside one of these — but outside the thread's current
   * root set — attaches that root to the thread (thread_roots + a persisted
   * system note) and is allowed, instead of being blocked. Read lazily on
   * every containment decision so root changes apply mid-session. Absent →
   * no auto-attach; every escape blocks exactly as before.
   */
  knownProjectRoots?: () => readonly string[]
  /**
   * The agent RUNTIME a project's threads run under (multi_runtime_support).
   * `resolveProviderFor` returns the per-project `.flowconfig` `provider` for a
   * project root (absent/null → no override); `globalProviderDefault` is the
   * app-wide default. Resolution is `override ?? default ?? legacy 'claude'`, so
   * a project that sets nothing is byte-identical to before this existed. Both
   * absent → every thread is a Claude thread, exactly as today.
   */
  resolveProviderFor?: (projectRoot: string) => Promise<string | null> | string | null
  /** The app-wide default runtime, read lazily so a settings change applies to
   *  threads created after it (no restart). Absent → no global default. */
  globalProviderDefault?: () => string | null
  /**
   * Give the thread its own checkout, if it should have one (thread-worktrees
   * Phase 5). Awaited in `sendMessage` BEFORE the session is created, because
   * the session's root is fixed at spawn (`sessionRootFor`) and no later
   * creation moves it. MUST NOT throw and MUST NOT ask the user anything — a
   * message is never lost to it. Absent → no thread ever gets a checkout, which
   * is the app exactly as it was before this existed.
   *
   * `firstTurn` IS REQUIRED, not optional, because what it gates is a thing
   * that must happen exactly once per conversation — the folder-behind notice —
   * and an optional flag is a flag some future caller forgets, silently turning
   * "said once" into "said on every relaunch" (allowed-pattern #26).
   */
  ensureThreadWorktree?: (threadId: string, context: { firstTurn: boolean }) => Promise<void>
  /**
   * Wait for a dependency promotion this thread owes from its last turn.
   *
   * Absent → nothing is ever owed, which is every caller that runs no
   * worktrees. See `ThreadWorktreeService.settleDependencies`.
   */
  settleThreadDependencies?: (threadId: string) => Promise<void>
  /**
   * Directory holding the files a person attached to this thread, or null.
   *
   * Read-only, and only ever added to the READ containment roots — see
   * `readRoots`. Absent → attachments are not readable, which is the behaviour
   * before they existed.
   */
  attachmentRoot?: (threadId: string) => string | null
  /**
   * The thread's auto-title has settled after a successful turn. Fired AFTER
   * `maybeGenerateTitle` resolves, not beside it: the thread's checkout is named
   * from that title, and a hook running in parallel would name it from the
   * previous one (thread-worktrees Phase 5). Best-effort; never blocks a turn.
   */
  onThreadTitleSettled?: (threadId: string) => void
  /** Build the Codex runtime for a codex-provider thread (tests inject a fake).
   *  Default: a real CodexRuntime driving the `codex` binary. */
  codexRuntimeFactory?: () => AgentRuntime
  /** Build the Copilot runtime for a copilot-provider thread (tests inject a
   *  fake). Default: a real CopilotRuntime driving the `copilot` binary. */
  copilotRuntimeFactory?: () => AgentRuntime
  /**
   * The user's OWN MCP servers for a project, merged into a Claude session's
   * `mcpServers` beside the `flow` board server (see external-mcp.ts). Injectable
   * so tests are not at the mercy of the dev machine's real `~/.claude.json`;
   * default reads the real config files, fail-soft. Absent → the real reader.
   */
  loadExternalMcpServers?: (projectRoot: string) => Record<string, McpServerConfig>
  /**
   * THE CONTEXT GATE (Workspaces Phase 7). On a thread's first send — awaited
   * BEFORE the session is created, because a session's folders are fixed when
   * it spawns — it may attach other projects of the thread's Workspace; on
   * later sends it may OFFER one (never attaches). Bounded and fail-soft: it
   * never throws and never waits past its own timeout. Absent → no thread
   * ever gains a project on its own, which is the app exactly as before.
   */
  contextGate?: ContextGate
  /**
   * May a native-containment runtime (Codex, Copilot) WRITE this attached root?
   * True for a registered project and for a thread's checkout — the address
   * gate (addressable-roots.ts). Attached roots are rows in the thread store,
   * and a row is not proof that the folder is a project: a stale or crafted one
   * must not become a writable sandbox root. ABSENT → no attached root is
   * granted (fail closed, forbidden-pattern #15); production always passes it.
   */
  isAttachableRoot?: (root: string) => boolean
  /**
   * BASIC DISCOVERY BEFORE A CONVERSATION (learn/basic-discovery.ts). A
   * thread's FIRST message waits until its project has its basic discovery —
   * it is stored at once, the thread says why it waits, and it is delivered
   * when the sweep ends (or the sweep's failure is shown with Try again). An
   * attached project still being learned is kept out of the session's folders
   * and joins on the first send after its sweep. Absent → nothing waits, the
   * app exactly as before.
   */
  basicDiscovery?: Pick<BasicDiscovery, 'require' | 'whenSettled' | 'isDeferred'>
}

/** One message stored while its thread waits on a basic discovery. */
interface HeldMessage {
  content: string
  attachments: readonly MessageAttachmentInput[] | undefined
  sendOptions: SendMessageOptions
  isFirstTurn: boolean
}

/** A thread whose first message waits on its project's basic discovery. */
interface HeldSend {
  roots: string[]
  names: string[]
  /** `delivering` = the discovery is done and the queue is being sent. */
  state: 'waiting' | 'failed' | 'delivering'
  detail?: string
  queue: HeldMessage[]
}

/** A project's display name: its folder's own name (never a path on screen). */
function projectDisplayName(root: string): string {
  return basename(root.replace(/[\\/]+$/, '')) || root
}

/** Per-send choices the person made in the composer. */
export interface SendMessageOptions {
  /** The person hand-picks this thread's projects: the context gate does not run. */
  skipContextGate?: boolean
}

/** Thrown when a project's bound account cannot run — fail-closed (never
 *  substitutes another account). Surfaced to the user via markThreadFailed. */
/** Tools a Flow session never offers the agent — see buildSessionOptions. */
export const FLOW_DISALLOWED_TOOLS = ['EnterPlanMode', 'ExitPlanMode'] as const

export class AccountUnavailableError extends Error {
  constructor(label: string, reason: string) {
    super(
      `Account "${label}" is unavailable for this project: ${reason}. ` +
        'Re-login or reassign the account in settings before running here.',
    )
    this.name = 'AccountUnavailableError'
  }
}

/** SDK session hooks shape (Options.hooks with the optionality removed). */
export type SessionHooks = NonNullable<Options['hooks']>

/**
 * Per-session hooks supplier — called once per session creation with the
 * thread being started so coordinators can attach thread-scoped hooks (e.g.
 * the terminal bash-mirror) without AgentManager knowing about their domain.
 */
export type SessionHooksProvider = (thread: ThreadRecord) => SessionHooks

/**
 * A live thread session (multi_runtime_support). Discriminated by `provider`:
 * the Claude session carries the SDK Query + StreamBridge it always has; a
 * non-Claude runtime session (Codex) carries a RuntimeSession + a persistence
 * sink instead. Branching on `provider` is enforced by the compiler — an
 * unguarded `.query`/`.bridge`/`.input` access is a type error.
 */
type ThreadSession = ClaudeThreadSession | RuntimeThreadSession

interface ClaudeThreadSession {
  provider: 'claude'
  threadId: string
  query: Query
  input: AsyncMessageQueue
  abortController: AbortController
  bridge: StreamBridge
  /** SDK session id this session was created to RESUME, or null for a fresh
   *  session. A resume that targets a session the SDK no longer knows about
   *  throws mid-stream; this lets runSession recover by restarting fresh. */
  resumedFrom: string | null
  /** The thread's attached projects when this session was created (`projectsKey`). */
  projectsKey: string
}

interface RuntimeThreadSession {
  /** Any non-Claude runtime (Codex, Copilot) — they share this session shape. */
  provider: Exclude<ProviderId, 'claude'>
  threadId: string
  /** The runtime session — NULL until the first turn (these runtimes are
   *  one-shot-per-turn: they spawn with the prompt, which only arrives on
   *  sendMessage). */
  runtime: RuntimeSession | null
  /** Persists the runtime's normalized events to the store (transcript reload). */
  sink: RuntimeEventSink
  abortController: AbortController
  /** Runtime session id to resume, or null for a fresh rollout. */
  resumedFrom: string | null
  /** The thread's attached projects when this session was created (`projectsKey`). */
  projectsKey: string
}

/**
 * The identity of the folders a thread's session works in beyond its own —
 * each attached project AS ITS THREAD CHECKOUT when it has one
 * (getThreadSessionRoots). Compared at each send: a project attached or
 * detached, or a checkout cut or released for one, changes the folders a
 * session must be started with, so the next turn restarts it.
 */
function projectsKey(roots: readonly string[]): string {
  return JSON.stringify([...new Set(roots)].sort())
}

/** Statuses in which a thread has no turn in flight and no question waiting. */
const RESTING_STATUSES: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>(['idle', 'done', 'failed'])

const SDK_MODULE_SPECIFIER = '@anthropic-ai/claude-agent-sdk'
const EFFORT_LEVELS = ['low', 'medium', 'high'] as const

/** Titles that mean "not yet named" — auto-titling only overwrites these. */
const DEFAULT_THREAD_TITLES = new Set(['New thread', 'Untitled thread', 'Untitled'])
/** Model alias for the cheap one-shot title summarizer. */
const TITLE_MODEL = 'haiku'
/** Model for the task technical brief — a touch more capable than titling. */
const BRIEF_MODEL = 'sonnet'
/** Cap on title length before ellipsizing. */
const MAX_TITLE_CHARS = 60

export class AgentManager extends EventEmitter {
  private readonly sessions = new Map<string, ThreadSession>()
  /** threadId → does its runtime offer shortening (#1955). Per session. */
  private readonly shortenSupport = new Map<string, boolean>()
  /**
   * What each thread is still waiting on after its turn ended.
   *
   * ONE TRACKER FOR THE WHOLE MANAGER, not one per session. The surfaces that
   * ask "what is this thread still owed" ask across every thread at once —
   * from an IPC handler with no session in hand — and a session is exactly the
   * thing that ends while the work continues.
   *
   * In memory and never persisted: the runtime's level signal is per CLI
   * process and emits nothing at startup, so a set read back from disk would
   * describe a process that no longer exists and spin forever with nothing
   * left to clear it.
   */
  private readonly backgroundTasks = new BackgroundTaskTracker()
  /** In-flight session creations — reserved synchronously so concurrent
   *  sendMessage calls share ONE creation instead of racing (LOG-1). */
  private readonly sessionCreations = new Map<string, Promise<ThreadSession>>()
  private queryFnPromise: Promise<QueryFunction> | null = null
  private editTracker: EditTracker | null = null
  private sessionHooksProvider: SessionHooksProvider | null = null
  private boardToolsProvider: BoardToolsProvider | null = null
  /** Threads with an in-flight auto-title generation (dedupes concurrent turns). */
  private readonly titling = new Set<string>()
  /** AskUserQuestion dialogs → the renderer's inline question card. */
  private readonly dialogs = new UserDialogBroker()
  /** Auto-attach debounce — once per root per turn (phase 6). */
  private readonly attachTracker = new TurnAttachTracker()

  constructor(
    private readonly threadStore: ThreadStore,
    private readonly credentials: CredentialsManager,
    private readonly permissions: PermissionBroker,
    private readonly options: AgentManagerOptions = {},
    /** Image-attachment persistence (#456); optional so tests can omit it. */
    private readonly attachmentStore?: AttachmentStore,
  ) {
    super()
    // Surface permission + dialog requests on the manager so the IPC layer
    // wires one object instead of several.
    this.permissions.on(PERMISSION_REQUEST_EVENT, (request: PermissionRequest) => {
      // #949: a parked ask flips the thread row to 'needs-decision' so a
      // blocked turn is discoverable from OUTSIDE the thread — without this, an
      // ask raised while the user reads another thread gave no sign anywhere
      // that the agent was waiting. respondPermission restores 'working'.
      // Guarded — updateThread throws on an unknown thread, and this listener
      // runs inside the broker's park path, which must never break.
      if (this.threadStore.getThread(request.threadId)) {
        this.threadStore.updateThread(request.threadId, { status: 'needs-decision' })
        this.emitStream({ kind: 'status', threadId: request.threadId, status: 'needs-decision' })
      }
      this.emit(PERMISSION_REQUEST_EVENT, request)
    })
    this.dialogs.on(DIALOG_REQUEST_EVENT, (request: UserQuestionRequest) => {
      // #949 sibling: an agent ASKING A QUESTION (AskUserQuestion) flips the row
      // to 'needs-decision', exactly as a parked permission does — so a turn
      // waiting on the user is discoverable from OUTSIDE the thread (the sidebar
      // dot AND the board card). Without this, a question raised while the user
      // reads another thread gave no sign anywhere. #restoreAfterAsk restores
      // 'working' once no ask of any kind remains. Guarded — the thread may have
      // been deleted between the ask and this handler.
      if (this.threadStore.getThread(request.threadId)) {
        this.threadStore.updateThread(request.threadId, { status: 'needs-decision' })
        this.emitStream({ kind: 'status', threadId: request.threadId, status: 'needs-decision' })
      }
      this.emit(DIALOG_REQUEST_EVENT, request)
    })
    this.dialogs.on(DIALOG_CANCEL_EVENT, (cancel: DialogCancel) => {
      // The user moved on — sent a plain message instead of answering (#692).
      // The parked questions are gone, so the thread should leave 'needs-decision'
      // if nothing else holds it (the ensuing turn also sets 'working', but this
      // makes the un-park itself restore, discovery R4).
      this.#restoreAfterAsk(cancel.threadId)
      this.emit(DIALOG_CANCEL_EVENT, cancel)
    })
    // AskUserQuestion comes through canUseTool — render the picker there and
    // return the answers on the tool input (the CLI's real SDK-mode channel).
    this.permissions.setQuestionAsker((threadId, input, signal) =>
      this.dialogs.askForToolInput(threadId, input, signal),
    )
    // A deleted thread's live SDK session must be torn down, or it keeps
    // streaming into a thread that no longer exists. Covers every delete path
    // (threads:delete and task delete, which cascades to deleteThread).
    this.threadStore.on(THREAD_STORE_CHANGE_EVENT, (event: ThreadChangeEvent) => {
      if (event.entity === 'thread' && event.action === 'deleted') {
        this.disposeThread(event.threadId)
        this.options.contextGate?.forgetThread(event.threadId)
        this.#held.delete(event.threadId)
      }
    })
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Wire the inline-diff-review edit tracker (ADR-001). Approved Edit/Write
   * tool calls feed the tracker at the canUseTool gate (before-content read
   * ahead of the SDK's write), and a PostToolUse hook verifies the applied
   * change against the prediction on sessions created from now on. The
   * approval flow itself is unchanged.
   */
  attachEditTracker(tracker: EditTracker): void {
    this.editTracker = tracker
    this.permissions.setApprovedToolObserver((call) => tracker.captureApprovedEdit(call))
  }

  /** The attached tracker, for git-state reconciliation wiring (#893). */
  getEditTracker(): EditTracker | null {
    return this.editTracker
  }

  /**
   * Supply thread-scoped SDK hooks for sessions created from now on (e.g.
   * the terminal bash-mirror). Merged with AgentManager's own hooks — the
   * provider's matchers run alongside, never instead of, internal ones.
   */
  setSessionHooksProvider(provider: SessionHooksProvider): void {
    this.sessionHooksProvider = provider
  }

  /**
   * Supply the in-process `flow` board tools for user-chat sessions created from
   * now on. Decoupled exactly like the seed provider and the hooks provider:
   * AgentManager never knows about the board or its stores, only that a provider
   * may hand it an `mcpServers` fragment to attach. Absent → no board tools.
   */
  setBoardToolsProvider(provider: BoardToolsProvider): void {
    this.boardToolsProvider = provider
  }

  /**
   * Persist a user message and feed it to the thread's session, creating or
   * resuming the session on demand. Resolves as soon as the turn starts —
   * the response arrives as stream events.
   */
  async sendMessage(
    threadId: string,
    content: string,
    attachments?: readonly MessageAttachmentInput[],
    sendOptions: SendMessageOptions = {},
  ): Promise<{ messageId: string }> {
    // A SEND WHILE A SESSION IS STILL BEING DECIDED WAITS ITS TURN. With the
    // context gate on, a thread's first send awaits the gate (up to its
    // timeout) before any session exists. A second send in that window used
    // to find no session, see the gate "already decided", and start the
    // session itself — without the projects the gate was about to attach, and
    // ahead of the first message. Every send made before the session exists is
    // chained behind the one before it, so the first send's decision, its
    // session and its message all land first.
    const prior = this.#sessionlessSends.get(threadId)
    if (
      prior === undefined &&
      (this.options.contextGate === undefined || this.sessions.has(threadId)) &&
      !this.#held.has(threadId)
    ) {
      return this.#sendMessageNow(threadId, content, attachments, sendOptions)
    }
    const run = (async (): Promise<{ messageId: string }> => {
      if (prior !== undefined) {
        // The earlier send's own caller hears about its failure; this one only waits for it.
        await prior.catch(() => undefined)
      }
      return this.#sendMessageNow(threadId, content, attachments, sendOptions)
    })()
    this.#sessionlessSends.set(threadId, run)
    try {
      return await run
    } finally {
      if (this.#sessionlessSends.get(threadId) === run) this.#sessionlessSends.delete(threadId)
    }
  }

  /** Sends made before a thread's session exists, chained per thread (see sendMessage). */
  readonly #sessionlessSends = new Map<string, Promise<unknown>>()

  async #sendMessageNow(
    threadId: string,
    content: string,
    attachments: readonly MessageAttachmentInput[] | undefined,
    sendOptions: SendMessageOptions,
  ): Promise<{ messageId: string }> {
    const thread = this.threadStore.getThread(threadId)
    if (!thread) {
      throw new Error(`[AgentManager] Cannot send to unknown thread: ${threadId}`)
    }

    // The user sent a message instead of answering a pending question — treat
    // that as ignoring it (#692): cancel the parked dialog so the agent unblocks
    // (proceeds with the AskUserQuestion "no answer" default) and the renderer
    // drops the stale card, rather than the never-drop queue re-showing it on the
    // next feed rebuild. No-op when nothing is parked for this thread.
    this.dialogs.cancelThreadQuestions(threadId)

    const message = this.threadStore.appendMessage(threadId, 'user', content)
    // Persist image attachments (bytes on disk, metadata in the DB) so they survive
    // reload/resume and render in the transcript (#456).
    if (attachments && attachments.length > 0) {
      this.attachmentStore?.save(threadId, message.id, attachments)
    }
    // First turn = no assistant reply has landed yet. A task-seeded thread
    // prepends its issue context to the agent input on this turn only (the
    // stored user message stays verbatim). Keyed on assistant messages — not
    // total count — so a retry after a failed session-create still seeds.
    const isFirstTurn = !this.threadStore
      .listMessages(threadId)
      .some((entry) => entry.role === 'assistant')

    // A THREAD ALREADY WAITING ON A BASIC DISCOVERY queues this message behind
    // the held one — stored, never dropped, delivered in order.
    const held = this.#held.get(threadId)
    if (held !== undefined) {
      held.queue.push({ content, attachments, sendOptions, isFirstTurn: false })
      return { messageId: message.id }
    }

    // ONLY ON A PROJECT FLOW HAS LEARNED. The first message of a thread whose
    // project lacks its basic discovery starts (or joins) that sweep at the
    // front of the queue and waits for it — the message is stored above, the
    // thread says why it waits, and it goes out when the sweep ends.
    const learning = this.options.basicDiscovery
    if (learning !== undefined && isFirstTurn && !this.sessions.has(threadId)) {
      const { learning: lacking } = await learning.require([thread.projectRoot], { priority: true, retry: true })
      if (lacking.length > 0) {
        this.#hold(threadId, lacking, { content, attachments, sendOptions, isFirstTurn })
        return { messageId: message.id }
      }
    }

    await this.#deliver(threadId, thread, content, attachments, sendOptions, isFirstTurn)
    return { messageId: message.id }
  }

  /** Threads whose first message waits on a basic discovery. */
  readonly #held = new Map<string, HeldSend>()

  #emitLearningFirst(threadId: string, held: HeldSend | null, state: LearningFirstState['state']): void {
    this.emitStream({
      kind: 'learning-first',
      threadId,
      state,
      projects: held?.names ?? [],
      ...(state === 'failed' && held?.detail !== undefined ? { detail: held.detail } : {}),
    })
  }

  #hold(threadId: string, roots: string[], first: HeldMessage): void {
    const held: HeldSend = { roots, names: roots.map(projectDisplayName), state: 'waiting', queue: [first] }
    this.#held.set(threadId, held)
    this.#emitLearningFirst(threadId, held, 'waiting')
    void this.#awaitHeld(threadId, held)
  }

  /** Wait for the held thread's discoveries; then deliver, or say why not. */
  async #awaitHeld(threadId: string, held: HeldSend): Promise<void> {
    const learning = this.options.basicDiscovery
    if (learning === undefined) return
    const answers = await Promise.all(held.roots.map((root) => learning.whenSettled(root)))
    if (this.#held.get(threadId) !== held) return // deleted, or replaced
    const failed = answers.find((answer): answer is { ok: false; reason: string } => !answer.ok)
    if (failed !== undefined) {
      held.state = 'failed'
      held.detail = learningFirstFailed(held.names, failed.reason)
      this.#emitLearningFirst(threadId, held, 'failed')
      return
    }
    held.state = 'delivering'
    this.#emitLearningFirst(threadId, held, 'done')
    try {
      // Drained one at a time: a message sent while these go out joins the
      // queue (the hold is still in the map) and is delivered after them.
      for (let next = held.queue.shift(); next !== undefined; next = held.queue.shift()) {
        const thread = this.threadStore.getThread(threadId)
        if (thread === null || thread === undefined) return
        await this.#deliver(threadId, thread, next.content, next.attachments, next.sendOptions, next.isFirstTurn)
      }
    } catch (error) {
      // #deliver marked the thread failed and said so in it; the message is in
      // the history either way.
      console.warn('[AgentManager] a held message could not be delivered', error)
    } finally {
      if (this.#held.get(threadId) === held) this.#held.delete(threadId)
    }
  }

  /**
   * Try again (the held thread's failure card): re-run the discoveries it
   * waits on — lifting a pause the learner put on itself — and wait again.
   */
  async retryLearningFirst(threadId: string): Promise<void> {
    const held = this.#held.get(threadId)
    const learning = this.options.basicDiscovery
    if (held === undefined || held.state !== 'failed' || learning === undefined) return
    held.state = 'waiting'
    delete held.detail
    this.#emitLearningFirst(threadId, held, 'waiting')
    await learning.require(held.roots, { priority: true, retry: true })
    void this.#awaitHeld(threadId, held)
  }

  /** The held first message's state, for a pane that opens mid-wait. */
  learningFirstState(threadId: string): LearningFirstState | null {
    const held = this.#held.get(threadId)
    if (held === undefined || held.state === 'delivering') return null
    return {
      state: held.state,
      projects: [...held.names],
      ...(held.state === 'failed' && held.detail !== undefined ? { detail: held.detail } : {}),
    }
  }

  /**
   * The folders a session gets beyond its own: each attached project's thread
   * checkout — except a project whose basic discovery is still running or
   * failed, which joins on the first send after it is learned.
   */
  #sessionRoots(threadId: string): string[] {
    const learning = this.options.basicDiscovery
    return this.threadStore.getThreadSessionRoots(
      threadId,
      learning === undefined ? undefined : (root) => learning.isDeferred(root),
    )
  }

  /** The rest of a send, once its message is stored and nothing holds it. */
  async #deliver(
    threadId: string,
    thread: ThreadRecord,
    content: string,
    attachments: readonly MessageAttachmentInput[] | undefined,
    sendOptions: SendMessageOptions,
    isFirstTurn: boolean,
  ): Promise<void> {
    // THE CONTEXT GATE (Workspaces Phase 7) — BEFORE the checkout is cut and
    // before the session spawns: the projects it attaches get their thread
    // checkouts from the same `ensureThreadWorktree` below (as a manual attach
    // does), and the session's folders are read when it is created. Bounded
    // and fail-soft: the worst it costs is its timeout, and the thread then
    // runs in its own project. Later sends only ever get an OFFER, off the
    // send path — it never attaches and never delays a turn.
    const gate = this.options.contextGate
    if (gate !== undefined) {
      if (isFirstTurn && !this.sessions.has(threadId)) {
        await gate.beforeFirstSession({
          threadId,
          projectRoot: thread.projectRoot,
          prompt: content,
          skip: sendOptions.skipContextGate === true,
        })
      } else if (!isFirstTurn) {
        void gate
          .afterLaterSend({ threadId, projectRoot: thread.projectRoot, prompt: content })
          .catch((error: unknown) => console.warn('[AgentManager] context offer check failed', error))
      }
    }

    // THE ATTACHED PROJECTS GO THROUGH THE SAME DOOR (one code path): any of
    // them without basic discovery has its sweep started (or tried again —
    // sending is a person acting) and is left out of the session's folders
    // until it is learned. Its chip says "Learning…" meanwhile.
    if (this.options.basicDiscovery !== undefined) {
      await this.options.basicDiscovery.require(this.threadStore.getThreadRoots(threadId), { retry: true })
    }

    // A THREAD'S PROJECTS CHANGED SINCE ITS SESSION STARTED (an attach or a
    // detach — the offer accepted, a chip removed). A session's folders are
    // fixed when it spawns: the SDK's additionalDirectories, Codex's -C /
    // --add-dir / writable roots and Copilot's --add-dir are all start-time
    // arguments. So a resting session is stood down here and the turn below
    // starts a fresh one RESUMING the same conversation (sdkSessionId), with
    // the new folder set — and, through `ensureThreadWorktree`, a checkout for
    // a newly attached project. A thread mid-turn or waiting on a question
    // keeps its session; the change applies to the first send after it rests.
    this.standDownIfProjectsChanged(threadId)

    // THE THREAD'S OWN CHECKOUT IS CUT HERE, and only here (thread-worktrees
    // Phase 5). Before the session, because the session's root is fixed at
    // spawn and never moves again; only when one is about to spawn, because a
    // thread already running in the project's tree cannot be relocated
    // mid-life. A thread that never sends a message never reaches this line —
    // which is the whole of the chat-only guarantee.
    let current = this.threadStore.getThread(threadId) ?? thread
    if (this.options.ensureThreadWorktree && !this.sessions.has(threadId)) {
      await this.options.ensureThreadWorktree(threadId, { firstTurn: isFirstTurn })
      current = this.threadStore.getThread(threadId) ?? thread
    }
    // BEFORE THE NEXT ONE, and this await is what makes that a guarantee rather
    // than a hope. A promotion is started when a turn ENDS; a person who
    // answers inside the install window would otherwise open a turn against a
    // half-installed tree. Unlike the line above it, this runs for EVERY turn —
    // a session that is already alive is exactly the case a promotion follows.
    // Resolves immediately when nothing is owed, which is every turn but the
    // one after a lockfile changed.
    await this.options.settleThreadDependencies?.(threadId)

    // LOG-5: session creation can fail (SDK load, spawn). Surface it — mark
    // the thread failed and emit an error stream event before rethrowing,
    // so the renderer never sits on a persisted message with no outcome.
    let session: ThreadSession
    try {
      session = await this.ensureSession(current)
    } catch (error) {
      this.markThreadFailed(threadId, error instanceof Error ? error.message : String(error))
      throw error
    }

    // #981: a stale interrupt mark (stop requested but the settling result
    // never arrived) must not swallow THIS turn's genuine failure. Claude only —
    // Codex has no StreamBridge.
    if (session.provider === 'claude') {
      session.bridge.clearInterruptRequested()
    }

    this.threadStore.updateThread(threadId, { status: 'working' })
    this.emitStream({ kind: 'status', threadId, status: 'working' })
    this.options.onTurnStart?.(threadId)
    // Auto-attach debounces once per root per TURN (phase 6) — a new turn
    // starts with a clean slate.
    this.attachTracker.beginTurn(threadId)

    // Brain-first compact block (brain-first-retrieval): first turn only, and
    // only when the CLI shim is on PATH — never instruct a verb that isn't
    // there (fail-soft: null cliShimDir just means no brain-first nudge).
    const brainFirst =
      isFirstTurn && this.options.cliShimDir ? BRAIN_FIRST_COMPACT : null
    const seed = isFirstTurn ? this.options.seedProvider?.(threadId) : null
    // A RUNTIME THAT DOES NOT READ .claude/commands GETS THE COMMAND EXPANDED
    // HERE (slash-command.ts): Copilot answered `/discovery-plan` with "Skill
    // not found" and improvised the discovery from the last one on disk.
    // Claude Code expands it itself, so its text goes through untouched.
    const turnText =
      session.provider === 'claude'
        ? content
        : await expandSlashCommand(content, [sessionRootFor(thread), thread.projectRoot])
    const seededText = [brainFirst, seed, turnText]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n\n')
    if (session.provider !== 'claude') {
      // Non-Claude runtimes are one-shot-per-turn: cold-start the first turn with
      // this prompt, resume the rollout on later turns. Text only in v1 (no
      // vision blocks).
      await this.startOrSendRuntimeTurn(session, thread, seededText)
    } else {
      session.input.push({
        type: 'user',
        // buildUserContent → a plain string when there are no attachments (unchanged),
        // else a text + image-block array the SDK accepts as vision input (#456).
        message: { role: 'user', content: buildUserContent(seededText, attachments) },
        parent_tool_use_id: null,
      })
    }
  }

  /**
   * Every thread's live background work, keyed by thread id.
   *
   * What a surface reads when it MOUNTS mid-run — the stream carries every
   * change from then on, but a sidebar opened while four agents are already
   * running has missed all of them, and the runtime will not re-announce a set
   * that has not changed.
   */
  listBackgroundTasks(): Record<string, BackgroundTaskInfo[]> {
    return this.backgroundTasks.snapshot()
  }

  /**
   * Forget a thread's background work — it was deleted, or its work is over.
   *
   * Broadcasts the empty set rather than leaving the last one standing: a row
   * that outlives the thread it belongs to is exactly the stale spinner the
   * runtime's level signal exists to prevent.
   */
  clearBackgroundTasks(threadId: string): void {
    if (this.backgroundTasks.reset(threadId)) {
      this.emitStream({ kind: 'background-tasks', threadId, tasks: [] })
    }
  }

  /** Interrupt the thread's in-flight turn. No-op when nothing is running. */
  async interrupt(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session) return
    // #1909: a user who STOPS the stream while the agent is parked on an
    // AskUserQuestion is done with that question — the turn that asked it is
    // being killed and can never read an answer. Cancel the parked dialog so the
    // promise resolves (the tool proceeds with its "no answer" default) AND the
    // renderer drops the card via DIALOG_CANCEL_EVENT; without this the question
    // component stays on screen forever. Same treatment as sendMessage (#692).
    // No-op when nothing is parked (e.g. a non-claude turn with no dialog).
    this.dialogs.cancelThreadQuestions(threadId)
    if (session.provider !== 'claude') {
      // Kill the in-flight codex turn; the rollout stays resumable.
      session.runtime?.interrupt()
      this.threadStore.updateThread(threadId, { status: 'idle' })
      this.emitStream({ kind: 'status', threadId, status: 'idle' })
      return
    }
    // #981: mark BEFORE the stop — the aborted turn's result message can land
    // while the interrupt is in flight, and the bridge must already know this
    // stop was user-initiated (else it classifies the non-success result as a
    // crash: status 'failed' + a raw SDK diagnostic in the transcript).
    session.bridge.markInterruptRequested()
    // #1927: recover the UI NOW, the way the non-claude branch above already
    // does — do not gate it on the SDK acknowledging. `query.interrupt()` is a
    // COOPERATIVE stop: when the turn is parked in a long tool call (a long
    // Bash, a nested sub-agent/Task, a slow MCP call) its ack is delayed or
    // never arrives. This flip used to sit in a `finally` after `await
    // query.interrupt()`, so a non-acking turn left the thread stuck on
    // "Working…" forever. Finalize the open tool calls (LOG-6) and emit idle
    // synchronously, then ask the SDK to stop best-effort without blocking on it
    // (matching claude-runtime.ts's own fire-and-forget interrupt). The session
    // stays open, so a later send resumes it.
    session.bridge.abortOpenToolCalls('interrupted')
    this.threadStore.updateThread(threadId, { status: 'idle' })
    this.emitStream({ kind: 'status', threadId, status: 'idle' })
    void session.query.interrupt().catch(() => {
      // A rejected interrupt (already-torn stream, etc.) must not surface — the
      // thread is already recovered, and the bridge's #981 result-time path
      // settles idempotently if the turn ever does report back.
    })
  }

  /**
   * Persist a model/effort selection and apply the model to the live session
   * if one is running (effort applies from the next session).
   */
  /**
   * How full this thread's context window is, or null (#1955).
   *
   * The SDK already resolves this against the model that is actually
   * answering — including a smaller compaction-policy window where one
   * applies — so Flow asks it rather than keeping a window table of its own.
   * A table would be wrong the week a model ships, which is the defect this
   * feature exists to end, not one to re-create one layer up (#1956).
   *
   * `detail: 'summary'` answers from the last response's usage and local
   * estimates. It makes NO token-count API calls, which is what lets the
   * footer ask after every turn.
   *
   * Null for every case where there is nothing honest to say: no live
   * session, a non-Claude runtime (Codex exposes no equivalent), or an SDK
   * that refuses. Never a default window — see `shared/context-usage.ts`.
   */
  async contextUsage(threadId: string): Promise<ContextUsageSnapshot | null> {
    const session = this.sessions.get(threadId)
    if (!session || session.provider !== 'claude') return null
    try {
      const usage = await session.query.getContextUsage({ detail: 'summary' })
      const maxTokens = usage.rawMaxTokens > 0 ? usage.rawMaxTokens : usage.maxTokens
      return {
        totalTokens: usage.totalTokens,
        maxTokens,
        model: typeof usage.model === 'string' ? usage.model : null,
        canShorten: await this.#canShorten(session),
      }
    } catch {
      // An older CLI, a closed session, a control request that times out. The
      // footer shows what it showed before this feature existed; nothing in a
      // thread should fail because a readout could not be taken.
      return null
    }
  }

  /**
   * Does this session offer a way to shorten the conversation?
   *
   * ASKED, not assumed. The command is the runtime's, not Flow's, and a button
   * that sends one the session does not have is a control that silently does
   * nothing. Resolved once per session and cached: the command list does not
   * change mid-session, and this is read after every turn.
   *
   * Matched on `name` and on `aliases`, because the SDK is explicit that an
   * alias resolves to the command (`/cost` and `/stats` both reach `/usage`).
   */
  async #canShorten(session: ClaudeThreadSession): Promise<boolean> {
    const cached = this.shortenSupport.get(session.threadId)
    if (cached !== undefined) return cached
    try {
      const commands = await session.query.supportedCommands()
      const supported = commands.some(
        (command) =>
          command.name === SHORTEN_COMMAND || (command.aliases ?? []).includes(SHORTEN_COMMAND),
      )
      this.shortenSupport.set(session.threadId, supported)
      return supported
    } catch {
      // Unknown is not yes. An older CLI that cannot answer gets no button.
      return false
    }
  }

  async setModel(threadId: string, selection: ModelSelection): Promise<void> {
    this.threadStore.updateThread(threadId, {
      model: selection.model,
      effort: selection.effort ?? null,
    })
    // The explicit pick becomes the preference future threads start from (#848).
    this.options.saveDefaultModelSelection?.(selection)
    const session = this.sessions.get(threadId)
    if (session) {
      // 'auto' routes by effort through the user's map (#129) so a mid-session
      // switch to Auto applies the routed model, matching a fresh turn.
      let resolved: string | undefined
      if (selection.model !== 'auto') {
        resolved = selection.model
      } else if (this.options.getModelRouting) {
        resolved = resolveAutoModel(
          parseEffort(selection.effort ?? null) ?? 'medium',
          this.options.getModelRouting(),
        )
      }
      if (session.provider !== 'claude') {
        // A codex turn's model is fixed at spawn; this applies from the next turn.
        if (typeof resolved === 'string' && resolved.length > 0) {
          session.runtime?.setModel(resolved)
        }
      } else {
        await session.query.setModel(resolved)
      }
      // Emit the new live model so the UI (usage line + composer indicator)
      // stays in sync — the SDK only reports the model on session init, so a
      // mid-thread switch would otherwise keep showing the previous model (#151).
      if (typeof resolved === 'string' && resolved.length > 0) {
        this.emitStream({ kind: 'model', threadId, model: resolved })
      }
    }
  }

  /** Renderer verdict for a pending permission request. */
  respondPermission(requestId: string, verdict: PermissionVerdict): void {
    // Resolve the thread BEFORE responding — respond() removes the request
    // from the broker's pending map, taking its threadId with it.
    const parked = this.permissions
      .listPending()
      .find((request) => request.requestId === requestId)
    this.permissions.respond(requestId, verdict)
    if (!parked) return
    // #949: the parked ask was just answered — hand the row back to 'working'
    // once nothing else holds it (any verdict un-parks the turn; a deny just
    // makes the agent continue without that tool).
    this.#restoreAfterAsk(parked.threadId)
  }

  /**
   * Hand a thread back to 'working' once NO ask of any kind remains — neither a
   * parked permission (#949) NOR a parked AskUserQuestion dialog. One gate for
   * every answer/cancel path so a thread with BOTH a permission and a question
   * parked doesn't leave 'needs-decision' when only the first is answered
   * (discovery R5). Guarded on the current status so a race with interrupt/
   * teardown (which set 'idle'/'failed') never resurrects a dead turn as working.
   */
  #restoreAfterAsk(threadId: string): void {
    if (this.pendingPermissions(threadId).length > 0) return
    if (this.dialogs.pendingDialogs(threadId) > 0) return
    if (this.threadStore.getThread(threadId)?.status !== 'needs-decision') return
    this.threadStore.updateThread(threadId, { status: 'working' })
    this.emitStream({ kind: 'status', threadId, status: 'working' })
  }

  /** Permission asks still parked in the broker for a thread (#949 re-sync). */
  pendingPermissions(threadId: string): PermissionRequest[] {
    return this.permissions.listPending().filter((request) => request.threadId === threadId)
  }

  /**
   * Renderer answers for a pending AskUserQuestion dialog. Returns `false` when
   * the dialog is no longer pending (session crashed/disposed, #290), so the IPC
   * layer can reject rather than silently drop the answer.
   */
  respondDialog(requestId: string, answers: UserQuestionAnswer[]): boolean {
    // Resolve the thread BEFORE responding — respond() removes the dialog from
    // the broker's pending map, taking its threadId with it.
    const threadId = this.dialogs.threadOf(requestId)
    const ok = this.dialogs.respond(requestId, answers)
    // The question was just answered — restore 'working' once no ask remains
    // (a sibling permission or another parked question can still hold the row).
    if (ok && threadId !== null) this.#restoreAfterAsk(threadId)
    return ok
  }

  /** True when the thread has a live SDK session. */
  hasActiveSession(threadId: string): boolean {
    return this.sessions.has(threadId)
  }

  /**
   * Stand a resting session down when the thread's attached projects are no
   * longer the ones it was created with, so the next turn resumes with the
   * current folder set (see the call site in sendMessage). Returns whether it
   * did. Background work still running keeps the session — killing its CLI
   * process would kill that work.
   */
  private standDownIfProjectsChanged(threadId: string): boolean {
    const session = this.sessions.get(threadId)
    if (session === undefined) return false
    if (session.projectsKey === projectsKey(this.#sessionRoots(threadId))) return false
    const status = this.threadStore.getThread(threadId)?.status ?? null
    if (status !== null && !RESTING_STATUSES.has(status)) return false
    if (this.backgroundTasks.list(threadId).length > 0) return false
    this.disposeThread(threadId)
    return true
  }

  /**
   * One call to the fast model (haiku): a tool-less one-shot under the
   * project's bound account — the title generator's path, with a signal so a
   * caller's timeout really stops it. The context gate's model.
   */
  readonly askFastModel: FastModelCall = async ({ projectRoot, prompt, signal }) => {
    const abortController = new AbortController()
    if (signal.aborted) return null
    signal.addEventListener('abort', () => abortController.abort(), { once: true })
    const options: Options = {
      cwd: projectRoot,
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'default',
      model: TITLE_MODEL,
      abortController,
    }
    await this.applyAuthEnv(options, projectRoot)
    const text = (await this.runOneShot(prompt, options)).trim()
    return text === '' ? null : text
  }

  /** Dispose one thread's session (thread deleted / window closing). */
  disposeThread(threadId: string): void {
    this.attachTracker.clearThread(threadId)
    // The CLI process that owned this thread's background work is going away,
    // and it is the only thing that could ever have reported the work finished.
    // Cleared BEFORE the early return, because a thread with no live session
    // can still be carrying tasks — that is the whole state this exists for.
    this.clearBackgroundTasks(threadId)
    const session = this.sessions.get(threadId)
    if (!session) return
    this.sessions.delete(threadId)
    this.shortenSupport.delete(threadId)
    this.permissions.disposeThread(threadId)
    this.dialogs.disposeThread(threadId)
    if (session.provider !== 'claude') {
      // Dispose kills any in-flight turn and closes the child; the abort tears
      // down anything the runtime linked to the signal.
      session.runtime?.dispose()
      session.abortController.abort()
      return
    }
    // LOG-6: teardown must not strand 'running' tool calls — runSession's
    // finally skips them for a disposed session (its map entry is gone).
    session.bridge.abortOpenToolCalls('interrupted')
    session.input.end()
    session.abortController.abort()
    try {
      session.query.close()
    } catch (error) {
      console.error(`[AgentManager] Failed to close session for ${threadId}:`, error)
    }
  }

  /** Dispose every session (app shutdown). */
  dispose(): void {
    for (const threadId of Array.from(this.sessions.keys())) {
      this.disposeThread(threadId)
    }
  }

  // ── Session lifecycle ──────────────────────────────────────────────────

  private async ensureSession(thread: ThreadRecord): Promise<ThreadSession> {
    const existing = this.sessions.get(thread.id)
    if (existing) return existing

    // LOG-1: reserve the thread's slot SYNCHRONOUSLY (before any await) so
    // concurrent callers await the same creation — a check-then-act gap here
    // would spawn two live SDK sessions, one orphaned and uninterruptible.
    const inFlight = this.sessionCreations.get(thread.id)
    if (inFlight) return inFlight

    const creation = this.createSession(thread)
    this.sessionCreations.set(thread.id, creation)
    try {
      return await creation
    } finally {
      this.sessionCreations.delete(thread.id)
    }
  }

  private async createSession(thread: ThreadRecord): Promise<ThreadSession> {
    // The three resolutions below stay keyed to `thread.projectRoot` — the
    // PROJECT — even for a thread that owns a worktree: provisioning state,
    // the runtime provider and the bound account are all per-project settings,
    // and a worktree is deliberately never a registered project, so resolving
    // any of them against it would answer "unknown" and fail closed. Only the
    // SESSION moves into the worktree (buildSessionOptions).
    //
    // #513 phase 2: if the project is still being provisioned, wait (bounded)
    // for it to settle before spawning — a session started mid-provision would
    // race the bundled-CLI init (missing skills / .flowconfig / brain). Never
    // hard-blocks: the gate resolves on ready, failure, or timeout. A `ready`
    // root resolves instantly, so the common path pays nothing.
    if (this.options.awaitProvisioning) {
      await this.options.awaitProvisioning(thread.projectRoot)
    }
    // Resolve the runtime provider (multi_runtime_support). Claude runs the SDK
    // path below; every other known provider (Codex, Copilot) runs the shared
    // runtime-session path. An unknown provider already threw in resolveProvider
    // (fail-closed), so nothing silently degrades to Claude.
    const provider = await this.resolveThreadProvider(thread.projectRoot)
    // A hidden end-to-end run may stand in for the runtime (e2e-seams.ts —
    // null outside FLOW_E2E=1): the session takes the shared runtime path,
    // whatever the provider, so no CLI is spawned and no model is reached.
    if (e2eSeams()?.runtime !== undefined) {
      return this.createRuntimeSession(thread, provider === 'claude' ? 'codex' : provider)
    }
    if (provider !== 'claude') {
      return this.createRuntimeSession(thread, provider)
    }
    const queryFn = await this.loadQueryFn()
    // Resolve the project's account BEFORE spawning — an unavailable/dangling
    // account throws here (fail-closed) rather than starting under the wrong
    // account. Legacy (no accounts configured) resolves to null = today's auth.
    const accountConfigDir = await this.resolveAccountConfigDir(thread.projectRoot)
    const input = new AsyncMessageQueue()
    const abortController = new AbortController()
    const bridge = new StreamBridge(thread.id, this.threadStore, {
      onSessionId: (sessionId) => this.bindSessionId(thread.id, sessionId),
      emit: (event) => this.emitStream(event),
      onTurnComplete: (success) => {
        // A clean turn is the cue to name an as-yet-untitled thread. Best
        // effort — never blocks the turn, never fails it.
        // The checkout's branch is named from that title, so its hook is
        // chained BEHIND the title rather than beside it (Phase 5).
        if (success) {
          void this.maybeGenerateTitle(thread.id).then(() =>
            this.options.onThreadTitleSettled?.(thread.id),
          )
        }
        this.options.onTurnComplete?.(thread.id, success)
      },
      onToolCallRecorded: (observation) => {
        this.options.onToolCallRecorded?.({ threadId: thread.id, ...observation })
      },
      backgroundTasks: this.backgroundTasks,
    })
    // A FRESH CLI PROCESS OWES NOTHING YET. The runtime emits its live set only
    // when membership changes, never at startup, so anything left from the
    // previous process would sit in the list with nothing able to clear it.
    if (this.backgroundTasks.reset(thread.id)) {
      this.emitStream({ kind: 'background-tasks', threadId: thread.id, tasks: [] })
    }

    const options = this.buildSessionOptions(thread, abortController, accountConfigDir)
    // Board tools (Claude only): a user-chat session in a project with the setting
    // on gets the in-process `flow` server. The provider decides both gates and
    // returns null otherwise; a failure to build the tools must never fail the
    // session, so it is logged and the turn proceeds without them.
    if (this.boardToolsProvider) {
      try {
        const servers = await this.boardToolsProvider({
          threadId: thread.id,
          // The registered PROJECT, not the session's worktree — the board is
          // keyed by project.
          projectRoot: thread.projectRoot,
        })
        if (servers) options.mcpServers = { ...(options.mcpServers ?? {}), ...servers }
      } catch (error) {
        console.error('[AgentManager] board tools provider failed:', error)
      }
    }

    // The USER's own MCP servers (their `.mcp.json` / ~/.claude.json). Flow
    // otherwise injects only the `flow` board server, so a server the user
    // registered never reaches the session — the worktree cwd and the
    // account-isolated CLAUDE_CONFIG_DIR both defeat the SDK's own filesystem
    // discovery (see external-mcp.ts). Read off the REGISTERED project, not the
    // worktree, and merged UNDER the board server so it can never shadow `flow`.
    // loadExternalMcpServers is fail-soft; the guard is belt-and-braces so a
    // surprise here can never fail a session.
    try {
      const readExternal = this.options.loadExternalMcpServers ?? loadExternalMcpServers
      const external = readExternal(thread.projectRoot)
      if (Object.keys(external).length > 0) {
        options.mcpServers = { ...external, ...(options.mcpServers ?? {}) }
      }
    } catch (error) {
      console.error('[AgentManager] external MCP load failed:', error)
    }

    const query = queryFn({ prompt: input, options })

    const session: ThreadSession = {
      threadId: thread.id,
      provider,
      query,
      input,
      abortController,
      bridge,
      resumedFrom: thread.sdkSessionId ?? null,
      projectsKey: projectsKey(this.#sessionRoots(thread.id)),
    }
    this.sessions.set(thread.id, session)

    // Consume in the background — errors are contained per-thread.
    void this.runSession(session)

    return session
  }

  /**
   * Resolve which account's isolated CLAUDE_CONFIG_DIR this project's session
   * should use, or null for legacy auth. Fail-closed: an unavailable or
   * dangling account throws instead of falling back to another account.
   */
  private async resolveAccountConfigDir(projectRoot: string): Promise<string | null> {
    const resolver = this.options.accountResolver
    if (!resolver) return null
    const resolution = await resolver.resolveForSession(projectRoot)
    switch (resolution.status) {
      case 'legacy':
        return null
      case 'ready':
        return resolution.account.configDirPath
      case 'unavailable':
        throw new AccountUnavailableError(resolution.account.label, resolution.reason)
      case 'dangling':
        throw new AccountUnavailableError('(removed account)', resolution.reason)
    }
  }

  /**
   * The subprocess auth env for a resolved account. Account-bound → the account's
   * isolated CLAUDE_CONFIG_DIR with every inherited token STRIPPED (buildAccountEnv,
   * #107). Legacy (null) → the stored API key on the environment, or undefined to
   * inherit the CLI's auth. Shared by the session AND the one-shot generators so
   * titling/briefs/commit-messages authenticate as the SAME account (#237).
   */
  private authEnv(accountConfigDir: string | null): NodeJS.ProcessEnv | undefined {
    if (accountConfigDir !== null) return buildAccountEnv(accountConfigDir)
    const apiKey = this.credentials.get('anthropic')?.['apiKey']
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      return { ...process.env, ANTHROPIC_API_KEY: apiKey }
    }
    return undefined
  }

  /**
   * Apply the account-resolved auth env to a one-shot generator's options, so it
   * runs under the project's bound account like the main session — not legacy /
   * inherited auth (#237). Fails closed on an unavailable/dangling account
   * (resolveAccountConfigDir throws) rather than leaking to the wrong org.
   */
  private async applyAuthEnv(options: Options, projectRoot: string): Promise<void> {
    const env = this.authEnv(await this.resolveAccountConfigDir(projectRoot))
    if (env) options.env = env
  }

  /**
   * Resolve the runtime provider for a project: per-project `.flowconfig`
   * override ?? global default ?? legacy 'claude' (multi_runtime_support). An
   * unknown provider string throws from resolveProvider (fail-closed).
   */
  private async resolveThreadProvider(projectRoot: string): Promise<ProviderId> {
    const projectProvider = this.options.resolveProviderFor
      ? await this.options.resolveProviderFor(projectRoot)
      : null
    return resolveProvider({
      projectProvider,
      globalDefault: this.options.globalProviderDefault ? this.options.globalProviderDefault() : null,
    }).provider
  }

  private buildSessionOptions(
    thread: ThreadRecord,
    abortController: AbortController,
    accountConfigDir: string | null,
  ): Options {
    // Multi-project threads (#45): the primary is cwd; additional projects go
    // in additionalDirectories (SDK permission scope). A single-project thread
    // has zero extras, so `additionalDirectories` is omitted and the session is
    // byte-identical to before. The same root set drives permission containment.
    //
    // EACH OTHER PROJECT AS ITS THREAD CHECKOUT, when it has one — the same rule
    // `sessionRootFor` applies to the primary. Reading the attached projects
    // themselves (getThreadRoots) handed the session their MAIN checkouts, so a
    // thread isolated across two repos wrote into the reader's tree in the
    // second one.
    const additionalRoots = this.#sessionRoots(thread.id)
    // THE THREAD'S OWN CHECKOUT IS THE SESSION'S WORLD (thread worktrees).
    // `sessionRootFor` answers with the worktree when the thread owns one, and
    // with the project's tree when it does not — so everything below reads the
    // same root and a thread without a worktree keeps today's behaviour exactly.
    // Fixed at session start on purpose: cwd cannot move after spawn, so a
    // containment set that drifted from it would deny a live session its own
    // working directory.
    const primaryRoot = sessionRootFor(thread)
    const roots = [primaryRoot, ...additionalRoots]
    // THE SYMLINKED `flow/` MUST BE IN THE SDK'S SCOPE, or Bash cannot write it.
    //
    // `flow/` is normally a SYMLINK into the plan-flow vault
    // (`~/plan-flow/brain/projects/<project>/flow`). Two layers disagree about
    // that, and the disagreement is invisible until something breaks:
    //
    //   • Write/Edit/MultiEdit are widened by `isFlowArtifactPath`, which is
    //     LEXICAL and never follows the link — so writing `flow/x.md` is
    //     allowed, and always looked fine.
    //   • Bash is NOT in that set. A process it spawns is bound by the SDK's own
    //     sandbox (cwd + additionalDirectories), which RESOLVES the symlink and
    //     lands outside every root — so `planflow-ai blueprint propose`,
    //     `observe` and `narrate` were denied at the filesystem.
    //
    // The failure never said so: the store's lock treated the denial as
    // contention and reported `store busy — retry`, which cannot clear because
    // nothing is locked. `proposals.jsonl` was consequently never written by any
    // agent in any project.
    //
    // Resolving the link and handing the SDK its target closes the gap. This
    // widens scope to the project's OWN artifact directory — the same bytes the
    // Write tool has always been allowed to write — and to nothing else.
    const writableRoots = sessionWritableRoots(primaryRoot, additionalRoots)
    // The one Workspace-level file a skill writes (`links.jsonl`, via
    // `workspace link-knowledge`), granted as a FILE — never the Workspace
    // folder, which holds unattached siblings' knowledge and the repository the
    // app syncs (flow-artifacts.ts `workspaceAgentWriteFiles` says why). The
    // SDK puts `sandbox` in its flag-settings layer, which the CLI deep-merges
    // into the user's own (arrays concatenated), so this adds one path and
    // turns nothing on or off. Omitted outside a Workspace.
    const workspaceWriteFiles = sessionWorkspaceWriteFiles(primaryRoot, additionalRoots)
    // Live root set (phase 6): auto-attach can grow thread_roots MID-SESSION,
    // so the containment hooks re-read the store on every decision instead of
    // closing over the session-start snapshot. The SDK's own scope
    // (additionalDirectories / canUseTool's flow-artifact widening) stays the
    // session-start snapshot — the SDK Query offers no mid-session directory
    // grow — so under default permission mode the SDK may still prompt for the
    // newly attached root until the next session; the containment hook below
    // is the authority (plan Intent), and the attach + notice happen anyway.
    // Each root's own knowledge folder counts as the root (`containmentRoots`).
    const currentRoots = (): string[] => containmentRoots([primaryRoot, ...this.#sessionRoots(thread.id)])
    /**
     * Where reads may look: the thread's roots, plus the files the PERSON
     * attached to this conversation.
     *
     * READS ONLY, AND DELIBERATELY. Writes keep `currentRoots()` — the agent
     * may look at what it was handed and may not write into the store that
     * holds it. This does not widen what a session can reach on its own:
     * nothing lands in that directory except by somebody picking a file in the
     * composer, which is the same act as pasting its contents into the message.
     *
     * The case it exists for: a network capture in ~/Downloads. Reading it in
     * place is refused (correctly — a session is strict to its project), so the
     * file comes IN, and then it is readable because it is here.
     */
    const readRoots = (): string[] => {
      const attachments = this.options.attachmentRoot?.(thread.id) ?? null
      return attachments === null ? currentRoots() : [...currentRoots(), attachments]
    }
    // THE MAIN CHECKOUT IS NOT REACHABLE FROM A WORKTREE THREAD — not even by
    // auto-attach. Its whole point is that this session cannot touch the tree
    // the reader is standing in; a write there would otherwise be met by the
    // containment hook, recognised as a KNOWN project root, attached, and
    // allowed — re-opening the door through the one path that widens scope on
    // its own. Every OTHER known root still auto-attaches as before.
    //
    // The same holds for every OTHER project that has a thread checkout: its
    // main tree is not this session's, and a write there must be refused, not
    // re-attached (it is already attached — as its checkout).
    const knownRoots = (): readonly string[] => {
      const known = this.options.knownProjectRoots?.() ?? []
      const unreachable = new Set(
        this.threadStore.getThreadRootWorktrees(thread.id).map((entry) => entry.rootPath),
      )
      if (primaryRoot !== thread.projectRoot) unreachable.add(thread.projectRoot)
      if (unreachable.size === 0) return known
      return known.filter((root) => !unreachable.has(root))
    }
    // What this session is told about itself: the worktree situation line when
    // the thread has one, plus the turn-close answer shape, which every Claude
    // thread gets — so a chat-only session carries an append too.
    const briefing = sessionBriefing(thread)
    const sessionOptions: Options = {
      cwd: primaryRoot,
      // THE PRESET IS UNCONDITIONAL, AND THAT IS A DELIBERATE FLIP.
      //
      // This key used to be set only for a thread that HAD a worktree; a thread
      // with `worktreePath === null` omitted `systemPrompt` entirely. That
      // looked like "let the SDK use its default". It is not what the SDK does.
      // From the shipped bundle (@anthropic-ai/claude-agent-sdk 0.3.204,
      // `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`):
      //
      //   if (n === void 0) d = "";                  // omitted → EMPTY prompt
      //   else if (typeof n === "string") d = n;
      //   else if (Array.isArray(n)) d = n;
      //   else if (n.type === "preset") p = n.append; // preset → d stays undefined
      //   ...
      //   { systemPrompt: d, appendSystemPrompt: p, ... }
      //
      // Omitting the key sends `systemPrompt: ""` — an explicit override to an
      // EMPTY custom prompt, not an absent one. Passing the preset leaves
      // `systemPrompt` undefined (the CLI keeps its own `claude_code` prompt)
      // and routes our text to `appendSystemPrompt`.
      //
      // So the real change for a non-worktree thread is `""` → the full
      // `claude_code` preset plus this append: tool guidance, TodoWrite rules,
      // commit conventions, refusal policy, brevity rules and the dynamic
      // cwd/git/memory sections — none of which those threads had before.
      //
      // WHO WAS AFFECTED: every thread with no worktree — thread worktrees
      // switched off, a project that is not a git repo, or a cut that failed.
      // Those are chat-only sessions, and running them with no system prompt at
      // all was the oversight, not a feature: they were the threads MOST likely
      // to be answering with no tool guidance and no idea of their cwd.
      //
      // It is unconditional now because both halves need it. The preset is what
      // those threads should always have had, and the fold in the chat feed
      // needs the turn-close instruction on EVERY Claude thread (a folded turn
      // is headed by its closing words). Pinned by the "runs with the full
      // claude_code preset" test — do not make it conditional again without
      // reading that test's comment first.
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: briefing },
      // The resolved `flow/` targets ride alongside the multi-project extras:
      // same mechanism, different reason (see where they are computed).
      // Omitted entirely when empty, so a single-project thread with a plain
      // flow/ directory gets a byte-identical session to before.
      ...(writableRoots.length > 0 ? { additionalDirectories: writableRoots } : {}),
      ...(workspaceWriteFiles.length > 0
        ? { sandbox: { filesystem: { allowWrite: workspaceWriteFiles } } }
        : {}),
      abortController,
      includePartialMessages: true,
      // #1931: forward a sub-agent's full text/thinking (not just its tool
      // use/results) so the Background-activity sub-chat can render it.
      forwardSubagentText: true,
      // A thread flagged bypassPermissions runs without prompts (dangerous, opt-in).
      permissionMode: thread.bypassPermissions ? 'bypassPermissions' : 'default',
      // No built-in plan mode (user, 2026-10-09). Flow plans through its own
      // workflow (discovery → plan → reviewed change notes); the agent's plan
      // mode added a second, private plan file and an "ExitPlanMode —
      // permission required" card mid-execution.
      disallowedTools: [...FLOW_DISALLOWED_TOOLS],
      // Saved allow/deny rules stay keyed to the PROJECT, not the worktree:
      // a rule remembered against a checkout that is pruned at merge time
      // would make the reader answer the same question in every new thread.
      canUseTool: this.permissions.createCanUseTool(thread.id, roots, thread.projectRoot),
      // Render AskUserQuestion in the Flow UI instead of the CLI's auto-cancel
      // default. supportedDialogKinds MUST list the exact dialog_kind the CLI
      // emits, or the dialog never reaches onUserDialog (it degrades to a stuck
      // tool call). We declare every observed AskUserQuestion spelling.
      onUserDialog: this.dialogs.createOnUserDialog(thread.id),
      supportedDialogKinds: [...ASK_USER_QUESTION_KINDS],
    }

    // Session hooks come from two sources, merged per event:
    //   - the coordinator's provider (thread-scoped, e.g. bash-mirror)
    //   - the edit tracker's PostToolUse VERIFICATION channel (ADR-001):
    //     hooks fire even when the CLI auto-allows without a canUseTool
    //     roundtrip, so this both cross-checks predicted diffs against disk
    //     and captures edits that bypassed the permission gate.
    const hookSets: SessionHooks[] = []
    if (this.sessionHooksProvider) {
      hookSets.push(this.sessionHooksProvider(thread))
    }
    // Containment (#62, #82): a session is STRICT to its own project — deny any
    // write outside the thread's root set. Runs as a PreToolUse hook so it fires
    // even under bypassPermissions (where canUseTool is skipped and the SDK's
    // cwd scope is not enforced). Covers the structured edit tools AND `Bash`
    // (shell redirection / cp / mv / sed -i / tee, which otherwise bypass #62).
    // Where this session's agent keeps its own files — its plan mode writes
    // the plan under `plans/` here (isSessionPlanFile).
    const sessionConfigDir = accountConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    // Where a shell READ may go outside the projects (path-containment.ts,
    // `readAllowedOutside`). One stat per path-shaped word, only for words
    // already outside every root.
    const readAllowance: ReadAllowance = { sessionConfigDir, exists: (abs) => existsSync(abs) }
    const denyOnEscape = (reason: string) => ({
      continue: true as const,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: reason,
      },
    })
    hookSets.push({
      PreToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|NotebookEdit',
          hooks: [
            async (hookInput) => {
              if (hookInput.hook_event_name === 'PreToolUse') {
                if (isSessionPlanFile(editFilePath(hookInput.tool_input), sessionConfigDir)) return { continue: true }
                const check = containmentCheck(hookInput.tool_input, currentRoots())
                if (check.deny) {
                  // Auto-attach (phase 6): a write INSIDE a known-but-
                  // unattached project root attaches that root to the
                  // thread, then allows. Unknown escapes stay blocked.
                  const target = attachRootForWritePath(
                    editFilePath(hookInput.tool_input),
                    currentRoots(),
                    knownRoots(),
                  )
                  if (target !== null && this.autoAttachRoots(thread.id, [target])) {
                    const recheck = containmentCheck(hookInput.tool_input, currentRoots())
                    if (!recheck.deny) return { continue: true }
                    return denyOnEscape(recheck.reason)
                  }
                  return denyOnEscape(check.reason)
                }
              }
              return { continue: true }
            },
          ],
        },
        {
          // Reads are scoped too (#503): the agent must only LOOK at the selected
          // project(s), never an unselected sibling repo. Reads NEVER auto-attach
          // (phase 6 attaches on writes only) — but they do honor a root attached
          // earlier in the session, via the live currentRoots read.
          matcher: 'Read|Grep|Glob|LS',
          hooks: [
            async (hookInput) => {
              if (hookInput.hook_event_name === 'PreToolUse') {
                if (isSessionPlanFile(readTargetPath(hookInput.tool_input), sessionConfigDir)) return { continue: true }
                const check = readContainmentCheck(hookInput.tool_input, readRoots(), process.platform, { sessionConfigDir })
                if (check.deny) return denyOnEscape(check.reason)
              }
              return { continue: true }
            },
          ],
        },
        {
          matcher: 'Bash',
          hooks: [
            async (hookInput) => {
              if (hookInput.hook_event_name === 'PreToolUse') {
                const check = bashContainmentCheck(hookInput.tool_input, currentRoots(), process.platform, readAllowance)
                if (check.deny) {
                  // Auto-attach for shell WRITES (phase 6): only when every
                  // escaping write target lands in known roots — a command
                  // that also writes outside every known root stays blocked
                  // with nothing attached. Read escapes never attach.
                  const command = bashCommand(hookInput.tool_input)
                  const decision = command
                    ? bashAttachDecision(command, currentRoots(), knownRoots())
                    : null
                  if (
                    decision !== null &&
                    !decision.blockedOutsideKnown &&
                    decision.attach.length > 0 &&
                    this.autoAttachRoots(thread.id, decision.attach)
                  ) {
                    const recheck = bashContainmentCheck(hookInput.tool_input, currentRoots(), process.platform, readAllowance)
                    if (!recheck.deny) return { continue: true }
                    return denyOnEscape(recheck.reason)
                  }
                  return denyOnEscape(check.reason)
                }
              }
              return { continue: true }
            },
          ],
        },
      ],
    })
    const editTracker = this.editTracker
    if (editTracker) {
      hookSets.push({
        PostToolUse: [
          {
            // MultiEdit included so its writes reach the diff-review strip too (#95).
            matcher: 'Edit|Write|MultiEdit',
            hooks: [
              async (hookInput) => {
                if (hookInput.hook_event_name === 'PostToolUse') {
                  await editTracker.verifyToolResult({
                    threadId: thread.id,
                    // The root the edited file actually lives under: the diff
                    // strip resolves `rootId` + a relative path back to a real
                    // file, and filters by the root the reader is looking at —
                    // which, for a worktree thread, is the worktree.
                    projectRoot: primaryRoot,
                    toolName: hookInput.tool_name,
                    input: hookInput.tool_input,
                    response: hookInput.tool_response,
                  })
                }
                return { continue: true }
              },
            ],
          },
        ],
      })
    }
    const hooks = mergeSessionHooks(hookSets)
    if (Object.keys(hooks).length > 0) {
      sessionOptions.hooks = hooks
    }

    if (thread.sdkSessionId) {
      sessionOptions.resume = thread.sdkSessionId
    }
    const effort = parseEffort(thread.effort)
    if (effort) {
      sessionOptions.effort = effort
    }
    // Model: a pinned model is used as-is — IF IT IS CLAUDE'S. The pin survives
    // a runtime switch (it is one persisted preference, applied to every new
    // thread), so a model chosen while Codex was selected reached the Claude
    // SDK and failed the turn outright:
    //   "There's an issue with the selected model (gpt-5.1-codex-max)."
    // A foreign id falls through to routing, which is what Auto would have
    // done — the guard the other runtimes already had, on this path too.
    const pinned = modelForRuntime('claude', thread.model)
    if (pinned !== undefined) {
      sessionOptions.model = pinned
    } else if (this.options.getModelRouting) {
      sessionOptions.model = resolveAutoModel(effort ?? 'medium', this.options.getModelRouting())
    }

    // Account-bound → the account's isolated CLAUDE_CONFIG_DIR with inherited
    // tokens stripped (#107); legacy → the stored API key, else inherit. Shared
    // with the one-shot generators via authEnv so all paths agree (#107/#237).
    const env = this.authEnv(accountConfigDir)
    // The planflow-ai CLI shim (cli-shim.ts): every session — account-bound,
    // legacy-with-key, or plain inherit — gets the shim dir prepended to
    // PATH so skills can shell out to `planflow-ai` with no local install.
    // `env ?? process.env` means the "undefined = inherit" case now gets an
    // EXPLICIT env object (a copy of process.env plus the prepended PATH)
    // instead of leaving sessionOptions.env unset — every other inherited
    // var passes through untouched. No shim (fail-soft: cliShimDir is null)
    // falls back exactly to the prior behavior — only set env when defined.
    const base = { ...(env ?? process.env) }
    sessionOptions.env = this.options.cliShimDir ? withShimPath(base, this.options.cliShimDir) : base

    return sessionOptions
  }

  /** Per-provider runtime constructors, overridable for tests. Passed to the
   *  registry's createRuntime, which also runs the admission gate. */
  private runtimeFactories(): RuntimeFactoryDeps {
    // The user's PATH, when the session has resolved it: a GUI-launched app
    // inherits /usr/bin:/bin:/usr/sbin:/sbin and cannot spawn a Homebrew or
    // npm-global CLI at all (tool-path.ts). Warmed at startup, so this is a
    // cache read rather than a shell.
    const pathEnv = cachedUserPathEnv()
    const env = { ...(pathEnv ?? process.env) }
    const standIn = e2eSeams()?.runtime
    if (standIn !== undefined) return { codex: standIn, copilot: standIn }
    return {
      codex: this.options.codexRuntimeFactory ?? ((): AgentRuntime => new CodexRuntime({ env })),
      copilot: this.options.copilotRuntimeFactory ?? ((): AgentRuntime => new CopilotRuntime({ env })),
    }
  }

  /**
   * Create a COLD runtime session for a non-Claude provider (Codex, Copilot)
   * (multi_runtime_support). These runtimes are one-shot-per-turn — they spawn
   * with the prompt, which only arrives on the first sendMessage — so no process
   * starts here; `runtime` stays null until `startOrSendRuntimeTurn` fires the
   * first turn. Its events persist through the sink and stream via emitStream;
   * it never enters runSession (the runtime consumes its own stream).
   */
  private createRuntimeSession(
    thread: ThreadRecord,
    provider: Exclude<ProviderId, 'claude'>,
  ): ThreadSession {
    const session: RuntimeThreadSession = {
      provider,
      threadId: thread.id,
      runtime: null,
      sink: new RuntimeEventSink(thread.id, this.threadStore),
      abortController: new AbortController(),
      resumedFrom: thread.sdkSessionId ?? null,
      projectsKey: projectsKey(this.#sessionRoots(thread.id)),
    }
    this.sessions.set(thread.id, session)
    return session
  }

  /** Cold-start the first runtime turn (spawn with the prompt, admitting the
   *  runtime first) or resume the rollout for a follow-up turn. */
  private async startOrSendRuntimeTurn(
    session: RuntimeThreadSession,
    thread: ThreadRecord,
    text: string,
  ): Promise<void> {
    if (session.runtime !== null) {
      session.runtime.send(text)
      return
    }
    // Same rule as the SDK session: a thread with a worktree runs there, one
    // without runs in the project tree (see sessionRootFor) — and each other
    // project as its thread checkout when it has one (getThreadSessionRoots).
    const primaryRoot = sessionRootFor(thread)
    const threadRoots = this.#sessionRoots(thread.id)
    // WHAT THE SESSION MAY WRITE beyond its cwd: the other projects, and where
    // each project's `flow/` link really lives (a vault or Workspace folder
    // outside the repo). Resolved asynchronously — this runs in main.
    const flowTargets = await resolveFlowLinkTargets([primaryRoot, ...threadRoots])
    // A concurrent send may have started the runtime while the links resolved
    // (read through a cast: the narrowing above does not survive the await).
    const startedMeanwhile = (session as RuntimeThreadSession).runtime
    if (startedMeanwhile !== null) {
      startedMeanwhile.send(text)
      return
    }
    if (this.sessions.get(thread.id) !== session) return
    // Only attached roots Flow knows as projects (or their thread checkouts)
    // are writable; the flow targets were validated by their own rule.
    const isAttachable = this.options.isAttachableRoot ?? ((): boolean => false)
    const writableThreadRoots = threadRoots.filter((root) => isAttachable(root))
    // NOT the Workspace-level `links.jsonl` the SDK session gets as a file:
    // these runtimes take DIRECTORIES only, and the only directory holding it
    // is the Workspace folder — unattached siblings' knowledge and the `.git`
    // the app syncs in. `link-knowledge` therefore cannot append there from
    // Copilot/Codex; that is the deliberate trade (flow-artifacts.ts).
    const writableRoots = [...new Set([...writableThreadRoots, ...flowTargets])]
    // createRuntime runs the admission gate — a runtime that cannot be contained
    // never starts.
    const runtime = createRuntime(session.provider, this.runtimeFactories())
    // THE MODEL BELONGS TO THE RUNTIME. resolveThreadModel answers with Claude
    // aliases (the composer's picker, and Auto's effort→model routing), and
    // handing one to another CLI is a turn that dies before it starts:
    //   Error: Model "opus" from --model flag is not available.
    // Anything this provider does not know is dropped; every runtime has a
    // default, and a turn that runs is worth more than a model that does not.
    const model = modelForRuntime(session.provider, thread.model)
    // ALWAYS SAY IT. Flow shows an effort for every thread — medium unless the
    // reader changed it — and a runtime with the same dial should run at the
    // effort the app is displaying, not at whatever its own config file last
    // said. (On one real machine that file's value was one this codex build
    // cannot parse, which killed every turn; see codex-runtime.ts.)
    const effort = parseEffort(thread.effort ?? null) ?? 'medium'
    // THE SYMLINKED flow/ MUST BE A WRITABLE ROOT FOR NATIVE-CONTAINMENT RUNTIMES.
    //
    // Copilot and Codex confine writes to `cwd + --add-dir roots` — they
    // deliberately omit `--allow-all-paths` (copilot-runtime.ts). `flow/` is a
    // symlink into the plan-flow vault whose realpath is OUTSIDE cwd, so anything
    // the runtime spawns — `planflow-ai blueprint/observe/narrate`, or a direct
    // write into `flow/` — resolves to that out-of-tree target and is denied,
    // exactly as the Claude SDK path documented before it started handing over
    // `flowRoots` (buildSessionOptions / resolveFlowArtifactRoots). The runtimes
    // were never given the same widening; without it, #1928's ~/.copilot grant is
    // bypassed because this launch path never consults the OS sandbox policy.
    session.runtime = runtime.start(
      {
        threadId: thread.id,
        // Same rule as the SDK session: a thread with a worktree runs there,
        // one without runs in the project tree (see sessionRootFor).
        cwd: primaryRoot,
        // Plus the worktree's linked `.claude` assets, which Copilot's sandbox
        // would not even READ through their links (see externalRuntimeRoots).
        additionalRoots: externalRuntimeRoots(primaryRoot, threadRoots),
        ...(writableRoots.length > 0 ? { writableRoots } : {}),
        // THE WRITING RULES RIDE ON THE RUNTIME'S FIRST PROMPT ONLY. These
        // runtimes take no system prompt, so the rules go ahead of the text the
        // runtime receives. The stored user message (appended in sendMessage)
        // stays exactly what the person typed, and neither runtime echoes its
        // prompt back as a stream event. Later turns go through `send` above,
        // untouched.
        prompt: runtimeFirstPrompt(text),
        ...(model !== undefined ? { model } : {}),
        // The thread's effort is Flow's, and a runtime with the same dial
        // should be told (codex-runtime.ts explains what else this fixes).
        ...(effort !== undefined ? { effort } : {}),
        resumeSessionId: session.resumedFrom,
        abortSignal: session.abortController.signal,
      },
      {
        onEvent: (event) => {
          // WATCH WHAT IT RUNS. Neither external runtime can be asked which
          // models an account may use, but both name the one they used in
          // every turn — so the picker is built from what was actually seen
          // rather than from a list Flow would have to invent.
          if (event.kind === 'model') {
            this.options.rememberRuntimeModel?.(session.provider, event.model)
          }
          session.sink.handle(event) // persist to the store (transcript reload)
          this.emitStream(event) // stream to the renderer
        },
        onSessionId: (id) => this.bindSessionId(thread.id, id),
        onDone: () => this.onRuntimeTurnComplete(thread.id),
        // A calm line in the thread, not an error card: the turn goes on.
        onNotice: (notice) => {
          try {
            this.threadStore.appendMessage(thread.id, 'system', notice)
          } catch (error) {
            console.error(`[AgentManager] Could not record a notice on ${thread.id}:`, error)
          }
        },
      },
    )
  }

  /** A runtime turn's child exited: the thread is idle and ready for the next. */
  private onRuntimeTurnComplete(threadId: string): void {
    this.threadStore.updateThread(threadId, { status: 'idle' })
    this.emitStream({ kind: 'status', threadId, status: 'idle' })
    this.options.onTurnComplete?.(threadId, true)
    // Best-effort auto-title — its generator is provider-independent.
    void this.maybeGenerateTitle(threadId).then(() =>
      this.options.onThreadTitleSettled?.(threadId),
    )
  }


  private async runSession(session: ClaudeThreadSession): Promise<void> {
    try {
      for await (const message of session.query) {
        session.bridge.handleMessage(message)
      }
    } catch (error) {
      const ownsThread = this.sessions.get(session.threadId) === session
      // Stale-resume recovery: opening an old thread whose persisted SDK
      // session no longer exists (the underlying conversation was rotated or
      // deleted) makes the SDK throw "No conversation found with session ID"
      // instead of streaming. Rather than fail the thread, forget the dead id
      // and restart the session fresh, replaying any unconsumed input.
      if (ownsThread && session.resumedFrom && isMissingSessionError(error)) {
        this.recoverFromStaleResume(session)
        return
      }
      // #981: a session torn down by the user's own Interrupt can surface as
      // a thrown abort here instead of a result message. That is a deliberate
      // stop, not a crash — settle idle quietly rather than flipping 'failed'.
      if (ownsThread && session.bridge.wasInterruptRequested) {
        session.bridge.clearInterruptRequested()
        this.threadStore.updateThread(session.threadId, { status: 'idle' })
        this.emitStream({ kind: 'status', threadId: session.threadId, status: 'idle' })
        return
      }
      // Crash isolation: the session dies, the app lives. Thread lands in
      // 'failed' and can be resumed with a fresh sendMessage.
      console.error(`[AgentManager] Session crashed for thread ${session.threadId}:`, error)
      // LOG-2: only flip the thread's status if THIS session still owns the
      // thread — a stale session's death must not fail a live replacement.
      if (ownsThread) {
        this.markThreadFailed(
          session.threadId,
          error instanceof Error ? error.message : String(error),
        )
      }
    } finally {
      // LOG-2: identity-checked cleanup — a stale session exiting after the
      // thread was recreated must not delete the NEW session's map entry or
      // force-deny its parked permission requests.
      if (this.sessions.get(session.threadId) === session) {
        this.sessions.delete(session.threadId)
        this.shortenSupport.delete(session.threadId)
        this.permissions.disposeThread(session.threadId)
        this.dialogs.disposeThread(session.threadId)
        // LOG-6: the stream is gone — tool calls still awaiting a
        // tool_result will never get one; resolve them as interrupted.
        session.bridge.abortOpenToolCalls('interrupted')
      }
      session.input.end()
    }
  }

  /**
   * Attach known project roots to a thread mid-session (phase 6): each root
   * goes through ThreadStore.addThreadRoot — the ONE thread_roots write seam,
   * whose THREAD_ROOTS_CHANGED_EVENT drives the thread-scope broadcast — and a
   * one-line system note is persisted in the transcript (the #981/#1048
   * persisted-note shape, rendered as a calm system line on history load).
   * Debounced once per root per turn. Returns true when every root is attached
   * (attach-then-allow); false when a store write failed, so the caller keeps
   * the containment denial.
   */
  private autoAttachRoots(threadId: string, rootPaths: readonly string[]): boolean {
    for (const rootPath of rootPaths) {
      // Already attached this turn — the root is in thread_roots; nothing to do.
      if (!this.attachTracker.markAttached(threadId, rootPath)) continue
      try {
        this.threadStore.addThreadRoot(threadId, rootPath)
        this.threadStore.appendMessage(
          threadId,
          'system',
          `Attached ${basename(rootPath)} to this thread — the agent is working there`,
        )
      } catch (error) {
        console.error(`[AgentManager] Auto-attach of ${rootPath} failed:`, error)
        return false
      }
    }
    return true
  }

  private markThreadFailed(threadId: string, message: string): void {
    const failureNote = `${SESSION_FAILURE_PREFIX} ${message}`
    try {
      // #1048: persist the failure alongside the status — the error stream
      // event below is ephemeral, so a session that dies while the user is
      // reading another thread would otherwise leave no trace. The renderer
      // renders this row as the error card on any later history load.
      this.threadStore.appendMessage(threadId, 'system', failureNote)
      this.threadStore.updateThread(threadId, { status: 'failed' })
    } catch (storeError) {
      console.error(`[AgentManager] Failed to mark thread ${threadId} failed:`, storeError)
    }
    this.emitStream({ kind: 'status', threadId, status: 'failed' })
    this.emitStream({ kind: 'error', threadId, message: failureNote })
  }

  /**
   * Restart a thread's session fresh after its resume target went missing.
   * Clears the dead SDK session id, then creates a new (non-resuming) session
   * and replays any input the crashed session had buffered but not consumed.
   * The crashed session's own finally block tears itself down; createSession
   * installs the replacement under the same thread id (identity check keeps
   * the two from colliding).
   */
  private recoverFromStaleResume(session: ClaudeThreadSession): void {
    console.warn(
      `[AgentManager] Thread ${session.threadId}: stored SDK session ${session.resumedFrom} ` +
        'no longer exists — starting a fresh session.',
    )
    try {
      this.threadStore.setSdkSessionId(session.threadId, null)
    } catch (error) {
      console.error(
        `[AgentManager] Failed to clear stale session id for ${session.threadId}:`,
        error,
      )
    }
    const thread = this.threadStore.getThread(session.threadId)
    if (!thread) return
    const pending = session.input.takePending()
    void this.createSession(thread)
      .then((fresh) => {
        // Stale-resume recovery is a Claude-only path (only the SDK persists an
        // sdkSessionId that can go stale); replay the buffered SDK input.
        if (fresh.provider === 'claude') {
          for (const message of pending) {
            fresh.input.push(message)
          }
        }
      })
      .catch((error) => {
        this.markThreadFailed(
          session.threadId,
          error instanceof Error ? error.message : String(error),
        )
      })
  }

  /**
   * Name an as-yet-untitled thread from its opening exchange. Runs once per
   * thread (guarded by the default-title check and the in-flight set), never
   * blocks or fails the turn. Falls back to the first user message when the
   * summarizer yields nothing, so every thread ends up with a real title.
   */
  private async maybeGenerateTitle(threadId: string): Promise<void> {
    const thread = this.threadStore.getThread(threadId)
    if (!thread || !isDefaultTitle(thread.title)) return
    if (this.titling.has(threadId)) return
    this.titling.add(threadId)
    try {
      const messages = this.threadStore.listMessages(threadId)
      const transcript = buildTitleTranscript(messages)
      if (!transcript) return

      let generated: string | null = null
      try {
        const generate = this.options.titleGenerator ?? ((input) => this.sdkTitleGenerator(input))
        // The PROJECT root, deliberately, even for a thread that owns a
        // worktree: this one-shot has no tools and never touches the tree, and
        // the root it carries is what resolves the project's bound account
        // (#237) — a worktree is not a registered project, so resolving auth
        // against it would summarize under the wrong account, or none.
        generated = normalizeTitle(
          await generate({ projectRoot: thread.projectRoot, transcript }),
        )
      } catch (error) {
        console.error(`[AgentManager] Title generation failed for ${threadId}:`, error)
      }

      const title = generated ?? deriveTitleFromMessages(messages)
      if (!title) return

      // Re-check under the latest state — the user may have renamed the thread
      // while the summarizer was running; never clobber a manual title.
      const current = this.threadStore.getThread(threadId)
      if (current && isDefaultTitle(current.title)) {
        this.threadStore.updateThread(threadId, { title })
      }
    } finally {
      this.titling.delete(threadId)
    }
  }

  /** Default title generator — a one-shot, tool-less haiku summarization. */
  private async sdkTitleGenerator(input: {
    projectRoot: string
    transcript: string
  }): Promise<string | null> {
    const prompt =
      'Summarize the following conversation as a short title of 3 to 6 words. ' +
      'Reply with ONLY the title — no quotes, no surrounding text, no trailing punctuation.\n\n' +
      `<conversation>\n${input.transcript}\n</conversation>`
    const options: Options = {
      cwd: input.projectRoot,
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'default',
      model: TITLE_MODEL,
    }
    // Authenticate AS the project's bound account — same contract as the main
    // session — not legacy/inherited auth (#237). Fails closed on unavailable.
    await this.applyAuthEnv(options, input.projectRoot)
    return this.runOneShot(prompt, options)
  }

  /**
   * Generate a task's technical brief — a one-shot, tool-less summarization.
   * Shares the title generator's key/environment contract. Returns null when the
   * model yields nothing (caller records it as an error status).
   *
   * `maxTurns` DEFAULTS TO 1 AND MUST STAY THAT WAY for the summarizers.
   * =====================================================================
   * Three callers share this helper, and they are not the same job. Task briefs
   * and commit messages are "summarize this text": the prompt names no files, so
   * the model has nothing to go looking for and answers in one turn.
   *
   * The invariant checker is not that. Its prompt embeds `### <filePath>`
   * headings and asks for a judgment, which is an invitation to go READ those
   * paths — and the attempt burns the only turn, so every call ended as
   * `Reached maximum number of turns (1)`. That surfaced as one non-fatal
   * console warning per module and, downstream, as every module silently
   * reporting `not-checked (model unavailable)`: the advisory verdicts never
   * appeared, and nothing upstream looked broken.
   *
   * So the cap is now the CALLER's to state, because it depends on the shape of
   * the prompt rather than on this function. `allowedTools: []` still holds for
   * every caller, so extra turns can only ever produce more text — never a tool
   * call, never a write.
   */
  async generateBrief(input: {
    projectRoot: string
    prompt: string
    maxTurns?: number
  }): Promise<string | null> {
    const options: Options = {
      cwd: input.projectRoot,
      maxTurns: input.maxTurns ?? 1,
      allowedTools: [],
      permissionMode: 'default',
      model: BRIEF_MODEL,
    }
    // Same account as the main session — the brief/commit-message prompt carries
    // the account-bound project's diff, so it must not go to the wrong org (#237).
    await this.applyAuthEnv(options, input.projectRoot)
    const text = (await this.runOneShot(input.prompt, options)).trim()
    return text || null
  }

  /** Run a single-prompt query to completion and return its result text. */
  private async runOneShot(prompt: string, options: Options): Promise<string> {
    const queryFn = await this.loadQueryFn()
    const query = queryFn({ prompt: singleUserPrompt(prompt), options })
    let result = ''
    try {
      for await (const message of query) {
        if (message.type === 'result' && message.subtype === 'success') {
          result = message.result
        }
      }
    } finally {
      try {
        query.close()
      } catch {
        // A one-shot query that already ended has nothing to close.
      }
    }
    return result
  }

  private bindSessionId(threadId: string, sessionId: string): void {
    try {
      this.threadStore.setSdkSessionId(threadId, sessionId)
    } catch (error) {
      // Unique-index conflicts (same SDK session bound elsewhere) must not
      // kill the stream — resume will fall back to a fresh session.
      console.error(`[AgentManager] Failed to bind session id for ${threadId}:`, error)
    }
  }

  private emitStream(event: AgentStreamEvent): void {
    // The one choke point every status transition flows through — the manager's
    // own writes AND the StreamBridge's (wired as `emit: (e) => this.emitStream(e)`).
    // Notify the decoupled status listener here so the Kanban lane reaction sees
    // every transition exactly once, from a single place.
    if (event.kind === 'status') this.options.onThreadStatus?.(event.threadId, event.status)
    this.emit(AGENT_STREAM_EVENT, event)
  }

  private loadQueryFn(): Promise<QueryFunction> {
    if (this.options.queryFn) return Promise.resolve(this.options.queryFn)
    if (!this.queryFnPromise) {
      // The binary is ensured BEFORE the first session: an install that shipped
      // without it downloads it here instead of failing every chat with "Native
      // CLI binary … not found" (agent-binary.ts). A failure is not cached — the
      // next session tries again.
      const loading = Promise.all([importAgentSdk(), ensureAgentBinary()]).then(([sdk, binary]) =>
        bindAgentBinary(sdk.query, binary.path),
      )
      loading.catch(() => {
        if (this.queryFnPromise === loading) this.queryFnPromise = null
      })
      this.queryFnPromise = loading
    }
    return this.queryFnPromise
  }
}

// ── Hook merging ─────────────────────────────────────────────────────────

/** Concatenate matcher lists per hook event across all sources. */
function mergeSessionHooks(sets: SessionHooks[]): SessionHooks {
  const merged: SessionHooks = {}
  for (const set of sets) {
    for (const [event, matchers] of Object.entries(set) as Array<
      [keyof SessionHooks, SessionHooks[keyof SessionHooks]]
    >) {
      if (!matchers || matchers.length === 0) {
        continue
      }
      merged[event] = [...(merged[event] ?? []), ...matchers]
    }
  }
  return merged
}

// ── SDK loading (ESM from CJS) ───────────────────────────────────────────

type AgentSdkModule = { query: QueryFunction }

/** Runtime import() that TypeScript's CJS output cannot rewrite to require. */
const dynamicImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<AgentSdkModule>

function importAgentSdk(): Promise<AgentSdkModule> {
  return dynamicImport(SDK_MODULE_SPECIFIER)
}

function parseEffort(value: string | null): (typeof EFFORT_LEVELS)[number] | undefined {
  return EFFORT_LEVELS.find((level) => level === value)
}

// ── Stale-resume detection ─────────────────────────────────────────────────

/** True when an error is the SDK rejecting a resume to an unknown session. */
function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no conversation found with session id/i.test(message)
}

// ── Auto-titling ───────────────────────────────────────────────────────────

/** A single user prompt as the SDK's streaming-input iterable (one-shot). */
async function* singleUserPrompt(text: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage
}

/** True when a title is unset or one of the "not yet named" placeholders. */
function isDefaultTitle(title: string): boolean {
  const trimmed = title.trim()
  return trimmed.length === 0 || DEFAULT_THREAD_TITLES.has(trimmed)
}

/** First few turns of the conversation, formatted for the summarizer. */
function buildTitleTranscript(messages: MessageRecord[]): string {
  const relevant = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(0, 4)
  if (relevant.length === 0) return ''
  return relevant
    .map(
      (message) =>
        `${message.role === 'user' ? 'User' : 'Assistant'}: ${truncate(message.content, 600)}`,
    )
    .join('\n\n')
}

/** Fallback title from the first user message when the summarizer is empty. */
function deriveTitleFromMessages(messages: MessageRecord[]): string | null {
  const firstUser = messages.find((message) => message.role === 'user')
  if (!firstUser) return null
  const firstLine = firstUser.content.trim().split('\n')[0]?.trim() ?? ''
  return firstLine.length === 0 ? null : ellipsize(firstLine, MAX_TITLE_CHARS)
}

/** Clean a raw model title: first line, strip quotes/trailing punctuation. */
function normalizeTitle(raw: string | null): string | null {
  if (!raw) return null
  let title = raw.trim().split('\n')[0]?.trim() ?? ''
  title = title.replace(/^["'`]+|["'`]+$/g, '').trim()
  title = title.replace(/[.。]+$/u, '').trim()
  return title.length === 0 ? null : ellipsize(title, MAX_TITLE_CHARS)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function ellipsize(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

// ── Streaming input queue ────────────────────────────────────────────────

/**
 * Push-based AsyncIterable feeding the SDK's streaming-input prompt. The
 * Query pulls messages as the user sends them; end() closes the stream on
 * dispose.
 */
class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffered: SDKUserMessage[] = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  private ended = false

  push(message: SDKUserMessage): void {
    if (this.ended) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: message, done: false })
      return
    }
    this.buffered.push(message)
  }

  end(): void {
    this.ended = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined, done: true })
    }
  }

  /** Remove and return every buffered-but-unconsumed message — used to replay
   *  input onto a fresh session after a stale resume forces a restart. */
  takePending(): SDKUserMessage[] {
    return this.buffered.splice(0)
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const nextBuffered = this.buffered.shift()
        if (nextBuffered !== undefined) {
          return Promise.resolve({ value: nextBuffered, done: false })
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        // LOG-8: settle a parked next() like end() does — leaving it pending
        // would strand the SDK's pull forever after an early return().
        this.end()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
