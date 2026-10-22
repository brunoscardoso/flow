/**
 * Flow IPC contract — the single source of truth for everything that
 * crosses the main ↔ renderer boundary.
 *
 * Types only (plus channel-name constants used for preload allowlisting):
 * no implementations live here. Main-process handlers, the preload bridge,
 * and renderer callers all import from this module so the three layers can
 * never drift apart.
 *
 * Channel naming: `<domain>:<action>` (invoke) and `<domain>:<event>`
 * (main → renderer push). Domains: threads, messages, toolCalls,
 * editor, terminal, git, flow, blueprint, project, plan.
 *
 * SECURITY INVARIANT (credentials): secrets are a MAIN-PROCESS concern and have
 * no renderer route at all — the credentials channels were removed once the
 * renderer moved to `integrations:*`. Never add one back: no channel may return
 * a credential value, and none should carry one either.
 */

import type { BasicDiscoveryStatus, LearningFirstState } from './basic-discovery'
import type { ReviewListResult } from './review-types'
import type { DebugSessionSummary, DebugStopResult } from './debug-session-ipc'
import type { UserDialogCancel, UserQuestionAnswer, UserQuestionRequest } from './dialog-types'
import type { ModelRouting } from './model-routing'
import type { ContextUsageSnapshot } from './context-usage'
import type { SideIdentity } from './side-identity'
import type { ConflictHunkChoice, ConflictHunkOrder } from './conflict-hunks'
import type { UpdateStatus } from './updater'
import type { FeatureRole, FeatureRoleSource } from './feature-role'
import type {
  BrowserBufferCounts,
  BrowserCapabilities,
  BrowserCapture,
  BrowserCaptureKind,
  TagWindow,
} from './browser-capture-types'

export type { SideIdentity, SideIdentityContext, SideIdentityProvider } from './side-identity'
export type { ReviewFile, ReviewGroup, ReviewListResult } from './review-types'
export type { UserQuestion, UserQuestionOption, UserQuestionAnswer, UserQuestionRequest, UserDialogCancel } from './dialog-types'
export type { UpdateStatus, UpdatePhase } from './updater'
export type {
  BrowserBufferCounts,
  BrowserCapabilities,
  BrowserCapture,
  BrowserCaptureKind,
  BrowserElementPayload,
  BrowserConsolePayload,
  BrowserNetworkPayload,
  BrowserElementCapture,
  BrowserConsoleCapture,
  BrowserNetworkCapture,
  TagWindow,
} from './browser-capture-types'
import type { ShareAccess, ShareRefusalReason, ShareSummary, ShareView } from './share-contract'
import type {
  WorkspaceAnswer,
  WorkspaceResolveRequest,
  WorkspaceResolveResult,
  WorkspaceCreateRemoteRequest,
  WorkspaceHostTools,
  WorkspaceRemoteResult,
  WorkspaceSetRemoteRequest,
  WorkspaceSyncChangedEvent,
  WorkspaceSyncStatus,
  WorkspaceJoinResult,
  WorkspaceLinkResult,
  WorkspaceMembership,
  WorkspaceRootMembership,
  ThreadContextChosenEvent,
  ThreadContextOfferEvent,
  WorkspacesChangedEvent,
  WorkspaceDeleteResult,
  WorkspacePlacementState,
  WorkspacesList,
  WorkspaceSuggestion,
  WorkspaceSummary,
} from './workspaces-contract'

// ═══════════════════════════════════════════════════════════════════════
// Domain models
// ═══════════════════════════════════════════════════════════════════════

// ── Threads / agent ─────────────────────────────────────────────────────

/** Plan-flow status-contract signals, plus 'idle' (matches main's ThreadStore). */
export type ThreadStatus = 'idle' | 'working' | 'needs-decision' | 'blocked' | 'done' | 'failed'

export interface ThreadSummary {
  id: string
  /** The project root the thread belongs to. */
  projectRoot: string
  title: string
  /** SDK session id for resume; null until the first agent turn binds one. */
  sdkSessionId: string | null
  /** Concrete model id, or 'auto' for plan-flow routing. Null → default. */
  model: string | null
  effort: string | null
  status: ThreadStatus
  createdAt: string
  updatedAt: string
  /** ISO timestamp the thread was archived, or null when active. */
  archivedAt: string | null
  /** True when the thread was imported from a Claude Code session (badged). */
  imported: boolean
  /** ISO timestamp the thread was pinned, or null when unpinned. Pinned threads
   *  bypass the sidebar's recency filter and float to the top. */
  pinnedAt: string | null
  /** When true, the thread's agent runs with permission prompts skipped. */
  bypassPermissions: boolean
  /** Additional project roots this thread spans (#45); [] for single-project. */
  additionalRoots: string[]
  /**
   * The checkouts this conversation's OTHER projects hold, if any.
   *
   * A thread can carry several projects and each may have its own copy. Without
   * this the panel could only speak for the project the thread started in — and
   * a conversation isolated in one repository while writing straight into the
   * others is the exact failure that made this necessary (user, 2026-09-17).
   *
   * Absent on a build that has none, which reads as "these projects work in
   * their own trees" — what was always true before attached checkouts existed.
   */
  /**
   * This conversation's checkout in each of its OTHER projects.
   *
   * `path` is what answers "does this project have a copy of its own?".
   * `branch` cannot: a checkout cut DETACHED has a null branch and a real
   * copy, and the panel used to read a null branch as "still in your main
   * folder" — mislabelling every detached attachment and offering a repair
   * button that could not do anything, because the copy already existed.
   */
  attachedWorktrees?: Array<{ rootPath: string; path: string | null; branch: string | null }>
  /**
   * The loop this thread IS a run of, or null for an ordinary conversation.
   * Written once when the run starts; the sidebar draws the loop's glyph off it,
   * the board's card finds its conversation through it.
   */
  originLoop: string | null
  /** The sentence that run was pointed at, verbatim, or null. */
  originAim: string | null
  /** Parent conversation when this is a promoted SUB-AGENT child thread (#1931),
   *  else null/absent — top-level list excludes these; they nest under the parent. */
  parentThreadId?: string | null
  /** The parent's Task tool-call this child thread was promoted from (#1931). */
  originToolCallId?: string | null
  /** The run's name — `TOL-001` — or null off a loop. */
  originKey: string | null
  /**
   * Absolute path of the git worktree this thread owns, or null when it has
   * none — a chat-only thread, and every thread from before the feature.
   * Exactly the path the worktree CLI returned (git's own spelling, realpathed);
   * nothing downstream may recompute it, or a symlinked root silently mismatches.
   */
  worktreePath: string | null
  /**
   * The branch that worktree is on, or null while it is DETACHED. Detached is
   * the normal early state: a thread has no title to name a branch after until
   * its first turn succeeds. Null means "not named yet", never "no worktree" —
   * `worktreePath` is the field that answers that.
   */
  worktreeBranch: string | null
  /** The ref the worktree was cut from — where the work is meant to land. */
  worktreeBase: string | null
  /**
   * The remote this thread publishes to, or null while it is UNBOUND.
   *
   * A MIRROR OF GIT'S OWN UPSTREAM, carried on the summary so a list can be
   * drawn without asking git once per row. Git is the truth; when the two
   * disagree git wins and the mirror is rewritten from it.
   */
  remote: string | null
  /**
   * The branch name on that remote — NOT the local branch name, which is Flow's
   * and follows Flow's grammar. Null means nobody has decided yet, and undecided
   * is asked about at the first publish rather than filled in from the local
   * name.
   */
  remoteBranch: string | null
  /** The branch a pull request opens against; null falls back to `worktreeBase`.
   *  The one part of a binding git keeps no config for. */
  prBase: string | null
  /** The remote branch this thread used to publish to, after a rename re-pointed
   *  it. That branch is still on the remote — nothing deletes it — and this is
   *  what lets a surface say so. */
  previouslyPushedAs: string | null
}

/**
 * What to do with the project's uncommitted work at the moment a thread takes a
 * worktree of its own (discovery OQ 2).
 *
 *  - `commit` — copy it onto a branch of its own and start the thread from
 *    there. Non-destructive: the user's files are left exactly as they are.
 *  - `stash`  — set it aside; the thread starts from the last commit.
 *  - `clean`  — do nothing at all. The default, and the only one a caller gets
 *    by omission (forbidden-pattern #15).
 */
export type CarryChoice = 'commit' | 'stash' | 'clean'

/** A model from a runtime's LIVE catalogue (#1929) — Copilot's `/models`
 *  endpoint. The context window is what makes the context-window choice
 *  possible; it is optional because the catalogue does not always report it. */
export interface RuntimeCatalogModel {
  id: string
  label?: string
  contextWindowTokens?: number
}

/** The context-window choice for a model (#1929): the provider's normal window,
 *  or its extended (e.g. 1M-token) window where the model supports one. */
export type RuntimeContextChoice = 'default' | 'max'

/**
 * Where a thread's worktree begins (thread-worktrees, the base fix).
 *
 * FOUR SHAPES, AND THE DEFAULT IS THE FIRST ONE. A thread is opened to help
 * with the work in front of somebody, so its copy of the project starts where
 * they are — on the branch they have open, at its tip, including commits they
 * have never pushed. It used to start at the repository's trunk, which is right
 * for a scheduled run and wrong for a person: a thread opened to resolve a
 * merge on a feature branch could see neither the branch nor its owner's
 * unpushed commits, and reconstructed the whole thing from the remote.
 *
 *  - `here`     — the branch the project is on. The thread branches off it.
 *  - `branch`   — a branch named by the person. The thread branches off it too.
 *  - `checkout` — a branch named by the person, TAKEN: the thread's commits land
 *                 on it directly and there is nothing to merge back. Only
 *                 possible for a branch no checkout currently holds.
 *  - `trunk`    — the project's default branch, brought up to date. "Start
 *                 fresh", and the behaviour every worktree used to get.
 */
export type WorktreeStart =
  | { kind: 'here' }
  | { kind: 'branch'; branch: string }
  | { kind: 'checkout'; branch: string }
  | { kind: 'trunk' }

/** One branch a worktree could start from, as the picker needs to see it. */
export interface WorktreeBranchOption {
  name: string
  /** True for the branch the project itself has open right now. */
  current: boolean
  /** True for the project's default branch. */
  trunk: boolean
  /**
   * True when NOTHING has this branch open, so a worktree may take it outright.
   *
   * False is git's answer, not a preference: a branch can be checked out in one
   * place at a time, so a branch the project itself has open cannot also be a
   * thread's. The picker offers branching from its tip instead.
   */
  canCheckOut: boolean
  /** True when it exists on the remote and not yet on this computer. */
  remoteOnly: boolean
}

/**
 * The seven things a person can decide about thread worktrees.
 *
 * ONE NAME PER SETTING, used by all three layers. The `.flowconfig` spellings
 * (`thread_worktrees`, `remote_branch_pattern`, …) are a FILE FORMAT, not an
 * identity — they appear in {@link WORKTREE_FLOWCONFIG_KEYS} and nowhere else,
 * so nothing outside the resolver has to know that the base branch is stored
 * under a key called `branch`. They are also never rendered: a settings panel
 * shows a labelled control, never the word a config file happens to use
 * (forbidden-pattern #12).
 */
export type WorktreeSettingKey =
  | 'threadWorktrees'
  | 'remote'
  | 'remoteBranchPattern'
  | 'baseBranch'
  | 'worktreeStart'
  | 'baseRefresh'
  | 'baseRefreshTimeoutMs'
  | 'worktreeCap'
  | 'worktreeSetup'
  | 'worktreeSetupTimeoutMs'

/**
 * Where a resolved value came from.
 *
 * FROM KEY PRESENCE, NEVER VALUE EQUALITY. A project that has deliberately set
 * the remote to `origin` and a project that has never been asked both END at
 * `origin`, and telling the two apart is the whole point of showing provenance:
 * the first must render as a project value the person can hand back, the second
 * as one they are inheriting. Comparing values would collapse them.
 */
export type WorktreeSettingSource = 'project' | 'global' | 'default'

/** One resolved setting: the value in effect, and the layer that supplied it. */
export interface ResolvedWorktreeSetting<T> {
  value: T
  source: WorktreeSettingSource
}

/**
 * Every worktree setting in effect for one project, each with its provenance.
 *
 * A null pattern or base branch is a real answer, not a missing one — "no
 * naming pattern" and "whatever branch the project has open" are the built-in
 * behaviours, and they are expressed here rather than left undefined so a
 * consumer never has to re-derive a default the resolver already applied.
 */
export interface ResolvedWorktreeSettings {
  /** Whether new threads get a checkout of their own. */
  threadWorktrees: ResolvedWorktreeSetting<boolean>
  /** The remote a base refresh reads and a push publishes to. */
  remote: ResolvedWorktreeSetting<string>
  /** Template for the branch name a thread suggests, or null for none. */
  remoteBranchPattern: ResolvedWorktreeSetting<string | null>
  /** What a worktree is cut from and lands on; null = the current branch. */
  baseBranch: ResolvedWorktreeSetting<string | null>
  /** The start the dialog pre-selects, and the one used when none is named. */
  worktreeStart: ResolvedWorktreeSetting<WorktreeStart>
  /** Whether the base is fetched before a worktree is cut. */
  baseRefresh: ResolvedWorktreeSetting<boolean>
  /** How long that fetch may take. Always within the resolver's bounds. */
  baseRefreshTimeoutMs: ResolvedWorktreeSetting<number>
  /**
   * How many thread copies this project may keep on disk before the oldest
   * LANDED one is reclaimed. Always at least 1, and never so large that the
   * ceiling stops being one.
   */
  worktreeCap: ResolvedWorktreeSetting<number>
  /**
   * The one command a project runs in each new worktree, or null for none.
   *
   * A `git worktree` carries tracked files only, so a fresh copy is a repo that
   * often cannot build: the dependencies, the generated clients and the local
   * config are all untracked by design. This is how a project finishes the job
   * — and null, the built-in, means it runs nothing, which is what every
   * project did before this key existed.
   */
  worktreeSetup: ResolvedWorktreeSetting<string | null>
  /** How long that command may take. Always within the resolver's bounds. */
  worktreeSetupTimeoutMs: ResolvedWorktreeSetting<number>
}

/**
 * The app-wide defaults layer: raw strings, keyed by setting.
 *
 * RAW, ON PURPOSE. The global layer is stored as text because the project layer
 * is text — `.flowconfig` is hand-editable and always will be — and one grammar
 * read by one parser is the only arrangement in which a value typed into the
 * global panel and the same value typed into the file cannot mean two different
 * things. A key absent from this record is a default nobody has set.
 */
export type WorktreeDefaults = Record<WorktreeSettingKey, string>

/** What `flow:worktreeSettings` answers with. */
export interface ResolvedWorktreeSettingsResult {
  settings: ResolvedWorktreeSettings
  /**
   * Sentences about values that could not be used, in a person's words.
   *
   * A setting Flow cannot read is not an error — the next layer answers and the
   * app carries on — but it is not nothing either, and silence would leave
   * someone staring at a value the app is ignoring.
   */
  warnings: string[]
}

/** What `threads:worktreeBranches` answers with. */
export interface WorktreeBranchChoices {
  /** The branch the project is on, or null when its HEAD is detached. */
  current: string | null
  branches: WorktreeBranchOption[]
}

/**
 * How a `threads:retargetWorktree` call ended.
 *
 *  - `recut`      — the worktree held nothing, so it was made again from the
 *                   new starting point. The thread's next turn begins there.
 *  - `retargeted` — the worktree holds work, so it stays exactly where it is
 *                   and only the branch its work LANDS on changed.
 *  - `unchanged`  — it already starts there.
 *  - `busy`       — a turn is running; its worktree is not to be moved.
 *  - `unavailable`— no such thread, or it has no worktree of its own.
 *  - `failed`     — git or the worktree tool refused; nothing changed.
 */
export type WorktreeRetargetStatus =
  | 'recut'
  | 'retargeted'
  | 'unchanged'
  | 'busy'
  | 'unavailable'
  | 'failed'

/** Outcome of `threads:retargetWorktree`. */
export interface WorktreeRetargetResult {
  status: WorktreeRetargetStatus
  /** The branch the thread's work now lands on. */
  base?: string | null
  /** One sentence a person reads. Never a command, a path or a config key. */
  detail: string
}

/**
 * How a `threads:prepareWorktree` call ended.
 *
 *  - `ready`        — the thread already had a worktree; nothing was done.
 *  - `created`      — it has one now.
 *  - `needs-choice` — the project has uncommitted work and the caller asked to
 *                     be told before anything is created. Call again with a
 *                     `carry`.
 *  - `disabled`     — this project has thread worktrees turned off.
 *  - `refused`      — the repository cannot have one (not git, no commits).
 *  - `busy`         — a turn is running; its session cannot be moved.
 *  - `unavailable`  — no such thread.
 */
export type ThreadWorktreeStatus =
  | 'ready'
  | 'created'
  | 'needs-choice'
  | 'disabled'
  | 'refused'
  | 'busy'
  | 'unavailable'
  /**
   * The conversation works in the project's own folder — asked for, and
   * answered, rather than inferred from nobody calling.
   *
   * IT EXISTS BECAUSE THE TWO FACTS WERE ONE. "Does this thread have a checkout
   * of its own" and "which branch does its work land on" were carried by a
   * single question — whether `prepareWorktree` was called at all — so main
   * could never be TOLD that a thread works in the project, only left to infer
   * it from silence, and a branch without a checkout could not be expressed at
   * all (user, 2026-09-17: "we should have two dif things, one is branch, and
   * another is worktree … we need to separate that concept everywhere").
   */
  | 'in-project'

/** Outcome of `threads:prepareWorktree`. */
export interface ThreadWorktreeResult {
  status: ThreadWorktreeStatus
  /** Files changed in the PROJECT's own tree — `needs-choice` only. */
  changedFiles?: number
  /** The project's current branch — `needs-choice` only. */
  baseBranch?: string | null
  /** The branch carried work was parked on, when one was made. */
  wipBranch?: string | null
  /** The branch this worktree's work belongs on, once there is one. */
  base?: string | null
  /** True when the worktree took `base` as its own branch — nothing to merge. */
  onBase?: boolean
  /** One sentence a person reads. Never a command, a path or a config key. */
  detail?: string
}

/**
 * How ONE repository's landing ended (thread-worktrees Phase 7).
 *
 * A thread spanning two repositories lands them one after another and each gets
 * its own outcome — one can be `landed` while the next is `conflicted`. No
 * atomicity is claimed anywhere in this contract: git has no cross-repository
 * transaction, and all-or-nothing was rejected because "nothing" would mean
 * undoing a merge that already worked.
 */
export type ThreadLandingOutcome =
  | 'landed'
  | 'opened'
  | 'conflicted'
  | 'nothing'
  | 'needs-message'
  | 'no-base'
  | 'no-branch'
  | 'local-only'
  /**
   * Nobody has said where this thread publishes, so nothing was pushed.
   *
   * A QUESTION, NOT A FAILURE. It is the one outcome that carries its own
   * answer: the row's `binding` holds what Flow would propose, and the surface
   * turns it into an ask rather than a report. Guessing here — the local name,
   * a template, the first remote — is the wrong-but-valid push this whole
   * feature exists to prevent.
   */
  | 'unbound'
  | 'blocked'
  | 'failed'

/** What one repository's landing did. */
export interface ThreadLandingRow {
  /** The repository, named the way the user sees it named. */
  name: string
  projectRoot: string
  outcome: ThreadLandingOutcome
  /** One sentence a person reads. Never a command, a path or a config key. */
  detail: string
  /** Files committed as part of this landing (untracked ones included). */
  committed?: number
  commit?: string
  /** The pull request that is now open. */
  url?: string
  /** Where the merge editor should open — the thread's own checkout. */
  conflictRoot?: string
  /** True when the checkout was released afterwards. */
  pruned?: boolean
  /** The branch that survives as the record of what the thread did. */
  branch?: string | null
  /**
   * What Flow would propose this thread publishes as — present ONLY on an
   * `unbound` row, and present there always.
   *
   * It travels with the refusal so the surface asking has everything it needs
   * (the proposal, where it came from, which remotes exist, which base to
   * offer) without a second round trip. It is a proposal until a person
   * answers; nothing binds from it.
   */
  binding?: ThreadBindingSuggestion
}

/** What one repository is holding, before anything is done about it. */
/** Outcome of `git:renameBranch` — the same five the thread verb reports. */
export type GitBranchRenameResult =
  | { status: 'renamed'; branch: string; detail: string; staleOnRemote?: true }
  | { status: 'unchanged'; branch: string; detail: string }
  | { status: 'refused'; detail: string }
  | { status: 'failed'; detail: string }

export interface ThreadLandingRepo {
  name: string
  projectRoot: string
  worktreePath: string
  branch: string | null
  base: string | null
  /** Files a landing would commit — untracked ones included. */
  changedFiles: number
  /** Commits on the thread's branch the base does not have yet. */
  aheadCommits: number | null
  /** Whether the base exists on a remote — a pull request needs one. */
  baseOnRemote: boolean
  /**
   * True when the worktree IS on its base branch — it took that branch rather
   * than branching off it, so its commits are already where they belong and
   * there is nothing to merge.
   *
   * Equivalent to `branch === base`, which happens in no other shape: a
   * worktree that branches gets a `thread/*` name, and one that stays detached
   * has no name at all.
   */
  onBase: boolean
}

/** Read-only: what is waiting, and the message it would be committed under. */
export interface ThreadLandingPreview {
  threadId: string
  /** The commit message, SHOWN FOR EDITING. A silent commit was rejected. */
  message: string
  repos: ThreadLandingRepo[]
  /** Null when landing is possible; otherwise the sentence that says why not. */
  blockedReason: string | null
  canOpenPullRequest: boolean
  /**
   * Where this thread publishes, as the store's mirror holds it — null when no
   * thread answers to this id.
   *
   * READ FROM THE MIRROR, NOT FROM GIT. Opening the landing surface must cost
   * no child processes (allowed-pattern #19), so this is the four columns as
   * they were last written and its `suggestion` is always null: proposing one
   * costs a ladder of git reads, and the moment worth paying for that is the
   * refusal, not the preview.
   */
  binding: ThreadBindingState | null
}

/** The whole landing, one row per repository. */
export interface ThreadLandingResult {
  threadId: string
  rows: ThreadLandingRow[]
  /** True when every repository landed or opened. */
  complete: boolean
}

/** How releasing a thread's checkout ended. */
export interface ThreadWorktreeReleaseResult {
  status: 'pruned' | 'absent' | 'holds-work' | 'refused' | 'failed'
  /** One sentence a person reads. */
  detail: string
  /** Uncommitted files still in the checkout, when that is what stopped it. */
  changedFiles?: number
  /** Commits the base does not have, when that is what stopped it. */
  aheadCommits?: number
}

/**
 * How much disk the thread checkouts of one project are holding (Phase 7).
 * THE ONE DEFINITION: `worktree-cap.ts` computes it and re-exports this type —
 * the numbers only; the sentence is the renderer's.
 */
export interface WorktreeUsage {
  total: number
  cap: number
  /** Checkouts whose work has not landed — never touched by the ceiling. */
  unlanded: number
  /** True once the ceiling is reached, so the surface can say so before it bites. */
  atCap: boolean
}

/**
 * How the record and the disk disagree about one thread worktree.
 *
 * A MANAGEMENT VIEW IS WHERE DRIFT SHOWS UP, and drift is normal here: a person
 * deletes a directory, a thread is deleted while its copy stays, a turn dies
 * halfway. Listing only what the database believes would hide exactly the rows
 * somebody opened this to find, so the list is the UNION of both sides and each
 * row says which side is missing.
 *
 *  - `none`         — the record and the directory agree. The ordinary row.
 *  - `gone`         — the thread still points at a copy that is not there.
 *  - `abandoned`    — a copy on disk whose thread no longer exists.
 *  - `dead-record`  — git is still holding a record for a directory it cannot
 *                     find; nothing occupies disk and nothing can be opened.
 */
export type ThreadWorktreeDrift = 'none' | 'gone' | 'abandoned' | 'dead-record'

/**
 * One thread worktree, as the list that manages them needs to see it.
 *
 * NO PATH CROSSES THIS BOUNDARY (forbidden-pattern #12). A worktree is its
 * thread, its branch and its state; where it sits on disk is Flow's business
 * and appears in no field a renderer could print. `threadId` is an opaque key
 * the surface passes back, never text it shows.
 */
export interface ThreadWorktreeEntry {
  /** The key every action is addressed by. NEVER rendered. */
  threadId: string
  /** The thread's title, or null when no thread answers to this id any more. */
  threadTitle: string | null
  /** The branch its work is on, or null while the copy is still detached. */
  branch: string | null
  /** The branch its work belongs on, or null when nothing named one. */
  base: string | null
  /** True when everything it holds has reached the branch it was cut from. */
  landed: boolean
  /** Files changed in it that nobody has committed. */
  changedFiles: number
  /** Commits its base has not got. */
  aheadCommits: number
  /** When it last had a commit made in it, in ms. 0 when unreadable. */
  lastActiveAt: number
  /** Kilobytes on disk, or null when that could not be read. */
  diskKb: number | null
  /** True when the worktree TOOK its base branch — nothing to merge back. */
  onBase: boolean
  /** True while the thread has a turn in flight. Nothing touches those. */
  busy: boolean
  /** True when the thread it belongs to is archived. */
  archived: boolean
  drift: ThreadWorktreeDrift
  /** The remote its work publishes to, or null while nothing has been decided. */
  remote: string | null
  /**
   * The branch its work publishes AS on that remote, or null when unbound.
   *
   * Null is the ordinary state and reads as "not published yet", never as an
   * error: most worktrees are landed by merge and never publish at all.
   */
  remoteBranch: string | null
  /** The branch a pull request from it opens against; null follows `base`. */
  prBase: string | null
  /** The remote branch it used to publish as, kept after a rename. Still on the
   *  remote, and named here so it is not discovered as an orphan. */
  previouslyPushedAs: string | null
  /**
   * True when the copy was cut from a base that could not be refreshed first —
   * the network was slow, absent, or the wait was cancelled.
   *
   * A FLAG, NOT A FAILURE. The cut still happened and the work is fine; what is
   * unknown is whether the branch it was cut from was current. Saying so is the
   * whole point: a stale cut that hides is a merge conflict nobody saw coming.
   * False for every entry that was never in that situation.
   */
  baseMayBeBehind: boolean
}

/**
 * What Flow would PROPOSE a thread publishes as — and where that proposal came
 * from.
 *
 * A SUGGESTION IS NOT A BINDING. Nothing is ever bound from this; it exists to
 * pre-fill an ask so a person is choosing rather than typing from scratch. The
 * `source` travels with it because a name derived from a ticket id parsed out of
 * a title is a much weaker claim than one built from the project's own
 * configured pattern, and the person answering deserves to know which they are
 * looking at before they accept it.
 *
 *  - `pattern` — the project configured how its branches are named.
 *  - `ticket`  — an issue id was recognised in the thread's title or its plan.
 *  - `learned` — the shape of the last binding made in this project.
 *  - `local`   — the last rung: the local branch's own name.
 */
export interface ThreadBindingSuggestion {
  /** The proposed remote branch name. Never applied without an answer. */
  suggestion: string
  source: 'pattern' | 'ticket' | 'learned' | 'local'
  /**
   * The remote this project usually publishes to, or null when nobody has
   * named one this repository actually has.
   *
   * A DEFAULT SOMEBODY STILL CONFIRMS — it arrives pre-selected so the ordinary
   * answer costs a nod rather than a decision, and it is never applied without
   * one. Null when the project named no remote, or named one this checkout
   * does not have.
   */
  remote: string | null
  /** Every remote this project has, so a choice between them can be offered
   *  rather than the first one assumed. One entry is the ordinary case. */
  remotes: string[]
  /** The branch this work was cut from, offered as the default to open against;
   *  null when nothing recorded one. */
  base: string | null
}

/**
 * A decision about where a thread publishes, on its way to being written.
 *
 * `confirmed` HAS NO DEFAULT and no true-by-omission (forbidden-pattern #15).
 * Binding writes git config and decides where real work will land; a call that
 * did not say a person asked for it must do nothing. Every field is stated
 * explicitly for the same reason — a request that omitted the branch and got
 * the local name would be exactly the silent guess this feature removes.
 */
export interface ThreadBindingRequest {
  threadId: string
  remote: string
  remoteBranch: string
  /** Null follows the branch the work was cut from. */
  prBase: string | null
  confirmed: boolean
}

/**
 * Where a thread publishes right now, as a surface needs to see it.
 *
 * `bound` is the field to read, not `remote !== null` — the two agree today and
 * a consumer that derives one from the other has to be found and changed the
 * day they stop agreeing. When `bound` is false the binding fields are null and
 * `suggestion` carries what would be proposed if somebody asked; when it is
 * true, `suggestion` is null because there is nothing left to propose.
 */
export interface ThreadBindingState {
  bound: boolean
  remote: string | null
  remoteBranch: string | null
  prBase: string | null
  previouslyPushedAs: string | null
  suggestion: ThreadBindingSuggestion | null
}

/** Every thread worktree one project is holding, plus the ceiling they live under. */
export interface ThreadWorktreeInventory {
  rootPath: string
  usage: WorktreeUsage
  /** Newest activity first; anything unreadable sorts last. */
  entries: ThreadWorktreeEntry[]
  /** True when the project's checkouts could not be read at all. */
  unreadable: boolean
}

/** How renaming a worktree's branch ended. */
export interface ThreadWorktreeRenameResult {
  status: 'renamed' | 'unchanged' | 'refused' | 'failed'
  /** One sentence a person reads. */
  detail: string
  /** The branch it is on afterwards, when there is one. */
  branch?: string
  /**
   * True when the old name also exists on a remote. Renaming here does not
   * touch that, and a person who pushed deserves to be told rather than to find
   * out from a pull request pointing at a name nothing answers to.
   */
  staleOnRemote?: boolean
}

/** How forgetting a worktree that is no longer on disk ended. */
export interface ThreadWorktreeForgetResult {
  status: 'forgotten' | 'still-there' | 'absent' | 'refused' | 'failed'
  detail: string
}

/** Patch shape for `threads:update` — mirrors ThreadStore.UpdateThreadInput. */
export interface ThreadUpdate {
  title?: string
  model?: string | null
  effort?: string | null
  status?: ThreadStatus
  /** true archives the thread, false unarchives it. */
  archived?: boolean
  /** true pins the thread, false unpins it. */
  pinned?: boolean
  /** true runs the thread's agent with permission prompts skipped (dangerous). */
  bypassPermissions?: boolean
}

export type MessageRole = 'user' | 'assistant' | 'system'

/** An image attached to a user message (#456) — metadata only; bytes live on disk. */
export interface MessageAttachment {
  id: string
  /** Allowed image media type (e.g. image/png). */
  mediaType: string
  /** Original file name (or a synthesized one for pastes/captures). */
  fileName: string
  byteSize: number
  width?: number
  height?: number
}

/** A pending attachment carried on send: metadata + the base64 bytes (#456). */
export interface MessageAttachmentInput extends MessageAttachment {
  /** Base64-encoded image bytes (no data: prefix). Materialized only at send time. */
  dataBase64: string
}

export interface ThreadMessage {
  id: string
  threadId: string
  role: MessageRole
  content: string
  createdAt: string
  /** The model that produced an assistant message (#129); null otherwise. */
  model: string | null
  /** Image attachments on a user message (#456); omitted when none. */
  attachments?: MessageAttachment[]
  /** True on the assistant message that ended its turn (plan_chat-cleanup
   *  FR-8); omitted when unmarked, including every message stored before the
   *  mark existed — the feed then falls back to the last assistant message. */
  endsTurn?: boolean
  /** Parent Task tool-call id when this is a SUB-AGENT message; null/absent on
   *  the main thread (#1931 — sub-agent sub-chats). */
  parentToolCallId?: string | null
}

/**
 * A tool call's outcome. `interrupted` is a deliberate STOP, not a failure
 * (#1217): pressing Interrupt used to finalize open calls as `error`, so the
 * transcript said both "this crashed" and "you stopped it" about the same
 * action — and explained the stop with raw `{"interrupted":true}` JSON, one
 * layer below where #981 fixed exactly this confusion.
 */
export type ToolCallStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'denied'
  | 'interrupted'

/** Persisted tool-call row (matches main's ThreadStore.ToolCallRecord). */
export interface ToolCallRecord {
  id: string
  threadId: string
  messageId: string | null
  toolName: string
  inputJson: string | null
  outputJson: string | null
  status: ToolCallStatus
  startedAt: string
  completedAt: string | null
  /** Parent Task tool-call id when this is a SUB-AGENT tool call; null/absent on
   *  the main thread (#1931 — sub-agent sub-chats). */
  parentToolCallId?: string | null
  /**
   * True when `outputJson` was WITHHELD from a list read, not absent.
   *
   * A tool call's output is the heaviest thing this app stores — a Read or a
   * Grep result, several kilobytes each — and a long session holds hundreds.
   * Measured on a synthetic 600-call thread with 8 KB outputs: 4.96 MB, sent
   * whole across IPC on every thread open AND on every turn's history
   * reconcile. That is what a click costing five seconds is made of.
   *
   * So a list read carries the newest outputs and withholds the rest; the card
   * that wants one fetches it (`toolCalls:get`) when the reader opens it.
   * `false`/absent means the output IS what it says it is — the distinction
   * matters, because "no output" and "not sent" are different facts and a card
   * must never present the second as the first.
   */
  outputWithheld?: boolean
  /**
   * True when `inputJson` was SUMMARIZED for a list read, not stored that way.
   *
   * A `Write` call's input carries the whole file — 2.18 MB across a measured
   * 600-call session — and the collapsed card prints only a path out of it. So
   * an old call's input arrives with its short scalars intact (the summary
   * still reads correctly) and its bulk removed; the card says so, and fetches
   * the real one if the reader opens it.
   */
  inputWithheld?: boolean
}

/**
 * A thread read, which is a SUMMARY and nothing more.
 *
 * It used to carry the transcript too: every message and every tool call of the
 * thread, bounded twice after two separate measurements and still 1,306 KB on a
 * 1,800-call session. Nothing ever read them. The composer asks for this on
 * every thread-entity event of a streaming turn — dozens of times a minute — to
 * refresh three fields, and the conversation pane fetches its own window from
 * messages:list / toolCalls:list, which is where a transcript belongs.
 *
 * Kept as a named alias so the channel still says what it returns.
 */
export type ThreadDetail = ThreadSummary

/** Batched change notification from main's ThreadStore (debounced). */
/** What a learning reset removed, or would remove. Counts of real things. */
export interface LearnForgetTally {
  /** `flow/brain/modules/*.md` — the per-module understanding docs. */
  moduleDocs: number
  /** Investigation notes — the learner's recorded findings. */
  notes: number
  /** Heat ticks — how often each module was visited. */
  heat: number
  /** Rows in the learning status table. */
  learningRows: number
  /** Generated curated feature views. */
  featureViews: number
  /** Features whose learned sections were removed (their prose is kept). */
  featuresStripped: number
  /** Feature files left alone because a machine section held hand-written
   *  content — named, never guessed at. */
  featuresSkipped: string[]
}

export interface ThreadChangeEvent {
  entity: 'thread' | 'message' | 'tool_call'
  action: 'created' | 'updated' | 'deleted'
  threadId: string
}

// ── Tasks (task list) ────────────────────────────────────────────────────

export type TaskSource = 'manual' | 'jira' | 'github' | 'azure'
/** Kanban lanes, in board order. `blocked` sits between doing and done: work
 *  that started and is now waiting on a human; `review` sits after it: work the
 *  agent finished and opened a pull request for, waiting on a human to merge
 *  (see TaskSummary.prUrl). Mirrors TaskLane in main/store/task-store.ts — the
 *  two must widen together. */
export type TaskLane = 'todo' | 'doing' | 'blocked' | 'review' | 'done'
/** Lifecycle of a task's auto-generated technical brief. */
export type TaskBriefStatus = 'idle' | 'pending' | 'ready' | 'error'

/** A task owns exactly one thread (1:1) and carries its source + Kanban lane. */
export interface TaskSummary {
  id: string
  projectRoot: string
  title: string
  source: TaskSource
  /** External issue key (e.g. PRJ-123 / owner/repo#42), or null for manual. */
  externalKey: string | null
  externalUrl: string | null
  lane: TaskLane
  /** A clean agent turn suggested Done (never auto-set). */
  suggestDone: boolean
  /** The 1:1 thread this task owns. */
  threadId: string | null
  /**
   * PROVENANCE — the thread that PRODUCED this task, which is NOT the thread it
   * owns. A card mirrored from an agent's todo list names the conversation it
   * came from here while owning no thread of its own. Null means "we do not
   * know": a task no conversation produced, a row written before the column
   * existed, or an origin thread since deleted (the task outlives it, FR-10).
   * Never resolve a card's own thread from this field, or ten cards from one
   * conversation would all reopen it.
   */
  originThreadId: string | null
  /** The imported issue/PR body (or manual description); shown in the detail modal. */
  description: string | null
  /**
   * The pictures the ticket carried when it was imported — addresses, never
   * bytes (`integrations:imageData` fetches one at a time, on demand).
   *
   * NULL MEANS NOBODY LOOKED: a manual task, a ledger item with no tracker to
   * ask, or a row written before the column existed. An empty array means the
   * tracker WAS asked and had none. Only the second is a ticket with no
   * screenshots — a detail that draws them alike would report an absence the
   * app never established.
   */
  images: RemoteIssueImage[] | null
  /**
   * Whether the board's loop may work this card.
   *
   * FALSE UNLESS SOMEBODY SAID OTHERWISE. A board is also a notebook, and a
   * card kept as a reminder must not be started on because play was pressed.
   */
  autoFix: boolean
  /**
   * The pull request this card produced, or null when it has none.
   *
   * App-written only: the board loop opens a PR when it finishes a card's turn
   * cleanly, moves the card to Review and records the URL here. A Review card
   * reads it to offer "PR ↗" and a merge; every other card reads null.
   */
  prUrl: string | null
  /** PM-style technical brief for the engineer; null until generated. */
  brief: string | null
  briefStatus: TaskBriefStatus
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskUpdate {
  title?: string
  lane?: TaskLane
  archived?: boolean
  suggestDone?: boolean
  /** Offer this card to the board's loop, or take it back. */
  autoFix?: boolean
}

/**
 * The outcome of merging a Review card's pull request (tasks:mergePr).
 *
 * `ok` gates whether the card advanced to Done; `detail` is the sentence the
 * board shows either way. `method` names how it merged when it did — a GitHub
 * squash (the review card's usual path, since it always carries a PR) or the
 * local base merge it falls back to.
 */
export interface TaskMergeResult {
  ok: boolean
  detail: string
  method?: 'github-squash' | 'local'
}

/** What one project's board loop is doing. */
export interface BoardLoopState {
  projectRoot: string
  running: boolean
  /** The card being worked, or null. */
  taskId: string | null
  /**
   * Why it stopped, when it stopped ITSELF — "Nothing left that is set to be
   * worked." is the ordinary end. Null while running, and null after a person
   * pressed stop, which needs no explanation.
   */
  stoppedReason: string | null
}

/**
 * What one conversation's autopilot chain is doing.
 *
 * EVERY FIELD IS A SENTENCE OR A FACT A PERSON CAN ACT ON — never a command, a
 * file path or a config key (forbidden-pattern #12). `step` is what is
 * happening ("Planning the work"), not which slash command is being typed on
 * somebody's behalf.
 */
export interface ChainState {
  threadId: string
  running: boolean
  /** The step it is on, in words. Null when nothing is running. */
  step: string | null
  /** True while it is holding because the agent asked the person something. */
  waitingOnYou: boolean
  /**
   * Why it stopped, when it stopped ITSELF — finished, a step that did not
   * finish, autopilot switched off. Null while running, and null after a person
   * ended it, which needs no explanation.
   */
  stoppedReason: string | null
  /** The pull request the chain opened at the end, when it opened one. */
  prUrl: string | null
  /**
   * Why the work was not published, when it was not.
   *
   * A PAUSE HONOURED IS NOT A FAILURE. An enforced chain withholds the publish
   * when the work was rated high risk, when nothing rated it, or when nobody has
   * said where the branch should go — and in all three the work is built,
   * reviewed and committed, waiting on a person rather than broken. Null
   * whenever nothing was withheld.
   */
  notPublished: string | null
}

/** Change notification from main's TaskStore (mirrors ThreadChangeEvent). */
export interface TaskChangeEvent {
  entity: 'task'
  action: 'created' | 'updated' | 'deleted'
  taskId: string
}

// ── Integrations (Jira / GitHub, read-only via PAT) ──────────────────────

export type IntegrationProvider = 'jira' | 'github' | 'azure'

/** Connection status — never carries the token itself. */
export interface IntegrationStatus {
  provider: IntegrationProvider
  connected: boolean
  identityHint?: string
}

/** Token input (renderer → main only; values are never returned). */
export type IntegrationTokenInput =
  | { provider: 'github'; pat: string }
  | { provider: 'jira'; site: string; email: string; apiToken: string }
  /**
   * Azure needs a PLACE as well as a credential: it has no "everything of mine,
   * everywhere" endpoint, so a query is scoped to one project and the
   * organisation and project are part of the connection.
   */
  | { provider: 'azure'; pat: string; org: string; project: string }

/**
 * Which of a provider's lists the board's Remote column shows.
 *
 * `assigned` — issues assigned to the signed-in user, the default and the only
 * thing a freshly-connected tracker can show. `list` — a saved query written in
 * the provider's OWN language. `both` — the two merged, de-duplicated by key.
 */
export type IssueListMode = 'assigned' | 'list' | 'both'

/**
 * A provider's issue-list preference — GLOBAL and non-secret, so it lives in
 * app_settings rather than the credentials file (which never crosses IPC).
 *
 * The query is the tracker's own language — GitHub search (`repo:acme/api
 * label:bug`), Jira JQL, Azure WIQL — the same languages the assigned read
 * already speaks. An empty query means only `assigned` is meaningful, so the
 * board offers `list`/`both` only once one is set.
 */
export interface IssueListConfig {
  mode: IssueListMode
  /** The native custom query, or '' when none is set. */
  query: string
}

export type EffortLevel = 'low' | 'medium' | 'high'

export interface ModelSelection {
  /** Concrete model id, or 'auto' for plan-flow routing. */
  model: string
  effort?: EffortLevel
}

/** Streaming events for a live agent turn (main → renderer). */
export type AgentStreamEvent =
  | { kind: 'message-start'; threadId: string; messageId: string }
  | { kind: 'message-delta'; threadId: string; messageId: string; text: string }
  /**
   * A TEXT block finished streaming — the counterpart to the deltas above, and
   * the signal that "visible text is flowing" has stopped being true.
   *
   * Without it the renderer had no way to learn that text ended: it drops its
   * loader on the first delta (text IS the feedback while it flows) and could
   * only restore it on `thinking`, `tool-start` or `done`. An agent that
   * finished a sentence and then spent seconds deciding its next move showed
   * NOTHING — no text moving, no loader — while the run was still live and the
   * Interrupt button still offered to stop it.
   *
   * Emitted per text block, not per message: a turn interleaves text and tool
   * blocks, so each stretch of prose ends on its own.
   */
  | { kind: 'text-stop'; threadId: string; messageId: string }
  | { kind: 'thinking'; threadId: string; active: boolean }
  | { kind: 'tool-start'; threadId: string; toolCall: ToolCallRecord }
  | { kind: 'tool-end'; threadId: string; toolCall: ToolCallRecord }
  /** End-of-turn token totals. `inputTokens` is EVERYTHING the turn sent —
   *  uncached + cache-read + cache-creation (#1136) — and `cachedInputTokens`
   *  is the cached portion of that same total (0 when nothing was cached),
   *  never a separate addend. */
  | {
      kind: 'usage'
      threadId: string
      inputTokens: number
      cachedInputTokens: number
      outputTokens: number
    }
  /** Estimated tokens saved by this turn's knowledge searches (brain-first
   *  retrieval) — computed post-turn by main's BrainUsageTracker and emitted
   *  only when positive, after the 'usage' event. The stats line appends its
   *  "~Nk saved" segment from this. */
  | {
      kind: 'brain-savings'
      threadId: string
      savedTokens: number
      /** #1280: false when the per-hit price is still the flat default, so
       *  the figure is a constant × `hits` — the stats line shows the hits.
       *  Absent from older main processes: treated as calibrated (the
       *  pre-#1280 behaviour) rather than silently blanking the segment. */
      calibrated?: boolean
      /** Hit-searches behind the figure. */
      hits?: number
    }
  /** The concrete model the SDK resolved for this turn (from the init message).
   *  Lets the UI show the REAL model even when the thread is set to 'auto'. */
  | { kind: 'model'; threadId: string; model: string }
  | { kind: 'status'; threadId: string; status: ThreadStatus }
  /**
   * THE THREAD'S LIVE BACKGROUND WORK, in full, every time the set changes.
   *
   * Separate from `status` on purpose, and never folded into it. `status` is
   * about the TURN — whether the model is generating right now — and it is what
   * unlocks the composer, moves a Kanban card and gates the prompt queue. A
   * thread that launched background agents and finished its turn is genuinely
   * resting by that measure: you can type into it, and it will answer.
   *
   * What it is NOT is finished. The agents keep running and will wake the
   * session when they land, and every surface went silent in the gap
   * ("seems to me that the chat is stopped, everywhere") because the app had no
   * word for "resting, still owed work". This is that word.
   *
   * REPLACE, never merge — the SDK emits the whole live set on every change
   * precisely so a dropped edge cannot wedge a spinner on forever, and the
   * renderer keeping its own tally from start/stop events would throw that
   * guarantee away.
   */
  | { kind: 'background-tasks'; threadId: string; tasks: BackgroundTaskInfo[] }
  /**
   * THE WAIT BEFORE THE FIRST REPLY, which has never had a voice.
   *
   * Cutting a thread's worktree blocks the first message — measured at ~3.6 s
   * for `git worktree add` on a 2k-file repo, plus up to eight more if the base
   * is refreshed — and the only thing that ever reached the thread was a
   * REFUSAL. Success said nothing, so the wait was indistinguishable from the
   * app having ignored the message. A project that sets a setup command turns
   * those seconds into minutes, which is what makes this load-bearing rather
   * than decorative.
   *
   * TRANSIENT, LIKE `background-tasks` AND UNLIKE A MESSAGE. Nothing here is
   * written to the thread's history: a worktree that was set up two weeks ago
   * is not something a person scrolling back needs to read past. `running` is
   * replaced by `done` (which draws nothing) or `failed` (which draws one
   * sentence), and a renderer that missed the first event simply has nothing to
   * clear.
   *
   * NOT `status`. That word is about the TURN — whether the model is generating
   * — and it gates the composer and moves Kanban cards. This is about the
   * worktree, before any turn exists.
   */
  | {
      kind: 'worktree-setup'
      threadId: string
      state: 'running' | 'done' | 'failed'
      /** One sentence a person reads. Present on `failed`; absent otherwise. */
      detail?: string
    }
  /**
   * THE FIRST MESSAGE IS WAITING ON A PROJECT'S BASIC DISCOVERY (decision
   * 2026-10-06: a conversation starts only on projects Flow has learned).
   * Transient like `worktree-setup`: `waiting` draws one line, `failed` one
   * sentence with Try again, `done` nothing. The message itself is already in
   * the thread's history and is delivered when the discovery ends.
   */
  | ({ kind: 'learning-first'; threadId: string } & LearningFirstState)
  | { kind: 'error'; threadId: string; message: string }
  | { kind: 'done'; threadId: string; messageId: string }

/**
 * One live background task — a backgrounded sub-agent, shell command, monitor
 * or workflow — as the UI needs it.
 *
 * Assembled in main from the SDK's own reporting: the `background_tasks_changed`
 * level says WHICH tasks are alive, and the `task_started` / `task_progress`
 * edges fill in what they are and how they are doing. Everything here is
 * therefore reported by the agent runtime, never inferred from a tool's prose.
 */
export interface BackgroundTaskInfo {
  /** The runtime's task id — stable for the task's whole life. */
  id: string
  /** Runtime label for the kind of task: 'subagent', 'shell', 'monitor', … */
  taskType: string
  /** What it is doing, in the runtime's words. Shown as the row's title. */
  description: string
  /** The sub-agent's type name, when this task is a sub-agent. */
  agentType?: string
  /** The tool it most recently used, from the last progress report. */
  lastTool?: string
  /**
   * The persisted ToolCallRecord.id of the SPAWNING Agent/Task tool call, when
   * it is known — the deterministic join between this live task and the row the
   * thread store holds (#1931). The runtime's task events carry the spawning
   * `tool_use_id`; the stream bridge resolves that to the record id it minted
   * when the tool_use was persisted. Absent when the runtime did not say (older
   * SDKs, non-tool tasks) — consumers must fall back to heuristics or to the
   * live-progress view, never guess.
   */
  toolCallId?: string
  /**
   * Milliseconds this task has been running, as last REPORTED by the runtime.
   *
   * Not a timestamp to count from: progress reports arrive irregularly, so the
   * renderer ticks from its own clock between them and re-syncs on each one.
   * Absent until the first progress report — a task that has only just started
   * has no reported duration, and showing 0s would be a measurement rather
   * than the absence of one.
   */
  elapsedMs?: number
  /** When main first saw this task, for ticking between progress reports. */
  startedAt: string
}

export interface PermissionRequest {
  requestId: string
  threadId: string
  toolName: string
  /** Human-readable description of what the tool wants to do. */
  summary: string
  /** Sanitized input excerpt for the permission card (never secrets). */
  inputPreview: string
}

export type PermissionVerdict = 'allow-once' | 'allow-always' | 'deny'

// ── Editor (LSP + diff review) ──────────────────────────────────────────

export interface TextPosition {
  /** Zero-based. */
  line: number
  /** Zero-based UTF-16 column. */
  character: number
}

export interface TextRange {
  start: TextPosition
  end: TextPosition
}

export interface DocumentPositionParams {
  rootId: string
  /** Project-root-relative path. */
  filePath: string
  position: TextPosition
}

export interface HoverResult {
  /** Markdown contents. */
  contents: string
  range?: TextRange
}

export interface DefinitionLocation {
  rootId: string
  filePath: string
  range: TextRange
}

export interface CompletionItem {
  label: string
  kind: string
  insertText: string
  detail?: string
  documentation?: string
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface Diagnostic {
  range: TextRange
  severity: DiagnosticSeverity
  message: string
  source?: string
  code?: string
}

export interface DiagnosticsEvent {
  rootId: string
  filePath: string
  diagnostics: Diagnostic[]
}

export type HunkStatus = 'pending' | 'accepted' | 'rejected'

export interface PendingHunk {
  hunkId: string
  range: TextRange
  beforeText: string
  afterText: string
  status: HunkStatus
}

export interface PendingFileChange {
  rootId: string
  filePath: string
  threadId: string
  hunks: PendingHunk[]
}

// ── Terminal ────────────────────────────────────────────────────────────

export type TerminalKind = 'user' | 'agent'

export interface TerminalInfo {
  terminalId: string
  kind: TerminalKind
  title: string
  cwd: string
  /** Owning thread for agent terminals. */
  threadId?: string
  /** Project this terminal belongs to (project context scoping). */
  projectRoot?: string
  /**
   * The conversation a USER shell was opened in — or (`threadId: null`) the
   * project view. Each thread is its own context: a shell is shown only while
   * its owner is the scope on screen, and hidden (never killed) otherwise.
   * Absent on agent terminals (they carry `threadId`) and on shells opened
   * before any project was active.
   */
  owner?: TerminalOwner
  /**
   * The name a person gave the tab (double-click rename), when they gave one.
   * Kept in main so the name is saved with the shell and survives a restart.
   */
  customTitle?: string
  /**
   * Whether the shell process has exited (user terminals). Surfaced so a window
   * reopened from the dock restores the dead tab as `(exited)` instead of a
   * live-looking shell that silently swallows keystrokes (#446).
   */
  exited?: boolean
}

/** Which scope a user shell belongs to: a conversation in a project, or
 *  (`threadId: null`) the project view. Same key as a tab set. */
export interface TerminalOwner {
  rootPath: string
  threadId: string | null
}

/** A saved shell — enough to re-spawn it in its scope after a restart. */
export interface SavedTerminalRef {
  title: string
  /** The directory it was opened in (a scope root — a thread's checkout or a project). */
  cwd: string
}

// ── Git ─────────────────────────────────────────────────────────────────

export type GitFileState =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'

/**
 * The specific KIND of an unmerged file, decoded from the porcelain v2
 * `u <XY>` stage code (or, in readConflicted, from which of the three merge
 * stages are present). Lets the UI handle hard cases first-class instead of
 * lumping everything as the generic `state: 'conflicted'`. Purely additive: it
 * REFINES `conflicted`, never replaces it, so existing consumers are unaffected.
 *   - both-modified   (UU) content edited on both sides
 *   - both-added      (AA) added on both sides, no common base
 *   - both-deleted    (DD) deleted on both sides
 *   - added-by-us     (AU) present on our side only
 *   - added-by-them   (UA) present on their side only
 *   - deleted-by-them (UD) we modified, they deleted — modify/delete
 *   - deleted-by-us   (DU) they modified, we deleted — delete/modify
 */
export type GitConflictType =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-them'
  | 'deleted-by-us'

export interface GitFileChange {
  filePath: string
  /** For `state: 'renamed'`, the path the file was renamed FROM (porcelain v2's
   *  origPath). The two paths are one change: a commit that names only the new
   *  one records half a rename, leaving both files in HEAD (#1182). Additive —
   *  absent for every other state. */
  renamedFrom?: string
  /** True when this entry is a git SUBMODULE (a `160000` gitlink), not a file
   *  (#1478, #1479). Porcelain v2 says so in its `<sub>` field, which used to be
   *  dropped — so a submodule arrived indistinguishable from a text file and was
   *  handed the file affordances: a diff that read it as bytes, and a discard
   *  that ran `git checkout --` on a gitlink and silently did nothing. Additive:
   *  absent means an ordinary path. */
  submodule?: boolean
  /** Worktree-wins display state, kept for existing consumers (Review, conflict gather). */
  state: GitFileState
  /** True when the index (staging area) carries a change for this file. */
  staged: boolean
  /** The staged (index) change type, or null when not staged (#335). Additive:
   *  existing consumers ignore it; the unified Source Control panel splits a file
   *  into the Staged and Changes sections from these two sub-states. */
  indexState?: GitFileState | null
  /** The unstaged (working-tree) change type, or null when the worktree is clean
   *  for this file (#335). A file can carry BOTH (staged then further edited). */
  worktreeState?: GitFileState | null
  /** The conflict SUB-TYPE for an unmerged entry (`state: 'conflicted'`), decoded
   *  from the porcelain v2 `u <XY>` code. Additive/optional: absent for clean or
   *  non-conflicted entries, and legacy consumers that only read `state` ignore it. */
  conflictType?: GitConflictType
}

export interface GitStatus {
  rootId: string
  branch: string
  dirty: boolean
  ahead: number
  behind: number
  changes: GitFileChange[]
  /** #1382: HEAD is on a commit, not a branch. `branch` is empty then, and a
   *  commit made here is reachable from no branch — the panel must say so
   *  rather than printing git's `(detached)` placeholder as a branch name. */
  detached?: boolean
  /** The commit HEAD is on, when detached. */
  headCommit?: string
}

export interface GitCommit {
  hash: string
  subject: string
  author: string
  date: string
}

// ── Thread change review (Cursor-style, #1906) ────────────────────────────
//
// A per-thread "review changes" surface: every file the agent touched in the
// thread's worktree, file-by-file, with keep/reject that IS git (the same
// working-tree/index the Source Control panel shows — not a second copy). The
// review set is the thread worktree's git working-tree status (source of
// truth), enriched by the thread's persisted tool-call paths so a file the
// agent touched but left with no net change is still visible (informational).

/** One file in a thread's change review. */
export interface ChangeReviewFile {
  /** Root-relative path (matches `GitFileChange.filePath`). */
  filePath: string
  /** Git worktree-wins state. For a `touchedOnly` entry this is `'modified'`, a
   *  placeholder that is never keep/rejectable. */
  status: GitFileState
  /** True when the index carries a change for this file (a staged / "kept" file). */
  staged: boolean
  /** Lines added / deleted vs HEAD, or null when unknown (untracked, binary, or
   *  uncounted). */
  added: number | null
  deleted: number | null
  /** For a rename, the path the file was renamed FROM. Additive; absent otherwise. */
  renamedFrom?: string
  /** True when git reports the file as binary — no line counts, no hunk review. */
  binary: boolean
  /** True when the agent touched this path (an Edit/Write/MultiEdit tool call)
   *  but git reports NO net change. Informational only — never keep/rejectable,
   *  because git is the source of truth for what can be staged or discarded. */
  touchedOnly: boolean
}

/** The change review for one thread's worktree. */
export interface ThreadChangeReview {
  threadId: string
  /** The addressable root whose working tree this reviews (absolute rootPath) —
   *  the thread's own copy when it has one, otherwise the project itself. */
  rootId: string
  /**
   * True when `rootId` is the thread's OWN copy, false when it is the project
   *  everyone shares.
   *
   * IT EXISTS SO THE WORDS CAN BE HONEST. In a thread's own checkout the file
   * list really is "what this conversation changed". In the project's own tree
   * it is every uncommitted change there — the agent's, yours, and whatever was
   * already sitting in the tree when the conversation started. Same list, two
   * different claims, and only the second one is safe to make.
   */
  ownWorktree: boolean
  /**
   * The branch that tree is on, or null when it is detached or not a repo.
   *
   * Free: the resolver already reads the root's git status to build the file
   * list, and the branch is on it. It rides along so the review's toolbar can
   * name where a commit would land without a second round trip — the question
   * anyone asks before pressing Keep on ten files.
   */
  branch: string | null
  /**
   * Which of the review's two states this is.
   *
   * `uncommitted` — files in the working tree, keep/rejectable, the ordinary
   * case. `committed` — the working tree is clean and the branch carries
   * commits its upstream does not: the same work, one step further along, and
   * the only thing left to do with it is push. A commit does not make work
   * disappear, and a review that emptied on one read as "nothing happened
   * here".
   */
  state: 'uncommitted' | 'committed'
  /** Commits this branch has that its upstream does not. 0 when unknowable. */
  aheadCommits: number
  /**
   * Whether this checkout's branch is aimed at anything — true when git has an
   * upstream configured for it.
   *
   * IT IS NOT FLOW'S BINDING. This is git's own `branch.<name>.remote` /
   * `.merge` for the tree being reviewed, read from the tree itself — not the
   * thread store's mirror of where a thread publishes. The two can disagree,
   * and when they do git is the one that decides where a push actually lands,
   * so the review reports git.
   *
   * It exists because `aheadCommits: 0` means two opposite things. A branch
   * with nothing left to publish and a branch nobody has ever published both
   * report zero — with no upstream there is nothing to be ahead OF. `bound` is
   * the fact that separates "nothing to push" from "never pushed".
   */
  bound: boolean
  files: ChangeReviewFile[]
}

/**
 * How publishing a branch ended — every outcome the Push control can render.
 *
 * ONE OF THEM IS A QUESTION. `unbound` is not a failure: the verb refused
 * because nobody has said where this branch publishes, and the refusal carries
 * everything the ask needs (allowed-pattern #21). Flattening it into `failed`
 * would throw the question away and leave the reader with a dead end where a
 * decision belongs.
 *
 * `diverged` is decided BEFORE anything is spawned, so a branch whose remote has
 * moved on is refused in words rather than force-pushed over or quietly pulled
 * on the reader's behalf.
 *
 * THREE OF THEM ARE ABOUT THE ANSWER, NOT THE PUSH (Phase 3). When the ask comes
 * back it arrives as a `binding` on the same request, and the three ways that
 * answer can be unusable are named separately rather than folded into `failed`:
 * `unconfirmed` (nobody said a person asked for it), `incomplete` (half an
 * answer), `bind-failed` (the answer was good and the repository refused it).
 * They are different things to say and different things to do next — re-ask,
 * re-ask with the blank pointed at, and report — so a surface that had to
 * distinguish them by reading a sentence would be parsing prose to pick a
 * behaviour.
 */
export type GitPublishResult =
  | {
      status: 'published'
      /** The remote it went to — a name git knows, never a URL. */
      remote: string
      /** The branch ON that remote, which may differ from the local name. */
      remoteBranch: string
      /** The name this branch used to publish under, when it was renamed once
       *  and the old ref is still sitting on the remote. */
      previouslyPushedAs?: string
    }
  /** Nobody has said where this branch goes. The ask is attached, not implied. */
  | { status: 'unbound'; suggestion: ThreadBindingSuggestion }
  /** The remote has commits this branch does not. Nothing was sent. */
  | { status: 'diverged'; behind: number }
  /** The branch is aimed somewhere and already there. */
  | { status: 'nothing' }
  | {
      status: 'failed'
      /**
       * What went wrong, as a sentence about the repository.
       *
       * NEVER A COMMAND, A PATH OR A CONFIG KEY (forbidden-pattern #12). It is
       * rendered as-is in a toolbar that has no terminal behind it, so an
       * invocation here would be a dead end wearing a sentence's clothes.
       */
      detail: string
    }
  /**
   * A binding was on the request and nothing said a person asked for it.
   *
   * NOTHING RAN — not the write, not the push (forbidden-pattern #15). Binding
   * decides where real work lands, so a call that did not say `confirmed: true`
   * must do nothing at all rather than take its own silence for consent.
   */
  | { status: 'unconfirmed'; detail: string }
  /**
   * The answer was missing a half — a blank remote, or a blank branch name.
   *
   * REFUSED, NEVER COMPLETED (allowed-pattern #22). Once a feature exists to
   * stop a silent guess, no layer beneath the ask may fill the blank in from
   * the project's default; doing it here would hide the guess one layer below
   * where anybody would look for it.
   */
  | { status: 'incomplete'; detail: string }
  /**
   * The binding write itself did not happen, so nothing was sent either.
   *
   * Distinct from `failed`, which is a push that was attempted. Here the branch
   * is still aimed nowhere and the reader's answer is still unrecorded.
   */
  | { status: 'bind-failed'; detail: string }

/**
 * A decision about where this checkout publishes, riding along with the press
 * that follows it.
 *
 * `confirmed` HAS NO DEFAULT and no true-by-omission (forbidden-pattern #15),
 * exactly as `ThreadBindingRequest` states it — this is the same decision
 * arriving by a different door, and the two doors must not disagree about what
 * consent looks like.
 *
 * THERE IS NO `prBase` HERE. Publishing does not open a pull request, so the
 * base a PR would target is not part of this answer; the landing flow still
 * owns proposing the work, and asks its own question when it does.
 */
export interface GitPublishBinding {
  remote: string
  remoteBranch: string
  confirmed: boolean
}

/**
 * Which in-progress integration operation (if any) a repo is sitting inside.
 * Additive union (#66; conflict-UX): `cherry-pick` is detected via
 * `.git/CHERRY_PICK_HEAD`; `stash` is reserved for a stash-apply-in-progress
 * (see `GitManager.getMergeState` for why it is not reliably detectable today).
 */
export type GitMergeOp = 'merge' | 'rebase' | 'cherry-pick' | 'stash' | 'none'

/**
 * A repo's in-progress merge/rebase/cherry-pick state — the surface the
 * conflict-resolution UI drives off. `op: 'none'` (with an empty
 * `unmergedPaths`) is the clean/idle and the fail-soft (non-repo) result.
 */
export interface GitMergeState {
  op: GitMergeOp
  /** The merge's incoming commit (`.git/MERGE_HEAD`), when `op === 'merge'`. */
  mergeHead?: string
  /** The prepared merge message (`.git/MERGE_MSG`), when present. */
  mergeMsg?: string
  /**
   * The incoming branch name for a merge, parsed from `MERGE_MSG`
   * (`Merge branch 'X'`), when resolvable. Additive: the human-facing label
   * behind `mergeHead`, so the UI need not show a bare SHA.
   */
  incomingBranch?: string
  /** The branch being replayed during a rebase (`head-name`, shortened). */
  ontoBranch?: string
  /**
   * The tip of the branch being replayed during a rebase (`orig-head` under the
   * rebase state dir).
   * Additive: this is the `theirs` side in a rebase's INVERTED mapping (the
   * commits being replayed), distinct from `incomingRef` (the `onto` base).
   */
  rebaseHead?: string
  /** The cherry-pick's incoming commit (`.git/CHERRY_PICK_HEAD`), when `op === 'cherry-pick'`. */
  cherryPickHead?: string
  /** The ref changes are coming in from — MERGE_HEAD for merge, `onto` for rebase. */
  incomingRef?: string
  /** Absolute-of-root file paths with unresolved conflicts (git stage-marked). */
  unmergedPaths: string[]
}

/** The three conflict sides plus the on-disk marker-laden working copy. */
export interface GitConflictedFile {
  /** Stage 2 — our side (`git show :2:<path>`); empty when the stage is absent. */
  ours: string
  /** Stage 3 — their side (`git show :3:<path>`); empty when the stage is absent. */
  theirs: string
  /** Stage 1 — merge base (`git show :1:<path>`); empty when the stage is absent. */
  base: string
  /** The working-tree file, still carrying the `<<<<<<<`/`=======`/`>>>>>>>` markers. */
  markered: string
  /**
   * Concrete identity of the `ours` side (stage 2), derived from the in-progress
   * operation — lets the renderer label the pane truthfully instead of a bare
   * "ours". Additive/optional: populated by the identity-wiring phase; absent
   * results render with the legacy stage label. See {@link SideIdentity}.
   */
  oursIdentity?: SideIdentity
  /**
   * Concrete identity of the `theirs` side (stage 3), derived from the
   * in-progress operation. Additive/optional (see {@link oursIdentity}). The
   * merge↔rebase inversion is carried here, not by the stage label.
   */
  theirsIdentity?: SideIdentity
  /**
   * The conflict SUB-TYPE, derived here from which of the three stages are
   * present (matching the porcelain `u <XY>` classification). Additive/optional
   * — lets the renderer branch on delete/modify, add/add, rename, etc. rather
   * than treating every side as plain text. See {@link GitConflictType}.
   */
  conflictType?: GitConflictType
  /**
   * True when ANY side is a binary blob (NUL byte within the scan window). When
   * set, `ours`/`theirs`/`base`/`markered` are empty strings — the renderer must
   * NOT decode them (they would be mojibake); use the per-side sizes instead.
   * Additive/optional; absent means a normal all-text conflict.
   */
  binary?: boolean
  /** True when stage 2 (ours) exists. Distinguishes a genuinely-empty side from
   *  an ABSENT one (delete/modify), which an empty `ours` string cannot. Additive. */
  oursPresent?: boolean
  /** True when stage 3 (theirs) exists. Additive (see {@link oursPresent}). */
  theirsPresent?: boolean
  /** True when stage 1 (base) exists. Additive (see {@link oursPresent}). */
  basePresent?: boolean
  /** Byte length of the ours (stage 2) blob; 0 when absent. Additive — the size
   *  the renderer shows for a binary side instead of decoded content. */
  oursSize?: number
  /** Byte length of the theirs (stage 3) blob; 0 when absent. Additive. */
  theirsSize?: number
  /** Byte length of the base (stage 1) blob; 0 when absent. Additive. */
  baseSize?: number
  /** Original path of a rename conflict (the pre-rename name). Additive/optional —
   *  populated best-effort for rename/rename and rename/modify conflicts. */
  renameFrom?: string
  /** New path of a rename conflict (the post-rename name). Additive (see {@link renameFrom}). */
  renameTo?: string
}

/** Reading a conflicted file, or a sentinel when a side blows the 64MB budget. */
export type GitReadConflictedResult = GitConflictedFile | { oversize: true }

/**
 * One side of an AGENT CLASH (conflict-UX Phase 6) — a plan-flow parallel-agent
 * clash where two wave phases each committed an edit to the same file. Unlike a
 * git conflict, a side is labeled by the PLAN PHASE/TASK that authored it, not a
 * branch/author. Pure serializable data — carried over IPC and consumed by the
 * wave `SideIdentityProvider`.
 */
export interface AgentClashSide {
  /** The plan phase number that committed this side (from the commit subject). */
  phase: number
  /** The task number within the phase, or null when the commit omits `.task-M`. */
  task: number | null
  /** The plan feature slug, or null when the commit omits the ` — <feature>` suffix. */
  feature: string | null
  /** The commit whose blob is this side's version of the file. */
  commit: string
  /** That commit's subject line (retained for identity/diagnostics). */
  subject: string
}

/**
 * A reconstructed same-file agent clash: the two phase/task sides plus the
 * common base commit the 3-way synthesis merges against. For a >2-phase clash
 * the first two (lowest-numbered) phases are sides A/B and the rest are recorded
 * in `extraPhases` + a `note`. Additive — surfaced only by the Phase 6 channels.
 */
export interface AgentClashInfo {
  /** Root-relative path of the clashed file. */
  filePath: string
  /** Merge-base of the two side commits (the wave-start version), or null. */
  base: string | null
  /** Side A — the lower-numbered phase. */
  sideA: AgentClashSide
  /** Side B — the higher-numbered phase. */
  sideB: AgentClashSide
  /** Phases beyond the reconstructed pair, when >2 phases touched the file. */
  extraPhases?: number[]
  /** Human note explaining a >2-phase narrowing (also logged). */
  note?: string
}

/**
 * An OPENED agent clash (conflict-UX Phase 6): the synthesized 3-way conflict —
 * the same {@link GitConflictedFile} shape a real git conflict produces, with its
 * per-side identities labeled by PHASE/TASK rather than branch/author — plus the
 * {@link AgentClashInfo} metadata (the reconstructed sides, base, and any
 * >2-phase note). The renderer opens `file` in the exact same per-hunk resolver a
 * git conflict uses; `clash` carries the narrative context.
 */
export interface AgentClashConflict {
  /** The synthesized conflicted file — markers + sides + wave identities. */
  file: GitConflictedFile
  /** The reconstructed clash the file was synthesized from. */
  clash: AgentClashInfo
}

/**
 * How to resolve a single conflicted file: write explicit merged `text`, or
 * take one whole side (`git checkout --ours|--theirs`). All kinds then `git add`.
 */
export type GitConflictResolution =
  | { kind: 'content'; text: string }
  | { kind: 'ours' }
  | { kind: 'theirs' }

/**
 * One resolved conflict in a merge-resolution summary (#66; Phase 8). Every
 * field is best-effort at completion time — unknown values degrade to empty
 * strings; the summary still renders. `finalRisk` is the post-triage verdict.
 */
export interface MergeSummaryConflict {
  file: string
  oursIntent: string
  theirsIntent: string
  choice: string
  /**
   * The post-triage verdict. `unassessed` (#1287) is the honest value for a
   * resolution nothing judged — a human picked a side, and claiming `safe`
   * over it put an unearned risk assessment into permanent git history.
   */
  finalRisk: 'safe' | 'risky' | 'unassessed'
  /** 0..1 confidence in the resolution. */
  confidence: number
  why: string
  how: string
}

/** Verification outcome folded into a merge-resolution summary (optional). */
export interface MergeSummaryVerify {
  ok: boolean
  ran: string[]
  /** The first failing step's name, when `ok` is false. */
  firstFailure?: string
}

/**
 * The recorded resolution set a merge-resolution summary is rendered from. PURE
 * input — the summary writer reads no clock, so the same input renders the
 * byte-identical doc + commit body (the filename `stamp` is passed separately).
 */
export interface MergeSummaryInput {
  branch: string
  ontoBranch: string
  conflicts: MergeSummaryConflict[]
  verify?: MergeSummaryVerify
}

export interface GitDiffRequest {
  rootId: string
  filePath: string
  /** Omitted → working tree vs HEAD; set → commit vs its parent. */
  commit?: string
  /** When true (and no `commit`), diff the STAGED index vs HEAD (`git diff --cached`)
   *  instead of the working tree — so clicking a file in the Staged Changes section
   *  shows exactly what a commit will contain, not later unstaged edits (#694-consistent). */
  staged?: boolean
  /**
   * Diff a NAMED BASE against HEAD instead of the working tree — today only
   * `'upstream'`, meaning everything this branch has committed and not pushed.
   *
   * It is an enum and not a revision string on purpose: the review needs one
   * base, the caller has no business naming refs across IPC, and a revision
   * arriving from the renderer is an untrusted value one argv away from git
   * (the reason `commit` is revision-validated at all). Main resolves the word.
   */
  against?: 'upstream'
}

export interface GitDiff {
  filePath: string
  beforeContent: string
  afterContent: string
  /**
   * True when either side is binary (NUL byte within the first 8 KB, git's own
   * heuristic). Content is left empty — the diff view renders a "Binary file"
   * notice instead of decoding raw bytes as UTF-8 mojibake.
   */
  binary?: boolean
  /**
   * Whole-commit diff only: the commit's TOTAL changed-file count. Present so
   * the reviewer can be told when the view is capped (see `truncated`).
   */
  totalFiles?: number
  /**
   * Whole-commit diff only: true when the commit has more files than the view
   * cap, so only the first N are included. A trailing notice is also appended
   * to the content, but this flag lets the panel surface a banner (#121).
   */
  truncated?: boolean
  /**
   * A change the two CONTENT sides cannot show (#1185) — today a file-mode
   * change (`chmod +x`), whose diff is otherwise byte-identical on both sides
   * and therefore indistinguishable from a diff that failed to load. Rendered
   * as a one-line banner above the panes. Absent when the content itself is
   * what changed.
   */
  note?: string
}

// ── flow/ observation (read-only in v1) ─────────────────────────────────

/** A blocked heartbeat prompt awaiting a user reply (one per root). */
export interface FlowPendingPrompt {
  /** Stable id derived from the prompt file's mtime. */
  promptId: string
  /** Task name extracted from the prompt's `**Task**:` line. */
  task: string
  /** Full prompt markdown, rendered by the renderer's blocked-prompt card. */
  markdown: string
}

export interface FlowState {
  rootId: string
  /** Parsed key/values from flow/.flowconfig (absent file → empty). */
  flowconfig: Record<string, string>
  /** Status line derived from flow/STATE.md, if present. */
  stateStatus?: string
  activeSkill?: string
  activePhase?: string
  autopilot: boolean
  activePlan?: string
  currentTask?: string
  nextAction?: string
  /** Events newer than lastReadTimestamp in flow/.heartbeat-state.json. */
  heartbeatUnread: number
  pendingPrompt: FlowPendingPrompt | null
}

/**
 * Request for `flow:recordVerdict` (Board Review Mode, #609) — one board file
 * decision. `classification` is passed through from the renderer's approve→'kept'
 * / refuse→'dismissed' mapping. `rootId` === absolute rootPath (the read path is
 * fixed in main). `reason` is optional free text.
 */
export interface FlowRecordVerdictRequest {
  rootId: string
  filePath: string
  classification: 'kept' | 'dismissed'
  reason?: string
}

/** Response for `flow:recordVerdict` — append outcome (fail-soft `ok: false`)
 *  plus the deterministic verdict fingerprint the entry was written under. */
export interface FlowRecordVerdictResponse {
  ok: boolean
  fingerprint: string
}

export type FlowNotificationKind = 'heartbeat-event' | 'blocked-prompt' | 'state-change'

/** Severity for the renderer's level-colored toast border / inbox dot. */
export type FlowNotificationLevel = 'info' | 'warn' | 'error'

export interface FlowNotification {
  kind: FlowNotificationKind
  rootId: string
  /** What the chip shows instead of the root's folder name — set when the
   *  rootId is not a path (a Workspace's notifications carry its name). */
  label?: string
  title: string
  body: string
  timestamp: string
  level: FlowNotificationLevel
  /** Set for blocked prompts awaiting a user reply. */
  promptId?: string
  /** Optional deep-link action rendered as a button on the toast. Clicking it
   *  dispatches `event` as a document CustomEvent — carrying `detail` as the
   *  event's detail when set, so the action can name WHAT it opens (a
   *  Workspace's slug) — and, when `openLearning` is set, also
   *  `flow:open-learning-panel`. An actionable toast is persistent. */
  action?: { label: string; event: string; detail?: Record<string, string>; openLearning?: boolean }
}

// ── flow/ artifact watching (blueprint-interaction #563+#568) ────────────

/** The three narratable artifact kinds, mapped 1:1 from their flow/ subdir. */
export type FlowArtifactKind = 'discovery' | 'plan' | 'brainstorm'

/** The existing artifacts for a root, returned by `flow:listArtifacts`. */
export interface FlowArtifactListResult {
  artifacts: FlowArtifactChangedEvent[]
}

/** A discovery/plan/brainstorm doc was added or changed under flow/. */
export interface FlowArtifactChangedEvent {
  /** Absolute project rootPath (addressing convention). */
  rootId: string
  kind: FlowArtifactKind
  /** Repo-relative path, e.g. "flow/plans/plan_foo_v1.md". */
  path: string
  /** File basename, e.g. "plan_foo_v1.md". */
  name: string
  /** File mtime (ms since epoch) at the time the change was observed. */
  mtime: number
  /** Whether the doc's user walkthrough page (`<doc>.walkthrough.html`, beside
   *  it) exists. Absent reads as false. Only a discovery's is offered as a
   *  feature view. */
  walkthrough?: boolean
  /** The walkthrough page's mtime when it exists — what tells an open feature
   *  view that the page itself changed, not just the markdown. */
  walkthroughMtime?: number
  /** The watch RE-LISTED this doc (it started following a re-pointed `flow/`
   *  link and re-announced what it found) — not a write. Only the thread that
   *  wrote the doc may take its card; nobody else's (live 2026-10-06). */
  replayed?: boolean
  /** True while the page is still the half-filled template — the card shows
   *  its feature-view door as loading rather than open an empty page. */
  walkthroughWriting?: boolean
  /** The thread this doc belongs to — its writer, else the thread active when
   *  it appeared — when main could tell. Lets a thread show a doc written into
   *  a project ATTACHED to it, which is not the active project. Absent reads as
   *  "unknown": the active project's rule applies, as it always did. */
  threadId?: string
}

// ── Blueprint (flow/.blueprint/ observation) ─────────────────────────────
//
// Minimal mirrors of the CLI's blueprint shapes. The app is a separate npm
// workspace, so these are DUPLICATED here on purpose — the source of truth
// is the CLI workspace's `src/cli/blueprint/types.ts`; keep the two in sync.

export type BlueprintNodeKind = 'integration' | 'endpoint' | 'datastore' | 'module' | 'project'

/** Optional extractor/graphify metadata for a node (open-ended). */
export interface BlueprintNodeMeta {
  degree?: number
  community?: string | number
  tables?: string[]
  method?: string
  route?: string
  graphifyIds?: string[]
  /** Folder-spine module nodes: tree depth (1 = top-level source dir). */
  depth?: number
  /** Folder-spine module nodes: count of emitted child module nodes. */
  childDirs?: number
  /** Folder-spine module nodes: direct source files (incl. rolled-up). */
  fileCount?: number
  /** True when deeper-than-cap directories rolled up into this module. */
  rolledUp?: boolean
  [key: string]: unknown
}

export interface BlueprintNode {
  /** Stable identifier, unique within the graph. */
  id: string
  kind: BlueprintNodeKind
  label: string
  /** Repo-relative path of the file the node was derived from. */
  sourceFile: string
  symbol?: string
  meta?: BlueprintNodeMeta
}

export interface BlueprintEdge {
  source: string
  target: string
  relation: string
}

/** Background code-graph build state when graphify has no graph yet (#535). */
export type GraphifyBuildState = 'building' | 'failed'

export interface BlueprintCoverage {
  filesScanned: number
  filesTotal: number
  extractorsRun: string[]
  graphifyEnriched: boolean
  /**
   * Set when graphify is installed but this project has no code graph yet (#535):
   * `'building'` while the first (background) build runs, `'failed'` if it overran
   * without producing a graph. Absent once a graph exists. Drives the board's
   * degraded-structure banner.
   */
  graphifyBuild?: GraphifyBuildState
}

export type BlueprintMustReviewSeverity = 'crit' | 'high' | 'ask' | 'info'

export interface BlueprintMustReviewItem {
  rank: number
  severity: BlueprintMustReviewSeverity
  title: string
  detail: string
  nodeId?: string
  source: string
}

/** The derived system graph at `<root>/flow/brain/.structure/graph.json`. */
export interface BlueprintGraph {
  version: number
  derivedAt: string
  coverage: BlueprintCoverage
  nodes: BlueprintNode[]
  edges: BlueprintEdge[]
  mustReview?: BlueprintMustReviewItem[]
  /**
   * APP-ONLY marker: true on the in-memory fallback graph that main derives
   * itself (src/main/blueprint/basic-derive.ts) when the full CLI derive is
   * unavailable/failed. CLI-derived graphs NEVER set this field — it exists
   * only in this mirror, never in graph.json on disk.
   */
  basic?: true
}

export type BlueprintAnchorKind = 'symbol' | 'file' | 'table' | 'endpoint' | 'module'

export interface BlueprintAnchor {
  kind: BlueprintAnchorKind
  ref: string
  file?: string
}

export type BlueprintAnnotationType = 'decision' | 'rule' | 'claim' | 'pin'
export type BlueprintAnnotationStatus = 'active' | 'stale'

/**
 * One annotation from `annotations.jsonl` with its EFFECTIVE status —
 * main folds `status-events.jsonl` (last event per fingerprint wins)
 * before the entry crosses this boundary.
 */
export interface BlueprintAnnotation {
  ts: string
  runId: string | null
  type: BlueprintAnnotationType
  text: string
  anchors: BlueprintAnchor[]
  provenance: string
  status: BlueprintAnnotationStatus
}

/**
 * Proposal lifecycle states (mirror of the CLI's ProposalEventName — source
 * of truth: `src/cli/blueprint/proposal-store.ts` in the CLI workspace).
 */
export type BlueprintProposalState =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'confirmed'
  | 'stale'
  | 'cleared'

/**
 * The folded (effective) state of one proposal from `proposals.jsonl` — a
 * PREDICTED graph node ("ghost") named by a plan before the code exists.
 * Mirror of the CLI's EffectiveProposal (source of truth:
 * `src/cli/blueprint/proposal-store.ts`); main folds the event stream
 * before it crosses this boundary. Proposals arrive via their own store —
 * graph.json stays derived-only and never carries them.
 */
export interface BlueprintEffectiveProposal {
  /** Stable identity: `<plan>+<predictedNodeId>`. */
  fingerprint: string
  plan: string
  phase?: number
  /** Exact node id the extractors are predicted to derive. */
  predictedNodeId: string
  kind: BlueprintNodeKind
  label: string
  detail?: string
  anchors: BlueprintAnchor[]
  /** Current lifecycle state — the latest event for the fingerprint. */
  state: BlueprintProposalState
  /** Provenance of the first `proposed` event. */
  provenance: string
  /** Timestamp of the first `proposed` event. */
  proposedAt: string
  /** Timestamp of the most recent `accepted`/`rejected` event, when any. */
  decidedAt?: string
  /** Timestamp of the most recent `confirmed` event, when any. */
  confirmedAt?: string
}

/**
 * One narrated step of a compiled story — mirror of the CLI's StoryStep
 * (source of truth: `src/cli/blueprint/types.ts` in the CLI workspace).
 * Reuses `BlueprintAnchor` for the step's structural attachment points.
 */
export interface BlueprintStoryStep {
  /** Deterministic id: kebab-slug of the title, with `-2`/`-3`… collision suffixes. */
  id: string
  title: string
  /** Short label shown above the title in the board panel. */
  kicker?: string
  /** Free markdown body, preserved verbatim (trimmed) from the source doc. */
  body: string
  anchors: BlueprintAnchor[]
  /** Ordered node ids describing the flow-path overlay for this step. */
  flow: string[]
  /** Plan phase numbers this step narrates. */
  phases: number[]
  decisions: string[]
  rejected: string[]
  questions: string[]
  /** Optional free-text source reference (e.g. a doc link or file path). */
  source?: string
  /** Anchors that failed to resolve against the graph/proposals (compile-time only). */
  unresolvedAnchors: string[]
  /** True when the step could not be fully anchored (compile-time only). */
  draft: boolean
}

/**
 * The compiled story for one plan/discovery doc, read from
 * `flow/brain/.structure/story.json` — mirror of the CLI's CompiledStory
 * (source of truth: `src/cli/blueprint/types.ts` and
 * `src/cli/blueprint/story-compile.ts` in the CLI workspace).
 */
export interface BlueprintStory {
  /** Plan or feature name the story belongs to. */
  plan: string
  /** Repo-relative path of the doc the `## Story` section was parsed from. */
  sourcePath: string
  mode: 'draft' | 'strict'
  steps: BlueprintStoryStep[]
  /** Human-readable parse warnings — malformed blocks/fields are skipped, never silently. */
  warnings: string[]
}

// ── Explainer narrative (native-full-preview, Phase 2) ─────────────────
/**
 * Progressive-learning status of one module, read from
 * `flow/brain/.structure/learning-state.jsonl`. The learn orchestrator is the
 * single writer (full file rewrite, deduped by module); the board reads it to
 * badge modules and to flag investigation notes whose module is now stale.
 */
export type BlueprintLearningStatus = 'queued' | 'learning' | 'learned' | 'stale'

/** One deduped learning-state record (latest per module). */
export interface BlueprintLearningEntry {
  /** Module path/id this status applies to. */
  module: string
  status: BlueprintLearningStatus
  /** ISO 8601 timestamp of when the status was recorded. */
  notedAt: string
  /**
   * Why this module was enqueued ('manual' | 'basic-discovery' | 'stale' | …),
   * recorded on 'queued'/'learning' so a restart can resume the work the user
   * actually asked for (#1132). Absent on older entries and on terminal
   * statuses.
   */
  reason?: string
  /**
   * Whether the enqueue was user-initiated (budget-exempt). Absent on older
   * entries — a resumed entry with no flag is treated as deliberate, since only
   * an explicit action (Learn / Learn all / onboarding) fills a queue that
   * survives to the next session.
   */
  deliberate?: boolean
}

/**
 * Cumulative brain-retrieval counters for one root (brain-first-retrieval,
 * Phase 4) — read from `flow/brain/.structure/brain-usage.json`, folded there
 * turn-by-turn by main's BrainUsageTracker. Missing/corrupt store → zeros
 * with a null `updatedAt` (the Learning panel hides the line then).
 */
export interface BrainUsageTotals {
  /** Brain searches observed (`planflow-ai brain search` Bash invocations). */
  searches: number
  /** Hits the search output flagged `● fresh` / `"freshness": "fresh"`. */
  freshHits: number
  /** Hits flagged `○ stale` / `"freshness": "stale"`. */
  staleHits: number
  /** Searches followed by a same-turn Grep/Glob/grep-rg-find fallback burst. */
  misses: number
  /** Cumulative ESTIMATED tokens saved by knowledge search: each hit-search
   *  priced at the median of the project's own measured exploration-burst
   *  costs (see main/agent/brain-savings.ts). An estimate, never a meter. */
  savedTokens: number
  /** Whether that price came from measured bursts rather than the flat
   *  default (#1280). Absent on stores written before the field existed —
   *  treated as uncalibrated, which is what they were. */
  calibrated?: boolean
  /** ISO 8601 timestamp of the last fold, or null when nothing was counted. */
  updatedAt: string | null
}

/**
 * What an `editor:resolveHunk` call actually did (#1290).
 *
 * - `resolved` — written; `hunks` is how many were resolved.
 * - `scope-changed` — the file drifted and MORE hunks are now in scope than
 *   the caller knew about. NOTHING was written; ask, then re-issue without
 *   `expectedHunks`. This is an OUTCOME, not a failure: a genuine failure
 *   (an unknown file, a stale hunk id) still rejects.
 */
export type ResolveHunkOutcome =
  | { status: 'resolved'; hunks: number }
  | { status: 'scope-changed'; hunks: number; expected: number }

/** Estimated tokens saved by knowledge search across ONE thread — recomputed
 *  on demand from the thread's persisted tool calls (sliced at user-message
 *  turn boundaries, tracker parity) plus the root's rolling burst samples
 *  (`threads:brainSavings`). Carries the root's cumulative total alongside so
 *  the chip can KEEP SHOWING project-wide savings when this thread has none
 *  yet (zero-everything still renders nothing). */
export interface BrainThreadSavings {
  savedTokens: number
  /** The project root's cumulative savedTokens across ALL threads
   *  (brain-usage.json) — the chip's keep-visible fallback. */
  rootSavedTokens: number
  /**
   * Whether the price-per-hit was MEASURED from this project's own bursts
   * (#1280). False means the estimator is still on its flat default, so the
   * token figure is a constant × the hit count — surfaces show the hits
   * instead of dressing that up as an estimate.
   */
  calibrated: boolean
  /** Hit-searches behind the figure — what the surfaces show uncalibrated. */
  hits: number
}

/**
 * A renderer-facing projection of ONE active investigation note from
 * `flow/brain/.structure/investigations.jsonl`. Main folds the note stream
 * (supersede chains collapsed — active = not superseded by any other note's
 * `supersedes` fingerprint) and projects each survivor to this compact shape.
 * The CLI's investigation-store is the AUTHORITY on the fold and fingerprint
 * (`<text>+<JSON array of sorted anchor refs>`); this mirror is intentionally
 * minimal (no cycle-rescue, no heat) and pinned by parity tests.
 */
export interface BlueprintInvestigation {
  /** Anchor refs the note attaches to (note order). */
  anchorRefs: string[]
  /** First line of the note text, truncated to 200 chars. */
  summary: string
  /** Where the note came from (observe command caller / skill). */
  provenance: string
  /** ISO 8601 timestamp of the note. */
  ts: string
  /** Stable identity `<text>+<JSON array of sorted anchor refs>`. */
  fingerprint: string
  /**
   * True when a learning-state entry for one of the note's modules is `stale`
   * — a cheap module-name join (NO content hashing in the app; the CLI
   * `blueprint stale-check` is the authority). Absent otherwise.
   */
  stale?: boolean
}

/** Who a drifted change is attributed to (mirror of drift-classify's DriftOrigin). */
export type BlueprintDriftOrigin = 'external' | 'yours' | 'agent'

/**
 * One source-file drift rolled up to its owning graph node (drift feature,
 * Phase 4). `dependents` is the node's blast radius (graphify `meta.degree`
 * else incident-edge count); `origin`/`author`/`commit` describe WHO/WHEN;
 * `acked` is true only when every committed file under the node is acknowledged.
 */
export interface BlueprintDriftNode {
  nodeId: string
  label: string
  origin: BlueprintDriftOrigin
  /** Author display name (or email) of the most-recent change; absent when unknown. */
  author?: string
  /** Commit hash of the most-recent change; absent for an uncommitted drift. */
  commit?: string
  /** Repo-relative drifted files under this node, sorted. */
  changedFiles: string[]
  /** Blast radius — dependents count driving the panel's ranking. */
  dependents: number
  /** True when every committed file under the node has been acknowledged. */
  acked: boolean
}

/**
 * One dependency/schema/config drift (drift feature, Phase 4) — the "system
 * changes" bucket the panel groups apart from source drift, since a user rarely
 * reasons about lockfile/migration/config churn line-by-line.
 */
export interface BlueprintSystemChange {
  path: string
  fileClass: 'dependency' | 'schema' | 'config'
  origin: BlueprintDriftOrigin
  /** Author display name (or email) of the last commit; absent when unknown. */
  author?: string
  acked: boolean
}

/**
 * The renderer-facing drift projection attached to a snapshot (drift feature,
 * Phase 4). `nodes` are capped and ranked by blast radius; `shown` + `overflow`
 * report the cap. Assembled by main's pure drift-assemble; omitted entirely when
 * drift-check has no baseline / could not run (all fail-soft).
 */
export interface BlueprintDrift {
  nodes: BlueprintDriftNode[]
  system: BlueprintSystemChange[]
  /** Number of nodes shown (after the cap). */
  shown: number
  /** Nodes beyond the cap, reported as a count. */
  overflow: number
}

/**
 * Trust-tier tallies for the board (trust-tiers Phase 4) — COUNTS ONLY over
 * the CLI's `file-tiers.json` sidecar (`src/cli/blueprint/file-tiers.ts`).
 * The board needs the claim-doc adjudication picture, not 4k file entries,
 * so main computes the tallies and the payload stays small.
 */
/** A claim file's adjudication state as shown per-row (unadjudicated = no verdict yet). */
export type BlueprintTierFileVerdict = 'corroborated' | 'contradicted' | 'unverifiable' | 'unadjudicated'

export interface BlueprintTierSummary {
  /** Total claim-tier entries (foreign docs — unverified statements about code). */
  claimTotal: number
  /** Claim docs adjudicated `corroborated`. */
  corroborated: number
  /** Claim docs adjudicated `contradicted`. */
  contradicted: number
  /** Claim docs adjudicated `unverifiable`. */
  unverifiable: number
  /** Claim docs with no verdict recorded yet. */
  unadjudicated: number
}

/**
 * CODE STORYLINE — mirror of `src/cli/blueprint/storyline-types.ts` (the CLI
 * is the one writer; this side only relays and renders). See that file for
 * the meaning of each field.
 */
/** `excerpt`: a few lines of a file a plan's file note is about, when no declaration holds its place. */
export type StorylinePieceKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'excerpt'

/** One declaration of the file: a box on the sheet. */
export interface StorylinePiece {
  /** Stable within one answer: `<file>#<name>` or `<file>#<Class>.<member>`. */
  id: string
  kind: StorylinePieceKind
  name: string
  /** The class a method belongs to. */
  className?: string
  /** Project-relative path of the file it lives in. */
  file: string
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  /** The first sentence of its doc comment, or null. */
  doc: string | null
  /** The exact source text, `startLine`..`endLine`. */
  text: string
  /** Exported from its module (a method: its class is exported). */
  exported: boolean
  isConstructor?: boolean
}

/** A call made inside a piece's body. */
export interface StorylineCall {
  /** The calling piece. */
  from: string
  /** 1-based absolute line of the call. */
  line: number
  /** The called piece of this answer, or null when it is not one. */
  to: string | null
  /** A call into another file of the project (resolved through a relative import). */
  external?: { file: string; name: string }
  /** A call nobody could name a target for — kept as plain text. */
  unresolvedName?: string
}

/** A piece naming a data structure of this answer in its types. */
export interface StorylineTypeUse {
  from: string
  to: string
}

/** A way into the story, ranked: the first is where it opens. */
export interface StorylineEntry {
  pieceId: string
  /** How many other project files import it by name. */
  usedFrom: number
}

export interface StorylineClass {
  name: string
  file: string
  startLine: number
  /** `constructor(deps: Deps)` — absent when the class declares none. */
  constructorSignature?: string
}

/** Mirror of the CLI's `StorylineLanguageId`. */
export type StorylineLanguageId = 'typescript' | 'javascript' | (string & {})

export interface StorylineResult {
  ok: true
  scope: 'file' | 'part'
  /** Project-relative paths read, in order. */
  files: string[]
  /**
   * The language read: `typescript` / `javascript` (the TypeScript compiler),
   * a tree-sitter language's id (`python`, `go`, …, `shared/storyline-languages`),
   * or `mixed` for a part whose files are in several.
   */
  language: StorylineLanguageId
  pieces: StorylinePiece[]
  calls: StorylineCall[]
  typeUses: StorylineTypeUse[]
  entries: StorylineEntry[]
  classes: StorylineClass[]
  /**
   * The plan's Today ⇄ After for this story — present only when the story was
   * asked for in a plan's context (`plan`) and that plan was found.
   */
  compare?: StorylineCompare
  /** Why a story asked for in a plan's context carries no `compare` (one sentence). */
  compareNote?: string
  /**
   * The story's files grouped by project — this project first — present only
   * when the story was opened for a plan that carries change notes. Every
   * story file is in exactly one band, spelled as `files` spells it.
   */
  bands?: StorylineBand[]
}

/**
 * One project's share of a story. A sibling project's files are spelled
 * `<project-slug>/<path>` in `files`, piece ids and calls.
 */
export interface StorylineBand {
  /** A sibling Workspace project's slug — null is this project. */
  project: string | null
  /** The project's colour slot (its position in the Workspace), when it is in one. */
  colorIndex?: number
  files: string[]
}

// ── Today ⇄ After (plan `story-today-after`) ────────────

/** What happened to one piece between the plan's starting point and the working tree. */
export type StorylinePieceChange = 'added' | 'removed' | 'changed' | 'same'

/** Where the starting point came from (see the CLI type for each). */
export type StorylineBaseSource = 'given' | 'run' | 'head' | 'worktree'

/** One line of a piece's diff. */
export interface StorylineDiffLine {
  op: 'context' | 'added' | 'removed'
  text: string
}

/** A run of nearby changed lines inside one piece, with a little context. */
export interface StorylineHunk {
  /** 1-based file line of the hunk's first Today line. */
  todayStart: number
  /** 1-based file line of the hunk's first After line. */
  afterStart: number
  lines: StorylineDiffLine[]
}

/** What the plan says will happen — labelled intent, never code. */
export type StorylinePrediction = StorylinePhasePrediction | StorylineNotePrediction

/**
 * A prediction read from the plan's phases and Story anchors — what a plan
 * WITHOUT change notes predicts (old plans, unchanged).
 */
export interface StorylinePhasePrediction {
  /** The piece it is about — absent for a planned piece or file that does not exist yet. */
  pieceId?: string
  file: string
  symbol?: string
  /** The plan phase that names it, or null when no phase does. */
  phase: number | null
  /** The plan's own words: the task line naming it, else its phase's first task. */
  task: string
  kind: 'changes' | 'planned' | 'planned-file'
}

// ── Change notes (plan `plan_change_review`) ────────────

export type PlanNoteKind = 'change' | 'new' | 'file'
export type PlanNoteStatus = 'proposed' | 'accepted' | 'rejected'
export type PlanNoteVerdict = 'done' | 'differs' | 'not-built'

/** Where a change note's quote was found in today's code. */
export interface NoteQuote {
  found: 'once' | 'none' | 'many'
  /** 1-based, inclusive. */
  startLine?: number
  endLine?: number
  /** How many times, when found more than once. */
  count?: number
}

/** One change note as the plan holds it (the plan file is the record). Mirror of the CLI's. */
export interface StorylineNote {
  n: number
  phase: number
  kind: PlanNoteKind
  /** The target as written. */
  target: string
  /** A sibling Workspace project's slug, when the target names one. */
  project?: string
  /** Project-relative path (relative to `project` when set). */
  file: string
  symbol?: string
  where?: string
  what?: string
  why?: string
  signature?: string
  purpose?: string
  callers?: string[]
  status: PlanNoteStatus
  reason?: string
  comments: string[]
  verdict?: PlanNoteVerdict
  verdictWhy?: string
}

/** What the real diff says about a note's function (or file), beside the note. */
export type StorylineNoteFact = 'changed' | 'added' | 'unchanged' | 'removed'

/** Fields every note prediction carries. */
export interface StorylineNotePredictionBase {
  /** The story file the note is about (`<project>/<path>` for a sibling project). */
  file: string
  note: StorylineNote
  /** The sibling project the note names. */
  project?: string
  /** The sibling project has no checkout on this machine. */
  codeUnavailable?: true
  /** The note's file is not in its project. */
  fileMissing?: true
  fact?: StorylineNoteFact
}

/** A change to an existing function. */
export interface StorylineNoteChangePrediction extends StorylineNotePredictionBase {
  kind: 'note-change'
  /** The function's piece — absent when it is not on the story. */
  pieceId?: string
  symbol: string
  /** The quoted lines of today's code (1-based, inclusive, file lines). */
  quoteLines?: { startLine: number; endLine: number }
  /** The quote is not in the function (or is found more than once) — nothing is highlighted. */
  quoteMissing?: true
  /** How many times the quote was found, when more than once. */
  quoteCount?: number
  /** The function is not on the story. */
  pieceMissing?: true
}

/** A function the plan adds. */
export interface StorylineNoteNewPrediction extends StorylineNotePredictionBase {
  kind: 'note-new'
  symbol: string
  signature: string
  purpose: string
  callers: string[]
  /** Caller name → its piece on the story; callers not found are left out. */
  callerPieces: Record<string, string>
  /** The function's piece, once the code has it (after execution). */
  pieceId?: string
}

/** A change to a file as a whole (a route table, a config). */
export interface StorylineNoteFilePrediction extends StorylineNotePredictionBase {
  kind: 'note-file'
  /** The piece holding the note's quote, when it has one and it was found. */
  pieceId?: string
  /** The quoted lines, found in the whole file (1-based, inclusive). */
  quoteLines?: { startLine: number; endLine: number }
  quoteMissing?: true
  quoteCount?: number
}

/** A plan WITH change notes predicts from its notes only — one per note, in plan order. */
export type StorylineNotePrediction =
  | StorylineNoteChangePrediction
  | StorylineNoteNewPrediction
  | StorylineNoteFilePrediction

export interface StorylineCompareSummary {
  changed: number
  added: number
  removed: number
  /** `changes` predictions the real diff has not (yet) confirmed, and change notes. */
  predicted: number
  /** Planned pieces and planned files; new and file notes. */
  planned: number
}

export interface StorylineCompare {
  /** The plan's name (its slug). */
  plan: string
  /** The starting commit — null when there is none (After is the prediction only). */
  base: string | null
  baseSource: StorylineBaseSource | null
  /** One sentence when a starting point was asked for and could not be read. */
  baseNote?: string
  /** Every After piece and every removed piece → what happened to it (empty without a base). */
  pieces: Record<string, StorylinePieceChange>
  /** Today's pieces that After no longer has, with Today's text. */
  removed: StorylinePiece[]
  /** Changed pieces → their line diff, capped. */
  hunks: Record<string, StorylineHunk[]>
  /** Changed pieces whose diff was cut at the cap → how many diff lines were left out. */
  hiddenLines: Record<string, number>
  /** Story files whose Today could not be read as code — not compared. */
  unreadable: string[]
  predicted: StorylinePrediction[]
  summary: StorylineCompareSummary
}

export type StorylineRefusalReason = 'unsupported-language' | 'syntax-error' | 'too-large' | 'no-compiler' | 'not-found'

/** Why a file cannot be read as a story — an answer, not a failure. */
export interface StorylineRefusal {
  ok: false
  reason: StorylineRefusalReason
  /** One sentence for the reader, in the terms of what is on screen. */
  sentence: string
  /** The file's text, for the plain read-only fallback (single files only). */
  text?: string
  file?: string
}

export type StorylineAnswer = StorylineResult | StorylineRefusal

// ── Plan change notes: read and decided (plan `plan_change_review`) ──

/** One note as `plan notes` reports it: the note, and (this project's change notes) where its quote is. */
export interface PlanNoteReport extends StorylineNote {
  quote?: NoteQuote
  /** The target file is not in the project. */
  fileMissing?: true
  /** The file is there but has no piece of that name. */
  symbolMissing?: true
  /** No reader could find the function's lines, so the quote was looked for in the whole file. */
  functionUnchecked?: true
}

/** Proposed notes are the unreviewed ones. */
export interface PlanNoteCounts {
  total: number
  accepted: number
  rejected: number
  unreviewed: number
}

/** A note line the parser could not read, with why. */
export interface PlanUnreadableNote {
  line: number
  reason: string
  n?: number
}

/** Why main could not read or write a plan's notes — one sentence for the reader. */
export interface PlanNotesFailure {
  ok: false
  /** The CLI's refusal reason (`unknown-plan`, `unknown-note`, …), or null when it never answered. */
  reason: string | null
  detail: string
}

export interface PlanNotesSnapshot {
  ok: true
  plan: string
  /** The plan file, relative to the project — for lookups, never for display. */
  path: string
  notes: PlanNoteReport[]
  counts: PlanNoteCounts
  unreadable: PlanUnreadableNote[]
}

export type PlanNotesAnswer = PlanNotesSnapshot | PlanNotesFailure

/** A status (with an optional reason) or a verdict (with its one sentence) — exactly one. */
export interface PlanSetNoteRequest {
  rootPath: string
  plan: string
  note: number
  status?: PlanNoteStatus
  reason?: string
  verdict?: PlanNoteVerdict
  why?: string
}

export interface PlanSetNoteSuccess {
  ok: true
  plan: string
  path: string
  /** Whether the plan file's bytes changed. */
  changed: boolean
  note: PlanNoteReport
}

export type PlanSetNoteAnswer = PlanSetNoteSuccess | PlanNotesFailure

/**
 * FEATURE PORTS — mirror of `src/cli/blueprint/feature-ports.ts` (the CLI
 * `blueprint features ports` is the one reader; this side only relays and
 * draws). What comes into a feature's diagram and what goes out of it. See
 * that file for the meaning of each field.
 */
export type PortDirection = 'in' | 'out' | 'linked'
export type PortTrust = 'code' | 'model' | 'declared'
/** Where a port came from: a connection (link or edge), or the view's own claim. */
export type PortSource = 'connection' | 'view'

/** The other end of a port, named only as finely as is known. */
export interface PortFarEnd {
  /** The far project's slug in the Workspace. Absent outside a Workspace. */
  project?: string
  /** Its display name, when the project is listed. */
  projectName?: string
  /** The far feature's slug. */
  feature?: string
  /** Its id (`feature:<slug>`), when the far store was read and holds it. */
  featureId?: string
  featureName?: string
  /** The far part's id, when exactly one part claims the anchor. */
  part?: string
  partName?: string
  /** Repo-relative file in the far project. */
  file?: string
  /** Function / symbol in that file, when the anchor names one. */
  symbol?: string
  /** The raw anchor, when the far end is an anchor. */
  anchor?: string
  /** True when the far end is in this project. */
  local: boolean
}

export interface FeaturePort {
  direction: PortDirection
  /** What crosses — the link note, else the relationship read from this side. */
  crosses: string
  far: PortFarEnd
  /** The curated component the near end touches, or null (drawn to the diagram's edge). */
  internalNode: string | null
  trust: PortTrust
  source: PortSource
}

export interface FeaturePorts {
  action: 'features-ports'
  /** The feature's id. */
  feature: string
  slug: string
  name: string
  /** The part, when the reference named one. */
  part: { id: string; name: string } | null
  /** This project's slug in its Workspace, or null outside one. */
  project: string | null
  workspace: { name: string; slug: string } | null
  in: FeaturePort[]
  out: FeaturePort[]
  linked: FeaturePort[]
  /** How many ports past the cap each side holds. */
  more: { in: number; out: number; linked: number }
  /** Lines of the Workspace's links that could not be read — reported, never fatal. */
  unreadableLinks: number
}

/** Why a feature's ports could not be read — an answer, not a failure. */
export interface FeaturePortsUnavailable {
  ports: null
  reason: string
  /** One sentence for the reader, in the terms of what is on screen. */
  sentence: string
}

export type FeaturePortsAnswer = FeaturePorts | FeaturePortsUnavailable

/**
 * Structured blueprint data for one root, read by main from FIXED paths
 * under `<root>/flow/brain/.structure/` — the renderer never supplies a file
 * path, only a rootId, so this channel cannot be used to read arbitrary
 * files. `graph: null` means no (or corrupt) graph.json.
 */
export interface BlueprintSnapshot {
  graph: BlueprintGraph | null
  annotations: BlueprintAnnotation[]
  /** Folded proposals from proposals.jsonl (empty when the store is absent). */
  proposals: BlueprintEffectiveProposal[]
  /** graph.json mtime, ms since epoch — null when the graph is missing. */
  mtime: number | null
  /** Compiled narrated story from story.json — undefined when missing/corrupt/invalid. */
  story?: BlueprintStory
  /** Deduped learning-state records — undefined when the store is missing/corrupt/empty. */
  learning?: BlueprintLearningEntry[]
  /** Active investigation notes (mirrored fold, capped) — undefined when none. */
  investigations?: BlueprintInvestigation[]
  /** True when active investigation notes exceeded the cap and were truncated. */
  investigationsTruncated?: boolean
  /**
   * Drift projection (drift feature, Phase 4) — source-file drift rolled up to
   * nodes plus a system-change bucket. Undefined when drift-check has no
   * baseline / could not run, or when there is no drift (all fail-soft).
   */
  drift?: BlueprintDrift
  /**
   * Trust-tier tallies (trust-tiers Phase 4) — undefined when file-tiers.json
   * is missing/corrupt/shape-invalid (fail-soft; the board then shows no Docs
   * row).
   */
  tiers?: BlueprintTierSummary
  /** Claim-tier FILES with their adjudication (capped) — the Learning panel's
   *  per-file trust column. Absent when the tier sidecar is missing/empty. */
  tierFiles?: Array<{
    path: string
    verdict: BlueprintTierFileVerdict
    /** Verdict origin (doc-verification): user | learn-pass | verify-agent | auto. */
    provenance?: string
    /** Per-claim rollup counts (verify-agent runs). */
    claims?: { corroborated: number; contradicted: number; unverifiable: number }
    /** True when the verdict's doc/witness hashes no longer match the tree —
     *  trust expired, treated as unadjudicated (revocation, decision #5). */
    stale?: boolean
    /** When the verdict was decided (ISO). Every verdict already records this;
     *  the snapshot used to drop it, so a doc marked `contradicted` could not
     *  say who decided or when (#1131). */
    verifiedAt?: string
    /** The verifier's one-line note — WHY it landed on this verdict. */
    evidence?: string
    /** Code files the doc was checked against, capped. Clickable peeks. */
    witnesses?: string[]
    /** Per-claim breakdown, capped: each statement and how it fared. */
    claimDetails?: Array<{
      text: string
      outcome: BlueprintTierFileVerdict
      evidence?: string
    }>
  }>
  /** Cross-project links (federation): folded consumer-side link state. */
  crossLinks?: BlueprintCrossLink[]
  /** Sibling surfaces visible in the vault (name + vintage + repo path). */
  siblings?: BlueprintSibling[]
}

/**
 * Result of a main-process `blueprint derive` run (blueprint:derive). The
 * CLI is resolved and spawned in MAIN with cwd = the validated root — the
 * renderer never supplies a command or path. `error` is a short one-line
 * reason for the view's calm failure state (never a command to run).
 */
export interface BlueprintDeriveResult {
  ok: boolean
  /** One-line failure reason; null when ok. */
  error: string | null
}

/**
 * One reconciled node (blueprint-simulation) — mirror of the CLI ReconcileNode.
 * State is the per-phase verdict of predicted vs actual touched nodes.
 */
export interface BlueprintReconcileNode {
  nodeId: string
  phase: number
  state: 'confirmed' | 'missed' | 'surprise'
}

/**
 * Response of `blueprint:reconcile` — the live change-simulation reconciliation
 * for a plan, computed by main via the bundled CLI `blueprint reconcile --json`.
 * `available: false` (with a one-line `reason`) when there is no baseline for the
 * plan's current hash (e.g. the plan changed, or was authored before the gate) —
 * the board then shows the predicted overlay only.
 */
export interface BlueprintReconcileResult {
  available: boolean
  reason: string | null
  nodes: BlueprintReconcileNode[]
  /** Unforeseen nodes (predicted in no phase) — the risk signal. */
  surprises: string[]
}

// ── feature blueprint (feature-blueprint) ──────────────────────────────────

/**
 * One node of the feature graph. THREE KINDS, TWO MEANINGS.
 *
 * `core` is a capability. `part` is a piece that capability is MADE OF — the
 * entries of its `## Parts` section, emitted as nodes by the CLI. `child` is a
 * CHANGE RECORD: a plan or an issue that once touched the feature. A change is
 * not a part, and the two must never be collapsed into one bucket again —
 * doing so is what put two plan names on Chats' ring under the words
 * "2 parts" while its ten real parts were invisible.
 */
export interface BlueprintFeatureNode {
  id: string
  slug: string
  name: string
  kind: 'core' | 'child' | 'part'
  parent?: string
  /** For a `part`: the slug of the feature it belongs to. Absent otherwise. */
  partOf?: string
  /** Grouping label for the board's root ring. HUMAN-OWNED; absent stays absent. */
  domain?: string
  understanding: 'none' | 'learning' | 'learned' | 'stale'
  /** True when a live plan touches one of this feature's anchors. */
  active: boolean
  anchorCount: number
  /**
   * What the anchors STAND ON, resolved on disk by the CLI: distinct files
   * and their lines. The Territory's area. Absent from an older bundle that
   * does not measure — the board then falls back to `anchorCount`.
   */
  size?: { files: number; lines: number }
  /** One line saying what this feature IS. Empty when it says nothing. */
  summary?: string
  /**
   * WHERE THE NODE LIVES — its top folders by lines, computed by the CLI on
   * every read (never stored). Absent when the CLI found no files for it, or
   * from a bundle that predates the field: no rows, never a guessed folder.
   */
  folders?: BlueprintFeatureFolders
  /**
   * WHAT KIND OF THING it is — the icon the board draws. Resolved once by the
   * CLI (the person's role, else the learned one, else the guess); the board
   * never re-derives it. Absent on a change, and from a bundle that predates it.
   */
  role?: FeatureRole
  /** Who answered `role`: a person, a learn pass, or the guess. Present exactly when `role` is. */
  roleSource?: FeatureRoleSource
}

/** One folder a feature or part lives in. Mirrors the CLI's `FolderRow`. */
export interface BlueprintFolderRow {
  /** Repo-relative folder path; `.` is the repository root. */
  path: string
  lines: number
  files: number
  /** Fraction 0..1 of the node's lines. */
  share: number
  /** A person chose this folder as the home. */
  pinned?: true
}

/** A node's folder rows. Mirrors the CLI's `FeatureFolders`. */
export interface BlueprintFeatureFolders {
  /** At most four, a chosen home first. */
  rows: BlueprintFolderRow[]
  /** How many folders the node's files fall in, before the cap. */
  folderCount: number
  /** No computed folder holds a clear majority of the node. */
  spread: boolean
  /** A person-chosen home exists and is `rows[0]`. */
  pinned: boolean
  /** A chosen home that is no longer a folder of the project, else null. */
  pinMissing: string | null
  files: number
  lines: number
  /**
   * The project's import index was not built yet, so the rows hold the
   * anchored and name-matched files only (no import trace). They are still
   * drawn; the next read after the background build is complete.
   */
  partial?: true
}

/** `blueprint:setFeatureHome` — exactly one of `folder` (repo-relative) or `clear`. */
export interface BlueprintSetFeatureHomeRequest {
  rootId: string
  /** The feature's id or slug, or a part's address (`feature:<f>/<part>`). */
  featureRef: string
  folder?: string
  clear?: boolean
}

/** What saving a home answered. `reason` is the writer's refusal code, or why it could not run. */
export type BlueprintSetFeatureHomeResult =
  | { ok: true; home: string | null; previous: string | null }
  | { ok: false; reason: string; folder: string | null }

/** A chosen home that no longer names a folder (the limitations disclosure). */
export interface BlueprintMissingHome {
  /** The feature's id, or the part's address. */
  id: string
  /** The owning feature's slug. */
  feature: string
  /** The part's name, or null for the feature itself. */
  part: string | null
  /** The folder as written. */
  home: string
}

/** A `relates` edge between two features — level 1 is a graph, not a list. */
export interface BlueprintFeatureEdge {
  from: string
  to: string
  /**
   * The mechanism changed since the edge was recorded, so the note is a claim
   * to verify rather than a fact to quote. Absent means fresh or unstamped —
   * the CLI's stale-check is the authority and this only carries its verdict.
   */
  stale?: boolean
}

/**
 * Response of `blueprint:features` — the feature graph, computed by main via
 * the bundled CLI. `available: false` (with a one-line reason) when the store
 * is empty or the CLI is missing; the board then shows its empty state.
 */
export interface BlueprintFeatureGraph {
  available: boolean
  reason: string | null
  nodes: BlueprintFeatureNode[]
  edges: BlueprintFeatureEdge[]
  /**
   * What the store is NOT saying (the feature map's limitations disclosure).
   *
   * `null` when the CLI did not report it — an older bundle, or an unavailable
   * graph. Null means UNKNOWN, and the board says so; it never renders unknown
   * as "nothing is missing", which is the exact lie this field exists to stop.
   */
  limitations: BlueprintFeatureLimitations | null
  /**
   * Whether the folder rows had the project's whole import index: `partial`
   * when it was cold (rows marked `partial`, a background build started),
   * `none` without a checkout. Absent from an older CLI.
   */
  importIndex?: 'complete' | 'partial' | 'none'
}

// ── The Workspace map (decision workspace-blueprint, 2026-10-06) ─────────────

/** How two projects' ends relate — `links.jsonl`'s vocabulary. */
export type BlueprintWorkspaceLinkKind = 'calls' | 'exposes' | 'consumes' | 'relates'

/** `local` has a checkout here; `remote` is drawn from the Workspace's shared knowledge. */
export type BlueprintWorkspaceProjectState = 'local' | 'remote' | 'unreadable'

/** One project of the Workspace, with its own feature graph — nothing merged. */
export interface BlueprintWorkspaceProject {
  id: string
  slug: string
  name: string
  description: string | null
  /** Position in the Workspace's project list — the stable colour slot. */
  colorIndex: number
  /** The project the board's own root is. */
  current: boolean
  /** This machine's checkout, or null when the project is not on this computer. */
  local: string | null
  state: BlueprintWorkspaceProjectState
  /** Why it could not be read, for `unreadable`. */
  error: string | null
  /** Where its size came from: measured now, the last known one, or none. */
  sizeSource: 'measured' | 'last-known' | 'none'
  /** The project's feature graph exactly as the board's own read returns it. Null when unreadable. */
  graph: { nodes: BlueprintFeatureNode[]; edges: BlueprintFeatureEdge[] } | null
  totals: {
    features: number
    lines: number | null
    understood: { done: number; total: number } | null
  }
  /** Links with this project on either end. */
  connections: number
}

/** One end of a Workspace link, resolved to the feature nodes it touches. */
export interface BlueprintWorkspaceLinkEnd {
  address: string
  project: string
  ref: string
  type: 'feature' | 'anchor'
  /** Core feature ids in `project` — empty when the end names nothing on the map. */
  features: string[]
}

export interface BlueprintWorkspaceLink {
  kind: BlueprintWorkspaceLinkKind
  note?: string
  /**
   * How the connection is known: `code` — connections learning matched a call
   * to an endpoint; `model` — the fast model suggested it (drawn lighter, named
   * "suggested by Flow"); absent — a person or a skill recorded it.
   */
  learned?: 'code' | 'model'
  from: BlueprintWorkspaceLinkEnd
  to: BlueprintWorkspaceLinkEnd
}

/**
 * The Workspace map — `blueprint workspace graph --json`, narrowed in main.
 * Fail-soft: `available: false` (with a reason) when the project is in no
 * Workspace or the read failed; the board then draws the project as before.
 */
export interface BlueprintWorkspaceGraph {
  available: boolean
  reason: string | null
  workspace: { name: string; slug: string } | null
  projects: BlueprintWorkspaceProject[]
  /** Null when the links could not be read — see `linksError`. */
  links: BlueprintWorkspaceLink[] | null
  /** One plain sentence when the links could not be read. */
  linksError: string | null
  /** How far connections learning has got over the Workspace's pairs of projects. */
  learning?: BlueprintConnectionsLearning | null
}

/** Connections learning's progress over a Workspace's pairs of projects. */
export interface BlueprintConnectionsLearning {
  pairs: number
  learned: number
  pending: number
  /** Pairs that cannot be checked yet (a project not learned, or unreadable). */
  blocked: number
  lastCheckedAt: string | null
}

/**
 * A connections-learning run, as main broadcasts it (`workspaces:connectionsLearning`)
 * and answers it (`workspaces:connectionsLearningStatus`). One run per Workspace.
 */
export interface ConnectionsLearningStatus {
  workspace: string
  running: boolean
  /** Pairs checked so far in this run, and the run's total. */
  done: number
  total: number
  /** Connections this run added. */
  found: number
  /** The pair being checked right now, or null (reading the projects, or done). */
  current?: [string, string] | null
  /** One plain sentence when the last run ended badly; null otherwise. */
  error: string | null
}

/** One node of a feature's code map. `part` is the first claimant; others badge. */
export interface BlueprintFeatureMapFile {
  /** Repo-relative posix path. */
  path: string
  /** Part that claimed it first; null when the feature's own anchors did. */
  part: string | null
  /** Directory anchors render as one folder node, never expanded. */
  kind: 'file' | 'folder'
  /** Other parts that also anchor this path. */
  badges: string[]
}

/** One import edge — both endpoints are always in the feature's file set. */
export interface BlueprintFeatureMapEdge {
  from: string
  to: string
}

/** An anchor that resolved to nothing — counted, never silently dropped. */
export interface BlueprintFeatureMapUnresolved {
  anchor: string
  reason: string
}

/**
 * Response of `blueprint:featureMap` — one feature's file graph (#1533),
 * computed on demand by the bundled CLI's `feature-map` verb. Fail-soft like
 * its `featureGraph` sibling: `available: false` with a one-line reason when
 * the CLI is missing, the feature is unknown, or the output refuses to parse.
 */
/**
 * One recorded coupling between two features, as `blueprint features
 * relations` reports it.
 *
 * `via` and `note` are the store's OWN words — the symbol that couples the two
 * and a hand-written sentence saying why — and they are deliberately absent
 * from `blueprint:featureGraph`, which carries the shape only. This is the
 * reader-of-one-feature channel that rule leaves open.
 */
export interface BlueprintFeatureRelation {
  /** The other feature's id. */
  target: string
  /** Its display name. */
  name: string
  /** The file or symbol that couples them, when the record names one. */
  via?: string
  /** One line of why, when the record has one. */
  note?: string
  /**
   * The mechanism `via` names has moved since the edge was recorded, so the
   * note is a claim to VERIFY rather than a fact to quote.
   */
  stale: boolean
}

/** Response of `blueprint:featureRelations`. Fail-soft like its siblings. */
export interface BlueprintFeatureRelationsResult {
  available: boolean
  reason: string | null
  feature: string
  name: string
  relations: BlueprintFeatureRelation[]
}

export interface BlueprintFeatureMapResult {
  available: boolean
  reason: string | null
  feature: string
  files: BlueprintFeatureMapFile[]
  edges: BlueprintFeatureMapEdge[]
  unresolved: BlueprintFeatureMapUnresolved[]
}

/** How much of the feature store is actually filled in. */
export interface BlueprintContentGaps {
  features: number
  withParts: number
  withLearned: number
  /** Bodies that refuse to parse — unreadable is not undocumented. */
  unreadable: number
}

/** One curated artifact that is broken, orphaned, or both. */
export interface BlueprintViewFailure {
  slug: string
  path: string
  state: 'invalid' | 'unreadable'
  orphaned: boolean
  /** Why it belongs to no feature. Empty when it does. */
  orphanReason: string
  /** The CLI validator's own messages, VERBATIM — never re-worded here. */
  errors: string[]
}

export interface BlueprintViewGaps {
  total: number
  valid: number
  broken: number
  orphaned: number
  failures: BlueprintViewFailure[]
}

export interface BlueprintFeatureLimitations {
  content: BlueprintContentGaps
  views: BlueprintViewGaps
  /**
   * Files in the feature directory the board did not draw, and files it drew on
   * a guess. Optional ONLY to admit a payload from a bundled CLI that predates
   * the field — an absent list means "this CLI could not say", never "nothing
   * was excluded", which is why the report distinguishes the two.
   */
  excluded?: BlueprintExcludedFeatureFile[]
  /**
   * Chosen homes that no longer name a folder. Optional for the same reason as
   * `excluded`: absent means this CLI could not say, never "none are missing".
   */
  missingHomes?: BlueprintMissingHome[]
}

/** One file the feature store declined, or admitted on a guess. Mirrors the
 *  CLI's `ExcludedFeatureFile` (separate runtimes, no shared import). */
export interface BlueprintExcludedFeatureFile {
  slug: string
  reason: 'working-set' | 'capture-note' | 'no-kind'
  /** False when the file IS drawn and the reason is a declared guess. */
  dropped: boolean
}

// ── corpus index (changes-discovery-view #1532) ────────────────────────────

/**
 * One change/discovery doc from the persisted corpus index — the app-side
 * mirror of the CLI's `CorpusIndexEntry` (`src/cli/blueprint/corpus-index.ts`;
 * separate runtimes, no shared import, so the shape is re-declared here on
 * purpose). `created`/`indexed` are optional ONLY to admit legacy records
 * written before the dates existed — the CLI writer always emits both.
 */
export interface BlueprintCorpusIndexEntry {
  /** Repo-relative doc path, e.g. `flow/plans/plan_x_v1.md`. */
  path: string
  /** Plans and archived docs are CHANGES; discovery docs are DISCOVERY. */
  kind: 'change' | 'discovery'
  /** Core feature this doc was parented under; null when unparented. */
  featureSlug: string | null
  /** Display name — the doc's `#` heading, or a title-cased slug. */
  name: string
  /** First-seen ISO date. Absent on a legacy record. */
  created?: string
  /** ISO timestamp of the pass that (re)wrote this entry. Absent on a legacy record. */
  indexed?: string
  /** True when the doc was sourced from `flow/archive/`. */
  archived: boolean
}

/**
 * Response of `blueprint:corpusIndex` — the persisted corpus index, read by
 * main straight off `flow/brain/.derived/corpus-index.json` (a plain file
 * read; no CLI spawn). Fail-soft by contract: a missing or unparsable index
 * is `indexedAt: null` with zero entries, never an error across IPC — the
 * index is derived and regenerable, so "not there yet" is an ordinary state.
 */
export interface BlueprintCorpusIndexResult {
  /** ISO timestamp of the pass that wrote the index; null when none exists. */
  indexedAt: string | null
  entries: BlueprintCorpusIndexEntry[]
}

// ── change brief (change-brief) ────────────────────────────────────────────

/** The kind of document backing a proposal — `none` when nothing on disk does. */
export type BlueprintProposalDocKind = 'plan' | 'discovery' | 'brainstorm' | 'none'

/** The document a proposal came out of, resolved by the CLI against disk. */
export interface BlueprintProposalSource {
  /** The proposal's `plan` field — the name the store recorded, verbatim. */
  plan: string
  /** Live doc basename backing it (no `.md`), or null when none survives. */
  doc: string | null
  kind: BlueprintProposalDocKind
}

/**
 * One proposal's claim on a node (discovery-view).
 *
 * `label` and `detail` travel WHOLE. Measured on this repo's live store, every
 * proposal derives as `changed` — the ordinary discovery view is marks on
 * boxes that already exist — so a payload that carried only the mark would
 * leave the renderer nothing to say beyond "something here moves".
 */
export interface BlueprintBriefProposal {
  /** Stable identity (`<plan>+<predictedNodeId>`). */
  fingerprint: string
  label: string
  detail?: string
  /** Anchor-derived: `changed` when it touches existing code, else `new`. */
  change: 'new' | 'changed'
  /** Lifecycle state at read time (`proposed` / `accepted` / `rejected`). */
  state: string
  /** What the proposal predicts — an extractor kind, or `part`. */
  kind: string
  resolvedAnchors: string[]
  /** Every anchor it was filed with (resolved or not), as `kind:ref`. */
  anchors?: string[]
  /** The plan phase that builds it, when it was filed with one. */
  phase?: number
  source: BlueprintProposalSource
}

/**
 * Why a node is in the brief, and whether its claim has actually happened.
 *
 * Two INDEPENDENT questions are answered per node — `existsToday` (is the box
 * real?) and `predicted` (is the claim unexecuted?) — because the ordinary case
 * is the one where they disagree: a proposal that CHANGES an existing module
 * draws a real box carrying an unbuilt claim. A renderer left to infer either
 * from the other eventually infers wrong, and the failure mode is a screenshot
 * of speculation that reads as the current architecture.
 */
export interface BlueprintBriefProvenance {
  source: 'graph' | 'story' | 'proposal'
  predicted: boolean
  proposals: BlueprintBriefProposal[]
}

/** A proposal the CLI recorded but will not draw, with the stated reason. */
export interface BlueprintBriefSkipped {
  fingerprint: string
  predictedNodeId: string
  reason: string
}

/**
 * The proposal layer at the brief's scope.
 *
 * `nothingProposed` is its own field rather than `nodes.length === 0` because
 * the two readings of an empty list are different facts — "this feature has no
 * upcoming change" is an answer, "nobody asked" is not — and the board's door
 * is absent for the first and for the second, but says different things about
 * why.
 */
export interface BlueprintBriefProposals {
  nodes: BlueprintBriefNode[]
  sources: BlueprintProposalSource[]
  nothingProposed: boolean
  summary: string
  skipped: BlueprintBriefSkipped[]
}

/** One node of the brief delta. `existsToday: false` ⇒ the plan introduces it. */
export interface BlueprintBriefNode {
  nodeId: string
  kind: 'stable' | 'modify' | 'new' | 'remove'
  existsToday: boolean
  label: string
  /** Predicted-vs-real and its evidence. Absent on an older CLI payload. */
  provenance?: BlueprintBriefProvenance
}

/** One directed wire of the brief delta. */
export interface BlueprintBriefWire {
  from: string
  to: string
  delta: 'kept' | 'added' | 'removed'
  labelBefore: string
  labelAfter: string
  /** False ⇒ withheld from the TODAY state (added, or an absent endpoint). */
  drawnToday: boolean
}

/** One story anchor plus whether it resolved — drives the honesty ledger. */
export interface BlueprintBriefAnchor {
  ref: string
  resolved: boolean
}

/** Story metadata the band and slots read (kicker picks the problem step). */
export interface BlueprintBriefStep {
  title: string
  kicker?: string
  body: string
  decisions: string[]
  rejected: string[]
}

/**
 * Response of `blueprint:brief` — the change-brief delta for a plan, computed
 * by main via the bundled CLI `blueprint brief --json`. `available: false`
 * (with a one-line `reason`) when there is no compiled story for the plan, or
 * the CLI is missing — the board then simply does not enter brief mode.
 *
 * `unchanged` and `fails` are AUTHORED claims that no extractor can produce;
 * the renderer's ledger must present them as unverifiable rather than let the
 * format's authority launder them into derived facts.
 */
/**
 * Who a feature-scoped brief is ABOUT — present only for `--feature` briefs.
 *
 * Deliberately separate from `steps`: story steps narrate a CHANGE, and a
 * feature's identity is not a change. Smuggling it through steps would make
 * the brief's problem band label a feature's own description "Known issue".
 */
/** A change record filed under a feature — its id makes it OPENABLE. */
export interface BlueprintBriefChild {
  id: string
  name: string
}

/** One thing learned about a feature, as the store records it. */
export interface BlueprintBriefLearning {
  text: string
  /** `code`, `human`, or `plan:<name>`. */
  provenance: string
  /** ISO date (YYYY-MM-DD). */
  date: string
  pinned?: boolean
  /** Present ⇒ replaced by a later learning, retained and demoted. */
  supersededReason?: string
}

export interface BlueprintBriefIdentity {
  name: string
  /** The feature's HUMAN prose only — learnings travel separately. */
  prose: string
  /**
   * The change records filed under this feature.
   *
   * Carries ids, not just names, because these are the ONLY way to reach a
   * child now: the card's drill chip is gone, so the brief's Changes row is
   * the navigation. A name alone can be printed but not opened.
   */
  children: BlueprintBriefChild[]
  /** The machine-owned `## Learned` section, parsed. */
  learnings?: BlueprintBriefLearning[]
}

export interface BlueprintBriefResult {
  available: boolean
  reason: string | null
  nodes: BlueprintBriefNode[]
  wires: BlueprintBriefWire[]
  fails: string[]
  anchors: BlueprintBriefAnchor[]
  steps: BlueprintBriefStep[]
  unchanged?: string
  identity?: BlueprintBriefIdentity
  /**
   * Which world the brief describes, as the CLI reports it: `anatomy` when no
   * plan is in flight (the brief is what EXISTS), `delta` when one is narrated
   * (Today ⇄ After). The CLI has always emitted this; the runner used to drop
   * it, so the board offered a Today/After switch on briefs that had no plan
   * to be before or after.
   */
  mode?: 'anatomy' | 'delta'
  /**
   * The proposal layer (discovery-view) — what a discovery or plan predicts at
   * this scope. Absent on an older CLI, which is NOT the same fact as
   * `nothingProposed: true`; the board hides its door for both and only calls
   * the second one an answer.
   */
  proposed?: BlueprintBriefProposals
  /**
   * The CURATED VIEW, when one has been generated for this feature — components
   * with human titles and LABELLED connections (feature-view #3). Absent until
   * a generation pass runs, and the board falls back to the anchor subgraph,
   * which is why this is optional rather than part of the brief proper.
   *
   * Deliberately typed loosely here: the CLI owns and VALIDATES the shape
   * (`src/cli/blueprint/feature-view.ts`), so re-declaring it in the contract
   * would create a second definition to drift from the one that refuses.
   */
  view?: Record<string, unknown>
  /**
   * The feature's PARTS — its children, each with its own anchors and its own
   * learnings. Typed loosely for the same reason as `view`: the CLI
   * (`src/cli/blueprint/feature-store.ts`) owns and validates the shape.
   */
  parts?: Array<Record<string, unknown>>
  /**
   * The repo-relative document a `--plan` brief described (`flow/…/<doc>.md`).
   * Absent on a `--feature` brief and on an older CLI. A door that pinned a
   * version compares it with the path it asked for: an older bundled CLI
   * accepts `--path` (another verb owns that option) and silently briefs the
   * NEWEST version instead.
   */
  docPath?: string
  /**
   * The features the document's anchors fall in, best first — a feature's
   * own anchors or its file set (`blueprint brief` computes it; one code
   * path). `project` names a sibling in this Workspace (null: this project),
   * `root` its checkout here (null: not on this computer). How the board
   * finds what a discovery is about before anything was proposed.
   */
  touches?: BlueprintBriefTouch[]
}

/** One feature a document touches (`BlueprintBriefResult.touches`). */
export interface BlueprintBriefTouch {
  project: string | null
  root: string | null
  featureId: string
  featureName: string
  parts: Array<{ id: string; name: string }>
  anchors: number
  specific: number
}

/**
 * Response of `blueprint:readBasic` — the in-memory BASIC fallback graph
 * main derives itself (no CLI) when the full derive is unavailable. Never
 * written to disk; `graph.basic` is always true when non-null. `graph:
 * null` means even the basic derivation found zero nodes (empty project)
 * — the only case left for the view's failure pane.
 */
export interface BlueprintBasicSnapshot {
  graph: BlueprintGraph | null
}

/**
 * "What was implemented" — a durable, CLI-INDEPENDENT view of the feature
 * work recorded in the project's plans. Sourced from plan-flow's plan files
 * (the same `## Phase N` + `**Files**:` declarations the review panel uses
 * for attribution), so a finished feature shows its phases and touched files
 * even when the full `planflow-ai blueprint derive` never ran. Read by main
 * from FIXED paths under `<root>/flow/plans/` and `<root>/flow/archive/` —
 * the renderer only ever supplies a rootId.
 */
export interface BlueprintFeaturePhase {
  /** Phase id, e.g. "phase-2". */
  phase: string
  /** Human label, e.g. "Phase 2". */
  label: string
  /** Phase title from the plan heading (e.g. "Content & markup"), or "". */
  title: string
  /** Declared/attributed path tokens (project-relative files, dirs, globs). */
  files: string[]
}

export interface BlueprintFeature {
  /** Feature slug from the plan filename (e.g. "coffee-3-steps"). */
  feature: string
  /** Plan filename (e.g. "plan_coffee_3_steps_v1.md"). */
  plan: string
  /** True when the plan lives in flow/archive/ (a completed feature). */
  archived: boolean
  phases: BlueprintFeaturePhase[]
  /** Distinct concrete files across all phases (globs/dirs excluded). */
  fileCount: number
}

export interface BlueprintFeaturesResult {
  features: BlueprintFeature[]
}

/**
 * Response for `blueprint:ackDrift` — the append outcome. Fail-soft: an unknown
 * root or an unwritable ack store yields `ok: false` rather than throwing across
 * the IPC boundary.
 */
export interface BlueprintAckDriftResponse {
  ok: boolean
}

/**
 * Response for `blueprint:driftReset` — "mark everything reviewed". Fail-soft:
 * an unknown root or a failed CLI spawn yields `ok: false` rather than throwing
 * across the IPC boundary.
 */
export interface BlueprintDriftResetResponse {
  ok: boolean
}

// ── Cross-project federation ────────────────────────────────────────────────

/** One consumer-side call site backing a cross-link — the EVIDENCE a user
 *  needs to judge a proposal (which file calls what, via which base). */
export interface BlueprintCrossLinkCall {
  file: string
  /** Env var name (baseIsEnv) or the raw base expression text. */
  base: string
  baseIsEnv: boolean
  /** The literal path portion of the call. */
  path: string
}

export interface BlueprintCrossLink {
  provider: string
  /** `GET /api/x` or `query Name`. */
  endpoint: string
  status: 'proposed' | 'confirmed' | 'rejected' | 'stale'
  confidence: 'high' | 'medium' | 'manual'
  /** Consumer files whose calls matched. */
  files: string[]
  surfaceDerivedAt: string
  /** Consumer-side call sites (joined from outbound.json at read time). */
  calls?: BlueprintCrossLinkCall[]
  /** Provider-side source file exposing the endpoint (from the sibling's
   *  vault graph), repo-relative in the PROVIDER's repo. */
  providerFile?: string
}

export interface BlueprintSibling {
  name: string
  repoPath: string
  surfaceDerivedAt: string
  endpointCount: number
}

// ── Invariant checker (#898 Phase B) ────────────────────────────────────────

/** How an invariant relates to a change — advisory, never gating. */
export type InvariantVerdictKind = 'violates' | 'touches' | 'clear'

/** One learned invariant judged against one changed file. */
export interface InvariantVerdict {
  /** Module directory (the module node's sourceFile), e.g. `src/api`. */
  module: string
  invariant: string
  verdict: InvariantVerdictKind
  filePath: string
  evidence: string
}

export type ModuleCheckStatus = 'checked' | 'no-invariants' | 'not-checked'

/** Per-module outcome of a checker pass — caps are loud, never silent. */
export interface ModuleCheckReport {
  module: string
  status: ModuleCheckStatus
  reason?: string
  /** True when the verdicts came from the hash cache (zero model calls). */
  cached?: boolean
}

export interface InvariantCheckResult {
  verdicts: InvariantVerdict[]
  modules: ModuleCheckReport[]
}

/** Latest completed checker pass for a root (`blueprint:listInvariantVerdicts`);
 *  nulls until the first pass lands. */
export interface InvariantCheckSnapshot {
  result: InvariantCheckResult | null
  checkedAt: string | null
}

/** Push payload for `blueprint:invariantVerdicts` — a pass just completed. */
export interface InvariantVerdictsEvent {
  rootId: string
  result: InvariantCheckResult
  checkedAt: string
}

// ── Agent loops (agent-loops, Phase 7) ──────────────────────────────────
//
// THE PANEL IS A VIEW. Every shape below is a narrowed copy of what the CLI's
// `loop status --json` already computes (src/cli/commands/loop.ts:
// StatusVerbResult / LoopStatusRow, src/cli/loop/run-log.ts: RunDigest), and
// the two write channels are narrowed copies of `loop pause|resume|approve`.
// Nothing here recomputes a loop's state: a pause set in the IDE and a pause
// set by a headless beat on another machine are the same write to the same
// state.json, because both go through the CLI.
//
// Field names are the CLI's own — a rename at this boundary would be a second
// vocabulary to keep in sync with the store.

/** Why a loop is currently stopped (CLI: PauseReport). */
export interface LoopPauseInfo {
  /** `global` stops every loop; `loop` stops only the named one. */
  scope: 'global' | 'loop'
  reason: string
  /** ISO timestamp the pause was set at. */
  since: string
  /** ISO timestamp it lifts at, when it expires on its own. */
  until?: string
}

/** Queue counts for one loop (CLI: LoopStatusRow['queue']). */
export interface LoopQueueCounts {
  open: number
  closed: number
  claimed: number
  awaitingApproval: number
  parked: number
  claimable: number
  maxOpenIssues: number
  capReached: boolean
}

/** Who currently holds one of a loop's run slots (CLI: LoopLockRecord). */
export interface LoopLockInfo {
  owner: string
  /** Which run slot this is — 1-based, and slot 1 is the original checkout. */
  slot: number
  acquiredAt: string
  expiresAt: string
}

/** Why a hunt is no longer running (CLI: InstructionStatus). */
export type LoopInstructionStatus =
  | 'active'
  | 'stopped'
  | 'dry'
  | 'capped'
  | 'elapsed'
  | 'met'

/**
 * HOW A HUNT ENDS — the rule chosen when it was started, mirroring the CLI's
 * `InstructionStop` (src/cli/loop/instructions.ts).
 *
 * Absent means the hunt is on its backstop alone, which is what every hunt
 * written before stop rules has. Never defaulted here: "nobody said" and
 * "somebody chose findings" are different facts and only one is a decision.
 */
export type LoopStopRule =
  | { kind: 'findings' }
  | { kind: 'duration'; hours: number; until: string }
  | { kind: 'custom'; rule: string }

/** What a surface asks for when it starts a hunt — the same three, without the
 * stamped deadline, which only the CLI's clock may compute. */
export type LoopStopChoice =
  | { kind: 'findings' }
  | { kind: 'duration'; hours: number }
  | { kind: 'custom'; rule: string }

/**
 * One standing hunt a producer is working through (CLI: Instruction) — what a
 * person typed, how many findings it has filed, its cap and its status.
 *
 * VERBATIM, LIKE EVERY OTHER SHAPE HERE. `filed` and `cap` are two numbers the
 * store already holds; nothing app-side turns them into a percentage, a
 * "remaining", or a status inferred from a count. The CLI's own comment on this
 * type says the same thing from the other end, which is the point of mirroring
 * the field names rather than renaming them at the boundary.
 *
 * `tag` IS THE LINK THAT DOES NOT EXIST, carried because the store carries it.
 * No filed item points back at an instruction: `file()` writes a loop marker, a
 * fingerprint over `{loop, title, primaryFile}` and the directive's own labels,
 * and the instruction's text appears in none of them — `tag` itself is only ever
 * preserved by the CLI, never written. So the board's filed-count filter is a
 * TOPIC filter that says so, rather than a lineage nobody recorded.
 *
 * NO BUDGET RIDES HERE, and none can. A run's budget is arithmetic over the
 * directive's `max_run_minutes` and the lock's `acquiredAt` (src/cli/loop/
 * run-budget.ts), and `loop status` reports the lock but NOT the minutes — so
 * "budget remaining" is not on this wire at all. A card computing it from the
 * lock's `expiresAt` would be reporting the TTL (the budget plus a wrap-up
 * margin) under the budget's name, which is exactly the kind of derived number
 * this boundary refuses.
 */
export interface LoopInstruction {
  /** The sentence a person typed. Its identity — retyping it resumes the hunt. */
  text: string
  /** The area its findings are tagged with, when one was ever chosen. */
  tag?: string
  /** How many findings it has filed, across every run. */
  filed: number
  /** The guard rail it stops at. */
  cap: number
  /** Consecutive runs that found nothing new. */
  quietRuns: number
  status: LoopInstructionStatus
  /** ISO instant it was first typed. */
  since: string
  /** How this hunt ends, when its author chose a rule. */
  stop?: LoopStopRule
}

/**
 * One loop's row. Mirrors the CLI's LoopStatusRow, INCLUDING its per-loop
 * fail-soft fields: a directive that would not parse or a queue backend that
 * could not be reached arrives as `directiveError` / `queueError` on an
 * otherwise-populated row, never as a missing loop.
 */
/**
 * What a loop is told, as it reads right now.
 *
 * `ok: false` carries the reason and leaves the fields at their empty values,
 * so a surface that forgets to check renders an empty editor rather than
 * inventing prose — the failure a reader can see, never one that looks like
 * "this loop says nothing".
 */
export interface LoopDescription {
  ok: boolean
  reason: string | null
  /** `## Direction`, trimmed. Empty when the section is absent. */
  direction: string
  /** `## Rules`, trimmed. Empty when the section is absent. */
  rules: string
  /** `max_open_issues` as the parser resolved it — the default included. */
  maxOpen: number | null
}

export interface LoopStatusRow {
  loop: string
  engine?: string
  /**
   * The area the directive points this loop at (`topic:`), when it names one.
   *
   * The panel RENDERS this and never derives it: the same field the CLI's own
   * human render puts in its bracket, carried through verbatim. Reading the
   * directive app-side to work out a loop's topic would be the second source of
   * truth this whole boundary exists to avoid.
   */
  topic?: string
  mission?: string
  slice?: string
  queueKind?: string
  queueLocation?: string
  /** True when the directive file itself says `paused: true`. */
  directivePaused?: boolean
  pause: LoopPauseInfo | null
  /**
   * Every slot this loop currently has a run in, lowest first — empty when idle.
   *
   * A LIST, BECAUSE A LOOP CAN RUN MORE THAN ONCE. It mirrored the CLI's single
   * `lock` until `max_concurrent_runs` landed; the CLI then began emitting
   * `locks` and this kept reading `lock`, so the bridge parsed `undefined` to
   * `null` and the panel reported every RUNNING loop as idle. No crash, no
   * warning — just a control centre quietly disagreeing with the thing it
   * controls, which is the failure mode a mirrored type has and a shared one
   * does not.
   */
  locks: LoopLockInfo[]
  lastOutcome?: string
  lastRunAt?: string
  /** Null when the queue could not be read — see `queueError`. */
  queue: LoopQueueCounts | null
  /**
   * Ids of the items waiting on a human, when the CLI reports them.
   *
   * EMITTED, AND READ. `loop status` fills this from the same single
   * `backend.list()` call that produces the row's counts (src/cli/commands/
   * loop.ts, `statusRow`: the open items with `approved: false`), so the count
   * and the ids are two answers to one read and cannot describe a queue state
   * that never existed. `approvalFor` in loops-panel-model.ts reads it to set
   * `actionable` — with ids the panel's approve control performs `loop approve
   * --loop <n> --id <id>` directly; without them it degrades to printing that
   * command for the user rather than pretending the control works.
   *
   * OPTIONAL, and it stays optional: the CLI omits it on a row whose queue
   * could not be read at all (it is set inside the same try that sets `queue`),
   * and an older CLI on a user's PATH predates it entirely. Absent therefore
   * means "not measured", exactly as `queue: null` does — never "nothing is
   * waiting", which is why nothing app-side defaults it to an empty array.
   */
  awaitingApprovalIds?: string[]
  /**
   * Open items whose claim has gone quiet for longer than a run may take
   * (CLI: LoopStatusRow.abandonedClaims).
   *
   * A DIFFERENT FACT FROM `stuckClaims`, which is why it is a different field
   * and why nothing may add the two together. This one is a CLOCK's answer —
   * the claim has not been touched since before the holding run's lock ran out,
   * which is true of a run that died and also true of one that is merely slow.
   * `stuckClaims` is the MACHINE's answer — the session the claim names is not
   * among the sessions running. The first needs no live-run snapshot and is the
   * only one that still fires when nothing recorded a session; the second is
   * exact but only answerable when something did.
   *
   * ABSENT IS NOT EMPTY, the same rule the two fields above it carry: the CLI
   * sets this inside the same try that sets `queue`, so a row whose queue could
   * not be read (or whose directive would not parse) omits it entirely. Empty
   * means the open items were read and every claim is recent.
   */
  abandonedClaims?: LoopAbandonedClaim[]
  /**
   * Open items held by a run that no longer exists (CLI: LoopStatusRow.stuckClaims).
   *
   * ABSENT IS NOT EMPTY, and reading it as empty is the one mistake that costs
   * the user the whole feature: absent means nobody could tell which runs are
   * alive, empty means the live-run snapshot WAS read and every claim's run is
   * still there. The activity read reports which of the two it is once, for the
   * whole answer (`LoopsActivity.stuck`), because a reader that saw an absent
   * field on every row would otherwise conclude the project is healthy on the
   * strength of a question nobody asked.
   */
  stuckClaims?: LoopStuckClaim[]
  /**
   * The standing hunts this loop's producer is working through.
   *
   * ABSENT means the store could not be read (see `instructionsError`); EMPTY
   * means this loop has none — the same distinction `queue: null` draws, and for
   * the same reason: a producer whose instruction file is corrupt has not
   * stopped hunting, it has stopped being able to say.
   *
   * REPORTED ON PRODUCER ROWS ONLY, and the CLI is explicit about why: the store
   * is ONE file per project keyed by instruction text, with no loop field on an
   * entry, so nothing on disk assigns a hunt to a loop. Two producers therefore
   * report the SAME hunts, which is why the board folds them into one card
   * naming both loops rather than drawing one hunt twice.
   */
  instructions?: LoopInstruction[]
  directiveError?: string
  queueError?: string
  /**
   * WHICH queue failure it was, when the CLI could name it.
   *
   * Carried beside the prose, never derived from it: the board needs to decide
   * whether it may offer a sign-in, and a UI that pattern-matched an error
   * sentence would break the day that sentence was reworded.
   */
  queueErrorKind?: 'not-installed' | 'signed-out' | 'bad-credentials' | 'unreachable' | 'rate-limited' | 'unknown'
  /** Why the instruction store could not be read, when it could not. */
  instructionsError?: string
}

/**
 * One open claim nobody has touched since before a run's lock would have run
 * out (CLI: `abandonedClaims` in `src/cli/loop/queue-backend.ts`).
 *
 * MIRRORED, NOT SHARED, like every other loop shape here. It carries no session
 * because it needs none: the whole point of this check is that it still answers
 * when the claim's owner records nothing a live-run snapshot could be matched
 * against — which is every claim taken by a run that was never told its session.
 */
export interface LoopAbandonedClaim {
  /** The item still held. */
  id: string
  /** Who holds it, exactly as the queue recorded it. */
  owner: string
  /** When it was taken. */
  claimedAt: string
  /** How long it has gone untouched, in milliseconds. */
  ageMs: number
}

/**
 * One item still held by a run that is gone (CLI: `src/cli/loop/stuck-claims.ts`).
 *
 * MIRRORED, NOT SHARED, like every other loop shape here — the CLI is ESM at
 * the repo root and this workspace is CommonJS. `sessionId` is the fact that
 * makes it nameable: the claim carries the session its run lived in, and that
 * session is not among the ones running.
 */
export interface LoopStuckClaim {
  /** The item still held. */
  id: string
  /** The loop it belongs to. */
  loop: string
  /** The run that took it, exactly as the queue recorded it. */
  owner: string
  /** The session that run lived in, and which no longer exists. */
  sessionId: string
  /** When it was taken, when the record carries a timestamp. */
  claimedAt?: string
}

/**
 * One background agent working in this project right now.
 *
 * `sessionId` is the only required field, for the same reason the main-process
 * reader gives: it is the identity a claim is bound to, and an entry missing
 * its display name is still a live run that must not be dropped.
 */
export interface LoopRunInFlight {
  sessionId: string
  /** The short id the agents list shows, when the entry carried one. */
  id: string | null
  /** The display name the session was started with, when it has one. */
  name: string | null
  /** The directory it was started under, when the entry carried one. */
  cwd: string | null
  /** Epoch ms it started, when the entry carried one. */
  startedAt: number | null
  /**
   * What it is doing, verbatim from the agents list.
   *
   * `blocked` IS THE ONE A READER MUST SEE. A background run that hit a
   * permission prompt sits blocked and looks alive from every other angle, so a
   * panel that shows only "2 running" leaves a person waiting on something that
   * is waiting on them.
   */
  state: string | null
}

/**
 * What is running for a project, or the reason nobody could say.
 *
 * A UNION ON `known`, so a consumer cannot read runs off an answer that has
 * none. Unknown is "we could not tell", never "nothing is running" — the same
 * safety property the CLI's stuck-claim check is built on.
 */
export type LoopsRunsReport =
  | { known: true; runs: LoopRunInFlight[] }
  | { known: false; reason: string }

/**
 * The stuck claims for a project, or the reason nobody could say.
 *
 * Same union, same rule, and it is REPORTED ONCE for the whole answer rather
 * than per row: the live-run snapshot is one snapshot, and a reader that saw
 * no claims on any row without knowing the question was never asked would call
 * a project healthy on the strength of silence.
 *
 * `known: true` MEANS EVERY LIST WAS READ. The CLI's own docblock names TWO
 * causes for an absent `stuckClaims` — "the queue was unreadable, or no
 * snapshot of the live runs was supplied" — and says it "must never be read as
 * 'nothing is stuck'". Reading only the second cause is how a `gh` outage on
 * one loop turned into a clean bill of health for the whole project (review
 * finding C3), so a row the CLI could not check makes this `known: false` even
 * when the live-run snapshot was perfect.
 *
 * A PARTIAL ANSWER IS STILL AN ANSWER, which is why the unknown branch may
 * carry claims. A project with one unreadable loop and one genuinely stuck item
 * has both facts, and dropping the found item to report the gap would trade one
 * silence for another. Absent `claims` on that branch means none was found, not
 * that none exists — nothing may render it as "nothing is stuck".
 */
export type LoopsStuckReport =
  | { known: true; claims: LoopStuckClaim[] }
  | { known: false; reason: string; claims?: LoopStuckClaim[] }

/**
 * Everything about a project's loops that costs more than a file read.
 *
 * THE SLOW HALF, DELIBERATELY SEPARATED FROM `loops:read`. Directive facts —
 * every loop, its mission, its list, whether it is switched on — are markdown
 * on local disk and answer in milliseconds. The counts behind them are a `gh`
 * round trip per loop, and the runs in flight are one Claude Code invocation.
 * Folding those into the panel's first read would MOVE the 2,103 ms the
 * directive reader removed rather than remove it, so they arrive on their own
 * channel and the cards render before they land.
 */
export interface LoopsActivity {
  /**
   * The CLI's own status read.
   *
   * Carries what a directive cannot: queue counts, standing hunts, the runtime
   * pause, and each row's stuck claims. FAIL-SOFT RATHER THAN NULL — a read
   * that could not happen arrives as `available: false` with the reason on it,
   * because "the counts are missing" and "the counts are zero" are different
   * answers and the panel says which.
   */
  status: LoopsSnapshot
  /** The background agents working in this project. */
  runs: LoopsRunsReport
  /** The claims whose run is gone — unknown when nobody could tell. */
  stuck: LoopsStuckReport
}

/** The rolled-up beat digest (CLI: RunDigest), minus its per-loop rows. */
export interface LoopDigest {
  entries: number
  beats: number
  success: number
  failure: number
  filed: number
  closed: number
  /**
   * Breaker trips the run log RECORDED — history, never a live state.
   *
   * The consecutive-failure breaker itself is gone (loops-native-runtime,
   * Phase 6): nothing counts failures and nothing can trip. The append-only run
   * log still holds the trips that really happened, so the digest still reports
   * them; a zero segment is dropped rather than printed.
   */
  breakerTrips: number
  pauses: number
  resumes: number
  approvals: number
  /** ISO timestamp of the first entry the digest covers. */
  since?: string
  /** ISO timestamp of the last entry the digest covers. */
  until?: string
}

/**
 * A project's loops, in one answer.
 *
 * TWO SOURCES NOW, ONE SHAPE. `loops:read` fills it from the DIRECTIVES on
 * disk — no subprocess, no network — and `loops:activity` fills the same shape
 * from the CLI's `loop status`, which additionally knows the counts, the hunts
 * and the runtime pause. The panel merges the second onto the first, so a
 * missing slow half costs detail and never a loop.
 *
 * FAIL-SOFT either way: an unreadable directory, no CLI, a refusal line, a
 * timeout or unparseable output all resolve to `available: false` with a
 * one-line `reason`, so the panel renders a notice instead of throwing. A
 * snapshot nobody could read is a NOTICE, not an empty list.
 */
export interface LoopsSnapshot {
  available: boolean
  reason: string | null
  loops: LoopStatusRow[]
  globalPause: LoopPauseInfo | null
  digest: LoopDigest | null
  /** ISO timestamp the CLI generated the report at. */
  generatedAt: string | null
}

/**
 * Which store a loop reads its work from — the directive's `queue:` kind.
 *
 * MIRRORED, NOT SHARED, like every other loop type here: the CLI's own
 * `LoopQueueKind` (src/cli/loop/types.ts). A row's `queueKind` stays a plain
 * `string` — it is whatever the CLI reported, including a kind a newer CLI knows
 * and this build does not — while this narrower type is what the app may ASK
 * for, and a request is exactly where an unknown word must not be sendable.
 */
/**
 * One item on a tracker, as the board's Remote column draws it.
 *
 * MIRRORS `NormalizedIssue` in main (src/main/issue-ref.ts) — the same shape the
 * importer already produces for a single issue, so an item read from a list and
 * an item fetched by reference are the same thing on this side of the bridge.
 */
/** One picture a ticket carries — its address on the tracker, and its name. */
export interface RemoteIssueImage {
  url: string
  name: string
}

export interface RemoteIssue {
  /** `owner/repo#12`, `PRJ-3`, … — how the tracker names it. */
  key: string
  title: string
  /** The body, capped by main. Empty when the tracker gave none. */
  description: string
  /** The tracker's own word for where it is: `open`, `In Progress`, … */
  status: string
  url: string
  /**
   * What a tracker prints beside a ticket. ABSENT MEANS IT DID NOT SAY, never
   * "none" — an absent field is not drawn, because "Priority: —" is a row of
   * chrome about an absence. Optional because the trackers disagree about which
   * exist: GitHub has no priority, Azure calls the reporter "created by".
   */
  type?: string
  priority?: string
  reporter?: string
  assignee?: string
  /**
   * The pictures on the ticket — ADDRESSES, never bytes.
   *
   * A screenshot is most of what a bug report says, so the card shows them;
   * but a list of thirty tickets that each inlined a megabyte of base64 would
   * be thirty megabytes across one IPC call. The bytes are asked for one at a
   * time by `integrations:imageData`, as each picture is drawn
   * (allowed-pattern #18).
   *
   * ABSENT IS NOT EMPTY. A provider whose payload was fetched without the
   * attachment field omits this; a ticket with nothing attached does too, and
   * neither draws a gallery.
   */
  images?: RemoteIssueImage[]
}

export type LoopSourceKind = 'github' | 'ledger'

/** Result of a `loops:setPaused` / `loops:approve` write. Fail-soft. */
export interface LoopsWriteResult {
  ok: boolean
  reason: string | null
}

// ── The queue itself (loops-on-the-board, Phase 4) ──────────────────────
//
// `loop status` reports how MANY items a loop has; `loop list` reports WHICH.
// A board's Todo column is a list of items, so it cannot be drawn from counts
// at all — which is the whole reason the read verb exists and the whole reason
// these shapes do. They are narrowed the same way `LoopStatusRow` is: field
// names are the CLI's own (src/cli/loop/queue-backend.ts: QueueItem,
// src/cli/commands/loop.ts: LoopListRow / ListVerbResult), unknown fields are
// dropped rather than guessed at, and NOTHING here is derived — a card shows
// what the queue said about an item, not what the app worked out about it.

/** Which slice of the queue a read covered (CLI: QueueItemState | 'all'). */
export type LoopQueueState = 'open' | 'closed' | 'all'

/** Why an item was closed (CLI: QueueCloseReason). */
export type LoopQueueCloseReason = 'done' | 'wontfix' | 'duplicate'

/**
 * One item in a loop's queue (CLI: QueueItem), backend-agnostic — a GitHub
 * issue and a ledger entry arrive in this one shape because the CLI already
 * materialized them into it.
 *
 * `body` is carried but deliberately NOT trimmed or parsed here: the markers it
 * holds (`loop:`, `loop-claim:`, `loop-plan:`) are already read back into
 * `loop`, `claimedBy` and `plan` by the backend, and a second parse app-side
 * would be a second reader of one record — the drift this boundary exists to
 * prevent.
 */
export interface LoopQueueItem {
  /** Backend-native id: a GitHub issue number, or the ledger's sequence id. */
  id: string
  /** The loop that filed it. */
  loop: string
  title: string
  /** The full body, markers included, verbatim. */
  body: string
  /** The dedup key, read back from the body's marker. */
  fingerprint: string
  /** The file the finding is primarily about, when it named one. */
  primaryFile?: string
  state: 'open' | 'closed'
  /** Labels as the backend holds them, reserved ones included. */
  labels: string[]
  /** Whether the approval gate is clear — the board's Blocked test, not ours. */
  approved: boolean
  /** The run id holding it, when claimed. */
  claimedBy?: string
  /** The queue's own record of who holds it — GitHub assignees. */
  assignees?: string[]
  claimedAt?: string
  /** The plan whose pipeline a run is advancing on this item, when recorded. */
  plan?: string
  createdAt: string
  closedAt?: string
  closeReason?: LoopQueueCloseReason
  /** A human-openable link, when the backend has one. */
  url?: string
  /** This loop's record that it is finished with an item it did not file. */
  handled?: { at: string; detail: string }
}

/**
 * One loop's slice of a queue read (CLI: LoopListRow).
 *
 * `items: null` IS THE POINT OF THIS TYPE. Null and empty are different answers
 * and the board must never confuse them: `[]` says the backlog is clear, and a
 * loop whose `gh` call failed has said nothing at all. Rendering an empty Todo
 * over an unreachable queue is precisely the failure this feature was asked to
 * avoid, so the reason travels as a string on `queueError` / `directiveError`
 * and the list stays null until something actually answered.
 */
export interface LoopQueueGroup {
  loop: string
  /** Which store answered — `github` or `ledger`, as the directive says. */
  queueKind?: string
  /** Repo-relative ledger path, or `owner/name` for GitHub. */
  queueLocation?: string
  /** The items the backend returned — or null when nobody could find out. */
  items: LoopQueueItem[] | null
  /** Why the directive could not be read, when it could not. */
  directiveError?: string
  /** Why the queue could not be read, when it could not. */
  queueError?: string
  /**
   * WHICH failure it was, when the CLI could name it — the half a control can
   * hang off.  is for reading; this is for deciding, and only
   * 'signed-out' has a remedy the board can offer.
   */
  queueErrorKind?: 'not-installed' | 'signed-out' | 'bad-credentials' | 'unreachable' | 'rate-limited' | 'unknown'
}

/**
 * Response of `loops:queue` — one `loop list` run, narrowed.
 *
 * FAIL-SOFT at two levels, and both are load-bearing: a missing CLI or an
 * unparseable report makes the whole snapshot `available: false` with a reason,
 * while one loop's unreachable backend leaves every other loop's list intact on
 * its own group. The panel's rule — nothing is computed that the CLI did not
 * report — is the same rule here.
 */
export interface LoopQueueSnapshot {
  available: boolean
  reason: string | null
  /**
   * The slice actually read, echoed by the CLI so no reader infers the default.
   * Null only when nothing was read at all.
   */
  state: LoopQueueState | null
  loops: LoopQueueGroup[]
  /** ISO timestamp the CLI generated the report at. */
  generatedAt: string | null
}

/**
 * Result of a `loops:claim` write — one `loop claim`, narrowed (CLI:
 * ClaimVerbResult, plus `refused` for the paths that exit non-zero).
 *
 * FOUR OUTCOMES, NOT TWO, because a claim has four and collapsing them into
 * ok/reason would make the board lie in the two interesting cases. `empty` is a
 * quiet queue and `lost` is another engineer's run getting there first —
 * neither is a failure, and a card bounced back to Todo with "failed" on it
 * would be reporting the system working as the system broken. Only `refused`
 * is a refusal, and its reason is the CLI's own line, verbatim.
 */
export interface LoopClaimResult {
  status: 'claimed' | 'empty' | 'lost' | 'refused'
  loop: string
  /** The run/owner id the CLI recorded on the claim — its own, not ours. */
  owner: string | null
  /** The CLI's reason line for `empty` / `lost` / `refused`. */
  reason: string | null
  /** The item, when the CLI named one — claimed, or the one that was lost. */
  item: LoopQueueItem | null
}

/**
 * Result of a `loops:unclaim` write — one `loop unclaim`, narrowed.
 *
 * `wasClaimed` is the CLI's own field and is carried rather than folded into
 * `ok`: RELEASING WHAT NOBODY HELD IS SUCCESS (the CLI says so), and a surface
 * that reported it as a plain "released" would tell the user it undid something
 * it did not. `ok: false` is reserved for a refusal — another owner's claim,
 * an unreachable queue, a CLI that is not there.
 */
export interface LoopUnclaimResult {
  ok: boolean
  /** The CLI's refusal line, verbatim, or null on success. */
  reason: string | null
  /** False when the item was not claimed in the first place. */
  wasClaimed: boolean
}

/**
 * Result of a `loops:close` write — one `loop close`, narrowed.
 *
 * `handled` IS NOT `closed` AND IS CARRIED AS ITSELF. A person's own issue is
 * never closed by a loop: the evidence gate still runs, the claim comes off, a
 * local record says it was handled — and the issue stays open until the pull
 * request that fixes it merges. Folding the two into `ok` would have the board
 * report an issue resolved that is still open in the tracker somebody else is
 * reading.
 */
export interface LoopCloseResult {
  ok: boolean
  /** The CLI's refusal line, verbatim, or null on success. */
  reason: string | null
  /** Which of the two settlements happened, or null when nothing did. */
  status: 'closed' | 'handled' | null
  /** The CLI's own note about what was and was not written, when it gave one. */
  note: string | null
}

/** Result of a `loops:finishHunt` write — one `loop finish`, narrowed. */
export interface LoopFinishResult {
  ok: boolean
  /** The CLI's refusal line, verbatim, or null on success. */
  reason: string | null
  /** How many hunts this loop still has RUNNING. Null when nothing landed. */
  remaining: number | null
}

/** Result of a `loops:forget` write — one `loop forget`, narrowed. */
export interface LoopForgetResult {
  ok: boolean
  /** The CLI's refusal line, verbatim, or null on success. */
  reason: string | null
  /** The sentences that were removed, as the store held them. */
  forgot: string[]
}

/**
 * Result of a `loops:file` write — one `loop file`, narrowed.
 *
 * `duplicate` IS NOT A FAILURE AND IS CARRIED RATHER THAN FOLDED INTO `ok`, on
 * the same rule `wasClaimed` follows above. The backend dedups on a fingerprint
 * over `{loop, title, primaryFile}` and exits 0 either way, so a second press —
 * or a producer that already filed the same finding — means THE WORK IS ON THE
 * LIST, which is what the person wanted, while nothing new was written. A
 * surface told only `ok: true` would report adding something it did not add.
 *
 * `status: null` is "the write landed and we could not read what it said" — an
 * exit code of 0 from a CLI whose output did not parse. The exit code is the
 * authority on whether it worked; the JSON is the authority on which of the two
 * it was, and an unreadable line loses the second answer only.
 */
export interface LoopFileResult {
  ok: boolean
  /** The CLI's refusal line, verbatim, or null on success. */
  reason: string | null
  /** Which of the two successes it was, or null when the report did not parse. */
  status: 'filed' | 'duplicate' | null
}

// ── Project ─────────────────────────────────────────────────────────────

/**
 * Per-root provisioning readiness (#513, progressive-learning phase 1):
 * `idle` — no run pending (never provisioned, or provisioned before this
 *   field existed, or a version-drifted root waiting for the next trigger);
 * `provisioning` — the bundled CLI is actively running for this root;
 * `ready` — stamped at the current bundled-CLI version, nothing to run;
 * `failed` — the last run errored; the root is left unstamped so the next
 *   trigger (activation, manual re-provision) retries automatically.
 * In-memory only — never persisted, recomputed on every restore from
 * `provisionedVersion` vs the bundled CLI's version.
 */
export type ProvisioningState = 'idle' | 'provisioning' | 'ready' | 'failed'

/**
 * A root's answer to the one-time "Run a basic discovery?" onboarding ask
 * (#513, progressive-learning phase 2). Persisted per root; absent (undefined)
 * means never asked/answered — the ask fires only while it is absent.
 */
export type BasicDiscoveryAnswer = 'yes' | 'no'

/** A registered project: one root the app has added. The ONE definition — main's ProjectRegistry re-exports it. */
export interface RegisteredProject {
  id: string
  windowId: string
  /** Absolute path — the key the project domain is addressed by. */
  rootPath: string
  position: number
  addedAt: string
  /** Whether the root's directory is currently reachable (#263). A persisted root
   *  whose folder isn't mounted at boot is kept but flagged `available: false` so
   *  the sidebar can show it greyed-out instead of silently dropping it. Absent =
   *  available (backward compatible for existing consumers/persistence). */
  available?: boolean
  /** ISO timestamp this root was last auto-provisioned (ide-auto-provisioning).
   *  Absent = never provisioned (or provisioned before this field existed). */
  provisionedAt?: string
  /** plan-flow version that performed the provisioning recorded in `provisionedAt`. */
  provisionedVersion?: string
  /** Live provisioning readiness (#513) — see `ProvisioningState`. Absent is
   *  treated as `idle` by consumers (backward compatible). */
  provisioningState?: ProvisioningState
  /** This root's answer to the basic-discovery onboarding ask (#513 phase 2).
   *  Absent = never asked/answered — the ask fires only while absent. */
  basicDiscoveryAnswer?: BasicDiscoveryAnswer
  /** User-picked accent color override (`#rrggbb`). Absent = no override —
   *  the deterministic hash accent (project-accent.ts) applies. */
  accentColor?: string
}

/** One level of a lazy directory listing (matches main's DirectoryEntry). */
export interface DirectoryEntry {
  name: string
  /** Absolute path. */
  path: string
  type: 'file' | 'directory'
}

/** One matched line within a file (project:searchContent). */
export interface ContentSearchMatch {
  /** 1-based line number of the match. */
  line: number
  /** 0-based column of the first match on the line. */
  column: number
  /** The matched line, trimmed to a preview length. */
  preview: string
}

/** One file with ≥1 content match (project:searchContent). */
export interface ContentSearchFile {
  /** Repo-relative POSIX path. */
  relPath: string
  matches: ContentSearchMatch[]
}

/** The result of a content search over one root (project:searchContent).
 *  `truncated` is true when a `maxResults`/walk cap stopped the search early. */
export interface ContentSearchResult {
  files: ContentSearchFile[]
  truncated: boolean
}

/** A slash command / skill available in a project (`.claude/commands/*.md`),
 *  surfaced by the composer's `/` autocomplete. */
export interface SlashCommand {
  /** Command name without the leading slash (the file basename). */
  name: string
  /** One-line summary from the file's frontmatter `description:`. */
  description: string
}

export type FileChangeType = 'created' | 'changed' | 'deleted'

export interface FileChange {
  type: FileChangeType
  /** Absolute path of the changed file/directory. */
  path: string
}

/** Debounced batch of file events for one root (matches main's emission). */
export interface ProjectFilesChangedEvent {
  rootPath: string
  changes: FileChange[]
}

/** App-wide onboarding + autonomy state (#48). */
/** Why a sign-in ended, in Flow's vocabulary rather than the tool's. */
export type RuntimeLoginFailure =
  | 'config-unreadable'
  | 'not-installed'
  | 'cancelled'
  | 'timeout'
  | 'failed'

/**
 * An external runtime's sign-in, as it happens.
 *
 * `url` + `code` are what a device-code flow gives a graphical app to show:
 * measured from `copilot login --device-code`, which prints
 * "visit https://github.com/login/device and enter code 6CB7-0989".
 *
 * NO TOOL OUTPUT CROSSES THIS BOUNDARY. Relaying the last line it printed
 * produced "Codex sign-in did not complete — in `model_reasoning_effort`",
 * which is half of a config parse error shown to somebody who pressed a button
 * called Sign in. Failures arrive classified; the raw text stays in the log.
 */
export interface RuntimeLoginProgress {
  provider: string
  kind: 'url' | 'code' | 'done' | 'error'
  url?: string
  code?: string
  reason?: RuntimeLoginFailure
}

export interface OnboardingState {
  /** The first-run wizard has been completed at least once. */
  completed: boolean
  /** New threads default to bypassPermissions ("Autonomous mode"). */
  autonomyBypassDefault: boolean
}

/** A brain tier a hit came from. */
export type BrainKind = 'feature' | 'error' | 'decision' | 'structure'

/** One retrieval hit from `brain:query`. */
export interface BrainHit {
  /** Root-relative path of the source markdown/graph. */
  path: string
  title: string
  snippet: string
  kind: BrainKind
}

/** Response for `brain:query`. */
export interface BrainQueryResult {
  hits: BrainHit[]
}

/** Response for `brain:capture`. */
export interface BrainCaptureResult {
  captured: boolean
  /** Root-relative path of the written raw record, when captured. */
  rawPath?: string
  /** Number of files in the captured working set. */
  fileCount: number
}

export interface FileContent {
  relPath: string
  content: string
  /** True when the file looks binary and `content` is empty. */
  binary: boolean
  /**
   * True when the file exceeds the read size limit and was not loaded. `content`
   * is empty and `binary` is true (so the editor treats it as a read-only
   * placeholder), but this flag lets the UI show an accurate "too large" message
   * instead of the binary one. Omitted (undefined) for normal files.
   */
  tooLarge?: boolean
  /**
   * True when the file on disk starts with a UTF-8 BOM (#1147). `content` has
   * it STRIPPED — the BOM is a property of the file, not of its text, and a
   * stray U+FEFF is noise in the editor, in search, and in diffs. The save path
   * restores it from the file's own bytes, so consumers never carry it.
   */
  hasBom?: boolean
  /**
   * True when the request said `missingOk` and the file does not exist. `content`
   * is empty and `binary` is true (the same read-only placeholder as tooLarge),
   * so a reader that ignores the flag still never mistakes it for an empty file.
   */
  missing?: boolean
}

// ── Project context (Zed-style active-project scoping) ───────────

/** An open editor tab, addressed within a project. */
export interface OpenFileRef {
  rootPath: string
  relPath: string
  /**
   * True for an unsaved ⌘N scratch note (#941), which is NOT a path on disk:
   * `relPath` is its display name (`Untitled-3`) and there is nothing to read.
   * Persisting it as an ordinary ref made restore call readFile on a path that
   * exists nowhere, so the tab and its typed text were silently dropped (#1441).
   * Absent on rows written before that fix — undefined means "a real file".
   */
  untitled?: boolean
  /**
   * Marks WHICH tab was active (#1481). The active file used to be persisted
   * separately as a bare project-relative path (`ProjectContext.activeFile`)
   * and restored by re-joining it against the ACTIVE project's root — so in a
   * multi-project thread, where two repos routinely hold the same `src/index.ts`,
   * a reload silently re-activated the OTHER repo's identically-named file.
   * A file's identity is (root, path); the pointer has to carry both. Rides in
   * the same JSON array, so rows written before this simply fall back to
   * `activeFile`.
   */
  active?: boolean
  /**
   * For a tab saved with an unsaved buffer: a hash of the DISK content that
   * buffer was typed over. On restore, a disk that no longer matches means the
   * file changed since — the buffer comes back flagged so a save asks before
   * overwriting the newer version, never silently reverting it. Absent on
   * clean tabs and on rows written before it existed.
   */
  dirtyBaseline?: string
  /**
   * Which in-memory buffer an unsaved snapshot was taken from (an id unique to
   * one renderer run). A restore that finds that very buffer still alive keeps
   * it — it is newer than the snapshot — instead of reverting it.
   */
  dirtyModel?: string
}

/**
 * The persisted, restorable state of one project's window. Everything the
 * app rebinds when a project becomes active. See ADR-002.
 */
export interface ProjectContext {
  rootPath: string
  /** Editor tabs, in order. */
  openFiles: OpenFileRef[]
  /** relPath of the active editor tab, if any. */
  activeFile: string | null
  /** Last thread selected in this project (re-selected on switch). */
  activeThreadId: string | null
  /**
   * Unsaved (dirty) buffer contents keyed by absolute file path, captured when
   * the project was switched away from. Rehydrated into the reopened tabs so a
   * project switch never silently destroys typed-but-unsaved work (#955).
   */
  dirtyBuffers: Record<string, string>
}

/**
 * One editor-area VIEW that belongs to a tab set (a feature view, the
 * blueprint, the browser, the Changes tab, …) — enough identity to reopen it
 * lazily. `kind` names the surface that knows how to rebuild it; `state` is
 * that surface's own JSON (a slug and doc path, a URL, a document it showed).
 */
export interface OpenViewRef {
  kind: string
  state: Record<string, string | number | boolean | null>
  /** True for the tab that was active when the set was captured. */
  active?: boolean
}

/**
 * The editor tabs of ONE conversation — or of the project while no
 * conversation is selected. Keyed in main by (project root, thread id | null);
 * switching threads swaps the whole set (files, unsaved buffers, views).
 */
export interface TabSet {
  /** File tabs, in order (scratch notes included, `untitled: true`). */
  openFiles: OpenFileRef[]
  /** Legacy relPath pointer to the active file (refs carry `active` now). */
  activeFile: string | null
  /** Unsaved buffer contents keyed by absolute path (or a note's synthetic id). */
  dirtyBuffers: Record<string, string>
  /** Views open in this set, in tab order. */
  openViews: OpenViewRef[]
}

// ── Thread scope (multi-project threads — the thread IS the project scope) ─

/**
 * One root in the active thread's scope. Derived by main's thread-scope layer
 * (`src/main/project/thread-scope.ts` — the one scope source of truth) from
 * the thread's primary `project_root` + its `thread_roots` extras, joined
 * against the project root list for identity + availability.
 */
export interface ThreadScopeEntry {
  /** Project root id (UUID). Empty string when the thread root has no
   *  project record yet — the auto-open phase materializes it. */
  rootId: string
  /** Absolute path — the key the project domain is addressed by. */
  rootPath: string
  /** Display name — the path's last segment for a project, and for a thread's
   *  own checkout the project's name plus whose copy it is (the checkout's
   *  folder is named after the thread id, and a UUID names nothing). */
  name: string
  /** True for the thread's primary root (threads.workspace_root). Always first. */
  primary: boolean
  /**
   * True when this root is the thread's OWN CHECKOUT rather than the project.
   *
   * A FLAG, NOT A NAME. The checkout is deliberately displayed under the
   * project's name — its folder is a UUID, which names nothing — and that made
   * the two indistinguishable on screen: a reader in a thread's copy saw a file
   * tree headed `orbit-app` and had no way to tell it from the project's own
   * (user, 2026-09-16). Consumers that want to say so need a fact they can
   * render, never a string they have to parse.
   *
   * Optional, so every existing consumer is untouched and absent reads as "an
   * ordinary project root" (allowed-pattern #23).
   */
  threadCopy?: boolean
  /** Availability from the project record (#263). A root with no project
   *  record is `false` until the auto-open phase materializes it. */
  available: boolean
  /** User accent override from the project record (`#rrggbb`). Absent = no
   *  override — consumers fall back to the deterministic hash accent. */
  accent?: string
}

/**
 * The active thread's ordered root set: primary first, then additional roots,
 * deduped. `threadId` is null when no thread is active — the scope then
 * degrades to the active project's single root (or empty when no project is
 * active), carrying exactly today's single-root semantics.
 */
export interface ThreadScope {
  threadId: string | null
  roots: ThreadScopeEntry[]
}

// ═══════════════════════════════════════════════════════════════════════
// Invoke channels (renderer → main, request/response)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Non-secret account metadata surfaced to the renderer. Never includes the
 * account's config-dir path or any token — those stay in the main process.
 */
export interface AccountSummary {
  id: string
  label: string
  identityHint: string | null
  createdAt: string
  isDefault: boolean
}

/** Which account a project resolves to (settings UI — no availability probe).
 *  `source` distinguishes a project PINNED to this account (`override`) from one
 *  that merely INHERITS the app default (`default`) — rendering them the same
 *  made "Use default account" an unreachable state and a following project look
 *  pinned (#1108). */
export type AccountResolutionSummary =
  | { status: 'legacy' }
  | { status: 'ready'; accountId: string; label: string; source: 'override' | 'default' }
  | { status: 'dangling'; accountId: string }

// ── Feature view sharing (feature-view-sharing Phase 5) ──────────────────
//
// What the renderer sees of a share: the server's summary, the local facts the
// author confirms before publishing, and a refusal in plain words. NEVER a
// token — the author's session token is read in main at the moment of each
// request and nothing below can hold it (the credentials invariant above).

/**
 * What changed about Flow's own sign-in (`auth:changed`). Surfaces re-read the
 * state they draw; nothing branches on who somebody is.
 */
export type AuthChangeCause = 'signed-in' | 'signed-out' | 'session-rejected'

/**
 * Why a share call was refused. The server's own words (`ShareRefusalReason`)
 * plus the ones Flow decides before anything leaves the machine.
 */
export type ShareClientRefusalReason =
  | ShareRefusalReason
  /** This build was made without a share host. */
  | 'sharing-unavailable'
  /** Nobody is signed in to Flow on this computer. */
  | 'signed-out'
  /** The path is not a discovery document inside a known project. */
  | 'not-a-discovery'
  /** The discovery has no walkthrough page beside it. */
  | 'page-missing'
  /** One of the two files could not be read. */
  | 'unreadable'
  /** The files changed between the author's review and the publish. */
  | 'changed-since-review'
  /** A revoke arrived without the author's explicit confirmation. */
  | 'not-confirmed'
  /** The share host did not answer (offline, timed out). */
  | 'unreachable'
  /** The project's sharing id could not be read or stored in its settings. */
  | 'project-settings'

/** A refusal: a code to branch on and one plain sentence to show. */
export interface ShareRefusal {
  ok: false
  reason: ShareClientRefusalReason
  /** No commands, paths or config keys (forbidden-pattern #12). */
  message: string
}

/** One of the two files a share sends — by name, size and hash, never content. */
export interface ShareLocalFile {
  part: 'walkthrough' | 'discovery'
  /** The file's name, e.g. `discovery_x_v2.walkthrough.html`. */
  name: string
  /** UTF-8 bytes, exactly what would be uploaded. */
  bytes: number
  /**
   * sha256 (lower-case hex) of the bytes main read — from the SAME read the
   * size came from. A publish carries it back as `reviewed`, so a same-size
   * rewrite between look and press is refused (review L-5).
   */
  sha256: string
}

/** What Flow would publish for this discovery, read fresh from disk. */
export interface ShareLocalFacts {
  project: string
  slug: string
  title: string
  discoveryVersion: number
  /** The walkthrough page's mtime, ISO 8601. */
  pageModifiedAt: string
  files: ShareLocalFile[]
  totalBytes: number
  /** The server's cap for one version (`SHARE_MAX_VERSION_BYTES`). */
  maxBytes: number
}

export type ShareGetResult =
  | { ok: true; share: ShareSummary | null; local: ShareLocalFacts }
  | ShareRefusal

export type ShareSummaryResult =
  | {
      ok: true
      share: ShareSummary
      /**
       * People the server did not email because of its sending limits (review
       * R2-L5). Absent or 0 when everyone asked for was emailed. The author is
       * told, so they can send those people the link themselves.
       */
      invitesSkipped?: number
    }
  | ShareRefusal

export type ShareViewsResult = { ok: true; views: ShareView[] } | ShareRefusal

/** The discovery a share call is about: its project root and repo-relative path. */
export interface ShareDocRef {
  /** Absolute project root (addressing convention). */
  rootPath: string
  /** Repo-relative discovery path, e.g. `flow/discovery/discovery_x_v2.md`. */
  docPath: string
}

/** What a publish says the author reviewed: both files' hashes (and sizes, for display). */
export interface ShareReviewed {
  walkthroughBytes: number
  discoveryBytes: number
  walkthroughSha256: string
  discoverySha256: string
}

export interface SharePublishRequest extends ShareDocRef {
  /**
   * What the author was shown and confirmed. REQUIRED: main re-reads both
   * files and refuses (`changed-since-review`) when either HASH differs, then
   * uploads exactly the bytes it hashed — so what is uploaded is what was
   * confirmed (review L-5). The sizes are carried for display only; a same-size
   * rewrite is caught by the hash, never by them.
   */
  reviewed: ShareReviewed
  /** Required on the first publish; omitted later keeps the list. */
  access?: ShareAccess
  notify: boolean
  expiresAt?: string | null
}

export interface ShareUpdateRequest {
  id: string
  access?: ShareAccess
  notify?: boolean
  expiresAt?: string | null
}

export interface ShareRevokeRequest {
  id: string
  /** Revoking is never a default — the caller must say a person asked. */
  confirmed: true
}

export interface IpcInvokeMap {
  // threads
  'threads:list': {
    // `limit` caps the result to the most-recent N (updated_at DESC) — set only
    // by genuinely bounded callers (e.g. the palette's recents). Omitted =
    // everything, which the sidebar history and the count-for-destruction
    // callers rely on (allowed-pattern #18).
    request: { projectRoot?: string; includeArchived?: boolean; limit?: number; includeChildren?: boolean }
    response: ThreadSummary[]
  }
  /** The promoted sub-agent CHILD threads of a parent, for nesting (#1931). */
  'threads:children': {
    request: { parentThreadId: string }
    response: ThreadSummary[]
  }
  /**
   * Promote a sub-agent (a parent Task tool-call) to a real, navigable CHILD
   * thread, or return the existing one — idempotent by parent + origin tool-call
   * (#1931). Re-homes the sub-agent's persisted rows into the child so the
   * conversation pane can switch to it. Returns the child summary.
   */
  'threads:openSubagent': {
    request: { parentThreadId: string; toolCallId: string }
    response: ThreadSummary
  }
  'threads:get': { request: { threadId: string }; response: ThreadDetail | null }
  /**
   * Every thread's live background work, keyed by thread id.
   *
   * What a surface reads when it MOUNTS: the `background-tasks` stream event
   * carries every change from that point on, but a sidebar opened while four
   * agents are already running has missed all of them, and the runtime only
   * re-announces a set that has CHANGED. Without this read, a panel could stay
   * blank through an entire multi-agent run and only come alive at the end.
   *
   * A thread with nothing running is simply absent from the record.
   */
  'threads:backgroundTasks': {
    request: Record<string, never>
    response: Record<string, BackgroundTaskInfo[]>
  }
  'threads:create': {
    // `projectRoot` is the PRIMARY project (cwd). `additionalRoots` are extra
    // projects the thread spans (#45) — the agent gets them via the SDK's
    // additionalDirectories. Omitted/empty = a normal single-project thread.
    request: {
      projectRoot: string
      title?: string
      model?: string
      effort?: string
      additionalRoots?: string[]
      /** Set only by the press that starts a loop run — see ThreadSummary. */
      originLoop?: string
      originAim?: string
      originKey?: string
    }
    response: ThreadSummary
  }
  /**
   * Could a worktree here take this branch name? READ-ONLY.
   *
   * THE ANSWER BELONGS WHERE THE QUESTION IS ASKED (allowed-pattern #21). The
   * modal has to say why a name will not work while the person is still
   * looking at the field, and it cannot learn that from a create it has not
   * made yet. Answering `no` here creates nothing and changes nothing.
   *
   * It is not a reservation. A name free at this call can be taken by the time
   * create runs, so create validates again and fails — this exists to make the
   * common refusal instant and legible, not to make it impossible.
   */
  'threads:branchAvailable': {
    request: { rootPath: string; branch: string }
    response: { ok: boolean; detail: string | null }
  }
  'threads:update': {
    request: { threadId: string; patch: ThreadUpdate }
    response: ThreadSummary
  }
  // Replace the thread's ADDITIONAL context roots (the extra folders the agent
  // reads beyond the primary project). `roots` is the full new additional set —
  // the primary/projectRoot is never included and never removed. The agent
  // picks up the change on its next turn (getThreadRoots → additionalDirectories).
  'threads:setRoots': {
    request: { threadId: string; roots: string[] }
    response: ThreadSummary
  }
  /** A first message held for its project's basic discovery, or null — what a
   *  pane that opens mid-wait draws (the stream only carries changes). */
  'threads:learningFirst': {
    request: { threadId: string }
    response: LearningFirstState | null
  }
  /** Try again: re-run the basic discovery a held first message is waiting on. */
  'threads:retryLearningFirst': {
    request: { threadId: string }
    response: void
  }
  /**
   * Give a thread a worktree of its own — the checkout its agent runs in.
   *
   * TWO-STEP BY DESIGN. Called WITHOUT `carry`, it answers `needs-choice` when
   * the project has uncommitted work, so the one surface that can put a
   * question on screen asks it; called WITH one, it acts. Every rule about
   * whether a worktree should exist at all (the per-project switch, the
   * refusals, what happens to uncommitted work) stays in main — the renderer
   * decides nothing here, it only relays an answer (allowed-pattern #14).
   *
   * `requested: true` marks a move a person asked for by name: it retries a
   * project that refused earlier, and it drops an IDLE session so the next turn
   * starts in the new worktree. A thread mid-turn answers `busy` instead —
   * a running session's root was fixed when it spawned and cannot follow.
   */
  'threads:prepareWorktree': {
    request: {
      threadId: string
      carry?: CarryChoice
      requested?: boolean
      /**
       * Whether this conversation gets a checkout of its OWN.
       *
       * THE OTHER HALF OF A QUESTION THAT USED TO BE ONE. It was carried by
       * whether this channel was called at all — "no checkout" was silence —
       * so main could not be told the answer, only left to infer it, and the
       * two facts (a checkout, and a branch) could not vary independently.
       * Absent → `own`, which is what every caller before this meant.
       */
      worktree?: 'own' | 'project'
      /**
       * What the checkout's FOLDER is called — a different question from
       * `branch`, which names the ref.
       *
       * Absent → the thread's id, which is what this channel meant for its
       * whole life and what put a uuid in every person's shell prompt.
       */
      worktreeName?: string
      /** Where the worktree begins. Absent → the project's base branch. */
      start?: WorktreeStart
      /**
       * What the new checkout's branch should be CALLED — a different question
       * from `start`, which says where it begins.
       *
       * A TYPED NAME, so it is validated and refused, never repaired
       * (allowed-pattern #22 — `isValidRefName`, not `threadBranchName`). It
       * names BOTH identities: the local branch and the remote it publishes to,
       * bound here so nothing has to ask at the first push.
       *
       * Absent is the path everything took before this: the checkout stays
       * detached and earns its name from the generated title once the first
       * reply lands (`nameAfterTitle`).
       */
      branch?: string
    }
    response: ThreadWorktreeResult
  }
  /**
   * The branches a worktree could start from, and which of them are spoken for.
   *
   * READ-ONLY. It exists so the surface that asks a person can offer real
   * choices — including the fact that a branch the project itself has open
   * cannot be taken, only branched from.
   */
  'threads:worktreeBranches': {
    request: { rootPath: string }
    response: WorktreeBranchChoices
  }
  /**
   * Change where a thread's worktree starts, after it already has one.
   *
   * TWO OUTCOMES, AND WHICH ONE IS NOT THE CALLER'S CHOICE. A worktree holding
   * nothing is simply made again from the new starting point. A worktree
   * holding work is never moved — its files and commits stay exactly where they
   * are, and only the branch its work lands on changes. Nothing is discarded to
   * honour a re-pick (forbidden-pattern #15).
   */
  'threads:retargetWorktree': {
    request: { threadId: string; start: WorktreeStart }
    response: WorktreeRetargetResult
  }
  /**
   * What landing this thread's work would involve (thread-worktrees Phase 7).
   *
   * READ-ONLY. Opening the landing surface must never stage, commit or move
   * anything — this reports what is waiting and the message a person is about
   * to be shown for editing.
   */
  'threads:landingPreview': {
    request: { threadId: string }
    response: ThreadLandingPreview
  }
  /**
   * Land the thread's work: commit what is loose under the message a person
   * accepted, then merge it to the branch it was cut from — or open a pull
   * request for it.
   *
   * `confirmed` HAS NO DEFAULT (forbidden-pattern #15). Called without it,
   * nothing that writes is run at all; the response says so on a blocked row.
   * `pruneAfter` is the same rule for the checkout's directory.
   *
   * `projectRoot` NARROWS the landing to one repository — the one whose group
   * the pressed control sits in. Absent → every repository this thread has a
   * worktree in, which is what the panel-level bar always meant and never
   * said. It can only ever remove targets, never add one.
   */
  'threads:landWorktree': {
    request: {
      threadId: string
      mode: 'merge' | 'pull-request'
      message?: string
      confirmed?: boolean
      pruneAfter?: boolean
      projectRoot?: string
    }
    response: ThreadLandingResult
  }
  /**
   * Release a thread's checkout, keeping its branch. `confirmed` is required;
   * `allowUnlanded` is the SECOND, separate say-so needed for a checkout that
   * still holds work living nowhere else.
   */
  'threads:releaseWorktree': {
    request: {
      threadId: string
      confirmed?: boolean
      allowUnlanded?: boolean
      /**
       * The project a checkout belongs to when NO THREAD DOES any more — the
       * one case a release cannot look its subject up (a thread was deleted and
       * its copy stayed). Absent for every ordinary release; present, it names
       * the repository whose listing supplies the missing details.
       *
       * The gates are unchanged and there is still exactly one deletion path:
       * this widens what `prune` can be pointed AT, never what it may do
       * without being asked.
       */
      abandonedIn?: string
    }
    response: ThreadWorktreeReleaseResult
  }
  /** How many thread checkouts a project is holding, and its ceiling (Phase 7). */
  'threads:worktreeUsage': {
    request: { rootPath: string }
    response: WorktreeUsage
  }
  /**
   * Every thread worktree one project is holding — READ-ONLY.
   *
   * The list a person opens to manage them. It is the UNION of what the
   * database believes and what git reports, so a copy whose thread is gone and
   * a thread pointing at a copy that is gone both appear, each saying which
   * side is missing. Opening it reads; it never creates, moves or deletes.
   */
  'threads:worktreeInventory': {
    request: { rootPath: string }
    response: ThreadWorktreeInventory
  }
  /**
   * Rename the branch a thread's worktree works on.
   *
   * `confirmed` HAS NO DEFAULT (forbidden-pattern #15) — a branch rename moves
   * a ref, and a call that did not say a person asked for it runs no git that
   * writes. `name` is what a person typed, in their own words; Flow decides the
   * branch's spelling from it, so no branch grammar reaches the screen.
   */
  'threads:renameWorktreeBranch': {
    request: { threadId: string; name: string; confirmed?: boolean }
    response: ThreadWorktreeRenameResult
  }
  /**
   * Stop a thread pointing at a copy that is no longer on disk.
   *
   * DELETES NOTHING. It clears the thread's record of a worktree that is
   * already gone, and REFUSES when the copy turns out to still be there — that
   * refusal is the whole safety of it, because forgetting a live checkout would
   * strand real files where nothing in the app would ever mention them again.
   */
  'threads:forgetWorktree': {
    request: { threadId: string; confirmed?: boolean }
    response: ThreadWorktreeForgetResult
  }
  /**
   * Where a thread publishes — READ-ONLY, and the suggestion when it publishes
   * nowhere yet.
   *
   * Answers from the store's mirror, reconciling against git when the two
   * disagree (git wins). Reading never binds anything: an unbound thread comes
   * back unbound with a proposal attached, and the proposal stays a proposal
   * until a person answers.
   */
  'threads:worktreeBinding': {
    request: { threadId: string }
    response: ThreadBindingState
  }
  /**
   * Decide where a thread publishes.
   *
   * `confirmed: true` is REQUIRED — an unconfirmed request is refused, not
   * defaulted (forbidden-pattern #15) — and the refusal's `detail` is one
   * sentence a person reads, carrying no command and no config key
   * (forbidden-pattern #12).
   */
  'threads:bindWorktree': {
    request: ThreadBindingRequest
    response: { ok: true; state: ThreadBindingState } | { ok: false; detail: string }
  }
  'threads:delete': { request: { threadId: string }; response: void }
  'threads:search': {
    request: { query: string; projectRoot?: string }
    response: ThreadSummary[]
  }
  'threads:sendMessage': {
    /**
     * `skipContextGate`: the person hand-picks this thread's projects, so the
     * first send does not ask the fast model which Workspace projects it needs
     * (Workspaces Phase 7). Attaching projects before the first send skips it
     * too, without the flag.
     */
    request: {
      threadId: string
      content: string
      attachments?: MessageAttachmentInput[]
      skipContextGate?: boolean
    }
    response: { messageId: string }
  }
  'threads:interrupt': { request: { threadId: string }; response: void }
  'threads:setModel': {
    request: { threadId: string; selection: ModelSelection }
    response: void
  }
  /**
   * How full this thread's context window is (#1955).
   *
   * `null` whenever there is nothing honest to answer — no live session, a
   * runtime with no such API, or a provider that reports no window — and the
   * footer renders that as today's line, with no bar and no percentage. The
   * window is never defaulted: see `shared/context-usage.ts`.
   */
  'threads:contextUsage': {
    request: { threadId: string }
    response: ContextUsageSnapshot | null
  }
  'threads:respondPermission': {
    request: { requestId: string; verdict: PermissionVerdict }
    response: void
  }
  /** Permission asks still parked in the broker for a thread (#949) — the
   *  renderer re-syncs on thread load so a pending card can be REBUILT after a
   *  thread switch, a background arrival, or a renderer reload. */
  'threads:pendingPermissions': {
    request: { threadId: string }
    response: PermissionRequest[]
  }
  /** AskUserQuestion dialogs still parked in main for a thread — the same
   *  re-sync as pendingPermissions, so a question card can be REBUILT after a
   *  thread switch, a background arrival, or a renderer reload. */
  'threads:pendingDialogs': {
    request: { threadId: string }
    response: UserQuestionRequest[]
  }
  /** Answer an AskUserQuestion dialog the agent raised (onUserDialog bridge). */
  'threads:respondDialog': {
    request: { requestId: string; answers: UserQuestionAnswer[] }
    response: void
  }
  /** Import a project's Claude Code CLI sessions as threads (idempotent). */
  'threads:importClaude': {
    request: { rootPath: string }
    response: { imported: number; skipped: number }
  }
  /** Estimated tokens saved by knowledge search across one thread — pure
   *  recompute from persisted tool calls (the conversation chip's source).
   *  Fail-soft: an unknown thread answers zero, never an error. */
  'threads:brainSavings': {
    request: { threadId: string }
    response: BrainThreadSavings
  }

  // tasks (task list — a task owns one thread)
  'tasks:list': {
    request: { projectRoot: string; includeArchived?: boolean }
    response: TaskSummary[]
  }
  'tasks:create': {
    // `additionalRoots` are extra context folders the spawned thread inherits as
    // additional roots (#695) — the task's agent reads them from its first turn.
    request: { projectRoot: string; title: string; description?: string; additionalRoots?: string[] }
    response: TaskSummary
  }
  'tasks:importIssue': {
    // `additionalRoots` are extra context folders the spawned thread inherits as
    // additional roots, same creation-time seed as tasks:create (#695, #1694).
    request: { projectRoot: string; keyOrUrl: string; additionalRoots?: string[] }
    response: { task: TaskSummary; created: boolean }
  }
  /**
   * Record a run for a queue item the board ALREADY READ — no refetch.
   *
   * The sibling of `tasks:importIssue`, and deliberately not a variant of it:
   * the importer takes a reference and goes and fetches the issue, which needs
   * a provider token and cannot work at all for a ledger queue (whose items
   * live in the project, not in a tracker). This one takes the facts the read
   * already produced — key, link, title, body, which store answered — so a
   * claim on a token-less machine, or on the Flow ledger, still materializes
   * the run record FR-7 promises. Both channels land in the same store under
   * the same dedup rule, so an item recorded by either is one record.
   */
  'tasks:createFromQueueItem': {
    request: {
      projectRoot: string
      /** `queueItemExternalKey`'s `<location>#<id>` — the board's join key. */
      externalKey?: string
      /** The item's backend-native id (GitHub issue number / ledger seq id). */
      itemId?: string
      url?: string
      title: string
      /** The item's body, verbatim, markers included. */
      body?: string
      /** `github` | `ledger`, exactly as `loop list` reported it. */
      queueKind?: string
      /**
       * The ticket's pictures, when the read that produced this item named any.
       *
       * The Remote column already holds them, so promoting an item keeps the
       * strip the card was showing rather than losing it at the board's edge —
       * and the task shows the same screenshots offline, with no second fetch
       * and no second way to fail.
       */
      images?: RemoteIssueImage[]
      /**
       * Whether the board's loop may work the card this becomes.
       *
       * ASKED ON THE TICKET, before it is a card: taking work on and saying
       * whether it should be worked is one decision, and splitting it into two
       * gestures means the second is the one people forget. Absent is false —
       * a board is also a notebook.
       */
      autoFix?: boolean
      /**
       * The other projects the task's chat reads besides `projectRoot` — the
       * rest of what a person ticked on a remote ticket (the first ticked is
       * `projectRoot`, where the chat runs).
       */
      additionalRoots?: string[]
      /**
       * A person chose these projects (the remote ticket's picker): the task's
       * chat starts with exactly them and the context gate does not guess.
       */
      projectsChosen?: boolean
    }
    response: { task: TaskSummary; created: boolean }
  }
  /**
   * Change the projects of a task whose chat has not started (a card's
   * "Change"). `roots[0]` is where the chat runs; the rest are context. A
   * different first project moves the task (and its unstarted chat) there.
   * Refused once the chat has started.
   */
  'tasks:setProjects': {
    request: { taskId: string; roots: string[] }
    response: { task: TaskSummary; additionalRoots: string[] }
  }
  /**
   * THE BOARD'S OWN LOOP — start it, stop it, or ask what it is doing.
   *
   * `run: true` takes the oldest ticked card in Todo, hands it to that card's
   * own 1:1 chat with autopilot on, and takes the next one when that turn ends
   * — until nothing ticked is left. `run: false` takes no more cards; the turn
   * already in flight is left alone, because interrupting an agent mid-sentence
   * is its own gesture, on the thread, where you can see what you are stopping.
   *
   * Omit `run` to just read the status.
   *
   * ONLY TICKED CARDS. A board is also a notebook (`TaskSummary.autoFix`), so
   * pressing play must not start work on a card somebody kept as a reminder.
   */
  'tasks:boardLoop': {
    request: { projectRoot: string; run?: boolean }
    response: BoardLoopState
  }
  'tasks:update': { request: { taskId: string; patch: TaskUpdate }; response: TaskSummary }
  /** Merge a Review card's pull request (GitHub squash, local-merge fallback),
   *  advancing the card to Done on success. */
  'tasks:mergePr': { request: { taskId: string }; response: TaskMergeResult }
  'tasks:delete': { request: { taskId: string }; response: void }
  /** (Re)generate the task's technical brief; resolves with the updated task. */
  'tasks:generateBrief': { request: { taskId: string }; response: TaskSummary }
  /** Guarantee the task has a live 1:1 thread — creating and linking a fresh one
   *  when its chat was deleted out from under it — and resolve with the task.
   *  Idempotent for a healthy task, so every "open this task's chat" path can go
   *  through it (#1061). */
  'tasks:ensureThread': { request: { taskId: string }; response: TaskSummary }

  // integrations (Jira / GitHub, read-only via a stored PAT)
  'integrations:setToken': { request: IntegrationTokenInput; response: void }
  'integrations:status': {
    request: { provider: IntegrationProvider }
    response: IntegrationStatus
  }
  'integrations:clearToken': { request: { provider: IntegrationProvider }; response: void }
  /**
   * EVERYTHING ON THIS PROVIDER ASSIGNED TO THE PERSON SIGNED IN.
   *
   * The board's Remote column asks this, and it is deliberately not the same
   * question as a loop's queue: a queue is a REPOSITORY's list that somebody
   * pointed a loop at, and this is MY list — the issues that are mine, wherever
   * they live. Connecting a tracker is enough to get it; no directive has to be
   * edited.
   *
   * FAIL-SOFT, LIKE EVERY OTHER READ THE BOARD DOES. A provider that is not
   * connected, whose token has expired, or that could not be reached answers
   * `ok: false` with its own sentence — never an empty list, which would say
   * "you have nothing assigned" about a question nobody managed to ask.
   */
  'integrations:assigned': {
    request: { provider: IntegrationProvider }
    response: {
      ok: boolean
      provider: IntegrationProvider
      items: RemoteIssue[]
      reason: string | null
    }
  }

  /**
   * A PROVIDER'S ISSUE-LIST PREFERENCE — the mode and the saved native query.
   *
   * Read by the settings panel (to fill the query field) and the board (to know
   * which modes the selector may offer). Non-secret and global; a provider that
   * has never been configured answers the default `{ mode: 'assigned',
   * query: '' }`.
   */
  'integrations:getListConfig': {
    request: { provider: IntegrationProvider }
    response: IssueListConfig
  }

  /**
   * SET THE MODE, THE QUERY, OR BOTH — a partial patch, and the merged result
   * is returned so the caller needs no follow-up read. Two writers share it: the
   * settings panel sets the query, the board's selector sets the mode.
   */
  'integrations:setListConfig': {
    request: { provider: IntegrationProvider; mode?: IssueListMode; query?: string }
    response: IssueListConfig
  }

  /**
   * WHAT A QUERY WOULD RETURN, before it is saved and before it reaches the
   * board. The settings field runs this to show a count for the exact string
   * the user typed — so a divergent list is visible at configuration time, not
   * discovered later on the board.
   *
   * Runs the query in `list` mode (the custom query verbatim), reusing the same
   * cap and the GitHub PR-drop the board's read uses, so the preview count and
   * the board agree. FAIL-SOFT: an error comes back as `ok:false` + a sentence,
   * never a rejected promise (a settings field draws this).
   */
  'integrations:previewList': {
    request: { provider: IntegrationProvider; query: string }
    response: {
      ok: boolean
      count: number
      /** A few titles, for a glance at what matched. */
      sample: string[]
      reason: string | null
    }
  }

  /**
   * WHETHER MOVING A PROMOTED TRACKER CARD TO DONE CLOSES THE REMOTE TICKET
   * (#1885). App-wide, non-secret, default ON. The Settings toggle reads and
   * writes it; the main-process `tasks:update` reaction reads the same value.
   */
  'integrations:getCloseOnDone': {
    request: Record<string, never>
    response: { enabled: boolean }
  }
  'integrations:setCloseOnDone': {
    request: { enabled: boolean }
    response: { enabled: boolean }
  }

  /**
   * ONE PICTURE OFF A TICKET, as bytes the page may actually draw.
   *
   * TWO WALLS MAKE THIS A MAIN-PROCESS JOB, and they are the reason it is not
   * simply an `<img src>`: a tracker's attachment is behind the same
   * credential as the issue (which the renderer deliberately never holds), and
   * the page's own policy is `img-src 'self' data:` — no remote image loads at
   * all. Loosening that would let anyone who can comment on a ticket beacon
   * the reader by putting an address in a description.
   *
   * So main fetches it, against an allow-list of the PROVIDER'S OWN hosts
   * rather than whatever the ticket said, and answers with a data URI.
   *
   * FAIL-SOFT, like every read a card draws: an image that cannot be fetched
   * comes back with its own sentence on `reason` and is shown as that sentence,
   * not as a broken frame.
   */
  'integrations:imageData': {
    request: { provider: IntegrationProvider; url: string }
    response: {
      ok: boolean
      /** `data:image/png;base64,…`, or null when it could not be loaded. */
      dataUri: string | null
      /** The decoded size in bytes, or 0. */
      bytes: number
      reason: string | null
    }
  }

  // messages / tool calls (raw persistence; threads:sendMessage is the
  // agent-facing send that starts a turn — messages:append only stores)
  /**
   * A thread's messages, oldest first.
   *
   * `limit` returns the NEWEST n, still in order — what a transcript view
   * needs, since it mounts a window at the bottom and hides the rest behind
   * "Show earlier". Measured: one real thread is 1,260 messages and 2.74 MB,
   * transferred in full on every open to mount 200 of them. Omit it to get
   * everything (the "show earlier" fetch, exporters).
   */
  'messages:list': {
    request: { threadId: string; limit?: number }
    response: ThreadMessage[]
  }
  'messages:append': {
    request: { threadId: string; role: MessageRole; content: string }
    response: ThreadMessage
  }
  /**
   * Every tool call of a thread — with the newest outputs, and only those.
   *
   * `outputLimit` is how many of the NEWEST calls arrive WHOLE; every older one
   * arrives with its output withheld and its input summarized (see
   * `outputWithheld` / `inputWithheld`). The
   * default is generous and the cap is the caller's, because the renderer is
   * what knows how much it will actually mount. Omit it (or pass 0) for the old
   * whole-thread read — the import path and any consumer that really wants
   * everything still has one.
   */
  'toolCalls:list': {
    /**
     * `since` bounds the read to the window the pane will actually mount: the
     * timestamp of the oldest message it fetched. Tool calls older than that
     * belong to turns nobody is looking at — measured at 1.19 MB of metadata
     * for 1,800 calls, shipped whole to draw a couple of hundred. Omit it and
     * the read spans the thread, which is what an exporter wants.
     *
     * `atLeast` is the floor under that window, and it is not optional in
     * spirit: an agent-heavy turn runs hundreds of calls between two messages,
     * so the oldest mounted MESSAGE can be newer than every card worth showing.
     * The read is the union — the span, plus the newest `atLeast`.
     */
    request: { threadId: string; outputLimit?: number; since?: string; atLeast?: number }
    response: ToolCallRecord[]
  }
  /** One tool call, whole — how a card gets the output a list withheld. */
  'toolCalls:get': {
    request: { threadId: string; toolCallId: string }
    response: ToolCallRecord | null
  }
  /** A sub-agent's transcript (#1931): the messages and tool calls captured
   *  under the parent Task tool call `toolCallId`. Outputs are withheld like
   *  `toolCalls:list` (fetched on demand via `toolCalls:get`). */
  'threads:subagentTranscript': {
    request: { threadId: string; toolCallId: string; outputLimit?: number }
    response: { messages: ThreadMessage[]; toolCalls: ToolCallRecord[] }
  }

  // editor
  'editor:hover': { request: DocumentPositionParams; response: HoverResult | null }
  'editor:definition': { request: DocumentPositionParams; response: DefinitionLocation[] }
  'editor:completions': { request: DocumentPositionParams; response: CompletionItem[] }
  'editor:didOpen': {
    request: { rootId: string; filePath: string; content: string }
    response: void
  }
  'editor:didChange': {
    request: { rootId: string; filePath: string; content: string }
    response: void
  }
  'editor:didClose': {
    request: { rootId: string; filePath: string }
    response: void
  }
  'editor:pendingChanges': {
    request: { rootId?: string }
    response: PendingFileChange[]
  }
  'editor:resolveHunk': {
    request: {
      rootId: string
      filePath: string
      /** Owning thread — pending changes are tracked per (thread, file), so
       *  two threads editing one file need the threadId to disambiguate. */
      threadId: string
      hunkId: string
      action: 'accept' | 'reject'
      /** #1290: hunks the CALLER believes are in scope. The tracker re-reads
       *  disk at resolution time, so a whole-file reject can cover edits the
       *  user saved after the review was broadcast — and destroy them. When
       *  the real count exceeds this, nothing is written and the call answers
       *  `scope-changed`. Omit to proceed regardless (the confirmed re-issue). */
      expectedHunks?: number
    }
    response: ResolveHunkOutcome
  }

  // terminal
  'terminal:list': { request: Record<string, never>; response: TerminalInfo[] }
  'terminal:create': {
    request: { rootId?: string; cols: number; rows: number; owner?: TerminalOwner }
    response: TerminalInfo
  }
  'terminal:write': { request: { terminalId: string; data: string }; response: void }
  'terminal:resize': {
    request: { terminalId: string; cols: number; rows: number }
    response: void
  }
  'terminal:dispose': { request: { terminalId: string }; response: void }
  /**
   * Give an UNOWNED user shell its owner — a shell that started before any
   * conversation was known (the boot shell) and was then adopted by the scope
   * that arrived. Never re-owns a shell that already has one.
   */
  'terminal:claim': { request: { terminalId: string; owner: TerminalOwner }; response: void }
  /**
   * A person renamed the tab — `title: null` clears it back to the automatic
   * one. Saved with the shell, so the name comes back after a restart.
   */
  'terminal:rename': { request: { terminalId: string; title: string | null }; response: void }

  // attachments (#456) — image attachments on user messages
  /** Read a persisted attachment's bytes for rendering (data URL). */
  'attachments:read': {
    request: { attachmentId: string }
    response: { dataUrl: string } | null
  }
  /** #1063 — reveal a persisted attachment's file in the OS file manager. Only
   *  the attachment id crosses the bridge; main resolves the on-disk path from
   *  the DB and confines it to the attachments root (never a renderer path). */
  'attachments:revealPath': {
    request: { attachmentId: string }
    response: void
  }
  /** macOS-only interactive screenshot region capture → a pending attachment. */
  'attachments:captureScreen': {
    request: Record<string, never>
    response: MessageAttachmentInput | null
  }

  // git
  /** Rename the branch a checkout is on. ANY checkout, any branch — the pencil
   *  on the Source Control branch line, which is the only line that names it. */
  'git:renameBranch': {
    request: { rootId: string; name: string; confirmed?: boolean }
    response: GitBranchRenameResult
  }
  'git:status': { request: { rootId: string }; response: GitStatus | null }
  /** #1335: `before` is the paging cursor — GitManager.log has always taken
   *  one, but the channel never forwarded it, so history past the first page
   *  was unreachable and the header printed a page size as if it were a total. */
  'git:log': {
    request: { rootId: string; limit?: number; before?: string }
    response: GitCommit[]
  }
  'git:diff': { request: GitDiffRequest; response: GitDiff }
  /** The Cursor-style change review for one thread's worktree (#1906): every
   *  file the agent touched, unioned from the worktree's git status + the
   *  thread's persisted tool-call paths. `null` when the thread has no worktree. */
  'threads:changeReview': {
    request: { threadId: string }
    response: ThreadChangeReview | null
  }
  /** The untracked files under a rolled-up untracked directory (repo-relative,
   *  sorted) — powers the expandable untracked-folder rows in Source Control (#615). */
  'git:listUntrackedDir': {
    request: { rootId: string; dirPath: string }
    response: { files: string[] }
  }
  /** Stage + commit the given files with a message; returns the short hash. */
  'git:commit': {
    request: { rootId: string; message: string; filePaths: string[] }
    response: { hash: string }
  }
  /** Stage files into the index — `git add` (#335). */
  'git:stage': { request: { rootId: string; filePaths: string[] }; response: void }
  /** Unstage files from the index — `git restore --staged` (#335). */
  'git:unstage': { request: { rootId: string; filePaths: string[] }; response: void }
  'git:discardFile': { request: { rootId: string; filePath: string }; response: void }
  /** Commit the staged index — `git commit -m <message>`, no pathspec (#335). */
  'git:commitIndex': { request: { rootId: string; message: string }; response: { hash: string } }
  /**
   * Publish this checkout's branch — `worktree push` and nothing else (#1906
   * follow-on). No pull, no rebase, no force, and no pull request: one press,
   * one outcome, and the landing flow still owns proposing the work.
   *
   * The answer is the whole story (`GitPublishResult`), including the two
   * states that are refusals rather than errors — a branch nobody has aimed
   * yet, and a branch whose remote has moved on.
   *
   * `binding` IS THE ANSWER TO THE FIRST OF THOSE, coming back (Phase 3). A
   * press with no answer attached omits it and nothing is ever written; a press
   * carrying one binds and then pushes once. The renderer never chooses HOW the
   * binding is written — a thread's own checkout and a plain project root take
   * different paths, and which one applies is a fact about the checkout that
   * main answers, not a fact about the surface.
   */
  'git:publish': {
    request: { rootId: string; binding?: GitPublishBinding }
    response: GitPublishResult
  }
  /** In-progress merge/rebase state for a root (fail-soft `op: 'none'`). */
  'git:mergeState': { request: { rootId: string }; response: GitMergeState }
  /** The three conflict sides + the marker-laden working copy for one file. */
  'git:readConflicted': {
    request: { rootId: string; filePath: string }
    response: GitReadConflictedResult
  }
  /** Resolve one conflicted file (content / ours / theirs) and `git add` it. */
  'git:resolveConflict': {
    request: { rootId: string; filePath: string; resolution: GitConflictResolution }
    response: void
  }
  /**
   * Resolve a SINGLE conflict hunk within a file (conflict-UX Phase 3) — splices
   * only the target hunk's marker region with the chosen side (or both, in the
   * given order), leaving sibling conflict hunks in the file untouched. The file
   * is re-staged (`git add`) ONLY when it becomes fully conflict-free; otherwise
   * it stays unmerged. Modeled on `editor:resolveHunk` (per-hunk id convention).
   * `content` is an optional pre-resolved hunk body (overrides `choice`) for the
   * manual-merge case. Additive — the whole-file `git:resolveConflict` still works.
   */
  'git:resolveConflictHunk': {
    request: {
      rootId: string
      filePath: string
      hunkId: string
      choice: ConflictHunkChoice
      order?: ConflictHunkOrder
      /** Explicit merged text for this hunk; when set, wins over `choice`. */
      content?: string
    }
    response: {
      /** Whether a hunk with `hunkId` was found + spliced. */
      matched: boolean
      /** Conflict hunks still remaining in the file after the splice. */
      remainingConflicts: number
      /** True when the file became fully resolved and was `git add`-ed. */
      staged: boolean
    }
  }
  /** Finalize a merge with a commit message; refuses while conflicts remain. */
  'git:completeMerge': {
    request: { rootId: string; message: string }
    response: { hash: string }
  }
  /** Abort an in-progress merge — `git merge --abort`. */
  'git:abortMerge': { request: { rootId: string }; response: void }
  'git:continueRebase': { request: { rootId: string }; response: { conflicted: boolean } }
  'git:abortRebase': { request: { rootId: string }; response: void }
  /**
   * Post-merge verification for a root (#66; Phase 7) — resolves and runs the
   * project's typecheck/test/build/lint from `flow/.flowconfig` `commands.*` →
   * `package.json` scripts. Fail-soft: no configured commands yields
   * `{ ok: true, ran: [] }`; a failure carries the first failing step + output.
   */
  'git:verifyMerge': {
    request: { rootId: string; changedFiles?: string[] }
    response: {
      ok: boolean
      ran: string[]
      firstFailure?: { name: string; output: string }
      /** Best-effort likely culprit among changedFiles, present on failure. */
      culprit?: string | null
    }
  }
  /**
   * Render + write a merge-resolution summary (#66; Phase 8). Builds the doc
   * deterministically from `input`, writes it to `flow/merges/merge_<branch>_
   * <stamp>.md`, and returns the doc path plus the condensed commit body the
   * caller folds into the merge commit message. `stamp` is caller-supplied so
   * the render stays clock-free and reproducible.
   */
  'git:writeMergeSummary': {
    request: { rootId: string; input: MergeSummaryInput; stamp: string }
    response: { path: string; commitBody: string }
  }
  /** Local branch names (current branch excluded) for the "Merge branch…" picker. */
  'git:listBranches': { request: { rootId: string }; response: string[] }
  /**
   * Merge a branch into the current one — `git merge --no-edit <ref>` (Phase 9,
   * minimal in-app merge). A conflict outcome is NOT an error: it lands in the
   * normal conflicted working-tree state (MERGE_HEAD set, markers on disk) for
   * the existing resolver, and is reported as `{ conflicted: true }`.
   */
  'git:mergeBranch': {
    request: { rootId: string; ref: string }
    response: { conflicted: boolean }
  }
  /**
   * Pull the current branch's tracked upstream — `git pull --no-edit` (Phase 9).
   * Same conflict-as-outcome contract as `git:mergeBranch`.
   */
  /** #1336: `received` is how many commits actually arrived (null = unknown),
   *  so the toast can stop claiming "Up to date" after a 20-commit pull. */
  'git:pull': {
    request: { rootId: string }
    response: { conflicted: boolean; received: number | null; branch: string }
  }
  /**
   * List every same-file AGENT CLASH in a project (conflict-UX Phase 6) — files
   * a plan-flow parallel wave attributed to >1 phase AND confirmed by real
   * per-task commits. Additive/read-only; fail-soft — no attribution / commits
   * yields `[]`, never throws.
   */
  'git:listAgentClashes': { request: { rootId: string }; response: AgentClashInfo[] }
  /**
   * Open ONE agent clash for `filePath` (conflict-UX Phase 6): reconstruct its
   * sides from the per-task commits, synthesize a 3-way conflict via
   * `git merge-file --diff3`, and overlay the wave (phase/task) side identities —
   * returning the SAME conflicted-file shape a git conflict does so the renderer
   * opens it in the same per-hunk resolver. `null` when the path is not a
   * reconstructable clash; `{ oversize: true }` when a side blows the buffer.
   */
  'git:readAgentClash': {
    request: { rootId: string; filePath: string }
    response: AgentClashConflict | { oversize: true } | null
  }
  /**
   * Reconcile an agent clash (conflict-UX Phase 6): write the resolved merged
   * `content` to the working tree and stage it. There is NO git `--continue` —
   * a clash is not a real merge state — so this simply persists the resolved
   * bytes deterministically. Additive; the clash is "done" once written.
   */
  'git:reconcileAgentClash': {
    request: { rootId: string; filePath: string; content: string }
    response: void
  }

  // review (phase-grouped review & commit panel)
  'review:list': { request: { rootPath: string }; response: ReviewListResult }
  /** Reject a file: revert its working-tree changes back to HEAD. */
  'review:reject': { request: { rootPath: string; filePath: string }; response: void }
  /** Manual commit mode (#67): AI-generate a commit message for the approved files. */
  'review:generateCommitMessage': {
    request: { rootPath: string; filePaths: string[] }
    response: { message: string | null }
  }

  // flow
  'flow:state': { request: { rootId: string }; response: FlowState }
  'flow:respondPrompt': {
    request: { rootId: string; promptId: string; response: string }
    response: void
  }
  // Write settings into the active project's flow/.flowconfig (non-destructive
  // merge in main); the watcher rebroadcasts flow:stateChanged.
  //
  // A `null` value REMOVES the key, which is how a project goes back to
  // inheriting a default. It only ever arrives from an explicit switch — a
  // control a person flipped, never a blank field or an unmentioned key
  // (forbidden-pattern #15).
  'flow:setConfig': {
    request: { rootId: string; updates: Record<string, string | null> }
    response: void
  }
  /** Every worktree setting in effect for a project, with per-key provenance:
   *  the project's own `.flowconfig`, the person's defaults, or the built-in. */
  'flow:worktreeSettings': {
    request: { rootId: string }
    response: ResolvedWorktreeSettingsResult
  }
  /** Record a board Review Mode file verdict as a `review_verdict` rounds entry,
   *  appended to `flow/.rounds.jsonl` (Board Review Mode, #609). Fail-soft. */
  'flow:recordVerdict': {
    request: FlowRecordVerdictRequest
    response: FlowRecordVerdictResponse
  }
  /**
   * THE AUTOPILOT CHAIN — start it on a conversation, end it, or ask what it
   * is doing.
   *
   * `run: true` runs the flow's steps in order — work out what is needed, plan
   * it, build it, review it, and publish if the project publishes — issuing
   * each one when the last one's turn ends. It is refused when the project has
   * autopilot switched off, and refused when something else is already working
   * that conversation.
   *
   * `run: false` ENDS IT AND CHANGES NOTHING ELSE. The turn in flight keeps
   * running and finishes; it is simply not followed by another. Nothing is
   * interrupted, rolled back or undone — interrupting an agent mid-sentence is
   * its own gesture, on the thread, where a person can see what they are
   * stopping.
   *
   * OMIT `run` TO JUST READ. Asking what a chain is doing must never start one,
   * so every surface that merely draws the state can call this freely.
   */
  'flow:chain': {
    request: {
      threadId: string
      run?: boolean
      /** What the chain is for, in the person's own words. Start only. */
      aim?: string
    }
    response: ChainState
  }

  // blueprint (rootId === absolute rootPath; the read path is fixed in main)
  'blueprint:read': { request: { rootId: string }; response: BlueprintSnapshot }
  // Run `planflow-ai blueprint derive` in main (async spawn, cwd = root).
  'blueprint:derive': { request: { rootId: string }; response: BlueprintDeriveResult }
  // Live change-simulation reconciliation for a plan (bundled CLI, --json).
  'blueprint:reconcile': {
    request: { rootId: string; plan: string }
    response: BlueprintReconcileResult
  }
  // Feature graph for the board's default view (bundled CLI, --json).
  'blueprint:featureGraph': { request: { rootId: string }; response: BlueprintFeatureGraph }
  // The Workspace map for the board's root — every project of the root's
  // Workspace side by side, plus the links between them (bundled CLI --json).
  'blueprint:workspaceGraph': { request: { rootId: string }; response: BlueprintWorkspaceGraph }
  // One feature's file/import graph (#1533) — bundled CLI `feature-map --json`.
  'blueprint:featureRelations': {
    request: { rootId: string; feature: string }
    response: BlueprintFeatureRelationsResult
  }
  'blueprint:featureMap': {
    request: { rootId: string; feature: string }
    response: BlueprintFeatureMapResult
  }
  // Persisted corpus index (changes-discovery-view #1532) — plain file read.
  'blueprint:corpusIndex': { request: { rootId: string }; response: BlueprintCorpusIndexResult }
  // Change-brief delta for a plan (bundled CLI, --json).
  'blueprint:brief': {
    /** `doc`: the repo-relative path of the document VERSION to describe, when
     *  a door names one — a slug has many versions, and an older version's
     *  card opens that version (`brief --path`). */
    request: { rootId: string; plan: string; feature?: string; doc?: string }
    response: BlueprintBriefResult
  }
  // In-memory basic fallback graph (main derives it, no CLI, never on disk).
  /** Just the learning rows for a root — the cheap half of blueprint:read,
   *  for a change that touched nothing else. */
  'blueprint:readLearning': {
    request: { rootId: string }
    response: { learning: BlueprintLearningEntry[] }
  }
  /** Just the compiled story — one small file, parsed.
   *
   *  The conversation pane reads a story on project bind, thread switch,
   *  relaunch and every blueprint:changed while a thread is open, and it was
   *  asking for the WHOLE snapshot to take one field off it: ten files read in
   *  main, and a graph measured at 1.1 MB shipped across IPC to be dropped on
   *  arrival. */
  'blueprint:readStory': {
    request: { rootId: string }
    response: { story: BlueprintStory | undefined }
  }
  'blueprint:readBasic': { request: { rootId: string }; response: BlueprintBasicSnapshot }
  /**
   * A plan's change notes, their review status and where each quote is in
   * today's code. Main runs the bundled CLI's `plan notes`; a plan it cannot
   * read answers `{ ok: false, detail }`. Never throws.
   */
  'plan:notes': { request: { rootPath: string; plan: string }; response: PlanNotesAnswer }
  /**
   * Record one note's status (Accept / Reject / back to proposed) or verdict,
   * through the CLI's one writer (`plan note`). Answers the note as written,
   * or `{ ok: false, detail }` with the refusal's sentence.
   */
  'plan:setNote': { request: PlanSetNoteRequest; response: PlanSetNoteAnswer }
  /**
   * One file (`file`, project-relative) or one feature/part (`partRef`) read
   * as a storyline — exactly one of the two. Main runs the bundled CLI's
   * `blueprint storyline` with the app's own TypeScript; a file that cannot
   * be read as a story answers a refusal carrying its sentence and text.
   */
  'blueprint:storyline': {
    /**
     * `plan` asks for that plan's Today ⇄ After (`compare` on the answer);
     * `base` names the plan's starting commit when the caller knows it —
     * omitted, the CLI resolves the run's recorded start, else HEAD.
     */
    request: { rootId: string; file?: string; partRef?: string; plan?: string; base?: string }
    response: StorylineAnswer
  }
  /**
   * What comes into a feature's (or a part's) diagram and what goes out of
   * it. Main runs the bundled CLI's `blueprint features ports`, cached per
   * root + feature until that root's next `blueprint:changed`; a refusal or a
   * failed run answers `{ ports: null }` with one sentence for the reader.
   */
  'blueprint:featurePorts': {
    request: { rootId: string; feature: string }
    response: FeaturePortsAnswer
  }
  // "What was implemented" — feature/phase/file view read from plan files.
  'blueprint:features': { request: { rootId: string }; response: BlueprintFeaturesResult }
  /**
   * #1307: populate an EMPTY feature store — `features discover` then
   * `features confirm`. The board's empty state used to name `features seed`,
   * which cannot work in the state that showed it.
   */
  'blueprint:discoverFeatures': {
    request: { rootId: string }
    response: { ok: boolean; reason: string | null }
  }
  /**
   * Pin (or clear) a feature's or part's person-owned home folder (plan
   * feature-home-folders, FR-10). Main runs the bundled CLI's one writer,
   * `blueprint features home`, in the root's checkout; a refusal answers its
   * reason code and the folder it named, never the writer's own sentence.
   */
  'blueprint:setFeatureHome': {
    request: BlueprintSetFeatureHomeRequest
    response: BlueprintSetFeatureHomeResult
  }
  // Record a human "I've seen this drift" ack — precious, append-only, survives
  // the disposable graph rebuild (main resolves the root's .structure/ dir).
  // `paths` are the node's changed files, also advanced into the drift baseline
  // (via `blueprint drift-ack`) so the acked node stops reading as drift.
  'blueprint:ackDrift': {
    request: { rootId: string; nodeId: string; commit: string; paths: string[] }
    response: BlueprintAckDriftResponse
  }
  // "Mark everything reviewed" — re-establish the drift baseline to the current
  // tree (via `blueprint drift-reset`), clearing drift to empty for this root.
  'blueprint:driftReset': {
    request: { rootId: string }
    response: BlueprintDriftResetResponse
  }
  /** Generate a markdown review summary for a node's must-review items (#must-review
   *  substance): main gathers context (source excerpt + repo references), asks the
   *  one-shot model, writes flow/brain/reviews/<slug>.md, returns its path. */
  /** Durable must-review acknowledgment (#910 follow-up): appends titles to
   *  mustreview-acks.jsonl; the CLI's derive filters acked items forever. */
  /** Manual per-doc trust adjudication from the Docs tab: runs the bundled
   *  CLI's adjudicate verb (one code path with learn-pass verdicts, #14). */
  /** Confirm/reject a proposed cross-link — routes through the CLI verbs
   *  (one writer) then the caller refreshes. */
  'blueprint:crossLinkDecide': {
    request: { rootId: string; provider: string; endpoint: string; decide: 'confirm' | 'reject' }
    response: { ok: boolean; reason?: string }
  }
  /** Background re-derive of a linked sibling via its surface-recorded repo
   *  path, then a rematch on the consumer. */
  'blueprint:refreshSibling': {
    request: { rootId: string; siblingRepoPath: string }
    response: { ok: boolean; reason?: string }
  }
  'blueprint:adjudicateDoc': {
    request: { rootId: string; path: string; verdict: 'corroborated' | 'contradicted' }
    response: { ok: boolean; reason?: string }
  }
  'blueprint:verifyDoc': {
    request: { rootId: string; path: string }
    response: {
      ok: boolean
      reason?: string
      verdict?: 'corroborated' | 'contradicted' | 'unverifiable'
      promoted?: number
      observations?: number
      claims?: { corroborated: number; contradicted: number; unverifiable: number }
    }
  }
  'blueprint:ackMustReview': {
    request: { rootId: string; titles: string[] }
    response: { ok: boolean; reason?: string }
  }
  'blueprint:reviewSummary': {
    request: {
      rootId: string
      nodeId: string
      label: string
      sourceFile: string
      items: Array<{ severity: string; title: string; detail: string }>
    }
    response: { ok: boolean; path?: string; reason?: string }
  }
  'blueprint:listInvariantVerdicts': {
    request: { rootId: string }
    response: InvariantCheckSnapshot
  }

  // agent loops (rootId === absolute rootPath) — every one of these is the
  // bundled CLI's `loop <verb>`, never a second implementation of the rule.
  /**
   * Every loop a project has a directive for — read from disk, never spawned.
   *
   * THE PANEL'S CRITICAL PATH, and the whole reason it stopped costing
   * 2,103 ms: this is a `readdir` plus N `readFile`s over `loops/*.md`, cached
   * per root behind a watcher. A malformed directive arrives as a row carrying
   * the refusal, never as a missing loop.
   *
   * WHAT IT CANNOT KNOW is everything that is not in the file: queue counts,
   * standing hunts, the runtime pause and the runs in flight. Those are
   * `loops:activity`, on their own channel, off this path.
   */
  'loops:read': { request: { rootId: string }; response: LoopsSnapshot }
  /**
   * The expensive half: `loop status --json --live-runs <snapshot>` plus the
   * project's background agents.
   *
   * `visible` IS NOT A HINT. A read of the running agents is one Claude Code
   * invocation, and an off-screen surface must spend nothing (allowed-pattern
   * #17) — so a request that says nobody is looking is answered from what is
   * already known, including the honest "nothing has looked yet". The renderer
   * owns the visibility rule and states it here; main never guesses it.
   */
  'loops:activity': {
    request: { rootId: string; visible: boolean }
    response: LoopsActivity
  }
  /**
   * `loop pause --loop <n> --reason <r>` / `loop resume --loop <n>`.
   *
   * ONE channel for both directions, because they are one decision — "should
   * this loop be running?" — and splitting it into pause/unpause channels is
   * how a UI ends up able to express states the store cannot hold. An empty
   * `loop` addresses the GLOBAL pause, exactly as the CLI reads it.
   */
  'loops:setPaused': {
    request: {
      rootId: string
      loop: string
      paused: boolean
      reason?: string
      /**
       * A hunt's sentence, on a RESUME only (loops-on-the-board, Phase 7).
       *
       * ONE VERB, ONE CHANNEL. `loop resume --loop <n> --focus <text>` is the
       * CLI's own "I looked, carry on" — it stops the instruction and starts it
       * again, which is the only path that restarts a capped hunt. It is the
       * same verb this channel already runs, so it rides the same request
       * rather than a second channel that would spawn the same command a
       * second way.
       *
       * It is NOT a hunt-only write, and the caller must say so: the same
       * invocation lifts the loop's pause. The board's control spells both out
       * (renderer/loops/hunt-instruction.ts); nothing here hides that behind a
       * narrower-sounding name.
       *
       * Ignored on a pause — `loop pause` takes no focus.
       */
      focus?: string
      /** The `--cap` a resumed hunt carries forward. Resume + focus only. */
      cap?: number
      /**
       * HOW THIS HUNT ENDS — the rule chosen when it was started. Resume +
       * focus only, like `cap` beside it.
       *
       * Absent leaves the hunt on its backstop, which is what every hunt
       * started before stop rules existed has. It is never defaulted on the way
       * through: "nobody chose" and "somebody chose findings" are different
       * facts, and only the second is a decision.
       */
      stop?: LoopStopChoice
    }
    response: LoopsWriteResult
  }
  /**
   * The DIRECTIVE's own pause — whether this loop is switched on at all.
   *
   * A SECOND FACT, NOT A SECOND WAY TO SAY THE FIRST. `loops:setPaused` writes
   * state.json: "stop for now", liftable by anyone, forgotten on a resume. This
   * writes the directive's `paused:` field: versioned intent, committed with the
   * repo, and the reason a loop stays off across every machine that clones it.
   * Nothing lifts one by writing the other, which is exactly why they are two
   * channels — a single control that silently cleared both would let a person
   * unpark a loop somebody deliberately parked, in the same press that resumed
   * a five-minute stop.
   *
   * THE CLI IS STILL THE ONLY WRITER. The app never opens a directive; this
   * spawns the bundled CLI's directive-pause verb exactly as every other loops
   * channel spawns its own.
   */
  'loops:setDirectivePaused': {
    request: { rootId: string; loop: string; paused: boolean }
    response: LoopsWriteResult
  }
  /**
   * WHERE A LOOP READS ITS WORK — the directive's `queue:` and the location
   * that goes with it, changed together.
   *
   * NOT A TOGGLE, because the store alone does not say enough: a GitHub queue
   * is a particular repo, and no app may guess which one. So the request
   * carries the kind AND, for GitHub, the `owner/name` the user typed.
   *
   * A LEDGER CARRIES NO LOCATION HERE, deliberately. The CLI can point a ledger
   * loop at a named file, and this channel cannot ask for one: the field would
   * be a file path in a text box, which is precisely the thing no surface of
   * this app may show or ask for (forbidden pattern #12). A ledger from the IDE
   * is the project's own list, on the CLI's documented default — and a loop
   * already reading a different one keeps it, because the CLI treats an
   * unmentioned path as "leave it alone" rather than "throw it away".
   *
   * THE CLI IS STILL THE ONLY WRITER, and the coupling is its rule to enforce:
   * `github` requires a repo and refuses a path, `ledger` the reverse, and both
   * fields move in one write so a directive is never momentarily unparseable.
   * The app validates the shape it is about to send so an obviously-wrong repo
   * is a sentence in the panel rather than a refusal that had to travel.
   */
  'loops:setDirectiveQueue': {
    request: { rootId: string; loop: string; queue: LoopSourceKind; repo?: string }
    response: LoopsWriteResult
  }
  /**
   * What one loop is currently told — read, not written.
   *
   * ON DEMAND, AND DELIBERATELY NOT ON THE STATUS ROW. `## Direction` and
   * `## Rules` are prose, sometimes a screenful of it, and the status rows are
   * re-read on a poll while the panel is open. Carrying two blobs per loop
   * through every one of those would pay, forever and for every loop, for text
   * a person looks at when they open the editor and never otherwise
   * (allowed-patterns #17 and #18). So this is asked for once, when the editor
   * opens.
   *
   * SERVED FROM THE APP'S OWN DIRECTIVE CACHE — no process is spawned. Reading
   * a directive is a guest's business; only writing one is the CLI's.
   */
  'loops:describe': {
    request: { rootId: string; loop: string }
    response: LoopDescription
  }
  /**
   * `loop describe` — what a loop is TOLD: its direction, its rules, its one
   * stop. A third committed fact, beside "switched off" and "where the work
   * comes from", and it touches neither of them.
   *
   * AN ABSENT FIELD IS ONE NOBODY EDITED, and an empty string is not the same
   * thing: the CLI leaves an unmentioned section alone and REMOVES an empty
   * one, which is how a person says "this loop has no rules of its own". A
   * panel that sent `''` for every box it did not show would erase prose the
   * person never opened.
   */
  'loops:setDirectiveDescription': {
    request: {
      rootId: string
      loop: string
      direction?: string
      rules?: string
      /** `max_open_issues` — the loop's own open items, not the queue's. */
      maxOpen?: number
    }
    response: LoopsWriteResult
  }
  /** `loop approve --loop <n> --id <id>` — clear one item's approval gate. */
  'loops:approve': {
    request: { rootId: string; loop: string; id: string }
    response: LoopsWriteResult
  }
  /**
   * `loop list` — the items themselves, for the board's Todo column.
   *
   * READING WRITES NOTHING. `loop list` opens the backend and calls `list()`;
   * it creates no label, no assignment and no comment, which is what makes it
   * safe to run every time a board is opened. `loop` is a FILTER, not a
   * requirement — a project's board shows the whole project — and `state`
   * defaults to `open` in the CLI, which echoes what it resolved.
   */
  'loops:queue': {
    request: { rootId: string; loop?: string; state?: LoopQueueState }
    response: LoopQueueSnapshot
  }
  /**
   * `loop claim --loop <n> [--id <id>]` — take an item.
   *
   * A HUMAN DRAG IS A CLAIM, and it is the same claim a loop performs: one verb,
   * one set of eligibility rules, one record on the item. Dragging a card to
   * Doing and a headless run picking up work are the same write, so the two can
   * never disagree about who holds an item. An absent `id` claims the oldest
   * eligible item, exactly as the CLI reads it.
   */
  'loops:claim': {
    request: { rootId: string; loop: string; id?: string; owner?: string }
    response: LoopClaimResult
  }
  /**
   * `loop unclaim --loop <n> --id <id>` — give a claimed item back.
   *
   * THE OTHER HALF OF THE CLAIM, and it had no surface at all (review finding
   * H1): a claim that landed while its local record did not left the item held
   * with no in-app way to let go of it — recovery meant a terminal. The
   * ownership check is the CLI's, so this channel cannot release a stranger's
   * claim however it is called.
   */
  'loops:unclaim': {
    request: { rootId: string; loop: string; id: string; owner?: string }
    response: LoopUnclaimResult
  }
  /**
   * `loop file --loop <n> --title <t>` — put one piece of work on the shared list.
   *
   * THE ONLY WAY ANYTHING THIS APP HOLDS REACHES A SHARED QUEUE, and it is a
   * person's explicit press every time (thread-tasklist, Phase 5). A conversation
   * never files as a side effect of anything: the mirror writes local records
   * only, and this channel is reachable from one control on one card.
   *
   * THE CLI IS THE WRITER, NOT THIS APP (allowed-pattern #14). Filing means a
   * dedup fingerprint, the directive's labels and topic, the open-item cap and
   * the approval gate — invariants that live in `queue-backend.ts` and must not
   * be re-implemented against a GitHub or ledger store from here. The app's whole
   * contribution is the title and the loop whose list it goes on.
   *
   * `--loop` IS NOT OPTIONAL AND CANNOT BE MADE SO. The loop names the directive,
   * and the directive is what says which store, which labels, which cap; there is
   * no queue to open without one. A board that cannot name exactly one loop
   * offers a disabled control saying so rather than picking (see `cardShare`).
   */
  'loops:file': {
    request: { rootId: string; loop: string; title: string; body?: string }
    response: LoopFileResult
  }
  /**
   * `loop close --loop <n> --id <id> --reason wontfix|duplicate --detail <why>`
   * — a person settles an item they do not want done.
   *
   * NOT A DELETE, AND THE CHANNEL IS SHAPED SO IT CANNOT PRETEND TO BE ONE.
   * `detail` is required because the store keeps it as permanent, searchable
   * memory: a producer that files the same idea tomorrow finds the refusal and
   * drops it, which is the whole mechanism by which rejecting something once
   * means rejecting it forever. An unexplained dismissal reads as a loop giving
   * up, and the CLI refuses it — better to require the sentence than to invent
   * one here.
   *
   * `done` IS DELIBERATELY NOT REACHABLE. Closing an item as done demands
   * machine-checkable evidence (commands run, exit codes captured); a button in
   * a board has none and could only fabricate it. Work finishes through the run
   * that did it, or through the pull request that carries it.
   */
  'loops:close': {
    request: {
      rootId: string
      loop: string
      id: string
      reason: 'wontfix' | 'duplicate'
      detail: string
      owner?: string
    }
    response: LoopCloseResult
  }
  /**
   * `loop finish --loop <n> --focus <text>` — a person says a hunt is done.
   *
   * FINISHED, NOT ERASED, and that is the difference from `loops:forget`. The
   * hunt is marked `stopped` — a person's decision, the store's own word — and
   * KEEPS its count, so the board can draw it in Done as the work it was rather
   * than dropping it off the screen. `remaining` says how many hunts the loop
   * still has running, which is how a caller decides whether the loop itself
   * now has anything to do.
   */
  'loops:finishHunt': {
    request: { rootId: string; loop: string; focus: string }
    response: LoopFinishResult
  }
  /**
   * `loop forget --loop <n> [--focus <text> | --all]` — a hunt is over.
   *
   * THE VERB BETWEEN "CARRY ON" AND NOTHING. `resume --focus` restarts a hunt
   * at zero and keeps hunting; nothing ended one — so clearing a loop out left
   * its hunts on the board reading `filed 0/20`, restarted rather than
   * finished. Removal, not a status: a `stopped` hunt is one a person may
   * resume, and is still reported and still drawn.
   *
   * NO RUNTIME STATE. Forgetting a hunt lifts no pause and closes nothing on
   * the queue — other verbs do those, and a person who set them meant them.
   */
  'loops:forget': {
    request: { rootId: string; loop: string; focus?: string; all?: boolean }
    response: LoopForgetResult
  }
  /**
   * The word THIS INSTALLATION claims under — minted once, kept forever.
   *
   * NO ROOT: it identifies the copy of Flow, not a project, which is exactly
   * the scope over which a retried claim has to match. The renderer needs it in
   * hand rather than only in main, because telling its OWN claim from a
   * stranger's — the whole point of the stable owner — is a comparison the
   * board makes against `card.heldBy` while deciding what to draw and say.
   */
  'loops:owner': { request: Record<string, never>; response: { owner: string } }

  // settings (app-wide, not per-project .flowconfig) — onboarding + autonomy (#48)
  'settings:getOnboarding': { request: Record<string, never>; response: OnboardingState }
  /** Partial update of app-wide settings; omitted fields are left unchanged. */
  'settings:setOnboarding': {
    request: { completed?: boolean; autonomyBypassDefault?: boolean }
    response: void
  }
  // Auto-mode effort→model routing (#129) — the full, validated map.
  /**
   * Has this person agreed to share usage data?
   *
   * `null` means nobody has been asked. It is NOT a no and is never a yes —
   * the first-run wizard has to tell "declined" from "not reached", and an
   * unanswered question resolved by a default is how somebody who was never
   * asked ends up being collected from.
   */
  'settings:getTelemetryConsent': { request: Record<string, never>; response: boolean | null }
  /**
   * Who is signed in, or null.
   *
   * SUBJECT AND DISPLAY NAME ONLY. The session token is a main-process concern
   * with no renderer route, exactly as the credentials invariant at the top of
   * this file requires — no channel may return one and none should carry one.
   */
  'auth:whoAmI': {
    request: Record<string, never>
    response: { subject: string; displayName: string | null } | null
  }
  /** Whether this build can offer sign-in at all. */
  'auth:available': { request: Record<string, never>; response: boolean }
  /** Begin a sign-in. Resolves with a sentence either way. */
  'auth:signIn': {
    request: Record<string, never>
    response:
      | { ok: true; subject: string; displayName: string | null }
      | { ok: false; reason: string }
  }
  /** Sign out, and say what it did. */
  'auth:signOut': { request: Record<string, never>; response: { removed: boolean; detail: string } }
  /**
   * Feature view sharing. The renderer names a discovery by root + path; main
   * validates it, reads exactly the walkthrough page and the markdown, and
   * talks to the share host with the session token it never hands over.
   */
  'share:get': { request: ShareDocRef; response: ShareGetResult }
  /**
   * "Check sharing status" — a person's press only. Asks the share host about
   * this discovery even when nothing on this machine says it is shared (a share
   * made from another computer), and remembers what it finds. `share:get`
   * never asks the host about a discovery this machine has no record of
   * (review R2-M7).
   */
  'share:check': { request: ShareDocRef; response: ShareGetResult }
  'share:publish': { request: SharePublishRequest; response: ShareSummaryResult }
  'share:update': { request: ShareUpdateRequest; response: ShareSummaryResult }
  'share:revoke': { request: ShareRevokeRequest; response: ShareSummaryResult }
  'share:views': { request: { id: string }; response: ShareViewsResult }
  /**
   * Workspaces — groups of projects that own their knowledge. Always on:
   * every project lives in one. Every channel goes through main's registry
   * over the bundled CLI's `workspace` verbs (the source of truth). Membership
   * is derived from the CLI, never stored (no schema change). Roots are
   * validated in main and a thread's checkout is answered as its project.
   */
  /** Every Workspace on this computer, its projects, and the Flow folder. */
  'workspaces:list': { request: Record<string, never>; response: WorkspaceAnswer<WorkspacesList> }
  /** Which Workspace and project a project root is, and its sibling projects. */
  'workspaces:status': { request: { rootPath: string }; response: WorkspaceAnswer<{ membership: WorkspaceMembership }> }
  /** The Workspace each root belongs to — one question for a whole thread list or board. */
  'workspaces:membership': { request: { roots: string[] }; response: WorkspaceAnswer<WorkspaceRootMembership> }
  /** Create a Workspace (a remote is recorded, never contacted). */
  'workspaces:create': { request: { name: string; remote?: string }; response: WorkspaceAnswer<{ workspace: WorkspaceSummary }> }
  /**
   * Add a project to a Workspace and link its knowledge there. `confirmCommit:
   * true` only after a person has seen the one commit a committed knowledge
   * folder takes (the refusal without it carries that commit).
   */
  'workspaces:link': {
    request: { rootPath: string; workspace: string; projectId?: string; confirmCommit?: boolean }
    response: WorkspaceAnswer<WorkspaceLinkResult>
  }
  /** A Workspace's display name (its handle never changes). */
  'workspaces:rename': { request: { slug: string; name: string }; response: WorkspaceAnswer<{ workspace: WorkspaceSummary }> }
  /** Move a project, and its knowledge, into another Workspace. */
  'workspaces:moveProject': { request: { project: string; to: string; from?: string }; response: WorkspaceAnswer<{ to: string }> }
  /**
   * Delete a Workspace on this computer after a person confirmed: its projects
   * move into Default, its folder is kept as a backup, the shared copy online
   * is not touched. Default refuses.
   */
  'workspaces:delete': { request: { slug: string }; response: WorkspaceAnswer<WorkspaceDeleteResult> }
  /** The projects outside every Workspace (waiting on a person, or failed), and whether the launch migration still runs. */
  'workspaces:placement': { request: Record<string, never>; response: WorkspacePlacementState }
  /** "Move it in": the one confirmed commit a committed knowledge folder takes. A person's press only. */
  'workspaces:moveIn': { request: { rootPath: string }; response: WorkspaceAnswer<WorkspaceLinkResult> }
  /** Try a project that could not move into a Workspace again. */
  'workspaces:retryPlacement': { request: { rootPath: string }; response: WorkspacePlacementState }
  /** Join a Workspace by its repository address (one clone), linking the projects this computer has. */
  'workspaces:join': { request: { remote: string; name?: string }; response: WorkspaceAnswer<WorkspaceJoinResult> }
  /** The selected Workspace (falls back to the first one here). */
  'workspaces:current': { request: Record<string, never>; response: WorkspaceAnswer<{ slug: string | null }> }
  'workspaces:setCurrent': { request: { slug: string | null }; response: WorkspaceAnswer<{ slug: string | null }> }
  /** FR-3: the opened project belongs to a Workspace here but is not linked yet — suggest linking it. */
  'workspaces:suggest': { request: { rootPath: string }; response: WorkspaceAnswer<{ suggestion: WorkspaceSuggestion }> }
  /** A task card's projects besides its own (stored as app settings — no schema change). */
  'workspaces:taskProjects': { request: { taskId: string }; response: WorkspaceAnswer<{ roots: string[] }> }
  /** Every card's projects in ONE read — the board asks once per paint, not once per card. */
  'workspaces:taskProjectsMany': {
    request: { taskIds: string[] }
    /** `chosen`: the asked tasks whose projects a person picked (the remote ticket's picker). */
    response: WorkspaceAnswer<{ projects: Record<string, string[]>; chosen: string[] }>
  }
  'workspaces:setTaskProjects': { request: { taskId: string; roots: string[] }; response: WorkspaceAnswer<{ roots: string[] }> }
  /**
   * One Workspace's knowledge sync (the CLI's `workspace sync`, scheduled by
   * main's engine). Reading starts nothing; `disabled` while Workspaces are off.
   */
  'workspaces:syncStatus': { request: { slug: string }; response: WorkspaceSyncStatus }
  /** Commit, bring in and send the Workspace's knowledge now — a paused or failed one is tried again. */
  'workspaces:syncNow': { request: { slug: string }; response: WorkspaceSyncStatus }
  /**
   * Settle one paused item (an ask or a review) by its path, then sync again;
   * the pause clears once nothing is waiting. `take: 'text'` sends the merged
   * text itself — a file path is never accepted.
   */
  'workspaces:resolve': { request: WorkspaceResolveRequest; response: WorkspaceResolveResult }
  /**
   * Connecting a Workspace to a shared repository. `hostTools`: which hosts
   * this computer's own signed-in tools can create a repository on, and where
   * (owners, organizations and their projects) — no credential is held or
   * sent. `createRemote`: a PRIVATE repository there, then connected.
   * `setRemote`: an existing repository on any git host, by its address.
   * `unsetRemote`: disconnect — everything stays on this computer and the
   * repository is untouched. Each runs one sync afterwards and answers it.
   */
  'workspaces:hostTools': { request: Record<string, never>; response: WorkspaceHostTools }
  'workspaces:createRemote': { request: WorkspaceCreateRemoteRequest; response: WorkspaceRemoteResult }
  'workspaces:setRemote': { request: WorkspaceSetRemoteRequest; response: WorkspaceRemoteResult }
  'workspaces:unsetRemote': { request: { slug: string }; response: WorkspaceRemoteResult }
  /**
   * Connections learning (discovery workspace-connections-learning): a person
   * pressed Learn connections — check the pending pairs of `rootId`'s
   * Workspace. Answers when the run ends (null: the project is in no
   * Workspace). `connectionsLearningStatus`: the run going now, or the last.
   */
  'workspaces:learnConnections': { request: { rootId: string }; response: ConnectionsLearningStatus | null }
  'workspaces:connectionsLearningStatus': { request: { rootId: string }; response: ConnectionsLearningStatus | null }
  /**
   * Should the telemetry question be raised now?
   *
   * Asked by the shell once, shortly after start. Main owns the decision — it
   * holds the use-day count and the ask count — so the renderer cannot decide
   * to ask somebody who has already answered.
   */
  'settings:shouldAskTelemetry': { request: Record<string, never>; response: boolean }
  /** Record that the question was RAISED, answered or not. */
  'settings:recordTelemetryAsk': { request: Record<string, never>; response: void }
  'settings:setTelemetryConsent': { request: { agreed: boolean }; response: void }
  'settings:getModelRouting': { request: Record<string, never>; response: ModelRouting }
  'settings:setModelRouting': { request: { routing: ModelRouting }; response: void }
  /**
   * Is a runtime signed in RIGHT NOW? (multi_runtime_support)
   *
   * Asked before a runtime is saved: a runtime nobody has authenticated is one
   * that fails at the first turn, minutes later, with whatever its CLI prints
   * to stderr. Four answers, not two — `unknown` exists because a CLI can
   * answer something that is not a sign-in verdict at all (a bad config key),
   * and reporting that as "not signed in" sends a signed-in user to a login
   * they already have.
   */
  'settings:checkRuntimeAuth': {
    request: { provider: string }
    response: {
      provider: string
      status: 'ready' | 'not-installed' | 'not-signed-in' | 'unknown'
      detail: string
    }
  }
  /**
   * Install a runtime's command-line tool, here, so the answer to "it is not
   * installed" is a button and not an instruction to go and type something
   * somewhere else (forbidden-pattern #12).
   *
   * Non-interactive by construction — this installs, it never signs in. A login
   * is interactive (a browser, a pasted code) and belongs in the terminal where
   * the person can answer it.
   */
  'settings:installRuntime': {
    request: { provider: string }
    response: {
      ok: boolean
      /** The installer's own last words — shown verbatim when it failed. */
      detail: string
    }
  }
  /**
   * Sign in to an external runtime IN THE APP — the Claude flow's shape for the
   * other two: a URL and a code appear here, the browser does the rest, and
   * this resolves when the tool's own process exits.
   */
  'settings:startRuntimeLogin': {
    request: { provider: string }
    /** A CLASSIFIED reason, never the tool's own words — see
     *  RuntimeLoginProgress. */
    response: { ok: boolean; reason?: RuntimeLoginFailure }
  }
  'settings:cancelRuntimeLogin': { request: Record<string, never>; response: void }
  /**
   * Sign OUT of an external runtime — its own logout command, where it has
   * one. `ok: false` with an empty detail means this runtime offers none.
   */
  'settings:signOutRuntime': {
    request: { provider: string }
    response: { ok: boolean; detail: string }
  }
  /**
   * The models a runtime can be asked for, here.
   *
   * Neither external CLI can list what an account may use, so this is what
   * Flow knows: the model the runtime's own config already names, plus the ids
   * the user has added. Claude's list is fixed and lives in the shared
   * catalogue, not here.
   */
  'settings:getRuntimeModels': {
    request: { provider: string }
    response: {
      /** The list the user keeps — what the composer offers beside Auto. */
      models: string[]
      /** Ids the runtime's OWN records name (its configured default, the
       *  models its sessions ran under, the ones Flow watched it use). These
       *  are evidence: this account has them. */
      suggested: string[]
      /** Ids worth TRYING — commonly available on that runtime, with no claim
       *  that this plan includes them. A plan that lacks one refuses it, and
       *  the refusal is visible in the transcript. */
      candidates: string[]
      /** The provider's LIVE catalogue when Flow could read it — Copilot's
       *  `/models` endpoint (#1929), carrying each model's context window.
       *  Absent/empty when there is no token or the call failed; the picker
       *  then stands on the lists above, exactly as before. */
      catalog?: RuntimeCatalogModel[]
      /** The user's saved context-window choice per model id (#1929), for the
       *  models whose catalogue entry offers an extended (e.g. 1M) context. */
      contextPreferences?: Record<string, RuntimeContextChoice>
    }
  }
  'settings:setRuntimeModels': { request: { provider: string; models: string[] }; response: void }
  /** Persist the context-window choice for one model (#1929). See
   *  `RuntimeContextChoice`. */
  'settings:setModelContext': {
    request: { provider: string; model: string; context: RuntimeContextChoice }
    response: void
  }
  'settings:getDefaultProvider': { request: Record<string, never>; response: { provider: string | null } }
  'settings:setDefaultProvider': { request: { provider: string }; response: void }
  /** The provider a specific project resolves to, and which rung answered:
   *  its own flow/.flowconfig `provider` ('project'), the app-wide default
   *  ('default'), or the built-in Claude fallback ('builtin'). Mirrors
   *  resolveProvider's precedence; `source` comes from key presence. */
  'settings:getProjectProvider': {
    request: { rootPath: string }
    response: { provider: string; source: 'project' | 'default' | 'builtin' }
  }
  /** The person's app-wide worktree defaults — raw strings, absent = unset. */
  'settings:getWorktreeDefaults': {
    request: Record<string, never>
    response: { defaults: Partial<WorktreeDefaults> }
  }
  /** Set or unset worktree defaults; a `null` value goes back to inheriting.
   *  Answers with the whole record after the write, so the panel never has to
   *  guess what it now holds. */
  'settings:setWorktreeDefaults': {
    request: { patch: Partial<Record<WorktreeSettingKey, string | null>> }
    response: { defaults: Partial<WorktreeDefaults> }
  }

  // brain (the single knowledge store — #52). rootId === absolute rootPath.
  /** Search the trusted brain tiers (features/errors/decisions/structure); .raw/ excluded. */
  'brain:query': {
    request: { rootId: string; query: string; limit?: number }
    response: BrainQueryResult
  }

  // project (projects are addressed by absolute rootPath, matching main)
  'project:list': { request: Record<string, never>; response: RegisteredProject[] }
  /**
   * Every root the renderer may address — registered projects AND threads'
   * checkouts — innermost first.
   *
   * `project:list` is the PROJECT LIST, which is a different question: a
   * surface that owns an absolute path and needs the root containing it must
   * ask this one, or it will find no root for anything inside a thread's
   * checkout and quietly do nothing.
   */
  'project:addressableRoots': { request: Record<string, never>; response: string[] }
  /** `workspace`: the Workspace the project joins (the current one when absent). */
  'project:add': { request: { path: string; workspace?: string }; response: RegisteredProject }
  /** Opens a native folder picker in the main process, adds the chosen directory
   *  as a root and ENTERS it — a foreground "open this project" always lands in
   *  the project the user picked, including one that is already open (#1008).
   *  Resolves to the new (or already-present) root, or null when the user
   *  cancels. `path` skips the dialog for an already-resolved pick (e2e drives
   *  the real post-pick path this way — the native dialog is not automatable). */
  'project:open': {
    /** `workspace`: the Workspace the project joins (the current one when absent). */
    request: { path?: string; workspace?: string }
    response: RegisteredProject | null
  }
  /** Native directory picker with NO side effects — returns the picked path or
   *  null on cancel. Used by the thread context-roots picker's Browse… flow
   *  (add-a-folder-from-disk to a thread's context) where openProject's
   *  activate-on-add behavior would yank the user's active project. */
  'project:pickFolder': {
    request: Record<string, never>
    response: string | null
  }
  /** Remove a project entirely (its tasks + threads + the project root), so it
   *  leaves the sidebar even when it owns threads. Destructive — the UI confirms. */
  'project:remove': { request: { rootPath: string }; response: void }
  /** Rename/move a file or directory within the same root (both paths contained). */
  'project:renamePath': {
    request: { rootPath: string; relPath: string; newRelPath: string }
    response: void
  }
  /** Delete a file or directory (recursive) inside the root. Destructive — the UI confirms. */
  'project:deletePath': { request: { rootPath: string; relPath: string }; response: void }
  /** Create an empty file or a directory at a contained path inside the root. */
  'project:createPath': {
    request: { rootPath: string; relPath: string; kind: 'file' | 'directory' }
    response: void
  }
  /** Reveal a project path in the OS file manager (#1063). Root-contained
   *  like every other file channel — the renderer sends only rootPath+relPath. */
  'project:revealPath': {
    request: { rootPath: string; relPath: string }
    response: void
  }
  // Reorder roots to match orderedPaths (index = new position); returns the
  // reordered list. rootsChanged is broadcast so every surface re-reads.
  'project:reorderRoots': {
    request: { orderedPaths: string[] }
    response: RegisteredProject[]
  }
  'project:listDir': {
    request: { rootPath: string; relPath?: string }
    response: DirectoryEntry[]
  }
  /** A bounded, ignore-aware FLAT file list for the root — the command palette's
   *  (⌘P) file source. No persistent index: main walks the tree on demand,
   *  skipping SEARCH_IGNORED_DIRS + dotfile dirs, capping at `limit` (default
   *  20000), and returns repo-relative POSIX paths sorted deterministically.
   *  `truncated` is true when the cap was hit. Fail-soft — unreadable dirs are
   *  skipped, never thrown. The renderer fuzzy-filters the returned list. */
  'project:listAllFiles': {
    request: { rootPath: string; limit?: number }
    response: { relPaths: string[]; truncated: boolean }
  }
  'project:listCommands': {
    request: { rootPath: string }
    response: SlashCommand[]
  }
  /** Search file CONTENTS under a root — the file-explorer content-search panel.
   *  No persistent index: main walks the tree on demand (skipping
   *  SEARCH_IGNORED_DIRS + dotfile dirs), skips binary/oversized files, and scans
   *  each candidate for a literal substring (case-insensitive unless
   *  `caseSensitive`). Bounded by `maxResults` (total matches) and `maxPerFile`;
   *  `truncated` is true when a cap was hit. Fail-soft — unreadable dirs/files are
   *  skipped, never thrown; an unknown root rejects. Empty/whitespace query
   *  returns no matches. */
  'project:searchContent': {
    request: {
      rootPath: string
      query: string
      caseSensitive?: boolean
      maxResults?: number
      maxPerFile?: number
    }
    response: ContentSearchResult
  }
  'project:readFile': {
    /** `missingOk`: a file that is not there (yet) answers `missing: true`
     *  instead of failing — for readers that expect a document to come and go
     *  (a plan card re-reading its plan while the `flow` link is being made). */
    request: { rootPath: string; relPath: string; missingOk?: boolean }
    response: FileContent
  }
  'project:writeFile': {
    request: { rootPath: string; relPath: string; content: string }
    response: void
  }
  /** Resolve a raw file reference from chat (bare name or partial path) to a
   *  real root-relative path, searching the project (flow/ artifacts first).
   *  `relPath` is null when nothing matches. */
  'project:resolveFileRef': {
    request: { rootPath: string; ref: string }
    response: { relPath: string | null }
  }
  // Project context (ADR-002): active-project switching + per-project state.
  'project:active': { request: Record<string, never>; response: ProjectContext | null }
  /** Enter a project. Resolves to the project's restored context — or to the
   *  UNCHANGED current context (null when nothing is active) when the request
   *  is refused because that root's folder isn't reachable (#974/#1118): the
   *  app never binds to a directory that isn't there, and the caller can see it
   *  didn't land where it asked. */
  'project:setActive': {
    request: { rootPath: string }
    response: ProjectContext | null
  }
  'project:saveOpenFiles': {
    request: {
      rootPath: string
      openFiles: OpenFileRef[]
      activeFile: string | null
      /** Unsaved buffer contents by absolute path — restored on switch-back (#955). */
      dirtyBuffers: Record<string, string>
    }
    response: void
  }
  /**
   * The tab set of one conversation in one project — `threadId: null` is the
   * project-level set (no thread selected). Never null: a set nobody saved
   * yet is the empty set. Tabs whose root can no longer be addressed are
   * filtered out on the way out, like the project context's.
   */
  'project:loadTabSet': {
    request: { rootPath: string; threadId: string | null }
    response: TabSet
  }
  /** Persist one conversation's tab set (see `project:loadTabSet`). */
  'project:saveTabSet': {
    request: { rootPath: string; threadId: string | null } & TabSet
    response: void
  }
  /**
   * The shells one scope had open when it was last left — `threadId: null` is
   * the project view. Main writes these itself as shells open, close and exit;
   * the renderer only reads them, to re-spawn a scope's shells after a restart.
   */
  'project:loadScopeTerminals': {
    request: { rootPath: string; threadId: string | null }
    response: SavedTerminalRef[]
  }
  /**
   * The renderer's answer to `project:flushEditorContext` (#1443): its
   * `saveOpenFiles` write has been issued, so the main process may proceed with
   * teardown. Sent even when there is nothing to persist — the ack is about the
   * handshake completing, not about work having happened.
   */
  'project:editorContextFlushed': { request: Record<string, never>; response: void }
  'project:setActiveThread': {
    request: { rootPath: string; threadId: string }
    response: void
  }
  /** The current thread scope (multi-project threads): the active project's
   *  active thread + its ordered root set. Snapshot pair of the
   *  `project:threadScopeChanged` event — the one scope source of truth. */
  'project:getThreadScope': { request: Record<string, never>; response: ThreadScope }
  /** Set (or clear, with `color: null` = "Auto") the user accent override for a
   *  root. One write path (ProjectRegistry.setRootAccent); the change fans out
   *  live via `project:listChanged` + `project:threadScopeChanged`. Resolves
   *  to the updated root, or null when `rootPath` isn't a known available root. */
  'project:setRootAccent': {
    request: { rootPath: string; color: string | null }
    response: RegisteredProject | null
  }
  /** Manual re-provision (ide-auto-provisioning settings row, #Phase5): force the
   *  bundled CLI's provision flow for one root regardless of its current stamp.
   *  Fire-and-forget from the caller's perspective — success/failure surface via
   *  `project:listChanged` (stamp update) or a `flow:notification` toast. */
  'project:provisionRoot': { request: { rootPath: string }; response: void }
  // Per-project Anthropic accounts (multi-account isolation). Values (config
  // dir / token) never cross this boundary — labels/ids/identity only.
  'accounts:list': { request: Record<string, never>; response: AccountSummary[] }
  'accounts:add': {
    request: { label: string }
    response: { account: AccountSummary } | { error: string }
  }
  /** Live auth check for one account (settings UI — subprocess probe).
   *  `checked: false` = the probe itself failed; loggedIn is then unknown. */
  'accounts:status': {
    request: { id: string }
    response: { checked: boolean; loggedIn: boolean; identity: string | null }
  }
  /** Interactive re-login into the account's EXISTING config dir (expired
   *  enterprise sessions — user call 2026-07-27). Blocks during OAuth. */
  'accounts:relogin': {
    request: { id: string }
    response: { ok: true; identity: string | null } | { ok: false; error: string }
  }
  /** Deliver the pasted OAuth authorization code to the active interactive
   *  login's stdin (#972). `ok: false` = no login is waiting for a code. */
  'accounts:submitLoginCode': {
    request: { code: string }
    response: { ok: boolean }
  }
  /** Abort the active interactive login (#972) — the pending add/relogin
   *  resolves as canceled. `ok: false` = no login was active. */
  'accounts:cancelLogin': {
    request: Record<string, never>
    response: { ok: boolean }
  }
  'accounts:remove': { request: { id: string }; response: void }
  'accounts:setDefault': { request: { id: string | null }; response: void }
  'accounts:assignProject': {
    request: { rootPath: string; accountId: string | null }
    response: void
  }
  'accounts:activeForProject': {
    request: { rootPath: string }
    response: AccountResolutionSummary
  }
  // In-app auto-update (#auto-update). check returns the current status; download
  // runs in the background (progress via the updater:status event); install quits
  // and relaunches into a downloaded update.
  'updater:check': { request: Record<string, never>; response: UpdateStatus }
  /** One-shot post-update detection + release-notes coordinates. `changedTo`
   *  is the new version exactly once after an update completed (then stamped),
   *  null otherwise; `repo` is the public releases repo ("owner/name") for
   *  fetching release-note bodies, null when unknown (dev). */
  'updater:whatsNew': {
    request: Record<string, never>
    response: { changedTo: string | null; previous: string | null; repo: string | null }
  }
  'updater:download': { request: Record<string, never>; response: void }
  /** Release-notes body for a version, fetched in MAIN (the renderer's CSP is
   *  connect-src 'self' by design — it must never call GitHub itself). */
  'updater:releaseNotes': {
    request: { repo: string; version: string }
    response: { notes: string | null }
  }
  'updater:install': { request: Record<string, never>; response: void }

  // diagnostics — evidence for "the app is slow", written by whoever noticed.
  // The renderer and the preload see stalls main cannot (a blocked paint, a
  // round trip that queued), and a console nobody opens is not a record. Both
  // append into the SAME file main already writes, so one file answers the
  // question instead of three.
  /** Append lines to the performance log. Batched by the caller — never one
   *  round trip per line, or the instrument becomes the problem. */
  'diagnostics:record': { request: { lines: string[] }; response: void }
  /** The log's recent tail, plus what it is worth: `empty` means nothing has
   *  been slow enough to record, which is an answer, not a missing file. */
  'diagnostics:report': {
    request: Record<string, never>
    response: { text: string; empty: boolean }
  }

  // learn (progressive-learning #513). rootId === absolute rootPath (matching
  // the blueprint/brain/project addressing convention).
  /** Answer the basic-discovery onboarding ask for a root. 'yes' records the
   *  answer AND requests a basic discovery (main-side `learn:basicDiscoveryRequested`
   *  emitter fires); 'no' records the answer and never re-asks. The Settings
   *  "Run basic discovery" action re-fires with 'yes'. */
  'learn:answerBasicDiscovery': {
    request: { rootId: string; answer: BasicDiscoveryAnswer }
    response: void
  }
  /** Answer the chat-learn ask — the prompt raised when a conversation worked
   *  in an area the blueprint does not understand yet. 'yes' enqueues a learn
   *  pass for `modulePath` and re-levels the store so the result hangs under
   *  the feature that owns it; 'no' does nothing (the thread is never asked
   *  again either way — main holds the asked set). */
  'learn:answerChatLearn': {
    request: { rootId: string; modulePath: string; answer: BasicDiscoveryAnswer }
    response: void
  }
  /** Learn (or re-learn) a single module — the board's "Learn" button. Enqueues
   *  a deliberate learn pass on the main-side orchestrator; the resulting
   *  learning-state transitions surface via the blueprint watcher. */
  /** Where each of these projects stands on its basic discovery (unknown roots are omitted). */
  'learn:basicDiscoveryState': {
    request: { roots: string[] }
    response: Record<string, BasicDiscoveryStatus>
  }
  'learn:learnModule': {
    request: { rootId: string; modulePath: string }
    response: void
  }
  /** Learn a FEATURE: read the code its anchors claim and write its
   *  machine-owned `## Learned` section. Distinct from learnModule, which
   *  documents one directory — a feature is not the sum of its directories. */
  /** Generate the curated VIEW for a feature — components, labelled edges,
   *  code excerpts — from its plan, discovery docs and code. */
  'learn:generateFeatureView': {
    request: { rootId: string; featureRef: string; featureName: string; modulePaths: string[] }
    response: void
  }
  'learn:learnFeature': {
    request: {
      rootId: string
      /** Feature id or slug — what `blueprint features learned --feature` takes. */
      featureRef: string
      featureName: string
      /** Module dirs the feature's resolved anchors point at. */
      modulePaths: string[]
    }
    response: void
  }
  /** Pause/resume the learn drain loop (the Learning panel's Pause button).
   *  Global — the queue is global-serial. While paused no NEW pass starts; the
   *  active pass finishes and records normally. Main echoes the resulting state
   *  on the `learn:pausedChanged` broadcast so every window's label stays live. */
  /**
   * What the learner is doing RIGHT NOW — asked, not inferred.
   *
   * The panel used to read "a sync is live" off the learning-state FILE, where
   * a row left saying 'queued' by a closed session claimed it forever. A file
   * records intent; only the orchestrator knows whether a pass is running.
   */
  'learn:status': {
    request: Record<string, never>
    response: {
      running: boolean
      paused: boolean
      activeModule: string | null
      /**
       * The root the active pass belongs to — null when nothing is running.
       *
       * ONE ORCHESTRATOR SERVES EVERY PROJECT, so the pass being reported may
       * not belong to the project the reader is looking at, while the panel's
       * Stop and Reset only reach the root it is viewing. Without this the two
       * cannot be told apart, and the panel narrates one project while its
       * buttons aim at another.
       */
      activeRoot: string | null
      queued: number
      /** When the active pass started (epoch ms), or null when idle. */
      startedAt: number | null
      /** Queued passes per project root (optional: an older main omits it). */
      queuedByRoot?: Record<string, number>
      /** Projects paused on their own. */
      pausedRoots?: string[]
    }
  }
  /**
   * The learner's recent activity, oldest first — a bounded in-memory ring.
   *
   * Asked for after watching one module for six minutes with no way to tell a
   * slow pass from a stopped one: "show the logs really". Not persisted, not
   * authoritative; a window on this session.
   */
  'learn:log': {
    request: Record<string, never>
    response: {
      entries: Array<{
        at: number
        kind: 'queued' | 'start' | 'read' | 'learned' | 'failed' | 'stopped' | 'note'
        module: string
        detail?: string
      }>
    }
  }
  'learn:pause': {
    request: { paused: boolean }
    response: { ok: true }
  }
  /** Pause or resume ONE project's learning; the others keep going. */
  'learn:pauseRoot': {
    request: { rootId: string; paused: boolean }
    response: { ok: true }
  }
  /** Stop a root's learning (the Learning panel's Stop button): abort the
   *  active pass + drop the queue; orphaned queued/learning entries flip to
   *  stale immediately (surfaces via the blueprint watcher). */
  'learn:cancel': {
    request: { rootId: string }
    response: { ok: boolean }
  }
  /**
   * Forget everything the learner knows about a root — the Learning panel's
   * Reset.
   *
   * It used to clear one file, the status table, while every artifact the
   * learning produced stayed on disk: the module docs, the investigation notes
   * and their heat, the generated feature views, and the machine-owned sections
   * inside each feature. The map came back looking exactly as informed as
   * before, which is not what pressing Reset asks for.
   *
   * `dryRun` counts without touching anything — what the panel shows before it
   * asks. The tally is what a person is told, in both moods.
   */
  'learn:reset': {
    request: { rootId: string; dryRun?: boolean }
    response: { ok: boolean; tally?: LearnForgetTally; reason?: string }
  }
  /** Cumulative brain-retrieval counters for a root (brain-first-retrieval
   *  Phase 4) — the Learning panel's "Brain retrieval" line. Fail-soft: an
   *  unreadable store answers zeros, never an error. */
  'learn:brainUsage': {
    request: { rootId: string }
    response: BrainUsageTotals
  }
  /**
   * The one-time CLASSIFY pass (plan `feature-type-icons`, FR-10): the smallest
   * model, in batches, decides a role for every learned feature (and part)
   * whose role is still only a guess — from names, summaries and part names,
   * never code — and writes each through the learnedRole verb.
   *
   * Offered by the board, never run silently. Resolves when the pass ENDS, with
   * what it did; `learn:classifyRolesProgress` reports it batch by batch.
   * `stop: true` stops a running pass for the root (its own call resolves with
   * `stopped: true`) and answers at once. A second start while one runs is
   * refused with `ok: false` and a reason. Whether to OFFER the pass is derived
   * in the renderer from the nodes on screen (`shared/role-classify.ts`).
   */
  'learn:classifyRoles': {
    request: { rootId: string; stop?: boolean }
    response: {
      ok: boolean
      written: number
      skipped: number
      failed: number
      total: number
      stopped: boolean
      /** Why it did not run — a sentence for a person, never a command. */
      reason?: string
    }
  }
  /** Compile a doc's `## Story` section via `blueprint narrate --from <docPath>`
   *  (cwd = root). Never throws for a CLI failure — a refusal (bad anchors,
   *  missing graph, etc.) comes back as `{ ok: false, reason }` with the CLI's
   *  own refusal text, verbatim. */
  'learn:narrate': {
    request: { rootId: string; docPath: string }
    response: { ok: true; summary: string } | { ok: false; reason: string }
  }
  // Existing flow/ artifacts for a root — the renderer seeds cards on mount from
  // this (the watcher's ignoreInitial means live events never cover pre-existing
  // docs after a reload).
  'flow:listArtifacts': {
    request: { rootId: string }
    response: FlowArtifactListResult
  }

  // browser (embedded <webview> browser tab) — the CONTRACT only; handlers
  // land in a later phase. Navigation verbs answer void; capture/tag verbs
  // answer where the question was asked (allowed-pattern #21) AND emit the
  // corresponding event.
  'browser:navigate': { request: { url: string }; response: void }
  'browser:back': { request: Record<string, never>; response: void }
  'browser:forward': { request: Record<string, never>; response: void }
  'browser:reload': { request: Record<string, never>; response: void }
  /** Toggle element-inspect mode (hover-to-tag) on the webview. */
  'browser:setInspect': { request: { on: boolean }; response: void }
  /** What the current page supports — probed per navigation (source mapping,
   *  CDP). Gates the element→source and rich console/network paths. */
  'browser:capabilities': { request: Record<string, never>; response: BrowserCapabilities }
  /** Grab a screenshot of the webview as a pending attachment (null on
   *  failure) — mirrors `attachments:captureScreen`. */
  'browser:captureScreenshot': {
    request: Record<string, never>
    response: MessageAttachmentInput | null
  }
  /** Tag a window of a kind's most-recent captures; also emits `browser:tagPosted`. */
  'browser:tagRecent': {
    request: { kind: BrowserCaptureKind; window: TagWindow }
    response: BrowserCapture[]
  }
  /** Tag one capture by id; also emits `browser:tagPosted`. Null if it's gone. */
  'browser:tagEntry': {
    request: { kind: BrowserCaptureKind; id: string }
    response: BrowserCapture | null
  }
  /** Read a slice of a kind's capture buffer without tagging it. */
  'browser:bufferSlice': {
    request: { kind: BrowserCaptureKind; selector: TagWindow }
    response: BrowserCapture[]
  }
  /**
   * Drop every buffered console/network/element capture. Sent when the browser
   * passes from one conversation to another, so one thread's "Add all" can
   * never attach what another thread's page logged.
   */
  'browser:clearCaptures': { request: Record<string, never>; response: void }

  // ── Debug session ─────────────────────────────────────────────────────────
  // One window in time across the browser AND the thread's terminals. See
  // `src/main/debug/debug-session.ts` for what a window is and why it is not
  // an attachment lifetime.

  /** Open the window. Starting twice returns the live session, not a second. */
  'debug:start': {
    request: { threadId: string | null }
    response: DebugSessionSummary
  }
  /** Close it, write the artifact, and post the summary to the thread. */
  'debug:stop': {
    request: Record<string, never>
    response: DebugStopResult | null
  }
  /**
   * One thing the person did in the page, on its way to a live session.
   *
   * RENDERER TO MAIN, because the guest can only `sendToHost` — it reaches the
   * window that owns the <webview>, and the session lives in main. Without this
   * hop the guest emitted clicks that nothing received, and every artifact said
   * "nothing was captured from the page itself" while the person had been
   * clicking the whole time (user, 2026-09-21).
   */
  'debug:interaction': {
    request: { kind: 'click' | 'navigate' | 'load'; at: number; target: string; url?: string }
    response: void
  }
  /** What is recording, or null. */
  'debug:status': {
    request: Record<string, never>
    response: DebugSessionSummary | null
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Event channels (main → renderer push)
// ═══════════════════════════════════════════════════════════════════════

export interface IpcEventMap {
  'threads:stream': AgentStreamEvent
  'threads:permissionRequest': PermissionRequest
  /** The agent raised an AskUserQuestion dialog — render it in the conversation. */
  'threads:dialogRequest': UserQuestionRequest
  /** Parked questions were cancelled (user sent a message instead of answering,
   *  #692) — the conversation pane drops the matching cards. */
  'threads:dialogCancel': UserDialogCancel
  /** Debounced batch of ThreadStore mutations (threads/messages/tool calls). */
  'threads:updated': ThreadChangeEvent[]
  /** Debounced batch of TaskStore mutations. */
  'tasks:updated': TaskChangeEvent[]
  /** One project's board loop started, took a card, or stopped. */
  'tasks:boardLoopChanged': BoardLoopState
  'editor:diagnostics': DiagnosticsEvent
  'editor:pendingChangesUpdated': PendingFileChange[]
  /** The app menu's Close Tab (⌘W / Ctrl+W) fired — close the active
   *  editor-area tab (file, markdown, or view tab), never the window (#673). */
  'editor:closeActiveTab': null
  /**
   * #1338: an Edit-menu action the renderer must route itself. Monaco's
   * EditContext focus means Blink's own `undo`/`selectAll` no-op in the code
   * editor, so the menu asks instead of assuming.
   */
  'editor:editAction': 'undo' | 'redo' | 'selectAll'
  /** The app menu's Settings… (⌘, / Ctrl+,) fired — open the Settings overlay,
   *  the same one the titlebar accounts control and the palette open (#1159). */
  'settings:open': null
  'terminal:data': { terminalId: string; data: string }
  'terminal:exit': { terminalId: string; exitCode: number }
  'terminal:created': TerminalInfo
  /** A terminal was disposed (user close, thread teardown) — drop its tab (#304). */
  'terminal:removed': { terminalId: string }
  'git:changed': { rootId: string }
  /** A thread's change review may have changed (#1906) — the card refetches
   *  `threads:changeReview` for this thread. Fired (debounced at the source) off
   *  the same `git:changed` / pending-changes signals. */
  'threads:changeReviewUpdated': { threadId: string }
  /** The first message of a Workspace thread added these projects (Workspaces
   *  Phase 7) — chips the person can remove (the ordinary detach). */
  'threads:contextChosen': ThreadContextChosenEvent
  /** A later message looks like it needs another Workspace project — an OFFER;
   *  accepting it is the ordinary attach. Nothing is attached until then. */
  'threads:contextOffer': ThreadContextOfferEvent
  /** The active project switched — renderer rebinds all surfaces. `null` means
   *  there is no active project anymore (the last/active root was removed, #323),
   *  so surfaces reset to the first-run empty state. */
  'project:activeChanged': ProjectContext | null
  /** The active thread's derived scope changed (multi-project threads) —
   *  re-derived on active project/thread switches, thread_roots mutations, and
   *  root availability refresh. Additive to `project:activeChanged`,
   *  which is untouched. */
  'project:threadScopeChanged': ThreadScope
  'flow:notification': FlowNotification
  'flow:stateChanged': FlowState
  /** A discovery/plan/brainstorm doc was added or changed under flow/. */
  'flow:artifactChanged': FlowArtifactChangedEvent
  /** One conversation's autopilot chain started, moved a step, or ended. */
  'flow:chainChanged': ChainState
  /** A root's blueprint data (graph/annotations/status events) changed — re-read. */
  /**
   * The project's structure changed on disk.
   *
   * `learningOnly` marks the common case during a learn run: the only file
   * touched was learning-state.jsonl. A listener that already holds the graph
   * can refresh the learning rows alone instead of re-reading a snapshot whose
   * graph is megabytes — measured in the renderer's own stack, deserializing
   * them, while the panel was doing nothing else.
   */
  'blueprint:changed': { rootId: string; learningOnly?: boolean }
  /** An invariant-checker pass completed for a root (#898) — advisory verdicts. */
  'blueprint:invariantVerdicts': InvariantVerdictsEvent
  /** Debounced batch of file events for one project root. */
  'project:fileChanged': ProjectFilesChangedEvent
  'project:listChanged': RegisteredProject[]
  /** Accounts or a project→account mapping changed — renderer refreshes + heads-up. */
  'accounts:changed': { rootPath?: string }
  /** Interactive-login progress push (#972): the sign-in URL fallback line, then
   *  the CLI's paste-the-code prompt — drives the code-entry UI in onboarding
   *  and Settings. Each phase fires at most once per login. */
  'accounts:loginEvent': { phase: 'url'; url: string } | { phase: 'awaiting-code' }
  /** An external runtime's in-app sign-in, as it happens. */
  'settings:runtimeLoginEvent': RuntimeLoginProgress
  /**
   * Flow's own sign-in changed: somebody signed in or out, or a session the
   * share host refused was cleared. Every surface that draws sign-in state
   * re-reads it (`auth:whoAmI`, `share:get`) — ONE sign-in state, so Settings
   * and the feature view's Share button never disagree. Carries no identity.
   */
  'auth:changed': { cause: AuthChangeCause }
  /** A Workspace was created, renamed, deleted, linked or joined, a project moved, the selection changed, or a card's projects changed. */
  'workspaces:changed': WorkspacesChangedEvent
  /** A connections-learning run moved (one per pair, plus its start and end). */
  'workspaces:connectionsLearning': ConnectionsLearningStatus
  /** One Workspace's sync status changed. Sent only on a real change, only for that Workspace. */
  'workspaces:syncChanged': WorkspaceSyncChangedEvent
  /** Auto-update lifecycle push — drives the update banner (#auto-update). */
  'updater:status': UpdateStatus
  /** Prompt the renderer to show the one-time basic-discovery ask for a root
   *  (#513 phase 2) — fired on the root's first provisioning-ready when it has
   *  never been answered. `rootId` === absolute rootPath. */
  'learn:basicDiscoveryAsk': { rootId: string }
  /** Ask whether to learn the area a conversation just worked in. Raised at
   *  most ONCE per thread, only for an area that is not already learned, and
   *  only when the turn touched enough of it to be evidence (see
   *  `chat-learn-trigger.ts`). `parentName` is the feature the result will hang
   *  under, or null when nothing claims the module yet. `rootId` === absolute
   *  rootPath. */
  'learn:chatLearnAsk': {
    rootId: string
    threadId: string
    modulePath: string
    fileCount: number
    parentName: string | null
  }
  /** Live learn-progress tick — the caged learner just read `file` for `module`
   *  under `rootId` (throttled per module in main). `rootId` === absolute rootPath. */
  'learn:progress': { rootId: string; module: string; file: string }
  /** The global learn pause state flipped (learn:pause) — panels toggle their
   *  Pause/Resume label live (mirrors learn:progress's event pattern). */
  'learn:pausedChanged': { paused: boolean; pausedRoots?: string[] }
  /** A FEATURE learn pass finished and wrote its `## Learned` section. The
   *  board reopens the brief so the reader sees what was just learned. */
  'learn:featureLearned': { rootId: string; featureRef: string; learnings: number }
  /**
   * A feature's PARTS were named, and progressively learned. Fires once when
   * they are named (`learned: 0`) and again after each part is investigated, so
   * the board can show the decomposition immediately rather than after every
   * child has been read.
   */
  'learn:featureParts': {
    rootId: string
    featureRef: string
    parts: number
    learned: number
  }
  /**
   * How far a feature pass has got through the FILES it ranked.
   *
   * THE ONE FRACTION A PASS HAS FROM ITS FIRST SECOND. `learn:featureParts`
   * only exists once the parts are named, and a feature with no parts never
   * names any — so a reader watching the level page of the feature being read
   * had a collar with nothing to fill it, for the whole pass.
   *
   * This is real and it is not the whole pass: reading is the first phase, and
   * composing the drawing and the learnings follows it with no fraction of its
   * own. So `read`/`total` is exactly what it says — how much of the code has
   * been read — and the surface showing it must say so rather than implying
   * completion.
   */
  'learn:featureReadProgress': {
    rootId: string
    featureRef: string
    read: number
    total: number
  }
  /** A curated view finished generating; the board reopens the brief. */
  'learn:featureViewed': { rootId: string; featureRef: string; components: number }
  /** The classify pass settled another batch (`learn:classifyRoles`). */
  'learn:classifyRolesProgress': { rootId: string; done: number; total: number; written: number }
  /**
   * Basic discovery's FEATURE-GENERATION step settled.
   *
   * Raised on EVERY exit of that step — features confirmed, nothing staged,
   * a CLI refusal, an unready root, a thrown error — for the same reason
   * `drawFeatureView` toasts on every branch: the board shows a running
   * indicator while a discovery it started is in flight, and a branch that
   * signals nothing leaves that indicator spinning forever.
   *
   * `reason` is null on success (`added` is how many features were written,
   * legitimately 0 when a repo names no capability twice over) and carries the
   * one-line failure otherwise. Module learning continues after this event —
   * it has its own panel; this is only the half the feature board draws.
   */
  /** A project's basic-discovery status changed (`rootId` === absolute rootPath). */
  'learn:basicDiscoveryChanged': { rootId: string; status: BasicDiscoveryStatus }
  'learn:featuresDiscovered': {
    rootId: string
    added: number
    reason: string | null
  }
  /**
   * Quit is about to tear the main process down (#1443) — persist the editor's
   * hot-exit state NOW, while `saveOpenFiles` and the DB are still alive.
   *
   * The renderer's own `beforeunload` persist is too late on this path: quit is
   * intercepted and `disposeMainProcess()` (disposeIpc + db.close) runs to
   * completion BEFORE the window unloads, so the write had no receiver left and
   * every edit typed since the last tab mutation was lost — restored clean.
   */
  'project:flushEditorContext': Record<string, never>
  /** A capture buffer's size changed — drives the per-kind tag badge. Carries
   *  the kind that changed plus the full per-kind snapshot. */
  'browser:bufferUpdated': { kind: BrowserCaptureKind; counts: BrowserBufferCounts }
  /** A capture was tagged — the renderer turns this into a composer chip. */
  'browser:tagPosted': BrowserCapture
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

export type IpcInvokeChannel = keyof IpcInvokeMap
export type IpcRequest<C extends IpcInvokeChannel> = IpcInvokeMap[C]['request']
export type IpcResponse<C extends IpcInvokeChannel> = IpcInvokeMap[C]['response']

export type IpcEventChannel = keyof IpcEventMap
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventMap[C]

export type Unsubscribe = () => void

/**
 * Runtime channel allowlists — the preload bridge refuses any channel not
 * listed here, so a compromised renderer cannot reach arbitrary IPC.
 * The `satisfies`/exhaustiveness types below force these arrays to stay in
 * lockstep with the maps above (compile error on drift).
 */
export const IPC_INVOKE_CHANNELS = [
  'threads:list',
  'threads:children',
  'threads:openSubagent',
  'threads:get',
  'threads:create',
  'threads:branchAvailable',
  'threads:update',
  'threads:setRoots',
  'threads:learningFirst',
  'threads:retryLearningFirst',
  'threads:prepareWorktree',
  'threads:worktreeBranches',
  'threads:retargetWorktree',
  'threads:landingPreview',
  'threads:landWorktree',
  'threads:releaseWorktree',
  'threads:worktreeUsage',
  'threads:worktreeInventory',
  'threads:renameWorktreeBranch',
  'threads:forgetWorktree',
  'threads:worktreeBinding',
  'threads:bindWorktree',
  'threads:delete',
  'threads:search',
  'threads:sendMessage',
  'threads:interrupt',
  'threads:setModel',
  'threads:contextUsage',
  'threads:respondPermission',
  'threads:pendingPermissions',
  'threads:pendingDialogs',
  'threads:respondDialog',
  'threads:importClaude',
  'threads:brainSavings',
  'tasks:list',
  'tasks:create',
  'tasks:importIssue',
  'tasks:createFromQueueItem',
  'tasks:setProjects',
  'tasks:boardLoop',
  'tasks:update',
  'tasks:mergePr',
  'tasks:delete',
  'tasks:generateBrief',
  'tasks:ensureThread',
  'integrations:setToken',
  'integrations:status',
  'integrations:clearToken',
  'integrations:assigned',
  'integrations:getListConfig',
  'integrations:setListConfig',
  'integrations:getCloseOnDone',
  'integrations:setCloseOnDone',
  'integrations:previewList',
  'integrations:imageData',
  'threads:backgroundTasks',
  'messages:list',
  'messages:append',
  'toolCalls:list',
  'toolCalls:get',
  'threads:subagentTranscript',
  'editor:hover',
  'editor:definition',
  'editor:completions',
  'editor:didOpen',
  'editor:didChange',
  'editor:didClose',
  'editor:pendingChanges',
  'editor:resolveHunk',
  'terminal:list',
  'terminal:create',
  'terminal:write',
  'terminal:resize',
  'terminal:dispose',
  'terminal:claim',
  'terminal:rename',
  'attachments:read',
  'attachments:revealPath',
  'attachments:captureScreen',
  'git:renameBranch',
  'git:status',
  'git:log',
  'git:diff',
  'threads:changeReview',
  'git:listUntrackedDir',
  'git:commit',
  'git:stage',
  'git:unstage',
  'git:discardFile',
  'git:commitIndex',
  'git:publish',
  'git:mergeState',
  'git:readConflicted',
  'git:resolveConflict',
  'git:resolveConflictHunk',
  'git:completeMerge',
  'git:abortMerge',
  'git:continueRebase',
  'git:abortRebase',
  'git:verifyMerge',
  'git:writeMergeSummary',
  'git:listBranches',
  'git:mergeBranch',
  'git:pull',
  'git:listAgentClashes',
  'git:readAgentClash',
  'git:reconcileAgentClash',
  'review:list',
  'review:reject',
  'review:generateCommitMessage',
  'flow:state',
  'flow:respondPrompt',
  'flow:setConfig',
  'flow:worktreeSettings',
  'flow:recordVerdict',
  'flow:chain',
  'settings:getOnboarding',
  'settings:setOnboarding',
  'settings:getTelemetryConsent',
  'auth:whoAmI',
  'auth:available',
  'auth:signIn',
  'auth:signOut',
  'share:get',
  'share:check',
  'share:publish',
  'share:update',
  'share:revoke',
  'share:views',
  'workspaces:list',
  'workspaces:status',
  'workspaces:membership',
  'workspaces:create',
  'workspaces:link',
  'workspaces:join',
  'workspaces:rename',
  'workspaces:moveProject',
  'workspaces:delete',
  'workspaces:placement',
  'workspaces:moveIn',
  'workspaces:retryPlacement',
  'workspaces:current',
  'workspaces:setCurrent',
  'workspaces:suggest',
  'workspaces:taskProjects',
  'workspaces:taskProjectsMany',
  'workspaces:setTaskProjects',
  'workspaces:syncStatus',
  'workspaces:syncNow',
  'workspaces:resolve',
  'workspaces:hostTools',
  'workspaces:learnConnections',
  'workspaces:connectionsLearningStatus',
  'workspaces:createRemote',
  'workspaces:setRemote',
  'workspaces:unsetRemote',
  'settings:shouldAskTelemetry',
  'settings:recordTelemetryAsk',
  'settings:setTelemetryConsent',
  'settings:getModelRouting',
  'settings:setModelRouting',
  'settings:checkRuntimeAuth',
  'settings:installRuntime',
  'settings:startRuntimeLogin',
  'settings:cancelRuntimeLogin',
  'settings:signOutRuntime',
  'settings:getRuntimeModels',
  'settings:setRuntimeModels',
  'settings:setModelContext',
  'settings:getDefaultProvider',
  'settings:setDefaultProvider',
  'settings:getProjectProvider',
  'settings:getWorktreeDefaults',
  'settings:setWorktreeDefaults',
  'blueprint:read',
  'blueprint:derive',
  'blueprint:reconcile',
  'blueprint:brief',
  'blueprint:featureGraph',
  'blueprint:workspaceGraph',
  'blueprint:featureRelations',
  'blueprint:featureMap',
  'blueprint:corpusIndex',
  'blueprint:readLearning',
  'blueprint:readStory',
  'blueprint:readBasic',
  'blueprint:storyline',
  'blueprint:featurePorts',
  'plan:notes',
  'plan:setNote',
  'blueprint:features',
  'blueprint:discoverFeatures',
  'blueprint:setFeatureHome',
  'blueprint:ackDrift',
  'blueprint:driftReset',
  'blueprint:crossLinkDecide',
  'blueprint:refreshSibling',
  'blueprint:adjudicateDoc',
  'blueprint:verifyDoc',
  'blueprint:ackMustReview',
  'blueprint:reviewSummary',
  'blueprint:listInvariantVerdicts',
  'loops:read',
  'loops:activity',
  'loops:setPaused',
  'loops:setDirectivePaused',
  'loops:setDirectiveQueue',
  'loops:describe',
  'loops:setDirectiveDescription',
  'loops:approve',
  'loops:queue',
  'loops:claim',
  'loops:unclaim',
  'loops:file',
  'loops:close',
  'loops:finishHunt',
  'loops:forget',
  'loops:owner',
  'brain:query',
  'project:list',
  'project:addressableRoots',
  'project:add',
  'project:open',
  'project:pickFolder',
  'project:remove',
  'project:renamePath',
  'project:deletePath',
  'project:createPath',
  'project:revealPath',
  'project:reorderRoots',
  'project:listDir',
  'project:listAllFiles',
  'project:listCommands',
  'project:searchContent',
  'project:readFile',
  'project:writeFile',
  'project:resolveFileRef',
  'project:active',
  'project:setActive',
  'project:saveOpenFiles',
  'project:loadTabSet',
  'project:saveTabSet',
  'project:loadScopeTerminals',
  'project:editorContextFlushed',
  'project:setActiveThread',
  'project:getThreadScope',
  'project:setRootAccent',
  'project:provisionRoot',
  'accounts:list',
  'accounts:add',
  'accounts:status',
  'accounts:relogin',
  'accounts:submitLoginCode',
  'accounts:cancelLogin',
  'accounts:remove',
  'accounts:setDefault',
  'accounts:assignProject',
  'accounts:activeForProject',
  'updater:check',
  'updater:whatsNew',
  'updater:releaseNotes',
  'updater:download',
  'updater:install',
  'diagnostics:record',
  'diagnostics:report',
  'learn:answerBasicDiscovery',
  'learn:answerChatLearn',
  'learn:learnModule',
  'learn:basicDiscoveryState',
  'learn:learnFeature',
  'learn:generateFeatureView',
  'learn:status',
  'learn:log',
  'learn:pause',
  'learn:pauseRoot',
  'learn:cancel',
  'learn:reset',
  'learn:narrate',
  'learn:brainUsage',
  'learn:classifyRoles',
  'flow:listArtifacts',
  'browser:navigate',
  'browser:back',
  'browser:forward',
  'browser:reload',
  'browser:setInspect',
  'browser:capabilities',
  'browser:captureScreenshot',
  'browser:tagRecent',
  'browser:tagEntry',
  'browser:bufferSlice',
  'browser:clearCaptures',
  'debug:start',
  'debug:stop',
  'debug:status',
  'debug:interaction',
] as const satisfies readonly IpcInvokeChannel[]

export const IPC_EVENT_CHANNELS = [
  'threads:stream',
  'threads:permissionRequest',
  'threads:dialogRequest',
  'threads:dialogCancel',
  'threads:updated',
  'tasks:updated',
  'tasks:boardLoopChanged',
  'editor:diagnostics',
  'editor:pendingChangesUpdated',
  'editor:closeActiveTab',
  'editor:editAction',
  'settings:open',
  'terminal:data',
  'terminal:exit',
  'terminal:created',
  'terminal:removed',
  'git:changed',
  'threads:changeReviewUpdated',
  'threads:contextChosen',
  'threads:contextOffer',
  'flow:notification',
  'flow:stateChanged',
  'flow:artifactChanged',
  'flow:chainChanged',
  'blueprint:changed',
  'project:fileChanged',
  'project:listChanged',
  'project:activeChanged',
  'project:threadScopeChanged',
  'accounts:changed',
  'accounts:loginEvent',
  'settings:runtimeLoginEvent',
  'auth:changed',
  'workspaces:changed',
  'workspaces:connectionsLearning',
  'workspaces:syncChanged',
  'updater:status',
  'learn:basicDiscoveryAsk',
  'learn:chatLearnAsk',
  'learn:progress',
  'learn:pausedChanged',
  'learn:featureLearned',
  'learn:featureParts',
  'learn:featureReadProgress',
  'learn:featureViewed',
  'learn:classifyRolesProgress',
  'learn:featuresDiscovered',
  'learn:basicDiscoveryChanged',
  'blueprint:invariantVerdicts',
  'project:flushEditorContext',
  'browser:bufferUpdated',
  'browser:tagPosted',
] as const satisfies readonly IpcEventChannel[]

/** Compile-time exhaustiveness: errors if a map key is missing from its array. */
type AssertNever<T extends never> = T
export type _InvokeChannelsExhaustive = AssertNever<
  Exclude<IpcInvokeChannel, (typeof IPC_INVOKE_CHANNELS)[number]>
>
export type _EventChannelsExhaustive = AssertNever<
  Exclude<IpcEventChannel, (typeof IPC_EVENT_CHANNELS)[number]>
>

// ═══════════════════════════════════════════════════════════════════════
// Renderer-facing bridge shape (implemented by src/preload/index.ts)
// ═══════════════════════════════════════════════════════════════════════

export interface FlowThreadsApi {
  list(request: IpcRequest<'threads:list'>): Promise<IpcResponse<'threads:list'>>
  /** Promoted sub-agent child threads of a parent (#1931). Optional so an older
   *  preload degrades to "no children" rather than throwing. */
  children?(request: IpcRequest<'threads:children'>): Promise<IpcResponse<'threads:children'>>
  /** Promote a sub-agent to a navigable child thread (#1931). Optional so an
   *  older preload degrades gracefully rather than throwing. */
  openSubagent?(
    request: IpcRequest<'threads:openSubagent'>,
  ): Promise<IpcResponse<'threads:openSubagent'>>

  get(request: IpcRequest<'threads:get'>): Promise<IpcResponse<'threads:get'>>
  /** Live background work per thread, for a surface mounting mid-run. Optional
   *  so an older preload degrades to "nothing running yet" — the stream still
   *  brings the next change — rather than throwing at whoever asked. */
  backgroundTasks?(
    request: IpcRequest<'threads:backgroundTasks'>,
  ): Promise<IpcResponse<'threads:backgroundTasks'>>
  create(request: IpcRequest<'threads:create'>): Promise<IpcResponse<'threads:create'>>
  /** Could a worktree take this branch name? Read-only — see the channel. */
  branchAvailable(
    request: IpcRequest<'threads:branchAvailable'>,
  ): Promise<IpcResponse<'threads:branchAvailable'>>
  update(request: IpcRequest<'threads:update'>): Promise<IpcResponse<'threads:update'>>
  setRoots(request: IpcRequest<'threads:setRoots'>): Promise<IpcResponse<'threads:setRoots'>>
  /** The held first message's state, or null (see the channel). */
  learningFirst?(request: IpcRequest<'threads:learningFirst'>): Promise<IpcResponse<'threads:learningFirst'>>
  /** Try again on a held first message whose project could not be learned. */
  retryLearningFirst?(request: IpcRequest<'threads:retryLearningFirst'>): Promise<void>
  prepareWorktree(
    request: IpcRequest<'threads:prepareWorktree'>,
  ): Promise<IpcResponse<'threads:prepareWorktree'>>
  worktreeBranches(
    request: IpcRequest<'threads:worktreeBranches'>,
  ): Promise<IpcResponse<'threads:worktreeBranches'>>
  retargetWorktree(
    request: IpcRequest<'threads:retargetWorktree'>,
  ): Promise<IpcResponse<'threads:retargetWorktree'>>
  landingPreview(
    request: IpcRequest<'threads:landingPreview'>,
  ): Promise<IpcResponse<'threads:landingPreview'>>
  landWorktree(
    request: IpcRequest<'threads:landWorktree'>,
  ): Promise<IpcResponse<'threads:landWorktree'>>
  releaseWorktree(
    request: IpcRequest<'threads:releaseWorktree'>,
  ): Promise<IpcResponse<'threads:releaseWorktree'>>
  worktreeUsage(
    request: IpcRequest<'threads:worktreeUsage'>,
  ): Promise<IpcResponse<'threads:worktreeUsage'>>
  worktreeInventory(
    request: IpcRequest<'threads:worktreeInventory'>,
  ): Promise<IpcResponse<'threads:worktreeInventory'>>
  renameWorktreeBranch(
    request: IpcRequest<'threads:renameWorktreeBranch'>,
  ): Promise<IpcResponse<'threads:renameWorktreeBranch'>>
  forgetWorktree(
    request: IpcRequest<'threads:forgetWorktree'>,
  ): Promise<IpcResponse<'threads:forgetWorktree'>>
  worktreeBinding(
    request: IpcRequest<'threads:worktreeBinding'>,
  ): Promise<IpcResponse<'threads:worktreeBinding'>>
  bindWorktree(
    request: IpcRequest<'threads:bindWorktree'>,
  ): Promise<IpcResponse<'threads:bindWorktree'>>
  delete(request: IpcRequest<'threads:delete'>): Promise<void>
  search(request: IpcRequest<'threads:search'>): Promise<IpcResponse<'threads:search'>>
  sendMessage(
    request: IpcRequest<'threads:sendMessage'>,
  ): Promise<IpcResponse<'threads:sendMessage'>>
  interrupt(request: IpcRequest<'threads:interrupt'>): Promise<void>
  setModel(request: IpcRequest<'threads:setModel'>): Promise<void>
  /** How full the thread's context window is, or null when nothing can say. */
  contextUsage(
    request: IpcRequest<'threads:contextUsage'>,
  ): Promise<IpcResponse<'threads:contextUsage'>>
  respondPermission(request: IpcRequest<'threads:respondPermission'>): Promise<void>
  pendingPermissions(
    request: IpcRequest<'threads:pendingPermissions'>,
  ): Promise<IpcResponse<'threads:pendingPermissions'>>
  pendingDialogs(
    request: IpcRequest<'threads:pendingDialogs'>,
  ): Promise<IpcResponse<'threads:pendingDialogs'>>
  respondDialog(request: IpcRequest<'threads:respondDialog'>): Promise<void>
  importClaude(
    request: IpcRequest<'threads:importClaude'>,
  ): Promise<IpcResponse<'threads:importClaude'>>
  /** Estimated tokens saved by knowledge search across one thread (the
   *  conversation pane's cumulative brain chip). */
  brainSavings(
    request: IpcRequest<'threads:brainSavings'>,
  ): Promise<IpcResponse<'threads:brainSavings'>>
  /** A sub-agent's transcript (#1931). Optional so an older preload degrades to
   *  the output-only tab rather than throwing. */
  subagentTranscript?(
    request: IpcRequest<'threads:subagentTranscript'>,
  ): Promise<IpcResponse<'threads:subagentTranscript'>>
  onStream(listener: (event: AgentStreamEvent) => void): Unsubscribe
  onPermissionRequest(listener: (request: PermissionRequest) => void): Unsubscribe
  onDialogRequest(listener: (request: UserQuestionRequest) => void): Unsubscribe
  onDialogCancel(listener: (cancel: UserDialogCancel) => void): Unsubscribe
  onUpdated(listener: (events: ThreadChangeEvent[]) => void): Unsubscribe
  /** Workspaces Phase 7 — optional: an older preload predates the channels. */
  onContextChosen?(listener: (event: IpcEventPayload<'threads:contextChosen'>) => void): Unsubscribe
  onContextOffer?(listener: (event: IpcEventPayload<'threads:contextOffer'>) => void): Unsubscribe
}

export interface FlowMessagesApi {
  list(request: IpcRequest<'messages:list'>): Promise<IpcResponse<'messages:list'>>
  append(request: IpcRequest<'messages:append'>): Promise<IpcResponse<'messages:append'>>
}

export interface FlowToolCallsApi {
  list(request: IpcRequest<'toolCalls:list'>): Promise<IpcResponse<'toolCalls:list'>>
  /** One tool call, whole — optional so an older preload degrades to "no
   *  output" rather than throwing at the card that asked for it. */
  get?(request: IpcRequest<'toolCalls:get'>): Promise<IpcResponse<'toolCalls:get'>>
}

export interface FlowEditorApi {
  hover(request: IpcRequest<'editor:hover'>): Promise<IpcResponse<'editor:hover'>>
  definition(
    request: IpcRequest<'editor:definition'>,
  ): Promise<IpcResponse<'editor:definition'>>
  completions(
    request: IpcRequest<'editor:completions'>,
  ): Promise<IpcResponse<'editor:completions'>>
  /** Document sync: push the renderer's buffer state to the language server. */
  didOpen(request: IpcRequest<'editor:didOpen'>): Promise<void>
  didChange(request: IpcRequest<'editor:didChange'>): Promise<void>
  didClose(request: IpcRequest<'editor:didClose'>): Promise<void>
  pendingChanges(
    request: IpcRequest<'editor:pendingChanges'>,
  ): Promise<IpcResponse<'editor:pendingChanges'>>
  resolveHunk(request: IpcRequest<'editor:resolveHunk'>): Promise<ResolveHunkOutcome>
  onDiagnostics(listener: (event: DiagnosticsEvent) => void): Unsubscribe
  onPendingChangesUpdated(listener: (changes: PendingFileChange[]) => void): Unsubscribe
  /** App-menu Close Tab (⌘W / Ctrl+W) — close the active editor tab (#673). */
  onCloseActiveTab(listener: () => void): Unsubscribe
  /** App-menu Edit ▸ Undo / Redo / Select All (#1338) — the renderer routes it
   *  to Monaco or to the focused plain input. */
  onEditAction?(listener: (action: 'undo' | 'redo' | 'selectAll') => void): Unsubscribe
  /** App-menu Settings… (⌘,) — #1159. */
  onOpenSettings(listener: () => void): Unsubscribe
}

export interface FlowTerminalApi {
  list(): Promise<IpcResponse<'terminal:list'>>
  create(request: IpcRequest<'terminal:create'>): Promise<IpcResponse<'terminal:create'>>
  write(request: IpcRequest<'terminal:write'>): Promise<void>
  resize(request: IpcRequest<'terminal:resize'>): Promise<void>
  dispose(request: IpcRequest<'terminal:dispose'>): Promise<void>
  /** Give an unowned user shell the scope that adopted it. */
  claim(request: IpcRequest<'terminal:claim'>): Promise<void>
  /** Record a person's name for a tab (null clears it). */
  rename(request: IpcRequest<'terminal:rename'>): Promise<void>
  onData(listener: (event: IpcEventPayload<'terminal:data'>) => void): Unsubscribe
  onExit(listener: (event: IpcEventPayload<'terminal:exit'>) => void): Unsubscribe
  onRemoved(listener: (event: IpcEventPayload<'terminal:removed'>) => void): Unsubscribe
  onCreated(listener: (terminal: TerminalInfo) => void): Unsubscribe
}

export interface FlowGitApi {
  renameBranch(
    request: IpcRequest<'git:renameBranch'>,
  ): Promise<IpcResponse<'git:renameBranch'>>
  status(request: IpcRequest<'git:status'>): Promise<IpcResponse<'git:status'>>
  log(request: IpcRequest<'git:log'>): Promise<IpcResponse<'git:log'>>
  diff(request: IpcRequest<'git:diff'>): Promise<IpcResponse<'git:diff'>>
  listUntrackedDir(
    request: IpcRequest<'git:listUntrackedDir'>,
  ): Promise<IpcResponse<'git:listUntrackedDir'>>
  commit(request: IpcRequest<'git:commit'>): Promise<IpcResponse<'git:commit'>>
  stage(request: IpcRequest<'git:stage'>): Promise<IpcResponse<'git:stage'>>
  unstage(request: IpcRequest<'git:unstage'>): Promise<IpcResponse<'git:unstage'>>
  discardFile(request: IpcRequest<'git:discardFile'>): Promise<IpcResponse<'git:discardFile'>>
  commitIndex(request: IpcRequest<'git:commitIndex'>): Promise<IpcResponse<'git:commitIndex'>>
  publish(request: IpcRequest<'git:publish'>): Promise<IpcResponse<'git:publish'>>
  mergeState(request: IpcRequest<'git:mergeState'>): Promise<IpcResponse<'git:mergeState'>>
  readConflicted(
    request: IpcRequest<'git:readConflicted'>,
  ): Promise<IpcResponse<'git:readConflicted'>>
  resolveConflict(
    request: IpcRequest<'git:resolveConflict'>,
  ): Promise<IpcResponse<'git:resolveConflict'>>
  resolveConflictHunk(
    request: IpcRequest<'git:resolveConflictHunk'>,
  ): Promise<IpcResponse<'git:resolveConflictHunk'>>
  completeMerge(
    request: IpcRequest<'git:completeMerge'>,
  ): Promise<IpcResponse<'git:completeMerge'>>
  abortMerge(request: IpcRequest<'git:abortMerge'>): Promise<IpcResponse<'git:abortMerge'>>
  continueRebase(request: IpcRequest<'git:continueRebase'>): Promise<IpcResponse<'git:continueRebase'>>
  abortRebase(request: IpcRequest<'git:abortRebase'>): Promise<IpcResponse<'git:abortRebase'>>
  verifyMerge(request: IpcRequest<'git:verifyMerge'>): Promise<IpcResponse<'git:verifyMerge'>>
  writeMergeSummary(
    request: IpcRequest<'git:writeMergeSummary'>,
  ): Promise<IpcResponse<'git:writeMergeSummary'>>
  /** Local branch names (current branch excluded) for the "Merge branch…" picker. */
  listBranches(
    request: IpcRequest<'git:listBranches'>,
  ): Promise<IpcResponse<'git:listBranches'>>
  /** Merge a branch into the current one; a conflict outcome is not an error. */
  mergeBranch(request: IpcRequest<'git:mergeBranch'>): Promise<IpcResponse<'git:mergeBranch'>>
  /** Pull the current branch's tracked upstream; a conflict outcome is not an error. */
  pull(request: IpcRequest<'git:pull'>): Promise<IpcResponse<'git:pull'>>
  /** List every same-file agent clash in a project (conflict-UX Phase 6). */
  listAgentClashes(
    request: IpcRequest<'git:listAgentClashes'>,
  ): Promise<IpcResponse<'git:listAgentClashes'>>
  /** Open one agent clash as a synthesized 3-way conflict for the per-hunk resolver. */
  readAgentClash(
    request: IpcRequest<'git:readAgentClash'>,
  ): Promise<IpcResponse<'git:readAgentClash'>>
  /** Reconcile an agent clash by writing the resolved content to the working tree. */
  reconcileAgentClash(
    request: IpcRequest<'git:reconcileAgentClash'>,
  ): Promise<IpcResponse<'git:reconcileAgentClash'>>
  onChanged(listener: (event: IpcEventPayload<'git:changed'>) => void): Unsubscribe
  /** The Cursor-style change review for one thread's worktree (#1906). */
  changeReview(
    request: IpcRequest<'threads:changeReview'>,
  ): Promise<IpcResponse<'threads:changeReview'>>
  /** A thread's change review may have changed — refetch `changeReview`. */
  onChangeReviewUpdated(
    listener: (event: IpcEventPayload<'threads:changeReviewUpdated'>) => void,
  ): Unsubscribe
}

export interface FlowFlowApi {
  state(request: IpcRequest<'flow:state'>): Promise<IpcResponse<'flow:state'>>
  respondPrompt(request: IpcRequest<'flow:respondPrompt'>): Promise<void>
  /** Write settings into the active project's flow/.flowconfig. */
  setConfig(request: IpcRequest<'flow:setConfig'>): Promise<void>
  /** Every worktree setting in effect for a project, with provenance. */
  worktreeSettings(
    request: IpcRequest<'flow:worktreeSettings'>,
  ): Promise<IpcResponse<'flow:worktreeSettings'>>
  /** Record a board Review Mode file verdict into flow/.rounds.jsonl (#609). */
  recordVerdict(
    request: IpcRequest<'flow:recordVerdict'>,
  ): Promise<IpcResponse<'flow:recordVerdict'>>
  onNotification(listener: (notification: FlowNotification) => void): Unsubscribe
  onStateChanged(listener: (state: FlowState) => void): Unsubscribe
  /** A discovery/plan/brainstorm doc was added or changed under flow/. */
  onArtifactChanged(listener: (event: FlowArtifactChangedEvent) => void): Unsubscribe
  /** Existing flow/ artifacts for a root — seed cards on mount (watcher is
   *  ignoreInitial, so live events never cover pre-existing docs). */
  listArtifacts(request: IpcRequest<'flow:listArtifacts'>): Promise<IpcResponse<'flow:listArtifacts'>>
  /** Start / end / read a conversation's autopilot chain. Reading starts nothing. */
  chain(request: IpcRequest<'flow:chain'>): Promise<IpcResponse<'flow:chain'>>
  /** A conversation's chain started, moved a step, or ended. */
  onChainChanged(listener: (state: ChainState) => void): Unsubscribe
}

export interface FlowSettingsApi {
  /** Read app-wide onboarding + autonomy state. */
  getOnboarding(): Promise<IpcResponse<'settings:getOnboarding'>>
  /** Partial update of app-wide settings (onboarding completion / autonomy default). */
  setOnboarding(request: IpcRequest<'settings:setOnboarding'>): Promise<void>
  /** Has this person agreed to share usage data? `null` = never asked. */
  getTelemetryConsent(): Promise<IpcResponse<'settings:getTelemetryConsent'>>
  whoAmI(): Promise<IpcResponse<'auth:whoAmI'>>
  authAvailable(): Promise<IpcResponse<'auth:available'>>
  signIn(): Promise<IpcResponse<'auth:signIn'>>
  signOut(): Promise<IpcResponse<'auth:signOut'>>
  /** Flow's sign-in changed anywhere in the app. Optional: an older preload has no event. */
  onAuthChanged?(listener: (change: IpcEventPayload<'auth:changed'>) => void): Unsubscribe
  shouldAskTelemetry(): Promise<IpcResponse<'settings:shouldAskTelemetry'>>
  recordTelemetryAsk(): Promise<void>
  setTelemetryConsent(request: IpcRequest<'settings:setTelemetryConsent'>): Promise<void>
  /** Read the Auto effort→model routing map (#129). */
  getModelRouting(): Promise<IpcResponse<'settings:getModelRouting'>>
  /** Save the Auto effort→model routing map (#129). */
  setModelRouting(request: IpcRequest<'settings:setModelRouting'>): Promise<void>
  /** Read the app-wide default runtime provider (multi_runtime_support). */
  /** Is a runtime signed in? Optional — an older preload degrades to "cannot
   *  check", which the settings UI treats as a reason to refuse the switch. */
  checkRuntimeAuth?(
    request: IpcRequest<'settings:checkRuntimeAuth'>,
  ): Promise<IpcResponse<'settings:checkRuntimeAuth'>>
  /** Install a runtime's CLI. Optional for the same reason as the check above:
   *  an older preload simply has no install button. */
  installRuntime?(
    request: IpcRequest<'settings:installRuntime'>,
  ): Promise<IpcResponse<'settings:installRuntime'>>
  /** Start an in-app sign-in for an external runtime. Optional: an older
   *  preload has no assist and the refusal simply offers no sign-in button. */
  startRuntimeLogin?(
    request: IpcRequest<'settings:startRuntimeLogin'>,
  ): Promise<IpcResponse<'settings:startRuntimeLogin'>>
  cancelRuntimeLogin?(): Promise<void>
  /** Sign out of an external runtime (Codex today — see runtime-logout.ts). */
  signOutRuntime?(
    request: IpcRequest<'settings:signOutRuntime'>,
  ): Promise<IpcResponse<'settings:signOutRuntime'>>
  /** The models this runtime can be asked for (configured + user-added). */
  getRuntimeModels?(
    request: IpcRequest<'settings:getRuntimeModels'>,
  ): Promise<IpcResponse<'settings:getRuntimeModels'>>
  setRuntimeModels?(request: IpcRequest<'settings:setRuntimeModels'>): Promise<void>
  /** Save the context-window choice for one model (#1929). */
  setModelContext?(request: IpcRequest<'settings:setModelContext'>): Promise<void>
  /** Progress of the in-flight runtime sign-in (URL, code, status, outcome). */
  onRuntimeLoginEvent?(listener: (event: RuntimeLoginProgress) => void): () => void
  getDefaultProvider(): Promise<IpcResponse<'settings:getDefaultProvider'>>
  /** Save the app-wide default runtime provider. */
  setDefaultProvider(request: IpcRequest<'settings:setDefaultProvider'>): Promise<void>
  /** The provider a specific project resolves to, and which rung answered.
   *  Optional: an older preload has no project-provider read, and the panel
   *  simply skips its pinned/inherited caption. */
  getProjectProvider?(
    request: IpcRequest<'settings:getProjectProvider'>,
  ): Promise<IpcResponse<'settings:getProjectProvider'>>
  /** The person's app-wide worktree defaults. Optional: an older preload has
   *  no defaults panel, and the project settings simply resolve without them. */
  getWorktreeDefaults?(): Promise<IpcResponse<'settings:getWorktreeDefaults'>>
  /** Set or unset worktree defaults; `null` puts a setting back to inherited. */
  setWorktreeDefaults?(
    request: IpcRequest<'settings:setWorktreeDefaults'>,
  ): Promise<IpcResponse<'settings:setWorktreeDefaults'>>
}

/**
 * The brain (#52), as the renderer sees it.
 *
 * READ ONLY, DELIBERATELY. `brain:capture` is a main-process concern — the
 * turn-complete hook (`makeBrainCaptureOnTurnComplete`) owns every write to the
 * store, and exposing a second writer to the renderer would put the tier
 * boundary (`.raw/` is never indexed or surfaced) behind two code paths instead
 * of one. The renderer asks questions; it does not answer them.
 */
export interface FlowBrainApi {
  /** Search the trusted brain tiers. The feature map's title strip is the
   *  first caller. */
  query(request: IpcRequest<'brain:query'>): Promise<IpcResponse<'brain:query'>>
}

/**
 * Agent loops (agent-loops, Phase 7; the board's two added by
 * loops-on-the-board, Phase 4). Every call is the bundled CLI: read the state,
 * read the queue, change whether a loop runs, clear an approval gate, claim an
 * item. The app holds no queue store of its own to read or write.
 *
 * OPTIONAL on the bridge, like `discoverFeatures` above — an older preload
 * predates the channels, and the panel must degrade to a notice rather than
 * throw on `window.flow.loops.read is not a function`. `queue` and `claim` are
 * OPTIONAL METHODS for the same reason, one version later: a board running
 * against a preload that predates them must render a notice, not a stack.
 */
export interface FlowLoopsApi {
  /** Every loop's directive facts, read from disk (fail-soft). */
  read(request: IpcRequest<'loops:read'>): Promise<IpcResponse<'loops:read'>>
  /**
   * The counts, the hunts, the runs in flight and the stuck claims.
   *
   * OPTIONAL, on the same rule as `queue` below: a renderer running against a
   * preload that predates the channel shows the directive facts alone rather
   * than throwing on `window.flow.loops.activity is not a function`.
   */
  activity?(request: IpcRequest<'loops:activity'>): Promise<IpcResponse<'loops:activity'>>
  /** Pause or resume one loop (empty `loop` = the global pause). */
  setPaused(request: IpcRequest<'loops:setPaused'>): Promise<IpcResponse<'loops:setPaused'>>
  /**
   * Switch one loop on or off in its directive — the durable, committed answer
   * to "should this loop run at all", as opposed to `setPaused`'s "not now".
   *
   * OPTIONAL, on the same rule as `queue` and `claim` below: a renderer running
   * against a preload that predates the channel must degrade to a notice rather
   * than throw on `window.flow.loops.setDirectivePaused is not a function`.
   */
  setDirectivePaused?(
    request: IpcRequest<'loops:setDirectivePaused'>,
  ): Promise<IpcResponse<'loops:setDirectivePaused'>>
  /**
   * Point one loop at the list its work comes from — its committed answer to
   * "where does this loop get its work", as opposed to whether it runs at all.
   *
   * OPTIONAL, on the same rule as its sibling above: a renderer running against
   * an older preload must degrade to a notice rather than throw.
   */
  setDirectiveQueue?(
    request: IpcRequest<'loops:setDirectiveQueue'>,
  ): Promise<IpcResponse<'loops:setDirectiveQueue'>>
  /**
   * Say what one loop is told — its direction, its rules, the count it stops on.
   *
   * OPTIONAL, on the same rule as its siblings above: a renderer running against
   * an older preload must degrade to a notice rather than throw.
   */
  setDirectiveDescription?(
    request: IpcRequest<'loops:setDirectiveDescription'>,
  ): Promise<IpcResponse<'loops:setDirectiveDescription'>>
  /**
   * What one loop is currently told. Optional, on the same rule as its siblings.
   */
  describe?(request: IpcRequest<'loops:describe'>): Promise<IpcResponse<'loops:describe'>>
  /** Clear one queue item's approval gate. */
  approve(request: IpcRequest<'loops:approve'>): Promise<IpcResponse<'loops:approve'>>
  /** `loop list` — the queue's items, for the board. Reading writes nothing. */
  queue?(request: IpcRequest<'loops:queue'>): Promise<IpcResponse<'loops:queue'>>
  /** `loop claim` — take an item. The same write a loop performs. */
  claim?(request: IpcRequest<'loops:claim'>): Promise<IpcResponse<'loops:claim'>>
  /** `loop unclaim` — give a claimed item back. The claim's other half. */
  unclaim?(request: IpcRequest<'loops:unclaim'>): Promise<IpcResponse<'loops:unclaim'>>
  /** `loop file` — put one card's work on the shared list. A person's press only. */
  file?(request: IpcRequest<'loops:file'>): Promise<IpcResponse<'loops:file'>>
  /** `loop close` — settle an item nobody wants done, with the reason why. */
  close?(request: IpcRequest<'loops:close'>): Promise<IpcResponse<'loops:close'>>
  /** `loop finish` — a person says one hunt is done; it stays, marked stopped. */
  finishHunt?(request: IpcRequest<'loops:finishHunt'>): Promise<IpcResponse<'loops:finishHunt'>>
  /** `loop forget` — end a standing hunt, or all of them. */
  forget?(request: IpcRequest<'loops:forget'>): Promise<IpcResponse<'loops:forget'>>
  /** The word this installation claims under (minted once, kept forever). */
  owner?(request: IpcRequest<'loops:owner'>): Promise<IpcResponse<'loops:owner'>>
}

export interface FlowBlueprintApi {
  read(request: IpcRequest<'blueprint:read'>): Promise<IpcResponse<'blueprint:read'>>
  /** Derive (regenerate) a root's blueprint — main resolves + spawns the CLI. */
  derive(request: IpcRequest<'blueprint:derive'>): Promise<IpcResponse<'blueprint:derive'>>
  /** Live change-simulation reconciliation for a plan (bundled CLI --json). */
  reconcile(
    request: IpcRequest<'blueprint:reconcile'>,
  ): Promise<IpcResponse<'blueprint:reconcile'>>
  /** The feature graph for the board's default view (fail-soft). */
  featureGraph(
    request: IpcRequest<'blueprint:featureGraph'>,
  ): Promise<IpcResponse<'blueprint:featureGraph'>>
  /** The Workspace map for the board's root level (fail-soft). Optional: an
   *  older preload predates it, and the board then draws the project alone. */
  workspaceGraph?(
    request: IpcRequest<'blueprint:workspaceGraph'>,
  ): Promise<IpcResponse<'blueprint:workspaceGraph'>>
  /** One feature's file/import graph (#1533) — fail-soft.
   *  Optional like `discoverFeatures`: an older preload predates the channel,
   *  and the surface must degrade to its empty state rather than throw. */
  featureMap?(
    request: IpcRequest<'blueprint:featureMap'>,
  ): Promise<IpcResponse<'blueprint:featureMap'>>
  /** One feature's recorded couplings, with the store's own words.
   *  Optional for the same reason as its siblings: an older preload predates
   *  the channel, and the panel must say it could not read rather than throw. */
  featureRelations?(
    request: IpcRequest<'blueprint:featureRelations'>,
  ): Promise<IpcResponse<'blueprint:featureRelations'>>
  /** Populate an empty feature store — discover + confirm (#1307). */
  discoverFeatures?(
    request: IpcRequest<'blueprint:discoverFeatures'>,
  ): Promise<IpcResponse<'blueprint:discoverFeatures'>>
  /** Pin or clear a feature's home folder (plan feature-home-folders).
   *  Optional like its siblings: an older preload predates the channel. */
  setFeatureHome?(
    request: IpcRequest<'blueprint:setFeatureHome'>,
  ): Promise<IpcResponse<'blueprint:setFeatureHome'>>
  /** The persisted corpus index — plain file read, fail-soft (#1532).
   *  Optional like `discoverFeatures`: an older preload predates the channel,
   *  and the view must degrade to its empty state rather than throw. */
  corpusIndex?(
    request: IpcRequest<'blueprint:corpusIndex'>,
  ): Promise<IpcResponse<'blueprint:corpusIndex'>>
  /** The change-brief delta for a plan (fail-soft; never blocks a board read). */
  brief(
    request: IpcRequest<'blueprint:brief'>,
  ): Promise<IpcResponse<'blueprint:brief'>>
  /** The in-memory basic fallback graph (used after a failed full derive). */
  readBasic(
    request: IpcRequest<'blueprint:readBasic'>,
  ): Promise<IpcResponse<'blueprint:readBasic'>>
  /** Just the learning rows (see the channel's note). Optional: an older
   *  preload simply falls back to the full read. */
  readLearning?(
    request: IpcRequest<'blueprint:readLearning'>,
  ): Promise<IpcResponse<'blueprint:readLearning'>>
  /** Just the compiled story (see the channel's note). Optional for the same
   *  reason: an older preload falls back to the full read. */
  readStory?(
    request: IpcRequest<'blueprint:readStory'>,
  ): Promise<IpcResponse<'blueprint:readStory'>>
  /** A file or a part read as a storyline (see the channel's note). */
  storyline(
    request: IpcRequest<'blueprint:storyline'>,
  ): Promise<IpcResponse<'blueprint:storyline'>>
  /** What connects to a feature's diagram (see the channel's note). */
  featurePorts(
    request: IpcRequest<'blueprint:featurePorts'>,
  ): Promise<IpcResponse<'blueprint:featurePorts'>>
  /** "What was implemented" — feature/phase/file view from the plan files. */
  features(
    request: IpcRequest<'blueprint:features'>,
  ): Promise<IpcResponse<'blueprint:features'>>
  /** Record a human ack of a specific drift — precious, append-only. */
  ackDrift(
    request: IpcRequest<'blueprint:ackDrift'>,
  ): Promise<IpcResponse<'blueprint:ackDrift'>>
  /** Mark everything reviewed — re-establish the drift baseline to the current tree. */
  driftReset(
    request: IpcRequest<'blueprint:driftReset'>,
  ): Promise<IpcResponse<'blueprint:driftReset'>>
  /** Confirm/reject a proposed cross-link via the CLI verbs. */
  crossLinkDecide(
    request: IpcRequest<'blueprint:crossLinkDecide'>,
  ): Promise<IpcResponse<'blueprint:crossLinkDecide'>>
  /** Re-derive a linked sibling in the background, then rematch. */
  refreshSibling(
    request: IpcRequest<'blueprint:refreshSibling'>,
  ): Promise<IpcResponse<'blueprint:refreshSibling'>>
  /** Manually adjudicate one claim doc (trust / distrust) via the CLI verb. */
  adjudicateDoc(
    request: IpcRequest<'blueprint:adjudicateDoc'>,
  ): Promise<IpcResponse<'blueprint:adjudicateDoc'>>
  verifyDoc(request: IpcRequest<'blueprint:verifyDoc'>): Promise<IpcResponse<'blueprint:verifyDoc'>>
  /** Durably acknowledge must-review items (titles) — they never resurface. */
  ackMustReview(
    request: IpcRequest<'blueprint:ackMustReview'>,
  ): Promise<IpcResponse<'blueprint:ackMustReview'>>
  /** Generate + persist a must-review markdown summary; returns the doc path. */
  reviewSummary(
    request: IpcRequest<'blueprint:reviewSummary'>,
  ): Promise<IpcResponse<'blueprint:reviewSummary'>>
  /** Latest invariant-checker pass for a root (nulls before the first pass). */
  listInvariantVerdicts(
    request: IpcRequest<'blueprint:listInvariantVerdicts'>,
  ): Promise<IpcResponse<'blueprint:listInvariantVerdicts'>>
  onChanged(listener: (event: IpcEventPayload<'blueprint:changed'>) => void): Unsubscribe
  /** Advisory invariant verdicts pushed as checker passes complete (#898). */
  onInvariantVerdicts(
    listener: (event: IpcEventPayload<'blueprint:invariantVerdicts'>) => void,
  ): Unsubscribe
}

export interface FlowProjectApi {
  list(): Promise<IpcResponse<'project:list'>>
  /** Every root the renderer may address — projects AND thread checkouts,
   *  innermost first. Ask this, not `list()`, when mapping an absolute path
   *  to the root that contains it. */
  addressableRoots(): Promise<IpcResponse<'project:addressableRoots'>>
  add(request: IpcRequest<'project:add'>): Promise<IpcResponse<'project:add'>>
  /** Open a native folder picker, add the chosen dir as a root and enter it
   *  (#1008). `request.path` skips the picker for an already-resolved pick. */
  open(
    request?: IpcRequest<'project:open'>,
  ): Promise<IpcResponse<'project:open'>>
  pickFolder(): Promise<IpcResponse<'project:pickFolder'>>
  remove(request: IpcRequest<'project:remove'>): Promise<void>
  renamePath(request: IpcRequest<'project:renamePath'>): Promise<void>
  deletePath(request: IpcRequest<'project:deletePath'>): Promise<void>
  createPath(request: IpcRequest<'project:createPath'>): Promise<void>
  /** Show the path in Finder/Explorer (#1063). */
  revealPath(request: IpcRequest<'project:revealPath'>): Promise<void>
  /** Reorder the project roots (index in orderedPaths = new position). */
  reorderRoots(
    request: IpcRequest<'project:reorderRoots'>,
  ): Promise<IpcResponse<'project:reorderRoots'>>
  listDir(request: IpcRequest<'project:listDir'>): Promise<IpcResponse<'project:listDir'>>
  listAllFiles(
    request: IpcRequest<'project:listAllFiles'>,
  ): Promise<IpcResponse<'project:listAllFiles'>>
  listCommands(
    request: IpcRequest<'project:listCommands'>,
  ): Promise<IpcResponse<'project:listCommands'>>
  searchContent(
    request: IpcRequest<'project:searchContent'>,
  ): Promise<IpcResponse<'project:searchContent'>>
  readFile(
    request: IpcRequest<'project:readFile'>,
  ): Promise<IpcResponse<'project:readFile'>>
  writeFile(request: IpcRequest<'project:writeFile'>): Promise<void>
  resolveFileRef(
    request: IpcRequest<'project:resolveFileRef'>,
  ): Promise<IpcResponse<'project:resolveFileRef'>>
  /** The current active project's context (null before any is set). */
  active(): Promise<IpcResponse<'project:active'>>
  /** Switch the active project; resolves to its restored context. */
  setActive(
    request: IpcRequest<'project:setActive'>,
  ): Promise<IpcResponse<'project:setActive'>>
  /** Persist the active project's open editor tabs. */
  saveOpenFiles(request: IpcRequest<'project:saveOpenFiles'>): Promise<void>
  /** One conversation's tab set — `threadId: null` is the project-level set. */
  loadTabSet(request: IpcRequest<'project:loadTabSet'>): Promise<IpcResponse<'project:loadTabSet'>>
  /** Persist one conversation's tab set. */
  saveTabSet(request: IpcRequest<'project:saveTabSet'>): Promise<void>
  /** The shells one scope had open — `threadId: null` is the project view. */
  loadScopeTerminals(
    request: IpcRequest<'project:loadScopeTerminals'>,
  ): Promise<IpcResponse<'project:loadScopeTerminals'>>
  /** Ack for onFlushEditorContext (#1443). */
  editorContextFlushed(): Promise<void>
  /** Main is about to tear down for quit — persist editor state now (#1443). */
  onFlushEditorContext(listener: () => void): Unsubscribe
  /** Persist the last-active thread for a project. */
  setActiveThread(request: IpcRequest<'project:setActiveThread'>): Promise<void>
  /** The current thread scope (multi-project threads) — snapshot pair of
   *  `onThreadScopeChanged`. */
  getThreadScope(): Promise<IpcResponse<'project:getThreadScope'>>
  /** Set or clear (null = "Auto") a root's user accent color override. */
  setRootAccent(
    request: IpcRequest<'project:setRootAccent'>,
  ): Promise<IpcResponse<'project:setRootAccent'>>
  /** Force re-provision a root now (settings surface's "Re-provision now" action). */
  provisionRoot(request: IpcRequest<'project:provisionRoot'>): Promise<void>
  onFileChanged(listener: (event: ProjectFilesChangedEvent) => void): Unsubscribe
  onListChanged(listener: (roots: RegisteredProject[]) => void): Unsubscribe
  onActiveChanged(listener: (context: ProjectContext | null) => void): Unsubscribe
  /** The derived thread scope changed (multi-project threads). */
  onThreadScopeChanged(listener: (scope: ThreadScope) => void): Unsubscribe
}

/** The complete bridge exposed on `window.flow`. */
export interface FlowAccountsApi {
  list(): Promise<IpcResponse<'accounts:list'>>
  /** Add + log in a new account (blocks on the interactive browser sign-in). */
  add(request: IpcRequest<'accounts:add'>): Promise<IpcResponse<'accounts:add'>>
  remove(request: IpcRequest<'accounts:remove'>): Promise<void>
  status(request: IpcRequest<'accounts:status'>): Promise<IpcResponse<'accounts:status'>>
  relogin(request: IpcRequest<'accounts:relogin'>): Promise<IpcResponse<'accounts:relogin'>>
  /** Hand the pasted authorization code to the active login (#972). */
  submitLoginCode(
    request: IpcRequest<'accounts:submitLoginCode'>,
  ): Promise<IpcResponse<'accounts:submitLoginCode'>>
  /** Abort the active interactive login (#972). */
  cancelLogin(): Promise<IpcResponse<'accounts:cancelLogin'>>
  setDefault(request: IpcRequest<'accounts:setDefault'>): Promise<void>
  assignProject(request: IpcRequest<'accounts:assignProject'>): Promise<void>
  activeForProject(
    request: IpcRequest<'accounts:activeForProject'>,
  ): Promise<IpcResponse<'accounts:activeForProject'>>
  onChanged(listener: (event: IpcEventPayload<'accounts:changed'>) => void): Unsubscribe
  /** Interactive-login progress (#972): url fallback + awaiting-code prompt. */
  onLoginEvent(listener: (event: IpcEventPayload<'accounts:loginEvent'>) => void): Unsubscribe
}

export interface FlowReviewApi {
  list(request: IpcRequest<'review:list'>): Promise<IpcResponse<'review:list'>>
  reject(request: IpcRequest<'review:reject'>): Promise<void>
  generateCommitMessage(
    request: IpcRequest<'review:generateCommitMessage'>,
  ): Promise<IpcResponse<'review:generateCommitMessage'>>
}

export interface FlowTasksApi {
  list(request: IpcRequest<'tasks:list'>): Promise<IpcResponse<'tasks:list'>>
  create(request: IpcRequest<'tasks:create'>): Promise<IpcResponse<'tasks:create'>>
  importIssue(request: IpcRequest<'tasks:importIssue'>): Promise<IpcResponse<'tasks:importIssue'>>
  /** Record a run for an already-read queue item — no refetch, no token (FR-7). */
  createFromQueueItem(
    request: IpcRequest<'tasks:createFromQueueItem'>,
  ): Promise<IpcResponse<'tasks:createFromQueueItem'>>
  /** Change an unstarted task's projects (the card's "Change"). */
  setProjects(request: IpcRequest<'tasks:setProjects'>): Promise<IpcResponse<'tasks:setProjects'>>
  update(request: IpcRequest<'tasks:update'>): Promise<IpcResponse<'tasks:update'>>
  /** Merge a Review card's pull request, advancing it to Done on success. */
  mergePr(request: IpcRequest<'tasks:mergePr'>): Promise<IpcResponse<'tasks:mergePr'>>
  delete(request: IpcRequest<'tasks:delete'>): Promise<void>
  generateBrief(
    request: IpcRequest<'tasks:generateBrief'>,
  ): Promise<IpcResponse<'tasks:generateBrief'>>
  /** Attach a fresh thread to a task whose chat was deleted (#1061); a no-op for
   *  a task whose thread is intact. */
  ensureThread(
    request: IpcRequest<'tasks:ensureThread'>,
  ): Promise<IpcResponse<'tasks:ensureThread'>>
  /** Start / stop / read the board's own loop. */
  boardLoop(request: IpcRequest<'tasks:boardLoop'>): Promise<IpcResponse<'tasks:boardLoop'>>
  onUpdated(listener: (events: TaskChangeEvent[]) => void): Unsubscribe
  onBoardLoopChanged(listener: (state: BoardLoopState) => void): Unsubscribe
}

export interface FlowIntegrationsApi {
  setToken(request: IpcRequest<'integrations:setToken'>): Promise<void>
  status(request: IpcRequest<'integrations:status'>): Promise<IpcResponse<'integrations:status'>>
  clearToken(request: IpcRequest<'integrations:clearToken'>): Promise<void>
  assigned(
    request: IpcRequest<'integrations:assigned'>,
  ): Promise<IpcResponse<'integrations:assigned'>>
  getListConfig(
    request: IpcRequest<'integrations:getListConfig'>,
  ): Promise<IpcResponse<'integrations:getListConfig'>>
  setListConfig(
    request: IpcRequest<'integrations:setListConfig'>,
  ): Promise<IpcResponse<'integrations:setListConfig'>>
  getCloseOnDone(
    request: IpcRequest<'integrations:getCloseOnDone'>,
  ): Promise<IpcResponse<'integrations:getCloseOnDone'>>
  setCloseOnDone(
    request: IpcRequest<'integrations:setCloseOnDone'>,
  ): Promise<IpcResponse<'integrations:setCloseOnDone'>>
  previewList(
    request: IpcRequest<'integrations:previewList'>,
  ): Promise<IpcResponse<'integrations:previewList'>>
  imageData(
    request: IpcRequest<'integrations:imageData'>,
  ): Promise<IpcResponse<'integrations:imageData'>>
}

/** Image attachments on user messages (#456). */
export interface FlowAttachmentsApi {
  read(request: IpcRequest<'attachments:read'>): Promise<IpcResponse<'attachments:read'>>
  revealPath(request: IpcRequest<'attachments:revealPath'>): Promise<void>
  captureScreen(
    request: IpcRequest<'attachments:captureScreen'>,
  ): Promise<IpcResponse<'attachments:captureScreen'>>
  /** Absolute path of a dragged-in File (#1339). Empty when it isn't an OS
   *  file. Optional: an older preload simply can't route OS drops. */
  pathFor?(file: File): string
}

/** Progressive-learning bridge (#513 phase 2). */
export interface FlowLearnApi {
  /** Answer the basic-discovery onboarding ask for a root ('yes' also requests
   *  the discovery; the Settings action re-fires with 'yes'). */
  answerBasicDiscovery(request: IpcRequest<'learn:answerBasicDiscovery'>): Promise<void>
  /** Answer the chat-learn ask ('yes' learns the area and re-levels the store). */
  answerChatLearn(request: IpcRequest<'learn:answerChatLearn'>): Promise<void>
  /** Learn (or re-learn) a single module — the board's "Learn"/"Re-learn" action. */
  learnModule(request: IpcRequest<'learn:learnModule'>): Promise<void>
  learnFeature(request: IpcRequest<'learn:learnFeature'>): Promise<void>
  generateFeatureView(request: IpcRequest<'learn:generateFeatureView'>): Promise<void>
  /** Pause/resume the global learn drain (the Learning panel's Pause button). */
  /** What the learner is doing right now — asked, never inferred from the
   *  learning-state file (see the channel's note). */
  status?(): Promise<IpcResponse<'learn:status'>>
  /** Recent learner activity for the panel's log (see the channel's note). */
  log?(): Promise<IpcResponse<'learn:log'>>
  pause(request: IpcRequest<'learn:pause'>): Promise<IpcResponse<'learn:pause'>>
  pauseRoot(request: IpcRequest<'learn:pauseRoot'>): Promise<IpcResponse<'learn:pauseRoot'>>
  /** Stop a root's learning — abort active + drop queue; entries flip stale. */
  cancel(request: IpcRequest<'learn:cancel'>): Promise<IpcResponse<'learn:cancel'>>
  /** Wipe a root's learning-state — all modules read never-learned again. */
  reset(request: IpcRequest<'learn:reset'>): Promise<IpcResponse<'learn:reset'>>
  /** Compile a doc's `## Story` section via the bundled CLI's `blueprint narrate`. */
  narrate(request: IpcRequest<'learn:narrate'>): Promise<IpcResponse<'learn:narrate'>>
  /** Cumulative brain-retrieval counters for a root (zeros when never counted). */
  brainUsage(request: IpcRequest<'learn:brainUsage'>): Promise<IpcResponse<'learn:brainUsage'>>
  /** Run (or, with `stop`, stop) the one-time role classify pass. Optional: an older preload lacks it. */
  classifyRoles?(request: IpcRequest<'learn:classifyRoles'>): Promise<IpcResponse<'learn:classifyRoles'>>
  /** Follow the classify pass batch by batch. */
  onClassifyRolesProgress?(
    listener: (event: IpcEventPayload<'learn:classifyRolesProgress'>) => void,
  ): () => void
  /** Show the one-time basic-discovery ask when main requests it for a root. */
  onBasicDiscoveryAsk(
    listener: (event: IpcEventPayload<'learn:basicDiscoveryAsk'>) => void,
  ): Unsubscribe
  /** Show the chat-learn ask when a conversation worked in an unlearned area. */
  onChatLearnAsk(listener: (event: IpcEventPayload<'learn:chatLearnAsk'>) => void): Unsubscribe
  /** Subscribe to live learn-progress ticks (throttled per module in main). */
  onProgress(listener: (event: IpcEventPayload<'learn:progress'>) => void): Unsubscribe
  /** Subscribe to global pause-state flips (drives the Pause/Resume label). */
  onPausedChanged(
    listener: (event: IpcEventPayload<'learn:pausedChanged'>) => void,
  ): () => void
  onFeatureLearned(
    listener: (event: IpcEventPayload<'learn:featureLearned'>) => void,
  ): () => void
  onFeatureViewed(
    listener: (event: IpcEventPayload<'learn:featureViewed'>) => void,
  ): Unsubscribe
  /**
   * The PARTS half of an understand pass landed — see `understandFeature`.
   *
   * This is a SECOND, LATER signal than `learn:featureViewed`, and the two are
   * not interchangeable. The pass is `drawFeatureView` THEN `learnFeatureParts`,
   * so the viewed event fires at the one moment a feature's parts are
   * guaranteed to be absent from disk. A board that refreshed only on it read
   * the store too early and showed an empty ring until the app was restarted.
   *
   * It fires REPEATEDLY: once when the parts are first written (`learned: 0`)
   * and again after each part is learned, so a listener sees the ring fill in
   * rather than appear all at once.
   */
  onFeatureParts(
    listener: (event: IpcEventPayload<'learn:featureParts'>) => void,
  ): Unsubscribe
  /** How far a feature pass has got through its ranked files — see the channel. */
  onFeatureReadProgress(
    listener: (event: IpcEventPayload<'learn:featureReadProgress'>) => void,
  ): Unsubscribe
  /** Basic discovery's feature-generation step settled — see the channel. */
  /** Where these projects stand on their basic discovery. */
  basicDiscoveryState?(request: IpcRequest<'learn:basicDiscoveryState'>): Promise<IpcResponse<'learn:basicDiscoveryState'>>
  /** A project's basic-discovery status changed. */
  onBasicDiscoveryChanged?(listener: (event: IpcEventPayload<'learn:basicDiscoveryChanged'>) => void): Unsubscribe
  onFeaturesDiscovered(
    listener: (event: IpcEventPayload<'learn:featuresDiscovered'>) => void,
  ): Unsubscribe
}

/** Performance evidence, recorded from wherever it was observed. */
export interface FlowDiagnosticsApi {
  /** Append lines to the shared performance log (fire-and-forget). */
  record(request: IpcRequest<'diagnostics:record'>): Promise<void>
  /** Read the log's tail — what a person copies when reporting slowness. */
  report(): Promise<IpcResponse<'diagnostics:report'>>
  /** Channels whose answer has not arrived yet, longest-waiting first, as
   *  `channel 820ms` strings. Not IPC — the preload knows this because it is
   *  the one waiting. It turns "the renderer froze" into "the renderer froze
   *  while waiting for project:listAllFiles". */
  inFlight(): string[]
}

export interface FlowUpdaterApi {
  /** Poll for a newer version; resolves to the resulting status. */
  check(): Promise<IpcResponse<'updater:check'>>
  /** Post-update detection (one-shot) + release-notes repo coordinates. */
  whatsNew(): Promise<IpcResponse<'updater:whatsNew'>>
  /** Fetch a release's notes body via main (null on any failure). */
  releaseNotes(
    request: IpcRequest<'updater:releaseNotes'>,
  ): Promise<IpcResponse<'updater:releaseNotes'>>
  /** Download the available update in the background (progress via onStatus). */
  download(): Promise<void>
  /** Quit and relaunch into a downloaded update. */
  install(): Promise<void>
  /** Subscribe to the auto-update lifecycle (drives the banner). */
  onStatus(listener: (status: IpcEventPayload<'updater:status'>) => void): Unsubscribe
}

/** Embedded-browser bridge — the `<webview>` browser tab. Optional: an older
 *  preload predates the channels, so the browser tab degrades to unavailable
 *  rather than throwing. */
/**
 * The debug session, from the renderer's side.
 *
 * Three calls and no event: the status bar asks while a session is live (which
 * is also when a session that has outlived its ceiling stops itself), and asks
 * nothing at all when none is. A broadcast would push a message per record.
 */
export interface FlowDebugApi {
  start(request: IpcRequest<'debug:start'>): Promise<IpcResponse<'debug:start'>>
  interaction(request: IpcRequest<'debug:interaction'>): Promise<IpcResponse<'debug:interaction'>>
  stop(request: IpcRequest<'debug:stop'>): Promise<IpcResponse<'debug:stop'>>
  status(request: IpcRequest<'debug:status'>): Promise<IpcResponse<'debug:status'>>
}

export interface FlowBrowserApi {
  navigate(request: IpcRequest<'browser:navigate'>): Promise<void>
  back(request: IpcRequest<'browser:back'>): Promise<void>
  forward(request: IpcRequest<'browser:forward'>): Promise<void>
  reload(request: IpcRequest<'browser:reload'>): Promise<void>
  setInspect(request: IpcRequest<'browser:setInspect'>): Promise<void>
  capabilities(
    request: IpcRequest<'browser:capabilities'>,
  ): Promise<IpcResponse<'browser:capabilities'>>
  captureScreenshot(
    request: IpcRequest<'browser:captureScreenshot'>,
  ): Promise<IpcResponse<'browser:captureScreenshot'>>
  tagRecent(request: IpcRequest<'browser:tagRecent'>): Promise<IpcResponse<'browser:tagRecent'>>
  tagEntry(request: IpcRequest<'browser:tagEntry'>): Promise<IpcResponse<'browser:tagEntry'>>
  bufferSlice(
    request: IpcRequest<'browser:bufferSlice'>,
  ): Promise<IpcResponse<'browser:bufferSlice'>>
  /** Empty the capture buffer (the browser changed conversation). */
  clearCaptures(request: IpcRequest<'browser:clearCaptures'>): Promise<void>
  /** A capture buffer's per-kind size changed — drives the tag badge. */
  onBufferUpdated(listener: (event: IpcEventPayload<'browser:bufferUpdated'>) => void): Unsubscribe
  /** A capture was tagged — the renderer turns it into a composer chip. */
  onTagPosted(listener: (event: IpcEventPayload<'browser:tagPosted'>) => void): Unsubscribe
}

/**
 * Feature view sharing — share state only, never a credential. Every call
 * answers `{ ok: true, … }` or a `ShareRefusal` carrying a plain sentence.
 */
export interface FlowShareApi {
  /** The author's share for this discovery (null when never shared) + local facts. */
  get(request: IpcRequest<'share:get'>): Promise<IpcResponse<'share:get'>>
  /** Ask the share host whether this discovery is shared — on a person's press only. */
  check(request: IpcRequest<'share:check'>): Promise<IpcResponse<'share:check'>>
  /** Publish, or publish a new version to the same link. */
  publish(request: IpcRequest<'share:publish'>): Promise<IpcResponse<'share:publish'>>
  /** Change who may open it, or its expiry. */
  update(request: IpcRequest<'share:update'>): Promise<IpcResponse<'share:update'>>
  /** Revoke. Requires `confirmed: true`. */
  revoke(request: IpcRequest<'share:revoke'>): Promise<IpcResponse<'share:revoke'>>
  /** Who has opened it, most recent first. */
  views(request: IpcRequest<'share:views'>): Promise<IpcResponse<'share:views'>>
}

/**
 * Workspaces. Optional on the bridge: an older preload predates the channels,
 * and every Workspace surface then simply stays as projects are today.
 */
export interface FlowWorkspacesApi {
  list(): Promise<IpcResponse<'workspaces:list'>>
  status(request: IpcRequest<'workspaces:status'>): Promise<IpcResponse<'workspaces:status'>>
  membership(request: IpcRequest<'workspaces:membership'>): Promise<IpcResponse<'workspaces:membership'>>
  create(request: IpcRequest<'workspaces:create'>): Promise<IpcResponse<'workspaces:create'>>
  link(request: IpcRequest<'workspaces:link'>): Promise<IpcResponse<'workspaces:link'>>
  join(request: IpcRequest<'workspaces:join'>): Promise<IpcResponse<'workspaces:join'>>
  rename(request: IpcRequest<'workspaces:rename'>): Promise<IpcResponse<'workspaces:rename'>>
  moveProject(request: IpcRequest<'workspaces:moveProject'>): Promise<IpcResponse<'workspaces:moveProject'>>
  delete(request: IpcRequest<'workspaces:delete'>): Promise<IpcResponse<'workspaces:delete'>>
  placement(): Promise<IpcResponse<'workspaces:placement'>>
  moveIn(request: IpcRequest<'workspaces:moveIn'>): Promise<IpcResponse<'workspaces:moveIn'>>
  retryPlacement(request: IpcRequest<'workspaces:retryPlacement'>): Promise<IpcResponse<'workspaces:retryPlacement'>>
  current(): Promise<IpcResponse<'workspaces:current'>>
  setCurrent(request: IpcRequest<'workspaces:setCurrent'>): Promise<IpcResponse<'workspaces:setCurrent'>>
  suggest(request: IpcRequest<'workspaces:suggest'>): Promise<IpcResponse<'workspaces:suggest'>>
  taskProjects(request: IpcRequest<'workspaces:taskProjects'>): Promise<IpcResponse<'workspaces:taskProjects'>>
  taskProjectsMany(request: IpcRequest<'workspaces:taskProjectsMany'>): Promise<IpcResponse<'workspaces:taskProjectsMany'>>
  setTaskProjects(request: IpcRequest<'workspaces:setTaskProjects'>): Promise<IpcResponse<'workspaces:setTaskProjects'>>
  onChanged(listener: (event: IpcEventPayload<'workspaces:changed'>) => void): Unsubscribe
  syncStatus(request: IpcRequest<'workspaces:syncStatus'>): Promise<IpcResponse<'workspaces:syncStatus'>>
  syncNow(request: IpcRequest<'workspaces:syncNow'>): Promise<IpcResponse<'workspaces:syncNow'>>
  resolve(request: IpcRequest<'workspaces:resolve'>): Promise<IpcResponse<'workspaces:resolve'>>
  hostTools(): Promise<IpcResponse<'workspaces:hostTools'>>
  createRemote(request: IpcRequest<'workspaces:createRemote'>): Promise<IpcResponse<'workspaces:createRemote'>>
  setRemote(request: IpcRequest<'workspaces:setRemote'>): Promise<IpcResponse<'workspaces:setRemote'>>
  unsetRemote(request: IpcRequest<'workspaces:unsetRemote'>): Promise<IpcResponse<'workspaces:unsetRemote'>>
  onSyncChanged(listener: (event: IpcEventPayload<'workspaces:syncChanged'>) => void): Unsubscribe
  learnConnections(request: IpcRequest<'workspaces:learnConnections'>): Promise<IpcResponse<'workspaces:learnConnections'>>
  connectionsLearningStatus(request: IpcRequest<'workspaces:connectionsLearningStatus'>): Promise<IpcResponse<'workspaces:connectionsLearningStatus'>>
  onConnectionsLearning(listener: (event: IpcEventPayload<'workspaces:connectionsLearning'>) => void): Unsubscribe
}

/** A plan's change notes (plan `plan_change_review`). */
export interface FlowPlansApi {
  notes(request: IpcRequest<'plan:notes'>): Promise<IpcResponse<'plan:notes'>>
  setNote(request: IpcRequest<'plan:setNote'>): Promise<IpcResponse<'plan:setNote'>>
}

export interface FlowApi {
  /** Current renderer zoom factor (#1352). Optional: an older preload can't
   *  report it, and the caller falls back to 1. */
  zoomFactor?(): number
  threads: FlowThreadsApi
  tasks: FlowTasksApi
  debug: FlowDebugApi
  integrations: FlowIntegrationsApi
  messages: FlowMessagesApi
  toolCalls: FlowToolCallsApi
  editor: FlowEditorApi
  terminal: FlowTerminalApi
  attachments: FlowAttachmentsApi
  git: FlowGitApi
  flow: FlowFlowApi
  settings: FlowSettingsApi
  blueprint: FlowBlueprintApi
  /** Agent loops (Phase 7). Optional: an older preload predates the channels. */
  loops?: FlowLoopsApi
  brain: FlowBrainApi
  project: FlowProjectApi
  accounts: FlowAccountsApi
  review: FlowReviewApi
  updater: FlowUpdaterApi
  /** Performance evidence — optional so an older preload simply records
   *  nothing rather than throwing at every observation. */
  diagnostics?: FlowDiagnosticsApi
  learn: FlowLearnApi
  /** Embedded browser (Phase 1 contract). Optional: an older preload predates
   *  the channels, so the browser tab degrades to unavailable. */
  browser?: FlowBrowserApi
  /** Feature view sharing. Optional: an older preload predates the channels,
   *  and the feature view then simply offers no Share button. */
  share?: FlowShareApi
  /** Workspaces. Optional: an older preload predates the channels. */
  workspaces?: FlowWorkspacesApi
  /** Plan change notes. Optional: an older preload predates the channels. */
  plans?: FlowPlansApi
}
